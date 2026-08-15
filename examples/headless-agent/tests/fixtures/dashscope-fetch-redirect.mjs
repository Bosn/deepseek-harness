/** Redirect the canonical DashScope snapshot endpoint to the owning test's local HTTP server. */

const dashScopeCompletionsURL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions'
const localBaseURL = process.env.DSH_SNAPSHOT_DASHSCOPE_REDIRECT_URL
if (localBaseURL === undefined || localBaseURL.length === 0) {
  throw new Error('DSH_SNAPSHOT_DASHSCOPE_REDIRECT_URL is required')
}

const nativeFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const requested = new URL(input instanceof Request ? input.url : String(input))
  if (requested.href !== dashScopeCompletionsURL) {
    throw new Error(`unexpected DashScope snapshot request: ${requested.href}`)
  }
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  if (method.toUpperCase() !== 'POST') throw new Error(`unexpected DashScope snapshot method: ${method}`)
  const redirected = new URL('/chat/completions', localBaseURL)
  return nativeFetch(redirected, init)
}
