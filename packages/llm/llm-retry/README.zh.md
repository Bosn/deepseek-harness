# `@deepseek-ai/dsh-llm-retry`

[English](README.md) | 中文

一个函数插件，通过 agent loop（智能体循环）在开放步骤上触发的 `agent/request-error` waterfall（瀑布式事件）应用确切提供方重试策略。它不包装 `ctx.llm.stream()`：每次适配器调用仍是一次提供方尝试，每次重试都会在同一编号轮次和步骤内重复请求。

每个提供方适配器都拥有可选的嵌套 `retryPolicy`；路由在 `ctx.llm` 上注册时会捕获该策略，任何到达该注册最终适配器边界的调用都会携带它。如果之后释放或替换路由，进行中的失败仍会保留当时为其提供服务的策略；在选中任何最终适配器前发生的失败没有提供方策略，会继续委托。省略策略时使用 normal mode：为 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT` 和 `TRANSPORT` 共享五次重试，并采用从 500 ms 到 10 秒的有界指数退避与 10% jitter。默认 `maxRetriesByCode: { TIMEOUT: 1 }` 会独立于共享预算，把空闲超时限制为一次重复。`EMPTY_RESPONSE` 是适配器对未产生任何持久内容的退化提供方完成所作的分类，因此可安全重复。normal 策略可以更改共享预算、符合条件的 code、按 code 上限和退避配置。两种 mode 都会先请求下游专用恢复，接受其显式重试，并在下游持久替换表层但未授权另一请求时抑制回退；这样可避免通用重试与已经失去请求归属或遇到竞争事务的专用修复并发。除此之外，normal mode 应用有界回退，always mode 则无次数上限地重试每个模型请求失败。成功、下游持久替换后未授权重试、取消或插件 dispose（资源释放）会在活跃的委托恢复完全停稳后终止 always mode。

`RATE_LIMIT` 失败不使用快速指数退避，而是依次等待冷却调度：`backoff.rateLimitDelaysMs` 按顺序列出一次 step 中 RATE_LIMIT 重试依次消耗的等待时长（默认 `[60000, 180000, 300000]`），因此默认行为是三次分别等待一、三、五分钟的冷却重试，让网关 429 限流——包括 qwen Model Studio `insufficient_quota` 这类带 quota 措辞的 429——有时间恢复。其他 code 的重试共用 normal 预算，不会推进该调度。该调度就是 `RATE_LIMIT` 的尝试预算：normal 模式下有效上限为 `min(maxRetries, 调度长度)`；空数组关闭该调度、退回指数退避；always 模式在调度耗尽后继续使用指数退避。有效的提供方 `Retry-After` 只会抬高冷却等待，而且抖动绝不会把最终等待压到调度项或该提供方提示以下；超出定时器范围的值则被忽略、改用调度项。

其他失败仍使用两种 mode 共有的带对称 jitter 有界指数退避。有效 `providerRetryAfterMs` 不超过 `maxDelayMs` 时会替换本地退避，并且不加 jitter。超出上限的提供方延迟会使 normal mode 继续委托；always mode 则改用已配置的本地退避，避免该指令终止重试。

等待前，插件会追加一条不进入表层的 `llm/retry` 事件，其中包含共享 `retryId`、提供方、mode、已解析策略的规范 key、失败和计划延迟。该载荷由可安全用于浏览器的 `@deepseek-ai/dsh-llm-retry/types` 子路径导出，因此远程渲染器无需加载策略运行时即可使用该持久状态。该 key 包含所有影响行为的字段，并对 normal mode 的 code 与按 code 上限条目排序，因为两者都使用成员查找。只有提供方与完整策略 key 都相同的事件才会延续重试编号；因此，用限制、code 成员关系或退避不同的路由替换后，会开始自己的历史。normal 事件包含有限共享上限；always 事件省略该上限，UI 会渲染 `∞`。等待完成时，插件会在返回 `{ kind: 'retry' }` 前立即追加 `llm/retry-started`，其中带有相同的 `retryId`、轮次、步骤与重试编号；退避期间取消则不会写入 started 事件。随后循环会在仍然开放的轮次和步骤内重建并重复请求。取消与插件 dispose 会中止活跃退避，在应用中止前等待活跃的委托恢复结算，并使 dispose 前捕获的 callback 只能以失败结束。

单独发布的 `./invariant` 配套模块会检查每个已调度重试是否指向当前开放的轮次和步骤，是否与失败请求的持久提供方匹配，是否携带非空的提供方与策略标识，是否满足 mode 特定边界，是否拥有唯一步骤记录和正确的提供方策略重试编号，以及是否携带有界定时器延迟。它还要求每个 `llm/retry-started` 事件通过相同的 `retryId`、轮次、步骤与重试编号指向一个先前调度的尝试，并拒绝重复的 started 事件。full jitter 可以在下界调度为零毫秒。

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    retryPolicy:
      mode: always
      backoff:
        initialDelayMs: 1000
        maxDelayMs: 30000
        jitterRatio: 0.2
        rateLimitDelaysMs: [60000, 180000, 300000]

- name: '@deepseek-ai/dsh-llm-retry'
```

执行器没有策略配置。`dsh-llm-pi-ai` 等多提供方适配器会把 `retryPolicy` 放在每个提供方 profile 内，避免维护第二份提供方名称列表。

## 模型体验

### 模型请求恢复

#### 模型看到的内容

模型不会看到重试事件、延迟、提供方错误或失败的部分输出。重试尝试会从持久表层历史中重建相同的显式提供方／模型请求，除非下游恢复策略有意更改该表层；失败分片绝不会进入派生消息。

#### Token 影响

每次重试都是新的提供方请求，可能重复计费输入 token。normal mode 具有有限预算；always mode 可以在成功、取消或下游持久替换抑制回退前消耗无界数量的请求。`llm/retry` 自身不产生 token。

#### KV Cache 影响

重建请求保留之前的前缀，并可根据该提供方的规则复用 cache。非表层重试事件不会改变 cache 身份。

## 已知限制与暂缓事项

- **agent loop 请求恢复是唯一重试边界**：直接 `ctx.llm.stream()` 消费方仍只尝试一次，因为原始流无法持久地区分各次尝试已经发出的分片。
- **always mode 会重试永久性失败**：身份验证、配额、无效请求、协议和无法恢复的上下文错误都会继续重试，直至成功、取消、dispose 或下游持久替换抑制回退；部署负责提供方特定的成本与延迟控制。
- **有限恢复预算保持独立**：专用恢复先运行并可能重建持久状态；normal 重试只统计由确切提供方策略调度的尝试。专用策略拒绝处理后，通用重试才接收未变化的失败。
- **恢复策略按 waterfall 顺序组合**：两种 mode 都会先接受下游重试，再应用自己的回退。后续策略如果忽略取消且永不结算，也会阻止回退、轮次完全停稳和插件 dispose 完成。
- **`llm/retry` 记录调度，不是完成**：后续步骤与轮次事件用于确立成功、耗尽或取消。
