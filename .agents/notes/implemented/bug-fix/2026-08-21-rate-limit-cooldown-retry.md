# Agent Note: Cooldown-retry quota-worded 429 throttling instead of ending the turn

Status: implemented

English | [中文](2026-08-21-rate-limit-cooldown-retry.zh.md)

## Problem

Gateway 429 failures killed tasks outright. An OpenAI-compatible gateway (e.g. qwen Model Studio) returns `429` with provider `code`/`type` `insufficient_quota` and a "check your plan and billing" message for per-minute token throttling that clears by itself, but the DeepSeek adapter's `httpErrorCode` mapped every quota-worded response to the terminal `QUOTA` code, which sits outside the default retryable set — so the first rejection ended the turn with no retry. Plain `RATE_LIMIT` 429s were retryable, but the only delay machinery was exponential backoff capped at `maxDelayMs` (default 10 s) and a normal-mode give-up whenever a provider `Retry-After` exceeded that cap; nothing could wait out a minute-scale throttle window.

## Decision

The cooldown schedule is a resolved policy fact, configured once and executed where every other retry is decided:

- `BackoffConfig.rateLimitDelaysMs` lists one per-attempt wait for `RATE_LIMIT` failures, default `[60000, 180000, 300000]` — three cooldown retries waiting one, three, and five minutes. An empty array disables the schedule and falls back to exponential backoff.
- The DeepSeek adapter reserves `QUOTA` for quota wording on non-429 statuses (a 402 insufficient balance) and classifies every HTTP 429 — quota-worded or not — as `RATE_LIMIT`, so `dsh-llm-retry` owns the wait. Bounded by the schedule, a genuinely exhausted account still fails after about nine minutes.
- `dsh-llm-retry` takes the schedule entry as the attempt's delay, jittered by the shared ratio but never below the entry or a valid provider `Retry-After` (in timer range; an out-of-range value is ignored). The schedule advances only on RATE_LIMIT retries within one step's recovery sequence, so other retried codes share the normal budget without consuming cooldown entries. In normal mode the schedule replaces `maxRetries` as the RATE_LIMIT budget (`min(maxRetries, length)`), with the schedule exhausted before the shared budget; always mode keeps retrying with exponential backoff past the schedule. The canonical policy key includes the schedule, so a changed schedule resets in-step retry history like any other policy change.
- The schedule is data, not a loop change: the loop's `agent/request-error` recovery already awaits a `Promise<RequestErrorAction>` with no deadline, and the existing lifetime/cancellation fusion already aborts minute-scale waits on cancel and disposal.

## Alternatives considered

**Keep `QUOTA` terminal and opt deployments in through `retryableCodes`.** Rejected: the opt-in never fires for the affected deployments because the error never classifies as retryable, and minute-scale waits still need the schedule machinery; a blind `QUOTA`-in-`retryableCodes` retry would also repeat 402 insufficient-balance failures.

**A separate canonical code for quota-worded 429s.** Rejected: status 429 is already the throttling signal, both classifications share one retry action, and a second code adds a routable surface with no distinct owner.

**Honor provider `Retry-After` verbatim instead of a schedule floor.** Rejected: gateway hints are often absent or a few seconds, which re-enters the throttle while it is still clearing; the floor is what makes the cooldown reliable.

**Fast backoff with a raised `maxDelayMs`.** Rejected: raising the exponential ceiling slows SERVER/TIMEOUT/TRANSPORT recovery, whose failures usually clear in seconds.

## Consequences

- A conversation hit by quota-worded 429 throttling now logs three non-surface `llm/retry` events (`delayMs` 60 000 / 180 000 / 300 000 by default) and fails with the original 429 only after the fourth rejection; a turn is never retried more than the default three cooldown attempts for RATE_LIMIT regardless of the five-retry normal budget.
- Genuine exhaustion on non-429 statuses (402 insufficient balance) remains terminal `QUOTA`, and deployments can shrink, reorder, or disable the schedule (`rateLimitDelaysMs: []`) without touching other codes.
- The resolved-policy shape and canonical `policyKey` both gained the schedule field, so committed replay fixtures and policy snapshots changed in the same PR: `examples/acp-agent` retry overlays and `examples/headless-agent` retry fixture pin short schedules, and their recorded `policyKey` strings embed the pinned arrays.
- `llm-pi-ai` shares `ResolvedRetryPolicy` but keeps its own classifications and its SDK retries disabled; its routes pick up an identical configurable schedule because `backoff.rateLimitDelaysMs` ships with any resolved policy.