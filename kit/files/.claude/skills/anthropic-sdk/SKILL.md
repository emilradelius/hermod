---
name: anthropic-sdk
description: Anthropic SDK calls with our rules and shapes. Use when adding or changing a model call, a prompt, a tool the model can call, streaming, prompt caching, refusal or error handling, retries, or cost tracking with @anthropic-ai/sdk in TypeScript, and when reviewing such code.
---

# Anthropic SDK: our rules, and how to add a model call

The rules come first because they are the part that is easy to break and expensive to get wrong. The exact
TypeScript shapes are in `references/`; every snippet there compiles against `@anthropic-ai/sdk` 1.1.0 and
`zod` 4.6.7. If the `claude-api` skill is available, load it too for anything this skill does not cover.

## Rules

1. **Anthropic only.** Model calls go to Anthropic through `@anthropic-ai/sdk`. No other AI provider, no proxy, no
   gateway, no shim library that wraps several providers. Why: one data processor to trust and one billing record,
   and the SDK's types are our first test.
2. **Pinned SDK.** `package.json` names an exact version (`"@anthropic-ai/sdk": "1.1.0"`), never a range or
   `latest`. Upgrade in its own pull request after reading the changelog. Why: minor versions have changed request
   shapes and defaults.
3. **Keys only in the environment.** `new Anthropic()` reads `ANTHROPIC_API_KEY`. A key never appears in code, tests,
   logs, error messages, commits or chats. Document the variable in `.env.example` with an empty value.
4. **One call module.** Every call goes through one module (for example `src/lib/ai.ts`); nothing else
   imports the SDK. That module applies the rules below, so they cannot be skipped.
5. **One redaction function.** The call module runs the app's single `redact()` over every text it sends and over
   anything it logs. Log sizes, models, stop reasons and costs, never prompts or replies.
6. **AI output is a draft.** A reply is stored as a draft that a person approves (or a test decides). Code that
   acts on a reply checks the approval first.
7. **No messaging tool.** The model never gets a tool that sends an e-mail, text, chat or push message to a customer
   or anyone else. Application code delivers approved drafts to configured targets.
8. **Cost cap per agent.** Every agent or route has a configured cap (per day or per run). The call module checks it
   before the call with a worst-case estimate and records the real cost after. No cap configured means no call.
9. **Stop reason before content.** Read `stop_reason` first. A `refusal` is not an answer, `max_tokens` is not
   finished, and a truncated tool call is never run.

## Models and request settings

| Route | Model | Settings |
|---|---|---|
| Main (agent turns, hard work) | `claude-opus-5-5` | `output_config.effort` set explicitly; stream; server-side fallback `fallbacks: 'default'` with beta `server-side-fallback-2026-07-01` |
| Background (summaries, sorting, checks) | `claude-haiku-5-5` | `output_config.effort: 'low'`; small `max_tokens`; no `fallbacks` (it has none) |

On every route:
- `thinking` is omitted or `{ type: 'adaptive' }`. Never `{ type: 'disabled' }` and never `budget_tokens`
  (both return 400 on Opus 5.5). Effort is the only depth control.
- No `temperature`, `top_p` or `top_k`. They are gone from the 1.x types and return 400.
- No assistant prefill (a last message with `role: 'assistant'`). Use structured output
  (`output_config.format`) or a sentence in the system prompt.
- No forced `tool_choice` (`any` or `tool`) on Opus 5.5: it returns 400. Use `auto` plus `strict: true` tools, and
  check that the call you needed happened.
- Stream when `max_tokens` is above about 16,000 (non-streaming `create` throws on the client above 21,333
  without an explicit timeout). Use `finalMessage()`.

Details and code: [models and parameters](references/models-and-params.md).

## Procedure: adding a model call

1. **Decide the route.** Main or background, which agent it belongs to, and its cost cap. Add the cap to config
   before writing the call.
2. **Write the prompt for caching.** A frozen system prompt (no dates, ids, names or modes); tools in a fixed order;
   dynamic context late, as a `role: 'system'` message or in the user turn. See
   [prompt caching](references/prompt-caching.md).
3. **Define tools with zod** (if any): `z.toJSONSchema(schema)` as `input_schema`, `strict: true`, a description
   that says when to call it. No tool may send messages or change data without approval. See
   [the tool loop](references/tool-loop.md).
4. **Build the request in the call module**: model, explicit effort, `max_tokens` sized for thinking plus reply,
   adaptive thinking, the fallback settings for the model. Redaction and the cap check happen there.
5. **Stream and take `finalMessage()`.** See [streaming](references/streaming.md).
6. **Branch on `stop_reason`**: `end_turn` (use it), `tool_use` (run tools, continue), `pause_turn` (re-send),
   `refusal` (record it, no output), `max_tokens` or `model_context_window_exceeded` (not done). See
   [refusals and fallbacks](references/refusals-and-fallbacks.md).
7. **Handle errors by class**, after the SDK's own retries: see [errors and retries](references/errors-and-retries.md).
8. **Record cost from `usage`** (sum `usage.iterations` on beta responses) against the agent's cap. See
   [cost tracking](references/cost-tracking.md).
9. **Store the reply as a draft** for a person to approve. See [guardrails](references/guardrails.md) for the
   call-module shape that ties steps 4 to 9 together.
10. **Test without the network.** Unit tests use a fake client or recorded responses; CI never needs a key. One
    manual, capped run against the real API before you call it done, and say in the pull request that you did it.

## Before you call it done

- [ ] The SDK version is exact in `package.json` and the lockfile.
- [ ] No key, prompt or reply text in code, tests, fixtures or logs; `.env.example` lists the variable.
- [ ] The call goes through the call module; `redact()` runs on everything sent and logged.
- [ ] Effort is explicit; no sampling parameters, no prefill, no forced tool choice, thinking not disabled.
- [ ] `stop_reason` is checked before `content`; refusals and truncation have a tested path.
- [ ] Tool inputs are validated with zod before running; errors go back as `is_error` with a JSON string.
- [ ] The agent has a cost cap; cost is recorded from `usage`; `cache_read_input_tokens` was checked once.
- [ ] Output is a draft; no tool lets the model message anyone.

## Why these rules

The expensive failures with model calls are quiet ones: a key in a log, a refusal shown to a user as an answer, a
loop that re-sends a failing call all night, a prompt change that turns every cache read into a cache write, a
model that acts on its own output. Each rule above closes one of those, and the call module makes them hard to skip.

Checked against @anthropic-ai/sdk 1.1.0 and the claude-api skill on 2026-11-05.
