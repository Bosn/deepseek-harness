/** Page-global name for the deployment's Host-configuration browser authorities. */
export const PRIVILEGED_HOSTS_GLOBAL = '__DSH_PRIVILEGED_HOSTS__'

/** Browser authority fields used to match a deployment declaration. */
export interface PageAuthority {
  /** URL hostname, already normalized by the browser. */
  hostname: string
  /** Explicit URL port, or the empty string when the URL omits it. */
  port: string
}

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/**
 * Assert that a configured authority is a bare canonical `host[:port]` value.
 * @param entry - deployment config entry.
 * @returns nothing after validation.
 */
export function assertTrustedAuthority(entry: string): void {
  const entryUrl = parseAuthority(entry)
  if (entryUrl !== undefined && canonicalAuthority(entry, entryUrl) === entry.toLowerCase()) return
  throw new Error(`client-connection: configured authority ${JSON.stringify(entry)} is not a bare host[:port] authority`)
}

/**
 * Whether a page authority matches a validated `host[:port]` declaration.
 * Port-less entries match every port; explicit ports match exactly.
 * @param page - current browser authority fields.
 * @param entries - config-validated authorities injected by the Host.
 * @returns whether one declaration names the page.
 */
export function isDeclaredAuthority(page: PageAuthority, entries: readonly string[]): boolean {
  const pageUrl = parseAuthority(page.port === '' ? page.hostname : `${page.hostname}:${page.port}`)
  if (pageUrl === undefined) return false
  return entries.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === pageUrl.hostname
      : entryUrl.host === pageUrl.host
  })
}
