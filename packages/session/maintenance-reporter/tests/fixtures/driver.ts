#!/usr/bin/env node
/** Boot the real maintenance composition and capture its owner-socket wire. */

import { chmod, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('maintenance-reporter driver requires a config path')

const socketPath = join(process.cwd(), 'maintenance-ingest.sock')
const policyPath = join(process.cwd(), 'policy.json')
process.env.DSH_MAINTENANCE_E2E_SOCKET = socketPath
process.env.DSH_MAINTENANCE_E2E_POLICY = policyPath
await writeFile(policyPath, '{"fixture":true}\n')

const commands: Record<string, unknown>[] = []
const server = createServer((socket) => {
  let input = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    input += chunk
    const newline = input.indexOf('\n')
    if (newline < 0) return
    const command = JSON.parse(input.slice(0, newline)) as Record<string, unknown>
    commands.push(structuredClone(command))
    const operation = String(command.operation)
    const lease = command.lease as { expectedHolderRevision?: number } | null
    const revision = (lease?.expectedHolderRevision ?? 0) + 1
    const holder = operation === 'report-coverage' ? null : {
      holderId: 'holder:dsh:session-one',
      leaseId: 'lease:session-one',
      generation: 1,
      holderRevision: revision,
      status: operation === 'release' ? 'released' : 'active',
      expiresAt: operation === 'release' ? null : '2026-08-30T00:20:00Z',
    }
    socket.end(`${JSON.stringify({
      protocolVersion: 'bo.agents.maintenance-holder-command-result/v1',
      requestId: command.requestId,
      operation,
      outcome: 'applied',
      dbNow: '2026-08-30T00:00:00Z',
      reasonCode: null,
      holder,
      aggregate: { protocolVersion: 'bo.agents.maintenance-aggregate/v1' },
    })}\n`)
  })
})
server.listen(socketPath)
await once(server, 'listening')
await chmod(socketPath, 0o600)

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`maintenance-reporter driver timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const ctx = await boot('maintenance-reporter-e2e', resolveConfigPath(configPath, undefined))
let disposed = false
try {
  const session = ctx.sessions.create(SessionId('session-one'), {
    meta: { cwd: process.cwd(), agentPreset: 'standard' },
  })
  const agent = {
    id: session.id,
    session,
    status: 'running',
    ctx,
  } as unknown as Agent
  ctx.agents.register(agent)
  agentEvents(ctx, agent).emit('agent/status', { status: 'running' })
  session.append('turn/start', { turn: 1 })

  const environment = ctx.shellEnv.collect({ agent } as unknown as ToolExecution)
  const actor = {
    kind: 'dsh',
    reporterId: environment.DSH_MAINTENANCE_REPORTER_ID,
    runtimeGeneration: environment.DSH_MAINTENANCE_RUNTIME_GENERATION,
    taskId: 'session-one',
    turnId: '1',
    topLevel: true,
  }
  const receipt = {
    protocolVersion: 'bo.agents.maintenance-client-receipt/v1',
    actor,
    commandResult: {
      protocolVersion: 'bo.agents.maintenance-holder-command-result/v1',
      requestId: 'maintenance:acquire:fixture',
      operation: 'acquire',
      outcome: 'applied',
      dbNow: '2026-08-30T00:00:00Z',
      reasonCode: null,
      holder: {
        holderId: 'holder:dsh:session-one',
        leaseId: 'lease:session-one',
        generation: 1,
        holderRevision: 1,
        status: 'active',
        expiresAt: '2026-08-30T00:20:00Z',
      },
      aggregate: { protocolVersion: 'bo.agents.maintenance-aggregate/v1' },
    },
  }
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('maintenance-acquire'),
      content: [{ type: 'text', text: `BOAGENTS_MAINTENANCE_RECEIPT ${JSON.stringify(receipt)}` }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })

  await waitFor(() => commands.some(command => command.operation === 'heartbeat'), 'heartbeat')
  session.append('turn/end', {
    turn: 1,
    reason: { kind: 'error', error: { message: 'fixture', code: 'UNKNOWN' } },
  })
  await waitFor(() => commands.some(command => command.operation === 'release'), 'terminal release')
  await ctx.fiber.dispose()
  disposed = true
  await waitFor(() => commands.some(command => command.operation === 'report-coverage'
    && (command.coverage as { state?: string }).state === 'unavailable'), 'teardown coverage')
  await writeFile('maintenance-captures.json', JSON.stringify({ environment, commands }))
} finally {
  if (!disposed) await ctx.fiber.dispose()
  await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
}
