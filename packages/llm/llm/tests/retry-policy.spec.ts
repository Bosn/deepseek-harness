import { describe, expect, it } from 'vitest'
import {
  resolveRetryPolicy,
  RetryPolicySchema,
} from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

describe('provider retry policy', () => {
  it('resolves immutable normal defaults', () => {
    const policy = resolveRetryPolicy(undefined, 'provider.retryPolicy')

    expect(policy).toEqual({
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['CONTENT_FILTERED', 'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      maxRetriesByCode: { TIMEOUT: 1 },
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
      rateLimitDelaysMs: [60_000, 180_000, 300_000],
    })
    expect(Object.isFrozen(policy)).toBe(true)
    if (policy.mode !== 'normal') throw new Error('expected normal policy')
    expect(Object.isFrozen(policy.retryableCodes)).toBe(true)
    expect(Object.isFrozen(policy.maxRetriesByCode)).toBe(true)
    expect(Object.isFrozen(policy.rateLimitDelaysMs)).toBe(true)
  })

  it('resolves and detaches a configured normal policy', () => {
    const retryableCodes = ['BUSY']
    const maxRetriesByCode = { BUSY: 2 }
    const rateLimitDelaysMs = [30_000, 90_000]
    const config: RetryPolicyConfig = {
      mode: 'normal',
      maxRetries: 4,
      retryableCodes,
      maxRetriesByCode,
      backoff: {
        initialDelayMs: 25,
        maxDelayMs: 100,
        jitterRatio: 0,
        rateLimitDelaysMs,
      },
    }

    const policy = resolveRetryPolicy(config, 'provider.retryPolicy')
    retryableCodes.push('LATE')
    maxRetriesByCode.BUSY = 3
    rateLimitDelaysMs.push(1)

    expect(policy).toEqual({
      mode: 'normal',
      maxRetries: 4,
      retryableCodes: ['BUSY'],
      maxRetriesByCode: { BUSY: 2 },
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0,
      rateLimitDelaysMs: [30_000, 90_000],
    })
  })

  it('resolves always mode with default backoff', () => {
    expect(resolveRetryPolicy({ mode: 'always' }, 'provider.retryPolicy')).toEqual({
      mode: 'always',
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
      rateLimitDelaysMs: [60_000, 180_000, 300_000],
    })
    expect(RetryPolicySchema).toBeDefined()
  })

  it('ignores normal-only fields retained after switching to always mode', () => {
    const layered = {
      mode: 'always',
      maxRetries: 5,
      retryableCodes: ['SERVER'],
      maxRetriesByCode: { SERVER: 2 },
    } as unknown as RetryPolicyConfig

    expect(resolveRetryPolicy(layered, 'provider.retryPolicy')).toEqual({
      mode: 'always',
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
      rateLimitDelaysMs: [60_000, 180_000, 300_000],
    })
  })

  it('resolves an empty cooldown schedule that disables the rate-limit cooldown', () => {
    expect(resolveRetryPolicy({
      mode: 'normal',
      backoff: { rateLimitDelaysMs: [] },
    }, 'provider.retryPolicy')).toMatchObject({
      rateLimitDelaysMs: [],
    })
  })

  it.each([
    [{ mode: 'normal', maxRetries: -1 }, /maxRetries/],
    [{ mode: 'normal', maxRetries: 1.5 }, /maxRetries/],
    [{ mode: 'normal', maxRetries: Number.MAX_SAFE_INTEGER + 1 }, /maxRetries/],
    [{ mode: 'always', backoff: { initialDelayMs: 0 } }, /initialDelayMs/],
    [{ mode: 'normal', backoff: { maxDelayMs: Number.POSITIVE_INFINITY } }, /maxDelayMs/],
    [{ mode: 'normal', backoff: { initialDelayMs: MAX_TIMER_DELAY_MS + 1 } }, /initialDelayMs/],
    [{ mode: 'always', backoff: { maxDelayMs: MAX_TIMER_DELAY_MS + 1 } }, /maxDelayMs/],
    [{ mode: 'normal', backoff: { initialDelayMs: 20, maxDelayMs: 10 } }, /less than or equal/],
    [{ mode: 'always', backoff: { jitterRatio: 1.1 } }, /jitterRatio/],
    [{ mode: 'normal', retryableCodes: [] }, /must not be empty/],
    [{ mode: 'normal', retryableCodes: ['SERVER', 'SERVER'] }, /duplicates/],
    [{ mode: 'normal', retryableCodes: [''] }, /non-empty strings/],
    [{ mode: 'normal', retryableCodes: [429] }, /non-empty strings/],
    [{ mode: 'normal', maxRetriesByCode: { TIMEOUT: -1 } }, /maxRetriesByCode\.TIMEOUT/],
    [{ mode: 'normal', maxRetriesByCode: { TIMEOUT: 1.5 } }, /maxRetriesByCode\.TIMEOUT/],
    [{ mode: 'normal', maxRetriesByCode: { TIMEOUT: Number.MAX_SAFE_INTEGER + 1 } }, /maxRetriesByCode\.TIMEOUT/],
    [{ mode: 'normal', maxRetriesByCode: { '': 1 } }, /keys must be non-empty strings/],
    [{ mode: 'normal', maxRetires: 1 }, /unknown key "maxRetires"/],
    [{ mode: 'always', backoff: { initialDelay: 1 } }, /unknown key "initialDelay"/],
    [{ mode: 'normal', backoff: { rateLimitDelaysMs: [0] } }, /rateLimitDelaysMs/],
    [{ mode: 'normal', backoff: { rateLimitDelaysMs: [-5] } }, /rateLimitDelaysMs/],
    [{ mode: 'normal', backoff: { rateLimitDelaysMs: [1.5] } }, /rateLimitDelaysMs/],
    [{ mode: 'normal', backoff: { rateLimitDelaysMs: [Number.POSITIVE_INFINITY] } }, /rateLimitDelaysMs/],
    [{ mode: 'normal', backoff: { rateLimitDelaysMs: [MAX_TIMER_DELAY_MS + 1] } }, /rateLimitDelaysMs/],
    [{ mode: 'normal', backoff: { rateLimitDelaysMs: ['500'] } }, /rateLimitDelaysMs/],
    [{ mode: 'sometimes' }, /mode must be "normal" or "always"/],
  ] as const)('rejects invalid policy %#', (config, message) => {
    expect(() => {
      resolveRetryPolicy(config as unknown as RetryPolicyConfig, 'provider.retryPolicy')
    }).toThrow(message)
  })
})
