# Agent Note: Private WeChat job completion notices

Status: implemented

English | [中文](2026-08-28-private-wechat-job-completion-notices.zh.md)

## Problem

DSH reports background-job completion inside the owning agent through `dsh-tool-jobs`, but a human who is not watching that session receives no private completion signal. Mounting another listener inside each agent preset would multiply delivery as presets evolve, and forwarding labels or output would move command material into a channel payload without a need.

The requested first step is awareness only. DSH does not need control, delegation, shared memory, or a handoff protocol with another agent.

## Decision

`@deepseek-ai/dsh-job-notify-wechat` is an opt-in host-level function plugin. One unscoped `ctx.jobs.onJobDone` listener observes the process-wide registry and invokes the configured OpenClaw wrapper once for each terminal snapshot.

The message is fixed to job id, kind, and terminal status. It excludes producer label, output, detail, owner id, and session id. The owner id remains only in a SHA-256 idempotency input alongside job identity and timing, so restart-local job-id reuse does not collapse unrelated notices.

The plugin reads account and target from a deployment-owned constants file at load. It spawns without a shell and passes an allowlisted environment, validates the OpenClaw CLI `action=send` JSON contract or an explicit sent result with a message id, and turns delivery failures into payload-free warnings. Disposal removes the listener before aborting and awaiting in-flight channel subprocesses.

The package stays out of shipped bundles. A deployment opts in through its host profile, which preserves the upstream default and prevents agent presets from owning process-level delivery.

## Alternatives considered

**Mounting the listener in `tool-jobs` or every preset** was rejected because the in-session controller has owner-relative first-wins reporting semantics, while the private owner notification is process-wide. Preset mounts would also make duplicate external attempts a composition concern.

**Adding an inter-agent handoff or control API** was rejected because completion awareness needs neither another authority nor a new protocol. The notification grants no mutation or continuation capability.

**Adding a durable package-owned outbox** was deferred because the current deployment needs a simple local signal and OpenClaw already accepts a stable idempotency key. The remaining process-exit gap is explicit rather than hidden behind a second persistence system.

**Forwarding the producer label or final output** was rejected because labels may contain commands and reusable credentials. Job identity and terminal status are enough for the requested awareness signal.

## Consequences

- One configured host mount observes owned and unowned terminal jobs across the process.
- One external subprocess runs per terminal snapshot; sender failure does not alter the committed job outcome.
- The notification cannot be used to control DSH or another agent, and it creates no session event or model-visible input.
- A process exit before the receipt can lose a notification because this package owns no durable outbox. The stable idempotency key prevents duplicate delivery only when an attempt reaches OpenClaw more than once.
- Real Loader composition coverage pins the host mount, bounded payload, route arguments, receipt validation, stable key form, and fail-open settlement behavior.
