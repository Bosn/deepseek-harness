/**
 * Basic replay-aware compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { estimateHeaderBytes, estimateMessageBytes } from '@deepseek-ai/dsh-token-meter'
import type { Session } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE, assertNever } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  MIN_USEFUL_REQUEST_BYTES,
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectCompactableRange,
} from './region.ts'
import { summarizeWithLlm } from './summarizer.ts'
import type { SummarizationInput, SummaryResult } from './summarizer.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedConfig,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

/** The region transaction's view of this service's dynamically dispatched summarizer. */
type RegionSummarize = (input: SummarizationInput, agent: Agent, signal?: AbortSignal) => Promise<SummaryResult>

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

/** Stable in-memory key for one exact provider/model route. */
function targetBudgetKey(target: Pick<LlmCallConfig, 'provider' | 'model'>): string {
  return JSON.stringify([target.provider, target.model])
}

/**
 * Estimate the wire-byte size of the current surfaced request envelope:
 * the routed header (system + tool schemas) plus every surface node's
 * derived message. This is the number an HTTP gateway caps with its
 * `RequestTooLarge` (413) family, which token pressure alone cannot predict
 * on mega-context models.
 * @param session - session supplying the request header and surface nodes.
 * @returns heuristic total request bytes (non-decreasing while the surface grows).
 */
function requestBytes(session: Session): number {
  let bytes = estimateHeaderBytes(session.requestHeader())
  const events = session.events
  for (const seq of session.surface.nodes) {
    const event = events[seq]
    /* v8 ignore next -- validated surface seqs always name existing session events. */
    if (event === undefined) continue
    const message = session.deriveEventMessage(event)
    /* v8 ignore next -- validated surface nodes always project to messages. */
    if (message !== null) bytes += estimateMessageBytes(message)
  }
  return bytes
}

/**
 * Compaction policy's configured summarization-input cap combined with any
 * probe-learned request-byte budget: the summarizer request must fit the same
 * byte envelope as the conversation request it repairs.
 */
function summarizerBudget(
  spec: { readonly summarizationInputBytes: number; readonly maxRequestBytes?: number },
  learned: number | undefined,
): number {
  return Math.min(
    spec.summarizationInputBytes,
    spec.maxRequestBytes ?? spec.summarizationInputBytes,
    learned === undefined ? Number.POSITIVE_INFINITY : learned,
  )
}

const thresholdRatioSchema = z.number()
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)
const maxRequestBytesSchema = z.number().step(1).min(1)
const summarizationInputBytesSchema = z.number().step(1).min(1)
const timeoutRecoveryBytesSchema = z.number().step(1).min(1)
const learnedByteSafetyRatioSchema = z.number()

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
  maxRequestBytes: maxRequestBytesSchema,
  summarizationInputBytes: summarizationInputBytesSchema,
  timeoutRecoveryBytes: timeoutRecoveryBytesSchema,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    maxRequestBytes: maxRequestBytesSchema,
    summarizationInputBytes: summarizationInputBytesSchema,
    timeoutRecoveryBytes: timeoutRecoveryBytesSchema,
    learnedByteSafetyRatio: learnedByteSafetyRatioSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly recoveryRetries = new WeakMap<Agent, number>()
  private readonly recoveryAgents = new WeakMap<Session, Agent>()
  /** Probe-learned byte budgets isolated by agent and exact routed target. */
  private readonly learnedByteBudgets = new WeakMap<Agent, Map<string, number>>()
  /** Candidate byte budgets visible only to the request-size recovery in flight. */
  private readonly recoveryByteBudgets = new WeakMap<Agent, Map<string, number>>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.recoveryRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.recoveryAgents.get(session)
      if (agent !== undefined) this.recoveryRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (signal.aborted) return next()
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const failedBytes = failure.requestBytesEstimate ?? requestBytes(agent.session)
      const requestSizeFailure = failure.status === 413
        || (failure.code === 'TIMEOUT' && failedBytes >= policy.timeoutRecoveryBytes)
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE && !requestSizeFailure) return next()

      this.recoveryAgents.set(agent.session, agent)
      const retries = this.recoveryRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      // HTTP 413 confirms byte pressure. A TIMEOUT above the configured
      // threshold opts into the same conservative recovery because resending
      // the unchanged large envelope can repeat an upload-side stall. The
      // candidate is temporary until recovery durably advances the surface.
      const learnedBudget = requestSizeFailure
        ? Math.floor(failedBytes * this.config.learnedByteSafetyRatio)
        : undefined
      this.stageRecoveryByteBudget(agent, target, learnedBudget)

      const generation = agent.session.surface.replaceGeneration
      const trigger: CompactionTrigger = requestSizeFailure ? 'request-size' : 'context-overflow'
      const label = requestSizeFailure ? 'request-size' : 'context-overflow'
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, trigger, signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        const madeProgress = agent.session.surface.replaceGeneration > generation
        if (madeProgress) this.publishLearnedByteBudget(agent, target, learnedBudget)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal may abort while compaction is awaited.
        if (!signal.aborted && madeProgress) {
          ctx.logger.warn(
            `${label} compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.recoveryRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal may abort while compaction is awaited.
          `${label} compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return await next()
      } finally {
        this.clearRecoveryByteBudget(agent)
      }
      const madeProgress = agent.session.surface.replaceGeneration > generation
      if (madeProgress) this.publishLearnedByteBudget(agent, target, learnedBudget)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal may abort while compaction is awaited.
      if (signal.aborted
        || !madeProgress) return next()
      if (result !== null) logResult(result, `${label} recovery`)
      this.recoveryRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const target = conversationTarget(agent)
    const config = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    return summarizeWithLlm(this.ctx, config, input, agent, signal)
  }

  /**
   * Compact for step-boundary pressure, semantic context overflow, or
   * request-size recovery. Failure recovery bypasses the normal threshold and
   * retained-tail policy so it can force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal pressure, semantic context overflow, or request-size recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    switch (trigger) {
      case 'context-overflow':
      case 'request-size':
        break
      case 'pressure':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    // Pruning is optional so compaction-basic remains independently composable.
    // Overflow always qualifies; pressure first resolves the routed model's
    // capacity and checks its target-specific threshold.
    const prune = this.ctx.get('toolResultPruner')

    if (trigger !== 'pressure') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)
      }
      const range = selectCompactableRange(agent.session, measurement, 0)
      if (range === null) return null
      // The compaction's own summarizer request must survive the same gateway
      // byte cap that overflowed the conversation: replay only a bounded head.
      const inputCap = summarizerBudget(policy, this.effectiveByteBudget(agent, target))
      return this.compactRegion(range.start, range.end, agent, signal, inputCap)
    }

    const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    const spec = resolveCompactSpec(policy, context.contextWindow)
    const learnedBudget = this.effectiveByteBudget(agent, target)
    const effectiveByteLimit = (): number | undefined => {
      // An explicitly configured budget is authoritative. A gateway-probe
      // budget is an estimate, so only values above the usefulness floor count.
      const learned = learnedBudget !== undefined && learnedBudget >= MIN_USEFUL_REQUEST_BYTES
        ? learnedBudget
        : undefined
      if (spec.maxRequestBytes === undefined) return learned
      return learned === undefined ? spec.maxRequestBytes : Math.min(spec.maxRequestBytes, learned)
    }
    const pressureQualifies = (): boolean => {
      const byteLimit = effectiveByteLimit()
      return measurement.totalTokens >= spec.thresholdTokens
        || (byteLimit !== undefined && requestBytes(agent.session) >= byteLimit)
    }
    if (!pressureQualifies()) return null

    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure through the singleton replay fold.
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (!pressureQualifies()) return null

    const inputCap = summarizerBudget(spec, learnedBudget)
    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(agent.session, measurement, spec.retainTokens)
      if (range === null) {
        /* v8 ignore else -- concrete replacement preserves a compactable checkpoint; subclass hooks cannot mutate it. */
        if (result === null) return null
        /* v8 ignore next -- paired with the defensive post-success branch above. */
        break
      }
      result = await this.compactRegion(range.start, range.end, agent, signal, inputCap)
      measurement = meter.measure(agent.session)
      if (!pressureQualifies()) return result
    }

    const byteLimit = effectiveByteLimit()
    const byteSummary = byteLimit === undefined
      ? ''
      : `, ${requestBytes(agent.session)} estimated bytes >= ${byteLimit} byte budget`
    throw new Error(
      `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens}${byteSummary})`,
    )
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @param summarizationInputBytes - internal complete-request cap; omitted
   * explicit calls resolve the routed configured and learned budget.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: number,
    end: number,
    agent: Agent,
    signal?: AbortSignal,
    summarizationInputBytes?: number,
  ): Promise<CompactionResult> {
    const inputCap = summarizationInputBytes ?? this.summarizationBudgetFor(agent)
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      {
        owner: 'current-turn',
        stability: 'whole-surface',
        summarizationInputBytes: inputCap,
      },
      signal,
    )
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold,
   * enforcing the routed summarizer byte cap, and resolve only after its
   * standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const range = selectCompactableRange(
            agent.session,
            this.ctx.tokenMeter.measure(agent.session),
            0,
          )
          if (range === null) return null
          return await compactSurfaceRegion(
            this.regionDependencies(),
            agent.session,
            range.start,
            range.end,
            agent,
            {
              owner: null,
              stability: 'selected-span',
              summarizationInputBytes: this.summarizationBudgetFor(agent),
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
            },
            operationSignal,
          )
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(): { meter: TokenMeter; summarize: RegionSummarize } {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
    }
  }

  /** Resolve the configured and learned complete-request cap for one agent route. */
  private summarizationBudgetFor(agent: Agent): number {
    const target = conversationTarget(agent)
    const policy = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    const learned = target === undefined
      ? undefined
      : this.learnedByteBudget(agent, target)
    return summarizerBudget(policy, learned)
  }

  /** Read a probe-learned byte budget without sharing it across routed targets. */
  private learnedByteBudget(
    agent: Agent,
    target: Pick<LlmCallConfig, 'provider' | 'model'>,
  ): number | undefined {
    return this.learnedByteBudgets.get(agent)?.get(targetBudgetKey(target))
  }

  /** Combine the durable learned budget with a narrower in-flight recovery candidate. */
  private effectiveByteBudget(
    agent: Agent,
    target: Pick<LlmCallConfig, 'provider' | 'model'>,
  ): number | undefined {
    const learned = this.learnedByteBudget(agent, target)
    const recovery = this.recoveryByteBudgets.get(agent)?.get(targetBudgetKey(target))
    if (learned === undefined) return recovery
    return recovery === undefined ? learned : Math.min(learned, recovery)
  }

  /** Expose every positive candidate only while its recovery attempt runs. */
  private stageRecoveryByteBudget(
    agent: Agent,
    target: Pick<LlmCallConfig, 'provider' | 'model'>,
    budget: number | undefined,
  ): void {
    if (budget === undefined || budget <= 0) return
    const budgets = this.recoveryByteBudgets.get(agent) ?? new Map<string, number>()
    budgets.set(targetBudgetKey(target), budget)
    this.recoveryByteBudgets.set(agent, budgets)
  }

  /** Remove the candidate after the agent's serial recovery attempt settles. */
  private clearRecoveryByteBudget(agent: Agent): void {
    this.recoveryByteBudgets.delete(agent)
  }

  /** Publish a useful lower probe budget after durable recovery progress. */
  private publishLearnedByteBudget(
    agent: Agent,
    target: Pick<LlmCallConfig, 'provider' | 'model'>,
    budget: number | undefined,
  ): void {
    if (budget === undefined || budget < MIN_USEFUL_REQUEST_BYTES) return
    const budgets = this.learnedByteBudgets.get(agent) ?? new Map<string, number>()
    const key = targetBudgetKey(target)
    const current = budgets.get(key)
    if (current !== undefined && current <= budget) return
    budgets.set(key, budget)
    this.learnedByteBudgets.set(agent, budgets)
  }
}

export default BasicCompactionEngine
