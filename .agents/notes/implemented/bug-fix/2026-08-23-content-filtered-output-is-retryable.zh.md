# Agent Note: 内容被过滤的输出是可重试的 CONTENT_FILTERED 失败

Status: implemented

[English](2026-08-23-content-filtered-output-is-retryable.md) | 中文

## 问题

上游安全网关可能以内容审核为由拒绝一条模型*响应*：线路 `content_filter` finish reason，或 dashscope-intl 这类网关的拒绝措辞 `Output data may contain inappropriate content.`（正是这句话在 `dsh` 下终止了一次 BoAgents 周进化运行）。pi-ai 适配器的分类器没有覆盖这一类措辞，于是落入通用兜底代码 `PI_AI_ERROR`。`PI_AI_ERROR` 不在默认可重试集合里，`dsh-llm-retry` 直接放行，主循环把该 finish 错误变成 `turn/end` 失败，整个自主运行就因为一个被审核的采样而中断——模型实际产生了什么内容，与另一次采样能否通过无关。

## 决策

对*响应*的审核拒绝是单一失败类别，提供方无关，且具有瞬时性特征：被拒绝的内容只来自一次采样，因此再次请求是在有界重试预算内的一次全新的审核判定。

- `dsh-llm` 在 `EMPTY_RESPONSE_CODE` 之外导出规范 code `CONTENT_FILTERED_CODE`（`'CONTENT_FILTERED'`），默认 normal 策略的 `retryableCodes` 将其纳入（排序后列表：`CONTENT_FILTERED`、`EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`）。部署方仍可通过 `retryableCodes` 将其移除，`dsh-llm-retry` 原样执行解析后的策略。
- `dsh-llm-pi-ai`（`classifyPiAiError`）：响应侧内容审核措辞映射为 `CONTENT_FILTERED`——合成的 `finish_reason: content_filter`，或点名被拒输出的安全网关措辞（实际观察到的 dashscope-intl 原句 `Output data may contain inappropriate content.`）。该分支位于 HTTP 400 / `INVALID_REQUEST` 检查之前，因此即使网关把拒绝措辞为 400，也保留可重试类别，而不是落入永不重试的请求形状兜底。请求侧内容审核——提示在生成前被拒，例如前置 400 中的 `content_filter` 措辞——不带任何响应侧措辞，仍为 `INVALID_REQUEST`，因此确定会被拦截的提示绝不会被原样重发。
- `dsh-llm-deepseek`（`mapFinishReason`）：线路 `content_filter` finish reason 映射为同一个规范 code，取代「把原因原样大写」的通用兜底，两个适配器对同一状况给出同一命名。

预算耗尽时，该轮次仍以显式的 `CONTENT_FILTERED` 失败结束——成本有界、code 可行动、不存在静默重试循环。

## 考虑过的替代方案

**只分类不重试（通过配置选择加入）。** 影响面更小，但出厂默认仍会让自主运行因为一个被审核的采样而中断——这正是本次观察到的伤害；重试本来就被 `maxRetries`／退避所限定，`CONTENT_FILTERED` 与之共享预算。

**只识别 dashscope 原句。** 只针对单一网关的措辞，任何改写或同类网关都会再次失效；`content_filter` finish reason 是对端适配器收到的同一状况，两个名称属于同一家族。

**注入指引消息并继续，而不是重试。** 告诉模型换种说法，类是 Claude Code 系 CLI 的做法，但 harness 没有为「失败的步骤注入续写」提供主循环机制，构建它是本次修复不需要的主循环改动。

## 后果

- 一次被审核的采样至多消耗共享重试预算（默认 5 次、指数退避），随后以精确的 `CONTENT_FILTERED` code 和消息让该轮次失败。
- 每次采样都被审核的提示现在会先消耗重试再失败，而不是立即失败——接受它作为有界且可诊断的取舍。
- `content-filter-retry` ACP 快照场景（人工编写的无密钥场景，复用重试 overlay，位于 `empty-response-retry` 旁）钉住产品可见的流程：携带 `CONTENT_FILTERED` 的持久 `llm/retry` 事件、被拒绝的尝试不产生任何 ACP 输出、恢复后的回复、一次正常完成的轮次。
- 相关但未被取代：[LLM 请求失败的受限恢复](../architecture/2026-06-21-bounded-llm-request-recovery.zh.md) 拥有被本记录扩展出 `CONTENT_FILTERED` 的默认暂时性集合；[空模型补全可重试](2026-07-24-empty-model-response-is-retryable.zh.md) 负责退化空 completion 类别；[pi-ai 传输截断分类](2026-07-22-pi-ai-transport-truncation-classification.zh.md) 负责同一函数中的传输措辞分类。受限恢复记录已同步更新新 code 及其请求侧 `INVALID_REQUEST` 边界。