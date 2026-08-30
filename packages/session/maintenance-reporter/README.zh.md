---
description: "Bosn 私有 BoAgents 部署的 DSH 顶层维护 holder 生命周期与 coverage 上报。"
kind: "package-reference"
---

# @deepseek-ai/dsh-maintenance-reporter

[English](README.md) | 中文

## 概述

`dsh-maintenance-reporter` 把顶层 DSH turn 接入 owner-only BoAgents maintenance command socket。它向受管 `DSH_*` shell 环境提供 exact session/turn/process 事实，观察 owner helper 产生的 typed acquire receipt，每五分钟续租 holder，在匹配的 terminal turn 释放，并上报所有 running top-level preset 是否能加载 instructions 和 acquire holder。它不持有数据库凭据，也不是 mutation permission、mutex、repair executor 或第二套 lease store。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

## Use this package

在 Host plane 的 `agents` 与 `shell-env` 旁挂载一次：

```yaml
- name: '@deepseek-ai/dsh-maintenance-reporter'
  config:
    socketPath: /run/user/1000/bocc-ingest.sock
    policyPath: /home/ec2-user/clawd/config/boagents-autorepair.v1.json
    reporterHash: sha256:<admitted-release-hash>
    heartbeatMs: 300000
    requestTimeoutMs: 15000
    instructionCoveredPresets: [standard, ptc, cordis, minimal]
    reportingCapablePresets: [standard, ptc, cordis]
```

模型不能提供 actor、task、turn、holder、lease、generation、TTL、expiry、policy 或 reporter identity。插件只向当前 shell execution 提供 `DSH_MAINTENANCE_TOP_LEVEL`、`DSH_MAINTENANCE_TURN_ID`、`DSH_MAINTENANCE_RUNTIME_GENERATION` 与 `DSH_MAINTENANCE_REPORTER_ID`。source-managed global AGENTS instructions 说明符合条件的顶层 session 何时运行固定 owner helper。

Acquire result 必须先进入 durable `tool/result` log，插件才采用其 lease。session、turn、actor、protocol 或 holder identity 不同的 receipt 会被忽略或让 coverage 变为 unavailable，绝不会覆盖第一个 exact lease。数据库 command plane 对每个 top-level task 只拥有一个 active holder generation：相同重试或同一 session 的后续 turn 必须 replay 该 generation，绝不能创建并行 holder。Heartbeat command identity 绑定 lease generation 与 expected holder revision；release 还绑定 terminal reason，coverage 则使用有界 cadence generation。Transport response 模糊时只用完全相同的 command bytes 重试一次。Subagent 继承 parent holder，不能重复 acquire。

Terminal release 是 best effort。Turn 一旦 terminal，该 holder 永不再续租，因此 transport failure 仍会通过固定 DB-time expiry 收敛。插件 teardown 停止 timer、尽可能发布 coverage unavailable，并等待 command chain；它不会把仍在运行的 turn 作为成功释放。

## Model Experience

### Managed shell identity

#### What the model sees

既有 shell tool 会说明四个受管 `DSH_MAINTENANCE_*` environment fact。值本身只进入 subprocess environment，不进入 request prefix。User-global AGENTS instructions 包含固定 acquire command 与正/负分类规则。

#### Token effect

Reporter 只增加 instruction loader 已拥有的有界 AGENTS 文本，以及 reporting-capable preset 中四条简短 environment-variable 描述。

#### KV Cache effect

Environment value 永不进入 request prefix。安装后的 AGENTS baseline 按 instruction-loader 约定在每个 session 中 durable 一次。

## Known Limitations and Deferred Work

- `minimal` 会加载 user-global instructions，但运行时明确上报 coverage unavailable：它的 persistent shell 在 per-call `shell-env` registry 之外创建，因此无法向 owner helper 证明 exact current turn。BoAgents mutation 应使用 `standard`、`ptc` 或 `cordis`。
- Source presence 不是 adoption。数据库表、owner helper、profile row、reporter hash、user-global AGENTS projection 与 live coverage readback 属于独立 activation work。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
