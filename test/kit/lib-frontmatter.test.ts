// Tests for kit/files/.claude/hermod/lib/frontmatter.mjs: the YAML subset of SKILL.md frontmatter. Malformed
// input gives errors with line numbers, never an exception.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup } from "./helpers.js";
import { loadLib, type KitModule } from "./kit-lib-tests-helpers.js";

let fm: KitModule;
beforeAll(async () => {
  fm = await loadLib("frontmatter");
});
afterAll(cleanup);

const parse = (yaml: string) => fm.parseFrontmatter(`---\n${yaml}\n---\nbody\n`) as { found: boolean; data: KitModule | null; body: string; bodyStartLine: number; errors: string[] };
const ok = (yaml: string) => {
  const r = parse(yaml);
  expect(r.errors, yaml).toEqual([]);
  return r.data as KitModule;
};

describe("splitting", () => {
  it("separates frontmatter and body, with the body's start line", () => {
    const r = fm.parseFrontmatter("---\nname: x\ndescription: y\n---\n# Title\ntext\n");
    expect(r).toEqual({ found: true, data: { name: "x", description: "y" }, body: "# Title\ntext\n", bodyStartLine: 5, errors: [] });
  });

  it("handles CRLF, a BOM, and an empty block", () => {
    const r = fm.parseFrontmatter("\ufeff---\r\nname: crlf\r\ndescription: x\r\n---\r\nbody\r\n");
    expect(r.data).toEqual({ name: "crlf", description: "x" });
    expect(r.body).toBe("body\n");
    expect(r.errors).toEqual([]);
    expect(fm.parseFrontmatter("---\n---\nbody").data).toEqual({});
  });

  it("reports missing and unclosed frontmatter", () => {
    expect(fm.parseFrontmatter("# No frontmatter")).toMatchObject({ found: false, data: null, errors: [] });
    expect(fm.parseFrontmatter("text\n---\nname: x\n---").found).toBe(false);
    const r = fm.parseFrontmatter("---\nname: x\n");
    expect(r.found).toBe(true);
    expect(r.data).toBeNull();
    expect(r.errors[0]).toMatch(/^line 1: the frontmatter is not closed/);
  });

  it("rejects a top-level list or scalar", () => {
    expect(parse("- a\n- b").errors[0]).toContain('must be "key: value" lines');
    const scalar = parse("just a scalar");
    expect(scalar.errors[0]).toMatch(/^line 2: expected "key: value"/);
  });
});

describe("scalars", () => {
  it("resolves plain scalars by the YAML 1.2 core schema", () => {
    expect(ok("a: true\nb: False\nc: null\nd: ~\ne: 42\nf: -1.5e3\ng: 0x1F\nh: 0o17\ni: .inf\nj: 1.0.0\nk: yes\nl: 007")).toEqual({
      a: true,
      b: false,
      c: null,
      d: null,
      e: 42,
      f: -1500,
      g: 31,
      h: 15,
      i: Infinity,
      j: "1.0.0",
      k: "yes",
      l: 7,
    });
    expect(Number.isNaN(ok("n: .nan").n)).toBe(true);
    expect(ok("empty:").empty).toBeNull();
  });

  it("reads quoted strings, also with colons, hashes and escapes", () => {
    expect(ok(`a: "x: y # not a comment"\nb: 'it''s: fine'\nc: "tab\\tnew\\nline \\u00e4\\x41 \\"q\\""\nd: ''`)).toEqual({
      a: "x: y # not a comment",
      b: "it's: fine",
      c: 'tab\tnew\nline äA "q"',
      d: "",
    });
    expect(ok('"quoted key": 1\n\'other: key\': 2')).toEqual({ "quoted key": 1, "other: key": 2 });
  });

  it("strips comments from plain scalars but keeps # inside words", () => {
    expect(ok("a: value # comment\nb: C#-style\nc: x#y")).toEqual({ a: "value", b: "C#-style", c: "x#y" });
  });

  it("folds plain scalars continued on more-indented lines", () => {
    expect(ok("description: First line\n  continues here\n\n  new paragraph\nnext: 1")).toEqual({
      description: "First line continues here\nnew paragraph",
      next: 1,
    });
  });
});

describe("block scalars", () => {
  it("> folds lines into spaces and keeps paragraph breaks (clip chomping)", () => {
    expect(ok("d: >\n  one\n  two\n\n  three\n").d).toBe("one two\nthree\n");
  });

  it("| keeps line breaks and extra indentation", () => {
    expect(ok("d: |\n  a\n    b\n  c\n").d).toBe("a\n  b\nc\n");
  });

  it("chomping: - strips, + keeps every trailing newline, default keeps one", () => {
    const yaml = (h: string) => `d: ${h}\n  text\n\n\nnext: 1`;
    expect(ok(yaml("|")).d).toBe("text\n");
    expect(ok(yaml("|-")).d).toBe("text");
    expect(ok(yaml("|+")).d).toBe("text\n\n\n");
    expect(ok(yaml(">")).d).toBe("text\n");
    expect(ok(yaml(">-")).d).toBe("text");
    expect(ok(yaml(">+")).d).toBe("text\n\n\n");
  });

  it("accepts an indentation digit, and keeps more-indented lines of > literal", () => {
    expect(ok("d: |2-\n    deeper\n  base").d).toBe("  deeper\nbase");
    expect(ok("d: >\n  intro\n    code line\n  outro").d).toBe("intro\n  code line\noutro\n");
  });

  it("ends the block at a less-indented key, and allows a comment after the header", () => {
    expect(ok("a: | # comment\n  x\nb: y")).toEqual({ a: "x\n", b: "y" });
  });

  it("reports a bad header", () => {
    expect(parse("d: |x\n  text").errors[0]).toMatch(/^line 2: block value header/);
  });
});

describe("collections", () => {
  it("reads block lists, lists of maps, nested lists and lists directly under a key", () => {
    expect(ok("tools:\n  - Read\n  - Bash\nsame:\n- a\n- b\nmaps:\n  - name: x\n    n: 1\n  - name: y\nnested:\n  -\n    - deep")).toEqual({
      tools: ["Read", "Bash"],
      same: ["a", "b"],
      maps: [{ name: "x", n: 1 }, { name: "y" }],
      nested: [["deep"]],
    });
  });

  it("reads flow lists", () => {
    expect(ok('a: [Read, "Bash(git:*)", 3, true, \'x, y\']\nb: []')).toEqual({ a: ["Read", "Bash(git:*)", 3, true, "x, y"], b: [] });
  });

  it("reads nested maps by indentation, with comments anywhere", () => {
    expect(ok("# top comment\nmetadata:\n  # inner comment\n  version: \"1.0\"\n  owner:\n    team: core # trailing\n\nlicense: MIT")).toEqual({
      metadata: { version: "1.0", owner: { team: "core" } },
      license: "MIT",
    });
  });
});

describe("malformed input gives errors, never an exception", () => {
  const BAD: Array<[string, RegExp]> = [
    ["a: [unclosed", /line 2: the \[list\] is not closed/],
    ["a: [x, [y]]", /nested lists/],
    ["a: [x,, y]", /empty item/],
    ["a: [x y: z]", /needs quotes/],
    ["a: {b: 1}", /flow map/],
    ["a: &anchor x", /anchor, alias or tag/],
    ["a: *alias", /anchor, alias or tag/],
    ["a: !tag x", /anchor, alias or tag/],
    ["a: @x", /cannot start with "@"/],
    ["a: b: c", /contains ": "/],
    ["a: \"open", /not closed on the same line/],
    ["a: \"bad \\q escape\"", /unknown escape/],
    ["a: \"x\" trailing", /text after the closing quote/],
    ["a: 1\na: 2", /line 3: duplicate key "a"/],
    ["a:\n\t- x", /line 3: indentation uses a tab/],
    ["\tkey: x", /indentation uses a tab/],
    ["a:\n    b: 1\n  c: 2", /line 4: unexpected indentation/],
    ["a: 1\n  b: 2", /contains ": "/],
    ["a: 1\n- x", /cannot appear between/],
    ["not a pair", /expected "key: value"/],
    ["? complex", /expected "key: value"|special character/],
    ["a: - x", /starts with "- "/],
  ];
  for (const [yaml, re] of BAD) {
    it(`reports ${JSON.stringify(yaml)}`, () => {
      let r: ReturnType<typeof parse> | undefined;
      expect(() => (r = parse(yaml))).not.toThrow();
      expect(r?.errors.join("\n")).toMatch(re);
      for (const e of r?.errors ?? []) expect(e).toMatch(/^line \d+: /);
    });
  }

  it("stops at a nesting depth limit instead of overflowing the stack", () => {
    let deep = "";
    for (let i = 0; i < 200; i++) deep += `${" ".repeat(i * 2)}k${i}:\n`;
    const r = parse(deep);
    expect(r.errors.join("\n")).toContain("nested too deeply");
    let lists = "k:\n";
    for (let i = 0; i < 200; i++) lists += `${" ".repeat(i * 2 + 2)}-\n`;
    expect(parse(lists).errors.join("\n")).toContain("nested too deeply");
  });

  it("does not let __proto__ keys pollute objects", () => {
    const data = ok("__proto__:\n  polluted: true\nconstructor: y");
    expect(Object.keys(data)).toEqual(["__proto__", "constructor"]);
    expect(({} as KitModule).polluted).toBeUndefined();
  });

  it("caps the number of errors and never throws on random input", () => {
    const many = Array.from({ length: 200 }, (_, i) => `bad line ${i}`).join("\n");
    expect(parse(many).errors.length).toBeLessThanOrEqual(50);
    let seed = 11;
    const alphabet = ["a", ":", " ", "-", "\n", "'", '"', "[", "]", "{", "#", "|", ">", "\t", "&", "*", "  ", "\\", "é", "😀"];
    for (let n = 0; n < 300; n++) {
      let s = "";
      for (let i = 0; i < 80; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        s += alphabet[seed % alphabet.length];
      }
      expect(() => fm.parseFrontmatter(`---\n${s}\n---\n`)).not.toThrow();
      const r = fm.parseFrontmatter(`---\n${s}\n---\n`);
      expect(Array.isArray(r.errors)).toBe(true);
    }
    expect(() => fm.parseFrontmatter(undefined)).not.toThrow();
    expect(() => fm.parseYamlLines(["a: 1", "  - x", "b"], 1)).not.toThrow();
  });
});
