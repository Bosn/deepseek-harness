# Agent Note: Content-filtered outputs are retryable CONTENT_FILTERED failures

Status: implemented

English | [中文](2026-08-23-content-filtered-output-is-retryable.zh.md)

## Problem

An upstream safety gate can reject a model *response* on moderation grounds: a wire `content_filter` finish reason, or a gateway rejection like dashscope-intl's `Output data may contain inappropriate content.` (the exact wording that killed a BoAgents weekly-evolution run under `dsh`). The pi-ai adapter's classifier had no branch for this family, so it fell through to the generic `PI_AI_ERROR` code. `PI_AI_ERROR` is outside the default retryable set, so `dsh-llm-retry` passed, the loop turned the finish error into a `turn/end` failure, and the whole autonomous run aborted on a single moderated sample — the response the model actually produced is irrelevant to whether another sample passes.

## Decision

Moderation rejection of a *response* is one failure class, provider-neutral, and transient-style: the rejected content came from one sample, so re-asking is a fresh moderation decision inside the bounded retry budget.

- `dsh-llm` exports the canonical code `CONTENT_FILTERED_CODE` (`'CONTENT_FILTERED'`) beside `EMPTY_RESPONSE_CODE`, and the default normal policy's `retryableCodes` includes it (sorted list: `CONTENT_FILTERED`, `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`). Deployments can still remove it via `retryableCodes`; `dsh-llm-retry` executes the resolved policy unchanged.
- `dsh-llm-pi-ai` (`classifyPiAiError`): response-side moderation wording maps to `CONTENT_FILTERED` — a synthesized `finish_reason: content_filter`, or safety-gate wording naming the rejected output (the observed dashscope-intl sentence `Output data may contain inappropriate content.`). The branch precedes the HTTP 400 / `INVALID_REQUEST` check, so a gateway that phrases the rejection as a 400 keeps the retryable class instead of the never-retried request-shape bucket. Request-side moderation — a prompt rejected before generation, such as `content_filter` wording in an up-front 400 — carries no response-specific wording and stays `INVALID_REQUEST`, so a deterministically blocked prompt is never re-sent unchanged.
- `dsh-llm-deepseek` (`mapFinishReason`): the wire `content_filter` finish reason maps to the same canonical code instead of the generic uppercased-reason default, so both adapters name the condition identically.

Exhausting the budget still ends the turn with an explicit `CONTENT_FILTERED` failure — bounded cost, actionable code, and no silent retry loop.

## Alternatives considered

**Classify without retrying (opt-in via configuration).** Smaller blast radius, but the shipped default then still aborts autonomous runs on one moderated sample, which is the observed harm; retries are already bounded by `maxRetries`/backoff, and `CONTENT_FILTERED` shares that budget.

**Recognize only the exact dashscope sentence.** One gateway's wording breaks on any rewording or sibling gateway; the `content_filter` finish reason is the same condition reaching the other adapter, so both names are one family.

**Inject a guidance message and continue instead of retrying.** Tells the model to rephrase, which Claude Code-style CLIs do, but the harness has no loop machinery for injecting a failed-step continuation, and building one is a loop change this fix does not need.

## Consequences

- A single moderated sample costs at most the shared retry budget (default 5, exponential backoff) and then fails the turn with the precise `CONTENT_FILTERED` code and message.
- A prompt whose every sample is moderated now consumes retries before failing instead of failing immediately — accepted as bounded and diagnosable.
- The `content-filter-retry` ACP snapshot scenario (authored keyless, retry overlay, beside `empty-response-retry`) pins the product-visible flow: durable `llm/retry` event carrying `CONTENT_FILTERED`, no ACP output for the rejected attempt, recovered reply, clean completed turn.
- Related, not superseded: [bounded recovery for transient LLM request failures](../architecture/2026-06-21-bounded-llm-request-recovery.md) owns the default transient set, which this note extends with `CONTENT_FILTERED`; [empty model responses are retryable](2026-07-24-empty-model-response-is-retryable.md) owns the degenerate-empty-completion class; [pi-ai transport truncation classification](2026-07-22-pi-ai-transport-truncation-classification.md) owns transport-wording classification in the same function. The bounded-recovery note records the new code and its request-side `INVALID_REQUEST` boundary.