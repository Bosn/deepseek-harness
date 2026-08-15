# Agent Note: 保留 DashScope 流式工具调用身份

Status: implemented

[English](2026-08-15-dashscope-streamed-tool-call-identity.md) | 中文

## 问题

DashScope International 的 OpenAI 兼容 chat-completions 端点会在工具调用的首个流式分片中发送非空 `id` 和函数 `name`，随后携带参数片段的续片可能将这些字段序列化为空字符串或 null。DeepSeek 直接转换器把每个已出现字段都当作替换值，因此续片会抹除已建立的身份，工具执行器最终收到 `name: ""`。由此产生的 `UNKNOWN_TOOL` 失败还会让空 call id 进入持久会话事件。

## 决策

`dsh-llm-deepseek` 只将规范 base URL `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` 识别为 DashScope International OpenAI 兼容端点。对于该端点，只有非空字符串会更新流式工具调用中缓存的 id 或函数名；空字符串和 null 的续片占位值不会改变已经建立的身份，而参数片段仍按到达顺序拼接。

兼容模式会在发送最终块之前，将从未同时建立非空 id 和函数名的已完成工具调用作为 `MALFORMED_RESPONSE` 拒绝。其他端点保留转换器的现有语义，包括已出现字段的替换行为，因此原生 API 路径不会获得 DashScope 特定的归一化。

适配器持有端点识别逻辑，并将该行为传入其私有转换器。提供方无关的 `StreamChunk` 词汇、`BlockAssembler`、agent loop（智能体循环）、工具注册表、持久化和 Web 客户端都不检查提供方主机名，也不修复工具身份。

## 曾考虑的替代方案

**为所有端点归一化空续片字段。** 否决，因为这会静默改变原生 DeepSeek 和已配置网关的语义；兼容行为应绑定到其已记录流式格式确实需要该行为的端点。

**在 `BlockAssembler`、agent loop、工具注册表或 Web 客户端中修复空身份。** 否决，因为这些层在适配器解释协议响应之后才收到提供方无关的分片，无法可靠重建已抹除的提供方元数据。

**通过基于库的 pi-ai 适配器路由 DashScope。** 否决，因为这会改变所选提供方路由及其请求、推理、重试、catalog 和诊断行为，而不是修复直接适配器的已配置端点。

## 后果

DashScope 续片占位值无法抹除有效的工具调用身份，并行调用继续由其协议索引区分；没有有效身份的 DashScope 流会在产生可执行或持久化的最终工具调用之前失败。原生 DeepSeek 响应保留其转换行为。重现 DashScope 占位值的自定义网关不会获得该兼容，除非它使用规范 DashScope base URL；支持其他端点需要显式的适配器决策，而不是主机名推断。

转换器测试固定空字符串和 null 续片、并行参数组装、选择性启用和缺少身份时的拒绝；适配器测试固定精确端点选择器，并通过提供方无关的 `BlockAssembler` 驱动所得分片。headless 快照以规范 DashScope 端点启动真实 Loader 组装，仅将其 HTTP 边界重定向到确定性 SSE，然后执行 `read`、持久化该轮，并在全新上下文中冷加载日志。使用相互独立凭据的提供方真实 API e2e 套件分别固定原生 DeepSeek 和 DashScope 工具调用往返。该决策遵循[孪生 LLM 适配器决策](../architecture/2026-06-13-twin-llm-adapters.md)确立的适配器归属，并保持更广泛的[架构一致性提案](../../proposed/process/2026-06-11-architectural-conformance.md)开放。
