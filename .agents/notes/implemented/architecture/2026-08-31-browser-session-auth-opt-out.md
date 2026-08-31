# Agent Note: Deployment browser-session authentication opt-out

Status: implemented

English | [中文](2026-08-31-browser-session-auth-opt-out.zh.md)

## Problem

The [browser launch-token authentication](2026-08-24-browser-token-authentication.md) model wants every browser to hold a signed session even when the deployment's network layer already decides who can reach the socket. An operator serving behind an overlay network or an authenticating reverse proxy still has to consume the printed `?token=...` URL on every new browser and after every process restart, and must treat that startup line as a credential. The session layer cannot see the network's admission decision, yet no supported configuration could turn it off, so such operators patched the harness or avoided the Web surface.

## Decision

`dsh-client-connection` gains the validated `browserSessionAuth` config, default `true`. When a deployment sets it to `false`, Connection activation selects `BrowserAuth.bypass()` instead of creating the signing-secret authenticator: every entry point — `authorizeIndex`, `isAuthenticated`, `isAuthenticatedFor`, and `authenticatedUrl` — accepts unconditionally or prints a clean URL, while the launch-token exchange and signed-cookie logic stay untouched for default deployments. `dsh-web-app` then prints the ordinary root URL without `?token=...`, and index, `/api`, and workspace-file requests serve after the existing checks only.

The opt-out disables identity, never reachability policy. The [Host/Origin trust fence](2026-07-28-api-browser-trust-boundary.md) still applies to every `/api` and workspace-file request, `--host 0.0.0.0` remains rejected by the shipped CLI, and `privilegedHosts` still only gates Host-configuration UI. Containment falls to the operator's network layer (bind, proxy authentication, or overlay-network membership) plus the fence.

## Verification

The `BrowserAuth` unit suite pins the bypass mode: index and request checks accept, sibling-authority checks accept, and the printed URL carries no token. The real-CLI e2e writes `$DSH_HOME/cordis.patch.yml` setting `browserSessionAuth: false`, boots `dsh web`, and proves a session-free request serves the index and dispatches `settings/describe`.

## Alternatives considered

**Flip the shipped default to `false`.** That removes the token exchange for every deployment, including the single-user loopback desktop the session layer protects from same-machine or LAN passerby requests, and rewrites the entire default-behavior test surface. A config with an authenticating default keeps the product posture unchanged and confines the change to activation plus entry points.

**Reuse `trustedHosts` to skip authentication for listed authorities.** A reachability list would become an identity grant: any caller able to send the listed `Host` would authenticate itself, which is the confused-deputy path the fence exists to close. Keeping the two layers separate leaves the fence auditable.

**Accept a fixed token from configuration or environment.** A durable token is a second long-lived bearer credential with a new rotation story. Bypass asks the network layer to own admission instead of minting a weaker credential the process would still have to protect.

**Add forwarding-header trust for authenticating proxies.** No shipped consumer parses forwarding headers, and honoring them without a proxy contract would let any direct caller claim proxy-granted identity.

## Consequences

A deployment with `browserSessionAuth: false` gates the complete tool-capable Host API only on the network layer and the trust fence; a misconfigured exposure grants remote code execution to whoever can reach the port. The field name, JSDoc, and connection README state that trade-off rather than hiding the switch.

Default deployments retain the unchanged token-and-cookie behavior, so this is an entry-point seam future authentication work merges beside. The startup URL in bypass mode contains no credential, but operators lose the printed login line and must deploy network-level admission control before switching the layer off.

The [token-authentication note](2026-08-24-browser-token-authentication.md) and the [trust note](2026-07-28-api-browser-trust-boundary.md) remain active authority for the default mode and the fence; no active Agent Note is archived because the change is additive, not supersession.