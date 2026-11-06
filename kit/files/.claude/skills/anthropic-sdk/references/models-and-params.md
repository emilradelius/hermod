# Models, effort and request parameters (@anthropic-ai/sdk 1.1.0)

## Pin

```jsonc
// package.json: exact versions, no ^ or ~
"dependencies": { "@anthropic-ai/sdk": "1.1.0", "zod": "4.6.7" }
```

SDK 1.x sends a newer API version than 0.x. On it, `temperature`, `top_p` and `top_k` return 400 on every model,
even at their default values, and the 1.x types no longer accept them. Other 0.x to 1.x changes that break code:
`MessageParam` is now a union of user, assistant and system messages; Text Completions are gone; the key is sent as
`Authorization: Bearer` (a gateway that reads `X-Api-Key` breaks); a client holds exactly one credential.

## The models we use

| | `claude-opus-5-5` | `claude-haiku-5-5` |
|---|---|---|
| Use for | main agent turns, hard reasoning | background work: summaries, sorting, checks |
| Effort | set explicitly (API default `medium`) | `low` (API default `medium`) |
| Thinking | always on; omit or `{ type: 'adaptive' }`; `disabled` and `budget_tokens` return 400 | adaptive, on by default; `budget_tokens` returns 400; we never disable it |
| Sampling params | 400 | 400 |
| Assistant prefill | 400 | 400 |
| Forced `tool_choice` | 400 (use `auto` + `strict`) | accepted, but the reply then has no thinking; prefer `auto` |
| Server-side fallback | yes: `fallbacks: 'default'` + beta `server-side-fallback-2026-07-01` | none: never send `fallbacks` |
| Context / max output | 1M / 128K | 1M / 128K |
| Min cacheable prefix | 512 tokens | 512 tokens |

Effort levels are `'low' | 'medium' | 'high' | 'xhigh' | 'max'`. Lower effort before you prompt for brevity.
Changing the top-level effort between requests of one conversation invalidates the prompt cache, so pin it per
route. `max_tokens` covers thinking plus reply: 64,000 is a reasonable start for long agent turns on Opus 5.5.

## Main route (Opus 5.5)

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment; never pass a literal key

export async function mainTurn() {
  const stream = client.beta.messages.stream({
    model: 'claude-opus-5-5',
    max_tokens: 64000, // thinking + reply; streaming is required above about 21,000
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium' }, // set it on every route; 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    thinking: { type: 'adaptive' }, // or omit it; never 'disabled', never budget_tokens
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    cache_control: { type: 'ephemeral' },
    messages,
  });
  return stream.finalMessage();
}
```

- `fallbacks` and `betas` exist only on `client.beta.messages`; the non-beta types reject them. Use the beta types
  (`Anthropic.Beta.*`) for the whole conversation and do not mix them with non-beta types.
- `betas` accepts any string, so a misspelt header compiles. Copy `server-side-fallback-2026-07-01` exactly.

## Background route (Haiku 5.5)

```ts
export async function backgroundTurn() {
  return client.messages.create({
    model: 'claude-haiku-5-5',
    max_tokens: 4096,
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: plainMessages,
  });
}
```

Non-streaming is fine here because `max_tokens` is small. Above about 16,000, stream (see `streaming.md`).

## Structured output instead of a prefill

```ts
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const Summary = z.object({ title: z.string(), bullets: z.array(z.string()) });
export async function structured() {
  const res = await client.messages.parse({
    model: 'claude-haiku-5-5',
    max_tokens: 2048,
    output_config: { effort: 'low', format: zodOutputFormat(Summary) },
    messages: [{ role: 'user', content: 'Summarise the notes below.\n\n<notes>…</notes>' }],
  });
  if (res.stop_reason === 'refusal') return null;
  return res.parsed_output; // null when parsing failed: treat as a failed call, not as an empty result
}
```

Other prefill replacements: a classification label becomes a tool with an enum field (or structured output);
"skip the preamble" becomes a system-prompt sentence; "continue an interrupted reply" goes into the user turn.

## Mid-conversation messages

`{ role: 'system', content: '…' }` is a valid message in 1.x (no header). Append it for context that changes
during a conversation instead of editing the system prompt. Never edit or delete earlier turns: thinking blocks are
signed against everything before them, and an edited history returns 400.
