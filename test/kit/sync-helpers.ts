// Helpers for test/kit/sync.test.ts: temporary "hermod" source repositories with their own fixture kit trees,
// temporary target repositories, a runner for scripts/sync.mjs, and tree snapshots that notice rewrites.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The script under test (HERMOD_SYNC_SCRIPT runs the tests against another copy, e.g. a deliberately broken one). */
export const SYNC_SCRIPT = process.env.HERMOD_SYNC_SCRIPT ?? fileURLToPath(new URL("../../scripts/sync.mjs", import.meta.url));

/** Files by posix path relative to some folder. */
export type Tree = Record<string, string | Buffer>;

export interface KitFixture {
  /** The content of kit/VERSION (one line). */
  version: string;
  /** kit/settings.hooks.json: an object (written as JSON) or the exact text. */
  hooks: unknown;
  /** kit/skills.json: an object (written as JSON) or the exact text; undefined writes no such file. */
  skills?: unknown;
  /** Paths relative to kit/files/. */
  files: Tree;
  /** Paths relative to kit/seed/. */
  seeds?: Tree;
  /** Other files of the source repository, relative to its top-level folder. */
  other?: Tree;
}

export interface PlanJson {
  add: string[];
  update: string[];
  forced: string[];
  delete: string[];
  unchanged: string[];
  seed: string[];
  conflict: { path: string; reason: string }[];
  kept: { path: string; reason: string }[];
  settings: "create" | "update" | "unchanged";
  stamp: "create" | "update" | "unchanged";
}

export interface SkillsJson {
  core: string[];
  chosen: string[];
  notChosen: string[];
  from: "option" | "stamp" | "default";
}

export interface SyncJson {
  ok: boolean;
  applied: boolean;
  dryRun?: boolean;
  error?: string;
  source?: string;
  target?: string;
  ref?: string;
  commit?: string;
  kit?: string;
  previous?: { kit: string; ref: string; commit: string; syncedAt: string } | null;
  skills?: SkillsJson;
  plan: PlanJson | null;
  warnings?: string[];
}

export interface SyncRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface SyncJsonRun extends SyncRun {
  json: SyncJson;
}

export interface RunOptions {
  /** Another copy of the script to run. */
  script?: string;
  /** The working folder of the sync process (default: the sandbox root). */
  cwd?: string;
  /** Variables added to (or replacing) the sandbox environment. */
  env?: NodeJS.ProcessEnv;
}

export interface Stamp {
  kit: string;
  ref: string;
  commit: string;
  syncedAt: string;
  /** The optional skills chosen (missing in a stamp written before optional skills existed). */
  skills?: string[];
  files: Record<string, string>;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Writes every file of the tree under root (creating folders). */
export function writeTree(root: string, tree: Tree): void {
  for (const [rel, content] of Object.entries(tree)) {
    const file = path.join(root, ...rel.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/**
 * Every entry under root (except those `include` rejects) with its content hash, inode and modification time, so
 * that a comparison notices content changes, rewrites with the same content, new files and removed files.
 */
export function snapshot(root: string, include: (rel: string) => boolean = () => true): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const name of readdirSync(path.join(root, rel)).sort()) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (!include(childRel)) continue;
      const full = path.join(root, childRel);
      const stat = lstatSync(full, { bigint: true });
      if (stat.isSymbolicLink()) out[childRel] = `link -> ${readlinkSync(full)} ino=${stat.ino}`;
      else if (stat.isDirectory()) {
        out[childRel] = `dir ino=${stat.ino} mtime=${stat.mtimeNs}`;
        walk(childRel);
      } else out[childRel] = `file sha256=${sha256(readFileSync(full))} ino=${stat.ino} mtime=${stat.mtimeNs}`;
    }
  };
  walk("");
  return out;
}

/** A snapshot of everything outside .claude/ (the .git folder included). */
export function snapshotOutsideClaude(root: string): Record<string, string> {
  return snapshot(root, (rel) => rel !== ".claude" && !rel.startsWith(".claude/"));
}

/** The posix paths (relative to root) of every file and link under root/sub, sorted (sub may be nested). */
export function listFiles(root: string, sub: string): string[] {
  const under = (rel: string) => rel === sub || rel.startsWith(`${sub}/`);
  const entries = snapshot(root, (rel) => under(rel) || sub.startsWith(`${rel}/`));
  return Object.entries(entries)
    .filter(([rel, entry]) => under(rel) && !entry.startsWith("dir "))
    .map(([rel]) => rel)
    .sort();
}

/** False on file systems that treat "a" and "A" as one name (the default on Windows and macOS). */
export function caseSensitiveFileSystem(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hermod-case-"));
  try {
    writeFileSync(path.join(dir, "a"), "");
    return readdirSync(dir).length === 1 && !existsSync(path.join(dir, "A"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Reads a target file as bytes. */
export function readBytes(root: string, rel: string): Buffer {
  return readFileSync(path.join(root, ...rel.split("/")));
}

/** Reads a target file as UTF-8 text. */
export function readText(root: string, rel: string): string {
  return readBytes(root, rel).toString("utf8");
}

export function readStamp(root: string): Stamp {
  return JSON.parse(readText(root, ".claude/hermod/VERSION.json")) as Stamp;
}

/**
 * One temporary folder per test file: git runs with an empty global config and no system config, so the
 * machine's git settings (autocrlf, signing, hooks) cannot change what the tests see.
 */
export class Sandbox {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  private counter = 0;

  constructor() {
    this.root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hermod-sync-")));
    const gitconfig = path.join(this.root, "empty.gitconfig");
    writeFileSync(gitconfig, "");
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = gitconfig;
    // A folder in the sandbox that is not a repository must not be found inside one above the sandbox.
    env.GIT_CEILING_DIRECTORIES = path.dirname(this.root);
    env.GIT_AUTHOR_NAME = "Hermod Test";
    env.GIT_AUTHOR_EMAIL = "test@example.invalid";
    env.GIT_COMMITTER_NAME = "Hermod Test";
    env.GIT_COMMITTER_EMAIL = "test@example.invalid";
    this.env = env;
  }

  /** A new empty folder under the sandbox. */
  dir(name: string): string {
    this.counter += 1;
    const dir = path.join(this.root, `${String(this.counter).padStart(3, "0")}-${name}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Runs git and returns its stdout; throws with stderr when it fails. */
  git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd, env: this.env, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.error?.message}`);
    }
    return result.stdout;
  }

  initRepo(dir: string): void {
    this.git(dir, "init", "-q", "-b", "main");
    this.git(dir, "config", "core.autocrlf", "false");
    this.git(dir, "config", "commit.gpgsign", "false");
    this.git(dir, "config", "tag.gpgsign", "false");
  }

  /** Stages everything and commits; returns the commit sha. */
  commitAll(dir: string, message: string): string {
    this.git(dir, "add", "-A");
    this.git(dir, "commit", "-q", "--allow-empty", "-m", message);
    return this.git(dir, "rev-parse", "HEAD").trim();
  }

  /** A new source ("hermod") repository with the kit committed; returns its folder and the commit sha. */
  makeSource(kit: KitFixture, name = "source"): { dir: string; commit: string } {
    const dir = this.dir(name);
    this.initRepo(dir);
    writeKit(dir, kit);
    return { dir, commit: this.commitAll(dir, `kit ${kit.version}`) };
  }

  /** A new target repository with the given files committed (by default a small app with a CLAUDE.md). */
  makeTarget(tree: Tree = DEFAULT_TARGET_FILES, name = "target"): string {
    const dir = this.dir(name);
    this.initRepo(dir);
    writeTree(dir, tree);
    this.commitAll(dir, "target initial");
    return dir;
  }

  /** Runs scripts/sync.mjs with these arguments (and optionally a changed environment). */
  sync(args: string[], options: RunOptions = {}): SyncRun {
    const result = spawnSync(process.execPath, [options.script ?? SYNC_SCRIPT, ...args], {
      cwd: options.cwd ?? this.root,
      env: { ...this.env, ...options.env },
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  /** Runs scripts/sync.mjs with --json and parses its output (which must be one JSON object). */
  syncJson(args: string[], options: RunOptions = {}): SyncJsonRun {
    const run = this.sync([...args, "--json"], options);
    let json: SyncJson;
    try {
      json = JSON.parse(run.stdout) as SyncJson;
    } catch {
      throw new Error(`sync --json did not print JSON (exit ${run.status}).\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
    }
    return { ...run, json };
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Replaces kit/ (and writes the other files) in a source repository's working tree. */
export function writeKit(dir: string, kit: KitFixture): void {
  rmSync(path.join(dir, "kit"), { recursive: true, force: true });
  writeTree(path.join(dir, "kit", "files"), kit.files);
  writeTree(path.join(dir, "kit", "seed"), kit.seeds ?? {});
  writeTree(path.join(dir, "kit"), {
    VERSION: `${kit.version}\n`,
    "settings.hooks.json": typeof kit.hooks === "string" ? kit.hooks : `${JSON.stringify(kit.hooks, null, 2)}\n`,
  });
  if (kit.skills !== undefined) {
    writeTree(path.join(dir, "kit"), {
      "skills.json": typeof kit.skills === "string" ? kit.skills : `${JSON.stringify(kit.skills, null, 2)}\n`,
    });
  }
  writeTree(dir, kit.other ?? {});
}

export const DEFAULT_TARGET_FILES: Tree = {
  "README.md": "# Target app\n",
  "CLAUDE.md": "# Instructions of the target repository\n",
  "src/app.js": "export const app = 1;\n",
  ".gitignore": "node_modules/\n",
};

const hook = (script: string, timeout: number) => ({
  type: "command",
  command: `node "$CLAUDE_PROJECT_DIR/.claude/hermod/hooks/${script}"`,
  timeout,
});

/** The fixture kit's hook entries in version 1 (like the real kit/settings.hooks.json, but the tests' own). */
export const HOOKS_V1 = {
  hooks: {
    SessionStart: [{ hooks: [hook("session-start.mjs", 15)] }],
    Stop: [{ hooks: [hook("stop.mjs", 30)] }],
    PostToolUse: [{ matcher: "Bash|Skill|Read", hooks: [hook("post-tool.mjs", 10)] }],
    PostToolUseFailure: [{ matcher: "Bash", hooks: [hook("post-tool.mjs", 10)] }],
  },
};

/** Version 2: Stop gets a longer timeout and PostToolUseFailure is no longer registered. */
export const HOOKS_V2 = {
  hooks: {
    SessionStart: [{ hooks: [hook("session-start.mjs", 15)] }],
    Stop: [{ hooks: [hook("stop.mjs", 45)] }],
    PostToolUse: [{ matcher: "Bash|Skill|Read", hooks: [hook("post-tool.mjs", 10)] }],
  },
};

export const CRLF_TEXT = "first line\r\nsecond line\r\nno newline at the end";
export const BINARY = Buffer.from([0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x00, 0x80, 0x0d, 0x0d, 0x0a, 0x1b, 0xc3, 0x28]);

export function kitV1(): KitFixture {
  return {
    version: "0.1.0",
    hooks: HOOKS_V1,
    files: {
      ".claude/hermod/README.md": "# Hermod fixture kit v1\n",
      ".claude/hermod/hooks/session-start.mjs": "// session-start v1\n",
      ".claude/hermod/hooks/stop.mjs": "// stop v1\n",
      ".claude/hermod/hooks/post-tool.mjs": "// post-tool v1\n",
      ".claude/hermod/legacy/old.mjs": "// removed in v2\n",
      ".claude/hermod/crlf.txt": CRLF_TEXT,
      ".claude/hermod/data/blob.bin": BINARY,
      ".claude/skills/reflect/SKILL.md": "---\nname: reflect\ndescription: Fixture skill.\n---\n\nBody v1.\n",
    },
    seeds: {
      ".claude/hermod/config.json": '{\n  "version": 1\n}\n',
      ".claude/hermod/LESSONS.md": "# Lessons\n",
      ".claude/hermod/checks/README.md": "# Checks\n",
    },
    other: { "README.md": "# Fixture hermod repository\n", "kit/README.md": "Not part of what is synced.\n" },
  };
}

export function kitV2(): KitFixture {
  const v1 = kitV1();
  const files: Tree = { ...v1.files };
  delete files[".claude/hermod/legacy/old.mjs"];
  return {
    ...v1,
    version: "0.2.0",
    hooks: HOOKS_V2,
    files: {
      ...files,
      ".claude/hermod/README.md": "# Hermod fixture kit v2\n",
      ".claude/hermod/lib/new.mjs": "// added in v2\n",
    },
    seeds: {
      ".claude/hermod/config.json": '{\n  "version": 2\n}\n',
      ".claude/hermod/LESSONS.md": "# Lessons (v2 seed)\n",
      ".claude/hermod/checks/README.md": "# Checks (v2 seed)\n",
    },
  };
}

/** The target paths of a kit's files, sorted. */
export function kitPaths(kit: KitFixture): string[] {
  return Object.keys(kit.files).sort();
}

/** The fixture's core skills, and its library skills (like the real kit's, but the tests' own copies). */
export const CORE_SKILLS = ["curate", "reflect"];
export const OPTIONAL_SKILLS = ["anthropic-sdk", "nextjs-16", "supabase-rls"];

function skillText(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: Fixture skill ${name}.\n---\n\n${body}\n`;
}

/**
 * Kit v1 with two core skills and three library skills, two of them with a references/ file. `skills` is
 * kit/skills.json (undefined: no such file, so every skill is core); `body` is the text of every SKILL.md, so that
 * a later version can change them all.
 */
export function skillsKit(version: string, skills: unknown, body = "Body v1."): KitFixture {
  const v1 = kitV1();
  return {
    ...v1,
    version,
    skills,
    files: {
      ...v1.files,
      ".claude/skills/reflect/SKILL.md": skillText("reflect", body),
      ".claude/skills/curate/SKILL.md": skillText("curate", body),
      ".claude/skills/anthropic-sdk/SKILL.md": skillText("anthropic-sdk", body),
      ".claude/skills/anthropic-sdk/references/tool-loop.md": "# Tool loop\n",
      ".claude/skills/nextjs-16/SKILL.md": skillText("nextjs-16", body),
      ".claude/skills/nextjs-16/references/caching.md": "# Caching\n",
      ".claude/skills/supabase-rls/SKILL.md": skillText("supabase-rls", body),
    },
  };
}

/** The target paths of a kit's files that belong to these skills, sorted. */
export function skillPaths(kit: KitFixture, names: string[]): string[] {
  return kitPaths(kit).filter((rel) => names.some((name) => rel.startsWith(`.claude/skills/${name}/`)));
}
