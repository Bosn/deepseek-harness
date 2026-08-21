# Agent Note: 对带 quota 措辞的 429 限流执行冷却重试，而不是直接结束轮次

Status: implemented

[English](2026-08-21-rate-limit-cooldown-retry.md) | 中文

## Problem

网关 429 失败会直接终止任务。OpenAI 兼容网关（例如 qwen Model Studio）对按分钟 token 限流返回 `429`，提供方 `code`／`type` 为 `insufficient_quota`，并附带 "check your plan and billing" 文案——这种限流会自行恢复，但 DeepSeek 适配器的 `httpErrorCode` 把每个带 quota 措辞的响应都映射为终态 `QUOTA` code，它在默认可重试集合之外，因此第一次被拒就结束轮次、没有任何重试。普通 `RATE_LIMIT` 429 虽然可重试，但唯一的延迟机制是封顶在 `maxDelayMs`（默认 10 秒）的指数退避，并且提供方 `Retry-After` 超过该上限时 normal 模式直接放弃——没有机制能等过一个分钟级的限流窗口。

## Decision

冷却调度是一个已解析的策略事实，配置一次，在执行所有其他重试决策的同一处生效：

- `BackoffConfig.rateLimitDelaysMs` 为 `RATE_LIMIT` 失败逐次列出一个等待时长，默认 `[60000, 180000, 300000]`——三次冷却重试，分别等待一、三、五分钟。空数组关闭该调度并回落指数退避。
- DeepSeek 适配器把 `QUOTA` 留给非 429 状态上的 quota 措辞（402 余额不足），并把每个 HTTP 429——无论是否带 quota 措辞——归类为 `RATE_LIMIT`，由 `dsh-llm-retry` 负责等待。有调度封顶，真正欠费的账号最坏约九分钟后仍会失败。
- `dsh-llm-retry` 把调度项作为该次尝试的延迟，用共享抖动比例抖动，但绝不会低于该调度项或有效的提供方 `Retry-After`（在定时器范围内；超出范围的值被忽略）。调度只在同一步恢复序列的 RATE_LIMIT 重试上推进，因此其他可重试 code 共用 normal 预算而不消耗冷却配置项。normal 模式下调度取代 `maxRetries` 成为 RATE_LIMIT 预算（`min(maxRetries, 调度长度)`），调度先于共享预算耗尽；always 模式在调度耗尽后继续指数退避重试。规范策略键包含该调度，因此调度变更会像任何其他策略变更一样重置同一步内的重试历史。
- 调度是数据，不是循环变更：循环的 `agent/request-error` 恢复本就无截止时间地等待 `Promise<RequestErrorAction>`，现有的生命周期／取消信号融合也本就会在取消与 dispose 时中止分钟级等待。

## Alternatives considered

**保持 `QUOTA` 终态，让部署通过 `retryableCodes` 自行开启。** 否决：对受影响的部署，该错误永远无法归类为可重试，开启项无从生效；分钟级等待仍然需要调度机制；把 `QUOTA` 盲目加入 `retryableCodes` 还会重复重试 402 余额不足类失败。

**为带 quota 措辞的 429 新建一个规范 code。** 否决：状态 429 本身就是限流信号，两种分类共用同一个重试动作，增加第二个 code 只会多出一个没有独立归属方的路由面。

**原样遵循提供方 `Retry-After`，而不是以调度为下限。** 否决：网关提示经常缺失或只有几秒，会在限流尚未消退时重新撞上；下限才是冷却可靠性的来源。

**调高 `maxDelayMs` 的快速退避。** 否决：抬高指数上限会拖慢通常在几秒内恢复的 SERVER／TIMEOUT／TRANSPORT 恢复。

## Consequences

- 遇到带 quota 措辞的 429 限流的会话现在会记录三条不进入表层的 `llm/retry` 事件（`delayMs` 默认 60 000／180 000／300 000），只在第四次被拒后以原始 429 结束回合；无论 normal 预算为五次，RATE_LIMIT 的每轮重试都不超过默认三次冷却尝试。
- 非 429 状态上的真实欠费（402 余额不足）仍是终态 `QUOTA`；部署可以缩短、重排或禁用调度（`rateLimitDelaysMs: []`），不影响其他 code。
- 已解析策略形状与规范 `policyKey` 都新增了调度字段，因此同一 PR 更新了已提交的回放 fixture 与策略快照：`examples/acp-agent` 的重试 overlay 与 `examples/headless-agent` 的重试 fixture 都固定了短调度，其记录的 `policyKey` 字符串嵌入了固定数组。
- `llm-pi-ai` 共享 `ResolvedRetryPolicy`，但保留自己的分类并将 SDK 重试保持禁用；它的路由因为任何已解析策略都带有 `backoff.rateLimitDelaysMs`，获得了同样可配置的调度。