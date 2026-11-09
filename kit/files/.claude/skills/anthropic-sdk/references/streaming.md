# Streaming with finalMessage()

Stream every agent turn. Non-streaming `messages.create` throws on the client when `max_tokens` is above 21,333
and no explicit `timeout` is set ("Streaming is required for operations that may take longer than 10 minutes").

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export async function streamTurn(
  params: Anthropic.Beta.MessageCreateParamsNonStreaming,
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<Anthropic.Beta.BetaMessage | 'reissue'> {
  const stream = client.beta.messages.stream(params, { signal });
  stream.on('text', (delta) => onText(delta));
  try {
    return await stream.finalMessage(); // resolves with the whole message; rejects on API errors
  } catch (err) {
    // Eager-streamed tool input that is not valid JSON: an AnthropicError (not an APIError) caused by a SyntaxError.
    if (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && err.cause instanceof SyntaxError) {
      return 'reissue'; // send the same turn again; cap this at 2 in a row
    }
    throw err;
  }
}
```

Rules:
- Use `finalMessage()` (or `finalText()`). Do not wrap `.on()` handlers in `new Promise()`; errors and aborts are
  easy to lose that way.
- Text deltas are for display only. Decide what to do from the final message's `stop_reason`, never from the
  streamed text: a refusal can arrive after some text has streamed, and that partial text must be discarded.
- Events: `text`, `thinking`, `inputJson`, `contentBlock`, `message`, `finalMessage`, `error`, `abort`, `end`.
  Since 0.136.0 unknown server-sent event names are passed through, so a raw event `switch` needs a `default`.
- `stream.abort()` or an `AbortSignal` stops a turn; the SDK then throws `APIUserAbortError`.
- With the default thinking display (`omitted`), thinking blocks arrive with empty text. Keep them anyway (see
  `tool-loop.md`): their signatures must go back unchanged.
- `eager_input_streaming: true` on a tool streams its input as it is generated, and the server no longer validates
  it. Set it only on streamed requests, and always validate the input yourself before running the tool.
