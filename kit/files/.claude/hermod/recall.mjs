// @ts-check
/**
 * Hermod recall: searches past work (progress logs, decisions, session history and git commit messages) with
 * BM25 (lib/bm25.mjs), all in memory, no index on disk, no network.
 *
 *   node .claude/hermod/recall.mjs "query" [--limit N] [--source progress|decisions|git|history|all]
 *                                  [--root DIR] [--json] [--help]
 *
 * Documents: every file matched by recall.sources in config.json (found by walking the repository, never inside
 * .git/, node_modules/ or .claude/hermod/.local/, never through a symlink), cut into markdown chunks of at most
 * ~800 characters (lib/markdown.mjs chunkMarkdown), plus one document per git commit (subject + body; subject
 * counts double, like a chunk's heading path). Output per hit:
 *
 *   docs/PROGRESS.md:42  (7.31)
 *       …the «max» «retries» setting is raised when…
 *   git 1a2b3c4 2026-11-05  (5.02)
 *       Raise «MAX_RETRIES» for slow uploads
 *
 * Exit code: 0 (also when nothing matches), 2 for a usage error, 1 when the search itself failed.
 * Read-only: it never writes a file.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildIndex, search, snippet } from "./lib/bm25.mjs";
import { loadConfig } from "./lib/config.mjs";
import { logMessages } from "./lib/git.mjs";
import { isMainModule, readText, resolveRoot } from "./lib/io.mjs";
import { chunkMarkdown, splitLines } from "./lib/markdown.mjs";
import { compilePattern, patternError, toPosix } from "./lib/paths.mjs";

export const USAGE = `Usage: node .claude/hermod/recall.mjs "query" [--limit N] [--source progress|decisions|git|history|all]
                                      [--root DIR] [--json] [--help]

Searches past work: the files in recall.sources in config.json (progress logs, decisions, session history)
and the git commit messages. Swedish letters match without diacritics (ratta finds rätta), identifiers match
by their parts (max retries finds MAX_RETRIES, fetch user finds fetchUser), and a word of 4 or more
letters with no exact match finds words that start with it.

  --limit N     show at most N hits (default: recall.limit in config.json, 8)
  --source S    progress   files that are not decisions or history (docs/PROGRESS.md, progress archives, …)
                decisions  files whose name contains "decision"
                history    files under .claude/hermod/history/
                git        commit messages only
                all        everything (default)
  --root DIR    the repository root (default: $CLAUDE_PROJECT_DIR, else the git top level of this folder)
  --json        print the hits as JSON
  --help        show this help

Exit code: 0 (also when nothing matches), 2 for a usage error. It never changes a file.`;

/** The values --source accepts. */
export const SOURCE_KINDS = Object.freeze(["progress", "decisions", "git", "history", "all"]);
/** Markdown chunks hold at most this many characters. */
export const CHUNK_CHARS = 800;
/** At most this many source files are read. */
export const MAX_FILES = 5000;
/** A source file is read up to this size. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** The walk stops after this many folder entries (a guard for huge trees). */
export const MAX_WALK_ENTRIES = 200_000;
/** git log may take this long (a CLI, not a hook: more than the hooks' 3 s). */
export const GIT_LOG_TIMEOUT_MS = 10_000;
/** --limit accepts 1 to this. */
export const MAX_LIMIT = 1000;

const HISTORY_PREFIX = ".claude/hermod/history/";
const LOCAL_DIR = ".claude/hermod/.local";
const SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * True for paths recall never reads: anything inside .git/ or node_modules/ (at any depth) and
 * .claude/hermod/.local/. Compared case-insensitively (macOS and Windows file systems ignore case).
 * @param {string} rel posix, repository-relative
 * @returns {boolean}
 */
export function isExcluded(rel) {
  const lower = toPosix(rel).toLowerCase();
  if (lower === LOCAL_DIR || lower.startsWith(`${LOCAL_DIR}/`)) return true;
  return lower.split("/").some((seg) => SKIP_DIRS.has(seg));
}

/**
 * Which --source a file belongs to.
 * @param {string} rel posix, repository-relative
 * @returns {"history" | "decisions" | "progress"}
 */
export function sourceKind(rel) {
  if (rel.startsWith(HISTORY_PREFIX)) return "history";
  if (path.posix.basename(rel).toLowerCase().includes("decision")) return "decisions";
  return "progress";
}

/**
 * True when every component of rel (inside root) exists and none is a symlink; the last one must be of the
 * wanted type.
 * @param {string} root
 * @param {string} rel
 * @param {"file" | "dir"} type
 * @returns {boolean}
 */
function isRealPath(root, rel, type) {
  if (rel === "") return type === "dir";
  const segs = rel.split("/");
  let cur = root;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) return false;
    const last = i === segs.length - 1;
    if (!last && !st.isDirectory()) return false;
    if (last) return type === "dir" ? st.isDirectory() : st.isFile();
  }
  return false;
}

/**
 * Where to start walking for a pattern: the folders before the first glob segment. Exact file paths are
 * returned as `exact`.
 * @param {string} pattern
 * @returns {{ exact: string } | { dir: string }}
 */
function patternStart(pattern) {
  const posix = toPosix(pattern);
  const segs = posix.split("/").filter((s) => s !== "" && s !== ".");
  const isDir = posix.endsWith("/");
  const firstGlob = segs.findIndex((s) => /[*?]/.test(s));
  if (firstGlob === -1 && !isDir) return { exact: segs.join("/") };
  return { dir: segs.slice(0, firstGlob === -1 ? segs.length : firstGlob).join("/") };
}

/**
 * The repository files matched by the patterns, sorted. Walks only the folders a pattern can reach, never
 * follows symlinks and skips the excluded folders (isExcluded). Invalid patterns are ignored.
 * @param {string} root
 * @param {readonly string[]} patterns
 * @param {{ maxFiles?: number, maxEntries?: number }} [options]
 * @returns {{ files: string[], truncated: boolean }}
 */
export function findSourceFiles(root, patterns, options = {}) {
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxEntries = options.maxEntries ?? MAX_WALK_ENTRIES;
  const valid = (patterns ?? []).filter((p) => patternError(p) === null);
  const matchers = valid.map((p) => compilePattern(p));
  /** @type {Set<string>} */
  const found = new Set();
  /** @type {string[]} */
  const dirs = [];
  for (const p of valid) {
    const start = patternStart(p);
    if ("exact" in start) {
      if (!isExcluded(start.exact) && isRealPath(root, start.exact, "file")) found.add(start.exact);
    } else if (!dirs.includes(start.dir)) {
      dirs.push(start.dir);
    }
  }
  // Walk each start folder once: skip one that lies inside another.
  dirs.sort();
  const roots = dirs.filter((d) => !dirs.some((o) => o !== d && (o === "" || d.startsWith(`${o}/`))));
  let entries = 0;
  let truncated = false;
  for (const start of roots) {
    if ((start !== "" && isExcluded(start)) || !isRealPath(root, start, "dir")) continue;
    /** @type {string[]} */
    const stack = [start];
    while (stack.length > 0 && !truncated) {
      const rel = /** @type {string} */ (stack.pop());
      /** @type {fs.Dirent[]} */
      let list;
      try {
        list = fs.readdirSync(path.join(root, ...(rel === "" ? [] : rel.split("/"))), { withFileTypes: true });
      } catch {
        continue;
      }
      list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const ent of list) {
        if (++entries > maxEntries) {
          truncated = true;
          break;
        }
        const child = rel === "" ? ent.name : `${rel}/${ent.name}`;
        if (isExcluded(child) || ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) stack.push(child);
        else if (ent.isFile() && matchers.some((m) => m(child))) found.add(child);
      }
    }
  }
  const files = [...found].sort();
  if (files.length > maxFiles) return { files: files.slice(0, maxFiles), truncated: true };
  return { files, truncated };
}

/**
 * @typedef {object} FileDoc
 * @property {"file"} kind
 * @property {string} path
 * @property {number} line start line of the chunk (for ordering)
 * @property {number} startLine
 * @property {number} endLine
 * @property {string[]} headingPath
 * @property {string} title heading path, indexed at double weight
 * @property {string} text body indexed at single weight (the chunk without its heading line)
 * @property {string} display the whole chunk, for the snippet
 * @property {string[]} fileLines every line of the file, for line numbers
 */

/**
 * @typedef {object} GitDoc
 * @property {"git"} kind
 * @property {string} path ordering key
 * @property {number} line
 * @property {string} sha
 * @property {string} date
 * @property {string} subject
 * @property {string} title the subject, indexed at double weight
 * @property {string} text the body
 * @property {string} display subject and body, for the snippet
 */

/** @typedef {FileDoc | GitDoc} RecallDoc */

const HEADING_LINE = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * True when the chunk's first line is the heading of its section (then it is indexed as the title only).
 * @param {import("./lib/markdown.mjs").Chunk} chunk
 * @returns {boolean}
 */
function startsWithHeading(chunk) {
  const first = chunk.text.split("\n", 1)[0];
  const m = HEADING_LINE.exec(first);
  if (!m || chunk.headingPath.length === 0) return false;
  const title = (m[1] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();
  return title === chunk.headingPath[chunk.headingPath.length - 1];
}

/**
 * The file line (1-based) of an offset in a chunk's text. Chunk text joins blocks with one blank line even
 * when the file has several, so its lines are matched back to the file's lines in order.
 * @param {import("./lib/markdown.mjs").Chunk} chunk
 * @param {string[]} fileLines
 * @param {number} offset
 * @returns {number}
 */
export function chunkLineAt(chunk, fileLines, offset) {
  const chunkLines = chunk.text.split("\n");
  const target = chunk.text.slice(0, Math.max(0, offset)).split("\n").length - 1;
  const last = Math.max(chunk.startLine, chunk.endLine) - 1;
  let f = chunk.startLine - 1;
  for (let j = 0; j < chunkLines.length; j++) {
    const c = chunkLines[j];
    const blank = c.trim() === "";
    if (!blank) {
      // Only blank lines were left out between two chunk lines: the next file line holding it is the one.
      let k = f;
      while (k <= last && !(fileLines[k] ?? "").includes(c)) k++;
      if (k <= last) f = k;
    }
    if (j === target) return Math.min(f, last) + 1;
    if (!blank) f++;
  }
  return chunk.startLine;
}

/**
 * @typedef {object} Corpus
 * @property {RecallDoc[]} docs
 * @property {number} files source files read
 * @property {number} chunks
 * @property {number} commits
 * @property {string[]} notes plain-English remarks (files skipped, git off, …)
 */

/**
 * Reads every document for a search.
 * @param {string} root
 * @param {import("./lib/config.mjs").HermodConfig} config
 * @param {{ source?: string }} [options]
 * @returns {Corpus}
 */
export function collectDocuments(root, config, options = {}) {
  const source = options.source ?? "all";
  const recall = config.recall;
  /** @type {RecallDoc[]} */
  const docs = [];
  /** @type {string[]} */
  const notes = [];
  let files = 0;
  let chunks = 0;
  let commits = 0;
  if (source !== "git") {
    const found = findSourceFiles(root, recall.sources);
    if (found.truncated) notes.push(`only the first ${found.files.length} source files were searched`);
    for (const rel of found.files) {
      if (source !== "all" && sourceKind(rel) !== source) continue;
      const text = readText(path.join(root, ...rel.split("/")), { maxBytes: MAX_FILE_BYTES });
      if (text === null || text.includes("\0")) continue;
      files++;
      const fileLines = splitLines(text);
      for (const chunk of chunkMarkdown(text, { maxChars: CHUNK_CHARS })) {
        const heading = startsWithHeading(chunk);
        docs.push({
          kind: "file",
          path: rel,
          line: chunk.startLine,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          headingPath: chunk.headingPath,
          title: chunk.headingPath.join("\n"),
          text: heading ? chunk.text.slice(chunk.text.split("\n", 1)[0].length) : chunk.text,
          display: chunk.text,
          fileLines,
        });
        chunks++;
      }
    }
  }
  if (source === "all" || source === "git") {
    if (!recall.git) {
      if (source === "git") notes.push("git search is off (recall.git in config.json)");
    } else if (recall.gitMaxCommits > 0) {
      for (const c of logMessages(root, { max: recall.gitMaxCommits, timeoutMs: GIT_LOG_TIMEOUT_MS })) {
        docs.push({
          kind: "git",
          path: `￿git ${c.date} ${c.sha}`,
          line: 0,
          sha: c.sha,
          date: c.date,
          subject: c.subject,
          title: c.subject,
          text: c.body,
          display: c.body ? `${c.subject}\n${c.body}` : c.subject,
        });
        commits++;
      }
    }
  }
  return { docs, files, chunks, commits, notes };
}

/**
 * @typedef {object} FileResult
 * @property {"file"} kind
 * @property {string} path
 * @property {number} line the line of the best match
 * @property {number} startLine
 * @property {number} endLine
 * @property {string[]} heading
 * @property {number} score rounded to 3 decimals
 * @property {string} snippet
 */

/**
 * @typedef {object} GitResult
 * @property {"git"} kind
 * @property {string} sha
 * @property {string} shortSha
 * @property {string} date
 * @property {string} subject
 * @property {number} score
 * @property {string} snippet
 */

/**
 * @typedef {object} RecallResult
 * @property {string} query
 * @property {string} source
 * @property {import("./lib/bm25.mjs").QueryTerm[]} terms
 * @property {Array<FileResult | GitResult>} results
 * @property {number} total hits before --limit
 * @property {{ files: number, chunks: number, commits: number }} searched
 * @property {string[]} notes
 */

/**
 * Searches a repository.
 * @param {string} root
 * @param {string} query
 * @param {{ config?: import("./lib/config.mjs").HermodConfig, limit?: number, source?: string }} [options]
 * @returns {RecallResult}
 */
export function recall(root, query, options = {}) {
  const config = options.config ?? loadConfig(root).config;
  const source = options.source ?? "all";
  const limit = options.limit ?? config.recall.limit;
  const corpus = collectDocuments(root, config, { source });
  const index = buildIndex(corpus.docs);
  const found = search(index, query, { limit });
  const chars = config.recall.snippetChars;
  /** @type {Array<FileResult | GitResult>} */
  const results = found.hits.map((hit) => {
    const doc = hit.doc;
    const snip = snippet(doc.display, hit.matched, chars);
    const score = Math.round(hit.score * 1000) / 1000;
    if (doc.kind === "git") {
      return { kind: "git", sha: doc.sha, shortSha: doc.sha.slice(0, 7), date: doc.date, subject: doc.subject, score, snippet: snip.text };
    }
    const chunk = { startLine: doc.startLine, endLine: doc.endLine, text: doc.display, headingPath: doc.headingPath };
    return {
      kind: "file",
      path: doc.path,
      line: chunkLineAt(chunk, doc.fileLines, snip.anchor),
      startLine: doc.startLine,
      endLine: doc.endLine,
      heading: doc.headingPath,
      score,
      snippet: snip.text,
    };
  });
  return {
    query,
    source,
    terms: found.terms,
    results,
    total: found.total,
    searched: { files: corpus.files, chunks: corpus.chunks, commits: corpus.commits },
    notes: corpus.notes,
  };
}

/**
 * @param {number} n
 * @param {string} word
 * @returns {string}
 */
const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The plain-text output.
 * @param {RecallResult} r
 * @returns {string}
 */
export function formatResult(r) {
  /** @type {string[]} */
  const out = [];
  const searched = `Searched ${count(r.searched.chunks, "chunk")} from ${count(r.searched.files, "file")} and ${count(r.searched.commits, "commit")}.`;
  if (r.terms.length === 0) {
    out.push(
      `No searchable words in "${r.query}" (words shorter than 2 characters and common words such as "the" or "och" are ignored).`,
    );
  } else if (r.results.length === 0) {
    out.push(`No matches for "${r.query}". ${searched}`);
  } else {
    for (const hit of r.results) {
      const score = hit.score.toFixed(2);
      out.push(hit.kind === "git" ? `git ${hit.shortSha} ${hit.date}  (${score})` : `${hit.path}:${hit.line}  (${score})`);
      out.push(`    ${hit.snippet}`);
      out.push("");
    }
    out.pop();
    if (r.total > r.results.length) out.push("", `Showing ${r.results.length} of ${r.total} hits; use --limit N for more.`);
  }
  for (const note of r.notes) out.push(`Note: ${note}.`);
  return `${out.join("\n")}\n`;
}

/**
 * Runs the CLI. Returns the exit code instead of exiting (the caller sets it).
 * @param {string[]} argv arguments after the script name
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv, cwd?: string }} [io]
 * @returns {number}
 */
export function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  /** @param {string} message */
  const usage = (message) => {
    stderr.write(`recall: ${message}\n\n${USAGE}\n`);
    return 2;
  };
  /** @type {{ values: { root?: string, limit?: string, source?: string, json?: boolean, help?: boolean }, positionals: string[] }} */
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        root: { type: "string" },
        limit: { type: "string", short: "n" },
        source: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  const args = parsed.values;
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const query = parsed.positionals.join(" ").trim();
  if (query === "") return usage("give a query, for example: recall.mjs \"cache version\"");
  /** @type {number | undefined} */
  let limit;
  if (args.limit !== undefined) {
    const n = /^\d+$/.test(args.limit.trim()) ? Number(args.limit.trim()) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return usage(`--limit must be a whole number from 1 to ${MAX_LIMIT} (got "${args.limit}")`);
    limit = n;
  }
  const source = args.source ?? "all";
  if (!SOURCE_KINDS.includes(source)) return usage(`--source must be one of ${SOURCE_KINDS.join(", ")} (got "${source}")`);
  const root = resolveRoot({ root: args.root ?? null, env: io.env, cwd: io.cwd, useGit: true });
  try {
    if (!fs.statSync(root).isDirectory()) return usage(`the root ${root} is not a folder`);
  } catch {
    return usage(`the root folder ${root} does not exist`);
  }
  try {
    const loaded = loadConfig(root);
    if (loaded.errors.length > 0) {
      stderr.write(`recall: config.json has ${count(loaded.errors.length, "invalid value")}; using the defaults for them (run validate.mjs)\n`);
    }
    const result = recall(root, query, { config: loaded.config, limit, source });
    stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatResult(result));
    return 0;
  } catch (error) {
    stderr.write(`recall failed: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
