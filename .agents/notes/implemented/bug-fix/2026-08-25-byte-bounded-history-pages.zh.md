# Agent Note: 受字节限定的历史页面

Status: implemented

[English](2026-08-25-byte-bounded-history-pages.md) | 中文

## 问题

刷新超大会话的 Web 界面失败，报错 `Failed to load history: The user aborted a request. (internal)`。长 agent 任务会产生数 MB 大、包含数万个事件的尾部（一个观测到的会话：约 5.8 MB、约 16k 事件、`hasMore: true`）。客户端用 30 秒超时来拉取 `session.history`；旧版 Chromium 把这种中止报成 `message: 'The user aborted a request.'`，传输层再把它折叠为 `{ code: 'internal' }`。`session.history` 原本只按消息数分页，因此一页仍可能远超过浏览器在用户可感知的刷新时间内的吞吐量：加载在渲染出任何对话之前就失败了。

## 决策

- 网关保留按消息数分页，同时为每个被服务的页面增加序列化大小界限。`ApiProxyService` 校验 `historyPageMaxBytes`（默认 2 MiB），`createApiProxy` 解析同一默认值（`DEFAULT_HISTORY_PAGE_MAX_BYTES` 是默认值，而非另一个旋钮）；每个部署都能从 `cordis.yml` 调整余量，无需改动协议或客户端。`0` 关闭该界限，与 `coldBlankProbeMaxBytes` 对称。
- 计数分页和视图计算之后，`boundHistoryPage` 按完整序列化响应计价——RPC 信封、值中的其他成员（尾页 projections 块）、事件数组分隔符与每个条目的 UTF-8 序列化（含宿主计算的工具视图）——并从页头丢弃完整的消息组，直到响应落入预算。组起点来自 `sourceEventSeqs`，因此 chunk 与工具对都跟随所属消息，任何消息都不会被拦腰截断。视图在修剪前先对完整分页页解析，因此保留下来的条目不会因为组被丢弃而丢失它的 `backscanArgs` 调用上下文。最新一组即使单独超过预算也会完整保留——超预算的一页胜过空页。仍然装不下的页面会摘掉 projections 块再限界（能力缺失，与 loadOlder 页同形），因此唯一超预算发出的响应，是其最新消息组自身单独超过界限的那一种。
- 只要被服务头部之前还有任何内容（`page.hasMore` 或裁剪过的页头），`hasMore` 就为真。保留的条目仍是连续 seq 区间且窗口尾部不动，因此现有的客户端 `loadOlder` 链（本身就会响亮地丢弃不连续页）仍能一路回溯全部历史。`subagents.history` 共用同一界限。

## 已考虑的其他方案

**仅按数量分页（现状）。** 拒绝：消息负载可相差几个数量级，固定消息数无法约束响应字节；故障会话的尾部约 5.8 MB。

**更小的固定默认值。** 拒绝：观测到的单个消息组最大约 700 KB；2 MiB 能保留附近几轮交换，同时远低于浏览器的解析成本。

**拦腰截消息。** 拒绝：把 chunk 流或工具对从所属消息上拆开，会破坏渲染所依赖的追加分组。

**客户端截断。** 拒绝：客户端绝不得丢弃或合成历史；模型可见话语属于持久化、由服务端拥有的事件。

## 验证

包内测试覆盖：不超预算的页面原样保留、恰好等于预算时的整组丢弃与诚实 `hasMore`、最新一组单独超预算时整组保留、经 `sourceEventSeqs` 的组起点切割、UTF-8 多字节计数（而非 UTF-16 码元）、宿主计算的视图字节计入预算、页首候选超预算时保留拟合后缀、完整 ok() RPC 响应的序列化不超预算、projections 块要么在预算内计价要么被摘除而非超预算发出、`0` 关闭界限，以及 `Config` schema 接受自然数默认值并拒绝负数与小数。本变更不附带 keyless 快照：页面大小属于宿主传输行为，对模型可见输出没有影响，且快照通道中不存在会执行 `session.history` 的既有真实运行示例，新增快照需要超出本 PR 范围的测试基建与金样。

## 后果

刷新超大会话现在会立刻应答有界的近期尾部；回滚浏览则每次按有界页面逐页回溯完整日志。部署可以调高 `historyPageMaxBytes`，或设为 `0` 恢复旧行为。仅当最新消息组单独超过预算时，被服务页头才可能超过预算。

## 取代审计

没有活动笔记被归档或删除。[为请求大小与停滞流恢复设置边界](2026-08-21-request-size-timeout-recovery.zh.md) 继续拥有提供方侧的超时修复；本笔记拥有刷新失败背后的历史读取界限。