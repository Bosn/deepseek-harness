import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  createUserMessage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createMessage,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
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
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter, { estimateHeaderBytes, estimateMessageBytes } from '@deepseek-ai/dsh-token-meter'
import { Session, SessionId, canonicalHeader } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SummarizationInput, SummaryResult } from '../src/summarizer.ts'
import { summarizeWithLlm } from '../src/summarizer.ts'

/** Gateway request-size and large-timeout recovery coverage. */

const OFFLOADED_IMAGE_PREFIX = 'image omitted to fit request image limits'

const REQUEST_TOO_LARGE_MESSAGE
  = '413: {"message":"Request body size exceeds maximum allowed sized","id":"449fa579-c4a3-9e93-ab20-7eb6805b6101","type":"RequestTooLarge","code":"RequestTooLarge"}'

class RecordingCompactionEngine extends BasicCompactionEngine {
  readonly capturedInputs: SummarizationInput[] = []
  beforeSummary: ((call: number) => Promise<void>) | undefined

  override async summarize(
    input: SummarizationInput,
    _agent: Agent,
    _signal?: AbortSignal,
  ): Promise<SummaryResult> {
    this.capturedInputs.push(input)
    await this.beforeSummary?.(this.capturedInputs.length)
    return {
      summary: [{ type: 'text', text: 'CHECKPOINT SUMMARY' }],
      provider: 'mock',
      model: 'stub',
    }
  }
}

/** Conversation requests fail at configured indexes or above the optional repeated byte cap. */
class SizeGateAdapter extends LlmAdapter {
  readonly conversationRequests: GenerateOptions[] = []
  readonly conversationRequestBytes: number[] = []
  readonly summaryRequests: GenerateOptions[] = []
  private readonly retryPolicy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 1,
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'byte-pressure test retryPolicy')

  constructor(
    private readonly contextWindow: number,
    private readonly failing: ReadonlySet<number>,
    private readonly failureStatus?: number,
    private readonly failureCode: string = CONTEXT_WINDOW_EXCEEDED_CODE,
    private readonly failureMessage: string = REQUEST_TOO_LARGE_MESSAGE,
    private readonly failureRequestBytesEstimate?: number,
    private readonly requestByteCap?: number,
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
    const requestBytes = estimateHeaderBytes({
      config: { provider: options.provider, model: options.model },
      ...options.system === undefined ? {} : { system: options.system },
      ...options.tools === undefined ? {} : { tools: [...options.tools] },
    }) + options.messages.reduce((total, message) => total + estimateMessageBytes(message), 0)
    this.conversationRequestBytes.push(requestBytes)
    const exceedsByteCap = this.requestByteCap !== undefined && requestBytes > this.requestByteCap
    const requestBytesEstimate = this.failureRequestBytesEstimate
      ?? (exceedsByteCap ? requestBytes : undefined)
    if (this.failing.has(this.conversationRequests.length) || exceedsByteCap) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: this.failureMessage,
            code: this.failureCode,
            ...this.failureStatus === undefined ? {} : { status: this.failureStatus },
            ...requestBytesEstimate === undefined ? {} : { requestBytesEstimate },
          },
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
    /** One-based conversation request indexes that fail with the gateway error. */
    failing: ReadonlySet<number>
    failureStatus?: number
    omitFailureStatus?: boolean
    failureCode?: string
    failureMessage?: string
    failureRequestBytesEstimate?: number
    requestByteCap?: number
    compaction?: Partial<BasicCompactionConfig>
    withRetry?: boolean
  },
): Promise<{ ctx: Context; compact: RecordingCompactionEngine; adapter: SizeGateAdapter }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountInvariants(ctx)
  if (options.withRetry === true) await ctx.plugin(LlmRetry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = new SizeGateAdapter(
    options.contextWindow,
    options.failing,
    options.omitFailureStatus === true ? undefined : options.failureStatus ?? 413,
    options.failureCode,
    options.failureMessage,
    options.failureRequestBytesEstimate,
    options.requestByteCap,
  )
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

/** One routed closed turn whose large image is transiently offloaded before dispatch. */
function imageHistorySeed(): SessionEvent[] {
  const session = Session.create(SessionId('byte-image-history-seed'))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: canonicalHeader({ config: { provider: 'mock', model: 'mock' } }),
    reason: 'initial',
  })
  session.append('user/message', createUserMessage({
    content: [
      { type: 'text', text: 'old image context '.repeat(200) },
      {
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'d'.repeat(64)}`),
          mediaType: 'image/png',
          bytes: 2_000_000,
          width: 1_000,
          height: 1_000,
        },
      },
    ],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'historical response' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [...session.events]
}

async function createSeededAgent(
  ctx: Context,
  sessionId: string,
  seed: SessionEvent[],
): Promise<Agent> {
  const { agent } = await ctx.agents.create({
    sessionId: SessionId(sessionId),
    seed,
    agentOptions: {
      provider: 'unconfigured-agent-fallback',
      model: 'unconfigured-agent-fallback',
    },
  })
  return agent
}

describe('gateway request-size recovery', () => {
  it('compacts oversized history in bounded per-chunk transactions, then the rebuilt retry succeeds', async () => {
    // Two individually-sized chunks: together they exceed the 512KB default
    // summarizer cap, while each one fits the cap minus the appended
    // instruction reservation. The front chunk receives its own compaction
    // transaction first — no node is erased behind an omission marker.
    const hugeOne = 'a'.repeat(360 * 1024)
    const hugeTwo = 'b'.repeat(360 * 1024)
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set([1]),
    })
    try {
      const seed = sizedHistorySeed([
        { user: hugeOne, assistant: 'historical response 1' },
        { user: hugeTwo, assistant: 'historical response 2' },
      ])
      const agent = await createSeededAgent(ctx, 'bounded-replay', seed)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue from history' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      expect(adapter.conversationRequests).toHaveLength(2)
      // Two bounded transactions: the oversized front chunk first, then that
      // checkpoint plus the remaining span. No input carries an omission marker.
      expect(compact.capturedInputs).toHaveLength(2)
      for (const input of compact.capturedInputs) {
        const payloadBytes = input.messages
          .reduce((sum, message) => sum + estimateMessageBytes(message), 0)
        expect(payloadBytes).toBeLessThanOrEqual(512 * 1024)
        const replayed = JSON.stringify(input.messages)
        expect(replayed).not.toContain('omitted from this summarization input')
      }
      expect(JSON.stringify(compact.capturedInputs[1]!.messages)).toContain('CHECKPOINT SUMMARY')

      // The retried request carries one consolidated checkpoint and none of
      // the oversized original text.
      const retry = JSON.stringify(adapter.conversationRequests[1]!.messages)
      expect(retry).not.toContain(hugeOne)
      expect(retry).not.toContain(hugeTwo)
      expect((retry.match(/CHECKPOINT SUMMARY/g) ?? []).length).toBe(1)

      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not retry partial progress while a competing compaction owns the durable lock', async () => {
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set([1]),
    })
    const releaseCompetitor = Promise.withResolvers<undefined>()
    compact.beforeSummary = async (call) => {
      if (call === 2) await releaseCompetitor.promise
    }
    let competing: Promise<unknown> | undefined
    let fallbackRelease: ReturnType<typeof setTimeout> | undefined
    let restoreAppend: (() => void) | undefined
    try {
      const agent = await createSeededAgent(ctx, 'competing-recovery-lock', sizedHistorySeed([
        { user: 'a'.repeat(360 * 1024), assistant: 'historical response 1' },
        { user: 'b'.repeat(360 * 1024), assistant: 'historical response 2' },
      ]))
      const append = agent.session.append.bind(agent.session)
      let startedCompetitor = false
      const appendSpy = vi.spyOn(agent.session, 'append').mockImplementation(((type: string, ...rest: never[]) => {
        const event = (append as (...args: never[]) => unknown)(type as never, ...rest)
        if (!startedCompetitor && type === 'compaction/end') {
          startedCompetitor = true
          const head = agent.session.surface.nodes[0]
          if (head === undefined) throw new Error('prefix compaction left no surface node')
          competing = compact.compactRegion(head, head, agent, new AbortController().signal)
          // A broken short-circuit never reaches the downstream release below;
          // keep that failure finite so the request count can expose it.
          fallbackRelease = setTimeout(() => { releaseCompetitor.resolve(undefined) }, 25)
        }
        return event
      }) as never)
      restoreAppend = () => { appendSpy.mockRestore() }
      let delegated = 0
      ctx.on('agent/request-error', async (_payload, next) => {
        delegated += 1
        releaseCompetitor.resolve(undefined)
        await competing?.catch(() => undefined)
        return next()
      })

      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue from history' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      expect(startedCompetitor).toBe(true)
      expect(delegated).toBe(1)
      expect(adapter.conversationRequests).toHaveLength(1)
      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error' } },
      })
    } finally {
      releaseCompetitor.resolve(undefined)
      if (fallbackRelease !== undefined) clearTimeout(fallbackRelease)
      await competing?.catch(() => undefined)
      restoreAppend?.()
      await ctx.fiber.dispose()
    }
  })

  it('does not retry successful recovery after its final transaction yields the durable lock', async () => {
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set([1]),
      omitFailureStatus: true,
      failureCode: 'TIMEOUT',
      failureMessage: 'stream idle timeout after a large upload',
      failureRequestBytesEstimate: 700_000,
      withRetry: true,
    })
    const releaseCompetitor = Promise.withResolvers<undefined>()
    compact.beforeSummary = async (call) => {
      if (call === 2) await releaseCompetitor.promise
    }
    let competing: Promise<unknown> | undefined
    let fallbackRelease: ReturnType<typeof setTimeout> | undefined
    let restoreAppend: (() => void) | undefined
    try {
      const agent = await createSeededAgent(ctx, 'competing-final-recovery-lock', sizedHistorySeed([
        { user: 'a'.repeat(360 * 1024), assistant: 'historical response' },
      ]))
      const append = agent.session.append.bind(agent.session)
      let startedCompetitor = false
      const appendSpy = vi.spyOn(agent.session, 'append').mockImplementation(((type: string, ...rest: never[]) => {
        const event = (append as (...args: never[]) => unknown)(type as never, ...rest)
        if (!startedCompetitor && type === 'compaction/end') {
          startedCompetitor = true
          const head = agent.session.surface.nodes[0]
          if (head === undefined) throw new Error('recovery compaction left no surface node')
          competing = compact.compactRegion(head, head, agent, new AbortController().signal)
          fallbackRelease = setTimeout(() => { releaseCompetitor.resolve(undefined) }, 25)
        }
        return event
      }) as never)
      restoreAppend = () => { appendSpy.mockRestore() }
      let delegated = 0
      ctx.on('agent/request-error', async (_payload, next) => {
        delegated += 1
        releaseCompetitor.resolve(undefined)
        await competing?.catch(() => undefined)
        return next()
      })

      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue from history' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      expect(startedCompetitor).toBe(true)
      expect(delegated).toBe(1)
      expect(adapter.conversationRequests).toHaveLength(1)
      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error' } },
      })
    } finally {
      releaseCompetitor.resolve(undefined)
      if (fallbackRelease !== undefined) clearTimeout(fallbackRelease)
      await competing?.catch(() => undefined)
      restoreAppend?.()
      await ctx.fiber.dispose()
    }
  })

  it('applies a confirmed 413 budget below the proactive usefulness floor to its recovery', async () => {
    const rejectedBytes = 60 * 1024
    const recoveryBudget = Math.floor(rejectedBytes * 0.75)
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set([1]),
      failureRequestBytesEstimate: rejectedBytes,
      requestByteCap: recoveryBudget,
    })
    try {
      const agent = await createSeededAgent(ctx, 'small-gateway-recovery', sizedHistorySeed([
        { user: 'a'.repeat(24_000), assistant: 'historical response 1' },
        { user: 'b'.repeat(24_000), assistant: 'historical response 2' },
      ]))
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      expect(adapter.conversationRequests).toHaveLength(2)
      expect(adapter.conversationRequestBytes[0]).toBeGreaterThan(recoveryBudget)
      expect(adapter.conversationRequestBytes[1]).toBeLessThanOrEqual(recoveryBudget)
      expect(compact.capturedInputs.length).toBeGreaterThan(0)
      for (const input of compact.capturedInputs) {
        expect(input.maxRequestBytes).toBe(recoveryBudget)
      }
      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses a post-offload 413 budget to summarize image history after full-envelope offload', async () => {
    const rejectedBytes = 100_000
    const recoveryBudget = Math.floor(rejectedBytes * 0.75)
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set([1]),
      failureRequestBytesEstimate: rejectedBytes,
      requestByteCap: recoveryBudget,
    })
    try {
      const agent = await createSeededAgent(ctx, 'post-offload-image-413', imageHistorySeed())
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue after the image' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      expect(adapter.conversationRequests).toHaveLength(2)
      expect(adapter.conversationRequestBytes[0]).toBeGreaterThan(recoveryBudget)
      expect(adapter.conversationRequestBytes[1]).toBeLessThanOrEqual(recoveryBudget)
      expect(compact.capturedInputs).toHaveLength(1)
      expect(compact.capturedInputs[0]?.maxRequestBytes).toBe(recoveryBudget)
      const replay = JSON.stringify(compact.capturedInputs[0]?.messages)
      expect(replay).toContain(OFFLOADED_IMAGE_PREFIX)
      expect(replay).not.toContain('"type":"image"')
      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails loud instead of replaying when one indivisible message exceeds the cap', async () => {
    const indivisible = 'z'.repeat(600 * 1024) // Alone it still exceeds the cap.
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set([1]),
    })
    try {
      const agent = await createSeededAgent(ctx, 'indivisible-replay', sizedHistorySeed([
        { user: indivisible, assistant: 'historical response 1' },
      ]))
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue from history' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      // No summarizer ran, no compaction bracket opened, the turn ends with
      // the original overflow error — bounded, never a spin.
      expect(compact.capturedInputs).toHaveLength(0)
      expect(adapter.conversationRequests).toHaveLength(1)
      expect([...agent.session.events].some(event => event.type === 'compaction/start')).toBe(false)
      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('terminates instead of spinning when even the rebuilt request overflows', async () => {
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set([1, 2]),
      failureRequestBytesEstimate: 512 * 1024,
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
      failing: new Set(),
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
    // ~100KB of chunkable history: each seeded message stays below the
    // learned budget, so honest hierarchical compaction can cover it all.
    const seedTurns = Array.from({ length: 8 }, (_, index) => ({
      user: `seed-${index}-` + 'x'.repeat(12_000),
      assistant: `historical response ${index}`,
    }))
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set([1]),
    })
    try {
      const agent = await createSeededAgent(ctx, 'learned-budget', sizedHistorySeed(seedTurns))
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'first followup' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      // 413 + a rebuilt retry that succeeded after bounded chunk transactions.
      expect(adapter.conversationRequests).toHaveLength(2)
      expect(compact.capturedInputs.length).toBeGreaterThanOrEqual(2)

      // Later chunkable growth crosses the probe-learned budget (~3/4 of the
      // rejected size) and triggers a pressure compaction before any second
      // gateway rejection.
      for (let index = 0; index < 7; index += 1) {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: `grow-${index}-` + 'y'.repeat(15_000) }],
          source: { kind: 'user' },
        }))
        await waitForIdle(ctx, agent)
      }

      const requests = adapter.conversationRequests.length
      expect(requests).toBe(9) // 2 initial + 7 growth turns, none rejected.
      expect(compact.capturedInputs.length).toBeGreaterThanOrEqual(3)
      // Pressure compaction shadowed the oldest chunkable growth out of the
      // surviving request; the retained recent tail stays verbatim.
      const lastRequest = JSON.stringify(adapter.conversationRequests[requests - 1]!.messages)
      expect(lastRequest).not.toContain('grow-0-')
      expect(lastRequest).toContain('grow-6-')
      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('learns byte budgets only from confirmed HTTP 413 wire-size rejections', async () => {
    const seedFiller = 'seed '.repeat(20_000) // ~100KB: first request overflows on semantic context, not wire size.
    const growthFiller = 'grow '.repeat(25_000) // ~125KB, below token pressure and without a learned byte budget.
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set([1]),
      omitFailureStatus: true,
    })
    try {
      const agent = await createSeededAgent(ctx, 'semantic-overflow', sizedHistorySeed([
        { user: seedFiller, assistant: 'historical response 1' },
      ]))
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'first followup' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      // Semantic overflow recovery does not infer a wire-byte budget.
      expect(adapter.conversationRequests).toHaveLength(2)
      expect(compact.capturedInputs).toHaveLength(1)

      agent.followup(createUserMessage({
        content: [{ type: 'text', text: growthFiller }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      // No learned byte budget exists, so the oversized growth produces no
      // proactive compaction: token pressure alone governs, and it stays far
      // below the mega-context threshold.
      expect(adapter.conversationRequests).toHaveLength(3)
      expect(compact.capturedInputs).toHaveLength(1)
      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('compacts a large timed-out request before repeating its unchanged envelope', async () => {
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set([1]),
      omitFailureStatus: true,
      failureCode: 'TIMEOUT',
      failureMessage: 'pi-ai stream idle timeout after 300000ms',
    })
    try {
      const agent = await createSeededAgent(ctx, 'large-timeout-recovery', sizedHistorySeed(
        Array.from({ length: 8 }, (_, index) => ({
          user: `large-${index}-` + 't'.repeat(75_000),
          assistant: `historical response ${index}`,
        })),
      ))
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue from the large history' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      expect(adapter.conversationRequests).toHaveLength(2)
      expect(compact.capturedInputs.length).toBeGreaterThan(0)
      expect(JSON.stringify(adapter.conversationRequests[1]!.messages)).not.toContain('large-0-')
      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('preserves a small timeout for generic retry policy instead of compacting', async () => {
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set([1]),
      omitFailureStatus: true,
      failureCode: 'TIMEOUT',
      failureMessage: 'pi-ai stream idle timeout after 300000ms',
    })
    try {
      const agent = await createSeededAgent(ctx, 'small-timeout', sizedHistorySeed([
        { user: 'small history', assistant: 'historical response' },
      ]))
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      expect(adapter.conversationRequests).toHaveLength(1)
      expect(compact.capturedInputs).toHaveLength(0)
      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses the adapter-converted size for timeout recovery after image offload', async () => {
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set([1]),
      omitFailureStatus: true,
      failureCode: 'TIMEOUT',
      failureMessage: 'pi-ai stream idle timeout after 300000ms',
      failureRequestBytesEstimate: 16 * 1024,
    })
    try {
      const agent = await createSeededAgent(ctx, 'offloaded-image-timeout', sizedHistorySeed([
        { user: 'pre-conversion attachment bytes '.repeat(30_000), assistant: 'historical response' },
      ]))
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      expect(adapter.conversationRequests).toHaveLength(1)
      expect(compact.capturedInputs).toHaveLength(0)
      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports exhausted byte-pressure compaction when the retained tail alone exceeds the budget', async () => {
    // Twelve ~6KB messages: each fits the 8KB cap, so every chunk compacts,
    // yet the retained tail plus checkpoints stays above the byte budget and
    // the engine reports the exhausted budget instead of spinning.
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set(),
      compaction: { maxRequestBytes: 8_000, compactionRetries: 0 },
    })
    try {
      const agent = await createSeededAgent(ctx, 'byte-exhausted', sizedHistorySeed(
        Array.from({ length: 12 }, (_, index) => ({
          user: `seed-${index}-` + 'm'.repeat(5_500),
          assistant: `historical response ${index}`,
        })),
      ))
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue from history' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      expect(adapter.conversationRequests).toHaveLength(1)
      expect(compact.capturedInputs.length).toBeGreaterThan(0)
      expect([...agent.session.events].some(event => event.type === 'compaction/start')).toBe(true)
      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the probe-learned budget when a later larger rejection arrives', async () => {
    const { ctx, compact, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set([1, 3]),
      compaction: { maxRequestBytes: 1_000_000 },
    })
    try {
      const agent = await createSeededAgent(ctx, 'larger-rejection', sizedHistorySeed(
        Array.from({ length: 8 }, (_, index) => ({
          user: `seed-${index}-` + 'x'.repeat(12_000),
          assistant: `historical response ${index}`,
        })),
      ))
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'first followup' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)
      expect(adapter.conversationRequests).toHaveLength(2)

      // A later, larger rejection cannot raise the conservative learned cap.
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'z'.repeat(200 * 1024) }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      expect(adapter.conversationRequests).toHaveLength(4)
      expect(compact.capturedInputs.length).toBeGreaterThanOrEqual(3)
      expect([...agent.session.events].at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('verifies the complete summarizer request against the cap before any provider call', async () => {
    const { ctx, adapter } = await harness({
      contextWindow: 1_000_000,
      failing: new Set(),
    })
    try {
      const agent = await createSeededAgent(ctx, 'summarizer-cap-check', sizedHistorySeed([
        { user: 'a short history', assistant: 'response' },
      ]))
      await expect(summarizeWithLlm(ctx, {
        summarizationProvider: 'mock',
        summarizationModel: 'mock',
        maxTokens: 8192,
      }, {
        messages: [createUserMessage({
          content: [{ type: 'text', text: 'replay body' }],
          source: { kind: 'user' },
        })],
        tools: [{ name: 'work', description: 'work', parameters: { type: 'object' } }],
        maxRequestBytes: 50,
      }, agent, undefined)).rejects.toThrow(/byte cap/)

      expect(adapter.conversationRequests).toHaveLength(0)
      expect(adapter.summaryRequests).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
