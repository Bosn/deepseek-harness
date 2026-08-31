/**
 * Provider-routed model-request retry policy on the agent loop's request
 * recovery extension point. Each scheduled retry is durable before its
 * cancellable wait. `RATE_LIMIT` failures wait out the policy's configured
 * cooldown schedule (default one, three, and five minutes) instead of the
 * fast exponential backoff, so gateway 429 throttling has time to clear. A
 * downstream durable surface replacement owns recovery unless it explicitly
 * authorizes another request, preventing either retry mode from racing that
 * specialized repair.
 *
 * @module @deepseek-ai/dsh-llm-retry
 */

import { randomUUID } from 'node:crypto'
import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { RetryId } from './brand.ts'
import type { LlmRetryEventData } from './types.ts'

export type { LlmRetryEventData, LlmRetryStartedEventData } from './types.ts'
export { RetryId } from './brand.ts'

export const name = 'llm-retry'
export const inject = ['agents', 'sessionProjections']

/** This policy executor has no config; providers own `retryPolicy`. */
export type Config = Readonly<Record<string, never>>

/** Runtime schema for {@link Config}. */
export const Config = z.object({}) as unknown as z<Config>

function validateConfig(config: Config): void {
  const [key] = Object.keys(config)
  if (key === undefined) return
  if (key === 'retryPolicy') {
    throw new Error('llm-retry: retryPolicy belongs under each provider configuration')
  }
  throw new Error(`llm-retry: unknown key "${key}"`)
}

/** Non-serializable hooks used to make timing policy deterministic in tests. */
export interface RetryInternals {
  /** Random sample in the inclusive zero-to-one range used for jitter. */
  random?: () => number
}

type DownstreamOutcome =
  | { readonly type: 'decision'; readonly decision: RequestErrorAction }
  | { readonly type: 'error'; readonly error: unknown }

async function settleDownstream(
  next: () => Promise<RequestErrorAction>,
): Promise<DownstreamOutcome> {
  try {
    return { type: 'decision', decision: await next() }
  } catch (error: unknown) {
    return { type: 'error', error }
  }
}

function jittered(base: number, jitterRatio: number, ceiling: number, random: () => number): number {
  const jitter = 1 - jitterRatio + 2 * jitterRatio * random()
  return Math.min(base * jitter, ceiling)
}

function localDelay(config: ResolvedRetryPolicy, retry: number, random: () => number): number {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
  return jittered(exponential, config.jitterRatio, config.maxDelayMs, random)
}

/**
 * Resolve the configured `RATE_LIMIT` cooldown wait for one retry, or
 * `undefined` when the schedule does not cover this attempt (a non-rate-limit
 * failure, an empty schedule, or every entry consumed). The schedule advances
 * only on RATE_LIMIT retries within this step's recovery sequence, so other
 * retried codes share the normal budget without consuming cooldown entries. A
 * positive provider `Retry-After` within timer range raises the wait —
 * throttling advice can only extend the cooldown — while an out-of-range value
 * is ignored in favor of the schedule entry. Jitter varies the schedule entry,
 * and the final wait never falls below the entry or a valid provider hint.
 * @param policy - the serving registration's resolved per-provider policy.
 * @param rateLimitAttempt - zero-based count of prior RATE_LIMIT retries in this step's recovery sequence.
 * @param failure - the classified model-request failure being recovered.
 * @param random - jitter sample source.
 * @returns the cooldown delay in milliseconds when the schedule applies.
 */
function cooldownDelay(
  policy: ResolvedRetryPolicy,
  rateLimitAttempt: number,
  failure: LlmFailure,
  random: () => number,
): number | undefined {
  if (failure.code !== 'RATE_LIMIT') return undefined
  const entry = policy.rateLimitDelaysMs[rateLimitAttempt]
  if (entry === undefined) return undefined
  let floor = entry
  const providerMs = failure.providerRetryAfterMs
  if (providerMs !== undefined
    && Number.isFinite(providerMs)
    && providerMs > 0
    && providerMs <= MAX_TIMER_DELAY_MS) {
    floor = Math.max(floor, providerMs)
  }
  // Jitter varies the entry; both floors survive it. Throttling advice and
  // the scheduled entry can extend the wait, never shorten it.
  return Math.max(jittered(entry, policy.jitterRatio, MAX_TIMER_DELAY_MS, random), floor)
}

function retryPolicyKey(policy: ResolvedRetryPolicy): string {
  return policy.mode === 'always'
    ? JSON.stringify([
      policy.mode,
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
      [...policy.rateLimitDelaysMs],
    ])
    : JSON.stringify([
      policy.mode,
      policy.maxRetries,
      [...policy.retryableCodes].sort(),
      Object.entries(policy.maxRetriesByCode).sort(([left], [right]) => left.localeCompare(right)),
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
      [...policy.rateLimitDelaysMs],
    ])
}

function retryStateKey(provider: string, policyKey: string): string {
  return JSON.stringify([provider, policyKey])
}

function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Install provider-routed normal or unbounded request recovery.
 * @param ctx - plugin context that owns the listener and active waits.
 * @param config - empty executor config; provider registrations own policy.
 * @param internals - non-serializable deterministic hooks for tests.
 */
interface RetryStateEntry {
  retry: number
  retryId: RetryId
  rateLimitRetries: number
  retriesByCode: Record<string, number>
}

type LlmRetryState = Record<string, RetryStateEntry>

// The cast bridges the branded retry id, which Zod cannot express directly.
const llmRetryStateSchema: zod.ZodType<LlmRetryState> = zod.record(zod.string(), zod.object({
  retry: zod.number().int().nonnegative(),
  retryId: zod.string(),
  rateLimitRetries: zod.number().int().nonnegative(),
  retriesByCode: zod.record(zod.string(), zod.number().int().nonnegative()),
})) as unknown as zod.ZodType<LlmRetryState>
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Retry state for the current step by provider and policy. */
    llmRetry: LlmRetryState
  }
}

export function apply(ctx: Context, config: Config = {}, internals: RetryInternals = {}): void {
  validateConfig(config)
  ctx.sessionProjections.register({
    key: 'llmRetry',
    stateVersion: 2,
    stateSchema: llmRetryStateSchema,
    init: () => ({}),
    apply: (state, event) => {
      if (event.type === 'step/start' || event.type === 'turn/end') return {}
      if (event.type !== 'llm/retry') return state
      const key = retryStateKey(event.data.provider, event.data.policyKey)
      const entry = state[key]
      if (entry?.retry === event.data.retry && entry.retryId === event.data.retryId) return state
      const code = event.data.failure.code
      return {
        ...state,
        [key]: {
          retry: event.data.retry,
          retryId: event.data.retryId,
          rateLimitRetries: (entry?.rateLimitRetries ?? 0) + (code === 'RATE_LIMIT' ? 1 : 0),
          retriesByCode: {
            ...entry?.retriesByCode,
            [code]: (entry?.retriesByCode[code] ?? 0) + 1,
          },
        },
      }
    },
  })
  const random = internals.random ?? Math.random
  const lifetime = new AbortController()
  const active = new Set<Promise<RequestErrorAction>>()

  function track(operation: Promise<RequestErrorAction>): Promise<RequestErrorAction> {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  async function backoff(
    agent: Agent,
    turn: number,
    step: number,
    failure: LlmFailure,
    provider: string,
    policy: ResolvedRetryPolicy,
    policyKey: string,
    retry: number,
    retryId: RetryId,
    delayMs: number,
    signal: AbortSignal,
  ): Promise<RequestErrorAction> {
    const fusedSignal = AbortSignal.any([signal, lifetime.signal])
    /* v8 ignore next -- cancellation may win between recovery selection and backoff setup. */
    if (fusedSignal.aborted) return
    const eventData: LlmRetryEventData = policy.mode === 'normal'
      ? {
        retryId,
        turn,
        step,
        provider,
        mode: policy.mode,
        policyKey,
        retry,
        maxRetries: policy.maxRetries,
        delayMs,
        failure,
      }
      : {
        retryId,
        turn,
        step,
        provider,
        mode: policy.mode,
        policyKey,
        retry,
        delayMs,
        failure,
      }
    agent.session.append('llm/retry', eventData)
    if (!await cancellableDelay(delayMs, fusedSignal)) return
    agent.session.append('llm/retry-started', { retryId, turn, step, retry })
    return { kind: 'retry' }
  }

  async function recover(
    { agent, turn, step, provider, failure, retryPolicy: policy, signal }: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    if (policy === undefined) return next()
    if (policy.mode === 'always') {
      if (signal.aborted || lifetime.signal.aborted) return
      const fusedSignal = AbortSignal.any([signal, lifetime.signal])
      const replacementGeneration = agent.session.surface.replaceGeneration
      // The loop and plugin lifetime stay open until delegated recovery settles.
      // An abort then wins before the decision or fallback can mutate later state.
      const downstream = await settleDownstream(next)
      if (fusedSignal.aborted) return
      if (downstream.type === 'decision' && downstream.decision?.kind === 'retry') {
        return downstream.decision
      }
      if (downstream.type === 'error') {
        ctx.logger.warn(
          `llm-retry: provider "${provider}" always policy ignored a downstream recovery failure: %o`,
          downstream.error,
        )
      }
      if (agent.session.surface.replaceGeneration > replacementGeneration) return
    } else {
      if (!policy.retryableCodes.includes(failure.code)) return next()
      if (signal.aborted || lifetime.signal.aborted) return
      // Specialized recovery may rebuild durable state (for example,
      // compaction after a large-request timeout). Generic repetition only
      // runs when no downstream listener owns that repair.
      const fusedSignal = AbortSignal.any([signal, lifetime.signal])
      const replacementGeneration = agent.session.surface.replaceGeneration
      const downstream = await next()
      if (fusedSignal.aborted) return
      if (downstream?.kind === 'retry') return downstream
      if (agent.session.surface.replaceGeneration > replacementGeneration) return
    }

    const policyKey = retryPolicyKey(policy)
    const retryState = ctx.sessionProjections.stateOf(agent.session, 'llmRetry') as LlmRetryState
    const previous = retryState[retryStateKey(provider, policyKey)]
    const previousRetry = previous?.retry ?? 0
    const priorRateLimitRetries = previous?.rateLimitRetries ?? 0
    const priorCodeRetries = previous?.retriesByCode[failure.code] ?? 0
    if (policy.mode === 'normal' && previousRetry >= policy.maxRetries) return
    if (policy.mode === 'normal') {
      const codeLimit = policy.maxRetriesByCode[failure.code]
      if (codeLimit !== undefined && priorCodeRetries >= codeLimit) return
    }
    const retry = previousRetry + 1
    const retryId = previous?.retryId ?? RetryId(randomUUID())
    const scheduledCooldownMs = cooldownDelay(policy, priorRateLimitRetries, failure, random)
    if (policy.mode === 'normal'
      && failure.code === 'RATE_LIMIT'
      && policy.rateLimitDelaysMs.length > 0
      && scheduledCooldownMs === undefined) {
      // The cooldown schedule is the whole RATE_LIMIT budget: once the
      // schedule no longer covers this attempt, the remaining normal budget
      // belongs to the other retryable codes, not to fast rate-limit retries.
      return
    }
    let delayMs: number
    if (scheduledCooldownMs !== undefined) {
      delayMs = scheduledCooldownMs
    } else if (failure.providerRetryAfterMs !== undefined
      && Number.isFinite(failure.providerRetryAfterMs)
      && failure.providerRetryAfterMs > 0) {
      if (failure.providerRetryAfterMs > policy.maxDelayMs) {
        if (policy.mode === 'normal') return
        delayMs = localDelay(policy, retry, random)
      } else {
        delayMs = failure.providerRetryAfterMs
      }
    } else {
      delayMs = localDelay(policy, retry, random)
    }

    return backoff(agent, turn, step, failure, provider, policy, policyKey, retry, retryId, delayMs, signal)
  }

  const disposeListener = ctx.on('agent/request-error', (
    payload,
    next: () => Promise<RequestErrorAction>,
  ) => {
    // A waterfall may have captured this callback before its registration was
    // removed. Lifetime cancellation must prevent that stale callback from
    // entering a downstream policy after disposal.
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorAction>(undefined)
    return track(recover(payload, next))
  })

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('llm-retry plugin disposed'))
    await Promise.allSettled([...active])
  }, 'llm-retry: abort and drain active recovery')
}
