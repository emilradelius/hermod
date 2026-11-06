/**
 * The curator (after Hermes): finds skills nobody has used, and reports them.
 *
 * - "Unused for" is measured from lastUsedAt, else createdAt.
 * - Unused ≥ staleDays (14) → stale; unused ≥ archiveDays (30) → archived. A stale skill that was used again
 *   (unused < staleDays) returns to active. An archived skill stays archived: a person restores it.
 * - Pinned skills are exempt. Nothing is ever deleted: only the status flag changes, the version history is untouched.
 * - The agent only proposes: `curate` never writes anything. It returns a report of what it would change.
 *   `applyCuration(storage, report, by)` is the explicit step a person takes to apply that report: it refuses
 *   Hermod's own actors (agent, job, review, system, curator, …; the shared check in src/safety/actors.ts), skips
 *   a change whose skill moved since the report (other status, pinned, used again), and audits every change it
 *   makes under the person's name.
 * - Off means off: for an agent that is off, curate and applyCuration throw AgentOffError before reading a skill
 *   or writing anything. An agent that does not exist is a programming error (TypeError).
 */
import { isNonHumanActor } from "../safety/actors.js";
import { AgentOffError, type Id, type IsoTime, type SkillRecord, type SkillStatus, type Storage } from "../types.js";

export const DEFAULT_STALE_DAYS = 14;
export const DEFAULT_ARCHIVE_DAYS = 30;
const DAY_MS = 86_400_000;

export interface CurateOptions {
  agentId: Id;
  now: Date;
  /** Default 14. */
  staleDays?: number;
  /** Default 30. */
  archiveDays?: number;
  /** Ignored: curate always only reports (kept so older calls still compile). Apply a report with applyCuration. */
  dryRun?: boolean;
}

export interface CuratorChange {
  skillId: Id;
  name: string;
  from: SkillStatus;
  to: SkillStatus;
  /** Whole and fractional days since lastUsedAt (else createdAt). */
  unusedDays: number;
  /** The skill's lastUsedAt when it was checked (applyCuration skips the change if the skill was used since). */
  lastUsedAt: IsoTime | null;
}

export interface CuratorReport {
  agentId: Id;
  at: string;
  checked: number;
  /** What applying the report would change. Nothing has changed yet. */
  changes: CuratorChange[];
  /** Pinned skills (never flagged). */
  exempt: string[];
  /** Names per status once the report is applied. */
  active: string[];
  stale: string[];
  archived: string[];
}

function days(value: unknown, name: string, fallback: number): number {
  const v = value ?? fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new TypeError(`curate: ${name} must be a number above 0.`);
  return v;
}

/** The status a skill should have; null for no change. */
export function curatedStatus(
  skill: Pick<SkillRecord, "status" | "pinned" | "lastUsedAt" | "createdAt">,
  now: Date,
  thresholds: { staleDays: number; archiveDays: number },
): SkillStatus | null {
  if (skill.pinned) return null;
  const since = Date.parse(skill.lastUsedAt ?? skill.createdAt);
  if (!Number.isFinite(since)) return null;
  const unused = now.getTime() - since;
  if (skill.status === "archived") return null;
  if (unused >= thresholds.archiveDays * DAY_MS) return "archived";
  if (unused >= thresholds.staleDays * DAY_MS) return skill.status === "stale" ? null : "stale";
  return skill.status === "stale" ? "active" : null;
}

/**
 * Reports which skills should become stale, archived or active again. Writes nothing (the agent only proposes):
 * a person applies the report with applyCuration.
 */
export async function curate(storage: Storage, options: CurateOptions): Promise<CuratorReport> {
  if (!options || typeof options.agentId !== "string" || options.agentId === "") throw new TypeError("curate: agentId is required.");
  if (!(options.now instanceof Date) || Number.isNaN(options.now.getTime())) throw new TypeError("curate: now must be a valid Date.");
  const staleDays = days(options.staleDays, "staleDays", DEFAULT_STALE_DAYS);
  const archiveDays = days(options.archiveDays, "archiveDays", DEFAULT_ARCHIVE_DAYS);
  if (archiveDays < staleDays) throw new TypeError("curate: archiveDays must be at least staleDays.");

  await requireAgentOn(storage, options.agentId, "curate");
  const skills = await storage.skills.list(options.agentId);
  const report: CuratorReport = {
    agentId: options.agentId,
    at: options.now.toISOString(),
    checked: skills.length,
    changes: [],
    exempt: [],
    active: [],
    stale: [],
    archived: [],
  };
  for (const skill of skills) {
    if (skill.pinned) report.exempt.push(skill.name);
    const next = curatedStatus(skill, options.now, { staleDays, archiveDays });
    if (next !== null) {
      const unusedDays = (options.now.getTime() - Date.parse(skill.lastUsedAt ?? skill.createdAt)) / DAY_MS;
      report.changes.push({
        skillId: skill.id,
        name: skill.name,
        from: skill.status,
        to: next,
        unusedDays,
        lastUsedAt: skill.lastUsedAt,
      });
    }
    report[next ?? skill.status].push(skill.name);
  }
  return report;
}

/** The status changes a curator report can hold; applyCuration refuses any other. */
const CURATOR_TRANSITIONS: ReadonlySet<string> = new Set(["active>stale", "active>archived", "stale>archived", "stale>active"]);

/** A curator report that cannot be applied (not made by curate, or a change the curator never makes). */
export class CurationError extends Error {
  readonly code: "not_allowed" | "invalid_report";
  constructor(code: "not_allowed" | "invalid_report", message: string) {
    super(message);
    this.name = "CurationError";
    this.code = code;
  }
}

export interface CurationResult {
  agentId: Id;
  /** Who applied the report (the person). */
  by: string;
  /** The changes that were made, each with an audit entry. */
  applied: CuratorChange[];
  /** The changes left out because the skill moved since the report. */
  skipped: Array<{ change: CuratorChange; reason: string }>;
}

/**
 * A person applies a curator report: each change is made only if the skill is still as the report saw it (same
 * id and status, not pinned, not used since), and audited (action "skill.status", actor = the person). Refuses
 * Hermod's own actors with CurationError("not_allowed"), and a malformed report with CurationError
 * ("invalid_report") before writing anything.
 */
export async function applyCuration(
  storage: Storage,
  report: CuratorReport,
  by: string,
  options: { now?: () => Date; note?: string } = {},
): Promise<CurationResult> {
  const actor = assertPerson(by);
  const changes = checkReport(report);
  await requireAgentOn(storage, report.agentId, "applyCuration");
  const result: CurationResult = { agentId: report.agentId, by: actor, applied: [], skipped: [] };
  for (const change of changes) {
    const current = await storage.skills.get(report.agentId, change.name);
    const reason = staleReason(current, change);
    if (reason !== null || !current) {
      result.skipped.push({ change, reason: reason ?? "the skill no longer exists" });
      continue;
    }
    const updated = await storage.skills.setStatus(current.id, change.to);
    if (!updated) {
      result.skipped.push({ change, reason: "the skill no longer exists" });
      continue;
    }
    await storage.audit.append({
      at: (options.now ?? (() => new Date()))().toISOString(),
      actor,
      action: "skill.status",
      target: `skill:${current.agentId}/${current.name}`,
      details: {
        skillId: current.id,
        from: change.from,
        to: change.to,
        unusedDays: Math.floor(change.unusedDays),
        lastUsedAt: current.lastUsedAt,
        version: current.version,
        source: "curator",
        reportAt: report.at,
        note: options.note ?? null,
      },
    });
    result.applied.push(change);
  }
  return result;
}

function assertPerson(by: unknown): string {
  if (typeof by !== "string" || by.trim() === "") {
    throw new CurationError("not_allowed", "Applying a curator report needs the person who does it.");
  }
  // The agent only proposes: none of Hermod's own actors (agent, job, review, system, curator, …, in any case)
  // may apply the curator's report.
  if (isNonHumanActor(by)) {
    throw new CurationError("not_allowed", `"${by}" cannot apply a curator report: only a person can.`);
  }
  return by.trim();
}

function checkReport(report: CuratorReport): CuratorChange[] {
  const bad = (why: string) => new CurationError("invalid_report", `This is not a curator report that can be applied: ${why}.`);
  if (typeof report !== "object" || report === null) throw bad("it is not an object");
  if (typeof report.agentId !== "string" || report.agentId === "") throw bad("it names no agent");
  if (!Array.isArray(report.changes)) throw bad("it has no list of changes");
  for (const change of report.changes) {
    if (typeof change !== "object" || change === null || typeof change.name !== "string" || typeof change.skillId !== "string") {
      throw bad("a change names no skill");
    }
    if (!CURATOR_TRANSITIONS.has(`${String(change.from)}>${String(change.to)}`)) {
      throw bad(`the curator never changes a skill from ${JSON.stringify(change.from)} to ${JSON.stringify(change.to)}`);
    }
  }
  return report.changes;
}

/** Why a reported change no longer fits the skill (null when it still does). */
function staleReason(current: SkillRecord | null, change: CuratorChange): string | null {
  if (!current || current.id !== change.skillId) return "the skill no longer exists";
  if (current.status !== change.from) return `the skill is ${current.status} now, not ${change.from}`;
  if (current.pinned) return "the skill is pinned now";
  if ((current.lastUsedAt ?? null) !== (change.lastUsedAt ?? null)) return "the skill was used after the report";
  return null;
}

async function requireAgentOn(storage: Storage, agentId: Id, what: string): Promise<void> {
  const agent = await storage.agents.get(agentId);
  if (!agent) throw new TypeError(`${what}: there is no agent "${agentId}".`);
  if (agent.mode === "off") throw new AgentOffError(agent.id);
}
