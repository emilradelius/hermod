# Prompt caching layout

The API caches the longest matching prefix. Render order is `tools`, then `system`, then `messages`, so anything
that changes early in that order makes everything after it a cache miss.

## Layout

```ts
import Anthropic from '@anthropic-ai/sdk';

export function buildRequest(): Anthropic.Beta.MessageCreateParamsNonStreaming {
  return {
    model: 'claude-opus-5-5',
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium' }, // changing effort between calls invalidates the cache: pin it per route
    tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)), // 1. tools: same set, same order, every call
    system: [{ type: 'text', text: STABLE_SYSTEM, cache_control: { type: 'ephemeral' } }], // 2. breakpoint on the last system block
    cache_control: { type: 'ephemeral' }, // 3. automatic breakpoint for the growing tail
    messages: [...history, { role: 'system', content: todayContext }, { role: 'user', content: 'Next task…' }], // 4. dynamic text goes late
  };
}
```

1. **Stable first.** Tools sorted and unchanged for the whole session; a frozen system prompt with no dates, ids,
   user names or modes. Do not change model, tools, thinking or effort mid-conversation.
2. **Dynamic last.** Today's date, the user's settings, retrieved documents: in an appended `role: 'system'`
   message or in the user turn.
3. **Breakpoints.** One explicit `cache_control` on the last system block plus the top-level `cache_control` for
   the tail. At most 4 breakpoints per request, and the automatic one uses a slot. With the 1-hour TTL, set
   `ttl: '1h'` on both, and longer TTLs must come before shorter ones.
4. **Prefix size.** The minimum cacheable prefix is 512 tokens; a shorter one silently does not cache.
5. **Lookback.** The cache looks back about 20 block positions from a breakpoint. A turn that adds more than about
   15 positions needs an extra breakpoint.
6. **Fan-out.** A cache entry becomes readable when the first response starts streaming. For N parallel calls with
   the same prefix, send one, wait for its first token, then send the rest.
7. **TTL.** Use the default 5 minutes when calls sharing a prefix come less than 5 minutes apart; `1h` only for gaps of
   5 to 60 minutes (a 1-hour write costs 2x base input, a 5-minute write 1.25x).

## Verify it

```ts
// Log this after every call while you change prompt assembly.
export function cacheReport(u: Anthropic.Beta.BetaUsage) {
  const read = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const prompt = u.input_tokens + written + read; // input_tokens is only the uncached remainder
  return { prompt, read, written, hitRate: prompt === 0 ? 0 : read / prompt };
}
```

A healthy loop shows `cache_read_input_tokens` growing turn by turn and `cache_creation_input_tokens` close to the
size of the newest turn only. If every call writes the whole prompt again, something early in the prompt changes:
look for a timestamp, a random id, an unsorted tool list or a per-user string in the system prompt.

Caches are per model and per workspace: a fallback or a model switch starts cold.
