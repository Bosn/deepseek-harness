# Agent Note: Expose the supportsDeveloperRole compat switch on custom OpenAI-compatible routes

Status: implemented

English | [中文](2026-08-19-llm-pi-ai-developer-role-compat-switch.zh.md)

## Problem

pi-ai's `openai-completions` serializer sends a reasoning model's system prompt as `role: "developer"` when `compat.supportsDeveloperRole` is true. pi-ai derives that flag from the endpoint URL and defaults it to true for any standard-looking OpenAI-compatible endpoint; only its installed catalog entries (the Alibaba MaaS `qwen-token-plan` routes, among others) carry the correct `supportsDeveloperRole: false`. A hand-declared `llm-pi-ai` route — the mechanism a deployment uses for a gateway pi-ai does not ship, such as DashScope Intl's compatible-mode endpoint — has no catalog entry to inherit from, and the harness compat schema offered only `thinkingFormat` and `supportsReasoningEffort`. A reasoning model on such a route therefore sent `messages[0].role = "developer"`, and gateways accepting only `system`/`assistant`/`user`/`tool`/`function` failed every turn with a 400 `invalid_request_error` ("developer is not one of [...]"). No configuration spelling could correct it: the only levers were declaring the model non-reasoning (losing the thinking-level selector and reasoning dispatch) or leaving the supported configuration surface.

## Decision

`llm-pi-ai`'s `PiAiCompatProfile` now offers `supportsDeveloperRole` (boolean) at route level and per model, beside `thinkingFormat` and `supportsReasoningEffort`. Resolution order is model → route → installed catalog entry → pi-ai's URL-derived detection; a route-level value shadows the catalog entry's for every model on the route, and there is still no spelling for handing a field back to the catalog short of restating its value. The field is accepted only where pi-ai types it — `OpenAICompletionsCompat` — so a model-level switch on another protocol fails resolution, a route-level one skips models of other protocols, and a route with no `openai-completions` model is refused, mirroring the existing reasoning switches. Absent the field, behavior is unchanged: pi-ai's auto-detection decides. The reasoning switches are untouched — `supportsDeveloperRole` changes only which role carries the system prompt, so thinking levels stay selectable and their wire spellings unchanged.

## Alternatives considered

**Declare `reasoningEfforts: false` on such models.** Rejected because it makes the model non-reasoning, removing the thinking-level selector and the `reasoning_effort` dispatch the deployment configured.

**Route the deployment through a pi-ai catalog provider (`qwen-token-plan`, `qwen-token-plan-cn`).** Rejected as the general answer: only those exact routes benefit, and a deployment whose gateway has its own baseURL, model ids, or is an aggregator is precisely what hand-declared routes exist for.

**Fix pi-ai's URL-derived detection upstream.** Not rejected, but out of this repository's control; until pi-ai classifies the endpoint, every affected deployment needs the switch. Reported upstream as a follow-up.

**Hack the baseURL into pi-ai's non-standard endpoint list.** Rejected: it misdescribes the endpoint and breaks the moment detection changes.

## Consequences

- A hand-declared `openai-completions` route whose gateway rejects the `developer` role can set `compat.supportsDeveloperRole: false` (route- or model-level) and keep reasoning dispatch fully intact.
- The settings UI surfaces the switch automatically: the Models settings form renders the namespace schema, so no client code changes.
- Default behavior is unchanged — absent the field, resolution falls through to pi-ai's detection as before, so existing configurations are unaffected.
- `routeCompatDefined` now counts the new switch, so a route-level value on a route with no `openai-completions` model is refused rather than silently skipped.

## Testing

`tests/config.spec.ts` accepts the boolean switch at the schema boundary and rejects non-boolean values. `tests/catalog.spec.ts` (compat switches) proves a route-level switch applies with a per-model override, a catalog role switch (`qwen-token-plan`'s `supportsDeveloperRole: false`) survives an unrelated switch override, a mixed-protocol route applies both reasoning and role switches to its completions models while skipping the others, and model-level and route-level switches on a protocol without the field fail resolution with the existing diagnostics.
