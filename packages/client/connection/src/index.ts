/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
// Activates the webServer Context merge used below.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority } from './api-request-trust.ts'
import { BrowserAuth } from './browser-auth.ts'
import { assertFilesPublicUrl, listenForWorkspaceFiles } from './files-server.ts'
import { PRIVILEGED_HOSTS_GLOBAL } from './privileged-hosts.ts'
import { HostConnectionService } from './rpc-host.ts'
import { FILES_INFO_GLOBAL, type WorkspaceFilesInfo } from './workspace-files.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Resolve one Session cwd without activating its Agent. The Session domain
     * owns the first answer; an absent owner delegates to undefined.
     * @param sessionId - opaque Session identity from the `/f` path.
     * @mode waterfall
     */
    'client-connection/workspace-root'(
      sessionId: string,
      next: () => Promise<string | undefined>,
    ): Promise<string | undefined>
  }
}

export type {
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRequestRejection,
  ConnectionRpcResult,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from './rpc.ts'
export { RpcId, transportError } from './rpc.ts'
export {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from './rpc-schema.ts'
export { HostConnectionService } from './rpc-host.ts'

export { API_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/**
 * Derive exact application authorities whose host-scoped cookies can reach a sibling port.
 * @param declaredAuthorities - trusted and privileged application authorities.
 * @param applicationPort - actual application listener port for port-less authorities.
 * @returns canonical application authorities accepted as cookie audiences.
 */
export function browserApplicationAuthorities(
  declaredAuthorities: readonly string[],
  applicationPort: number,
): readonly string[] {
  const authorities = new Set([
    new URL(`http://127.0.0.1:${String(applicationPort)}`).host,
    new URL(`http://localhost:${String(applicationPort)}`).host,
  ])
  for (const authority of declaredAuthorities) {
    const parsed = new URL(`http://${authority}`)
    authorities.add(parsed.port === ''
      ? new URL(`http://${parsed.hostname}:${String(applicationPort)}`).host
      : parsed.host)
  }
  return [...authorities]
}

/** Services required before providing Connection. */
export const inject = ['webServer', 'credentials']

/** Plugin config: the deployment's non-loopback serving authorities. */
export interface ConnectionConfig {
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by; the Web runtime derives LAN IP literals from an active all-interface
   * bind. An entry that is not a bare, canonical authority fails plugin load.
   */
  trustedHosts?: string[]
  /**
   * Remote page authorities where the shipped client may expose Host-backed
   * configuration UI, in the same `host[:port]` form as
   * {@link ConnectionConfig.trustedHosts}. Each entry also joins the outer
   * Host/Origin trust fence, but never bypasses browser-session authentication.
   * This is a client capability declaration, not a method-specific API grant.
   */
  privilegedHosts?: string[]
  /**
   * Optional dedicated workspace-file origin. With neither key present no
   * listener exists; `files: {}` is intentionally a no-op because the config
   * schema materializes absent nested objects.
   */
  files?: {
    /** Listener port. Zero requests an OS-assigned direct-access port. */
    port?: number
    /** Bare external HTTP(S) origin when a reverse proxy republishes the listener. */
    publicUrl?: string
  }
  /** Absolute browser-session lifetime in days. Default: 30. */
  cookieMaxAgeDays?: number
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
}

export const Config: z<ConnectionConfig> = z.object({
  trustedHosts: z.array(String).default([]),
  privilegedHosts: z.array(String).default([]),
  // No inner defaults: key presence is the enable signal.
  files: z.object({
    port: z.natural().max(65535),
    publicUrl: z.string(),
  }),
  cookieMaxAgeDays: z.natural().min(1).default(30),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

/**
 * Mounts the API gateway under the browser transport prefix. Every request on
 * the prefix passes the Host/Origin browser-trust fence and persistent browser
 * authentication before dispatch. `privilegedHosts` contributes to the outer
 * trust fence and client capability injection only; it never replaces the
 * browser session or creates a method-specific authorization path.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config?: ConnectionConfig): Promise<void> {
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const privilegedHosts = config?.privilegedHosts ?? []
  const fenceHosts = [...trustedHosts, ...privilegedHosts]
  const cookieMaxAgeDays = config?.cookieMaxAgeDays ?? 30
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of fenceHosts) assertTrustedAuthority(entry)
  const filesPort = config?.files?.port
  const filesPublicOrigin = config?.files?.publicUrl === undefined
    ? undefined
    : assertFilesPublicUrl(config.files.publicUrl)
  const filesEnabled = filesPort !== undefined || filesPublicOrigin !== undefined
  if (filesPublicOrigin !== undefined && !filesPort) {
    throw new Error('client-connection: files.publicUrl requires a fixed files.port')
  }
  const applicationAuthorities = browserApplicationAuthorities(fenceHosts, ctx.webServer.port)
  if (filesPublicOrigin !== undefined) {
    const filesHostname = new URL(filesPublicOrigin).hostname
    const sharesApplicationHostname = applicationAuthorities.some(
      authority => new URL(`http://${authority}`).hostname === filesHostname,
    )
    if (!sharesApplicationHostname) {
      throw new Error(
        'client-connection: files.publicUrl hostname must match an application authority '
        + 'so the browser session reaches the files origin',
      )
    }
  }
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  const browserAuth = await BrowserAuth.create(ctx.root, ctx.credentials, cookieMaxAgeDays)
  const connection = new HostConnectionService(
    ctx,
    fenceHosts,
    browserAuth,
  )
  const fetchHandler = connection.createSharedFetchHandler(API_PATH)
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      await bridge(req, res, fetchHandler, maxRequestBodyBytes)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'client-connection: /api route')
  ctx.inject(['attachments'], (attachmentCtx) => {
    assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes)
  })
  // The browser uses this to decide whether the shipped client exposes Host
  // configuration surfaces. Every request still passes the uniform Host fence
  // and BrowserAuth session check above.
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: PRIVILEGED_HOSTS_GLOBAL, value: privilegedHosts })
  })
  if (!filesEnabled) return

  const files = await listenForWorkspaceFiles(
    ctx.webServer.host,
    filesPort ?? 0,
    fenceHosts,
    filesPublicOrigin,
    request => browserAuth.isAuthenticatedFor(request, applicationAuthorities),
    {
      cwdFor: sessionId => ctx.waterfall(
        'client-connection/workspace-root',
        sessionId,
        () => Promise.resolve(undefined),
      ),
    },
    (error) => { ctx.logger.error(error) },
  )
  const info: WorkspaceFilesInfo = {
    port: files.port,
    ...(filesPublicOrigin === undefined ? {} : { publicUrl: filesPublicOrigin }),
  }
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: FILES_INFO_GLOBAL, value: info })
  })
  ctx.effect(() => files.close, 'client-connection: /f listener')
}
