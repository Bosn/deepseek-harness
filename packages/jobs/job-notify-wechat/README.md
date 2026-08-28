# @deepseek-ai/dsh-job-notify-wechat

English | [中文](README.zh.md)

An opt-in host plugin that sends one private WeChat notice for every terminal `ctx.jobs` record. Mount it once in the host profile, outside agent presets, so the unscoped listener observes every owner without multiplying sends per preset.

The notice contains only the DSH job id, kind, and terminal status. Producer labels, output, owner ids, session ids, and status details never enter the channel command. This keeps command text and possible reusable credentials outside the notification payload.

## Delivery

`onJobDone` runs after the registry commits a terminal snapshot. The plugin derives a stable SHA-256 idempotency key from the owner id, job id and kind, start and finish timestamps, and terminal status, then invokes the configured OpenClaw wrapper without a shell. It accepts only a non-dry-run JSON receipt with the configured channel, a message id, and either the OpenClaw CLI `action=send` contract or an explicit sent/delivered or `ok` result.

The subprocess receives an allowlisted environment rather than the ambient DSH environment. Delivery errors become payload-free warnings and never change the job outcome. Plugin disposal detaches the listener, aborts in-flight sends, and waits for them to settle.

## Config

| key | default | meaning |
|---|---:|---|
| `command` | required | Absolute owner wrapper or OpenClaw CLI path |
| `routeFile` | required | Owner-only constants file read once at plugin load |
| `accountKey` | `WEIXIN_ACCOUNT_ID` | Route-file key containing the WeChat account id |
| `targetKey` | `WEIXIN_BOSN_TARGET` | Route-file key containing the private owner target |
| `channel` | `openclaw-weixin` | OpenClaw channel passed to `message send` |
| `timeoutMs` | `45000` | Positive integer subprocess timeout |

Missing route keys or an unreadable route file fail plugin load. The live account and target belong in the deployment-owned route file, not repository config.

## Model Experience

None, as this host observer adds no tools, prompt text, session events, messages, or agent turns. In-session job collection remains owned by `@deepseek-ai/dsh-tool-jobs`.

#### KV Cache effect

No direct effect. The plugin never changes request content or a reusable prefix.

## Known Limitations and Deferred Work

- Delivery has no package-owned durable outbox. A process exit after job settlement but before the channel receipt can lose the notice; the stable idempotency key only prevents duplicate delivery when the command itself is retried.
- The plugin reports DSH background-job terminals, not an inferred whole-session or whole-project outcome.
- The package defines notification only. It adds no control, delegation, shared memory, or inter-agent handoff between DSH and other agents.
