# Agent Note: 在自定义 OpenAI 兼容路由上开放 supportsDeveloperRole compat 开关

Status: implemented

[English](2026-08-19-llm-pi-ai-developer-role-compat-switch.md) | 中文

## Problem

pi-ai 的 `openai-completions` 序列化器在 `compat.supportsDeveloperRole` 为 true 时，会把推理模型的系统提示词以 `role: "developer"` 发送。pi-ai 从端点 URL 推导该标志，并对任何看起来标准的 OpenAI 兼容端点默认其为 true；只有它已安装的 catalog 条目（例如阿里云 MaaS 的 `qwen-token-plan` 路由）才带有正确的 `supportsDeveloperRole: false`。手工声明的 `llm-pi-ai` 路由——部署用来接入 pi-ai 未内置网关（例如 DashScope 国际版 compatible-mode 端点）的机制——没有可继承的 catalog 条目，而 harness 的 compat schema 只提供 `thinkingFormat` 与 `supportsReasoningEffort`。于是此类路由上的推理模型会发出 `messages[0].role = "developer"`，只接受 `system`/`assistant`/`user`/`tool`/`function` 的网关每个回合都以 400 `invalid_request_error`（"developer is not one of [...]"）失败。没有任何配置写法能够纠正它：仅有的手段是把模型声明为非推理模型（失去思考级别选择器与推理派发），或者离开受支持的配置面。

## Decision

`llm-pi-ai` 的 `PiAiCompatProfile` 现在在路由级与按模型两个层面提供 `supportsDeveloperRole`（布尔值），与 `thinkingFormat`、`supportsReasoningEffort` 并列。解析顺序为模型 → 路由 → 已安装 catalog 条目 → pi-ai 按 URL 得出的检测；路由级取值会为路由上的每个模型遮蔽 catalog 条目的取值，而且除了重述其值，仍然没有任何写法能把某个字段交还给 catalog。该字段只在 pi-ai 为其定义类型的地方——`OpenAICompletionsCompat`——被接受，因此其他协议上的模型级开关会使解析失败，路由级开关会跳过其他协议的模型，完全没有 `openai-completions` 模型的路由会被拒绝，与现有推理开关的行为一致。字段缺省时行为不变：仍由 pi-ai 的自动检测决定。推理开关不受影响——`supportsDeveloperRole` 只改变系统提示词由哪个角色承载，因此思考级别保持可选，其协议拼写不变。

## Alternatives considered

**在这类模型上声明 `reasoningEfforts: false`。** 否决：它使模型变为非推理模型，移除思考级别选择器与部署已配置的 `reasoning_effort` 派发。

**让部署改用 pi-ai catalog 提供方（`qwen-token-plan`、`qwen-token-plan-cn`）。** 作为通用答案被否决：只有这些确切路由受益，而网关自带 baseURL、模型 id 或是聚合器的部署，恰恰是手工声明路由存在的意义。

**在上游修复 pi-ai 按 URL 得出的检测。** 未被否决，但不在本仓库控制范围内；在 pi-ai 对该端点作出归类之前，每个受影响的部署都需要这个开关。已作为后续事项向上游报告。

**篡改 baseURL 以落入 pi-ai 的非标准端点名单。** 否决：它错误描述端点，一旦检测逻辑变化即失效。

## Consequences

- 网关拒绝 `developer` 角色的手工声明 `openai-completions` 路由，可以设置 `compat.supportsDeveloperRole: false`（路由级或模型级），并保持推理派发完全不受影响。
- 设置界面自动呈现该开关：Models 设置表单渲染的是命名空间 schema，因此无需任何客户端代码改动。
- 默认行为不变——字段缺省时解析如旧，沿用 pi-ai 的检测，既有配置不受影响。
- `routeCompatDefined` 现在计入新开关，因此在没有 `openai-completions` 模型的路由上设置路由级取值会被拒绝，而不是被静默跳过。

## Testing

`tests/config.spec.ts` 在 schema 边界接受布尔开关并拒绝非布尔值。`tests/catalog.spec.ts`（compat switches）证明：路由级开关生效且按模型覆盖；catalog 角色开关（`qwen-token-plan` 的 `supportsDeveloperRole: false`）在无关开关被覆盖时仍然保留；混合协议路由对它的 completions 模型同时施加推理与角色开关并跳过其余模型；在不含该字段的协议上设置模型级与路由级开关都会以既有诊断信息使解析失败。
