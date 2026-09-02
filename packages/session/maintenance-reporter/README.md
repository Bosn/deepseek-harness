---
description: "Top-level DSH maintenance holder lifecycle and coverage reporting for the private BoAgents deployment."
kind: "package-reference"
---

# @deepseek-ai/dsh-maintenance-reporter

English | [中文](README.zh.md)

## Summary

`dsh-maintenance-reporter` connects top-level DSH turns to the owner-only BoAgents maintenance command socket. It contributes exact session/turn/process facts to the managed `DSH_*` shell environment, observes the typed acquire receipt produced by the owner helper, renews that holder every five minutes, releases it on the matching terminal turn, and reports whether every running top-level preset can load instructions and acquire a holder. It has no database credential and is not a mutation permission, mutex, repair executor, or second lease store.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Mount it once on the Host plane beside `agents` and `shell-env`:

```yaml
- name: '@deepseek-ai/dsh-maintenance-reporter'
  config:
    socketPath: /run/user/1000/bocc-ingest.sock
    policyPath: /home/ec2-user/.local/share/boagents-autorepair/policy.json
    reporterHash: sha256:<admitted-release-hash>
    heartbeatMs: 300000
    requestTimeoutMs: 15000
    instructionCoveredPresets: [standard, ptc, cordis, minimal]
    reportingCapablePresets: [standard, ptc, cordis]
```

The model never supplies actor, task, turn, holder, lease, generation, TTL, expiry, policy, or reporter identity. The plugin contributes `DSH_MAINTENANCE_TOP_LEVEL`, `DSH_MAINTENANCE_TURN_ID`, `DSH_MAINTENANCE_RUNTIME_GENERATION`, and `DSH_MAINTENANCE_REPORTER_ID` only to the current shell execution. The source-managed global AGENTS instructions tell a qualifying top-level session when to run the fixed owner helper.

An acquire result reaches the durable `tool/result` log before this plugin adopts its lease. A receipt whose session, turn, actor, protocol, or holder identity differs is ignored or marks coverage unavailable; it never replaces the first exact lease. The database command plane owns one active holder generation per top-level task: an identical retry or a later turn in the same session must replay that generation and can never create a parallel holder. Heartbeat command identity binds the lease generation plus expected holder revision; release additionally binds the terminal reason, while coverage uses a bounded cadence generation. An ambiguous transport response is retried once with the exact same command bytes. Subagents inherit the parent holder and cannot acquire a duplicate.

Terminal release is best effort. Once a turn is terminal the holder is never renewed again, so a transport failure still converges through the fixed DB-time expiry. Plugin teardown stops timers, publishes coverage unavailable when possible, and waits for its command chain; it does not release still-running turns as successful.

## Model Experience

### Managed shell identity

#### What the model sees

The existing shell tool advertises the four managed `DSH_MAINTENANCE_*` environment facts. The values themselves enter only the subprocess environment, not the request prefix. User-global AGENTS instructions contain the fixed acquire command and the positive/negative classification rules.

#### Token effect

The reporter adds only the bounded AGENTS text already owned by the instruction loader and four short environment-variable descriptions in reporting-capable presets.

#### KV Cache effect

Environment values never enter the request prefix. The installed AGENTS baseline is durable once per session under the instruction-loader contract.

## Known Limitations and Deferred Work

- `minimal` loads user-global instructions but deliberately reports coverage unavailable while running: its persistent shell is created outside the per-call `shell-env` registry and therefore cannot prove an exact current turn to the owner helper. Use `standard`, `ptc`, or `cordis` for a BoAgents mutation.
- Source presence is not adoption. The database tables, owner helper, profile row, reporter hash, user-global AGENTS projection, and live coverage readback are separate activation work.
- No invariant companion is published: the authoritative holder and coverage relationships live behind the external typed command transport, so lifecycle, identity, and teardown verification stays in the real-composition test.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
