# Testing policy

English | [中文](testing.zh.md)

How this repo tests, tier by tier, and the rules that keep a green suite meaningful. Commands live in root [AGENTS.md](../AGENTS.md); linked Agent Notes carry the rationale.

## Tiers

- **Unit** (`pnpm run test`): vitest over package and example specs under their `tests/**` directories plus repository script specs under `scripts/**/*.spec.ts`; tests stay with the code area they exercise. Every registry gets an HMR-safety test (dispose the contributing fiber, assert cleanup). Prefer edge cases, error paths, event ordering, concurrency races, and permanent tests for contract regressions (see `packages/core/agent-loop/tests/contract-regressions.spec.ts`).
- **Coverage gate** (`pnpm run test:coverage`): the gating run, per-file 100% on `packages/*/*/src`. An uncovered line is often dead code the gate is correctly flagging for deletion, not a missing test to bolt on. Line coverage is necessary, never sufficient — it proves lines ran, not that the feature works as shipped. Per-file 100% on `packages/shell/pwsh-local/src` needs a real `pwsh`: without one its executor suites self-skip and `vitest.config.ts` exempts the file so pwsh-less hosts stay green, while CI runners ship pwsh and enforce the full bar.
- **Real-API e2e** (`pnpm run test:e2e`): with-key tests against live provider APIs — the DeepSeek model plus provider-specific smokes that gate on their own keys (`EXA_API_KEY`, `PERPLEXITY_API_KEY`, …); each suite self-skips without its key so keyless CI stays green ([real-API e2e Agent Note](../.agents/notes/implemented/testing/2026-06-19-real-api-e2e-ci.md)).
- **Snapshot** (`pnpm run test:snapshot`): keyless expected outputs cover external behavior — transport contracts and presentation, while persisted logs pin assembled backend behavior. ACP boots the real automation-server example, replays a recorded session, and diffs normalized JSON-RPC plus the re-persisted log ([ACP snapshot Agent Note](../.agents/notes/implemented/testing/2026-06-19-acp-snapshot-tests.md)); headless backend scenarios boot their explicit example composition through an unexported JSONL test driver, while `apps/cli` separately owns product `dsh --profile headless` acceptance. When an owning snapshot needs a new live-model transcript, run `pnpm run test:snapshot:record` only with available credentials and explicit user authorization; use `pnpm run test:snapshot:refresh` when existing replay input remains valid. Review every JSONL and expected-output diff. One ACP scenario (`text-turn`) pins full system-prompt/tool-schema content; other fixtures tokenize it so an edit churns one line ([pinned-header Agent Note](../.agents/notes/archived/testing/2026-07-06-pin-request-header-content-in-one-scenario.md)).
- **Web browser snapshot** (`pnpm run test:web`; required Linux PR gate): Chromium compares replayed browser output with `apps/web/tests/snapshots/`. CI forces read-only `DSH_SNAPSHOT=replay`, never writing expected outputs; record/refresh stay local and every diff is reviewed ([web e2e lane](../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md), [CI gate decision](../.agents/notes/implemented/testing/2026-07-30-web-browser-snapshot-ci-gate.md)). This is not a default local delivery step; run it locally only when the user explicitly requests browser acceptance. `test:web` [builds first](../.agents/notes/implemented/bug-fix/2026-07-28-themed-scrollbars-and-reserved-gutter.md) for plugin CSS.

Committed session-format JSONL uses the canonical packed-row layout, and the keyless snapshot gate discovers every such fixture by its `session` header; the [temporary migrator](../scripts/migrate-packed-session-fixtures.ts) rewrites older fixture layouts.

## With-key policy: targeted provider evidence

For agent-run local delivery, use live-provider evidence only when a provider/API compatibility change cannot be established credibly with deterministic tests. Select the narrow relevant e2e only when credentials are available and the user authorizes the call; credential presence is capability, not permission. A live API run does not imply starting the Web UI, performing browser acceptance, or capturing media. Existing with-key smokes still cover real model behavior and self-skip without their provider key ([examples/AGENTS.md](../examples/AGENTS.md)).

## Prefer the real implementation over a mock

Mock only the expensive or non-deterministic boundary (LLM adapter, network, clock); keep everything downstream real. A hand-rolled stand-in proves the bridge moves bytes, not that the shipping tool behaves as asserted. Bridge tool-call tests use the scripted mock model with the real tool and executor: `makeBridgeHarness({ withBash: true })` plugs in `dsh-bash-local` and `dsh-tool-bash`, then runs `echo`.

Recovery tests separate pre/post-chunk failures by step and prove failed chunks derive no message or tool side effect. Cover exhaustion, cancellation, policy composition, persistence, status, wire counts, transport-closing idle timeouts, and shipping Loader composition.

## Verify the world, not the self-report

An e2e assertion re-runs the command or re-reads the file externally; a keyword probe on the agent's own output lets a cheating agent pass. Assert untouched files are byte-identical. e2e tests own their resources: create the harness in the test, dispose in `afterEach` (even on failure/retry/timeout); shared fixtures live in a plain `tests/harness.ts`, never another `*.e2e.ts` (importing a spec re-registers its `describe` and duplicates real API calls).

## Test the real entry path

- Product-visible plugins require a non-unit REAL-composition test. Hand-built `ctx.plugin(...)` suites are insufficient: boot test-only `cordis.yml` through Loader and app/process, mock only external services or nondeterministic inputs, and assert model-visible request/log, durable state, or user-visible output. Keep opt-ins out of shipped defaults.
- A guard only guards if the regression actually fails it. For a plugin without `inject` (bundle/composition plugins), a Loader smoke stays green when a default export replaces the required named exports — add an explicit `expect('default' in mod).toBe(false)` plus an `unwrapExports` round-trip assertion, and prove it: introduce the regression, watch red, revert.
- "Real entry path" means the published artifact: a package `bin` runs built `lib/bin.js` under plain `node`, exposing failures tsx masks (settle races, module resolution, swallowed load failures). The same applies to non-index runtime entries (the worker-thread sibling `lib/worker.cjs`) and singleton modules shared across bundles (`packages/sdk/server/tests/built-scope-carrier.e2e.ts`). Keep the built-artifact smokes green (`packages/examples/*/tests/built-bin.e2e.ts`, `packages/code-runtime/code-runtime-worker-thread/tests/built-lib.e2e.ts`), and assert a genuinely-missing config exits non-zero.

## Test resolution: source plane only

- Every vitest config points vite-tsconfig-paths at `tsconfig.base.json`; bare workspace imports resolve to `src` ([layout](development.md#typescript-project-layout)), never through package `exports` to built `lib/` — stale artifacts there load a second copy of module singletons. Built artifacts are consumed only explicitly: `lib`-mode subprocesses and the built smokes below.

## Test subprocess launch modes

- CI and build-having test lanes run every example or Cordis-config subprocess from built `lib/` through the shared dual-mode launcher. Do not hand-write `--import tsx` for these subprocesses.
- Protocol and operating-system fixtures that do not load Cordis run erasable `.ts` directly with Node, without tsx or the root paths map.
- Only a test whose subject is source-path resolution may select `src`; state that contract in the test.

## When a snapshot test is required

A snapshot is required when the changed contract is owned by an expected-output suite, such as a model transcript, protocol transcript, persisted assembled behavior, or stable application presentation. Model-, protocol-, human-, or browser-visible scope alone is not a trigger; a focused unit or composition test may own the regression instead. ACP automation scenarios use `examples/<name>/tests/snapshots/`, a scenario table over the [`dsh-acp-snapshot`](../packages/test-support/acp-snapshot/README.md) suite factory (`examples/acp-agent` is primary); `examples/headless-agent` owns canonical-event JSONL snapshots and replay fixtures. Completed terminal journeys use `apps/cli/tests/snapshots/`; browser-rendered journeys use `apps/web/tests/snapshots/`. Add or update only the owning scenario, and verify that the harness can express a new transcript surface before relying on it.
