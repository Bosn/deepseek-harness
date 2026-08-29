# Agent Note: Request-level image payload bound

Status: implemented

English | [中文](2026-08-18-request-image-payload-bound.zh.md)

## Problem

Every image in session history is base64-inlined into every model request by the pi-ai adapter, so a long session's request body grows monotonically with each admitted image. Gateways cap request-body size; once the accumulated payload crossed such a cap the request was rejected with 413 (`Failed to buffer the request body: length limit exceeded`), and because nothing bounds or trims the assembled request, every retry resent the same oversized body. The session was permanently unusable, and the failure text matched no `classifyPiAiError` rule, so it surfaced as the generic `PI_AI_ERROR`. Admission bounds (per image, per message) cannot prevent this: each image is individually admissible, and the sum still grows without bound. Two screenshots were enough to trigger it in production.

## Decision

Each pi-ai profile carries `maxRequestImageBytes` (20MiB by default) for aggregate base64 request-image payload. The direct DeepSeek adapter instead uses its upstream representation-specific controls: `maxRequestFilesBytes` for Files requests and `maxInlineRequestImageBytes` for base64 fallback, with independent count and quantized removal settings. The provider-neutral `offloadRequestImagesWithPolicy` conversion prices each represented image without reading an image that will be omitted, then replaces a deterministic oldest prefix with per-image `offloadedImageText`. The placeholder retains attachment identity and any currently resolved read-only path, so the model can reopen the normalized object or ask the user to attach it again. The most recent images are omitted last; an image larger than the bound is itself omitted. Occurrence-order replacement does not depend on object identity, so replaying the same JSON log produces the same request. Both adapters classify HTTP 413 as `CONTEXT_WINDOW_EXCEEDED` so failed-request compaction can rebuild a smaller envelope; pi-ai also recognizes specific request-body-cap wording. With the 1MiB request-version default, the pi-ai 20MiB bound retains fifteen maximum-size versions after base64 expansion while leaving the remaining request envelope outside that image-only budget; stricter gateways lower the value per route.

## Offload is conversion, not history

The placeholder is model-visible but not logged as a session event. It stays within the model-visible ⟺ logged invariant the same way the adapter's other serialization does (`(no output)` fallbacks, text-only folding): the offload locations are a pure function of the logged history and the route configuration, so the exact request remains reconstructable from the session log plus the composition. A logged elision event becomes necessary only when offload decisions gain non-deterministic inputs (for example live gateway feedback), which belongs to the deferred capability-metadata design.

## Alternatives considered

- **Fail the request with a clear error instead of offloading.** Keeps the model informed but leaves the session wedged: the user cannot remove images from durable history, so a hard failure at the bound is permanent. Offload keeps the session serviceable, which is the point of the fix.
- **Require Files references on every route.** The direct DeepSeek adapter now prefers Files ids, but pi-ai spans providers without one shared upload lifecycle. Representation-specific offload remains required for inline-only routes and for direct DeepSeek's deterministic inline fallback.
- **Count the full request body, not only images.** Text and tools contribute little and their sizes are only known after full serialization per protocol; bounding the dominant term with explicit headroom is accurate enough for the failure being fixed and much simpler. Revisit inside the route-capability design.
- **Trim at admission instead.** Admission cannot see future accumulation; only the assembled request knows its total. Admission-side bounds (per-side dimension, bytes) remain as the first layer and are owned by [the unified image request pipeline note](../feature/2026-08-20-unified-image-request-pipeline.md).

## Related

- [Unified image request pipeline](../feature/2026-08-20-unified-image-request-pipeline.md) — the admission-layer companion fix; together they close the two observed session-poisoning failures (400 dimension, 413 body size).
- [DeepSeek Files inline fallback](2026-08-21-deepseek-files-inline-fallback.md) — applies this provider-neutral conversion to the official multimodal route.
- [Request-size and stalled-stream recovery](2026-08-21-request-size-timeout-recovery.md) — owns 413 classification, bounded summarizer requests, and the rebuilt-request retry.

## Consequences

- An image-heavy long session keeps completing requests. The oldest images are omitted first; the most recent image is omitted only when it cannot fit within the bound.
- Crossing the bound rewrites an early message, so the provider prompt-cache prefix ends at the newly offloaded image until the offloaded prefix stabilizes.
- Pi-ai's bound and direct DeepSeek's inline bound count base64 image payload only; deployments must keep them below their gateway's request-body cap with headroom, and the shipped defaults cannot know a private gateway's cap. Direct DeepSeek Files mode applies its separate raw-byte bound.
- Route capability metadata driving admission and assembly together (image count, per-image size, request size, provider token formulas) remains deferred design work tracked outside this fix.
