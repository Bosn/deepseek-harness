# Agent Note: top-level BoAgents maintenance reporting

Status: implemented

[English](2026-08-30-boagents-maintenance-reporting.md) | 中文

## Problem

DSH 可以同时运行多个独立 top-level session，而 Priapus 自动修复不能把工程任务产生的短暂 service 或 scheduler failure 当成无人处理的故障。Process-wide boolean 会丢失每个任务的 owner、并发释放顺序、exact terminal identity 与 crash expiry。把每个 active session 都当作 maintenance 又会阻塞无关分析和普通工作。

Maintenance authority 位于 TiDB，并由 owner-only typed command socket 提供。DSH 必须贡献 exact session 与 turn identity，同时不能向模型提供数据库凭据或可写 identity 字段；reporter crash 必须停止续租，不能留下永久 maintenance state。

## Decision

`dsh-maintenance-reporter` 是一个可选的 Host-plane lifecycle adapter。它向既有受管 `DSH_*` environment 提供当前 top-level session、turn、process generation 与 reporter identity。Source-managed user-global AGENTS instructions 告诉模型哪些 BoAgents mutation 必须运行固定 owner helper。Helper 从这些受管值派生 actor，并在普通 tool output 中返回一个 typed acquire receipt；只有该 exact receipt 在匹配 session 与 turn 中 durable 后，reporter 才采用 lease。

Reporter 不存储 authoritative lease database。它只保留从已接受 DB receipt 派生的 process-local handle，按固定 cadence 为 active top-level holder 续租，并在匹配 `turn/end` 释放。Release 失败后 terminal holder 永不再续租，因此 DB-time expiry 仍是 fallback。Subagent session 不能 acquire，而是继承 parent holder。Teardown 停止 timer、在 transport 允许时撤销 coverage、等待 command chain，并让仍在运行的 task holder 自然过期，不编造 terminal result。

Coverage 与 holder count 独立。只有每个 running top-level preset 都加载 user-global instructions，并能提供 exact per-turn managed identity 时才是 current。`standard`、`ptc` 与 `cordis` 同时满足两项。`minimal` 会加载 instructions，但其 persistent shell 不是 per-call `shell-env` consumer，因此 active minimal session 上报 coverage unavailable；BoAgents mutation 必须移到 reporting-capable preset。

Codex owner helper 与 watcher 使用相同 typed command/result protocol。两个 runtime 因此都能上报一个 top-level holder、五分钟续租、exact terminal release 与 coverage，而不增加 active-task proxy 或第二个 repair executor。

## Alternatives considered

- **一个 process-wide maintenance flag 或 counter**——拒绝，因为它不能识别并发 holder、仅在最后一个任务结束时释放、拒绝其它任务的更新，或让 crash owner 安全过期。
- **把每个 active DSH session 都当作 maintenance**——拒绝，因为 read-only 和无关 session 不应暂停自动修复。
- **让模型提交 session、turn、generation、TTL 或 expiry**——拒绝，因为这些是 runtime 与 DB fact，不是模型参数。
- **在 TiDB 旁持久化本地 lease registry**——拒绝，因为它会创建第二 authority。Local handle 只是派生 cache，并在 reporter failure 后停止续租。
- **仅凭 process-level session id 声称 minimal coverage**——拒绝，因为 persistent shell 无法证明由哪个 current turn 发出 command。

## Consequences

通过 admission 的 top-level DSH mutation 无需直接 DB access 即可发布一个 holder。多个 session 作为独立 generation 共存；terminal 或 disposed session 停止续租；reporter crash 收敛到 coverage unavailable 与固定 holder expiry。无关 session 在任务不符合 AGENTS 分类时不会产生 holder。

Source test 固定 exact actor/turn binding、duplicate-receipt rejection、generation/revision heartbeat、terminal release、failed-release expiry、subagent inheritance、minimal-preset coverage 与 typed command fields。Live instruction installation、profile composition、database adoption、reporter hash 与 service readback 属于独立 activation work。
