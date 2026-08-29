# Agent Note: 受字节限定的历史页面

Status: implemented

[English](2026-08-25-byte-bounded-history-pages.md) | 中文

## 问题

在 Web 界面打开超大 Session 时，一个历史窗口可能包含数万个事件、占用数 MB（一个观测到的 Session 约为 5.8 MB、16,000 个事件，且仍有更旧历史）。仅按消息数分页无法限定传输、JSON 解析或 Client 折叠成本，因为消息负载的大小可相差几个数量级。过大的 opening window 因此可能让对话完全无法渲染，过大的旧历史页也可能使回滚浏览失败。

## 决策

- `SessionController` 把 `historyPageMaxBytes` 校验为自然数，默认值为 2 MiB；`0` 禁用该限制。controller 把已解析的值传给 `SessionHistoryController`，因此每个部署都能从 `cordis.yml` 调整限制，无需修改 Remote 接口或 Client。
- `SessionHistoryController` 在按消息数分页与 packed-record 编码之后应用该限制。`session.page` 按完整的 Connection JSON 响应计价（`server-response`、标准 Web client 的 36 字节 UUID RPC id、成功结果与页值）；opening `session.follow` snapshot 按完整的 Gateway stream JSON 消息计价（`item`、标准 Web client 的 36 字节 UUID stream id 与 snapshot 值）。两种计算都包含 record 分隔符、UTF-8 序列化与所有非 record 字段。因此 opening 计算也包含 Session header 与 projection baseline。使用其他关联 id 长度的 raw 或 custom carrier 不在该完整载体保证范围内。
- 过大的窗口会从页头移除最旧的完整 append-message 组。组起点来自 `sourceEventSeqs`；packed Assistant chunk row 与工具配套事件会与所属消息一起保留，包括切分 seq 落在 packed row 内部的情况。最新消息组即使单独超过预算也会整组保留，因为可用的超预算页优于空页。如果 opening projection baseline 使该组无法装入预算，snapshot 会在不携带这个不可分割 baseline 的情况下重新计算；Client 已把 baseline 缺失视为不重置 projection。
- 只要按数量分页或按字节修剪留下了更旧前缀，`hasMore` 就为真。保留的 record 仍是连续序列区间，且窗口尾部不变，因此 `RemoteJournalStream` 可通过 `session.page` 继续向后分页。普通 Session 与 direct subagent address 使用同一路径与限制。

## 已考虑的其他方案

**仅按数量分页。** 拒绝：消息负载可相差几个数量级，固定消息数无法约束响应字节；观测到的 Session 尾部约为 5.8 MB。

**更小的固定默认值。** 拒绝：观测到的单个消息组最大约 700 KB；2 MiB 能保留附近几轮交换，同时远低于浏览器的解析成本。

**拦腰截消息。** 拒绝：把 packed chunk run 或工具配套事件从所属消息上拆开，会破坏渲染所依赖的 append-surface 分组。

**Client 侧截断。** 拒绝：Client 不得丢弃或合成历史；模型可见话语属于持久化且由服务端拥有的事件。

## 验证

Session Controller 测试覆盖：在完整 Connection 响应的精确预算上修剪、UTF-8 多字节计数、通过 `sourceEventSeqs` 切分同时保留 packed chunk row、超预算的最新 packed 组、`0` 禁用限制、从完整 Gateway stream item 中省略过大的 projection baseline、Client 接受该无 baseline opening，以及 Config 默认值与自然数校验。该行为不附带 keyless 快照：载体字节计算不改变模型可见 transcript 输出，快照通道也不执行浏览器历史传输。

## 后果

打开超大 Session 时会提供受限的近期 journal 窗口，回滚浏览则通过受限页面遍历完整日志。部署可以调高 `historyPageMaxBytes` 或把它设为 `0`。仅当载体消息包含超预算的最新不可分割消息组，或窗口仅有 record 而没有消息切分点时，载体消息才可能超过预算。

## 取代审计

没有活动笔记被归档或删除。[为请求大小与停滞流恢复设置边界](2026-08-21-request-size-timeout-recovery.zh.md) 拥有 provider 请求恢复；本笔记拥有 Session Controller 历史响应限制。
