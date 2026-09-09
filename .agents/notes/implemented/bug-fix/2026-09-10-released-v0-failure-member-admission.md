# Agent Note: Admit requestBytesEstimate in released-v0 failure records

Status: implemented

English | [中文](2026-09-10-released-v0-failure-member-admission.zh.md)

## Problem

The released v0-to-v1 edge refused real v0 Sessions whose LLM failure records carry `requestBytesEstimate`. The member entered the `LlmError` vocabulary on 2026-08-21 (`fix(llm): report post-conversion request bytes`) and flowed into logged `llm/retry`, assistant finish, and turn/end error failures from that build onward, while the session format was still v0. The frozen [released-format migration](../../../../packages/session/session-format-v0-to-v1/README.md) froze the failure allowlist `{message, code}` plus `{status, providerRetryAfterMs, requestId}` ten days later without this member, so it refused every such log: a live Session (`session-021a0e4c-aea5-444f-9881-c1381637cd2f`, `llm/retry` seq 196010 with `failure.requestBytesEstimate: 1948914`) failed history load with "has unexpected member \"requestBytesEstimate\"", and the source v0 artifact stayed unchanged. The refusal was not a deliberate inventory entry: [the committed-corpus inventory](../../../../packages/test-support/llm-replay/tests/session-format-corpus-inventory.ts) requires unlisted artifacts to restore, and the member is legitimate current vocabulary that appears in shipped expected outputs.

## Decision

Released-v0 failure records admit `requestBytesEstimate` at every validated position — `llm/retry.failure`, `assistant/chunk` finish `reason.failure` and `turn/end` `reason.error` through the shared `llmFailureValue`, and the retired `turn/end` `reason.failure` conversion in the v0-to-v1 stage — validated as a positive safe integer. Migration preserves the member unchanged through v1-to-v2 and v2-to-v3, which already carry it natively in current generations. The edge remains exact: any other unexpected failure member still refuses.

## Verification

The v0-to-v1 suite pins acceptance in the valid fixture inventory, type corruption at the new leaf, refusals for `0`, `-1`, and `1.5`, and lossless preservation through the retired turn/end conversion. The real refused Session restores through the source catalog with production recovery: 17,877 physical rows decode into 2,028 current events with all 51 `requestBytesEstimate` occurrences preserved and no refusal. The full session-format family, `session-persistence-jsonl`, and committed-corpus suites pass unchanged, and no corpus entry or fixture changes.

## Alternatives considered

**Inventory the refusal as deliberate.** The corpus contract forbids unlisted refusals and retaining real artifacts must not force rejecting released writer output; listing every affected log is unbounded and leaves the Session unreadable.

**Classify the member as corruption.** The rows are well-formed released data written by shipped builds, not a torn or malformed artifact; the wrong class would drop rows or refuse under strict recovery.

**Strip the member during migration.** Removing evidence contradicts the model-visible-means-logged rule: the byte estimate explains retry and compaction decisions and downstream generations preserve it.

## Consequences

v0 artifacts written between the member's introduction and the format migration become readable again, and the fix costs one admitted member with a validation rule in the frozen inventory. The same harness-version skew can still surface other under-covered released shapes; each one needs the same evidence-based admission rather than a blanket relaxation.