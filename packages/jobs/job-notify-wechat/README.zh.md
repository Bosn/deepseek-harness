# @deepseek-ai/dsh-job-notify-wechat

[English](README.md) | 中文

这是一个可选的 host 插件，会为每条进入终态的 `ctx.jobs` 记录发送一次私人微信通知。它应当只在 host profile 中挂载一次，并位于 agent preset 之外；这样无 scope 的 listener 可以观察所有 owner，同时不会因 preset 数量而重复发送。

通知只包含 DSH job id、kind 和终态。生产方 label、输出、owner id、session id 与状态 detail 都不会进入渠道命令，因此命令文本和潜在的可复用凭据不会出现在通知 payload 中。

## 交付

`onJobDone` 在 registry 提交终态 snapshot 后运行。插件根据 owner id、job id 与 kind、开始与结束时间及终态生成稳定的 SHA-256 幂等键，然后在不经过 shell 的情况下调用配置的 OpenClaw wrapper。它只接受非 dry-run 的 JSON 回执；回执必须包含配置的 channel、message id，以及 OpenClaw CLI 的 `action=send` 约定或明确的 sent/delivered/`ok` 结果。

子进程获得的是 allowlist 环境，而不是 DSH 的完整环境。交付错误只生成不含 payload 的 warning，绝不会改变 job outcome。插件 dispose 时会先移除 listener，再中止正在发送的命令并等待它们结束。

## 配置

| key | 默认值 | 含义 |
|---|---:|---|
| `command` | 必填 | owner wrapper 或 OpenClaw CLI 的绝对路径 |
| `routeFile` | 必填 | 插件加载时读取一次的 owner-only constants 文件 |
| `accountKey` | `WEIXIN_ACCOUNT_ID` | route 文件中保存微信 account id 的 key |
| `targetKey` | `WEIXIN_BOSN_TARGET` | route 文件中保存私人 owner target 的 key |
| `channel` | `openclaw-weixin` | 传给 `message send` 的 OpenClaw channel |
| `timeoutMs` | `45000` | 正整数子进程超时 |

route key 缺失或 route 文件不可读会使插件加载失败。live account 与 target 属于部署方管理的 route 文件，不应写进仓库配置。

## 模型体验

无，因为这个 host observer 不增加工具、prompt 文本、session event、消息或 agent turn。session 内的 job 收集仍由 `@deepseek-ai/dsh-tool-jobs` 负责。

#### KV Cache 影响

没有直接影响。插件不会改变请求内容或可复用前缀。

## 已知限制与后续工作

- 插件没有自有的 durable outbox。进程如果在 job 结算之后、获得渠道回执之前退出，通知可能丢失；稳定幂等键只会在命令本身被重试时防止重复交付。
- 插件报告 DSH background job 的终态，不推断整个 session 或整个 project 的结果。
- 这个 package 只定义通知，不增加 DSH 与其他 Agent 之间的控制、委派、共享记忆或跨 Agent handoff。
