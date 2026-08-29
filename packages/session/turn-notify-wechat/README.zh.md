# @deepseek-ai/dsh-turn-notify-wechat

[English](README.md) | 中文

这是一个可选的 host 插件，会在顶层 DSH turn 到达终态 `turn/end` 时发送私人微信通知。它应当只在 host profile 中、agent preset 之外挂载一次；这样一个进程级 observer 就能覆盖所有顶层 session，同时不会报告内部 background job 或 subagent turn。

经过配置的 settle delay 后，插件读取当前 `ctx.sessionTitle` 标题，以及 turn number 与终态事件完全一致的最后一条 `assistant/message`。摘要只拼接可见的 `text` block，移除常见 Markdown 展示符号，压缩非空行，在必须截断时优先保留简洁的结果行，并施加 Unicode grapheme cluster 上限。完整组装通知还受到 UTF-8 字节上限约束，按字节截断时不会拆开 grapheme cluster。reasoning、tool call、tool result 和其他 turn 的 assistant message 都不会进入通知。没有可见 assistant 文本或没有可用 session 标题的 turn 不会产生 channel 命令。

消息格式为：

```text
DSH任务 [完成]：<session title>
<final assistant summary>
```

标签遵循 durable terminal reason：`completed` → `完成`、`aborted` → `已取消`、`error` → `失败`、`max-tokens` → `输出截断`、`blocked` → `已阻止`、`interrupted` → `已中断`。每个顶层 session 只保留一条待发送通知；如果较新的终态 turn 在旧通知开始交付前到达，它会替换旧通知。

## 交付

插件根据 session id 及精确 `turn/end` 的 turn、sequence、timestamp 和 reason 生成稳定的 SHA-256 幂等键，然后在不经过 shell 的情况下调用配置的 OpenClaw wrapper。它只接受非 dry-run 的 JSON 回执；回执必须包含配置的 channel、message id，以及 OpenClaw CLI 的 `action=send` 约定或明确的 sent/delivered/`ok` 结果。

子进程获得的是 allowlist 环境，而不是 DSH 的完整环境。经过校验的并发上限会限制同时存活的交付子进程，独立的队列上限会限制跨 session 保留的交付。同一 session 的较新排队 turn 会替换该 session 的旧排队通知；队列已满时会丢弃最旧的排队通知以保留最新完成结果，并生成不含 payload 的 warning。交付错误只生成不含 payload 的 warning，绝不会改变 durable turn result。插件 dispose 时会先移除 observer、取消待发送 timer、丢弃排队交付，再中止正在发送的命令并等待它们结束。

## 配置

| key | 默认值 | 含义 |
|---|---:|---|
| `command` | 必填 | owner wrapper 或 OpenClaw CLI 的绝对路径 |
| `routeFile` | 必填 | 插件加载时读取一次的 owner-only constants 文件 |
| `accountKey` | `WEIXIN_ACCOUNT_ID` | route 文件中保存微信 account id 的 key |
| `targetKey` | `WEIXIN_BOSN_TARGET` | route 文件中保存私人 owner target 的 key |
| `channel` | `openclaw-weixin` | 传给 `message send` 的 OpenClaw channel |
| `timeoutMs` | `45000` | 正整数子进程超时 |
| `titleMaxChars` | `80` | session 标题的正整数 Unicode 字符上限 |
| `summaryMaxChars` | `100` | assistant 摘要的正整数 Unicode 字符上限 |
| `messageMaxBytes` | `8192` | 完整通知的 UTF-8 字节上限，范围为 `256` 至 `16384` |
| `settleDelayMs` | `5000` | 解析标题并交付前的非负延迟 |
| `maxConcurrentDeliveries` | `2` | 同时运行的交付子进程正整数上限 |
| `maxQueuedDeliveries` | `64` | 保留交付数量上限，范围为 `1` 至 `256`；溢出时丢弃最旧的排队通知 |

`command` 不是绝对路径、route key 缺失或 route 文件不可读都会使插件加载失败。live account 与 target 属于部署方管理的 route 文件，不应写进仓库配置。

## 模型体验

无，因为这个 observer 会读取已有的 durable session event 与标题状态，但不会增加工具、prompt 文本、session event、消息或 agent turn。

#### KV Cache 影响

没有直接影响。插件不会改变请求内容或可复用前缀。

## 已知限制与后续工作

- 插件没有自有的 durable outbox。进程如果在 `turn/end` 之后、获得渠道回执之前退出，通知可能丢失；稳定幂等键只会在命令本身被重试时防止重复交付。
- 标题生成失败可能导致交付时没有可用 session 标题；此时插件只记录不含 payload 的 warning 并跳过通知。
- 终态标签报告的是一个 DSH turn 的结果，不推断整个 session 或整个 project 的 outcome。
- 这个 package 只定义通知，不增加 DSH 与其他 Agent 之间的控制、委派、共享记忆或跨 Agent handoff。
