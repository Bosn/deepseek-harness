# Agent Note: Retry gateway model-serving wrapper failures

Status: implemented

English | [中文](2026-08-22-gateway-model-serving-wrapper-retry.zh.md)

## Problem

`mapStopReason` classifies every pi-ai stream failure from its error text. The dashscope-intl compatible-mode gateway reports upstream serving-layer failures with the wrapper statement `An error occurred in model serving, error message is: […]`. When the embedded detail reads `[Invalid request parameters.]`, the existing `/invalid.?request/i` pattern classifies the whole event `INVALID_REQUEST`. The default normal retry policy never retries `INVALID_REQUEST` — a real request-shape 400 would simply be rejected again — so one mid-stream serving hiccup aborts the entire turn and discards everything it had produced.

The wrapper denotes serving infrastructure, not request shape: on 2026-08-22 the identical 444,659-byte request was accepted and streamed across seven transport-level retries and was accepted again, unchanged, by the same gateway and model twenty minutes later. A parameter rejection is answered up front, before any content; this error arrives after content has streamed.

## Decision

- `classifyPiAiError` tests the serving-wrapper preamble (`/error occurred in model serving/i`) before the 400/invalid-request branch and returns `SERVER`, which the default bounded normal policy retries with its usual budget and backoff.
- Request-shape rejections keep `INVALID_REQUEST`: a bare `[Invalid request parameters.]` without the wrapper, explicit HTTP 400 text, and any other 400-class wording still classify `INVALID_REQUEST` and remain non-retryable.
- Classification order is otherwise unchanged; error texts from other gateways are unaffected.

## Alternatives considered

**Add `INVALID_REQUEST` to the normal policy's retryable codes.** Rejected: genuinely invalid parameters repeat the same rejected envelope, so retries only purchase delay. The same gateway has produced deterministic 400s (an unsupported `reasoning_effort` value and a non-standard message role, observed 2026-08-19 and 2026-08-21) that must keep failing fast and loudly.

**Record the wrapper failure as `TRANSPORT`.** Rejected: nothing transport-level failed — the server answered with a statement about its own serving layer. `SERVER` states the true semantic and already belongs to the default retryable set.

**Classify the wrapper only when the terminal event carries zero usage.** Rejected: the pi-ai error event collapses usage, and empty usage accompanies several unrelated paths; the preamble is the reliable, stateless discriminator.

## Verification

`convert.spec.ts` pins both directions: `error occurred in model serving` → `SERVER`, and the bare `[Invalid request parameters.]` → `INVALID_REQUEST`. The complete llm-pi-ai suite covers the branch. The keyless headless scenario `apps/cli/tests/profiles/headless/tests/expected/provider-serving-wrapper` runs the assembled app through the real pi-ai adapter against a local OpenAI-compatible SSE stand-in whose first stream emits the wrapper and dies, and whose second attempt completes: the replay pins the `llm/retry` schedule (failure code `SERVER` carrying the wrapper message), the `llm/retry-started` record, retraction of the failed partial from the projected assistant message, and projection of the retry outcome leading to a completed turn.

## Consequences

A transient gateway serving failure no longer aborts a run on first occurrence; the retry resends the identical request, which the gateway accepts once its serving layer recovers (such recovery was observed mid-incident with the same request bytes). The accepted trade: if a gateway ever wraps a genuinely invalid request in the same preamble, the turn spends the bounded retry budget before failing — slower, but still finite and loud.
