# Agent Note: Per-provider request retry policies

Status: implemented

English | [中文](2026-07-24-provider-retry-policies.zh.md)

## Problem

One process may route model requests to providers with different reliability and cost constraints. A single transient classifier and finite retry budget cannot express a deployment that wants bounded recovery for most providers but requires one provider to keep retrying every model-request failure until the request succeeds or the caller cancels it.

Provider policy must follow the request that actually failed, including a route selected by `agent/request`, rather than the agent's initial options. Unbounded policy also cannot store JavaScript `Infinity` in the durable session event, and neither provider error text nor discarded partial output may enter the next model request.

## Decision

Each concrete adapter accepts an optional `retryPolicy` inside its provider configuration, validates and resolves it, and exposes that resolved route policy through `providerRetryPolicy()`. Omission selects the shared core normal default of five retries for every composition, including Web, headless, and custom profiles, with a default per-code cap of one retry for `TIMEOUT`. The effective policy remains route-owned registration state rather than a retry-executor setting. Layered settings may retain normal-only `maxRetries`, `retryableCodes`, or `maxRetriesByCode` after changing `mode` to `always`; the resolver ignores those inactive fields while still rejecting unknown keys, and the registered always policy omits them. When a call enters its final adapter boundary, `ctx.llm` binds the serving registration's immutable policy to that call; the agent loop passes it to open-step recovery before `step/end` even if the route is disposed or replaced while the request is in flight. `@deepseek-ai/dsh-llm-retry` combines that call-local policy with the failed step's durable provider identity. A call that never reaches a final adapter has no serving policy and delegates.

```yaml
providers:
  - provider: deepseek
    retryPolicy:
      mode: normal
      maxRetries: 2
      retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
      maxRetriesByCode: { TIMEOUT: 1 }
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
        rateLimitDelaysMs: [60000, 180000, 300000]
  - provider: internal
    retryPolicy:
      mode: always
      backoff:
        initialDelayMs: 1000
        maxDelayMs: 30000
        jitterRatio: 0.2
```

The listener receives the provider frozen with the failed call while its durable turn and step remain open, and never re-resolves policy from the mutable provider registry. The invariant binds that provider to the durable `request/header`. The listener derives a canonical key from every field of the resolved serving policy, sorting `retryableCodes` and `maxRetriesByCode`, and continues retry history only for the same turn, step, provider, and key. Replacing a route with different limits, code membership, per-code caps, or backoff therefore starts a new count and initial delay even when the mode is unchanged. Normal mode delegates an eligible failure to specialized recovery first; a downstream retry wins, while an unhandled failure receives generic retry up to both `maxRetries` and its optional `maxRetriesByCode` cap. In either mode, a downstream durable surface replacement without an explicit retry owns recovery and suppresses fallback, so a generic request cannot race that specialized repair.

Always mode asks downstream recovery first so a specialized policy such as context-overflow compaction can make progress. A downstream retry wins. When downstream made no durable replacement, an undefined decision or thrown recovery error falls back to an unbounded retry of the same provider request; the thrown error is logged. A durable replacement without explicit retry instead ends this recovery sequence, including when the specialized recovery throws after committing progress. The retry listener owns and drains delegated recovery before cancellation or plugin disposal can finish, then applies the abort instead of a late downstream decision. Success, turn cancellation, plugin disposal, and a downstream durable replacement without retry are the termination paths.

For failures outside the RATE_LIMIT cooldown path, both modes use exponential local delays from `initialDelayMs` to `maxDelayMs`. `jitterRatio` multiplies each target by a uniform sample in `[1 - jitterRatio, 1 + jitterRatio]`, then applies the cap. A positive provider `Retry-After` within the cap remains exact and unjittered. An over-cap provider delay makes normal mode delegate; always mode retains its guarantee by using the configured local backoff.

`backoff.rateLimitDelaysMs` is the per-attempt cooldown schedule for `RATE_LIMIT` failures, default `[60000, 180000, 300000]`: attempt N waits entry N-1, jittered by the same ratio but not capped by `maxDelayMs`, and the schedule is the RATE_LIMIT attempt budget — `min(maxRetries, length)` in normal mode, an empty array opts back into exponential backoff, and always mode continues with exponential backoff past the schedule. A valid provider `Retry-After` raises a cooldown wait (the scheduled entry is the floor); an out-of-timer-range value is ignored. The canonical key includes the schedule, so a changed schedule starts a new retry count — the [cooldown decision](../bug-fix/2026-08-21-rate-limit-cooldown-retry.md) owns these semantics.

Each scheduled retry appends a non-surface `llm/retry` event with the failed provider, policy mode, canonical resolved-policy key, provider-policy retry number, delay, and failure facts. Normal events carry finite `maxRetries`; always events omit it, and UIs render the limit as `∞`. The event and failed `assistant/chunk` records do not contribute surface messages, so the next request contains the same derived context as the failed request unless another recovery policy deliberately changes the surface.

## Alternatives considered

**One retry-executor-level `always` switch** — rejected because it cannot isolate the unbounded cost and latency risk to the provider that needs it and can silently apply after runtime rerouting. Provider route policies remain authoritative, and the effective policy is captured only after routing selects a registration.

**A separate exact-provider list on `dsh-llm-retry`** — rejected because it duplicates provider route names outside their owning adapter configuration and lets provider registration drift from recovery policy.

**A very large finite retry count** — rejected because it eventually violates the requested keep-retrying contract and serializes an arbitrary operational limit as if it were meaningful.

**Adapter-specific omission defaults** — rejected because a shared budget would have to be repeated by every adapter family and every future adapter, making equivalent model routes behave differently depending on their implementation.

**An LLM deployment-level default** — rejected because it introduces another configuration layer only to make Web differ from other compositions. The product default is uniform, while provider settings retain the existing per-route override.

**Stamp five retries into profiles when the Web UI writes them** — rejected because existing profiles, settings written outside that UI, and non-Web compositions would retain the old value.

**Provider-SDK retries** — rejected because hidden attempts multiply agent-level budgets, cannot use the open-step durable retry-event boundary, and may splice or discard streamed output without a reconstructable retry record.

**Put the error into model context** — rejected because a transport or provider diagnostic is operational state, not conversation content. It can expose sensitive provider details and changes the retried request instead of repeating the failed request.

## Verification

Adapter tests validate nested policies at provider load, prove explicit profile policies reach registration, prove omission resolves to five retries with a one-retry TIMEOUT cap, and retain the serving policy across in-flight route replacement. LLM service tests prove adapter policies are captured and omission uses the shared normal policy. Resolver tests cover per-code validation and freezing, and prove always mode ignores retained normal-only fields but returns a pure always policy. Unit tests select policies from the failed request's serving registration, separate provider and changed-policy histories, exercise always mode beyond the normal budget, cap repeated timeouts, pin jitter and delay caps, pin the cooldown schedule's one/three/five-minute waits, schedule exhaustion, provider `Retry-After` floor, and empty-schedule fallback, prove downstream recovery ordering, preserve an explicit retry after downstream replacement, suppress normal and always fallback after unowned durable progress, retain the always-mode warning when that progress also throws, prove cancellation and disposal drain delegated recovery before reaching quiescence, and prove both abort active backoff waits. Request-level coverage compares the complete messages of failed and retried attempts and rejects both provider error text and discarded partial output. A keyless headless `stream-json` snapshot runs failure, retry, and success through the assembled app, pins the complete `llm/retry` record, and rejects any model-message change between attempts. The shipped Web composition snapshot pins omitted DeepSeek and pi-ai policies, including their TIMEOUT caps, then proves settings can write `{ mode: 'always', maxRetries: 5 }` and obtain a pure always policy. JSONL and SQLite tests round-trip an always event without `Infinity`; invariant tests bind provider identity to the request header, validate failure and mode-specific timer bounds, and bind retry numbers to provider-policy keys; TUI tests render finite and infinite limits.

## Consequences

Normal mode remains a finite default, while an explicit always policy can spend unbounded requests and time on permanent authentication, quota, invalid-request, protocol, or context failures unless downstream durable recovery changes the surface without authorizing another request. Operators must pair always mode with a cancellable caller and provider-specific cost controls. A specialized policy that commits a replacement but loses request ownership can end the failed request without a generic fallback racing its durable work. Any model route using omission defaults may spend up to three more requests and their backoff time than under the former two-retry default, in exchange for recovering from longer transient outages; a persistently throttled RATE_LIMIT request may additionally wait about nine minutes across the default cooldown schedule before the original 429 ends its turn. Retry state stays observable and durable without becoming model-visible, and serving-registration capture prevents adapter lifecycle changes from retroactively changing an in-flight request's recovery contract.

This decision extends the open-step same-turn recovery, single visible adapter attempt, structured failure, and durable status design in [bounded recovery for transient LLM request failures](../architecture/2026-06-21-bounded-llm-request-recovery.md).
