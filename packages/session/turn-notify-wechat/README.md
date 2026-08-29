# @deepseek-ai/dsh-turn-notify-wechat

English | [中文](README.zh.md)

An opt-in host plugin that sends a private WeChat notice when a top-level DSH turn reaches terminal `turn/end`. Mount it once in the host profile, outside agent presets, so one process-level observer covers every top-level session without reporting internal background jobs or subagent turns.

After the configured settle delay, the plugin reads the current `ctx.sessionTitle` title and the last `assistant/message` whose turn number matches the terminal event. The summary joins only visible `text` blocks, removes common Markdown presentation, compacts non-empty lines, prioritizes concise outcome lines when truncation is required, and applies a Unicode grapheme-cluster bound. The complete assembled notice also has a UTF-8 byte bound, and byte truncation does not split a grapheme cluster. Reasoning, tool calls, tool results, and assistant messages from other turns never enter the notice. A turn with no visible assistant text or no available session title produces no channel command.

The message format is:

```text
DSH任务 [完成]：<session title>
<final assistant summary>
```

The label follows the durable terminal reason: `completed` → `完成`, `aborted` → `已取消`, `error` → `失败`, `max-tokens` → `输出截断`, `blocked` → `已阻止`, and `interrupted` → `已中断`. One pending notice is retained per top-level session; a newer terminal turn replaces an older notice that has not reached delivery.

## Delivery

The plugin derives a stable SHA-256 idempotency key from the session id and the exact `turn/end` turn, sequence, timestamp, and reason, then invokes the configured OpenClaw wrapper without a shell. It accepts only a non-dry-run JSON receipt with the configured channel, a message id, and either the OpenClaw CLI `action=send` contract or an explicit sent/delivered or `ok` result.

The subprocess receives an allowlisted environment rather than the ambient DSH environment. A validated concurrency limit bounds live delivery subprocesses, and a separate queue limit bounds retained cross-session deliveries. A newer queued turn from the same session replaces that session's older queued notice; when the queue is full, the oldest queued notice is dropped so the newest completion is retained, and the plugin emits a payload-free warning. Delivery errors become payload-free warnings and never change the durable turn result. Plugin disposal detaches the observer, cancels pending timers, drops queued deliveries, aborts in-flight sends, and waits for them to settle.

## Config

| key | default | meaning |
|---|---:|---|
| `command` | required | Absolute owner wrapper or OpenClaw CLI path |
| `routeFile` | required | Owner-only constants file read once at plugin load |
| `accountKey` | `WEIXIN_ACCOUNT_ID` | Route-file key containing the WeChat account id |
| `targetKey` | `WEIXIN_BOSN_TARGET` | Route-file key containing the private owner target |
| `channel` | `openclaw-weixin` | OpenClaw channel passed to `message send` |
| `timeoutMs` | `45000` | Positive integer subprocess timeout |
| `titleMaxChars` | `80` | Positive Unicode character bound for the session title |
| `summaryMaxChars` | `100` | Positive Unicode character bound for the assistant summary |
| `messageMaxBytes` | `8192` | Complete notice UTF-8 byte bound from `256` through `16384` |
| `settleDelayMs` | `5000` | Non-negative delay before title resolution and delivery |
| `maxConcurrentDeliveries` | `2` | Positive integer cap on simultaneous delivery subprocesses |
| `maxQueuedDeliveries` | `64` | Retained delivery cap from `1` through `256`; overflow drops the oldest queued notice |

A non-absolute `command`, missing route keys, or an unreadable route file fail plugin load. The live account and target belong in the deployment-owned route file, not repository config.

## Model Experience

None, as the observer reads existing durable session events and title state but adds no tools, prompt text, session events, messages, or agent turns.

#### KV Cache effect

No direct effect. The plugin never changes request content or a reusable prefix.

## Known Limitations and Deferred Work

- Delivery has no package-owned durable outbox. A process exit after `turn/end` but before the channel receipt can lose the notice; the stable idempotency key only prevents duplicate delivery when the command itself is retried.
- A title-generation failure can leave the session title unavailable at delivery time, in which case the plugin logs a payload-free warning and skips the notice.
- The terminal label reports one DSH turn result, not an inferred whole-session or whole-project outcome.
- The package defines notification only. It adds no control, delegation, shared memory, or inter-agent handoff between DSH and other agents.
