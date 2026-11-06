// @ts-check
/**
 * Stop hook: the end-of-session ritual.
 *
 * When a session changed code but not the files the repository requires (by default docs/PROGRESS.md), or a
 * repository check fails, or a lessons or skill file changed this session is invalid, it asks Claude to finish
 * the job before stopping: stdout {"decision":"block","reason":"..."} and exit 0. Otherwise no output, exit 0.
 *
 * It can never loop:
 * - it does nothing when stop_hook_active is true (Claude is already continuing because of a Stop hook);
 * - it blocks at most once per reason: every reason key that caused a block is saved in
 *   .local/sessions/<id>/stop.json (written before the block is printed), and a later Stop blocks only when a
 *   reason is new; a check's key is its id, so a failing check whose message changes does not block twice;
 *   and it blocks at most ritual.maxBlocksPerSession times per session;
 * - any error is logged to .local/errors.log and the hook exits 0 without blocking (fail open).
 *
 * Changed files this session: everything that differs between the HEAD saved at session start and the working
 * tree (committed, staged, unstaged and untracked), minus files that were already dirty at session start and
 * still have the same content, and minus files that were dirty at start but not hashed (dirtyPaths without a
 * hash: their content at start is unknown, so they count as pre-existing). Without session-start state: since the merge base with the default branch,
 * else uncommitted changes only.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { blockingFailures, runChecks } from "../lib/checks.mjs";
import { loadConfig } from "../lib/config.mjs";
import {
  changedFilesSince,
  defaultBranchRef,
  hashFiles,
  head,
  mergeBase,
  runGit,
  uncommittedFiles,
} from "../lib/git.mjs";
import { failOpen, hermodPath, isMainModule, readStdinJson, readText, resolveRoot, truncateChars, truncateHead } from "../lib/io.mjs";
import { validateLessons } from "../lib/lessons.mjs";
import { matchAny, matchPath, normalizeRelPath, resolveInside } from "../lib/paths.mjs";
import { redact } from "../lib/redact.mjs";
import { listSkills, validateSkill } from "../lib/skills.mjs";
import { readSessionStart, readStopState, writeStopState } from "../lib/state.mjs";

/** The reason text is never longer than this. */
export const MAX_REASON_CHARS = 1500;
/** At most this many changed paths are listed by name. */
export const MAX_LISTED_PATHS = 5;
/** Checks that have not started after this long are skipped (the hook's own timeout is 30 s). */
export const CHECKS_DEADLINE_MS = 12000;
/** The watchdog for the whole hook. */
export const HOOK_TIMEOUT_MS = 25000;
const MAX_ITEM_CHARS = 300;
const MAX_ITEMS_PER_SECTION = 6;
export const FOOTER = "Hermod blocks once for this; it will not block again for the same reason.";

/**
 * @typedef {object} Reason
 * @property {"missing" | "check" | "knowledge"} kind
 * @property {string} key stable text the fingerprint is made of (no line numbers)
 * @property {string} text what the reason text shows
 */

/**
 * @typedef {object} SessionChanges
 * @property {string[]} files posix paths relative to root, sorted
 * @property {string | null} base the ref checks compare against
 * @property {"session-start" | "merge-base" | "uncommitted"} source
 */

/**
 * @typedef {object} StopDecision
 * @property {boolean} block
 * @property {string | null} reason the text shown to Claude when block is true
 * @property {string} why a short note on what was decided (for tests and debugging)
 * @property {string[]} changedFiles
 * @property {Reason[]} reasons
 * @property {string | null} fingerprint
 */

/**
 * Every file tracked in the index (for a session that started in a repository with no commits yet).
 * @param {string} root
 * @returns {string[]}
 */
function trackedFiles(root) {
  const r = runGit(root, ["ls-files", "-z"]);
  if (!r.ok) return [];
  return r.stdout
    .split("\0")
    .map((p) => normalizeRelPath(p))
    .filter((p) => p !== null);
}

/**
 * The files changed in this session (see the header comment).
 * @param {string} root
 * @param {ReturnType<typeof readSessionStart>} start
 * @returns {SessionChanges}
 */
export function sessionChanges(root, start) {
  if (start) {
    /** @type {string[]} */
    let files;
    if (start.head) {
      files = changedFilesSince(root, start.head);
    } else {
      // No commits at session start: everything tracked now is new, plus anything uncommitted.
      files = [...new Set([...trackedFiles(root), ...uncommittedFiles(root)])].sort();
    }
    const dirty = start.dirty;
    const wereDirty = files.filter((f) => Object.hasOwn(dirty, f));
    const now = wereDirty.length > 0 ? hashFiles(root, wereDirty) : {};
    // Dirty at start but not hashed (more than MAX_DIRTY_HASHES files, or hashing ran out of time): the content
    // at start is unknown, so the file counts as pre-existing, not as changed. Paths are saved redacted, so a
    // path that redaction changed is compared in its redacted form.
    const unhashed = new Set((start.dirtyPaths ?? []).filter((p) => !Object.hasOwn(dirty, p)));
    /** @param {string} f */
    const wasDirtyUnhashed = (f) => unhashed.size > 0 && (unhashed.has(f) || unhashed.has(redact(f)));
    files = files.filter((f) => {
      if (Object.hasOwn(dirty, f)) return !(now[f] !== undefined && now[f] === dirty[f]);
      return !wasDirtyUnhashed(f);
    });
    return { files, base: start.head ?? null, source: "session-start" };
  }
  const def = defaultBranchRef(root);
  const base = def ? mergeBase(root, "HEAD", def) : null;
  if (base) return { files: changedFilesSince(root, base), base, source: "merge-base" };
  return { files: changedFilesSince(root, null), base: head(root), source: "uncommitted" };
}

/**
 * @param {string} location
 * @param {{ message: string, line: number | null }} finding
 * @returns {Reason}
 */
function knowledgeReason(location, finding) {
  const message = finding.message.replace(/\s+/g, " ").trim();
  const at = finding.line ? `${location} line ${finding.line}` : location;
  return { kind: "knowledge", key: `knowledge:${location}:${message}`, text: `${at}: ${message}` };
}

/**
 * Validation errors in the lessons file and the skills that changed this session.
 * @param {string} root
 * @param {import("../lib/config.mjs").HermodConfig} config
 * @param {readonly string[]} changed
 * @returns {Reason[]}
 */
export function knowledgeReasons(root, config, changed) {
  /** @type {Reason[]} */
  const reasons = [];
  const lessonsRel = config.lessons.file;
  if (changed.includes(lessonsRel)) {
    const abs = resolveInside(root, lessonsRel);
    const text = abs === null ? null : readText(abs);
    if (text !== null) {
      const report = validateLessons(text, { capChars: config.lessons.capChars, maxEntryChars: config.lessons.maxEntryChars });
      for (const e of report.errors) reasons.push(knowledgeReason(lessonsRel, e));
    }
  }
  const skillsDir = normalizeRelPath(config.skills.dir);
  if (skillsDir !== null) {
    /** @type {Set<string>} */
    const touched = new Set();
    for (const f of changed) {
      if (!f.startsWith(`${skillsDir}/`)) continue;
      const parts = f.slice(skillsDir.length + 1).split("/");
      if (parts.length >= 2 && parts[0] !== "") touched.add(parts[0]);
    }
    if (touched.size > 0) {
      for (const ref of listSkills(root, skillsDir)) {
        if (!touched.has(ref.name)) continue;
        const report = validateSkill(ref.dir, {
          indexChars: config.skills.indexChars,
          maxSkillLines: config.curator.maxSkillLines,
        });
        for (const e of report.errors) reasons.push(knowledgeReason(ref.relFile, e));
      }
    }
  }
  return reasons;
}

/**
 * sha256 of the sorted reason keys.
 * @param {readonly Reason[]} reasons
 * @returns {string}
 */
export function fingerprintOf(reasons) {
  const keys = [...new Set(reasons.map((r) => r.key))].sort();
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}

/**
 * "a, b, c, d, e and 3 more".
 * @param {readonly string[]} paths
 * @param {number} [max]
 * @returns {string}
 */
export function listPaths(paths, max = MAX_LISTED_PATHS) {
  const shown = paths.slice(0, max).map((p) => truncateChars(p, 120));
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/**
 * @param {string} title
 * @param {readonly string[]} items
 * @returns {string}
 */
function section(title, items) {
  const lines = items.slice(0, MAX_ITEMS_PER_SECTION).map((i) => `- ${truncateChars(i.replace(/\s+/g, " "), MAX_ITEM_CHARS)}`);
  if (items.length > MAX_ITEMS_PER_SECTION) lines.push(`- and ${items.length - MAX_ITEMS_PER_SECTION} more`);
  return `${title}\n${lines.join("\n")}`;
}

/**
 * The text shown to Claude: plain English, at most MAX_REASON_CHARS, always ending with FOOTER.
 * @param {{ codeFiles: readonly string[], changedFiles: readonly string[], reasons: readonly Reason[], warnings: readonly string[], remind: readonly string[] }} parts
 * @returns {string}
 */
export function formatReason(parts) {
  const blocks = [];
  const missing = parts.reasons.filter((r) => r.kind === "missing");
  const checks = parts.reasons.filter((r) => r.kind === "check");
  const knowledge = parts.reasons.filter((r) => r.kind === "knowledge");
  blocks.push("Before you stop, Hermod's end-of-session ritual needs a few things.");
  if (parts.codeFiles.length > 0) blocks.push(`Code changed this session: ${listPaths(parts.codeFiles)}.`);
  else if (parts.changedFiles.length > 0) blocks.push(`Changed this session: ${listPaths(parts.changedFiles)}.`);
  if (missing.length > 0) {
    blocks.push(section("Not updated yet (update them, or say plainly why not):", missing.map((r) => r.text)));
  }
  if (checks.length > 0) blocks.push(section("Checks that failed (node .claude/hermod/check.mjs):", checks.map((r) => r.text)));
  if (knowledge.length > 0) {
    blocks.push(section("Invalid knowledge files (node .claude/hermod/validate.mjs):", knowledge.map((r) => r.text)));
  }
  if (parts.warnings.length > 0) blocks.push(section("Warnings (these do not block):", parts.warnings));
  if (parts.remind.length > 0) blocks.push(section("Reminders:", parts.remind));
  const body = redact(blocks.join("\n\n"));
  const room = MAX_REASON_CHARS - FOOTER.length - 2;
  return `${truncateHead(body, room, { marker: "\n…" })}\n\n${FOOTER}`;
}

/**
 * Decides whether to block, and records the block in the session's stop state before returning it.
 * @param {string} root
 * @param {Record<string, unknown>} input the hook input
 * @returns {Promise<StopDecision>}
 */
export async function decideStop(root, input) {
  /**
   * @param {string} why
   * @param {Partial<StopDecision>} [more]
   * @returns {StopDecision}
   */
  const pass = (why, more = {}) => ({ block: false, reason: null, why, changedFiles: [], reasons: [], fingerprint: null, ...more });
  if (input.stop_hook_active === true || input.stop_hook_active === "true") return pass("stop_hook_active");
  if (typeof input.hook_event_name === "string" && input.hook_event_name !== "Stop") return pass("not a Stop event");
  if (!fs.existsSync(hermodPath(root))) return pass("Hermod is not installed here");
  const { config } = loadConfig(root);
  const ritual = config.ritual;
  if (!ritual.enabled) return pass("ritual disabled");
  const sessionId = typeof input.session_id === "string" && input.session_id.trim() !== "" ? input.session_id : null;
  if (sessionId === null) return pass("no session id");

  const start = readSessionStart(root, sessionId);
  const changes = sessionChanges(root, start);
  const changedFiles = changes.files;
  const codeFiles = changedFiles.filter((f) => matchAny(ritual.codePaths, f) && !matchAny(ritual.ignorePaths, f));

  /** @type {Reason[]} */
  const reasons = [];
  /** @type {string[]} */
  const warnings = [];
  if (codeFiles.length > 0) {
    for (const req of ritual.require) {
      if (changedFiles.some((f) => matchPath(req.path, f))) continue;
      const why = req.why ? ` (${req.why.trim()})` : "";
      reasons.push({ kind: "missing", key: `missing:${req.path}`, text: `${req.path}${why}` });
    }
  }
  if (ritual.validateKnowledge) reasons.push(...knowledgeReasons(root, config, changedFiles));
  if (ritual.runChecks && codeFiles.length > 0) {
    const report = await runChecks(root, {
      dir: config.checks.dir,
      base: changes.base,
      changedFiles,
      deadlineMs: CHECKS_DEADLINE_MS,
      committedOnly: true,
    });
    for (const r of blockingFailures(report.results)) {
      const message = (r.message ?? "failed").replace(/\s+/g, " ").trim();
      reasons.push({ kind: "check", key: `check:${r.id}`, text: `${r.id}: ${message}` });
    }
    for (const r of report.results) {
      if (r.level === "warn" && (r.status === "fail" || r.status === "error")) {
        warnings.push(`${r.id}: ${(r.message ?? "failed").replace(/\s+/g, " ").trim()}`);
      }
    }
  }
  const more = { changedFiles, reasons };
  if (reasons.length === 0) return pass(codeFiles.length > 0 ? "ritual done" : "no code changed", more);

  const fingerprint = fingerprintOf(reasons);
  const state = readStopState(root, sessionId);
  const blockedBefore = new Set(state.keys ?? []);
  const fresh = [...new Set(reasons.map((r) => r.key))].filter((k) => !blockedBefore.has(k));
  // Each reason blocks at most once: only a reason that has not blocked yet can block. (State from before keys
  // existed has only fingerprints: the same set of reasons does not block twice.)
  if (fresh.length === 0 || state.fingerprints.includes(fingerprint)) {
    return pass("already blocked for these reasons", { ...more, fingerprint });
  }
  if (state.blocks >= ritual.maxBlocksPerSession) return pass("block limit reached", { ...more, fingerprint });
  // Record first: if the state cannot be saved, this throws and the hook fails open (no block, so no loop).
  writeStopState(root, sessionId, {
    fingerprints: [...state.fingerprints, fingerprint],
    keys: [...blockedBefore, ...fresh],
    blocks: state.blocks + 1,
    lastBlockAt: new Date().toISOString(),
  });
  const reason = formatReason({ codeFiles, changedFiles, reasons, warnings, remind: ritual.remind });
  return { block: true, reason, why: "blocked", changedFiles, reasons, fingerprint };
}

/**
 * The hook: reads stdin, decides, prints the block (or nothing).
 * @param {import("../lib/io.mjs").HookContext} ctx
 * @returns {Promise<{ decision: "block", reason: string } | "">}
 */
export async function main(ctx) {
  const input = await readStdinJson();
  const root = resolveRoot({ input });
  ctx.root = root;
  if (!fs.existsSync(path.join(root, ".claude", "hermod"))) return "";
  const decision = await decideStop(root, input);
  return decision.block && decision.reason ? { decision: "block", reason: decision.reason } : "";
}

if (isMainModule(import.meta.url)) {
  failOpen(main, { context: "stop", timeoutMs: HOOK_TIMEOUT_MS });
}
