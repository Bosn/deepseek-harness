/** Dedicated HTTP origin serving only confined Session workspace files. */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isTrustedApiRequest } from './api-request-trust.ts'
import { FILES_PATH } from './workspace-files.ts'
import { handleWorkspaceFile, type WorkspaceFileDeps } from './workspace-file-handler.ts'

/** Bound files listener and quiescent teardown. */
export interface FilesServer {
  /** Actual listener port, including an OS-assigned port for config zero. */
  readonly port: number
  /** Idempotent close that also terminates held connections. */
  readonly close: () => Promise<void>
}

/**
 * Derive the authorities accepted by the files listener. A declared public
 * origin is authoritative; without one, exact API authorities are re-ported
 * to the listener while port-less declarations already match every port.
 * @param declaredAuthorities - application authorities from the deployment fence.
 * @param port - actual bound files-listener port.
 * @param publicOrigin - optional externally published bare origin.
 * @returns deduplicated authorities accepted by the files listener.
 */
export function workspaceFileAuthorities(
  declaredAuthorities: readonly string[],
  port: number,
  publicOrigin?: string,
): readonly string[] {
  const authorities = new Set(declaredAuthorities)
  if (publicOrigin !== undefined) {
    authorities.add(new URL(publicOrigin).host)
  } else {
    for (const authority of declaredAuthorities) {
      const parsed = new URL(`http://${authority}`)
      if (parsed.port !== '') authorities.add(`${parsed.hostname}:${String(port)}`)
    }
  }
  return [...authorities]
}

/**
 * Bind the read-only workspace-file origin.
 * @param host - network interface shared with the application Web server.
 * @param port - requested listener port, with zero requesting an ephemeral port.
 * @param trustedHosts - deployment application authorities.
 * @param publicOrigin - optional externally published bare origin.
 * @param isAuthenticated - browser-session verifier for each trusted request.
 * @param deps - Session-workspace resolver.
 * @param onSocketError - observer for asynchronous listener and handler failures.
 * @returns the bound port and quiescent close operation.
 */
export async function listenForWorkspaceFiles(
  host: string,
  port: number,
  trustedHosts: readonly string[],
  publicOrigin: string | undefined,
  isAuthenticated: (request: IncomingMessage) => boolean,
  deps: WorkspaceFileDeps,
  onSocketError: (error: Error) => void,
): Promise<FilesServer> {
  let servingAuthorities: readonly string[] = trustedHosts
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isTrustedApiRequest(req, servingAuthorities)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (!isAuthenticated(req)) {
      res.writeHead(401)
      res.end('unauthorized')
      return
    }
    /* v8 ignore next -- node:http supplies url for server requests. */
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    if (pathname !== FILES_PATH && !pathname.startsWith(`${FILES_PATH}/`)) {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    await handleWorkspaceFile(req, res, deps)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      /* v8 ignore next 3 -- current handler destroys post-header failures. */
      if (res.headersSent) {
        res.destroy()
        return
      }
      onSocketError(error instanceof Error ? error : new Error(String(error)))
      res.writeHead(400)
      res.end()
    })
  })

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      const actualPort = (server.address() as AddressInfo).port
      servingAuthorities = workspaceFileAuthorities(trustedHosts, actualPort, publicOrigin)
      server.on('error', onSocketError)
      resolve(actualPort)
    })
  })

  let closing: Promise<void> | undefined
  return {
    port: boundPort,
    close: () => {
      if (closing !== undefined) return closing
      closing = new Promise<void>((resolve) => {
        server.close(() => { resolve() })
        server.closeAllConnections()
      })
      return closing
    },
  }
}

/**
 * Validate and normalize a bare HTTP(S) public origin.
 * @param publicUrl - deployment-provided external origin.
 * @returns the normalized URL origin.
 */
export function assertFilesPublicUrl(publicUrl: string): string {
  let url: URL
  try {
    url = new URL(publicUrl)
  } catch {
    throw new Error(`client-connection: files.publicUrl ${JSON.stringify(publicUrl)} is not a URL`)
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `client-connection: files.publicUrl ${JSON.stringify(publicUrl)} must be a bare http(s) origin`,
    )
  }
  return url.origin
}
