# Fork-local change log

Records every fork-local custom change made in this `Bosn/deepseek-harness` fork on top of upstream `deepseek-ai/deepseek-harness`, from 2026-09-10 on. An agent working in this repository can look up what was changed here beyond upstream code and which PR each change shipped in. The owning rule lives in [AGENTS.md](AGENTS.md#fork-local-change-log).

## Scope

- Entries cover only **new custom changes** (patches, fixes, improvements) accepted from 2026-09-10 forward; earlier fork history is not backfilled.
- Upstream sync merges (`chore: merge upstream <ref>`) are **not** entries; upstream code stays authoritative ([sync policy](AGENTS.md#syncing-this-fork-with-upstream)).
- Rows are append-only: never rewrite or delete a historical row. Fix a not-yet-merged row's PR link only before that PR merges.

## Adding an entry

When a custom change passes acceptance (owner approval, checks green): create or submit its PR to `Bosn/deepseek-harness:master` if one does not exist yet, then append one row to the table below in the same branch before the PR merges, with the real PR URL. When the PR number is only known after commit time, append the row in a follow-up commit on the same branch after the PR is created.

## Entries

| Date | PR | Scope | Summary |
|---|---|---|---|
| 2026-09-10 | [#26](https://github.com/Bosn/deepseek-harness/pull/26) | `session-format-v0-to-v1` | Admit `requestBytesEstimate` in released-v0 failure records: the frozen v0→v1 edge no longer refuses real v0 Sessions written before the format migration; the member is validated as a positive integer and preserved unchanged through v3. |
| 2026-09-10 | [#27](https://github.com/Bosn/deepseek-harness/pull/27) | repo process | Add `FORK-CHANGES.md` and the AGENTS.md rule: every accepted fork-local custom change automatically gets a PR and an append-only change-log row with its PR link; history before 2026-09-10 is not backfilled. |