---
description: "The retry executor for users and maintainers configuring provider-routed model-request recovery at durable agent-step boundaries."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-retry

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-retry` is the retry executor for failed model requests: it applies each provider's resolved retry policy at the agent loop's open-step `agent/request-error` extension point, so every retry re-runs the same step inside the same open turn over the same durable history. It does not wrap the streaming call itself — every adapter call remains one provider attempt, and direct `ctx.llm.stream()` consumers stay single-attempt. Retry scheduling is durable: the plugin appends `llm/retry` events to the session log before waiting, and cancellation during backoff leaves the log consistent. Normal mode retries a bounded set of failure codes up to `maxRetries` with exponential backoff; always mode asks downstream recovery first, then retries every failure without an attempt limit.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when agent runs should recover from transient model-request failures — rate limits, server errors, timeouts, transport errors — instead of ending the turn. It is the executor: the retry policy itself lives on each provider adapter's configuration, and this package has no configuration of its own.

### When to choose it

Choose it when a composition runs the agent loop and wants durable request recovery. The plugin is a function plugin with no config; provider adapters such as `dsh-llm-deepseek` and `dsh-llm-pi-ai` own the `retryPolicy` for their routes, and multi-provider adapters place it inside each provider profile. Skip it when calls go through `ctx.llm.stream()` directly without the agent loop: those consumers remain single-attempt because a raw stream cannot separate already-emitted chunks durably.

### Minimal configuration

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

Omission of `retryPolicy` uses normal mode: five shared retries for `CONTENT_FILTERED`, `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, and `TRANSPORT`, with bounded exponential backoff from 500 ms to 10 seconds and 10 percent jitter. The default `maxRetriesByCode: { TIMEOUT: 1 }` limits a long idle timeout to one repeat independently of the shared budget. `CONTENT_FILTERED` is safe to repeat because the next sampled response receives a fresh moderation decision. Normal mode can change its finite budget, eligible codes, per-code caps, and backoff; both modes ask downstream specialized recovery first, accept its explicit retry, and suppress fallback after a durable replacement that does not authorize another request.

`RATE_LIMIT` uses `backoff.rateLimitDelaysMs` instead of the fast exponential schedule. The default `[60000, 180000, 300000]` gives three cooldown retries after one, three, and five minutes; only `RATE_LIMIT` attempts advance it. In normal mode the schedule length is that code's retry budget capped by `maxRetries`; an empty array restores exponential backoff, while always mode falls back to exponential delay after exhausting the schedule. This includes quota-worded HTTP 429 responses only on routes that classify that wording as transient, such as pi-ai's built-in qwen token-plan routes. A valid provider `Retry-After` raises the cooldown floor, and jitter never reduces the wait below either floor.

### What you can observe

Each scheduled retry is durable before its wait: the plugin appends a non-surface `llm/retry` event carrying the retry id, provider, mode, complete canonical policy key, failure, and scheduled delay, then a `llm/retry-started` event immediately before the retry begins. Retry numbering continues only for the same provider and complete policy key. When the wait completes, the loop re-runs the failed step inside the same open turn over the same durable history, so the retried request is reconstructable from the session log exactly like the original. Cancellation or plugin disposal aborts active backoff, drains active delegated recovery, and makes a callback captured before disposal fail closed.

### Failures and recovery

A failure before any final adapter is selected has no provider policy and delegates downstream unchanged. In normal mode, a failure code outside the eligible set, or an exhausted budget, delegates; in always mode, an over-cap provider delay uses the configured local backoff so the policy cannot terminate on that instruction. Nothing here is model-visible: no retry event, delay, provider error, or failed partial output reaches the model or derived messages.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the executor; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The executor is built on one rule: **durable before wait, open-step boundaries.** A retry is scheduled through the session log before any timer starts, so a crash or cancellation never leaves an invisible pending retry. Recovery runs on the agent loop's `agent/request-error` waterfall, the open-step extension point, rather than wrapping `ctx.llm.stream()` — a raw stream cannot separate already-emitted chunks durably, while the loop can re-run the failed step inside the same open turn.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The function plugin: waterfall listener, policy lookup, backoff, durable event appends |
| [`src/history.ts`](src/history.ts) | Durable retry-history lookup from the session log |
| [`src/types.ts`](src/types.ts) | Browser-safe `llm/retry` and `llm/retry-started` event payload types |
| [`src/brand.ts`](src/brand.ts) | The `RetryId` brand shared by the event payloads |

### Recovery flow

A failed step arrives on the waterfall with its provider and resolved policy. Both modes settle downstream recovery first, honor a downstream `retry` decision, and veto fallback after a durable replacement that did not authorize another request. Normal mode then checks that the failure code and its shared, per-code, or cooldown budget remain eligible. The plugin computes the delay — the `RATE_LIMIT` cooldown floor, a valid provider `Retry-After`, or local bounded exponential backoff with symmetric jitter — appends the `llm/retry` event, waits on a cancellable timer, appends `llm/retry-started`, and returns `{ kind: 'retry' }`. The loop then re-runs the failed step inside the same open turn over the same durable history.

### Waterfall composition

The plugin is one listener in the `agent/request-error` waterfall. Always mode's "downstream first" posture means a later policy that ignores cancellation and never settles also prevents fallback, turn quiescence, and plugin disposal from completing; success, cancellation, or disposal stops always mode after active delegated recovery reaches quiescence.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the service contract to the adapters that own retry policies.

- [dsh-llm service](../llm/README.md) — the provider-neutral service whose adapters own `retryPolicy`.
- [llm-deepseek adapter](../llm-deepseek/README.md) — a provider adapter with a route-level `retryPolicy`.
- [llm-pi-ai adapter](../llm-pi-ai/README.md) — a multi-provider adapter with per-profile `retryPolicy`.
- [Terminal LLM stream failures](../../../.agents/notes/implemented/architecture/2026-07-29-terminal-llm-stream-failures.md) — how failures reach the service boundary as terminal chunks.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the `StreamChunk` protocol and adapter contract.

-----

<a id="model-experience"></a>
## Model Experience

### Model-request recovery

#### What the model sees

No retry event, delay, provider error, or failed partial output is model-visible. The retry attempt reconstructs the same explicit provider/model request from durable surface history unless a downstream recovery policy deliberately changes that surface; failed chunks never enter derived messages.

#### Token effect

Each retry is a new provider request and may repeat input-token billing. Normal mode has a finite budget; always mode can consume unbounded requests until success, cancellation, or a downstream durable replacement suppresses fallback. `llm/retry` itself contributes no tokens.

#### KV Cache effect

The reconstructed request preserves the prior prefix and is eligible for provider cache reuse under that provider's rules. The non-surface retry event does not change cache identity.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the executor stops and future work begins. They are current package constraints, not a general retry comparison or a task backlog.

- **Agent turns are the only retry boundary** — direct `ctx.llm.stream()` consumers remain single-attempt because a raw stream cannot separate already-emitted chunks durably.
- **Always mode retries permanent failures** — authentication, quota, invalid-request, protocol, and unrecoverable context errors continue until success, cancellation, disposal, or a downstream durable replacement suppresses fallback; deployments own provider-specific cost and latency controls.
- **Finite recovery budgets remain independent** — specialized recovery runs first and may rebuild durable state; normal retry counts only attempts it schedules under the exact provider policy. A specialized policy that declines leaves the unchanged failure to generic retry.
- **Recovery policies compose by waterfall order** — both modes accept a downstream retry before applying their fallback. A later policy that ignores cancellation and never settles also prevents fallback, turn quiescence, and plugin disposal from completing.
- **`llm/retry` records scheduling, not completion** — later step and turn events establish success, exhaustion, or cancellation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: notes for maintainers and open questions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Retry numbers continue only across events with the same provider and complete policy key, so a route replacement with different limits, code membership, or backoff starts its own history; the key includes every behavior-affecting field and sorts normal-mode codes because eligibility uses set membership.
- The separately published `./invariant` companion validates each scheduled retry against the session log — naming the current open turn and latest closed step, matching the failed request's durable provider, and requiring each `llm/retry-started` event to name one prior scheduled attempt with the same retry id, turn, step, and retry number.

</details>
