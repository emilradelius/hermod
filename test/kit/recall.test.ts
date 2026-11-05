// End-to-end tests for recall (kit/files/.claude/hermod/recall.mjs): spawns the CLI in temporary git repositories
// with the real kit files, plus a few direct tests of its exported helpers.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KIT_FILES, cleanup, makeRepo, runNode, tempDir, type CommitSpec, type Files, type Repo } from "./helpers.js";

interface Chunk {
  startLine: number;
  endLine: number;
  text: string;
  headingPath: string[];
}
interface RecallModule {
  USAGE: string;
  isExcluded(rel: string): boolean;
  sourceKind(rel: string): string;
  findSourceFiles(root: string, patterns: string[], options?: { maxFiles?: number }): { files: string[]; truncated: boolean };
  chunkLineAt(chunk: Chunk, fileLines: string[], offset: number): number;
}
interface JsonHit {
  kind: "file" | "git";
  path?: string;
  line?: number;
  startLine?: number;
  heading?: string[];
  sha?: string;
  shortSha?: string;
  date?: string;
  subject?: string;
  score: number;
  snippet: string;
}
interface JsonResult {
  query: string;
  source: string;
  results: JsonHit[];
  total: number;
  searched: { files: number; chunks: number; commits: number };
  terms: { term: string; match: string; terms: string[] }[];
  notes: string[];
}

let R: RecallModule;
beforeAll(async () => {
  R = (await import(pathToFileURL(path.join(KIT_FILES, ".claude", "hermod", "recall.mjs")).href)) as RecallModule;
});
afterAll(() => cleanup());

function recall(repo: Repo, ...args: string[]) {
  return runNode(repo.kitPath("recall.mjs"), { cwd: repo.root, args, env: { CLAUDE_PROJECT_DIR: repo.root } });
}

function recallJson(repo: Repo, ...args: string[]): JsonResult {
  const r = recall(repo, ...args, "--json");
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as JsonResult;
}

/** The "path:line" / "git sha date" header lines of plain output, without scores. */
function heads(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((l) => /^\S.* {2}\(\d+\.\d\d\)$/.test(l))
    .map((l) => l.replace(/ {2}\(\d+\.\d\d\)$/, ""));
}

const PROGRESS = [
  "# Progress",
  "",
  "## Status",
  "",
  "The booking form works. We still have to rätta the price rounding.",
  "",
  "## Next step",
  "",
  "Wire the export page.",
  "",
].join("\n");

const DECISIONS = [
  "# Decisions",
  "",
  "- Bump CACHE_VERSION in public/sw.js whenever the service worker changes (2026-10-01).",
  "- Every model call goes through askClaude in src/lib/claude.ts.",
  "",
].join("\n");

function sampleRepo(extra: Files = {}, commits?: CommitSpec[]): Repo {
  return makeRepo({ files: { "docs/PROGRESS.md": PROGRESS, "docs/decisions.md": DECISIONS, ...extra }, commits });
}

// --------------------------------------------------------------------------------------------- matching

describe("recall finds words and identifiers", () => {
  let repo: Repo;
  beforeAll(() => {
    repo = sampleRepo();
  });

  it.each(["ratta", "Ratta", "RÄTTA", "rätta"])("finds rätta for %s, with the right line", (q) => {
    const r = recall(repo, q);
    expect(r.code).toBe(0);
    expect(heads(r.stdout)[0]).toBe("docs/PROGRESS.md:5");
    expect(r.stdout).toContain("«rätta»");
  });

  it.each(["cache version", "CACHE_VERSION", "cache_version", "Cache Version"])("finds CACHE_VERSION for %s", (q) => {
    const r = recall(repo, q);
    expect(r.code).toBe(0);
    expect(heads(r.stdout)[0]).toBe("docs/decisions.md:3");
    expect(r.stdout).toContain("«CACHE_VERSION»");
  });

  it("finds camelCase askClaude for 'ask claude'", () => {
    const r = recall(repo, "ask", "claude");
    expect(r.code).toBe(0);
    expect(heads(r.stdout)[0]).toBe("docs/decisions.md:4");
    expect(r.stdout).toContain("«askClaude»");
  });

  it("falls back to prefix matches (4+ characters) when a word has no exact match", () => {
    const j = recallJson(repo, "boo");
    expect(j.results).toEqual([]);
    const k = recallJson(repo, "book");
    expect(k.terms).toEqual([{ term: "book", match: "prefix", terms: ["booking"] }]);
    expect(k.results[0]!.path).toBe("docs/PROGRESS.md");
    expect(k.results[0]!.snippet).toContain("«booking»");
  });

  it("says plainly when nothing matches, and exits 0", () => {
    const r = recall(repo, "zebrafish");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^No matches for "zebrafish"\. Searched \d+ chunks from 2 files and 1 commit\.\n$/);
  });

  it("explains a query with only stopwords", () => {
    const r = recall(repo, "the och");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No searchable words in "the och"');
  });
});

// ---------------------------------------------------------------------------------------------- ranking

describe("ranking and output", () => {
  it("ranks a heading match above a passing mention", () => {
    const repo = makeRepo({
      files: {
        "docs/PROGRESS.md": [
          "# Progress",
          "",
          "## Session notes",
          "",
          "Many things happened: routing, auth, a deploy, and we also mentioned the service worker in passing once.",
          "",
          "## Service worker",
          "",
          "Bump it on every change.",
          "",
        ].join("\n"),
      },
    });
    const j = recallJson(repo, "service worker");
    expect(j.results.map((h) => h.line)).toEqual([7, 5]);
    expect(j.results[0]!.heading).toEqual(["Progress", "Service worker"]);
    expect(j.results[0]!.score).toBeGreaterThan(j.results[1]!.score);
  });

  it("prints path:line  (score) then the indented snippet, in a deterministic order", () => {
    const same = "## Note\n\nThe widget renders twice.\n";
    const repo = makeRepo({
      files: {
        "docs/progress-archive/b.md": same,
        "docs/progress-archive/a.md": `${same}\n## Note\n\nThe widget renders twice.\n`,
      },
    });
    const r = recall(repo, "widget");
    expect(r.code).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toMatch(/^docs\/progress-archive\/a\.md:3 {2}\(\d+\.\d\d\)$/);
    expect(lines[1]).toBe("    ## Note The «widget» renders twice.");
    expect(heads(r.stdout)).toEqual(["docs/progress-archive/a.md:3", "docs/progress-archive/a.md:7", "docs/progress-archive/b.md:3"]);
    // Same input, same output.
    expect(recall(repo, "widget").stdout).toBe(r.stdout);
  });

  it("respects --limit and says how many more there are", () => {
    const files: Files = {};
    for (let i = 0; i < 12; i++) files[`docs/progress-archive/s${String(i).padStart(2, "0")}.md`] = `# S${i}\n\nThe migration ran.\n`;
    const repo = makeRepo({ files });
    const two = recall(repo, "migration", "--limit", "2");
    expect(heads(two.stdout)).toHaveLength(2);
    expect(two.stdout).toContain("Showing 2 of 12 hits; use --limit N for more.");
    expect(heads(recall(repo, "migration").stdout)).toHaveLength(8); // config default
    expect(heads(recall(repo, "migration", "--limit=50").stdout)).toHaveLength(12);
    expect(recall(repo, "migration", "--limit", "50").stdout).not.toContain("Showing");
    expect(recallJson(repo, "migration", "-n", "3").results).toHaveLength(3);
  });

  it("uses recall.limit and recall.snippetChars from config.json", () => {
    const files: Files = {
      ".claude/hermod/config.json": JSON.stringify({ version: 1, recall: { limit: 1, snippetChars: 40 } }),
      "docs/PROGRESS.md": `# P\n\nalpha ${"filler ".repeat(60)}\n\n## Q\n\nalpha again\n`,
    };
    const repo = makeRepo({ files });
    const j = recallJson(repo, "alpha");
    expect(j.results).toHaveLength(1);
    expect(j.total).toBe(2);
    expect(j.results.every((h) => h.snippet.replace(/[«»…]/g, "").length <= 41)).toBe(true);
  });

  it("--json gives hits with path, line, heading, score and snippet", () => {
    const repo = sampleRepo();
    const j = recallJson(repo, "export");
    expect(j.query).toBe("export");
    expect(j.source).toBe("all");
    expect(j.searched.files).toBe(2);
    expect(j.results[0]).toMatchObject({ kind: "file", path: "docs/PROGRESS.md", line: 9, startLine: 7, heading: ["Progress", "Next step"] });
    expect(j.results[0]!.snippet).toContain("«export»");
  });
});

// ------------------------------------------------------------------------------------------------ git

describe("git commits", () => {
  let repo: Repo;
  beforeAll(() => {
    repo = sampleRepo({}, [
      { message: "Fix the invoice rounding\n\nThe totals were off by one öre because of float math.", date: "2026-10-02T10:00:00Z" },
      { message: "Add the zebra crossing page", date: "2026-10-03T10:00:00Z" },
    ]);
  });

  it("finds commits by subject and body, printed as git <shortsha> <date>", () => {
    const sha = repo.git("rev-parse", "HEAD~1");
    const r = recall(repo, "ore", "float");
    expect(r.code).toBe(0);
    expect(heads(r.stdout)[0]).toBe(`git ${sha.slice(0, 7)} 2026-10-02`);
    expect(r.stdout).toContain("«öre»");
    const j = recallJson(repo, "zebra");
    expect(j.results).toHaveLength(1);
    expect(j.results[0]).toMatchObject({ kind: "git", sha: repo.git("rev-parse", "HEAD"), date: "2026-10-03", subject: "Add the zebra crossing page" });
  });

  it("--source git searches only commits; other sources skip them", () => {
    expect(recallJson(repo, "rounding", "--source", "git").results.map((h) => h.kind)).toEqual(["git"]);
    expect(recallJson(repo, "rounding", "--source", "progress").results.map((h) => h.kind)).toEqual(["file"]);
    expect(recallJson(repo, "zebra", "--source", "decisions").results).toEqual([]);
    expect(recallJson(repo, "rounding").results.map((h) => h.kind).sort()).toEqual(["file", "git"]);
  });

  it("recall.git false turns commit search off", () => {
    const off = makeRepo({
      files: { ".claude/hermod/config.json": JSON.stringify({ version: 1, recall: { git: false } }) },
      commits: [{ message: "Add the zebra crossing page" }],
    });
    expect(recallJson(off, "zebra").results).toEqual([]);
    const r = recall(off, "zebra", "--source", "git");
    expect(r.stdout).toContain("Note: git search is off (recall.git in config.json).");
  });

  it("caps commits at recall.gitMaxCommits (newest first)", () => {
    const capped = makeRepo({
      files: { ".claude/hermod/config.json": JSON.stringify({ version: 1, recall: { gitMaxCommits: 1 } }) },
      commits: [{ message: "older lighthouse" }, { message: "newer lighthouse" }],
    });
    const j = recallJson(capped, "lighthouse");
    expect(j.searched.commits).toBe(1);
    expect(j.results.map((h) => h.subject)).toEqual(["newer lighthouse"]);
  });
});

// --------------------------------------------------------------------------------------------- sources

describe("sources", () => {
  it("--source picks progress, decisions or history files", () => {
    const repo = makeRepo({
      files: {
        "docs/PROGRESS.md": "# P\n\nkestrel in progress\n",
        "docs/progress-archive/2026-10.md": "# Oct\n\nkestrel archived\n",
        "docs/decisions.md": "# D\n\nkestrel decided\n",
        ".claude/hermod/history/2026-11-01.md": "# H\n\nkestrel history\n",
      },
    });
    const paths = (source: string) => recallJson(repo, "kestrel", "--source", source).results.map((h) => h.path).sort();
    expect(paths("progress")).toEqual(["docs/PROGRESS.md", "docs/progress-archive/2026-10.md"]);
    expect(paths("decisions")).toEqual(["docs/decisions.md"]);
    expect(paths("history")).toEqual([".claude/hermod/history/2026-11-01.md"]);
    expect(paths("all")).toHaveLength(4);
    expect(paths("git")).toEqual([]); // commits only: no file hits
  });

  it("never reads .claude/hermod/.local or node_modules, even when a pattern names them", () => {
    const secret = "# Secret\n\nquetzal marker\n";
    const repo = makeRepo({
      files: {
        ".claude/hermod/config.json": JSON.stringify({
          version: 1,
          recall: {
            sources: ["**/*.md", ".claude/hermod/.local/notes.md", "node_modules/pkg/README.md", ".claude/hermod/.local/", "**/node_modules/**"],
            git: false,
          },
        }),
        ".claude/hermod/.local/notes.md": secret,
        ".claude/hermod/.local/sessions/abc/brief.md": secret,
        "node_modules/pkg/README.md": secret,
        "packages/app/node_modules/dep/notes.md": secret,
        "docs/visible.md": "# Visible\n\nquetzal here\n",
      },
    });
    // .local is gitignored by the kit at runtime; node_modules would be too in a real repo. Not committed here
    // either way: recall walks the file system, not git.
    const j = recallJson(repo, "quetzal");
    expect(j.results.map((h) => h.path)).toEqual(["docs/visible.md"]);
    expect(R.findSourceFiles(repo.root, ["**/*.md"]).files.filter((f) => /\.local|node_modules/i.test(f))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("does not follow symlinks out of the repository", () => {
    const outside = tempDir("hermod-recall-outside-");
    mkdirSync(path.join(outside, "docs"), { recursive: true });
    writeFileSync(path.join(outside, "docs", "PROGRESS.md"), "# Outside\n\nplatypus outside\n");
    const repo = makeRepo({ files: { "docs/decisions.md": "# D\n\nnothing\n" } });
    symlinkSync(path.join(outside, "docs"), repo.abs("docs/progress-archive"));
    symlinkSync(path.join(outside, "docs", "PROGRESS.md"), repo.abs("docs/PROGRESS.md"));
    expect(recallJson(repo, "platypus").results).toEqual([]);
    // Symlinks met while walking a folder are skipped too (a folder and a file).
    const walked = makeRepo({
      files: {
        ".claude/hermod/config.json": JSON.stringify({ version: 1, recall: { sources: ["docs/**/*.md"], git: false } }),
        "docs/real.md": "# Real\n\nplatypus inside\n",
      },
    });
    symlinkSync(path.join(outside, "docs"), walked.abs("docs/linked-dir"));
    symlinkSync(path.join(outside, "docs", "PROGRESS.md"), walked.abs("docs/linked.md"));
    expect(recallJson(walked, "platypus").results.map((h) => h.path)).toEqual(["docs/real.md"]);
  });

  it("skips binary files and reports an empty corpus plainly", () => {
    const repo = makeRepo({ git: false, files: { "docs/PROGRESS.md": "# P\n\nnarwhal\0binary\n" } });
    const r = recall(repo, "narwhal");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('No matches for "narwhal". Searched 0 chunks from 0 files and 0 commits.\n');
  });

  it("works in an empty repository (no sources, no commits) and outside git", () => {
    const empty = makeRepo({ initialCommit: false, kit: true });
    const r = recall(empty, "anything");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('No matches for "anything". Searched 0 chunks from 0 files and 0 commits.\n');
    const plain = makeRepo({ git: false, files: { "docs/PROGRESS.md": "# P\n\nwalrus\n" } });
    expect(recallJson(plain, "walrus").results.map((h) => h.path)).toEqual(["docs/PROGRESS.md"]);
  });

  it("finds the files a pattern matches: exact, directory prefix and globs", () => {
    const repo = makeRepo({
      kit: false,
      files: {
        "docs/PROGRESS.md": "x",
        "docs/a/b/deep.md": "x",
        "docs/a/b/deep.txt": "x",
        "notes/one.md": "x",
        "notes/sub/two.md": "x",
        "README.md": "x",
      },
    });
    expect(R.findSourceFiles(repo.root, ["docs/PROGRESS.md"]).files).toEqual(["docs/PROGRESS.md"]);
    expect(R.findSourceFiles(repo.root, ["docs/**/*.md"]).files).toEqual(["docs/PROGRESS.md", "docs/a/b/deep.md"]);
    expect(R.findSourceFiles(repo.root, ["notes/"]).files).toEqual(["notes/one.md", "notes/sub/two.md"]);
    expect(R.findSourceFiles(repo.root, ["notes/*.md", "notes/**/*.md"]).files).toEqual(["notes/one.md", "notes/sub/two.md"]);
    expect(R.findSourceFiles(repo.root, ["*.md"]).files).toEqual(["README.md"]);
    expect(R.findSourceFiles(repo.root, ["/etc/passwd", "../x.md", "missing.md"]).files).toEqual([]);
    expect(R.findSourceFiles(repo.root, ["**/*.md"], { maxFiles: 2 })).toEqual({ files: ["README.md", "docs/PROGRESS.md"], truncated: true });
  });

  it("classifies files by source kind and exclusion", () => {
    expect(R.sourceKind("docs/decisions.md")).toBe("decisions");
    expect(R.sourceKind("docs/Decisions-2025.md")).toBe("decisions");
    expect(R.sourceKind(".claude/hermod/history/x.md")).toBe("history");
    expect(R.sourceKind("docs/PROGRESS.md")).toBe("progress");
    expect(R.isExcluded(".claude/hermod/.local/a.md")).toBe(true);
    expect(R.isExcluded(".claude/hermod/.LOCAL/a.md")).toBe(true);
    expect(R.isExcluded("a/node_modules/b.md")).toBe(true);
    expect(R.isExcluded(".git/HEAD")).toBe(true);
    expect(R.isExcluded(".claude/hermod/local.md")).toBe(false);
    expect(R.isExcluded("docs/node_modules.md")).toBe(false);
  });
});

// -------------------------------------------------------------------------------------- line numbers

describe("line numbers", () => {
  it("are correct for Windows CRLF files", () => {
    const text = ["# Progress", "", "## Status", "", "", "", "First paragraph.", "", "Second paragraph mentions the gazebo.", "", "## Next"]
      .join("\r\n");
    const repo = makeRepo({ files: { "docs/PROGRESS.md": `${text}\r\n` } });
    const j = recallJson(repo, "gazebo");
    expect(j.results[0]).toMatchObject({ path: "docs/PROGRESS.md", line: 9, startLine: 3 });
    expect(j.results[0]!.snippet).not.toContain("\r");
    const r = recall(repo, "gazebo");
    expect(heads(r.stdout)).toEqual(["docs/PROGRESS.md:9"]);
  });

  it("are correct after several blank lines, inside fences and for headings", () => {
    const text = [
      "# Log", // 1
      "",
      "intro line", // 3
      "",
      "",
      "",
      "", // 7
      "```sh", // 8
      "npm run build",
      "",
      "npm run gazebo", // 11
      "```",
      "",
      "## Gazebo heading", // 14
      "",
      "body",
    ].join("\n");
    const repo = makeRepo({ files: { "docs/PROGRESS.md": `${text}\n` } });
    const j = recallJson(repo, "gazebo");
    expect(j.results.map((h) => h.line).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([11, 14]);
  });

  it("chunkLineAt maps chunk offsets back to file lines", () => {
    const fileLines = ["## A", "", "", "one", "two", "", "", "three"];
    const chunk = { startLine: 1, endLine: 8, text: "## A\n\none\ntwo\n\nthree", headingPath: ["A"] };
    expect(R.chunkLineAt(chunk, fileLines, 0)).toBe(1);
    expect(R.chunkLineAt(chunk, fileLines, chunk.text.indexOf("one"))).toBe(4);
    expect(R.chunkLineAt(chunk, fileLines, chunk.text.indexOf("two"))).toBe(5);
    expect(R.chunkLineAt(chunk, fileLines, chunk.text.indexOf("three"))).toBe(8);
  });
});

// ---------------------------------------------------------------------------------------- performance

describe("performance", () => {
  it("answers over a 1 MB corpus in under 1.5 s", () => {
    const words = ["booking", "invoice", "deploy", "rätta", "kunden", "lager", "migration", "service", "worker", "routing", "askClaude", "CACHE_VERSION", "schema", "offline", "export", "räkning", "fordon", "kalender", "summary", "release"];
    const files: Files = {};
    let total = 0;
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let f = 0; total < 1_050_000; f++) {
      const lines: string[] = [`# Session ${f}`, ""];
      for (let s = 0; s < 40; s++) {
        lines.push(`## Part ${f}.${s} ${words[rnd() % words.length]}`, "");
        for (let p = 0; p < 3; p++) {
          const sentence = Array.from({ length: 24 }, () => `${words[rnd() % words.length]}${rnd() % 500}`).join(" ");
          lines.push(`${sentence} plain ${words[rnd() % words.length]}.`, "");
        }
      }
      const text = lines.join("\n");
      total += text.length;
      files[`docs/progress-archive/s${String(f).padStart(3, "0")}.md`] = text;
    }
    const repo = makeRepo({ files });
    let best = Infinity;
    let out = "";
    for (let i = 0; i < 2; i++) {
      const r = recall(repo, "rätta kunden cache version");
      expect(r.code).toBe(0);
      out = r.stdout;
      best = Math.min(best, r.durationMs);
    }
    expect(total).toBeGreaterThan(1_000_000);
    expect(heads(out)).toHaveLength(8);
    expect(best).toBeLessThan(1500);
  });
});

// ------------------------------------------------------------------------------------------------ usage

describe("usage", () => {
  let repo: Repo;
  beforeAll(() => {
    repo = sampleRepo();
  });

  it("--help prints the usage and exits 0", () => {
    const r = recall(repo, "--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${R.USAGE}\n`);
    expect(r.stdout).toContain("--source S");
  });

  it.each([
    [[] as string[], "give a query"],
    [["   "], "give a query"],
    [["x", "--limit", "0"], "--limit must be"],
    [["x", "--limit", "abc"], "--limit must be"],
    [["x", "--limit", "-3"], ""],
    [["x", "--limit", "1001"], "--limit must be"],
    [["x", "--source", "everything"], "--source must be one of"],
    [["x", "--bogus"], "Unknown option"],
    [["x", "--root", "/definitely/not/here"], "does not exist"],
  ])("exits 2 for %j", (args, message) => {
    const r = recall(repo, ...args);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(message);
    expect(r.stderr).toContain("Usage:");
  });

  it("accepts --root and a query after --", () => {
    const r = runNode(repo.kitPath("recall.mjs"), { cwd: tempDir(), args: ["--root", repo.root, "--", "-ratta"] });
    expect(r.code).toBe(0);
    expect(heads(r.stdout)[0]).toBe("docs/PROGRESS.md:5");
  });

  it("finds the repository from the git top level when run from a subfolder", () => {
    const r = runNode(repo.kitPath("recall.mjs"), { cwd: repo.abs("docs"), args: ["ratta"] });
    expect(r.code).toBe(0);
    expect(heads(r.stdout)[0]).toBe("docs/PROGRESS.md:5");
  });

  it("still searches with an invalid config.json value and says so on stderr", () => {
    const bad = sampleRepo({ ".claude/hermod/config.json": JSON.stringify({ version: 1, recall: { limit: "lots" } }) });
    const r = recall(bad, "ratta");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("config.json has 1 invalid value");
    expect(heads(r.stdout)[0]).toBe("docs/PROGRESS.md:5");
  });

  it("never writes a file", () => {
    const before = repo.git("status", "--porcelain", "--ignored", "--untracked-files=all");
    recall(repo, "ratta");
    recall(repo, "ratta", "--json");
    expect(repo.git("status", "--porcelain", "--ignored", "--untracked-files=all")).toBe(before);
  });
});
