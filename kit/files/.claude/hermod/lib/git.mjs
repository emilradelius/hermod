// @ts-check
/**
 * Read-only git helpers for the hooks and CLIs.
 *
 * - git runs through spawnSync with an argument list (never a shell string), a 3 s timeout per call,
 *   GIT_OPTIONAL_LOCKS=0 (no index refresh writes), LC_ALL=C, no pager, no prompts, no colour and literal
 *   pathspecs.
 * - Every function returns a safe value on failure (null, "", [], {} or false) and never throws.
 * - Paths in results are posix and relative to `root`, also when `root` is a subfolder of the repository
 *   (files outside `root` are left out).
 * - Refs that start with "-" or contain spaces are refused, so a ref can never be read as a git option.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeRelPath, resolveInside, toPosix } from "./paths.mjs";

/** Timeout for every git call, in milliseconds. */
export const GIT_TIMEOUT_MS = 3000;
const MAX_BUFFER = 64 * 1024 * 1024;
const REMOVED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
];

/**
 * @typedef {object} GitResult
 * @property {boolean} ok true when git ran and exited with code 0
 * @property {number | null} code exit code (null when git did not run or was killed)
 * @property {string} stdout
 * @property {string} stderr
 * @property {string | null} error plain-English reason when ok is false
 */

/**
 * @typedef {object} GitBufferResult
 * @property {boolean} ok
 * @property {number | null} code
 * @property {Buffer} stdout
 * @property {string} stderr
 * @property {string | null} error
 */

/**
 * @typedef {object} GitOptions
 * @property {string} [input] written to git's stdin
 * @property {number} [timeoutMs] default GIT_TIMEOUT_MS
 * @property {number} [maxBuffer] default 64 MB
 */

/**
 * @typedef {object} StatusEntry
 * @property {string} path posix, relative to root
 * @property {string | null} origPath the old path of a rename or copy
 * @property {string} index status letter for the index ("M", "A", "D", "R", "?", ...)
 * @property {string} worktree status letter for the working tree
 */

/**
 * @typedef {object} BranchInfo
 * @property {string} name short name ("main", "origin/feature-x")
 * @property {string} ref full name ("refs/heads/main")
 * @property {string} sha
 * @property {string} date ISO time of the last commit
 * @property {string} age "3 days ago"
 */

/**
 * @typedef {object} CommitMessage
 * @property {string} sha
 * @property {string} date YYYY-MM-DD (committer date)
 * @property {string} subject
 * @property {string} body
 */

/** @returns {NodeJS.ProcessEnv} */
function gitEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env };
  for (const key of REMOVED_ENV) delete env[key];
  env.GIT_OPTIONAL_LOCKS = "0";
  env.LC_ALL = "C";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GIT_LITERAL_PATHSPECS = "1";
  return env;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .find((l) => l.trim() !== "")
      ?.trim() ?? ""
  );
}

/**
 * @param {string} root
 * @param {string[]} args
 * @param {GitOptions} options
 * @returns {GitBufferResult}
 */
function spawnGit(root, args, options) {
  const empty = Buffer.alloc(0);
  /**
   * @param {string} error
   * @returns {GitBufferResult}
   */
  const fail = (error) => ({ ok: false, code: null, stdout: empty, stderr: "", error });
  if (typeof root !== "string" || root === "" || !Array.isArray(args) || args.length === 0) {
    return fail("git was called without a folder or without arguments");
  }
  if (args.some((a) => typeof a !== "string" || a.includes("\0"))) return fail("git arguments must be text");
  try {
    if (!fs.statSync(root).isDirectory()) return fail(`${root} is not a folder`);
  } catch {
    return fail(`folder ${root} does not exist`);
  }
  const timeout = options.timeoutMs ?? GIT_TIMEOUT_MS;
  /** @type {import("node:child_process").SpawnSyncReturns<Buffer>} */
  let res;
  try {
    res = spawnSync("git", ["-c", "color.ui=false", "-c", "core.quotePath=false", ...args], {
      cwd: root,
      env: gitEnv(),
      input: options.input,
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: options.maxBuffer ?? MAX_BUFFER,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return fail(`git could not start: ${errorText(error)}`);
  }
  const stdout = res.stdout ?? empty;
  const stderr = (res.stderr ?? empty).toString("utf8");
  if (res.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (res.error).code;
    let reason = `git ${args[0]} failed: ${res.error.message}`;
    if (code === "ETIMEDOUT") reason = `git ${args[0]} timed out after ${timeout} ms`;
    else if (code === "ENOENT") reason = "git is not installed or not on the PATH";
    else if (code === "ENOBUFS") reason = `git ${args[0]} printed more output than allowed`;
    return { ok: false, code: null, stdout, stderr, error: reason };
  }
  if (res.status !== 0) {
    const detail = firstLine(stderr);
    const reason = `git ${args[0]} exited with code ${res.status}${detail ? `: ${detail}` : ""}`;
    return { ok: false, code: res.status, stdout, stderr, error: reason };
  }
  return { ok: true, code: 0, stdout, stderr, error: null };
}

/**
 * Runs git in `root` and returns text output. Never throws.
 * @param {string} root
 * @param {string[]} args
 * @param {GitOptions} [options]
 * @returns {GitResult}
 */
export function runGit(root, args, options = {}) {
  const r = spawnGit(root, args, options);
  return { ok: r.ok, code: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr, error: r.error };
}

/**
 * Like runGit, but stdout is a Buffer (for binary content). Never throws.
 * @param {string} root
 * @param {string[]} args
 * @param {GitOptions} [options]
 * @returns {GitBufferResult}
 */
export function runGitBuffer(root, args, options = {}) {
  return spawnGit(root, args, options);
}

/**
 * Runs fn and returns fallback if it throws (the helpers below promise never to throw).
 * @template T
 * @param {T} fallback
 * @param {() => T} fn
 * @returns {T}
 */
function safely(fallback, fn) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * True for a ref that is safe to pass to git as a revision: text, not empty, at most 256 characters,
 * no leading "-", no whitespace or control characters.
 * @param {unknown} ref
 * @returns {ref is string}
 */
export function isSafeRef(ref) {
  return (
    typeof ref === "string" &&
    ref.length > 0 &&
    ref.length <= 256 &&
    !ref.startsWith("-") &&
    // eslint-disable-next-line no-control-regex
    !/[\s\u0000-\u001f\u007f]/.test(ref)
  );
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitZ(text) {
  return text.split("\0").filter((s) => s !== "");
}

/**
 * True when `root` is inside a git work tree.
 * @param {string} root
 * @returns {boolean}
 */
export function isGitRepo(root) {
  return safely(false, () => {
    const r = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
    return r.ok && r.stdout.trim() === "true";
  });
}

/**
 * The top folder of the git work tree that contains `cwd`.
 * @param {string} cwd
 * @returns {string | null} absolute path in the platform's form
 */
export function toplevel(cwd) {
  return safely(null, () => {
    const r = runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const out = r.stdout.trim();
    return r.ok && out ? path.resolve(out) : null;
  });
}

/** @type {Map<string, string | null>} */
const prefixCache = new Map();

/**
 * Where `root` sits inside its repository: "" at the top, "packages/app/" in a subfolder.
 * @param {string} root
 * @returns {string | null} null when root is not in a repository
 */
export function repoPrefix(root) {
  const key = path.resolve(String(root ?? ""));
  if (prefixCache.has(key)) return prefixCache.get(key) ?? null;
  const value = safely(null, () => {
    const r = runGit(root, ["rev-parse", "--show-prefix"]);
    return r.ok ? toPosix(r.stdout.trim()) : null;
  });
  if (value !== null) prefixCache.set(key, value);
  return value;
}

/**
 * Converts a repository-relative path to a root-relative one; null when it is outside root.
 * @param {string} prefix from repoPrefix
 * @param {string} repoPath
 * @returns {string | null}
 */
function fromRepoPath(prefix, repoPath) {
  const p = toPosix(repoPath);
  if (prefix === "") return normalizeRelPath(p);
  return p.startsWith(prefix) ? normalizeRelPath(p.slice(prefix.length)) : null;
}

/**
 * The commit sha a ref points to.
 * @param {string} root
 * @param {string} ref
 * @returns {string | null}
 */
export function revParse(root, ref) {
  if (!isSafeRef(ref)) return null;
  return safely(null, () => {
    const r = runGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    const sha = r.stdout.trim();
    return r.ok && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  });
}

/**
 * The sha of HEAD, or null in a repository without commits.
 * @param {string} root
 * @returns {string | null}
 */
export function head(root) {
  return revParse(root, "HEAD");
}

/**
 * The checked-out branch name, or null when HEAD is detached (or there is no repository).
 * @param {string} root
 * @returns {string | null}
 */
export function branch(root) {
  return safely(null, () => {
    const r = runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const name = r.stdout.trim();
    return r.ok && name ? name : null;
  });
}

/**
 * True for a shallow clone (history is cut off, so old bases may be missing).
 * @param {string} root
 * @returns {boolean}
 */
export function isShallow(root) {
  return safely(false, () => {
    const r = runGit(root, ["rev-parse", "--is-shallow-repository"]);
    return r.ok && r.stdout.trim() === "true";
  });
}

/**
 * `git status --porcelain -z` for root, with renames and copies parsed.
 * @param {string} root
 * @param {{ untracked?: boolean }} [options] include untracked files (default true)
 * @returns {StatusEntry[]}
 */
export function statusPorcelain(root, options = {}) {
  return safely([], () => {
    const prefix = repoPrefix(root);
    if (prefix === null) return [];
    const untracked = options.untracked ?? true;
    const r = runGit(root, [
      "status",
      "--porcelain=v1",
      "-z",
      untracked ? "--untracked-files=all" : "--untracked-files=no",
      "--",
      ".",
    ]);
    if (!r.ok) return [];
    /** @type {StatusEntry[]} */
    const out = [];
    const parts = r.stdout.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      const index = entry[0];
      const worktree = entry[1];
      const rel = fromRepoPath(prefix, entry.slice(3));
      let orig = null;
      if ("RC".includes(index) || "RC".includes(worktree)) {
        orig = fromRepoPath(prefix, parts[i + 1] ?? "");
        i++;
      }
      if (rel !== null) out.push({ path: rel, origPath: orig, index, worktree });
    }
    return out;
  });
}

/**
 * Every file with uncommitted changes (staged, unstaged, untracked, both sides of a rename), sorted.
 * @param {string} root
 * @returns {string[]}
 */
export function uncommittedFiles(root) {
  /** @type {Set<string>} */
  const set = new Set();
  for (const e of statusPorcelain(root)) {
    set.add(e.path);
    if (e.origPath) set.add(e.origPath);
  }
  return [...set].sort();
}

/**
 * Files changed since `base`: committed since base + staged + unstaged + untracked, as sorted posix paths
 * relative to root. Renames count as both paths. Without a usable base: uncommitted files only.
 * @param {string} root
 * @param {string | null | undefined} base a ref or sha
 * @returns {string[]}
 */
export function changedFilesSince(root, base) {
  return safely([], () => {
    const sha = base ? revParse(root, base) : null;
    if (!sha) return uncommittedFiles(root);
    const diff = runGit(root, ["diff", "--name-only", "-z", "--no-renames", "--relative", sha, "--"]);
    if (!diff.ok) return uncommittedFiles(root);
    /** @type {Set<string>} */
    const set = new Set();
    for (const p of splitZ(diff.stdout)) {
      const rel = normalizeRelPath(p);
      if (rel) set.add(rel);
    }
    const others = runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (others.ok) {
      for (const p of splitZ(others.stdout)) {
        const rel = normalizeRelPath(p);
        if (rel) set.add(rel);
      }
    }
    return [...set].sort();
  });
}

/**
 * The best common ancestor of two refs.
 * @param {string} root
 * @param {string} a
 * @param {string} b
 * @returns {string | null}
 */
export function mergeBase(root, a, b) {
  if (!isSafeRef(a) || !isSafeRef(b)) return null;
  return safely(null, () => {
    const r = runGit(root, ["merge-base", a, b]);
    const sha = r.stdout.trim();
    return r.ok && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  });
}

const DEFAULT_BRANCH_CANDIDATES = [
  "refs/remotes/origin/main",
  "refs/remotes/origin/master",
  "refs/heads/main",
  "refs/heads/master",
];

/**
 * @param {string} ref
 * @returns {string}
 */
function shortRef(ref) {
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  return ref;
}

/**
 * The default branch to compare against: the target of origin/HEAD, else origin/main, origin/master,
 * main or master (the first that exists).
 * @param {string} root
 * @returns {string | null} a short ref like "origin/main"
 */
export function defaultBranchRef(root) {
  return safely(null, () => {
    const r = runGit(root, [
      "for-each-ref",
      "--format=%(refname)%00%(symref)",
      "refs/remotes/origin/HEAD",
      ...DEFAULT_BRANCH_CANDIDATES,
    ]);
    if (!r.ok) return null;
    /** @type {Map<string, string>} */
    const refs = new Map();
    for (const line of r.stdout.split("\n")) {
      const [name, symref = ""] = line.split("\0");
      if (name) refs.set(name, symref);
    }
    const target = refs.get("refs/remotes/origin/HEAD");
    if (target && (refs.has(target) || revParse(root, target))) return shortRef(target);
    const found = DEFAULT_BRANCH_CANDIDATES.find((c) => refs.has(c));
    return found ? shortRef(found) : null;
  });
}

/**
 * The git blob sha of a symlink (git stores the link text, not the target).
 * @param {string} abs
 * @returns {string}
 */
function symlinkBlobHash(abs) {
  const target = fs.readlinkSync(abs, { encoding: "buffer" });
  return crypto
    .createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${target.length}\0`), target]))
    .digest("hex");
}

/**
 * Git blob hashes of files in the working tree (`git hash-object --no-filters`, batched). Missing files map
 * to "deleted". Folders (for example submodules) and files that could not be hashed in time are left out,
 * so callers should treat a missing entry as "unknown".
 * @param {string} root
 * @param {readonly string[]} paths relative to root
 * @param {{ deadlineMs?: number }} [options] total time budget (default 3000 ms)
 * @returns {Record<string, string>}
 */
export function hashFiles(root, paths, options = {}) {
  /** @type {Record<string, string>} */
  const result = {};
  return safely(result, () => {
    const started = Date.now();
    const deadline = options.deadlineMs ?? GIT_TIMEOUT_MS;
    /** @type {string[]} */
    const regular = [];
    for (const p of new Set(paths ?? [])) {
      const rel = normalizeRelPath(p);
      const abs = rel === null ? null : resolveInside(root, rel);
      if (rel === null || abs === null) continue;
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch (error) {
        const code = /** @type {NodeJS.ErrnoException} */ (error).code;
        if (code === "ENOENT" || code === "ENOTDIR") result[rel] = "deleted";
        continue;
      }
      if (st.isSymbolicLink()) {
        result[rel] = symlinkBlobHash(abs);
      } else if (st.isFile()) {
        regular.push(rel);
      }
    }
    const batch = regular.filter((p) => !p.includes("\n") && !p.includes("\r"));
    const single = regular.filter((p) => p.includes("\n") || p.includes("\r"));
    if (batch.length > 0) {
      const r = runGit(root, ["hash-object", "--no-filters", "--stdin-paths"], {
        input: `${batch.join("\n")}\n`,
        timeoutMs: deadline,
      });
      const lines = r.ok ? r.stdout.split("\n").filter((l) => l !== "") : [];
      if (r.ok && lines.length === batch.length) batch.forEach((p, i) => (result[p] = lines[i]));
      else single.push(...batch);
    }
    for (const p of single) {
      const left = deadline - (Date.now() - started);
      if (left <= 0) break;
      const r = runGit(root, ["hash-object", "--no-filters", "--", p], { timeoutMs: Math.min(left, GIT_TIMEOUT_MS) });
      const sha = r.stdout.trim();
      if (r.ok && /^[0-9a-f]{40,64}$/.test(sha)) result[p] = sha;
    }
    return result;
  });
}

/**
 * The blob hash of one file, "deleted" when it does not exist, or null when it cannot be hashed.
 * @param {string} root
 * @param {string} rel
 * @returns {string | null}
 */
export function blobHash(root, rel) {
  const clean = normalizeRelPath(rel);
  if (clean === null) return null;
  return hashFiles(root, [clean])[clean] ?? null;
}

/**
 * Snapshot of the files that have uncommitted changes, with their blob hashes ("deleted" when gone).
 * @param {string} root
 * @param {{ max?: number }} [options] at most this many files (default 300; sorted by path)
 * @returns {{ files: Record<string, string>, total: number, truncated: boolean }}
 */
export function snapshotDirty(root, options = {}) {
  const max = Math.max(0, Math.floor(options.max ?? 300));
  const all = uncommittedFiles(root);
  return { files: hashFiles(root, all.slice(0, max)), total: all.length, truncated: all.length > max };
}

/**
 * "just now", "5 minutes ago", "3 days ago", "2 weeks ago", "4 months ago", "1 year ago".
 * @param {number} thenMs
 * @param {number} [nowMs]
 * @returns {string}
 */
export function relativeAge(thenMs, nowMs = Date.now()) {
  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  /**
   * @param {number} n
   * @param {string} unit
   */
  const fmt = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (!Number.isFinite(seconds) || seconds < 60) return "just now";
  if (seconds < 3600) return fmt(Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return fmt(Math.floor(seconds / 3600), "hour");
  const days = Math.floor(seconds / 86400);
  if (days < 14) return fmt(days, "day");
  if (days < 60) return fmt(Math.floor(days / 7), "week");
  if (days < 365) return fmt(Math.floor(days / 30), "month");
  return fmt(Math.floor(days / 365), "year");
}

/**
 * Local and remote branches, most recently committed first (symbolic refs such as origin/HEAD left out).
 * @param {string} root
 * @param {number} [limit] default 6
 * @param {{ now?: number }} [options]
 * @returns {BranchInfo[]}
 */
export function recentBranches(root, limit = 6, options = {}) {
  const max = Math.floor(Number(limit));
  if (!Number.isFinite(max) || max <= 0) return [];
  return safely([], () => {
    const r = runGit(root, [
      "for-each-ref",
      "--sort=-committerdate",
      `--count=${max + 20}`,
      "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(committerdate:unix)%00%(symref)",
      "refs/heads",
      "refs/remotes",
    ]);
    if (!r.ok) return [];
    const now = options.now ?? Date.now();
    /** @type {BranchInfo[]} */
    const out = [];
    for (const line of r.stdout.split("\n")) {
      const [ref, name, sha, unix, symref] = line.split("\0");
      if (!ref || !name || !sha || symref || ref.endsWith("/HEAD")) continue;
      const ms = Number(unix) * 1000;
      out.push({
        name,
        ref,
        sha,
        date: Number.isFinite(ms) ? new Date(ms).toISOString() : "",
        age: Number.isFinite(ms) ? relativeAge(ms, now) : "",
      });
      if (out.length >= max) break;
    }
    return out;
  });
}

/**
 * Commit messages, newest first, merges left out.
 * @param {string} root
 * @param {{ max?: number, timeoutMs?: number }} [options] max commits (default 3000)
 * @returns {CommitMessage[]}
 */
export function logMessages(root, options = {}) {
  const max = Math.min(100000, Math.max(1, Math.floor(options.max ?? 3000)));
  return safely([], () => {
    const r = runGit(
      root,
      ["log", "--no-merges", "-n", String(max), "--date=short", "--format=%H%x1f%cd%x1f%s%x1f%b%x1e"],
      { timeoutMs: options.timeoutMs },
    );
    if (!r.ok) return [];
    /** @type {CommitMessage[]} */
    const out = [];
    for (const record of r.stdout.split("\x1e")) {
      const fields = record.replace(/^\n+/, "").split("\x1f");
      if (fields.length < 4 || !/^[0-9a-f]{40,64}$/.test(fields[0])) continue;
      out.push({
        sha: fields[0],
        date: fields[1],
        subject: fields[2],
        body: fields.slice(3).join("\x1f").trim(),
      });
    }
    return out;
  });
}

/**
 * A unified diff that shows a new, untracked file.
 * @param {string} rel
 * @param {string} text
 * @returns {string}
 */
function newFileDiff(rel, text) {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const out = [`diff --git a/${rel} b/${rel}`, "new file mode 100644"];
  if (lines.length > 0) {
    out.push("--- /dev/null", `+++ b/${rel}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`));
    if (!text.endsWith("\n")) out.push("\\ No newline at end of file");
  }
  return `${out.join("\n")}\n`;
}

/**
 * The unified diff of one file between `base` and the working tree ("" when there is none or on error).
 * An untracked new file is shown as fully added.
 * @param {string} root
 * @param {string} base
 * @param {string} rel
 * @returns {string}
 */
export function diffFile(root, base, rel) {
  const clean = normalizeRelPath(rel);
  if (clean === null) return "";
  return safely("", () => {
    const sha = revParse(root, base);
    if (!sha) return "";
    const r = runGit(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--relative", sha, "--", clean]);
    if (!r.ok) return "";
    if (r.stdout !== "") return r.stdout;
    const tracked = runGit(root, ["ls-files", "-z", "--", clean]);
    if (!tracked.ok || tracked.stdout !== "") return "";
    const abs = resolveInside(root, clean);
    if (abs === null) return "";
    try {
      const st = fs.statSync(abs);
      return st.isFile() ? newFileDiff(clean, fs.readFileSync(abs, "utf8")) : "";
    } catch {
      return "";
    }
  });
}

/**
 * The content of a file at a ref, as text; null when the ref or the file does not exist there.
 * @param {string} root
 * @param {string} ref
 * @param {string} rel path relative to root
 * @returns {string | null}
 */
export function showFile(root, ref, rel) {
  const clean = normalizeRelPath(rel);
  if (clean === null) return null;
  return safely(null, () => {
    const sha = revParse(root, ref);
    if (!sha) return null;
    const r = runGit(root, ["cat-file", "blob", `${sha}:./${clean}`]);
    return r.ok ? r.stdout : null;
  });
}

/**
 * The committer date (YYYY-MM-DD) of the last commit that touched a path, or null.
 * @param {string} root
 * @param {string} rel
 * @returns {string | null}
 */
export function lastCommitDate(root, rel) {
  const clean = normalizeRelPath(rel);
  if (clean === null) return null;
  return safely(null, () => {
    const r = runGit(root, ["log", "-1", "--date=short", "--format=%cd", "--", clean]);
    const date = r.stdout.trim();
    return r.ok && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  });
}

/**
 * How many commits reachable from HEAD touched a path (0 on error).
 * @param {string} root
 * @param {string} rel
 * @returns {number}
 */
export function countCommits(root, rel) {
  const clean = normalizeRelPath(rel);
  if (clean === null) return 0;
  return safely(0, () => {
    const r = runGit(root, ["rev-list", "--count", "HEAD", "--", clean]);
    const n = Number(r.stdout.trim());
    return r.ok && Number.isInteger(n) && n >= 0 ? n : 0;
  });
}
