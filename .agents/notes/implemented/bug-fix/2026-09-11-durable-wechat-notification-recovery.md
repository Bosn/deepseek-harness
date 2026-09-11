# Agent Note: Durable WeChat notification recovery

Status: implemented

English | [中文](2026-09-11-durable-wechat-notification-recovery.zh.md)

## Problem

Transient channel failures must not permanently discard a completed turn notification. A timeout or interrupted process also cannot prove that the provider did not send a message, so unconditional retry can duplicate owner notifications.

## Decision

The [notification plugin](../../../../packages/session/turn-notify-wechat/README.md) owns a private versioned outbox and its existing host timers. Only newly observed eligible top-level terminals enter it. The outbox binds the channel, account and destination by hash; files are atomic and owner-only, and a process-owned lock excludes concurrent consumers. No session history is scanned or replayed.

Pending and queued notices survive disposal. The sender starts only after a durable `sending` transition; a restart turns that interrupted state into `unknown`. Verified receipts persist `sent` with the message ID. Definite provider rejection and explicit pre-send failure codes retry with the same key, bounded exponential delay and a total-attempt ceiling. Unknown results stop. Corruption, route drift and storage failure stop delivery independently of the business turn result.

This decision supersedes the deferred durability choice in the [original notification decision](../feature/2026-08-28-private-wechat-turn-completion-notices.md). Its top-level filtering, bounded visible summary, quiet period, coalescing and external-authority limits remain applicable.

## Alternatives considered

**Blindly retrying all command failures** is rejected because a timeout or lost receipt may follow successful provider acceptance.

**Replaying old session history** is rejected because deployment cannot infer which historical notices the owner received. Recovery consumes only explicit outbox admissions.

**Adding a separate daemon** is rejected because the host already owns notification timers and subprocess teardown. The outbox needs independent durability, not another scheduler.

## Consequences

- Definite temporary failures survive host restarts without changing their key or attempt count; unknown outcomes remain visible for operator investigation.
- A restart inside the quiet period uses the title captured at admission. An unavailable captured title stops the notice. Pending retention and the latest 256 terminal delivery records remain bounded.
- Unit regressions cover safe retries, bounds, interrupted sends, route drift, corrupt storage and duplicate ownership. Real Loader composition verifies retry recovery and receipt persistence without replaying a session or using a real channel.
