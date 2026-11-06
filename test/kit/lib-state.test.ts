// Tests for kit/files/.claude/hermod/lib/state.mjs (session folders, write-once session start, pruning), and
// end to end: more than 300 files dirty at session start must not make the Stop hook block (dirtyPaths).
import { existsSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, makeRepo, runHook, tempDir } from "./helpers.js";
import { loadLib, type KitModule } from "./kit-lib-tests-helpers.js";

let st: KitModule;
beforeAll(async () => {
  st = await loadLib("state");
});
afterAll(cleanup);

const DAY = 86_400_000;

describe("sanitizeSessionId", () => {
  it("keeps UUIDs and simple ids", () => {
    expect(st.sanitizeSessionId("3f2b8c1e-0000-4abc-9def-1234567890ab")).toBe("3f2b8c1e-0000-4abc-9def-1234567890ab");
    expect(st.sanitizeSessionId("abc_1.2")).toBe("abc_1.2");
  });

  it("turns anything else into a safe, distinct folder name", () => {
    const hostile = ["../../etc", "..", ".", "a/b", "a\\b", "con", "NUL.txt", "x".repeat(200), "ä", "a b", "a\0b", ".hidden", "trail."];
    const names = hostile.map((id) => st.sanitizeSessionId(id));
    for (const [i, n] of names.entries()) {
      expect(n, hostile[i]).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(n).not.toContain("..");
      expect(n.length).toBeLessThanOrEqual(64);
      expect(n.toLowerCase()).not.toMatch(/^(con|nul)$/);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(st.sanitizeSessionId("a/b")).not.toBe(st.sanitizeSessionId("a_b"));
    expect(st.sanitizeSessionId("")).toBe("unknown");
    expect(st.sanitizeSessionId(42)).toBe("unknown");
  });

  it("keeps every session folder inside .local/sessions", () => {
    const repo = makeRepo({ git: false });
    for (const id of ["../../escape", "/abs/path", "..\\..\\win"]) {
      const dir = st.ensureSessionDir(repo.root, id);
      expect(path.dirname(dir)).toBe(repo.abs(".claude/hermod/.local/sessions"));
    }
    expect(existsSync(path.join(repo.root, "..", "escape"))).toBe(false);
  });
});

describe("session files", () => {
  it("writes the session start once (resume keeps the original baseline)", () => {
    const repo = makeRepo({ git: false });
    const first = { sessionId: "s1", startedAt: "2026-01-01T00:00:00.000Z", head: "a".repeat(40), branch: "main", transcriptPath: null, dirty: { "a.txt": "b".repeat(40) } };
    expect(st.writeSessionStart(repo.root, "s1", first)).toBe(true);
    expect(st.writeSessionStart(repo.root, "s1", { ...first, head: "c".repeat(40) })).toBe(false);
    expect(st.readSessionStart(repo.root, "s1").head).toBe("a".repeat(40));
    expect(st.writeSessionStart(repo.root, "s1", { ...first, head: "c".repeat(40) }, { overwrite: true })).toBe(true);
    expect(st.readSessionStart(repo.root, "s1").head).toBe("c".repeat(40));
  });

  it("reads back dirtyPaths, dirtyTruncated and dirtyTotal, caps dirtyPaths at 5,000, and reads old state", () => {
    const repo = makeRepo({ git: false });
    const paths = Array.from({ length: 6000 }, (_, i) => `f${i}.txt`);
    st.writeSessionStart(repo.root, "big", { sessionId: "big", startedAt: "", head: null, branch: null, transcriptPath: null, dirty: { "f0.txt": "deleted" }, dirtyPaths: paths, dirtyTruncated: true, dirtyTotal: 6000 });
    const raw = JSON.parse(readFileSync(path.join(st.sessionDir(repo.root, "big"), "session-start.json"), "utf8"));
    expect(raw.dirtyPaths).toHaveLength(st.MAX_DIRTY_PATHS);
    expect(st.MAX_DIRTY_PATHS).toBe(5000);
    expect(st.MAX_DIRTY_HASHES).toBe(300);
    const back = st.readSessionStart(repo.root, "big");
    expect(back.dirtyTruncated).toBe(true);
    expect(back.dirtyTotal).toBe(6000);
    expect(back.dirtyPaths).toHaveLength(5000);
    expect(back.dirty).toEqual({ "f0.txt": "deleted" });

    // State saved before dirtyPaths existed: the hashed paths are the dirty paths.
    const dir = st.ensureSessionDir(repo.root, "old");
    writeFileSync(path.join(dir, "session-start.json"), JSON.stringify({ sessionId: "old", head: "", dirty: { "x.txt": "deleted", bad: 3 } }));
    const old = st.readSessionStart(repo.root, "old");
    expect(old).toMatchObject({ head: null, dirty: { "x.txt": "deleted" }, dirtyPaths: ["x.txt"], dirtyTruncated: false, dirtyTotal: 1 });
  });

  it("redacts what it writes (values, not keys)", () => {
    const repo = makeRepo({ git: false });
    const secret = ["sk", "ant", "api03", "Ab1".repeat(12)].join("-");
    st.writeSessionStart(repo.root, "r", { sessionId: "r", startedAt: "", head: null, branch: null, transcriptPath: `/tmp/${secret}`, dirty: {} });
    const text = readFileSync(path.join(st.sessionDir(repo.root, "r"), "session-start.json"), "utf8");
    expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED:anthropic-key]");
    const saved = st.writeBrief(repo.root, "r", `brief with ${secret}`);
    expect(saved).not.toContain(secret);
    expect(st.readBrief(repo.root, "r")).toBe(saved);
  });

  it("returns null or empty state for missing and corrupt files", () => {
    const repo = makeRepo({ git: false });
    expect(st.readSessionStart(repo.root, "none")).toBeNull();
    expect(st.readBrief(repo.root, "none")).toBeNull();
    expect(st.readStopState(repo.root, "none")).toEqual({ fingerprints: [], keys: [], blocks: 0, lastBlockAt: null });
    const dir = st.ensureSessionDir(repo.root, "bad");
    writeFileSync(path.join(dir, "session-start.json"), "{not json");
    writeFileSync(path.join(dir, "stop.json"), JSON.stringify({ fingerprints: ["a", 1], blocks: -3 }));
    expect(st.readSessionStart(repo.root, "bad")).toBeNull();
    expect(st.readStopState(repo.root, "bad")).toEqual({ fingerprints: ["a"], keys: [], blocks: 0, lastBlockAt: null });
  });

  it("stop state dedupes fingerprints", () => {
    const repo = makeRepo({ git: false });
    st.writeStopState(repo.root, "s", { fingerprints: ["x", "x", "y"], blocks: 2, lastBlockAt: "t" });
    expect(st.readStopState(repo.root, "s")).toEqual({ fingerprints: ["x", "y"], keys: [], blocks: 2, lastBlockAt: "t" });
    st.writeStopState(repo.root, "k", { fingerprints: ["x"], keys: ["missing:b", "check:a", "check:a"], blocks: 1, lastBlockAt: "t" });
    expect(st.readStopState(repo.root, "k").keys).toEqual(["check:a", "missing:b"]);
  });

  it("refuses session file names that could leave the folder", () => {
    const repo = makeRepo({ git: false });
    for (const bad of ["../x", "a/b", "", ".hidden", "a..b"]) {
      expect(() => st.writeSessionFile(repo.root, "s", bad, "x"), bad).toThrow(/invalid session file name/);
      expect(() => st.readSessionFile(repo.root, "s", bad), bad).toThrow(/invalid session file name/);
    }
  });
});

describe("pruneOldSessions", () => {
  it("removes folders older than N days, keeps newer ones and the current session, and never follows symlinks", () => {
    const repo = makeRepo({ git: false });
    const now = Date.now();
    const age = (id: string, days: number) => {
      const dir = st.ensureSessionDir(repo.root, id);
      writeFileSync(path.join(dir, "brief.md"), "x");
      const t = new Date(now - days * DAY);
      utimesSync(path.join(dir, "brief.md"), t, t);
      utimesSync(dir, t, t);
      return dir;
    };
    age("old", 40);
    age("new", 2);
    age("current", 90);
    const outside = tempDir();
    writeFileSync(path.join(outside, "precious.txt"), "keep me");
    const link = path.join(st.sessionsDir(repo.root), "link");
    symlinkSync(outside, link, "dir");
    const t = new Date(now - 60 * DAY);
    utimesSync(outside, t, t);
    // lutimes is not in all node typings; the link's own mtime does not matter: a symlink is never followed.
    const removed = st.pruneOldSessions(repo.root, 30, { now, keep: ["current"] });
    expect(removed).toContain("old");
    expect(removed).not.toContain("new");
    expect(removed).not.toContain("current");
    expect(existsSync(path.join(outside, "precious.txt"))).toBe(true);
    expect(readdirSync(st.sessionsDir(repo.root))).toEqual(expect.arrayContaining(["new", "current"]));
  });

  it("keeps a folder whose files are recent even if the folder itself is old", () => {
    const repo = makeRepo({ git: false });
    const dir = st.ensureSessionDir(repo.root, "busy");
    writeFileSync(path.join(dir, "stop.json"), "{}");
    const t = new Date(Date.now() - 50 * DAY);
    utimesSync(dir, t, t);
    expect(st.pruneOldSessions(repo.root, 30)).toEqual([]);
  });

  it("never throws when there is nothing to prune", () => {
    expect(st.pruneOldSessions(tempDir(), 30)).toEqual([]);
  });
});

describe("Stop hook with more than 300 files dirty at session start (end to end)", () => {
  const SESSION = "sess-many-dirty";
  const N = 320;
  const name = (i: number) => `src/gen/f${String(i).padStart(3, "0")}.ts`;

  function repoWithManyDirtyFiles() {
    const files: Record<string, string> = { "docs/PROGRESS.md": "# Progress\n\n## Status\n\nok\n" };
    for (let i = 0; i < N; i++) files[name(i)] = `export const v${i} = ${i};\n`;
    const repo = makeRepo({ files });
    for (let i = 0; i < N; i++) repo.write(name(i), `export const v${i} = ${i + 1000};\n`);
    return repo;
  }

  it("records dirtyTruncated and every dirty path, and does not block for files that were only dirty before", () => {
    const repo = repoWithManyDirtyFiles();
    const start = runHook(repo, "session-start", { session_id: SESSION, source: "startup", hook_event_name: "SessionStart" });
    expect(start.code).toBe(0);
    const state = JSON.parse(repo.read(`.claude/hermod/.local/sessions/${SESSION}/session-start.json`) ?? "{}");
    expect(Object.keys(state.dirty)).toHaveLength(300);
    expect(state.dirtyTruncated).toBe(true);
    expect(state.dirtyTotal).toBe(N);
    expect(state.dirtyPaths).toHaveLength(N);
    expect(state.dirtyPaths).toContain(name(N - 1));
    expect(state.dirty).not.toHaveProperty(name(N - 1));

    // Nothing changed during the session: no block (before the fix, the 20 unhashed files counted as changed).
    const stop = runHook(repo, "stop", { session_id: SESSION, hook_event_name: "Stop", stop_hook_active: false });
    expect(stop.code).toBe(0);
    expect(stop.stdout).toBe("");
    expect(repo.exists(`.claude/hermod/.local/sessions/${SESSION}/stop.json`)).toBe(false);
  });

  it("still blocks for a code file that is new this session", () => {
    const repo = repoWithManyDirtyFiles();
    runHook(repo, "session-start", { session_id: SESSION, source: "startup" });
    repo.write("src/brand-new.ts", "export const x = 1;\n");
    const stop = runHook(repo, "stop", { session_id: SESSION, hook_event_name: "Stop" });
    expect(stop.code).toBe(0);
    const out = JSON.parse(stop.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("src/brand-new.ts");
    expect(out.reason).not.toContain(name(N - 1));
  });

  it("still blocks for a hashed dirty file that changed further during the session", () => {
    const repo = repoWithManyDirtyFiles();
    runHook(repo, "session-start", { session_id: SESSION, source: "startup" });
    repo.write(name(0), "export const v0 = 'changed during the session';\n");
    const out = JSON.parse(runHook(repo, "stop", { session_id: SESSION, hook_event_name: "Stop" }).stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain(name(0));
  });
});
