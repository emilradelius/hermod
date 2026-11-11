// @ts-check
/**
 * The session ledger: an append-only JSONL file at `.claude/hermod/.local/ledger.jsonl` (never committed)
 * that notes failed commands, the command and files that resolved them, and which skills were used.
 *
 * Entries (one JSON object per line; every string is redacted with lib/redact.mjs before it is written):
 * - { id, ts, session, type: "fail", key, cmd, exit, out }
 * - { id, ts, session, type: "resolved", failureId, attempts, key, cmd, changedFiles }
 * - { id, ts, session, type: "skill", skill }        (the Skill tool was used)
 * - { id, ts, session, type: "skill-view", skill }   (a skill's SKILL.md was read)
 *
 * A failure stays "open" for its command key in `.local/sessions/<id>/open-failures.json`, with the blob
 * hashes of the files that were dirty at that moment (at most MAX_SNAPSHOT_FILES). A later success of the
 * same key in the same session appends a "resolved" entry with the files that changed since the failure, and
 * closes it. Successes with no open failure write nothing and make no git calls (the fast path).
 *
 * Rotation: when appending would take ledger.jsonl over maxFileBytes, it is renamed to ledger.1.jsonl
 * (replacing an older one) and a fresh file is started.
 *
 * Summary mode (config ledger.mode "summary"): no command text, output or file names are ever written, not even
 * here on the device. A failure is { id, ts, session, type: "fail", key, exit } and a resolution
 * { id, ts, session, type: "resolved", failureId, attempts, key }, where key is the summary key (lib/summary.mjs:
 * at most three plain words). No snapshot is taken, so no git call is made. An open failure is kept under a hash of
 * its full redacted key, so failures match exactly and no command text is stored. Skill entries are the same as in
 * full mode. This is the mode for a repository whose command output can hold personal text.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashFiles, head, isSafeRef, runGit, uncommittedFiles } from "./git.mjs";
import { appendLine, ensureLocalDir, isPlainObject, localDir, readText, truncateChars, truncateTail } from "./io.mjs";
import { normalizeRelPath, relativeToRoot } from "./paths.mjs";
import { redact, redactDeep } from "./redact.mjs";
import { readSessionJson, writeSessionJson } from "./state.mjs";
import { summaryKeyFromTokens } from "./summary.mjs";

export const LEDGER_FILE = "ledger.jsonl";
export const ROTATED_FILE = "ledger.1.jsonl";
export const OPEN_FAILURES_FILE = "open-failures.json";
/** cmd is cut to this many characters (after redaction). */
export const MAX_CMD_CHARS = 500;
/** At most this many dirty files are hashed into a failure's snapshot. */
export const MAX_SNAPSHOT_FILES = 100;
/** At most this many dirty paths are remembered (hashed or not) per failure. */
export const MAX_DIRTY_PATHS = 1000;
/** At most this many open failures are kept per session (the oldest are dropped). */
export const MAX_OPEN_FAILURES = 50;
/** A resolved entry lists at most this many changed files. */
export const MAX_CHANGED_FILES = 50;
/** The key is made of at most this many words of the command. */
export const KEY_TOKENS = 3;
const MAX_KEY_CHARS = 200;
const MAX_SKILL_CHARS = 200;

/**
 * @typedef {object} LedgerOptions
 * @property {number} [maxOutputChars] tail of the output kept in a failure (config ledger.maxOutputChars)
 * @property {number} [maxFileBytes] rotation size (config ledger.maxFileBytes)
 * @property {ReadonlyArray<string | RegExp>} [extraRedactPatterns] config ledger.extraRedactPatterns
 * @property {string} [skillsDir] config skills.dir (for skill views)
 * @property {Date} [now]
 * @property {"full" | "summary"} [mode] config ledger.mode: "summary" keeps only the summary key and exit code
 */

/**
 * @typedef {object} OpenFailure
 * @property {string} id
 * @property {string} key
 * @property {string} ts
 * @property {number} attempts failures of this key since it was opened
 * @property {string | null} head HEAD at the failure
 * @property {Record<string, string>} snapshot dirty files at the failure → blob sha or "deleted"
 * @property {string[]} dirty every dirty path at the failure (at most MAX_DIRTY_PATHS)
 */

/**
 * @typedef {object} ToolEvent
 * @property {"fail" | "success" | "ignore" | "skill" | "skill-view"} kind
 * @property {string} [command] Bash command (fail and success)
 * @property {number | null} [exit] exit code of a failure, when known
 * @property {string} [output] output of a failure
 * @property {string} [skill] skill name (skill and skill-view)
 * @property {string} why a short note on how the event was classified
 */

/**
 * @typedef {object} RecordResult
 * @property {"fail" | "resolved" | "skill" | "skill-view" | "none"} action
 * @property {Record<string, unknown> | null} entry what was appended (null for none)
 * @property {string} why
 * @property {boolean} usedGit true when git was called (never on the fast path)
 */

// ------------------------------------------------------------------------------------------------ paths

/**
 * @param {string} root
 * @returns {string}
 */
export function ledgerPath(root) {
  return path.join(localDir(root), LEDGER_FILE);
}

/**
 * @param {string} root
 * @returns {string}
 */
export function rotatedLedgerPath(root) {
  return path.join(localDir(root), ROTATED_FILE);
}

// ------------------------------------------------------------------------------------------- the key

const OPERATORS = new Set(["&&", "||", "|", ";", "&", "|&", ">", ">>", "<", "2>", "2>&1", "&>"]);

/**
 * @typedef {object} ShellToken
 * @property {string} text the token with its quotes removed
 * @property {boolean} quoted some of it was quoted or escaped
 */

/**
 * Splits a shell command into tokens: quotes are removed (a token remembers that some of it was quoted or
 * escaped), shell operators (&&, ||, |, ;, &, redirections) become their own tokens. A rough lexer, good enough
 * for a key; never throws.
 * @param {string} command
 * @returns {ShellToken[]}
 */
export function shellTokens(command) {
  /** @type {ShellToken[]} */
  const out = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  /** @type {string | null} */
  let quote = null;
  const s = String(command ?? "");
  const flush = () => {
    if (inWord) out.push({ text: word, quoted });
    word = "";
    inWord = false;
    quoted = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) word += s[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      quoted = true;
    } else if (c === "\\" && i + 1 < s.length) {
      word += s[++i];
      inWord = true;
      quoted = true;
    } else if (/\s/.test(c)) {
      flush();
    } else if (c === "&" || c === "|" || c === ";" || c === ">" || c === "<") {
      // "2>" and "2>&1" stay together when the 2 started this word.
      let op = c;
      if ((c === ">" || c === "<") && inWord && /^\d$/.test(word)) {
        op = word + c;
        word = "";
        inWord = false;
        quoted = false;
      } else {
        flush();
      }
      while (i + 1 < s.length && /[&|>]/.test(s[i + 1]) && op.length < 4) op += s[++i];
      if (op.endsWith(">&") && /\d/.test(s[i + 1] ?? "")) op += s[++i];
      out.push({ text: op, quoted: false });
    } else {
      word += c;
      inWord = true;
    }
  }
  flush();
  return out;
}

/**
 * Splits a shell command into words: shellTokens without the quote marks.
 * @param {string} command
 * @returns {string[]}
 */
export function shellWords(command) {
  return shellTokens(command).map((t) => t.text);
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isOperator(token) {
  return OPERATORS.has(token) || /^\d?>{1,2}(?:&\d)?$/.test(token) || /^[&|;<>]+$/.test(token);
}

/**
 * The first tokens (at most KEY_TOKENS) of the first command, after leading `cd <dir> &&` (or `;`) steps and
 * `NAME=value` assignments are removed; the first command ends at a shell operator (&&, |, ;, a redirection) or
 * at "--" (arguments passed through).
 * @param {string} command
 * @returns {ShellToken[]}
 */
export function commandTokens(command) {
  let tokens = shellTokens(String(command ?? "").replace(/\r\n?/g, "\n"));
  for (;;) {
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0].text)) tokens = tokens.slice(1);
    if ((tokens[0]?.text === "cd" || tokens[0]?.text === "pushd") && tokens.length >= 2) {
      const next = tokens.findIndex((t, i) => i > 0 && isOperator(t.text));
      if (next === -1) return tokens.slice(0, KEY_TOKENS);
      if (tokens[next].text === "&&" || tokens[next].text === ";") {
        tokens = tokens.slice(next + 1);
        continue;
      }
    }
    break;
  }
  const end = tokens.findIndex((t) => isOperator(t.text) || t.text === "--");
  return (end === -1 ? tokens : tokens.slice(0, end)).slice(0, KEY_TOKENS);
}

/**
 * The normalized command key used to match a failure with its fix: the first words of the first command
 * (commandTokens). `npx`, `npm run`, `pnpm` and similar prefixes stay part of the key, so "npm test -- --run" has
 * the key of "npm test". "" when there is nothing left.
 *   "cd app && CI=1 npm run test -- --watch=false" → "npm run test"
 * @param {string} command
 * @returns {string}
 */
export function commandKey(command) {
  return truncateChars(
    commandTokens(command)
      .map((t) => t.text)
      .join(" "),
    MAX_KEY_CHARS,
    "",
  );
}

/**
 * The summary key of a command (lib/summary.mjs): what of it may travel, from its real tokens, so a quoted or
 * escaped token never does. Pass the redacted command.
 *   'mysql -uroot -pSecret shop' → "mysql … …"; 'cat "my notes.md"' → "cat …"; "npm run build" → "npm run build"
 * @param {string} command
 * @returns {string}
 */
export function summaryKeyOf(command) {
  return summaryKeyFromTokens(commandTokens(command));
}

// ------------------------------------------------------------------------------------ classification

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function exitCodeOf(v) {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * The exit code at the start of a PostToolUseFailure error ("Exit code 2 ..."), else the first one in it.
 * @param {unknown} error
 * @returns {number | null}
 */
export function parseExitCode(error) {
  if (typeof error !== "string") return null;
  const m = /^\s*Exit code:?\s*(-?\d+)/i.exec(error) ?? /\bExit code:?\s*(-?\d+)/i.exec(error);
  return m ? Number(m[1]) : null;
}

/**
 * Text of a tool response: stdout and stderr (or the response itself when it is a string).
 * @param {unknown} response
 * @returns {string}
 */
function responseText(response) {
  if (typeof response === "string") return response;
  if (!isPlainObject(response)) return "";
  const parts = [];
  for (const k of ["stdout", "stderr", "output", "error"]) {
    if (typeof response[k] === "string" && response[k] !== "") parts.push(response[k]);
  }
  return parts.join("\n");
}

/**
 * Classifies a PostToolUse / PostToolUseFailure hook input. Pure: no file or git access.
 * - PostToolUseFailure for Bash: a failure (exit code from "Exit code N"), unless is_interrupt is true.
 * - PostToolUse for Bash: a success, unless tool_response has a non-zero exitCode / exit_code / returnCode
 *   (then a failure) or interrupted is true (then ignored).
 * - PostToolUse for Skill: a skill use; for Read of `<skillsDir>/<name>/SKILL.md`: a skill view.
 * @param {Record<string, unknown>} input
 * @param {{ root?: string, skillsDir?: string }} [options]
 * @returns {ToolEvent}
 */
export function classifyEvent(input, options = {}) {
  if (!isPlainObject(input)) return { kind: "ignore", why: "input is not an object" };
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const event =
    typeof input.hook_event_name === "string"
      ? input.hook_event_name
      : typeof input.error === "string"
        ? "PostToolUseFailure"
        : "PostToolUse";
  const toolInput = isPlainObject(input.tool_input) ? input.tool_input : {};

  if (event === "PostToolUseFailure") {
    if (tool !== "Bash") return { kind: "ignore", why: `failure of ${tool || "an unknown tool"}` };
    if (input.is_interrupt === true || input.is_interrupt === "true") return { kind: "ignore", why: "interrupted" };
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (command.trim() === "") return { kind: "ignore", why: "no command" };
    const error = typeof input.error === "string" ? input.error : responseText(input.tool_response);
    return { kind: "fail", command, exit: parseExitCode(error), output: error, why: "PostToolUseFailure" };
  }
  if (event !== "PostToolUse") return { kind: "ignore", why: `event ${event}` };

  if (tool === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (command.trim() === "") return { kind: "ignore", why: "no command" };
    const response = input.tool_response;
    if (isPlainObject(response)) {
      if (response.interrupted === true || response.interrupted === "true") return { kind: "ignore", why: "interrupted" };
      for (const field of ["exitCode", "exit_code", "returnCode"]) {
        const code = exitCodeOf(response[field]);
        if (code !== null && code !== 0) {
          return { kind: "fail", command, exit: code, output: responseText(response), why: `tool_response.${field}` };
        }
      }
    }
    return { kind: "success", command, why: "PostToolUse" };
  }
  if (tool === "Skill") {
    const raw = typeof toolInput.skill === "string" ? toolInput.skill : typeof toolInput.name === "string" ? toolInput.name : "";
    const skill = raw.trim().replace(/^\/+/, "");
    if (skill === "" || skill.length > MAX_SKILL_CHARS || /[\s\0]/.test(skill)) return { kind: "ignore", why: "no skill name" };
    return { kind: "skill", skill, why: "Skill tool" };
  }
  if (tool === "Read") {
    const file = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
    const skill = skillOfPath(options.root ?? process.cwd(), file, options.skillsDir ?? ".claude/skills");
    return skill ? { kind: "skill-view", skill, why: "Read of a SKILL.md" } : { kind: "ignore", why: "Read of another file" };
  }
  return { kind: "ignore", why: `tool ${tool || "unknown"}` };
}

/**
 * The skill name when `file` is `<root>/<skillsDir>/<name>/SKILL.md`, else null.
 * @param {string} root
 * @param {string} file absolute, or relative to root
 * @param {string} skillsDir posix, relative to root
 * @returns {string | null}
 */
export function skillOfPath(root, file, skillsDir) {
  if (typeof file !== "string" || file === "" || file.includes("\0")) return null;
  const dir = normalizeRelPath(skillsDir);
  if (dir === null) return null;
  // Only look closer at paths that end in SKILL.md (cheap, and keeps realpath calls off the common path).
  if (!/[\\/]SKILL\.md$/.test(file)) return null;
  const rel = relativeToRoot(root, file);
  if (rel === null || !rel.startsWith(`${dir}/`)) return null;
  const rest = rel.slice(dir.length + 1).split("/");
  if (rest.length !== 2 || rest[1] !== "SKILL.md" || rest[0] === "" || rest[0].startsWith(".")) return null;
  return rest[0];
}

// ------------------------------------------------------------------------------------------- writing

/**
 * A short random id ("3f9a0c1b").
 * @returns {string}
 */
export function newId() {
  return randomBytes(4).toString("hex");
}

/**
 * Redacts a long output and keeps its tail. Only the end of the raw text is redacted (redacting megabytes
 * would be slow); when the raw text was cut, the first line of that window is dropped after redaction, so a
 * secret cut in half at the window's edge can not leak.
 * @param {string} text
 * @param {number} maxChars
 * @param {ReadonlyArray<string | RegExp>} [extraPatterns]
 * @returns {string}
 */
export function redactedTail(text, maxChars, extraPatterns) {
  const max = Math.max(0, Math.floor(maxChars));
  const raw = String(text ?? "");
  const window = max * 2 + 4096;
  const cut = raw.length > window;
  let safe = redact(cut ? raw.slice(raw.length - window) : raw, { extraPatterns });
  if (cut) {
    // Drop the window's first line: a secret cut at the edge would sit there, unrecognised.
    const nl = safe.indexOf("\n");
    safe = nl !== -1 ? safe.slice(nl + 1) : safe.slice(Math.min(safe.length, 2048));
  }
  return truncateTail(safe.replace(/\r\n?/g, "\n").trimEnd(), max, { marker: "…\n" });
}

/**
 * Appends one entry (redacted again as a whole) to the ledger, rotating first when the file would grow over
 * maxFileBytes. Returns the entry as written.
 * @param {string} root
 * @param {Record<string, unknown>} entry
 * @param {LedgerOptions} [options]
 * @returns {Record<string, unknown>}
 */
export function appendEntry(root, entry, options = {}) {
  const dir = ensureLocalDir(root);
  const file = path.join(dir, LEDGER_FILE);
  const safe = /** @type {Record<string, unknown>} */ (redactDeep(entry, { extraPatterns: options.extraRedactPatterns }));
  const line = `${JSON.stringify(safe)}\n`;
  const max = Math.max(1, Math.floor(options.maxFileBytes ?? 2_000_000));
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }
  if (size > 0 && size + Buffer.byteLength(line) > max) {
    fs.renameSync(file, path.join(dir, ROTATED_FILE));
  }
  appendLine(file, line);
  return safe;
}

/**
 * Reads the ledger (the rotated file first, then the current one), skipping lines that are not JSON objects.
 * @param {string} root
 * @param {{ session?: string | null, rotated?: boolean, maxBytes?: number }} [options]
 *   session: only entries of this session; rotated: include ledger.1.jsonl (default true)
 * @returns {Array<Record<string, unknown>>}
 */
export function readLedger(root, options = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  const files = options.rotated === false ? [ledgerPath(root)] : [rotatedLedgerPath(root), ledgerPath(root)];
  const session = options.session === undefined || options.session === null ? null : redact(String(options.session));
  for (const file of files) {
    const text = readText(file, { maxBytes: options.maxBytes ?? 64 * 1024 * 1024 });
    if (text === null) continue;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const v = JSON.parse(line);
        if (!isPlainObject(v)) continue;
        if (session !== null && v.session !== session) continue;
        out.push(v);
      } catch {
        // a torn or foreign line
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------- open failures

/**
 * @param {string} root
 * @param {string} sessionId
 * @returns {OpenFailure[]}
 */
export function readOpenFailures(root, sessionId) {
  const v = readSessionJson(root, sessionId, OPEN_FAILURES_FILE);
  const list = isPlainObject(v) && Array.isArray(v.open) ? v.open : [];
  /** @type {OpenFailure[]} */
  const out = [];
  for (const f of list) {
    if (!isPlainObject(f) || typeof f.id !== "string" || typeof f.key !== "string") continue;
    /** @type {Record<string, string>} */
    const snapshot = {};
    if (isPlainObject(f.snapshot)) for (const [p, h] of Object.entries(f.snapshot)) if (typeof h === "string") snapshot[p] = h;
    out.push({
      id: f.id,
      key: f.key,
      ts: typeof f.ts === "string" ? f.ts : "",
      attempts: typeof f.attempts === "number" && f.attempts > 0 ? Math.floor(f.attempts) : 1,
      head: typeof f.head === "string" && f.head !== "" ? f.head : null,
      snapshot,
      dirty: Array.isArray(f.dirty) ? f.dirty.filter((p) => typeof p === "string") : Object.keys(snapshot),
    });
  }
  return out;
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @param {OpenFailure[]} open
 */
function writeOpenFailures(root, sessionId, open) {
  writeSessionJson(root, sessionId, OPEN_FAILURES_FILE, { open: open.slice(-MAX_OPEN_FAILURES) });
}

/**
 * Files changed since a failure: files whose blob hash differs from the snapshot, files that became dirty
 * since, and files changed by commits made since (when HEAD moved). Files that were already dirty at the
 * failure but not hashed (beyond MAX_SNAPSHOT_FILES) count only when a commit touched them.
 * @param {string} root
 * @param {OpenFailure} failure
 * @returns {string[]}
 */
export function changedSinceFailure(root, failure) {
  /** @type {Set<string>} */
  const changed = new Set();
  const snapPaths = Object.keys(failure.snapshot);
  const now = hashFiles(root, snapPaths);
  for (const p of snapPaths) {
    if (now[p] !== undefined && now[p] !== failure.snapshot[p]) changed.add(p);
  }
  const before = new Set(failure.dirty);
  for (const p of uncommittedFiles(root)) {
    if (!before.has(p)) changed.add(p);
  }
  const current = head(root);
  if (failure.head && current && current !== failure.head && isSafeRef(failure.head)) {
    const r = runGit(root, ["diff", "--name-only", "-z", "--no-renames", "--relative", failure.head, current, "--"]);
    if (r.ok) {
      for (const p of r.stdout.split("\0")) {
        const rel = normalizeRelPath(p);
        if (rel) changed.add(rel);
      }
    }
  }
  return [...changed].sort();
}

// -------------------------------------------------------------------------------------------- record

/**
 * Records one PostToolUse / PostToolUseFailure event. Throws only when the ledger cannot be written
 * (the hook's failOpen logs it).
 * @param {string} root
 * @param {Record<string, unknown>} input the hook input
 * @param {LedgerOptions} [options]
 * @returns {RecordResult}
 */
export function recordToolEvent(root, input, options = {}) {
  const event = classifyEvent(input, { root, skillsDir: options.skillsDir });
  const rawSession = typeof input.session_id === "string" && input.session_id.trim() !== "" ? input.session_id : null;
  const ts = (options.now ?? new Date()).toISOString();
  const extraPatterns = options.extraRedactPatterns;
  const session = rawSession === null ? null : redact(rawSession);
  /** @type {RecordResult} */
  const none = { action: "none", entry: null, why: event.why, usedGit: false };

  if (event.kind === "ignore") return none;

  if (event.kind === "skill" || event.kind === "skill-view") {
    const entry = appendEntry(root, { id: newId(), ts, session, type: event.kind, skill: event.skill }, options);
    return { action: event.kind, entry, why: event.why, usedGit: false };
  }

  // The key is made from the redacted command (and redacted again), so a secret can never reach it, and the
  // same command always gives the same key. Summary mode keeps only its plain words (lib/summary.mjs).
  // An open failure is matched on the full key; in summary mode only its hash is kept on the device, so commands
  // whose summary keys look alike ("grep -rn …") never resolve each other.
  const summaryMode = options.mode === "summary";
  const safeCommand = redact(event.command ?? "", { extraPatterns });
  const fullKey = redact(commandKey(safeCommand), { extraPatterns });
  const key = summaryMode ? summaryKeyOf(safeCommand) : fullKey;
  const openKey = summaryMode && fullKey !== "" ? `h:${createHash("sha256").update(fullKey).digest("hex").slice(0, 32)}` : fullKey;
  if (event.kind === "success") {
    // Fast path: no open failure for this session → nothing to do, no git.
    if (rawSession === null || openKey === "") return { ...none, why: "success" };
    const open = readOpenFailures(root, rawSession);
    if (open.length === 0) return { ...none, why: "success" };
    const match = open.find((f) => f.key === openKey);
    if (!match) return { ...none, why: "success (no open failure for this key)" };
    if (summaryMode) {
      const entry = appendEntry(
        root,
        { id: newId(), ts, session, type: "resolved", failureId: match.id, attempts: match.attempts, key },
        options,
      );
      writeOpenFailures(
        root,
        rawSession,
        open.filter((f) => f !== match),
      );
      return { action: "resolved", entry, why: event.why, usedGit: false };
    }
    const changedFiles = changedSinceFailure(root, match);
    const entry = appendEntry(
      root,
      {
        id: newId(),
        ts,
        session,
        type: "resolved",
        failureId: match.id,
        attempts: match.attempts,
        key,
        cmd: truncateChars(safeCommand, MAX_CMD_CHARS),
        changedFiles: changedFiles.slice(0, MAX_CHANGED_FILES),
        ...(changedFiles.length > MAX_CHANGED_FILES ? { moreChangedFiles: changedFiles.length - MAX_CHANGED_FILES } : {}),
      },
      options,
    );
    writeOpenFailures(
      root,
      rawSession,
      open.filter((f) => f !== match),
    );
    return { action: "resolved", entry, why: event.why, usedGit: true };
  }

  // A failure.
  const id = newId();
  const entry = appendEntry(
    root,
    summaryMode
      ? { id, ts, session, type: "fail", key, exit: event.exit ?? null }
      : {
          id,
          ts,
          session,
          type: "fail",
          key,
          cmd: truncateChars(safeCommand, MAX_CMD_CHARS),
          exit: event.exit ?? null,
          out: redactedTail(event.output ?? "", options.maxOutputChars ?? 2000, extraPatterns),
        },
    options,
  );
  let usedGit = false;
  if (rawSession !== null && openKey !== "") {
    const open = readOpenFailures(root, rawSession);
    const previous = open.find((f) => f.key === openKey);
    const rest = open.filter((f) => f !== previous);
    const attempts = (previous?.attempts ?? 0) + 1;
    if (summaryMode) {
      // No snapshot: summary mode never records which files changed, so it needs no git.
      rest.push({ id, key: openKey, ts, attempts, head: null, snapshot: {}, dirty: [] });
    } else {
      usedGit = true;
      const dirty = uncommittedFiles(root).slice(0, MAX_DIRTY_PATHS);
      const snapshot = hashFiles(root, dirty.slice(0, MAX_SNAPSHOT_FILES));
      rest.push({ id, key, ts, attempts, head: head(root), snapshot, dirty });
    }
    writeOpenFailures(root, rawSession, rest);
  }
  return { action: "fail", entry, why: event.why, usedGit };
}
