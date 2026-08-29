/** Browser registry for read-only Cordis capability providers. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  CordisInspectProviderManifest, CordisInspectQueryRequest, CordisInspectQueryResolution,
  CordisInspectRequestId, JsonValue,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'

/** Context supplied to a Client inspect provider query. */
export interface ClientCordisInspectQueryContext {
  /** Cancellation broadcast by the Host. */
  signal: AbortSignal
  /** Session whose model requested the query. */
  sessionId: SessionId
}

/** Client provider registration retained beside its serializable manifest. */
export interface ClientCordisInspectProviderRegistration {
  /** Provider and explicit query directory. */
  manifest: CordisInspectProviderManifest
  /** Execute one declared read-only method. */
  query(method: string, input: JsonValue | undefined, context: ClientCordisInspectQueryContext): Promise<JsonValue>
}

/** Remote operations needed by the Client registry. */
export interface ClientCordisInspectHost {
  /** Replace the Host's mirrored Client manifest. */
  sync(providers: readonly CordisInspectProviderManifest[]): Promise<void>
  /** Submit one query result; the first accepted page wins. */
  resolve(
    sessionId: SessionId,
    requestId: CordisInspectRequestId,
    resolution: CordisInspectQueryResolution,
  ): Promise<void>
}

/** Client provider registry, manifest publisher, and live query dispatcher. */
export class ClientCordisInspectRegistry {
  private readonly providers = new Map<string, ClientCordisInspectProviderRegistration>()
  private readonly active = new Map<CordisInspectRequestId, AbortController>()
  private publishQueued = false
  /** Serializes manifest writes within the current Connection generation. */
  private syncChain: Promise<void> = Promise.resolve()
  /** A manifest is not transportable until the Connection handshake completes. */
  private connected = false
  /** A failed current-generation sync remains dirty for the next reset. */
  private dirty = false
  /** Invalidates work that belongs to an older provider or connection snapshot. */
  private revision = 0
  private connectionGeneration = 0
  private disposed = false

  /** @param host - folded manifest and query result transport. */
  constructor(private readonly host: ClientCordisInspectHost) {}

  /**
   * Register one Client provider and publish a new complete manifest.
   * @param registration - provider manifest and local handler.
   * @returns idempotent disposer.
   */
  register(registration: ClientCordisInspectProviderRegistration): () => void {
    const { manifest } = registration
    if (manifest.id.trim() === '') throw new Error('Client Cordis inspect provider id must not be empty')
    if (this.providers.has(manifest.id)) throw new Error(`Client Cordis inspect provider "${manifest.id}" is already registered`)
    const names = new Set<string>()
    for (const method of manifest.methods) {
      if (names.has(method.name)) throw new Error(`Client Cordis inspect provider "${manifest.id}" repeats method "${method.name}"`)
      names.add(method.name)
    }
    this.providers.set(manifest.id, registration)
    this.publish()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.providers.get(manifest.id) === registration) {
        this.providers.delete(manifest.id)
        this.publish()
      }
    }
  }

  /**
   * Mark the complete manifest dirty and publish it once a connection is ready.
   * Registration can happen before the first handshake; in that state this is
   * deliberately only a local state change, never a Remote call.
   */
  publish(): void {
    if (this.disposed) return
    this.revision += 1
    this.dirty = true
    this.scheduleSync()
  }

  /**
   * Mark a newly established connection generation and send a full snapshot.
   * Even an unchanged provider set is sent again: the Host mirror belongs to
   * the previous generation and may have been replaced with a fresh process.
   */
  connectionReset(): void {
    if (this.disposed) return
    this.connectionGeneration += 1
    this.revision += 1
    // An old carrier call can remain pending after its Connection disappears.
    // Give the new generation an independent queue so it can publish without
    // waiting for a promise that its transport can no longer settle.
    this.syncChain = Promise.resolve()
    this.connected = true
    this.dirty = true
    this.cancelActiveQueries()
    this.scheduleSync()
  }

  /**
   * Retract transport work when a generation dies. The next reset will publish
   * the complete manifest again, while stale sync/query continuations become
   * no-ops instead of touching a dead Remote host.
   */
  connectionLost(): void {
    if (this.disposed) return
    this.connectionGeneration += 1
    this.syncChain = Promise.resolve()
    this.connected = false
    this.dirty = true
    this.cancelActiveQueries()
  }

  /** Dispose page-local work, including queries waiting on a provider. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.connected = false
    this.dirty = false
    this.publishQueued = false
    this.connectionGeneration += 1
    this.syncChain = Promise.resolve()
    this.cancelActiveQueries()
  }

  /** Queue one serialized sync for the latest complete snapshot. */
  private scheduleSync(): void {
    if (this.disposed || !this.connected || !this.dirty || this.publishQueued) return
    this.publishQueued = true
    queueMicrotask(() => {
      this.publishQueued = false
      if (this.disposed || !this.connected || !this.dirty) return
      const run = this.syncChain.then(async () => {
        if (this.disposed || !this.connected || !this.dirty) return
        // Capture immediately before the call, not when the microtask was
        // scheduled: a burst of register/dispose operations converges to the
        // latest complete snapshot while preserving call order.
        const revision = this.revision
        const generation = this.connectionGeneration
        const manifests = [...this.providers.values()].map(provider => provider.manifest)
        try {
          await this.host.sync(manifests)
        } catch (error: unknown) {
          // A disconnect or teardown makes an old failure expected. Keep the
          // current generation dirty without emitting a misleading error for it.
          if (!this.isCurrentGeneration(generation)) return
          this.dirty = true
          console.error('[cordis-client-runner] syncing inspect providers failed:', error)
          return
        }
        if (!this.isCurrentGeneration(generation)) return
        if (revision === this.revision) {
          this.dirty = false
        } else {
          this.dirty = true
          this.scheduleSync()
        }
      })
      // A failed chain tail must not wedge later provider or connection updates.
      this.syncChain = run.catch(() => {})
    })
  }

  private cancelActiveQueries(): void {
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.disposed && this.connected && generation === this.connectionGeneration
  }

  /**
   * Execute and answer one Host-broadcast query.
   * @param request - exact provider query and Session correlation received from Host.
   * @returns after the first local result has been sent back to Host.
   */
  async query(request: CordisInspectQueryRequest): Promise<void> {
    if (this.disposed || !this.connected) return
    if (this.active.has(request.requestId)) return
    const controller = new AbortController()
    this.active.set(request.requestId, controller)
    const generation = this.connectionGeneration
    let resolution: CordisInspectQueryResolution
    try {
      const provider = this.providers.get(request.provider)
      if (provider === undefined) {
        resolution = { ok: false, reason: 'provider-missing', message: `Client inspect provider "${request.provider}" is unavailable` }
      } else if (!provider.manifest.methods.some(method => method.name === request.method)) {
        resolution = { ok: false, reason: 'method-missing', message: `Client inspect provider "${request.provider}" has no method "${request.method}"` }
      } else {
        const data = await provider.query(request.method, request.input, {
          signal: controller.signal,
          sessionId: request.agentId,
        })
        resolution = controller.signal.aborted
          ? { ok: false, reason: 'cancelled', message: 'Client inspect query was cancelled' }
          : { ok: true, data }
      }
    } catch (error) {
      resolution = controller.signal.aborted
        ? { ok: false, reason: 'cancelled', message: 'Client inspect query was cancelled' }
        : { ok: false, reason: 'provider-error', message: error instanceof Error ? error.message : String(error) }
    } finally {
      if (this.active.get(request.requestId) === controller) this.active.delete(request.requestId)
    }
    // A provider may ignore AbortSignal, and a reset can happen after the
    // provider resolved but before the answer reaches the carrier. In either
    // case the request belongs to an obsolete generation and must not touch a
    // Remote mounted for the next one.
    if (controller.signal.aborted || !this.isCurrentGeneration(generation)) return
    await this.host.resolve(request.agentId, request.requestId, resolution)
  }

  /**
   * Cancel local work after another page answered or the Tool call ended.
   * @param requestId - query correlation that is no longer answerable.
   */
  close(requestId: CordisInspectRequestId): void {
    const controller = this.active.get(requestId)
    controller?.abort()
    if (controller !== undefined && this.active.get(requestId) === controller) this.active.delete(requestId)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser registry for pre-definition Cordis capability discovery. */
    cordisInspect: ClientCordisInspectRegistry
  }
}

/**
 * Provide the registry as a normal Client service.
 * @param ctx - Client Cordis context receiving the service.
 * @param registry - page-local inspect registry to publish.
 */
export function provideClientCordisInspect(ctx: Context, registry: ClientCordisInspectRegistry): void {
  ctx.provide('cordisInspect', registry)
}
