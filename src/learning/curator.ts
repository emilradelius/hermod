/**
 * The curator (after Hermes): flags skills nobody has used.
 *
 * - "Unused for" is measured from lastUsedAt, else createdAt.
 * - Unused ≥ staleDays (14) → stale; unused ≥ archiveDays (30) → archived. A stale skill that was used again
 *   (unused < staleDays) returns to active. An archived skill stays archived: a person restores it.
 * - Pinned skills are exempt. Nothing is ever deleted: only the status flag changes, the version history is untouched.
 * - Every status change writes an audit entry. With dryRun nothing is written; the report says what would change.
 * - Off means off: for an agent that is off, curate throws AgentOffError before reading a skill or writing anything
 *   (also in a dry run). An agent that does not exist is a programming error (TypeError).
 */
import { AgentOffError, type Id, type SkillRecord, type SkillStatus, type Storage } from "../types.js";

export const DEFAULT_STALE_DAYS = 14;
export const DEFAULT_ARCHIVE_DAYS = 30;
export const CURATOR_ACTOR = "system";
const DAY_MS = 86_400_000;

export interface CurateOptions {
  agentId: Id;
  now: Date;
  /** Default 14. */
  staleDays?: number;
  /** Default 30. */
  archiveDays?: number;
  /** Report only; write nothing. */
  dryRun?: boolean;
}

export interface CuratorChange {
  skillId: Id;
  name: string;
  from: SkillStatus;
  to: SkillStatus;
  /** Whole and fractional days since lastUsedAt (else createdAt). */
  unusedDays: number;
}

export interface CuratorReport {
  agentId: Id;
  at: string;
  dryRun: boolean;
  checked: number;
  changes: CuratorChange[];
  /** Pinned skills (never flagged). */
  exempt: string[];
  /** Names per status after the run (what it would be, in a dry run). */
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

export async function curate(storage: Storage, options: CurateOptions): Promise<CuratorReport> {
  if (!options || typeof options.agentId !== "string" || options.agentId === "") throw new TypeError("curate: agentId is required.");
  if (!(options.now instanceof Date) || Number.isNaN(options.now.getTime())) throw new TypeError("curate: now must be a valid Date.");
  const staleDays = days(options.staleDays, "staleDays", DEFAULT_STALE_DAYS);
  const archiveDays = days(options.archiveDays, "archiveDays", DEFAULT_ARCHIVE_DAYS);
  if (archiveDays < staleDays) throw new TypeError("curate: archiveDays must be at least staleDays.");
  const dryRun = options.dryRun === true;
  const at = options.now.toISOString();

  const agent = await storage.agents.get(options.agentId);
  if (!agent) throw new TypeError(`curate: there is no agent "${options.agentId}".`);
  if (agent.mode === "off") throw new AgentOffError(agent.id);

  const skills = await storage.skills.list(options.agentId);
  const report: CuratorReport = {
    agentId: options.agentId,
    at,
    dryRun,
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
    let status = skill.status;
    if (next !== null) {
      const unusedDays = (options.now.getTime() - Date.parse(skill.lastUsedAt ?? skill.createdAt)) / DAY_MS;
      const change: CuratorChange = { skillId: skill.id, name: skill.name, from: skill.status, to: next, unusedDays };
      if (dryRun) {
        report.changes.push(change);
        status = next;
      } else {
        const updated = await storage.skills.setStatus(skill.id, next);
        if (updated) {
          await storage.audit.append({
            at,
            actor: CURATOR_ACTOR,
            action: "skill.status",
            target: `skill:${skill.agentId}/${skill.name}`,
            details: {
              skillId: skill.id,
              from: skill.status,
              to: next,
              unusedDays: Math.floor(unusedDays),
              lastUsedAt: skill.lastUsedAt,
              version: skill.version,
              by: "curator",
            },
          });
          report.changes.push(change);
          status = updated.status;
        }
      }
    }
    report[status].push(skill.name);
  }
  return report;
}
