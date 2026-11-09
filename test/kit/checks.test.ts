// Tests for the check runner (kit/files/.claude/hermod/lib/checks.mjs) and its CLI (check.mjs):
// shape validation, fake contexts, running checks in worker threads with timeouts, the self-test and exit codes.
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, KIT_FILES, makeRepo, runNode, tempDir, type Files, type Repo } from "./helpers.js";

const FIXTURE = readFileSync(fileURLToPath(new URL("./fixtures/checks/no-console-log.mjs", import.meta.url)), "utf8");
const CHECKS_DIR = ".claude/hermod/checks";

// ------------------------------------------------------------------------------------------ the lib's types

interface GitResultLike {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}
interface Ctx {
  root: string;
  base: string | null;
  changedFiles: readonly string[];
  read(p: string): string | null;
  readAt(ref: string, p: string): string | null;
  diff(p: string): string;
  git(args: string[]): GitResultLike;
}
type Status = "pass" | "fail" | "error" | "skip";
interface CheckResult {
  id: string;
  file: string;
  description: string;
  level: "error" | "warn";
  status: Status;
  ok: boolean;
  message: string | null;
  durationMs: number;
}
interface RunReport {
  dir: string;
  base: string | null;
  changedFiles: string[];
  results: CheckResult[];
  errors: string[];
}
interface ExampleResult {
  check: string;
  index: number;
  name: string;
  expect: boolean;
  actual: boolean | null;
  ok: boolean;
  message: string | null;
}
interface SelfTestReport {
  dir: string;
  checks: { id: string; file: string; valid: boolean; errors: string[]; examples: ExampleResult[] }[];
  errors: string[];
  failures: number;
  ok: boolean;
}
interface ChecksLib {
  CHECK_TIMEOUT_MS: number;
  validateCheck(check: unknown, id: string): string[];
  makeFakeContext(ctx: unknown, root?: string): Ctx;
  makeContext(root: string, base: string | null, changed: string[]): Ctx;
  simpleDiff(rel: string, before: string | null, after: string | null): string;
  normalizeOutcome(v: unknown): { status: Status; message: string | null };
  whenMatches(when: unknown, changed: string[]): boolean;
  listCheckFiles(root: string, dir?: string): { dir: string; files: { id: string; rel: string }[]; errors: string[] };
  runChecks(root: string, options?: Record<string, unknown>): Promise<RunReport>;
  selfTest(root: string, options?: Record<string, unknown>): Promise<SelfTestReport>;
  blockingFailures(results: CheckResult[]): CheckResult[];
}

let lib: ChecksLib;
beforeAll(async () => {
  lib = (await import(pathToFileURL(path.join(KIT_FILES, ".claude/hermod/lib/checks.mjs")).href)) as ChecksLib;
});
afterAll(() => cleanup());

// ------------------------------------------------------------------------------------------------ helpers

/** A check module's source. `run` and `extra` are spliced in as code. */
function checkSource(id: string, opts: { level?: string; run?: string; when?: string[]; top?: string; examples?: string } = {}): string {
  const examples =
    opts.examples ??
    `[
      { name: "passes", ctx: { changedFiles: [] }, expect: true },
      { name: "fails", ctx: { changedFiles: ["src/x.ts"] }, expect: false },
    ]`;
  return `// @ts-check
${opts.top ?? ""}
export default {
  id: ${JSON.stringify(id)},
  description: "test check ${id}",
  level: ${JSON.stringify(opts.level ?? "error")},
  ${opts.when ? `when: ${JSON.stringify(opts.when)},` : ""}
  run(ctx) { ${opts.run ?? "return { ok: true };"} },
  examples: ${examples},
};
`;
}

function repoWithChecks(checks: Record<string, string>, files: Files = {}): Repo {
  const all: Files = { "src/app.ts": "export const a = 1;\n", ...files };
  for (const [name, src] of Object.entries(checks)) all[`${CHECKS_DIR}/${name}`] = src;
  return makeRepo({ files: all });
}

function byId(report: RunReport, id: string): CheckResult {
  const r = report.results.find((x) => x.id === id);
  if (!r) throw new Error(`no result for ${id}: ${JSON.stringify(report.results)}`);
  return r;
}

function cli(repo: Repo, args: string[] = [], timeoutMs?: number) {
  return runNode(repo.kitPath("check.mjs"), { cwd: repo.root, args: ["--root", repo.root, ...args], timeoutMs });
}

const validCheck = () => ({
  id: "x",
  description: "d",
  level: "error",
  run: () => ({ ok: true }),
  examples: [
    { name: "a", ctx: { changedFiles: [] }, expect: true },
    { name: "b", ctx: { changedFiles: ["src/a"] }, expect: false },
  ],
});

// ------------------------------------------------------------------------------------------- validation

describe("validateCheck", () => {
  it("accepts a complete check, with or without ctx and when", () => {
    expect(lib.validateCheck(validCheck(), "x")).toEqual([]);
    expect(lib.validateCheck({ ...validCheck(), when: ["src/", "**/*.sql"] }, "x")).toEqual([]);
    const noCtx = { ...validCheck(), examples: [{ name: "a", expect: true }, { name: "b", expect: false }] };
    expect(lib.validateCheck(noCtx, "x")).toEqual([]);
  });

  it("requires the id to equal the file name", () => {
    expect(lib.validateCheck(validCheck(), "other").join()).toMatch(/"id" is "x" but the file is other\.mjs/);
    expect(lib.validateCheck({ ...validCheck(), id: "" }, "x").join()).toMatch(/"id" must be text/);
  });

  it.each([
    ["description missing", { description: undefined }, /"description"/],
    ["description blank", { description: "  " }, /"description"/],
    ["level wrong", { level: "fatal" }, /"level" must be "error" or "warn"/],
    ["level missing", { level: undefined }, /"level"/],
    ["run not a function", { run: "return true" }, /"run" must be a function/],
    ["examples missing", { examples: undefined }, /"examples" must be a list/],
    ["when empty", { when: [] }, /"when" must be a non-empty list/],
    ["when not a list", { when: "src/" }, /"when" must be a non-empty list/],
    ["when absolute", { when: ["/etc/passwd"] }, /unusable pattern.*absolute/],
    ["when with ..", { when: ["../x"] }, /unusable pattern/],
  ])("rejects a check with %s", (_label, patch, message) => {
    const errors = lib.validateCheck({ ...validCheck(), ...patch }, "x");
    expect(errors.join("\n")).toMatch(message);
  });

  it("requires at least one passing and one failing example", () => {
    const onlyPass = { ...validCheck(), examples: [{ name: "a", expect: true }] };
    expect(lib.validateCheck(onlyPass, "x").join()).toMatch(/at least one example with expect: false/);
    const onlyFail = { ...validCheck(), examples: [{ name: "a", expect: false }] };
    expect(lib.validateCheck(onlyFail, "x").join()).toMatch(/at least one example with expect: true/);
    expect(lib.validateCheck({ ...validCheck(), examples: [] }, "x").length).toBe(2);
  });

  it("rejects malformed examples", () => {
    const bad = (ex: unknown) => lib.validateCheck({ ...validCheck(), examples: [...validCheck().examples, ex] }, "x").join("\n");
    expect(bad("nope")).toMatch(/examples\[2\] must be an object/);
    expect(bad({ name: "", expect: true })).toMatch(/examples\[2\] needs a "name"/);
    expect(bad({ name: "n", expect: "yes" })).toMatch(/examples\[2\] "expect" must be true/);
    expect(bad({ name: "n", expect: true, ctx: [] })).toMatch(/"ctx" must be an object/);
    expect(bad({ name: "n", expect: true, ctx: { changedFiles: "src/a" } })).toMatch(/ctx.changedFiles must be a list/);
    expect(bad({ name: "n", expect: true, ctx: { changedFiles: [1] } })).toMatch(/ctx.changedFiles must be a list/);
    expect(bad({ name: "n", expect: true, ctx: { files: { a: 1 } } })).toMatch(/ctx.files must map paths to text/);
    expect(bad({ name: "n", expect: true, ctx: { baseFiles: "x" } })).toMatch(/ctx.baseFiles must map paths to text/);
    expect(bad({ name: "n", expect: true, ctx: { base: 3 } })).toMatch(/ctx.base must be text/);
  });

  it("rejects something that is not a check object", () => {
    for (const v of [undefined, null, 3, "x", [], () => ({ ok: true })]) {
      expect(lib.validateCheck(v, "x").join()).toMatch(/must export a check object/);
    }
  });
});

describe("fake contexts and outcomes", () => {
  it("serves files, baseFiles and a diff, and has no git", () => {
    const ctx = lib.makeFakeContext({
      changedFiles: ["./src\\a.ts", "src/new.ts"],
      files: { "src/a.ts": "one\ntwo\n", "src/new.ts": "n\n" },
      baseFiles: { "src/a.ts": "one\n", "src/gone.ts": "g\n" },
    });
    expect(ctx.changedFiles).toEqual(["src/a.ts", "src/new.ts"]);
    expect(Object.isFrozen(ctx.changedFiles)).toBe(true);
    expect(ctx.read("src/a.ts")).toBe("one\ntwo\n");
    expect(ctx.read("./src/a.ts")).toBe("one\ntwo\n");
    expect(ctx.read("src/missing.ts")).toBeNull();
    expect(ctx.readAt("HEAD", "src/a.ts")).toBe("one\n");
    expect(ctx.readAt("anything", "src/new.ts")).toBeNull();
    expect(ctx.base).toBe("HEAD");
    const d = ctx.diff("src/a.ts");
    expect(d).toContain("--- a/src/a.ts");
    expect(d).toContain("+two");
    expect(d).toContain("-one");
    expect(ctx.diff("src/new.ts")).toMatch(/--- \/dev\/null[\s\S]*\+n/);
    expect(ctx.diff("src/gone.ts")).toMatch(/\+\+\+ \/dev\/null[\s\S]*-g/);
    expect(ctx.diff("src/missing.ts")).toBe("");
    const g = ctx.git(["status"]);
    expect(g.ok).toBe(false);
    expect(g.error).toMatch(/not available/);
  });

  it("copes with a missing or odd ctx", () => {
    const ctx = lib.makeFakeContext(undefined);
    expect(ctx.changedFiles).toEqual([]);
    expect(ctx.read("a")).toBeNull();
    expect(lib.makeFakeContext({ base: "main" }).base).toBe("main");
    expect(lib.simpleDiff("a", "x\n", "x\n")).toBe("");
  });

  it("normalizes what run() returns", () => {
    expect(lib.normalizeOutcome({ ok: true })).toEqual({ status: "pass", message: null });
    expect(lib.normalizeOutcome({ ok: false, message: "bad" })).toEqual({ status: "fail", message: "bad" });
    expect(lib.normalizeOutcome({ ok: false })).toEqual({ status: "fail", message: "failed (no message given)" });
    for (const v of [true, false, undefined, null, "ok", { ok: "yes" }, 1]) {
      const r = lib.normalizeOutcome(v);
      expect(r.status).toBe("error");
      expect(r.message).toMatch(/must return \{ ok: true \}/);
    }
    const long = lib.normalizeOutcome({ ok: false, message: "x".repeat(5000) });
    expect(long.message!.length).toBeLessThanOrEqual(500);
  });

  it("applies when lists with the shared matcher", () => {
    expect(lib.whenMatches(undefined, [])).toBe(true);
    expect(lib.whenMatches(["public/sw.js"], ["public/sw.js"])).toBe(true);
    expect(lib.whenMatches(["public/sw.js"], ["public/other.js"])).toBe(false);
    expect(lib.whenMatches(["src/"], ["src/a/b.ts"])).toBe(true);
    expect(lib.whenMatches(["**/*.sql"], ["db/m/1.sql"])).toBe(true);
    expect(lib.whenMatches(["src/"], [])).toBe(false);
  });
});

describe("listCheckFiles", () => {
  it("lists *.mjs in the folder, sorted, without helpers, hidden files or other types", () => {
    const root = tempDir();
    const dir = path.join(root, ".claude/hermod/checks");
    mkdirSync(path.join(dir, "nested"), { recursive: true });
    for (const f of ["b.mjs", "a.mjs", "_helper.mjs", ".hidden.mjs", "README.md", "c.js", "nested/d.mjs"]) {
      writeFileSync(path.join(dir, f), "export default {}");
    }
    const r = lib.listCheckFiles(root);
    expect(r.files.map((f) => f.id)).toEqual(["a", "b"]);
    expect(r.files[0]!.rel).toBe(".claude/hermod/checks/a.mjs");
    expect(r.errors).toEqual([]);
  });

  it("returns nothing for a missing folder and refuses a bad dir", () => {
    const root = tempDir();
    expect(lib.listCheckFiles(root)).toEqual({ dir: ".claude/hermod/checks", files: [], errors: [] });
    expect(lib.listCheckFiles(root, "../elsewhere").errors.join()).toMatch(/not a path inside the repository/);
  });

  it("refuses a check file that is a symlink to outside the repository", () => {
    const outside = tempDir();
    writeFileSync(path.join(outside, "evil.mjs"), checkSource("evil"));
    const root = tempDir();
    const dir = path.join(root, ".claude/hermod/checks");
    mkdirSync(dir, { recursive: true });
    symlinkSync(path.join(outside, "evil.mjs"), path.join(dir, "evil.mjs"));
    writeFileSync(path.join(dir, "fine.mjs"), checkSource("fine"));
    const r = lib.listCheckFiles(root);
    expect(r.files.map((f) => f.id)).toEqual(["fine"]);
    expect(r.errors.join()).toMatch(/evil\.mjs leads outside the repository/);
  });

  it("refuses a checks folder that is a symlink to outside the repository", () => {
    const outside = tempDir();
    writeFileSync(path.join(outside, "evil.mjs"), checkSource("evil"));
    const root = tempDir();
    mkdirSync(path.join(root, ".claude/hermod"), { recursive: true });
    symlinkSync(outside, path.join(root, ".claude/hermod/checks"));
    const r = lib.listCheckFiles(root);
    expect(r.files).toEqual([]);
    expect(r.errors.join()).toMatch(/leads outside the repository/);
  });
});

// ---------------------------------------------------------------------------------------------- running

describe("runChecks", () => {
  it("runs the example check with a real context: fails on an added console.log, passes otherwise", async () => {
    const repo = repoWithChecks({ "no-console-log.mjs": FIXTURE });
    const base = repo.git("rev-parse", "HEAD");
    repo.write("src/app.ts", 'export const a = 1;\nconsole.log("debug");\n');
    let report = await lib.runChecks(repo.root, { base, changedFiles: ["src/app.ts"] });
    let r = byId(report, "no-console-log");
    expect(r.status).toBe("fail");
    expect(r.ok).toBe(false);
    expect(r.message).toBe("console.log added in src/app.ts");
    expect(r.level).toBe("error");
    expect(r.description).toMatch(/console\.log/);
    expect(lib.blockingFailures(report.results)).toHaveLength(1);

    repo.write("src/app.ts", 'export const a = 1;\nlog.info("x");\n');
    report = await lib.runChecks(repo.root, { base, changedFiles: ["src/app.ts"] });
    r = byId(report, "no-console-log");
    expect(r.status).toBe("pass");
    expect(lib.blockingFailures(report.results)).toEqual([]);

    // A new, untracked file is diffed as fully added.
    repo.write("src/new.ts", 'console.log("new");\n');
    report = await lib.runChecks(repo.root, { base, changedFiles: ["src/app.ts", "src/new.ts"] });
    expect(byId(report, "no-console-log").message).toBe("console.log added in src/new.ts");
  });

  it("skips a check whose when list matches no changed file", async () => {
    const repo = repoWithChecks({ "no-console-log.mjs": FIXTURE });
    repo.write("src/app.ts", 'console.log("x");\n');
    const report = await lib.runChecks(repo.root, { base: "HEAD", changedFiles: ["docs/a.md"] });
    const r = byId(report, "no-console-log");
    expect(r.status).toBe("skip");
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/"when"/);
  });

  it("gives checks root, base, changedFiles, read, readAt, diff and git", async () => {
    const run = `
      const head = ctx.git(["rev-parse", "HEAD"]);
      const bad = ctx.git(["no-such-command"]);
      const facts = {
        root: ctx.root, base: ctx.base, changed: ctx.changedFiles,
        now: ctx.read("src/app.ts"), then: ctx.readAt(ctx.base, "src/app.ts"), missing: ctx.read("nope.txt"),
        escape: ctx.read("../outside.txt"),
        diffHasPlus: ctx.diff("src/app.ts").includes("+export const a = 2;"),
        head: head.ok ? head.stdout.trim() : null, badOk: bad.ok, frozen: Object.isFrozen(ctx.changedFiles),
      };
      return { ok: false, message: JSON.stringify(facts) };`;
    const repo = repoWithChecks({ "facts.mjs": checkSource("facts", { run }) });
    const base = repo.git("rev-parse", "HEAD");
    repo.write("src/app.ts", "export const a = 2;\n");
    const report = await lib.runChecks(repo.root, { base, changedFiles: ["src/app.ts"] });
    const facts = JSON.parse(byId(report, "facts").message!);
    expect(facts).toEqual({
      root: path.resolve(repo.root),
      base,
      changed: ["src/app.ts"],
      now: "export const a = 2;\n",
      then: "export const a = 1;\n",
      missing: null,
      escape: null,
      diffHasPlus: true,
      head: base,
      badOk: false,
      frozen: true,
    });
  });

  it("reports a check that throws, returns garbage, rejects or exits as an error", async () => {
    const repo = repoWithChecks({
      "throws.mjs": checkSource("throws", { run: 'throw new Error("boom");' }),
      "garbage.mjs": checkSource("garbage", { run: "return 42;" }),
      "rejects.mjs": checkSource("rejects", { run: 'return Promise.reject(new Error("async boom"));' }),
      "exits.mjs": checkSource("exits", { run: "process.exit(0);" }),
      "exits3.mjs": checkSource("exits3", { run: "process.exit(3);" }),
      "async-ok.mjs": checkSource("async-ok", { run: "return new Promise((r) => setTimeout(() => r({ ok: true }), 20));" }),
    });
    const report = await lib.runChecks(repo.root, { base: "HEAD", changedFiles: ["src/app.ts"] });
    expect(byId(report, "throws")).toMatchObject({ status: "error", ok: false, message: "threw: boom" });
    expect(byId(report, "garbage").status).toBe("error");
    expect(byId(report, "garbage").message).toMatch(/returned 42/);
    expect(byId(report, "rejects")).toMatchObject({ status: "error", message: "threw: async boom" });
    expect(byId(report, "exits").status).toBe("error");
    expect(byId(report, "exits").message).toMatch(/before returning a result/);
    expect(byId(report, "exits3").message).toBe("exited with code 3 before returning a result");
    expect(byId(report, "async-ok").status).toBe("pass");
    expect(lib.blockingFailures(report.results).map((r) => r.id).sort()).toEqual(["exits", "exits3", "garbage", "rejects", "throws"]);
  });

  it("stops a check that hangs (sync loop, never-settling promise, hanging import) at the timeout", async () => {
    const repo = repoWithChecks({
      "spin.mjs": checkSource("spin", { run: "for (;;) {}" }),
      "never.mjs": checkSource("never", { run: "return new Promise(() => { setInterval(() => {}, 1000); });" }),
      "import-spin.mjs": checkSource("import-spin", { top: "for (;;) {}" }),
      "fine.mjs": checkSource("fine"),
    });
    const started = Date.now();
    const report = await lib.runChecks(repo.root, { base: "HEAD", changedFiles: ["src/app.ts"], timeoutMs: 400 });
    const elapsed = Date.now() - started;
    for (const id of ["spin", "never", "import-spin"]) {
      const r = byId(report, id);
      expect(r.status, id).toBe("error");
      expect(r.message, id).toMatch(/timed out after 0\.4 s/);
    }
    expect(byId(report, "fine").status).toBe("pass");
    expect(elapsed).toBeLessThan(5000);
  });

  it("reports a promise that never settles (and keeps nothing alive) as an error", async () => {
    const repo = repoWithChecks({ "unsettled.mjs": checkSource("unsettled", { run: "return new Promise(() => {});" }) });
    const report = await lib.runChecks(repo.root, { base: "HEAD", changedFiles: [], timeoutMs: 2000 });
    expect(byId(report, "unsettled")).toMatchObject({ status: "error", ok: false });
    expect(byId(report, "unsettled").message).toMatch(/before returning a result/);
  });

  it("never lets the timeout go above 5 s", async () => {
    expect(lib.CHECK_TIMEOUT_MS).toBe(5000);
    const repo = repoWithChecks({ "never.mjs": checkSource("never", { run: "for (;;) {}" }) });
    const report = await lib.runChecks(repo.root, { base: "HEAD", changedFiles: [], timeoutMs: 600_000 });
    expect(byId(report, "never").message).toMatch(/timed out after 5 s/);
  }, 20_000);

  it("reports a file that cannot be loaded or has the wrong shape as an error, keeping a valid level", async () => {
    const repo = repoWithChecks({
      "syntax.mjs": "export default {{{",
      "no-default.mjs": "export const check = {};",
      "wrong-id.mjs": checkSource("something-else"),
      "warn-invalid.mjs": checkSource("warn-invalid", { level: "warn", examples: "[]" }),
      "bad-import.mjs": 'import "./does-not-exist.mjs";\nexport default {};',
    });
    const report = await lib.runChecks(repo.root, { base: "HEAD", changedFiles: [] });
    expect(byId(report, "syntax")).toMatchObject({ status: "error", level: "error" });
    expect(byId(report, "syntax").message).toMatch(/could not be loaded/);
    expect(byId(report, "bad-import").message).toMatch(/could not be loaded/);
    expect(byId(report, "no-default").message).toMatch(/not a valid check: must export a check object/);
    expect(byId(report, "wrong-id").message).toMatch(/"id" is "something-else" but the file is wrong-id\.mjs/);
    const warnInvalid = byId(report, "warn-invalid");
    expect(warnInvalid).toMatchObject({ status: "error", level: "warn" });
    expect(lib.blockingFailures(report.results).map((r) => r.id).sort()).toEqual(["bad-import", "no-default", "syntax", "wrong-id"]);
  });

  it("never lets a warn-level check block", async () => {
    const repo = repoWithChecks({
      "soft.mjs": checkSource("soft", { level: "warn", run: 'return { ok: false, message: "just so you know" };' }),
      "soft-throw.mjs": checkSource("soft-throw", { level: "warn", run: 'throw new Error("x");' }),
    });
    const report = await lib.runChecks(repo.root, { base: "HEAD", changedFiles: [] });
    expect(byId(report, "soft")).toMatchObject({ status: "fail", level: "warn", message: "just so you know" });
    expect(byId(report, "soft-throw")).toMatchObject({ status: "error", level: "warn" });
    expect(lib.blockingFailures(report.results)).toEqual([]);
  });

  it("with committedOnly, runs only check files present in HEAD", async () => {
    const failing = (id: string) => checkSource(id, { run: 'return { ok: false, message: "no" };' });
    const repo = repoWithChecks({ "committed.mjs": failing("committed") });
    repo.write(`${CHECKS_DIR}/fresh.mjs`, failing("fresh"));
    const strict = await lib.runChecks(repo.root, { base: "HEAD", changedFiles: [], committedOnly: true });
    expect(byId(strict, "committed").status).toBe("fail");
    expect(byId(strict, "fresh")).toMatchObject({ status: "skip", ok: true });
    expect(byId(strict, "fresh").message).toMatch(/not committed/);
    const all = await lib.runChecks(repo.root, { base: "HEAD", changedFiles: [] });
    expect(byId(all, "fresh").status).toBe("fail");
  });

  it("skips checks that have not started when the deadline has passed", async () => {
    const repo = repoWithChecks({ "a.mjs": checkSource("a", { run: 'return { ok: false, message: "no" };' }) });
    const report = await lib.runChecks(repo.root, { base: "HEAD", changedFiles: [], deadlineMs: 0 });
    expect(byId(report, "a")).toMatchObject({ status: "skip", ok: true, message: "not run: out of time" });
  });

  it("uses the configured folder and returns nothing when there are no checks", async () => {
    const repo = repoWithChecks({}, { "tools/checks/elsewhere.mjs": checkSource("elsewhere", { run: 'return { ok: false, message: "m" };' }) });
    expect((await lib.runChecks(repo.root, {})).results).toEqual([]);
    const report = await lib.runChecks(repo.root, { dir: "tools/checks" });
    expect(report.dir).toBe("tools/checks");
    expect(byId(report, "elsewhere").status).toBe("fail");
  });
});

describe("selfTest", () => {
  it("passes the example check's own examples", async () => {
    const repo = repoWithChecks({ "no-console-log.mjs": FIXTURE });
    const report = await lib.selfTest(repo.root);
    expect(report.ok).toBe(true);
    expect(report.failures).toBe(0);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]!.examples.map((e) => [e.expect, e.actual])).toEqual([
      [true, true],
      [true, true],
      [false, false],
    ]);
  });

  it("catches an example whose expect is wrong, and names it", async () => {
    // The check really fails on console.log, but this example claims it passes.
    const wrong = FIXTURE.replace(/(name: "fails when a new line calls console\.log",[\s\S]*?expect: )false/, "$1true").replace(
      '"passes when nothing in src/ changed"',
      '"passes when nothing in src/ changed (and claims to fail)"',
    );
    const lying = wrong.replace(
      /(name: "passes when nothing in src\/ changed \(and claims to fail\)",[\s\S]*?expect: )true/,
      "$1false",
    );
    expect(lying).not.toBe(FIXTURE);
    const repo = repoWithChecks({ "no-console-log.mjs": lying });
    const report = await lib.selfTest(repo.root);
    expect(report.ok).toBe(false);
    expect(report.failures).toBe(2);
    const bad = report.checks[0]!.examples.filter((e) => !e.ok);
    expect(bad.map((e) => e.name)).toEqual([
      "passes when nothing in src/ changed (and claims to fail)",
      "fails when a new line calls console.log",
    ]);
    expect(bad.map((e) => [e.expect, e.actual])).toEqual([
      [false, true],
      [true, false],
    ]);
  });

  it("does not use git or the working tree: examples see only their own files", async () => {
    const run = `
      const g = ctx.git(["rev-parse", "HEAD"]);
      if (g.ok) return { ok: false, message: "git ran" };
      return ctx.read("src/app.ts") === "fake" ? { ok: true } : { ok: false, message: "real file" };`;
    const examples = `[
      { name: "fake file", ctx: { files: { "src/app.ts": "fake" } }, expect: true },
      { name: "no file", ctx: {}, expect: false },
    ]`;
    const repo = repoWithChecks({ "hermetic.mjs": checkSource("hermetic", { run, examples }) });
    const report = await lib.selfTest(repo.root);
    expect(report.ok).toBe(true);
    expect(report.checks[0]!.examples.map((e) => e.actual)).toEqual([true, false]);
  });

  it("applies when lists to examples (a non-matching example counts as passing)", async () => {
    const examples = `[
      { name: "other file", ctx: { changedFiles: ["docs/a.md"] }, expect: true },
      { name: "matching file", ctx: { changedFiles: ["src/a.ts"] }, expect: false },
    ]`;
    const repo = repoWithChecks({
      "always-fails.mjs": checkSource("always-fails", { when: ["src/"], run: 'return { ok: false, message: "no" };', examples }),
    });
    expect((await lib.selfTest(repo.root)).ok).toBe(true);
  });

  it("reports invalid checks, throwing examples and hanging examples", async () => {
    const hangExamples = `[
      { name: "first", ctx: { changedFiles: [] }, expect: true },
      { name: "hangs", ctx: { changedFiles: ["x"] }, expect: false },
      { name: "after", ctx: { changedFiles: ["y"] }, expect: false },
    ]`;
    const repo = repoWithChecks({
      "invalid.mjs": checkSource("invalid", { examples: "[{ name: 'a', expect: true }]" }),
      "throws.mjs": checkSource("throws", { run: 'if (ctx.changedFiles.length) throw new Error("boom"); return { ok: true };' }),
      "hang.mjs": checkSource("hang", { run: "if (ctx.changedFiles.length) for (;;) {} return { ok: true };", examples: hangExamples }),
    });
    const report = await lib.selfTest(repo.root, { timeoutMs: 400 });
    expect(report.ok).toBe(false);
    const invalid = report.checks.find((c) => c.id === "invalid")!;
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.join()).toMatch(/expect: false/);
    const throws = report.checks.find((c) => c.id === "throws")!;
    expect(throws.examples.map((e) => [e.ok, e.actual])).toEqual([
      [true, true],
      [false, null],
    ]);
    expect(throws.examples[1]!.message).toBe("threw: boom");
    const hang = report.checks.find((c) => c.id === "hang")!;
    expect(hang.examples.map((e) => e.ok)).toEqual([true, false, false]);
    expect(hang.examples[1]!.message).toMatch(/timed out/);
    expect(hang.examples[2]!.message).toMatch(/not run/);
    expect(report.failures).toBe(1 + 1 + 2);
  });
});

// ------------------------------------------------------------------------------------------------- CLI

describe("check.mjs", () => {
  it("exits 0 when the checks pass and 1 when an error-level check fails", () => {
    const repo = repoWithChecks({ "no-console-log.mjs": FIXTURE });
    let r = cli(repo);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/1 check/);
    expect(r.stdout.trim().split("\n").at(-1)).toBe("ok");

    repo.write("src/app.ts", 'console.log("x");\n');
    r = cli(repo);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+no-console-log: console\.log added in src\/app\.ts/);
    expect(r.stdout).toMatch(/failed: 1 problem/);
  });

  it("measures changes from --base, including commits since it", () => {
    const repo = repoWithChecks({ "no-console-log.mjs": FIXTURE });
    const base = repo.git("rev-parse", "HEAD");
    repo.commit({ files: { "src/app.ts": 'console.log("committed");\n' } });
    expect(cli(repo).code).toBe(0); // on main: auto base is HEAD, nothing uncommitted
    const r = cli(repo, ["--base", base, "--json"]);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.stdout);
    expect(json.ok).toBe(false);
    expect(json.base).toBe(base);
    expect(json.changedFiles).toEqual(["src/app.ts"]);
  });

  it("uses the merge base with the default branch by default on a feature branch", () => {
    const repo = repoWithChecks({ "no-console-log.mjs": FIXTURE });
    repo.git("checkout", "-q", "-b", "feature");
    repo.commit({ files: { "src/app.ts": 'console.log("on the branch");\n' } });
    const r = cli(repo);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/merge base with main/);
  });

  it("exits 0 when only a warn-level check fails, and 1 when an error-level check throws", () => {
    const repo = repoWithChecks({
      "soft.mjs": checkSource("soft", { level: "warn", run: 'return { ok: false, message: "heads up" };' }),
    });
    let r = cli(repo);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/warn\s+soft: heads up/);
    repo.write(`${CHECKS_DIR}/boom.mjs`, checkSource("boom", { run: 'throw new Error("kaboom");' }));
    r = cli(repo);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/ERROR\s+boom: threw: kaboom/);
  });

  it("keeps --json output clean when a check prints to stdout and stderr", () => {
    const run = 'console.log("NOISE"); process.stdout.write("MORE NOISE\\n"); console.error("ERR NOISE"); return { ok: true };';
    const repo = repoWithChecks({ "noisy.mjs": checkSource("noisy", { run }) });
    const r = cli(repo, ["--json"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/NOISE/);
    expect(r.stderr).not.toMatch(/NOISE/);
    expect(JSON.parse(r.stdout).results[0].status).toBe("pass");
  });

  it("--self-test exits 0 for correct examples and 1 when an example's expect is wrong", () => {
    const repo = repoWithChecks({ "no-console-log.mjs": FIXTURE });
    let r = cli(repo, ["--self-test"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/3 examples/);
    const wrong = FIXTURE.replace(/(name: "passes when the new line uses the logger",[\s\S]*?expect: )true/, "$1false");
    expect(wrong).not.toBe(FIXTURE);
    repo.write(`${CHECKS_DIR}/no-console-log.mjs`, wrong);
    r = cli(repo, ["--self-test"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/WRONG\s+no-console-log: "passes when the new line uses the logger" should fail, but it passed/);
    const json = JSON.parse(cli(repo, ["--self-test", "--json"]).stdout);
    expect(json.ok).toBe(false);
    expect(json.failures).toBe(1);
  });

  it("--self-test exits 1 for an invalid check", () => {
    const repo = repoWithChecks({ "half.mjs": checkSource("half", { examples: "[{ name: 'only', expect: true }]" }) });
    const r = cli(repo, ["--self-test"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/ERROR\s+half: is not a valid check/);
  });

  it("exits 0 with no checks, 0 for --help, and 2 for usage errors and unknown refs", () => {
    const repo = makeRepo();
    let r = cli(repo);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/No checks in \.claude\/hermod\/checks\//);
    r = cli(repo, ["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Usage: node \.claude\/hermod\/check\.mjs/);
    r = cli(repo, ["--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Usage:/);
    r = cli(repo, ["stray-positional"]);
    expect(r.code).toBe(2);
    r = cli(repo, ["--base", "no-such-branch"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--base "no-such-branch" is not a commit/);
    r = cli(repo, ["--base", "--upload-pack=evil"]);
    expect(r.code).toBe(2);
    r = runNode(repo.kitPath("check.mjs"), { args: ["--root", path.join(repo.root, "missing")] });
    expect(r.code).toBe(2);
  });

  it("falls back to the automatic base when checks.base in config.json is not a commit", () => {
    const repo = repoWithChecks(
      { "no-console-log.mjs": FIXTURE },
      { ".claude/hermod/config.json": JSON.stringify({ version: 1, checks: { base: "origin/gone" } }) },
    );
    repo.write("src/app.ts", 'console.log("x");\n');
    const r = cli(repo);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/checks\.base "origin\/gone" is not a commit here/);
  });

  it("stops a check that loops forever after 5 s and exits 1", () => {
    const repo = repoWithChecks({ "spin.mjs": checkSource("spin", { run: "for (;;) {}" }) });
    const r = cli(repo, [], 25_000);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/ERROR\s+spin: timed out after 5 s/);
    expect(r.durationMs).toBeGreaterThan(4500);
    expect(r.durationMs).toBeLessThan(15_000);
  }, 30_000);
});
