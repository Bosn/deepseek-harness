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
import { PRIVILEGED_HOSTS_GLOBAL } from './privileged-hosts.ts'
import { HostConnectionService } from './rpc-host.ts'
import { ConnectionRecoveryConfigSchema, resolveConnectionConfig, type ConnectionRecoveryConfig } from './recovery-config.ts'

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
  ConnectionRequestBodyMode,
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
export const inject = ['credentials']

/** Browser authentication, request limits, and connection recovery configuration. */
export interface ConnectionConfig {
  /** Browser recovery timing, injected into each served page. */
  recovery?: ConnectionRecoveryConfig
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
   * Serve the browser surface without the launch-token exchange and signed
   * cookies. Defaults to true; false accepts every root and /api request that
   * clears the Host/Origin trust fence, leaving containment entirely to
   * network reachability and {@link ConnectionConfig.trustedHosts}.
   */
  browserSessionAuth?: boolean
  /** Absolute browser-session lifetime in days. Default: 30. */
  cookieMaxAgeDays?: number
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
}

export const Config: z<ConnectionConfig> = z.object({
  recovery: ConnectionRecoveryConfigSchema.default({}),
  trustedHosts: z.array(String).default([]),
  privilegedHosts: z.array(String).default([]),
  browserSessionAuth: z.boolean().default(true),
  cookieMaxAgeDays: z.natural().min(1).default(30),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

/**
 * Provides carrier-neutral RPC and Fetch registries. When `webServer` is
 * present, the plugin also mounts the `/api` browser transport with Host/Origin
 * checks and, unless `browserSessionAuth` is false, persistent browser
 * authentication. `privilegedHosts` contributes to the outer trust fence and
 * client capability injection only; it never replaces the browser session or
 * creates a method-specific authorization path.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config?: ConnectionConfig): Promise<void> {
  const recovery = resolveConnectionConfig(config?.recovery)
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const privilegedHosts = config?.privilegedHosts ?? []
  const fenceHosts = [...trustedHosts, ...privilegedHosts]
  const cookieMaxAgeDays = config?.cookieMaxAgeDays ?? 30
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of fenceHosts) assertTrustedAuthority(entry)
  const browserAuth = config?.browserSessionAuth === false
    ? BrowserAuth.bypass()
    : await BrowserAuth.create(ctx.root, ctx.credentials, cookieMaxAgeDays)
  const connection = new HostConnectionService(
    ctx,
    fenceHosts,
    browserAuth,
  )
  ctx.inject(['webServer'], (webCtx) => {
    assertImageBodyCapacity(webCtx, maxRequestBodyBytes)
    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: recovery })
    })
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
    webCtx.effect(() => webCtx.webServer.register(route), 'client-connection: /api route')
    // The browser uses this to decide whether the shipped client exposes Host
    // configuration surfaces. Every request still passes the uniform Host fence
    // and BrowserAuth session check above.
    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: PRIVILEGED_HOSTS_GLOBAL, value: privilegedHosts })
    })
  })
  ctx.inject(['attachments'], (attachmentCtx) => {
    assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes)
  })
}
