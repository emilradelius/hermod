/**
 * The review inbox. Agents (and the post-session review) create proposals; a person approves, rejects or scores
 * them. Approval applies the change:
 * - memory: the batch is re-validated against the CURRENT store content and written with the version check; if it
 *   no longer applies the proposal is marked rejected with the reason;
 * - skill: the changes become a new version (or the skill is created);
 * - action: `executeAction` runs it when the app provides one; otherwise the proposal stays approved for the app.
 * A draft made in shadow mode (shadow: true, any kind) is never approved: it is scored, not run. approve throws
 * ProposalRefusedError("not_allowed") for it and changes nothing. Only a person decides: none of Hermod's own
 * actors (agent, job, review, system, curator, scheduler, delegate, in any case; see src/safety/actors.ts) may.
 * Every transition is a compare-and-set, so a proposal is never applied twice, and every transition is audited.
 */
import type {
  DraftScore,
  Id,
  NewProposal,
  ProposalKind,
  ProposalRecord,
  ProposalStatus,
  SkillChange,
  Storage,
} from "../types.js";
import type { MemoryService } from "../memory/memory.js";
import { applySkillChanges, validateNewSkill, validateSkillName, type SkillService } from "../skills/skills.js";
import { isNonHumanActor } from "../safety/actors.js";
import { ProposalRefusedError, SkillError, errorText } from "./errors.js";
import { recordProposal } from "./record.js";

const DRAFT_SCORES: readonly DraftScore[] = ["as_is", "small_edit", "wrong"];

export interface ProposalServiceOptions {
  storage: Storage;
  memory: MemoryService;
  skills: SkillService;
  /** Runs an approved action proposal. Without it, approved actions stay "approved" for the app to run. */
  executeAction?: (payload: Extract<ProposalRecord["payload"], { kind: "action" }>, proposal: ProposalRecord) => Promise<unknown>;
  now?: () => Date;
}

export class ProposalService {
  readonly #storage: Storage;
  readonly #memory: MemoryService;
  readonly #skills: SkillService;
  readonly #executeAction: ProposalServiceOptions["executeAction"];
  readonly #now: () => Date;

  constructor(options: ProposalServiceOptions) {
    this.#storage = options.storage;
    this.#memory = options.memory;
    this.#skills = options.skills;
    this.#executeAction = options.executeAction;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Stores a pending proposal after checking that it could apply now (memory batch valid against the current
   * content; skill changes valid against the current skill), that its evidence verifies (required with
   * requireGrounding, and checked whenever evidence is given), and that no text in it looks like prompt injection.
   * Throws ProposalRefusedError; nothing is stored then.
   */
  async create(proposal: NewProposal, options: { requireGrounding?: boolean } = {}): Promise<ProposalRecord> {
    const payload = proposal?.payload;
    if (payload?.kind === "memory") {
      const preview = await this.#memory.preview(proposal.agentId, payload.store, payload.ops);
      if (!preview.ok) throw new ProposalRefusedError(refusalCode(preview.error.code), [preview.error.message]);
    } else if (payload?.kind === "skill") {
      await this.#checkSkillChanges(proposal.agentId, payload.skill, payload.changes);
    } else if (payload?.kind === "action") {
      if (typeof payload.tool !== "string" || payload.tool === "") {
        throw new ProposalRefusedError("invalid", ["An action proposal needs a tool name."]);
      }
    } else {
      throw new ProposalRefusedError("invalid", ["Unknown proposal kind."]);
    }
    return recordProposal(this.#storage, proposal, { requireGrounding: options.requireGrounding ?? false, now: this.#now });
  }

  get(id: Id): Promise<ProposalRecord | null> {
    return this.#storage.proposals.get(id);
  }

  list(options?: { agentId?: Id; status?: ProposalStatus; kind?: ProposalKind; sessionId?: Id; limit?: number }): Promise<ProposalRecord[]> {
    return this.#storage.proposals.list(options);
  }

  /**
   * A person approves: pending → approved, then the change is applied (→ applied), or marked rejected with the
   * reason when it no longer applies. Returns null when the proposal does not exist or is not pending (so a second
   * approval does nothing). Throws when `by` is not a person, and ProposalRefusedError("not_allowed") for a shadow
   * draft (nothing changes).
   */
  async approve(id: Id, by: string, note?: string): Promise<ProposalRecord | null> {
    assertHuman(by);
    // A draft made in shadow mode is scored, never run: approving it would apply what shadow mode promised not to.
    // (shadow is set when a proposal is created and never changes, so one read is enough.)
    const current = await this.#storage.proposals.get(id);
    if (current?.shadow === true) throw shadowRefusal(id);
    const approved = await this.#storage.proposals.transition(id, ["pending"], "approved", {
      at: this.#iso(),
      by,
      note: note ?? null,
    });
    if (!approved) return null;
    await this.#audit(by, "proposal.approve", approved, { note: note ?? null });

    let outcome: { ok: true; details?: Record<string, unknown> } | { ok: false; reason: string } | { ok: "waiting" };
    try {
      outcome = await this.#apply(approved, by);
    } catch (error) {
      outcome = { ok: false, reason: errorText(error) };
    }
    if (outcome.ok === "waiting") return approved;
    if (outcome.ok) {
      const applied = await this.#storage.proposals.transition(id, ["approved"], "applied", {
        at: this.#iso(),
        by,
        note: note ?? null,
      });
      if (!applied) return this.#storage.proposals.get(id);
      await this.#audit(by, "proposal.apply", applied, outcome.details ?? {});
      return applied;
    }
    const rejected = await this.#storage.proposals.transition(id, ["approved"], "rejected", {
      at: this.#iso(),
      by,
      note: `Could not apply: ${outcome.reason}`,
    });
    if (!rejected) return this.#storage.proposals.get(id);
    await this.#audit(by, "proposal.apply_failed", rejected, { reason: outcome.reason });
    return rejected;
  }

  /** The app ran an approved action itself: approved → applied. Null unless it was approved. */
  async markApplied(id: Id, by: string, note?: string): Promise<ProposalRecord | null> {
    assertHuman(by);
    const applied = await this.#storage.proposals.transition(id, ["approved"], "applied", {
      at: this.#iso(),
      by,
      note: note ?? null,
    });
    if (applied) await this.#audit(by, "proposal.apply", applied, { by: "app" });
    return applied;
  }

  /** A person rejects: pending → rejected. Null when it was not pending. */
  async reject(id: Id, by: string, note?: string): Promise<ProposalRecord | null> {
    assertHuman(by);
    const rejected = await this.#storage.proposals.transition(id, ["pending"], "rejected", {
      at: this.#iso(),
      by,
      note: note ?? null,
    });
    if (rejected) await this.#audit(by, "proposal.reject", rejected, { note: note ?? null });
    return rejected;
  }

  /** A person scores a (shadow) draft. Null when the proposal does not exist. */
  async score(id: Id, score: DraftScore, by = "user"): Promise<ProposalRecord | null> {
    assertHuman(by);
    if (!DRAFT_SCORES.includes(score)) {
      throw new ProposalRefusedError("invalid", [`A score is one of ${DRAFT_SCORES.join(", ")}.`]);
    }
    const scored = await this.#storage.proposals.setScore(id, score);
    if (scored) await this.#audit(by, "proposal.score", scored, { score });
    return scored;
  }

  async #apply(
    proposal: ProposalRecord,
    by: string,
  ): Promise<{ ok: true; details?: Record<string, unknown> } | { ok: false; reason: string } | { ok: "waiting" }> {
    const payload = proposal.payload;
    switch (payload.kind) {
      case "memory": {
        const outcome = await this.#memory.applyProposal(proposal, by);
        return outcome.ok
          ? { ok: true, details: { store: payload.store, version: outcome.store.version } }
          : { ok: false, reason: outcome.error.message };
      }
      case "skill": {
        const skill = await this.#applySkill(proposal, payload.skill, payload.changes, by);
        return { ok: true, details: { skill: skill.name, version: skill.version } };
      }
      case "action": {
        if (!this.#executeAction) return { ok: "waiting" };
        await this.#executeAction(payload, proposal);
        return { ok: true, details: { tool: payload.tool } };
      }
      default:
        return { ok: false, reason: "Unknown proposal kind." };
    }
  }

  async #applySkill(proposal: ProposalRecord, name: string, changes: SkillChange[], by: string) {
    const meta = { actor: by, proposalId: proposal.id };
    const [first] = changes;
    if (changes.length === 1 && first?.change === "create") {
      return this.#skills.createSkill(proposal.agentId, { name, description: first.description, body: first.body }, meta);
    }
    return this.#skills.patchSkill({ agentId: proposal.agentId, name }, changes, meta);
  }

  async #checkSkillChanges(agentId: Id, name: string, changes: SkillChange[]): Promise<void> {
    const nameCheck = validateSkillName(name);
    if (!nameCheck.ok) throw new ProposalRefusedError("invalid", [nameCheck.error]);
    if (!Array.isArray(changes) || changes.length === 0) {
      throw new ProposalRefusedError("invalid", ["A skill proposal needs at least one change."]);
    }
    const existing = await this.#skills.get(agentId, name, { includeArchived: true });
    try {
      if (existing) {
        applySkillChanges(existing, changes);
        return;
      }
      const [first] = changes;
      if (changes.length !== 1 || first?.change !== "create") {
        throw new SkillError("not_found", `There is no skill named "${name}"; to make one, propose a single "create" change.`);
      }
      validateNewSkill({ name, description: first.description, body: first.body });
    } catch (error) {
      if (error instanceof SkillError) {
        throw new ProposalRefusedError(error.code === "injection" ? "injection" : "not_applicable", [error.message]);
      }
      throw error;
    }
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  async #audit(actor: string, action: string, proposal: ProposalRecord, details: Record<string, unknown>): Promise<void> {
    await this.#storage.audit.append({
      at: this.#iso(),
      actor,
      action,
      target: `proposal:${proposal.id}`,
      details: { kind: proposal.kind, target: proposal.target, status: proposal.status, ...details },
    });
  }
}

function assertHuman(by: string): void {
  if (typeof by !== "string" || by.trim() === "") {
    throw new ProposalRefusedError("not_allowed", ["A decision needs the person who made it."]);
  }
  // The agent only proposes: none of Hermod's own actors (agent, job, review, system, curator, scheduler, delegate,
  // in any case) may decide a proposal.
  if (isNonHumanActor(by)) {
    throw new ProposalRefusedError("not_allowed", [`"${by}" cannot decide proposals: the agent only proposes; a person decides.`]);
  }
}

function shadowRefusal(id: Id): ProposalRefusedError {
  return new ProposalRefusedError("not_allowed", [
    `Proposal "${id}" is a shadow draft: a shadow draft is scored, not run (score it with scoreDraft instead).`,
  ]);
}

function refusalCode(code: string): "injection" | "not_applicable" | "invalid" {
  if (code === "injection") return "injection";
  if (code === "invalid_op" || code === "no_ops" || code === "too_many_ops") return "invalid";
  return "not_applicable";
}
