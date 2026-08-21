import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE, createMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import TokenMeter, { estimateMessageBytes } from '@deepseek-ai/dsh-token-meter'
import { Session, SessionId, canonicalHeader } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SummarizationInput, SummaryResult } from '../src/summarizer.ts'

/**
 * Gateway request-size (HTTP 413 `RequestTooLarge`) regression coverage.
 * These tests pin the exact failure recorded from a real bricked session:
 * the provider rejects the request body with `RequestTooLarge`, the harness
 * must NOT classify it as terminal INVALID_REQUEST (which makes every later
 * turn fail instantly — the dead loop), must force-compact with a bounded
 * summarizer input, and must retry the rebuilt request exactly within the
 * configured overflow-retry budget.
 */

const REQUEST_TOO_LARGE_MESSAGE
  = '413: {"message":"Request body size exceeds maximum allowed sized","id":"449fa579-c4a3-9e93-ab20-7eb6805b6101","type":"RequestTooLarge","code":"RequestTooLarge"}'

class RecordingCompactionEngine extends BasicCompactionEngine {
  readonly capturedInputs: SummarizationInput[] = []

  override async summarize(
    input: SummarizationInput,
    _agent: Agent,
    _signal?: AbortSignal,
  ): Promise<SummaryResult> {
    this.capturedInputs.push(input)
    return {
      summary: [{ type: 'text', text: 'CHECKPOINT SUMMARY' }],
      provider: 'mock',
      model: 'stub',
    }
  }
}

/** Conversation requests 1..overflowRequests fail like the real gateway; later ones succeed. */
class SizeGateAdapter extends LlmAdapter {
  readonly conversationRequests: GenerateOptions[] = []
  readonly summaryRequests: GenerateOptions[] = []
  private readonly retryPolicy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 1,
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'byte-pressure test retryPolicy')

  constructor(
    private readonly contextWindow: number,
    private readonly overflowRequests: number,
  ) {
    super()
  }

  override resolveModel(): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider: 'mock',
      id: 'mock',
      name: 'mock',
      context: { contextWindow: this.contextWindow },
    })
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const trailing = options.messages.at(-1)?.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('') ?? ''
    if (trailing.includes('acting as a compaction engine')) {
      this.summaryRequests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'RECOVERY CHECKPOINT' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    this.conversationRequests.push(options)
    if (this.conversationRequests.length <= this.overflowRequests) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: REQUEST_TOO_LARGE_MESSAGE, code: CONTEXT_WINDOW_EXCEEDED_CODE },
        },
      }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'recovered '.repeat(30) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

async function harness(
  options: {
    contextWindow: number
    overflowRequests: number
    compaction?: Partial<BasicCompactionConfig>
  },
): Promise<{ ctx: Context; compact: RecordingCompactionEngine; adapter: SizeGateAdapter }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountInvariants(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = new SizeGateAdapter(options.contextWindow, options.overflowRequests)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineContentToolFixture({
    name: 'work',
    description: 'does work',
    parameters: { i: { type: 'number' } },
    async execute() {
      return [{ type: 'text', text: 'work result' }]
    },
  }))
  ctx.on('agent/request', async (_payload, next) => ({
    ...await next(), provider: 'mock', model: 'mock',
  }))
  const compact = new RecordingCompactionEngine(ctx, {
    thresholdRatio: 0.5,
    retainTokens: 50,
    maxTokens: 8192,
    compactionRetries: 0,
    maxOverflowRetries: 1,
    ...options.compaction,
  })
  return { ctx, compact, adapter }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function sizedHistorySeed(turns: readonly { user: string; assistant: string }[]): SessionEvent[] {
  const session = Session.create(SessionId('byte-history-seed'))
  for (const [index, item] of turns.entries()) {
    const turn = index + 1
    session.append('turn/start', { turn })
    // A routed header must exist before the first request of a followup turn,
    // otherwise pressure compaction cannot resolve the routed model target.
    session.append('request/header', {
      header: canonicalHeader({ config: { provider: 'mock', model: 'mock' } }),
      reason: 'initial',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: item.user }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: item.assistant }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return [...session.events]
}

async function createSeededAgent(
  ctx: Context,
  sessionId: string,
  seed: SessionEvent[],
): Promise<Agent> {
  const { agent } = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId(sessionId),
    seed,
    agentOptions: {
      provider: 'unconfigured-agent-fallback',
      model: 'unconfigured-agent-fallback',
    },
  })
  return agent
}

describe('gateway 413 RequestTooLarge recovery (the bricked-session dead loop)', () => {
  it('force-compacts with a bounded summarizer input, then the rebuilt retry succeeds', async () => {
    const huge = 'x'.repeat(600 * 1024) // ~600KB — beyond the default 512KB summarizer cap.
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      overflowRequests: 1,
    })
    try {
      const seed = sizedHistorySeed([
        { user: huge, assistant: 'historical response 1' },
        { user: 'RECENT HISTORY', assistant: 'historical response 2' },
      ])
      const agent = await createSeededAgent(ctx, 'bounded-replay', seed)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue from history' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      expect(adapter.conversationRequests).toHaveLength(2)
      // The summarizer is subclass-overridden, so no auxiliary LLM call occurs;
      // the bounded replay input is what the recording engine captured.
      expect(compact.capturedInputs).toHaveLength(1)

      // The summarizer input dropped the oldest oversized message with a marker
      // and its replayed payload fits the default 512KB budget.
      const input = compact.capturedInputs[0]!
      const firstBlockText = input.messages[0]!.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('')
      expect(firstBlockText).toContain('omitted from this summarization input')
      const payloadBytes = input.messages.slice(1)
        .reduce((sum, message) => sum + estimateMessageBytes(message), 0)
      expect(payloadBytes).toBeLessThanOrEqual(512 * 1024)

      // The retried request no longer carries the oversized history.
      const retry = JSON.stringify(adapter.conversationRequests[1]!.messages)
      expect(retry).not.toContain(huge)
      expect(retry).toContain('CHECKPOINT SUMMARY')

      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('terminates instead of spinning when even the rebuilt request overflows', async () => {
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      overflowRequests: 2,
    })
    try {
      const agent = await createSeededAgent(ctx, 'unbounded-retry', sizedHistorySeed([
        // Enough shadowed content that the mock checkpoint is a real shrink.
        { user: `OLD HISTORY SENTINEL ${'filler '.repeat(200)}`, assistant: 'historical response 1' },
      ]))
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue from history' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      // One recovery compaction ran, exactly one retry followed, and the turn
      // ended with the overflow error — bounded, never a spin.
      expect(compact.capturedInputs).toHaveLength(1)
      expect(adapter.conversationRequests).toHaveLength(2)
      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('compacts proactively at the configured request-byte budget (no provider 413 needed)', async () => {
    const oldFiller = 'old context '.repeat(1_600) // ~19KB: oldest, must be shadowed.
    const recentFiller = 'recent tail '.repeat(2_100) // ~25KB: retained tail, fits the budget.
    const { ctx, adapter } = await harness({
      contextWindow: 1_000_000,
      overflowRequests: 0,
      compaction: { maxRequestBytes: 30_000 },
    })
    try {
      const agent = await createSeededAgent(ctx, 'byte-pressure', sizedHistorySeed([
        { user: oldFiller, assistant: 'historical response 1' },
        { user: recentFiller, assistant: 'historical response 2' },
      ]))
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue from history' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      // No provider failure ever: pressure compaction shrank the first request
      // below the byte budget before it reached the gateway. The oldest span is
      // checkpointed; the recent tail legitimately remains verbatim.
      expect(adapter.conversationRequests).toHaveLength(1)
      const firstRequest = JSON.stringify(adapter.conversationRequests[0]!.messages)
      expect(firstRequest).not.toContain(oldFiller)
      expect(firstRequest).toContain('CHECKPOINT SUMMARY')
      const events = [...agent.session.events]
      expect(events.some(event => event.type === 'compaction/start')).toBe(true)
      expect(events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('learns the rejected request size and compacts later growth before the gateway rejects again', async () => {
    const seedFiller = 'seed '.repeat(20_000) // ~100KB: first request overflows the gateway probe.
    const growthFiller = 'grow '.repeat(25_000) // ~125KB: later growth must compact proactively.
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      overflowRequests: 1,
    })
    try {
      const agent = await createSeededAgent(ctx, 'learned-budget', sizedHistorySeed([
        { user: seedFiller, assistant: 'historical response 1' },
      ]))
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'first followup' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      expect(adapter.conversationRequests).toHaveLength(2) // 413 + rebuilt retry.
      expect(compact.capturedInputs).toHaveLength(1)

      agent.followup(createUserMessage({
        content: [{ type: 'text', text: growthFiller }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      // A turn's own message lands only after its first pre-step, so the
      // learned budget shows up on a later step: a third followup whose tail
      // pushes the oversized growth out of the retained region.
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'tail '.repeat(200) }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      // The gateway never rejected the later requests: with the probe-learned
      // byte budget (~3/4 of the rejected size) active, the oversized growth
      // triggered a second pressure compaction before it went back out.
      expect(adapter.conversationRequests).toHaveLength(4)
      expect(compact.capturedInputs).toHaveLength(2)
      expect(JSON.stringify(adapter.conversationRequests[3]!.messages)).not.toContain(growthFiller)
      const events = [...agent.session.events]
      const lastTurnStart = events.findLast(event => event.type === 'turn/start')!
      expect(events.some(event =>
        event.type === 'compaction/start' && event.seq > lastTurnStart.seq)).toBe(true)
      expect(events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
