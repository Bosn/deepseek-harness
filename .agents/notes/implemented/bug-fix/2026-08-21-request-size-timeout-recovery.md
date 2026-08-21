# Agent Note: Bound request-size and stalled-stream recovery

Status: implemented

English | [中文](2026-08-21-request-size-timeout-recovery.zh.md)

## Problem

A normal provider policy can assign one shared retry budget to failures with very different time costs. A pi-ai stream idle timeout may consume five minutes before it reports `TIMEOUT`; allowing that code to consume the full default five-retry budget can keep one turn in an unchanged request loop for more than half an hour. A large request makes this worse when the timeout is an upload-side stall: generic retry resends the same envelope without any repair. HTTP 413 has the same structural requirement, but without explicit parsing pi-ai's flattened non-2xx error loses the status and quota wording can classify HTTP 429 as terminal `QUOTA` before status takes precedence.

Request-size recovery must also bound its own summarizer call. Replacing an oversized conversation through one equally oversized replay merely moves the gateway rejection into compaction; omitting older messages from the summarizer while replacing them durably would lose model-visible history without summarizing it.

## Decision

- Pi-ai extracts explicit HTTP status from the SDK's flattened error text and records it on `LlmFailure`. HTTP 429 takes precedence over quota wording and maps to `RATE_LIMIT`; non-429 quota remains `QUOTA`. HTTP 413 and request-body-cap wording map to `CONTEXT_WINDOW_EXCEEDED`. The SDK invokes its response hook only for successful responses, so pi-ai does not claim unavailable non-2xx headers, `Retry-After`, or request ids.
- Normal retry policy has `maxRetriesByCode`, included in validation, immutable resolution, and the canonical policy key. The omission default is `{ TIMEOUT: 1 }`; unlisted codes retain the shared `maxRetries` limit, and explicit always policy has no per-code cap.
- Normal generic retry delegates eligible failures to downstream recovery before scheduling a repetition. A specialized `{ kind: 'retry' }` decision wins. Generic retry runs only when no downstream listener repairs the request, and exhausted paths return after that single delegation.
- Compaction treats HTTP 413 as request-size failure and treats `TIMEOUT` the same way only when the current estimated request reaches `timeoutRecoveryBytes` (default 512 KiB). Both bypass ordinary pressure and retained-tail policy, use the existing `maxOverflowRetries` budget, and retry only after durable surface replacement. Successful request-size recovery learns a proactive byte budget at `learnedByteSafetyRatio` (default `0.75`) for that agent and exact provider/model route; semantic context overflow does not.
- `summarizationInputBytes` (default 512 KiB) caps the complete summarizer request from automatic pressure, explicit-region, and `compactNow()` entry points: routed header, replayed messages, and fixed instruction. Oversized ranges compact through earlier balanced transactions until every request fits. Partitions preserve tool-call/result pairs, every replaced message is represented in a bounded summarizer input, and an indivisible over-cap unit fails before provider dispatch.

## Alternatives considered

**Raise or reuse the shared retry count.** Rejected because request count is not a time bound: five five-minute idle deadlines can still hold a turn for at least 25 minutes before backoff, and an unchanged large envelope receives no repair.

**Classify every TIMEOUT as request size.** Rejected because small requests can time out from ordinary transport or provider outages. `timeoutRecoveryBytes` confines the heuristic to envelopes large enough for upload-side pressure to be plausible.

**Truncate the summarizer replay but replace the full range.** Rejected because a durable checkpoint would then claim to summarize messages the model never received.

**Retry HTTP 413 through generic policy.** Rejected because the identical body cannot pass the same byte cap; only a rebuilt request can make progress.

## Verification

Resolver and retry tests cover validation, freezing, policy-key separation, one-retry TIMEOUT defaults, and downstream-recovery precedence. A real Loader composition routes pi-ai through a mock OpenAI-compatible HTTP server, returns a quota-worded 429, observes `RATE_LIMIT` with status 429, waits the configured cooldown, and succeeds on the rebuilt attempt. Adapter tests cover explicit 413/429/5xx status extraction, terminal non-429 quota, request-local timeout abort, and concurrent-request isolation. Compaction tests cover HTTP 413, large and small TIMEOUT paths, exact-route learned budgets, bounded automatic and manual entry points, balanced hierarchical requests, tool-pair boundaries, indivisible oversize failure, and complete-request cap enforcement before provider dispatch. Keyless headless and ACP snapshots exercise assembled HTTP 413 recovery and transient retry.

## Supersession audit

No active note is archived or deleted. [Request-level image payload bound](2026-08-18-request-image-payload-bound.md) remains the owner of proactive image offload and now points here for 413 recovery. [RATE_LIMIT cooldown retry](2026-08-21-rate-limit-cooldown-retry.md) remains the owner of cooldown scheduling and now covers both adapters' explicit 429 classification. The provider-policy, bounded-request-recovery, compaction capability, and after-call recovery notes retain their broader ownership with their configuration and ordering facts updated in place.

## Consequences

A default normal route makes at most one unchanged generic retry after a timeout, while a large timed-out request first receives one bounded compaction recovery opportunity. HTTP 413 reconstructs a smaller request rather than ending the session or repeating the rejected body. Request-size recovery may compact conservatively after a large timeout that was not caused by body size; operators can raise `timeoutRecoveryBytes`, change `learnedByteSafetyRatio`, or disable failed-request recovery with `maxOverflowRetries: 0`. Pi-ai routes use configured 429 cooldowns without provider response-header hints because the SDK does not expose those headers on non-2xx failures.
