// Tests for kit/files/.claude/hermod/validate.mjs, run as a CLI in temporary repositories: exit codes, --strict,
// --json, --kit, --help, and the in-process API.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, HERMOD_ROOT, makeRepo, runNode, tempDir, type Files } from "./helpers.js";
import { collector, KIT_HERMOD, loadKit, type KitModule } from "./kit-lib-tests-helpers.js";

let v: KitModule;
beforeAll(async () => {
  v = await loadKit("validate.mjs");
});
afterAll(cleanup);

const GOOD_LESSONS = "# Lessons\n<!-- hermod:lessons -->\n\nThe brief is frozen at session start.\n§\nChecks run from committed files only.\n";
const skill = (name: string, description = "Does one thing. Use when needed.") => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`;

/** A repo with the kit (and its own skills), plus files. */
const repoWith = (files: Files = {}) => makeRepo({ files });
const run = (root: string, ...args: string[]) => runNode(path.join(root, ".claude/hermod/validate.mjs"), { cwd: root, args: ["--root", root, ...args] });

describe("validate.mjs CLI", () => {
  it("prints ok and exits 0 for a valid repository", () => {
    const repo = repoWith({ ".claude/hermod/LESSONS.md": GOOD_LESSONS, ".claude/skills/my-skill/SKILL.md": skill("my-skill") });
    const r = run(repo.root);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(`Hermod validate: ${repo.root}`);
    expect(lines[lines.length - 1]).toBe("ok");
    expect(r.stdout).toMatch(/^ok\s+config\s+\.claude\/hermod\/config\.json \(not found; using the defaults\)$/m);
    expect(r.stdout).toMatch(/^ok\s+lessons\s+\.claude\/hermod\/LESSONS\.md \(\d+ of 4,000 chars, 2 entries\)$/m);
    expect(r.stdout).toMatch(/^ok\s+skill\s+\.claude\/skills\/my-skill\/SKILL\.md$/m);
    expect(r.stdout).toMatch(/^ok\s+skill\s+\.claude\/skills\/reflect\/SKILL\.md$/m);
  });

  it("exits 1 on errors and names each one, with its line", () => {
    const repo = repoWith({
      ".claude/hermod/config.json": JSON.stringify({ brief: { budgetChars: 20000 } }),
      ".claude/hermod/LESSONS.md": "# Lessons\n<!-- x -->\n\nFact.\n§\nfact.\n",
      ".claude/skills/broken/SKILL.md": skill("wrong-name"),
    });
    const r = run(repo.root);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^error\s+config/m);
    expect(r.stdout).toContain("brief.budgetChars must be a whole number from 1000 to 9500");
    expect(r.stdout).toContain("error (line 6): Entry 2 repeats entry 1");
    expect(r.stdout).toContain('error (line 2): "name" "wrong-name" does not match the folder name "broken"');
    expect(r.stdout.trimEnd().split("\n").pop()).toBe("failed: 3 errors, 0 warnings");
  });

  it("passes with warnings, and fails with them under --strict", () => {
    const repo = repoWith({ ".claude/hermod/LESSONS.md": "# Lessons\n<!-- x -->\n\nAlways run the tests first.\n" });
    const plain = run(repo.root);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toMatch(/^warning\s+lessons/m);
    expect(plain.stdout.trimEnd().split("\n").pop()).toBe("ok with 1 warning");
    const strict = run(repo.root, "--strict");
    expect(strict.code).toBe(1);
    expect(strict.stdout.trimEnd().split("\n").pop()).toBe("failed: 1 warning (--strict)");
  });

  it("--json prints the whole result", () => {
    const repo = repoWith({ ".claude/hermod/LESSONS.md": GOOD_LESSONS, ".claude/skills/bad/SKILL.md": "no frontmatter\n" });
    const r = run(repo.root, "--json");
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out).sort()).toEqual(["errors", "items", "ok", "root", "strict", "warnings"]);
    expect(out).toMatchObject({ ok: false, strict: false, root: repo.root, errors: 1, warnings: 0 });
    const bad = out.items.find((i: KitModule) => i.target === ".claude/skills/bad/SKILL.md");
    expect(bad).toEqual({
      kind: "skill",
      target: ".claude/skills/bad/SKILL.md",
      status: "error",
      found: true,
      errors: [{ message: "SKILL.md has no frontmatter: it must start with a --- line, then name: and description:, then ---", line: 1 }],
      warnings: [],
      note: null,
    });
    const lessons = out.items.find((i: KitModule) => i.kind === "lessons");
    expect(lessons).toMatchObject({ status: "ok", found: true, errors: [], warnings: [] });
    expect(out.items[0]).toMatchObject({ kind: "config", found: false, status: "ok" });
    expect(JSON.parse(run(repo.root, "--json", "--strict").stdout).strict).toBe(true);
  });

  it("reports missing lessons as not found (not an error), and an empty skills folder as nothing to check", () => {
    const repo = makeRepo({ kitSkills: false });
    const out = JSON.parse(run(repo.root, "--json").stdout);
    expect(out.ok).toBe(true);
    expect(out.items.map((i: KitModule) => [i.kind, i.found])).toEqual([
      ["config", false],
      ["lessons", false],
    ]);
  });

  it("uses lessons.file and skills.dir from config.json", () => {
    const repo = repoWith({
      ".claude/hermod/config.json": JSON.stringify({ lessons: { file: "docs/LESSONS.md", capChars: 500 }, skills: { dir: "skills" } }),
      "docs/LESSONS.md": `# Lessons\n<!-- x -->\n\n${"A fact that is long. ".repeat(30)}\n`,
      "skills/one/SKILL.md": skill("one"),
    });
    const out = JSON.parse(run(repo.root, "--json").stdout);
    expect(out.items.map((i: KitModule) => i.target)).toEqual([".claude/hermod/config.json", "docs/LESSONS.md", "skills/one/SKILL.md"]);
    expect(out.items[1].errors[0].message).toContain("the cap is 500");
  });

  it("--kit checks the kit's own skills and seed files in a hermod checkout", () => {
    const r = runNode(path.join(KIT_HERMOD, "validate.mjs"), { cwd: HERMOD_ROOT, args: ["--root", HERMOD_ROOT, "--kit", "--json"] });
    const out = JSON.parse(r.stdout);
    const kinds = out.items.map((i: KitModule) => `${i.kind} ${i.target}`);
    expect(kinds).toContain("kit-skill kit/files/.claude/skills/reflect/SKILL.md");
    expect(kinds).toContain("kit-seed kit/seed/.claude/hermod/config.json");
    expect(kinds).toContain("kit-seed kit/seed/.claude/hermod/LESSONS.md");
    for (const i of out.items.filter((x: KitModule) => x.kind.startsWith("kit"))) expect(i.errors, i.target).toEqual([]);
  });

  it("--kit fails outside a hermod checkout, and catches a broken kit skill or seed", () => {
    const repo = repoWith();
    const r = run(repo.root, "--kit");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("--kit was given, but kit/files/.claude/skills does not exist");
    const fake = makeRepo({
      kit: true,
      files: {
        "kit/files/.claude/skills/x/SKILL.md": skill("y"),
        "kit/seed/.claude/hermod/config.json": "{ bad json",
        "kit/seed/.claude/hermod/LESSONS.md": "# Lessons\n<!-- -->\n\n#heading\n",
      },
    });
    const out = JSON.parse(run(fake.root, "--kit", "--json").stdout);
    const byTarget = Object.fromEntries(out.items.map((i: KitModule) => [i.target, i]));
    expect(byTarget["kit/files/.claude/skills/x/SKILL.md"].status).toBe("error");
    expect(byTarget["kit/seed/.claude/hermod/config.json"].errors[0].message).toContain("not valid JSON");
    expect(byTarget["kit/seed/.claude/hermod/LESSONS.md"].errors[0].message).toContain('starts with "#"');
    expect(out.ok).toBe(false);
  });

  it("--help prints usage and exits 0; unknown options and a missing root exit 1", () => {
    const repo = repoWith();
    const help = run(repo.root, "--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: node .claude/hermod/validate.mjs");
    expect(help.stdout).toContain("--strict");
    expect(run(repo.root, "-h").code).toBe(0);
    const bad = run(repo.root, "--nope");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("validate:");
    expect(bad.stderr).toContain("Usage:");
    expect(run(repo.root, "positional").code).toBe(1);
    const missing = runNode(path.join(repo.root, ".claude/hermod/validate.mjs"), { args: ["--root", path.join(tempDir(), "nope")] });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("does not exist");
  });

  it("finds the root from CLAUDE_PROJECT_DIR or the git top level", () => {
    const repo = repoWith({ ".claude/skills/bad/SKILL.md": "x" });
    const viaEnv = runNode(repo.kitPath("validate.mjs"), { cwd: tempDir(), env: { CLAUDE_PROJECT_DIR: repo.root }, args: ["--json"] });
    expect(JSON.parse(viaEnv.stdout).root).toBe(repo.root);
    repo.write("sub/dir/.keep", "");
    const viaGit = runNode(repo.kitPath("validate.mjs"), { cwd: repo.abs("sub/dir"), args: ["--json"] });
    expect(JSON.parse(viaGit.stdout).root).toBe(repo.root);
    expect(viaGit.code).toBe(1);
  });

  it("never changes a file", () => {
    const repo = repoWith({ ".claude/hermod/LESSONS.md": GOOD_LESSONS, ".claude/skills/bad/SKILL.md": "x" });
    const before = repo.git("status", "--porcelain", "--untracked-files=all");
    run(repo.root);
    run(repo.root, "--json", "--strict", "--kit");
    expect(repo.git("status", "--porcelain", "--untracked-files=all")).toBe(before);
    expect(repo.exists(".claude/hermod/.local")).toBe(false);
  });
});

describe("validate.mjs API", () => {
  it("main returns the exit code and writes to the given streams", () => {
    const repo = repoWith({ ".claude/hermod/LESSONS.md": GOOD_LESSONS });
    const out = collector();
    const err = collector();
    expect(v.main(["--root", repo.root], { stdout: out.stream, stderr: err.stream })).toBe(0);
    expect(out.text().trimEnd().endsWith("ok")).toBe(true);
    expect(v.main(["--bogus"], { stdout: out.stream, stderr: err.stream })).toBe(1);
    expect(err.text()).toContain("validate:");
  });

  it("validateRepo and formatReport", () => {
    const repo = repoWith({ ".claude/skills/a/SKILL.md": skill("a", "Fine.") });
    const result = v.validateRepo(repo.root);
    expect(result.errors).toBe(0);
    expect(result.items.find((i: KitModule) => i.target === ".claude/skills/a/SKILL.md").status).toBe("ok");
    const text = v.formatReport({ root: "/r", items: [{ kind: "lessons", target: "L.md", status: "warn", found: true, errors: [], warnings: [{ message: "w", line: 3 }], note: null }], errors: 0, warnings: 1 }, { strict: true });
    expect(text).toBe("Hermod validate: /r\nwarning lessons   L.md\n          warning (line 3): w\nfailed: 1 warning (--strict)\n");
  });

  it("the usage text in the file matches USAGE", () => {
    const src = readFileSync(path.join(KIT_HERMOD, "validate.mjs"), "utf8");
    expect(src).toContain("node .claude/hermod/validate.mjs [--root DIR] [--strict] [--json] [--kit] [--help]");
    expect(v.USAGE).toContain("Exit code: 0 when everything is valid");
  });
});
