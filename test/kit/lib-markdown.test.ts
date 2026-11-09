// Tests for kit/files/.claude/hermod/lib/markdown.mjs: sections, fences, findSection, chunkMarkdown, CRLF.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup } from "./helpers.js";
import { loadLib, type KitModule } from "./kit-lib-tests-helpers.js";

let md: KitModule;
beforeAll(async () => {
  md = await loadLib("markdown");
});
afterAll(cleanup);

interface Section {
  title: string;
  level: number;
  line: number;
  endLine: number;
  path: string[];
  body: string;
}

const DOC = [
  "# Progress", // 1
  "", // 2
  "## Status (2026-11-05)", // 3
  "Working on the kit.", // 4
  "### Detail", // 5
  "More.", // 6
  "```md", // 7
  "## Next step", // 8 (inside a fence: not a heading)
  "```", // 9
  "<!--", // 10
  "## Hidden", // 11 (inside a comment)
  "-->", // 12
  "## Next step", // 13
  "Write tests.", // 14
  "#NotAHeading", // 15
  "## Closing ##", // 16
  "", // 17
].join("\n");

describe("parseSections", () => {
  it("finds ATX headings, skipping fences and HTML comments", () => {
    const s: Section[] = md.parseSections(DOC);
    expect(s.map((x) => [x.title, x.level, x.line, x.endLine])).toEqual([
      ["Progress", 1, 1, 16],
      ["Status (2026-11-05)", 2, 3, 12],
      ["Detail", 3, 5, 12],
      ["Next step", 2, 13, 15],
      ["Closing", 2, 16, 16],
    ]);
    expect(s[2]?.path).toEqual(["Progress", "Status (2026-11-05)", "Detail"]);
    expect(s[3]?.path).toEqual(["Progress", "Next step"]);
    expect(s[3]?.body).toBe("Write tests.\n#NotAHeading");
    expect(s[1]?.body.split("\n")[0]).toBe("Working on the kit.");
    expect(s[1]?.body).toContain("### Detail");
  });

  it("handles fences of different lengths and tildes, and an unclosed fence", () => {
    const text = ["# A", "````", "```", "# not", "````", "# B", "~~~", "# not either", "~~~", "# C", "```js", "# never closed"].join("\n");
    expect(md.parseSections(text).map((s: Section) => s.title)).toEqual(["A", "B", "C"]);
    expect(md.parseSections("# X\n```inline``` text\n# Y").map((s: Section) => s.title)).toEqual(["X", "Y"]);
  });

  it("counts CRLF lines like LF lines and keeps bodies with \\n", () => {
    const crlf = DOC.replace(/\n/g, "\r\n");
    const a: Section[] = md.parseSections(DOC);
    const b: Section[] = md.parseSections(crlf);
    expect(b).toEqual(a);
  });

  it("handles empty input, text without headings, empty headings and closing #s", () => {
    expect(md.parseSections("")).toEqual([]);
    expect(md.parseSections(undefined)).toEqual([]);
    expect(md.parseSections("just text\nmore")).toEqual([]);
    const s: Section[] = md.parseSections("#\n   ### Indented ###\n    # code block indent is not a heading");
    expect(s.map((x) => [x.title, x.level])).toEqual([
      ["", 1],
      ["Indented", 3],
    ]);
    expect(md.parseSections("####### seven").length).toBe(0);
  });

  /** The original (quadratic) algorithm, as the reference the linear one must match exactly. */
  function reference(text: string): Section[] {
    const raw = md.parseSections(text) as Section[];
    const lines = text.split(/\r?\n/);
    const total = text.endsWith("\n") ? lines.length - 1 : lines.length;
    return raw.map((s, k) => {
      const next = raw.slice(k + 1).find((n) => n.level <= s.level);
      const endLine = next ? next.line - 1 : total;
      const stack: Section[] = [];
      for (const h of raw.slice(0, k + 1)) {
        while (stack.length > 0 && (stack[stack.length - 1] as Section).level >= h.level) stack.pop();
        stack.push(h);
      }
      return { ...s, endLine, path: stack.map((x) => x.title), body: lines.slice(s.line, endLine).join("\n") };
    });
  }

  it("gives the same output as the reference algorithm on random documents", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let doc = 0; doc < 40; doc++) {
      const lines: string[] = [];
      for (let i = 0; i < 120; i++) {
        const k = rand(10);
        if (k < 3) lines.push(`${"#".repeat(1 + rand(6))} Title ${i}`);
        else if (k === 3) lines.push("```", `# fenced ${i}`, "```");
        else if (k === 4) lines.push("");
        else lines.push(`text ${i}`);
      }
      const text = lines.join(rand(2) ? "\n" : "\r\n") + (rand(2) ? "\n" : "");
      expect(md.parseSections(text)).toEqual(reference(text));
    }
  });

  it("is linear: 100,000 headings in under 1.5 s", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100_000; i++) lines.push(`${"#".repeat(1 + (i % 6))} Heading ${i}`, `line ${i}`);
    const flat: string[] = [];
    for (let i = 0; i < 100_000; i++) flat.push(`## Same level ${i}`);
    for (const text of [lines.join("\n"), flat.join("\n")]) {
      const t = performance.now();
      const s = md.parseSections(text);
      const ms = performance.now() - t;
      expect(s).toHaveLength(100_000);
      expect(ms).toBeLessThan(1500);
    }
  });
});

describe("findSection", () => {
  it("prefers an exact title, then a prefix, case-insensitive and ignoring emphasis", () => {
    const text = "# Status report\n## Status\nx\n## Next steps\ny\n## **Open** questions\nz\n";
    expect(md.findSection(text, "status")?.line).toBe(2);
    expect(md.findSection(text, "Next step")?.title).toBe("Next steps");
    expect(md.findSection(text, "open QUESTIONS")?.body).toBe("z");
    expect(md.findSection(text, "Missing")).toBeNull();
    expect(md.findSection(text, "")).toBeNull();
    expect(md.findSection(md.parseSections(text), "Status")?.line).toBe(2);
  });

  it("matches a section with a suffix like a date", () => {
    expect(md.findSection(DOC, "Status")?.title).toBe("Status (2026-11-05)");
  });
});

describe("chunkMarkdown", () => {
  it("never mixes two sections, keeps heading paths and line ranges", () => {
    const chunks = md.chunkMarkdown(DOC, { maxChars: 800 });
    for (const c of chunks) {
      const headings = c.text.split("\n").filter((l: string, i: number) => i > 0 && /^#{1,6} /.test(l) && !l.startsWith("## Next step") && !l.startsWith("## Hidden"));
      expect(headings, c.text).toEqual([]);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
    }
    const next = chunks.find((c: KitModule) => c.text.startsWith("## Next step"));
    expect(next.startLine).toBe(13);
    expect(next.headingPath).toEqual(["Progress", "Next step"]);
    expect(next.text).toContain("Write tests.");
    const fenced = chunks.find((c: KitModule) => c.text.includes("```md"));
    expect(fenced.headingPath).toEqual(["Progress", "Status (2026-11-05)", "Detail"]);
  });

  it("splits at blank lines and keeps every chunk within maxChars", () => {
    const para = (n: number) => `Paragraph ${n} ${"word ".repeat(20)}`.trim();
    const text = ["# Doc", ...Array.from({ length: 30 }, (_, i) => [para(i), ""]).flat()].join("\n");
    const chunks = md.chunkMarkdown(text, { maxChars: 300 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(300);
      expect(c.text.trim()).not.toBe("");
      expect(c.text.startsWith("\n")).toBe(false);
    }
    // Every paragraph is in exactly one chunk.
    for (let i = 0; i < 30; i++) expect(chunks.filter((c: KitModule) => c.text.includes(`Paragraph ${i} `)).length).toBe(1);
    // Line numbers point at the paragraph.
    const lines = text.split("\n");
    for (const c of chunks) expect(lines[c.startLine - 1]).toBe(c.text.split("\n")[0]);
  });

  it("cuts a single line that is too long without splitting a surrogate pair", () => {
    const text = `# T\n${"😀".repeat(500)}`;
    const chunks = md.chunkMarkdown(text, { maxChars: 101 });
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(101);
      expect(/\p{Cs}/u.test(c.text)).toBe(false);
    }
    expect(chunks.map((c: KitModule) => c.text).join("").replace("# T", "")).toBe("😀".repeat(500));
  });

  it("uses CRLF line numbers like LF ones, and enforces the minimum size", () => {
    const lf = md.chunkMarkdown(DOC);
    const crlf = md.chunkMarkdown(DOC.replace(/\n/g, "\r\n"));
    expect(crlf.map((c: KitModule) => [c.startLine, c.endLine])).toEqual(lf.map((c: KitModule) => [c.startLine, c.endLine]));
    for (const c of md.chunkMarkdown("# A\n" + "x".repeat(200), { maxChars: 1 })) expect(c.text.length).toBeLessThanOrEqual(50);
    expect(md.chunkMarkdown("")).toEqual([]);
    expect(md.chunkMarkdown("\n\n\n")).toEqual([]);
  });

  it("splitLines handles both line endings", () => {
    expect(md.splitLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
  });
});
