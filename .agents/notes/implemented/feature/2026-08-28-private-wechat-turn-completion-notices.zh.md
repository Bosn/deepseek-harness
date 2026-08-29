# Agent Note: 私人微信 Turn 完成通知

Status: implemented

[English](2026-08-28-private-wechat-turn-completion-notices.md) | 中文

## 问题

DSH 用户在没有观察 Web session 时，需要收到私人完成信号。进程级 job registry 无法提供这个信号：它的终态记录描述的是 `bash-3` 子进程一类内部 background work，而不是已完成的 assistant turn、session 任务标题或用户可见结果。

通知需要提供有用的完成上下文，同时不能转发 reasoning、tool argument、tool result 或无界 assistant 输出。第一步集成只提供感知，不增加 DSH 与其他 Agent 之间的控制、委派、共享记忆或 handoff 协议。

## 决策

`@deepseek-ai/dsh-turn-notify-wechat` 是可选的 host-level function plugin。一个无 scope 的 `session/event` observer 监听 durable `turn/end` 事件，并过滤 header origin 为 `subagent` 的 session。

每个符合条件的终态会选择 turn number 与完成 turn 完全一致的最后一条 `assistant/message`，并只拼接其中的可见 text block。插件沿用 Codex 完成摘要的清理方式和可配置 Unicode grapheme cluster 上限；reasoning 与 tool-call block 绝不会进入 channel payload。没有可见 assistant 文本的终态保持静默。

每个顶层 session 只保留一条 pending completion。经过可配置的五秒 settle delay 后，插件解析当前 `ctx.sessionTitle` 标题、施加上限，并发送 `DSH任务 [<status>]：<title>\n<summary>`。较新的终态 turn 会替换较旧的 pending completion。缺少标题时只记录不含 payload 的 warning，不发送无法识别的通知。

插件加载时从部署方管理的 constants 文件读取 account 和 target。它不经过 shell 启动配置的 OpenClaw wrapper，只传递 allowlist 环境，校验包含配置 channel 与 message id 的 sent 回执，并把交付失败转换为不含 payload 的 warning。幂等键绑定 session id 与精确终态 turn、sequence、timestamp 和 reason。dispose 会先移除 observer、取消 pending timer，再中止并等待仍在运行的 channel 子进程。

这个 package 不进入 shipped bundle。部署方通过 host profile 显式启用它，从而保留 upstream default，也避免让 agent preset 拥有进程级交付。

## 考虑过的替代方案

**观察 `ctx.jobs.onJobDone`** 被否决，因为 job terminal 属于实现细节，只能权威地标识内部 job id 与 kind，不能提供已完成的顶层 turn、session 标题或最后的可见 assistant 结果。

**把 observer 挂进每个 agent preset** 被否决，因为完成通知属于进程级部署策略。preset mount 会让重复外部 attempt 取决于 composition，也可能为 subagent turn 发送通知。

**增加跨 Agent handoff 或控制 API** 被否决，因为完成感知既不需要另一个权威，也不需要新协议。通知不会授予 mutation 或 continuation 能力。

**增加 package 自有的 durable outbox** 暂缓，因为当前部署只需要简单的本地信号，而且 OpenClaw 已接受稳定幂等键。剩余的进程退出窗口被明确记录，不引入第二套持久化系统。

**转发完整 assistant message** 被否决，因为完成感知只需要有界结果摘要。选定的纯文本摘要会排除 reasoning 与 tool 材料，并沿用 Codex 完成通知的紧凑展示。

## 影响

- 一个配置好的 host mount 会观察进程内的顶层终态 turn，不报告内部 background job 或 subagent work。
- 通知携带有界 session 任务标题与精确 turn 的最后可见 assistant 摘要；缺少任一值的 turn 保持静默。
- coalescing 后每个实际交付的终态会运行一个外部子进程；sender 失败不会改变 durable turn result。
- 由于 package 没有自有 durable outbox，进程在获得回执前退出可能丢失通知。稳定幂等键只会在同一次 attempt 多次到达 OpenClaw 时防止重复交付。
- Real Loader composition coverage 会固定 session/title mount、精确 turn 选择、有界展示、route 参数、回执校验、稳定 key 格式和 fail-open turn-result 行为。
