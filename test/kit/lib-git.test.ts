// Tests for kit/files/.claude/hermod/lib/git.mjs in temporary repositories: every helper returns the right
// thing inside a repo and a safe value outside one.
import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanEnv, cleanup, makeRepo, tempDir } from "./helpers.js";
import { loadLib, type KitModule } from "./kit-lib-tests-helpers.js";

let git: KitModule;
beforeAll(async () => {
  git = await loadLib("git");
});
afterAll(cleanup);

const SHA = /^[0-9a-f]{40}$/;
/** What `git hash-object` says for a file. */
const hashOf = (root: string, rel: string) =>
  spawnSync("git", ["hash-object", "--no-filters", "--", rel], { cwd: root, encoding: "utf8", env: cleanEnv() }).stdout.trim();

describe("head, branch, revParse, isGitRepo, toplevel", () => {
  it("reads HEAD and the branch", () => {
    const repo = makeRepo({ kit: false, branch: "trunk", files: { "a.txt": "a" } });
    expect(git.isGitRepo(repo.root)).toBe(true);
    expect(git.head(repo.root)).toBe(repo.git("rev-parse", "HEAD"));
    expect(git.head(repo.root)).toMatch(SHA);
    expect(git.branch(repo.root)).toBe("trunk");
    expect(git.revParse(repo.root, "trunk")).toBe(git.head(repo.root));
    expect(git.revParse(repo.root, "no-such-ref")).toBeNull();
    expect(git.toplevel(repo.abs("."))).toBe(repo.root);
    expect(git.isShallow(repo.root)).toBe(false);
  });

  it("gives null for a detached HEAD branch and for a repo with no commits", () => {
    const repo = makeRepo({ kit: false, files: { "a.txt": "a" } });
    repo.git("checkout", "-q", "--detach");
    expect(git.branch(repo.root)).toBeNull();
    const empty = makeRepo({ kit: false, initialCommit: false });
    expect(git.head(empty.root)).toBeNull();
    expect(git.branch(empty.root)).toBe("main");
  });

  it("refuses refs that could be read as options", () => {
    const repo = makeRepo({ kit: false });
    for (const bad of ["--output=/tmp/x", "-n", "a b", "a\nb", "", "x".repeat(300), 5, null]) {
      expect(git.isSafeRef(bad), JSON.stringify(bad)).toBe(false);
      expect(git.revParse(repo.root, bad)).toBeNull();
      expect(git.mergeBase(repo.root, "HEAD", bad)).toBeNull();
    }
    expect(git.isSafeRef("origin/main")).toBe(true);
    expect(git.isSafeRef("HEAD~1")).toBe(true);
  });
});

describe("statusPorcelain / uncommittedFiles", () => {
  it("parses modified, staged, deleted, untracked, renames and names with spaces and unicode", () => {
    const repo = makeRepo({
      kit: false,
      files: { "keep.txt": "k", "mod.txt": "m", "gone.txt": "g", "old name.txt": "rename me\n".repeat(20), "staged.txt": "s" },
    });
    repo.write("mod.txt", "changed");
    repo.remove("gone.txt");
    repo.git("mv", "old name.txt", "new name.txt");
    repo.write("staged.txt", "s2");
    repo.git("add", "staged.txt");
    repo.write("dir with space/ny fil ä.txt", "u");
    repo.write("tab\tname.txt", "t");

    const status = git.statusPorcelain(repo.root);
    const byPath = Object.fromEntries(status.map((e: KitModule) => [e.path, e]));
    expect(byPath["mod.txt"]).toMatchObject({ index: " ", worktree: "M", origPath: null });
    expect(byPath["gone.txt"]).toMatchObject({ worktree: "D" });
    expect(byPath["new name.txt"]).toMatchObject({ index: "R", origPath: "old name.txt" });
    expect(byPath["staged.txt"]).toMatchObject({ index: "M" });
    expect(byPath["dir with space/ny fil ä.txt"]).toMatchObject({ index: "?", worktree: "?" });
    expect(byPath["tab\tname.txt"]).toBeDefined();
    expect(byPath["keep.txt"]).toBeUndefined();

    expect(git.uncommittedFiles(repo.root)).toEqual(
      ["dir with space/ny fil ä.txt", "gone.txt", "mod.txt", "new name.txt", "old name.txt", "staged.txt", "tab\tname.txt"].sort(),
    );
    expect(git.statusPorcelain(repo.root, { untracked: false }).some((e: KitModule) => e.index === "?")).toBe(false);
  });

  it("gives paths relative to a root that is a subfolder, leaving out files outside it", () => {
    const repo = makeRepo({ kit: false, files: { "pkg/app/a.ts": "a", "other/b.ts": "b" } });
    repo.write("pkg/app/a.ts", "a2");
    repo.write("other/b.ts", "b2");
    repo.write("pkg/app/new.ts", "n");
    expect(git.repoPrefix(repo.abs("pkg/app"))).toBe("pkg/app/");
    expect(git.uncommittedFiles(repo.abs("pkg/app"))).toEqual(["a.ts", "new.ts"]);
    expect(git.changedFilesSince(repo.abs("pkg/app"), "HEAD")).toEqual(["a.ts", "new.ts"]);
  });
});

describe("changedFilesSince", () => {
  it("includes committed, staged, unstaged and untracked changes since the base, and deletions", () => {
    const repo = makeRepo({ kit: false, files: { "base.txt": "b", "committed.txt": "c", "staged.txt": "s", "unstaged.txt": "u", "del.txt": "d" } });
    const base = git.head(repo.root);
    repo.commit({ files: { "committed.txt": "c2", "added-in-commit.txt": "n" } });
    repo.write("staged.txt", "s2");
    repo.git("add", "staged.txt");
    repo.write("unstaged.txt", "u2");
    repo.write("untracked/new file.txt", "x");
    repo.remove("del.txt");
    expect(git.changedFilesSince(repo.root, base)).toEqual(
      ["added-in-commit.txt", "committed.txt", "del.txt", "staged.txt", "unstaged.txt", "untracked/new file.txt"].sort(),
    );
    expect(git.changedFilesSince(repo.root, "HEAD")).toEqual(["del.txt", "staged.txt", "unstaged.txt", "untracked/new file.txt"]);
  });

  it("leaves out ignored files and counts a rename as both paths", () => {
    const repo = makeRepo({ kit: false, files: { ".gitignore": "*.log\n", "a.txt": "same content\n".repeat(10) } });
    const base = git.head(repo.root);
    repo.write("debug.log", "x");
    repo.git("mv", "a.txt", "b.txt");
    expect(git.changedFilesSince(repo.root, base)).toEqual(["a.txt", "b.txt"]);
  });

  it("falls back to uncommitted files without a usable base", () => {
    const repo = makeRepo({ kit: false, files: { "a.txt": "a" } });
    repo.commit({ files: { "b.txt": "b" } });
    repo.write("c.txt", "c");
    expect(git.changedFilesSince(repo.root, null)).toEqual(["c.txt"]);
    expect(git.changedFilesSince(repo.root, "0".repeat(40))).toEqual(["c.txt"]);
    expect(git.changedFilesSince(repo.root, "--bad")).toEqual(["c.txt"]);
  });
});

describe("mergeBase / defaultBranchRef", () => {
  it("finds the merge base with the default branch", () => {
    const repo = makeRepo({ kit: false, files: { "a.txt": "a" } });
    const fork = git.head(repo.root);
    repo.commit({ files: { "main.txt": "m" } });
    repo.git("checkout", "-q", "-b", "feature", fork);
    repo.commit({ files: { "f.txt": "f" } });
    expect(git.defaultBranchRef(repo.root)).toBe("main");
    expect(git.mergeBase(repo.root, "HEAD", "main")).toBe(fork);
    expect(git.changedFilesSince(repo.root, git.mergeBase(repo.root, "HEAD", "main"))).toEqual(["f.txt"]);
  });

  it("prefers origin/HEAD's target, then origin/main", () => {
    const repo = makeRepo({ kit: false, files: { "a.txt": "a" } });
    const sha = git.head(repo.root);
    repo.git("update-ref", "refs/remotes/origin/develop", sha);
    repo.git("update-ref", "refs/remotes/origin/main", sha);
    expect(git.defaultBranchRef(repo.root)).toBe("origin/main");
    repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    expect(git.defaultBranchRef(repo.root)).toBe("origin/develop");
  });

  it("gives null when there is no default branch", () => {
    const repo = makeRepo({ kit: false, branch: "work", files: { "a.txt": "a" } });
    expect(git.defaultBranchRef(repo.root)).toBeNull();
  });
});

describe("hashFiles / blobHash / snapshotDirty", () => {
  it("matches git hash-object, marks deleted files, and skips folders", () => {
    const repo = makeRepo({ kit: false, files: { "a.txt": "hello\n", "dir/b.txt": "b", "crlf.txt": "x\r\ny\r\n" } });
    const r = git.hashFiles(repo.root, ["a.txt", "dir/b.txt", "missing.txt", "dir", "crlf.txt", "../outside", "a.txt"]);
    expect(r["a.txt"]).toBe(hashOf(repo.root, "a.txt"));
    expect(r["a.txt"]).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(r["dir/b.txt"]).toBe(hashOf(repo.root, "dir/b.txt"));
    expect(r["crlf.txt"]).toBe(hashOf(repo.root, "crlf.txt"));
    expect(r["missing.txt"]).toBe("deleted");
    expect(r).not.toHaveProperty("dir");
    expect(r).not.toHaveProperty("../outside");
    expect(git.blobHash(repo.root, "a.txt")).toBe(r["a.txt"]);
    expect(git.blobHash(repo.root, "nope")).toBe("deleted");
    expect(git.blobHash(repo.root, "/etc/passwd")).toBeNull();
  });

  it("hashes a symlink as git does (the link text)", () => {
    const repo = makeRepo({ kit: false, files: { "target.txt": "t" } });
    symlinkSync("target.txt", repo.abs("link"));
    repo.git("add", "link");
    const staged = repo.git("ls-files", "-s", "link").split(/\s+/)[1];
    expect(git.hashFiles(repo.root, ["link"]).link).toBe(staged);
  });

  it("hashes names with newlines one by one", () => {
    const repo = makeRepo({ kit: false });
    repo.write("odd\nname.txt", "x");
    repo.write("plain.txt", "x");
    const r = git.hashFiles(repo.root, ["odd\nname.txt", "plain.txt"]);
    expect(r["odd\nname.txt"]).toBe(r["plain.txt"]);
    expect(r["plain.txt"]).toMatch(SHA);
  });

  it("snapshotDirty caps the number of hashed files and says so", () => {
    const repo = makeRepo({ kit: false });
    for (let i = 0; i < 12; i++) repo.write(`f${String(i).padStart(2, "0")}.txt`, String(i));
    const s = git.snapshotDirty(repo.root, { max: 5 });
    expect(s.total).toBe(12);
    expect(s.truncated).toBe(true);
    expect(Object.keys(s.files)).toEqual(["f00.txt", "f01.txt", "f02.txt", "f03.txt", "f04.txt"]);
    expect(git.snapshotDirty(repo.root).truncated).toBe(false);
  });
});

describe("recentBranches / relativeAge", () => {
  it("lists branches newest first, without origin/HEAD, at most limit", () => {
    const repo = makeRepo({ kit: false, files: { "a.txt": "a" } });
    repo.git("checkout", "-q", "-b", "old");
    repo.commit({ files: { "o.txt": "o" }, date: "2020-01-01T00:00:00Z" });
    repo.git("checkout", "-q", "-b", "newer");
    repo.commit({ files: { "n.txt": "n" }, date: "2030-01-01T00:00:00Z" });
    repo.git("update-ref", "refs/remotes/origin/feature", repo.git("rev-parse", "HEAD"));
    repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature");
    const list = git.recentBranches(repo.root, 10, { now: Date.parse("2030-01-04T00:00:00Z") });
    const names = list.map((b: KitModule) => b.name);
    expect(names).not.toContain("origin/HEAD");
    expect(names.slice(0, 2).sort()).toEqual(["newer", "origin/feature"]);
    expect(names[names.length - 1]).toBe("old");
    expect(list[0].age).toBe("3 days ago");
    expect(list[0].sha).toMatch(SHA);
    expect(git.recentBranches(repo.root, 2)).toHaveLength(2);
    expect(git.recentBranches(repo.root, 0)).toEqual([]);
    expect(git.recentBranches(repo.root, Number.NaN)).toEqual([]);
  });

  it("relativeAge words", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(git.relativeAge(now - 10_000, now)).toBe("just now");
    expect(git.relativeAge(now - 60_000, now)).toBe("1 minute ago");
    expect(git.relativeAge(now - 5 * 3600_000, now)).toBe("5 hours ago");
    expect(git.relativeAge(now - 20 * 86400_000, now)).toBe("2 weeks ago");
    expect(git.relativeAge(now - 90 * 86400_000, now)).toBe("3 months ago");
    expect(git.relativeAge(now - 800 * 86400_000, now)).toBe("2 years ago");
    expect(git.relativeAge(now + 10_000, now)).toBe("just now");
  });
});

describe("logMessages / showFile / diffFile / lastCommitDate / countCommits", () => {
  it("reads commit messages (newest first, no merges), files at a ref and diffs", () => {
    const repo = makeRepo({ kit: false, files: { "a.txt": "one\n" } });
    const first = git.head(repo.root);
    spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "Second subject\n\nBody line\nwith \x1f odd char"], {
      cwd: repo.root,
      env: cleanEnv(),
    });
    repo.commit({ files: { "a.txt": "two\n" }, message: "Third", date: "2026-03-04T10:00:00Z" });
    const log = git.logMessages(repo.root);
    expect(log.map((c: KitModule) => c.subject)).toEqual(["Third", "Second subject", "initial"]);
    expect(log[1].body).toContain("Body line");
    expect(log[0].date).toBe("2026-03-04");
    expect(git.logMessages(repo.root, { max: 1 })).toHaveLength(1);

    expect(git.showFile(repo.root, first, "a.txt")).toBe("one\n");
    expect(git.showFile(repo.root, first, "missing.txt")).toBeNull();
    expect(git.showFile(repo.root, "--bad", "a.txt")).toBeNull();

    repo.write("a.txt", "three\n");
    expect(git.diffFile(repo.root, first, "a.txt")).toContain("-one\n+three");
    repo.write("new.txt", "fresh\n");
    expect(git.diffFile(repo.root, first, "new.txt")).toContain("+fresh");
    expect(git.diffFile(repo.root, first, "../x")).toBe("");
    expect(git.lastCommitDate(repo.root, "a.txt")).toBe("2026-03-04");
    expect(git.countCommits(repo.root, "a.txt")).toBe(2);
    expect(git.countCommits(repo.root, "nope.txt")).toBe(0);
  });
});

describe("outside a repository", () => {
  it("every helper returns a safe value and never throws", () => {
    const dir = tempDir();
    const missing = `${dir}/does-not-exist`;
    for (const root of [dir, missing, ""]) {
      expect(git.isGitRepo(root)).toBe(false);
      expect(git.toplevel(root)).toBeNull();
      expect(git.repoPrefix(root)).toBeNull();
      expect(git.head(root)).toBeNull();
      expect(git.branch(root)).toBeNull();
      expect(git.isShallow(root)).toBe(false);
      expect(git.statusPorcelain(root)).toEqual([]);
      expect(git.uncommittedFiles(root)).toEqual([]);
      expect(git.changedFilesSince(root, "HEAD")).toEqual([]);
      expect(git.mergeBase(root, "HEAD", "main")).toBeNull();
      expect(git.defaultBranchRef(root)).toBeNull();
      expect(git.recentBranches(root)).toEqual([]);
      expect(git.logMessages(root)).toEqual([]);
      expect(git.diffFile(root, "HEAD", "a")).toBe("");
      expect(git.showFile(root, "HEAD", "a")).toBeNull();
      expect(git.lastCommitDate(root, "a")).toBeNull();
      expect(git.countCommits(root, "a")).toBe(0);
      expect(git.snapshotDirty(root)).toEqual({ files: {}, total: 0, truncated: false });
      const r = git.runGit(root, ["status"]);
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe("string");
    }
  });

  it("runGit refuses bad arguments instead of running git", () => {
    const dir = tempDir();
    expect(git.runGit(dir, []).ok).toBe(false);
    expect(git.runGit(dir, ["status", "a\0b"]).error).toContain("must be text");
    expect(git.runGitBuffer(dir, ["--version"]).stdout).toBeInstanceOf(Buffer);
    expect(git.GIT_TIMEOUT_MS).toBe(3000);
  });
});
