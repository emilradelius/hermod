// @ts-check
/**
 * Skill usage for the curator: how often each skill was used (the Skill tool) and viewed (its SKILL.md was read),
 * and the last day it was.
 *
 * Two sources, read only (this module never writes):
 * - `.claude/hermod/usage/*.json`, committed by /reflect, one file per session:
 *   `{ "session": "<id>", "date": "<YYYY-MM-DD>", "skills": { "<name>": { "uses": n, "views": n } } }`
 * - the local ledger (`.claude/hermod/.local/ledger.jsonl` and its rotated file), entries
 *   `{ ts, session, type: "skill" | "skill-view", skill }`. Sessions that already have a usage file are skipped
 *   there, so a session is never counted twice.
 *
 * Bad files and lines are skipped and counted, never an error.
 */
import fs from "node:fs";
import path from "node:path";
import { hermodPath, isPlainObject, readText } from "./io.mjs";
import { readLedger } from "./ledger.mjs";

/** The usage folder, relative to the root. */
export const USAGE_DIR = ".claude/hermod/usage";
/** Usage files larger than this are skipped (they are a few hundred bytes normally). */
export const MAX_USAGE_FILE_BYTES = 1024 * 1024;
/** At most this many usage files are read (the newest by name). */
export const MAX_USAGE_FILES = 20000;
/** Counts above this in one file are treated as invalid (a hand-edited or hostile file). */
const MAX_COUNT = 1_000_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * @typedef {object} SkillUsage
 * @property {number} uses Skill tool uses
 * @property {number} views reads of its SKILL.md
 * @property {string | null} lastUsed YYYY-MM-DD of the last use or view, or null
 * @property {number} sessions sessions with at least one use or view
 */

/**
 * @typedef {object} UsageResult
 * @property {Map<string, SkillUsage>} skills by skill name
 * @property {number} files usage files read
 * @property {string[]} invalidFiles usage files skipped (posix, relative to the root)
 * @property {number} ledgerEvents ledger skill events counted (sessions with a usage file excluded)
 * @property {number} ledgerSkipped ledger skill events skipped because their session has a usage file
 */

/**
 * True for a real calendar date written as YYYY-MM-DD.
 * @param {unknown} s
 * @returns {s is string}
 */
export function isDate(s) {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * Whole days from date a to date b (both YYYY-MM-DD), b - a.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * The later of two dates (null-safe).
 * @param {string | null} a
 * @param {string | null} b
 * @returns {string | null}
 */
export function laterDate(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

/**
 * A count from a usage file: a whole number from 0 to MAX_COUNT, else null.
 * @param {unknown} n
 * @returns {number | null}
 */
function count(n) {
  if (n === undefined) return 0;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_COUNT ? n : null;
}

/**
 * @param {Map<string, SkillUsage>} map
 * @param {string} name
 * @returns {SkillUsage}
 */
function entryFor(map, name) {
  let u = map.get(name);
  if (!u) {
    u = { uses: 0, views: 0, lastUsed: null, sessions: 0 };
    map.set(name, u);
  }
  return u;
}

/**
 * Parses one usage file's JSON value. The date comes from "date", else from the file name's YYYY-MM-DD prefix.
 * Returns null when the value is not a usage record.
 * @param {unknown} value
 * @param {string} fileName
 * @returns {{ session: string | null, date: string, skills: Map<string, { uses: number, views: number }> } | null}
 */
export function parseUsageFile(value, fileName) {
  if (!isPlainObject(value)) return null;
  const fromName = fileName.slice(0, 10);
  const date = isDate(value.date) ? value.date : isDate(fromName) ? fromName : null;
  if (date === null) return null;
  if (!isPlainObject(value.skills)) return null;
  /** @type {Map<string, { uses: number, views: number }>} */
  const skills = new Map();
  for (const [name, c] of Object.entries(value.skills)) {
    if (name === "" || name.length > 200 || !isPlainObject(c)) return null;
    const uses = count(c.uses);
    const views = count(c.views);
    if (uses === null || views === null) return null;
    skills.set(name, { uses, views });
  }
  return { session: typeof value.session === "string" && value.session !== "" ? value.session : null, date, skills };
}

/**
 * The usage files' names in the usage folder (only `*.json` regular files), sorted.
 * @param {string} root
 * @returns {string[]}
 */
function usageFileNames(root) {
  const dir = hermodPath(root, "usage");
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith(".")).map((e) => e.name);
  names.sort();
  return names.length > MAX_USAGE_FILES ? names.slice(names.length - MAX_USAGE_FILES) : names;
}

/**
 * Collects usage from the usage files and the local ledger.
 * @param {string} root
 * @param {{ ledger?: boolean }} [options] ledger: also read the local ledger (default true)
 * @returns {UsageResult}
 */
export function collectUsage(root, options = {}) {
  /** @type {Map<string, SkillUsage>} */
  const skills = new Map();
  /** @type {string[]} */
  const invalidFiles = [];
  /** @type {Set<string>} */
  const coveredSessions = new Set();
  let files = 0;
  const dir = hermodPath(root, "usage");
  for (const name of usageFileNames(root)) {
    const rel = `${USAGE_DIR}/${name}`;
    const text = readText(path.join(dir, name), { maxBytes: MAX_USAGE_FILE_BYTES + 1 });
    if (text === null || Buffer.byteLength(text) > MAX_USAGE_FILE_BYTES) {
      invalidFiles.push(rel);
      continue;
    }
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      invalidFiles.push(rel);
      continue;
    }
    const parsed = parseUsageFile(value, name);
    if (parsed === null) {
      invalidFiles.push(rel);
      continue;
    }
    files++;
    if (parsed.session !== null) coveredSessions.add(parsed.session);
    for (const [skill, c] of parsed.skills) {
      const u = entryFor(skills, skill);
      u.uses += c.uses;
      u.views += c.views;
      if (c.uses + c.views > 0) {
        u.sessions++;
        u.lastUsed = laterDate(u.lastUsed, parsed.date);
      }
    }
  }

  let ledgerEvents = 0;
  let ledgerSkipped = 0;
  if (options.ledger !== false) {
    /** @type {Map<string, Set<string>>} */
    const ledgerSessions = new Map();
    for (const e of readLedger(root)) {
      if (e.type !== "skill" && e.type !== "skill-view") continue;
      if (typeof e.skill !== "string" || e.skill === "") continue;
      const session = typeof e.session === "string" ? e.session : "";
      if (session !== "" && coveredSessions.has(session)) {
        ledgerSkipped++;
        continue;
      }
      const ts = typeof e.ts === "string" ? e.ts.slice(0, 10) : "";
      const u = entryFor(skills, e.skill);
      if (e.type === "skill") u.uses++;
      else u.views++;
      if (isDate(ts)) u.lastUsed = laterDate(u.lastUsed, ts);
      ledgerEvents++;
      const seen = ledgerSessions.get(e.skill) ?? new Set();
      if (!seen.has(session)) {
        seen.add(session);
        u.sessions++;
      }
      ledgerSessions.set(e.skill, seen);
    }
  }
  return { skills, files, invalidFiles, ledgerEvents, ledgerSkipped };
}
