# Agent Note: Private WeChat turn completion notices

Status: implemented

English | [中文](2026-08-28-private-wechat-turn-completion-notices.zh.md)

## Problem

DSH users need a private completion signal when they are not watching the Web session. The process-wide job registry cannot supply that signal: its terminal records describe internal background work such as a `bash-3` subprocess, not the completed assistant turn, session task title, or user-visible result.

The notification must include useful completion context without forwarding reasoning, tool arguments, tool results, or unbounded assistant output. This first integration step provides awareness only; it does not add control, delegation, shared memory, or a handoff protocol with another agent.

## Decision

`@deepseek-ai/dsh-turn-notify-wechat` is an opt-in host-level function plugin. One unscoped `session/event` observer listens for durable `turn/end` events and suppresses sessions whose header origin is `subagent`.

Each eligible terminal selects the last `assistant/message` with the exact completed turn number and joins only its visible text blocks. The plugin applies the established Codex completion-summary cleanup and a configurable Unicode grapheme-cluster bound, then bounds the complete assembled channel message by UTF-8 bytes without splitting a grapheme cluster. Reasoning and tool-call blocks never enter the channel payload. A terminal with no visible assistant text is silent.

One pending completion is retained per top-level session. After a configurable five-second settle delay, the plugin resolves the current `ctx.sessionTitle` title, bounds it, and sends `DSH任务 [<status>]：<title>\n<summary>`. A newer terminal turn replaces an older pending completion. A missing title is a payload-free warning rather than an unidentifiable notification.

The plugin reads account and target from a deployment-owned constants file at load. It spawns the configured OpenClaw wrapper without a shell and with an allowlisted environment, validates a sent receipt carrying the configured channel and message id, and turns delivery failures into payload-free warnings. The idempotency key binds the session id and exact terminal turn, sequence, timestamp, and reason. Configurable limits bound live delivery subprocesses and the retained cross-session queue. A newer queued turn for the same session replaces its older queued notice; queue overflow drops the oldest queued notice, retains the newest completion, and emits a payload-free warning. Disposal removes the observer, cancels pending timers, drops queued deliveries, then aborts and awaits live channel subprocesses.

The package stays out of shipped bundles. A deployment opts in through its host profile, which preserves the upstream default and prevents agent presets from owning process-level delivery.

## Alternatives considered

**Observing `ctx.jobs.onJobDone`** was rejected because a job terminal is an implementation detail and can identify only an internal job id and kind. It cannot authoritatively provide the completed top-level turn, its session title, or the final visible assistant result.

**Mounting the observer in every agent preset** was rejected because completion notification is process-level deployment policy. Preset mounts would make duplicate external attempts depend on composition and would also risk notifying for subagent turns.

**Adding an inter-agent handoff or control API** was rejected because completion awareness needs neither another authority nor a new protocol. The notification grants no mutation or continuation capability.

**Adding a durable package-owned outbox** was deferred because the deployment needs a simple local signal and OpenClaw already accepts a stable idempotency key. The remaining process-exit gap is explicit instead of introducing a second persistence system.

**Forwarding the complete assistant message** was rejected because completion awareness needs a bounded result synopsis. The selected text-only summary excludes reasoning and tool material and follows the same compact presentation used by Codex completion notices.

## Consequences

- One configured host mount observes top-level terminal turns across the process without reporting internal background jobs or subagent work.
- Notifications carry a bounded session task title and the exact turn's final visible assistant summary; the complete message is byte-bounded, and turns without either value are silent.
- At most the configured number of external subprocesses run concurrently, and the retained queue cannot grow beyond its configured cap. Each delivered terminal still invokes one sender after coalescing, queue overflow favors recent completions, and sender failure does not alter the durable turn result.
- A process exit before the receipt can lose a notification because this package owns no durable outbox. The stable idempotency key prevents duplicate delivery only when an attempt reaches OpenClaw more than once.
- Real Loader composition coverage pins the session/title mount, exact-turn selection, bounded presentation, route arguments, receipt validation, stable key form, and fail-open turn-result behavior.
