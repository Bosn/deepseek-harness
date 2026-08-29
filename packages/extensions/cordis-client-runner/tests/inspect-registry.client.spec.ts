/**
 * @vitest-environment jsdom
 *
 * Inspect-manifest transport lifecycle: provider registration happens while the
 * page is still doing its first connection handshake, and reconnects must not
 * let an old generation or a disposed page call the old Remote host.
 */

import { describe, expect, it, vi } from 'vitest'
import type {
  CordisInspectProviderManifest, CordisInspectQueryResolution, CordisInspectRequestId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { ClientCordisInspectRegistry } from '../src/client/inspect-registry.ts'

const SESSION = 'inspect-session' as SessionId
const REQUEST = 'inspect-request' as CordisInspectRequestId

const PROVIDER_A: CordisInspectProviderManifest = {
  id: 'provider-a',
  description: 'Provider A',
  methods: [{
    name: 'read',
    description: 'Read A',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  }],
}

const PROVIDER_B: CordisInspectProviderManifest = {
  id: 'provider-b',
  description: 'Provider B',
  methods: [{
    name: 'read',
    description: 'Read B',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  }],
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

function host() {
  const calls: string[][] = []
  const sync = vi.fn(async (providers: readonly CordisInspectProviderManifest[]) => {
    calls.push(providers.map(provider => provider.id))
  })
  const resolve = vi.fn(async (
    _sessionId: SessionId,
    _requestId: CordisInspectRequestId,
    _resolution: CordisInspectQueryResolution,
  ) => {})
  return { host: { sync, resolve }, calls }
}

describe('ClientCordisInspectRegistry connection lifecycle', () => {
  it('does not call the Remote host while the first connection is pending', async () => {
    const seam = host()
    const registry = new ClientCordisInspectRegistry(seam.host)
    registry.register({ manifest: PROVIDER_A, query: async () => ({ ok: true }) })

    await settle()

    expect(seam.host.sync).not.toHaveBeenCalled()
    expect(seam.calls).toEqual([])
  })

  it('sends the latest complete manifest after the first connection reset', async () => {
    const seam = host()
    const registry = new ClientCordisInspectRegistry(seam.host)
    registry.register({ manifest: PROVIDER_A, query: async () => ({ ok: true }) })
    registry.register({ manifest: PROVIDER_B, query: async () => ({ ok: true }) })

    registry.connectionReset()
    await settle()

    expect(seam.calls).toEqual([['provider-a', 'provider-b']])
  })

  it('re-sends an unchanged complete manifest for every reconnect generation', async () => {
    const seam = host()
    const registry = new ClientCordisInspectRegistry(seam.host)
    registry.register({ manifest: PROVIDER_A, query: async () => ({ ok: true }) })

    registry.connectionReset()
    await settle()
    registry.connectionReset()
    await settle()

    expect(seam.calls).toEqual([['provider-a'], ['provider-a']])
  })

  it('does not let a hung old-generation sync block the reconnect snapshot', async () => {
    const first = deferred<undefined>()
    const calls: string[][] = []
    let count = 0
    const sync = vi.fn((providers: readonly CordisInspectProviderManifest[]) => {
      calls.push(providers.map(provider => provider.id))
      count += 1
      return count === 1 ? first.promise : Promise.resolve()
    })
    const registry = new ClientCordisInspectRegistry({ sync, resolve: async () => {} })
    registry.register({ manifest: PROVIDER_A, query: async () => ({ ok: true }) })

    registry.connectionReset()
    await settle()
    expect(calls).toEqual([['provider-a']])

    registry.connectionLost()
    registry.connectionReset()
    await settle()
    expect(calls).toEqual([['provider-a'], ['provider-a']])

    first.resolve(undefined)
    await settle()
    expect(calls).toEqual([['provider-a'], ['provider-a']])
  })

  it('serializes generations and converges to changes made during a sync', async () => {
    const first = deferred<undefined>()
    const calls: string[][] = []
    let count = 0
    const sync = vi.fn((providers: readonly CordisInspectProviderManifest[]) => {
      calls.push(providers.map(provider => provider.id))
      count += 1
      return count === 1 ? first.promise : Promise.resolve()
    })
    const registry = new ClientCordisInspectRegistry({ sync, resolve: async () => {} })
    const disposeA = registry.register({ manifest: PROVIDER_A, query: async () => ({ ok: true }) })
    registry.connectionReset()
    await settle()
    expect(calls).toEqual([['provider-a']])

    registry.register({ manifest: PROVIDER_B, query: async () => ({ ok: true }) })
    disposeA()
    first.resolve(undefined)
    await settle()
    await settle()

    expect(calls).toEqual([['provider-a'], ['provider-b']])
  })

  it('keeps a failed manifest dirty and retries it on the next connection reset', async () => {
    let fail = true
    const seam = host()
    seam.host.sync.mockImplementation(async (providers) => {
      seam.calls.push(providers.map(provider => provider.id))
      if (fail) throw new Error('connection went away')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const registry = new ClientCordisInspectRegistry(seam.host)
    registry.register({ manifest: PROVIDER_A, query: async () => ({ ok: true }) })

    registry.connectionReset()
    await settle()
    expect(error).toHaveBeenCalled()

    fail = false
    registry.connectionReset()
    await settle()

    expect(seam.calls).toEqual([['provider-a'], ['provider-a']])
    error.mockRestore()
  })

  it('does not invoke a queued host sync after disposal', async () => {
    const seam = host()
    const registry = new ClientCordisInspectRegistry(seam.host)
    registry.register({ manifest: PROVIDER_A, query: async () => ({ ok: true }) })
    registry.connectionReset()
    registry.dispose()

    await settle()

    expect(seam.host.sync).not.toHaveBeenCalled()
  })

  it('cancels an active query and never resolves it through a disposed host', async () => {
    const pending = deferred<{ ok: true }>()
    const seam = host()
    let signal: AbortSignal | undefined
    const registry = new ClientCordisInspectRegistry(seam.host)
    registry.connectionReset()
    registry.register({
      manifest: PROVIDER_A,
      query: async (_method, _input, context) => {
        signal = context.signal
        return pending.promise
      },
    })

    const query = registry.query({
      requestId: REQUEST,
      agentId: SESSION,
      provider: PROVIDER_A.id,
      method: 'read',
    })
    await Promise.resolve()
    registry.dispose()
    pending.resolve({ ok: true })
    await query

    expect(signal?.aborted).toBe(true)
    expect(seam.host.resolve).not.toHaveBeenCalled()
  })

  it('does not start a query while disconnected and drops a provider that ignores abort on loss', async () => {
    const pending = deferred<{ ok: true }>()
    const seam = host()
    let calls = 0
    const registry = new ClientCordisInspectRegistry(seam.host)
    registry.register({
      manifest: PROVIDER_A,
      query: async () => {
        calls += 1
        return pending.promise
      },
    })

    // Before the first reset there is no active transport, so even a Host
    // event delivered out of order is ignored locally.
    await registry.query({
      requestId: REQUEST,
      agentId: SESSION,
      provider: PROVIDER_A.id,
      method: 'read',
    })
    expect(calls).toBe(0)

    registry.connectionReset()
    await settle()
    const query = registry.query({
      requestId: REQUEST,
      agentId: SESSION,
      provider: PROVIDER_A.id,
      method: 'read',
    })
    await Promise.resolve()
    registry.connectionLost()
    pending.resolve({ ok: true })
    await query

    expect(calls).toBe(1)
    expect(seam.host.resolve).not.toHaveBeenCalled()
  })
})
