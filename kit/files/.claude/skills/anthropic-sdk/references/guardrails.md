# Guardrails: the one call module

Every rule in SKILL.md is enforced in one place: the module that owns the SDK client. Nothing else in the app
imports `@anthropic-ai/sdk`. A lint rule (`no-restricted-imports`) or a repo check can keep it that way.

```ts
import Anthropic from '@anthropic-ai/sdk';

// One module owns every model call. Nothing else in the app imports '@anthropic-ai/sdk'.
declare function redact(text: string): string; // the app's ONE redaction function (secrets, e-mail, phone, ids)
declare function assertUnderCap(agent: string, model: string, inputTokens: number, maxTokens: number): Promise<void>;
declare function afterCall(agent: string, msg: Anthropic.Beta.BetaMessage, model: string): Promise<void>;
declare function saveDraft(d: { agent: string; text: string; model: string; status: 'pending' }): Promise<string>;
declare function log(event: string, data: Record<string, unknown>): void;

const client = new Anthropic(); // ANTHROPIC_API_KEY from the environment only

function redactParams(p: Anthropic.Beta.MessageCreateParamsNonStreaming): Anthropic.Beta.MessageCreateParamsNonStreaming {
  const system = typeof p.system === 'string' ? redact(p.system) : p.system?.map((b) => ({ ...b, text: redact(b.text) }));
  const messages = p.messages.map((m): Anthropic.Beta.BetaMessageParam => {
    if (m.role === 'system') return typeof m.content === 'string' ? { ...m, content: redact(m.content) } : m;
    if (typeof m.content === 'string') return { ...m, content: redact(m.content) };
    if (m.role === 'assistant') return m; // model output goes back unchanged (thinking signatures)
    return { ...m, content: m.content.map((b) => (b.type === 'text' ? { ...b, text: redact(b.text) } : b)) };
  });
  return { ...p, system, messages };
}

export async function draftFromModel(agent: string, params: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<string | null> {
  const safe = redactParams(params);
  const { input_tokens } = await client.beta.messages.countTokens({ model: safe.model, system: safe.system, messages: safe.messages, tools: safe.tools });
  await assertUnderCap(agent, safe.model, input_tokens, safe.max_tokens);
  const msg = await client.beta.messages.stream(safe).finalMessage();
  await afterCall(agent, msg, safe.model);
  if (msg.stop_reason === 'refusal') {
    log('model.refusal', { agent, category: msg.stop_details?.category ?? null });
    return null;
  }
  const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
  log('model.reply', { agent, model: msg.model, chars: text.length }); // sizes, never the text itself
  return saveDraft({ agent, text, model: msg.model, status: 'pending' }); // a person approves; delivery code sends
}
```

## What each part protects

- **Keys.** `new Anthropic()` reads `ANTHROPIC_API_KEY`. Never pass `apiKey:` from a literal, never log the client
  or its options, never echo a key in an error. If a key was pasted into a chat, a log or a commit, treat it as
  leaked: revoke it and make a new one.
- **Redaction.** One `redact()` for the whole app, so a new kind of personal data (or a new secret format) is added
  in one place and covers every call and every log line. Tool results that carry user data go through it too.
  Assistant turns are sent back unchanged; they were produced from already-redacted input.
- **Untrusted text.** Text from web pages, e-mails, files or other tools is data, not instructions. Wrap it in clear
  delimiters (for example `<document>…</document>`) and do not let it trigger side effects on its own.
- **Drafts.** The reply is saved with status `pending`. Code that uses a reply (sends it, writes it to a record,
  changes settings) runs only after a person approved it, or after a test decided. Store who approved and when.
- **No messaging tool.** Delivery (e-mail, push, chat) lives in application code that sends approved drafts to
  configured targets. The model can at most prepare a draft.
- **Cost.** The cap check runs before the call; the real cost is recorded after, also for refusals.
- **Logs.** Model, agent, stop reason, token counts, cost, request id. Never prompts, replies, tool inputs or keys.

## Tests

- Unit tests use a fake client (an object with the same `beta.messages.stream` / `create` shape returning canned
  messages) or recorded responses. CI never needs `ANTHROPIC_API_KEY`.
- Test the paths that are rare in real use: a refusal, `max_tokens` with a `tool_use`, a tool handler that throws,
  invalid tool input, the cap reached, a 529 and a 400.
- A real-API check is opt-in, capped, run by a person, and mentioned in the pull request.
