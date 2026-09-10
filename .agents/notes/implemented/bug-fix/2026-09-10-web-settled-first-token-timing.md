# Agent Note: Restore first-token timing on settled Web Assistant records

Status: implemented

English | [中文](2026-09-10-web-settled-first-token-timing.zh.md)

## Problem

Web per-step latency reads one field: `AssistantMessageNode.timing.firstTokenTime`. Before [embedded Assistant streams](../../implemented/architecture/2026-09-01-v2-embedded-assistant-streams.md), that field was folded from the durable chunk events themselves. The perf change `84c11c7243` (*perf(client): avoid replaying settled assistant streams*) removed `expandAssistantStream` from the Chat and Trajectory Assistant Definitions, so the field is now written only by a transient `assistant/live-chunk` update. Settlement retires those transient Matches and replays the Context from durable events alone, and the durable `assistant/message` fold sets blocks, usage, and the final Match only. Every settled step therefore reaches its consumers with `firstTokenTime: null` — whether it streamed live in this tab or was loaded from history.

The user-visible effect on a settled record is the Trajectory detail panel reporting 首 token 时间不可用 / "First token unavailable" for 首 token 延迟, 生成, and 吞吐量 while 开始时间 and 总时长 stay correct, because those come from `step/start` and the settlement time. The Trajectory overview collapses that record to a single Assistant color instead of splitting TTFT from decoding, and the Chat Turn time dialog loses both its TTFT row and its decode speed. The host `sessionStats` projection never lost the figure: it reads `assistantStreamFirstTokenTime(event.data.stream)` from the same settlement, so a whole-session average could be correct while every record it averaged reported nothing.

## Decision

Both Web Assistant Definitions derive the settled first-token time from the durable embedded stream, using the early-exit reader the host projection already uses:

```ts
firstTokenTime: state.firstTokenTime ?? assistantStreamFirstTokenTime(event.data.stream)
```

`assistantStreamFirstTokenTime` from `@deepseek-ai/dsh-llm/assistant-stream` stops at the first token-bearing member, so a settlement costs one bounded scan instead of the per-delta object graph the perf change removed. A live first token still wins over the recorded one, which is what keeps an in-step `llm/retry` measured from its earliest attempt exactly as `sessionStats` does. The Definitions still never expand a settled stream into its block members, so nothing else from `84c11c7243` returns.

## Verification

`packages/client/ui-trajectory/tests/conversation-definitions.client.spec.ts` and `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts` each pin the settled packed stream's first-token time (a text run whose first member is empty, and a name-bearing Tool-call run whose time is its first member) and the settlement path that retires the transient Matches. Both suites fail on the previous Definitions. `apps/web/tests/turn-tail-actions.e2e.ts` again requires the Turn time dialog's TTFT and decode-speed rows, and `apps/web/tests/navigation-panes.e2e.ts` again requires a settled Assistant timeline span to carry the TTFT/decoding split and its hover tooltip, with `snapshots/web/navigation-panes/trajectory.expected.md` recording the tooltip.

## Alternatives considered

**Resume expanding settled streams (`expandAssistantStream`).** It would also restore streamed blocks for interrupted attempts, but it re-materializes every delta object for every settled record — the cost `84c11c7243` removed. One early-exit scan answers the only question the latency surfaces ask.

**Persist a first-token timestamp on the settlement event.** It changes the released Session format to duplicate evidence the embedded stream already carries, and splits attempt timing across two owners.

**Read the figure from the host `sessionStats` projection.** That projection is session-cumulative — sums and step counts — so it cannot label one record, and a per-record read would make the panel's value depend on which projections an assembly composed.

**Drop the unrecorded rows from the panel.** The durable evidence is present in every settlement; the display would report a missing fact that the log holds.

## Consequences

Settled Assistant records carry TTFT again everywhere node timing is consumed: the Trajectory detail panel and timeline split, the Chat Turn time dialog with its decode speed, and the window-scoped stats fallback used by assemblies without the projection. The cost is one early-exit scan per settled message, and cold presentation still reconstructs no per-delta objects, so an attempt that settles without a surface message (a failed or cancelled `assistant/attempt`) keeps no per-record timing. Upstream accepted the loss as a performance trade-off; this fork restores the display from the same durable evidence, so a later upstream fix supersedes this fold rather than merging with it.
