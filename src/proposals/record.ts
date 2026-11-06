/**
 * The one place a proposal row is written: shape check, grounding, injection scan, store, audit. MemoryService and
 * ProposalService both use it (it depends only on storage and the safety scanner, so there is no import cycle).
 */
import { hasInjectionErrors, scanForInjection } from "../safety/index.js";
import type { Evidence, NewProposal, ProposalRecord, Storage } from "../types.js";
import { ProposalRefusedError } from "./errors.js";
import { MAX_EVIDENCE_ITEMS, verifyEvidence } from "./evidence.js";

export interface RecordProposalOptions {
  /** The evidence must verify (at least one item, quotes found in their messages). */
  requireGrounding?: boolean;
  now: () => Date;
}

/** Every string inside a value (object keys included), depth-first. */
export function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 32) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out, depth + 1);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectStrings(item, out, depth + 1);
    }
  }
  return out;
}

/** Injection findings (errors only) over a list of texts, as plain sentences. */
export function injectionProblems(texts: readonly string[]): string[] {
  const problems: string[] = [];
  for (const text of texts) {
    const findings = scanForInjection(text);
    if (!hasInjectionErrors(findings)) continue;
    for (const finding of findings) {
      if (finding.severity === "error") problems.push(`${finding.message} (${finding.id})`);
    }
  }
  return [...new Set(problems)];
}

function targetOf(proposal: NewProposal): string | null {
  const payload = proposal.payload;
  switch (payload.kind) {
    case "memory":
      return payload.store;
    case "skill":
      return payload.skill;
    case "action":
      return payload.tool;
    default:
      return null;
  }
}

/** Validates, grounds, scans and stores a new proposal (status pending), then audits it. Throws ProposalRefusedError. */
export async function recordProposal(
  storage: Storage,
  proposal: NewProposal,
  options: RecordProposalOptions,
): Promise<ProposalRecord> {
  if (proposal === null || typeof proposal !== "object" || proposal.payload === null || typeof proposal.payload !== "object") {
    throw new ProposalRefusedError("invalid", ["A proposal needs a payload."]);
  }
  if (proposal.payload.kind !== proposal.kind) {
    throw new ProposalRefusedError("invalid", [
      `The payload kind ${JSON.stringify(proposal.payload.kind)} does not match the proposal kind ${JSON.stringify(proposal.kind)}.`,
    ]);
  }
  const target = targetOf(proposal);
  if (target === null || target !== proposal.target) {
    throw new ProposalRefusedError("invalid", [
      `The proposal target ${JSON.stringify(proposal.target)} does not match its payload (${JSON.stringify(target)}).`,
    ]);
  }
  const evidence: Evidence[] = Array.isArray(proposal.evidence) ? proposal.evidence : [];
  if (!Array.isArray(proposal.evidence)) throw new ProposalRefusedError("invalid", ["Evidence must be a list."]);
  if (evidence.length > MAX_EVIDENCE_ITEMS) {
    throw new ProposalRefusedError("invalid", [`Too much evidence: at most ${MAX_EVIDENCE_ITEMS} items.`]);
  }
  if (options.requireGrounding || evidence.length > 0) {
    const check = await verifyEvidence(storage, evidence, { agentId: proposal.agentId });
    if (!check.ok) throw new ProposalRefusedError("ungrounded", check.problems);
  }
  // Quotes are not scanned: they are verified excerpts of stored messages, i.e. data, and may legitimately show
  // the very text that was suspicious. Everything that would become memory, a skill or an action is scanned.
  const problems = injectionProblems([...collectStrings(proposal.payload), String(proposal.rationale ?? "")]);
  if (problems.length > 0) throw new ProposalRefusedError("injection", problems);

  const record = await storage.proposals.create(proposal);
  await storage.audit.append({
    at: options.now().toISOString(),
    actor: record.createdBy,
    action: "proposal.create",
    target: `proposal:${record.id}`,
    details: {
      kind: record.kind,
      target: record.target,
      agentId: record.agentId,
      sessionId: record.sessionId,
      evidence: record.evidence.length,
      shadow: record.shadow,
    },
  });
  return record;
}
