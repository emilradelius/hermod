// Tests for the session brief (kit/files/.claude/hermod/lib/brief.mjs) and its CLI (brief.mjs).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  KIT_FILES,
  cleanup,
  hardLine,
  hardText,
  hugeProgress,
  lessonsFile,
  makeRepo,
  runNode,
  skillFiles,
  splitCharacterProblems,
  tempDir,
  type Files,
  type Repo,
} from "./helpers.js";

// ------------------------------------------------------------------------------------- the module

interface GitFacts {
  repo: boolean;
  head: string | null;
  branch: string | null;
  uncommitted: string[];
}
interface BriefPart {
  name: string;
  status: "full" | "cut" | "missing" | "dropped" | "off" | "empty";
  text: string;
  chars: number;
  note?: string;
}
interface BriefResult {
  text: string;
  budget: number;
  chars: number;
  parts: BriefPart[];
}
interface BriefModule {
  BRIEF_TITLE: string;
  MAX_BRIEF_CHARS: number;
  MIN_BRIEF_CHARS: number;
  buildBrief(root: string, config?: unknown, options?: Record<string, unknown>): BriefResult;
  extractSection(text: string, title: string): { title: string; level: number; line: number; body: string } | null;
  cutText(text: string, max: number): string;
  oneLine(text: string, max: number): string;
  graphemeEnd(text: string, i: number): number;
  allocateEvenly(desired: number[], total: number): number[];
  gatherGit(root: string): GitFacts;
  kitVersion(dir?: string): string;
  capBrief(text: string): string;
}
interface ConfigModule {
  loadConfig(root: string): { config: Record<string, unknown>; errors: string[]; warnings: string[] };
}

const LIB = path.join(KIT_FILES, ".claude", "hermod", "lib");
const CLI = path.join(KIT_FILES, ".claude", "hermod", "brief.mjs");
let B: BriefModule;
let C: ConfigModule;

beforeAll(async () => {
  B = (await import(pathToFileURL(path.join(LIB, "brief.mjs")).href)) as BriefModule;
  C = (await import(pathToFileURL(path.join(LIB, "config.mjs")).href)) as ConfigModule;
});
afterAll(() => cleanup());

const TOOLS_LINE = '- Search past work: node .claude/hermod/recall.mjs "query"';
const REFLECT_LINE = "- End of session: /reflect (proposes lesson/skill/check changes in the PR; a person merges)";

/** A config.json text: the defaults with the given brief/lessons/skills overrides. */
function configJson(over: { brief?: Record<string, unknown>; lessons?: Record<string, unknown>; skills?: Record<string, unknown> }): string {
  return JSON.stringify({ version: 1, ...over }, null, 2);
}

function load(repo: Repo): Record<string, unknown> {
  const r = C.loadConfig(repo.root);
  expect(r.errors).toEqual([]);
  return r.config;
}

/** The text between start and end (end omitted: to the end); throws when a marker is missing. */
function between(text: string, start: string, end?: string): string {
  const a = text.indexOf(start);
  if (a === -1) throw new Error(`missing ${JSON.stringify(start)}`);
  const from = a + start.length;
  if (end === undefined) return text.slice(from);
  const b = text.indexOf(end, from);
  if (b === -1) throw new Error(`missing ${JSON.stringify(end)}`);
  return text.slice(from, b);
}

function part(result: BriefResult, name: string): BriefPart {
  const p = result.parts.find((x) => x.name === name);
  if (!p) throw new Error(`no part ${name}`);
  return p;
}

// --------------------------------------------------------------------------------- section matching

describe("extractSection", () => {
  const doc = [
    "# Progress",
    "",
    "```md",
    "## Status",
    "fenced, not a heading",
    "```",
    "<!--",
    "## Status",
    "commented out",
    "-->",
    "## Status (2026-11-05)",
    "",
    "status line 1",
    "### Detail",
    "detail line",
    "~~~",
    "## Not a heading inside tildes",
    "~~~",
    "status after fence",
    "## Next steps later",
    "prefix-only match",
    "## Next step",
    "exact match",
    "#### Deep",
    "deep body",
    "## Open questions",
    "q",
  ].join("\n");

  it("matches a heading that starts with the title, case-insensitive, ignoring fenced and commented headings", () => {
    const s = B.extractSection(doc, "status");
    expect(s?.title).toBe("Status (2026-11-05)");
    expect(s?.line).toBe(11);
    expect(s?.body).toBe(
      ["status line 1", "### Detail", "detail line", "~~~", "## Not a heading inside tildes", "~~~", "status after fence"].join("\n"),
    );
    expect(B.extractSection(doc, "STATUS (2026")?.title).toBe("Status (2026-11-05)");
  });

  it("prefers an exact title over an earlier prefix match", () => {
    expect(B.extractSection(doc, "Next step")?.body).toBe("exact match\n#### Deep\ndeep body");
    expect(B.extractSection(doc, "next steps")?.body).toBe("prefix-only match");
  });

  it("finds any level, and the section ends at the next heading of the same or a higher level", () => {
    expect(B.extractSection(doc, "deep")?.level).toBe(4);
    expect(B.extractSection(doc, "deep")?.body).toBe("deep body");
    expect(B.extractSection(doc, "Detail")?.body).toBe("detail line\n~~~\n## Not a heading inside tildes\n~~~\nstatus after fence");
    const nested = "# A\n## B\nb\n# C\nc";
    expect(B.extractSection(nested, "A")?.body).toBe("## B\nb");
  });

  it("ignores emphasis in headings, handles CRLF and returns null when absent", () => {
    expect(B.extractSection("## **Status**\r\nok\r\n## Next\r\n", "status")?.body).toBe("ok");
    expect(B.extractSection(doc, "Roadmap")).toBeNull();
    expect(B.extractSection(doc, "  ")).toBeNull();
    expect(B.extractSection("", "Status")).toBeNull();
    expect(B.extractSection("Status\n======\ntext", "Status")).toBeNull();
  });

  it("does not match a word that merely starts like the title", () => {
    expect(B.extractSection("## Statistics\nx\n", "Status")).toBeNull();
  });

  it("is linear: 100,000 headings are handled quickly", () => {
    const text = "#\n".repeat(100_000) + "## Status\nfound\n";
    const t = performance.now();
    expect(B.extractSection(text, "Status")?.body).toBe("found");
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

// -------------------------------------------------------------------------------------- cutting

describe("cutting text", () => {
  const samples = [
    "Läget är så här: åtgärda flödet 🚀 och kör testerna igen, tack. Ärendet är öppet.",
    "äää 👨‍👩‍👧 🇸🇪🇸🇪 ö é́ 😀",
    "👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧🇸🇪🇸🇪🇸🇪ääää",
  ];
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
  const boundaries = (s: string) => new Set([...[...seg.segment(s)].map((x) => x.index), s.length]);

  it("graphemeEnd returns the largest grapheme boundary at or below i", () => {
    for (const s of samples) {
      const b = boundaries(s);
      for (let i = 0; i <= s.length; i++) {
        const e = B.graphemeEnd(s, i);
        expect(b.has(e), `${JSON.stringify(s)} at ${i} gave ${e}`).toBe(true);
        expect(e).toBeLessThanOrEqual(i);
        // nothing larger and still ≤ i is a boundary
        for (let k = e + 1; k <= i; k++) expect(b.has(k)).toBe(false);
      }
    }
  });

  it("cutText and oneLine never exceed the limit and never split a character", () => {
    for (const s of samples) {
      const b = boundaries(s);
      for (let max = 0; max <= s.length + 2; max++) {
        const c = B.cutText(s, max);
        expect(c.length).toBeLessThanOrEqual(Math.max(0, max));
        expect(s.startsWith(c)).toBe(true);
        expect(b.has(c.length) || c.length === s.trimEnd().length || /\s/.test(s[c.length] ?? " ")).toBe(true);
        const o = B.oneLine(s, max);
        expect(o.length).toBeLessThanOrEqual(Math.max(0, max));
        if (o.endsWith("…") && o.length < s.length) {
          const kept = o.slice(0, -1);
          expect(s.startsWith(kept)).toBe(true);
          expect(b.has(kept.length) || /\s/.test(s[kept.length] ?? " ")).toBe(true);
        }
      }
    }
  });

  it("cutText prefers a line break, then a space", () => {
    expect(B.cutText("first line here\nsecond line here", 20)).toBe("first line here");
    expect(B.cutText("one two three four", 10)).toBe("one two");
    expect(B.cutText("abcdefghij", 4)).toBe("abcd");
    expect(B.cutText("fits", 10)).toBe("fits");
  });

  it("oneLine flattens control characters and line separators", () => {
    expect(B.oneLine("a\nb\tc d\u0000e", 50)).toBe("a b c d e");
    expect(B.oneLine("abcdef", 4)).toBe("abc…");
  });

  it("allocateEvenly gives small items what they need and splits the rest equally", () => {
    expect(B.allocateEvenly([100, 5000, 5000], 3000)).toEqual([100, 1450, 1450]);
    expect(B.allocateEvenly([10, 20], 1000)).toEqual([10, 20]);
    expect(B.allocateEvenly([500, 500], 0)).toEqual([0, 0]);
    const a = B.allocateEvenly([3000, 10, 2500, 400], 2000);
    expect(a.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(2000);
    expect(a[1]).toBe(10);
    expect(a[0]).toBe(a[2]);
  });
});

// --------------------------------------------------------------------------------- the hard budget

describe("budget", () => {
  let repo: Repo;
  beforeAll(() => {
    const files: Files = {
      "docs/PROGRESS.md": hugeProgress(200_000),
      ".claude/hermod/LESSONS.md": lessonsFile(19_900),
      "docs/decisions.md": `# Decisions\n\n## Recent\n${hardText(30_000)}\n`,
      ...skillFiles(80),
    };
    repo = makeRepo({ files, kitSkills: false });
    for (let i = 0; i < 50; i++) repo.git("branch", `feature-${String(i).padStart(2, "0")}-${"x".repeat(60)}`);
    repo.write("dirty.txt", "uncommitted\n");
  });

  for (const budget of [1000, 4000, 8000, 9500]) {
    it(`never exceeds ${budget} characters with huge inputs, and never splits a character`, () => {
      repo.write(
        ".claude/hermod/config.json",
        configJson({
          brief: { budgetChars: budget, maxBranches: 50, extra: [{ file: "docs/decisions.md", sections: ["Recent"] }] },
          lessons: { capChars: 20_000, maxEntryChars: 2000 },
          skills: { indexChars: 200 },
        }),
      );
      const result = B.buildBrief(repo.root, load(repo), { kitVersion: "1.2.3" });
      expect(result.budget).toBe(budget);
      expect(result.text.length).toBeLessThanOrEqual(budget);
      expect(result.chars).toBe(result.text.length);
      expect(splitCharacterProblems(result.text)).toEqual([]);
      // Header and tools are always there.
      expect(result.text.startsWith(`${B.BRIEF_TITLE}\nrepo · branch main · `)).toBe(true);
      expect(result.text).toContain(" · 2 uncommitted · kit 1.2.3");
      expect(result.text.endsWith(`## Tools\n${TOOLS_LINE}\n${REFLECT_LINE}`)).toBe(true);
      // The parts add up to the text.
      const shown = result.parts.filter((p) => p.text !== "");
      expect(shown.map((p) => p.text).join("\n\n")).toBe(result.text);
      for (const p of result.parts) expect(p.chars).toBe(p.text.length);
      // Lessons come first in the allocation: at 4000+ the first lesson is there.
      if (budget >= 4000) expect(result.text).toContain(`- ${hardLine(300, 0)}.`);
      // Something was cut, and the brief says so.
      expect(result.parts.some((p) => p.status === "cut" || p.status === "dropped")).toBe(true);
    });
  }

  it("at the largest budget the lessons are cut only after filling the room, then skills say how many are left", () => {
    repo.write(
      ".claude/hermod/config.json",
      configJson({ brief: { budgetChars: 9500 }, lessons: { capChars: 20_000, maxEntryChars: 2000 } }),
    );
    const result = B.buildBrief(repo.root, load(repo));
    const lessons = part(result, "lessons");
    expect(lessons.status).toBe("cut");
    expect(lessons.text).toMatch(/\n- … \d+ more in \.claude\/hermod\/LESSONS\.md$/);
    // The lessons take nearly all of the room left after header and tools.
    expect(result.text.length).toBeGreaterThan(9500 - 400);
    expect(part(result, "skills").status).toBe("cut");
    const skills = part(result, "skills").text;
    expect(skills.startsWith("## Skills (load the full SKILL.md when one applies)\n")).toBe(true);
    const more = /\n- … and (\d+) more in \.claude\/skills$/.exec(skills);
    expect(more).not.toBeNull();
    const shownSkills = skills.split("\n").filter((l) => /^- skill-\d\d: /.test(l)).length;
    expect(shownSkills + Number(more?.[1])).toBe(80);
    expect(shownSkills).toBeLessThan(10);
  });

  it("skills are dropped from the end with '… and N more' when lessons are small", () => {
    repo.write(".claude/hermod/config.json", configJson({ brief: { budgetChars: 4000 } }));
    repo.write(".claude/hermod/LESSONS.md", "# Lessons\n<!-- x -->\n\nOne fact.\n§\nTwo facts.\n");
    const result = B.buildBrief(repo.root, load(repo));
    const skills = part(result, "skills");
    expect(skills.status).toBe("cut");
    const m = /- … and (\d+) more in \.claude\/skills$/.exec(skills.text);
    expect(m).not.toBeNull();
    const shownLines = skills.text.split("\n").filter((l) => /^- skill-\d\d: /.test(l));
    expect(shownLines.length).toBeGreaterThan(5);
    expect(shownLines.length + Number(m?.[1])).toBe(80);
    expect(shownLines[0]).toMatch(/^- skill-01: ¶/);
    expect(part(result, "lessons").text).toBe("## Lessons (.claude/hermod/LESSONS.md, 22 of 4,000 chars)\n- One fact.\n- Two facts.");
    expect(result.text.length).toBeLessThanOrEqual(4000);
    repo.write(".claude/hermod/LESSONS.md", lessonsFile(19_900));
  });

  it("a single lesson larger than the room is cut, not dropped", () => {
    repo.write(".claude/hermod/config.json", configJson({ brief: { budgetChars: 1000 }, lessons: { capChars: 20_000, maxEntryChars: 2000 } }));
    repo.write(".claude/hermod/LESSONS.md", `# Lessons\n<!-- x -->\n\n${hardLine(5000)}\n§\nsecond\n`);
    const result = B.buildBrief(repo.root, load(repo));
    const lessons = part(result, "lessons");
    expect(lessons.status).toBe("cut");
    expect(lessons.text).toMatch(/^## Lessons \(\.claude\/hermod\/LESSONS\.md, 5,\d{3} of 20,000 chars\)\n- ¶/);
    expect(lessons.text).toMatch(/ \[…\]\n- … 1 more in \.claude\/hermod\/LESSONS\.md$/);
    expect(result.text.length).toBeLessThanOrEqual(1000);
    expect(splitCharacterProblems(result.text)).toEqual([]);
    repo.write(".claude/hermod/LESSONS.md", lessonsFile(19_900));
  });
});

// ------------------------------------------------------------------------------------- progress

describe("progress sections", () => {
  it("shows each section up to maxCharsPerSection, cut at a line with a pointer to the file", () => {
    const status = Array.from({ length: 200 }, (_, i) => `status line ${i}`).join("\n");
    const repo = makeRepo({
      files: {
        "docs/PROGRESS.md": `# P\n\n## Status (today)\n\n${status}\n\n## Next step\n\nDo the next thing.\n`,
        ".claude/hermod/config.json": configJson({ brief: { budgetChars: 9500, progress: { file: "docs/PROGRESS.md", sections: ["Status", "Next step"], maxCharsPerSection: 500 } } }),
      },
    });
    const result = B.buildBrief(repo.root, load(repo));
    const p = part(result, "progress");
    expect(p.status).toBe("cut");
    const statusPart = between(p.text, "", "\n### Next step\n");
    const nextPart = between(p.text, "\n### Next step\n");
    expect(statusPart.startsWith("## Status and next step (from docs/PROGRESS.md)\n### Status (today)\nstatus line 0\n")).toBe(true);
    const body = statusPart.split("\n").slice(2).join("\n");
    expect(body.length).toBeLessThanOrEqual(500);
    expect(body.length).toBeGreaterThan(400);
    expect(body.endsWith("\n[… cut; the rest is in docs/PROGRESS.md]")).toBe(true);
    // Cut at a line boundary: every kept line is a whole line.
    for (const line of body.split("\n").slice(0, -1)) expect(line).toMatch(/^status line \d+$/);
    expect(nextPart).toBe("Do the next thing.");
  });

  it("shrinks big sections evenly when the budget is tight", () => {
    const big = (word: string) => Array.from({ length: 400 }, (_, i) => `${word} ${i} lorem ipsum dolor`).join("\n");
    const repo = makeRepo({
      files: {
        "docs/PROGRESS.md": `## Status\n${big("s")}\n## Next step\n${big("n")}\n## Small\nshort\n`,
        ".claude/hermod/config.json": configJson({
          brief: { budgetChars: 3000, includeSkills: false, includeLessons: false, includeGit: false, progress: { file: "docs/PROGRESS.md", sections: ["Status", "Small", "Next step"], maxCharsPerSection: 2500 } },
        }),
      },
    });
    const result = B.buildBrief(repo.root, load(repo));
    expect(result.text.length).toBeLessThanOrEqual(3000);
    const text = part(result, "progress").text;
    const s = between(text, "### Status\n", "\n### Small\n");
    const small = between(text, "### Small\n", "\n### Next step\n");
    const n = between(text, "### Next step\n");
    expect(small).toBe("short");
    expect(Math.abs(s.length - n.length)).toBeLessThan(40);
    expect(s.length).toBeGreaterThan(1000);
    expect(s.endsWith("[… cut; the rest is in docs/PROGRESS.md]")).toBe(true);
  });

  it("closes a fenced code block left open by a cut", () => {
    const code = Array.from({ length: 300 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const repo = makeRepo({
      files: {
        "docs/PROGRESS.md": `## Status\nintro\n\`\`\`js\n${code}\n\`\`\`\n## Next step\nafter\n`,
        ".claude/hermod/config.json": configJson({ brief: { progress: { file: "docs/PROGRESS.md", sections: ["Status", "Next step"], maxCharsPerSection: 600 } } }),
      },
    });
    const text = part(B.buildBrief(repo.root, load(repo)), "progress").text;
    const status = between(text, "### Status\n", "\n### Next step\n");
    expect(status.length).toBeLessThanOrEqual(600);
    const fences = status.split("\n").filter((l) => /^```/.test(l));
    expect(fences).toEqual(["```js", "```"]);
    expect(status.endsWith("\n```\n[… cut; the rest is in docs/PROGRESS.md]")).toBe(true);
  });

  it("reports a missing file and a missing section in one short line each", () => {
    const repo = makeRepo({ files: { "docs/PROGRESS.md": "## Status\nall good\n" }, kitSkills: false });
    const result = B.buildBrief(repo.root, load(repo));
    expect(part(result, "progress").text).toBe(
      "## Status and next step (from docs/PROGRESS.md)\n### Status\nall good\n### Next step\n(not found in docs/PROGRESS.md)",
    );
    repo.remove("docs/PROGRESS.md");
    const missing = B.buildBrief(repo.root, load(repo));
    expect(part(missing, "progress")).toMatchObject({ status: "missing", text: "## Status and next step: docs/PROGRESS.md not found" });
    expect(missing.text).toContain("\n## Lessons: none yet (.claude/hermod/LESSONS.md not found)\n");
    expect(missing.text).toContain("\n## Skills: none (.claude/skills not found)\n");
  });

  it("an empty section says so, and an empty section list shows the top of the file", () => {
    const repo = makeRepo({
      files: {
        "docs/PROGRESS.md": "## Status\n\n## Next step\nnext\n",
        ".claude/hermod/config.json": configJson({ brief: { progress: { file: "docs/PROGRESS.md", sections: ["Status"], maxCharsPerSection: 100 } } }),
      },
    });
    expect(part(B.buildBrief(repo.root, load(repo)), "progress").text).toBe("## Status (from docs/PROGRESS.md)\n### Status\n(empty)");
    repo.write(".claude/hermod/config.json", configJson({ brief: { progress: { file: "docs/PROGRESS.md", sections: [], maxCharsPerSection: 100 } } }));
    expect(part(B.buildBrief(repo.root, load(repo)), "progress").text).toBe("## Progress (from docs/PROGRESS.md)\n## Status\n\n## Next step\nnext");
  });

  it("shows brief.extra files with their own title and cap", () => {
    const repo = makeRepo({
      files: {
        "docs/PROGRESS.md": "## Status\nok\n## Next step\ngo\n",
        "docs/decisions.md": "# Decisions\n## Recent\n- one\n- two\n## Old\n- zero\n",
        ".claude/hermod/config.json": configJson({
          brief: { extra: [{ file: "docs/decisions.md", sections: ["Recent"], title: "Decisions" }, "docs/missing.md"] },
        }),
      },
    });
    const result = B.buildBrief(repo.root, load(repo));
    expect(part(result, "extra:docs/decisions.md").text).toBe("## Decisions (from docs/decisions.md)\n### Recent\n- one\n- two");
    expect(part(result, "extra:docs/missing.md")).toMatchObject({ status: "missing", text: "## docs/missing.md: docs/missing.md not found" });
    // Output order: progress, extra, lessons.
    expect(result.text.indexOf("## Status and next step")).toBeLessThan(result.text.indexOf("## Decisions"));
    expect(result.text.indexOf("## Decisions")).toBeLessThan(result.text.indexOf("## Lessons"));
  });

  it("redacts secrets before cutting, so no part of a secret survives a cut", () => {
    const token = `ghp_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;
    const filler = "word ".repeat(84); // the token straddles the 500-char cut point
    const repo = makeRepo({
      files: {
        "docs/PROGRESS.md": `## Status\n${filler}${token} tail\n${"more\n".repeat(200)}## Next step\nkey ${token}\n`,
        ".claude/hermod/config.json": configJson({ brief: { progress: { file: "docs/PROGRESS.md", sections: ["Status", "Next step"], maxCharsPerSection: 500 } } }),
      },
    });
    const result = B.buildBrief(repo.root, load(repo));
    expect(result.text).toContain("[REDACTED:github-token]");
    for (let i = 0; i + 8 <= token.length; i++) expect(result.text).not.toContain(token.slice(i, i + 8));
  });

  it("redacts secrets in lessons, skill descriptions and branch names", () => {
    const key = ["sk", "ant", "api03", "Qw3rTy7uIoP".repeat(5)].join("-");
    const ghp = `ghp_${"Mn8Bv7Cx6Z".repeat(4).slice(0, 36)}`;
    const repo = makeRepo({
      kitSkills: false,
      files: {
        ".claude/hermod/LESSONS.md": `# Lessons\n<!-- c -->\n\nThe staging key was ${key} once.\n`,
        ".claude/skills/leaky/SKILL.md": `---\nname: leaky\ndescription: Uses ${ghp} to talk to the API.\n---\nbody\n`,
      },
    });
    repo.git("branch", `fix-${ghp}`);
    const text = B.buildBrief(repo.root).text;
    expect(text).not.toContain(key);
    expect(text).not.toContain(ghp);
    expect(text).toContain("- The staging key was [REDACTED:anthropic-key] once.");
    expect(text).toMatch(/- leaky: Uses \[REDACTED:github-token\]/);
    expect(text).toContain("- fix-[REDACTED:github-token] (");
  });

  it("refuses a progress path that leaves the repository", () => {
    const outside = tempDir();
    writeFileSync(path.join(outside, "secret.md"), "## Status\nOUTSIDE\n");
    const repo = makeRepo();
    const result = B.buildBrief(repo.root, { brief: { progress: { file: `../${path.basename(outside)}/secret.md`, sections: ["Status"] } } });
    expect(result.text).not.toContain("OUTSIDE");
    expect(part(result, "progress").status).toBe("missing");
  });
});

// -------------------------------------------------------------------------------- header and git

describe("header, branches and switches", () => {
  it("shows repo name, branch, short sha, uncommitted count and kit version", () => {
    const repo = makeRepo({ name: "my-repo", files: { "a.txt": "a\n" } });
    repo.write("a.txt", "changed\n");
    repo.write("new.txt", "new\n");
    const sha = repo.git("rev-parse", "HEAD");
    const result = B.buildBrief(repo.root, null, { kitVersion: "0.1.0" });
    expect(result.text.split("\n")[1]).toBe(`my-repo · branch main · ${sha.slice(0, 7)} · 2 uncommitted · kit 0.1.0`);
  });

  it("detached HEAD, no commits, and not a git repository", () => {
    const repo = makeRepo({ commits: [{ message: "second" }] });
    repo.git("checkout", "-q", "--detach", "HEAD~1");
    expect(B.buildBrief(repo.root, null, { kitVersion: "x" }).text.split("\n")[1]).toMatch(/^repo · detached HEAD · [0-9a-f]{7} · 0 uncommitted · kit x$/);
    const empty = makeRepo({ initialCommit: false, kit: false, files: { "f.txt": "x" } });
    expect(B.buildBrief(empty.root, null, { kitVersion: "x" }).text.split("\n")[1]).toBe("repo · branch main · no commits yet · 1 uncommitted · kit x");
    const plain = makeRepo({ git: false });
    const r = B.buildBrief(plain.root, null, { kitVersion: "x" });
    expect(r.text.split("\n")[1]).toBe("repo · not a git repository · kit x");
    expect(part(r, "branches").status).toBe("off");
  });

  it("lists other branches, most recent first, at most maxBranches, without the current one", () => {
    const repo = makeRepo({ commits: [{ message: "old", date: "2020-01-01T00:00:00Z" }] });
    repo.git("branch", "old-branch");
    repo.commit({ message: "newer", date: "2026-11-01T00:00:00Z" });
    repo.git("branch", "new-branch");
    repo.git("branch", "third");
    repo.write(".claude/hermod/config.json", configJson({ brief: { maxBranches: 2 } }));
    const result = B.buildBrief(repo.root, load(repo), { now: Date.parse("2026-11-04T00:00:00Z") });
    const lines = part(result, "branches").text.split("\n");
    expect(lines[0]).toBe("## Branches");
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).every((l) => /^- (new-branch|third) \(3 days ago\)$/.test(l))).toBe(true);
    expect(result.text).not.toContain("- main (");
    repo.write(".claude/hermod/config.json", configJson({ brief: { maxBranches: 0 } }));
    expect(part(B.buildBrief(repo.root, load(repo)), "branches").status).toBe("off");
  });

  it("includeLessons, includeSkills and includeGit switch their parts off", () => {
    const repo = makeRepo({
      files: {
        ".claude/hermod/LESSONS.md": "# Lessons\n\nA fact.\n",
        ...skillFiles(2),
        ".claude/hermod/config.json": configJson({ brief: { includeLessons: false, includeSkills: false, includeGit: false } }),
      },
    });
    repo.git("branch", "other");
    const result = B.buildBrief(repo.root, load(repo), { kitVersion: "x" });
    expect(result.text).not.toContain("## Lessons");
    expect(result.text).not.toContain("## Skills");
    expect(result.text).not.toContain("## Branches");
    expect(result.text.split("\n")[1]).toBe("repo · kit x");
    for (const name of ["lessons", "skills", "branches"]) expect(part(result, name).status).toBe("off");
  });

  it("empty lessons and an empty skills folder are one line each", () => {
    const repo = makeRepo({ files: { ".claude/hermod/LESSONS.md": "# Lessons\n<!-- header -->\n" }, kitSkills: false });
    mkdirSync(repo.abs(".claude/skills"), { recursive: true });
    const result = B.buildBrief(repo.root);
    expect(part(result, "lessons").text).toBe("## Lessons (.claude/hermod/LESSONS.md, 0 of 4,000 chars)\n- none yet");
    expect(part(result, "skills").text).toBe("## Skills: none in .claude/skills");
  });

  it("multi-line lessons keep their continuation lines indented under the bullet", () => {
    const repo = makeRepo({ files: { ".claude/hermod/LESSONS.md": "# Lessons\n<!-- c -->\n\nFirst line\ncontinues here.\n§\nSecond.\n" } });
    expect(part(B.buildBrief(repo.root), "lessons").text).toBe(
      "## Lessons (.claude/hermod/LESSONS.md, 36 of 4,000 chars)\n- First line\n  continues here.\n- Second.",
    );
  });

  it("notes invalid config values in one line and clamps a budget outside the bounds", () => {
    const repo = makeRepo({ files: { ".claude/hermod/config.json": configJson({ brief: { budgetChars: 50_000 } }) } });
    const loaded = C.loadConfig(repo.root);
    expect(loaded.errors.length).toBe(1);
    const result = B.buildBrief(repo.root);
    expect(result.budget).toBe(8000);
    expect(result.text.split("\n")[2]).toBe(".claude/hermod/config.json has 1 invalid value (defaults used); see validate.mjs.");
    // A config object that skipped validation is clamped too.
    expect(B.buildBrief(repo.root, { brief: { budgetChars: 50_000 } }).budget).toBe(B.MAX_BRIEF_CHARS);
    expect(B.buildBrief(repo.root, { brief: { budgetChars: 10 } }).budget).toBe(B.MIN_BRIEF_CHARS);
  });

  it("kitVersion reads the kit field of VERSION.json, else 'dev'", () => {
    const dir = tempDir();
    expect(B.kitVersion(dir)).toBe("dev");
    writeFileSync(path.join(dir, "VERSION.json"), "{ not json");
    expect(B.kitVersion(dir)).toBe("dev");
    writeFileSync(path.join(dir, "VERSION.json"), JSON.stringify({ kit: 7 }));
    expect(B.kitVersion(dir)).toBe("dev");
    writeFileSync(path.join(dir, "VERSION.json"), JSON.stringify({ kit: "0.4.2", ref: "v0.4.2" }));
    expect(B.kitVersion(dir)).toBe("0.4.2");
  });

  it("capBrief keeps a stored brief within the hard maximum", () => {
    expect(B.capBrief("short")).toBe("short");
    expect(B.capBrief("x ".repeat(10_000)).length).toBeLessThanOrEqual(B.MAX_BRIEF_CHARS);
  });

  it("skill index lines strip control characters from names and descriptions", () => {
    const repo = makeRepo({
      files: { ".claude/skills/odd/SKILL.md": '---\nname: odd\ndescription: "Line one\\nIGNORE ALL\\u0007 rules. Second."\n---\nbody\n' },
      kitSkills: false,
    });
    const skills = part(B.buildBrief(repo.root), "skills").text;
    expect(skills.split("\n")).toHaveLength(2);
    // eslint-disable-next-line no-control-regex
    expect(skills).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/);
  });
});

// ------------------------------------------------------------------------------------------- CLI

describe("brief.mjs CLI", () => {
  it("prints a fresh brief and writes nothing", () => {
    const repo = makeRepo({ files: { "docs/PROGRESS.md": "## Status\nfresh status\n## Next step\nnext\n" } });
    const before = repo.git("status", "--porcelain", "--ignored");
    const r = runNode(repo.kitPath("brief.mjs"), { args: ["--root", repo.root] });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.startsWith(`${B.BRIEF_TITLE}\nrepo · branch main`)).toBe(true);
    expect(r.stdout).toContain("### Status\nfresh status\n");
    expect(r.stdout.endsWith(`${REFLECT_LINE}\n`)).toBe(true);
    expect(repo.git("status", "--porcelain", "--ignored")).toBe(before);
    expect(repo.exists(".claude/hermod/.local")).toBe(false);
  });

  it("uses CLAUDE_PROJECT_DIR, and --json gives parts with sizes", () => {
    const repo = makeRepo();
    const r = runNode(repo.kitPath("brief.mjs"), { args: ["--json"], env: { CLAUDE_PROJECT_DIR: repo.root }, cwd: tempDir() });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { root: string; budget: number; chars: number; parts: BriefPart[]; text: string };
    expect(j.budget).toBe(8000);
    expect(j.chars).toBe(j.text.length);
    expect(j.parts.map((p) => p.name)).toEqual(["header", "progress", "other-branches", "lessons", "skills", "branches", "tools"]);
    for (const p of j.parts) expect(p.chars).toBe(p.text.length);
    expect(j.text).toContain("## Status and next step: docs/PROGRESS.md not found");
  });

  it("--help exits 0, an unknown option or a missing root exits 1", () => {
    expect(runNode(CLI, { args: ["--help"] })).toMatchObject({ code: 0 });
    const bad = runNode(CLI, { args: ["--nope"] });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Usage:");
    const missing = runNode(CLI, { args: ["--root", path.join(tempDir(), "nope")] });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("does not exist");
  });
});
