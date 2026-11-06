# The tool loop

## Defining a tool

```ts
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

const SearchNotesInput = z.object({
  query: z.string().describe('Words to search for'),
  limit: z.number().int().describe('How many results, 1 to 20'),
});

export const searchNotesTool: Anthropic.Beta.BetaTool = {
  name: 'search_notes',
  description: 'Search the saved notes. Call this whenever the user asks about something that may be in the notes.',
  input_schema: z.toJSONSchema(SearchNotesInput) as Anthropic.Beta.BetaTool.InputSchema, // the cast is required
  strict: true,
  eager_input_streaming: true, // only on streamed requests
};
```

- The description says **when** to call the tool, not only what it does.
- `z.toJSONSchema` (zod 4) sets `additionalProperties: false` on objects, which `strict: true` needs.
- Strict mode does not support numeric ranges or string lengths. Keep `.min()`, `.max()` and `.length()` out of
  the schema you send, and check them yourself (the `refine` below).
- Keep the tool set fixed for the session and sorted by name (see `prompt-caching.md`).
- Opus 5.5 rejects forced `tool_choice` (`any` or `tool`). Use `{ type: 'auto' }`, and if a call is required, check
  that it happened and ask again if not.

## What a tool may do

- Read-only tools (search, read a file, look up a record) are fine.
- A tool that changes data writes a **proposal or draft** for a person to approve, never the change itself.
- No tool sends a message (e-mail, text, chat, push) to a customer or anyone else. Delivery is application code.
- A tool that takes a path confines it to an allowed root and resolves symlinks before reading. Schema validation is
  not path validation.

## Running one turn's tools

```ts
type Handler = (input: unknown) => Promise<unknown>;
const handlers: Record<string, { schema: z.ZodType; run: Handler; readOnly: boolean }> = {
  search_notes: {
    schema: SearchNotesInput.refine((v) => v.limit >= 1 && v.limit <= 20, 'limit must be 1 to 20'),
    run: async () => ({ hits: [] }),
    readOnly: true,
  },
};

// --- run every tool_use of one turn and answer with ONE user message, results in tool_use order
export async function runTools(msg: Anthropic.Beta.BetaMessage): Promise<Anthropic.Beta.BetaMessageParam> {
  const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
  const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
  const readOnly = uses.filter((u) => handlers[u.name]?.readOnly);
  const settled = new Map<string, Anthropic.Beta.BetaToolResultBlockParam>();
  await Promise.all(readOnly.map(async (u) => settled.set(u.id, await runOne(u)))); // read-only tools in parallel
  for (const u of uses) {
    if (!settled.has(u.id)) settled.set(u.id, await runOne(u)); // everything else one at a time, in order
    results.push(settled.get(u.id)!);
  }
  return { role: 'user', content: results };
}

async function runOne(u: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const h = handlers[u.name];
  if (!h) return fail(u.id, { error: `unknown tool ${u.name}` });
  const parsed = h.schema.safeParse(u.input); // ALWAYS validate: streamed input is not validated by the server
  if (!parsed.success) return fail(u.id, { error: 'invalid input', issues: parsed.error.issues.map((i) => i.message) });
  try {
    return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(await h.run(parsed.data)) };
  } catch (e) {
    return fail(u.id, { error: e instanceof Error ? e.message : String(e) });
  }
}

function fail(id: string, body: Record<string, unknown>): Anthropic.Beta.BetaToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: id, is_error: true, content: JSON.stringify(body) }; // a JSON string, built with JSON.stringify
}
```

Rules shown above:
- **All results of one turn go back in one user message**, one `tool_result` per `tool_use`, in `tool_use` order.
  Extra text for the model (a reminder) goes after the results in that same message, never inside a result.
- **Errors go back to the model** as `is_error: true` with a JSON string built by `JSON.stringify`, so the model can
  correct itself. A thrown handler must not crash the loop.
- **Validate every input with zod** before running. The SDK's partial-JSON parser can turn malformed input into a
  silently truncated object.
- Read-only tools may run in parallel; tools with side effects run one at a time.

## The loop

```ts
export async function loop(history: Anthropic.Beta.BetaMessageParam[], maxTurns = 20): Promise<Anthropic.Beta.BetaMessage> {
  for (let turn = 0; turn < maxTurns; turn++) {
    const msg = await streamTurn({ ...base, tool_choice: { type: 'auto' }, messages: history });
    if (msg.stop_reason === 'tool_use') {
      history.push({ role: 'assistant', content: msg.content }); // append the full content, unchanged
      history.push(await runTools(msg));
      continue;
    }
    if (msg.stop_reason === 'pause_turn') {
      history.push({ role: 'assistant', content: msg.content }); // re-send as is; no "Continue." message
      continue;
    }
    return msg; // end_turn, refusal, max_tokens, ...: the caller reads stop_reason (see readReply)
  }
  throw new Error('tool loop: turn cap reached');
}
```

- Always cap the number of turns (and the cost, see `cost-tracking.md`).
- History is append-only. Push the assistant `content` exactly as received, including thinking blocks with empty
  text and their signatures. Editing, reordering or deleting earlier turns makes the next request fail with 400.
  To shrink a long conversation, start a new one from a summary at a turn boundary (no tool call waiting for its
  result), or use the API's server-side context editing or compaction.
- On `refusal` never run that turn's tools; on `max_tokens` with a `tool_use` present, never run the truncated call.
