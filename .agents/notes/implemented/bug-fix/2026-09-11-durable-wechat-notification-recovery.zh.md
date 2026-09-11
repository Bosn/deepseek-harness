# Agent Note: 微信通知持久恢复

Status: implemented

[English](2026-09-11-durable-wechat-notification-recovery.md) | 中文

## 问题

短暂渠道故障不应永久丢弃已完成 turn 的通知。超时或进程中断也不能证明 provider 没有发送，因此无条件重试可能重复通知 owner。

## 决策

[通知插件](../../../../packages/session/turn-notify-wechat/README.zh.md) 拥有私人版本化 outbox，并复用现有 host timer。只有新观察到的合格顶层终态进入队列。outbox 使用 hash 绑定 channel、account 与目的地；文件以 owner-only 权限原子写入，进程锁排除并发消费者。不扫描或回放 session history。

pending 与 queued 通知在 dispose 后保留。sender 只在 `sending` 状态持久化后启动；重启会把该中断状态转为 `unknown`。核实的回执持久化为 `sent` 并保存 message ID。明确 provider 拒绝和显式发送前失败码使用相同 key、有界指数退避和总次数上限重试。结果未知时停止。损坏、route 漂移与存储失败会停止发送，独立于 business turn result。

此决策取代[原通知决策](../feature/2026-08-28-private-wechat-turn-completion-notices.zh.md)中暂缓持久化的选择。原决策的顶层过滤、有界可见摘要、quiet period、coalescing 和外部授权限制继续适用。

## 考虑过的替代方案

**无条件重试全部命令失败**被否决，因为超时或回执丢失可能发生在 provider 已成功接收之后。

**回放旧 session history**被否决，因为部署无法推断 owner 已收到哪些历史通知。恢复只消费明确的 outbox admission。

**增加独立 daemon**被否决，因为 host 已拥有通知 timer 与 subprocess teardown。outbox 需要独立持久化，而不是另一个 scheduler。

## 影响

- 明确的临时故障在 host 重启后保留 key 与尝试次数；结果未知时保留证据供运维排查。
- quiet period 内重启会使用接收时捕获的标题。没有捕获标题时停止该通知。pending 保留和最近 256 条终态发送记录保持有界。
- 单元回归覆盖安全重试、次数上限、发送中断、route 漂移、存储损坏和重复占用。真实 Loader 组合验证重试恢复与回执持久化，不回放 session 或使用真实渠道。
