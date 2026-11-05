// @ts-check
/**
 * The check runner. A check is a small module the repository owns, `.claude/hermod/checks/<id>.mjs`, that
 * protects against one known mistake:
 *
 *   // @ts-check
 *   /** @type {import('../lib/checks.mjs').Check} *\/
 *   export default {
 *     id: "example-check",               // must equal the file name without .mjs
 *     description: "One line: what it protects against",
 *     level: "error",                    // or "warn" (a warn check never blocks)
 *     when: ["public/sw.js"],            // optional: run only if a changed file matches one of these patterns
 *     run(ctx) { return { ok: true } },  // or { ok: false, message: "…" }; may be async
 *     examples: [                        // at least one passing and one failing example (for --self-test)
 *       { name: "passes when …", ctx: { changedFiles: [], files: {}, baseFiles: {} }, expect: true },
 *       { name: "fails when …", ctx: { changedFiles: ["public/sw.js"], files: { "public/sw.js": "…" } }, expect: false },
 *     ],
 *   };
 *
 * How checks run:
 * - Every check runs in its own worker thread, so a check that hangs (even in a synchronous loop) is stopped
 *   after CHECK_TIMEOUT_MS. A check that throws, times out, exits, or returns something other than
 *   { ok: boolean, message?: string } counts as failed with that reason. Anything a check prints is discarded.
 * - A check file that cannot be loaded, or whose shape is wrong (see validateCheck), is reported as an error.
 * - ctx (the real one): { root, base, changedFiles, read(p), readAt(ref, p), diff(p), git(args) }.
 *   read → the working-tree text or null; readAt → the text at a ref or null; diff → the unified diff of one
 *   file from base to the working tree ("" when none); git → { ok, code, stdout, stderr, error } (never throws).
 * - selfTest() runs each check's examples against a fake ctx built from the example (no git): read(p) reads
 *   `files`, readAt(ref, p) reads `baseFiles` (whatever the ref), diff(p) is a simple diff of the two, and
 *   git() always returns { ok: false }.
 *
 * Trust model: checks are code from the repository. Hermod never downloads or generates them. The Stop hook
 * runs only check files that are committed (present in HEAD); `check.mjs`, which a person or Claude runs by
 * hand, also runs uncommitted ones. Check files that lead outside the repository (symlinks) are refused.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { diffFile, runGit, showFile } from "./git.mjs";
import { isPlainObject, readText, truncateChars } from "./io.mjs";
import { matchAny, normalizeRelPath, patternError, relativeToRoot, resolveInside } from "./paths.mjs";

/** A check's run (and loading it) may take at most this long. */
export const CHECK_TIMEOUT_MS = 5000;
/** The levels a check can have. */
export const CHECK_LEVELS = Object.freeze(["error", "warn"]);
/** Default folder of the repository's checks (config checks.dir). */
export const DEFAULT_CHECKS_DIR = ".claude/hermod/checks";
/** Checks run at most this many at a time. */
export const DEFAULT_CONCURRENCY = 4;
/** Messages from a check are cut to this length. */
export const MAX_MESSAGE_CHARS = 500;
const WORKER_MARK = "hermod-check-worker-v1";
const WORKER_MEMORY_MB = 512;

/**
 * @typedef {object} GitResultLike
 * @property {boolean} ok
 * @property {number | null} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {string | null} error
 */

/**
 * @typedef {object} CheckContext
 * @property {string} root absolute repository root
 * @property {string | null} base the ref changes are measured from (null: uncommitted changes only)
 * @property {readonly string[]} changedFiles posix paths relative to root
 * @property {(p: string) => string | null} read working-tree text, or null when missing
 * @property {(ref: string, p: string) => string | null} readAt text at a ref, or null when missing there
 * @property {(p: string) => string} diff unified diff of one file from base to the working tree ("" when none)
 * @property {(args: string[]) => GitResultLike} git runs git in root (never throws)
 */

/**
 * @typedef {object} CheckOutcome
 * @property {boolean} ok
 * @property {string} [message] why it failed (shown to Claude and the person)
 */

/**
 * @typedef {object} CheckExampleContext
 * @property {string[]} [changedFiles]
 * @property {Record<string, string>} [files] working-tree content by path
 * @property {Record<string, string>} [baseFiles] content at base by path
 * @property {string} [base] default "HEAD"
 */

/**
 * @typedef {object} CheckExample
 * @property {string} name
 * @property {CheckExampleContext} [ctx]
 * @property {boolean} expect true when the check should pass for this example
 */

/**
 * @typedef {object} Check
 * @property {string} id equals the file name without .mjs
 * @property {string} description one line: what it protects against
 * @property {"error" | "warn"} level a warn check never blocks
 * @property {string[]} [when] run only when a changed file matches one of these path patterns
 * @property {(ctx: CheckContext) => CheckOutcome | Promise<CheckOutcome>} run
 * @property {CheckExample[]} examples at least one passing and one failing
 */

/**
 * @typedef {object} CheckFile
 * @property {string} id the file name without .mjs
 * @property {string} file absolute path
 * @property {string} rel posix path relative to the root
 */

/**
 * @typedef {"pass" | "fail" | "error" | "skip"} CheckStatus
 * pass/fail: the check ran; error: it could not be loaded, is invalid, threw, timed out or returned a wrong
 * value; skip: it did not need to run (its `when` list matched nothing, it is not committed, or time ran out).
 */

/**
 * @typedef {object} CheckResult
 * @property {string} id
 * @property {string} file posix path relative to the root
 * @property {string} description
 * @property {"error" | "warn"} level
 * @property {CheckStatus} status
 * @property {boolean} ok true for pass and skip
 * @property {string | null} message
 * @property {number} durationMs
 */

/**
 * @typedef {object} ExampleResult
 * @property {string} check check id
 * @property {string} file posix path relative to the root
 * @property {number} index 0-based position in examples
 * @property {string} name
 * @property {boolean} expect
 * @property {boolean | null} actual null when the check errored (threw, timed out, wrong return value)
 * @property {boolean} ok actual === expect
 * @property {string | null} message
 */

/**
 * @typedef {object} SelfTestCheck
 * @property {string} id
 * @property {string} file
 * @property {boolean} valid
 * @property {string[]} errors why the check is invalid or could not run
 * @property {ExampleResult[]} examples
 */

/**
 * @typedef {object} SelfTestReport
 * @property {string} dir
 * @property {SelfTestCheck[]} checks
 * @property {string[]} errors problems with the checks folder itself
 * @property {number} failures examples whose result differs from expect, plus invalid checks
 * @property {boolean} ok
 */

/**
 * @typedef {object} RunReport
 * @property {string} dir
 * @property {string | null} base
 * @property {string[]} changedFiles
 * @property {CheckResult[]} results
 * @property {string[]} errors problems with the checks folder itself
 */

/**
 * @typedef {object} RunOptions
 * @property {string} [dir] checks folder relative to root (default DEFAULT_CHECKS_DIR)
 * @property {string | null} [base]
 * @property {readonly string[]} [changedFiles]
 * @property {number} [timeoutMs] per check (default CHECK_TIMEOUT_MS; capped at it)
 * @property {number} [deadlineMs] total budget: checks not started in time are skipped
 * @property {number} [concurrency] default DEFAULT_CONCURRENCY
 * @property {boolean} [committedOnly] run only check files present in HEAD (the Stop hook sets this)
 */

// ---------------------------------------------------------------------------------------------- helpers

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * One message, trimmed and capped.
 * @param {unknown} text
 * @returns {string}
 */
function cleanMessage(text) {
  return truncateChars(String(text ?? "").trim(), MAX_MESSAGE_CHARS);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function shown(value) {
  if (typeof value === "function") return "a function";
  if (value === undefined) return "nothing";
  let s;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = String(value);
  }
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, string>}
 */
function isStringMap(value) {
  return isPlainObject(value) && Object.values(value).every((v) => typeof v === "string");
}

/**
 * True when the check has no `when` list, or a changed file matches one of its patterns.
 * @param {unknown} when
 * @param {readonly string[]} changedFiles
 * @returns {boolean}
 */
export function whenMatches(when, changedFiles) {
  if (!Array.isArray(when)) return true;
  return changedFiles.some((f) => matchAny(/** @type {string[]} */ (when), f));
}

// ------------------------------------------------------------------------------------------- validation

/**
 * Plain-English problems with a check module's default export (empty when it is a valid check).
 * @param {unknown} check
 * @param {string} expectedId the file name without .mjs
 * @returns {string[]}
 */
export function validateCheck(check, expectedId) {
  /** @type {string[]} */
  const errors = [];
  if (!isPlainObject(check)) {
    return [`must export a check object as its default export (got ${shown(check)})`];
  }
  if (typeof check.id !== "string" || check.id.trim() === "") {
    errors.push(`"id" must be text equal to the file name ("${expectedId}")`);
  } else if (check.id !== expectedId) {
    errors.push(`"id" is "${check.id}" but the file is ${expectedId}.mjs; they must be the same`);
  }
  if (typeof check.description !== "string" || check.description.trim() === "") {
    errors.push(`"description" must be one line of text saying what the check protects against`);
  }
  if (!CHECK_LEVELS.includes(/** @type {string} */ (check.level))) {
    errors.push(`"level" must be "error" or "warn" (got ${shown(check.level)})`);
  }
  if (check.when !== undefined) {
    if (!Array.isArray(check.when) || check.when.length === 0) {
      errors.push(`"when" must be a non-empty list of path patterns, or left out (got ${shown(check.when)})`);
    } else {
      for (const p of check.when) {
        const why = patternError(p);
        if (why) errors.push(`"when" has an unusable pattern: ${why}`);
      }
    }
  }
  if (typeof check.run !== "function") errors.push(`"run" must be a function (got ${shown(check.run)})`);
  if (!Array.isArray(check.examples)) {
    errors.push(`"examples" must be a list with at least one passing and one failing example`);
    return errors;
  }
  let passing = 0;
  let failing = 0;
  check.examples.forEach((ex, i) => {
    const at = `examples[${i}]`;
    if (!isPlainObject(ex)) {
      errors.push(`${at} must be an object like { name, ctx, expect } (got ${shown(ex)})`);
      return;
    }
    if (typeof ex.name !== "string" || ex.name.trim() === "") errors.push(`${at} needs a "name"`);
    if (typeof ex.expect !== "boolean") {
      errors.push(`${at} "expect" must be true (should pass) or false (should fail) (got ${shown(ex.expect)})`);
    } else if (ex.expect) {
      passing++;
    } else {
      failing++;
    }
    if (ex.ctx === undefined) return;
    if (!isPlainObject(ex.ctx)) {
      errors.push(`${at} "ctx" must be an object (got ${shown(ex.ctx)})`);
      return;
    }
    const c = ex.ctx;
    if (c.changedFiles !== undefined && (!Array.isArray(c.changedFiles) || c.changedFiles.some((f) => typeof f !== "string"))) {
      errors.push(`${at} ctx.changedFiles must be a list of paths`);
    }
    if (c.files !== undefined && !isStringMap(c.files)) errors.push(`${at} ctx.files must map paths to text`);
    if (c.baseFiles !== undefined && !isStringMap(c.baseFiles)) errors.push(`${at} ctx.baseFiles must map paths to text`);
    if (c.base !== undefined && typeof c.base !== "string") errors.push(`${at} ctx.base must be text`);
  });
  if (passing === 0) errors.push(`"examples" needs at least one example with expect: true`);
  if (failing === 0) errors.push(`"examples" needs at least one example with expect: false`);
  return errors;
}

// -------------------------------------------------------------------------------------------- contexts

/**
 * The real context a check runs with.
 * @param {string} root
 * @param {string | null} base
 * @param {readonly string[]} changedFiles
 * @returns {CheckContext}
 */
export function makeContext(root, base, changedFiles) {
  const absRoot = path.resolve(root);
  const files = Object.freeze([...changedFiles]);
  return Object.freeze({
    root: absRoot,
    base: base ?? null,
    changedFiles: files,
    /** @param {string} p */
    read: (p) => {
      const abs = resolveInside(absRoot, p);
      return abs === null ? null : readText(abs);
    },
    /**
     * @param {string} ref
     * @param {string} p
     */
    readAt: (ref, p) => (typeof ref === "string" ? showFile(absRoot, ref, p) : null),
    /** @param {string} p */
    diff: (p) => (base ? diffFile(absRoot, base, p) : ""),
    /** @param {string[]} args */
    git: (args) => {
      const list = Array.isArray(args) ? args.map((a) => String(a)) : [String(args)];
      const r = runGit(absRoot, list);
      return { ok: r.ok, code: r.code, stdout: r.stdout, stderr: r.stderr, error: r.error };
    },
  });
}

/**
 * A small unified diff of one file (for fake contexts): every old line removed, every new line added.
 * @param {string} rel
 * @param {string | null} before
 * @param {string | null} after
 * @returns {string}
 */
export function simpleDiff(rel, before, after) {
  if (before === after) return "";
  /** @param {string | null} t */
  const lines = (t) => {
    if (t === null || t === "") return [];
    const l = t.split("\n");
    if (l[l.length - 1] === "") l.pop();
    return l;
  };
  const a = lines(before);
  const b = lines(after);
  const out = [`diff --git a/${rel} b/${rel}`];
  if (before === null) out.push("new file mode 100644");
  if (after === null) out.push("deleted file mode 100644");
  out.push(before === null ? "--- /dev/null" : `--- a/${rel}`, after === null ? "+++ /dev/null" : `+++ b/${rel}`);
  out.push(`@@ -${a.length > 0 ? 1 : 0},${a.length} +${b.length > 0 ? 1 : 0},${b.length} @@`);
  for (const l of a) out.push(`-${l}`);
  for (const l of b) out.push(`+${l}`);
  return `${out.join("\n")}\n`;
}

/**
 * The fake context for one example (no git, no file system).
 * @param {CheckExampleContext | undefined} exampleCtx
 * @param {string} [root] reported as ctx.root (default "")
 * @returns {CheckContext}
 */
export function makeFakeContext(exampleCtx, root = "") {
  const c = isPlainObject(exampleCtx) ? exampleCtx : {};
  /**
   * @param {unknown} map
   * @returns {Map<string, string>}
   */
  const normalized = (map) => {
    /** @type {Map<string, string>} */
    const out = new Map();
    if (isPlainObject(map)) {
      for (const [k, v] of Object.entries(map)) {
        const rel = normalizeRelPath(k);
        if (rel !== null && typeof v === "string") out.set(rel, v);
      }
    }
    return out;
  };
  const files = normalized(c.files);
  const baseFiles = normalized(c.baseFiles);
  const changed = Array.isArray(c.changedFiles)
    ? c.changedFiles.map((f) => normalizeRelPath(f)).filter((f) => f !== null)
    : [];
  /** @param {string} p */
  const key = (p) => normalizeRelPath(p) ?? "";
  return Object.freeze({
    root,
    base: typeof c.base === "string" ? c.base : "HEAD",
    changedFiles: Object.freeze(/** @type {string[]} */ (changed)),
    /** @param {string} p */
    read: (p) => files.get(key(p)) ?? null,
    /**
     * @param {string} _ref
     * @param {string} p
     */
    readAt: (_ref, p) => baseFiles.get(key(p)) ?? null,
    /** @param {string} p */
    diff: (p) => simpleDiff(key(p), baseFiles.get(key(p)) ?? null, files.get(key(p)) ?? null),
    git: () => ({
      ok: false,
      code: null,
      stdout: "",
      stderr: "",
      error: "git is not available in --self-test examples; use read, readAt and diff",
    }),
  });
}

/**
 * Turns what run() returned into a status.
 * @param {unknown} value
 * @returns {{ status: CheckStatus, message: string | null }}
 */
export function normalizeOutcome(value) {
  if (isPlainObject(value) && typeof value.ok === "boolean") {
    if (value.ok) return { status: "pass", message: null };
    const msg = typeof value.message === "string" && value.message.trim() !== "" ? value.message : "failed (no message given)";
    return { status: "fail", message: cleanMessage(msg) };
  }
  return {
    status: "error",
    message: `returned ${shown(value)}; a check must return { ok: true } or { ok: false, message: "…" }`,
  };
}

/**
 * @param {Check} check
 * @param {CheckContext} ctx
 * @returns {Promise<{ status: CheckStatus, message: string | null }>}
 */
async function runOne(check, ctx) {
  try {
    return normalizeOutcome(await check.run(ctx));
  } catch (error) {
    return { status: "error", message: cleanMessage(`threw: ${errorMessage(error)}`) };
  }
}

// ---------------------------------------------------------------------------------------------- worker

/**
 * @typedef {object} WorkerTask
 * @property {string} mark
 * @property {"run" | "selftest"} mode
 * @property {string} file absolute path of the check
 * @property {string} id
 * @property {string} root
 * @property {string | null} base
 * @property {string[]} changedFiles
 */

/**
 * @typedef {{ description: string, level: "error" | "warn", examples: Array<{ name: string, expect: boolean }> }} CheckMeta
 */

/**
 * @param {unknown} check
 * @returns {CheckMeta}
 */
function describeCheck(check) {
  const c = isPlainObject(check) ? check : {};
  const level = c.level === "warn" ? "warn" : "error";
  const examples = Array.isArray(c.examples)
    ? c.examples.map((ex) => ({
        name: isPlainObject(ex) && typeof ex.name === "string" ? ex.name : "(no name)",
        expect: isPlainObject(ex) ? ex.expect === true : false,
      }))
    : [];
  return { description: typeof c.description === "string" ? c.description.trim() : "", level, examples };
}

/**
 * Runs inside the worker thread: loads one check, validates it, and runs it (or its examples).
 * @param {WorkerTask} task
 */
async function workerMain(task) {
  const port = /** @type {import("node:worker_threads").MessagePort} */ (parentPort);
  /** @param {object} m */
  const post = (m) => port.postMessage(m);
  /** @type {unknown} */
  let mod;
  try {
    mod = await import(pathToFileURL(task.file).href);
  } catch (error) {
    post({ type: "invalid", meta: describeCheck(null), errors: [cleanMessage(`could not be loaded: ${errorMessage(error)}`)] });
    return;
  }
  const check = isPlainObject(mod) ? mod.default : undefined;
  const meta = describeCheck(check);
  const errors = validateCheck(check, task.id);
  if (errors.length > 0) {
    post({ type: "invalid", meta, errors });
    return;
  }
  const valid = /** @type {Check} */ (check);
  post({ type: "meta", meta });
  if (task.mode === "run") {
    if (!whenMatches(valid.when, task.changedFiles)) {
      post({ type: "result", status: "skip", message: 'no changed file matches its "when" list' });
    } else {
      post({ type: "result", ...(await runOne(valid, makeContext(task.root, task.base, task.changedFiles))) });
    }
  } else {
    for (let i = 0; i < valid.examples.length; i++) {
      const ex = valid.examples[i];
      const ctx = makeFakeContext(ex.ctx, task.root);
      const res = whenMatches(valid.when, ctx.changedFiles)
        ? await runOne(valid, ctx)
        : { status: /** @type {CheckStatus} */ ("skip"), message: 'not run: no changed file matches its "when" list' };
      post({ type: "example", index: i, ...res });
    }
  }
  post({ type: "done" });
}

if (!isMainThread && isPlainObject(workerData) && workerData.mark === WORKER_MARK && parentPort) {
  workerMain(/** @type {WorkerTask} */ (workerData)).catch((error) => {
    parentPort?.postMessage({ type: "crash", message: cleanMessage(errorMessage(error)) });
  });
}

/**
 * Starts a worker for one task and collects its messages. A run (loading the check and running it) gets
 * timeoutMs in all; in self-test mode the timer restarts after loading and after each example, so each
 * example gets timeoutMs.
 * @param {WorkerTask} task
 * @param {number} timeoutMs
 * @returns {Promise<{ messages: any[], failure: string | null }>}
 */
function runWorker(task, timeoutMs) {
  return new Promise((resolve) => {
    /** @type {any[]} */
    const messages = [];
    let settled = false;
    /** @type {Worker} */
    let worker;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    /** @param {string | null} failure */
    const finish = (failure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) worker.terminate().catch(() => {});
      resolve({ messages, failure });
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(`timed out after ${Math.round(timeoutMs / 100) / 10} s`), timeoutMs);
    };
    try {
      worker = new Worker(fileURLToPath(import.meta.url), {
        workerData: task,
        stdout: true,
        stderr: true,
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB },
      });
    } catch (error) {
      finish(`could not start: ${errorMessage(error)}`);
      return;
    }
    // Whatever a check prints is discarded (it must never reach a hook's stdout).
    worker.stdout.resume();
    worker.stderr.resume();
    arm();
    worker.on("message", (m) => {
      messages.push(m);
      if (isPlainObject(m) && (m.type === "done" || m.type === "invalid" || m.type === "crash")) finish(null);
      else if (task.mode === "selftest") arm();
    });
    worker.on("error", (error) => finish(cleanMessage(`crashed: ${errorMessage(error)}`)));
    worker.on("exit", (code) =>
      finish(
        code === 0
          ? "stopped before returning a result (it called process.exit, or its promise never settles)"
          : `exited with code ${code} before returning a result`,
      ),
    );
  });
}

/**
 * Runs tasks with at most `limit` at a time; tasks not started before the deadline get `late()`.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @param {number | null} deadline epoch ms
 * @param {(item: T) => R} late
 * @returns {Promise<R[]>}
 */
async function pool(items, limit, fn, deadline, late) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = deadline !== null && Date.now() >= deadline ? late(items[i]) : await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return out;
}

// ------------------------------------------------------------------------------------------- discovery

/**
 * The check files in the checks folder: `*.mjs` directly inside it, sorted. Files whose name starts with "."
 * or "_" are left out (helpers can live there). Files that lead outside the root are refused.
 * @param {string} root
 * @param {string} [dir] relative to root (default DEFAULT_CHECKS_DIR)
 * @returns {{ dir: string, files: CheckFile[], errors: string[] }}
 */
export function listCheckFiles(root, dir = DEFAULT_CHECKS_DIR) {
  const absRoot = path.resolve(root);
  const rel = normalizeRelPath(dir);
  if (rel === null) return { dir: String(dir), files: [], errors: [`checks.dir "${dir}" is not a path inside the repository`] };
  const absDir = path.join(absRoot, ...rel.split("/"));
  /** @type {CheckFile[]} */
  const files = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return { dir: rel, files, errors };
  }
  let realDir = absDir;
  try {
    realDir = fs.realpathSync.native(absDir);
  } catch {
    // keep the lexical path
  }
  if (relativeToRoot(absRoot, realDir) === null) {
    return { dir: rel, files, errors: [`${rel}/ leads outside the repository; its checks are not run`] };
  }
  for (const e of entries) {
    if (!e.name.endsWith(".mjs") || e.name.startsWith(".") || e.name.startsWith("_")) continue;
    const abs = path.join(absDir, e.name);
    const relFile = `${rel}/${e.name}`;
    let real;
    try {
      if (!fs.statSync(abs).isFile()) continue;
      real = fs.realpathSync.native(abs);
    } catch {
      continue;
    }
    if (relativeToRoot(absRoot, real) === null) {
      errors.push(`${relFile} leads outside the repository; it is not run`);
      continue;
    }
    files.push({ id: e.name.slice(0, -".mjs".length), file: abs, rel: relFile });
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { dir: rel, files, errors };
}

/**
 * The paths (relative to root) of files in `dir` that are committed in HEAD.
 * @param {string} root
 * @param {string} dir
 * @returns {Set<string>}
 */
function committedFiles(root, dir) {
  const r = runGit(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", dir]);
  if (!r.ok) return new Set();
  return new Set(
    r.stdout
      .split("\0")
      .map((p) => normalizeRelPath(p))
      .filter((p) => p !== null),
  );
}

// -------------------------------------------------------------------------------------------- running

/**
 * @param {RunOptions} options
 * @returns {number}
 */
function timeoutOf(options) {
  const t = Number(options.timeoutMs ?? CHECK_TIMEOUT_MS);
  return Number.isFinite(t) && t > 0 ? Math.min(t, CHECK_TIMEOUT_MS) : CHECK_TIMEOUT_MS;
}

/**
 * Runs the repository's checks. Never throws.
 * @param {string} root
 * @param {RunOptions} [options]
 * @returns {Promise<RunReport>}
 */
export async function runChecks(root, options = {}) {
  const absRoot = path.resolve(root);
  const listing = listCheckFiles(absRoot, options.dir ?? DEFAULT_CHECKS_DIR);
  const changedFiles = [...(options.changedFiles ?? [])]
    .map((f) => normalizeRelPath(f))
    .filter((f) => f !== null);
  const base = options.base ?? null;
  const timeoutMs = timeoutOf(options);
  const deadline = typeof options.deadlineMs === "number" ? Date.now() + options.deadlineMs : null;
  const committed = options.committedOnly ? committedFiles(absRoot, listing.dir) : null;

  /**
   * @param {CheckFile} f
   * @param {Partial<CheckResult>} fields
   * @returns {CheckResult}
   */
  const result = (f, fields) => ({
    id: f.id,
    file: f.rel,
    description: "",
    level: "error",
    status: "error",
    ok: false,
    message: null,
    durationMs: 0,
    ...fields,
  });

  const results = await pool(
    listing.files,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async (f) => {
      if (committed && !committed.has(f.rel)) {
        return result(f, { status: "skip", ok: true, message: "not run: the file is not committed yet" });
      }
      const started = Date.now();
      const { messages, failure } = await runWorker(
        { mark: WORKER_MARK, mode: "run", file: f.file, id: f.id, root: absRoot, base, changedFiles },
        timeoutMs,
      );
      const durationMs = Date.now() - started;
      const metaMsg = messages.find((m) => m.type === "meta" || m.type === "invalid");
      /** @type {CheckMeta} */
      const meta = metaMsg?.meta ?? describeCheck(null);
      const common = { description: meta.description, level: meta.level, durationMs };
      if (metaMsg?.type === "invalid") {
        return result(f, { ...common, message: cleanMessage(`is not a valid check: ${metaMsg.errors.join("; ")}`) });
      }
      const crash = messages.find((m) => m.type === "crash");
      if (crash) return result(f, { ...common, message: cleanMessage(`crashed: ${crash.message}`) });
      const res = messages.find((m) => m.type === "result");
      if (!res) return result(f, { ...common, message: failure ?? "did not return a result" });
      /** @type {CheckStatus} */
      const status = res.status;
      return result(f, { ...common, status, ok: status === "pass" || status === "skip", message: res.message ?? null });
    },
    deadline,
    (f) => result(f, { status: "skip", ok: true, message: "not run: out of time" }),
  );
  return { dir: listing.dir, base, changedFiles, results, errors: listing.errors };
}

/**
 * The results that make a run fail: error-level checks that failed or errored.
 * @param {readonly CheckResult[]} results
 * @returns {CheckResult[]}
 */
export function blockingFailures(results) {
  return results.filter((r) => r.level === "error" && (r.status === "fail" || r.status === "error"));
}

/**
 * Runs every check's examples against fake contexts and reports each example whose result differs from its
 * `expect` (and every check that is invalid). Never throws.
 * @param {string} root
 * @param {{ dir?: string, timeoutMs?: number, concurrency?: number }} [options]
 * @returns {Promise<SelfTestReport>}
 */
export async function selfTest(root, options = {}) {
  const absRoot = path.resolve(root);
  const listing = listCheckFiles(absRoot, options.dir ?? DEFAULT_CHECKS_DIR);
  const timeoutMs = timeoutOf(options);
  const checks = await pool(
    listing.files,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async (f) => {
      const { messages, failure } = await runWorker(
        { mark: WORKER_MARK, mode: "selftest", file: f.file, id: f.id, root: absRoot, base: null, changedFiles: [] },
        timeoutMs,
      );
      /** @type {SelfTestCheck} */
      const out = { id: f.id, file: f.rel, valid: true, errors: [], examples: [] };
      const invalid = messages.find((m) => m.type === "invalid");
      if (invalid) return { ...out, valid: false, errors: invalid.errors };
      const metaMsg = messages.find((m) => m.type === "meta");
      if (!metaMsg) return { ...out, valid: false, errors: [failure ?? "did not report its examples"] };
      /** @type {CheckMeta} */
      const meta = metaMsg.meta;
      const crash = messages.find((m) => m.type === "crash");
      /** @type {Map<number, any>} */
      const byIndex = new Map(messages.filter((m) => m.type === "example").map((m) => [m.index, m]));
      let stopped = false;
      meta.examples.forEach((ex, index) => {
        const got = byIndex.get(index);
        /** @type {boolean | null} */
        let actual = null;
        /** @type {string | null} */
        let message;
        if (got) {
          actual = got.status === "pass" || got.status === "skip" ? true : got.status === "fail" ? false : null;
          message = got.message ?? null;
        } else {
          message = stopped ? "not run (an earlier example did not finish)" : (crash?.message ?? failure ?? "not run");
          stopped = true;
        }
        out.examples.push({ check: f.id, file: f.rel, index, name: ex.name, expect: ex.expect, actual, ok: actual === ex.expect, message });
      });
      return out;
    },
    null,
    (f) => ({ id: f.id, file: f.rel, valid: false, errors: ["not run"], examples: [] }),
  );
  const failures =
    checks.filter((c) => !c.valid).length + checks.reduce((n, c) => n + c.examples.filter((e) => !e.ok).length, 0);
  return { dir: listing.dir, checks, errors: listing.errors, failures, ok: failures === 0 && listing.errors.length === 0 };
}
