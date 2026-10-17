# Agent Note: Retire the deployment-declared Host configuration authority

Status: implemented

English | [中文](2026-10-17-retire-declared-host-configuration-authority.zh.md)

## Problem

The [deployment-declared Host configuration authority](2026-08-29-deployment-declared-privileged-browser-authority.md) existed because the browser selected its settings store from connection locality: a non-loopback page kept a process-local mirror, so a deployment had to declare its remote authority as `privilegedHosts` before that page could reach the Host settings document.

dsh-v0.2.1-rc.2 removed store selection from locality. [Every authenticated browser shares the Host settings document](../bug-fix/2026-09-15-authenticated-browser-host-preferences.md): `SettingsDescribeMirror` and `ConfigForms` no longer accept a persistence selector, and a form reports `unavailable` only for a namespace the Host did not register. No supported extension point remains where a locality fact selects the settings store.

## Decision

The fork retires the privilege declaration instead of keeping a fact nothing selects on. `client-connection` no longer reads `privilegedHosts` from its config, no longer injects `__DSH_PRIVILEGED_HOSTS__` into served documents, and no longer derives `ConnectionHandle.canUseHostConfiguration`; API Gateway stops mapping it onto `ctx.remote.$host`. `trustedHosts` remains the single reachability declaration for the Host/Origin fence, and `isLoopback` remains the fixed transport fact that desktop-only behavior reads.

The separate [`browserSessionAuth` opt-out](2026-08-31-browser-session-auth-opt-out.md) is unchanged: it still disables browser-session identity while leaving reachability policy to the fence and the operator's network layer.

## Alternatives considered

- **Keep `canUseHostConfiguration` as a fixed client fact** — rejected: after upstream removed the store selector the fact has no consumer, and a public capability that selects nothing invites the next reader to reintroduce locality-dependent behavior.
- **Re-add a persistence selector to upstream's mirror and forms** — rejected: it reverts an upstream decision in a sync and splits the one settings mirror per browser, which is the split the upstream change removes.
- **Classify a declared remote authority as loopback** — rejected for the same reason as in the [original note](2026-08-29-deployment-declared-privileged-browser-authority.md): `isLoopback` also enables desktop-only UI that a remote page cannot use.

## Consequences

A deployment that declared `privilegedHosts` loses the key and must rely on `trustedHosts` alone; an undeclared key now fails plugin load, so the declaration is removed from the owning profile in the same change. Every authenticated browser reaching one Host shares that Host's settings document, including a trusted remote page, and preference access is governed by Connection authentication and `settings.describe.writable` as upstream documents. The outer fence is unchanged: a remote authority still needs `trustedHosts`, and the browser-session opt-out still bypasses identity rather than reachability.

## Testing

The connection suites pin the remaining fixed facts only: `isLoopback` for a loopback page, a non-loopback page, and a runtime without browser location. Upstream's `ui-settings` mirror and configuration-form suites pin the locality-free behavior, and the keyless `apps/web` remote-settings scenario keeps proving that a trusted remote page persists preferences through the Host.
