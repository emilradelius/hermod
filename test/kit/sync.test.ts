// End-to-end tests of scripts/sync.mjs: every test runs the real script with node against temporary git
// repositories (a fixture "hermod" source with its own kit tree, and fresh target repositories). A few pure
// functions (the settings merge, the ref and path rules) are also tested directly.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BINARY,
  CORE_SKILLS,
  CRLF_TEXT,
  DEFAULT_TARGET_FILES,
  HOOKS_V1,
  HOOKS_V2,
  type KitFixture,
  OPTIONAL_SKILLS,
  type SyncJsonRun,
  type Tree,
  SYNC_SCRIPT,
  Sandbox,
  caseSensitiveFileSystem,
  kitPaths,
  kitV1,
  kitV2,
  listFiles,
  readBytes,
  readStamp,
  readText,
  sha256,
  skillPaths,
  skillsKit,
  snapshot,
  snapshotOutsideClaude,
  writeKit,
  writeTree,
} from "./sync-helpers.js";

const posixOnly = process.platform === "win32" ? it.skip : it;

let sandbox: Sandbox;
/** The shared fixture hermod repository: v0.1.0 (annotated tag), v0.2.0 (lightweight tag), then an unreleased
 *  commit on main; its working tree and index differ from every commit. */
let source: { dir: string; v1: string; v2: string; v3: string };

beforeAll(() => {
  sandbox = new Sandbox();
  const dir = sandbox.dir("hermod");
  sandbox.initRepo(dir);
  writeKit(dir, kitV1());
  const v1 = sandbox.commitAll(dir, "kit 0.1.0");
  sandbox.git(dir, "tag", "-a", "v0.1.0", "-m", "kit 0.1.0");
  writeKit(dir, kitV2());
  const v2 = sandbox.commitAll(dir, "kit 0.2.0");
  sandbox.git(dir, "tag", "v0.2.0");
  const v3Kit = kitV2();
  writeKit(dir, {
    ...v3Kit,
    version: "0.3.0",
    files: { ...v3Kit.files, ".claude/hermod/README.md": "# Hermod fixture kit v3 (unreleased)\n" },
  });
  const v3 = sandbox.commitAll(dir, "kit 0.3.0, not released");
  // A branch with the same name as a tag (it points at the unreleased commit), and a tag that is not a commit.
  sandbox.git(dir, "branch", "v0.1.0", v3);
  sandbox.git(dir, "tag", "tree-tag", `${v1}^{tree}`);
  // The working tree and the index differ from every commit; sync must not read either.
  const kitFiles = path.join(dir, "kit", "files");
  writeFileSync(path.join(kitFiles, ".claude/hermod/README.md"), "# WORKING TREE\n");
  writeFileSync(path.join(kitFiles, ".claude/hermod/hooks/stop.mjs"), "// staged, never committed\n");
  sandbox.git(dir, "add", "kit/files/.claude/hermod/hooks/stop.mjs");
  writeFileSync(path.join(kitFiles, ".claude/hermod/untracked.mjs"), "// untracked\n");
  rmSync(path.join(kitFiles, ".claude/skills/reflect/SKILL.md"));
  writeFileSync(path.join(dir, "kit", "VERSION"), "9.9.9\n");
  source = { dir, v1, v2, v3 };
});

afterAll(() => {
  sandbox.cleanup();
});

function args(target: string, ref: string, ...extra: string[]): string[] {
  return ["--source", source.dir, "--target", target, "--ref", ref, ...extra];
}

/** A target that has been synced to `ref` and committed (so .claude/ is clean). */
function syncedTarget(ref: string, tree: Tree = DEFAULT_TARGET_FILES): string {
  const target = sandbox.makeTarget(tree);
  const run = sandbox.syncJson(args(target, ref));
  expect(run.status, run.stdout + run.stderr).toBe(0);
  sandbox.commitAll(target, `sync ${ref}`);
  return target;
}

/** A refusal before any plan: exit 1, no plan, the message. */
function expectRefused(run: SyncJsonRun, message: RegExp): void {
  expect(run.status, run.stdout + run.stderr).toBe(1);
  expect(run.json.ok).toBe(false);
  expect(run.json.applied).toBe(false);
  expect(run.json.plan).toBeNull();
  expect(run.json.error).toMatch(message);
}

type Settings = Record<string, unknown> & { hooks: Record<string, unknown[]> };

function readSettings(target: string): Settings {
  return JSON.parse(readText(target, ".claude/settings.json")) as Settings;
}

describe("sync: the ref must be pinned", () => {
  it("refuses a branch name and writes nothing", () => {
    const target = sandbox.makeTarget();
    const before = snapshot(target);
    expectRefused(sandbox.syncJson(args(target, "main")), /"main" is a branch/);
    const human = sandbox.sync(args(target, "main"));
    expect(human.status).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toMatch(/^hermod sync: "main" is a branch, and a branch moves\. Use a tag/);
    expect(snapshot(target)).toEqual(before);
  });

  it("refuses short shas of any length below 40", () => {
    const target = sandbox.makeTarget();
    const before = snapshot(target);
    for (const length of [7, 12, 39]) {
      expectRefused(sandbox.syncJson(args(target, source.v1.slice(0, length))), /looks like a short commit sha/);
    }
    expect(snapshot(target)).toEqual(before);
  });

  it("refuses HEAD, revision expressions and full ref names", () => {
    const target = sandbox.makeTarget();
    const before = snapshot(target);
    for (const ref of ["HEAD", "HEAD~1", "v0.2.0^{commit}", "v0.2.0~0", "v0.2.0^", "main@{0}", "v0.2.0:kit", "refs/heads/main"]) {
      expectRefused(sandbox.syncJson(args(target, ref)), /tag/);
    }
    expect(snapshot(target)).toEqual(before);
  });

  it("refuses a full sha that is not in the source repository", () => {
    const target = sandbox.makeTarget();
    expectRefused(sandbox.syncJson(args(target, "1234567890abcdef1234567890abcdef12345678")), /was not found/);
  });

  it("refuses a tag that does not point at a commit, and a full sha of a tree", () => {
    const target = sandbox.makeTarget();
    expectRefused(sandbox.syncJson(args(target, "tree-tag")), /does not point at a commit/);
    const tree = sandbox.git(source.dir, "rev-parse", `${source.v1}^{tree}`).trim();
    expectRefused(sandbox.syncJson(args(target, tree)), new RegExp(`^${tree} is a tree in .*, not a commit\\.$`));
  });

  it("accepts an annotated tag, a lightweight tag and a full sha, and stamps the ref as given", () => {
    const cases: [string, string, string][] = [
      ["v0.1.0", source.v1, "0.1.0"],
      ["v0.2.0", source.v2, "0.2.0"],
      [source.v1, source.v1, "0.1.0"],
      [source.v2.toUpperCase(), source.v2, "0.2.0"],
    ];
    for (const [ref, commit, version] of cases) {
      const target = sandbox.makeTarget();
      const run = sandbox.syncJson(args(target, ref));
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(run.json).toMatchObject({ ok: true, applied: true, ref, commit, kit: version });
      expect(readStamp(target)).toMatchObject({ kit: version, ref, commit });
    }
  });

  it("uses the tag, not a branch with the same name", () => {
    const target = sandbox.makeTarget();
    const run = sandbox.syncJson(args(target, "v0.1.0"));
    expect(run.status).toBe(0);
    expect(run.json.commit).toBe(source.v1);
    expect(readText(target, ".claude/hermod/README.md")).toBe("# Hermod fixture kit v1\n");
  });
});

describe("sync: reading the kit", () => {
  it("reads every kit file at the ref, not from the source working tree, index or HEAD", () => {
    expect(readText(source.dir, "kit/files/.claude/hermod/README.md")).toBe("# WORKING TREE\n");
    for (const [ref, kit] of [
      ["v0.1.0", kitV1()],
      ["v0.2.0", kitV2()],
    ] as const) {
      const target = sandbox.makeTarget();
      expect(sandbox.syncJson(args(target, ref)).status).toBe(0);
      for (const [rel, content] of Object.entries(kit.files)) {
        expect(readBytes(target, rel).equals(Buffer.from(content)), rel).toBe(true);
      }
      expect(listFiles(target, ".claude")).toEqual(
        [...kitPaths(kit), ...Object.keys(kit.seeds ?? {}), ".claude/settings.json", ".claude/hermod/VERSION.json"].sort(),
      );
      const stamp = readStamp(target);
      expect(stamp.kit).toBe(kit.version);
      expect(Object.keys(stamp.files)).toEqual(kitPaths(kit));
    }
  });

  it("copies CRLF text and binary files byte for byte", () => {
    expect(sandbox.git(source.dir, "cat-file", "blob", `${source.v1}:kit/files/.claude/hermod/crlf.txt`)).toBe(CRLF_TEXT);
    const target = syncedTarget("v0.1.0");
    expect(readBytes(target, ".claude/hermod/crlf.txt").equals(Buffer.from(CRLF_TEXT))).toBe(true);
    expect(readBytes(target, ".claude/hermod/data/blob.bin").equals(BINARY)).toBe(true);
    const stamp = readStamp(target);
    expect(stamp.files[".claude/hermod/crlf.txt"]).toBe(sha256(CRLF_TEXT));
    expect(stamp.files[".claude/hermod/data/blob.bin"]).toBe(sha256(BINARY));
    const again = sandbox.syncJson(args(target, "v0.1.0"));
    expect(again.json.plan?.unchanged).toContain(".claude/hermod/crlf.txt");
    expect(again.json.plan?.unchanged).toContain(".claude/hermod/data/blob.bin");
  });

  function refusedKit(kit: KitFixture, message: RegExp): void {
    const { dir } = sandbox.makeSource(kit, "bad-kit");
    sandbox.git(dir, "tag", "v1");
    const target = sandbox.makeTarget();
    const before = snapshot(target);
    expectRefused(sandbox.syncJson(["--source", dir, "--target", target, "--ref", "v1"]), message);
    expect(snapshot(target)).toEqual(before);
  }

  it("refuses a kit with files outside .claude/ or files that belong to the repository", () => {
    const cases: [Tree, RegExp][] = [
      [{ "CLAUDE.md": "# not ours\n" }, /CLAUDE\.md is outside \.claude\//],
      [{ "src/app.js": "overwrite\n" }, /src\/app\.js is outside \.claude\//],
      [{ ".claude/CLAUDE.md": "x\n" }, /is a CLAUDE\.md file/],
      [{ ".claude/hermod/LESSONS.md": "x\n" }, /belongs to the repository/],
      [{ ".claude/hermod/config.json": "{}\n" }, /belongs to the repository/],
      [{ ".claude/hermod/checks/own.mjs": "x\n" }, /belongs to the repository/],
      [{ ".claude/hermod/usage/x.json": "{}\n" }, /belongs to the repository/],
      [{ ".claude/settings.json": "{}\n" }, /is a settings file/],
      [{ ".claude/settings.local.json": "{}\n" }, /is a settings file/],
      [{ ".claude/hermod/VERSION.json": "{}\n" }, /is the sync stamp/],
      [{ ".claude/hermod/.local/state.json": "{}\n" }, /local session data/],
      [{ ".claude/hermod/con.txt": "x\n" }, /reserved file name on Windows/],
    ];
    for (const [extra, message] of cases) {
      const kit = kitV1();
      refusedKit({ ...kit, files: { ...kit.files, ...extra } }, message);
    }
  });

  it("refuses bad seeds: outside .claude/, a settings file, a kit file, or a file inside a kit file", () => {
    const kit = kitV1();
    refusedKit({ ...kit, seeds: { "CLAUDE.md": "x\n" } }, /CLAUDE\.md is outside \.claude\//);
    refusedKit({ ...kit, seeds: { ".claude/settings.json": "{}\n" } }, /\.claude\/settings\.json is a settings file/);
    refusedKit({ ...kit, seeds: { ".claude/hermod/README.md": "x\n" } }, /in both kit\/files and kit\/seed/);
    refusedKit(
      { ...kit, seeds: { ".claude/hermod/README.md/notes.md": "x\n" } },
      /has a file \.claude\/hermod\/README\.md and also \.claude\/hermod\/README\.md\/notes\.md inside it/,
    );
  });

  it.skipIf(!caseSensitiveFileSystem())("refuses a kit whose paths are one file on case-insensitive file systems", () => {
    const kit = kitV1();
    refusedKit({ ...kit, files: { ...kit.files, ".claude/hermod/readme.md": "x\n" } }, /one file on Windows and macOS/);
  });

  it("refuses kit hook entries that a later sync could not recognize, and other bad kit metadata", () => {
    const kit = kitV1();
    const relative = { hooks: { Stop: [{ hooks: [{ type: "command", command: "node .claude/hermod/hooks/stop.mjs" }] }] } };
    refusedKit({ ...kit, hooks: relative }, /without \/\.claude\/hermod\/hooks\//);
    refusedKit({ ...kit, hooks: "{ not json" }, /settings\.hooks\.json at v1 \(\w+\) is not valid JSON/);
    refusedKit({ ...kit, hooks: { ...HOOKS_V1, permissions: {} } }, /may only contain "hooks"/);
    refusedKit({ ...kit, hooks: { hooks: { Stop: [] } } }, /must be a non-empty list/);
    refusedKit({ ...kit, hooks: '{ "hooks": { "not-an-event": [] } }' }, /invalid event name "not-an-event"/);
    const stop = (group: Record<string, unknown>) => ({ hooks: { Stop: [group] } });
    const good = HOOKS_V1.hooks.Stop[0]?.hooks[0];
    refusedKit({ ...kit, hooks: stop({ hooks: [good], when: "x" }) }, /unknown keys \(when\)/);
    refusedKit({ ...kit, hooks: stop({ matcher: 1, hooks: [good] }) }, /matcher that is not a string/);
    refusedKit({ ...kit, hooks: stop({ hooks: [] }) }, /a group without hooks/);
    refusedKit({ ...kit, hooks: stop({ hooks: [{ type: "prompt", prompt: "x" }] }) }, /is not \{"type": "command"/);
    refusedKit({ ...kit, hooks: stop({ hooks: [{ ...good, timeout: "10" }] }) }, /timeout that is not a positive number/);
    refusedKit({ ...kit, version: "one" }, /kit\/VERSION at v1 .* must hold one version/);
  });

  it("refuses a source without kit/files, kit/VERSION or kit/settings.hooks.json at the ref", () => {
    refusedKit({ ...kitV1(), files: {} }, /kit\/files at v1 .* has no files/);
    for (const [file, message] of [
      ["VERSION", /kit\/VERSION is missing at v1/],
      ["settings.hooks.json", /kit\/settings\.hooks\.json is missing at v1/],
    ] as const) {
      const { dir } = sandbox.makeSource(kitV1(), "incomplete-kit");
      rmSync(path.join(dir, "kit", file));
      sandbox.commitAll(dir, `remove kit/${file}`);
      sandbox.git(dir, "tag", "v1");
      const target = sandbox.makeTarget();
      expectRefused(sandbox.syncJson(["--source", dir, "--target", target, "--ref", "v1"]), message);
    }
  });

  it("refuses a --source that is not a git repository", () => {
    const plain = sandbox.dir("not-hermod");
    const target = sandbox.makeTarget();
    expectRefused(
      sandbox.syncJson(["--source", plain, "--target", target, "--ref", "v0.1.0"]),
      /is not a git repository, so the kit cannot be read at a pinned ref/,
    );
  });

  posixOnly("refuses bytes from git that do not match the object ids of the commit", () => {
    const realGit = sandbox.git(sandbox.root, "--exec-path").trim();
    const bin = sandbox.dir("fake-git-bin");
    // A git that appends a byte to whatever `git show` prints, as a broken filter would.
    writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\nif [ "$1" = "show" ]; then "${realGit}/git" "$@"; status=$?; printf X; exit $status; fi\nexec "${realGit}/git" "$@"\n`,
    );
    chmodSync(path.join(bin, "git"), 0o755);
    const target = sandbox.makeTarget();
    const before = snapshot(target);
    const run = sandbox.syncJson(args(target, "v0.1.0"), { env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } });
    expectRefused(run, /git show returned other bytes for kit\/\S+ than commit/);
    expect(snapshot(target)).toEqual(before);
  });

  posixOnly("refuses a kit that contains a symbolic link", () => {
    const { dir } = sandbox.makeSource(kitV1(), "link-kit");
    symlinkSync("README.md", path.join(dir, "kit/files/.claude/hermod/link.md"));
    sandbox.commitAll(dir, "add a link");
    sandbox.git(dir, "tag", "v1");
    const target = sandbox.makeTarget();
    const before = snapshot(target);
    expectRefused(sandbox.syncJson(["--source", dir, "--target", target, "--ref", "v1"]), /is a symbolic link/);
    expect(snapshot(target)).toEqual(before);
  });

  it("defaults --source to the repository that contains the script", () => {
    const { dir } = sandbox.makeSource(kitV1(), "hermod-copy");
    sandbox.git(dir, "tag", "v1");
    mkdirSync(path.join(dir, "scripts"));
    const script = path.join(dir, "scripts", "sync.mjs");
    copyFileSync(SYNC_SCRIPT, script);
    const target = sandbox.makeTarget();
    const run = sandbox.syncJson(["--target", target, "--ref", "v1"], { script });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.source).toBe(dir);
    expect(readStamp(target).ref).toBe("v1");
  });
});

describe("sync: install, no-op and upgrade", () => {
  it("a fresh install writes the kit files, the seeds, the settings and the stamp", () => {
    const kit = kitV1();
    const target = sandbox.makeTarget();
    const started = Date.now();
    const run = sandbox.syncJson(args(target, "v0.1.0"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json).toMatchObject({ ok: true, applied: true, dryRun: false, kit: "0.1.0", ref: "v0.1.0", previous: null });
    // This fixture kit has no kit/skills.json, so its one skill is core.
    expect(run.json.skills).toEqual({ core: ["reflect"], chosen: [], notChosen: [], from: "default" });
    expect(run.json.plan).toEqual({
      add: kitPaths(kit),
      update: [],
      forced: [],
      delete: [],
      unchanged: [],
      seed: Object.keys(kit.seeds ?? {}).sort(),
      conflict: [],
      kept: [],
      settings: "create",
      stamp: "create",
    });
    for (const [rel, content] of Object.entries({ ...kit.files, ...kit.seeds })) {
      expect(readBytes(target, rel).equals(Buffer.from(content)), rel).toBe(true);
    }
    expect(listFiles(target, ".claude")).toEqual(
      [...kitPaths(kit), ...Object.keys(kit.seeds ?? {}), ".claude/settings.json", ".claude/hermod/VERSION.json"].sort(),
    );
    expect(readText(target, ".claude/settings.json")).toBe(`${JSON.stringify(HOOKS_V1, null, 2)}\n`);
    const stamp = readStamp(target);
    expect(Object.keys(stamp)).toEqual(["kit", "ref", "commit", "syncedAt", "skills", "files"]);
    expect(stamp).toMatchObject({ kit: "0.1.0", ref: "v0.1.0", commit: source.v1, skills: [] });
    expect(stamp.syncedAt).toBe(new Date(stamp.syncedAt).toISOString());
    expect(Date.parse(stamp.syncedAt)).toBeGreaterThanOrEqual(started - 1000);
    expect(Date.parse(stamp.syncedAt)).toBeLessThanOrEqual(Date.now() + 1000);
    const expectedFiles = Object.fromEntries(kitPaths(kit).map((rel) => [rel, sha256(kit.files[rel] ?? "")]));
    expect(stamp.files).toEqual(expectedFiles);
    expect(Object.keys(stamp.files)).toEqual(kitPaths(kit));
  });

  it("a second run is a no-op: nothing is written anywhere", () => {
    const target = syncedTarget("v0.1.0");
    // A stale index entry: a git status that may take optional locks would rewrite .git/index now.
    utimesSync(path.join(target, ".claude/hermod/README.md"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    const before = snapshot(target);
    const run = sandbox.syncJson(args(target, "v0.1.0"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.applied).toBe(false);
    expect(run.json.plan).toMatchObject({ add: [], update: [], delete: [], seed: [], conflict: [], kept: [] });
    expect(run.json.plan?.unchanged).toEqual(kitPaths(kitV1()));
    expect(run.json.plan?.settings).toBe("unchanged");
    expect(run.json.plan?.stamp).toBe("unchanged");
    expect(snapshot(target)).toEqual(before);
    const human = sandbox.sync(args(target, "v0.1.0"));
    expect(human.status).toBe(0);
    expect(human.stdout).toMatch(/Nothing to do: the target already has kit 0\.1\.0 at v0\.1\.0\./);
    expect(snapshot(target)).toEqual(before);
  });

  it("an upgrade updates unmodified files, adds new ones, deletes removed ones and keeps seeds", () => {
    const target = syncedTarget("v0.1.0");
    const before = snapshot(target);
    const run = sandbox.syncJson(args(target, "v0.2.0"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const v2 = kitV2();
    expect(run.json.previous).toMatchObject({ kit: "0.1.0", ref: "v0.1.0", commit: source.v1 });
    expect(run.json.plan).toMatchObject({
      add: [".claude/hermod/lib/new.mjs"],
      update: [".claude/hermod/README.md"],
      delete: [".claude/hermod/legacy/old.mjs"],
      seed: [],
      conflict: [],
      kept: [],
      settings: "update",
      stamp: "update",
    });
    const unchanged = kitPaths(v2).filter((rel) => rel !== ".claude/hermod/README.md" && rel !== ".claude/hermod/lib/new.mjs");
    expect(run.json.plan?.unchanged).toEqual(unchanged);
    const after = snapshot(target);
    for (const rel of unchanged) expect(after[rel], `${rel} was rewritten`).toBe(before[rel]);
    for (const [rel, content] of Object.entries(v2.files)) {
      expect(readBytes(target, rel).equals(Buffer.from(content)), rel).toBe(true);
    }
    expect(existsSync(path.join(target, ".claude/hermod/legacy"))).toBe(false);
    for (const [rel, content] of Object.entries(kitV1().seeds ?? {})) expect(readText(target, rel)).toBe(content);
    expect(readSettings(target)).toEqual(HOOKS_V2);
    const stamp = readStamp(target);
    expect(stamp).toMatchObject({ kit: "0.2.0", ref: "v0.2.0", commit: source.v2 });
    expect(stamp.files).toEqual(Object.fromEntries(kitPaths(v2).map((rel) => [rel, sha256(v2.files[rel] ?? "")])));
  });

  it("puts back a kit file deleted in the target, and then rewrites the stamp", () => {
    const target = syncedTarget("v0.1.0");
    const stampBefore = readStamp(target);
    rmSync(path.join(target, ".claude/hermod/hooks/stop.mjs"));
    sandbox.commitAll(target, "deleted a kit file");
    const run = sandbox.syncJson(args(target, "v0.1.0"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.plan).toMatchObject({ add: [".claude/hermod/hooks/stop.mjs"], settings: "unchanged", stamp: "update" });
    expect(readText(target, ".claude/hermod/hooks/stop.mjs")).toBe("// stop v1\n");
    const stampAfter = readStamp(target);
    expect(stampAfter.files).toEqual(stampBefore.files);
    expect(stampAfter.syncedAt).not.toBe(stampBefore.syncedAt);
  });

  it("hands a kit file over to the repository when a later kit makes it a seed", () => {
    const kitA = kitV1();
    const { dir } = sandbox.makeSource(
      { ...kitA, files: { ...kitA.files, ".claude/hermod/notes.md": "# Notes from the kit\n" } },
      "seed-handover",
    );
    sandbox.git(dir, "tag", "a");
    writeKit(dir, { ...kitA, version: "0.1.1", seeds: { ...kitA.seeds, ".claude/hermod/notes.md": "# Notes seed\n" } });
    sandbox.commitAll(dir, "notes.md becomes a seed");
    sandbox.git(dir, "tag", "b");
    const target = sandbox.makeTarget();
    expect(sandbox.syncJson(["--source", dir, "--target", target, "--ref", "a"]).status).toBe(0);
    sandbox.commitAll(target, "sync a");
    const run = sandbox.syncJson(["--source", dir, "--target", target, "--ref", "b"]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.plan?.delete).toEqual([]);
    expect(run.json.plan?.seed).toEqual([]);
    expect(run.json.plan?.kept).toEqual([{ path: ".claude/hermod/notes.md", reason: expect.stringMatching(/is a seed .* the repository owns it/) }]);
    expect(readText(target, ".claude/hermod/notes.md")).toBe("# Notes from the kit\n");
    expect(readStamp(target).files).not.toHaveProperty([".claude/hermod/notes.md"]);
  });

  it("a downgrade works too, and says that the kit is older", () => {
    const target = syncedTarget("v0.2.0");
    const run = sandbox.syncJson(args(target, "v0.1.0"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.warnings).toEqual(["kit 0.1.0 is older than the installed kit 0.2.0."]);
    expect(run.json.plan?.add).toEqual([".claude/hermod/legacy/old.mjs"]);
    expect(run.json.plan?.delete).toEqual([".claude/hermod/lib/new.mjs"]);
    expect(existsSync(path.join(target, ".claude/hermod/lib"))).toBe(false);
    expect(readSettings(target)).toEqual(HOOKS_V1);
  });
});

describe("sync: conflicts", () => {
  it("a kit file changed in the target is a conflict: exit 1 and nothing is written", () => {
    const target = syncedTarget("v0.1.0");
    writeFileSync(path.join(target, ".claude/hermod/README.md"), "# Hermod fixture kit v1\n\nA local note.\n");
    sandbox.commitAll(target, "local change to a kit file");
    const before = snapshot(target);
    const run = sandbox.syncJson(args(target, "v0.2.0"));
    expect(run.status).toBe(1);
    expect(run.json).toMatchObject({ ok: false, applied: false, error: "1 conflict; nothing was written." });
    expect(run.json.plan?.conflict).toEqual([
      { path: ".claude/hermod/README.md", reason: expect.stringMatching(/changed in this repository since the last sync.*--force/) },
    ]);
    expect(snapshot(target)).toEqual(before);
    const human = sandbox.sync(args(target, "v0.2.0"));
    expect(human.status).toBe(1);
    expect(human.stdout).toMatch(/\n {2}conflict {3}\.claude\/hermod\/README\.md was changed in this repository/);
    expect(human.stdout).toMatch(/1 conflict: nothing was written\./);
    expect(snapshot(target)).toEqual(before);
  });

  it("--force overwrites a kit file changed in the target", () => {
    const target = syncedTarget("v0.1.0");
    writeFileSync(path.join(target, ".claude/hermod/README.md"), "local edit\n");
    sandbox.commitAll(target, "local change to a kit file");
    const run = sandbox.syncJson(args(target, "v0.2.0", "--force"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.plan?.forced).toEqual([".claude/hermod/README.md"]);
    expect(run.json.plan?.update).toContain(".claude/hermod/README.md");
    expect(readText(target, ".claude/hermod/README.md")).toBe("# Hermod fixture kit v2\n");
    expect(readStamp(target).files[".claude/hermod/README.md"]).toBe(sha256("# Hermod fixture kit v2\n"));
  });

  it("a changed kit file is a conflict even when the new kit did not change it", () => {
    const target = syncedTarget("v0.1.0");
    writeFileSync(path.join(target, ".claude/skills/reflect/SKILL.md"), "edited locally\n");
    sandbox.commitAll(target, "local change to a kit skill");
    const before = snapshot(target);
    for (const ref of ["v0.1.0", "v0.2.0"]) {
      const run = sandbox.syncJson(args(target, ref));
      expect(run.status).toBe(1);
      expect(run.json.plan?.conflict.map((item) => item.path)).toEqual([".claude/skills/reflect/SKILL.md"]);
    }
    expect(snapshot(target)).toEqual(before);
  });

  it("a repository file at a kit path that no sync wrote is a conflict, even with --force", () => {
    const target = sandbox.makeTarget({ ...DEFAULT_TARGET_FILES, ".claude/hermod/README.md": "# Our own notes\n" });
    const before = snapshot(target);
    for (const extra of [[], ["--force"]]) {
      const run = sandbox.syncJson(args(target, "v0.1.0", ...extra));
      expect(run.status).toBe(1);
      expect(run.json.plan?.conflict).toEqual([
        { path: ".claude/hermod/README.md", reason: expect.stringMatching(/not written by a previous sync/) },
      ]);
      expect(snapshot(target)).toEqual(before);
    }
  });

  it("a file that already has exactly the kit's content is taken over, not a conflict", () => {
    const target = sandbox.makeTarget({ ...DEFAULT_TARGET_FILES, ".claude/hermod/README.md": "# Hermod fixture kit v1\n" });
    const run = sandbox.syncJson(args(target, "v0.1.0"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.plan?.unchanged).toEqual([".claude/hermod/README.md"]);
    expect(readStamp(target).files[".claude/hermod/README.md"]).toBe(sha256("# Hermod fixture kit v1\n"));
  });

  it("CRLF line endings from a Windows checkout are not a local change", () => {
    const target = syncedTarget("v0.1.0");
    const readme = path.join(target, ".claude/hermod/README.md");
    writeFileSync(readme, "# Hermod fixture kit v1\r\n");
    sandbox.commitAll(target, "checked out with CRLF");
    const before = snapshot(target);
    const same = sandbox.syncJson(args(target, "v0.1.0"));
    expect(same.status, same.stdout + same.stderr).toBe(0);
    expect(same.json.plan?.unchanged).toContain(".claude/hermod/README.md");
    expect(same.json.applied).toBe(false);
    expect(snapshot(target)).toEqual(before);
    const upgrade = sandbox.syncJson(args(target, "v0.2.0"));
    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    expect(upgrade.json.plan?.update).toContain(".claude/hermod/README.md");
    expect(readText(target, ".claude/hermod/README.md")).toBe("# Hermod fixture kit v2\n");
  });

  it("a file removed from the kit but changed in the target is kept and reported, not deleted", () => {
    const target = syncedTarget("v0.1.0");
    writeFileSync(path.join(target, ".claude/hermod/legacy/old.mjs"), "// we changed this\n");
    sandbox.commitAll(target, "local change to a file the kit will drop");
    const run = sandbox.syncJson(args(target, "v0.2.0"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.plan?.delete).toEqual([]);
    expect(run.json.plan?.kept).toEqual([
      { path: ".claude/hermod/legacy/old.mjs", reason: expect.stringMatching(/no longer in the kit but was changed/) },
    ]);
    expect(readText(target, ".claude/hermod/legacy/old.mjs")).toBe("// we changed this\n");
    expect(readStamp(target).files).not.toHaveProperty([".claude/hermod/legacy/old.mjs"]);
    sandbox.commitAll(target, "sync v0.2.0");
    const again = sandbox.syncJson(args(target, "v0.2.0"));
    expect(again.status).toBe(0);
    expect(again.json.plan?.kept).toEqual([]);
    expect(readText(target, ".claude/hermod/legacy/old.mjs")).toBe("// we changed this\n");
  });

  it("--dry-run reports conflicts with exit 1", () => {
    const target = sandbox.makeTarget({ ...DEFAULT_TARGET_FILES, ".claude/hermod/README.md": "# Our own notes\n" });
    const before = snapshot(target);
    const run = sandbox.syncJson(args(target, "v0.1.0", "--dry-run"));
    expect(run.status).toBe(1);
    expect(run.json.plan?.conflict.map((item) => item.path)).toEqual([".claude/hermod/README.md"]);
    expect(snapshot(target)).toEqual(before);
  });
});

describe("sync: .claude/settings.json", () => {
  const kitHook = (script: string) => ({ type: "command", command: `node "$CLAUDE_PROJECT_DIR/.claude/hermod/hooks/${script}"` });
  const userStart = { matcher: "startup", hooks: [{ type: "command", command: "echo user-start" }] };
  const userStop = { type: "command", command: "echo user-stop" };
  const userPrompt = { type: "prompt", prompt: "Check the work before stopping." };
  const userSettings = {
    permissions: { allow: ["Bash(npm test)"], deny: [] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-pre" }] }],
      SessionStart: [userStart, { hooks: [{ ...kitHook("old-name.mjs"), timeout: 99 }] }],
      Stop: [{ hooks: [userStop, { type: "command", command: "node /elsewhere/.claude/hermod/hooks/stop.mjs" }, userPrompt] }],
      Notification: [{ matcher: "", hooks: [{ type: "command", command: "echo notify" }] }],
      PostToolUseFailure: [{ matcher: "Bash", hooks: [kitHook("post-tool.mjs")] }],
    },
    model: "example-model",
    env: { EXAMPLE_FLAG: "1" },
  };

  it("keeps user hooks, other keys and every order, and replaces only the kit's entries", () => {
    const target = sandbox.makeTarget({ ...DEFAULT_TARGET_FILES, ".claude/settings.json": JSON.stringify(userSettings, null, 4) });
    const run = sandbox.syncJson(args(target, "v0.1.0"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.plan?.settings).toBe("update");
    const after = readSettings(target);
    expect(Object.keys(after)).toEqual(["permissions", "hooks", "model", "env"]);
    expect(after.permissions).toEqual(userSettings.permissions);
    expect(after.model).toBe("example-model");
    expect(after.env).toEqual(userSettings.env);
    expect(Object.keys(after.hooks)).toEqual(["PreToolUse", "SessionStart", "Stop", "Notification", "PostToolUseFailure", "PostToolUse"]);
    expect(after.hooks.PreToolUse).toEqual(userSettings.hooks.PreToolUse);
    expect(after.hooks.SessionStart).toEqual([userStart, ...HOOKS_V1.hooks.SessionStart]);
    expect(after.hooks.Stop).toEqual([{ hooks: [userStop, userPrompt] }, ...HOOKS_V1.hooks.Stop]);
    expect(after.hooks.Notification).toEqual(userSettings.hooks.Notification);
    expect(after.hooks.PostToolUseFailure).toEqual(HOOKS_V1.hooks.PostToolUseFailure);
    expect(after.hooks.PostToolUse).toEqual(HOOKS_V1.hooks.PostToolUse);
    expect(readText(target, ".claude/settings.json")).toBe(`${JSON.stringify(after, null, 2)}\n`);

    sandbox.commitAll(target, "sync v0.1.0");
    const before = snapshot(target);
    const again = sandbox.syncJson(args(target, "v0.1.0"));
    expect(again.json.plan?.settings).toBe("unchanged");
    expect(snapshot(target)).toEqual(before);

    const upgrade = sandbox.syncJson(args(target, "v0.2.0"));
    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    const upgraded = readSettings(target);
    expect(Object.keys(upgraded.hooks)).toEqual(["PreToolUse", "SessionStart", "Stop", "Notification", "PostToolUse"]);
    expect(upgraded.hooks.Stop).toEqual([{ hooks: [userStop, userPrompt] }, ...HOOKS_V2.hooks.Stop]);
    expect(upgraded.hooks.SessionStart).toEqual([userStart, ...HOOKS_V2.hooks.SessionStart]);
    expect(upgraded.permissions).toEqual(userSettings.permissions);
  });

  it("does not rewrite settings.json when only its formatting differs", () => {
    const target = sandbox.makeTarget({ ...DEFAULT_TARGET_FILES, ".claude/settings.json": JSON.stringify(HOOKS_V1) });
    const before = snapshot(target);
    const run = sandbox.syncJson(args(target, "v0.1.0"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.plan?.settings).toBe("unchanged");
    expect(snapshot(target)[".claude/settings.json"]).toBe(before[".claude/settings.json"]);
  });

  it("refuses settings.json that is not valid JSON, writes nothing and never echoes the file", () => {
    const cases: [string, string][] = [
      ['{ "hooks": ', " (it ends too early)"],
      ["", " (it ends too early)"],
      ["// a comment\n{}", ""],
      ['{\n  "env": { "EXAMPLE_TOKEN": "do-not-print-this-value" },\n}', " (at line 3, column 1)"],
    ];
    for (const [bad, place] of cases) {
      const target = sandbox.makeTarget({ ...DEFAULT_TARGET_FILES, ".claude/settings.json": bad });
      const before = snapshot(target);
      const run = sandbox.syncJson(args(target, "v0.1.0"));
      expectRefused(run, /^\.claude\/settings\.json in the target is not valid JSON/);
      expect(run.json.error).toBe(
        `.claude/settings.json in the target is not valid JSON${place}. Fix it by hand, then run sync again; sync never rewrites a file it cannot read.`,
      );
      const human = sandbox.sync(args(target, "v0.1.0"));
      expect(human.stderr).not.toContain("do-not-print-this-value");
      expect(human.stderr.trim().split("\n")).toHaveLength(1);
      expect(snapshot(target)).toEqual(before);
    }
  });

  it("refuses settings.json that is not UTF-8, not an object, or has hooks of the wrong shape", () => {
    const cases: [string | Buffer, RegExp][] = [
      [Buffer.from([0x7b, 0xff, 0x7d]), /is not valid UTF-8/],
      ["[]", /must hold a JSON object/],
      ['"text"', /must hold a JSON object/],
      ['{ "hooks": [] }', /"hooks" in \.claude\/settings\.json must be an object/],
      ['{ "hooks": { "Stop": { "hooks": [] } } }', /"hooks\.Stop" in \.claude\/settings\.json must be a list/],
    ];
    const folder = sandbox.makeTarget({ ...DEFAULT_TARGET_FILES, ".claude/settings.json/inner.txt": "x\n" });
    expectRefused(sandbox.syncJson(args(folder, "v0.1.0")), /settings\.json in the target is a folder, not a file; sync will not write it/);
    for (const [bad, message] of cases) {
      const target = sandbox.makeTarget({ ...DEFAULT_TARGET_FILES, ".claude/settings.json": bad });
      const before = snapshot(target);
      expectRefused(sandbox.syncJson(args(target, "v0.1.0")), message);
      expect(snapshot(target)).toEqual(before);
    }
  });
});

describe("sync: seeds", () => {
  it("creates only missing seeds and never overwrites or tracks them, also on upgrade", () => {
    const own = {
      ".claude/hermod/config.json": '{ "version": 1, "brief": { "budgetChars": 5000 } }\n',
      ".claude/hermod/LESSONS.md": "# Lessons\n\nThe repository's own fact.\n",
    };
    const target = sandbox.makeTarget({ ...DEFAULT_TARGET_FILES, ...own });
    const before = snapshot(target);
    const run = sandbox.syncJson(args(target, "v0.1.0"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.plan?.seed).toEqual([".claude/hermod/checks/README.md"]);
    const after = snapshot(target);
    for (const rel of Object.keys(own)) expect(after[rel], `${rel} was rewritten`).toBe(before[rel]);
    expect(readText(target, ".claude/hermod/checks/README.md")).toBe("# Checks\n");
    const seeds = Object.keys(kitV1().seeds ?? {});
    for (const rel of seeds) expect(readStamp(target).files).not.toHaveProperty([rel]);

    sandbox.commitAll(target, "sync v0.1.0");
    const beforeUpgrade = snapshot(target);
    const upgrade = sandbox.syncJson(args(target, "v0.2.0"));
    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    expect(upgrade.json.plan?.seed).toEqual([]);
    const afterUpgrade = snapshot(target);
    for (const rel of seeds) expect(afterUpgrade[rel], `${rel} was rewritten`).toBe(beforeUpgrade[rel]);
    expect(readText(target, ".claude/hermod/checks/README.md")).toBe("# Checks\n");
  });
});

describe("sync: optional skills", () => {
  const ALL_SKILLS = [...OPTIONAL_SKILLS, ...CORE_SKILLS].sort();
  /** s1 has no kit/skills.json (every skill is core); s2 lists the three library skills as optional; s3 changes
   *  every SKILL.md. */
  const kits = {
    s1: skillsKit("0.1.0", undefined),
    s2: skillsKit("0.2.0", { optional: OPTIONAL_SKILLS }),
    s3: skillsKit("0.3.0", { optional: OPTIONAL_SKILLS }, "Body v3."),
  };
  let skillsSource: string;

  beforeAll(() => {
    skillsSource = sandbox.dir("hermod-skills");
    sandbox.initRepo(skillsSource);
    for (const [tag, kit] of Object.entries(kits)) {
      writeKit(skillsSource, kit);
      sandbox.commitAll(skillsSource, `kit ${kit.version}`);
      sandbox.git(skillsSource, "tag", tag);
    }
  });

  function skillArgs(target: string, ref: string, ...extra: string[]): string[] {
    return ["--source", skillsSource, "--target", target, "--ref", ref, ...extra];
  }

  /** A target that has been synced to `ref` (with these extra arguments) and committed. */
  function skillsTarget(ref: string, ...extra: string[]): string {
    const target = sandbox.makeTarget();
    const run = sandbox.syncJson(skillArgs(target, ref, ...extra));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    sandbox.commitAll(target, `sync ${ref}`);
    return target;
  }

  /** The kit's files without those of these skills. */
  function without(kit: KitFixture, names: string[]): string[] {
    const skipped = skillPaths(kit, names);
    return kitPaths(kit).filter((rel) => !skipped.includes(rel));
  }

  it("a first install without --skills syncs only the core skills, and says so", () => {
    const target = sandbox.makeTarget();
    const run = sandbox.syncJson(skillArgs(target, "s2"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.skills).toEqual({ core: CORE_SKILLS, chosen: [], notChosen: OPTIONAL_SKILLS, from: "default" });
    const synced = without(kits.s2, OPTIONAL_SKILLS);
    expect(run.json.plan?.add).toEqual(synced);
    expect(listFiles(target, ".claude/skills")).toEqual([".claude/skills/curate/SKILL.md", ".claude/skills/reflect/SKILL.md"]);
    // Every other kit file is synced as before; kit/skills.json itself is not copied.
    expect(listFiles(target, ".claude")).toEqual(
      [...synced, ...Object.keys(kits.s2.seeds ?? {}), ".claude/settings.json", ".claude/hermod/VERSION.json"].sort(),
    );
    const stamp = readStamp(target);
    expect(stamp.skills).toEqual([]);
    expect(Object.keys(stamp.files)).toEqual(synced);

    const human = sandbox.sync(skillArgs(sandbox.makeTarget(), "s2", "--dry-run"));
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain(
      "  before  no stamp (first install)\n" +
        "  skills  core: curate, reflect\n" +
        "          optional, chosen: none (the default on a first install)\n" +
        "          optional, not chosen: anthropic-sdk, nextjs-16, supabase-rls\n\n",
    );
  });

  it("--skills adds the named optional skills, and the stamp records them", () => {
    const target = sandbox.makeTarget();
    const run = sandbox.syncJson(skillArgs(target, "s2", "--skills", "anthropic-sdk"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.skills).toEqual({
      core: CORE_SKILLS,
      chosen: ["anthropic-sdk"],
      notChosen: ["nextjs-16", "supabase-rls"],
      from: "option",
    });
    expect(run.json.plan?.add).toEqual(without(kits.s2, ["nextjs-16", "supabase-rls"]));
    expect(listFiles(target, ".claude/skills")).toEqual([
      ".claude/skills/anthropic-sdk/SKILL.md",
      ".claude/skills/anthropic-sdk/references/tool-loop.md",
      ".claude/skills/curate/SKILL.md",
      ".claude/skills/reflect/SKILL.md",
    ]);
    const stamp = readStamp(target);
    expect(Object.keys(stamp)).toEqual(["kit", "ref", "commit", "syncedAt", "skills", "files"]);
    expect(stamp.skills).toEqual(["anthropic-sdk"]);
    for (const rel of skillPaths(kits.s2, ["anthropic-sdk"])) {
      expect(readText(target, rel)).toBe(kits.s2.files[rel]);
      expect(stamp.files[rel], rel).toBe(sha256(kits.s2.files[rel] ?? ""));
    }
    expect(Object.keys(stamp.files)).toEqual(without(kits.s2, ["nextjs-16", "supabase-rls"]));

    // Names in any order, with a space after the comma: the stamp lists them sorted.
    const other = sandbox.makeTarget();
    const two = sandbox.syncJson(skillArgs(other, "s2", "--skills", "supabase-rls, anthropic-sdk"));
    expect(two.status, two.stdout + two.stderr).toBe(0);
    expect(two.json.skills?.chosen).toEqual(["anthropic-sdk", "supabase-rls"]);
    expect(readStamp(other).skills).toEqual(["anthropic-sdk", "supabase-rls"]);
    expect(listFiles(other, ".claude/skills")).toEqual(skillPaths(kits.s2, ["anthropic-sdk", "curate", "reflect", "supabase-rls"]));

    const human = sandbox.sync(skillArgs(sandbox.makeTarget(), "s2", "--skills", "anthropic-sdk"));
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain(
      "          optional, chosen: anthropic-sdk (from --skills)\n          optional, not chosen: nextjs-16, supabase-rls\n",
    );
  });

  it("a re-sync at a newer ref without --skills keeps the selection, and then changes nothing", () => {
    const target = skillsTarget("s2", "--skills", "anthropic-sdk");
    const run = sandbox.syncJson(skillArgs(target, "s3"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.skills).toEqual({
      core: CORE_SKILLS,
      chosen: ["anthropic-sdk"],
      notChosen: ["nextjs-16", "supabase-rls"],
      from: "stamp",
    });
    expect(run.json.plan).toMatchObject({ add: [], delete: [], conflict: [], kept: [], stamp: "update" });
    expect(run.json.plan?.update).toEqual([
      ".claude/skills/anthropic-sdk/SKILL.md",
      ".claude/skills/curate/SKILL.md",
      ".claude/skills/reflect/SKILL.md",
    ]);
    expect(readText(target, ".claude/skills/anthropic-sdk/SKILL.md")).toBe(kits.s3.files[".claude/skills/anthropic-sdk/SKILL.md"]);
    expect(existsSync(path.join(target, ".claude/skills/nextjs-16"))).toBe(false);
    expect(existsSync(path.join(target, ".claude/skills/supabase-rls"))).toBe(false);
    expect(readStamp(target)).toMatchObject({ kit: "0.3.0", ref: "s3", skills: ["anthropic-sdk"] });

    sandbox.commitAll(target, "sync s3");
    const before = snapshot(target);
    for (const extra of [[], ["--skills", "anthropic-sdk"]]) {
      const again = sandbox.syncJson(skillArgs(target, "s3", ...extra));
      expect(again.status, again.stdout + again.stderr).toBe(0);
      expect(again.json.applied).toBe(false);
      expect(again.json.plan).toMatchObject({ add: [], update: [], delete: [], stamp: "unchanged" });
      expect(snapshot(target)).toEqual(before);
    }
    const human = sandbox.sync(skillArgs(target, "s3"));
    expect(human.stdout).toContain("          optional, chosen: anthropic-sdk (as in the last sync)\n");
    expect(human.stdout).toMatch(/Nothing to do: the target already has kit 0\.3\.0 at s3\./);
    expect(snapshot(target)).toEqual(before);
  });

  it("--skills none deletes the unchanged files of the skills it drops and keeps a locally changed one", () => {
    const target = skillsTarget("s2", "--skills", "anthropic-sdk,nextjs-16");
    const edited = ".claude/skills/nextjs-16/SKILL.md";
    const local = "---\nname: nextjs-16\ndescription: Changed in this repository.\n---\n\nOur own notes.\n";
    writeFileSync(path.join(target, edited), local);
    sandbox.commitAll(target, "local change to an optional skill");
    const before = snapshot(target);
    const run = sandbox.syncJson(skillArgs(target, "s2", "--skills", "none"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.skills).toEqual({ core: CORE_SKILLS, chosen: [], notChosen: OPTIONAL_SKILLS, from: "option" });
    expect(run.json.plan).toMatchObject({ add: [], update: [], conflict: [], stamp: "update" });
    expect(run.json.plan?.delete).toEqual([
      ".claude/skills/anthropic-sdk/SKILL.md",
      ".claude/skills/anthropic-sdk/references/tool-loop.md",
      ".claude/skills/nextjs-16/references/caching.md",
    ]);
    expect(run.json.plan?.kept).toEqual([
      {
        path: edited,
        reason: expect.stringMatching(
          /^belongs to the optional skill nextjs-16, which this sync does not install \(--skills\) but was changed in this repository, so it was left in place/,
        ),
      },
    ]);
    expect(existsSync(path.join(target, ".claude/skills/anthropic-sdk"))).toBe(false);
    expect(existsSync(path.join(target, ".claude/skills/nextjs-16/references"))).toBe(false);
    expect(readText(target, edited)).toBe(local);
    const after = snapshot(target);
    for (const rel of without(kits.s2, OPTIONAL_SKILLS)) expect(after[rel], `${rel} was rewritten`).toBe(before[rel]);
    const stamp = readStamp(target);
    expect(stamp.skills).toEqual([]);
    expect(Object.keys(stamp.files)).toEqual(without(kits.s2, OPTIONAL_SKILLS));

    // The kept file belongs to the repository now: a later sync without --skills chooses nothing and leaves it alone.
    sandbox.commitAll(target, "sync --skills none");
    const later = sandbox.syncJson(skillArgs(target, "s3"));
    expect(later.status, later.stdout + later.stderr).toBe(0);
    expect(later.json.skills).toMatchObject({ chosen: [], from: "stamp" });
    expect(later.json.plan).toMatchObject({ add: [], delete: [], kept: [], conflict: [] });
    expect(readText(target, edited)).toBe(local);
    expect(readStamp(target).skills).toEqual([]);
  });

  it("--skills all syncs every optional skill", () => {
    const target = sandbox.makeTarget();
    const run = sandbox.syncJson(skillArgs(target, "s2", "--skills", "all"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.skills).toEqual({ core: CORE_SKILLS, chosen: OPTIONAL_SKILLS, notChosen: [], from: "option" });
    expect(run.json.plan?.add).toEqual(kitPaths(kits.s2));
    expect(listFiles(target, ".claude/skills")).toEqual(skillPaths(kits.s2, ALL_SKILLS));
    const stamp = readStamp(target);
    expect(stamp.skills).toEqual(OPTIONAL_SKILLS);
    expect(Object.keys(stamp.files)).toEqual(kitPaths(kits.s2));
  });

  it("refuses a --skills name that is not an optional skill of the kit at the ref, and writes nothing", () => {
    for (const target of [sandbox.makeTarget(), skillsTarget("s2", "--skills", "anthropic-sdk")]) {
      const before = snapshot(target);
      expectRefused(
        sandbox.syncJson(skillArgs(target, "s2", "--skills", "anthropic-sdk,bogus")),
        /^--skills: "bogus" is not an optional skill of the kit at s2 \([0-9a-f]{12}\)\. Optional skills: anthropic-sdk, nextjs-16, supabase-rls\.$/,
      );
      expectRefused(
        sandbox.syncJson(skillArgs(target, "s2", "--skills", "bogus,reflect")),
        /^--skills: "bogus", "reflect" are not optional skills of the kit at s2 \([0-9a-f]{12}\); reflect is a core skill, always synced\. Optional skills: anthropic-sdk, nextjs-16, supabase-rls\.$/,
      );
      expectRefused(
        sandbox.syncJson(skillArgs(target, "s1", "--skills", "anthropic-sdk")),
        /^--skills: "anthropic-sdk" is not an optional skill of the kit at s1 \([0-9a-f]{12}\); anthropic-sdk is a core skill, always synced\. Optional skills: none\.$/,
      );
      const human = sandbox.sync(skillArgs(target, "s2", "--skills", "bogus"));
      expect(human.status).toBe(1);
      expect(human.stdout).toBe("");
      expect(human.stderr).toMatch(/^hermod sync: --skills: "bogus" is not an optional skill of the kit at s2 .*\. Optional skills: anthropic-sdk, nextjs-16, supabase-rls\.\n$/);
      expect(snapshot(target)).toEqual(before);
    }
  });

  it("refuses an invalid kit/skills.json, and writes nothing", () => {
    const shape = /must be an object with an "optional" list of skill names/;
    const cases: [unknown, RegExp][] = [
      ['{ "optional": [', /^kit\/skills\.json at v1 \([0-9a-f]{12}\) is not valid JSON \(it ends too early\)\.$/],
      [[], shape],
      [{}, shape],
      [{ optional: "anthropic-sdk" }, shape],
      [{ optional: { "anthropic-sdk": true } }, shape],
      [{ optional: [], core: ["reflect"] }, /may only contain "optional" \(found "core"\)/],
      [{ optional: ["Anthropic-SDK"] }, /lists "Anthropic-SDK", which is not a skill name/],
      [{ optional: [7] }, /lists 7, which is not a skill name/],
      [{ optional: ["nextjs-16", "nextjs-16"] }, /lists "nextjs-16" more than once/],
      [{ optional: ["missing-skill"] }, /lists "missing-skill", but kit\/files\/\.claude\/skills\/missing-skill\/ does not exist at that commit/],
      [{ optional: ["hermod"] }, /lists "hermod", but kit\/files\/\.claude\/skills\/hermod\/ does not exist/],
      [{ optional: ["none"] }, /lists "none", which cannot be a skill name/],
    ];
    for (const [skills, message] of cases) {
      const { dir } = sandbox.makeSource(skillsKit("0.2.0", skills), "bad-skills");
      sandbox.git(dir, "tag", "v1");
      const target = sandbox.makeTarget();
      const before = snapshot(target);
      expectRefused(sandbox.syncJson(["--source", dir, "--target", target, "--ref", "v1"]), message);
      expect(snapshot(target)).toEqual(before);
    }
  });

  it("a ref without kit/skills.json syncs every skill, as before", () => {
    const target = sandbox.makeTarget();
    const run = sandbox.syncJson(skillArgs(target, "s1"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.skills).toEqual({ core: ALL_SKILLS, chosen: [], notChosen: [], from: "default" });
    expect(run.json.plan?.add).toEqual(kitPaths(kits.s1));
    expect(listFiles(target, ".claude/skills")).toEqual(skillPaths(kits.s1, ALL_SKILLS));
    expect(readStamp(target).skills).toEqual([]);
    const human = sandbox.sync(skillArgs(sandbox.makeTarget(), "s1", "--dry-run"));
    expect(human.stdout).toContain("  skills  core: anthropic-sdk, curate, nextjs-16, reflect, supabase-rls\n          optional: none\n\n");
    for (const choice of ["none", "all"]) {
      const other = sandbox.makeTarget();
      const chosen = sandbox.syncJson(skillArgs(other, "s1", "--skills", choice));
      expect(chosen.status, chosen.stdout + chosen.stderr).toBe(0);
      expect(chosen.json.plan?.add).toEqual(kitPaths(kits.s1));
    }
  });

  it("keeps an optional skill that the last sync installed as a core skill", () => {
    const target = skillsTarget("s1");
    expect(readStamp(target).skills).toEqual([]);
    const before = snapshot(target);
    const run = sandbox.syncJson(skillArgs(target, "s2"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.skills).toEqual({ core: CORE_SKILLS, chosen: OPTIONAL_SKILLS, notChosen: [], from: "stamp" });
    expect(run.json.plan).toMatchObject({ add: [], update: [], delete: [], kept: [], conflict: [], stamp: "update" });
    const after = snapshot(target);
    for (const rel of skillPaths(kits.s1, OPTIONAL_SKILLS)) expect(after[rel], `${rel} was rewritten`).toBe(before[rel]);
    expect(readStamp(target).skills).toEqual(OPTIONAL_SKILLS);
  });

  it('reads a stamp without "skills" as: every optional skill it has a file of stays chosen', () => {
    const target = skillsTarget("s1");
    // A stamp as the sync before optional skills wrote it (no "skills" key). It lists only one file of nextjs-16
    // and none of supabase-rls, which this target does not have.
    const old = readStamp(target);
    delete old.skills;
    delete old.files[".claude/skills/nextjs-16/SKILL.md"];
    for (const rel of skillPaths(kits.s1, ["supabase-rls"])) delete old.files[rel];
    writeFileSync(path.join(target, ".claude/hermod/VERSION.json"), `${JSON.stringify(old, null, 2)}\n`);
    rmSync(path.join(target, ".claude/skills/supabase-rls"), { recursive: true });
    sandbox.commitAll(target, "a stamp from before optional skills");
    const before = snapshot(target);
    const run = sandbox.syncJson(skillArgs(target, "s2"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.skills).toEqual({
      core: CORE_SKILLS,
      chosen: ["anthropic-sdk", "nextjs-16"],
      notChosen: ["supabase-rls"],
      from: "stamp",
    });
    expect(run.json.plan).toMatchObject({ add: [], update: [], delete: [], kept: [], conflict: [] });
    expect(run.json.plan?.unchanged).toContain(".claude/skills/nextjs-16/SKILL.md");
    const after = snapshot(target);
    for (const rel of skillPaths(kits.s1, ["anthropic-sdk", "nextjs-16"])) expect(after[rel], `${rel} was rewritten`).toBe(before[rel]);
    expect(existsSync(path.join(target, ".claude/skills/supabase-rls"))).toBe(false);
    const stamp = readStamp(target);
    expect(stamp.skills).toEqual(["anthropic-sdk", "nextjs-16"]);
    expect(Object.keys(stamp.files)).toEqual(without(kits.s2, ["supabase-rls"]));
  });

  it('refuses a stamp whose "skills" is not a list of skill names, and writes nothing', () => {
    for (const bad of ["anthropic-sdk", { "anthropic-sdk": true }, [1], ["Not a name"], null]) {
      const stamp = { kit: "0.2.0", ref: "s2", commit: "0".repeat(40), syncedAt: new Date(0).toISOString(), skills: bad, files: {} };
      const target = sandbox.makeTarget({ ...DEFAULT_TARGET_FILES, ".claude/hermod/VERSION.json": JSON.stringify(stamp) });
      const before = snapshot(target);
      expectRefused(
        sandbox.syncJson(skillArgs(target, "s2")),
        /^\.claude\/hermod\/VERSION\.json in the target has a "skills" entry that is not a list of skill names\. Restore it from git/,
      );
      expect(snapshot(target)).toEqual(before);
    }
  });
});

describe("sync: uncommitted changes and dry runs", () => {
  it("refuses uncommitted changes under .claude/ unless --allow-dirty", () => {
    const target = syncedTarget("v0.1.0");
    writeTree(target, { ".claude/skills/own/SKILL.md": "---\nname: own\ndescription: The repository's own.\n---\n" });
    const before = snapshot(target);
    expectRefused(
      sandbox.syncJson(args(target, "v0.2.0")),
      /uncommitted changes under \.claude\/ \(\.claude\/skills\/own\/SKILL\.md\).*--allow-dirty/,
    );
    expect(snapshot(target)).toEqual(before);
    const run = sandbox.syncJson(args(target, "v0.2.0", "--allow-dirty"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(snapshot(target)[".claude/skills/own/SKILL.md"]).toBe(before[".claude/skills/own/SKILL.md"]);
    expect(readText(target, ".claude/hermod/README.md")).toBe("# Hermod fixture kit v2\n");
  });

  it("refuses staged and unstaged changes to tracked files under .claude/", () => {
    const target = syncedTarget("v0.1.0");
    const settings = path.join(target, ".claude/settings.json");
    writeFileSync(settings, `${JSON.stringify(HOOKS_V1)}\n`);
    expectRefused(sandbox.syncJson(args(target, "v0.2.0")), /uncommitted changes under \.claude\/ \(\.claude\/settings\.json\)/);
    sandbox.git(target, "add", ".claude/settings.json");
    expectRefused(sandbox.syncJson(args(target, "v0.2.0")), /uncommitted changes under \.claude\/ \(\.claude\/settings\.json\)/);
    sandbox.git(target, "rm", "-q", "--cached", ".claude/hermod/README.md");
    expectRefused(sandbox.syncJson(args(target, "v0.2.0")), /uncommitted changes under \.claude\/ \(.*\.claude\/hermod\/README\.md/);
  });

  it("ignores uncommitted changes outside .claude/ and in .claude/hermod/.local/", () => {
    const target = syncedTarget("v0.1.0");
    writeFileSync(path.join(target, "src/app.js"), "export const app = 2;\n");
    writeTree(target, { ".claude/hermod/.local/ledger.jsonl": '{"type":"fail"}\n' });
    const run = sandbox.syncJson(args(target, "v0.2.0"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(readText(target, "src/app.js")).toBe("export const app = 2;\n");
    expect(readText(target, ".claude/hermod/.local/ledger.jsonl")).toBe('{"type":"fail"}\n');
  });

  it("--dry-run prints the plan and writes nothing", () => {
    const target = sandbox.makeTarget();
    const before = snapshot(target);
    const run = sandbox.syncJson(args(target, "v0.1.0", "--dry-run"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json).toMatchObject({ ok: true, applied: false, dryRun: true });
    expect(run.json.plan?.add).toEqual(kitPaths(kitV1()));
    expect(run.json.plan?.seed).toEqual(Object.keys(kitV1().seeds ?? {}).sort());
    expect(run.json.plan?.settings).toBe("create");
    expect(run.json.plan?.stamp).toBe("create");
    expect(snapshot(target)).toEqual(before);
    const human = sandbox.sync(args(target, "v0.1.0", "--dry-run"));
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("  add        .claude/hermod/README.md\n");
    expect(human.stdout).toContain("  seed       .claude/hermod/config.json\n");
    expect(human.stdout).toContain("  settings   .claude/settings.json: create\n");
    expect(human.stdout).toContain("  stamp      .claude/hermod/VERSION.json: create\n");
    expect(human.stdout).toContain("  before  no stamp (first install)\n");
    expect(human.stdout).toMatch(/Dry run: nothing was written\.\n$/);
    expect(snapshot(target)).toEqual(before);
  });
});

describe("sync: the target is protected", () => {
  it("never touches anything outside .claude/ (install, upgrade with --force)", () => {
    const target = sandbox.makeTarget();
    const outside = snapshotOutsideClaude(target);
    expect(sandbox.syncJson(args(target, "v0.1.0")).status).toBe(0);
    expect(snapshotOutsideClaude(target)).toEqual(outside);
    writeFileSync(path.join(target, ".claude/hermod/README.md"), "local edit\n");
    sandbox.commitAll(target, "sync and a local edit");
    const outsideAfterCommit = snapshotOutsideClaude(target);
    const run = sandbox.syncJson(args(target, "v0.2.0", "--force"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(snapshotOutsideClaude(target)).toEqual(outsideAfterCommit);
    expect(readText(target, "CLAUDE.md")).toBe(DEFAULT_TARGET_FILES["CLAUDE.md"]);
  });

  it("refuses a stamp that lists files outside .claude/ or files of the repository, and deletes nothing", () => {
    const lessons = "# Lessons\n\nOur fact.\n";
    const cases: [string, string, RegExp][] = [
      ["README.md", DEFAULT_TARGET_FILES["README.md"] as string, /lists "README\.md", which is outside \.claude\//],
      ["../escape.txt", "outside\n", /lists "\.\.\/escape\.txt", which has an empty, "\." or "\.\." part/],
      [".claude/hermod/LESSONS.md", lessons, /lists "\.claude\/hermod\/LESSONS\.md", which belongs to the repository/],
    ];
    for (const [listed, content, message] of cases) {
      const stamp = { kit: "0.0.1", ref: "v0.0.1", commit: "0".repeat(40), syncedAt: new Date(0).toISOString(), files: { [listed]: sha256(content) } };
      const target = sandbox.makeTarget({
        ...DEFAULT_TARGET_FILES,
        ".claude/hermod/LESSONS.md": lessons,
        ".claude/hermod/VERSION.json": JSON.stringify(stamp),
      });
      writeFileSync(path.join(target, "..", "escape.txt"), "outside\n");
      const before = snapshot(target);
      expectRefused(sandbox.syncJson(args(target, "v0.1.0")), message);
      expect(snapshot(target)).toEqual(before);
      expect(readText(path.join(target, ".."), "escape.txt")).toBe("outside\n");
    }
  });

  it("refuses a stamp that is not valid", () => {
    for (const bad of ["not json", "{}", '{ "files": { ".claude/hermod/README.md": "abc" } }']) {
      const target = sandbox.makeTarget({ ...DEFAULT_TARGET_FILES, ".claude/hermod/VERSION.json": bad });
      expectRefused(sandbox.syncJson(args(target, "v0.1.0")), /VERSION\.json in the target (is not a valid sync stamp|has an invalid sha256)/);
    }
  });

  posixOnly("does not write through a symbolic link at a kit path", () => {
    const outside = sandbox.dir("link-target");
    writeFileSync(path.join(outside, "secret.txt"), "keep me\n");
    const target = sandbox.makeTarget();
    mkdirSync(path.join(target, ".claude/hermod"), { recursive: true });
    symlinkSync(path.join(outside, "secret.txt"), path.join(target, ".claude/hermod/README.md"));
    sandbox.commitAll(target, "a link at a kit path");
    const before = snapshot(target);
    const run = sandbox.syncJson(args(target, "v0.1.0", "--force"));
    expect(run.status).toBe(1);
    expect(run.json.plan?.conflict).toEqual([{ path: ".claude/hermod/README.md", reason: expect.stringMatching(/symbolic link/) }]);
    expect(snapshot(target)).toEqual(before);
    expect(readText(outside, "secret.txt")).toBe("keep me\n");
  });

  posixOnly("does not write through a .claude folder that is a symbolic link", () => {
    const outside = sandbox.dir("claude-elsewhere");
    const target = sandbox.makeTarget();
    symlinkSync(outside, path.join(target, ".claude"), "dir");
    sandbox.commitAll(target, ".claude is a link");
    const run = sandbox.syncJson(args(target, "v0.1.0"));
    expectRefused(run, /inside \.claude, which is a symbolic link/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("ignores GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE from the caller's environment", () => {
    const other = sandbox.makeTarget(DEFAULT_TARGET_FILES, "other-repo");
    const otherBefore = snapshot(other);
    const target = sandbox.makeTarget();
    const env = {
      GIT_DIR: path.join(other, ".git"),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: path.join(other, ".git", "index"),
    };
    const run = sandbox.syncJson(args(target, "v0.1.0"), { env });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.commit).toBe(source.v1);
    expect(readStamp(target).commit).toBe(source.v1);
    expect(snapshot(other)).toEqual(otherBefore);
  });

  it("warns when git ignores .claude/ in the target", () => {
    const target = sandbox.makeTarget({ ...DEFAULT_TARGET_FILES, ".gitignore": ".claude/\n" });
    const run = sandbox.syncJson(args(target, "v0.1.0"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.warnings).toEqual([
      "git ignores .claude/hermod/VERSION.json in the target, so the synced files cannot be committed; check its .gitignore.",
    ]);
    expect(sandbox.syncJson(args(sandbox.makeTarget(), "v0.1.0")).json.warnings).toEqual([]);
  });

  it("refuses a target that is not a git repository, a subfolder of one, or the hermod repository", () => {
    const plain = sandbox.dir("plain");
    expectRefused(sandbox.syncJson(args(plain, "v0.1.0")), /is not a git repository/);
    expect(existsSync(path.join(plain, ".claude"))).toBe(false);
    const target = sandbox.makeTarget();
    expectRefused(sandbox.syncJson(args(path.join(target, "src"), "v0.1.0")), /not its top-level folder/);
    expect(existsSync(path.join(target, "src", ".claude"))).toBe(false);
    expectRefused(sandbox.syncJson(args(source.dir, "v0.1.0")), /is the hermod repository itself/);
    expectRefused(sandbox.syncJson(args(path.join(sandbox.root, "missing"), "v0.1.0")), /does not exist/);
  });
});

describe("sync: command line", () => {
  it("--help prints the usage and exits 0", () => {
    const run = sandbox.sync(["--help"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^Usage: node scripts\/sync\.mjs --target <repo> --ref <tag \| full commit sha>/);
    expect(run.stdout).toContain("--allow-dirty");
    expect(run.stdout).toContain("  --skills <list>  The optional skills to install");
  });

  it("exits 2 with a plain message for bad arguments", () => {
    const target = sandbox.makeTarget();
    const cases: [string[], RegExp][] = [
      [["--target", target], /--ref <tag \| full commit sha> is required/],
      [["--ref", "v0.1.0"], /--target <repo> is required/],
      [["--target", target, "--ref", "v0.1.0", "--bogus"], /unknown option --bogus/],
      [["--target", target, "--ref", "v0.1.0", "extra"], /unexpected argument "extra"/],
      [["--target", target, "--ref", "v0.1.0", "--ref", "v0.2.0"], /--ref was given more than once/],
      [["--target", target, "--ref", "v0.1.0", "--skills", ""], /--skills needs optional skill names/],
      [["--target", target, "--ref", "v0.1.0", "--skills", " "], /--skills needs optional skill names/],
      [["--target", target, "--ref", "v0.1.0", "--skills", "nextjs-16,,supabase-rls"], /--skills has an empty name in "nextjs-16,,supabase-rls"/],
      [["--target", target, "--ref", "v0.1.0", "--skills", "nextjs-16,"], /--skills has an empty name/],
      [["--target", target, "--ref", "v0.1.0", "--skills", "Nextjs_16"], /--skills: "Nextjs_16" is not a skill name/],
      [["--target", target, "--ref", "v0.1.0", "--skills", "../reflect"], /--skills: "\.\.\/reflect" is not a skill name/],
      [["--target", target, "--ref", "v0.1.0", "--skills", "none,nextjs-16"], /--skills none cannot be combined with skill names/],
      [["--target", target, "--ref", "v0.1.0", "--skills", "nextjs-16,all"], /--skills all cannot be combined with skill names/],
      [["--target", target, "--ref", "v0.1.0", "--skills", "nextjs-16, nextjs-16"], /--skills names nextjs-16 more than once/],
      [["--target", target, "--ref", "v0.1.0", "--skills", "none", "--skills", "all"], /--skills was given more than once/],
    ];
    for (const [argv, message] of cases) {
      const run = sandbox.sync(argv);
      expect(run.status, run.stderr).toBe(2);
      expect(run.stderr).toMatch(message);
      expect(run.stderr).toMatch(/^hermod sync: .*Run with --help for usage\.\n$/);
      const json = sandbox.syncJson(argv);
      expect(json.status).toBe(2);
      expect(json.json).toMatchObject({ ok: false, applied: false, plan: null });
      expect(json.json.error).toMatch(message);
    }
  });

  it("resolves relative --target and --source paths against the working folder", () => {
    const target = sandbox.makeTarget();
    const run = sandbox.syncJson(
      ["--source", path.relative(sandbox.root, source.dir), "--target", path.relative(sandbox.root, target), "--ref=v0.1.0"],
      { cwd: sandbox.root },
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.json.target).toBe(target);
    expect(run.json.source).toBe(source.dir);
  });

  it("prints a human plan with every kind of line", () => {
    const target = syncedTarget("v0.1.0");
    writeFileSync(path.join(target, ".claude/hermod/hooks/stop.mjs"), "// local\n");
    writeFileSync(path.join(target, ".claude/hermod/legacy/old.mjs"), "// local\n");
    sandbox.commitAll(target, "local changes");
    const run = sandbox.sync(args(target, "v0.2.0", "--force"));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^Hermod sync: kit 0\.2\.0 at v0\.2\.0 \([0-9a-f]{12}\)\n/);
    expect(run.stdout).toContain(`  before  kit 0.1.0 at v0.1.0 (${source.v1.slice(0, 12)})\n`);
    expect(run.stdout).toContain("  add        .claude/hermod/lib/new.mjs\n");
    expect(run.stdout).toContain("  update     .claude/hermod/README.md\n");
    expect(run.stdout).toContain("  update     .claude/hermod/hooks/stop.mjs (local changes overwritten: --force)\n");
    expect(run.stdout).toContain("  keep       .claude/hermod/legacy/old.mjs is no longer in the kit but was changed");
    expect(run.stdout).toContain("  unchanged  5 files\n");
    expect(run.stdout).toContain("  settings   .claude/settings.json: update\n");
    expect(run.stdout).toMatch(/Done: 1 added, 2 updated, 0 deleted, 0 seeded, settings update\./);
  });
});

describe("sync: pure functions", () => {
  interface SyncModule {
    mergeHookSettings(settings: unknown, kitHooks: Record<string, unknown[]>): Record<string, unknown>;
    isSafeTagName(name: string): boolean;
    unsafePathReason(rel: string): string | null;
    parsePorcelainPaths(output: Buffer): string[];
    sameContent(data: Buffer, hash: string): boolean;
    crlfToLf(data: Buffer): Buffer;
  }
  let sync: SyncModule;

  beforeAll(async () => {
    const url = pathToFileURL(SYNC_SCRIPT).href;
    sync = (await import(url)) as SyncModule;
  });

  const kit = HOOKS_V1.hooks as Record<string, unknown[]>;
  const owned = (name: string) => ({ type: "command", command: `node "$CLAUDE_PROJECT_DIR/.claude/hermod/hooks/${name}"` });
  const user = (text: string) => ({ type: "command", command: `echo ${text}` });

  function deepFreeze<T>(value: T): T {
    if (typeof value === "object" && value !== null) {
      for (const inner of Object.values(value)) deepFreeze(inner);
      Object.freeze(value);
    }
    return value;
  }

  it("adds the kit's entries to empty settings", () => {
    expect(sync.mergeHookSettings({}, kit)).toEqual(HOOKS_V1);
  });

  it("is idempotent and keeps key order", () => {
    const settings = { a: 1, hooks: { Stop: [{ hooks: [user("x"), owned("stop.mjs")] }], PreToolUse: [] }, z: 2 };
    const once = sync.mergeHookSettings(settings, kit);
    const twice = sync.mergeHookSettings(once, kit);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(Object.keys(once)).toEqual(["a", "hooks", "z"]);
  });

  it("removes kit handlers from a mixed group in place and keeps the group's other keys", () => {
    const settings = { hooks: { Stop: [{ matcher: "", hooks: [user("a"), owned("stop.mjs"), user("b")], extra: true }, { hooks: [user("c")] }] } };
    const merged = sync.mergeHookSettings(settings, { Stop: kit.Stop ?? [] }) as Settings;
    expect(merged.hooks.Stop).toEqual([{ matcher: "", hooks: [user("a"), user("b")], extra: true }, { hooks: [user("c")] }, ...(kit.Stop ?? [])]);
  });

  it("drops only groups that became empty, and keeps groups and lists that were empty already", () => {
    const settings = { hooks: { Stop: [{ hooks: [] }, { hooks: [owned("stop.mjs")] }], SubagentStop: [] } };
    const merged = sync.mergeHookSettings(settings, { Stop: kit.Stop ?? [] }) as Settings;
    expect(merged.hooks).toEqual({ Stop: [{ hooks: [] }, ...(kit.Stop ?? [])], SubagentStop: [] });
  });

  it("removes an event that held only kit entries once the kit drops it, but keeps events with user entries", () => {
    const settings = {
      hooks: {
        PostToolUseFailure: [{ matcher: "Bash", hooks: [owned("post-tool.mjs")] }],
        PreCompact: [{ hooks: [owned("x.mjs")] }, { hooks: [user("keep")] }],
      },
    };
    const merged = sync.mergeHookSettings(settings, { Stop: kit.Stop ?? [] }) as Settings;
    expect(merged.hooks).toEqual({ PreCompact: [{ hooks: [user("keep")] }], Stop: kit.Stop });
    expect(sync.mergeHookSettings({ hooks: { Stop: [{ hooks: [owned("stop.mjs")] }] } }, {})).toEqual({});
    expect(sync.mergeHookSettings({ hooks: {} }, {})).toEqual({ hooks: {} });
  });

  it("keeps handlers without a command, malformed groups and odd values of events the kit does not use", () => {
    const prompt = { type: "prompt", prompt: "Check." };
    const settings = { hooks: { Stop: [{ hooks: [prompt] }, "odd", { matcher: "x" }], Custom: { not: "a list" } } };
    const merged = sync.mergeHookSettings(settings, { Stop: kit.Stop ?? [] }) as Settings;
    expect(merged.hooks).toEqual({ Stop: [{ hooks: [prompt] }, "odd", { matcher: "x" }, ...(kit.Stop ?? [])], Custom: { not: "a list" } });
  });

  it("recognizes kit entries only by the /.claude/hermod/hooks/ marker", () => {
    const wrapped = { type: "command", command: "bash -c 'node /repo/.claude/hermod/hooks/stop.mjs'" };
    const relative = { type: "command", command: "node .claude/hermod/hooks/stop.mjs" };
    const merged = sync.mergeHookSettings({ hooks: { Stop: [{ hooks: [wrapped, relative] }] } }, {}) as Settings;
    expect(merged.hooks).toEqual({ Stop: [{ hooks: [relative] }] });
  });

  it("refuses settings, hooks or kit events of the wrong shape", () => {
    expect(() => sync.mergeHookSettings([], kit)).toThrow(/must hold a JSON object/);
    expect(() => sync.mergeHookSettings(null, kit)).toThrow(/must hold a JSON object/);
    expect(() => sync.mergeHookSettings({ hooks: [] }, kit)).toThrow(/"hooks" in .* must be an object/);
    expect(() => sync.mergeHookSettings({ hooks: { Stop: "x" } }, kit)).toThrow(/"hooks\.Stop" .* must be a list/);
  });

  it("keeps a __proto__ key as an ordinary key and pollutes no prototype", () => {
    const settings: unknown = JSON.parse('{"__proto__":{"polluted":true},"hooks":{"__proto__":[{"hooks":[{"type":"command","command":"echo x"}]}]}}');
    const merged = sync.mergeHookSettings(settings, { Stop: kit.Stop ?? [] });
    expect(JSON.stringify(merged)).toBe(
      JSON.stringify({ hooks: { Stop: kit.Stop } }).replace('{"hooks":{', '{"__proto__":{"polluted":true},"hooks":{"__proto__":[{"hooks":[{"type":"command","command":"echo x"}]}],'),
    );
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does not change its input", () => {
    const settings = deepFreeze({ hooks: { Stop: [{ hooks: [user("a"), owned("stop.mjs")] }, { hooks: [owned("stop.mjs")] }] }, other: [1] });
    const copy = JSON.parse(JSON.stringify(settings)) as unknown;
    const frozenKit = deepFreeze(JSON.parse(JSON.stringify(kit)) as Record<string, unknown[]>);
    const merged = sync.mergeHookSettings(settings, frozenKit) as Settings;
    expect(settings).toEqual(copy);
    expect(merged.hooks.Stop).toHaveLength(2);
  });

  it("accepts only plain tag names", () => {
    for (const name of ["v0.1.0", "kit-v1.2.3", "release/2026-11", "v1.0.0+build.1", "1.0"]) {
      expect(sync.isSafeTagName(name), name).toBe(true);
    }
    const bad = ["", "-v1", "v1..2", "v1^{commit}", "v1~1", "v1^", "v1:path", "main@{0}", "@", "v1/", ".hidden", "a/.b", "v1.lock", "with space", "a\\b", "x".repeat(201)];
    for (const name of bad) expect(sync.isSafeTagName(name), name).toBe(false);
  });

  it("allows only safe, portable paths under .claude/", () => {
    expect(sync.unsafePathReason(".claude/hermod/README.md")).toBeNull();
    expect(sync.unsafePathReason(".claude/skills/a-b/references/x.md")).toBeNull();
    const bad = [
      "README.md",
      ".claude",
      "../x",
      ".claude/../x",
      ".claude//x",
      ".claude/./x",
      "/etc/passwd",
      "C:/x",
      ".claude\\x",
      ".claude/.git/config",
      ".claude/.GIT/config",
      ".claude/con.txt",
      ".claude/a\u0000b",
      ".claude/a\nb",
      ".claude/a:b",
      ".claude/trailing.",
      ".claude/trailing ",
      ".Claude/x",
    ];
    for (const rel of bad) expect(sync.unsafePathReason(rel), JSON.stringify(rel)).not.toBeNull();
  });

  it("reads every path of git status --porcelain=v1 -z, renames included", () => {
    const output = Buffer.from("?? .claude/a b\0 M .claude/b\0R  .claude/new\0.claude/old\0A  .claude/c\0");
    expect(sync.parsePorcelainPaths(output)).toEqual([".claude/a b", ".claude/b", ".claude/new", ".claude/old", ".claude/c"]);
    expect(sync.parsePorcelainPaths(Buffer.alloc(0))).toEqual([]);
  });

  it("treats CRLF line endings as the same content, but nothing else", () => {
    const lf = Buffer.from("one\ntwo\n");
    expect(sync.sameContent(lf, sha256(lf))).toBe(true);
    expect(sync.sameContent(Buffer.from("one\r\ntwo\r\n"), sha256(lf))).toBe(true);
    expect(sync.sameContent(Buffer.from("one\rtwo\r"), sha256(lf))).toBe(false);
    expect(sync.sameContent(Buffer.from("one\r\ntwo\r\nthree\r\n"), sha256(lf))).toBe(false);
    expect(sync.crlfToLf(Buffer.from("a\r\r\nb\r\n"))).toEqual(Buffer.from("a\r\nb\n"));
  });
});

describe("sync: this repository's kit/skills.json", () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const skillsDir = path.join(repo, "kit", "files", ".claude", "skills");

  it("lists only existing kit skill folders, and reflect and curate are core", async () => {
    const folders = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const data = readFileSync(path.join(repo, "kit", "skills.json"));
    const parsed = JSON.parse(data.toString("utf8")) as { optional: string[] };
    expect(Object.keys(parsed)).toEqual(["optional"]);
    expect(parsed.optional.length).toBeGreaterThan(0);
    expect(new Set(parsed.optional).size).toBe(parsed.optional.length);
    for (const name of parsed.optional) {
      expect(folders, name).toContain(name);
      expect(existsSync(path.join(skillsDir, name, "SKILL.md")), `${name}/SKILL.md`).toBe(true);
    }
    for (const name of ["reflect", "curate"]) {
      expect(existsSync(path.join(skillsDir, name, "SKILL.md")), `${name}/SKILL.md`).toBe(true);
      expect(parsed.optional, name).not.toContain(name);
    }
    // The same rules that sync applies to kit/skills.json at a ref.
    const sync = (await import(pathToFileURL(SYNC_SCRIPT).href)) as {
      parseKitSkills(data: Buffer, at: string, folders: string[]): string[];
    };
    expect(sync.parseKitSkills(data, "the working tree", folders)).toEqual([...parsed.optional].sort());
  });
});
