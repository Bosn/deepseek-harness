# Agent Note: 私人微信 Job 完成通知

Status: implemented

[English](2026-08-28-private-wechat-job-completion-notices.md) | 中文

## 问题

DSH 会通过 `dsh-tool-jobs` 在 owner agent 内部报告 background job 完成，但没有观察该 session 的人收不到私人完成信号。如果把另一个 listener 挂进每个 agent preset，交付次数会随着 preset 演进而增加；如果转发 label 或输出，又会在没有必要的情况下把命令材料移入 channel payload。

当前要求的第一步只是感知。DSH 不需要与其他 Agent 建立控制、委派、共享记忆或 handoff 协议。

## 决策

`@deepseek-ai/dsh-job-notify-wechat` 是可选的 host-level function plugin。一个无 scope 的 `ctx.jobs.onJobDone` listener 观察进程级 registry，并为每个终态 snapshot 调用一次配置的 OpenClaw wrapper。

消息固定为 job id、kind 和终态，不包含生产方 label、输出、detail、owner id 或 session id。owner id 只与 job identity 和时间一起参与 SHA-256 幂等输入，因此进程重启后复用的 job id 不会把无关通知折叠成一条。

插件加载时从部署方管理的 constants 文件读取 account 和 target。它不经过 shell 启动子进程，只传递 allowlist 环境，校验带 message id 的 OpenClaw CLI `action=send` JSON 约定或明确 sent 结果，并把交付失败转换为不含 payload 的 warning。dispose 会先移除 listener，再中止并等待仍在运行的 channel 子进程。

这个 package 不进入 shipped bundle。部署方通过 host profile 显式启用它，从而保留 upstream default，也避免让 agent preset 拥有进程级交付。

## 考虑过的替代方案

**把 listener 挂进 `tool-jobs` 或每个 preset** 被否决，因为 session 内 controller 使用 owner-relative、first-wins 的报告语义，而私人 owner 通知属于进程级功能。preset mount 还会让重复外部尝试成为 composition 问题。

**增加跨 Agent handoff 或控制 API** 被否决，因为完成感知既不需要另一个权威，也不需要新协议。通知不会授予 mutation 或 continuation 能力。

**增加 package 自有的 durable outbox** 暂缓，因为当前部署只需要简单的本地信号，而且 OpenClaw 已接受稳定幂等键。剩余的进程退出窗口被明确记录，不通过第二套持久化系统隐藏。

**转发生产方 label 或最终输出** 被否决，因为 label 可能包含命令和可复用凭据。job identity 与终态足以满足当前的感知需求。

## 影响

- 一个配置好的 host mount 会观察进程内有 owner 和无 owner 的终态 job。
- 每个终态 snapshot 会运行一个外部子进程；sender 失败不会改变已经提交的 job outcome。
- 通知不能用于控制 DSH 或其他 Agent，也不会创建 session event 或模型可见输入。
- 由于 package 没有自有 durable outbox，进程在获得回执前退出可能丢失通知。稳定幂等键只会在同一次 attempt 多次到达 OpenClaw 时防止重复交付。
- Real Loader composition coverage 会固定 host mount、有界 payload、route 参数、回执校验、稳定 key 格式和 fail-open 结算行为。
