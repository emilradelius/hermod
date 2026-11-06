// @ts-check
/**
 * Skills: `.claude/skills/<name>/SKILL.md` in the agentskills.io format that Claude Code reads.
 * listSkills() finds them, validateSkill() checks one, indexLine() makes the one line the brief shows.
 *
 * Errors: SKILL.md missing; frontmatter missing or invalid; name missing, not lowercase-and-hyphens, longer
 * than 64 characters or different from the folder name; description missing, empty or over 1,024
 * characters; a markdown link into references/, scripts/, templates/ or assets/ that does not exist (or
 * leaves the skill folder), and a `code` path into one of those folders that does not exist when the skill
 * folder has that folder; prompt-injection findings of severity error; anything that looks like a secret.
 * Warnings: unknown frontmatter keys; a first sentence of the description longer than skills.indexChars;
 * a body longer than curator.maxSkillLines lines; unexpected entries in the skill folder; doubtful values
 * of known keys; description + when_to_use longer than Claude Code's 1,536-character listing; prompt-
 * injection findings of severity warn.
 */
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";
import { scanText } from "./injection.mjs";
import { graphemeEnd, isPlainObject, readText } from "./io.mjs";
import { normalizeRelPath } from "./paths.mjs";
import { detectSecrets } from "./redact.mjs";

export const SKILL_FILE = "SKILL.md";
export const DEFAULT_SKILLS_DIR = ".claude/skills";
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_NAME_CHARS = 64;
export const MAX_DESCRIPTION_CHARS = 1024;
/** Claude Code cuts description + when_to_use at this length in its skill listing. */
export const LISTING_CHARS = 1536;
/** Keys from the agentskills.io specification. */
export const AGENTSKILLS_KEYS = Object.freeze(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
/** Keys Claude Code reads in addition. */
export const CLAUDE_CODE_KEYS = Object.freeze([
  "when_to_use",
  "argument-hint",
  "arguments",
  "disable-model-invocation",
  "user-invocable",
  "disallowed-tools",
  "model",
  "effort",
  "context",
  "agent",
  "background",
  "hooks",
  "paths",
  "shell",
]);
export const ALLOWED_FRONTMATTER_KEYS = Object.freeze(new Set([...AGENTSKILLS_KEYS, ...CLAUDE_CODE_KEYS]));
/** What may sit directly in a skill folder. */
export const ALLOWED_SKILL_ENTRIES = Object.freeze(["SKILL.md", "references", "scripts", "templates", "assets"]);
const LINK_DIRS = ["references", "scripts", "templates", "assets"];
const IGNORED_ENTRIES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const ABBREVIATIONS = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|approx|incl|al|resp|no|nr|t\.ex|bl\.a|m\.m|s\.k|d\.v\.s)\.$/i;

/**
 * @typedef {object} SkillRef
 * @property {string} name folder name
 * @property {string} dir absolute folder path
 * @property {string} relDir posix, relative to the root
 * @property {string} file absolute path of SKILL.md
 * @property {string} relFile posix, relative to the root
 */

/**
 * @typedef {object} SkillFinding
 * @property {string} message plain English
 * @property {number | null} line 1-based line in SKILL.md, when known
 */

/**
 * @typedef {object} SkillReport
 * @property {string} name folder name
 * @property {string} dir
 * @property {string} file
 * @property {SkillFinding[]} errors
 * @property {SkillFinding[]} warnings
 * @property {{ name: string | null, description: string | null, firstSentence: string, lines: number, chars: number }} meta
 */

/**
 * The skill folders in `dir` (relative to root), sorted by name. Hidden folders are skipped. A missing
 * folder gives [].
 * @param {string} root
 * @param {string} [dir] default ".claude/skills"
 * @returns {SkillRef[]}
 */
export function listSkills(root, dir = DEFAULT_SKILLS_DIR) {
  const rel = normalizeRelPath(dir);
  if (rel === null) return [];
  const abs = path.join(path.resolve(root), ...rel.split("/"));
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {SkillRef[]} */
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const skillDir = path.join(abs, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(skillDir).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    out.push({
      name: e.name,
      dir: skillDir,
      relDir: `${rel}/${e.name}`,
      file: path.join(skillDir, SKILL_FILE),
      relFile: `${rel}/${e.name}/${SKILL_FILE}`,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The first sentence of a description, on one line: up to the first ".", "!" or "?" that is followed by
 * whitespace and a capital letter or digit (or ends the text). Common abbreviations ("e.g.") do not end a
 * sentence. Only the first paragraph is used.
 * @param {unknown} description
 * @returns {string}
 */
export function firstSentence(description) {
  const text = String(description ?? "").trim();
  if (text === "") return "";
  const flat = text.split(/\n[ \t]*\n/)[0].replace(/\s+/g, " ").trim();
  const re = /[.!?](?=\s+["'([]?[\p{Lu}\p{N}]|\s*$)/gu;
  for (let m = re.exec(flat); m !== null; m = re.exec(flat)) {
    const candidate = flat.slice(0, m.index + 1);
    if (m[0] === "." && ABBREVIATIONS.test(candidate)) continue;
    return candidate;
  }
  return flat;
}

/**
 * Cuts text to at most max characters (with "…"), at a word boundary when that keeps most of it, never
 * inside a grapheme.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function cutAtWord(text, max) {
  if (text.length <= max) return text;
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  let cut = graphemeEnd(text, max - 1);
  const space = text.lastIndexOf(" ", cut);
  if (space >= Math.floor(max * 0.6)) cut = space;
  return `${text.slice(0, cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/**
 * The brief's index line for a skill: "name: <first sentence of the description, cut to maxChars with …>".
 * @param {{ name?: unknown, description?: unknown }} skill
 * @param {number} [maxChars] skills.indexChars (default 60)
 * @returns {string}
 */
export function indexLine(skill, maxChars = 60) {
  const name = String(skill?.name ?? "").trim();
  const sentence = firstSentence(skill?.description ?? "");
  return `${name}: ${cutAtWord(sentence, Math.max(1, Math.floor(maxChars)))}`;
}

/**
 * Reads a skill's SKILL.md and frontmatter (no validation).
 * @param {string} skillDir
 * @returns {{ text: string | null, frontmatter: ReturnType<typeof parseFrontmatter> | null, name: string | null, description: string | null }}
 */
export function readSkill(skillDir) {
  const text = readText(path.join(skillDir, SKILL_FILE));
  if (text === null) return { text: null, frontmatter: null, name: null, description: null };
  const frontmatter = parseFrontmatter(text);
  const data = frontmatter.data ?? {};
  return {
    text,
    frontmatter,
    name: typeof data.name === "string" ? data.name : null,
    description: typeof data.description === "string" ? data.description : null,
  };
}

/**
 * Index lines for every skill with a readable name and description, sorted by name.
 * @param {string} root
 * @param {{ dir?: string, indexChars?: number }} [options]
 * @returns {Array<{ name: string, line: string }>}
 */
export function skillIndex(root, options = {}) {
  /** @type {Array<{ name: string, line: string }>} */
  const out = [];
  for (const ref of listSkills(root, options.dir ?? DEFAULT_SKILLS_DIR)) {
    const skill = readSkill(ref.dir);
    if (!skill.description || skill.description.trim() === "") continue;
    const name = skill.name && SKILL_NAME_RE.test(skill.name) ? skill.name : ref.name;
    out.push({ name, line: indexLine({ name, description: skill.description }, options.indexChars ?? 60) });
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function shown(value) {
  if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}...` : value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "a map" : String(value);
}

/**
 * Local file references in the body: markdown links, reference definitions ("link") and `code` spans
 * ("code") whose path names something inside references/, scripts/, templates/ or assets/. Fenced code is
 * skipped, and so are globs and placeholders ("references/*.md", "scripts/<name>.sh").
 * @param {string} body
 * @param {number} firstLine line number of body's first line
 * @returns {Array<{ target: string, line: number, kind: "link" | "code" }>}
 */
function localReferences(body, firstLine) {
  /** @type {Array<{ target: string, line: number, kind: "link" | "code" }>} */
  const out = [];
  /** @type {{ char: string, length: number } | null} */
  let fence = null;
  body.split("\n").forEach((line, k) => {
    const n = firstLine + k;
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      return;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      return;
    }
    /** @type {Array<{ raw: string, kind: "link" | "code" }>} */
    const candidates = [];
    for (const m of line.matchAll(/\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)) {
      candidates.push({ raw: m[1], kind: "link" });
    }
    const def = /^ {0,3}\[[^\]]+\]:\s*(<[^>\n]*>|\S+)/.exec(line);
    if (def) candidates.push({ raw: def[1], kind: "link" });
    for (const m of line.matchAll(/(`+)([^`\n]+?)\1/g)) candidates.push({ raw: m[2].trim().split(/\s+/)[0] ?? "", kind: "code" });
    for (const { raw, kind } of candidates) {
      let target = raw.replace(/^<|>$/g, "").replace(/[#?].*$/, "");
      try {
        target = decodeURI(target);
      } catch {
        // keep it as written
      }
      target = target.replace(/^\.\//, "");
      const segments = target.split("/");
      // "references/" on its own names the folder in general; only paths to something inside it are checked.
      if (!LINK_DIRS.includes(segments[0]) || segments.filter(Boolean).length < 2) continue;
      if (/[*?<>{}$|[\]]/.test(target)) continue;
      out.push({ target, line: n, kind });
    }
  });
  return out;
}

/**
 * Validates one skill folder.
 * @param {string} skillDir absolute path
 * @param {{ indexChars?: number, maxSkillLines?: number }} [options] defaults 60 and 500
 * @returns {SkillReport}
 */
export function validateSkill(skillDir, options = {}) {
  const indexChars = options.indexChars ?? 60;
  const maxLines = options.maxSkillLines ?? 500;
  const dirName = path.basename(skillDir);
  /** @type {SkillFinding[]} */
  const errors = [];
  /** @type {SkillFinding[]} */
  const warnings = [];
  /** @type {SkillReport} */
  const report = {
    name: dirName,
    dir: skillDir,
    file: path.join(skillDir, SKILL_FILE),
    errors,
    warnings,
    meta: { name: null, description: null, firstSentence: "", lines: 0, chars: 0 },
  };
  /** @param {string} message @param {number | null} [line] */
  const err = (message, line = null) => errors.push({ message, line });
  /** @param {string} message @param {number | null} [line] */
  const warn = (message, line = null) => warnings.push({ message, line });

  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(skillDir, { withFileTypes: true });
  } catch {
    err(`the skill folder "${dirName}" cannot be read`);
    return report;
  }
  const names = entries.map((e) => e.name);
  const hasSkillFile = names.includes(SKILL_FILE);
  if (!hasSkillFile) {
    const variant = names.find((n) => n.toLowerCase() === "skill.md");
    err(variant ? `the skill file is called ${variant}; rename it to SKILL.md` : "SKILL.md is missing");
  }
  for (const e of entries) {
    if (e.name === SKILL_FILE || IGNORED_ENTRIES.has(e.name) || e.name.toLowerCase() === "skill.md") continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(skillDir, e.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (LINK_DIRS.includes(e.name)) {
      if (!isDir) warn(`"${e.name}" should be a folder`);
      continue;
    }
    warn(`unexpected ${isDir ? "folder" : "file"} "${e.name}" in the skill folder (allowed: SKILL.md, references/, scripts/, templates/, assets/)`);
  }
  if (!hasSkillFile) return report;

  const text = readText(report.file);
  if (text === null) {
    err("SKILL.md cannot be read");
    return report;
  }
  const fm = parseFrontmatter(text);
  report.meta.chars = text.length;
  const bodyLines = fm.body.split("\n");
  report.meta.lines = bodyLines.length - (fm.body.endsWith("\n") ? 1 : 0);

  if (!fm.found) err("SKILL.md has no frontmatter: it must start with a --- line, then name: and description:, then ---", 1);
  for (const e of fm.errors) {
    const m = /^line (\d+): (.*)$/.exec(e);
    err(`frontmatter: ${m ? m[2] : e}`, m ? Number(m[1]) : null);
  }
  const data = fm.data ?? {};
  const strict = fm.found && fm.errors.length === 0;
  /** @param {string} key */
  const keyLine = (key) => {
    const lines = text.split(/\r?\n/);
    const idx = lines.findIndex((l, i) => i > 0 && i < fm.bodyStartLine - 1 && l.startsWith(`${key}:`));
    return idx === -1 ? null : idx + 1;
  };

  // name
  const name = data.name;
  if (name === undefined || name === null || name === "") {
    if (strict) err('the frontmatter has no "name"');
  } else if (typeof name !== "string") {
    err(`"name" must be text (got ${shown(name)})`, keyLine("name"));
  } else {
    report.meta.name = name;
    if (name.length > MAX_NAME_CHARS) err(`"name" is ${name.length} characters; the limit is ${MAX_NAME_CHARS}`, keyLine("name"));
    if (!SKILL_NAME_RE.test(name)) {
      err(
        `"name" ${shown(name)} must use lowercase letters, digits and single hyphens, and must not start or end with a hyphen`,
        keyLine("name"),
      );
    }
    if (name !== dirName) err(`"name" ${shown(name)} does not match the folder name "${dirName}"`, keyLine("name"));
  }

  // description
  const description = data.description;
  if (description === undefined || description === null) {
    if (strict) err('the frontmatter has no "description"');
  } else if (typeof description !== "string") {
    err(`"description" must be text (got ${shown(description)})`, keyLine("description"));
  } else if (description.trim() === "") {
    err('"description" is empty', keyLine("description"));
  } else {
    report.meta.description = description;
    const length = description.trimEnd().length;
    if (length > MAX_DESCRIPTION_CHARS) {
      err(`"description" is ${length} characters; the limit is ${MAX_DESCRIPTION_CHARS}`, keyLine("description"));
    }
    const sentence = firstSentence(description);
    report.meta.firstSentence = sentence;
    if (sentence.length > indexChars) {
      warn(
        `the first sentence of "description" is ${sentence.length} characters; the brief's index shows ${indexChars} (skills.indexChars), so it will be cut`,
        keyLine("description"),
      );
    }
    const whenToUse = typeof data.when_to_use === "string" ? data.when_to_use : "";
    if (description.length + whenToUse.length > LISTING_CHARS) {
      warn(`"description" and "when_to_use" together are over ${LISTING_CHARS} characters; Claude Code cuts the rest in its skill list`);
    }
  }

  // other keys
  for (const key of Object.keys(data)) {
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
      warn(`unknown frontmatter key "${key}" (Claude Code and agentskills.io do not read it)`, keyLine(key));
    }
  }
  if (data.compatibility !== undefined) {
    const c = data.compatibility;
    if (typeof c !== "string" || c.length < 1 || c.length > 500) {
      warn('"compatibility" should be text of 1 to 500 characters', keyLine("compatibility"));
    }
  }
  if (data.metadata !== undefined) {
    const meta = data.metadata;
    if (!isPlainObject(meta) || Object.values(meta).some((v) => typeof v !== "string")) {
      warn('"metadata" should map keys to text values (quote numbers such as version: "1.0")', keyLine("metadata"));
    }
  }
  if (data.license !== undefined && typeof data.license !== "string") warn('"license" should be text', keyLine("license"));
  for (const key of ["allowed-tools", "disallowed-tools"]) {
    const v = data[key];
    if (v !== undefined && typeof v !== "string" && !(Array.isArray(v) && v.every((t) => typeof t === "string"))) {
      warn(`"${key}" should be text or a list of tool names`, keyLine(key));
    }
  }

  // body
  if (report.meta.lines > maxLines) {
    warn(`the body is ${report.meta.lines} lines; keep SKILL.md under ${maxLines} (curator.maxSkillLines) and move detail into references/`);
  }
  // Markdown links are always checked, relative to the skill folder. A bare `code` path is checked only when
  // the skill folder has that top-level folder itself: `scripts/build.mjs` usually means the repository's own
  // scripts/ folder, not the skill's.
  /** @type {Map<string, boolean>} */
  const hasDir = new Map();
  /** @param {string} name */
  const skillHasDir = (name) => {
    if (!hasDir.has(name)) {
      let found;
      try {
        found = fs.statSync(path.join(skillDir, name)).isDirectory();
      } catch {
        found = false;
      }
      hasDir.set(name, found);
    }
    return hasDir.get(name) === true;
  };
  for (const ref of localReferences(fm.body, fm.bodyStartLine)) {
    if (ref.kind === "code" && !skillHasDir(ref.target.split("/")[0])) continue;
    const clean = normalizeRelPath(ref.target);
    if (clean === null) {
      err(`the link "${ref.target}" leaves the skill folder`, ref.line);
      continue;
    }
    if (!fs.existsSync(path.join(skillDir, ...clean.split("/")))) {
      err(`the link "${ref.target}" points to a file that does not exist in the skill folder`, ref.line);
    }
  }

  // safety
  // Uncapped scan, then capped per severity, so many warnings can never hide an error.
  const findings = scanText(text, { maxFindings: Infinity });
  for (const f of findings.filter((x) => x.severity === "error").slice(0, 50)) err(`${f.message}: ${f.excerpt}`, f.line);
  for (const f of findings.filter((x) => x.severity !== "error").slice(0, 20)) warn(`${f.message}: ${f.excerpt}`, f.line);
  for (const s of detectSecrets(text)) {
    err(`looks like it contains ${s.description} (${s.excerpt}); secrets must never be committed`, s.line);
  }
  return report;
}

/**
 * Validates every skill folder in `dir`.
 * @param {string} root
 * @param {{ dir?: string, indexChars?: number, maxSkillLines?: number }} [options]
 * @returns {SkillReport[]}
 */
export function validateSkills(root, options = {}) {
  return listSkills(root, options.dir ?? DEFAULT_SKILLS_DIR).map((ref) =>
    validateSkill(ref.dir, { indexChars: options.indexChars, maxSkillLines: options.maxSkillLines }),
  );
}
