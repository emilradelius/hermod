// @ts-check
/**
 * Repository-relative paths and the one path-pattern matcher the kit uses everywhere
 * (config codePaths / ignorePaths / require, recall sources, check `when` lists).
 *
 * Pattern rules:
 * - A pattern ending in "/" is a directory prefix: "src/" matches "src/a.ts" and "src/x/y.ts".
 *   The prefix may itself contain globs: "packages/*\/src/".
 * - A pattern with "*", "**" or "?" is a glob: "*" and "?" never cross "/", "**" spans any number of
 *   folders (also none): "**\/*.md" matches "README.md" and "docs/a/b.md". Dotfiles match like other files.
 * - Any other pattern is an exact path.
 * - Matching is case-sensitive, on posix separators. Backslashes are read as "/".
 * - Absolute patterns, patterns that start with "~" and patterns with ".." segments are rejected:
 *   they never match, and patternError() explains why.
 * Characters such as "[", "]", "{" and "}" have no special meaning.
 */
import fs from "node:fs";
import path from "node:path";

const GLOB_CHARS = /[*?]/;
const MAX_CACHE = 500;

/** @type {Map<string, (rel: string) => boolean>} */
const matcherCache = new Map();

/**
 * Converts a path to posix form: "\" becomes "/", repeated "/" collapse (a leading "//" is kept) and a
 * leading "./" is dropped. It does not resolve ".." and does not make paths relative.
 * @param {unknown} p
 * @returns {string}
 */
export function toPosix(p) {
  let s = String(p ?? "").replace(/\\/g, "/");
  const unc = s.startsWith("//");
  s = s.replace(/\/{2,}/g, "/");
  if (unc) s = "/" + s;
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

/**
 * True for paths that are absolute on any platform ("/x", "C:\x", "C:/x", "\\server\x") or that start
 * with "~" (a home directory in shells).
 * @param {string} p
 * @returns {boolean}
 */
export function isAbsoluteLike(p) {
  const s = toPosix(p);
  return s.startsWith("/") || /^[A-Za-z]:/.test(s) || s.startsWith("~");
}

/**
 * Normalises a repository-relative path: posix separators, no "." segments, no trailing "/".
 * @param {unknown} p
 * @returns {string | null} the normalised path, or null when it is empty, absolute, contains a NUL
 *   character or has a ".." segment (it would leave the repository).
 */
export function normalizeRelPath(p) {
  if (typeof p !== "string" || p.includes("\0")) return null;
  const s = toPosix(p);
  if (s === "" || isAbsoluteLike(s)) return null;
  /** @type {string[]} */
  const parts = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

/**
 * Explains why a path pattern is not usable, in plain English.
 * @param {unknown} pattern
 * @returns {string | null} null when the pattern is valid
 */
export function patternError(pattern) {
  if (typeof pattern !== "string") return `path pattern must be text (got ${describe(pattern)})`;
  if (pattern.trim() === "") return "path pattern is empty";
  if (pattern !== pattern.trim()) return `path pattern "${pattern}" has spaces at the start or end`;
  if (pattern.includes("\0")) return "path pattern contains a NUL character";
  const s = toPosix(pattern);
  if (isAbsoluteLike(s)) {
    return `path pattern "${pattern}" is absolute; use a path relative to the repository root, like "src/"`;
  }
  if (s.split("/").includes("..")) {
    return `path pattern "${pattern}" uses ".."; patterns must stay inside the repository`;
  }
  if (s.split("/").every((seg) => seg === "" || seg === ".")) {
    return `path pattern "${pattern}" names no file or folder; use "**" to match everything`;
  }
  return null;
}

/**
 * Explains why a repository-relative file path (not a pattern) is not usable.
 * @param {unknown} p
 * @returns {string | null} null when the path is valid
 */
export function relPathError(p) {
  if (typeof p !== "string") return `path must be text (got ${describe(p)})`;
  if (p.trim() === "") return "path is empty";
  if (p !== p.trim()) return `path "${p}" has spaces at the start or end`;
  if (p.includes("\0")) return "path contains a NUL character";
  if (isAbsoluteLike(p)) return `path "${p}" is absolute; use a path relative to the repository root`;
  if (toPosix(p).split("/").includes("..")) return `path "${p}" uses ".."; it must stay inside the repository`;
  if (normalizeRelPath(p) === null) return `path "${p}" names no file or folder`;
  return null;
}

/**
 * Converts one glob segment ("*.md", "a?c") to a regular-expression source.
 * @param {string} seg
 * @returns {string}
 */
function segmentSource(seg) {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") {
      while (seg[i + 1] === "*") i++;
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

/**
 * Compiles a glob to an anchored regular expression (see the module comment for the rules).
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  /** @type {string[]} */
  const segs = [];
  for (const s of toPosix(glob).split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "**" && segs[segs.length - 1] === "**") continue;
    segs.push(s);
  }
  let src = "";
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === "**") src += last ? ".*" : "(?:[^/]+/)*";
    else src += segmentSource(seg) + (last ? "" : "/");
  });
  return new RegExp(`^${src}$`);
}

/**
 * @param {string} pattern
 * @returns {(rel: string) => boolean}
 */
function buildMatcher(pattern) {
  if (patternError(pattern) !== null) return () => false;
  const posix = toPosix(pattern);
  const isDir = posix.endsWith("/");
  const body = posix
    .split("/")
    .filter((seg) => seg !== "" && seg !== ".")
    .join("/");
  if (isDir) {
    if (!GLOB_CHARS.test(body)) {
      const prefix = `${body}/`;
      return (rel) => rel.startsWith(prefix);
    }
    const re = globToRegExp(`${body}/**`);
    return (rel) => re.test(rel);
  }
  if (!GLOB_CHARS.test(body)) return (rel) => rel === body;
  const re = globToRegExp(body);
  return (rel) => re.test(rel);
}

/**
 * Returns a matcher for one pattern. Invalid patterns give a matcher that never matches.
 * The matcher expects a normalised path (see normalizeRelPath); matchPath() normalises for you.
 * @param {string} pattern
 * @returns {(rel: string) => boolean}
 */
export function compilePattern(pattern) {
  const key = String(pattern);
  const cached = matcherCache.get(key);
  if (cached) return cached;
  const fn = buildMatcher(key);
  if (matcherCache.size >= MAX_CACHE) matcherCache.clear();
  matcherCache.set(key, fn);
  return fn;
}

/**
 * True when the repository-relative path matches the pattern.
 * @param {string} pattern
 * @param {string} filePath
 * @returns {boolean}
 */
export function matchPath(pattern, filePath) {
  const rel = normalizeRelPath(filePath);
  return rel !== null && compilePattern(pattern)(rel);
}

/**
 * True when the path matches at least one of the patterns.
 * @param {readonly string[] | null | undefined} patterns
 * @param {string} filePath
 * @returns {boolean}
 */
export function matchAny(patterns, filePath) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const rel = normalizeRelPath(filePath);
  if (rel === null) return false;
  return patterns.some((p) => compilePattern(p)(rel));
}

/**
 * The paths that match at least one pattern, normalised, in their original order.
 * @param {readonly string[]} paths
 * @param {readonly string[]} patterns
 * @returns {string[]}
 */
export function filterPaths(paths, patterns) {
  /** @type {string[]} */
  const out = [];
  for (const p of paths ?? []) {
    const rel = normalizeRelPath(p);
    if (rel !== null && matchAny(patterns, rel)) out.push(rel);
  }
  return out;
}

/**
 * @param {string} rel output of path.relative
 * @returns {boolean}
 */
function escapes(rel) {
  return rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || path.isAbsolute(rel);
}

/**
 * realpath that also works for paths that do not exist yet (resolves the nearest existing parent).
 * @param {string} p absolute path
 * @returns {string}
 */
function realpathLoose(p) {
  /** @type {string[]} */
  const tail = [];
  let cur = p;
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

/**
 * The posix path of `target` relative to `root`, or null when it is outside the root (or is the root).
 * Symlinked roots (for example /var vs /private/var on macOS) are handled.
 * @param {string} root
 * @param {string} target absolute, or relative to root
 * @returns {string | null}
 */
export function relativeToRoot(root, target) {
  if (typeof root !== "string" || typeof target !== "string" || target === "" || target.includes("\0")) {
    return null;
  }
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, target);
  let rel = path.relative(absRoot, abs);
  if (escapes(rel)) {
    rel = path.relative(realpathLoose(absRoot), realpathLoose(abs));
    if (escapes(rel)) return null;
  }
  return normalizeRelPath(rel);
}

/**
 * Joins a repository-relative path onto the root, refusing anything that would leave the root.
 * Symlinks are not resolved (use relativeToRoot on the result if that matters).
 * @param {string} root
 * @param {string} rel
 * @returns {string | null} the absolute path, or null when rel is invalid
 */
export function resolveInside(root, rel) {
  const clean = normalizeRelPath(rel);
  if (clean === null) return null;
  return path.join(path.resolve(root), ...clean.split("/"));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value;
}
