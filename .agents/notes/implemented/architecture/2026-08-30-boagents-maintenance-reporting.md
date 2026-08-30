# Agent Note: top-level BoAgents maintenance reporting

Status: implemented

English | [中文](2026-08-30-boagents-maintenance-reporting.zh.md)

## Problem

DSH can run several independent top-level sessions, while Priapus automatic repair must not interpret an engineering task's transient service or scheduler failures as unattended faults. A process-wide boolean loses the owner of each task, concurrent release ordering, exact terminal identity, and crash expiry. Treating every active session as maintenance instead blocks unrelated analysis and ordinary work.

The maintenance authority lives in TiDB behind an owner-only typed command socket. DSH needs to contribute exact session and turn identity without giving a model database credentials or writable identity fields, and a reporter crash must stop renewal instead of leaving an immortal maintenance state.

## Decision

`dsh-maintenance-reporter` is one optional Host-plane lifecycle adapter. It contributes the current top-level session, turn, process generation, and reporter identity to the existing managed `DSH_*` environment. The source-managed user-global AGENTS instructions tell a model which BoAgents mutations require the fixed owner helper. The helper derives the actor from those managed values and returns one typed acquire receipt in normal tool output; the reporter adopts a lease only after that exact receipt is durable in the matching session and turn.

The reporter stores no authoritative lease database. It holds only process-local handles derived from accepted DB receipts, renews active top-level holders at the fixed cadence, and releases them on the matching `turn/end`. A terminal holder is never renewed after a release failure, so the DB-time expiry remains the fallback. Subagent sessions cannot acquire: they inherit the parent holder. Teardown stops timers, withdraws coverage when transport permits, waits for the command chain, and leaves still-running task holders to expire rather than inventing a terminal result.

Coverage is independent of holder count. It is current only when every running top-level preset both loads the user-global instructions and can expose exact per-turn managed identity. `standard`, `ptc`, and `cordis` meet both conditions. `minimal` loads the instructions but its persistent shell is not a per-call `shell-env` consumer, so an active minimal session reports coverage unavailable and must move a BoAgents mutation to a reporting-capable preset.

The Codex owner helper and watcher use the same typed command/result protocols. Both runtimes therefore report one top-level holder, five-minute renewal, exact terminal release, and coverage without adding an active-task proxy or another repair executor.

## Alternatives considered

- **One process-wide maintenance flag or counter** — rejected because it cannot identify concurrent holders, release only the final task, reject another task's update, or expire a crashed owner safely.
- **Treat every active DSH session as maintenance** — rejected because read-only and unrelated sessions must not suppress automatic repair.
- **Let the model submit session, turn, generation, TTL, or expiry** — rejected because those are runtime and DB facts, not model arguments.
- **Persist a local lease registry beside TiDB** — rejected because it would create a second authority. Local handles are derived caches and stop renewing on reporter failure.
- **Claim minimal coverage from its process-level session id** — rejected because a persistent shell cannot prove which current turn issued a command.

## Consequences

An admitted top-level DSH mutation can publish one holder without direct DB access. Several sessions coexist as independent generations, a terminal or disposed session stops renewal, and a reporter crash converges to coverage unavailable plus fixed holder expiry. Unrelated sessions remain unrepresented when their task does not meet the AGENTS classification.

Source tests pin exact actor/turn binding, duplicate-receipt rejection, generation/revision heartbeat, terminal release, failed-release expiry, subagent inheritance, minimal-preset coverage, and the typed command fields. Live instruction installation, profile composition, database adoption, reporter hashes, and service readback remain separate activation work.
