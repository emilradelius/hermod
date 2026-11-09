// @ts-check
/**
 * `.claude/hermod/LESSONS.md`: short declarative facts, separated by lines that contain only "§".
 *
 *   # Lessons
 *   <!-- hermod:lessons — ... -->
 *
 *   First fact as a declarative sentence; may continue on the next line.
 *   §
 *   Second fact.
 *
 * Header = everything up to and including the first HTML comment block that follows an optional H1 (both
 * optional). Body = the rest; entries are split on lines that contain only "§". The cap applies to the
 * entries joined by SEPARATOR.
 */
import { stripBom } from "./io.mjs";
import { scanErrors } from "./injection.mjs";
import { detectSecrets } from "./redact.mjs";

/** The canonical separator between entries. */
export const SEPARATOR = "\n§\n";

/** The header of a new LESSONS.md (the seed file is this plus a newline). */
export const LESSONS_HEADER = [
  "# Lessons",
  "<!-- hermod:lessons — declarative facts, separated by a line containing only §. Cap in config.json",
  "     (lessons.capChars). Changes go through a pull request. -->",
].join("\n");

const SEPARATOR_LINE = /^[ \t]*§[ \t]*$/;
const IMPERATIVE =
  /^(always|never|do not|don['’]t|make sure|remember( to)?|ensure|you must|you should|please|ignore|forget)\b/i;
const DATE = /\b20\d\d-\d\d-\d\d\b/;
const PR_REFERENCE = /\bPR\s*#?\d+\b|(^|\s)#\d{2,}\b/;
const SOFT_ENTRY_CHARS = 300;

/**
 * @typedef {object} LessonEntry
 * @property {string} text the entry, trimmed
 * @property {number} line 1-based line where the entry's text starts
 * @property {number} index 0-based position
 */

/**
 * @typedef {object} ParsedLessons
 * @property {string} header
 * @property {string} body
 * @property {number} bodyStartLine
 * @property {LessonEntry[]} entries
 */

/**
 * @typedef {object} LessonFinding
 * @property {string} message plain English
 * @property {number | null} line 1-based line in the file
 * @property {number | null} entry 1-based entry number
 */

/**
 * @typedef {object} LessonsReport
 * @property {LessonFinding[]} errors
 * @property {LessonFinding[]} warnings
 * @property {{ chars: number, cap: number, entries: number }} stats
 * @property {ParsedLessons} parsed
 */

/**
 * Splits LESSONS.md into header, body and entries.
 * @param {unknown} text
 * @returns {ParsedLessons}
 */
export function parseLessons(text) {
  const lines = stripBom(String(text ?? "")).replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  let headerEnd = 0;
  if (i < lines.length && /^ {0,3}#(?:[ \t]|$)/.test(lines[i])) {
    i++;
    headerEnd = i;
  }
  let j = i;
  while (j < lines.length && lines[j].trim() === "") j++;
  if (j < lines.length && lines[j].trimStart().startsWith("<!--")) {
    const open = lines[j].indexOf("<!--") + 4;
    for (let k = j; k < lines.length; k++) {
      if (lines[k].indexOf("-->", k === j ? open : 0) !== -1) {
        headerEnd = k + 1;
        break;
      }
    }
  }
  const header = lines.slice(0, headerEnd).join("\n").trim();
  const bodyLines = lines.slice(headerEnd);
  const body = bodyLines.join("\n");
  /** @type {LessonEntry[]} */
  const entries = [];
  if (body.trim() !== "") {
    /** @type {{ start: number, lines: string[] }} */
    let group = { start: headerEnd + 1, lines: [] };
    /** @param {{ start: number, lines: string[] }} g */
    const push = (g) => {
      const firstText = g.lines.findIndex((l) => l.trim() !== "");
      entries.push({
        text: g.lines.join("\n").trim(),
        line: g.start + (firstText === -1 ? 0 : firstText),
        index: entries.length,
      });
    };
    bodyLines.forEach((line, k) => {
      if (SEPARATOR_LINE.test(line)) {
        push(group);
        group = { start: headerEnd + k + 2, lines: [] };
      } else {
        group.lines.push(line);
      }
    });
    push(group);
  }
  return { header, body, bodyStartLine: headerEnd + 1, entries };
}

/**
 * Builds LESSONS.md text: the header, a blank line, then the entries joined by SEPARATOR. Empty entries are
 * dropped.
 * @param {{ header?: string, entries?: ReadonlyArray<string | { text: string }> }} lessons
 * @returns {string}
 */
export function serializeLessons(lessons) {
  const header = String(lessons?.header ?? "").trim();
  const entries = (lessons?.entries ?? [])
    .map((e) => (typeof e === "string" ? e : String(e?.text ?? "")).trim())
    .filter((e) => e !== "");
  const body = entries.join(SEPARATOR);
  if (header === "") return body === "" ? "" : `${body}\n`;
  return body === "" ? `${header}\n` : `${header}\n\n${body}\n`;
}

/**
 * The form used to detect duplicates: lower case, whitespace collapsed.
 * @param {string} text
 * @returns {string}
 */
export function normalizeEntry(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Size of the lessons as counted against the cap: the entries joined by SEPARATOR.
 * @param {ParsedLessons} parsed
 * @param {number} cap
 * @returns {{ chars: number, cap: number, entries: number }}
 */
export function lessonsStats(parsed, cap) {
  const chars = parsed.entries.map((e) => e.text).join(SEPARATOR).length;
  return { chars, cap, entries: parsed.entries.filter((e) => e.text !== "").length };
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {number} 0-based line offset of index inside text
 */
function lineOffset(text, index) {
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/**
 * Validates LESSONS.md text.
 * Errors: over the cap; an empty entry; a duplicate entry; an entry longer than maxEntryChars; an entry
 * that starts with "#"; prompt-injection findings of severity error; anything that looks like a secret.
 * Warnings: an entry that starts with an imperative; a date; a pull-request or issue reference; an entry
 * over 300 characters.
 * @param {unknown} text
 * @param {{ capChars?: number, maxEntryChars?: number }} [options] defaults 4000 and 400
 * @returns {LessonsReport}
 */
export function validateLessons(text, options = {}) {
  const cap = options.capChars ?? 4000;
  const maxEntry = options.maxEntryChars ?? 400;
  const parsed = parseLessons(text);
  /** @type {LessonFinding[]} */
  const errors = [];
  /** @type {LessonFinding[]} */
  const warnings = [];
  const stats = lessonsStats(parsed, cap);

  if (stats.chars > cap) {
    errors.push({
      message: `The lessons are ${stats.chars} characters; the cap is ${cap} (lessons.capChars). Remove or shorten entries, or move detail into a skill.`,
      line: null,
      entry: null,
    });
  }

  const headerStart = (stripBom(String(text ?? "")).replace(/\r\n?/g, "\n").split("\n").findIndex((l) => l.trim() !== "")) + 1;
  for (const f of scanErrors(parsed.header)) {
    errors.push({ message: `The header ${f.message}.`, line: headerStart + f.line - 1, entry: null });
  }
  for (const s of detectSecrets(parsed.header)) {
    errors.push({
      message: `The header looks like it contains ${s.description} (${s.excerpt}); secrets must never be committed.`,
      line: headerStart + s.line - 1,
      entry: null,
    });
  }

  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const entry of parsed.entries) {
    const n = entry.index + 1;
    const at = { line: entry.line, entry: n };
    if (entry.text === "") {
      errors.push({ message: `Entry ${n} is empty; remove the extra § line.`, ...at });
      continue;
    }
    const key = normalizeEntry(entry.text);
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push({ message: `Entry ${n} repeats entry ${first} (ignoring case and spacing).`, ...at });
    } else {
      seen.set(key, n);
    }
    const len = entry.text.length;
    if (len > maxEntry) {
      errors.push({
        message: `Entry ${n} is ${len} characters; the limit is ${maxEntry} (lessons.maxEntryChars). Shorten it or move the detail into a skill.`,
        ...at,
      });
    } else if (len > SOFT_ENTRY_CHARS) {
      warnings.push({ message: `Entry ${n} is ${len} characters; aim for ${SOFT_ENTRY_CHARS} or fewer.`, ...at });
    }
    if (entry.text.startsWith("#")) {
      errors.push({ message: `Entry ${n} starts with "#"; lessons are plain sentences, not headings.`, ...at });
    }
    for (const f of scanErrors(entry.text)) {
      errors.push({ message: `Entry ${n} ${f.message}.`, line: entry.line + f.line - 1, entry: n });
    }
    for (const s of detectSecrets(entry.text)) {
      errors.push({
        message: `Entry ${n} looks like it contains ${s.description} (${s.excerpt}); secrets must never be committed.`,
        line: entry.line + lineOffset(entry.text, s.index),
        entry: n,
      });
    }
    const imperative = IMPERATIVE.exec(entry.text);
    if (imperative) {
      warnings.push({
        message: `Entry ${n} starts with "${imperative[0]}"; write lessons as facts ("X does Y because Z"), not orders.`,
        ...at,
      });
    }
    const date = DATE.exec(entry.text);
    if (date) {
      warnings.push({
        message: `Entry ${n} contains a date (${date[0]}); a lesson should stay true without one.`,
        line: entry.line + lineOffset(entry.text, date.index),
        entry: n,
      });
    }
    const ref = PR_REFERENCE.exec(entry.text);
    if (ref) {
      warnings.push({
        message: `Entry ${n} mentions a pull request or issue (${ref[0].trim()}); write the lesson itself, not where it came from.`,
        line: entry.line + lineOffset(entry.text, ref.index),
        entry: n,
      });
    }
  }
  return { errors, warnings, stats, parsed };
}
