/**
 * Configuration vocabulary for the replay-aware basic compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic/types
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Policy fields shared by the default policy and exact model overrides. */
export interface CompactionPolicyConfig {
  /** Compact at this fraction of the model's context window. Defaults to `0.8`. */
  thresholdRatio?: number
  /** Recent context retained as a fraction of the model's window. Defaults to `0.16`. */
  retainRatio?: number
  /** Absolute recent-context budget; mutually exclusive with `retainRatio`. */
  retainTokens?: number
  /** Summary provider; set together with `summarizationModel`, or inherit the conversation target. */
  summarizationProvider?: string
  /** Summary model; set together with `summarizationProvider`, or inherit the conversation target. */
  summarizationModel?: string
  /** Provider generation cap for summarization. Defaults to `8192`. */
  maxTokens?: number
  /** Extra attempts after the first compaction when pressure remains above threshold. Defaults to `1`. */
  compactionRetries?: number
  /** Maximum retries after context-overflow or request-size recovery; `0` disables recovery. Defaults to `1`. */
  maxOverflowRetries?: number
  /**
   * Optional bound on the estimated wire-byte size of the routed model request.
   * Gateways answer oversized bodies with HTTP 413, which token pressure on a
   * mega-context model can never predict; when set, pressure compaction also
   * fires at this byte bound. It also limits summarizer requests, so the
   * resolved value must hold one minimal replay message plus the fixed
   * compaction instruction. Unset by default (token pressure only).
   */
  maxRequestBytes?: number
  /**
   * Optional cap on each complete summarizer request's estimated wire bytes.
   * Oversized ranges use balanced hierarchical compaction transactions so
   * every summarized message stays within a bounded request. After exact-model
   * inheritance, its minimum with `maxRequestBytes` must hold one minimal
   * replay message plus the fixed compaction instruction. Defaults to `512 * 1024`.
   */
  summarizationInputBytes?: number
  /**
   * Minimum estimated request bytes at which a stream `TIMEOUT` may trigger
   * request-size compaction before generic retry. Defaults to `512 * 1024`.
   */
  timeoutRecoveryBytes?: number
}

/** Exact provider/model override merged over the default compaction policy. */
export interface ModelCompactPolicyConfig extends CompactionPolicyConfig {
  /** Registered provider route to match. */
  provider: string
  /** Exact routed model id to match within `provider`. */
  model: string
}

/** Basic compaction configuration with an optional exact-target policy table. */
export interface BasicCompactionConfig extends CompactionPolicyConfig {
  /** Exact provider/model overrides; duplicate targets fail plugin load. */
  modelPolicies?: ModelCompactPolicyConfig[]
  /**
   * Fraction of a failed request's estimated bytes adopted as the
   * probe-learned byte budget after HTTP 413 or eligible large-request timeout
   * recovery. Must be in `(0, 1)`. Defaults to `0.75`.
   */
  learnedByteSafetyRatio?: number
  /** Enable automatic pressure and failed-request recovery listeners. Defaults to `true`. */
  auto?: boolean
}

/** Exactly one validated retention form. */
export type ResolvedRetention =
  | { readonly retainRatio: number; readonly retainTokens?: never }
  | { readonly retainRatio?: never; readonly retainTokens: number }

/** Validated policy fields shared before and after exact-target matching. */
interface ResolvedPolicyFields {
  readonly thresholdRatio: number
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  readonly compactionRetries: number
  readonly maxOverflowRetries: number
  /** Absent until a request-byte bound is configured. */
  readonly maxRequestBytes?: number
  readonly summarizationInputBytes: number
  readonly timeoutRecoveryBytes: number
}

/** Validated immutable config whose target-specific defaults remain unresolved. */
export type ResolvedConfig = ResolvedPolicyFields & ResolvedRetention & {
  readonly modelPolicies: readonly Readonly<ModelCompactPolicyConfig>[]
  /** Fraction of a rejected request's bytes adopted as the probe-learned budget. */
  readonly learnedByteSafetyRatio: number
  readonly auto: boolean
}

/** Fully merged policy for one routed conversation target, before capacity scaling. */
export type ResolvedTargetPolicy = ResolvedPolicyFields & ResolvedRetention & {
  readonly target: Pick<LlmCallConfig, 'provider' | 'model'>
}

/** One routed model's concrete pressure and retention budget. */
export type ResolvedCompactSpec = Omit<ResolvedTargetPolicy, 'retainRatio' | 'retainTokens'> & {
  readonly contextWindow: number
  readonly thresholdTokens: number
  readonly retainTokens: number
}
