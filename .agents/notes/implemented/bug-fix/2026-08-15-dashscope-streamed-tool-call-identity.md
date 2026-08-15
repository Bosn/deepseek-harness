# Agent Note: Preserve DashScope streamed tool-call identity

Status: implemented

English | [中文](2026-08-15-dashscope-streamed-tool-call-identity.zh.md)

## Problem

The DashScope International OpenAI-compatible chat-completions endpoint sends a tool call's non-empty `id` and function `name` in its first streaming chunk, then may serialize those fields as an empty string or null in continuation chunks that carry argument fragments. The direct DeepSeek translator treated every present field as a replacement, so a continuation erased the established identity and the tool executor received `name: ""`. The resulting `UNKNOWN_TOOL` failures also allowed an empty call id into durable session events.

## Decision

`dsh-llm-deepseek` recognizes only the canonical `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` base URL as the DashScope International OpenAI-compatible endpoint. For that endpoint, only a non-empty string updates a streamed tool call's cached id or function name; empty and null continuation placeholders leave the established identity unchanged, while argument fragments still concatenate in arrival order.

The compatibility mode rejects a completed tool call that never establishes both a non-empty id and function name with `MALFORMED_RESPONSE` before emitting its final block. Other endpoints keep the existing translator semantics, including present-field replacement, so the native API path does not acquire DashScope-specific normalization.

The adapter owns endpoint recognition and passes the behavior into its private translator. The provider-neutral `StreamChunk` vocabulary, `BlockAssembler`, agent loop, tool registry, persistence, and Web client do not inspect provider hostnames or repair tool identity.

## Alternatives considered

**Normalize empty continuation fields for every endpoint.** Rejected because it would silently change native DeepSeek and configured gateway semantics; compatibility is tied to the endpoint whose documented stream requires it.

**Repair empty identity in `BlockAssembler`, the agent loop, the tool registry, or the Web client.** Rejected because those layers receive provider-neutral chunks after the adapter has already interpreted the wire response, and none can reconstruct erased provider metadata reliably.

**Route DashScope through the library-backed pi-ai adapter.** Rejected because it changes the selected provider route and its request, reasoning, retry, catalog, and diagnostics behavior instead of fixing the direct adapter's configured endpoint.

## Consequences

DashScope continuation placeholders cannot erase a valid tool-call identity, parallel calls remain separated by their wire indices, and a DashScope stream with no valid identity fails before an executable or durable final tool call exists. Native DeepSeek responses retain their translation behavior. Custom gateways that reproduce DashScope's placeholders do not receive this compatibility unless they use the canonical DashScope base URL; supporting another endpoint requires an explicit adapter decision rather than hostname inference.

Translator tests pin empty-string and null continuations, parallel argument assembly, opt-in behavior, and missing-identity rejection. An adapter test pins the exact endpoint selector and drives the resulting chunks through the provider-neutral `BlockAssembler`. The headless snapshot boots the real Loader composition with the canonical DashScope endpoint, redirects only its HTTP boundary to deterministic SSE, executes `read`, persists the turn, and cold-loads the log in a fresh context. Provider-specific real-API e2e suites pin both native DeepSeek and DashScope tool-call round trips behind independent credentials. This decision follows the adapter ownership established by [the twin LLM adapter decision](../architecture/2026-06-13-twin-llm-adapters.md) and leaves the broader [architectural conformance proposal](../../proposed/process/2026-06-11-architectural-conformance.md) open.
