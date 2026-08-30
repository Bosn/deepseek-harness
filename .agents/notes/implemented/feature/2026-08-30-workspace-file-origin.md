# Agent Note: authenticated workspace-file origin for remote Web clients

Status: implemented

English | [中文](2026-08-30-workspace-file-origin.zh.md)

## Problem

The Web file affordances delegated every click to `session/openWorkspacePath`, which is correct for a browser on the Host desktop but cannot open a remote EC2 path in a browser on another machine. Publishing a file beside `/api` would give agent-produced HTML the application's authority, while an unauthenticated second listener would turn knowledge of a Session id into a file-read capability.

## Decision

`@deepseek-ai/dsh-client-connection` owns an optional `files` deployment capability. Neither key means no listener, and `files: {}` is also a no-op because the configuration layer can materialize an absent nested object. `files.port` binds a dedicated listener on the Web server host; `files.publicUrl` declares the bare externally published origin and requires a fixed non-zero port plus a hostname already present in the application's trusted or privileged authorities.

The application shell receives only `__DSH_FILES__ = { port, publicUrl? }`. The browser's `ConnectionHandle.fileUrl()` converts a tool-reported absolute or cwd-relative path into `/f/<sessionId>/<segments…>` only when it remains below the Session cwd. The chat surface opens that URL in a new tab when available and otherwise preserves the existing `session.openWorkspacePath` fallback.

The Session Controller owns Session-to-workspace resolution through the `client-connection/workspace-root` waterfall. It uses `inspect()` for attached and persisted Sessions, so a file read does not activate an Agent; unknown Sessions delegate and produce no root.

## Security boundary

The files listener accepts only `GET` and `HEAD` below `/f`, applies the same Host/Origin authority fence as the application, and requires a valid browser-session cookie minted for an allowed application authority on the same hostname. Browser cookies are host-scoped rather than port-scoped, while the signed payload remains bound to the exact application authority, so a sibling files port can verify the established application session without becoming an authentication endpoint of its own.

The handler decodes each URL segment without allowing separators, dot traversal, or NUL bytes, resolves both the Session cwd and target through `realpath`, rejects symlink escape, serves only regular files, and streams the body with explicit inline MIME types, `nosniff`, and `no-store`. Missing, unreadable, and invalid targets share the same 404 response. Served documents have a distinct origin and therefore cannot call the application's `/api` as same-origin content.

## Alternatives considered

- **Serve files on the application origin** — rejected because active agent-produced HTML would inherit the application's `/api` authority.
- **Apply `Content-Security-Policy: sandbox` to same-origin files** — rejected because it breaks the storage and active-script behavior that makes generated HTML useful while retaining needless routing complexity.
- **Expose the second listener without BrowserAuth** — rejected because a Session id is routing identity, not authorization, and can appear in browser history, logs, or copied links.
- **Mint one-time file capability URLs** — rejected for this deployment path because they add expiry, replay, and leak-handling semantics while the application already owns a durable signed browser session that is safely reusable on a same-host sibling port.

## Verification

Focused Host and Client suites cover URL construction and parsing, authentication, authority derivation, config activation semantics, listener lifecycle, traversal and symlink escape, cold and attached Session lookup, browser popup selection, and the native fallback. Per-file coverage for every changed source is 100%.

The Web composition E2E starts the application with an OS-assigned files port, authenticates through the real BrowserAuth flow, clicks an actual produced-file chip, and verifies the popup path, file bytes, distinct origin, response headers, active HTML behavior, blocked application API access, route isolation, and traversal rejection.

## Consequences

Remote deployments that publish the extra port can open produced files directly in the user's browser without granting those documents application authority. Default and desktop deployments do not gain a listener or change their opening behavior. Reverse proxies must publish the configured files port separately, and the public files hostname must match the application hostname so the established browser session reaches it.
