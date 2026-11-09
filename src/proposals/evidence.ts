/**
 * Grounding checks for proposals. A proposal cites evidence; a message or tool-result quote must really occur in
 * the stored message it names, so a reviewer (or the agent) cannot invent a reason for a change.
 */
import type { Evidence, Id, Storage } from "../types.js";

/** Longest quote accepted (characters, after whitespace normalisation). */
export const MAX_QUOTE_CHARS = 300;
/** Most evidence items one proposal may cite (bounds the reads). */
export const MAX_EVIDENCE_ITEMS = 20;

const EVIDENCE_KINDS: readonly Evidence["kind"][] = ["message", "tool_result", "commit", "test", "log"];

export interface EvidenceCheck {
  ok: boolean;
  /** One plain sentence per problem; empty when ok. */
  problems: string[];
}

/** Collapses every run of whitespace to one space and trims. Case is kept: matching is case-sensitive. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Verifies evidence. Message and tool-result items must name a stored message whose text contains the quote (after
 * whitespace normalisation, case-sensitive; at most 300 characters). Commit, test and log items are accepted as
 * references but need a non-empty ref. An empty list is not grounding and fails. With `agentId`, a cited message
 * must belong to a session of that agent.
 */
export async function verifyEvidence(
  storage: Storage,
  evidence: readonly Evidence[],
  options: { agentId?: Id } = {},
): Promise<EvidenceCheck> {
  const problems: string[] = [];
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { ok: false, problems: ["No evidence was given; cite the message that shows this."] };
  }
  if (evidence.length > MAX_EVIDENCE_ITEMS) {
    return { ok: false, problems: [`Too much evidence: at most ${MAX_EVIDENCE_ITEMS} items.`] };
  }
  const sessionAgents = new Map<Id, Id | null>();
  for (const [index, item] of evidence.entries()) {
    const label = `Evidence ${index + 1}`;
    if (item === null || typeof item !== "object") {
      problems.push(`${label} is not an object.`);
      continue;
    }
    const kind: unknown = item.kind;
    if (typeof kind !== "string" || !(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
      problems.push(`${label} has an unknown kind ${JSON.stringify(kind)}.`);
      continue;
    }
    const ref = typeof item.ref === "string" ? item.ref.trim() : "";
    if (ref === "") {
      problems.push(`${label} (${kind}) has no ref.`);
      continue;
    }
    if (kind !== "message" && kind !== "tool_result") continue;

    const quote = typeof item.quote === "string" ? normalizeWhitespace(item.quote) : "";
    if (quote === "") {
      problems.push(`${label} (${kind} ${ref}) has no quote; quote the words in that message that show this.`);
      continue;
    }
    if (quote.length > MAX_QUOTE_CHARS) {
      problems.push(`${label} quote is ${quote.length} characters; the limit is ${MAX_QUOTE_CHARS}.`);
      continue;
    }
    const message = await storage.messages.get(ref);
    if (!message) {
      problems.push(`${label}: there is no message with id "${ref}".`);
      continue;
    }
    if (options.agentId !== undefined) {
      if (!sessionAgents.has(message.sessionId)) {
        const session = await storage.sessions.get(message.sessionId);
        sessionAgents.set(message.sessionId, session ? session.agentId : null);
      }
      if (sessionAgents.get(message.sessionId) !== options.agentId) {
        problems.push(`${label}: message "${ref}" belongs to another agent.`);
        continue;
      }
    }
    if (!normalizeWhitespace(message.text).includes(quote)) {
      problems.push(`${label}: the quote does not occur in message "${ref}"; quote it word for word.`);
    }
  }
  return { ok: problems.length === 0, problems };
}
