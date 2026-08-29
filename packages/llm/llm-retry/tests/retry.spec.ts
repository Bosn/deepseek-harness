import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ToolCallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, resolveRetryPolicy  } from '@deepseek-ai/dsh-llm'
import type {
  AlwaysRetryPolicyConfig,
  BackoffConfig,
  GenerateOptions,
  NormalRetryPolicyConfig,
  ResolvedRetryPolicy,
  RetryPolicyConfig,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry/types'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as retry from '../src/index.ts'

type ScriptEntry = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

it('keeps the browser-safe retry payload identical to the session event', () => {
  expectTypeOf<LlmRetryEventData>().toEqualTypeOf<SessionEventMap['llm/retry']>()
})

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private retryPolicies: Readonly<Record<string, ResolvedRetryPolicy | undefined>> = {}

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('retry test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }

  configureRetryPolicies(
    policies: Readonly<Record<string, RetryPolicyConfig | undefined>>,
  ): void {
    this.retryPolicies = Object.fromEntries(Object.entries(policies).map(([provider, policy]) => [
      provider,
      policy === undefined
        ? undefined
        : resolveRetryPolicy(policy, `retry test provider "${provider}" retryPolicy`),
    ]))
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.retryPolicies[provider]
  }
}

async function* partialToolFailure(error: Error): AsyncGenerator<StreamChunk> {
  const id = ToolCallId('discarded-call')
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'discarded partial output' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'discarded partial output' } }
  yield { type: 'block-start', index: 1, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 1, id, name: 'danger', argumentsDelta: '{}' }
  yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'danger', arguments: '{}' } }
  throw error
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * A degenerate empty provider completion as an error finish chunk. Both
 * adapters emit this shape and the EMPTY_RESPONSE code (the field the policy
 * routes on); the message text here is the deepseek adapter's phrasing (pi-ai
 * qualifies it with the model name).
 */
function emptyCompletion(): StreamChunk[] {
  return [
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
    {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
      },
    },
  ]
}

async function harness(
  adapter: ScriptedAdapter,
  policies: Readonly<Record<string, RetryPolicyConfig | undefined>> = { mock: normalConfig() },
  beforeRetry?: (ctx: Context) => void,
  internals: retry.RetryInternals = {},
): Promise<{ ctx: Context; retryFiber: Fiber; disposeAdapter: () => void }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  beforeRetry?.(ctx)
  adapter.configureRetryPolicies(policies)
  const retryFiber = await ctx.plugin(Object.assign((inner: Context) => {
    retry.apply(inner, {}, internals)
  }, { inject: retry.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  const disposeAdapter = ctx.llm.registerAdapter(['mock', 'other'], adapter)
  return { ctx, retryFiber, disposeAdapter }
}

function normalConfig(
  overrides: Partial<Omit<NormalRetryPolicyConfig, 'mode'>> = {},
): NormalRetryPolicyConfig {
  const { backoff, ...policy } = overrides
  return {
    mode: 'normal',
    maxRetries: 2,
    ...policy,
    backoff: {
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0,
      // Pin a 500 ms schedule so the suite's RATE_LIMIT cases keep their
      // baseline speed; cooldown-specific tests configure the real defaults.
      rateLimitDelaysMs: [500],
      ...backoff,
    },
  }
}

function alwaysConfig(backoff: BackoffConfig = {}): AlwaysRetryPolicyConfig {
  return {
    mode: 'always',
    backoff: {
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0,
      ...backoff,
    },
  }
}

function waitForIdle(_ctx: Context, agent: Agent): Promise<void> {
  return agent.whenIdle()
}

function waitForRetry(ctx: Context, agent: Agent, retryNumber: number): Promise<Extract<SessionEvent, { type: 'llm/retry' }>> {
  return new Promise((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/retry' && event.data.retry === retryNumber) {
        dispose()
        resolve(event)
      }
    })
  })
}

let context: Context | undefined

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
})

describe('provider-routed retry policy', () => {
  it('records the scheduled delay before retrying the request', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      mock: normalConfig({
        retryableCodes: ['SERVER', 'RATE_LIMIT'],
        maxRetriesByCode: { TIMEOUT: 1, TRANSPORT: 2 },
      }),
    }, undefined, { random: () => 0.5 }))
    const agent = context.agentLoop.create(SessionId('retry-success'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    const event = await scheduled

    expect(event.data.retryId).toEqual(expect.any(String))
    expect(event.data).toEqual({
      retryId: event.data.retryId,
      turn: 1,
      step: 1,
      provider: 'mock',
      mode: 'normal',
      policyKey: '["normal",2,["RATE_LIMIT","SERVER"],[["TIMEOUT",1],["TRANSPORT",2]],500,10000,0,[500]]',
      retry: 1,
      maxRetries: 2,
      delayMs: 500,
      failure: { message: 'busy', code: 'RATE_LIMIT', status: 429 },
    })
    expect(adapter.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(adapter.requests).toHaveLength(1)

    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.filter(item => item.type === 'step/start').map(item => item.data))
      .toEqual([{ turn: 1, step: 1 }])
    expect(agent.session.deriveMessages().at(-1)).toEqual({
      id: expect.any(String) as unknown,
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    })
  })

  it('retries an EMPTY_RESPONSE error finish under the default retryable codes', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      emptyCompletion(),
      textResponse('recovered'),
    ])
    // No retryableCodes override: this proves the default policy covers the
    // adapters' empty-completion classification end to end (finish-chunk error
    // delivery, not a thrown stream error).
    ;({ ctx: context } = await harness(adapter))
    const agent = context.agentLoop.create(SessionId('retry-empty-response'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    const event = await scheduled
    expect(event.data.failure).toEqual({
      message: 'model returned a completed response with no content',
      code: EMPTY_RESPONSE_CODE,
    })

    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'assistant/message').map(event => ({
      turn: event.data.turn,
      step: event.data.step,
    }))).toEqual([{ turn: 1, step: 1 }])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
    })
  })

  it('leaves partial failed chunks on their step without committing a message or tool side effect', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      partialToolFailure(new LlmError('stream interrupted', 'TRANSPORT')),
      textResponse('recovered'),
    ])
    ;({ ctx: context } = await harness(adapter))
    let toolExecutions = 0
    context.tools.register(defineContentToolFixture({
      name: 'danger',
      description: 'must not run for a failed provider attempt',
      parameters: {},
      async execute() {
        toolExecutions += 1
        return [{ type: 'text', text: 'unexpected' }]
      },
    }))
    const agent = context.agentLoop.create(SessionId('retry-partial'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await scheduled
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await idle

    const retryEvent = agent.session.events.find(event => event.type === 'llm/retry')
    const failedChunks = agent.session.events.filter(event =>
      event.type === 'assistant/chunk'
      && retryEvent !== undefined
      && event.seq < retryEvent.seq,
    )
    expect(failedChunks).toHaveLength(7)
    const assistantMessages = agent.session.events.filter(event => event.type === 'assistant/message')
    expect(assistantMessages.map(event => ({
      turn: event.data.turn,
      step: event.data.step,
    }))).toEqual([{ turn: 1, step: 1 }])
    expect(failedChunks.every(event =>
      !assistantMessages[0]?.sourceEventSeqs?.includes(event.seq),
    )).toBe(true)
    expect(agent.session.events.some(event => event.type === 'tool/call')).toBe(false)
    expect(toolExecutions).toBe(0)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    })
  })

  it('applies bounded exponential jitter and stops after the configured budget', async () => {
    vi.useFakeTimers()
    const samples = [0, 1]
    const adapter = new ScriptedAdapter([
      new LlmError('busy one', 'SERVER'),
      new LlmError('busy two', 'SERVER'),
      new LlmError('busy three', 'SERVER'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { jitterRatio: 0.1 },
    }) }, undefined, {
      random: () => samples.shift() ?? 0.5,
    }))
    const agent = context.agentLoop.create(SessionId('retry-exhausted'), { provider: 'mock', model: 'mock' })
    const first = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await first).data.delayMs).toBe(450)

    const second = waitForRetry(context, agent, 2)
    await vi.advanceTimersByTimeAsync(450)
    expect((await second).data.delayMs).toBe(1_100)

    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1_100)
    await idle

    expect(adapter.requests).toHaveLength(3)
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(2)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'busy three', code: 'SERVER' } } },
    })
  })

  it('caps repeated idle timeouts independently of the shared retry budget', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('idle timeout one', 'TIMEOUT'),
      new LlmError('idle timeout two', 'TIMEOUT'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      maxRetries: 8,
      backoff: { initialDelayMs: 1, maxDelayMs: 1 },
    }) }))
    const agent = context.agentLoop.create(SessionId('retry-timeout-cap'), { provider: 'mock', model: 'mock' })
    const first = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await first).data).toMatchObject({ retry: 1, failure: { code: 'TIMEOUT' } })
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'idle timeout two', code: 'TIMEOUT' } } },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets downstream specialized recovery run before normal fallback', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('large request timed out', 'TIMEOUT'),
      textResponse('specialized recovery won'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig() }))
    context.on('agent/request-error', async ({ agent }) => {
      const head = agent.session.surface.nodes[0]!
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'durable specialized recovery' }],
        source: { kind: 'plugin', plugin: 'test' },
      }), {
        surfaceOp: { op: 'replace', start: head, end: head },
        sourceEventSeqs: [head],
      })
      return { kind: 'retry' }
    })
    const agent = context.agentLoop.create(SessionId('retry-normal-composition'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.surface.replaceGeneration).toBe(1)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
  })

  it('does not override downstream durable recovery progress with normal fallback', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('large request timed out', 'TIMEOUT'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { initialDelayMs: 1, maxDelayMs: 1 },
    }) }))
    context.on('agent/request-error', async ({ agent }) => {
      const head = agent.session.surface.nodes[0]!
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'durable specialized recovery' }],
        source: { kind: 'plugin', plugin: 'test' },
      }), {
        surfaceOp: { op: 'replace', start: head, end: head },
        sourceEventSeqs: [head],
      })
      return undefined
    })
    const agent = context.agentLoop.create(SessionId('retry-normal-durable-downstream'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.surface.replaceGeneration).toBe(1)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
  })

  it('does not schedule normal fallback after downstream cancellation', async () => {
    const adapter = new ScriptedAdapter([new LlmError('large request timed out', 'TIMEOUT')])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig() }))
    context.on('agent/request-error', ({ agent }) => {
      agent.cancel({ kind: 'user' })
      return Promise.resolve(undefined)
    })
    const agent = context.agentLoop.create(SessionId('retry-normal-downstream-cancel'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
  })

  it('accepts the zero-delay lower jitter bound', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'SERVER'),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 1 },
    }) }, undefined, { random: () => 0 }))
    const agent = context.agentLoop.create(SessionId('retry-zero-delay'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await scheduled).data.delayMs).toBe(0)

    const idle = waitForIdle(context, agent)
    await vi.runAllTimersAsync()
    await idle
    expect(adapter.requests).toHaveLength(2)
  })

  it('uses a bounded provider Retry-After verbatim when the cooldown schedule does not say more', async () => {
    vi.useFakeTimers()
    const accepted = new ScriptedAdapter([
      new LlmError('wait', 'RATE_LIMIT', { providerRetryAfterMs: 2_000 }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(accepted, { mock: normalConfig({
      backoff: { jitterRatio: 1 },
    }) }, undefined, { random: () => 0.5 }))
    const acceptedAgent = context.agentLoop.create(SessionId('retry-after-accepted'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, acceptedAgent, 1)
    acceptedAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    // The pinned 500 ms schedule is the floor; the 2 s provider hint raises it.
    expect((await scheduled).data.delayMs).toBe(2_000)
    const acceptedIdle = waitForIdle(context, acceptedAgent)
    await vi.advanceTimersByTimeAsync(2_000)
    await acceptedIdle
    expect(accepted.requests).toHaveLength(2)

    await context.fiber.dispose()
    const raised = new ScriptedAdapter([
      new LlmError('wait too long', 'RATE_LIMIT', { providerRetryAfterMs: 10_001 }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(raised, { mock: normalConfig() }))
    const raisedAgent = context.agentLoop.create(SessionId('retry-after-raised'), { provider: 'mock', model: 'mock' })
    const raisedScheduled = waitForRetry(context, raisedAgent, 1)
    raisedAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    // The cooldown path floors at the schedule entry and keeps the provider
    // hint even past the exponential ceiling, instead of giving up.
    expect((await raisedScheduled).data.delayMs).toBe(10_001)
    const raisedIdle = waitForIdle(context, raisedAgent)
    await vi.advanceTimersByTimeAsync(10_001)
    await raisedIdle
    expect(raised.requests).toHaveLength(2)
  })

  it('uses a bounded non-rate-limit provider Retry-After verbatim', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('wait', 'SERVER', { providerRetryAfterMs: 2_000 }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig() }))
    const agent = context.agentLoop.create(SessionId('retry-after-server-accepted'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await scheduled).data.delayMs).toBe(2_000)
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(2_000)
    await idle
    expect(adapter.requests).toHaveLength(2)
  })

  it('delegates a non-rate-limit over-cap provider Retry-After in normal mode', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('wait too long', 'SERVER', { providerRetryAfterMs: 10_001 }),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig() }))
    const agent = context.agentLoop.create(SessionId('retry-after-server-over-cap'), { provider: 'mock', model: 'mock' })
    const idle = waitForIdle(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses local jittered backoff when always mode receives an over-cap Retry-After', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('wait too long', 'AUTH', { providerRetryAfterMs: 10 }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({
      initialDelayMs: 2,
      maxDelayMs: 4,
      jitterRatio: 0.5,
    }) }, undefined, { random: () => 1 }))
    const agent = context.agentLoop.create(SessionId('retry-always-over-cap'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await scheduled).data.delayMs).toBe(3)
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(3)
    await idle

    expect(adapter.requests).toHaveLength(2)
  })

  it('delegates non-transient failures without scheduling a timer', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    ;({ ctx: context } = await harness(adapter))
    const agent = context.agentLoop.create(SessionId('retry-auth'), { provider: 'mock', model: 'mock' })
    const idle = waitForIdle(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('delegates when no final adapter served the failed request', async () => {
    const adapter = new ScriptedAdapter([textResponse('must not run')])
    const mounted = await harness(adapter, { mock: alwaysConfig() })
    context = mounted.ctx
    mounted.disposeAdapter()
    const agent = context.agentLoop.create(SessionId('retry-no-serving-policy'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'missing route' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
    const end = agent.session.events.at(-1)
    expect(end).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'NO_ADAPTER' } } },
    })
    if (end?.type === 'turn/end' && end.data.reason.kind === 'error') {
      expect(end.data.reason.error.message).toContain('no adapter registered for provider')
    }
  })

  it('selects policy by the failed request provider', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('mock auth failed', 'AUTH'),
      new LlmError('other auth failed', 'AUTH'),
      textResponse('other recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      other: alwaysConfig({ initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }),
    }))

    const normalAgent = context.agentLoop.create(SessionId('retry-provider-normal'), {
      provider: 'mock',
      model: 'mock',
    })
    const normalIdle = waitForIdle(context, normalAgent)
    normalAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'normal' }], source: { kind: 'user' } }))
    await normalIdle
    expect(normalAgent.session.events.some(event => event.type === 'llm/retry')).toBe(false)

    const alwaysAgent = context.agentLoop.create(SessionId('retry-provider-always'), {
      provider: 'other',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, alwaysAgent, 1)
    alwaysAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'always' }], source: { kind: 'user' } }))
    expect((await scheduled).data).toMatchObject({
      provider: 'other',
      mode: 'always',
      retry: 1,
      delayMs: 1,
    })
    const alwaysIdle = waitForIdle(context, alwaysAgent)
    await vi.advanceTimersByTimeAsync(1)
    await alwaysIdle

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other', 'other'])
  })

  it('selects an always policy from the provider chosen by agent/request', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('rerouted auth failed', 'AUTH'),
      textResponse('rerouted recovery'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      other: alwaysConfig({ initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }),
    }, (ctx) => {
      ctx.on('agent/request', async (_payload, next) => ({
        ...await next(),
        provider: 'other',
      }))
    }))
    const agent = context.agentLoop.create(SessionId('retry-provider-rerouted'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'reroute' }], source: { kind: 'user' } }))
    expect((await scheduled).data).toMatchObject({ provider: 'other', mode: 'always' })
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests.map(request => request.provider)).toEqual(['other', 'other'])
  })

  it('keeps finite retry budgets scoped to the failed provider', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('mock failed', 'SERVER'),
      new LlmError('other failed', 'SERVER'),
      textResponse('other recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      mock: normalConfig({
        maxRetries: 1,
        backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      }),
      other: normalConfig({
        maxRetries: 1,
        backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      }),
    }, (ctx) => {
      ctx.on('agent/request', async (_payload, next) => ({
        ...await next(),
        provider: adapter.requests.length === 0 ? 'mock' : 'other',
      }))
    }))
    const agent = context.agentLoop.create(SessionId('retry-provider-budgets'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'switch provider after failure' }],
      source: { kind: 'user' },
    }))
    await vi.runAllTimersAsync()
    await idle

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other', 'other'])
    expect(agent.session.events.filter(event => event.type === 'llm/retry').map(event => ({
      provider: event.data.provider,
      retry: event.data.retry,
    }))).toEqual([
      { provider: 'mock', retry: 1 },
      { provider: 'other', retry: 1 },
    ])
  })

  it.each(['thrown', 'in-band'] as const)(
    'uses the serving registration policy and resets changed-policy history after a %s failure',
    async (failureKind) => {
      vi.useFakeTimers()
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const oldAdapter = new ScriptedAdapter([(async function * (): AsyncGenerator<StreamChunk> {
        entered.resolve(undefined)
        await release.promise
        if (failureKind === 'thrown') {
          throw new LlmError('old route auth failed', 'AUTH')
        }
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'old route auth failed', code: 'AUTH' },
          },
        }
      })()])
      const mounted = await harness(oldAdapter, { mock: alwaysConfig({
        initialDelayMs: 1,
        maxDelayMs: 1,
      }) })
      context = mounted.ctx
      const agent = context.agentLoop.create(SessionId('retry-serving-registration'), {
        provider: 'mock',
        model: 'mock',
      })
      const scheduled = waitForRetry(context, agent, 1)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'replace while in flight' }],
        source: { kind: 'user' },
      }))
      await entered.promise

      mounted.disposeAdapter()
      const replacement = new ScriptedAdapter([
        new LlmError('replacement failed', 'AUTH'),
        textResponse('replacement recovered'),
      ])
      replacement.configureRetryPolicies({ mock: alwaysConfig({
        initialDelayMs: 3,
        maxDelayMs: 3,
      }) })
      context.llm.registerAdapter(['mock'], replacement)
      release.resolve(undefined)

      const firstEvent = await scheduled
      expect(firstEvent.data).toMatchObject({
        provider: 'mock',
        mode: 'always',
        retry: 1,
        delayMs: 1,
      })
      const replacementScheduled = waitForRetry(context, agent, 1)
      const idle = waitForIdle(context, agent)
      await vi.advanceTimersByTimeAsync(1)
      const replacementEvent = await replacementScheduled
      expect(replacementEvent.data).toMatchObject({
        provider: 'mock',
        mode: 'always',
        retry: 1,
        delayMs: 3,
      })
      expect(replacementEvent.data.policyKey).not.toBe(firstEvent.data.policyKey)
      await vi.advanceTimersByTimeAsync(3)
      await idle

      expect(oldAdapter.requests).toHaveLength(1)
      expect(replacement.requests).toHaveLength(2)
      expect(agent.session.deriveMessages().at(-1)).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: 'replacement recovered' }],
      })
    },
  )

  it('keeps always mode unbounded while preserving cancellable jittered backoff', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('auth one', 'AUTH'),
      new LlmError('auth two', 'AUTH'),
      new LlmError('auth three', 'AUTH'),
      new LlmError('auth four', 'AUTH'),
      textResponse('eventually recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({
      initialDelayMs: 1,
      maxDelayMs: 4,
      jitterRatio: 0.1,
    }) }, undefined, { random: () => 1 }))
    const agent = context.agentLoop.create(SessionId('retry-always-unbounded'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'keep trying' }], source: { kind: 'user' } }))
    await vi.runAllTimersAsync()
    await idle

    const events = agent.session.events.filter(event => event.type === 'llm/retry')
    expect(adapter.requests).toHaveLength(5)
    expect(events.map(event => ({
      provider: event.data.provider,
      mode: event.data.mode,
      retry: event.data.retry,
      delayMs: event.data.delayMs,
      hasMax: 'maxRetries' in event.data,
    }))).toEqual([
      { provider: 'mock', mode: 'always', retry: 1, delayMs: 1.1, hasMax: false },
      { provider: 'mock', mode: 'always', retry: 2, delayMs: 2.2, hasMax: false },
      { provider: 'mock', mode: 'always', retry: 3, delayMs: 4, hasMax: false },
      { provider: 'mock', mode: 'always', retry: 4, delayMs: 4, hasMax: false },
    ])
  })

  it('keeps failed error text and partial output out of every retried model context', async () => {
    vi.useFakeTimers()
    const diagnostic = 'private provider diagnostic must not enter context'
    const adapter = new ScriptedAdapter([
      partialToolFailure(new LlmError(diagnostic, 'AUTH')),
      textResponse('recovered without leaked context'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({
      initialDelayMs: 1,
      maxDelayMs: 1,
    }) }))
    const agent = context.agentLoop.create(SessionId('retry-always-context-isolation'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'safe input' }], source: { kind: 'user' } }))
    await scheduled
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.messages).toEqual(adapter.requests[0]?.messages)
    const retriedContext = JSON.stringify(adapter.requests[1]?.messages)
    expect(retriedContext).not.toContain(diagnostic)
    expect(retriedContext).not.toContain('discarded partial output')
    expect(agent.session.events.some(event =>
      event.type === 'llm/retry' && event.data.failure.message === diagnostic,
    )).toBe(true)
  })

  it('lets downstream specialized recovery run before always fallback', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('requires specialized recovery', 'AUTH'),
      textResponse('specialized recovery won'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig() }))
    context.on('agent/request-error', async ({ agent }) => {
      const head = agent.session.surface.nodes[0]!
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'durable specialized recovery' }],
        source: { kind: 'plugin', plugin: 'test' },
      }), {
        surfaceOp: { op: 'replace', start: head, end: head },
        sourceEventSeqs: [head],
      })
      return { kind: 'retry' }
    })
    const agent = context.agentLoop.create(SessionId('retry-always-composition'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.surface.replaceGeneration).toBe(1)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
  })

  it('does not override downstream durable recovery progress with always fallback', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('requires specialized recovery', 'AUTH'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({
      initialDelayMs: 1,
      maxDelayMs: 1,
    }) }))
    const warnings: string[] = []
    context.logger.warn = ((message: string) => void warnings.push(message)) as typeof context.logger.warn
    context.on('agent/request-error', async ({ agent }) => {
      const head = agent.session.surface.nodes[0]!
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'durable specialized recovery' }],
        source: { kind: 'plugin', plugin: 'test' },
      }), {
        surfaceOp: { op: 'replace', start: head, end: head },
        sourceEventSeqs: [head],
      })
      throw new Error('downstream recovery failed after replacement')
    })
    const agent = context.agentLoop.create(SessionId('retry-always-durable-downstream'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.surface.replaceGeneration).toBe(1)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
    expect(warnings).toContainEqual(expect.stringContaining('ignored a downstream recovery failure'))
  })

  it.each([
    ['synchronously', () => { throw new Error('downstream recovery failed') }],
    ['asynchronously', async () => { throw new Error('downstream recovery failed') }],
  ])('falls back to always retry when downstream recovery throws %s', async (_kind, failDownstream) => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('requires fallback', 'AUTH'),
      textResponse('always recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({
      initialDelayMs: 1,
      maxDelayMs: 1,
    }) }))
    context.on('agent/request-error', failDownstream)
    const agent = context.agentLoop.create(SessionId('retry-always-downstream-error'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await scheduled
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests).toHaveLength(2)
  })

  it('aborts and drains a captured backoff before plugin disposal completes', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('temporary', 'TRANSPORT'),
      textResponse('must not run'),
    ])
    const mounted = await harness(adapter, { mock: alwaysConfig() })
    context = mounted.ctx
    const agent = context.agentLoop.create(SessionId('retry-hmr'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await scheduled
    const idle = waitForIdle(context, agent)

    await mounted.retryFiber.dispose()
    await idle
    await vi.advanceTimersByTimeAsync(60_000)

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drains delegated recovery before completing plugin disposal', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    const mounted = await harness(adapter, { mock: alwaysConfig() })
    context = mounted.ctx
    const release = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const order: string[] = []
    context.on('agent/request-error', async () => {
      entered.resolve(undefined)
      await release.promise
      order.push('downstream')
      return { kind: 'retry' }
    })
    const agent = context.agentLoop.create(SessionId('retry-delegated-disposal'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent).then(() => { order.push('idle') })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await entered.promise

    const disposing = mounted.retryFiber.dispose().then(() => { order.push('disposed') })
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      disposing.then(() => 'disposed' as const),
      new Promise<'blocked'>((resolve) => { timer = setTimeout(() => { resolve('blocked') }, 100) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    expect(outcome).toBe('blocked')

    release.resolve(undefined)
    await disposing
    await idle

    expect(order[0]).toBe('downstream')
    expect(order).toEqual(expect.arrayContaining(['disposed', 'idle']))
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
  })

  it('drains delegated recovery before turn cancellation reaches idle', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    const mounted = await harness(adapter, { mock: alwaysConfig() })
    context = mounted.ctx
    const downstream = Promise.withResolvers<RequestErrorAction>()
    const entered = Promise.withResolvers<undefined>()
    const order: string[] = []
    context.on('agent/request-error', async () => {
      entered.resolve(undefined)
      const decision = await downstream.promise
      order.push('downstream')
      return decision
    })
    const agent = context.agentLoop.create(SessionId('retry-delegated-cancel'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent).then(() => { order.push('idle') })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await entered.promise

    agent.cancel({ kind: 'user' })
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      idle.then(() => 'idle' as const),
      new Promise<'blocked'>((resolve) => { timer = setTimeout(() => { resolve('blocked') }, 100) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    expect(outcome).toBe('blocked')

    downstream.resolve({ kind: 'retry' })
    await idle

    expect(order).toEqual(['downstream', 'idle'])
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
  })

  it('handles synchronous cancellation while entering delegated recovery', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    const mounted = await harness(adapter, { mock: alwaysConfig() })
    context = mounted.ctx
    const downstream = Promise.withResolvers<RequestErrorAction>()
    const entered = Promise.withResolvers<undefined>()
    context.on('agent/request-error', ({ agent }) => {
      agent.cancel({ kind: 'user' })
      entered.resolve(undefined)
      return downstream.promise
    })
    const agent = context.agentLoop.create(SessionId('retry-delegated-sync-cancel'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await entered.promise
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      idle.then(() => 'idle' as const),
      new Promise<'blocked'>((resolve) => { timer = setTimeout(() => { resolve('blocked') }, 100) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    expect(outcome).toBe('blocked')

    downstream.resolve({ kind: 'retry' })
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
  })

  it('fails a captured callback after disposal without entering downstream policy', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    const captured = Promise.withResolvers<undefined>()
    let invokeCaptured: (() => Promise<void>) | undefined
    const mounted = await harness(adapter, {}, (ctx) => {
      ctx.on('agent/request-error', (_payload, next) => {
        return new Promise<RequestErrorAction>((resolve) => {
          invokeCaptured = async () => { resolve(await next()) }
          captured.resolve(undefined)
        })
      })
    })
    context = mounted.ctx
    let downstreamCalls = 0
    context.on('agent/request-error', async (_payload, next) => {
      downstreamCalls += 1
      return next()
    })
    const agent = context.agentLoop.create(SessionId('retry-captured-disposal'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await captured.promise

    await mounted.retryFiber.dispose()
    if (invokeCaptured === undefined) throw new Error('request-error waterfall did not capture retry callback')
    await invokeCaptured()
    await idle

    expect(downstreamCalls).toBe(0)
    expect(adapter.requests).toHaveLength(1)
  })

  it('lets turn cancellation win during backoff without opening another step', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('permanent', 'AUTH'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig() }))
    const agent = context.agentLoop.create(SessionId('retry-cancel'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await scheduled
    const idle = waitForIdle(context, agent)
    agent.cancel({ kind: 'user' })
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['normal', normalConfig()],
    ['always', alwaysConfig()],
  ])('lets an earlier recovery listener cancel before %s retry policy runs', async (_mode, policy) => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('temporary', 'SERVER'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: policy }, (ctx) => {
      ctx.on('agent/request-error', async ({ agent }, next) => {
        agent.cancel({ kind: 'user' })
        return next()
      })
    }))
    const agent = context.agentLoop.create(SessionId('retry-pre-cancel'), { provider: 'mock', model: 'mock' })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
  })

  it('handles synchronous cancellation from the retry status event', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('temporary', 'SERVER'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter))
    const agent = context.agentLoop.create(SessionId('retry-event-cancel'), { provider: 'mock', model: 'mock' })
    context.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/retry') agent.cancel({ kind: 'user' })
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  describe('RATE_LIMIT cooldown schedule', () => {
    function cooldownConfig(
      overrides: Partial<Omit<NormalRetryPolicyConfig, 'mode'>> = {},
    ): NormalRetryPolicyConfig {
      const { backoff, ...policy } = overrides
      return {
        mode: 'normal',
        maxRetries: 5,
        ...policy,
        backoff: {
          initialDelayMs: 500,
          maxDelayMs: 10_000,
          jitterRatio: 0,
          rateLimitDelaysMs: [60_000, 180_000, 300_000],
          ...backoff,
        },
      }
    }

    it('waits one, three, and five minutes across three cooldown retries before failing the turn', async () => {
      vi.useFakeTimers()
      const adapter = new ScriptedAdapter([
        new LlmError('throttled one', 'RATE_LIMIT', { status: 429 }),
        new LlmError('throttled two', 'RATE_LIMIT', { status: 429 }),
        new LlmError('throttled three', 'RATE_LIMIT', { status: 429 }),
        new LlmError('throttled four', 'RATE_LIMIT', { status: 429 }),
      ])
      ;({ ctx: context } = await harness(adapter, { mock: cooldownConfig() }))
      const agent = context.agentLoop.create(SessionId('cooldown-exhausted'), { provider: 'mock', model: 'mock' })
      const first = waitForRetry(context, agent, 1)

      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      expect((await first).data.delayMs).toBe(60_000)

      const second = waitForRetry(context, agent, 2)
      await vi.advanceTimersByTimeAsync(60_000)
      expect((await second).data.delayMs).toBe(180_000)

      const third = waitForRetry(context, agent, 3)
      await vi.advanceTimersByTimeAsync(180_000)
      expect((await third).data.delayMs).toBe(300_000)

      const idle = waitForIdle(context, agent)
      await vi.advanceTimersByTimeAsync(300_000)
      await idle

      expect(adapter.requests).toHaveLength(4)
      expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(3)
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: {
          reason: {
            kind: 'error',
            error: { message: 'throttled four', code: 'RATE_LIMIT', status: 429 },
          },
        },
      })
      expect(vi.getTimerCount()).toBe(0)
    })

    it('recovers the turn when the gateway clears during the cooldown window', async () => {
      vi.useFakeTimers()
      const adapter = new ScriptedAdapter([
        new LlmError('throttled once', 'RATE_LIMIT', { status: 429 }),
        textResponse('recovered after cooldown'),
      ])
      ;({ ctx: context } = await harness(adapter, { mock: cooldownConfig() }))
      const agent = context.agentLoop.create(SessionId('cooldown-recovered'), { provider: 'mock', model: 'mock' })
      const scheduled = waitForRetry(context, agent, 1)

      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      expect((await scheduled).data.delayMs).toBe(60_000)

      const idle = waitForIdle(context, agent)
      await vi.advanceTimersByTimeAsync(60_000)
      await idle

      expect(adapter.requests).toHaveLength(2)
      expect(agent.session.events.filter(event => event.type === 'step/start').map(event => event.data))
        .toEqual([{ turn: 1, step: 1 }])
      expect(agent.session.deriveMessages().at(-1)).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: 'recovered after cooldown' }],
      })
    })

    it('raises a cooldown entry with a valid provider Retry-After and ignores an out-of-range one', async () => {
      vi.useFakeTimers()
      const raised = new ScriptedAdapter([
        new LlmError('wait for me', 'RATE_LIMIT', { providerRetryAfterMs: 600_001 }),
        textResponse('raised recovery'),
      ])
      ;({ ctx: context } = await harness(raised, { mock: cooldownConfig() }))
      const raisedAgent = context.agentLoop.create(SessionId('cooldown-retry-after-raise'), {
        provider: 'mock',
        model: 'mock',
      })
      const raisedScheduled = waitForRetry(context, raisedAgent, 1)
      raisedAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      expect((await raisedScheduled).data.delayMs).toBe(600_001)
      const raisedIdle = waitForIdle(context, raisedAgent)
      await vi.advanceTimersByTimeAsync(600_001)
      await raisedIdle
      expect(raised.requests).toHaveLength(2)

      await context.fiber.dispose()
      const absurd = new ScriptedAdapter([
        new LlmError('unusable advice', 'RATE_LIMIT', { providerRetryAfterMs: MAX_TIMER_DELAY_MS + 1 }),
        textResponse('schedule recovery'),
      ])
      ;({ ctx: context } = await harness(absurd, { mock: cooldownConfig() }))
      const absurdAgent = context.agentLoop.create(SessionId('cooldown-retry-after-absurd'), {
        provider: 'mock',
        model: 'mock',
      })
      const absurdScheduled = waitForRetry(context, absurdAgent, 1)
      absurdAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      expect((await absurdScheduled).data.delayMs).toBe(60_000)
      const absurdIdle = waitForIdle(context, absurdAgent)
      await vi.advanceTimersByTimeAsync(60_000)
      await absurdIdle
      expect(absurd.requests).toHaveLength(2)
    })

    it('never jitters a cooldown wait below its schedule entry or a valid provider hint', async () => {
      vi.useFakeTimers()
      const adviceFloor = new ScriptedAdapter([
        new LlmError('throttled with advice', 'RATE_LIMIT', { providerRetryAfterMs: 120_000 }),
        textResponse('advice floor recovery'),
      ])
      ;({ ctx: context } = await harness(adviceFloor, { mock: cooldownConfig({
        backoff: { jitterRatio: 0.1 },
      }) }, undefined, { random: () => 0 }))
      const adviceAgent = context.agentLoop.create(SessionId('cooldown-jitter-floor-advice'), {
        provider: 'mock',
        model: 'mock',
      })
      const adviceScheduled = waitForRetry(context, adviceAgent, 1)
      adviceAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      // The low jitter sample would give 54_000; the 120 s provider hint must survive.
      expect((await adviceScheduled).data.delayMs).toBe(120_000)
      const adviceIdle = waitForIdle(context, adviceAgent)
      await vi.advanceTimersByTimeAsync(120_000)
      await adviceIdle
      expect(adviceFloor.requests).toHaveLength(2)

      await context.fiber.dispose()
      const entryFloor = new ScriptedAdapter([
        new LlmError('throttled without advice', 'RATE_LIMIT', { status: 429 }),
        textResponse('entry floor recovery'),
      ])
      ;({ ctx: context } = await harness(entryFloor, { mock: cooldownConfig({
        backoff: { jitterRatio: 0.1 },
      }) }, undefined, { random: () => 0 }))
      const entryAgent = context.agentLoop.create(SessionId('cooldown-jitter-floor-entry'), {
        provider: 'mock',
        model: 'mock',
      })
      const entryScheduled = waitForRetry(context, entryAgent, 1)
      entryAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      // The same sample would give 54_000; the 60 s schedule entry is the floor.
      expect((await entryScheduled).data.delayMs).toBe(60_000)
      const entryIdle = waitForIdle(context, entryAgent)
      await vi.advanceTimersByTimeAsync(60_000)
      await entryIdle
      expect(entryFloor.requests).toHaveLength(2)
    })

    it('advances the cooldown schedule only on RATE_LIMIT failures', async () => {
      vi.useFakeTimers()
      const leadServer = new ScriptedAdapter([
        new LlmError('transient server', 'SERVER'),
        new LlmError('first throttle', 'RATE_LIMIT', { status: 429 }),
        textResponse('mixed lead recovery'),
      ])
      ;({ ctx: context } = await harness(leadServer, { mock: cooldownConfig() }))
      const leadAgent = context.agentLoop.create(SessionId('cooldown-mixed-lead'), { provider: 'mock', model: 'mock' })
      const leadFirst = waitForRetry(context, leadAgent, 1)
      leadAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      expect((await leadFirst).data.delayMs).toBe(500)
      const leadSecond = waitForRetry(context, leadAgent, 2)
      await vi.advanceTimersByTimeAsync(500)
      // The first 429 owns the first entry: 60 s, not the 180 s a total-count index would give.
      expect((await leadSecond).data.delayMs).toBe(60_000)
      const leadIdle = waitForIdle(context, leadAgent)
      await vi.advanceTimersByTimeAsync(60_000)
      await leadIdle
      expect(leadServer.requests).toHaveLength(3)

      await context.fiber.dispose()
      const interleaved = new ScriptedAdapter([
        new LlmError('throttle one', 'RATE_LIMIT', { status: 429 }),
        new LlmError('transient server', 'SERVER'),
        new LlmError('throttle two', 'RATE_LIMIT', { status: 429 }),
        textResponse('interleaved recovery'),
      ])
      ;({ ctx: context } = await harness(interleaved, { mock: cooldownConfig() }))
      const interleavedAgent = context.agentLoop.create(SessionId('cooldown-interleaved'), {
        provider: 'mock',
        model: 'mock',
      })
      const interleavedFirst = waitForRetry(context, interleavedAgent, 1)
      interleavedAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      expect((await interleavedFirst).data.delayMs).toBe(60_000)
      const interleavedSecond = waitForRetry(context, interleavedAgent, 2)
      await vi.advanceTimersByTimeAsync(60_000)
      expect((await interleavedSecond).data.delayMs).toBe(1_000)
      const interleavedThird = waitForRetry(context, interleavedAgent, 3)
      await vi.advanceTimersByTimeAsync(1_000)
      // The SERVER retry did not advance the schedule: the second 429 owns the
      // second entry, 180 s.
      expect((await interleavedThird).data.delayMs).toBe(180_000)
      const interleavedIdle = waitForIdle(context, interleavedAgent)
      await vi.advanceTimersByTimeAsync(180_000)
      await interleavedIdle
      expect(interleaved.requests).toHaveLength(4)

      await context.fiber.dispose()
      const lateThrottle = new ScriptedAdapter([
        new LlmError('server one', 'SERVER'),
        new LlmError('server two', 'SERVER'),
        new LlmError('server three', 'SERVER'),
        new LlmError('first throttle', 'RATE_LIMIT', { status: 429 }),
        textResponse('late throttle recovery'),
      ])
      ;({ ctx: context } = await harness(lateThrottle, { mock: cooldownConfig() }))
      const lateAgent = context.agentLoop.create(SessionId('cooldown-late-first-throttle'), {
        provider: 'mock',
        model: 'mock',
      })
      const lateFirst = waitForRetry(context, lateAgent, 1)
      lateAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      expect((await lateFirst).data.delayMs).toBe(500)
      const lateSecond = waitForRetry(context, lateAgent, 2)
      await vi.advanceTimersByTimeAsync(500)
      expect((await lateSecond).data.delayMs).toBe(1_000)
      const lateThird = waitForRetry(context, lateAgent, 3)
      await vi.advanceTimersByTimeAsync(1_000)
      expect((await lateThird).data.delayMs).toBe(2_000)
      const lateFourth = waitForRetry(context, lateAgent, 4)
      await vi.advanceTimersByTimeAsync(2_000)
      // The first 429 still owns the first entry instead of being delegated.
      expect((await lateFourth).data.delayMs).toBe(60_000)
      const lateIdle = waitForIdle(context, lateAgent)
      await vi.advanceTimersByTimeAsync(60_000)
      await lateIdle
      expect(lateThrottle.requests).toHaveLength(5)
    })

    it('caps normal-mode RATE_LIMIT retries at the shorter schedule length', async () => {
      vi.useFakeTimers()
      const adapter = new ScriptedAdapter([
        new LlmError('throttled one', 'RATE_LIMIT', { status: 429 }),
        new LlmError('throttled two', 'RATE_LIMIT', { status: 429 }),
        new LlmError('throttled three', 'RATE_LIMIT', { status: 429 }),
      ])
      ;({ ctx: context } = await harness(adapter, { mock: cooldownConfig({
        backoff: { rateLimitDelaysMs: [25, 30] },
      }) }))
      const agent = context.agentLoop.create(SessionId('cooldown-short-schedule'), { provider: 'mock', model: 'mock' })
      const first = waitForRetry(context, agent, 1)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      expect((await first).data.delayMs).toBe(25)
      const second = waitForRetry(context, agent, 2)
      await vi.advanceTimersByTimeAsync(25)
      expect((await second).data.delayMs).toBe(30)

      const idle = waitForIdle(context, agent)
      await vi.advanceTimersByTimeAsync(30)
      await idle

      expect(adapter.requests).toHaveLength(3)
      expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(2)
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: {
          reason: {
            kind: 'error',
            error: { message: 'throttled three', code: 'RATE_LIMIT', status: 429 },
          },
        },
      })
    })

    it('falls back to exponential backoff for RATE_LIMIT when the schedule is empty', async () => {
      vi.useFakeTimers()
      const adapter = new ScriptedAdapter([
        new LlmError('throttled once', 'RATE_LIMIT', { status: 429 }),
        textResponse('exponential recovery'),
      ])
      ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
        backoff: { rateLimitDelaysMs: [] },
      }) }))
      const agent = context.agentLoop.create(SessionId('cooldown-empty-schedule'), { provider: 'mock', model: 'mock' })
      const scheduled = waitForRetry(context, agent, 1)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      expect((await scheduled).data.delayMs).toBe(500)

      const idle = waitForIdle(context, agent)
      await vi.advanceTimersByTimeAsync(500)
      await idle
      expect(adapter.requests).toHaveLength(2)
    })

    it('continues always mode past the schedule with exponential backoff', async () => {
      vi.useFakeTimers()
      const adapter = new ScriptedAdapter([
        new LlmError('throttled one', 'RATE_LIMIT', { status: 429 }),
        new LlmError('throttled two', 'RATE_LIMIT', { status: 429 }),
        new LlmError('throttled three', 'RATE_LIMIT', { status: 429 }),
        new LlmError('throttled four', 'RATE_LIMIT', { status: 429 }),
        textResponse('always recovered'),
      ])
      ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({
        initialDelayMs: 1,
        maxDelayMs: 4,
        jitterRatio: 0,
        rateLimitDelaysMs: [2, 3],
      }) }))
      const agent = context.agentLoop.create(SessionId('cooldown-always-past-schedule'), {
        provider: 'mock',
        model: 'mock',
      })
      const idle = waitForIdle(context, agent)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'keep trying' }], source: { kind: 'user' } }))
      await vi.runAllTimersAsync()
      await idle

      const events = agent.session.events.filter(event => event.type === 'llm/retry')
      expect(adapter.requests).toHaveLength(5)
      expect(events.map(event => event.data.delayMs)).toEqual([2, 3, 4, 4])
      expect(agent.session.deriveMessages().at(-1)).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: 'always recovered' }],
      })
    })

    it('lets turn cancellation abort a cooldown wait without opening another step', async () => {
      vi.useFakeTimers()
      const adapter = new ScriptedAdapter([
        new LlmError('throttled', 'RATE_LIMIT', { status: 429 }),
        textResponse('must not run'),
      ])
      ;({ ctx: context } = await harness(adapter, { mock: cooldownConfig() }))
      const agent = context.agentLoop.create(SessionId('cooldown-cancel'), { provider: 'mock', model: 'mock' })
      const scheduled = waitForRetry(context, agent, 1)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await scheduled
      const idle = waitForIdle(context, agent)
      agent.cancel({ kind: 'user' })
      await idle

      expect(adapter.requests).toHaveLength(1)
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'aborted' } },
      })
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('rejects retry policy configured on the executor instead of a provider', () => {
    expectTypeOf<{}>().toExtend<retry.Config>()
    expectTypeOf<{ retryPolicy: { mode: 'always' } }>().not.toExtend<retry.Config>()
    expect(() => {
      retry.apply(new Context(), { retryPolicy: { mode: 'always' } } as unknown as retry.Config)
    }).toThrow(/retryPolicy belongs under each provider/)
  })

  it('rejects unknown executor config', () => {
    expect(() => {
      retry.apply(new Context(), { retryPolciy: {} } as unknown as retry.Config)
    }).toThrow(/unknown key "retryPolciy"/)
  })
})
