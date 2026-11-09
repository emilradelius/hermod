# Cost tracking and caps

## Prices (USD per million tokens; check the Anthropic pricing page when you add a model)

| Model | Input | 5-min cache write | 1-hour cache write | Cache read | Output |
|---|---:|---:|---:|---:|---:|
| `claude-opus-5-5` | 4.00 | 5.00 | 8.00 | 0.20 | 20.00 |
| `claude-sonnet-5-5` | 2.00 | 2.50 | 4.00 | 0.10 | 10.00 |
| `claude-haiku-5-5`, prompt up to 100,000 tokens | 0.10 | 0.125 | 0.20 | 0.01 | 0.50 |
| `claude-haiku-5-5`, prompt over 100,000 tokens | 0.50 | 0.625 | 1.00 | 0.05 | 2.50 |

- Batch API: half price on everything. US-only inference (`inference_geo`): 1.1x.
- The Haiku tier is decided per request by the whole prompt: `input_tokens + cache_creation_input_tokens +
  cache_read_input_tokens`.
- Thinking tokens are output tokens: `output_tokens` is the billed total.
- Server-tool fees (for example per web search) are extra and not covered here.

## Usage fields

`input_tokens` (only the uncached remainder), `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`, `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`. Beta
responses may also carry `usage.iterations`: one entry per billed attempt (fallback hops, compaction). The top-level
fields then describe only the attempt that produced the reply, so price the iterations instead.

```ts
import Anthropic from '@anthropic-ai/sdk';

type Rate = { input: number; write5m: number; write1h: number; read: number; output: number };
const OPUS: Rate = { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 };
const SONNET: Rate = { input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 };
const HAIKU_LOW: Rate = { input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01, output: 0.5 };
const HAIKU_HIGH: Rate = { input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 }; // prompt over 100,000 tokens

function rateFor(model: string, promptTokens: number): Rate {
  if (model.startsWith('claude-opus-5-5')) return OPUS;
  if (model.startsWith('claude-sonnet-5-5')) return SONNET;
  if (model.startsWith('claude-haiku-5-5')) return promptTokens > 100_000 ? HAIKU_HIGH : HAIKU_LOW;
  return OPUS; // unknown model: charge the dearest known rate so a cap is never too generous
}

type Counts = {
  input_tokens: number;
  output_tokens: number; // includes thinking tokens
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
};

export function usd(model: string, u: Counts): number {
  const read = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens : written; // no split given: assume 5m
  const r = rateFor(model, u.input_tokens + written + read);
  return (u.input_tokens * r.input + w5m * r.write5m + w1h * r.write1h + read * r.read + u.output_tokens * r.output) / 1e6;
}

// Beta responses: when usage.iterations is present (fallback hops, compaction), price each entry and add them up.
export function usdOfBeta(msg: Anthropic.Beta.BetaMessage, requestedModel: string): number {
  const its = msg.usage.iterations;
  if (!its || its.length === 0) return usd(msg.model, msg.usage);
  return its.reduce((sum, it) => sum + usd('model' in it && it.model ? String(it.model) : requestedModel, it), 0);
}
```

Summing every iteration is an upper bound: a declined pre-output hop in a non-billed refusal category appears there
but is not charged. For a cap, an upper bound is the right side to err on.

## A cap per agent

```ts
declare function spentTodayUsd(agent: string): Promise<number>;
declare function recordSpend(agent: string, model: string, amountUsd: number): Promise<void>;
const DAILY_CAP_USD: Record<string, number> = { 'nightly-summary': 0.5, assistant: 5 };

export async function assertUnderCap(agent: string, model: string, inputTokens: number, maxTokens: number) {
  const cap = DAILY_CAP_USD[agent];
  if (cap === undefined) throw new Error(`no cost cap configured for agent ${agent}`); // no cap, no call
  const r = rateFor(model, inputTokens);
  const worst = (inputTokens * Math.max(r.input, r.write1h) + maxTokens * r.output) / 1e6;
  if ((await spentTodayUsd(agent)) + worst > cap) throw new Error(`cost cap reached for ${agent}`);
}

export async function afterCall(agent: string, msg: Anthropic.Beta.BetaMessage, requestedModel: string) {
  await recordSpend(agent, msg.model, usdOfBeta(msg, requestedModel));
}
```

- Check **before** the call with a worst case (prompt priced as a cache write, `max_tokens` of output); record the
  real cost **after**, including failed and refused calls that were billed.
- Get the prompt size from `client.messages.countTokens` (or `client.beta.messages.countTokens`) with the same
  model, system, tools and messages. Never estimate with another tokenizer.
- A cap reached is a normal outcome: the job stops for today and says so; it is not an error to retry.
- Keep caps in config the app owner can see and change, per agent and per period.
