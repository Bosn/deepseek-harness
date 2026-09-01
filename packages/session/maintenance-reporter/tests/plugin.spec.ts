import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  createMaintenanceReporter,
  type Config,
  type MaintenanceTransport,
} from '../src/index.ts'

const RESULT_PROTOCOL = 'bo.agents.maintenance-holder-command-result/v1'
const AGGREGATE_PROTOCOL = 'bo.agents.maintenance-aggregate/v1'
const RECEIPT_PROTOCOL = 'bo.agents.maintenance-client-receipt/v1'
const RECEIPT_PREFIX = 'BOAGENTS_MAINTENANCE_RECEIPT '
const hash = (character: string): string => `sha256:${character.repeat(64)}`

function holder(revision = 1, leaseId = 'lease:one') {
  return {
    holderId: 'holder:dsh:session-one',
    leaseId,
    generation: 1,
    holderRevision: revision,
    status: 'active' as const,
    expiresAt: '2026-08-30T00:20:00Z',
  }
}

interface TestTransport extends MaintenanceTransport {
  commands: Record<string, unknown>[]
  failRelease: boolean
}

class FakeTransport implements TestTransport {
  commands: Record<string, unknown>[] = []
  revision = 1
  failRelease = false

  async send(command: Record<string, unknown>) {
    this.commands.push(structuredClone(command))
    if (command.operation === 'release' && this.failRelease) throw new Error('fixture unavailable')
    if (command.operation === 'heartbeat') this.revision++
    return {
      protocolVersion: RESULT_PROTOCOL as typeof RESULT_PROTOCOL,
      requestId: String(command.requestId),
      operation: String(command.operation),
      outcome: 'applied' as const,
      dbNow: '2026-08-30T00:00:00Z',
      reasonCode: null,
      holder: command.operation === 'report-coverage'
        ? null
        : command.operation === 'release'
          ? { ...holder(this.revision), status: 'released' as const }
          : holder(this.revision),
      aggregate: { protocolVersion: AGGREGATE_PROTOCOL as typeof AGGREGATE_PROTOCOL },
    }
  }
}

class ApplyThenTimeoutTransport implements TestTransport {
  commands: Record<string, unknown>[] = []
  failRelease = false
  private heartbeatApplied = false
  private releaseApplied = false

  async send(command: Record<string, unknown>) {
    this.commands.push(structuredClone(command))
    if (command.operation === 'heartbeat' && !this.heartbeatApplied) {
      this.heartbeatApplied = true
      throw new Error('fixture heartbeat response was lost after apply')
    }
    if (command.operation === 'release' && !this.releaseApplied) {
      this.releaseApplied = true
      throw new Error('fixture release response was lost after apply')
    }
    const replay = command.operation === 'heartbeat' || command.operation === 'release'
    return {
      protocolVersion: RESULT_PROTOCOL as typeof RESULT_PROTOCOL,
      requestId: String(command.requestId),
      operation: String(command.operation),
      outcome: replay ? 'replay' as const : 'applied' as const,
      dbNow: '2026-08-30T00:00:00Z',
      reasonCode: null,
      holder: command.operation === 'report-coverage'
        ? null
        : command.operation === 'release'
          ? { ...holder(2), status: 'released' as const }
          : holder(2),
      aggregate: { protocolVersion: AGGREGATE_PROTOCOL as typeof AGGREGATE_PROTOCOL },
    }
  }
}

async function fixture(
  overrides: Partial<Config> = {},
  suppliedTransport: TestTransport = new FakeTransport(),
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-maintenance-reporter-'))
  const policyPath = join(root, 'policy.json')
  await writeFile(policyPath, '{"fixture":true}\n')
  const config: Config = {
    socketPath: join(root, 'ingest.sock'),
    policyPath,
    reporterHash: hash('a'),
    heartbeatMs: 300_000,
    requestTimeoutMs: 15_000,
    instructionCoveredPresets: ['standard', 'ptc', 'cordis', 'minimal'],
    reportingCapablePresets: ['standard', 'ptc', 'cordis'],
    ...overrides,
  }
  const transport = suppliedTransport
  let now = 0
  const reporter = createMaintenanceReporter({ config, transport, now: () => now, schedule: false })
  return { reporter, transport, advance: (value: number) => { now = value } }
}

function session(id: string, options: { preset?: string; subagent?: boolean } = {}): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    cwd: '/workspace',
    isSeeded: false,
    agentPreset: options.preset ?? 'standard',
    ...(options.subagent ? { origin: 'subagent' as const, delegationDepth: 1 } : {}),
  })
}

function agent(value: Session): Agent {
  return {
    id: value.id,
    session: value,
    status: 'running',
  } as unknown as Agent
}

function appendTurn(value: Session, turn = 1): Extract<SessionEvent, { type: 'turn/start' }> {
  return value.append('turn/start', { turn })
}

function receiptEvent(value: Session, actor: Record<string, unknown>, lease = holder(), turn = 1): Extract<SessionEvent, { type: 'tool/result' }> {
  const receipt = {
    protocolVersion: RECEIPT_PROTOCOL,
    actor,
    commandResult: {
      protocolVersion: RESULT_PROTOCOL,
      requestId: 'maintenance:acquire-one',
      operation: 'acquire',
      outcome: 'applied',
      dbNow: '2026-08-30T00:00:00Z',
      reasonCode: null,
      holder: lease,
      aggregate: { protocolVersion: AGGREGATE_PROTOCOL },
    },
  }
  return value.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [{ type: 'text', text: `${RECEIPT_PREFIX}${JSON.stringify(receipt)}` }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
}

describe('maintenance reporter lifecycle', () => {
  it('contributes exact top-level turn identity and never grants it to subagents', async () => {
    const { reporter } = await fixture()
    const top = session('session-one')
    reporter.handleSessionEvent(top, appendTurn(top))
    expect(reporter.environmentFor(agent(top))).toMatchObject({
      DSH_MAINTENANCE_TOP_LEVEL: '1',
      DSH_MAINTENANCE_TURN_ID: '1',
      DSH_MAINTENANCE_REPORTER_ID: 'dsh-maintenance-reporter',
    })

    const child = session('child-one', { subagent: true })
    reporter.handleSessionEvent(child, appendTurn(child))
    expect(reporter.environmentFor(agent(child)).DSH_MAINTENANCE_TOP_LEVEL).toBe('0')
    await reporter.close()
  })

  it('adopts one exact durable acquire receipt, heartbeats at five minutes, and releases the matching terminal', async () => {
    const { reporter, transport, advance } = await fixture()
    const current = session('session-one')
    const owner = agent(current)
    reporter.handleAgentStatus(owner, 'running')
    reporter.handleSessionEvent(current, appendTurn(current))
    const environment = reporter.environmentFor(owner)
    const actor = {
      kind: 'dsh',
      reporterId: environment.DSH_MAINTENANCE_REPORTER_ID,
      runtimeGeneration: environment.DSH_MAINTENANCE_RUNTIME_GENERATION,
      taskId: 'session-one',
      turnId: '1',
      topLevel: true,
    }
    reporter.handleSessionEvent(current, receiptEvent(current, actor))
    expect(reporter.snapshot().leaseCount).toBe(1)

    advance(300_000)
    await reporter.tick()
    const heartbeat = transport.commands.find(command => command.operation === 'heartbeat')!
    expect(heartbeat.lease).toEqual({ leaseId: 'lease:one', generation: 1, expectedHolderRevision: 1 })
    expect(heartbeat.requestId).toMatch(/^maintenance:heartbeat:[a-f0-9]{64}$/u)

    const terminal = current.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'fixture', code: 'UNKNOWN' } },
    })
    reporter.handleSessionEvent(current, terminal)
    await reporter.tick()
    const release = transport.commands.find(command => command.operation === 'release')!
    expect(release.releaseReason).toBe('failed')
    expect(release.requestId).toMatch(/^maintenance:release:[a-f0-9]{64}$/u)
    expect(reporter.snapshot().leaseCount).toBe(0)
    await reporter.close()
  })

  it('never overwrites a first lease with a conflicting receipt', async () => {
    const { reporter } = await fixture()
    const current = session('session-one')
    reporter.handleSessionEvent(current, appendTurn(current))
    const environment = reporter.environmentFor(agent(current))
    const actor = {
      kind: 'dsh', reporterId: environment.DSH_MAINTENANCE_REPORTER_ID,
      runtimeGeneration: environment.DSH_MAINTENANCE_RUNTIME_GENERATION,
      taskId: 'session-one', turnId: '1', topLevel: true,
    }
    reporter.handleSessionEvent(current, receiptEvent(current, actor))
    reporter.handleSessionEvent(current, receiptEvent(current, actor, holder(1, 'lease:other')))
    expect(reporter.snapshot()).toMatchObject({ leaseCount: 1, coverageState: 'unavailable' })
    await reporter.close()
  })

  it('keeps one session lease when a later turn replays the same holder generation', async () => {
    const { reporter } = await fixture()
    const current = session('session-one')
    reporter.handleSessionEvent(current, appendTurn(current, 1))
    let environment = reporter.environmentFor(agent(current))
    reporter.handleSessionEvent(current, receiptEvent(current, {
      kind: 'dsh', reporterId: environment.DSH_MAINTENANCE_REPORTER_ID,
      runtimeGeneration: environment.DSH_MAINTENANCE_RUNTIME_GENERATION,
      taskId: 'session-one', turnId: '1', topLevel: true,
    }))
    reporter.handleSessionEvent(current, current.append('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    reporter.handleSessionEvent(current, appendTurn(current, 2))
    environment = reporter.environmentFor(agent(current))
    reporter.handleSessionEvent(current, receiptEvent(current, {
      kind: 'dsh', reporterId: environment.DSH_MAINTENANCE_REPORTER_ID,
      runtimeGeneration: environment.DSH_MAINTENANCE_RUNTIME_GENERATION,
      taskId: 'session-one', turnId: '2', topLevel: true,
    }, holder(2), 2))
    expect(reporter.snapshot().leaseCount).toBe(1)
    await reporter.close()
  })

  it('retries ambiguous heartbeat and release responses with byte-identical commands', async () => {
    const transport = new ApplyThenTimeoutTransport()
    const { reporter, advance } = await fixture({}, transport)
    const current = session('session-one')
    reporter.handleSessionEvent(current, appendTurn(current))
    const environment = reporter.environmentFor(agent(current))
    reporter.handleSessionEvent(current, receiptEvent(current, {
      kind: 'dsh', reporterId: environment.DSH_MAINTENANCE_REPORTER_ID,
      runtimeGeneration: environment.DSH_MAINTENANCE_RUNTIME_GENERATION,
      taskId: 'session-one', turnId: '1', topLevel: true,
    }))
    advance(300_000)
    await reporter.tick()
    const heartbeats = transport.commands.filter(command => command.operation === 'heartbeat')
    expect(heartbeats).toHaveLength(2)
    expect(heartbeats[0]).toEqual(heartbeats[1])

    reporter.handleSessionEvent(current, current.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'fixture', code: 'UNKNOWN' } },
    }))
    await reporter.tick()
    const releases = transport.commands.filter(command => command.operation === 'release')
    expect(releases).toHaveLength(2)
    expect(releases[0]).toEqual(releases[1])
    expect(reporter.snapshot().leaseCount).toBe(0)
    await reporter.close()
  })

  it('reports minimal and uncovered mutation-capable presets unavailable without creating holders', async () => {
    const { reporter, transport } = await fixture()
    const minimal = session('minimal-one', { preset: 'minimal' })
    reporter.handleAgentStatus(agent(minimal), 'running')
    await reporter.tick()
    expect(reporter.snapshot()).toEqual({ leaseCount: 0, runningCount: 1, coverageState: 'unavailable' })
    const coverage = transport.commands.filter(command => command.operation === 'report-coverage').at(-1)!
    expect((coverage.coverage as { state: string }).state).toBe('unavailable')
    await reporter.close()
  })

  it('a terminal transport failure stops renewals and leaves fixed expiry as fallback', async () => {
    const { reporter, transport, advance } = await fixture()
    const current = session('session-one')
    reporter.handleSessionEvent(current, appendTurn(current))
    const environment = reporter.environmentFor(agent(current))
    const actor = {
      kind: 'dsh', reporterId: environment.DSH_MAINTENANCE_REPORTER_ID,
      runtimeGeneration: environment.DSH_MAINTENANCE_RUNTIME_GENERATION,
      taskId: 'session-one', turnId: '1', topLevel: true,
    }
    reporter.handleSessionEvent(current, receiptEvent(current, actor))
    transport.failRelease = true
    reporter.handleSessionEvent(current, current.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } }))
    await reporter.tick()
    advance(600_000)
    await reporter.tick()
    expect(transport.commands.filter(command => command.operation === 'heartbeat')).toHaveLength(0)
    expect(transport.commands.filter(command => command.operation === 'release')).toHaveLength(4)
    expect(reporter.snapshot().leaseCount).toBe(1)
    await reporter.close()
  })

  it('minimal preset loads the global instruction plugin but remains reporting-unavailable by contract', async () => {
    const text = await readFile(new URL('../../../preset/agent-presets/presets/minimal/agent.cordis.yml', import.meta.url), 'utf8')
    expect(text).toContain("name: '@deepseek-ai/dsh-agent-instructions'")
    expect(text).toContain('maintenance reporter')
  })
})
