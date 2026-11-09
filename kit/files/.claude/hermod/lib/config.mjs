// @ts-check
/**
 * The kit's settings: `.claude/hermod/config.json` (owned by the repository) merged over DEFAULTS.
 *
 * loadConfig(root) never throws and always returns a complete, valid config: values that are missing use
 * the default, values that are invalid are reported in `errors` and replaced by the default (invalid list
 * entries are dropped), and unknown keys are reported in `warnings` and ignored.
 * Objects merge key by key; lists replace the default list.
 */
import path from "node:path";
import { isSafeRef } from "./git.mjs";
import { isPlainObject, readText } from "./io.mjs";
import { normalizeRelPath, patternError, relPathError } from "./paths.mjs";
import { compileRedactPattern } from "./redact.mjs";

/** Where the config lives, relative to the repository root. */
export const CONFIG_FILE = ".claude/hermod/config.json";

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * The default settings (the seed config.json is exactly this, pretty-printed). Frozen; loadConfig returns
 * copies.
 */
export const DEFAULTS = deepFreeze({
  version: 1,
  brief: {
    budgetChars: 8000,
    progress: { file: "docs/PROGRESS.md", sections: ["Status", "Next step"], maxCharsPerSection: 2500 },
    includeLessons: true,
    includeSkills: true,
    includeGit: true,
    maxBranches: 6,
    extra: [],
  },
  lessons: { file: ".claude/hermod/LESSONS.md", capChars: 4000, maxEntryChars: 400 },
  skills: { dir: ".claude/skills", indexChars: 60 },
  ritual: {
    enabled: true,
    codePaths: ["src/", "app/", "lib/", "scripts/", "supabase/", "public/", "tests/", "test/"],
    ignorePaths: [".claude/", "docs/", "**/*.md"],
    require: [{ path: "docs/PROGRESS.md", why: "Status, Next step, Not done" }],
    remind: [],
    runChecks: true,
    validateKnowledge: true,
    maxBlocksPerSession: 2,
  },
  ledger: { enabled: true, maxOutputChars: 2000, maxFileBytes: 2000000, extraRedactPatterns: [] },
  recall: {
    sources: ["docs/PROGRESS.md", "docs/progress-archive/**/*.md", "docs/decisions.md", ".claude/hermod/history/**/*.md"],
    git: true,
    gitMaxCommits: 3000,
    limit: 8,
    snippetChars: 240,
  },
  checks: { dir: ".claude/hermod/checks", base: "auto" },
  curator: {
    staleDays: 14,
    archiveDays: 30,
    pinned: [],
    maxSkillLines: 500,
    maxSkillChars: 20000,
    overlapThreshold: 0.55,
  },
});

/**
 * @typedef {typeof DEFAULTS} HermodConfig
 */

/**
 * @typedef {object} ConfigResult
 * @property {HermodConfig} config complete and valid
 * @property {string[]} errors invalid values (each replaced by its default)
 * @property {string[]} warnings unknown keys and doubtful values
 * @property {string} file CONFIG_FILE
 * @property {boolean} found whether config.json exists
 */

/**
 * @typedef {{ type: "object", keys: Record<string, Schema> }
 *   | { type: "int", min: number, max: number }
 *   | { type: "number", min: number, max: number }
 *   | { type: "bool" }
 *   | { type: "path" }
 *   | { type: "patterns" }
 *   | { type: "strings" }
 *   | { type: "require" }
 *   | { type: "remind" }
 *   | { type: "regexes" }
 *   | { type: "extra" }
 *   | { type: "version" }
 *   | { type: "base" }
 *   | { type: "skillNames" }} Schema
 */

/**
 * @param {number} min
 * @param {number} max
 * @returns {Schema}
 */
const int = (min, max) => ({ type: "int", min, max });
/** @type {Schema} */
const bool = { type: "bool" };
/** @type {Schema} */
const relPath = { type: "path" };
/** @type {Schema} */
const patterns = { type: "patterns" };

/** @type {Schema} */
const SCHEMA = {
  type: "object",
  keys: {
    version: { type: "version" },
    brief: {
      type: "object",
      keys: {
        budgetChars: int(1000, 9500),
        progress: {
          type: "object",
          keys: { file: relPath, sections: { type: "strings" }, maxCharsPerSection: int(100, 9500) },
        },
        includeLessons: bool,
        includeSkills: bool,
        includeGit: bool,
        maxBranches: int(0, 50),
        extra: { type: "extra" },
      },
    },
    lessons: { type: "object", keys: { file: relPath, capChars: int(500, 20000), maxEntryChars: int(50, 2000) } },
    skills: { type: "object", keys: { dir: relPath, indexChars: int(30, 200) } },
    ritual: {
      type: "object",
      keys: {
        enabled: bool,
        codePaths: patterns,
        ignorePaths: patterns,
        require: { type: "require" },
        remind: { type: "remind" },
        runChecks: bool,
        validateKnowledge: bool,
        maxBlocksPerSession: int(1, 5),
      },
    },
    ledger: {
      type: "object",
      keys: {
        enabled: bool,
        maxOutputChars: int(200, 20000),
        maxFileBytes: int(10000, 100000000),
        extraRedactPatterns: { type: "regexes" },
      },
    },
    recall: {
      type: "object",
      keys: {
        sources: patterns,
        git: bool,
        gitMaxCommits: int(0, 100000),
        limit: int(1, 100),
        snippetChars: int(40, 2000),
      },
    },
    checks: { type: "object", keys: { dir: relPath, base: { type: "base" } } },
    curator: {
      type: "object",
      keys: {
        staleDays: int(1, 3650),
        archiveDays: int(1, 3650),
        pinned: { type: "skillNames" },
        maxSkillLines: int(10, 100000),
        maxSkillChars: int(1000, 1000000),
        overlapThreshold: { type: "number", min: 0, max: 1 },
      },
    },
  },
};

/**
 * Numeric bounds per setting ("brief.budgetChars" → [1000, 9500]), for documentation and tests.
 * @type {Readonly<Record<string, readonly [number, number]>>}
 */
export const CONFIG_BOUNDS = (() => {
  /** @type {Record<string, readonly [number, number]>} */
  const out = {};
  /**
   * @param {Schema} node
   * @param {string} key
   */
  const walk = (node, key) => {
    if (node.type === "object") for (const [k, child] of Object.entries(node.keys)) walk(child, key ? `${key}.${k}` : k);
    else if (node.type === "int" || node.type === "number") out[key] = Object.freeze([node.min, node.max]);
  };
  walk(SCHEMA, "");
  return Object.freeze(out);
})();

/**
 * @param {unknown} value
 * @returns {string}
 */
function shown(value) {
  let s;
  try {
    s = value === undefined ? "nothing" : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/**
 * Edit distance, for "did you mean" hints.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/**
 * @typedef {{ errors: string[], warnings: string[] }} Report
 */

/**
 * @param {string} key
 * @param {Record<string, unknown>} value
 * @param {string[]} known
 * @param {Report} report
 */
function warnUnknown(key, value, known, report) {
  for (const k of Object.keys(value)) {
    if (known.includes(k)) continue;
    const full = key ? `${key}.${k}` : k;
    const guess = known.find((c) => distance(c, k) <= 2);
    const hint = guess ? ` (did you mean "${key ? `${key}.${guess}` : guess}"?)` : "";
    report.warnings.push(`Unknown setting "${full}" is ignored${hint}.`);
  }
}

/**
 * @param {Schema} schema
 * @param {unknown} value
 * @param {any} def
 * @param {string} key
 * @param {Report} report
 * @returns {any}
 */
function check(schema, value, def, key, report) {
  if (value === undefined) return structuredClone(def);
  /** @param {string} what */
  const bad = (what) => {
    report.errors.push(`${key} ${what} (got ${shown(value)}); using the default ${shown(def)}.`);
    return structuredClone(def);
  };
  switch (schema.type) {
    case "object": {
      if (!isPlainObject(value)) return bad("must be an object");
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, child] of Object.entries(schema.keys)) {
        out[k] = check(child, value[k], def[k], key ? `${key}.${k}` : k, report);
      }
      warnUnknown(key, value, Object.keys(schema.keys), report);
      return out;
    }
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value) || value < schema.min || value > schema.max) {
        return bad(`must be a whole number from ${schema.min} to ${schema.max}`);
      }
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || value < schema.min || value > schema.max) {
        return bad(`must be a number from ${schema.min} to ${schema.max}`);
      }
      return value;
    case "bool":
      return typeof value === "boolean" ? value : bad("must be true or false");
    case "version":
      if (value !== 1) {
        report.errors.push(`version must be 1 (this kit reads config version 1; got ${shown(value)}).`);
      }
      return 1;
    case "path": {
      const why = relPathError(value);
      if (why) return bad(`must be a path relative to the repository root, like "docs/PROGRESS.md": ${why}`);
      return normalizeRelPath(/** @type {string} */ (value));
    }
    case "base":
      if (value === "auto" || isSafeRef(value)) return value;
      return bad('must be "auto" or a git ref such as "origin/main"');
    case "strings":
    case "patterns":
    case "regexes":
    case "skillNames":
    case "remind":
    case "require":
    case "extra":
      if (!Array.isArray(value)) return bad("must be a list");
      return checkList(schema.type, value, key, report);
    default:
      return structuredClone(def);
  }
}

/**
 * @param {string} type
 * @param {unknown[]} list
 * @param {string} key
 * @param {Report} report
 * @returns {unknown[]}
 */
function checkList(type, list, key, report) {
  /** @type {unknown[]} */
  const out = [];
  list.forEach((item, i) => {
    const at = `${key}[${i}]`;
    /** @param {string} why */
    const drop = (why) => report.errors.push(`${at} ${why}; it is ignored.`);
    if (type === "strings" || type === "remind") {
      if (typeof item !== "string" || item.trim() === "") drop(`must be non-empty text (got ${shown(item)})`);
      else out.push(item);
    } else if (type === "patterns") {
      const why = patternError(item);
      if (why) drop(`is not a usable path pattern: ${why}`);
      else out.push(item);
    } else if (type === "regexes") {
      const { error } = compileRedactPattern(/** @type {string} */ (item));
      if (typeof item !== "string" || error) drop(`is not a usable redaction pattern: ${error ?? "must be text"}`);
      else out.push(item);
    } else if (type === "skillNames") {
      if (typeof item !== "string" || item.trim() === "") {
        drop(`must be a skill name (got ${shown(item)})`);
      } else {
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(item)) {
          report.warnings.push(`${at} "${item}" is not a valid skill name (lowercase letters, digits and hyphens).`);
        }
        out.push(item);
      }
    } else if (type === "require") {
      const entry = typeof item === "string" ? { path: item } : item;
      if (!isPlainObject(entry)) {
        drop(`must be an object like { "path": "docs/PROGRESS.md", "why": "..." } (got ${shown(item)})`);
        return;
      }
      const why = patternError(entry.path);
      if (why) {
        drop(`has no usable "path": ${why}`);
        return;
      }
      if (entry.why !== undefined && typeof entry.why !== "string") {
        drop(`has a "why" that is not text (got ${shown(entry.why)})`);
        return;
      }
      warnUnknown(at, entry, ["path", "why"], report);
      out.push({ path: entry.path, why: typeof entry.why === "string" ? entry.why : "" });
    } else if (type === "extra") {
      const entry = typeof item === "string" ? { file: item } : item;
      if (!isPlainObject(entry)) {
        drop(`must be a path or an object like { "file": "docs/decisions.md" } (got ${shown(item)})`);
        return;
      }
      const why = relPathError(entry.file);
      if (why) {
        drop(`has no usable "file": ${why}`);
        return;
      }
      /** @type {Record<string, unknown>} */
      const clean = { file: normalizeRelPath(/** @type {string} */ (entry.file)) };
      if (entry.sections !== undefined) {
        if (!Array.isArray(entry.sections) || entry.sections.some((s) => typeof s !== "string" || s.trim() === "")) {
          drop(`has "sections" that are not a list of headings`);
          return;
        }
        clean.sections = entry.sections;
      }
      if (entry.maxChars !== undefined) {
        const n = entry.maxChars;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 100 || n > 9500) {
          drop(`has "maxChars" that is not a whole number from 100 to 9500`);
          return;
        }
        clean.maxChars = n;
      }
      if (entry.title !== undefined) {
        if (typeof entry.title !== "string" || entry.title.trim() === "") {
          drop(`has a "title" that is not text`);
          return;
        }
        clean.title = entry.title;
      }
      warnUnknown(at, entry, ["file", "sections", "maxChars", "title"], report);
      out.push(clean);
    }
  });
  return out;
}

/**
 * Validates a parsed config.json value (pure; no file access).
 * @param {unknown} value
 * @returns {{ config: HermodConfig, errors: string[], warnings: string[] }}
 */
export function validateConfig(value) {
  /** @type {Report} */
  const report = { errors: [], warnings: [] };
  if (!isPlainObject(value)) {
    report.errors.push(`config.json must contain a JSON object (got ${shown(value)}); using the defaults.`);
    return { config: structuredClone(DEFAULTS), errors: report.errors, warnings: report.warnings };
  }
  const config = check(SCHEMA, value, DEFAULTS, "", report);
  if (config.curator.archiveDays < config.curator.staleDays) {
    report.warnings.push(
      `curator.archiveDays (${config.curator.archiveDays}) is lower than curator.staleDays (${config.curator.staleDays}); skills would be archive candidates before they are stale.`,
    );
  }
  return { config, errors: report.errors, warnings: report.warnings };
}

/**
 * Reads `.claude/hermod/config.json` under root and validates it. Never throws.
 * A missing file is not an error: the defaults are used.
 * @param {string} root
 * @returns {ConfigResult}
 */
export function loadConfig(root) {
  const file = path.join(path.resolve(root), ...CONFIG_FILE.split("/"));
  const text = readText(file);
  if (text === null) {
    return { config: structuredClone(DEFAULTS), errors: [], warnings: [], file: CONFIG_FILE, found: false };
  }
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      config: structuredClone(DEFAULTS),
      errors: [`config.json is not valid JSON (${why}); using the defaults.`],
      warnings: [],
      file: CONFIG_FILE,
      found: true,
    };
  }
  return { ...validateConfig(value), file: CONFIG_FILE, found: true };
}
