// Shared helpers for the kit's tests: temporary git repositories with the real kit files copied in, a runner that
// spawns `node` with JSON on stdin (the way Claude Code runs a hook), and cleanup of everything created.
//
// Owned by the kit-brief agent. Other agents: import from here, and put helpers of your own in your own file.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The hermod checkout these tests run in. */
export const HERMOD_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** kit/files: copied into a target repo at the same relative paths. */
export const KIT_FILES = path.join(HERMOD_ROOT, "kit", "files");
/** kit/seed: created once in a target repo. */
export const KIT_SEED = path.join(HERMOD_ROOT, "kit", "seed");

/** Files by posix path relative to the repo root. `null` deletes the file (in a commit step). */
export type Files = Record<string, string | Buffer | null>;

export interface CommitSpec {
  /** Files to write (or delete with null) before committing. */
  files?: Files;
  /** Commit message (default "commit N"). */
  message?: string;
  /** ISO date for author and committer (default: git's own clock). */
  date?: string;
}

export interface MakeRepoOptions {
  /** Files written before the first commit (after the kit files, so they can override them). */
  files?: Files;
  /** Further commits after the first one, in order. */
  commits?: CommitSpec[];
  /** Copy kit/files in (default true). */
  kit?: boolean;
  /** With kit: also copy the kit's own skills (kit/files/.claude/skills/*) (default true). */
  kitSkills?: boolean;
  /** Copy kit/seed in, without overwriting `files` (default false). */
  seed?: boolean;
  /** Make it a git repository (default true). `false` gives a plain folder (for "no git" cases). */
  git?: boolean;
  /** Name of the initial branch (default "main"). */
  branch?: string;
  /** Make the first commit (default true). `false` leaves everything untracked in a repo with no commits. */
  initialCommit?: boolean;
  /** Folder name inside the temp dir (default "repo"), so the repo name in output is predictable. */
  name?: string;
}

export interface Repo {
  /** Absolute path of the repository root. */
  root: string;
  /** Absolute path for a repo-relative posix path. */
  abs(rel: string): string;
  /** Write a file (creating folders). */
  write(rel: string, content: string | Buffer): void;
  /** Delete a file if it exists. */
  remove(rel: string): void;
  /** Read a file as UTF-8, or null when missing. */
  read(rel: string): string | null;
  exists(rel: string): boolean;
  /** Run git in the repo; throws on a non-zero exit. Returns trimmed stdout. */
  git(...args: string[]): string;
  /** Write files and commit everything (`git add -A`). Returns the new HEAD sha. */
  commit(spec?: CommitSpec): string;
  /** Absolute path of a kit file inside this repo, e.g. kitPath("hooks/session-start.mjs"). */
  kitPath(rel: string): string;
  /** Remove the repo (also done by cleanup()). */
  cleanup(): void;
}

export interface RunNodeOptions {
  /** Text for stdin, or an object (sent as JSON). Omitted → stdin is closed empty. */
  stdin?: string | Buffer | object;
  /** Extra env (merged over a cleaned copy of process.env). A value of undefined removes the variable. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  args?: string[];
  /** Kill after this many ms (default 20 s). */
  timeoutMs?: number;
}

export interface RunResult {
  /** Exit code (null when killed by a signal). */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Wall-clock time of the child process, in ms. */
  durationMs: number;
}

const created: string[] = [];

/** A fresh temporary directory, removed by cleanup(). */
export function tempDir(prefix = "hermod-kit-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Remove every temp dir made by these helpers. Call it from afterAll/afterEach. */
export function cleanup(): void {
  while (created.length > 0) {
    const dir = created.pop() as string;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // best effort
    }
  }
}

/** Variables from the outer environment that would leak into the child (e.g. when tests run inside Claude Code). */
const LEAKY_ENV = /^(CLAUDE_|GIT_|HERMOD_)/;

/** process.env without Claude Code, git and Hermod variables, plus a quiet, deterministic git identity. */
export function cleanEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!LEAKY_ENV.test(k) && v !== undefined) env[k] = v;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_AUTHOR_NAME = "Test";
  env.GIT_AUTHOR_EMAIL = "test@example.com";
  env.GIT_COMMITTER_NAME = "Test";
  env.GIT_COMMITTER_EMAIL = "test@example.com";
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function writeFiles(root: string, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, ...rel.split("/"));
    if (content === null) {
      rmSync(file, { force: true });
      continue;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function gitIn(root: string, args: string[], env: NodeJS.ProcessEnv = cleanEnv()): string {
  const r = spawnSync("git", args, { cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

/** Copy a folder's files into root without overwriting existing ones. */
function copyMissing(from: string, root: string): void {
  if (!existsSync(from)) return;
  cpSync(from, root, { recursive: true, force: false, errorOnExist: false });
}

/**
 * A temporary git repository with user.name/email set, the real kit files from kit/files copied in, `files`
 * written, and one initial commit (then `commits`, in order).
 */
export function makeRepo(options: MakeRepoOptions = {}): Repo {
  const base = tempDir();
  const root = path.join(base, options.name ?? "repo");
  mkdirSync(root, { recursive: true });
  const useGit = options.git !== false;

  if (options.kit !== false) {
    const skills = path.join(KIT_FILES, ".claude", "skills");
    const withSkills = options.kitSkills !== false;
    cpSync(KIT_FILES, root, {
      recursive: true,
      filter: (src) => withSkills || !(src === skills || src.startsWith(skills + path.sep)),
    });
  }
  if (options.files) writeFiles(root, options.files);
  if (options.seed) copyMissing(KIT_SEED, root);

  const repo: Repo = {
    root,
    abs: (rel) => path.join(root, ...rel.split("/")),
    write: (rel, content) => writeFiles(root, { [rel]: content }),
    remove: (rel) => writeFiles(root, { [rel]: null }),
    read: (rel) => {
      const file = path.join(root, ...rel.split("/"));
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    },
    exists: (rel) => existsSync(path.join(root, ...rel.split("/"))),
    git: (...args) => gitIn(root, args),
    commit: (spec = {}) => {
      if (spec.files) writeFiles(root, spec.files);
      const env = spec.date ? cleanEnv({ GIT_AUTHOR_DATE: spec.date, GIT_COMMITTER_DATE: spec.date }) : cleanEnv();
      gitIn(root, ["add", "-A"], env);
      gitIn(root, ["commit", "-q", "--allow-empty", "--no-verify", "-m", spec.message ?? "commit"], env);
      return gitIn(root, ["rev-parse", "HEAD"], env);
    },
    kitPath: (rel) => path.join(root, ".claude", "hermod", ...rel.split("/")),
    cleanup: () => rmSync(base, { recursive: true, force: true, maxRetries: 3 }),
  };

  if (useGit) {
    gitIn(root, ["init", "-q", "-b", options.branch ?? "main"]);
    gitIn(root, ["config", "user.name", "Test"]);
    gitIn(root, ["config", "user.email", "test@example.com"]);
    gitIn(root, ["config", "commit.gpgsign", "false"]);
    gitIn(root, ["config", "core.autocrlf", "false"]);
    if (options.initialCommit !== false) {
      repo.commit({ message: "initial" });
      (options.commits ?? []).forEach((c, i) => repo.commit({ message: `commit ${i + 1}`, ...c }));
    }
  }
  return repo;
}

/** Spawn `node <script> ...args` with stdin, a cleaned environment and a timeout. Never throws on a non-zero exit. */
export function runNode(script: string, options: RunNodeOptions = {}): RunResult {
  let input: string | Buffer | undefined;
  if (typeof options.stdin === "string" || Buffer.isBuffer(options.stdin)) input = options.stdin;
  else if (options.stdin !== undefined) input = JSON.stringify(options.stdin);
  const started = performance.now();
  const r = spawnSync(process.execPath, [script, ...(options.args ?? [])], {
    cwd: options.cwd ?? process.cwd(),
    env: cleanEnv(options.env),
    input: input ?? "",
    encoding: "utf8",
    timeout: options.timeoutMs ?? 20_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = performance.now() - started;
  if (r.error && (r.error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw r.error;
  return { code: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "", durationMs };
}

/**
 * Run a kit hook in a repo the way Claude Code does: `node <repo>/.claude/hermod/hooks/<name>.mjs`, JSON on stdin,
 * CLAUDE_PROJECT_DIR set to the repo, cwd the repo.
 */
export function runHook(repo: Repo, name: string, stdin?: string | object, options: RunNodeOptions = {}): RunResult {
  return runNode(repo.kitPath(`hooks/${name}.mjs`), {
    cwd: repo.root,
    ...options,
    stdin,
    env: { CLAUDE_PROJECT_DIR: repo.root, ...(options.env ?? {}) },
  });
}

// ------------------------------------------------------------------------------------- big fixtures

/**
 * Body text that is hard to cut: decomposed Swedish letters ("a" + combining diaeresis), a ZWJ emoji family,
 * a flag (two regional indicators) and astral emoji. Every line starts with "¶", and the only "a" in it is the
 * base of a decomposed "ä", so a split character is easy to detect (see assertNoSplitCharacters).
 */
export const HARD_WORDS = ["ää", "👨‍👩‍👧", "🇸🇪", "😀😀", "ä-🚀", "ö", "å"];

/** One line of hard text of roughly `chars` characters (no trailing newline). */
export function hardLine(chars: number, seed = 0): string {
  let s = "¶";
  for (let i = seed; s.length < chars; i++) s += `${HARD_WORDS[i % HARD_WORDS.length]}${i % 5 === 4 ? ", " : " "}`;
  return s.trimEnd();
}

/** Lines of hard text, about `chars` characters in total. */
export function hardText(chars: number, lineChars = 90): string {
  const lines: string[] = [];
  let total = 0;
  for (let i = 0; total < chars; i++) {
    const line = hardLine(lineChars, i);
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Fails when a character (grapheme) of hard text was split: checks every "¶" line fragment of the output.
 * Also checks that the text is well-formed UTF-16 (no lone surrogate).
 */
export function splitCharacterProblems(text: string): string[] {
  const problems: string[] = [];
  if (/\p{Cs}/u.test(text)) problems.push("text has a lone surrogate");
  for (const line of text.split("\n")) {
    const at = line.indexOf("¶");
    if (at === -1) continue;
    const frag = line.slice(at);
    if (/a(?!̈)/u.test(frag)) problems.push(`decomposed ä split: ${JSON.stringify(frag.slice(-30))}`);
    if (/^\p{M}/u.test(frag.slice(1))) problems.push(`starts with a combining mark: ${JSON.stringify(frag.slice(0, 20))}`);
    if (/‍(?![\u{1F466}-\u{1F469}])/u.test(frag)) problems.push(`ZWJ sequence split: ${JSON.stringify(frag.slice(-30))}`);
    const men = (frag.match(/👨/gu) ?? []).length;
    const families = (frag.match(/👨‍👩‍👧/gu) ?? []).length;
    if (men !== families) problems.push(`family emoji split: ${JSON.stringify(frag.slice(-30))}`);
    if ((frag.match(/\p{RI}/gu) ?? []).length % 2 !== 0) problems.push(`flag split: ${JSON.stringify(frag.slice(-30))}`);
  }
  return problems;
}

/** A markdown progress file of about `bytes` characters with deep sections, fences and the two sections. */
export function hugeProgress(bytes = 200_000): string {
  const out: string[] = ["# Progress", "", "## Status (2026-11-05)", ""];
  out.push(hardText(30_000));
  out.push("### Status detail", hardText(5_000), "#### Deeper", hardText(3_000));
  out.push("```md", "## Next step", "this heading is inside a fence and must be ignored", "```");
  out.push(hardText(2_000));
  out.push("", "## Recent sessions", "");
  let n = 0;
  while (out.join("\n").length < bytes - 25_000) {
    for (let level = 3; level <= 6; level++) out.push(`${"#".repeat(level)} Session ${n} level ${level}`, hardLine(120, n));
    n++;
  }
  out.push("", "## Next step", "", hardText(20_000), "", "## Open questions", "", hardText(2_000));
  return `${out.join("\n")}\n`;
}

/** LESSONS.md with hard-text entries totalling about `chars` characters. */
export function lessonsFile(chars: number, entryChars = 300): string {
  const entries: string[] = [];
  let total = 0;
  for (let i = 0; total < chars; i++) {
    const e = `${hardLine(entryChars, i)}.`;
    entries.push(e);
    total += e.length + 3;
  }
  return `# Lessons\n<!-- hermod:lessons — test fixture. -->\n\n${entries.join("\n§\n")}\n`;
}

/** `.claude/skills/<name>/SKILL.md` files for n skills with long hard-text descriptions. */
export function skillFiles(n: number, descriptionChars = 200): Files {
  const files: Files = {};
  for (let i = 1; i <= n; i++) {
    const name = `skill-${String(i).padStart(2, "0")}`;
    const description = `${hardLine(descriptionChars, i).replace(/"/g, "")} Second sentence.`;
    files[`.claude/skills/${name}/SKILL.md`] = `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n\nBody.\n`;
  }
  return files;
}
