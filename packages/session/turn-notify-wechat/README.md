---
description: "Private WeChat completion notices for operators configuring bounded, host-level delivery of terminal top-level DSH turns through OpenClaw."
kind: "package-reference"
---

# @deepseek-ai/dsh-turn-notify-wechat

English | [中文](README.zh.md)

## Summary

`dsh-turn-notify-wechat` sends a private WeChat notice when a top-level DSH turn reaches terminal `turn/end`. Mount it once in the host profile, outside agent presets, when an operator needs completion notices without reporting internal jobs or subagent turns. The notice uses the current session title and visible text from the matching final assistant message, with grapheme and UTF-8 byte bounds. Delivery is fail-soft: channel failures produce payload-free warnings and never change the durable turn result.

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

Mount this plugin once in the host composition so one process-level observer covers every top-level session.

### When to choose it

Choose it when a deployment needs a private external notice after each top-level terminal turn and can provide an owner-controlled OpenClaw command plus route file. Skip it when notifications must be durable across process exit, when another channel owns completion reporting, or when a deployment must report subagent or background-job turns.

### Notice content

After the configured settle delay, the plugin reads the current `ctx.sessionTitle` title and the last `assistant/message` whose turn number matches the terminal event. The summary joins only visible `text` blocks, removes common Markdown presentation, compacts non-empty lines, prioritizes concise outcome lines when truncation is required, and preserves Unicode grapheme clusters. Reasoning, tool calls, tool results, and assistant messages from other turns never enter the notice. A turn with no visible assistant text or no available title produces no channel command.

The notice format is:

```text
DSH任务 [完成]：<session title>
<final assistant summary>
```

The label follows the durable terminal reason: `completed` → `完成`, `aborted` → `已取消`, `error` → `失败`, `max-tokens` → `输出截断`, `blocked` → `已阻止`, and `interrupted` → `已中断`.

### Minimal configuration

Mount the plugin beside the session and title services. Both paths are deployment-owned absolute paths:

```yaml
- id: turn-notify-wechat
  name: '@deepseek-ai/dsh-turn-notify-wechat'
  config:
    command: /absolute/path/to/openclaw-wrapper
    routeFile: /absolute/path/to/wechat-route.env
```

| Field | Default | Meaning |
|---|---:|---|
| `command` | required | Absolute owner wrapper or OpenClaw CLI path |
| `routeFile` | required | Owner-only constants file read once at plugin load |
| `accountKey` | `WEIXIN_ACCOUNT_ID` | Route-file key containing the WeChat account id |
| `targetKey` | `WEIXIN_BOSN_TARGET` | Route-file key containing the private owner target |
| `channel` | `openclaw-weixin` | Non-empty NUL-free OpenClaw channel passed to `message send` |
| `timeoutMs` | `45000` | Positive integer subprocess timeout, at most `2147483647` ms |
| `titleMaxChars` | `80` | Positive Unicode character bound for the session title |
| `summaryMaxChars` | `100` | Positive Unicode character bound for the assistant summary |
| `messageMaxBytes` | `8192` | Complete notice UTF-8 byte bound from `256` through `16384` |
| `settleDelayMs` | `5000` | Delay before title resolution and delivery, from `0` through `2147483647` ms |
| `maxConcurrentDeliveries` | `2` | Positive integer cap on simultaneous delivery subprocesses |
| `maxRetainedDeliveries` | `64` | Pending plus queued delivery cap from `1` through `256`; overflow drops the oldest retained notice |

A non-absolute `command`, missing route keys, or an unreadable route file fail plugin load. The live account and target belong in the deployment-owned route file, not repository config. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-turn-notify-wechat) is the exhaustive source for every accepted field and its JSDoc.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin derives a stable SHA-256 idempotency key from the session id and exact `turn/end` turn, sequence, timestamp, and reason, then invokes the configured command without a shell. It accepts only a non-dry-run JSON receipt with the configured channel, a message id, and either the OpenClaw CLI `action=send` contract or an explicit sent, delivered, or `ok` result.

The subprocess receives an allowlisted environment rather than the ambient DSH environment. A validated concurrency limit bounds live subprocesses, and a separate retention limit bounds pending settle timers plus queued deliveries across sessions. A newer retained turn from the same session replaces the older notice; when retention is full, the oldest pending or queued notice is dropped so the newest completion remains. Disposal detaches the observer, cancels timers, drops queued deliveries, aborts in-flight sends, and waits for them to settle.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin configuration, session observer, notice assembly, bounded queue, and command receipt validation |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion registration; it installs no runtime check because the external channel relationship is not queryable |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.
- [Session title service](../session-title/README.md) — the title state read after the settle delay.
- [Session core](../../core/session/README.md) — the durable events that identify terminal turns and final assistant messages.
- [Private WeChat turn completion Agent Note](../../../.agents/notes/implemented/feature/2026-08-28-private-wechat-turn-completion-notices.md) — design and operational rationale.

-----

<a id="model-experience"></a>
## Model Experience

None, as the observer reads existing durable session events and title state but adds no tools, prompt text, session events, messages, or agent turns.

#### KV Cache effect

No direct effect. The plugin never changes request content or a reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where notification delivery still needs operational support.

- Delivery has no package-owned durable outbox. A process exit after `turn/end` but before the channel receipt can lose the notice; the stable idempotency key only prevents duplicate delivery when the command itself is retried.
- A title-generation failure can leave the session title unavailable at delivery time, in which case the plugin logs a payload-free warning and skips the notice.
- The terminal label reports one DSH turn result, not an inferred whole-session or whole-project outcome.
- The package defines notification only. It adds no control, delegation, shared memory, or inter-agent handoff between DSH and other agents.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
