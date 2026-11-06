// @ts-check
/**
 * Small, dependency-free I/O helpers shared by the hooks and CLIs.
 *
 * - readStdinJson(): hook input with a timeout and a size limit.
 * - resolveRoot(): the repository root (CLAUDE_PROJECT_DIR, the hook's cwd, or the git top level).
 * - readText()/readJson(): reads that return null instead of throwing.
 * - writeFileAtomic()/appendLine(): writes that never leave half-written files.
 * - ensureLocalDir(): `.claude/hermod/.local/`, with a `.gitignore` containing "*" so nothing in it is
 *   ever committed. It refuses to write through a symlink that leads outside the repository.
 * - logError(): one redacted line in `.local/errors.log`, capped at 100 KB.
 * - truncateHead()/truncateTail()/truncateChars(): cuts that never split a character (a grapheme: a letter and
 *   its combining marks, an emoji sequence, a flag) and prefer line boundaries.
 * - failOpen(main): runs a hook; any error is logged and the process exits 0 with no output.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toplevel } from "./git.mjs";
import { redact } from "./redact.mjs";

/** The kit's folder inside a repository (posix, repository-relative). */
export const HERMOD_DIR = ".claude/hermod";
/** Local, never-committed data (posix, repository-relative). */
export const LOCAL_DIR = ".claude/hermod/.local";
/** errors.log never grows beyond this. */
export const ERROR_LOG_MAX_BYTES = 100 * 1024;
/** failOpen() gives up after this long (a hook must never hang a session). */
export const DEFAULT_HOOK_TIMEOUT_MS = 8000;
const DEFAULT_STDIN_TIMEOUT_MS = 2000;
const DEFAULT_STDIN_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_READ_MAX_BYTES = 16 * 1024 * 1024;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Removes a leading byte-order mark.
 * @param {string} text
 * @returns {string}
 */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * One line describing an error: its message and, for Error objects, where it was thrown.
 * @param {unknown} error
 * @returns {string}
 */
export function formatError(error) {
  if (error instanceof Error) {
    const where = /\(?([^()\s]+:\d+:\d+)\)?\s*$/m.exec(String(error.stack ?? "").split("\n")[1] ?? "")?.[1];
    const at = where ? ` (at ${path.basename(where)})` : "";
    return `${error.name}: ${error.message}${at}`.replace(/\s*\r?\n\s*/g, " | ");
  }
  return String(error).replace(/\s*\r?\n\s*/g, " | ");
}

// ---------------------------------------------------------------------------------------------- paths

/**
 * Absolute path of a file inside `.claude/hermod/`.
 * @param {string} root
 * @param {...string} parts
 * @returns {string}
 */
export function hermodPath(root, ...parts) {
  return path.join(path.resolve(root), ".claude", "hermod", ...parts);
}

/**
 * Absolute path of `.claude/hermod/.local/` (it may not exist yet).
 * @param {string} root
 * @returns {string}
 */
export function localDir(root) {
  return hermodPath(root, ".local");
}

/**
 * The repository root.
 * Order: an explicit root (for example --root) → CLAUDE_PROJECT_DIR → the hook input's cwd →
 * the git top level of cwd (only with useGit) → cwd.
 * @param {{ root?: string | null, env?: NodeJS.ProcessEnv, cwd?: string, input?: unknown, useGit?: boolean }} [options]
 * @returns {string} absolute path
 */
export function resolveRoot(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (typeof options.root === "string" && options.root.trim() !== "") return path.resolve(cwd, options.root);
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (typeof projectDir === "string" && projectDir.trim() !== "") return path.resolve(cwd, projectDir);
  const inputCwd = isPlainObject(options.input) ? options.input.cwd : undefined;
  if (typeof inputCwd === "string" && inputCwd.trim() !== "") return path.resolve(cwd, inputCwd);
  if (options.useGit) {
    const top = toplevel(cwd);
    if (top) return top;
  }
  return path.resolve(cwd);
}

/**
 * True when this module file is the script node was started with (`node file.mjs`).
 * @param {string} metaUrl import.meta.url of the calling module
 * @returns {boolean}
 */
export function isMainModule(metaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(path.resolve(argv1));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------- reads

/**
 * Reads a UTF-8 text file. Returns null when it is missing, a folder or unreadable; never throws.
 * Files larger than maxBytes are cut at maxBytes (on a character boundary). A leading BOM is removed.
 * @param {string} file
 * @param {{ maxBytes?: number }} [options]
 * @returns {string | null}
 */
export function readText(file, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_READ_MAX_BYTES;
  /** @type {number | null} */
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const size = Math.min(st.size, Math.max(0, maxBytes));
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = fs.readSync(fd, buf, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString("utf8");
    // A cut in the middle of a multi-byte character decodes to U+FFFD; drop it.
    while (st.size > maxBytes && text.endsWith(String.fromCharCode(0xfffd))) text = text.slice(0, -1);
    return stripBom(text);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/**
 * Reads and parses a JSON file. Never throws.
 * @param {string} file
 * @returns {{ found: boolean, value: unknown, error: string | null }}
 */
export function readJson(file) {
  const text = readText(file);
  if (text === null) {
    return { found: fs.existsSync(file), value: null, error: fs.existsSync(file) ? "could not be read" : null };
  }
  try {
    return { found: true, value: JSON.parse(text), error: null };
  } catch (error) {
    return { found: true, value: null, error: `is not valid JSON: ${error instanceof Error ? error.message : error}` };
  }
}

// --------------------------------------------------------------------------------------------- writes

/**
 * Synchronous sleep for short retry pauses.
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Renames, retrying briefly on Windows when the target is busy; as a last resort copies.
 * @param {string} from
 * @param {string} to
 */
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      const busy = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!busy) throw error;
      if (attempt >= 4) {
        fs.copyFileSync(from, to);
        fs.rmSync(from, { force: true });
        return;
      }
      sleepSync(15 * (attempt + 1));
    }
  }
}

/**
 * Writes a file atomically: a temporary file in the same folder, then a rename. Creates parent folders.
 * Throws a plain Error when it fails (the temporary file is removed).
 * @param {string} file
 * @param {string | Uint8Array} data
 */
export function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { flag: "wx" });
    renameWithRetry(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing to clean up
    }
    throw new Error(`could not write ${file}: ${error instanceof Error ? error.message : error}`, { cause: error });
  }
}

/**
 * Appends one line (a newline is added when missing). Creates parent folders.
 * @param {string} file
 * @param {string} line
 */
export function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`);
}

/**
 * @param {string} p
 * @returns {string}
 */
function realpathOr(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Creates `.claude/hermod/.local/` with a `.gitignore` that contains "*", and returns its absolute path.
 * Throws when the kit is not installed (no `.claude/hermod/` folder) or when the folder, or a folder on
 * the way to it, is a symlink that leads outside the repository.
 * @param {string} root
 * @returns {string}
 */
export function ensureLocalDir(root) {
  const absRoot = path.resolve(root);
  const hermod = hermodPath(absRoot);
  if (!fs.existsSync(hermod) || !fs.statSync(hermod).isDirectory()) {
    throw new Error(`Hermod is not installed in ${absRoot} (${HERMOD_DIR}/ is missing)`);
  }
  const realRoot = realpathOr(absRoot);
  const dir = localDir(absRoot);
  for (const p of [path.join(absRoot, ".claude"), hermod, dir]) {
    if (fs.existsSync(p) && !isInside(realRoot, realpathOr(p))) {
      throw new Error(`refusing to write outside the repository: ${p} leads to ${realpathOr(p)}`);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  const current = readText(ignore);
  if (current === null || !current.split(/\r?\n/).some((l) => l.trim() === "*")) {
    writeFileAtomic(ignore, "*\n");
  }
  return dir;
}

/**
 * Appends one redacted line to `.claude/hermod/.local/errors.log` and keeps the file at or below
 * ERROR_LOG_MAX_BYTES (older lines are dropped first). Never throws, and writes nothing when the kit is not
 * installed in root.
 * @param {string} root
 * @param {unknown} error
 * @param {string} [context] for example "session-start"
 * @param {{ maxBytes?: number, now?: Date }} [options]
 */
export function logError(root, error, context = "", options = {}) {
  try {
    const maxBytes = options.maxBytes ?? ERROR_LOG_MAX_BYTES;
    const dir = ensureLocalDir(root);
    const file = path.join(dir, "errors.log");
    const stamp = (options.now ?? new Date()).toISOString();
    let line = `${stamp}${context ? ` [${context}]` : ""} ${redact(formatError(error))}`;
    line = truncateChars(line, 2000, "…");
    const lineBytes = Buffer.byteLength(line) + 1;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    if (size + lineBytes > maxBytes) {
      const keepBytes = Math.max(0, Math.floor(maxBytes / 2) - lineBytes);
      const old = readText(file) ?? "";
      const tail = Buffer.from(old, "utf8").subarray(Math.max(0, Buffer.byteLength(old) - keepBytes)).toString("utf8");
      const firstBreak = tail.indexOf("\n");
      const kept = firstBreak === -1 ? "" : tail.slice(firstBreak + 1);
      writeFileAtomic(file, `${kept}${line}\n`);
    } else {
      fs.appendFileSync(file, `${line}\n`);
    }
  } catch {
    // Logging must never break a hook.
  }
}

// ------------------------------------------------------------------------------------------ truncation

/**
 * @param {number} code
 * @returns {boolean}
 */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The largest end index ≤ i that does not split a surrogate pair.
 * @param {string} text
 * @param {number} i
 * @returns {number}
 */
export function safeEnd(text, i) {
  if (i <= 0) return 0;
  if (i >= text.length) return text.length;
  return isHighSurrogate(text.charCodeAt(i - 1)) && isLowSurrogate(text.charCodeAt(i)) ? i - 1 : i;
}

/**
 * The smallest start index ≥ i that does not split a surrogate pair.
 * @param {string} text
 * @param {number} i
 * @returns {number}
 */
export function safeStart(text, i) {
  if (i <= 0) return 0;
  if (i >= text.length) return text.length;
  return isLowSurrogate(text.charCodeAt(i)) && isHighSurrogate(text.charCodeAt(i - 1)) ? i + 1 : i;
}

/** @type {Intl.Segmenter | null} */
const SEGMENTER =
  typeof Intl === "object" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;
/** How far around a cut the grapheme search looks (segmenting the whole text would cost O(n) per cut). */
const GRAPHEME_WINDOW = 1024;

/**
 * The segment of a window around i that contains index i (relative to the window), or null.
 * @param {string} text
 * @param {number} i 0 < i < text.length
 * @returns {{ start: number, end: number, windowStart: number, windowEnd: number } | null}
 */
function graphemeAround(text, i) {
  if (!SEGMENTER) return null;
  const windowStart = safeStart(text, Math.max(0, i - GRAPHEME_WINDOW));
  const windowEnd = safeEnd(text, Math.min(text.length, i + GRAPHEME_WINDOW));
  try {
    const seg = SEGMENTER.segment(text.slice(windowStart, windowEnd)).containing(i - windowStart);
    if (!seg) return null;
    const start = windowStart + seg.index;
    return { start, end: start + seg.segment.length, windowStart, windowEnd };
  } catch {
    return null;
  }
}

/**
 * The largest end index ≤ i that does not split a grapheme (a letter and its combining marks, an emoji ZWJ
 * sequence, a flag). Falls back to safeEnd (surrogate pairs only) for clusters longer than the search window.
 * @param {string} text
 * @param {number} i
 * @returns {number}
 */
export function graphemeEnd(text, i) {
  if (i <= 0) return 0;
  if (i >= text.length) return text.length;
  const g = graphemeAround(text, i);
  // A cluster that starts at the window's own start may really start earlier: not trustworthy.
  if (!g || (g.start === g.windowStart && g.windowStart > 0)) return safeEnd(text, i);
  return g.start;
}

/**
 * The smallest start index ≥ i that does not split a grapheme. Falls back to safeStart for clusters longer
 * than the search window.
 * @param {string} text
 * @param {number} i
 * @returns {number}
 */
export function graphemeStart(text, i) {
  if (i <= 0) return 0;
  if (i >= text.length) return text.length;
  const g = graphemeAround(text, i);
  if (!g) return safeStart(text, i);
  if (g.start === i) return i;
  if (g.end === g.windowEnd && g.windowEnd < text.length) return safeStart(text, i);
  if (g.start === g.windowStart && g.windowStart > 0) return safeStart(text, i);
  return g.end;
}

/**
 * Cuts text to at most maxChars UTF-16 units including the ellipsis, never splitting a grapheme.
 * Text that already fits is returned unchanged.
 * @param {unknown} text
 * @param {number} maxChars
 * @param {string} [ellipsis] default "…"
 * @returns {string}
 */
export function truncateChars(text, maxChars, ellipsis = "…") {
  const s = String(text ?? "");
  const max = Math.floor(maxChars);
  if (s.length <= max) return s;
  if (!(max > 0)) return "";
  if (ellipsis.length >= max) return s.slice(0, graphemeEnd(s, max));
  return s.slice(0, graphemeEnd(s, max - ellipsis.length)).trimEnd() + ellipsis;
}

/**
 * @typedef {object} TruncateOptions
 * @property {string} [marker] appended (head) or prepended (tail) when text is cut; counts toward the limit.
 *   Start a head marker with "\n" (end a tail marker with "\n") to put it on its own line.
 * @property {boolean} [preferLines] cut at a line boundary when that keeps at least minKeep of the budget
 *   (default true); otherwise at a space, otherwise anywhere (never inside a grapheme)
 * @property {number} [minKeep] share of the budget a nicer cut may give up, 0..1 (default 0.5)
 */

/**
 * Keeps the start of text within maxChars (marker included). Text that fits is returned unchanged.
 * @param {unknown} text
 * @param {number} maxChars
 * @param {TruncateOptions} [options]
 * @returns {string}
 */
export function truncateHead(text, maxChars, options = {}) {
  const s = String(text ?? "");
  const max = Math.floor(maxChars);
  if (s.length <= max) return s;
  if (!(max > 0)) return "";
  const marker = options.marker ?? "";
  if (marker.length >= max) return truncateChars(marker, max, "");
  const budget = max - marker.length;
  const minKeep = budget * (options.minKeep ?? 0.5);
  let cut = graphemeEnd(s, budget);
  if (options.preferLines ?? true) {
    const nl = s.lastIndexOf("\n", budget);
    if (nl >= 0 && nl >= minKeep) {
      cut = nl;
    } else {
      const sp = Math.max(s.lastIndexOf(" ", budget), s.lastIndexOf("\t", budget));
      if (sp >= 0 && sp >= minKeep) cut = sp;
    }
  }
  return s.slice(0, cut).replace(/[ \t\r]+$/, "") + marker;
}

/**
 * Keeps the end of text within maxChars (marker included), for command output. Text that fits is
 * returned unchanged.
 * @param {unknown} text
 * @param {number} maxChars
 * @param {TruncateOptions} [options]
 * @returns {string}
 */
export function truncateTail(text, maxChars, options = {}) {
  const s = String(text ?? "");
  const max = Math.floor(maxChars);
  if (s.length <= max) return s;
  if (!(max > 0)) return "";
  const marker = options.marker ?? "";
  if (marker.length >= max) return truncateChars(marker, max, "");
  const budget = max - marker.length;
  const minKeep = budget * (options.minKeep ?? 0.5);
  let start = graphemeStart(s, s.length - budget);
  if ((options.preferLines ?? true) && s[start - 1] !== "\n") {
    const nl = s.indexOf("\n", start);
    if (nl >= 0 && s.length - (nl + 1) >= minKeep) start = nl + 1;
  }
  return marker + s.slice(start);
}

// ---------------------------------------------------------------------------------------------- stdin

/**
 * @typedef {object} StdinOptions
 * @property {NodeJS.ReadableStream & { isTTY?: boolean, destroy?: () => void }} [stream] default process.stdin
 * @property {number} [timeoutMs] give up waiting for the end of input after this long (default 2000)
 * @property {number} [maxBytes] stop reading beyond this size (default 32 MB)
 */

/**
 * Reads all of stdin as UTF-8. Never throws and never waits longer than timeoutMs.
 * A terminal (TTY) gives "" at once.
 * @param {StdinOptions} [options]
 * @returns {Promise<{ text: string, timedOut: boolean, tooLarge: boolean }>}
 */
export function readStdinText(options = {}) {
  const stream = options.stream ?? process.stdin;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STDIN_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_STDIN_MAX_BYTES;
  return new Promise((resolve) => {
    if (stream.isTTY) {
      resolve({ text: "", timedOut: false, tooLarge: false });
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let done = false;
    /**
     * @param {boolean} timedOut
     * @param {boolean} tooLarge
     */
    const finish = (timedOut, tooLarge) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onEnd);
      if (timedOut || tooLarge) {
        try {
          stream.pause();
          stream.destroy?.();
        } catch {
          // the stream is gone already
        }
      }
      resolve({ text: Buffer.concat(chunks).toString("utf8"), timedOut, tooLarge });
    };
    /** @param {Buffer | string} chunk */
    const onData = (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      size += buf.length;
      if (size > maxBytes) {
        finish(false, true);
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => finish(false, false);
    const timer = setTimeout(() => finish(true, false), timeoutMs);
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onEnd);
    stream.resume();
  });
}

/**
 * Reads the hook input: a JSON object on stdin. Empty input gives {}.
 * Throws a plain-English Error for input that is too large, not JSON, or not an object
 * (inside failOpen that error is logged and the hook exits 0).
 * @param {StdinOptions} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readStdinJson(options = {}) {
  const { text, timedOut, tooLarge } = await readStdinText(options);
  if (tooLarge) {
    throw new Error(`hook input on stdin is larger than ${options.maxBytes ?? DEFAULT_STDIN_MAX_BYTES} bytes`);
  }
  const trimmed = stripBom(text).trim();
  if (trimmed === "") return {};
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`hook input on stdin is not valid JSON${timedOut ? " (stdin did not close in time)" : ""}: ${why}`, {
      cause: error,
    });
  }
  if (!isPlainObject(value)) throw new Error("hook input on stdin must be a JSON object");
  return value;
}

// ------------------------------------------------------------------------------------------- failOpen

/**
 * @typedef {object} HookContext
 * @property {string | null} root set this once known, so errors are logged in the right repository
 */

/**
 * @typedef {object} FailOpenOptions
 * @property {string} [context] name used in errors.log, for example "post-tool"
 * @property {string | null} [root] where to log errors (default: ctx.root, else CLAUDE_PROJECT_DIR, else cwd)
 * @property {number} [timeoutMs] watchdog (default DEFAULT_HOOK_TIMEOUT_MS)
 * @property {boolean} [exit] call process.exit(0) at the end (default true; tests pass false)
 * @property {NodeJS.WritableStream} [stdout] default process.stdout
 */

/**
 * @param {unknown} output
 * @returns {string}
 */
function renderOutput(output) {
  if (output === undefined || output === null || output === "") return "";
  if (typeof output === "string") return output;
  return JSON.stringify(output);
}

/**
 * Runs a hook's main function so that it can never break a session:
 * - its return value (a string, or an object printed as JSON) is written to stdout only on success;
 * - any error, rejected promise, uncaught exception or a run longer than timeoutMs is written as one line to
 *   `.claude/hermod/.local/errors.log`, nothing is printed, and the process exits 0.
 * @param {(ctx: HookContext) => unknown} main
 * @param {FailOpenOptions} [options]
 * @returns {Promise<{ ok: boolean, output: string, error: string | null }>}
 */
export function failOpen(main, options = {}) {
  const context = options.context ?? "hook";
  const timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const exit = options.exit ?? true;
  const out = options.stdout ?? process.stdout;
  /** @type {HookContext} */
  const ctx = { root: options.root ?? null };
  return new Promise((resolve) => {
    let settled = false;
    /**
     * @param {boolean} ok
     * @param {unknown} output
     * @param {unknown} error
     */
    const finish = (ok, output, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("uncaughtException", onFatal);
      process.removeListener("unhandledRejection", onFatal);
      let text = "";
      let failure = error;
      if (ok) {
        try {
          text = renderOutput(output);
        } catch (renderError) {
          ok = false;
          failure = renderError;
        }
      }
      if (!ok) logError(ctx.root ?? resolveRoot(), failure, context);
      const result = { ok, output: ok ? text : "", error: ok ? null : formatError(failure) };
      const end = () => {
        resolve(result);
        if (exit) process.exit(0);
      };
      if (ok && text !== "") {
        out.on("error", () => {});
        out.write(text, () => end());
      } else {
        end();
      }
    };
    /** @param {unknown} error */
    const onFatal = (error) => finish(false, null, error);
    process.on("uncaughtException", onFatal);
    process.on("unhandledRejection", onFatal);
    const timer = setTimeout(() => finish(false, null, new Error(`${context} timed out after ${timeoutMs} ms`)), timeoutMs);
    Promise.resolve()
      .then(() => main(ctx))
      .then(
        (output) => finish(true, output, null),
        (error) => finish(false, null, error),
      );
  });
}
