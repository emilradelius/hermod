/**
 * The `session_search` tool: full-text search over this agent's past sessions (no model call). It returns the
 * matching message snippets with their session ids, and the top session's messages in full (each truncated).
 *
 * Past messages can contain text that came from outside (web pages, files, tool output), so the output is marked
 * untrusted: the loop wraps it and the session counts as tainted afterwards.
 */
import { z } from "zod";
import type { MessageRecord, SearchHit, Storage, ToolDef } from "../../types.js";

export const MAX_SEARCH_LIMIT = 10;
export const MAX_MESSAGE_CHARS = 2_000;
export const MAX_RESULT_CHARS = 12_000;

export const sessionSearchInput = z.object({
  query: z.string().min(1).max(500).describe("Plain words to look for (no special syntax)."),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional().describe(`Matches to return (default 5, at most ${MAX_SEARCH_LIMIT}).`),
});

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = `… [truncated, ${text.length - max} more characters]`;
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function hitLine(hit: SearchHit): string {
  return `- session ${hit.sessionId}, message ${hit.messageId} (#${hit.seq}, ${hit.role}, ${hit.createdAt}): ${truncate(oneLine(hit.snippet), 400)}`;
}

function messageBlock(message: MessageRecord): string {
  return `[#${message.seq} ${message.role} ${message.id}]\n${truncate(message.text, MAX_MESSAGE_CHARS)}`;
}

/** Builds the tool's text from hits and the top session's messages, within MAX_RESULT_CHARS. */
export function formatSearchResult(query: string, hits: readonly SearchHit[], topMessages: readonly MessageRecord[]): string {
  const top = hits[0];
  if (top === undefined) return `No past messages match ${JSON.stringify(truncate(oneLine(query), 200))}.`;
  const header = `Matches (${hits.length}):`;
  const parts: string[] = [header];
  let size = header.length;
  const add = (part: string): boolean => {
    if (size + 1 + part.length > MAX_RESULT_CHARS) return false;
    parts.push(part);
    size += 1 + part.length;
    return true;
  };
  for (const hit of hits) if (!add(hitLine(hit))) break;
  const note = (left: number) => `… [${left} more messages of session ${top.sessionId} left out; the result is limited to ${MAX_RESULT_CHARS} characters]`;
  if (topMessages.length > 0) {
    const reserve = note(topMessages.length).length + 1;
    if (size + 1 + reserve < MAX_RESULT_CHARS) {
      add(`\nTop session ${top.sessionId} in full (${topMessages.length} messages):`);
      for (const [index, message] of topMessages.entries()) {
        const block = messageBlock(message);
        const remaining = topMessages.length - index;
        if (size + 1 + block.length + 1 + reserve > MAX_RESULT_CHARS) {
          add(note(remaining));
          break;
        }
        add(block);
      }
    }
  }
  const out = parts.join("\n");
  return out.length <= MAX_RESULT_CHARS ? out : truncate(out, MAX_RESULT_CHARS);
}

export function makeSessionSearchTool(storage: Storage): ToolDef<typeof sessionSearchInput> {
  return {
    name: "session_search",
    description: [
      "Search your past sessions with plain words. Returns matching messages (with session and message ids, which",
      "you can cite as evidence) and the best-matching session in full. Use it to recall what was decided or done",
      "before; it does not search the current session.",
    ].join(" "),
    input: sessionSearchInput,
    readOnly: true,
    capabilities: ["read"],
    untrustedOutput: true,
    async run(input, ctx) {
      const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, input.limit ?? 5));
      const hits = await storage.messages.search(input.query, {
        agentId: ctx.agentId,
        excludeSessionId: ctx.sessionId,
        limit,
      });
      const top = hits[0];
      const topMessages = top ? await storage.messages.list(top.sessionId) : [];
      return formatSearchResult(input.query, hits.slice(0, limit), topMessages);
    },
  };
}
