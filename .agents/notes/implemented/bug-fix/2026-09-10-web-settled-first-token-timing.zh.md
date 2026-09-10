# Agent Note: 恢复已结算 Web Assistant 记录的首 token 计时

Status: implemented

[English](2026-09-10-web-settled-first-token-timing.md) | 中文

## 问题

Web 的逐步骤延迟只读一个字段：`AssistantMessageNode.timing.firstTokenTime`。在[内嵌 Assistant stream](../../implemented/architecture/2026-09-01-v2-embedded-assistant-streams.zh.md)之前，该字段由持久 chunk 事件自身折算。性能改动 `84c11c7243`（*perf(client): avoid replaying settled assistant streams*）把 `expandAssistantStream` 从 Chat 与 Trajectory 的 Assistant Definition 中移除，此后该字段只由瞬态 `assistant/live-chunk` 更新写入。结算会退休这些瞬态 Match 并仅从持久事件重放 Context，而持久 `assistant/message` 的折叠只设置 blocks、usage 与最终 Match。因此每个已结算步骤都以 `firstTokenTime: null` 送达消费方——无论它是在本标签页实时流式生成的，还是从历史加载的。

在已结算记录上的用户可见后果是：Trajectory 详情面板对首 token 延迟、生成与吞吐量都报告“首 token 时间不可用”，而开始时间与总时长仍然正确（它们来自 `step/start` 与结算时刻）。Trajectory 概览把该记录收缩为单一 Assistant 颜色，不再拆分 TTFT 与解码；Chat 的用时弹层同时失去 TTFT 行与解码速度。Host 侧 `sessionStats` 投影从未丢失该数字：它从同一结算里读 `assistantStreamFirstTokenTime(event.data.stream)`，因此全会话平均值可以是正确的，而它所平均的每条记录都报告不出任何值。

## 决策

两个 Web Assistant Definition 都从持久内嵌 stream 推导已结算的首 token 时刻，复用 Host 投影既有的提前退出读取器：

```ts
firstTokenTime: state.firstTokenTime ?? assistantStreamFirstTokenTime(event.data.stream)
```

来自 `@deepseek-ai/dsh-llm/assistant-stream` 的 `assistantStreamFirstTokenTime` 在第一个携带 token 的成员处停止，因此一次结算只需一次有界扫描，而不必重建性能改动所移除的逐 delta 对象图。实时首 token 仍优先于记录值，这正是步内 `llm/retry` 依旧从最早一次尝试起算、与 `sessionStats` 一致的原因。两个 Definition 仍不把已结算 stream 展开成 block 成员，因此 `84c11c7243` 的其他内容没有回归。

## 验证

`packages/client/ui-trajectory/tests/conversation-definitions.client.spec.ts` 与 `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts` 各自固定已打包结算 stream 的首 token 时刻（首个成员为空的文本 run，以及以首个成员为时刻的具名 Tool-call run）与退休瞬态 Match 的结算路径。两个套件在改动前的 Definition 上均失败。`apps/web/tests/turn-tail-actions.e2e.ts` 重新要求用时弹层出现 TTFT 与解码速度行，`apps/web/tests/navigation-panes.e2e.ts` 重新要求已结算的 Assistant 时间条携带 TTFT／解码拆分及其悬停提示，并由 `snapshots/web/navigation-panes/trajectory.expected.md` 记录该提示。

## 考虑过的替代方案

**恢复展开已结算 stream（`expandAssistantStream`）。** 它还能为被打断的尝试恢复流式 blocks，但会为每条已结算记录重建全部 delta 对象——正是 `84c11c7243` 移除的开销。一次提前退出扫描即可回答延迟界面唯一要问的问题。

**在结算事件上持久化首 token 时间戳。** 这为重复内嵌 stream 已携带的证据改动已发布的会话格式，并把尝试计时拆到两个归属方。

**从 Host `sessionStats` 投影读取该数字。** 该投影是全会话累计的——总和与步骤计数——无法标注单条记录，且逐记录读取会让面板取值取决于装配组合了哪些投影。

**从面板中删掉未记录的行。** 每条结算里都存在这份持久证据；显示为缺失会让界面报告日志其实持有的事实。

## 后果

已结算 Assistant 记录在所有消费节点计时的地方重新携带 TTFT：Trajectory 详情面板与时间条拆分、Chat 用时弹层及其解码速度，以及无投影装配所用的窗口口径统计回退。代价是每条已结算消息一次提前退出扫描；冷展示仍不重建任何逐 delta 对象，因此没有 surface message 的尝试（失败或被取消的 `assistant/attempt`）仍无逐记录计时。上游把该缺失作为性能取舍接受；本 fork 从同一份持久证据恢复显示，因此日后上游的修复将取代这处折叠，而不是与之合并。
