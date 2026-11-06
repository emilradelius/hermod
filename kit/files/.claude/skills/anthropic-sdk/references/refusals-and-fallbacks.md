# Refusals and fallbacks

A refusal is HTTP 200 with `stop_reason: 'refusal'`. It can happen before any output or in the middle of a stream.
It is never an answer: discard any partial text, do not run that turn's tools, and record the category.

## Read the stop reason first

```ts
import Anthropic from '@anthropic-ai/sdk';

export type Reply =
  | { kind: 'text'; text: string; servedBy: string; fellBack: boolean }
  | { kind: 'refused'; category: string | null; servedBy: string }
  | { kind: 'truncated' }
  | { kind: 'tools'; uses: Anthropic.Beta.BetaToolUseBlock[] };

export function readReply(msg: Anthropic.Beta.BetaMessage): Reply {
  switch (msg.stop_reason) {
    case 'refusal':
      // Discard any partial text. The whole fallback chain declined.
      return { kind: 'refused', category: msg.stop_details?.category ?? null, servedBy: msg.model };
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return { kind: 'truncated' }; // never run a truncated tool call
    case 'tool_use':
      return { kind: 'tools', uses: msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use') };
    default: {
      const text = msg.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const fellBack = msg.content.some((b) => b.type === 'fallback');
      return { kind: 'text', text, servedBy: msg.model, fellBack };
    }
  }
}
```

- Branch on `stop_reason`, never on `stop_details` (which is `null` for every other stop reason).
- `stop_details.category` can be `null`; treat that as a valid value.
- Read content blocks by `type`, never `content[0]`.
- `pause_turn` is not a refusal: append the assistant content and send again (see `tool-loop.md`).

## Opus 5.5: server-side fallback "default"

Send `fallbacks: 'default'` with the beta header `server-side-fallback-2026-07-01` on every Opus 5.5 request (shape
in `models-and-params.md`). When Opus 5.5 declines, the API retries on a fallback model and returns that reply:
- `msg.model` names the model that answered; a `fallback` content block marks the switch (`from`, `to`, `trigger`).
- `msg.usage.iterations` lists every attempt with its own tokens; price each one (see `cost-tracking.md`).
- A refusal that still comes back means the whole chain declined. `msg.stop_details?.recommended_model` may name a
  model for a direct retry.
- Fallbacks trigger on policy declines only. Rate limits, overloads and server errors come back as errors.
- `reasoning_extraction` declines are not retried on a fallback: change the prompt instead.
- Routing is sticky for about an hour: later requests in the same conversation go to the fallback model.
- A pinned list (`fallbacks: [{ model: … }]`) needs the other header, `server-side-fallback-2026-06-01`. Pairing a
  header with the wrong form can return 400; stick to `'default'` with `-07-01` unless you need a pinned target.
- Not available on the Batches API, Bedrock, Vertex AI or Foundry.

Echoing a fallback turn back into history: keep the `fallback` block where it appeared, keep `text` blocks, keep
everything after the last `fallback` block. Before the last `fallback` block, drop `thinking`, `redacted_thinking`
and client `tool_use` blocks, and never run a client `tool_use` that came before it.

## Haiku 5.5: no server-side fallback

Never send `fallbacks` to Haiku 5.5: with `'default'` a declined request stays declined, and a list returns 400.
A Haiku 5.5 refusal carries no fallback credit, so a retry on another model pays full price.

Our default for background routes: **record the refusal and stop.** No draft this run; the log shows the route and
category so a person can look.

```ts
declare function recordRefusal(route: string, category: string | null): Promise<void>;
export async function backgroundOnce(client: Anthropic, body: Anthropic.MessageCreateParamsNonStreaming) {
  const msg = await client.messages.create(body);
  if (msg.stop_reason === 'refusal') {
    await recordRefusal('nightly-summary', msg.stop_details?.category ?? null);
    return null; // no draft this run; a person sees the refusal in the log
  }
  return msg;
}
```

When a route is configured to escalate, retry **once** with the same body on the escalation model, and stay on that
model for the rest of the conversation. The retry counts against the same cost cap.

```ts
export async function backgroundWithEscalation(client: Anthropic, body: Anthropic.MessageCreateParamsNonStreaming) {
  const first = await client.messages.create(body);
  if (first.stop_reason !== 'refusal') return first;
  if (first.stop_details?.category === 'reasoning_extraction') return null; // change the prompt instead
  // Same body, new model; stay on that model for the rest of this conversation.
  return client.messages.create({ ...body, model: 'claude-opus-5-5', output_config: { effort: 'low' } });
}
```

The SDK also has `betaRefusalFallbackMiddleware` with one `BetaFallbackState` per conversation. In 1.1.0 it retries
non-streaming refusals only; a streamed Haiku 5.5 refusal is passed through. Never combine the middleware with
server-side `fallbacks` on the same request.

## Billing of refusals

A pre-output refusal in the `cyber`, `general_harms` or `null` category is not billed (its tokens still appear in
`usage`); `bio`, `frontier_llm` and `reasoning_extraction` are. A mid-stream refusal is billed for input plus the
output already streamed.
