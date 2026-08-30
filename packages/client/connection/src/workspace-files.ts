/**
 * Browser-safe URL contract for workspace-file reads. The browser turns a
 * tool-reported path into `/f/<sessionId>/<segments...>` and the dedicated
 * listener parses the same shape before it touches the filesystem.
 */

/** Route prefix owned by the dedicated workspace-file origin. */
export const FILES_PATH = '/f'

/** Page global publishing the dedicated workspace-file origin facts. */
export const FILES_INFO_GLOBAL = '__DSH_FILES__'

/** Origin facts injected into the served application shell. */
export interface WorkspaceFilesInfo {
  /** Bound listener port. */
  readonly port: number
  /** Deployment-declared public origin when a reverse proxy republishes it. */
  readonly publicUrl?: string
}

/** Parsed workspace-file address below one Session cwd. */
export interface WorkspaceFileTarget {
  /** Session whose cwd anchors the read. */
  readonly sessionId: string
  /** Decoded path segments below that cwd. */
  readonly segments: readonly string[]
}

function isPlainSegment(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..'
    && !segment.includes('/') && !segment.includes('\\') && !segment.includes('\0')
}

function decode(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

/**
 * Express one absolute or cwd-relative file path as segments below the cwd.
 * @param cwd - Session working directory, when known.
 * @param path - tool-reported path.
 * @returns confined relative segments, or undefined for the cwd itself,
 * traversal, or an absolute path outside the workspace.
 */
export function workspaceFileSegments(cwd: string | undefined, path: string): string[] | undefined {
  const slashed = path.replace(/\\/g, '/')
  const absolute = /^\/|^[A-Za-z]:\//.test(slashed)
  let relative: string
  if (absolute) {
    if (cwd === undefined || cwd === '') return undefined
    const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!slashed.startsWith(`${root}/`)) return undefined
    relative = slashed.slice(root.length + 1)
  } else {
    relative = slashed
  }
  const segments = relative.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.some(segment => !isPlainSegment(segment))) return undefined
  return segments
}

/**
 * Build the origin-relative URL for one confined workspace file.
 * @param sessionId - opaque Session identity.
 * @param segments - validated path segments below the Session cwd.
 * @returns encoded origin-relative `/f` URL.
 */
export function workspaceFileUrl(sessionId: string, segments: readonly string[]): string {
  const encoded = segments.map(segment => encodeURIComponent(segment)).join('/')
  return `${FILES_PATH}/${encodeURIComponent(sessionId)}/${encoded}`
}

/**
 * Parse one raw request pathname without permitting a decoded segment to
 * become a separator, dot traversal, or NUL byte.
 * @param pathname - raw URL pathname from the files listener.
 * @returns decoded Session and path segments, or undefined for an invalid shape.
 */
export function parseWorkspaceFilePath(pathname: string): WorkspaceFileTarget | undefined {
  if (!pathname.startsWith(`${FILES_PATH}/`)) return undefined
  const [rawSession, ...rawSegments] = pathname.slice(FILES_PATH.length + 1).split('/')
  if (rawSession === undefined || rawSegments.length === 0) return undefined
  const sessionId = decode(rawSession)
  if (sessionId === undefined || sessionId === '') return undefined
  const segments: string[] = []
  for (const raw of rawSegments) {
    const segment = decode(raw)
    if (segment === undefined || !isPlainSegment(segment)) return undefined
    segments.push(segment)
  }
  return { sessionId, segments }
}
