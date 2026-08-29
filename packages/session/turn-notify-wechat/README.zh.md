---
description: "面向运维者的私人微信完成通知说明，用于配置通过 OpenClaw 对顶层 DSH 终态 turn 进行有界的 host 级交付。"
kind: "package-reference"
---

# @deepseek-ai/dsh-turn-notify-wechat

[English](README.md) | 中文

## 概述

`dsh-turn-notify-wechat` 会在顶层 DSH turn 到达终态 `turn/end` 时发送私人微信通知。当运维者需要完成通知、但不希望报告内部 job 或 subagent turn 时，应在 agent preset 之外的 host profile 中只挂载一次。通知使用当前 session 标题和匹配的最后一条 assistant message 中的可见文本，并受到 grapheme 和 UTF-8 字节上限约束。交付采用 fail-soft 方式：渠道故障只生成不含 payload 的 warning，绝不会改变 durable turn result。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 host composition 中只挂载一次本插件，使一个进程级 observer 覆盖所有顶层 session。

### 何时选择

当部署需要在每个顶层终态 turn 后发送私人外部通知，并且能够提供 owner 管理的 OpenClaw 命令与 route 文件时选择本插件。如果通知必须在进程退出后仍可恢复、其他渠道已经负责完成报告，或部署必须报告 subagent 或 background-job turn，则跳过本插件。

### 通知内容

经过配置的 settle delay 后，插件读取当前 `ctx.sessionTitle` 标题，以及 turn number 与终态事件一致的最后一条 `assistant/message`。摘要只拼接可见的 `text` block，移除常见 Markdown 展示符号，压缩非空行，在必须截断时优先保留简洁结果行，并保持 Unicode grapheme cluster 完整。reasoning、tool call、tool result 和其他 turn 的 assistant message 都不会进入通知。没有可见 assistant 文本或没有可用标题的 turn 不会产生 channel 命令。

通知格式为：

```text
DSH任务 [完成]：<session title>
<final assistant summary>
```

标签遵循 durable terminal reason：`completed` → `完成`、`aborted` → `已取消`、`error` → `失败`、`max-tokens` → `输出截断`、`blocked` → `已阻止`、`interrupted` → `已中断`。

### 最小配置

把本插件与 session 和标题服务一起挂载。两个路径都必须是部署方管理的绝对路径：

```yaml
- id: turn-notify-wechat
  name: '@deepseek-ai/dsh-turn-notify-wechat'
  config:
    command: /absolute/path/to/openclaw-wrapper
    routeFile: /absolute/path/to/wechat-route.env
```

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `command` | 必填 | owner wrapper 或 OpenClaw CLI 的绝对路径 |
| `routeFile` | 必填 | 插件加载时读取一次的 owner-only constants 文件 |
| `accountKey` | `WEIXIN_ACCOUNT_ID` | route 文件中保存微信 account id 的 key |
| `targetKey` | `WEIXIN_BOSN_TARGET` | route 文件中保存私人 owner target 的 key |
| `channel` | `openclaw-weixin` | 传给 `message send` 的非空且不含 NUL 的 OpenClaw channel |
| `timeoutMs` | `45000` | 正整数子进程超时，最大为 `2147483647` ms |
| `titleMaxChars` | `80` | session 标题的正整数 Unicode 字符上限 |
| `summaryMaxChars` | `100` | assistant 摘要的正整数 Unicode 字符上限 |
| `messageMaxBytes` | `8192` | 完整通知的 UTF-8 字节上限，范围为 `256` 至 `16384` |
| `settleDelayMs` | `5000` | 解析标题并交付前的延迟，范围为 `0` 至 `2147483647` ms |
| `maxConcurrentDeliveries` | `2` | 同时运行的交付子进程正整数上限 |
| `maxRetainedDeliveries` | `64` | pending 与排队交付总数上限，范围为 `1` 至 `256`；溢出时丢弃最旧的保留通知 |

`command` 不是绝对路径、route key 缺失或 route 文件不可读都会使插件加载失败。live account 与 target 属于部署方管理的 route 文件，不应写进仓库配置。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-turn-notify-wechat)是所有可接受字段及其 JSDoc 的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件根据 session id 及精确 `turn/end` 的 turn、sequence、timestamp 和 reason 生成稳定的 SHA-256 幂等键，然后在不经过 shell 的情况下调用配置命令。它只接受非 dry-run 的 JSON 回执；回执必须包含配置的 channel、message id，以及 OpenClaw CLI 的 `action=send` 约定或明确的 sent、delivered 或 `ok` 结果。

子进程获得的是 allowlist 环境，而不是 DSH 的完整环境。经过校验的并发上限限制同时存活的子进程，独立的保留上限约束跨 session 的 pending settle timer 与排队交付总数。同一 session 的较新保留 turn 会替换旧通知；达到保留上限时会丢弃最旧的 pending 或排队通知，以保留最新完成结果。dispose 会移除 observer、取消 timer、丢弃排队交付、中止正在发送的命令并等待它们结束。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件配置、session observer、通知组装、有界队列和命令回执校验 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生注册；外部渠道关系不可查询，因此不安装运行时检查 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Session 包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。
- [Session 标题服务](../session-title/README.zh.md)——settle delay 后读取的标题状态。
- [Session 核心](../../core/session/README.zh.md)——标识终态 turn 与最后 assistant message 的 durable event。
- [私人微信 turn 完成通知 Agent Note](../../../.agents/notes/implemented/feature/2026-08-28-private-wechat-turn-completion-notices.zh.md)——设计与运维理由。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这个 observer 会读取已有的 durable session event 与标题状态，但不会增加工具、prompt 文本、session event、消息或 agent turn。

#### KV Cache 影响

没有直接影响。插件不会改变请求内容或可复用前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定通知交付仍需运维支持的范围。

- 插件没有自有的 durable outbox。进程如果在 `turn/end` 之后、获得渠道回执之前退出，通知可能丢失；稳定幂等键只会在命令本身被重试时防止重复交付。
- 标题生成失败可能导致交付时没有可用 session 标题；此时插件只记录不含 payload 的 warning 并跳过通知。
- 终态标签报告的是一个 DSH turn 的结果，不推断整个 session 或整个 project 的 outcome。
- 这个 package 只定义通知，不增加 DSH 与其他 agent 之间的控制、委派、共享记忆或跨 agent handoff。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
