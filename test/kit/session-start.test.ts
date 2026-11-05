// End-to-end tests for the SessionStart hook (kit/files/.claude/hermod/hooks/session-start.mjs): spawned with
// node, JSON on stdin, in temporary git repositories with the kit copied in.
import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanup,
  hugeProgress,
  lessonsFile,
  makeRepo,
  runHook,
  runNode,
  skillFiles,
  splitCharacterProblems,
  tempDir,
  type Repo,
} from "./helpers.js";

afterAll(() => cleanup());

const TITLE = "# Session brief (Hermod, frozen at session start)";
const SESSIONS = ".claude/hermod/.local/sessions";

interface SessionState {
  sessionId: string;
  startedAt: string;
  head: string | null;
  branch: string | null;
  transcriptPath: string | null;
  dirty: Record<string, string>;
}

function input(sessionId: string | undefined, source = "startup", extra: Record<string, unknown> = {}) {
  return {
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    transcript_path: "/tmp/transcripts/session.jsonl",
    hook_event_name: "SessionStart",
    source,
    ...extra,
  };
}

function readState(repo: Repo, id: string): SessionState {
  return JSON.parse(readFileSync(repo.abs(`${SESSIONS}/${id}/session-start.json`), "utf8")) as SessionState;
}

function sessionDirs(repo: Repo): string[] {
  try {
    return readdirSync(repo.abs(SESSIONS)).sort();
  } catch {
    return [];
  }
}

function errorsLog(repo: Repo): string {
  return repo.read(".claude/hermod/.local/errors.log") ?? "";
}

describe("SessionStart: first start", () => {
  it("prints the brief as plain text, saves it, and saves the session state once", () => {
    const repo = makeRepo({
      files: {
        "docs/PROGRESS.md": "# P\n## Status\nBuilding the thing.\n## Next step\nFinish it.\n",
        "src/a.ts": "export const a = 1;\n",
        "src/gone.ts": "export const g = 1;\n",
      },
    });
    repo.write("src/a.ts", "export const a = 2;\n");
    repo.write("notes.txt", "untracked\n");
    repo.remove("src/gone.ts");
    const head = repo.git("rev-parse", "HEAD");

    const r = runHook(repo, "session-start", input("sess-1"));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.startsWith(`${TITLE}\nrepo · branch main · ${head.slice(0, 7)} · 3 uncommitted · kit dev\n`)).toBe(true);
    expect(r.stdout).toContain("## Status and next step (from docs/PROGRESS.md)\n### Status\nBuilding the thing.\n### Next step\nFinish it.");
    expect(() => JSON.parse(r.stdout)).toThrow();
    expect(r.stdout.length).toBeLessThanOrEqual(8000);

    expect(repo.read(`${SESSIONS}/sess-1/brief.md`)).toBe(r.stdout);
    const state = readState(repo, "sess-1");
    expect(state.sessionId).toBe("sess-1");
    expect(state.head).toBe(head);
    expect(state.branch).toBe("main");
    expect(state.transcriptPath).toBe("/tmp/transcripts/session.jsonl");
    expect(Number.isNaN(Date.parse(state.startedAt))).toBe(false);
    expect(Object.keys(state.dirty).sort()).toEqual(["notes.txt", "src/a.ts", "src/gone.ts"]);
    expect(state.dirty["src/a.ts"]).toBe(repo.git("hash-object", "src/a.ts"));
    expect(state.dirty["notes.txt"]).toBe(repo.git("hash-object", "notes.txt"));
    expect(state.dirty["src/gone.ts"]).toBe("deleted");
    // .local is never committed.
    expect(repo.read(".claude/hermod/.local/.gitignore")).toBe("*\n");
    expect(repo.git("status", "--porcelain", "--", ".claude")).toBe("");
    expect(errorsLog(repo)).toBe("");
  });

  it("hashes at most 300 dirty files", () => {
    const repo = makeRepo();
    for (let i = 0; i < 350; i++) repo.write(`untracked/f${String(i).padStart(3, "0")}.txt`, `${i}\n`);
    const r = runHook(repo, "session-start", input("many"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(" · 350 uncommitted · ");
    const dirty = readState(repo, "many").dirty;
    expect(Object.keys(dirty)).toHaveLength(300);
    expect(dirty["untracked/f000.txt"]).toBe(repo.git("hash-object", "untracked/f000.txt"));
  });

  it("redacts secrets in what it prints and saves", () => {
    const token = `ghp_${"Zq9Xw8Vu7T".repeat(4).slice(0, 36)}`;
    const repo = makeRepo({ files: { "docs/PROGRESS.md": `## Status\nThe token is ${token} oops.\n` } });
    const r = runHook(repo, "session-start", input("secret", "startup", { transcript_path: `/tmp/x?token=${token}` }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[REDACTED:github-token]");
    expect(r.stdout).not.toContain(token);
    const dir = repo.abs(`${SESSIONS}/secret`);
    for (const f of readdirSync(dir)) expect(readFileSync(path.join(dir, f), "utf8")).not.toContain(token);
  });

  it("keeps a hostile session id inside the sessions folder", () => {
    const repo = makeRepo();
    const r = runHook(repo, "session-start", input("../../../escape"));
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith(TITLE)).toBe(true);
    const dirs = sessionDirs(repo);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).not.toContain("..");
    expect(repo.exists("escape")).toBe(false);
    expect(repo.exists(".claude/escape")).toBe(false);
    // The same hostile id finds its own brief again.
    repo.write("docs/PROGRESS.md", "## Status\nchanged\n");
    expect(runHook(repo, "session-start", input("../../../escape", "resume")).stdout).toBe(r.stdout);
  });

  it("uses the input cwd when CLAUDE_PROJECT_DIR is not set", () => {
    const repo = makeRepo({ name: "from-cwd" });
    const r = runNode(repo.kitPath("hooks/session-start.mjs"), {
      stdin: input("cwd-1", "startup", { cwd: repo.root }),
      cwd: tempDir(),
      env: { CLAUDE_PROJECT_DIR: undefined },
    });
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[1]).toMatch(/^from-cwd · branch main · /);
    expect(sessionDirs(repo)).toEqual(["cwd-1"]);
  });

  it("shows the kit version from VERSION.json next to the kit", () => {
    const repo = makeRepo({ files: { ".claude/hermod/VERSION.json": JSON.stringify({ kit: "0.9.1", ref: "v0.9.1" }) } });
    expect(runHook(repo, "session-start", input("v")).stdout.split("\n")[1]).toMatch(/ · kit 0\.9\.1$/);
  });
});

describe("SessionStart: frozen brief", () => {
  it("prints the saved brief byte for byte on resume, compact and clear, even after the files changed", () => {
    const repo = makeRepo({
      files: {
        "docs/PROGRESS.md": "## Status\nOriginal status. Läget är bra 🚀\n## Next step\nOriginal next.\n",
        ".claude/hermod/LESSONS.md": "# Lessons\n<!-- x -->\n\nOriginal lesson.\n",
      },
    });
    const first = runHook(repo, "session-start", input("frozen"));
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Original status. Läget är bra 🚀");
    const statePath = repo.abs(`${SESSIONS}/frozen/session-start.json`);
    const stateText = readFileSync(statePath, "utf8");
    const stateMtime = statSync(statePath).mtimeMs;

    repo.write("docs/PROGRESS.md", "## Status\nNEW STATUS\n## Next step\nNEW NEXT\n");
    repo.write(".claude/hermod/LESSONS.md", "# Lessons\n<!-- x -->\n\nNEW LESSON.\n");
    repo.write(".claude/skills/new-skill/SKILL.md", "---\nname: new-skill\ndescription: A new skill.\n---\nbody\n");
    repo.commit({ message: "move on" });
    repo.write("src/new-dirty.ts", "x\n");

    for (const source of ["resume", "compact", "clear", "startup"]) {
      const again = runHook(repo, "session-start", input("frozen", source));
      expect(again.code).toBe(0);
      expect(again.stdout).toBe(first.stdout);
    }
    // The session state was written once and never again.
    expect(readFileSync(statePath, "utf8")).toBe(stateText);
    expect(statSync(statePath).mtimeMs).toBe(stateMtime);

    // A new session gets a fresh brief.
    const fresh = runHook(repo, "session-start", input("other"));
    expect(fresh.stdout).toContain("NEW STATUS");
    expect(fresh.stdout).toContain("- NEW LESSON.");
    expect(fresh.stdout).toContain("- new-skill: A new skill.");
    expect(fresh.stdout).not.toContain("Original status");
    expect(readState(repo, "other").dirty).toHaveProperty(["src/new-dirty.ts"]);
    expect(readState(repo, "frozen").dirty).not.toHaveProperty(["src/new-dirty.ts"]);
  });

  it("keeps the first session state when only the brief file is lost", () => {
    const repo = makeRepo();
    runHook(repo, "session-start", input("lost"));
    const before = readFileSync(repo.abs(`${SESSIONS}/lost/session-start.json`), "utf8");
    repo.remove(`${SESSIONS}/lost/brief.md`);
    repo.write("later.txt", "x\n");
    const r = runHook(repo, "session-start", input("lost", "resume"));
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith(TITLE)).toBe(true);
    expect(readFileSync(repo.abs(`${SESSIONS}/lost/session-start.json`), "utf8")).toBe(before);
    expect(repo.read(`${SESSIONS}/lost/brief.md`)).toBe(r.stdout);
  });

  it("a damaged oversized stored brief is cut to the hard maximum", () => {
    const repo = makeRepo();
    runHook(repo, "session-start", input("big"));
    repo.write(`${SESSIONS}/big/brief.md`, `${TITLE}\n${"line of text\n".repeat(2000)}`);
    const r = runHook(repo, "session-start", input("big", "resume"));
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(9500);
    expect(r.stdout.startsWith(TITLE)).toBe(true);
  });
});

describe("SessionStart: pruning", () => {
  it("removes session folders older than 30 days and keeps newer ones and the current one", () => {
    const repo = makeRepo();
    runHook(repo, "session-start", input("current"));
    const day = 86_400_000;
    for (const [name, ageDays] of [
      ["old", 31],
      ["recent", 10],
    ] as const) {
      const dir = repo.abs(`${SESSIONS}/${name}`);
      mkdirSync(dir, { recursive: true });
      const f = path.join(dir, "brief.md");
      writeFileSync(f, "x");
      const t = new Date(Date.now() - ageDays * day);
      utimesSync(f, t, t);
      utimesSync(dir, t, t);
    }
    // The current session is old too, but it is in use.
    const cur = repo.abs(`${SESSIONS}/current`);
    const old = new Date(Date.now() - 40 * day);
    for (const f of readdirSync(cur)) utimesSync(path.join(cur, f), old, old);
    utimesSync(cur, old, old);

    const r = runHook(repo, "session-start", input("current", "resume"));
    expect(r.code).toBe(0);
    expect(sessionDirs(repo)).toEqual(["current", "recent"]);
  });
});

describe("SessionStart: hostile input never breaks a session", () => {
  const cases: Array<[string, string | undefined]> = [
    ["corrupted JSON", '{"session_id": "x", '],
    ["a JSON array", "[1, 2, 3]"],
    ["JSON null", "null"],
    ["a number", "42"],
    ["binary garbage", "\u0000ÿ�\u0001{{{"],
    ["no stdin", undefined],
    ["an empty object", "{}"],
    ["a non-string session id", JSON.stringify({ session_id: { evil: true }, source: "startup" })],
  ];
  for (const [label, stdin] of cases) {
    it(`${label}: exit 0, prints a fresh brief, saves no session`, () => {
      const repo = makeRepo();
      const r = runHook(repo, "session-start", stdin);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout.startsWith(`${TITLE}\nrepo · branch main · `)).toBe(true);
      expect(sessionDirs(repo)).toEqual([]);
    });
  }

  it("logs unreadable input to errors.log", () => {
    const repo = makeRepo();
    runHook(repo, "session-start", "{not json");
    expect(errorsLog(repo)).toMatch(/\[session-start\] .*not valid JSON/);
  });

  it("without git on PATH: exit 0, a brief, and a state with no head", () => {
    const repo = makeRepo();
    const r = runHook(repo, "session-start", input("nogit"), { env: { PATH: tempDir() } });
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[1]).toBe("repo · not a git repository · kit dev");
    const state = readState(repo, "nogit");
    expect(state.head).toBeNull();
    expect(state.dirty).toEqual({});
  });

  it("in a folder that is not a git repository", () => {
    const repo = makeRepo({ git: false });
    const r = runHook(repo, "session-start", input("plain"));
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[1]).toBe("repo · not a git repository · kit dev");
    expect(r.stdout).not.toContain("## Branches");
  });

  it("with a root that has no kit installed: prints a brief and writes nothing there", () => {
    const repo = makeRepo();
    const bare = tempDir();
    const r = runNode(repo.kitPath("hooks/session-start.mjs"), { stdin: input("elsewhere"), cwd: bare, env: { CLAUDE_PROJECT_DIR: bare } });
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith(TITLE)).toBe(true);
    expect(readdirSync(bare)).toEqual([]);
  });

  it("with an invalid config.json: uses the defaults and says so in one line", () => {
    const repo = makeRepo({ files: { ".claude/hermod/config.json": "{ this is not json" } });
    const r = runHook(repo, "session-start", input("badcfg"));
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[2]).toBe(".claude/hermod/config.json has 1 invalid value (defaults used); see validate.mjs.");
  });

  it("when .local cannot be written: still prints the brief and exits 0", () => {
    const repo = makeRepo();
    // A file where the .local folder should be makes every write fail.
    repo.write(".claude/hermod/.local", "not a folder");
    const r = runHook(repo, "session-start", input("ro"));
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith(TITLE)).toBe(true);
  });
});

describe("SessionStart: budget and speed on a big repository", () => {
  let repo: Repo;
  const setup = () => {
    if (repo) return repo;
    const files: Record<string, string> = {
      "docs/PROGRESS.md": hugeProgress(200_000),
      ".claude/hermod/LESSONS.md": lessonsFile(19_900),
      ...(skillFiles(80) as Record<string, string>),
    };
    for (let i = 0; i < 300; i++) files[`src/mod${Math.floor(i / 30)}/file${i}.ts`] = `export const v${i} = ${i};\n`;
    repo = makeRepo({ files });
    for (let i = 0; i < 50; i++) repo.git("branch", `topic/branch-${String(i).padStart(2, "0")}`);
    for (let i = 0; i < 20; i++) repo.write(`src/mod0/file${i}.ts`, `export const changed${i} = true;\n`);
    return repo;
  };

  for (const budget of [1000, 4000, 8000, 9500]) {
    it(`stays within ${budget} characters end to end`, () => {
      const r0 = setup();
      r0.write(
        ".claude/hermod/config.json",
        JSON.stringify({ brief: { budgetChars: budget, maxBranches: 50 }, lessons: { capChars: 20_000, maxEntryChars: 2000 } }),
      );
      const r = runHook(r0, "session-start", input(`budget-${budget}`));
      expect(r.code).toBe(0);
      expect(r.stdout.length).toBeLessThanOrEqual(budget);
      expect(r.stdout.startsWith(TITLE)).toBe(true);
      expect(r.stdout).toContain("## Tools\n");
      expect(splitCharacterProblems(r.stdout)).toEqual([]);
      expect(r0.read(`${SESSIONS}/budget-${budget}/brief.md`)).toBe(r.stdout);
    });
  }

  it("finishes in under 1.5 s with 300 files and 50 branches (start and resume)", () => {
    const r0 = setup();
    r0.remove(".claude/hermod/config.json");
    // Warm up the file system cache once, then measure.
    runHook(r0, "session-start", input("warm"));
    const start = runHook(r0, "session-start", input("speed"));
    expect(start.code).toBe(0);
    expect(start.durationMs).toBeLessThan(1500);
    expect(Object.keys(readState(r0, "speed").dirty)).toHaveLength(20);
    const resume = runHook(r0, "session-start", input("speed", "resume"));
    expect(resume.stdout).toBe(start.stdout);
    expect(resume.durationMs).toBeLessThan(1500);
  });
});
