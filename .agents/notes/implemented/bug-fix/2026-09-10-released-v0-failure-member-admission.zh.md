# Agent Note: 在已发布 v0 失败记录中放行 requestBytesEstimate

Status: implemented

[English](2026-09-10-released-v0-failure-member-admission.md) | 中文

## 问题

已发布的 v0 到 v1 迁移边拒绝了真实 v0 会话中带 `requestBytesEstimate` 的 LLM 失败记录。该成员于 2026-08-21 进入 `LlmError` 词表(`fix(llm): report post-conversion request bytes`),从该构建起就随 `llm/retry`、assistant finish 和 turn/end error 失败写入日志,而当时会话格式仍是 v0。十天后冻结的[已发布格式迁移](../../../../packages/session/session-format-v0-to-v1/README.zh.md)把失败白名单冻结为 `{message, code}` 加 `{status, providerRetryAfterMs, requestId}`,遗漏了该成员,于是拒绝所有此类日志:一个活跃会话(`session-021a0e4c-aea5-444f-9881-c1381637cd2f`,`llm/retry` seq 196010,`failure.requestBytesEstimate: 1948914`)历史加载失败,报 "has unexpected member \"requestBytesEstimate\"",源 v0 产物保持原样。该拒绝并非清单中的故意条目:[已提交语料清单](../../../../packages/test-support/llm-replay/tests/session-format-corpus-inventory.ts)要求未列入的产物必须能恢复,且该成员是出现在已发布期望输出中的合法当前词表。

## 决策

已发布 v0 失败记录在每一个校验位置放行 `requestBytesEstimate` —— `llm/retry.failure`、`assistant/chunk` finish 的 `reason.failure`、`turn/end` 的 `reason.error`(共用 `llmFailureValue`),以及 v0 到 v1 阶段中退役的 `turn/end` `reason.failure` 转换 —— 校验为正的安全整数。迁移在 v1-to-v2 与 v2-to-v3 中原样保留该成员,当前世代本就原生携带它。边仍然精确:任何其他意外失败成员依旧拒绝。

## 验证

v0 到 v1 套件固定了有效 fixture 清单中的接受、新叶子上的类型破坏、`0`、`-1`、`1.5` 的拒绝,以及退役 turn/end 转换的无损保留。真实被拒会话以生产恢复策略通过源码 catalog 完整恢复:17,877 行物理行解码为 2,028 个当前事件,51 处 `requestBytesEstimate` 全部保留,无拒绝。完整 session-format 家族、`session-persistence-jsonl` 与已提交语料套件原样通过,语料条目与 fixture 无改动。

## 考虑过的替代方案

**把该拒绝列入清单作为故意行为。** 语料契约禁止未列出的拒绝,保留真实产物不能以拒绝已发布写入方的输出为代价;逐一列出所有受影响日志没有边界,且会让会话永久不可读。

**把该成员归类为损坏。** 这些行是已发布构建写出的完好发布数据,不是撕裂或畸形产物;归类错误会在严格恢复下丢行或拒绝。

**在迁移中剥掉该成员。** 移除证据违背"模型可见即记录"规则:字节估值解释了重试与压缩决策,且下游世代会保留它。

## 后果

成员引入到格式迁移之间写出的 v0 产物重新可读,修复的代价是冻结清单中多一个带校验规则的成员。同样的构建版本错位仍可能暴露其他覆盖不足的已发布形态;每一种都需要同样基于证据的放行,而不是整体放宽校验。