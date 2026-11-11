// @ts-check
/**
 * State that follows a person between devices, through git, in private repositories that opt in.
 *
 * By default Hermod keeps its working state on the device, in `.claude/hermod/.local/` (never committed): the
 * ledger, each session's hook state and the reflect bundle. A cloud container loses it when it ends.
 *
 * Opting in: a person creates `.claude/hermod/state/ALLOW_COMMIT` in a private repository and merges it to the
 * default branch. It counts only on the remote default branch (origin/HEAD, else origin/main or origin/master),
 * so a marker made during a session does nothing until a person merges it. Sync, the hooks and the scripts
 * never create it.
 *
 * What travels then: one small file per session, `.claude/hermod/state/sessions/<YYYY-MM-DD>-<id8>.json`
 *   { "v": 1, "session": "<uuid>", "date": "YYYY-MM-DD", "branch": "<name>",
 *     "skills": { "<skill>": { "uses": n, "views": n } },
 *     "commands": [ { "key": "npm run build", "exit": 1, "attempts": 2, "resolved": true } ] }
 * A failed command is only its key (lib/summary.mjs): never the full command, its output or a file name. One
 * file per session, so two devices never edit the same file. `reflect-prep.mjs --write-usage` (a /reflect step)
 * writes it; the curator and reflect-prep read them all; the session commits and pushes it with its work.
 *
 * Nothing here runs by itself: the Stop hook only reads (its reminder), and only the script writes.
 */
import fs from "node:fs";
import path from "node:path";
import { branch as gitBranch, revParse, runGit } from "./git.mjs";
import { hermodPath, isPlainObject, readText, writeFileAtomic } from "./io.mjs";
import { relativeToRoot } from "./paths.mjs";
import { summaryKeyOf } from "./ledger.mjs";
import { isSummaryKey } from "./summary.mjs";

/** The folder for travelling state, relative to the root. */
export const STATE_DIR = ".claude/hermod/state";
/** The opt-in marker. Only a person creates it; it counts once it is on the remote default branch. */
export const MARKER = `${STATE_DIR}/ALLOW_COMMIT`;
/** One summary file per session. */
export const SESSIONS_DIR = `${STATE_DIR}/sessions`;
/** The format version of a session summary. */
export const SUMMARY_VERSION = 1;
/** A summary lists at most this many commands and skills. */
export const MAX_COMMANDS = 30;
export const MAX_SKILLS = 100;
/** A summary file is never larger than this. */
export const MAX_SUMMARY_BYTES = 16 * 1024;
/** At most this many summary files are read (the newest by name). */
export const MAX_SUMMARY_FILES = 20000;
/** The fields a summary may have, and a command in it. */
export const SUMMARY_KEYS = Object.freeze(["v", "session", "date", "branch", "skills", "commands"]);
export const COMMAND_KEYS = Object.freeze(["key", "exit", "attempts", "resolved"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FILE_NAME = /^(\d{4}-\d{2}-\d{2})-([0-9a-f]{8})\.json$/;
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BRANCH_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_COUNT = 1_000_000;
const REMOTE_DEFAULTS = ["refs/remotes/origin/main", "refs/remotes/origin/master"];

// ------------------------------------------------------------------------------------------- opting in

/**
 * The remote default branch as a full ref, or null. When refs/remotes/origin/HEAD is set it decides alone: its
 * branch, or null when that branch is gone (the hermod-state check applies the same rule). Only without it do
 * origin/main and then origin/master count. A local branch never counts: a session can commit to one without
 * anyone merging.
 * @param {string} root
 * @returns {string | null}
 */
export function remoteDefaultRef(root) {
  // symbolic-ref reads origin/HEAD even when its branch is gone; for-each-ref would skip it as broken.
  const head = runGit(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  const target = head.ok ? head.stdout.trim() : "";
  if (target !== "") {
    return target.startsWith("refs/remotes/origin/") && !target.endsWith("/HEAD") && revParse(root, target) ? target : null;
  }
  const r = runGit(root, ["for-each-ref", "--format=%(refname)", ...REMOTE_DEFAULTS]);
  if (!r.ok) return null;
  const refs = new Set(r.stdout.split("\n").filter((l) => l !== ""));
  return REMOTE_DEFAULTS.find((c) => refs.has(c)) ?? null;
}

/**
 * @param {string} ref
 * @returns {string}
 */
function shortRef(ref) {
  return ref.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, "");
}

/**
 * @typedef {object} TravelState
 * @property {boolean} allowed the marker is on the remote default branch
 * @property {string | null} ref the remote default branch (full ref), or null when there is none
 * @property {boolean} markerInTree the marker exists in the working tree
 * @property {string} why one plain sentence
 */

/**
 * Whether this repository lets state travel.
 * @param {string} root
 * @returns {TravelState}
 */
export function travelState(root) {
  const markerInTree = fs.existsSync(path.join(path.resolve(root), ...MARKER.split("/")));
  const ref = remoteDefaultRef(root);
  if (ref === null) {
    return { allowed: false, ref: null, markerInTree, why: "no remote default branch (origin/HEAD, origin/main or origin/master), so state stays on this device" };
  }
  const shown = shortRef(ref);
  if (runGit(root, ["cat-file", "-e", `${ref}:./${MARKER}`]).ok) {
    return { allowed: true, ref, markerInTree, why: `${MARKER} is on ${shown}` };
  }
  const why = markerInTree
    ? `${MARKER} is not on ${shown} yet; it counts once a person merges it there`
    : `no ${MARKER} on ${shown}, so state stays on this device`;
  return { allowed: false, ref, markerInTree, why };
}

// ------------------------------------------------------------------------------------------ the summary

/**
 * True for a real calendar date written YYYY-MM-DD.
 * @param {unknown} s
 * @returns {s is string}
 */
function isDate(s) {
  if (typeof s !== "string") return false;
  const m = DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * A branch name that may travel: parts separated by "/", each a plain name, at most 100 characters, no run of
 * 6 or more digits and no run of 16 or more letters and digits in a part.
 * @param {unknown} name
 * @returns {name is string}
 */
export function isTravelBranch(name) {
  if (typeof name !== "string" || name === "" || name.length > 100) return false;
  return name.split("/").every((p) => BRANCH_PART.test(p) && !/\d{6,}/.test(p) && !/[A-Za-z0-9]{16,}/.test(p));
}

/**
 * @param {unknown} n
 * @param {number} min
 * @returns {boolean}
 */
function isCount(n, min) {
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= MAX_COUNT;
}

/**
 * The file name of a session's summary.
 * @param {string} date YYYY-MM-DD
 * @param {string} sessionId a UUID
 * @returns {string}
 */
export function summaryFileName(date, sessionId) {
  return `${date}-${sessionId.slice(0, 8)}.json`;
}

/**
 * @typedef {object} SessionSummary
 * @property {number} v
 * @property {string} session
 * @property {string} date
 * @property {string} [branch]
 * @property {Record<string, { uses: number, views: number }>} skills
 * @property {Array<{ key: string, exit: number | null, attempts: number, resolved: boolean }>} commands
 */

/**
 * A ledger entry's summary key: made from its command text when the ledger kept it (full mode), so the shell's
 * quotes are known; else its key when that already is a summary key (summary mode); "" otherwise.
 * @param {Record<string, unknown>} e
 * @returns {string}
 */
function travelKey(e) {
  if (typeof e.cmd === "string" && e.cmd !== "") return summaryKeyOf(e.cmd);
  return isSummaryKey(e.key) ? String(e.key) : "";
}

/**
 * Builds a session's summary from its ledger entries. Only skills in `skillNames` (when given) count; a failed
 * command keeps only its summary key, its last exit code, how often it failed and whether it was resolved.
 * @param {{ sessionId: string, date: string, branch?: string | null, entries: ReadonlyArray<Record<string, unknown>>, skillNames?: ReadonlySet<string> }} input
 * @returns {SessionSummary}
 */
export function buildSessionSummary(input) {
  /** @type {Record<string, { uses: number, views: number }>} */
  const skills = {};
  /** @type {Map<string, { key: string, exit: number | null, attempts: number, resolved: boolean }>} */
  const commands = new Map();
  for (const e of input.entries) {
    if (e.type === "skill" || e.type === "skill-view") {
      const name = typeof e.skill === "string" ? e.skill : "";
      if (!SKILL_NAME.test(name) || name.length > 64) continue;
      if (input.skillNames && !input.skillNames.has(name)) continue;
      if (!(name in skills) && Object.keys(skills).length >= MAX_SKILLS) continue;
      const c = skills[name] ?? { uses: 0, views: 0 };
      if (e.type === "skill") c.uses++;
      else c.views++;
      skills[name] = c;
    } else if (e.type === "fail") {
      const key = travelKey(e);
      if (key === "") continue;
      const c = commands.get(key);
      if (!c && commands.size >= MAX_COMMANDS) continue;
      const exit = typeof e.exit === "number" && Number.isInteger(e.exit) && Math.abs(e.exit) <= 255 ? e.exit : null;
      commands.set(key, { key, exit: exit ?? c?.exit ?? null, attempts: Math.min(MAX_COUNT, (c?.attempts ?? 0) + 1), resolved: false });
    } else if (e.type === "resolved") {
      const c = commands.get(travelKey(e));
      if (c) c.resolved = true;
    }
  }
  /** @type {SessionSummary} */
  const summary = { v: SUMMARY_VERSION, session: input.sessionId, date: input.date, skills: {}, commands: [...commands.values()] };
  if (isTravelBranch(input.branch)) summary.branch = input.branch;
  summary.skills = Object.fromEntries(Object.entries(skills).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  // Field order as documented (branch before skills).
  return {
    v: summary.v,
    session: summary.session,
    date: summary.date,
    ...(summary.branch ? { branch: summary.branch } : {}),
    skills: summary.skills,
    commands: summary.commands,
  };
}

/**
 * Everything wrong with a summary file, as plain sentences ([] when it may travel). The seeded check
 * `hermod-state` applies the same rules.
 * @param {unknown} value the parsed JSON
 * @param {string} fileName its base name, e.g. "2026-11-10-1a2b3c4d.json"
 * @returns {string[]}
 */
export function validateSessionSummary(value, fileName) {
  /** @type {string[]} */
  const errors = [];
  const name = FILE_NAME.exec(fileName);
  if (!name) errors.push(`the file name must be <YYYY-MM-DD>-<first 8 of the session id>.json (got ${JSON.stringify(fileName)})`);
  if (!isPlainObject(value)) return [...errors, "it must be a JSON object"];
  for (const k of Object.keys(value)) if (!SUMMARY_KEYS.includes(k)) errors.push(`"${k}" is not a summary field`);
  if (value.v !== SUMMARY_VERSION) errors.push(`"v" must be ${SUMMARY_VERSION}`);
  if (typeof value.session !== "string" || !UUID.test(value.session)) errors.push('"session" must be the session id (a UUID)');
  else if (name && !value.session.startsWith(name[2])) errors.push("the file name and \"session\" name different sessions");
  if (!isDate(value.date)) errors.push('"date" must be a date written YYYY-MM-DD');
  else if (name && value.date !== name[1]) errors.push("the file name and \"date\" differ");
  if ("branch" in value && !isTravelBranch(value.branch)) errors.push('"branch" must be a plain branch name');
  if (!isPlainObject(value.skills)) errors.push('"skills" must be an object');
  else {
    const entries = Object.entries(value.skills);
    if (entries.length > MAX_SKILLS) errors.push(`"skills" lists more than ${MAX_SKILLS} skills`);
    for (const [skill, c] of entries.slice(0, MAX_SKILLS)) {
      if (!SKILL_NAME.test(skill) || skill.length > 64) errors.push(`"${skill.slice(0, 40)}" is not a skill name`);
      else if (!isPlainObject(c) || Object.keys(c).some((k) => k !== "uses" && k !== "views") || !isCount(c.uses, 0) || !isCount(c.views, 0)) {
        errors.push(`skill ${skill} must be { "uses": n, "views": n }`);
      }
    }
  }
  if (!Array.isArray(value.commands)) errors.push('"commands" must be a list');
  else {
    if (value.commands.length > MAX_COMMANDS) errors.push(`"commands" lists more than ${MAX_COMMANDS} commands`);
    value.commands.slice(0, MAX_COMMANDS).forEach((c, i) => {
      if (!isPlainObject(c)) {
        errors.push(`commands[${i}] must be an object`);
        return;
      }
      for (const k of Object.keys(c)) if (!COMMAND_KEYS.includes(k)) errors.push(`commands[${i}]: "${k}" is not a command field`);
      if (!isSummaryKey(c.key)) errors.push(`commands[${i}]: "key" must be at most three plain words, like "npm run build"`);
      if (!(c.exit === null || (typeof c.exit === "number" && Number.isInteger(c.exit) && Math.abs(c.exit) <= 255))) {
        errors.push(`commands[${i}]: "exit" must be an exit code or null`);
      }
      if (!isCount(c.attempts, 1)) errors.push(`commands[${i}]: "attempts" must be a whole number from 1`);
      if (typeof c.resolved !== "boolean") errors.push(`commands[${i}]: "resolved" must be true or false`);
    });
  }
  return errors;
}

// ------------------------------------------------------------------------------------- reading, writing

/**
 * The absolute sessions folder, or null when it, or a folder on the way, leads outside the repository.
 * @param {string} root
 * @returns {string | null}
 */
function safeSessionsDir(root) {
  const absRoot = path.resolve(root);
  const dir = path.join(absRoot, ...SESSIONS_DIR.split("/"));
  for (const p of [hermodPath(absRoot), path.join(absRoot, ...STATE_DIR.split("/")), dir]) {
    if (!fs.existsSync(p)) continue;
    let real;
    try {
      real = fs.realpathSync.native(p);
    } catch {
      return null;
    }
    if (relativeToRoot(absRoot, real) === null) return null;
  }
  return dir;
}

/**
 * The summary file names in the sessions folder (regular `*.json` files), sorted, newest last.
 * @param {string} root
 * @returns {string[]}
 */
function summaryFileNames(root) {
  const dir = safeSessionsDir(root);
  if (dir === null) return [];
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith(".")).map((e) => e.name);
  names.sort();
  return names.length > MAX_SUMMARY_FILES ? names.slice(names.length - MAX_SUMMARY_FILES) : names;
}

/**
 * @typedef {object} SummaryFile
 * @property {string} file path relative to the root
 * @property {SessionSummary} summary
 */

/**
 * Reads every session summary in the working tree. Files that break the rules are listed in `invalid`, never
 * used.
 * @param {string} root
 * @returns {{ summaries: SummaryFile[], invalid: string[] }}
 */
export function readSessionSummaries(root) {
  const dir = safeSessionsDir(root);
  /** @type {SummaryFile[]} */
  const summaries = [];
  /** @type {string[]} */
  const invalid = [];
  if (dir === null) return { summaries, invalid };
  for (const name of summaryFileNames(root)) {
    const rel = `${SESSIONS_DIR}/${name}`;
    const text = readText(path.join(dir, name), { maxBytes: MAX_SUMMARY_BYTES + 1 });
    if (text === null || Buffer.byteLength(text) > MAX_SUMMARY_BYTES) {
      invalid.push(rel);
      continue;
    }
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      invalid.push(rel);
      continue;
    }
    if (validateSessionSummary(value, name).length > 0) {
      invalid.push(rel);
      continue;
    }
    summaries.push({ file: rel, summary: /** @type {SessionSummary} */ (value) });
  }
  return { summaries, invalid };
}

/**
 * The summary file of a session already in the working tree (relative path), or null.
 * @param {string} root
 * @param {string} sessionId
 * @returns {string | null}
 */
export function findSessionSummary(root, sessionId) {
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) return null;
  const dir = safeSessionsDir(root);
  if (dir === null) return null;
  const suffix = `-${sessionId.slice(0, 8)}.json`;
  for (const name of summaryFileNames(root)) {
    if (!name.endsWith(suffix) || !FILE_NAME.test(name)) continue;
    // Only this session's own file: another session may share the first 8 characters of the id.
    if (summarySession(path.join(dir, name)) === sessionId) return `${SESSIONS_DIR}/${name}`;
  }
  return null;
}

/**
 * The "session" of a summary file, or null when it cannot be read.
 * @param {string} abs
 * @returns {string | null}
 */
function summarySession(abs) {
  const text = readText(abs, { maxBytes: MAX_SUMMARY_BYTES + 1 });
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    return isPlainObject(v) && typeof v.session === "string" ? v.session : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {object} WriteResult
 * @property {boolean} written
 * @property {string | null} file path relative to the root, when written
 * @property {string} why one plain sentence
 * @property {SessionSummary | null} summary
 */

/**
 * Writes this session's summary when the repository lets state travel (travelState), else writes nothing and
 * says why. A summary already written for the session is replaced (same file name), so running it twice is safe.
 * @param {string} root
 * @param {string} sessionId
 * @param {{ date: string, entries: ReadonlyArray<Record<string, unknown>>, skillNames?: ReadonlySet<string> }} input
 * @returns {WriteResult}
 */
export function writeSessionSummary(root, sessionId, input) {
  const gate = travelState(root);
  if (!gate.allowed) return { written: false, file: null, why: gate.why, summary: null };
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) {
    return { written: false, file: null, why: "the session id is not a UUID, so no summary is written", summary: null };
  }
  const dir = safeSessionsDir(root);
  if (dir === null) return { written: false, file: null, why: `${SESSIONS_DIR} leads outside the repository`, summary: null };
  const existing = findSessionSummary(root, sessionId);
  const fileName = existing ? path.posix.basename(existing) : summaryFileName(input.date, sessionId);
  if (!existing && fs.existsSync(path.join(dir, fileName))) {
    return { written: false, file: null, why: `${SESSIONS_DIR}/${fileName} belongs to another session with the same id prefix`, summary: null };
  }
  const date = fileName.slice(0, 10);
  const summary = buildSessionSummary({
    sessionId,
    date,
    branch: gitBranch(root),
    entries: input.entries.filter((e) => e.session === sessionId),
    skillNames: input.skillNames,
  });
  const errors = validateSessionSummary(summary, fileName);
  if (errors.length > 0) return { written: false, file: null, why: `the summary breaks its own rules: ${errors[0]}`, summary: null };
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_SUMMARY_BYTES) return { written: false, file: null, why: "the summary is too large", summary: null };
  fs.mkdirSync(dir, { recursive: true });
  // The folder was checked before it existed; check again now that it does.
  if (safeSessionsDir(root) === null) return { written: false, file: null, why: `${SESSIONS_DIR} leads outside the repository`, summary: null };
  writeFileAtomic(path.join(dir, fileName), text);
  return { written: true, file: `${SESSIONS_DIR}/${fileName}`, why: `written (${gate.why})`, summary };
}

// ----------------------------------------------------------------------------------------- push status

/**
 * Whether HEAD's commits are on its upstream, from local refs only (the kit never fetches).
 * @param {string} root
 * @returns {{ upstream: string | null, ahead: number | null }}
 */
export function upstreamStatus(root) {
  const up = runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const upstream = up.ok ? up.stdout.trim() : "";
  if (!up.ok || upstream === "") return { upstream: null, ahead: null };
  const r = runGit(root, ["rev-list", "--count", "@{upstream}..HEAD"]);
  const n = Number(r.stdout.trim());
  return { upstream, ahead: r.ok && Number.isInteger(n) && n >= 0 ? n : null };
}
