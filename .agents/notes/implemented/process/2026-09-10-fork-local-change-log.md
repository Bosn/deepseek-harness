# Agent Note: Fork-local changes log with PR links

Status: implemented

English | [中文](2026-09-10-fork-local-change-log.zh.md)

## Problem

This fork merges upstream releases and also carries fork-local custom changes, but nothing told a later agent which on-disk behavior is upstream and which is custom, or which PR shipped a given change. The sync policy keeps upstream code authoritative, yet a custom fix (for example the released-v0 failure admission in PR #26) is indistinguishable from upstream history without reading every merge. The "accepted change → PR" convention also had no durable record for agents to consult.

## Decision

`FORK-CHANGES.md` at the repository root logs every accepted fork-local custom change from 2026-09-10 on — date, PR link, scope, and one-line summary — appended in the change's own branch before its PR merges. The rule lives in [AGENTS.md](../../../../AGENTS.md#fork-local-change-log): after a custom change passes acceptance (owner approval, checks green), the agent automatically submits its PR to `Bosn/deepseek-harness:master` when one does not exist yet and appends the row with the real PR URL; rows are append-only. Upstream sync merges (`chore: merge upstream <ref>`) are explicitly not entries, and upstream code stays authoritative. The log starts empty of history before 2026-09-10 by design; earlier fork work is not backfilled.

## Alternatives considered

**One conventional `CHANGELOG.md`.** Release-oriented changelogs conflate upstream releases with fork deltas and invite upstream merge conflicts on every sync; the fork's sync policy merges upstream release notes as-is.

**Log entries inside `.agents/notes/`.** Agent Notes are decision records with format gates and bilingual pairs, not an append-friendly running inventory; a change log is a ledger, not a decision.

**A `docs/` page.** The docs tree carries metadata, bilingual, and budget gates better suited to current-state prose than to a machine-appended log; root-level single-language files (`BENCHMARK.md`, `SAFETY.md`) are the established pattern.

## Consequences

Agents can now answer "what did this fork change beyond upstream, and which PR" from one append-only file linked from AGENTS.md. The entry arrives with the change's own PR, so the log never lags the branch; the cost is one table row per accepted custom change and a follow-up commit when the PR number is only known after creation.