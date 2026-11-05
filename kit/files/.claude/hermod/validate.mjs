// @ts-check
/**
 * Hermod validate: checks `.claude/hermod/config.json`, the lessons file and every skill, and prints a
 * short report. Exit code 0 when everything is valid, 1 when there are errors (or warnings with --strict).
 *
 *   node .claude/hermod/validate.mjs [--root DIR] [--strict] [--json] [--kit] [--help]
 *
 * Read-only: it never changes a file.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CONFIG_FILE, DEFAULTS, loadConfig, validateConfig } from "./lib/config.mjs";
import { isMainModule, readText, resolveRoot } from "./lib/io.mjs";
import { validateLessons } from "./lib/lessons.mjs";
import { listSkills, validateSkill } from "./lib/skills.mjs";

export const USAGE = `Usage: node .claude/hermod/validate.mjs [--root DIR] [--strict] [--json] [--kit] [--help]

Checks .claude/hermod/config.json, the lessons file (lessons.file) and every skill in the skills folder
(skills.dir), and prints a short report. It never changes a file.

  --root DIR  the repository root (default: $CLAUDE_PROJECT_DIR, else the git top level of this folder)
  --strict    treat warnings as errors
  --json      print the full result as JSON
  --kit       also check the kit's own skills (kit/files/.claude/skills) and seed files (kit/seed);
              for a hermod checkout
  --help      show this help

Exit code: 0 when everything is valid, 1 when there are errors (or warnings with --strict).`;

const KIT_SKILLS_DIR = "kit/files/.claude/skills";
const KIT_SEED_CONFIG = "kit/seed/.claude/hermod/config.json";
const KIT_SEED_LESSONS = "kit/seed/.claude/hermod/LESSONS.md";

/**
 * @typedef {{ message: string, line: number | null }} Finding
 */

/**
 * @typedef {object} ValidationItem
 * @property {"config" | "lessons" | "skill" | "kit-skill" | "kit-seed" | "kit"} kind
 * @property {string} target posix path relative to the root
 * @property {"ok" | "warn" | "error"} status
 * @property {boolean} found
 * @property {Finding[]} errors
 * @property {Finding[]} warnings
 * @property {string | null} note
 */

/**
 * @typedef {object} ValidationResult
 * @property {string} root
 * @property {ValidationItem[]} items
 * @property {number} errors
 * @property {number} warnings
 */

/**
 * @param {ValidationItem["kind"]} kind
 * @param {string} target
 * @param {Finding[]} errors
 * @param {Finding[]} warnings
 * @param {{ found?: boolean, note?: string | null }} [extra]
 * @returns {ValidationItem}
 */
function item(kind, target, errors, warnings, extra = {}) {
  const status = errors.length > 0 ? "error" : warnings.length > 0 ? "warn" : "ok";
  return { kind, target, status, found: extra.found ?? true, errors, warnings, note: extra.note ?? null };
}

/**
 * @param {string[]} messages
 * @returns {Finding[]}
 */
const asFindings = (messages) => messages.map((message) => ({ message, line: null }));

/**
 * @param {Array<{ message: string, line: number | null }>} list
 * @returns {Finding[]}
 */
const plain = (list) => list.map((f) => ({ message: f.message, line: f.line ?? null }));

/**
 * @param {number} n
 * @returns {string}
 */
const num = (n) => n.toLocaleString("en-US");

/**
 * @param {string} root
 * @param {string} rel posix
 * @returns {string}
 */
const abs = (root, rel) => path.join(root, ...rel.split("/"));

/**
 * @param {string} text
 * @param {number} capChars
 * @param {number} maxEntryChars
 * @returns {{ errors: Finding[], warnings: Finding[], note: string }}
 */
function lessonsResult(text, capChars, maxEntryChars) {
  const r = validateLessons(text, { capChars, maxEntryChars });
  const entries = `${r.stats.entries} ${r.stats.entries === 1 ? "entry" : "entries"}`;
  return { errors: plain(r.errors), warnings: plain(r.warnings), note: `${num(r.stats.chars)} of ${num(capChars)} chars, ${entries}` };
}

/**
 * Validates a repository. Read-only; never throws for problems in the files it checks.
 * @param {string} root absolute path
 * @param {{ kit?: boolean }} [options]
 * @returns {ValidationResult}
 */
export function validateRepo(root, options = {}) {
  /** @type {ValidationItem[]} */
  const items = [];
  const loaded = loadConfig(root);
  const config = loaded.config;
  items.push(
    item("config", CONFIG_FILE, asFindings(loaded.errors), asFindings(loaded.warnings), {
      found: loaded.found,
      note: loaded.found ? null : "not found; using the defaults",
    }),
  );

  const lessonsFile = config.lessons.file;
  const lessonsText = readText(abs(root, lessonsFile));
  if (lessonsText === null) {
    items.push(item("lessons", lessonsFile, [], [], { found: false, note: "not found" }));
  } else {
    const r = lessonsResult(lessonsText, config.lessons.capChars, config.lessons.maxEntryChars);
    items.push(item("lessons", lessonsFile, r.errors, r.warnings, { note: r.note }));
  }

  for (const ref of listSkills(root, config.skills.dir)) {
    const r = validateSkill(ref.dir, { indexChars: config.skills.indexChars, maxSkillLines: config.curator.maxSkillLines });
    items.push(item("skill", ref.relFile, plain(r.errors), plain(r.warnings)));
  }

  if (options.kit) {
    const kitDir = abs(root, KIT_SKILLS_DIR);
    if (!fs.existsSync(kitDir) || !fs.statSync(kitDir).isDirectory()) {
      items.push(
        item("kit", KIT_SKILLS_DIR, asFindings([`--kit was given, but ${KIT_SKILLS_DIR} does not exist; run --kit in a hermod checkout`]), [], {
          found: false,
        }),
      );
    } else {
      const refs = listSkills(root, KIT_SKILLS_DIR);
      if (refs.length === 0) items.push(item("kit", KIT_SKILLS_DIR, asFindings(["the kit has no skills"]), []));
      for (const ref of refs) {
        const r = validateSkill(ref.dir, { indexChars: DEFAULTS.skills.indexChars, maxSkillLines: DEFAULTS.curator.maxSkillLines });
        items.push(item("kit-skill", ref.relFile, plain(r.errors), plain(r.warnings)));
      }
    }
    const seedConfig = readText(abs(root, KIT_SEED_CONFIG));
    if (seedConfig === null) {
      items.push(item("kit-seed", KIT_SEED_CONFIG, asFindings(["the seed config.json is missing"]), [], { found: false }));
    } else {
      /** @type {{ errors: string[], warnings: string[] }} */
      let r;
      try {
        r = validateConfig(JSON.parse(seedConfig));
      } catch (error) {
        r = { errors: [`the seed config.json is not valid JSON: ${error instanceof Error ? error.message : error}`], warnings: [] };
      }
      items.push(item("kit-seed", KIT_SEED_CONFIG, asFindings(r.errors), asFindings(r.warnings)));
    }
    const seedLessons = readText(abs(root, KIT_SEED_LESSONS));
    if (seedLessons === null) {
      items.push(item("kit-seed", KIT_SEED_LESSONS, asFindings(["the seed LESSONS.md is missing"]), [], { found: false }));
    } else {
      const r = lessonsResult(seedLessons, DEFAULTS.lessons.capChars, DEFAULTS.lessons.maxEntryChars);
      items.push(item("kit-seed", KIT_SEED_LESSONS, r.errors, r.warnings, { note: r.note }));
    }
  }

  return {
    root,
    items,
    errors: items.reduce((n, i) => n + i.errors.length, 0),
    warnings: items.reduce((n, i) => n + i.warnings.length, 0),
  };
}

/**
 * @param {number} n
 * @param {string} word
 * @returns {string}
 */
const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The plain-text report.
 * @param {ValidationResult} result
 * @param {{ strict?: boolean }} [options]
 * @returns {string}
 */
export function formatReport(result, options = {}) {
  const lines = [`Hermod validate: ${result.root}`];
  for (const it of result.items) {
    const status = it.status === "warn" ? "warning" : it.status;
    const note = it.note ? ` (${it.note})` : "";
    lines.push(`${status.padEnd(8)}${it.kind.padEnd(10)}${it.target}${note}`);
    for (const f of it.errors) lines.push(`          error${f.line ? ` (line ${f.line})` : ""}: ${f.message}`);
    for (const f of it.warnings) lines.push(`          warning${f.line ? ` (line ${f.line})` : ""}: ${f.message}`);
  }
  if (result.errors > 0) {
    lines.push(`failed: ${count(result.errors, "error")}, ${count(result.warnings, "warning")}`);
  } else if (result.warnings > 0) {
    lines.push(options.strict ? `failed: ${count(result.warnings, "warning")} (--strict)` : `ok with ${count(result.warnings, "warning")}`);
  } else {
    lines.push("ok");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Runs the CLI. Returns the exit code instead of exiting (the caller sets it).
 * @param {string[]} argv arguments after the script name
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv, cwd?: string }} [io]
 * @returns {number}
 */
export function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  /** @type {{ root?: string, strict?: boolean, json?: boolean, kit?: boolean, help?: boolean }} */
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        root: { type: "string" },
        strict: { type: "boolean" },
        json: { type: "boolean" },
        kit: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    stderr.write(`validate: ${error instanceof Error ? error.message : error}\n\n${USAGE}\n`);
    return 1;
  }
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const root = resolveRoot({ root: args.root ?? null, env: io.env, cwd: io.cwd, useGit: true });
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      stderr.write(`validate: the root folder ${root} does not exist\n`);
      return 1;
    }
    const result = validateRepo(root, { kit: args.kit ?? false });
    const failed = result.errors > 0 || (Boolean(args.strict) && result.warnings > 0);
    if (args.json) {
      stdout.write(`${JSON.stringify({ ok: !failed, strict: Boolean(args.strict), ...result }, null, 2)}\n`);
    } else {
      stdout.write(formatReport(result, { strict: args.strict }));
    }
    return failed ? 1 : 0;
  } catch (error) {
    stderr.write(`validate failed: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
