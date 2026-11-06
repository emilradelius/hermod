// Tests for kit/files/.claude/hermod/lib/config.mjs: defaults, deep merge, bounds, unknown keys, bad JSON.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, HERMOD_ROOT, makeRepo } from "./helpers.js";
import { loadLib, type KitModule } from "./kit-lib-tests-helpers.js";

let cfg: KitModule;
beforeAll(async () => {
  cfg = await loadLib("config");
});
afterAll(cleanup);

const validate = (value: unknown) => cfg.validateConfig(value) as { config: KitModule; errors: string[]; warnings: string[] };

describe("DEFAULTS", () => {
  it("match the spec and the seed config.json exactly", () => {
    const seed = JSON.parse(readFileSync(path.join(HERMOD_ROOT, "kit/seed/.claude/hermod/config.json"), "utf8"));
    expect(seed).toEqual(cfg.DEFAULTS);
    expect(cfg.DEFAULTS.brief.budgetChars).toBe(8000);
    expect(cfg.DEFAULTS.lessons).toEqual({ file: ".claude/hermod/LESSONS.md", capChars: 4000, maxEntryChars: 400 });
    expect(cfg.DEFAULTS.ritual.maxBlocksPerSession).toBe(2);
    expect(cfg.DEFAULTS.ritual.require).toEqual([{ path: "docs/PROGRESS.md", why: "Status, Next step, Not done" }]);
    expect(cfg.DEFAULTS.ritual.remind).toEqual([]);
    expect(cfg.DEFAULTS.checks).toEqual({ dir: ".claude/hermod/checks", base: "auto" });
  });

  it("are frozen, and loadConfig hands out copies", () => {
    expect(Object.isFrozen(cfg.DEFAULTS)).toBe(true);
    expect(Object.isFrozen(cfg.DEFAULTS.ritual.codePaths)).toBe(true);
    const { config } = validate({});
    config.ritual.codePaths.push("x/");
    config.brief.budgetChars = 1;
    expect(cfg.DEFAULTS.ritual.codePaths).not.toContain("x/");
    expect(cfg.DEFAULTS.brief.budgetChars).toBe(8000);
  });
});

describe("validateConfig", () => {
  it("returns the defaults for an empty object, without errors or warnings", () => {
    const r = validate({});
    expect(r.config).toEqual(cfg.DEFAULTS);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("merges objects key by key and replaces lists", () => {
    const r = validate({
      brief: { budgetChars: 5000, progress: { file: "notes/PROGRESS.md" } },
      ritual: { codePaths: ["packages/"], remind: ["Update the changelog"] },
    });
    expect(r.errors).toEqual([]);
    expect(r.config.brief.budgetChars).toBe(5000);
    expect(r.config.brief.progress).toEqual({ file: "notes/PROGRESS.md", sections: ["Status", "Next step"], maxCharsPerSection: 2500 });
    expect(r.config.brief.includeLessons).toBe(true);
    expect(r.config.ritual.codePaths).toEqual(["packages/"]);
    expect(r.config.ritual.ignorePaths).toEqual(cfg.DEFAULTS.ritual.ignorePaths);
    expect(r.config.ritual.remind).toEqual(["Update the changelog"]);
    expect(r.config.lessons).toEqual(cfg.DEFAULTS.lessons);
  });

  const bounds: Array<[string, number, number]> = [
    ["brief.budgetChars", 1000, 9500],
    ["lessons.capChars", 500, 20000],
    ["lessons.maxEntryChars", 50, 2000],
    ["skills.indexChars", 30, 200],
    ["ritual.maxBlocksPerSession", 1, 5],
  ];

  it("publishes the spec's bounds in CONFIG_BOUNDS", () => {
    for (const [key, min, max] of bounds) expect(cfg.CONFIG_BOUNDS[key]).toEqual([min, max]);
  });

  /** {"a": {"b": value}} for "a.b". */
  const nest = (key: string, value: unknown): Record<string, unknown> => {
    const parts = key.split(".");
    let obj: Record<string, unknown> = { [parts[parts.length - 1] as string]: value };
    for (let i = parts.length - 2; i >= 0; i--) obj = { [parts[i] as string]: obj };
    return obj;
  };
  const get = (config: KitModule, key: string) => key.split(".").reduce((o, k) => o[k], config);

  for (const [key, min, max] of bounds) {
    it(`accepts ${key} at ${min} and ${max}, and rejects ${min - 1}, ${max + 1}, fractions and text`, () => {
      const def = get(cfg.DEFAULTS, key);
      for (const ok of [min, max]) {
        const r = validate(nest(key, ok));
        expect(r.errors).toEqual([]);
        expect(get(r.config, key)).toBe(ok);
      }
      for (const bad of [min - 1, max + 1, min + 0.5, String(min), null, true]) {
        const r = validate(nest(key, bad));
        expect(r.errors.length, `${key}=${JSON.stringify(bad)}`).toBe(1);
        expect(r.errors[0]).toContain(key);
        expect(r.errors[0]).toContain(`from ${min} to ${max}`);
        expect(get(r.config, key)).toBe(def);
      }
    });
  }

  it("rejects NaN and Infinity for numbers", () => {
    expect(validate({ curator: { overlapThreshold: Number.NaN } }).errors).toHaveLength(1);
    expect(validate({ curator: { overlapThreshold: 1.5 } }).errors).toHaveLength(1);
    expect(validate({ curator: { overlapThreshold: 0.7 } }).config.curator.overlapThreshold).toBe(0.7);
    expect(validate({ brief: { budgetChars: Infinity } }).errors).toHaveLength(1);
  });

  it("warns about unknown keys at every level, with a did-you-mean hint, and ignores them", () => {
    const r = validate({ extraTop: 1, brief: { budgetChar: 5000 }, ritual: { require: [{ path: "a.md", whyy: "x" }] } });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings.join("\n")).toContain('"extraTop"');
    expect(r.warnings.join("\n")).toContain('Unknown setting "brief.budgetChar" is ignored (did you mean "brief.budgetChars"?)');
    expect(r.warnings.join("\n")).toContain("ritual.require[0].whyy");
    expect(r.config).not.toHaveProperty("extraTop");
    expect(r.config.brief.budgetChars).toBe(8000);
  });

  it("rejects a config that is not an object", () => {
    for (const bad of [null, [], "x", 3]) {
      const r = validate(bad);
      expect(r.errors).toHaveLength(1);
      expect(r.config).toEqual(cfg.DEFAULTS);
    }
  });

  it("rejects a section of the wrong type and uses its default", () => {
    const r = validate({ ritual: "on", brief: { includeGit: "yes" } });
    expect(r.errors).toHaveLength(2);
    expect(r.config.ritual).toEqual(cfg.DEFAULTS.ritual);
    expect(r.config.brief.includeGit).toBe(true);
  });

  it("insists on version 1", () => {
    expect(validate({ version: 2 }).errors[0]).toContain("version must be 1");
    expect(validate({ version: 1 }).errors).toEqual([]);
  });

  it("rejects absolute paths, '..' and Windows paths, and normalises backslashes", () => {
    for (const bad of ["/etc/passwd", "../outside.md", "docs/../../x", "C:\\x\\y.md", "~/notes.md", "", " docs/a.md"]) {
      const r = validate({ lessons: { file: bad } });
      expect(r.errors, bad).toHaveLength(1);
      expect(r.config.lessons.file).toBe(cfg.DEFAULTS.lessons.file);
    }
    expect(validate({ lessons: { file: "notes\\LESSONS.md" } }).config.lessons.file).toBe("notes/LESSONS.md");
    expect(validate({ skills: { dir: "./skills/" } }).config.skills.dir).toBe("skills");
  });

  it("drops bad list entries and keeps good ones", () => {
    const r = validate({
      ritual: {
        codePaths: ["src/", "/abs/", "../up/", 7, "lib/**/*.ts"],
        require: ["CHANGELOG.md", { path: "docs/x.md", why: "why" }, { path: "/abs" }, { why: "no path" }, { path: "a.md", why: 3 }, 5],
        remind: ["a", "", 4],
      },
      recall: { sources: [] },
    });
    expect(r.config.ritual.codePaths).toEqual(["src/", "lib/**/*.ts"]);
    expect(r.config.ritual.require).toEqual([
      { path: "CHANGELOG.md", why: "" },
      { path: "docs/x.md", why: "why" },
    ]);
    expect(r.config.ritual.remind).toEqual(["a"]);
    expect(r.config.recall.sources).toEqual([]);
    expect(r.errors).toHaveLength(3 + 4 + 2);
    expect(r.errors.every((e) => e.endsWith("it is ignored."))).toBe(true);
  });

  it("checks extraRedactPatterns as regular expressions", () => {
    const r = validate({ ledger: { extraRedactPatterns: ["ACME-[0-9]{6}", "/secret-\\w+/i", "(", "/x/g", 5, ""] } });
    expect(r.config.ledger.extraRedactPatterns).toEqual(["ACME-[0-9]{6}", "/secret-\\w+/i"]);
    expect(r.errors).toHaveLength(4);
  });

  it("checks brief.extra entries", () => {
    const r = validate({
      brief: {
        extra: ["docs/decisions.md", { file: "docs/plan.md", sections: ["Now"], maxChars: 500, title: "Plan" }, { file: "/x" }, { file: "a.md", maxChars: 50 }, { file: "a.md", sections: "Now" }, { file: "a.md", color: "red" }],
      },
    });
    expect(r.config.brief.extra).toEqual([
      { file: "docs/decisions.md" },
      { file: "docs/plan.md", sections: ["Now"], maxChars: 500, title: "Plan" },
      { file: "a.md" },
    ]);
    expect(r.errors).toHaveLength(3);
    expect(r.warnings.join("\n")).toContain("brief.extra[5].color");
  });

  it("accepts checks.base auto or a safe git ref, never an option-like value", () => {
    expect(validate({ checks: { base: "origin/main" } }).config.checks.base).toBe("origin/main");
    for (const bad of ["--output=/tmp/x", "a b", "", 3]) {
      const r = validate({ checks: { base: bad } });
      expect(r.errors, String(bad)).toHaveLength(1);
      expect(r.config.checks.base).toBe("auto");
    }
  });

  it("warns about curator pinned names that are not skill names, and archiveDays below staleDays", () => {
    const r = validate({ curator: { pinned: ["good-name", "Bad Name", ""], staleDays: 30, archiveDays: 10 } });
    expect(r.config.curator.pinned).toEqual(["good-name", "Bad Name"]);
    expect(r.errors).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes('"Bad Name"'))).toBe(true);
    expect(r.warnings.some((w) => w.includes("archiveDays"))).toBe(true);
  });

  it("never throws on hostile values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const r = validate({ brief: cyclic, ritual: { require: [cyclic] }, __proto__: { polluted: true } });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("loadConfig", () => {
  it("uses the defaults when config.json is missing (found: false, no errors)", () => {
    const repo = makeRepo({ git: false });
    const r = cfg.loadConfig(repo.root);
    expect(r.found).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.config).toEqual(cfg.DEFAULTS);
    expect(r.file).toBe(".claude/hermod/config.json");
  });

  it("reports bad JSON as an error and uses the defaults", () => {
    const repo = makeRepo({ git: false, files: { ".claude/hermod/config.json": '{ "brief": { "budgetChars": 5000, } }' } });
    const r = cfg.loadConfig(repo.root);
    expect(r.found).toBe(true);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("not valid JSON");
    expect(r.config).toEqual(cfg.DEFAULTS);
  });

  it("reads a config with a BOM and CRLF line endings", () => {
    const repo = makeRepo({ git: false, files: { ".claude/hermod/config.json": '\ufeff{\r\n  "brief": { "budgetChars": 4000 }\r\n}\r\n' } });
    const r = cfg.loadConfig(repo.root);
    expect(r.errors).toEqual([]);
    expect(r.config.brief.budgetChars).toBe(4000);
  });

  it("treats a folder named config.json as missing instead of throwing", () => {
    const repo = makeRepo({ git: false, files: { ".claude/hermod/config.json/x": "y" } });
    expect(() => cfg.loadConfig(repo.root)).not.toThrow();
    expect(cfg.loadConfig(repo.root).config).toEqual(cfg.DEFAULTS);
  });
});
