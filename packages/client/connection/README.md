---
description: "Browser-host wire layer for the web GUI: authenticated Remote RPC, reconnecting event delivery, and an optional isolated workspace-file origin."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

## Summary

The package carries browser-to-Host Remote calls, exact Fetch responses, and connection generations. The Client plugin mounts `ctx.connection` with current-page loopback state, a generic RPC carrier, the active generation and its Host facts, and the registration point for one generation source. A generation becomes visible when its source reports ready; source completion, failure, withdrawal, or an explicit stop clears it before `ConnectionController` reconnects with backoff.

The Host injects `privilegedHosts` as `__DSH_PRIVILEGED_HOSTS__`. The Client exposes `ctx.connection.canUseHostConfiguration` for deciding whether the shipped UI should mount Host-backed settings, credentials, model-provider, and related configuration surfaces on a remote page. Loopback pages and transports that own their Host always expose them; a served remote page does so only when its exact authority matches the injected declaration. This is a deployment UI capability, not an API access-control list: each declared authority joins the ordinary Host/Origin trust fence, and every request still requires the same signed browser session as every other Host operation. There is no method-specific loopback tier.

An opt-in `files` block binds a second HTTP listener that serves only `GET`/`HEAD /f/<sessionId>/<path...>`. Its port is a separate browser origin, so an active HTML or SVG artifact keeps its own storage and sibling requests without becoming same-origin with `/api`. Session Controller resolves the cwd without activating a cold Agent; dual `realpath` confinement rejects traversal and symlink escape. With no `files.port` or `files.publicUrl` key, no listener or page global exists and file clicks keep using the Host native opener.

## Table of Contents

- [Use this package](#use-this-package)
- [Browser authentication and request trust](#browser-authentication-and-request-trust)
- [Connection generation](#connection-generation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The browser uses HTTP POST for Remote unary calls. API Gateway owns the `/api/remote.mux` WebSocket and its logical streams; in-process compositions provide equivalent Remote streams through `connection.rpc.open` without opening a WebSocket. The Host half owns the sole `/api` route, Fetch bridge, browser authentication, Host/Origin checks, and exact `GET`/`HEAD` route registry. Typert Gateway claims generated Remote endpoints, feature packages register non-JSON responses such as Session-log downloads, and unclaimed requests return 404. Loopback hostname classification remains package-internal to the browser-facing Client state.

To serve remote workspace files, configure `files.port` and, when a reverse proxy publishes that socket, its bare `files.publicUrl`. A public URL requires a fixed nonzero port and the same hostname as an application authority: the authority-bound application cookie is host-scoped and therefore reaches the sibling port, where the listener validates its signed application audience. The browser builds a file URL only for a path below the Session cwd; outside paths retain the native-opener fallback.

-----

<a id="browser-authentication-and-request-trust"></a>
## Browser authentication and request trust

Every Host RPC method and WebSocket stream requires one browser session; there is no method-specific loopback tier. Each process mints a random launch token. `dsh-web-app` prints and opens the ordinary root URL with `?token=...`; `frontend-static` delegates root and index requests to `ctx.connection.authorizeIndex`, which accepts that token only on `GET /`, writes an authority-bound signed cookie, and redirects to clean `/`. A missing, expired, malformed, or wrong-authority cookie returns 401 before RPC dispatch. Static assets remain public. The HTTP carrier accepts no query token outside the root exchange and no Authorization-header token.

The cookie signing secret is the owner-scoped `client-connection/browser-session` grant record in `ctx.credentials`. The local provider persists it in `$DSH_HOME/.credentials.yaml`; `BrowserAuth` loads or creates the record during Connection activation and retains the secret in memory, so request authentication is synchronous. Deleting or replacing the record takes effect on the next Connection activation. Cookies carry an absolute issue/expiry interval, defaulting to 30 days through `cookieMaxAgeDays`, and bind the normalized hostname plus port in both their deterministic name and signed payload. They are host-only, `Path=/`, `HttpOnly`, and `SameSite=Strict`; they deliberately omit `Secure` because the shipped server uses loopback HTTP.

Before authentication, every request still passes `src/api-request-trust.ts`. Its `Host` must be loopback or match the union of `trustedHosts` and `privilegedHosts`: exact on `host:port`, any port on port-less entries, both sides WHATWG-normalized. An attached `Origin` must equal that Host and `sec-fetch-site: cross-site` is refused. Malformed entries in either configured list fail plugin load. These checks defend DNS rebinding and cross-site browser requests; they never establish identity. A failed Host/Origin check returns 403, while a trusted but unauthenticated request returns 401. After authentication, all Host APIs use the same policy; `privilegedHosts` only opts a matching remote page into the shipped Host-configuration UI and never bypasses or replaces the session. `dsh web --host 0.0.0.0` remains unsupported. Decision records: [browser request trust](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md), [browser token authentication](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md), and [deployment-declared Host configuration UI](../../../.agents/notes/implemented/architecture/2026-08-29-deployment-declared-privileged-browser-authority.md).

The workspace-file listener applies that Host/Origin fence to its own effective authority and then accepts only a valid browser cookie minted for a configured same-host application authority. It exposes neither an index nor `/api`; every non-`/f` path is 404 and every write method is 405. Responses are streamed with `no-store`, `nosniff`, explicit inline media types, and no sandbox header—the distinct origin is the isolation boundary.

<a id="connection-generation"></a>
## Connection generation

API Gateway Client registers the internal `$events` logical stream as the sole generation source, independently of whether any `$on` listener exists. The Host attaches all incremental listeners in the API Remotes source factory, then sends one `{ type: 'ready', clientId, host: { home } }` item before events. `ConnectionController` publishes that generation and calls `onConnected` only after the ready item arrives, so baseline acquisition cannot race ahead of incremental observation.

An ended `$events` stream, a Remote stream error, a non-ready opening item, or a malformed event item invalidates the current generation. The controller immediately withdraws the generation, publishes `reconnecting`, and reopens `$events` after backoff. Gateway mux reconnects the physical WebSocket; Connection generation reopens the logical stream and establishes the next baseline starting point.

<a id="model-experience"></a>
## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The `/api` bridge buffers each request body in memory** — `maxRequestBodyBytes` (default 300 MiB, sized for the default 200 MiB aggregate image limit after base64 expansion plus envelope headroom) is therefore also the per-request resident bound; a streaming body path would be needed to lower it without shrinking the image limits.
- **The browser cookie is not marked `Secure`** — loopback HTTP is the shipped transport, so exposing the same authority over plaintext networking can expose the bearer cookie in transit.
- **There is no logout operation** — clearing the browser cookie ends one browser session; deleting the owner credential record and restarting `dsh` revokes every session.
- **Workspace-file serving consumes a second listener and same-host public authority** — a reverse proxy must publish `files.port` separately, and a different public hostname cannot receive the host-only application cookie.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
