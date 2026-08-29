# Agent Note: deployment-declared Host configuration authority

Status: implemented

English | [中文](2026-08-29-deployment-declared-privileged-browser-authority.zh.md)

## Problem

Every Host operation requires one authenticated browser session, but the browser selected its Host-backed configuration client only from a loopback hostname. An authenticated page served through a trusted remote authority therefore selected its process-local settings mirror and never issued `settings.describe`, even though the same session could call the Host API.

`isLoopback` also controls browser behavior that requires a local desktop. Treating an arbitrary deployment hostname as loopback would enable native-only UI and confuse transport location with the choice to expose Host configuration controls.

## Decision

The connection plugin has a separate `privilegedHosts` deployment declaration. Its entries use the same canonical `host[:port]` rules as `trustedHosts`: an explicit port matches exactly, while a port-less entry matches every port. Loopback may render Host configuration without this declaration. `privilegedHosts` joins `trustedHosts` in the Host and Origin reachability set, so the same authority need not appear in both lists; every request still needs the same browser session, and the declaration adds no method-specific permission.

The Host injects the declarations into the served document as `__DSH_PRIVILEGED_HOSTS__`. The browser derives `ctx.connection.canUseHostConfiguration` from loopback or an exact current-page authority match. Settings selects its Host-backed client from that capability; `isLoopback` remains the source for desktop-only behavior. A malformed or absent injection leaves the remote page on its process-local mirror.

This declaration is neither authentication nor a method-level API access-control list. The process-token exchange and signed browser-session cookie authenticate every Host operation uniformly; Host and Origin checks apply the union of `trustedHosts` and `privilegedHosts` as request-routing policy. The deployment limits each `privilegedHosts` entry to the intended port when possible so only the intended page renders the controls.

## Alternatives considered

- **Let `trustedHosts` select Host configuration** — rejected because it would expose configuration controls in every existing remote deployment. Request reachability and UI exposure remain separate declarations even though both require the same browser session.
- **Classify the remote deployment as loopback in the browser** — rejected because `isLoopback` also enables desktop-only behavior. Transport location and Host configuration capability remain separate facts.
- **Rely on proxy header rewriting** — rejected because it changes only the server's view. The page selects its memory mirror before making a settings request, so proxy rewriting cannot expose the controls.
- **Render Host configuration on every authenticated remote page** — rejected because authentication answers who may use the Host API, not which deployment intends to present configuration controls remotely. The deployment names that page authority explicitly.

## Consequences

An authenticated browser at an explicitly declared remote authority loads and mutates the same settings document as loopback, so Models settings work through that deployment. An undeclared remote page remains process-local and sends no settings request from the configuration UI. After a request passes the combined Host and Origin policy plus browser-session authentication, every Host API method has the same authority regardless of which list admitted the route. Tests pin canonical authority matching, browser capability derivation, both settings client modes, and the assembled authorized and unauthorized remote Models paths.
