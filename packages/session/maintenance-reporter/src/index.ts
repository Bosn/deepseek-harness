/**
 * DSH top-level maintenance holder renewal, terminal release, reporter coverage,
 * and trusted shell identity for the owner maintenance client.
 * @module @deepseek-ai/dsh-maintenance-reporter
 */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createConnection } from 'node:net'
import { performance } from 'node:perf_hooks'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { DshEnvironment } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-shell-env'

export const name = 'maintenance-reporter'
export const inject = ['agents', 'shellEnv']

const COMMAND_PROTOCOL = 'bo.agents.maintenance-holder-command/v1'
const RESULT_PROTOCOL = 'bo.agents.maintenance-holder-command-result/v1'
const AGGREGATE_PROTOCOL = 'bo.agents.maintenance-aggregate/v1'
const CLIENT_RECEIPT_PROTOCOL = 'bo.agents.maintenance-client-receipt/v1'
const CLIENT_RECEIPT_PREFIX = 'BOAGENTS_MAINTENANCE_RECEIPT '
const STATE_KEY = 'boagents.maintenance'
const MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_HEARTBEAT_MS = 300_000
const DEFAULT_TIMEOUT_MS = 15_000
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,239}$/u
const ENV_TOP_LEVEL = 'DSH_MAINTENANCE_TOP_LEVEL'
const ENV_TURN_ID = 'DSH_MAINTENANCE_TURN_ID'
const ENV_RUNTIME_GENERATION = 'DSH_MAINTENANCE_RUNTIME_GENERATION'
const ENV_REPORTER_ID = 'DSH_MAINTENANCE_REPORTER_ID'

/** Deployment paths, release identity, timing, and supported preset coverage. */
export interface Config {
  /** Owner-only BOCC ingest Unix socket. */
  socketPath: string
  /** Source-managed automatic-repair policy whose bytes bind every command. */
  policyPath: string
  /** Hash of the admitted reporter release bytes. */
  reporterHash: string
  /** Stable reporter identity. */
  reporterId?: string
  /** Fixed holder and coverage renewal cadence. */
  heartbeatMs?: number
  /** One command request timeout. */
  requestTimeoutMs?: number
  /** Presets that load the user-global AGENTS instruction source. */
  instructionCoveredPresets: string[]
  /** Presets whose shell carries exact per-turn maintenance identity. */
  reportingCapablePresets: string[]
}

export const Config: z<Config> = z.object({
  socketPath: z.string().required(),
  policyPath: z.string().required(),
  reporterHash: z.string().required(),
  reporterId: z.string().default('dsh-maintenance-reporter'),
  heartbeatMs: z.number().step(1).min(1).default(DEFAULT_HEARTBEAT_MS),
  requestTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS),
  instructionCoveredPresets: z.array(z.string()).required(),
  reportingCapablePresets: z.array(z.string()).required(),
})

type Actor = {
  kind: 'dsh'
  reporterId: string
  runtimeGeneration: string
  taskId: string | null
  turnId: string | null
  topLevel: boolean
}

type Holder = {
  holderId: string
  leaseId: string
  generation: number
  holderRevision: number
  status: 'active' | 'released' | 'expired' | 'superseded'
  expiresAt: string | null
}

type Command = Record<string, unknown> & {
  protocolVersion: typeof COMMAND_PROTOCOL
  requestId: string
  operation: 'heartbeat' | 'release' | 'report-coverage'
  actor: Actor
}

type CommandResult = {
  protocolVersion: typeof RESULT_PROTOCOL
  requestId: string
  operation: string
  outcome: 'applied' | 'replay' | 'no-op' | 'stale' | 'rejected'
  dbNow: string
  reasonCode: string | null
  holder: Holder | null
  aggregate: { protocolVersion: typeof AGGREGATE_PROTOCOL } & Record<string, unknown>
}

type ClientReceipt = {
  protocolVersion: typeof CLIENT_RECEIPT_PROTOCOL
  actor: Record<string, unknown>
  commandResult: Record<string, unknown>
}

type Lease = {
  actor: Actor
  holder: Holder
  terminal: TurnEndReason | null
  nextHeartbeatAt: number
  identityConflict: boolean
  heartbeatError: boolean
}

/** Transport for one exact maintenance command. */
export interface MaintenanceTransport {
  /**
   * Send one command and resolve only after its typed terminal response.
   * @param command - closed command value.
   * @param signal - reporter shutdown and request cancellation.
   * @returns the validated command result.
   */
  send(command: Command, signal?: AbortSignal): Promise<CommandResult>
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      throw new Error('maintenance-reporter: command material is not JSON')
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function runtimeGeneration(): string {
  return sha256(JSON.stringify({ pid: process.pid, startedAt: performance.timeOrigin, execPath: process.execPath }))
}

function policyHash(path: string): string {
  try {
    return sha256(readFileSync(path))
  } catch {
    throw new Error('maintenance-reporter: policy file is unavailable')
  }
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateResult(command: Command, value: unknown): CommandResult {
  if (!isRecord(value)
    || !exactKeys(value, ['protocolVersion', 'requestId', 'operation', 'outcome', 'dbNow', 'reasonCode', 'holder', 'aggregate'])) {
    throw new Error('maintenance-reporter: command result fields are invalid')
  }
  const result = value
  const outcome = result.outcome
  const aggregate = result.aggregate
  if (result.protocolVersion !== RESULT_PROTOCOL || result.requestId !== command.requestId
    || result.operation !== command.operation
    || (outcome !== 'applied' && outcome !== 'replay' && outcome !== 'no-op'
      && outcome !== 'stale' && outcome !== 'rejected')
    || !isRecord(aggregate) || aggregate.protocolVersion !== AGGREGATE_PROTOCOL) {
    throw new Error('maintenance-reporter: command result identity is invalid')
  }
  return result as CommandResult
}

/** JSON-line transport over one owner-only Unix socket. */
export class UnixMaintenanceTransport implements MaintenanceTransport {
  /**
   * @param socketPath - absolute owner-only Unix socket path.
   * @param timeoutMs - request wall-clock timeout.
   */
  constructor(private readonly socketPath: string, private readonly timeoutMs: number) {
    if (!isAbsolute(socketPath) || socketPath.includes('\0')) throw new Error('maintenance-reporter: socketPath must be absolute')
  }

  /** @inheritdoc */
  send(command: Command, signal?: AbortSignal): Promise<CommandResult> {
    let info
    try { info = lstatSync(this.socketPath) } catch {
      return Promise.reject(new Error('maintenance-reporter: command transport unavailable'))
    }
    if (!info.isSocket() || info.uid !== 1000 || (info.mode & 0o777) !== 0o600) {
      return Promise.reject(new Error('maintenance-reporter: socket failed owner-only admission'))
    }
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      let response = Buffer.alloc(0)
      let settled = false
      const finish = (error: Error | null, result?: CommandResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        socket.destroy()
        if (error !== null) reject(error)
        else if (result === undefined) reject(new Error('maintenance-reporter: command result is missing'))
        else resolve(result)
      }
      const aborted = (): void => { finish(new Error('maintenance-reporter: command aborted')) }
      const timer = setTimeout(() => { finish(new Error('maintenance-reporter: command timed out')) }, this.timeoutMs)
      signal?.addEventListener('abort', aborted, { once: true })
      socket.once('connect', () => socket.write(`${JSON.stringify(command)}\n`))
      socket.once('error', () => { finish(new Error('maintenance-reporter: command transport unavailable')) })
      socket.on('data', (chunk) => {
        response = Buffer.concat([response, chunk])
        if (response.length > MAX_RESPONSE_BYTES) {
          finish(new Error('maintenance-reporter: response exceeds byte bound'))
          return
        }
        const newline = response.indexOf(0x0a)
        if (newline < 0) return
        try {
          finish(null, validateResult(command, JSON.parse(response.subarray(0, newline).toString('utf8'))))
        } catch (error: unknown) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
      socket.once('end', () => {
        if (!settled) finish(new Error('maintenance-reporter: incomplete response'))
      })
    })
  }
}

function textBlocks(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(textBlocks)
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  if (record.type === 'text' && typeof record.text === 'string') return [record.text]
  return Object.values(record).flatMap(textBlocks)
}

function parseClientReceipts(event: Extract<SessionEvent, { type: 'tool/result' }>): ClientReceipt[] {
  const receipts: ClientReceipt[] = []
  for (const text of textBlocks(event.data.message.content)) {
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith(CLIENT_RECEIPT_PREFIX)) continue
      let value: unknown
      try { value = JSON.parse(line.slice(CLIENT_RECEIPT_PREFIX.length)) } catch { continue }
      if (!isRecord(value) || value.protocolVersion !== CLIENT_RECEIPT_PROTOCOL
        || !isRecord(value.actor) || !isRecord(value.commandResult)
        || value.commandResult.protocolVersion !== RESULT_PROTOCOL) continue
      receipts.push({
        protocolVersion: CLIENT_RECEIPT_PROTOCOL,
        actor: value.actor,
        commandResult: value.commandResult,
      })
    }
  }
  return receipts
}

function topLevel(session: Session): boolean {
  return session.header.origin !== 'subagent' && (session.header.delegationDepth ?? 0) === 0
}

function activeTurn(session: Session): number | undefined {
  const boundary = session.events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  return boundary?.type === 'turn/start' ? boundary.data.turn : undefined
}

function leaseIdentity(holder: Holder): string {
  return `${holder.holderId}\0${holder.leaseId}\0${String(holder.generation)}`
}

function leaseRequest(holder: Holder): { leaseId: string; generation: number; expectedHolderRevision: number } {
  return { leaseId: holder.leaseId, generation: holder.generation, expectedHolderRevision: holder.holderRevision }
}

function releaseReason(reason: TurnEndReason): 'complete' | 'failed' | 'cancelled' | 'interrupted' {
  switch (reason.kind) {
    case 'completed': return 'complete'
    case 'aborted': return 'cancelled'
    case 'error':
    case 'blocked':
    case 'max-tokens': return 'failed'
    default: return 'interrupted'
  }
}

function commandBase(config: ResolvedConfig, actor: Actor, operation: Command['operation'], now: number): Command {
  return {
    protocolVersion: COMMAND_PROTOCOL,
    requestId: 'maintenance:pending',
    operation,
    stateKey: STATE_KEY,
    actor,
    policyHash: config.policyHash,
    issuedAt: new Date(now).toISOString(),
    holder: null,
    lease: null,
    coverage: null,
    expectedStateRevision: null,
    recheck: null,
    releaseReason: null,
    evidenceRef: null,
  }
}

function bindCommandId(command: Command, idempotencyGeneration: number | null = null): void {
  const { requestId: _requestId, issuedAt: _issuedAt, ...material } = command
  const digest = sha256(canonicalJson({ operation: command.operation, material: { ...material, idempotencyGeneration } })).slice(7)
  command.requestId = `maintenance:${command.operation}:${digest}`
}

type ResolvedConfig = Required<Omit<Config, 'reporterId' | 'heartbeatMs' | 'requestTimeoutMs'>> & {
  reporterId: string
  heartbeatMs: number
  requestTimeoutMs: number
  policyHash: string
  runtimeGeneration: string
}

/** Inputs used by source tests to inject transport and time. */
export interface ReporterOptions {
  config: Config
  transport: MaintenanceTransport
  now?: () => number
  schedule?: boolean
}

/** Stateful reporter used by the Cordis adapter and source lifecycle tests. */
export interface MaintenanceReporter {
  /** Start coverage reporting and optional interval scheduling. */
  start(): void
  /** Stop scheduling, report unavailable, and await transport quiescence. */
  close(): Promise<void>
  /** Run one deterministic lease and coverage cycle. */
  tick(): Promise<void>
  /** Observe an Agent status transition for coverage admission. */
  handleAgentStatus(agent: Agent, status: AgentStatus): void
  /** Observe terminal disposal when no turn/end arrived. */
  handleAgentDisposed(agent: Agent): void
  /** Observe durable turn, tool-result, and terminal events. */
  handleSessionEvent(session: Session, event: SessionEvent): void
  /** Resolve trusted per-execution identity values. */
  environmentFor(agent: Agent): DshEnvironment
  /** Bounded source-test snapshot. */
  snapshot(): { leaseCount: number; runningCount: number; coverageState: string }
}

/**
 * Create one process reporter without activating a live profile.
 * @param options - deployment config, transport, time, and scheduling seam.
 * @returns the lifecycle adapter.
 */
export function createMaintenanceReporter(options: ReporterOptions): MaintenanceReporter {
  const config: ResolvedConfig = {
    socketPath: options.config.socketPath,
    policyPath: options.config.policyPath,
    reporterHash: options.config.reporterHash,
    reporterId: options.config.reporterId ?? 'dsh-maintenance-reporter',
    heartbeatMs: options.config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    requestTimeoutMs: options.config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    instructionCoveredPresets: options.config.instructionCoveredPresets,
    reportingCapablePresets: options.config.reportingCapablePresets,
    policyHash: policyHash(options.config.policyPath),
    runtimeGeneration: runtimeGeneration(),
  }
  if (!FINGERPRINT.test(config.reporterHash) || !STABLE_ID.test(config.reporterId)) {
    throw new Error('maintenance-reporter: release identity is invalid')
  }
  const instructionCovered = new Set(config.instructionCoveredPresets)
  const reportingCapable = new Set(config.reportingCapablePresets)
  const now = options.now ?? Date.now
  const leases = new Map<Session, Lease>()
  const running = new Map<Session, Agent>()
  const turns = new Map<Session, number>()
  const abort = new AbortController()
  let chain = Promise.resolve()
  let timer: ReturnType<typeof setInterval> | undefined
  let closing = false
  let nextCoverageAt = 0
  let lastCoverageState = 'missing'

  const actor = (session: Session | null): Actor => ({
    kind: 'dsh',
    reporterId: config.reporterId,
    runtimeGeneration: config.runtimeGeneration,
    taskId: session === null ? null : String(session.id),
    turnId: session === null ? null : String(turns.get(session) ?? activeTurn(session) ?? ''),
    topLevel: session === null || topLevel(session),
  })

  const send = (command: Command): Promise<CommandResult> => {
    const operation = chain.then(async () => {
      let firstError: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await options.transport.send(command, abort.signal)
        } catch (error: unknown) {
          if (abort.signal.aborted || attempt === 1) throw error
          firstError = error
        }
      }
      throw firstError
    })
    chain = operation.then(() => undefined, () => undefined)
    return operation
  }

  const heartbeat = async (session: Session, lease: Lease): Promise<void> => {
    if (lease.terminal !== null || lease.identityConflict) return
    const command = commandBase(config, lease.actor, 'heartbeat', now())
    command.lease = leaseRequest(lease.holder)
    bindCommandId(command)
    try {
      const result = await send(command)
      if (['applied', 'replay', 'no-op'].includes(result.outcome) && result.holder !== null) {
        lease.holder = result.holder
        lease.nextHeartbeatAt = now() + config.heartbeatMs
        lease.heartbeatError = false
      } else {
        lease.identityConflict = true
      }
    } catch {
      lease.heartbeatError = true
      lease.nextHeartbeatAt = now() + Math.min(config.heartbeatMs, 30_000)
    }
    leases.set(session, lease)
  }

  const release = async (session: Session, lease: Lease): Promise<void> => {
    if (lease.terminal === null) return
    const command = commandBase(config, lease.actor, 'release', now())
    command.lease = leaseRequest(lease.holder)
    command.releaseReason = releaseReason(lease.terminal)
    bindCommandId(command)
    try {
      const result = await send(command)
      if (['applied', 'replay', 'no-op', 'stale'].includes(result.outcome)) leases.delete(session)
    } catch {
      // A terminal lease is never heartbeated again; fixed DB expiry remains
      // the crash-safe release when the transport cannot accept this command.
    }
  }

  const preset = (session: Session): string => session.header.agentPreset ?? '__host__'
  const coverageState = (): 'complete' | 'unavailable' => {
    for (const [session] of running) {
      if (!topLevel(session)) continue
      const id = preset(session)
      if (!instructionCovered.has(id) || !reportingCapable.has(id)) return 'unavailable'
    }
    for (const lease of leases.values()) {
      if (lease.identityConflict || lease.heartbeatError) return 'unavailable'
    }
    return 'complete'
  }

  const reportCoverage = async (forcedState?: 'unavailable'): Promise<void> => {
    const state = forcedState ?? coverageState()
    if (forcedState === undefined && now() < nextCoverageAt && state === lastCoverageState) return
    const observedAt = now()
    const command = commandBase(config, actor(null), 'report-coverage', observedAt)
    command.coverage = {
      source: 'dsh',
      state,
      subjectRuntimeGeneration: config.runtimeGeneration,
      reporterHash: config.reporterHash,
      evidenceRefs: state === 'complete' ? ['dsh:maintenance-reporter'] : ['dsh:maintenance-coverage-unavailable'],
    }
    bindCommandId(command, Math.floor(observedAt / config.heartbeatMs))
    try {
      await send(command)
      lastCoverageState = state
      nextCoverageAt = now() + config.heartbeatMs
    } catch {
      // No local success marker substitutes for the DB receipt; existing
      // coverage expires naturally when the transport remains unavailable.
    }
  }

  const tick = async (): Promise<void> => {
    if (closing) return
    for (const [session, lease] of [...leases]) {
      if (lease.terminal !== null) await release(session, lease)
      else if (now() >= lease.nextHeartbeatAt) await heartbeat(session, lease)
    }
    await reportCoverage()
  }

  const acceptReceipt = (session: Session, receipt: ClientReceipt): void => {
    const currentTurn = turns.get(session) ?? activeTurn(session)
    const actorValue = receipt.actor
    const result = receipt.commandResult
    const holderValue = result.holder
    if (!topLevel(session) || currentTurn === undefined || actorValue.kind !== 'dsh'
      || actorValue.topLevel !== true || actorValue.taskId !== String(session.id)
      || actorValue.turnId !== String(currentTurn) || result.operation !== 'acquire'
      || (result.outcome !== 'applied' && result.outcome !== 'replay' && result.outcome !== 'no-op')
      || !isRecord(holderValue) || holderValue.status !== 'active') return
    const acceptedActor = actorValue as Actor
    const holder = holderValue as Holder
    const existing = leases.get(session)
    if (existing !== undefined && leaseIdentity(existing.holder) !== leaseIdentity(holder)) {
      existing.identityConflict = true
      return
    }
    leases.set(session, {
      actor: acceptedActor,
      holder,
      terminal: null,
      nextHeartbeatAt: now() + config.heartbeatMs,
      identityConflict: false,
      heartbeatError: false,
    })
  }

  return {
    start() {
      if (timer !== undefined || closing) return
      void reportCoverage()
      if (options.schedule !== false) timer = setInterval(() => void tick(), config.heartbeatMs)
    },
    async close() {
      if (closing) return
      closing = true
      if (timer !== undefined) clearInterval(timer)
      await reportCoverage('unavailable')
      abort.abort()
      await chain
    },
    tick,
    handleAgentStatus(agent, status) {
      if (status === 'running') running.set(agent.session, agent)
      else running.delete(agent.session)
      nextCoverageAt = 0
    },
    handleAgentDisposed(agent) {
      running.delete(agent.session)
      const lease = leases.get(agent.session)
      if (lease !== undefined && lease.terminal === null) {
        lease.terminal = { kind: 'interrupted' }
      }
      nextCoverageAt = 0
    },
    handleSessionEvent(session, event) {
      if (event.type === 'turn/start') turns.set(session, event.data.turn)
      if (event.type === 'tool/result') {
        for (const receipt of parseClientReceipts(event)) acceptReceipt(session, receipt)
      }
      if (event.type === 'turn/end') {
        turns.delete(session)
        const lease = leases.get(session)
        if (lease !== undefined) lease.terminal = event.data.reason
      }
    },
    environmentFor(agent) {
      const turn = turns.get(agent.session) ?? activeTurn(agent.session)
      if (turn === undefined) return Object.freeze({})
      return Object.freeze({
        [ENV_TOP_LEVEL]: topLevel(agent.session) ? '1' : '0',
        [ENV_TURN_ID]: String(turn),
        [ENV_RUNTIME_GENERATION]: config.runtimeGeneration,
        [ENV_REPORTER_ID]: config.reporterId,
      })
    },
    snapshot() {
      return { leaseCount: leases.size, runningCount: running.size, coverageState: coverageState() }
    },
  }
}

/**
 * Register the reporter against DSH lifecycle and trusted shell environment.
 * @param ctx - host context carrying Agent and shell-environment registries.
 * @param config - deployment transport, identity, and coverage configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const reporter = createMaintenanceReporter({
    config,
    transport: new UnixMaintenanceTransport(config.socketPath, config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  const disposers = [
    ctx.on('agent/status', ({ agent, status }) => { reporter.handleAgentStatus(agent, status) }),
    ctx.on('agent/disposed', ({ agent }) => { reporter.handleAgentDisposed(agent) }),
    ctx.on('session/event', (session, event) => { reporter.handleSessionEvent(session, event) }),
    ctx.shellEnv.register({
      name: 'maintenance-reporter',
      variables: {
        [ENV_TOP_LEVEL]: { description: 'Whether the calling DSH session is a top-level maintenance identity.' },
        [ENV_TURN_ID]: { description: 'Exact active DSH turn used by the maintenance client.' },
        [ENV_RUNTIME_GENERATION]: { description: 'Opaque DSH process generation used by maintenance commands.' },
        [ENV_REPORTER_ID]: { description: 'Admitted DSH maintenance reporter identity.' },
      },
      resolve: execution => execution.agent === undefined ? {} : reporter.environmentFor(execution.agent),
    }),
  ]
  reporter.start()
  ctx.effect(() => async () => {
    for (const dispose of disposers) dispose()
    await reporter.close()
  }, 'maintenance-reporter teardown')
}
