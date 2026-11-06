// Tests for kit/files/.claude/hermod/lib/paths.mjs: the one path-pattern matcher and repository-relative paths.
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, tempDir } from "./helpers.js";
import { loadLib, type KitModule } from "./kit-lib-tests-helpers.js";

let p: KitModule;
beforeAll(async () => {
  p = await loadLib("paths");
});
afterAll(cleanup);

describe("toPosix / normalizeRelPath", () => {
  it("converts Windows backslashes and collapses separators", () => {
    expect(p.toPosix("src\\lib\\a.ts")).toBe("src/lib/a.ts");
    expect(p.toPosix("./a//b///c")).toBe("a/b/c");
    expect(p.toPosix("\\\\server\\share")).toBe("//server/share");
    expect(p.normalizeRelPath("src\\x\\..\\y")).toBeNull();
    expect(p.normalizeRelPath(".\\docs\\.\\PROGRESS.md")).toBe("docs/PROGRESS.md");
    expect(p.normalizeRelPath("docs/")).toBe("docs");
  });

  it("refuses absolute, home, '..', empty and NUL paths", () => {
    for (const bad of ["/etc/passwd", "C:\\Windows", "c:/x", "\\\\server\\x", "~/x", "../x", "a/../../x", "a/..", "", ".", "./", "a\0b"]) {
      expect(p.normalizeRelPath(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(p.normalizeRelPath(5)).toBeNull();
    expect(p.normalizeRelPath(null)).toBeNull();
  });

  it("keeps names that only look odd", () => {
    expect(p.normalizeRelPath("..hidden/a")).toBe("..hidden/a");
    expect(p.normalizeRelPath("a/b..c")).toBe("a/b..c");
    expect(p.normalizeRelPath("dir with space/f i.md")).toBe("dir with space/f i.md");
  });
});

describe("matchPath", () => {
  it("treats a trailing / as a directory prefix", () => {
    expect(p.matchPath("src/", "src/a.ts")).toBe(true);
    expect(p.matchPath("src/", "src/x/y/z.ts")).toBe(true);
    expect(p.matchPath("src/", "src")).toBe(false);
    expect(p.matchPath("src/", "srcx/a.ts")).toBe(false);
    expect(p.matchPath("src/", "lib/src/a.ts")).toBe(false);
    expect(p.matchPath("packages/*/src/", "packages/app/src/a.ts")).toBe(true);
    expect(p.matchPath("packages/*/src/", "packages/app/lib/a.ts")).toBe(false);
  });

  it("matches exact paths exactly", () => {
    expect(p.matchPath("docs/PROGRESS.md", "docs/PROGRESS.md")).toBe(true);
    expect(p.matchPath("docs/PROGRESS.md", "docs/progress.md")).toBe(false);
    expect(p.matchPath("docs/PROGRESS.md", "x/docs/PROGRESS.md")).toBe(false);
    expect(p.matchPath("docs/PROGRESS.md", "docs/PROGRESS.md.bak")).toBe(false);
  });

  it("* and ? never cross a /", () => {
    expect(p.matchPath("*.md", "README.md")).toBe(true);
    expect(p.matchPath("*.md", "docs/README.md")).toBe(false);
    expect(p.matchPath("docs/*.md", "docs/a.md")).toBe(true);
    expect(p.matchPath("docs/*.md", "docs/x/a.md")).toBe(false);
    expect(p.matchPath("a?c", "abc")).toBe(true);
    expect(p.matchPath("a?c", "a/c")).toBe(false);
    expect(p.matchPath("a?c", "ac")).toBe(false);
    expect(p.matchPath("*", ".env")).toBe(true);
  });

  it("** spans any number of folders, also none", () => {
    expect(p.matchPath("**/*.md", "README.md")).toBe(true);
    expect(p.matchPath("**/*.md", "docs/a/b/c.md")).toBe(true);
    expect(p.matchPath("**/*.md", "docs/a/b/c.mdx")).toBe(false);
    expect(p.matchPath("docs/**/*.md", "docs/a.md")).toBe(true);
    expect(p.matchPath("docs/**/*.md", "docs/x/y/a.md")).toBe(true);
    expect(p.matchPath("docs/**/*.md", "other/a.md")).toBe(false);
    expect(p.matchPath("docs/**", "docs/x/y")).toBe(true);
    expect(p.matchPath("**", "anything/at/all.txt")).toBe(true);
    expect(p.matchPath("a/**/**/b", "a/b")).toBe(true);
    expect(p.matchPath("**/.claude/**", "x/.claude/settings.json")).toBe(true);
  });

  it("treats regex and brace characters literally", () => {
    expect(p.matchPath("a.b", "axb")).toBe(false);
    expect(p.matchPath("a+(b)", "a+(b)")).toBe(true);
    expect(p.matchPath("[ab].md", "a.md")).toBe(false);
    expect(p.matchPath("[ab].md", "[ab].md")).toBe(true);
    expect(p.matchPath("{a,b}.md", "a.md")).toBe(false);
    expect(p.matchPath("$x^.md", "$x^.md")).toBe(true);
  });

  it("normalises Windows separators in both pattern and path", () => {
    expect(p.matchPath("src\\", "src\\lib\\a.ts")).toBe(true);
    expect(p.matchPath("docs\\**\\*.md", "docs/a/b.md")).toBe(true);
    expect(p.matchPath("src/", ".\\src\\a.ts")).toBe(true);
  });

  it("refuses absolute and '..' patterns: they never match", () => {
    for (const bad of ["/src/", "/etc/passwd", "../x/", "src/../../x", "C:\\src\\", "~/x", "", "  ", " src/", "./", "."]) {
      expect(p.patternError(bad), JSON.stringify(bad)).not.toBeNull();
      expect(p.matchPath(bad, "src/a.ts")).toBe(false);
      expect(p.matchPath(bad, "etc/passwd")).toBe(false);
      expect(p.matchPath(bad, "x/a")).toBe(false);
    }
    expect(p.patternError(5)).toContain("must be text");
    expect(p.patternError("src/")).toBeNull();
    expect(p.patternError("**")).toBeNull();
  });

  it("never matches a path that leaves the repository", () => {
    expect(p.matchPath("**", "../x")).toBe(false);
    expect(p.matchPath("**", "/abs/x")).toBe(false);
    expect(p.matchPath("**", "")).toBe(false);
  });

  it("matchAny and filterPaths", () => {
    expect(p.matchAny(["src/", "**/*.test.ts"], "test/a.test.ts")).toBe(true);
    expect(p.matchAny(["src/"], "lib/a.ts")).toBe(false);
    expect(p.matchAny([], "a")).toBe(false);
    expect(p.matchAny(null, "a")).toBe(false);
    expect(p.filterPaths(["src\\a.ts", "docs/b.md", "../c", "src/d.ts"], ["src/"])).toEqual(["src/a.ts", "src/d.ts"]);
  });

  it("compiles each pattern once (cache) and the cache stays bounded", () => {
    const f = p.compilePattern("cache-test/");
    expect(p.compilePattern("cache-test/")).toBe(f);
    for (let i = 0; i < 1200; i++) p.compilePattern(`dir${i}/`);
    expect(p.matchPath("dir5/", "dir5/a")).toBe(true);
  });
});

describe("relativeToRoot / resolveInside", () => {
  it("gives posix paths inside the root, null outside or at the root", () => {
    const root = tempDir();
    expect(p.relativeToRoot(root, path.join(root, "a", "b.md"))).toBe("a/b.md");
    expect(p.relativeToRoot(root, "a/b.md")).toBe("a/b.md");
    expect(p.relativeToRoot(root, path.join(root, "..", "x"))).toBeNull();
    expect(p.relativeToRoot(root, root)).toBeNull();
    expect(p.relativeToRoot(root, "")).toBeNull();
    expect(p.relativeToRoot(root, "a\0b")).toBeNull();
  });

  it("handles a symlinked root", () => {
    const base = tempDir();
    const real = path.join(base, "real");
    mkdirSync(path.join(real, "docs"), { recursive: true });
    const link = path.join(base, "link");
    symlinkSync(real, link, "dir");
    expect(p.relativeToRoot(link, path.join(real, "docs", "a.md"))).toBe("docs/a.md");
  });

  it("resolveInside refuses paths that leave the root", () => {
    const root = tempDir();
    expect(p.resolveInside(root, "a/b")).toBe(path.join(root, "a", "b"));
    expect(p.resolveInside(root, "a\\b")).toBe(path.join(root, "a", "b"));
    expect(p.resolveInside(root, "../x")).toBeNull();
    expect(p.resolveInside(root, "/etc")).toBeNull();
  });
});
