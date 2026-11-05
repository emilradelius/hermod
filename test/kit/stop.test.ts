// End-to-end tests for the Stop hook (kit/files/.claude/hermod/hooks/stop.mjs): each test builds a temporary git
// repository with the real kit copied in, saves session-start state the way SessionStart does, makes changes, and
// runs `node .claude/hermod/hooks/stop.mjs` with JSON on stdin.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, KIT_FILES, makeRepo, runHook, type Files, type Repo, type RunResult } from "./helpers.js";

const FIXTURE = readFileSync(fileURLToPath(new URL("./fixtures/checks/no-console-log.mjs", import.meta.url)), "utf8");
const CHECKS_DIR = ".claude/hermod/checks";
const FOOTER = "Hermod blocks once for this; it will not block again for the same reason.";

interface GitLib {
  head(root: string): string | null;
  branch(root: string): string | null;
  snapshotDirty(root: string, options?: { max?: number }): { files: Record<string, string> };
}
interface StateLib {
  writeSessionStart(root: string, id: string, state: Record<string, unknown>): boolean;
  sessionDir(root: string, id: string): string;
}
let gitLib: GitLib;
let stateLib: StateLib;

beforeAll(async () => {
  const load = async (rel: string) => import(pathToFileURL(path.join(KIT_FILES, ".claude/hermod/lib", rel)).href);
  gitLib = (await load("git.mjs")) as GitLib;
  stateLib = (await load("state.mjs")) as StateLib;
});
afterAll(() => cleanup());

// ------------------------------------------------------------------------------------------------ helpers

const BASE_FILES: Files = {
  "src/app.ts": "export const a = 1;\n",
  "docs/PROGRESS.md": "# Progress\n\n## Status\nStarted.\n\n## Next step\nBuild.\n",
  "README.md": "# Demo\n",
  ".claude/hermod/LESSONS.md": "# Lessons\n<!-- hermod:lessons -->\n\nThe app reads settings from one file.\n",
};

function config(ritual: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, ritual, ...extra }, null, 2);
}

function repoWith(files: Files = {}): Repo {
  return makeRepo({ files: { ...BASE_FILES, ...files } });
}

/** Save session-start state as the SessionStart hook does: HEAD, branch and the dirty files' blob hashes. */
function startSession(repo: Repo, id = "sess-1"): string {
  const snap = gitLib.snapshotDirty(repo.root);
  stateLib.writeSessionStart(repo.root, id, {
    sessionId: id,
    startedAt: new Date().toISOString(),
    head: gitLib.head(repo.root),
    branch: gitLib.branch(repo.root),
    transcriptPath: null,
    dirty: snap.files,
  });
  return id;
}

function stop(repo: Repo, input: string | object = { session_id: "sess-1", hook_event_name: "Stop", stop_hook_active: false }): RunResult {
  return runHook(repo, "stop", input);
}

/** Asserts the hook blocked and returns the reason. */
function blocked(r: RunResult): string {
  expect(r.code).toBe(0);
  expect(r.stdout, `stderr: ${r.stderr}`).not.toBe("");
  const out = JSON.parse(r.stdout) as { decision: string; reason: string };
  expect(Object.keys(out).sort()).toEqual(["decision", "reason"]);
  expect(out.decision).toBe("block");
  expect(out.reason.length).toBeLessThanOrEqual(1500);
  expect(out.reason.endsWith(FOOTER)).toBe(true);
  return out.reason;
}

function passed(r: RunResult): void {
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
}

function stopState(repo: Repo, id = "sess-1"): { fingerprints: string[]; blocks: number } | null {
  const file = path.join(stateLib.sessionDir(repo.root, id), "stop.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { fingerprints: string[]; blocks: number }) : null;
}

function errorsLog(repo: Repo): string {
  return repo.read(".claude/hermod/.local/errors.log") ?? "";
}

// --------------------------------------------------------------------------------------------- the ritual

describe("Stop hook: the progress file", () => {
  it("blocks once when code changed without docs/PROGRESS.md, then never again for the same reason", () => {
    const repo = repoWith();
    startSession(repo);
    repo.write("src/app.ts", "export const a = 2;\n");
    const reason = blocked(stop(repo));
    expect(reason).toMatch(/Code changed this session: src\/app\.ts\./);
    expect(reason).toMatch(/- docs\/PROGRESS\.md \(Status, Next step, Not done\)/);
    expect(stopState(repo)).toMatchObject({ blocks: 1 });
    expect(stopState(repo)!.fingerprints).toHaveLength(1);

    passed(stop(repo));
    // More code changes, same missing file: still the same reason, so still no block.
    repo.write("src/other.ts", "export const b = 1;\n");
    passed(stop(repo));
    expect(stopState(repo)).toMatchObject({ blocks: 1 });
    expect(errorsLog(repo)).toBe("");
  });

  it("never blocks when stop_hook_active is true, and writes no state", () => {
    const repo = repoWith();
    startSession(repo);
    repo.write("src/app.ts", "export const a = 2;\n");
    passed(stop(repo, { session_id: "sess-1", hook_event_name: "Stop", stop_hook_active: true }));
    expect(stopState(repo)).toBeNull();
    // It still blocks later when Claude Code is not already continuing because of a Stop hook.
    blocked(stop(repo));
  });

  it("does not block for docs-only changes", () => {
    const repo = repoWith();
    startSession(repo);
    repo.write("docs/notes.md", "notes\n");
    repo.write("README.md", "# Demo, changed\n");
    repo.write("src/README.md", "markdown under src/ is ignored too\n");
    repo.write(".claude/hermod/config.json.bak", "{}");
    passed(stop(repo));
    expect(stopState(repo)).toBeNull();
  });

  it("does not block when docs/PROGRESS.md was updated too (uncommitted or committed)", () => {
    const repo = repoWith();
    startSession(repo);
    repo.write("src/app.ts", "export const a = 2;\n");
    repo.write("docs/PROGRESS.md", "# Progress\n\n## Status\nDone.\n");
    passed(stop(repo));

    const repo2 = repoWith();
    startSession(repo2);
    repo2.commit({ files: { "src/app.ts": "export const a = 3;\n", "docs/PROGRESS.md": "# Progress\nDone.\n" } });
    passed(stop(repo2));
  });

  it("counts code committed during the session", () => {
    const repo = repoWith();
    startSession(repo);
    repo.commit({ files: { "src/app.ts": "export const a = 2;\n" }, message: "change" });
    expect(blocked(stop(repo))).toMatch(/src\/app\.ts/);
  });

  it("satisfies a glob require with any matching file, and only a matching one", () => {
    const cfg = config({ require: [{ path: "docs/progress-archive/*.md", why: "the session's full entry" }] });
    const repo = repoWith({ ".claude/hermod/config.json": cfg });
    startSession(repo);
    repo.write("src/app.ts", "export const a = 2;\n");
    repo.write("docs/progress-archive/sub/2026-11.md", "deeper than * reaches\n");
    repo.write("docs/PROGRESS.md", "# Progress\nThe default require is replaced by config.\n");
    expect(blocked(stop(repo))).toMatch(/- docs\/progress-archive\/\*\.md \(the session's full entry\)/);

    const repo2 = repoWith({ ".claude/hermod/config.json": cfg });
    startSession(repo2);
    repo2.write("src/app.ts", "export const a = 2;\n");
    repo2.write("docs/progress-archive/2026-11.md", "## Done\n");
    passed(stop(repo2));
  });

  it("lists every missing required file and the reminders", () => {
    const cfg = config({
      require: [{ path: "docs/PROGRESS.md", why: "Status" }, { path: "docs/decisions.md" }],
      remind: ["Run /reflect before you finish."],
    });
    const repo = repoWith({ ".claude/hermod/config.json": cfg });
    startSession(repo);
    repo.write("src/app.ts", "export const a = 2;\n");
    const reason = blocked(stop(repo));
    expect(reason).toMatch(/- docs\/PROGRESS\.md \(Status\)\n- docs\/decisions\.md\n/);
    expect(reason).toMatch(/Reminders:\n- Run \/reflect before you finish\./);
  });

  it("never blocks when ritual.enabled is false", () => {
    const repo = repoWith({
      ".claude/hermod/config.json": config({ enabled: false }),
      [`${CHECKS_DIR}/no-console-log.mjs`]: FIXTURE,
    });
    startSession(repo);
    repo.write("src/app.ts", 'console.log("x");\n');
    repo.write(".claude/hermod/LESSONS.md", "# Lessons\n<!-- x -->\n\nSame.\n§\nSame.\n");
    passed(stop(repo));
    passed(stop(repo));
    expect(stopState(repo)).toBeNull();
  });

  it("keeps the reason under 1,500 characters and lists at most 5 paths", () => {
    const files: Files = {};
    for (let i = 0; i < 20; i++) files[`src/module-${String(i).padStart(2, "0")}.ts`] = `export const v${i} = ${i};\n`;
    const longWhy = "x".repeat(3000);
    const cfg = config({
      require: Array.from({ length: 12 }, (_, i) => ({ path: `docs/required-${i}.md`, why: longWhy })),
      remind: Array.from({ length: 12 }, (_, i) => `Reminder ${i} ${"y".repeat(400)}`),
    });
    const repo = repoWith({ ".claude/hermod/config.json": cfg });
    startSession(repo);
    for (const [p, c] of Object.entries(files)) repo.write(p, c as string);
    const reason = blocked(stop(repo));
    expect(reason).toMatch(
      /Code changed this session: src\/module-00\.ts, src\/module-01\.ts, src\/module-02\.ts, src\/module-03\.ts, src\/module-04\.ts and 15 more\./,
    );
    expect(reason).not.toMatch(/module-05/);
  });
});

describe("Stop hook: changed files", () => {
  it("ignores a file that was already dirty at session start and is unchanged", () => {
    const repo = repoWith();
    repo.write("src/app.ts", "export const a = 'dirty before the session';\n");
    repo.write("src/untracked.ts", "export const u = 1;\n");
    startSession(repo);
    passed(stop(repo));
    expect(stopState(repo)).toBeNull();
  });

  it("counts a file that was dirty at session start and changed further", () => {
    const repo = repoWith();
    repo.write("src/app.ts", "export const a = 'dirty before the session';\n");
    repo.write("src/untracked.ts", "export const u = 1;\n");
    startSession(repo);
    repo.write("src/untracked.ts", "export const u = 2;\n");
    const reason = blocked(stop(repo));
    expect(reason).toMatch(/Code changed this session: src\/untracked\.ts\./);
    expect(reason).not.toMatch(/src\/app\.ts/);
  });

  it("counts a file that was dirty at session start and deleted during it", () => {
    const repo = repoWith();
    repo.write("src/app.ts", "export const a = 'dirty';\n");
    startSession(repo);
    repo.remove("src/app.ts");
    expect(blocked(stop(repo))).toMatch(/src\/app\.ts/);
  });

  it("without session state: uses the merge base with the default branch on a feature branch", () => {
    const repo = repoWith();
    repo.git("checkout", "-q", "-b", "feature");
    repo.commit({ files: { "src/feature.ts": "export const f = 1;\n" } });
    expect(blocked(stop(repo, { session_id: "no-state", hook_event_name: "Stop" }))).toMatch(/src\/feature\.ts/);
  });

  it("without session state on the default branch: counts uncommitted changes only", () => {
    const repo = repoWith();
    repo.commit({ files: { "src/committed.ts": "export const c = 1;\n" } });
    passed(stop(repo, { session_id: "no-state" }));
    repo.write("src/app.ts", "export const a = 9;\n");
    const reason = blocked(stop(repo, { session_id: "no-state" }));
    expect(reason).toMatch(/src\/app\.ts/);
    expect(reason).not.toMatch(/committed\.ts/);
  });

  it("handles a session that started before the first commit", () => {
    const repo = makeRepo({ files: BASE_FILES, initialCommit: false });
    startSession(repo);
    repo.commit({ files: { "src/new.ts": "export const n = 1;\n" } });
    const reason = blocked(stop(repo));
    expect(reason).toMatch(/src\/new\.ts/);
    // src/app.ts was untracked and unchanged since the start: not counted.
    expect(reason).not.toMatch(/src\/app\.ts/);
  });
});

describe("Stop hook: block limits", () => {
  it("blocks again for a different reason, but at most maxBlocksPerSession times", () => {
    const repo = repoWith({ ".claude/hermod/config.json": config({ maxBlocksPerSession: 2 }) });
    startSession(repo);
    repo.write("src/app.ts", "export const a = 2;\n");
    blocked(stop(repo)); // 1: progress file missing
    repo.write(".claude/hermod/LESSONS.md", "# Lessons\n<!-- x -->\n\nOne fact.\n§\nOne fact.\n");
    expect(blocked(stop(repo))).toMatch(/repeats entry 1/); // 2: new reason set
    repo.write(".claude/hermod/LESSONS.md", "# Lessons\n<!-- x -->\n\nA.\n§\n\n§\nB.\n");
    passed(stop(repo)); // 3: yet another reason set, but the limit is reached
    expect(stopState(repo)).toMatchObject({ blocks: 2 });
    expect(stopState(repo)!.fingerprints).toHaveLength(2);
  });

  it("respects maxBlocksPerSession = 1", () => {
    const repo = repoWith({ ".claude/hermod/config.json": config({ maxBlocksPerSession: 1 }) });
    startSession(repo);
    repo.write("src/app.ts", "export const a = 2;\n");
    blocked(stop(repo));
    repo.write(".claude/hermod/LESSONS.md", "# Lessons\n<!-- x -->\n\nOne fact.\n§\nOne fact.\n");
    passed(stop(repo));
  });

  it("keeps block state per session", () => {
    const repo = repoWith();
    startSession(repo, "sess-a");
    startSession(repo, "sess-b");
    repo.write("src/app.ts", "export const a = 2;\n");
    blocked(stop(repo, { session_id: "sess-a" }));
    passed(stop(repo, { session_id: "sess-a" }));
    blocked(stop(repo, { session_id: "sess-b" }));
  });

  it("does not block when its state cannot be saved (fails open, so it can never loop)", () => {
    const repo = repoWith();
    repo.write("src/app.ts", "export const a = 2;\n");
    // The session folder path is taken by a file, so stop.json cannot be written.
    mkdirSync(repo.abs(".claude/hermod/.local/sessions"), { recursive: true });
    writeFileSync(repo.abs(".claude/hermod/.local/sessions/sess-1"), "not a folder");
    passed(stop(repo));
    passed(stop(repo));
    expect(errorsLog(repo)).toMatch(/\[stop\]/);
  });

  it("does not block without a session id, or for another hook event", () => {
    const repo = repoWith();
    repo.write("src/app.ts", "export const a = 2;\n");
    passed(stop(repo, { hook_event_name: "Stop" }));
    passed(stop(repo, { session_id: "", hook_event_name: "Stop" }));
    passed(stop(repo, { session_id: "sess-1", hook_event_name: "SubagentStop" }));
  });
});

describe("Stop hook: checks", () => {
  function repoWithCheck(name: string, source: string, files: Files = {}): Repo {
    return repoWith({ [`${CHECKS_DIR}/${name}`]: source, ...files });
  }
  const custom = (id: string, level: string, run: string) => `export default {
    id: ${JSON.stringify(id)}, description: "custom ${id}", level: ${JSON.stringify(level)},
    run(ctx) { ${run} },
    examples: [{ name: "p", expect: true }, { name: "f", expect: false }],
  };\n`;

  it("blocks with a failing check's message even when the progress file was updated", () => {
    const repo = repoWithCheck("no-console-log.mjs", FIXTURE);
    startSession(repo);
    repo.write("src/app.ts", 'export const a = 1;\nconsole.log("debug");\n');
    repo.write("docs/PROGRESS.md", "# Progress\nUpdated.\n");
    const reason = blocked(stop(repo));
    expect(reason).toMatch(/Checks that failed \(node \.claude\/hermod\/check\.mjs\):\n- no-console-log: console\.log added in src\/app\.ts/);
    expect(reason).not.toMatch(/Not updated yet/);
    passed(stop(repo));
  });

  it("passes the session-start head as the base (a console.log committed before the session is not counted)", () => {
    const repo = repoWithCheck("no-console-log.mjs", FIXTURE, { "src/old.ts": 'console.log("old");\n' });
    startSession(repo);
    repo.write("src/app.ts", "export const a = 2;\n");
    repo.write("src/old.ts", 'console.log("old");\nexport const o = 1;\n');
    repo.write("docs/PROGRESS.md", "# Progress\nUpdated.\n");
    passed(stop(repo));
  });

  it("never blocks for a warn-level check, but mentions it when blocking for something else", () => {
    const repo = repoWithCheck("soft.mjs", custom("soft", "warn", 'return { ok: false, message: "consider a test" };'));
    startSession(repo);
    repo.write("src/app.ts", "export const a = 2;\n");
    repo.write("docs/PROGRESS.md", "# Progress\nUpdated.\n");
    passed(stop(repo));

    const repo2 = repoWithCheck("soft.mjs", custom("soft", "warn", 'return { ok: false, message: "consider a test" };'));
    startSession(repo2);
    repo2.write("src/app.ts", "export const a = 2;\n");
    const reason = blocked(stop(repo2));
    expect(reason).toMatch(/Warnings \(these do not block\):\n- soft: consider a test/);
    expect(reason).not.toMatch(/Checks that failed/);
  });

  it("reports a throwing check as failed and still exits 0", () => {
    const repo = repoWithCheck("boom.mjs", custom("boom", "error", 'throw new Error("kaboom");'));
    startSession(repo);
    repo.write("src/app.ts", "export const a = 2;\n");
    repo.write("docs/PROGRESS.md", "# Progress\nUpdated.\n");
    const r = stop(repo);
    expect(blocked(r)).toMatch(/- boom: threw: kaboom/);
    expect(r.stderr).toBe("");
  });

  it("keeps its output a single JSON object when a check prints", () => {
    const run = 'console.log("NOISE"); process.stdout.write("{\\"decision\\":\\"approve\\"}\\n"); return { ok: false, message: "loud" };';
    const repo = repoWithCheck("loud.mjs", custom("loud", "error", run));
    startSession(repo);
    repo.write("src/app.ts", "export const a = 2;\n");
    const r = stop(repo);
    expect(r.stdout).not.toMatch(/NOISE|approve/);
    expect(blocked(r)).toMatch(/- loud: loud/);
  });

  it("does not run checks that are not committed", () => {
    const repo = repoWith();
    startSession(repo);
    repo.write(`${CHECKS_DIR}/fresh.mjs`, custom("fresh", "error", 'return { ok: false, message: "uncommitted check ran" };'));
    repo.write("src/app.ts", "export const a = 2;\n");
    repo.write("docs/PROGRESS.md", "# Progress\nUpdated.\n");
    passed(stop(repo));
  });

  it("does not run checks when runChecks is false or no code changed", () => {
    const failing = custom("always", "error", 'return { ok: false, message: "always fails" };');
    const repo = repoWithCheck("always.mjs", failing, { ".claude/hermod/config.json": config({ runChecks: false }) });
    startSession(repo);
    repo.write("src/app.ts", "export const a = 2;\n");
    repo.write("docs/PROGRESS.md", "# Progress\nUpdated.\n");
    passed(stop(repo));

    const repo2 = repoWithCheck("always.mjs", failing);
    startSession(repo2);
    repo2.write("docs/notes.md", "docs only\n");
    passed(stop(repo2));
  });
});

describe("Stop hook: knowledge files", () => {
  it("blocks with the validator's errors when LESSONS.md changed and is invalid, even with no code change", () => {
    const repo = repoWith();
    startSession(repo);
    repo.write(".claude/hermod/LESSONS.md", "# Lessons\n<!-- x -->\n\nThe build uses one config file.\n§\nthe build uses ONE config   file.\n§\n# Not a heading\n");
    const reason = blocked(stop(repo));
    expect(reason).toMatch(/Invalid knowledge files \(node \.claude\/hermod\/validate\.mjs\):/);
    expect(reason).toMatch(/\.claude\/hermod\/LESSONS\.md line \d+: Entry 2 repeats entry 1/);
    expect(reason).toMatch(/Entry 3 starts with "#"/);
    expect(reason).toMatch(/Changed this session: \.claude\/hermod\/LESSONS\.md\./);
    expect(reason).not.toMatch(/Not updated yet/);
    passed(stop(repo));
  });

  it("does not block for a valid LESSONS.md change, or for an invalid one not changed this session", () => {
    const repo = repoWith();
    startSession(repo);
    repo.write(".claude/hermod/LESSONS.md", "# Lessons\n<!-- x -->\n\nThe app reads settings from one file.\n§\nTests run in temp repos.\n");
    passed(stop(repo));

    const repo2 = repoWith({ ".claude/hermod/LESSONS.md": "# Lessons\n<!-- x -->\n\nSame.\n§\nSame.\n" });
    startSession(repo2);
    repo2.write("docs/notes.md", "x\n");
    passed(stop(repo2));
  });

  it("does not block again when only a line number in the same errors moved", () => {
    const repo = repoWith();
    startSession(repo);
    repo.write(".claude/hermod/LESSONS.md", "# Lessons\n<!-- x -->\n\nSame.\n§\nSame.\n");
    blocked(stop(repo));
    repo.write(".claude/hermod/LESSONS.md", "# Lessons\n<!-- x -->\n\n\n\nSame.\n§\nSame.\n");
    passed(stop(repo));
  });

  it("validates a skill changed this session", () => {
    const repo = repoWith();
    startSession(repo);
    repo.write(".claude/skills/my-skill/SKILL.md", "---\nname: other-name\ndescription: Does a thing.\n---\n\nBody.\n");
    expect(blocked(stop(repo))).toMatch(/\.claude\/skills\/my-skill\/SKILL\.md[^\n]*: [^\n]*other-name/);

    const repo2 = repoWith();
    startSession(repo2);
    repo2.write(".claude/skills/good-skill/SKILL.md", "---\nname: good-skill\ndescription: Does a thing.\n---\n\nBody.\n");
    passed(stop(repo2));
  });

  it("skips validation when validateKnowledge is false", () => {
    const repo = repoWith({ ".claude/hermod/config.json": config({ validateKnowledge: false }) });
    startSession(repo);
    repo.write(".claude/hermod/LESSONS.md", "# Lessons\n<!-- x -->\n\nSame.\n§\nSame.\n");
    passed(stop(repo));
  });
});

describe("Stop hook: hostile input", () => {
  it.each([
    ["malformed JSON", "{not json"],
    ["a JSON array", "[1, 2]"],
    ["a JSON string", '"Stop"'],
    ["empty input", ""],
    ["binary noise", "\u0000\u0001ÿ"],
  ])("exits 0 silently on %s", (_label, stdin) => {
    const repo = repoWith();
    startSession(repo);
    repo.write("src/app.ts", "export const a = 2;\n");
    const r = stop(repo, stdin);
    passed(r);
    expect(r.stderr).toBe("");
  });

  it("logs malformed input to errors.log", () => {
    const repo = repoWith();
    passed(stop(repo, "{not json"));
    expect(errorsLog(repo)).toMatch(/\[stop\].*not valid JSON/);
  });

  it("exits 0 silently in a folder without Hermod, and outside git", () => {
    const plain = makeRepo({ kit: false, files: { "src/app.ts": "export const a = 1;\n" } });
    plain.write("src/app.ts", "export const a = 2;\n");
    const hook = path.join(KIT_FILES, ".claude/hermod/hooks/stop.mjs");
    const r = runHook({ ...plain, kitPath: () => hook } as Repo, "stop", { session_id: "s" });
    passed(r);

    const nogit = makeRepo({ git: false, files: BASE_FILES });
    passed(stop(nogit, { session_id: "s" }));
  });

  it("treats a hostile session id as a plain folder name", () => {
    const repo = repoWith();
    repo.write("src/app.ts", "export const a = 2;\n");
    blocked(stop(repo, { session_id: "../../../../escape" }));
    expect(existsSync(path.join(repo.root, "..", "escape"))).toBe(false);
    passed(stop(repo, { session_id: "../../../../escape" }));
  });

  it("ignores an invalid config.json and uses the defaults", () => {
    const repo = repoWith({ ".claude/hermod/config.json": "{ not json" });
    startSession(repo);
    repo.write("src/app.ts", "export const a = 2;\n");
    expect(blocked(stop(repo))).toMatch(/docs\/PROGRESS\.md/);
  });
});
