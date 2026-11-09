// Tests for kit/files/.claude/hermod/lib/io.mjs: stdin with a timeout, fail-open hooks, the capped error log,
// truncation that never splits a character, and the self-ignoring .local folder.
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, makeRepo, runNode, tempDir } from "./helpers.js";
import { collector, isGraphemePrefix, isGraphemeSuffix, loadLib, type KitModule } from "./kit-lib-tests-helpers.js";

let io: KitModule;
beforeAll(async () => {
  io = await loadLib("io");
});
afterAll(cleanup);

const LONE_SURROGATE = /\p{Cs}/u;
const FAMILY = "👨‍👩‍👧"; // man ZWJ woman ZWJ girl: 8 UTF-16 units, one grapheme
const E_ACUTE = "é"; // e + combining acute accent: 2 units, one grapheme

describe("readStdinText / readStdinJson", () => {
  it("reads all input", async () => {
    const s = new PassThrough();
    const p = io.readStdinText({ stream: s, timeoutMs: 1000 });
    s.write('{"a":');
    s.end("1}");
    expect(await p).toEqual({ text: '{"a":1}', timedOut: false, tooLarge: false });
  });

  it("gives up after timeoutMs when stdin never closes", async () => {
    const s = new PassThrough();
    s.write("partial");
    const started = Date.now();
    const r = await io.readStdinText({ stream: s, timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
    expect(r.text).toBe("partial");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("returns at once for a terminal", async () => {
    const s = Object.assign(new PassThrough(), { isTTY: true });
    expect(await io.readStdinText({ stream: s, timeoutMs: 5000 })).toEqual({ text: "", timedOut: false, tooLarge: false });
  });

  it("stops at maxBytes", async () => {
    const s = new PassThrough();
    const p = io.readStdinText({ stream: s, maxBytes: 10, timeoutMs: 1000 });
    s.write("0123456789abcdef");
    expect((await p).tooLarge).toBe(true);
  });

  it("parses JSON objects, gives {} for empty input, and throws plain errors otherwise", async () => {
    const feed = (text: string) => {
      const s = new PassThrough();
      setImmediate(() => s.end(text));
      return { stream: s, timeoutMs: 1000 };
    };
    expect(await io.readStdinJson(feed('\ufeff {"session_id":"x"} \n'))).toEqual({ session_id: "x" });
    expect(await io.readStdinJson(feed("   "))).toEqual({});
    await expect(io.readStdinJson(feed("not json"))).rejects.toThrow(/not valid JSON/);
    await expect(io.readStdinJson(feed("[1,2]"))).rejects.toThrow(/must be a JSON object/);
    await expect(io.readStdinJson(feed("null"))).rejects.toThrow(/must be a JSON object/);
  });
});

describe("failOpen (in a real node process)", () => {
  /** A script inside the repo's .claude/hermod/ that runs failOpen with the given main body. */
  function hookScript(repo: ReturnType<typeof makeRepo>, body: string, options = "{}"): string {
    const file = repo.kitPath("test-hook.mjs");
    writeFileSync(
      file,
      `import { failOpen } from "./lib/io.mjs";\nfailOpen(async (ctx) => { ctx.root = process.env.CLAUDE_PROJECT_DIR; ${body} }, { context: "test-hook", ...${options} });\n`,
    );
    return file;
  }
  const errorsLog = (repo: ReturnType<typeof makeRepo>) => repo.read(".claude/hermod/.local/errors.log") ?? "";

  it("prints the return value on success", () => {
    const repo = makeRepo({ git: false });
    const r = runNode(hookScript(repo, 'return { decision: "block", reason: "x" };'), { env: { CLAUDE_PROJECT_DIR: repo.root } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ decision: "block", reason: "x" });
    expect(errorsLog(repo)).toBe("");
  });

  it("exits 0 with no output and logs one redacted line when main throws", () => {
    const repo = makeRepo({ git: false });
    const token = `ghp_${"A1b2C3d4E5".repeat(4)}`;
    const r = runNode(hookScript(repo, `throw new Error("boom with ${token}");`), { env: { CLAUDE_PROJECT_DIR: repo.root } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const log = errorsLog(repo);
    expect(log).toContain("[test-hook] Error: boom with");
    expect(log).not.toContain(token);
    expect(log).toContain("[REDACTED:github-token]");
    expect(log.trim().split("\n")).toHaveLength(1);
    expect(repo.read(".claude/hermod/.local/.gitignore")).toBe("*\n");
  });

  it("exits 0 when the error is thrown later, outside the promise (uncaught exception)", () => {
    const repo = makeRepo({ git: false });
    const r = runNode(hookScript(repo, 'setTimeout(() => { throw new Error("late"); }, 10); await new Promise((r) => setTimeout(r, 2000)); return "never";'), {
      env: { CLAUDE_PROJECT_DIR: repo.root },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(errorsLog(repo)).toContain("late");
  });

  it("exits 0 with no output when main hangs past the watchdog", () => {
    const repo = makeRepo({ git: false });
    const r = runNode(hookScript(repo, "await new Promise(() => setInterval(() => {}, 1000));", "{ timeoutMs: 300 }"), {
      env: { CLAUDE_PROJECT_DIR: repo.root },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.durationMs).toBeLessThan(5000);
    expect(errorsLog(repo)).toContain("timed out after 300 ms");
  });

  it("does not create anything when the kit is not installed", async () => {
    const dir = tempDir();
    const out = collector();
    const r = await io.failOpen(
      () => {
        throw new Error("x");
      },
      { root: dir, exit: false, stdout: out.stream },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Error: x");
    expect(out.text()).toBe("");
    expect(existsSync(path.join(dir, ".claude"))).toBe(false);
  });

  it("returns ok with the rendered output (in-process)", async () => {
    const out = collector();
    const r = await io.failOpen(() => "hello", { root: tempDir(), exit: false, stdout: out.stream });
    expect(r).toEqual({ ok: true, output: "hello", error: null });
    expect(out.text()).toBe("hello");
  });
});

describe("logError", () => {
  it("keeps errors.log at or below 100 KB, dropping the oldest lines first", () => {
    const repo = makeRepo({ git: false });
    for (let i = 0; i < 400; i++) io.logError(repo.root, new Error(`error number ${i} ${"x".repeat(500)}`), "t");
    const file = repo.abs(".claude/hermod/.local/errors.log");
    expect(statSync(file).size).toBeLessThanOrEqual(io.ERROR_LOG_MAX_BYTES);
    expect(io.ERROR_LOG_MAX_BYTES).toBe(100 * 1024);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("error number 399 ");
    expect(text).not.toContain("error number 0 ");
    // Every line is whole: it starts with a timestamp.
    for (const line of text.trimEnd().split("\n")) expect(line).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("cuts one huge error to a single line and never throws", () => {
    const repo = makeRepo({ git: false });
    expect(() => io.logError(repo.root, `a\nb ${"y".repeat(10_000)}`, "t", { maxBytes: 1000 })).not.toThrow();
    const text = repo.read(".claude/hermod/.local/errors.log") ?? "";
    expect(text.split("\n").filter(Boolean)).toHaveLength(1);
    expect(text.length).toBeLessThanOrEqual(2001);
    expect(text).toContain("a | b");
    expect(() => io.logError(path.join(tempDir(), "missing"), new Error("x"))).not.toThrow();
  });
});

describe("ensureLocalDir", () => {
  it("creates .local with a .gitignore of '*' that git honours", () => {
    const repo = makeRepo();
    const dir = io.ensureLocalDir(repo.root);
    expect(dir).toBe(repo.abs(".claude/hermod/.local"));
    expect(repo.read(".claude/hermod/.local/.gitignore")).toBe("*\n");
    repo.write(".claude/hermod/.local/ledger.jsonl", "{}\n");
    expect(repo.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("repairs a .gitignore without '*' and keeps one that has it", () => {
    const repo = makeRepo({ git: false });
    repo.write(".claude/hermod/.local/.gitignore", "other\n");
    io.ensureLocalDir(repo.root);
    expect(repo.read(".claude/hermod/.local/.gitignore")).toBe("*\n");
    repo.write(".claude/hermod/.local/.gitignore", "# mine\r\n*\r\n");
    io.ensureLocalDir(repo.root);
    expect(repo.read(".claude/hermod/.local/.gitignore")).toBe("# mine\r\n*\r\n");
  });

  it("refuses when the kit is missing, or .local is a symlink out of the repository", () => {
    expect(() => io.ensureLocalDir(tempDir())).toThrow(/not installed/);
    const repo = makeRepo({ git: false });
    const outside = tempDir();
    symlinkSync(outside, repo.abs(".claude/hermod/.local"), "dir");
    expect(() => io.ensureLocalDir(repo.root)).toThrow(/outside the repository/);
    expect(existsSync(path.join(outside, ".gitignore"))).toBe(false);
  });
});

describe("readText / readJson / writeFileAtomic / appendLine", () => {
  it("returns null for missing files and folders, strips a BOM, and caps the size on a character boundary", () => {
    const dir = tempDir();
    expect(io.readText(path.join(dir, "nope"))).toBeNull();
    expect(io.readText(dir)).toBeNull();
    const f = path.join(dir, "a.txt");
    writeFileSync(f, "\ufeffhéllo");
    expect(io.readText(f)).toBe("héllo");
    writeFileSync(f, "ab€cd"); // € is 3 bytes in UTF-8
    expect(io.readText(f, { maxBytes: 3 })).toBe("ab");
  });

  it("readJson reports missing files and invalid JSON without throwing", () => {
    const dir = tempDir();
    expect(io.readJson(path.join(dir, "x.json"))).toEqual({ found: false, value: null, error: null });
    writeFileSync(path.join(dir, "bad.json"), "{");
    const r = io.readJson(path.join(dir, "bad.json"));
    expect(r.found).toBe(true);
    expect(r.error).toMatch(/not valid JSON/);
  });

  it("writes atomically (creating folders) and appends lines", () => {
    const dir = tempDir();
    const f = path.join(dir, "a", "b", "c.txt");
    io.writeFileAtomic(f, "one");
    io.writeFileAtomic(f, "two");
    expect(readFileSync(f, "utf8")).toBe("two");
    io.appendLine(path.join(dir, "l.jsonl"), "x");
    io.appendLine(path.join(dir, "l.jsonl"), "y\n");
    expect(readFileSync(path.join(dir, "l.jsonl"), "utf8")).toBe("x\ny\n");
    mkdirSync(path.join(dir, "isdir"));
    expect(() => io.writeFileAtomic(path.join(dir, "isdir"), "x")).toThrow(/could not write/);
  });
});

describe("resolveRoot", () => {
  it("prefers --root, then CLAUDE_PROJECT_DIR, then the hook input's cwd, then cwd", () => {
    const cwd = tempDir();
    expect(io.resolveRoot({ root: "sub", cwd, env: { CLAUDE_PROJECT_DIR: "/x" } })).toBe(path.join(cwd, "sub"));
    expect(io.resolveRoot({ cwd, env: { CLAUDE_PROJECT_DIR: path.join(cwd, "p") }, input: { cwd: "/y" } })).toBe(path.join(cwd, "p"));
    expect(io.resolveRoot({ cwd, env: {}, input: { cwd: path.join(cwd, "q") } })).toBe(path.join(cwd, "q"));
    expect(io.resolveRoot({ cwd, env: { CLAUDE_PROJECT_DIR: "  " }, input: { cwd: 5 } })).toBe(cwd);
  });

  it("uses the git top level with useGit", () => {
    const repo = makeRepo({ files: { "a/b/x.txt": "x" } });
    expect(io.resolveRoot({ cwd: repo.abs("a/b"), env: {}, useGit: true })).toBe(repo.root);
  });
});

describe("truncation", () => {
  it("leaves text that fits unchanged, and handles zero and negative limits", () => {
    expect(io.truncateChars("abc", 3)).toBe("abc");
    expect(io.truncateChars("abc", 0)).toBe("");
    expect(io.truncateHead("abc", -1)).toBe("");
    expect(io.truncateTail("abc", 0)).toBe("");
    expect(io.truncateChars(null, 5)).toBe("");
  });

  it("truncateChars counts the ellipsis toward the limit", () => {
    expect(io.truncateChars("abcdefgh", 5)).toBe("abcd…");
    expect(io.truncateChars("abcd efgh", 6, "...")).toBe("abc...");
    expect(io.truncateChars("abcdef", 2, "...")).toBe("ab");
  });

  it("never splits a surrogate pair", () => {
    const s = "😀".repeat(50);
    for (let max = 1; max < 60; max++) {
      for (const out of [io.truncateChars(s, max), io.truncateHead(s, max), io.truncateTail(s, max), io.truncateHead(s, max, { marker: "\n…" })]) {
        expect(LONE_SURROGATE.test(out), `max ${max}: ${JSON.stringify(out)}`).toBe(false);
        expect(out.length).toBeLessThanOrEqual(max);
      }
    }
    expect(io.safeEnd("a😀", 2)).toBe(1);
    expect(io.safeStart("😀a", 1)).toBe(2);
  });

  it("never splits a letter from its combining mark, or a ZWJ emoji family (grapheme-safe)", () => {
    const texts = [E_ACUTE.repeat(40), FAMILY.repeat(20), `ab ${FAMILY} cd ${E_ACUTE}${E_ACUTE} ${FAMILY}${E_ACUTE} 🇸🇪🇸🇪 x`.repeat(5)];
    for (const s of texts) {
      for (let max = 1; max <= s.length; max++) {
        const head = io.truncateHead(s, max, { preferLines: false });
        expect(head.length).toBeLessThanOrEqual(max);
        expect(isGraphemePrefix(s, head), `head ${max}: ${JSON.stringify(head)}`).toBe(true);
        const chars = io.truncateChars(s, max, "…");
        expect(chars.length).toBeLessThanOrEqual(max);
        const kept = chars.endsWith("…") && chars !== s ? chars.slice(0, -1) : chars;
        expect(isGraphemePrefix(s, kept) || isGraphemePrefix(s.trimEnd(), kept), `chars ${max}: ${JSON.stringify(chars)}`).toBe(true);
        const tail = io.truncateTail(s, max, { preferLines: false });
        expect(tail.length).toBeLessThanOrEqual(max);
        expect(isGraphemeSuffix(s, tail), `tail ${max}: ${JSON.stringify(tail)}`).toBe(true);
      }
    }
    expect(io.truncateChars(`${E_ACUTE}${E_ACUTE}${E_ACUTE}`, 4)).toBe(`${E_ACUTE}…`);
    expect(io.truncateChars(`ab${FAMILY}cd`, 6)).toBe("ab…");
    expect(io.truncateTail(`ab${FAMILY}`, 7, { preferLines: false })).toBe("");
    expect(io.truncateTail(`ab${FAMILY}`, 8, { preferLines: false })).toBe(FAMILY);
  });

  it("graphemeEnd / graphemeStart find cluster boundaries, and fall back safely for huge clusters", () => {
    const s = `x${E_ACUTE}${FAMILY}y`;
    expect(io.graphemeEnd(s, 2)).toBe(1);
    expect(io.graphemeStart(s, 2)).toBe(3);
    expect(io.graphemeEnd(s, 7)).toBe(3);
    expect(io.graphemeStart(s, 7)).toBe(11);
    expect(io.graphemeEnd(s, 11)).toBe(11);
    // A cluster longer than the search window (zalgo text): still never a lone surrogate.
    const zalgo = `a${"́".repeat(5000)}😀b`;
    const cut = io.truncateChars(zalgo, 3000);
    expect(LONE_SURROGATE.test(cut)).toBe(false);
    expect(cut.length).toBeLessThanOrEqual(3000);
  });

  it("prefers a line boundary, then a space, when that keeps at least half", () => {
    const text = "first line here\nsecond line is longer than the budget";
    expect(io.truncateHead(text, 30)).toBe("first line here");
    expect(io.truncateHead(text, 30, { marker: "\n…" })).toBe("first line here\n…");
    expect(io.truncateHead("word word word word", 12)).toBe("word word");
    expect(io.truncateHead("abcdefghij\nk", 8)).toBe("abcdefgh");
    expect(io.truncateTail("old one\nold two\nnew three\nnew four", 22)).toBe("new three\nnew four");
    expect(io.truncateTail("old one\nold two\nnew three\nnew four", 22, { marker: "…\n" })).toBe("…\nnew three\nnew four");
    expect(io.truncateHead("a\r\nb\r\nccccccccccccc", 6)).toBe("a\r\nb");
  });

  it("is fast on huge text", () => {
    const big = `${"line with ä and 😀 and é\n".repeat(400_000)}`;
    const t = performance.now();
    for (let i = 0; i < 20; i++) {
      io.truncateHead(big, 5000);
      io.truncateTail(big, 2000);
      io.truncateChars(big, 1000);
    }
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("small helpers", () => {
  it("isPlainObject, stripBom, formatError, hermodPath", () => {
    expect(io.isPlainObject({})).toBe(true);
    expect(io.isPlainObject([])).toBe(false);
    expect(io.isPlainObject(null)).toBe(false);
    expect(io.stripBom("\ufeffx")).toBe("x");
    expect(io.formatError(new TypeError("bad\nthing"))).toMatch(/^TypeError: bad \| thing/);
    expect(io.formatError("plain")).toBe("plain");
    expect(io.hermodPath("/r", "a", "b")).toBe(path.join(path.resolve("/r"), ".claude", "hermod", "a", "b"));
    expect(io.LOCAL_DIR).toBe(".claude/hermod/.local");
  });
});
