/**
 * Agent modes (off / shadow / supervised / autonomous), shadow scoring and the promotion check.
 *
 * - setMode is the ONLY way to change a mode: it validates the mode, refuses non-human actors and writes an audit
 *   entry. Nothing in Hermod calls it on its own: promotion is never automatic (a test greps src/ for that).
 * - scoreDraft lets a person score a draft (a shadow proposal or an action proposal): as_is / small_edit / wrong.
 * - shadowStats counts the scored drafts; accuracy = (as_is + smallEditWeight × small_edit) / n.
 * - meetsBar compares the stats with the agent's accuracyBar and minSamples. It only reports; a person decides.
 */
import type { ProposalService } from "../proposals/proposals.js";
import { isNonHumanActor } from "../safety/actors.js";
import type { AgentMode, AgentRecord, DraftScore, Id, ProposalRecord, Storage } from "../types.js";

export const AGENT_MODES: readonly AgentMode[] = Object.freeze(["off", "shadow", "supervised", "autonomous"]);
export const DRAFT_SCORES: readonly DraftScore[] = Object.freeze(["as_is", "small_edit", "wrong"]);
export const DEFAULT_SMALL_EDIT_WEIGHT = 0.5;

/** A mode change or score that is not allowed. Nothing is written when it is thrown. */
export class ModeError extends Error {
  readonly code: "invalid_mode" | "not_allowed" | "not_found" | "not_a_draft" | "invalid_score";
  constructor(code: ModeError["code"], message: string) {
    super(message);
    this.name = "ModeError";
    this.code = code;
  }
}

export function isAgentMode(value: unknown): value is AgentMode {
  return typeof value === "string" && (AGENT_MODES as readonly string[]).includes(value);
}

function assertHuman(by: unknown, what: string): string {
  if (typeof by !== "string" || by.trim() === "") throw new ModeError("not_allowed", `${what} needs the person who does it.`);
  // Actors that are not a person (agent, job, review, system, …, any case) may never change a mode or score a draft.
  if (isNonHumanActor(by)) {
    throw new ModeError("not_allowed", `"${by}" cannot ${what.toLowerCase()}: only a person can.`);
  }
  return by.trim();
}

/** The agent's current mode. Throws ModeError("not_found") for an unknown agent. */
export async function getMode(storage: Storage, agentId: Id): Promise<AgentMode> {
  const agent = await storage.agents.get(agentId);
  if (!agent) throw new ModeError("not_found", `There is no agent "${agentId}".`);
  return agent.mode;
}

/**
 * A person changes the agent's mode. Validates the mode and the actor, writes it and audits the change (from, to,
 * note). Setting the mode it already has writes nothing and returns the agent unchanged.
 */
export async function setMode(
  storage: Storage,
  agentId: Id,
  mode: AgentMode,
  by: string,
  options: { note?: string; now?: () => Date } = {},
): Promise<AgentRecord> {
  if (!isAgentMode(mode)) {
    throw new ModeError("invalid_mode", `${JSON.stringify(mode)} is not a mode; use one of ${AGENT_MODES.join(", ")}.`);
  }
  const actor = assertHuman(by, "Changing a mode");
  const agent = await storage.agents.get(agentId);
  if (!agent) throw new ModeError("not_found", `There is no agent "${agentId}".`);
  if (agent.mode === mode) return agent;
  const updated = await storage.agents.update(agentId, { mode });
  if (!updated) throw new ModeError("not_found", `There is no agent "${agentId}".`);
  await storage.audit.append({
    at: (options.now ?? (() => new Date()))().toISOString(),
    actor,
    action: "agent.mode",
    target: `agent:${agentId}`,
    details: { from: agent.mode, to: mode, note: options.note ?? null },
  });
  return updated;
}

/** A draft a person can score: a proposal made in shadow mode, or a proposed action. */
export function isDraft(proposal: Pick<ProposalRecord, "shadow" | "kind">): boolean {
  return proposal.shadow === true || proposal.kind === "action";
}

/**
 * A person scores a draft. Only shadow proposals and action proposals can be scored. Audited (by the proposal
 * service). Returns null when the proposal does not exist.
 */
export async function scoreDraft(
  proposals: ProposalService,
  proposalId: Id,
  score: DraftScore,
  by: string,
): Promise<ProposalRecord | null> {
  if (!(DRAFT_SCORES as readonly string[]).includes(score)) {
    throw new ModeError("invalid_score", `A score is one of ${DRAFT_SCORES.join(", ")}.`);
  }
  const actor = assertHuman(by, "Scoring a draft");
  const proposal = await proposals.get(proposalId);
  if (!proposal) return null;
  if (!isDraft(proposal)) {
    throw new ModeError("not_a_draft", `Proposal "${proposalId}" is not a draft (only shadow and action proposals are scored).`);
  }
  return proposals.score(proposalId, score, actor);
}

export interface ShadowStats {
  /** Scored drafts counted. */
  n: number;
  asIs: number;
  smallEdit: number;
  wrong: number;
  /** (asIs + smallEditWeight × smallEdit) / n; 0 when n is 0. */
  accuracy: number;
  smallEditWeight: number;
}

/**
 * Counts the agent's scored drafts (newest first; `window` = how many of the newest to count, default all).
 * smallEditWeight (0..1, default 0.5) is how much a small edit counts as right.
 */
export async function shadowStats(
  storage: Storage,
  agentId: Id,
  options: { window?: number; smallEditWeight?: number } = {},
): Promise<ShadowStats> {
  const weight = options.smallEditWeight ?? DEFAULT_SMALL_EDIT_WEIGHT;
  if (typeof weight !== "number" || !(weight >= 0 && weight <= 1)) {
    throw new TypeError("shadowStats: smallEditWeight must be a number from 0 to 1.");
  }
  if (options.window !== undefined && (!Number.isSafeInteger(options.window) || options.window < 1)) {
    throw new TypeError("shadowStats: window must be a whole number, 1 or more.");
  }
  const all = await storage.proposals.list({ agentId });
  const scored = all
    .filter((proposal) => proposal.agentId === agentId && isDraft(proposal) && proposal.score !== null)
    // Storage lists newest first (ties in insertion order); the stable sort keeps that order for equal times.
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const counted = options.window === undefined ? scored : scored.slice(0, options.window);
  let asIs = 0;
  let smallEdit = 0;
  let wrong = 0;
  for (const proposal of counted) {
    if (proposal.score === "as_is") asIs += 1;
    else if (proposal.score === "small_edit") smallEdit += 1;
    else if (proposal.score === "wrong") wrong += 1;
  }
  const n = asIs + smallEdit + wrong;
  return { n, asIs, smallEdit, wrong, accuracy: n === 0 ? 0 : (asIs + weight * smallEdit) / n, smallEditWeight: weight };
}

/**
 * Whether the stats meet the agent's bar: at least minSamples scored drafts (and at least one) and accuracy ≥
 * accuracyBar. It only reports; it never changes the mode.
 */
export function meetsBar(stats: Pick<ShadowStats, "n" | "accuracy">, agent: Pick<AgentRecord, "accuracyBar" | "minSamples">): boolean {
  if (!Number.isFinite(agent.accuracyBar) || !Number.isFinite(agent.minSamples)) return false;
  return stats.n >= Math.max(1, agent.minSamples) && stats.accuracy >= agent.accuracyBar;
}
