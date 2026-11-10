// End-to-end tests for reflect-prep (kit/files/.claude/hermod/reflect-prep.mjs): a temporary git repository with the
// real kit, a session started by the real SessionStart hook, ledger entries written by the real PostToolUse hook, a
// fake transcript, then `node .claude/hermod/reflect-prep.mjs` and checks on the bundle and the usage file.
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, makeRepo, runHook, runNode, tempDir, type Repo, type RunResult } from "./helpers.js";

afterAll(() => cleanup());

const SESSION = "0f3c2a1b-aaaa-4bbb-8ccc-123456789abc";
const LESSONS = "# Lessons\n<!-- hermod:lessons -->\n\nThe build reads settings from one file.\n§\nTests run against a temporary folder.\n";

function prep(repo: Repo, ...args: string[]): RunResult {
  return runNode(repo.kitPath("reflect-prep.mjs"), { cwd: repo.root, args, env: { CLAUDE_PROJECT_DIR: repo.root } });
}

function startSession(repo: Repo, id = SESSION, transcript?: string): void {
  const r = runHook(repo, "session-start", {
    session_id: id,
    hook_event_name: "SessionStart",
    source: "startup",
    cwd: repo.root,
    ...(transcript === undefined ? {} : { transcript_path: transcript }),
  });
  expect(r.code, r.stderr).toBe(0);
}

function tool(repo: Repo, input: Record<string, unknown>, id = SESSION): void {
  const r = runHook(repo, "post-tool", { session_id: id, cwd: repo.root, ...input });
  expect(r.code, r.stderr).toBe(0);
}

const bashFail = (command: string, error: string) => ({
  hook_event_name: "PostToolUseFailure",
  tool_name: "Bash",
  tool_input: { command },
  error,
});
const bashOk = (command: string) => ({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "ok" } });
const skill = (name: string) => ({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: name } });

function writeTranscript(lines: unknown[]): string {
  const file = path.join(tempDir("hermod-transcript-"), "session.jsonl");
  writeFileSync(file, `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`);
  return file;
}
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", message: { role: "user", content }, ...extra });

function bundleOf(repo: Repo, id = SESSION): string {
  const text = repo.read(`.claude/hermod/.local/reflect/${id}.md`);
  expect(text, "bundle written").not.toBeNull();
  return text ?? "";
}

/** Lets state travel: the marker committed, and origin/main (a local remote-tracking ref) pointing at it. */
function optIn(repo: Repo): void {
  repo.commit({ files: { ".claude/hermod/state/ALLOW_COMMIT": "private\n" }, message: "opt in" });
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
}

function baseRepo(): Repo {
  return makeRepo({
    files: {
      "src/app.ts": "export const a = 1;\n",
      "docs/PROGRESS.md": "# Progress\n\n## Status\nStarted.\n",
      ".claude/hermod/LESSONS.md": LESSONS,
      ".claude/hermod/checks/no-todo.mjs":
        '// @ts-check\nexport default { id: "no-todo", description: "No TODO left in src", level: "warn", run() { return { ok: true }; }, examples: [] };\n',
    },
  });
}

describe("reflect-prep: the bundle", () => {
  it("writes all six sections with commits, changes, ledger, user messages and knowledge", () => {
    const repo = baseRepo();
    const secret = "ghp_" + "c".repeat(36);
    const transcript = writeTranscript([
      { type: "summary", summary: "a summary line of an unknown shape" },
      user("Please fix the failing test in src/app.ts"),
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ASSISTANT WORDS" }] } },
      user([{ type: "tool_result", tool_use_id: "t1", content: "TOOL RESULT CONTENT" }]),
      user([{ type: "tool_result", tool_use_id: "t2", content: "x" }, { type: "text", text: "TEXT BESIDE A TOOL RESULT" }]),
      user("output", { toolUseResult: { stdout: "TOOL USE RESULT" } }),
      user([{ type: "text", text: `here is my token ${secret} for the deploy` }]),
      "{ broken json",
      user("Thanks, that works"),
    ]);
    startSession(repo, SESSION, transcript);
    tool(repo, bashFail("npm test", "Exit code 1\nFAIL src/app.test.ts\nexpected 2, got 1"));
    repo.write("src/app.ts", "export const a = 2;\n");
    tool(repo, bashOk("npm test"));
    tool(repo, skill("reflect"));
    repo.commit({ message: "Fix the answer in app" });
    repo.write("src/new.ts", "export {};\n");

    const r = prep(repo);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`.claude/hermod/.local/reflect/${SESSION}.md`);
    expect(r.stdout).toContain("1 commit, 2 changed files, 1 failed command (1 resolved), 3 user messages, 1 skill event.");
    const b = bundleOf(repo);

    for (const h of ["## 1. Session", "## 2. Commits and changes", "## 3. Ledger", "## 4. User messages", "## 5. Lessons, skills, checks", "## 6. Footer"]) {
      expect(b).toContain(h);
    }
    const order = ["## 1.", "## 2.", "## 3.", "## 4.", "## 5.", "## 6."].map((h) => b.indexOf(h));
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(b.trimEnd().endsWith("Proposals only. A person merges; nothing is kept until then.")).toBe(true);

    // 1. Session
    const startHead = repo.git("rev-parse", "HEAD~1");
    expect(b).toContain(`- Session: ${SESSION}`);
    expect(b).toContain(`- Start head: ${startHead}`);
    expect(b).toContain(`- Current head: ${repo.git("rev-parse", "HEAD")}`);
    expect(b).toContain("- Branch: main");
    // 2. Commits and changes
    expect(b).toMatch(/- [0-9a-f]{7,} Fix the answer in app/);
    expect(b).toContain("src/app.ts | ");
    expect(b).toContain("- src/app.ts\n");
    expect(b).toContain("- src/new.ts (untracked)");
    // 3. Ledger: the failure, its resolution with the changed file, the skill use
    const ledger = (repo.read(".claude/hermod/.local/ledger.jsonl") ?? "").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const failure = ledger.find((e) => e.type === "fail");
    const resolved = ledger.find((e) => e.type === "resolved");
    expect(b).toContain(`- ${failure?.id} · \`npm test\` · exit 1 · resolved by ${resolved?.id}`);
    expect(b).toContain("expected 2, got 1");
    expect(b).toContain(`- ${resolved?.id} resolves ${failure?.id}: \`npm test\``);
    expect(b).toContain("changed since the failure: src/app.ts");
    expect(b).toContain("- reflect: 1 use, 0 views");
    // 4. User messages: only the user's words, redacted
    expect(b).toContain("1. Please fix the failing test in src/app.ts");
    expect(b).toContain("2. here is my token [REDACTED:github-token] for the deploy");
    expect(b).toContain("3. Thanks, that works");
    for (const bad of ["TOOL RESULT CONTENT", "TEXT BESIDE A TOOL RESULT", "TOOL USE RESULT", "ASSISTANT WORDS", "a summary line"]) expect(b).not.toContain(bad);
    expect(b).not.toContain(secret);
    // 5. Knowledge
    expect(b).toMatch(/### Lessons \(\.claude\/hermod\/LESSONS\.md: \d+ of 4,000 chars, \d+%, 2 entries\)/);
    expect(b).toContain("1. The build reads settings from one file.");
    expect(b).toContain("2. Tests run against a temporary folder.");
    expect(b).toMatch(/- reflect: .+ \([\d,]+ chars, \d+ lines\)/);
    expect(b).toContain("- no-todo: No TODO left in src");
    expect(b).toContain("### Validator");
  });

  it("says plainly when there is no transcript, and when it is missing", () => {
    const repo = baseRepo();
    startSession(repo, "no-transcript");
    expect(prep(repo, "--session", "no-transcript").code).toBe(0);
    expect(bundleOf(repo, "no-transcript")).toContain("No transcript path was saved for this session");

    startSession(repo, "gone", path.join(tempDir(), "does-not-exist.jsonl"));
    const r = prep(repo, "--session", "gone");
    expect(r.code, r.stderr).toBe(0);
    expect(bundleOf(repo, "gone")).toMatch(/No user messages: the transcript could not be read: it does not exist/);
  });

  it("picks the most recent session by default, and the named one with --session", () => {
    const repo = baseRepo();
    startSession(repo, "older-session");
    tool(repo, bashFail("npm run old", "Exit code 1\nold"), "older-session");
    // Make sure the second session is newer on coarse file systems.
    const until = Date.now() + 30;
    while (Date.now() < until) {
      /* wait */
    }
    startSession(repo, "newer-session");
    tool(repo, bashFail("npm run new", "Exit code 1\nnew"), "newer-session");

    expect(prep(repo).code).toBe(0);
    const newer = bundleOf(repo, "newer-session");
    expect(newer).toContain("`npm run new`");
    expect(newer).not.toContain("npm run old");

    expect(prep(repo, "--session", "older-session").code).toBe(0);
    const older = bundleOf(repo, "older-session");
    expect(older).toContain("`npm run old`");
    expect(older).not.toContain("npm run new");
  });

  it("fails with a clear message when there is no session, and when the kit is missing", () => {
    const repo = baseRepo();
    const r = prep(repo);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no session found/);
    expect(existsSync(repo.abs(".claude/hermod/.local/reflect"))).toBe(false);

    const bare = makeRepo({ kit: false, files: { "a.txt": "a\n" } });
    const r2 = runNode(repo.kitPath("reflect-prep.mjs"), { cwd: bare.root, args: ["--root", bare.root, "--session", "x"] });
    expect(r2.code).toBe(1);
    expect(r2.stderr).toMatch(/not installed/);
    expect(existsSync(bare.abs(".claude"))).toBe(false);
  });

  it("prints JSON with --json and help with --help, and rejects unknown options", () => {
    const repo = baseRepo();
    startSession(repo);
    const r = prep(repo, "--json");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; session: string; bundle: string; bytes: number; counts: Record<string, number> };
    expect(out).toMatchObject({ ok: true, session: SESSION, bundle: `.claude/hermod/.local/reflect/${SESSION}.md` });
    expect(out.bytes).toBe(Buffer.byteLength(bundleOf(repo)));
    expect(prep(repo, "--help").stdout).toContain("Usage: node .claude/hermod/reflect-prep.mjs");
    expect(prep(repo, "--bogus").code).toBe(1);
  });

  it("never changes lessons, skills, checks or settings", () => {
    const repo = baseRepo();
    startSession(repo);
    tool(repo, skill("reflect"));
    const r = prep(repo, "--write-usage");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("No session summary written: no remote default branch");
    // Nothing appears in git status: .local/ is ignored, and without the opt-in no summary is written.
    const status = () => repo.git("status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean);
    expect(status()).toEqual([]);
    optIn(repo);
    expect(prep(repo, "--write-usage").code).toBe(0);
    // Opted in: only the session summary appears.
    expect(status().map((l) => l.slice(3))).toEqual([expect.stringMatching(/^\.claude\/hermod\/state\/sessions\/\d{4}-\d{2}-\d{2}-0f3c2a1b\.json$/)]);
  });
});

describe("reflect-prep: hostile input", () => {
  it("redacts secrets in commit subjects and the session id, and keeps the file name inside reflect/", () => {
    const repo = baseRepo();
    const id = "../../evil id";
    startSession(repo, id);
    const secret = "glpat-" + "Zx9Qw3Er7Ty1Ui5Op2As8";
    repo.commit({ files: { "src/app.ts": "export const a = 3;\n" }, message: `use token ${secret} for now` });
    const r = prep(repo, "--session", id);
    expect(r.code, r.stderr).toBe(0);
    const dir = repo.abs(".claude/hermod/.local/reflect");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[A-Za-z0-9._-]+\.md$/);
    expect(files[0]).not.toContain("..");
    const b = readFileSync(path.join(dir, files[0] ?? ""), "utf8");
    expect(b).toContain("use token [REDACTED:gitlab-token] for now");
    expect(b).not.toContain(secret);
    expect(existsSync(path.join(repo.root, "..", "..", "evil id.md"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses a sessions folder that is a symlink out of the repository", () => {
    const repo = baseRepo();
    startSession(repo);
    tool(repo, skill("reflect"));
    optIn(repo);
    const outside = tempDir("hermod-outside-");
    symlinkSync(outside, repo.abs(".claude/hermod/state/sessions"));
    const r = prep(repo, "--write-usage");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/No session summary written: .*leads outside the repository/);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("reflect-prep: size", () => {
  it("keeps the bundle under 40 KB with a huge ledger, transcript and lessons, and keeps the footer", () => {
    const repo = baseRepo();
    const transcript = writeTranscript(Array.from({ length: 500 }, (_, i) => user(`message ${i} ${"wörd ".repeat(200)}`)));
    startSession(repo, SESSION, transcript);
    // A huge ledger written directly (thousands of hook runs would be slow): failures with big outputs, resolutions.
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) {
      lines.push(
        JSON.stringify({ id: `f${i}`, ts: "2026-11-05T10:00:00.000Z", session: SESSION, type: "fail", key: `npm run t${i}`, cmd: `npm run t${i} ${"x".repeat(480)}`, exit: 1, out: "ä€😀 ".repeat(500) }),
        JSON.stringify({ id: `r${i}`, ts: "2026-11-05T10:00:01.000Z", session: SESSION, type: "resolved", failureId: `f${i}`, key: `npm run t${i}`, cmd: `npm run t${i}`, changedFiles: Array.from({ length: 50 }, (_, k) => `src/very/long/path/to/file-${k}.ts`) }),
        JSON.stringify({ id: `s${i}`, ts: "2026-11-05T10:00:02.000Z", session: SESSION, type: "skill", skill: `skill-${i % 40}` }),
      );
    }
    mkdirSync(repo.abs(".claude/hermod/.local"), { recursive: true });
    writeFileSync(repo.abs(".claude/hermod/.local/ledger.jsonl"), `${lines.join("\n")}\n`);
    const entries = Array.from({ length: 300 }, (_, i) => `Fact ${i} about the build, with many words to take room ${"ö".repeat(30)}.`);
    repo.write(".claude/hermod/LESSONS.md", `# Lessons\n<!-- hermod:lessons -->\n\n${entries.join("\n§\n")}\n`);
    for (let i = 0; i < 80; i++) {
      repo.write(`.claude/skills/skill-${String(i).padStart(2, "0")}/SKILL.md`, `---\nname: skill-${String(i).padStart(2, "0")}\ndescription: Skill ${i} does a thing. More words.\n---\n\nBody.\n`);
    }
    for (let i = 0; i < 200; i++) repo.write(`src/gen/file-${i}.ts`, `export const v${i} = ${i};\n`);
    repo.commit({ message: "many files" });

    const r = prep(repo);
    expect(r.code, r.stderr).toBe(0);
    const b = bundleOf(repo);
    expect(Buffer.byteLength(b)).toBeLessThan(40000);
    expect(b.trimEnd().endsWith("Proposals only. A person merges; nothing is kept until then.")).toBe(true);
    for (const h of ["## 1. Session", "## 2.", "## 3. Ledger", "## 4. User messages", "## 5.", "## 6. Footer"]) expect(b).toContain(h);
    // The newest evidence survives the cuts.
    expect(b).toContain("f2999");
    expect(b).toContain("message 499");
  });
});

describe("reflect-prep: --write-usage", () => {
  it("counts uses and views of skills that exist, and ignores the others and other sessions", () => {
    const repo = baseRepo();
    startSession(repo);
    tool(repo, skill("reflect"));
    tool(repo, skill("reflect"));
    tool(repo, skill("curate"));
    tool(repo, skill("ghost-skill"));
    tool(repo, skill("plugin:thing"));
    tool(repo, { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: repo.abs(".claude/skills/reflect/SKILL.md") } });
    tool(repo, { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: repo.abs(".claude/skills/nothere/SKILL.md") } });
    tool(repo, skill("curate"), "another-session");

    optIn(repo);
    const r = prep(repo, "--write-usage");
    expect(r.code, r.stderr).toBe(0);
    const dir = repo.abs(".claude/hermod/state/sessions");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const name = files[0] ?? "";
    const startedAt = (JSON.parse(repo.read(`.claude/hermod/.local/sessions/${SESSION}/session-start.json`) ?? "{}") as { startedAt: string }).startedAt;
    expect(name).toBe(`${startedAt.slice(0, 10)}-0f3c2a1b.json`);
    const summary = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as unknown;
    expect(summary).toEqual({
      v: 1,
      session: SESSION,
      date: startedAt.slice(0, 10),
      branch: "main",
      skills: { curate: { uses: 1, views: 0 }, reflect: { uses: 2, views: 1 } },
      commands: [],
    });
    expect(r.stdout).toContain(`.claude/hermod/state/sessions/${name}`);
    expect(existsSync(repo.abs(".claude/hermod/usage"))).toBe(false);
  });

  it("writes no summary without --write-usage, and empty skills and commands when nothing was used", () => {
    const repo = baseRepo();
    startSession(repo);
    optIn(repo);
    expect(prep(repo).code).toBe(0);
    expect(existsSync(repo.abs(".claude/hermod/state/sessions"))).toBe(false);
    expect(prep(repo, "--write-usage").code).toBe(0);
    const [name] = readdirSync(repo.abs(".claude/hermod/state/sessions"));
    const s = JSON.parse(readFileSync(repo.abs(`.claude/hermod/state/sessions/${name}`), "utf8")) as { skills: unknown; commands: unknown };
    expect(s.skills).toEqual({});
    expect(s.commands).toEqual([]);
  });

  it("keeps a failed command only as its plain-word key: never its text or output", () => {
    const repo = baseRepo();
    startSession(repo);
    optIn(repo);
    const token = ["ghp", "d".repeat(36)].join("_");
    tool(repo, bashFail(`npm run build -- --token ${token} "my private note"`, `Error: build failed for Emil at emil@example.com ${token}`));
    tool(repo, bashFail("npm run build", "Error: still failing"));
    tool(repo, bashOk("npm run build"));
    tool(repo, bashFail('echo "dear diary" my plans', "nope"));
    const r = prep(repo, "--write-usage");
    expect(r.code, r.stderr).toBe(0);
    const [name] = readdirSync(repo.abs(".claude/hermod/state/sessions"));
    const text = readFileSync(repo.abs(`.claude/hermod/state/sessions/${name}`), "utf8");
    expect(JSON.parse(text).commands).toEqual([
      { key: "npm run build", exit: null, attempts: 2, resolved: true },
      { key: "echo …", exit: null, attempts: 1, resolved: false },
    ]);
    for (const leak of [token, "private note", "Emil", "emil@example.com", "diary", "plans", "Error"]) expect(text).not.toContain(leak);
  });

  it("writes nothing while the marker is only in the working tree, and says why", () => {
    const repo = baseRepo();
    startSession(repo);
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    repo.write(".claude/hermod/state/ALLOW_COMMIT", "private\n");
    const r = prep(repo, "--write-usage");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("is not on origin/main yet");
    expect(existsSync(repo.abs(".claude/hermod/state/sessions"))).toBe(false);
  });

  it("lists earlier sessions on this branch from their summaries, from any device", () => {
    const repo = baseRepo();
    startSession(repo);
    optIn(repo);
    const other = "1a2b3c4d-1111-4222-8333-444455556666";
    repo.write(
      ".claude/hermod/state/sessions/2026-11-01-1a2b3c4d.json",
      JSON.stringify({ v: 1, session: other, date: "2026-11-01", branch: "main", skills: { curate: { uses: 1, views: 0 } }, commands: [{ key: "npm run lint", exit: 1, attempts: 3, resolved: true }] }),
    );
    repo.write(
      ".claude/hermod/state/sessions/2026-11-02-2b3c4d5e.json",
      JSON.stringify({ v: 1, session: "2b3c4d5e-1111-4222-8333-444455556666", date: "2026-11-02", branch: "other", skills: {}, commands: [{ key: "npm test", exit: 1, attempts: 1, resolved: false }] }),
    );
    expect(prep(repo).code).toBe(0);
    const b = bundleOf(repo);
    expect(b).toContain("### Earlier sessions on this branch");
    expect(b).toContain("2026-11-01 1a2b3c4d: failed: `npm run lint` (exit 1, 3×, resolved); skills: curate");
    expect(b).not.toContain("npm test");
  });
});
