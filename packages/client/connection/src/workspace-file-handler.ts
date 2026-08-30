/** Stream one confined file from a Session workspace on the files origin. */

import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { parseWorkspaceFilePath } from './workspace-files.ts'

/** Explicit inline types; unknown extensions stay readable text under nosniff. */
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
}

const DEFAULT_MIME = 'text/plain; charset=utf-8'

/** Session-to-workspace lookup supplied by the current Session owner. */
export interface WorkspaceFileDeps {
  /** Resolve one Session id without activating its Agent. */
  readonly cwdFor: (sessionId: string) => Promise<string | undefined>
}

function fail(res: ServerResponse, status: number): void {
  res.writeHead(status)
  res.end()
}

/** Resolve both the workspace and target through symlinks, then confine. */
async function confine(cwd: string, segments: readonly string[]): Promise<string | undefined> {
  const root = await realpath(cwd)
  const prefix = root.endsWith(sep) ? root : root + sep
  const real = await realpath(resolve(root, ...segments))
  return real.startsWith(prefix) ? real : undefined
}

/**
 * Serve one GET/HEAD after the dedicated listener has applied its authority
 * fence and method boundary.
 * @param req - trusted and authenticated files-origin request.
 * @param res - response receiving headers and the optional streamed body.
 * @param deps - Session-workspace resolver.
 */
export async function handleWorkspaceFile(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WorkspaceFileDeps,
): Promise<void> {
  /* v8 ignore next -- node:http supplies url for server requests. */
  const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
  const target = parseWorkspaceFilePath(pathname)
  if (target === undefined) {
    fail(res, 404)
    return
  }
  const cwd = await deps.cwdFor(target.sessionId)
  if (cwd === undefined) {
    fail(res, 404)
    return
  }

  let file: string | undefined
  let size: number
  try {
    file = await confine(cwd, target.segments)
    if (file === undefined) {
      fail(res, 403)
      return
    }
    const info = await stat(file)
    if (!info.isFile()) {
      fail(res, 404)
      return
    }
    size = info.size
  } catch {
    // Do not let probes distinguish missing, unreadable, and invalid parents.
    fail(res, 404)
    return
  }

  const ext = extname(file).toLowerCase()
  res.writeHead(200, {
    'content-type': MIME[ext] ?? DEFAULT_MIME,
    'content-length': String(size),
    'content-disposition': 'inline',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  try {
    await pipeline(createReadStream(file), res)
  } catch {
    // The status line is already committed; terminate an incomplete body.
    res.destroy()
  }
}
