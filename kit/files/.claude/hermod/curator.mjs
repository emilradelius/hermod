// @ts-check
/**
 * Hermod curator: a report on the health of this repo's skills and lessons. Report only; it never edits anything.
 *
 *   node .claude/hermod/curator.mjs [--root DIR] [--out FILE] [--json] [--now YYYY-MM-DD] [--help]
 *
 * Per skill: size (chars, lines), description and first-sentence length, last modified and patch count (git),
 * uses and views (from `.claude/hermod/usage/*.json`, which /reflect commits per session, plus the local ledger),
 * pinned (config curator.pinned), and a status:
 *   active; stale (no use for curator.staleDays, measured from the later of the last use and the day the skill
 *   was added); archive-candidate (curator.archiveDays). Pinned skills and skills owned by the kit (listed in
 *   `.claude/hermod/VERSION.json`) are exempt. While the ledger is off (config ledger.enabled), skill use is not
 *   recorded at all, so no skill is called stale or an archive candidate on age alone; the report says so.
 * Also: pairs of skills whose token sets overlap (Jaccard ≥ curator.overlapThreshold), skills that are too long
 * (lines > maxSkillLines or chars > maxSkillChars), and lessons: cap use, near-duplicates (Jaccard ≥ 0.6) and
 * lessons that restate a skill (≥ 80 % of the lesson's tokens are in one skill).
 *
 * The /curate skill turns the report into a pull request a person merges.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { tokenize } from "./lib/bm25.mjs";
import { loadConfig } from "./lib/config.mjs";
import { parseFrontmatter } from "./lib/frontmatter.mjs";
import { countCommits, lastCommitDate, runGit } from "./lib/git.mjs";
import { ensureLocalDir, hermodPath, isMainModule, isPlainObject, localDir, readJson, readText, resolveRoot, writeFileAtomic } from "./lib/io.mjs";
import { lessonsStats, parseLessons } from "./lib/lessons.mjs";
import { normalizeRelPath, relativeToRoot } from "./lib/paths.mjs";
import { redact } from "./lib/redact.mjs";
import { firstSentence, listSkills } from "./lib/skills.mjs";
import { collectUsage, daysBetween, isDate, laterDate } from "./lib/usage.mjs";

export const USAGE = `Usage: node .claude/hermod/curator.mjs [--root DIR] [--out FILE] [--json] [--now YYYY-MM-DD] [--help]

Reports on this repo's skills and lessons: unused (stale, archive candidates), overlapping and too-long skills,
and lessons that repeat each other or restate a skill. It changes nothing; /curate turns the report into a pull
request a person merges.

  --out FILE   write the report to FILE instead of printing it. A relative FILE is under the repository root and
               must be inside .claude/hermod/.local/; a file outside the repository needs an absolute path.
  --json       the report as JSON
  --now DATE   count days up to this date (YYYY-MM-DD; default today)
  --root DIR   the repository root (default: $CLAUDE_PROJECT_DIR, else the git top level of this folder)
  --help       show this help`;

export const FOOTER = "This report changes nothing. /curate turns it into a pull request a person merges.";
/** Lessons this similar (Jaccard of token sets) are near-duplicates. */
export const LESSON_DUPLICATE_THRESHOLD = 0.6;
/** A lesson restates a skill when at least this share of its tokens is in the skill. */
export const RESTATE_SHARE = 0.8;
/** Lessons with fewer distinct tokens are not compared with skills (too little to say anything). */
export const MIN_RESTATE_TOKENS = 4;
/** Lessons use this share of the cap or more → suggest making room. */
export const LESSONS_FULL_SHARE = 0.9;
const STAMP_FILE = "VERSION.json";
const EXCERPT_CHARS = 80;

/**
 * @typedef {"active" | "stale" | "archive-candidate" | "pinned" | "kit" | "invalid"} SkillStatus
 */

/**
 * @typedef {object} SkillRow
 * @property {string} name folder name
 * @property {string} path posix path of SKILL.md, relative to the root
 * @property {number} chars characters in SKILL.md
 * @property {number} lines lines of the body (after the frontmatter), as the validator counts them
 * @property {number} descriptionChars
 * @property {number} firstSentenceChars
 * @property {string | null} created YYYY-MM-DD the SKILL.md was added (git), else its modification day
 * @property {"git" | "mtime" | null} createdFrom
 * @property {string | null} lastModified YYYY-MM-DD of the last commit that touched the skill folder
 * @property {number} patches commits that touched the skill folder
 * @property {number} uses
 * @property {number} views
 * @property {number} sessions
 * @property {string | null} lastUsed
 * @property {string | null} since the later of lastUsed and created
 * @property {number | null} idleDays days from `since` to the report date
 * @property {boolean} pinned
 * @property {boolean} kit owned by the kit (listed in VERSION.json)
 * @property {SkillStatus} status
 * @property {string | null} problem why a skill is "invalid"
 */

/**
 * @typedef {object} Action
 * @property {"archive" | "review-stale" | "merge-skills" | "shorten-skill" | "merge-lessons" | "fold-lesson" | "trim-lessons"} kind
 * @property {string} target skill name(s) or lesson numbers
 * @property {string} text one line, with the evidence numbers
 */

/**
 * @typedef {object} CuratorReport
 * @property {string} date the report date (YYYY-MM-DD)
 * @property {{ staleDays: number, archiveDays: number, overlapThreshold: number, maxSkillLines: number, maxSkillChars: number, lessonDuplicateThreshold: number, restateShare: number, pinned: string[] }} settings
 * @property {string[]} configErrors
 * @property {{ tracked: boolean, files: number, invalidFiles: string[], ledgerEvents: number, ledgerSkipped: number, unknownSkills: string[] }} usage
 * @property {SkillRow[]} skills
 * @property {Array<{ a: string, b: string, similarity: number }>} overlaps
 * @property {Array<{ name: string, lines: number, chars: number, overLines: boolean, overChars: boolean }>} tooLong
 * @property {{ file: string, found: boolean, chars: number, cap: number, percent: number, entries: number, duplicates: Array<{ a: number, b: number, similarity: number }>, restates: Array<{ lesson: number, skill: string, share: number, kit: boolean }>, excerpts: Record<string, string> }} lessons
 * @property {Action[]} actions
 */

// ------------------------------------------------------------------------------------------- helpers

/**
 * Jaccard similarity of two sets (0 when both are empty).
 * @param {ReadonlySet<string>} a
 * @param {ReadonlySet<string>} b
 * @returns {number}
 */
export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let both = 0;
  for (const t of small) if (large.has(t)) both++;
  return both / (a.size + b.size - both);
}

/**
 * The share of `part`'s tokens that are also in `whole` (0 when part is empty).
 * @param {ReadonlySet<string>} part
 * @param {ReadonlySet<string>} whole
 * @returns {number}
 */
export function containment(part, whole) {
  if (part.size === 0) return 0;
  let both = 0;
  for (const t of part) if (whole.has(t)) both++;
  return both / part.size;
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenSet(text) {
  return new Set(tokenize(text));
}

/**
 * A local date as YYYY-MM-DD.
 * @param {Date} d
 * @returns {string}
 */
function localDate(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The day a file was added to git (the oldest commit that added it), else null.
 * @param {string} root
 * @param {string} rel posix
 * @returns {string | null}
 */
export function gitCreationDate(root, rel) {
  const clean = normalizeRelPath(rel);
  if (clean === null) return null;
  const r = runGit(root, ["log", "--diff-filter=A", "--format=%cs", "--", clean]);
  if (!r.ok) return null;
  const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return isDate(last) ? last : null;
}

/**
 * Skill names owned by the kit: `<skillsDir>/<name>/…` paths in `.claude/hermod/VERSION.json` (written by sync).
 * @param {string} root
 * @param {string} skillsDir posix
 * @returns {Set<string>}
 */
export function kitSkillNames(root, skillsDir) {
  /** @type {Set<string>} */
  const out = new Set();
  const { value } = readJson(hermodPath(root, STAMP_FILE));
  if (!isPlainObject(value) || !isPlainObject(value.files)) return out;
  const prefix = `${normalizeRelPath(skillsDir) ?? ".claude/skills"}/`;
  for (const p of Object.keys(value.files)) {
    if (!p.startsWith(prefix)) continue;
    const name = p.slice(prefix.length).split("/")[0];
    if (name) out.add(name);
  }
  return out;
}

/**
 * Text for a markdown table cell or a one-line excerpt: no pipes, backticks or line breaks.
 * @param {unknown} value
 * @returns {string}
 */
function cell(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'");
}

/**
 * @param {string} text
 * @returns {string}
 */
function excerpt(text) {
  const flat = redact(text).replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : flat;
}

/** @param {number} n */
const fmt = (n) => n.toLocaleString("en-US");
/** @param {number} n */
const fixed = (n) => (Math.floor(n * 100) / 100).toFixed(2);
/** @param {number} n */
const pct = (n) => `${Math.floor(n * 100)}%`;

// -------------------------------------------------------------------------------------------- report

/**
 * Builds the report. Reads only; never writes.
 * @param {string} root
 * @param {{ now?: string }} [options] now: the report date, YYYY-MM-DD (default today)
 * @returns {CuratorReport}
 */
export function buildReport(root, options = {}) {
  const date = options.now ?? localDate(new Date());
  if (!isDate(date)) throw new Error(`the date ${JSON.stringify(date)} is not a YYYY-MM-DD date`);
  const loaded = loadConfig(root);
  const config = loaded.config;
  const cur = config.curator;
  const pinned = new Set(cur.pinned);
  const kitSkills = kitSkillNames(root, config.skills.dir);
  const usage = collectUsage(root);
  // With the ledger off nothing records skill use, so days without a recorded use say nothing about a skill.
  const tracked = config.ledger.enabled !== false;

  /** @type {SkillRow[]} */
  const skills = [];
  /** @type {Map<string, Set<string>>} */
  const tokens = new Map();
  for (const ref of listSkills(root, config.skills.dir)) {
    const text = readText(ref.file);
    const used = usage.skills.get(ref.name);
    /** @type {SkillRow} */
    const row = {
      name: ref.name,
      path: ref.relFile,
      chars: 0,
      lines: 0,
      descriptionChars: 0,
      firstSentenceChars: 0,
      created: null,
      createdFrom: null,
      lastModified: lastCommitDate(root, ref.relDir),
      patches: countCommits(root, ref.relDir),
      uses: used?.uses ?? 0,
      views: used?.views ?? 0,
      sessions: used?.sessions ?? 0,
      lastUsed: used?.lastUsed ?? null,
      since: null,
      idleDays: null,
      pinned: pinned.has(ref.name),
      kit: kitSkills.has(ref.name),
      status: "active",
      problem: null,
    };
    const gitCreated = gitCreationDate(root, ref.relFile);
    if (gitCreated) {
      row.created = gitCreated;
      row.createdFrom = "git";
    } else {
      try {
        row.created = localDate(fs.statSync(text === null ? ref.dir : ref.file).mtime);
        row.createdFrom = "mtime";
      } catch {
        // stays null
      }
    }
    row.since = laterDate(row.lastUsed, row.created);
    row.idleDays = row.since === null ? null : Math.max(0, daysBetween(row.since, date));

    if (text === null) {
      row.status = "invalid";
      row.problem = "SKILL.md is missing or unreadable";
      skills.push(row);
      continue;
    }
    const fm = parseFrontmatter(text);
    const description = typeof fm.data?.description === "string" ? fm.data.description : "";
    row.chars = text.length;
    row.lines = fm.body.split("\n").length - (fm.body.endsWith("\n") ? 1 : 0);
    row.descriptionChars = description.trim().length;
    row.firstSentenceChars = firstSentence(description).length;
    tokens.set(ref.name, tokenSet(`${description}\n${fm.body}`));

    if (row.pinned) row.status = "pinned";
    else if (row.kit) row.status = "kit";
    else if (tracked && row.idleDays !== null && row.idleDays >= cur.archiveDays) row.status = "archive-candidate";
    else if (tracked && row.idleDays !== null && row.idleDays >= cur.staleDays) row.status = "stale";
    skills.push(row);
  }
  const known = new Set(skills.map((s) => s.name));
  const unknownSkills = [...usage.skills.keys()].filter((n) => !known.has(n)).sort();

  // Overlaps.
  /** @type {CuratorReport["overlaps"]} */
  const overlaps = [];
  const names = [...tokens.keys()];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const s = jaccard(/** @type {Set<string>} */ (tokens.get(names[i])), /** @type {Set<string>} */ (tokens.get(names[j])));
      if (s >= cur.overlapThreshold) overlaps.push({ a: names[i], b: names[j], similarity: s });
    }
  }
  overlaps.sort((x, y) => y.similarity - x.similarity || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));

  // Too long.
  const tooLong = skills
    .filter((s) => s.status !== "invalid" && (s.lines > cur.maxSkillLines || s.chars > cur.maxSkillChars))
    .map((s) => ({ name: s.name, lines: s.lines, chars: s.chars, overLines: s.lines > cur.maxSkillLines, overChars: s.chars > cur.maxSkillChars }));

  // Lessons.
  const lessonsRel = config.lessons.file;
  const lessonsAbs = path.join(path.resolve(root), ...lessonsRel.split("/"));
  const lessonsText = readText(lessonsAbs);
  const parsed = parseLessons(lessonsText ?? "");
  const stats = lessonsStats(parsed, config.lessons.capChars);
  const entries = parsed.entries.filter((e) => e.text !== "");
  const lessonTokens = entries.map((e) => tokenSet(e.text));
  /** @type {CuratorReport["lessons"]["duplicates"]} */
  const duplicates = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const s = jaccard(lessonTokens[i], lessonTokens[j]);
      if (s >= LESSON_DUPLICATE_THRESHOLD) duplicates.push({ a: entries[i].index + 1, b: entries[j].index + 1, similarity: s });
    }
  }
  /** @type {CuratorReport["lessons"]["restates"]} */
  const restates = [];
  entries.forEach((entry, i) => {
    if (lessonTokens[i].size < MIN_RESTATE_TOKENS) return;
    /** @type {{ skill: string, share: number } | null} */
    let best = null;
    for (const name of names) {
      const share = containment(lessonTokens[i], /** @type {Set<string>} */ (tokens.get(name)));
      if (share >= RESTATE_SHARE && (best === null || share > best.share)) best = { skill: name, share };
    }
    if (best) restates.push({ lesson: entry.index + 1, ...best, kit: kitSkills.has(best.skill) });
  });
  /** @type {Record<string, string>} */
  const excerpts = {};
  for (const n of new Set([...duplicates.flatMap((d) => [d.a, d.b]), ...restates.map((r) => r.lesson)])) {
    excerpts[String(n)] = excerpt(parsed.entries[n - 1]?.text ?? "");
  }
  const lessons = {
    file: lessonsRel,
    found: lessonsText !== null,
    chars: stats.chars,
    cap: stats.cap,
    percent: stats.cap > 0 ? stats.chars / stats.cap : 0,
    entries: stats.entries,
    duplicates,
    restates,
    excerpts,
  };

  // Suggested actions, most important first.
  /** @type {Action[]} */
  const actions = [];
  /** @param {SkillRow} s */
  const idleEvidence = (s) => {
    const from = s.lastUsed !== null && s.since === s.lastUsed ? `last used ${s.lastUsed}` : `no recorded use; added ${s.created}${s.createdFrom === "mtime" ? " (file date)" : ""}`;
    return `${s.idleDays} days without use (${from}; uses ${s.uses}, views ${s.views})`;
  };
  for (const s of skills.filter((x) => x.status === "archive-candidate")) {
    actions.push({
      kind: "archive",
      target: s.name,
      text: `Archive skill ${s.name}: ${idleEvidence(s)}; archive candidate at ${cur.archiveDays} days.`,
    });
  }
  for (const s of skills.filter((x) => x.status === "stale")) {
    actions.push({
      kind: "review-stale",
      target: s.name,
      text: `Review skill ${s.name}: ${idleEvidence(s)}; stale at ${cur.staleDays} days, archive candidate at ${cur.archiveDays}. Pin it if it should stay.`,
    });
  }
  for (const o of overlaps) {
    actions.push({
      kind: "merge-skills",
      target: `${o.a}, ${o.b}`,
      text: `Consider merging skills ${o.a} and ${o.b}: similarity ${fixed(o.similarity)} (threshold ${fixed(cur.overlapThreshold)}).`,
    });
  }
  for (const t of tooLong) {
    const parts = [];
    if (t.overLines) parts.push(`${fmt(t.lines)} lines (max ${fmt(cur.maxSkillLines)})`);
    if (t.overChars) parts.push(`${fmt(t.chars)} chars (max ${fmt(cur.maxSkillChars)})`);
    actions.push({ kind: "shorten-skill", target: t.name, text: `Move detail of skill ${t.name} into references/: ${parts.join(", ")}.` });
  }
  for (const d of duplicates) {
    actions.push({
      kind: "merge-lessons",
      target: `${d.a}, ${d.b}`,
      text: `Merge lessons ${d.a} and ${d.b}: similarity ${fixed(d.similarity)} (threshold ${fixed(LESSON_DUPLICATE_THRESHOLD)}).`,
    });
  }
  for (const r of restates) {
    actions.push({
      kind: "fold-lesson",
      target: `${r.lesson} → ${r.skill}`,
      text: r.kit
        ? `Lesson ${r.lesson} restates kit skill ${r.skill}: ${pct(r.share)} of its words are in the skill (threshold ${pct(RESTATE_SHARE)}); consider removing it (kit skills change in hermod).`
        : `Fold lesson ${r.lesson} into skill ${r.skill}: ${pct(r.share)} of its words are in the skill (threshold ${pct(RESTATE_SHARE)}).`,
    });
  }
  if (lessons.found && lessons.percent >= LESSONS_FULL_SHARE) {
    actions.push({
      kind: "trim-lessons",
      target: lessonsRel,
      text: `Make room in the lessons: ${fmt(lessons.chars)} of ${fmt(lessons.cap)} chars (${pct(lessons.percent)}; suggested at ${pct(LESSONS_FULL_SHARE)}). Merge, shorten, or move detail into skills.`,
    });
  }

  return {
    date,
    settings: {
      staleDays: cur.staleDays,
      archiveDays: cur.archiveDays,
      overlapThreshold: cur.overlapThreshold,
      maxSkillLines: cur.maxSkillLines,
      maxSkillChars: cur.maxSkillChars,
      lessonDuplicateThreshold: LESSON_DUPLICATE_THRESHOLD,
      restateShare: RESTATE_SHARE,
      pinned: [...cur.pinned],
    },
    configErrors: loaded.errors.map((e) => redact(e)),
    usage: {
      tracked,
      files: usage.files,
      invalidFiles: usage.invalidFiles,
      ledgerEvents: usage.ledgerEvents,
      ledgerSkipped: usage.ledgerSkipped,
      unknownSkills,
    },
    skills,
    overlaps,
    tooLong,
    lessons,
    actions,
  };
}

/**
 * The report as markdown.
 * @param {CuratorReport} r
 * @returns {string}
 */
export function formatReport(r) {
  const st = r.settings;
  /** @type {string[]} */
  const out = [`# Hermod curator report (${r.date})`, "", "## Summary"];
  /** @param {SkillStatus} k */
  const nStatus = (k) => r.skills.filter((s) => s.status === k).length;
  out.push(
    `- Skills: ${r.skills.length} (${nStatus("active")} active, ${nStatus("stale")} stale, ${nStatus("archive-candidate")} archive candidates, ${nStatus("pinned")} pinned, ${nStatus("kit")} kit, ${nStatus("invalid")} invalid). Stale after ${st.staleDays} days without use, archive candidate after ${st.archiveDays}.`,
  );
  let usageLine = `- Usage: ${r.usage.files} usage files, ${r.usage.ledgerEvents} skill events from the local ledger`;
  if (r.usage.ledgerSkipped > 0) usageLine += ` (${r.usage.ledgerSkipped} more already in usage files)`;
  usageLine += ".";
  if (!r.usage.tracked) {
    usageLine += " Skill use is not recorded while the ledger is off (ledger.enabled in config.json), so no skill is called stale or an archive candidate on age alone.";
  }
  if (r.usage.invalidFiles.length > 0) usageLine += ` Skipped ${r.usage.invalidFiles.length} unreadable usage files: ${r.usage.invalidFiles.slice(0, 5).map(cell).join(", ")}${r.usage.invalidFiles.length > 5 ? ", …" : ""}.`;
  if (r.usage.unknownSkills.length > 0) usageLine += ` Usage of ${r.usage.unknownSkills.length} skills that no longer exist was ignored.`;
  out.push(usageLine);
  out.push(`- Overlapping skill pairs: ${r.overlaps.length} (similarity ≥ ${fixed(st.overlapThreshold)}).`);
  out.push(`- Too long: ${r.tooLong.length} (over ${fmt(st.maxSkillLines)} lines or ${fmt(st.maxSkillChars)} chars).`);
  if (r.lessons.found) {
    out.push(
      `- Lessons: ${fmt(r.lessons.chars)} of ${fmt(r.lessons.cap)} chars (${pct(r.lessons.percent)}), ${r.lessons.entries} entries; ${r.lessons.duplicates.length} near-duplicate pairs, ${r.lessons.restates.length} restating a skill.`,
    );
  } else {
    out.push(`- Lessons: ${cell(r.lessons.file)} not found.`);
  }
  out.push(`- Suggested actions: ${r.actions.length}.`);
  for (const e of r.configErrors) out.push(`- Config problem (defaults used): ${cell(e)}`);

  out.push("", "## Skills");
  if (r.skills.length === 0) out.push("No skills found.");
  else {
    out.push(
      "| Skill | Status | Uses | Views | Last used | Added | Idle days | Last modified | Patches | Lines | Chars | Description | First sentence |",
      "|---|---|---:|---:|---|---|---:|---|---:|---:|---:|---:|---:|",
    );
    for (const s of r.skills) {
      const status = s.status === "invalid" ? `invalid: ${s.problem}` : s.status;
      const added = s.created === null ? "?" : `${s.created}${s.createdFrom === "mtime" ? " (file)" : ""}`;
      out.push(
        `| ${cell(s.name)} | ${cell(status)} | ${s.uses} | ${s.views} | ${s.lastUsed ?? "never"} | ${added} | ${s.idleDays ?? "?"} | ${s.lastModified ?? "not committed"} | ${s.patches} | ${s.lines} | ${s.chars} | ${s.descriptionChars} | ${s.firstSentenceChars} |`,
      );
    }
  }

  out.push("", "## Overlaps");
  if (r.overlaps.length === 0) out.push("None.");
  for (const o of r.overlaps) out.push(`- ${cell(o.a)} and ${cell(o.b)}: similarity ${fixed(o.similarity)} → consider merging.`);

  out.push("", "## Too long");
  if (r.tooLong.length === 0) out.push("None.");
  for (const t of r.tooLong) out.push(`- ${cell(t.name)}: ${fmt(t.lines)} lines, ${fmt(t.chars)} chars → move detail into references/.`);

  out.push("", "## Lessons");
  if (!r.lessons.found) out.push(`${cell(r.lessons.file)} not found.`);
  else {
    out.push(`Cap use: ${fmt(r.lessons.chars)} of ${fmt(r.lessons.cap)} chars (${pct(r.lessons.percent)}), ${r.lessons.entries} entries.`);
    /** @param {number} n */
    const quote = (n) => `"${cell(r.lessons.excerpts[String(n)] ?? "")}"`;
    if (r.lessons.duplicates.length === 0 && r.lessons.restates.length === 0) out.push("No near-duplicates, and no lesson restates a skill.");
    for (const d of r.lessons.duplicates) {
      out.push(`- Lessons ${d.a} and ${d.b} are near-duplicates (similarity ${fixed(d.similarity)}): ${quote(d.a)} / ${quote(d.b)}`);
    }
    for (const x of r.lessons.restates) {
      out.push(`- Lesson ${x.lesson} restates skill ${cell(x.skill)} (${pct(x.share)} of its words): ${quote(x.lesson)} → fold into skill ${cell(x.skill)}.`);
    }
  }

  out.push("", "## Suggested actions");
  if (r.actions.length === 0) out.push("Nothing to do.");
  r.actions.forEach((a, i) => out.push(`${i + 1}. ${cell(a.text)}`));

  out.push("", "---", FOOTER, "");
  return out.join("\n");
}

// ------------------------------------------------------------------------------------------------ out

/**
 * Where --out may write: inside the repository only under `.claude/hermod/.local/`; outside it only an absolute
 * path. Returns the absolute file path or throws with a plain reason.
 * @param {string} root
 * @param {string} out
 * @returns {string}
 */
export function resolveOutPath(root, out) {
  if (typeof out !== "string" || out.trim() === "" || out.includes("\0")) throw new Error("--out needs a file name");
  const absRoot = path.resolve(root);
  const abs = path.isAbsolute(out) ? path.resolve(out) : path.resolve(absRoot, out);
  if (abs === absRoot) throw new Error(`--out ${out} is the repository folder`);
  const rel = relativeToRoot(absRoot, abs);
  if (rel === null) {
    // Outside the repository: only when asked for explicitly, with an absolute path.
    if (!path.isAbsolute(out)) throw new Error(`--out ${out} leads outside the repository; give an absolute path for a file outside it`);
  } else {
    if (!rel.startsWith(".claude/hermod/.local/")) {
      throw new Error(`--out may only write inside the repository under .claude/hermod/.local/ (got ${out})`);
    }
    const local = ensureLocalDir(absRoot);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const inside = path.relative(fs.realpathSync.native(local), fs.realpathSync.native(path.dirname(abs)));
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      throw new Error(`refusing to write ${out}: its folder leads outside ${path.relative(absRoot, localDir(absRoot))}`);
    }
  }
  try {
    if (fs.statSync(abs).isDirectory()) throw new Error(`--out ${out} is a folder`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("--out")) throw error;
  }
  return abs;
}

// ----------------------------------------------------------------------------------------------- CLI

/**
 * Runs the CLI. Returns the exit code (0 report written, 1 failure, 2 usage error).
 * @param {string[]} argv
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv, cwd?: string }} [io]
 * @returns {number}
 */
export function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  /** @type {{ root?: string, out?: string, json?: boolean, now?: string, help?: boolean }} */
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        root: { type: "string" },
        out: { type: "string" },
        json: { type: "boolean" },
        now: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    stderr.write(`curator: ${error instanceof Error ? error.message : error}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.now !== undefined && !isDate(args.now)) {
    stderr.write(`curator: --now must be a date written YYYY-MM-DD (got ${JSON.stringify(args.now)})\n`);
    return 2;
  }
  try {
    const root = resolveRoot({ root: args.root ?? null, env: io.env, cwd: io.cwd, useGit: true });
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      stderr.write(`curator: the root folder ${root} does not exist\n`);
      return 1;
    }
    const report = buildReport(root, { now: args.now });
    const text = args.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report);
    if (args.out !== undefined) {
      const file = resolveOutPath(root, args.out);
      writeFileAtomic(file, text);
      const shown = relativeToRoot(root, file) ?? file;
      stdout.write(`Wrote ${shown} (${report.actions.length} suggested actions). ${FOOTER}\n`);
    } else {
      stdout.write(text);
    }
    return 0;
  } catch (error) {
    stderr.write(`curator: ${redact(error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
