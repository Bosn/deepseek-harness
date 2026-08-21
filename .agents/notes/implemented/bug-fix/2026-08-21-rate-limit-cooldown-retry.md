# Agent Note: Cooldown-retry quota-worded 429 throttling instead of ending the turn

Status: implemented

English | [中文](2026-08-21-rate-limit-cooldown-retry.zh.md)

## Problem

Gateway 429 failures killed tasks outright. An OpenAI-compatible gateway (e.g. qwen Model Studio) returns `429` with provider `code`/`type` `insufficient_quota` and a "check your plan and billing" message for per-minute token throttling that clears by itself, but the DeepSeek adapter's `httpErrorCode` mapped every quota-worded response to the terminal `QUOTA` code, which sits outside the default retryable set — so the first rejection ended the turn with no retry. OpenAI uses the same status and quota wording for genuine account exhaustion, so pi-ai routes cannot safely make that classification globally. Plain `RATE_LIMIT` 429s were retryable, but the only delay machinery was exponential backoff capped at `maxDelayMs` (default 10 s) and a normal-mode give-up whenever a provider `Retry-After` exceeded that cap; nothing could wait out a minute-scale throttle window.

## Decision

The cooldown schedule is a resolved policy fact, configured once and executed where every other retry is decided:

- `BackoffConfig.rateLimitDelaysMs` lists one per-attempt wait for `RATE_LIMIT` failures, default `[60000, 180000, 300000]` — three cooldown retries waiting one, three, and five minutes. An empty array disables the schedule and falls back to exponential backoff.
- The direct DeepSeek adapter classifies every explicit HTTP 429 as `RATE_LIMIT`. Pi-ai classifies plain 429 and rate-limit wording the same way, but keeps quota wording terminal unless the explicit status is 429 and the resolved route enables `quotaWorded429IsRateLimit`. The built-in `qwen-token-plan` and `qwen-token-plan-cn` routes enable it by default; all other routes default it off, and custom Model Studio gateways opt in explicitly. Pi-ai recovers status from the SDK's flattened error message; its non-2xx response headers are not exposed to the adapter. Quota wording on non-429 statuses remains terminal `QUOTA` on every route.
- `dsh-llm-retry` takes the schedule entry as the attempt's delay, jittered by the shared ratio but never below the entry or a valid provider `Retry-After` (in timer range; an out-of-range value is ignored). The schedule advances only on RATE_LIMIT retries within one step's recovery sequence, so other retried codes share the normal budget without consuming cooldown entries. In normal mode the schedule replaces `maxRetries` as the RATE_LIMIT budget (`min(maxRetries, length)`), with the schedule exhausted before the shared budget; always mode keeps retrying with exponential backoff past the schedule. The canonical policy key includes the schedule, so a changed schedule resets in-step retry history like any other policy change.
- The schedule is data, not a loop change: the loop's `agent/request-error` recovery already awaits a `Promise<RequestErrorAction>` with no deadline, and the existing lifetime/cancellation fusion already aborts minute-scale waits on cancel and disposal.

## Alternatives considered

**Make `QUOTA` retryable through `retryableCodes`.** Rejected: a blind `QUOTA` retry would repeat OpenAI account exhaustion and 402 insufficient-balance failures, while minute-scale waits still need the RATE_LIMIT schedule. The route field classifies only the known provider-specific 429 semantics as transient.

**A separate canonical code for quota-worded 429s.** Rejected: providers disagree on whether that response is transient. Route configuration selects the existing `RATE_LIMIT` or `QUOTA` behavior directly, so a second code would add a routable surface with no distinct recovery action.

**Honor provider `Retry-After` verbatim instead of a schedule floor.** Rejected: gateway hints are often absent or a few seconds, which re-enters the throttle while it is still clearing; the floor is what makes the cooldown reliable.

**Fast backoff with a raised `maxDelayMs`.** Rejected: raising the exponential ceiling slows SERVER/TIMEOUT/TRANSPORT recovery, whose failures usually clear in seconds.

## Consequences

- A conversation hit by quota-worded 429 throttling on an enabled route logs three non-surface `llm/retry` events (`delayMs` 60 000 / 180 000 / 300 000 by default) and fails with the original 429 only after the fourth rejection; a turn is never retried more than the default three cooldown attempts for RATE_LIMIT regardless of the five-retry normal budget.
- Genuine exhaustion remains terminal `QUOTA` on non-429 statuses and on quota-worded 429 responses from routes that do not opt in, including OpenAI by default. Deployments can shrink, reorder, or disable the RATE_LIMIT schedule (`rateLimitDelaysMs: []`) without touching other codes.
- The resolved-policy shape and canonical `policyKey` both gained the schedule field, so committed replay fixtures and policy snapshots changed in the same PR: `examples/acp-agent` retry overlays and `examples/headless-agent` retry fixture pin short schedules, and their recorded `policyKey` strings embed the pinned arrays.
- `llm-pi-ai` keeps SDK retries disabled and uses the same resolved cooldown schedule. Because the SDK does not expose non-2xx response headers to its hook, these routes use configured cooldowns without a provider `Retry-After` floor or request-id fact.
