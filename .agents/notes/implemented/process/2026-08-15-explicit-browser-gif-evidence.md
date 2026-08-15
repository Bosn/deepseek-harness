# Agent Note: Browser demonstrations require explicit requests

Status: implemented

English | [中文](2026-08-15-explicit-browser-gif-evidence.zh.md)

## Problem

Treating every product-visible GUI change or pull request as a request for a browser demonstration forced agents to build and start a real Web service, spend live-model credentials, operate a browser, capture media, and mutate a remote assets branch even when focused tests already covered the change. Credential availability also became an accidental trigger for live-provider work. That delivery cost is disproportionate for quick fixes and personal forks, and pull-request creation does not itself authorize those local or remote actions.

## Decision

An explicit user request to show an effect, perform browser acceptance, take screenshots, record a GIF or video, or provide a UI demo is the only trigger for starting a real Web service for demonstration, controlling a browser, capturing media, or invoking [`record-browser-gif`](../../../skills/record-browser-gif/SKILL.md). Product-user-visible behavior, Web/UI scope, and pull-request creation or update are insufficient triggers. Skill metadata disables implicit invocation so this rule is mechanically visible to supported agents.

Default delivery uses the smallest implementation and the narrowest evidence owned by the changed contract: focused tests, necessary typecheck or lint, and a snapshot only when an expected-output suite owns that output. A requested quick fix or personal-fork change prioritizes this minimal validation, commit, and pull request over upstream-style demonstration work.

Live-provider e2e is separate from browser evidence. Run it only when a provider/API compatibility change genuinely needs live verification, credentials are available, and the user authorizes the call. A live API run never authorizes starting the Web UI, browser acceptance, screenshots, recording, or publication.

Create or update a media-only assets branch only when the user explicitly asks to attach GIF, screenshot, or video evidence to a pull request. Once recording or publication is explicitly requested, the [browser GIF evidence-chain decision](2026-08-08-browser-gif-evidence-chain.md) continues to govern source integrity, provenance, verification, and media-only publication.

This decision supersedes the automatic local-delivery timing in the [GUI testing system](2026-07-20-gui-testing-system.md). It leaves the lane ownership and keyless CI browser replay gate intact; CI policy does not become a default local browser run.

## Alternatives considered

**Require a real-model GIF for every GUI pull request.** This gives reviewers visual evidence by default but spends credentials, creates remote state, and delays changes whose regression is already owned by focused deterministic tests.

**Treat available credentials as authorization.** Environment state says a call is possible, not that the user approved cost, data transfer, or an external side effect.

**Run local browser replay for every visible change.** The CI replay gate already covers repository-wide browser carriage. Local browser work is justified only by an explicit user request for browser acceptance, not visibility or diagnosis alone.

**Publish every locally recorded artifact.** Recording and remote publication have different side effects. A local demonstration request does not imply an assets branch or pull-request-body mutation.

## Consequences

Personal-fork and rapid-fix delivery remains proportional to the code change. Reviewers receive browser or media evidence only when requested, while CI retains deterministic browser coverage. Agents must distinguish test ownership, live-provider authorization, browser demonstration, and media publication instead of escalating from one to the next automatically. Explicit demonstration requests still incur the existing evidence-chain cost because the resulting artifact must support the claim it presents.
