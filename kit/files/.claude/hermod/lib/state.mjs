// @ts-check
/**
 * Per-session state under `.claude/hermod/.local/sessions/<sanitized session id>/`:
 * - session-start.json: what the repository looked like when the session started (written once);
 * - brief.md: the brief printed at session start, printed again unchanged on resume and compact;
 * - stop.json: what the Stop hook already blocked for (so it blocks at most once per reason).
 * Everything is redacted before it is written. pruneOldSessions() removes folders older than N days.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureLocalDir, isPlainObject, localDir, readText, writeFileAtomic } from "./io.mjs";
import { redact, redactDeep } from "./redact.mjs";

export const SESSIONS_DIR = "sessions";
export const SESSION_START_FILE = "session-start.json";
export const BRIEF_FILE = "brief.md";
export const STOP_FILE = "stop.json";
/** At most this many dirty files are hashed into the session-start state. */
export const MAX_DIRTY_HASHES = 300;
/** At most this many dirty paths (hashed or not) are listed in the session-start state. */
export const MAX_DIRTY_PATHS = 5000;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

/**
 * @typedef {object} SessionStartState
 * @property {string} sessionId
 * @property {string} startedAt ISO time
 * @property {string | null} head HEAD sha at start
 * @property {string | null} branch
 * @property {string | null} transcriptPath
 * @property {Record<string, string>} dirty files with uncommitted changes at start → blob sha or "deleted"
 *   (at most MAX_DIRTY_HASHES; a file that could not be hashed is left out)
 * @property {string[]} [dirtyPaths] every file with uncommitted changes at start, hashed or not (at most
 *   MAX_DIRTY_PATHS). A path here without an entry in `dirty` was already dirty, but its content is unknown.
 * @property {boolean} [dirtyTruncated] true when more files were dirty than `dirty` holds hashes for
 * @property {number} [dirtyTotal] how many files were dirty at start
 */

/**
 * @typedef {object} StopState
 * @property {string[]} fingerprints reasons already blocked for (sha256 of the sorted reasons)
 * @property {string[]} [keys] every reason key that has already caused a block (each reason blocks at most once)
 * @property {number} blocks how many times the Stop hook blocked in this session
 * @property {string | null} lastBlockAt ISO time
 */

/**
 * A folder name for a session id: ids made of letters, digits, ".", "_" and "-" (such as UUIDs) are kept;
 * anything else becomes a readable prefix plus a hash, so different ids never share a folder.
 * @param {unknown} id
 * @returns {string}
 */
export function sanitizeSessionId(id) {
  const raw = typeof id === "string" ? id : "";
  if (raw === "") return "unknown";
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  const safe =
    clean === raw && raw.length <= 64 && !raw.startsWith(".") && !raw.endsWith(".") && !WINDOWS_RESERVED.test(raw);
  if (safe) return raw;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const prefix = clean.replace(/^[._-]+/, "").slice(0, 40).replace(/[._-]+$/, "");
  return prefix ? `${prefix}-${hash}` : `session-${hash}`;
}

/**
 * Absolute path of `.local/sessions/` (may not exist).
 * @param {string} root
 * @returns {string}
 */
export function sessionsDir(root) {
  return path.join(localDir(root), SESSIONS_DIR);
}

/**
 * Absolute path of one session's folder (may not exist).
 * @param {string} root
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionDir(root, sessionId) {
  return path.join(sessionsDir(root), sanitizeSessionId(sessionId));
}

/**
 * Creates the session folder (and `.local/` with its `.gitignore`) and returns its path. Throws when
 * `.local/` cannot be created safely (see ensureLocalDir).
 * @param {string} root
 * @param {string} sessionId
 * @returns {string}
 */
export function ensureSessionDir(root, sessionId) {
  ensureLocalDir(root);
  const dir = sessionDir(root, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} name
 */
function assertFileName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.includes("..")) {
    throw new Error(`invalid session file name "${name}"`);
  }
}

/**
 * Reads a text file from the session folder; null when missing.
 * @param {string} root
 * @param {string} sessionId
 * @param {string} name
 * @returns {string | null}
 */
export function readSessionFile(root, sessionId, name) {
  assertFileName(name);
  return readText(path.join(sessionDir(root, sessionId), name));
}

/**
 * Writes a text file into the session folder (redacted, atomically) and returns the text written.
 * @param {string} root
 * @param {string} sessionId
 * @param {string} name
 * @param {string} text
 * @returns {string}
 */
export function writeSessionFile(root, sessionId, name, text) {
  assertFileName(name);
  const safe = redact(String(text ?? ""));
  writeFileAtomic(path.join(ensureSessionDir(root, sessionId), name), safe);
  return safe;
}

/**
 * Reads a JSON file from the session folder; null when missing or invalid.
 * @param {string} root
 * @param {string} sessionId
 * @param {string} name
 * @returns {unknown}
 */
export function readSessionJson(root, sessionId, name) {
  const text = readSessionFile(root, sessionId, name);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Writes a JSON file into the session folder. Every string value is redacted (keys are kept).
 * @param {string} root
 * @param {string} sessionId
 * @param {string} name
 * @param {unknown} value
 */
export function writeSessionJson(root, sessionId, name, value) {
  assertFileName(name);
  const safe = redactDeep(value);
  writeFileAtomic(path.join(ensureSessionDir(root, sessionId), name), `${JSON.stringify(safe, null, 2)}\n`);
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
const textOrNull = (v) => (typeof v === "string" && v !== "" ? v : null);

/**
 * The session-start state, or null when there is none (or it is unreadable).
 * @param {string} root
 * @param {string} sessionId
 * @returns {SessionStartState | null}
 */
export function readSessionStart(root, sessionId) {
  const v = readSessionJson(root, sessionId, SESSION_START_FILE);
  if (!isPlainObject(v)) return null;
  /** @type {Record<string, string>} */
  const dirty = {};
  if (isPlainObject(v.dirty)) {
    for (const [p, sha] of Object.entries(v.dirty)) if (typeof sha === "string") dirty[p] = sha;
  }
  // State written before dirtyPaths existed: the hashed files are all that is known.
  const dirtyPaths = Array.isArray(v.dirtyPaths)
    ? [...new Set([...Object.keys(dirty), ...v.dirtyPaths.filter((p) => typeof p === "string" && p !== "")])]
    : Object.keys(dirty);
  const total = typeof v.dirtyTotal === "number" && Number.isInteger(v.dirtyTotal) && v.dirtyTotal >= 0 ? v.dirtyTotal : null;
  return {
    sessionId: typeof v.sessionId === "string" ? v.sessionId : String(sessionId),
    startedAt: typeof v.startedAt === "string" ? v.startedAt : "",
    head: textOrNull(v.head),
    branch: textOrNull(v.branch),
    transcriptPath: textOrNull(v.transcriptPath),
    dirty,
    dirtyPaths,
    dirtyTruncated: v.dirtyTruncated === true,
    dirtyTotal: total ?? dirtyPaths.length,
  };
}

/**
 * Saves the session-start state. By default only once: returns false (and writes nothing) when a state
 * already exists, so resume and compact keep the original baseline. dirtyPaths is cut to MAX_DIRTY_PATHS.
 * Strings are redacted (object keys, so the paths in `dirty`, are kept as they are).
 * @param {string} root
 * @param {string} sessionId
 * @param {SessionStartState} state
 * @param {{ overwrite?: boolean }} [options]
 * @returns {boolean} true when written
 */
export function writeSessionStart(root, sessionId, state, options = {}) {
  if (!options.overwrite && fs.existsSync(path.join(sessionDir(root, sessionId), SESSION_START_FILE))) return false;
  /** @type {Record<string, unknown>} */
  const out = { ...state };
  if (Array.isArray(state.dirtyPaths)) out.dirtyPaths = state.dirtyPaths.slice(0, MAX_DIRTY_PATHS);
  writeSessionJson(root, sessionId, SESSION_START_FILE, out);
  return true;
}

/**
 * The frozen brief of a session, or null.
 * @param {string} root
 * @param {string} sessionId
 * @returns {string | null}
 */
export function readBrief(root, sessionId) {
  return readSessionFile(root, sessionId, BRIEF_FILE);
}

/**
 * Saves the brief (redacted) and returns exactly the text saved; print that text so that resume shows the
 * same brief.
 * @param {string} root
 * @param {string} sessionId
 * @param {string} text
 * @returns {string}
 */
export function writeBrief(root, sessionId, text) {
  return writeSessionFile(root, sessionId, BRIEF_FILE, text);
}

/**
 * The Stop hook's memory for a session (empty when there is none).
 * @param {string} root
 * @param {string} sessionId
 * @returns {StopState}
 */
export function readStopState(root, sessionId) {
  const v = readSessionJson(root, sessionId, STOP_FILE);
  if (!isPlainObject(v)) return { fingerprints: [], keys: [], blocks: 0, lastBlockAt: null };
  const fingerprints = Array.isArray(v.fingerprints) ? v.fingerprints.filter((f) => typeof f === "string") : [];
  // State written before keys existed has only fingerprints; it is read as "no key blocked yet".
  const keys = Array.isArray(v.keys) ? v.keys.filter((k) => typeof k === "string") : [];
  const blocks = typeof v.blocks === "number" && Number.isInteger(v.blocks) && v.blocks >= 0 ? v.blocks : 0;
  return { fingerprints, keys, blocks, lastBlockAt: textOrNull(v.lastBlockAt) };
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @param {StopState} state
 */
export function writeStopState(root, sessionId, state) {
  writeSessionJson(root, sessionId, STOP_FILE, {
    fingerprints: [...new Set(state.fingerprints ?? [])],
    keys: [...new Set(state.keys ?? [])].sort(),
    blocks: state.blocks ?? 0,
    lastBlockAt: state.lastBlockAt ?? null,
  });
}

/**
 * The newest modification time inside a session folder (the folder itself and its direct files).
 * @param {string} dir
 * @returns {number}
 */
function newestMtime(dir) {
  let newest = fs.lstatSync(dir).mtimeMs;
  for (const name of fs.readdirSync(dir)) {
    try {
      newest = Math.max(newest, fs.lstatSync(path.join(dir, name)).mtimeMs);
    } catch {
      // vanished meanwhile
    }
  }
  return newest;
}

/**
 * Removes session folders not touched for more than `days` days. Symlinks are removed, never followed.
 * Never throws.
 * @param {string} root
 * @param {number} [days] default 30
 * @param {{ now?: number, keep?: string[] }} [options] keep: session ids that must stay (the current one)
 * @returns {string[]} names of the removed folders
 */
export function pruneOldSessions(root, days = 30, options = {}) {
  /** @type {string[]} */
  const removed = [];
  const dir = sessionsDir(root);
  const now = options.now ?? Date.now();
  const limit = now - Math.max(0, Number(days) || 0) * 86400000;
  const keep = new Set((options.keep ?? []).map((id) => sanitizeSessionId(id)));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        if (st.mtimeMs < limit) {
          fs.unlinkSync(p);
          removed.push(name);
        }
        continue;
      }
      if (newestMtime(p) < limit) {
        fs.rmSync(p, { recursive: true, force: true });
        removed.push(name);
      }
    } catch {
      // leave it for the next run
    }
  }
  return removed.sort();
}
