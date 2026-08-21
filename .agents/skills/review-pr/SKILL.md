---
name: review-pr
description: Use when the user asks `review-pr <PR link>` or asks to fix the issues Codex Review raised on a pull request and to re-trigger @codex review, looping until Codex review passes ("循环直到 codex review 通过"). Covers reading Codex feedback for the current PR head, fixing each suggestion with focused local evidence, pushing, re-triggering the review, polling for the per-commit verdict, and repeating until Codex reacts 👍.
---

# Review PR: fix Codex feedback and loop until it passes

The user hands you one PR link and expects the full loop: pull Codex Review's suggestions for the current head, fix them, push, re-trigger `@codex review`, and repeat until Codex reports pass — no re-describing the loop each round.

## Invoke from the link

The canonical invocation is `review-pr <link>`, e.g. `review-pr https://github.com/Bosn/deepseek-harness/pull/4`. Parse `owner/repo/number` from any GitHub PR URL form.

Standing repo rule ([AGENTS.md](../../AGENTS.md)): PRs open in the checkout's own fork `Bosn/deepseek-harness`, never upstream. When the user passes a link, operate on that exact repository and PR.

1. `gh pr view <n> -R <owner>/<repo> --json state,mergeable,headRefName,headRefOid,baseRefName` — record the current head SHA and the PR's head branch; the loop is per-head.
2. Make sure local work happens on the PR's head branch. The shared checkout commonly carries other tasks' uncommitted WIP: **never** `git add -A`, `git stash`, `git clean`, or `git checkout` away that WIP; stage and commit only the paths you actually touch.
3. Arm a same-session goal for the whole loop (each Codex round can take 5–35 min, longer than one turn); poll through it and mark it complete only on a per-head pass verdict.

## Read the review state (every round)

```sh
gh api repos/<owner>/<repo>/pulls/<n>/reviews             # .commit_id, .state, .body
gh api repos/<owner>/<repo>/pulls/<n>/comments            # inline: .commit_id, .path, .line, .body
gh api repos/<owner>/<repo>/issues/<n>/reactions          # .content, .created_at
```

Only the bot reviews matter: `chatgpt-codex-connector[bot]`. Its review body names the commit: `Reviewed commit: <sha>`.

- **Suggestion on the current head** — an inline comment (P1/P2 badge + body) attached to `commit_id == HEAD`, or `state: COMMENTED` review whose body tracks HEAD → fix it this round.
- **Pass verdict** — a `+1` reaction from the connector bot, created after your latest `@codex review` trigger, with no newer review/comment on the head. Codex's own contract: it comments when it has suggestions, otherwise it reacts 👍. A pass produces no review record; the reaction is the evidence.
- **Stale feedback** — a review/comment whose `commit_id` (or `Reviewed commit:`) is an older head. It may arrive minutes after you already fixed it (observed lag: one run still described the pre-fix commit). Ignore it; do not re-answer.
- **Nothing yet for the current head** — poll. Wait a few minutes between polls (sleep inside a bash poll or return and let the goal round re-poll); do not stack extra `@codex review` triggers while a run on the same head is outstanding.

## Fix round

For every suggestion on the current head:

1. Decide correct semantics with the code, not just the reviewer's wording; push back in a PR comment only when the suggestion misreads the facts (each suggestion so far has been a real defect, not noise).
2. Implement, then update tests that describe the behavior (focused Vitest on the owning packages, coverage on the touched `src`). Add the missing case, never weaken a gate.
3. Keep docs honest with the new behavior: owning README pairs, generated catalogs (regenerate, don't hand-edit), subsystem pages, and the Agent Note triplet when the mechanism's contract changed. After bilingual edits run `pnpm run verify-translation-pairing --write <pair-en.md>` and the normal verifier.
4. Commit **only the touched paths** with one commit per review round citing the P1. Push the PR's head branch. If the pre-push typecheck fails, prove the failure is unrelated to the change (clean-worktree check, other-task WIP paths, or pre-existing upstream errors named with file/line); only then push `--no-verify` and note it. Never bypass to skip evidence for the change itself.
5. Re-trigger exactly once: `gh pr comment <n> -R <owner>/<repo> --body "@codex review"`. Record the trigger time to timestamp the next verdict against it.

## Report

Close each round with the running table — `round | Codex reviewed commit | suggestions | fix commit | result` — and the final pass evidence (reaction `+1` at `<timestamp>`, no newer feedback on the head SHA). Keep the goal active until that pass exists; on pass, mark the goal complete.