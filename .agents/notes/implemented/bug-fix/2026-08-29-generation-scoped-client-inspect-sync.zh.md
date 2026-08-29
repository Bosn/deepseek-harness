# Agent Note: 按 Connection generation 隔离的 Client inspect 同步

Status: implemented

[English](2026-08-29-generation-scoped-client-inspect-sync.md) | 中文

## 问题

Web Client 会在第一次 Connection 握手尚未完成时登记 Cordis inspect provider。过去每次登记都会立刻通过 `dynamicCordisRunner/syncInspectManifest` 发布完整 manifest。Remote namespace 已挂载只能证明生成的代理存在，不能证明其 carrier 已有 active Connection，因此这条启动顺序会在没有传输连接时抵达代理，并产生 `client api: dynamicCordisRunner/syncInspectManifest has no active Connection`。重连和页面局部插件 remount 也存在同一竞态。捕获被拒绝的调用能让进程继续存活，却会使页面启动路径缺少已同步的 Client provider 目录，并反复暴露白屏时观测到的故障。

## 决策

- `cordis-client-runner` 在包注入元数据中声明 Client Connection 包，并在插件注入中声明 `connection` 服务。runner 订阅 `ctx.connection.generation` 并以此作为 ready 权威；其单调递增的 generation id 会对观测去重，而随后发出的 `connection/reset` 通知仍供缓存消费方使用，不会再触发一次 manifest 同步。
- 第一次握手前的 provider 登记只改变页面本地 registry，并把完整 manifest 标为 dirty。每个 ready Connection generation 都会排队一份完整基线快照；即使 provider 集合未变也会重发，因为 Host mirror 属于上一进程 generation。
- Connection 丢失会使排队 continuation 失效并取消进行中的 inspect query。query resolution 会捕获所属 generation；即使 provider 忽略 `AbortSignal`，也绝不会通过后来的 Remote carrier 应答。
- Manifest 写入只在同一个 Connection generation 内串行。generation 丢失和替换会建立独立同步队列，因此旧 carrier 上永不 settle 的 promise 不能阻止替代 Connection 接收快照。当前 generation 的失败写入保持 dirty，等待后续 provider 变化或 ready generation，而不会进入无界重试循环。
- 页面 dispose 会先撤销 description listener、使排队工作失效并取消进行中的 query，然后 provider effect 再依次退场。

## 已考虑的其他方案

**把 Remote namespace 注入视为 ready。** 拒绝：注入只保证生成代理已经组装；Connection 激活是更晚的运行时生命周期边沿。

**捕获启动错误并重试每个被拒绝的调用。** 拒绝：这会保留握手前的无效调用，在正常启动时产生误导性 console 故障，并可能在 carrier 缺失时形成无界重试。

**跨重连保留一条同步 promise chain。** 拒绝：某一 generation 消失后，其传输 promise 仍可能保持 pending，从而阻止之后所有 generation 发布。

**只使用 `connection/reset`。** 拒绝：该事件不通知 generation 丢失，而在事件之后才挂载的 runner 需要立刻读取当前 generation 快照。

## 验证

Registry 测试覆盖握手前登记、第一次完整快照、不变 manifest 的重连重发、新 generation 越过旧 generation 永不返回的写入、同 generation 串行、失败写入保留、query 取消和 dispose。组装后的 Client 插件测试通过真实 plugin apply 路径驱动断线、重连和 dispose。GUI 测试套件、包级 typecheck、Client 包验证器、生产构建及 diff 检查都随本次生命周期修改通过。Manifest 同步属于浏览器传输行为，不改变任何模型可见文本，因此没有模型 transcript 快照变化。

## 后果

Web 启动与重连只会通过 active Connection 发布 Client inspect 能力。Host 仍接收完整替换快照而非 delta，过时的页面工作则不能跨越 generation 边界。永不 settle 的 carrier 可能在传输层释放之前保留自身 promise，但它无法延迟当前 generation。

## 取代审计

没有活动笔记被归档、拒绝或删除。[Cordis Web 动态包](../../proposed/architecture/2026-08-08-cordis-web-dynamic-packages.zh.md) 继续拥有更广的 Host/Client runner 设计；本笔记拥有 Client inspect manifest 的 Connection 生命周期，对该方案做局部专化但不取代它。
