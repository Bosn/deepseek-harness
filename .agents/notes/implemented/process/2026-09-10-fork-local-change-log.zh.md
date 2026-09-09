# Agent Note: 带 PR 链接的 fork 本地改动记录

Status: implemented

[English](2026-09-10-fork-local-change-log.md) | 中文

## 问题

本 fork 既合入上游发布,也承载 fork 本地自定义改动,但没有任何信息告诉后来的 agent:哪些磁盘上的行为来自上游、哪些是自定义的,以及某个改动由哪个 PR 发布。同步策略保持上游代码权威,但自定义修复(例如 PR #26 的 released-v0 失败记录放行)若不逐个阅读每次 merge,就无法与上游历史区分。"验收的改动 → PR"这一约定也没有供 agent 查阅的持久记录。

## 决策

仓库根目录的 `FORK-CHANGES.md` 记录 2026-09-10 起每个已验收的 fork 本地自定义改动 —— 日期、PR 链接、范围、一行摘要 —— 在改动自己的分支上、其 PR 合并前追加。规则位于 [AGENTS.md](../../../../AGENTS.md#fork-local-change-log):自定义改动通过验收(所有者确认、检查通过)后,agent 在尚无 PR 时自动向 `Bosn/deepseek-harness:master` 提交 PR,并用真实 PR 链接追加记录行;记录行只增不改。上游同步合并(`chore: merge upstream <ref>`)明确不记录,上游代码仍保持权威。2026-09-10 之前的历史有意不回溯补记。

## 考虑过的替代方案

**传统 `CHANGELOG.md`。** 面向发布的变更日志会把上游发布与 fork 差异混在一起,并在每次同步时引发上游合并冲突;fork 的同步策略本就原样合入上游发布说明。

**把记录放进 `.agents/notes/`。** Agent Note 是带格式门与双语对的决策记录,不是适合追加的运行清单;改动记录是台账,不是决策。

**放到 `docs/` 页面。** docs 树带有元数据、双语与预算门,更适配现状陈述类文档,而非由 agent 机械追加的日志;根级单语文件(`BENCHMARK.md`、`SAFETY.md`)是既有模式。

## 后果

Agent 现在可以从 AGENTS.md 链接的单一只增文件回答"本 fork 在上游之外改了什么、对应哪个 PR"。记录随改动自己的 PR 一起到达,台账不会滞后于分支;代价是每个已验收自定义改动一行表格记录,以及 PR 编号在提交后才可知时的一次补提交。