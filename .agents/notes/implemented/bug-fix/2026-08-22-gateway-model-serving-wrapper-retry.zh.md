# Agent Note: 重试网关 model-serving 包装失败

Status: implemented

[English](2026-08-22-gateway-model-serving-wrapper-retry.md) | 中文

## Problem

`mapStopReason` 依据错误文本对每个 pi-ai 流失败分类。dashscope-intl compatible-mode 网关用包装语句 `An error occurred in model serving, error message is: […]` 报告上游服务层失败。当内嵌明细是 `[Invalid request parameters.]` 时，既有的 `/invalid.?request/i` 模式会把整个事件归类为 `INVALID_REQUEST`。默认 normal 重试策略从不重试 `INVALID_REQUEST`——真正的请求形状 400 只会再次被拒——因此一次中流的服务抖动就会中止整个 turn，丢弃它已产出的全部内容。

该包装语指代服务设施而非请求形状：2026-08-22 同一份 444,659 字节的请求在七次传输级重试中被接受并流出内容，二十分钟后又原样被同一网关与模型接受。参数拒绝会在任何内容之前、请求起始处作答；而此错误在内容流出之后才到达。

## Decision

- `classifyPiAiError` 在 400/invalid-request 分支之前检测服务层包装语（`/error occurred in model serving/i`）并返回 `SERVER`——默认有界 normal 策略会按惯常预算与退避重试它。
- 请求形状拒绝保持 `INVALID_REQUEST`：不带包装语的裸 `[Invalid request parameters.]`、显式 HTTP 400 文本，以及任何其他 400 类措辞仍归类 `INVALID_REQUEST`，保持不可重试。
- 分类顺序其余不变；其他网关的错误文本不受影响。

## Alternatives considered

**把 `INVALID_REQUEST` 加入 normal 策略的可重试 code。** 否决：真正无效的参数会重发同一份被拒信封，重试只会买到延迟。同一网关曾产生过确定性 400（2026-08-19 与 2026-08-21 观察到不受支持的 `reasoning_effort` 值与非标准消息角色），它们必须继续快速且响亮地失败。

**把该包装失败记录为 `TRANSPORT`。** 否决：传输层没有发生任何故障——服务器用一段关于自家服务层的语句作答。`SERVER` 才是真实语义，且已在默认可重试集合中。

**仅在终态事件携带零 usage 时才算包装语。** 否决：pi-ai 错误事件会折叠 usage，且空 usage 伴随多条无关路径；包装语才是可靠、无状态的判别依据。

## Verification

`convert.spec.ts` 双向钉死：`error occurred in model serving` → `SERVER`，裸 `[Invalid request parameters.]` → `INVALID_REQUEST`。llm-pi-ai 套件覆盖该分支。keyless headless 场景 `apps/cli/tests/profiles/headless/tests/expected/provider-serving-wrapper` 让装配后的应用经真实 pi-ai 适配器连到本地 OpenAI-compatible SSE 桩——第一次流发出 wrapper 错误后中断、第二次正常完成——回放钉住 `llm/retry` 调度（failure code `SERVER` 并携带 wrapper 消息）、`llm/retry-started` 记录、失败片段从投影 assistant 消息中剔除、重试结果投影入转写并以 completed 结束该 turn。

## Consequences

瞬时网关服务失败不再在首次出现时就中止整轮运行；重试会重发同一请求，网关在其服务层恢复后即接受（事故期间已观察到同一请求字节的此类恢复）。已知的取舍：若某网关将来把真正无效的请求也包进同一句开头，该 turn 会在失败前花掉有界重试预算——更慢，但仍有限且响亮。
