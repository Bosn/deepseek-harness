# `@deepseek-ai/dsh-llm-retry`

English | [中文](README.zh.md)

Function plugin that applies exact-provider retry policy through the agent loop's open-step `agent/request-error` waterfall. It does not wrap `ctx.llm.stream()`: every adapter call remains one provider attempt, and every retry repeats the request inside the same numbered turn and step.

Each provider adapter owns an optional nested `retryPolicy`, captured when its route registers on `ctx.llm` and carried with each call that reaches that registration's final adapter boundary. An in-flight failure retains that serving policy if the route is later disposed or replaced; a failure before any final adapter is selected has no provider policy and delegates. Omission uses normal mode: five shared retries for `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, and `TRANSPORT`, with bounded exponential backoff from 500 ms to 10 seconds and 10 percent jitter. The default `maxRetriesByCode: { TIMEOUT: 1 }` limits an idle timeout to one repeat independently of that shared budget. `EMPTY_RESPONSE` is the adapters' classification of a degenerate provider completion that produced no durable content, so repeating it is safe. A normal policy can change its shared budget, eligible codes, per-code caps, and backoff. Both modes ask downstream specialized recovery first, accept its explicit retry, and suppress fallback when it durably replaces the surface without authorizing another request; this prevents a generic retry from racing a specialized repair that lost request ownership or encountered a competing transaction. Otherwise normal mode applies its bounded fallback, while always mode retries every model-request failure without an attempt limit. Success, a downstream durable replacement without retry authorization, cancellation, or plugin disposal stops always mode after active delegated recovery reaches quiescence.

RATE_LIMIT failures wait out a cooldown schedule instead of the fast exponential backoff: `backoff.rateLimitDelaysMs` lists the waits a step's RATE_LIMIT retries consume in order (default `[60000, 180000, 300000]`), so the default delivers three one-, three-, and five-minute cooldown retries while gateway 429 throttling clears. This includes quota-worded 429s such as qwen Model Studio's `insufficient_quota` when the adapter route identifies that wording as transient; pi-ai's built-in qwen token-plan routes do so by default, while custom routes opt in explicitly. Other retried codes share the normal budget without advancing the schedule. The schedule is the RATE_LIMIT attempt budget: in normal mode the effective cap is `min(maxRetries, schedule length)`, an empty array disables the schedule and falls back to exponential backoff, and always mode continues with exponential backoff after the schedule is consumed. A valid provider `Retry-After` raises a cooldown wait, and jitter never lowers the final wait below the scheduled entry or that provider hint; an out-of-timer-range value is ignored in favor of the entry.

Both modes use bounded exponential backoff with symmetric jitter for every other failure. A valid `providerRetryAfterMs` at or below `maxDelayMs` replaces local backoff without jitter. An over-cap provider delay makes normal mode delegate, while always mode uses its configured local backoff so it cannot terminate on that instruction.

Before waiting, the plugin appends a non-surface `llm/retry` event with the shared `retryId`, provider, mode, canonical resolved-policy key, failure, and scheduled delay. Its payload is available from the browser-safe `@deepseek-ai/dsh-llm-retry/types` subpath, so remote renderers can consume the durable status without loading the policy runtime. The key includes every behavior-affecting field and sorts normal-mode codes and per-code cap entries because both use membership lookup. Retry numbers continue only across events with the same provider and complete policy key, so a route replacement with different limits, code membership, or backoff starts its own history. Normal events include the finite shared maximum; always events omit it, and UIs render `∞`. When the wait completes, the plugin appends `llm/retry-started` with the same `retryId`, turn, step, and retry number immediately before returning `{ kind: 'retry' }`; cancellation during backoff writes no started event. The loop then rebuilds and repeats the request inside that still-open turn and step. Cancellation and plugin disposal abort active backoff, drain active delegated recovery before applying the abort, and make a callback captured before disposal fail closed.

The separately published `./invariant` companion checks that every scheduled retry names the current open turn and step, matches the failed request's durable provider, carries non-empty provider and policy identities, has mode-specific bounds, a unique step record, the correct provider-policy retry number, and a bounded timer delay. It also requires each `llm/retry-started` event to name one prior scheduled attempt with the same `retryId`, turn, step, and retry number, and rejects repeated started events. Full jitter may schedule zero milliseconds at its lower boundary.

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    retryPolicy:
      mode: always
      backoff:
        initialDelayMs: 1000
        maxDelayMs: 30000
        jitterRatio: 0.2
        rateLimitDelaysMs: [60000, 180000, 300000]

- name: '@deepseek-ai/dsh-llm-retry'
```

The executor has no policy config. Multi-provider adapters such as `dsh-llm-pi-ai` place `retryPolicy` inside each provider profile, avoiding a second provider-name list.

## Model Experience

### Model-request recovery

#### What the model sees

No retry event, delay, provider error, or failed partial output is model-visible. The retry attempt reconstructs the same explicit provider/model request from durable surface history unless a downstream recovery policy deliberately changes that surface; failed chunks never enter derived messages.

#### Token effect

Each retry is a new provider request and may repeat input-token billing. Normal mode has a finite budget; always mode can consume unbounded requests until success, cancellation, or a downstream durable replacement suppresses fallback. `llm/retry` itself contributes no tokens.

#### KV Cache effect

The reconstructed request preserves the prior prefix and is eligible for provider cache reuse under that provider's rules. The non-surface retry event does not change cache identity.

## Known Limitations and Deferred Work

- **Agent-loop request recovery is the only retry boundary** — direct `ctx.llm.stream()` consumers remain single-attempt because a raw stream cannot separate already-emitted chunks durably.
- **Always mode retries permanent failures** — authentication, quota, invalid-request, protocol, and unrecoverable context errors continue until success, cancellation, disposal, or a downstream durable replacement suppresses fallback; deployments own provider-specific cost and latency controls.
- **Finite recovery budgets remain independent** — specialized recovery runs first and may rebuild durable state; normal retry counts only attempts it schedules under the exact provider policy. A specialized policy that declines leaves the unchanged failure to generic retry.
- **Recovery policies compose by waterfall order** — both modes accept a downstream retry before applying their fallback. A later policy that ignores cancellation and never settles also prevents fallback, turn quiescence, and plugin disposal from completing.
- **`llm/retry` records scheduling, not completion** — later step and turn events establish success, exhaustion, or cancellation.
