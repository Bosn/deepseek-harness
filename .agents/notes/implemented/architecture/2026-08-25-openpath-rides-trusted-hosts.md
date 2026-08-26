# Agent Note: host.openPath rides the trusted-hosts fence instead of the loopback pin

Status: implemented

English | [中文](2026-08-25-openpath-rides-trusted-hosts.zh.md)

## Problem

`host.openPath` was pinned to loopback in `dsh-client-connection`'s privileged method set ([tool-call file open in OS](../feature/2026-07-28-tool-call-file-open-in-os.md)): even a deployment that declared `trustedHosts` authorities — and served every other `/api` method to them — refused the desktop opener with 403 for anything but a loopback, same-origin browser. An operator who deliberately serves dsh web to a private network they own (a Tailscale tailnet, declared as a `trustedHosts` entry for its MagicDNS name) then cannot open produced files from that browser: clicking a tool-row path fails with "transport failure for /api/host.openPath: HTTP 403" while every other page interaction works.

## Decision

`host.openPath` leaves the loopback-pinned privileged set and rides the ordinary `/api` browser-trust fence: a request whose `Host` is loopback or matches a declared `trustedHosts` authority reaches the opener, and an undeclared (external) authority is refused 403 exactly like every other method. The deployment's reachability binding is unchanged and stays the outer limit — this grants nothing to a network the operator did not already declare.

The rest of the privileged set is untouched: `host.pickDirectory` (an OS dialog on the host screen), the whole settings/credentials configuration plane, `llm.discoverModels`, and the agent-preset authoring plane stay loopback-same-origin until a real authentication layer exists. Granting a declared authority the desktop opener is the operator's deliberate choice: the same authority already creates sessions whose agents run `bash` as this process, and the [config-plane decision](2026-07-30-config-plane-boundaries.md) records why `trustedHosts` is a DNS-rebinding fence, not an authentication layer — declaring an authority for it already grants that authority more than a file open.

## Testing

`packages/client/connection/tests/node-half.host.spec.ts` pins the boundary over a hand-assembled route and a real HTTP server: a declared authority reaches `host.openPath` (the bridge runs, asserted as the empty proxy's 404), an undeclared authority gets 403 before the bridge, and every remaining privileged method still 403s for the same declared authority. `apps/cli/tests/web-openpath.spec.ts` additionally boots the shipped Web surface (both bundle patches through the Loader, webserver bound to an ephemeral port) and sends the declared-authority request through the assembled proxy: the platform opener's own answer comes back — its rejection for a missing path is the opener's text, not the fence's — while an undeclared authority gets 403.

## Alternatives considered

- **Tailscale-address recognition in the fence** — accept Hosts in `100.64.0.0/10` (or a Tailscale ULA prefix) for this method only: rejected. The fence is header-only by design ([api browser-trust boundary](2026-07-28-api-browser-trust-boundary.md)), browsers reach the host by its MagicDNS name rather than an IP literal, and baking one VPN vendor's address space into the connection plugin makes reachability policy package-internal state the fence deliberately avoids.
- **A per-method config key** (`openPathTrustedHosts` or similar): rejected as machinery with no present consumer — the deployment's existing `trustedHosts` grant is exactly the set the operator wants to authorize for the opener, and a second overlapping list would be a second source of truth for the same boundary.
- **A loopback socket-address check instead of the header fence**: rejected — it reintroduces the socket check the [api browser-trust boundary](2026-07-28-api-browser-trust-boundary.md) dropped, and a socket address cannot express a named authority at all.

## Consequences

- A Tailscale (or any operator-declared) authority can open produced files on the host desktop; external, undeclared Hosts stay refused by the same fence that already protected them.
- `host.describe.canOpenPath` is unchanged: it still advertises whether the handoff can reach a user-visible desktop, not who may call it.
- No client change: the tool-row open action was never gated client-side, and its failure dialog ([tool-row file open failure](../bug-fix/2026-08-18-tool-row-file-open-failure.md)) already surfaces a Host refusal with a retry.
- `host.pickDirectory` and the configuration plane keep their loopback pin; the [web config plane](2026-07-30-web-config-plane.md) and [tool-call file open](../feature/2026-07-28-tool-call-file-open-in-os.md) notes now cite this note for the `host.openPath` exception.
