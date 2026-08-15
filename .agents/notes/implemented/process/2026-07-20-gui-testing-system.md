# Agent Note: GUI testing system — the three-tier structure

Status: implemented

> Path update (2026-07-22, plugin-system refactor): the three-tier philosophy and golden-path method here remain current; homes moved — object-layer specs now live in `packages/client/runtime/tests/` (was web-runtime), wire specs in `packages/client/connection/tests/`, and the `web-ui` coverage exclusion is gone with the package (component specs are per-plugin jsdom suites under each `packages/client/*/tests/`). Component-spec shape follows the [slot system standard](../architecture/2026-07-22-slot-type-chain-implementation.md): feed props directly — the store share comes from `createXXXStore().create()` (the real engine, the sanctioned zero-machinery path), framework hooks are plain stubs; no render machinery, no provider mounting. Slot ownership/registry semantics are tier-2 territory (`runtime` + `ui-slots` suites), not component specs.

English | [中文](2026-07-20-gui-testing-system.zh.md)

> Division of labor: this note covers only the test structure specific to the GUI (`packages/{client,host}/*` + `apps/web`); repo-wide testing policy (tiering principles, the with-key policy, real-implementation-first, REAL-composition) lives in [docs/testing.md](../../../../docs/testing.md) and is not restated here. Authority to run local browser validation, live-model browser rounds, screenshots, GIF recording, or publication belongs to the [explicit browser and GIF evidence decision](2026-08-15-explicit-browser-gif-evidence.md).

## Problem

The GUI stack spans multiple application shapes, and within one shape multiple runtime environments (the Node host, the data protocol layer, the browser object layer, React/DOM); a single-lane test suite cannot give a meaningful signal. Every link needs effective tests of its own, plus the base capability for full-chain testing.

## Decision

Cut along the architecture's natural test hooks into three tiers, bottom-up:

| Tier | Under test | Key technique | File location |
|---|---|---|---|
| 1 Protocol isomorphism | `AbstractApiClient` + `toFetchHandler` (bidirectional data / rpcId / zod types / SSE streams / batching / timeouts) | **The full chain at the isomorphic point**: `InProcessApiClient(toFetchHandler(脚本化 impl))` skips the network but genuinely runs the wire serialization — zero browser, pure node env | `packages/host/apiproxy/tests/client-handler.spec.ts` |
| 2 Object-layer orchestration | `Session`/`SessionManager`/`ConnectionController` (state machines and timing: stitching / dedup / paging / optimistic draft clearing / pendingBuffers / reconnect / backoff) | **The "event sequence in → snapshot out" golden path**: programmable fakes + deferreds controlling timing + fake timers controlling backoff | `packages/client/{runtime,connection}/tests/` |
| 3 Assembled presentation | Built artifacts × the real client loader and plugin composition | App-owned semantic snapshots boot all eight built client plugins under jsdom for deterministic cross-plugin state changes; bare Playwright smoke separately proves the real browser/carrier boundary, with its real-host case self-skipping without a key; the keyless browser e2e lane disables the shipped model-adapter row and replays recorded session fixtures through `dsh-llm-replay` in the real in-process web assembly against conversation aria goldens ([web e2e lane](../testing/2026-07-24-web-gui-browser-e2e-lane.md), [required CI gate](../testing/2026-07-30-web-browser-snapshot-ci-gate.md)) | `apps/web/tests/*.snapshot.ts`, `apps/web/tests/smoke-{fixture,real}.e2e.ts`, `apps/web/tests/{replay-round-trip,seeded-history}.e2e.ts` |

Inter-tier discipline: **each tier tests its own layer, upper tiers never re-test lower ones** — an app semantic snapshot pins only user-visible projection across the assembled plugin boundary, while Playwright smoke proves browser and carrier liveness; wire semantics belong to tier 1 and data semantics to tier 2. Pure-function layers (lineage/partial/notifier/transcript-adapter) are tested directly with zero fakes in the same package's tests/ alongside tier 2.

- **Host and client source** are under the repo-wide per-file 100% coverage gate except the narrow browser-grade exclusions annotated in `vitest.config.ts`; component suites use per-file jsdom pragmas and Testing Library without changing Node suites.
- **App-owned semantic snapshots** read built client bundles, execute them through the real loader, and drive only deterministic fixture hooks. They own stable visible state such as sidebar labels, breadcrumbs, and `document.title`, not CSS pixels or lower-layer state-machine details.

## Lane map

| Scenario | Command | Content | When to run |
|---|---|---|---|
| Baseline | `pnpm run test:gui` | Tier 1+2 vitest (`packages/client packages/host`), seconds-fast, no browser, no server | Default local evidence after touching GUI source; narrow further to the affected packages or tests |
| Semantic snapshot | `DSH_EXAMPLE_MODE=lib pnpm run test:snapshot` | Keyless assembled-application semantics plus the repo's transport-specific expected outputs | When the changed contract is owned by this snapshot; visibility alone is insufficient |
| Browser end-to-end | `pnpm run test:web` | Rebuilds the front-end dist first, then runs the tier-3 browser set: fixture smoke, a real-host case that self-skips without a key, and keyless replayed e2e scenarios; `DSH_SNAPSHOT=record`/`refresh` remain explicit fixture/golden maintenance modes | Only when the user explicitly requests browser acceptance; live-model execution requires separate user authorization, and GUI visibility alone is insufficient |
| Browser expected-output gate | `DSH_SNAPSHOT=replay pnpm run test:web:built` | Reuses CI-built artifacts and compares every committed browser golden without writing | Every Linux pull request |
| Gate | `pnpm run test:coverage` | The repo-wide gate (host and client GUI packages included, except annotated browser-grade exclusions) | The PR window |

**Division of labor between the browser scripts and vitest**: Playwright owns browser/carrier black-box regression and long sequential user journeys; ordinary vitest owns data-layer semantics such as reference stability, timing, and wire shapes; snapshot vitest owns stable app-level semantic output through the built composition. These lanes complement each other rather than duplicating assertions.

## Anti-regression discipline

- **Every bug fix pins an assertion in the narrowest owning tier**: use a browser spec only when browser or carrier behavior owns the regression; browser visibility alone does not move an assertion out of its data, protocol, or component owner.
- **Full carriage remains required without becoming the default local loop**: the Linux PR gate runs the complete keyless HTTP/SSE browser replay. Local changes to connection, bridge, handler, or SSE code use focused owner tests by default; run browser validation only when the user explicitly requests browser acceptance. Authorizing browser validation does not by itself authorize the live-model real-host smoke.
- The code-on-disk-is-the-answer reconciliation workflow: when a behavior change lands and turns existing cases red, reconcile on the spot (fix the test or fix the code, with the RFC/contract as arbiter); no red left hanging.

## Consequences

Each lane tests its own tier: local work defaults to focused `test:gui` or owner tests, wire/object-layer semantics assert in milliseconds in Node, and built-composition snapshots pin deterministic user-visible projection when they own the changed contract. Linux CI mechanically enforces browser wiring, carriage acceptance, and golden freshness; local browser and live-model evidence remain separately authorized. Every new app snapshot must avoid unstable layout or clock output.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Single e2e (everything through the browser) | Browser startup is seconds × N slower and timing is uncontrollable; wire/object-layer invariants can be fully asserted in milliseconds in node env |
| Migrating the verify scripts to vitest | An ordered script shares one browser session; splitting the cases either formalizes it (sequential + shared page) or re-runs the preamble × N; streaming PASS/FAIL output is exactly the agent's locating interface |
| Reusing FixtureApiClient in tests | The demo script runs on a real clock, tests need deferred hand-controlled timing — orthogonal purposes; forced reuse chains the tests to the demo's rhythm |
| A standalone vitest config for GUI packages (once designed as vitest.gui.config.ts) | Package-level tests/ are already scanned by the root include; `vitest run packages/client packages/host` path filtering is the tight loop — zero new config |
| Deferring hooks/component-layer unit tests | jsdom remains the coverage mainline because it gives fast per-file component behavior; the required browser replay gate complements it at the assembled tier rather than replacing it ([CI gate decision](../testing/2026-07-30-web-browser-snapshot-ci-gate.md)) |
