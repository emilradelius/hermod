/**
 * Skills (agentskills.io format, as in Claude Code and Hermes): a name, a description whose first sentence is the
 * index line, and a body loaded only when the skill applies (progressive disclosure).
 *
 * - Names: ^[a-z0-9]+(-[a-z0-9]+)*$, at most 64 characters. Descriptions: 1 to 1,024 characters.
 * - Every change is a new version row; nothing is ever deleted (archiving is a status).
 * - Every new text is scanned for prompt injection.
 * - The agent never calls createSkill / patchSkill itself: they run when a person approves a proposal (or from the
 *   app's own code).
 */
import { hasInjectionErrors, scanForInjection } from "../safety/index.js";
import type { Id, SkillChange, SkillRecord, Storage } from "../types.js";
import { SkillError } from "../proposals/errors.js";

export const MAX_SKILL_NAME_CHARS = 64;
export const MAX_SKILL_DESCRIPTION_CHARS = 1024;
/** Index one-liners are at most this long (Hermes's 60). */
export const INDEX_LINE_CHARS = 60;
/** Upper bound for a skill body (characters). */
export const MAX_SKILL_BODY_CHARS = 20_000;

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateSkillName(name: unknown): ValidationResult {
  if (typeof name !== "string" || name === "") return { ok: false, error: "A skill name must not be empty." };
  if (name.length > MAX_SKILL_NAME_CHARS) {
    return { ok: false, error: `A skill name has at most ${MAX_SKILL_NAME_CHARS} characters (got ${name.length}).` };
  }
  if (!SKILL_NAME.test(name)) {
    return {
      ok: false,
      error: "A skill name uses lowercase letters, digits and single hyphens between them (e.g. \"release-notes\").",
    };
  }
  return { ok: true };
}

export function validateSkillDescription(description: unknown): ValidationResult {
  if (typeof description !== "string" || description.trim() === "") {
    return { ok: false, error: "A skill description must not be empty." };
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    return {
      ok: false,
      error: `A skill description has at most ${MAX_SKILL_DESCRIPTION_CHARS} characters (got ${description.length}).`,
    };
  }
  return { ok: true };
}

/**
 * The first sentence of a text, on one line: up to the first ".", "!" or "?" that is followed by whitespace and a
 * character that is not a lowercase letter (so "e.g. this" does not end it), or the whole text.
 */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const match = /^.*?[.!?](?=\s+[^\p{Ll}]|$)/u.exec(flat);
  return match ? match[0] : flat;
}

/** "name: one-liner", the one-liner being the description's first sentence, at most `max` characters. */
export function indexLine(skill: Pick<SkillRecord, "name" | "description">, max = INDEX_LINE_CHARS): string {
  return `${skill.name}: ${truncateWords(firstSentence(skill.description), max)}`;
}

function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(1, max - 1);
  const cut = text.slice(0, room);
  const space = cut.lastIndexOf(" ");
  const base = space >= room / 2 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s,;:.]+$/u, "")}…`;
}

export const SKILLS_INDEX_HEADER = "Skills (load the full skill with skill_view when one applies):";

/** The skills index for the system prompt: active and stale skills (never archived), sorted by name. "" if none. */
export function renderSkillsIndex(skills: readonly SkillRecord[]): string {
  const visible = skills
    .filter((skill) => skill.status === "active" || skill.status === "stale")
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (visible.length === 0) return "";
  return [SKILLS_INDEX_HEADER, ...visible.map((skill) => `- ${indexLine(skill)}`)].join("\n");
}

/** Throws a SkillError when any text has an injection error finding. */
export function assertNoInjection(texts: readonly string[]): void {
  for (const text of texts) {
    const findings = scanForInjection(text);
    if (hasInjectionErrors(findings)) {
      const reasons = [...new Set(findings.filter((f) => f.severity === "error").map((f) => f.message))].join(" ");
      throw new SkillError("injection", `Refused: the text looks like prompt injection. ${reasons}`);
    }
  }
}

/** Throws a SkillError unless a new skill is valid and clean (what createSkill checks before writing). */
export function validateNewSkill(input: { name: string; description: string; body: string }): void {
  assertValidContent(input.name, input.description, input.body);
  assertNoInjection([input.description, input.body]);
}

function assertValidContent(name: string, description: string, body: string): void {
  const nameCheck = validateSkillName(name);
  if (!nameCheck.ok) throw new SkillError("invalid_name", nameCheck.error);
  const descriptionCheck = validateSkillDescription(description);
  if (!descriptionCheck.ok) throw new SkillError("invalid_description", descriptionCheck.error);
  if (typeof body !== "string" || body.trim() === "") throw new SkillError("invalid_body", "A skill body must not be empty.");
  if (body.length > MAX_SKILL_BODY_CHARS) {
    throw new SkillError("invalid_body", `A skill body has at most ${MAX_SKILL_BODY_CHARS} characters (got ${body.length}).`);
  }
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

/**
 * Applies changes to a skill's content in memory (patch: `old` must occur exactly once in the body; add_reference:
 * appends a "## Reference: <title>" section). "create" is not a change to an existing skill. Throws SkillError.
 */
export function applySkillChanges(
  current: Pick<SkillRecord, "name" | "description" | "body">,
  changes: readonly SkillChange[],
): { description: string; body: string } {
  if (!Array.isArray(changes) || changes.length === 0) throw new SkillError("invalid_change", "No changes were given.");
  const description = current.description;
  let body = current.body;
  for (const [index, change] of changes.entries()) {
    const label = `Change ${index + 1}`;
    if (change === null || typeof change !== "object") throw new SkillError("invalid_change", `${label} is not an object.`);
    if (change.change === "patch") {
      if (typeof change.old !== "string" || change.old === "" || typeof change.new !== "string") {
        throw new SkillError("invalid_change", `${label}: a patch needs non-empty "old" text and "new" text.`);
      }
      const count = occurrences(body, change.old);
      if (count === 0) throw new SkillError("patch_not_found", `${label}: the old text does not occur in skill "${current.name}".`);
      if (count > 1) {
        throw new SkillError("patch_ambiguous", `${label}: the old text occurs ${count} times; quote more so it is unique.`);
      }
      assertNoInjection([change.new]);
      const at = body.indexOf(change.old);
      body = body.slice(0, at) + change.new + body.slice(at + change.old.length);
    } else if (change.change === "add_reference") {
      if (typeof change.title !== "string" || change.title.trim() === "" || typeof change.text !== "string" || change.text.trim() === "") {
        throw new SkillError("invalid_change", `${label}: a reference needs a title and text.`);
      }
      const title = change.title.replace(/\s+/gu, " ").trim();
      assertNoInjection([title, change.text]);
      body = `${body.trimEnd()}\n\n## Reference: ${title}\n\n${change.text.trim()}\n`;
    } else if (change.change === "create") {
      throw new SkillError("exists", `${label}: skill "${current.name}" already exists; propose a patch instead.`);
    } else {
      throw new SkillError("invalid_change", `${label}: unknown change ${JSON.stringify((change as { change?: unknown }).change)}.`);
    }
  }
  assertValidContent(current.name, description, body);
  return { description, body };
}

/**
 * Thrown by SkillService.patchSkill when the skill kept changing while the change was being written (its version
 * moved twice). Nothing was written. A proposal whose apply failed this way is marked rejected with this reason, so
 * the change has to be proposed again (on the latest version).
 */
export class SkillConflictError extends Error {
  readonly code = "conflict" as const;
  readonly skill: string;
  constructor(name: string) {
    super(`Skill "${name}" changed twice while this change was being written; nothing was saved. Propose the change again.`);
    this.name = "SkillConflictError";
    this.skill = name;
  }
}

export interface SkillServiceOptions {
  storage: Storage;
  now?: () => Date;
}

export interface SkillMeta {
  /** Who made the change: "user:<id>", "system", … (recorded on the version row and in the audit). */
  actor: string;
  proposalId?: Id | null;
}

export class SkillService {
  readonly #storage: Storage;
  readonly #now: () => Date;

  constructor(options: SkillServiceOptions) {
    this.#storage = options.storage;
    this.#now = options.now ?? (() => new Date());
  }

  /** Skills sorted by name; archived ones only with includeArchived. */
  async list(agentId: Id, options: { includeArchived?: boolean } = {}): Promise<SkillRecord[]> {
    const skills = await this.#storage.skills.list(agentId);
    return skills.filter((skill) => options.includeArchived || skill.status !== "archived");
  }

  /** Reads a skill without counting it (null when missing or archived, unless includeArchived). */
  async get(agentId: Id, name: string, options: { includeArchived?: boolean } = {}): Promise<SkillRecord | null> {
    const skill = await this.#storage.skills.get(agentId, name);
    if (!skill || (skill.status === "archived" && !options.includeArchived)) return null;
    return skill;
  }

  /** Loads a skill for the model: bumps views and uses and sets lastUsedAt. Archived skills are not visible. */
  async view(agentId: Id, name: string): Promise<SkillRecord | null> {
    const skill = await this.get(agentId, name);
    if (!skill) return null;
    const at = this.#now().toISOString();
    await this.#storage.skills.bump(skill.id, "views", at);
    await this.#storage.skills.bump(skill.id, "uses", at);
    return (await this.#storage.skills.get(agentId, name)) ?? skill;
  }

  /** A skill attached to a run (scheduled job): bumps uses and sets lastUsedAt. */
  async use(agentId: Id, name: string): Promise<SkillRecord | null> {
    const skill = await this.get(agentId, name);
    if (!skill) return null;
    await this.#storage.skills.bump(skill.id, "uses", this.#now().toISOString());
    return (await this.#storage.skills.get(agentId, name)) ?? skill;
  }

  /** Creates a skill (validated and scanned). Throws SkillError. Audited. */
  async createSkill(
    agentId: Id,
    input: { name: string; description: string; body: string; pinned?: boolean },
    meta: SkillMeta,
  ): Promise<SkillRecord> {
    validateNewSkill(input);
    if (await this.#storage.skills.get(agentId, input.name)) {
      throw new SkillError("exists", `A skill named "${input.name}" already exists; propose a patch instead.`);
    }
    // The first version row has no proposal id (storage.skills.create takes none); the audit entry links the
    // approval that created the skill.
    const skill = await this.#storage.skills.create({
      agentId,
      name: input.name,
      description: input.description,
      body: input.body,
      createdBy: meta.actor,
      pinned: input.pinned ?? false,
    });
    await this.#audit(meta.actor, "skill.create", agentId, input.name, {
      skillId: skill.id,
      version: skill.version,
      proposalId: meta.proposalId ?? null,
    });
    return skill;
  }

  /**
   * Applies one or more changes as ONE new version (bumps "patches"). The skill is named by agent and name (the
   * storage contract has no lookup by id). Archived skills are patched too (a person may be restoring one).
   */
  async patchSkill(
    ref: { agentId: Id; name: string },
    change: SkillChange | readonly SkillChange[],
    meta: SkillMeta,
  ): Promise<SkillRecord> {
    const changes: readonly SkillChange[] = Array.isArray(change) ? change : [change as SkillChange];
    const versionMeta = { createdBy: meta.actor, proposalId: meta.proposalId ?? null };
    let skill: SkillRecord | null = null;
    let updated: SkillRecord | null = null;
    // Compare-and-set on the version: a change computed from a version that moved meanwhile (another approval
    // landed first) is not written. It is computed again once on a fresh read, so both changes are kept, or it
    // fails (patch_not_found when the other change removed the text it patches). Never loses a change silently.
    for (let attempt = 0; attempt < 2 && updated === null; attempt++) {
      skill = await this.#storage.skills.get(ref.agentId, ref.name);
      if (!skill) throw new SkillError("not_found", `There is no skill named "${ref.name}".`);
      const next = applySkillChanges(skill, changes);
      updated = await this.#storage.skills.update(skill.id, next, versionMeta, skill.version);
    }
    if (!skill) throw new SkillError("not_found", `There is no skill named "${ref.name}".`);
    if (!updated) {
      if (!(await this.#storage.skills.get(ref.agentId, ref.name))) {
        throw new SkillError("not_found", `There is no skill named "${ref.name}".`);
      }
      throw new SkillConflictError(ref.name);
    }
    const at = this.#now().toISOString();
    await this.#storage.skills.bump(skill.id, "patches", at);
    await this.#audit(meta.actor, "skill.patch", ref.agentId, ref.name, {
      skillId: skill.id,
      version: updated.version,
      changes: changes.map((c) => c.change),
      proposalId: meta.proposalId ?? null,
    });
    return (await this.#storage.skills.get(ref.agentId, ref.name)) ?? updated;
  }

  async #audit(actor: string, action: string, agentId: Id, name: string, details: Record<string, unknown>): Promise<void> {
    await this.#storage.audit.append({
      at: this.#now().toISOString(),
      actor,
      action,
      target: `skill:${agentId}/${name}`,
      details,
    });
  }
}
