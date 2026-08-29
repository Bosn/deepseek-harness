# Agent Note: Generation-scoped Client inspect synchronization

Status: implemented

English | [中文](2026-08-29-generation-scoped-client-inspect-sync.zh.md)

## Problem

The Web Client registers its Cordis inspect providers while the first Connection handshake is still in flight. Each registration used to publish the complete manifest immediately through `dynamicCordisRunner/syncInspectManifest`. A mounted Remote namespace proves that the generated proxy exists, not that its carrier has an active Connection, so this startup ordering reached the proxy with no transport and produced `client api: dynamicCordisRunner/syncInspectManifest has no active Connection`. The same race existed during reconnect and page-local plugin remount. Catching the rejected call kept the process alive but left the page startup path without a synchronized Client provider directory and repeatedly surfaced the failure observed with the blank Web page.

## Decision

- `cordis-client-runner` declares the Client Connection package in its package injection metadata and the `connection` service in its plugin injections. The runner subscribes to `ctx.connection.generation` as the readiness authority; its monotone generation id deduplicates observations, while the later `connection/reset` notification remains available to cache consumers without triggering another manifest sync.
- Provider registration before the first handshake changes only the page-local registry and marks its complete manifest dirty. Each ready Connection generation queues one complete baseline snapshot, including when the provider set is unchanged, because the Host mirror belongs to the previous process generation.
- Connection loss invalidates queued continuations and cancels active inspect queries. Query resolution captures its generation and never answers through a later Remote carrier, even when a provider ignores its `AbortSignal`.
- Manifest writes serialize only within one Connection generation. Generation loss and replacement start an independent synchronization queue, so an old carrier promise that never settles cannot block the replacement Connection from receiving its snapshot. A failed current-generation write remains dirty for a later provider change or ready generation rather than entering an unbounded retry loop.
- Page disposal retracts the description listener, invalidates queued work, and cancels active queries before provider effects unwind.

## Alternatives considered

**Treat Remote namespace injection as readiness.** Rejected: injection guarantees assembly of the generated proxy, while Connection activation is a later runtime lifecycle edge.

**Catch the startup error and retry every rejected call.** Rejected: this preserves the invalid pre-handshake call, produces misleading console failures during normal startup, and risks an unbounded retry loop while the carrier is absent.

**Keep one synchronization promise chain across reconnects.** Rejected: a transport promise can remain pending after its generation disappears, which would prevent every later generation from publishing.

**Use only `connection/reset`.** Rejected: the event does not announce generation loss, and a runner mounted after the event needs the current generation snapshot immediately.

## Verification

Registry tests cover pre-handshake registration, the first complete snapshot, unchanged reconnect snapshots, a replacement generation progressing past a hung old-generation write, same-generation serialization, failed-write retention, query cancellation, and disposal. The assembled Client plugin test drives the real plugin apply path through disconnect, reconnect, and disposal. The GUI test suite, package typecheck, client-package verifier, production build, and diff check pass with the lifecycle change. No model transcript snapshot changes because manifest synchronization is browser transport behavior and changes no model-visible text.

## Consequences

Web startup and reconnect publish Client inspect capabilities only through an active Connection. The Host still receives complete replacement snapshots rather than deltas, while stale page work cannot cross a generation boundary. A carrier that never settles may retain its own promise until the transport releases it, but it cannot delay the current generation.

## Supersession audit

No active note is archived, rejected, or deleted. [Cordis Web dynamic packages](../../proposed/architecture/2026-08-08-cordis-web-dynamic-packages.md) continues to own the broader Host/Client runner design; this note owns the Client inspect manifest's Connection lifecycle and partially specializes that proposal without replacing it.
