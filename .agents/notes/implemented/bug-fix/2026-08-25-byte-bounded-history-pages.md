# Agent Note: Byte-bounded history pages

Status: implemented

English | [中文](2026-08-25-byte-bounded-history-pages.zh.md)

## Problem

Refreshing the Web GUI of a huge session failed with `Failed to load history: The user aborted a request. (internal)`. Long agent tasks produce tails of several megabytes across tens of thousands of events (one observed session: ~5.8 MB, ~16k events, `hasMore: true`). The client fetches `session.history` over a 30-second timeout; legacy Chromium reports that abort as `message: 'The user aborted a request.'`, and the transport layer folds it into `{ code: 'internal' }`. `session.history` paginated by message count only, so one page could weigh far more than the browser ingests within the user-visible refresh: the load failed before any conversation rendered.

## Decision

- The gateway keeps count pagination and adds a serialized-size bound per served page. `ApiProxyService` validates `historyPageMaxBytes` (default 2 MiB) and `createApiProxy` resolves the same default (`DEFAULT_HISTORY_PAGE_MAX_BYTES` is the default value, not another knob); every deployment can tune the latitude from `cordis.yml` without a wire or client change. `0` disables the bound, mirroring `coldBlankProbeMaxBytes`.
- After count pagination and view computation, `boundHistoryPage` prices the complete serialized response — the RPC envelope, the value's other members (a tail page's projections block), the events array's delimiters, and each entry's UTF-8 serialization (host-computed tool views included) — and drops whole message groups from the page head until the response fits the budget. Group starts come from `sourceEventSeqs`, so chunks and tool pairs ride their message and no message is cut mid-stream. Views resolve against the full paginated page before the trim, so a kept entry never loses its `backscanArgs` call context to dropped groups. The newest group survives whole even when it alone exceeds the budget — an over-budget page serves the user better than an empty one. A page that still cannot fit is re-bounded without its projections block (capability-absent, the same shape loadOlder pages already serve), so the only over-budget response is one whose newest message group alone exceeds the bound.
- `hasMore` is true whenever anything older than the served head exists (`page.hasMore` or a cut head). Kept entries stay one contiguous seq range with the window tail untouched, so the existing client `loadOlder` chain (which already drops discontinuous pages) keeps walking back through everything. `subagents.history` shares the same bound.

## Alternatives considered

**Count-only pages (existing).** Rejected: message payloads vary by orders of magnitude, so a fixed message count cannot bound response bytes; the failing session's tail weighed ~5.8 MB.

**A smaller fixed default.** Rejected: observed single message groups reach ~700 KB; 2 MiB keeps several nearby exchanges visible while staying far below browser parse cost.

**Mid-message cuts.** Rejected: splitting a chunk stream or a tool pair from its message would break the append-surface grouping rendering already relies on.

**Client-side truncation.** Rejected: the client must never drop or synthesize history; model-visible speech belongs to durable, server-owned events.

## Verification

Package tests cover a fitting page served untouched, exact-budget group drops with honest `hasMore`, the newest group kept whole when it alone exceeds the budget, group-start cuts through `sourceEventSeqs`, UTF-8 multibyte accounting (not UTF-16 code units), host-computed view bytes counting toward the budget, a fitting suffix surviving an over-budget head-anchored candidate, the complete ok() RPC response serializing within the budget, a projections block either priced inside the budget or dropped rather than shipped over-budget, `0` disabling the bound, and the `Config` schema accepting the natural default while rejecting negatives and fractions. No keyless snapshot accompanies this change: page size is host transport behavior with no model-visible transcript effect, and no existing real-run example in the snapshot lanes exercises `session.history`, so a snapshot would require new harness and golden infrastructure outside this PR's scope.

## Consequences

Refreshing a huge session now answers a bounded recent tail immediately; scroll-back walks the full log one bounded page at a time. Deployments can raise `historyPageMaxBytes` or set `0` for the old behavior. The served head may exceed the budget only when the newest message group alone exceeds it.

## Supersession audit

No active note is archived or deleted. [Bound request-size and stalled-stream recovery](2026-08-21-request-size-timeout-recovery.md) keeps provider-side timeout repair; this note owns the history-serving bound behind the refresh failure.