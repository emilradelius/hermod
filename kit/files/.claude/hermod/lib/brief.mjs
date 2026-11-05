// @ts-check
/**
 * The session brief: a short text printed at session start (hooks/session-start.mjs) and on demand
 * (brief.mjs). It says where the work stands (sections of the progress file), the lessons, an index of the
 * skills, recent branches and the kit's tools.
 *
 * Hard guarantee: the text is never longer than brief.budgetChars (and never longer than 9,500 characters,
 * because Claude Code moves hook output over 10,000 characters into a file and shows only a preview).
 *
 * Budget allocation, in this order:
 *   1. header and tools (always);
 *   2. lessons (whole; cut only when they alone do not fit);
 *   3. skills index (one line each; lines dropped from the end with "… and N more");
 *   4. progress sections and brief.extra (each at most its own cap, then shrunk evenly to fit);
 *   5. branches (lines dropped when out of room).
 * Output order: header, progress, extra, lessons, skills, branches, tools.
 *
 * Every piece of repository text is redacted before it is measured and cut, so a cut never leaves part of a
 * secret behind and redaction can never push the brief over its budget. Cuts prefer line boundaries and never
 * split a character (surrogate pairs and grapheme clusters such as "ä" written as a + combining mark, or emoji
 * sequences, stay whole). A missing file is reported in one short line, never as an error.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_BOUNDS, CONFIG_FILE, DEFAULTS, loadConfig } from "./config.mjs";
import { branch as gitBranch, head as gitHead, isGitRepo, recentBranches, uncommittedFiles } from "./git.mjs";
import { isPlainObject, readJson, readText, safeEnd } from "./io.mjs";
import { lessonsStats, parseLessons } from "./lessons.mjs";
import { resolveInside, toPosix } from "./paths.mjs";
import { redact } from "./redact.mjs";
import { skillIndex } from "./skills.mjs";

/** The first line of every brief. */
export const BRIEF_TITLE = "# Session brief (Hermod, frozen at session start)";
/** The smallest and largest budget a brief may have (config bounds of brief.budgetChars). */
export const MIN_BRIEF_CHARS = CONFIG_BOUNDS["brief.budgetChars"]?.[0] ?? 1000;
export const MAX_BRIEF_CHARS = CONFIG_BOUNDS["brief.budgetChars"]?.[1] ?? 9500;

/** Between the brief's parts. */
const SEP = "\n\n";
/** Larger progress/extra files are read only up to here. */
const DOC_MAX_BYTES = 4 * 1024 * 1024;
const LESSONS_MAX_BYTES = 1024 * 1024;
/** Longest repository name, branch name or heading shown. */
const NAME_CHARS = 80;
/** A cut body keeps at least this much text next to its marker, else it shows the short marker only. */
const MIN_BODY_CHARS = 40;

/** The kit folder this file belongs to (`.claude/hermod/` in a target repository). */
const KIT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * @typedef {object} GitFacts
 * @property {boolean} repo root is inside a git work tree
 * @property {string | null} head
 * @property {string | null} branch null when detached (or no repository)
 * @property {string[]} uncommitted files with uncommitted changes (staged, unstaged, untracked)
 */

/**
 * @typedef {object} BriefPart
 * @property {string} name "header" | "progress" | "extra:<file>" | "lessons" | "skills" | "branches" | "tools"
 * @property {"full" | "cut" | "missing" | "dropped" | "off" | "empty"} status
 * @property {string} text what the brief shows for this part ("" when dropped or off)
 * @property {number} chars text.length
 * @property {string} [note] why it was cut, dropped or missing
 */

/**
 * @typedef {object} BriefResult
 * @property {string} text the brief (≤ budget)
 * @property {number} budget the budget used (brief.budgetChars, clamped to the config bounds)
 * @property {number} chars text.length
 * @property {BriefPart[]} parts in output order
 */

/**
 * @typedef {object} BriefOptions
 * @property {string | null} [sessionId] only used for the record (the brief text is the same for every id)
 * @property {GitFacts} [git] git facts already gathered (the hook needs them for the session state too)
 * @property {string} [kitVersion] default: VERSION.json next to the kit ("kit" field), else "dev"
 * @property {number} [now] for branch ages (ms)
 * @property {number} [configErrors] number of config.json errors, shown in one line
 * @property {string} [toolsDir] posix path of the kit folder as shown in the tools lines
 */

// --------------------------------------------------------------------------------------------- cutting

/** @type {Intl.Segmenter | null} */
const SEGMENTER = typeof Intl === "object" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;

/**
 * The largest index ≤ i that is a grapheme boundary (falls back to a surrogate-safe index for clusters
 * longer than the search window).
 * @param {string} text
 * @param {number} i
 * @returns {number}
 */
export function graphemeEnd(text, i) {
  if (i <= 0) return 0;
  if (i >= text.length) return text.length;
  const fallback = safeEnd(text, i);
  if (!SEGMENTER) return fallback;
  const start = Math.max(0, i - 64);
  let best = -1;
  for (const { index } of SEGMENTER.segment(text.slice(start, Math.min(text.length, i + 64)))) {
    const b = start + index;
    if (b > i) break;
    best = b;
  }
  // start is only a real boundary when it is 0; otherwise a boundary found at start is uncertain.
  if (best < 0 || (best === start && start > 0)) return fallback;
  return best;
}

/**
 * Cuts text to at most max characters: at the last line break when that keeps at least 30 % of max, else at
 * the last space, else at a grapheme boundary. Text that fits is returned unchanged. Trailing whitespace of
 * a cut is removed.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function cutText(text, max) {
  const s = String(text ?? "");
  const limit = Math.floor(max);
  if (s.length <= limit) return s;
  if (!(limit > 0)) return "";
  const minKeep = limit * 0.3;
  const nl = s.lastIndexOf("\n", limit);
  if (nl >= minKeep && nl > 0) return s.slice(0, nl).trimEnd();
  const sp = Math.max(s.lastIndexOf(" ", limit), s.lastIndexOf("\t", limit));
  if (sp >= minKeep && sp > 0) return s.slice(0, sp).trimEnd();
  return s.slice(0, graphemeEnd(s, limit)).trimEnd();
}

/**
 * One line of at most max characters, ending in "…" when cut. Control characters become spaces.
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
export function oneLine(text, max) {
  // eslint-disable-next-line no-control-regex
  const s = String(text ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
  if (s.length <= max) return s;
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  return `${s.slice(0, graphemeEnd(s, max - 1)).trimEnd()}…`;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * The line that closes a fenced code block left open at the end of text ("" when none is open).
 * @param {string} text
 * @returns {string}
 */
function openFenceCloser(text) {
  /** @type {string | null} */
  let fence = null;
  for (const line of text.split("\n")) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) fence = open[1];
  }
  return fence ? `\n${fence}` : "";
}

/**
 * A body cut to at most max characters with a marker after it. A fenced code block left open by the cut is
 * closed, so the rest of the brief is not read as code.
 * @param {string} body
 * @param {number} max
 * @param {string} marker appended when cut (starts with "\n")
 * @param {string} shortMarker used alone when there is no room for text
 * @returns {{ text: string, cut: boolean }}
 */
function cutBody(body, max, marker, shortMarker) {
  if (body.length <= max) return { text: body, cut: false };
  if (max < marker.length + MIN_BODY_CHARS) {
    return { text: shortMarker.length <= max ? shortMarker : "", cut: true };
  }
  let reserve = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const kept = cutText(body, max - marker.length - reserve);
    const closer = openFenceCloser(kept);
    if (closer.length <= reserve) {
      const text = kept + closer + marker;
      if (text.length <= max) return { text, cut: true };
      break;
    }
    reserve = closer.length;
  }
  return { text: shortMarker.length <= max ? shortMarker : "", cut: true };
}

/**
 * Splits total among items that want desired[i] each: everyone gets an equal share, and what small items do
 * not need goes to the larger ones ("shrink evenly").
 * @param {number[]} desired
 * @param {number} total
 * @returns {number[]}
 */
export function allocateEvenly(desired, total) {
  const out = desired.map(() => 0);
  let left = Math.max(0, Math.floor(total));
  const open = desired.map((_, i) => i).sort((a, b) => desired[a] - desired[b] || a - b);
  while (open.length > 0) {
    const share = Math.floor(left / open.length);
    const i = open[0];
    if (desired[i] <= share) {
      out[i] = desired[i];
      left -= desired[i];
      open.shift();
    } else {
      for (const j of open) out[j] = share;
      break;
    }
  }
  return out;
}

/**
 * @param {number} n
 * @returns {string}
 */
function fmt(n) {
  return Math.round(n).toLocaleString("en-US");
}

// ------------------------------------------------------------------------------------------ sections

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * @param {string} raw
 * @returns {string}
 */
function cleanTitle(raw) {
  return raw.replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();
}

/**
 * @param {unknown} title
 * @returns {string}
 */
function normTitle(title) {
  return String(title ?? "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The ATX headings of a markdown text in one linear pass; headings inside fenced code and HTML comments are
 * ignored (the same rules as lib/markdown.mjs, whose parseSections is quadratic in the number of headings).
 * @param {string[]} lines
 * @returns {Array<{ index: number, level: number, title: string }>}
 */
function scanHeadings(lines) {
  /** @type {Array<{ index: number, level: number, title: string }>} */
  const out = [];
  /** @type {{ char: string, length: number } | null} */
  let fence = null;
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    const commentStart = line.lastIndexOf("<!--");
    if (commentStart !== -1 && !line.slice(commentStart).includes("-->")) inComment = true;
    if (line.trimStart().startsWith("<!--")) continue;
    const h = HEADING.exec(line);
    if (h) out.push({ index: i, level: h[1].length, title: cleanTitle(h[2] ?? "") });
  }
  return out;
}

/**
 * Finds a section: the first heading whose text equals the title, else the first that starts with it
 * (case-insensitive, emphasis ignored, any level). The section ends before the next heading of the same or a
 * higher level. Its body has leading and trailing blank lines removed.
 * @param {unknown} text markdown
 * @param {string} title
 * @returns {{ title: string, level: number, line: number, body: string } | null}
 */
export function extractSection(text, title) {
  const want = normTitle(title);
  if (want === "") return null;
  const lines = String(text ?? "").split(/\r?\n/);
  const headings = scanHeadings(lines);
  let k = headings.findIndex((h) => normTitle(h.title) === want);
  if (k === -1) k = headings.findIndex((h) => normTitle(h.title).startsWith(want));
  if (k === -1) return null;
  const h = headings[k];
  let end = lines.length;
  for (let j = k + 1; j < headings.length; j++) {
    if (headings[j].level <= h.level) {
      end = headings[j].index;
      break;
    }
  }
  const body = lines
    .slice(h.index + 1, end)
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
  return { title: h.title, level: h.level, line: h.index + 1, body };
}

// ---------------------------------------------------------------------------------------------- facts

/**
 * Head, branch and uncommitted files of root (all empty when root is not a git work tree or git is missing).
 * @param {string} root
 * @returns {GitFacts}
 */
export function gatherGit(root) {
  if (!isGitRepo(root)) return { repo: false, head: null, branch: null, uncommitted: [] };
  return { repo: true, head: gitHead(root), branch: gitBranch(root), uncommitted: uncommittedFiles(root) };
}

/**
 * The kit version from VERSION.json in the kit folder (written by sync), else "dev".
 * @param {string} [kitDir]
 * @returns {string}
 */
export function kitVersion(kitDir = KIT_DIR) {
  const { value } = readJson(path.join(kitDir, "VERSION.json"));
  const v = isPlainObject(value) ? value.kit : null;
  return typeof v === "string" && v.trim() !== "" ? oneLine(v, 40) : "dev";
}

/**
 * How the tools lines name the kit folder: its path relative to root (".claude/hermod" in a target
 * repository; "kit/files/.claude/hermod" inside hermod itself).
 * @param {string} root
 * @returns {string}
 */
function defaultToolsDir(root) {
  const rel = toPosix(path.relative(path.resolve(root), KIT_DIR));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || /[\s"'`$\\]/.test(rel)) return ".claude/hermod";
  return rel;
}

/**
 * @param {string | null} abs
 * @returns {boolean}
 */
function isDirectory(abs) {
  try {
    return abs !== null && fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reads a repository file by relative path; null when missing, outside the root or unreadable.
 * @param {string} root
 * @param {string} rel
 * @param {number} maxBytes
 * @returns {string | null}
 */
function readRepoFile(root, rel, maxBytes) {
  const abs = resolveInside(root, rel);
  return abs === null ? null : readText(abs, { maxBytes });
}

/**
 * @param {unknown} v
 * @param {boolean} def
 * @returns {boolean}
 */
const bool = (v, def) => (typeof v === "boolean" ? v : def);

/**
 * @param {unknown} v
 * @param {number} def
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function int(v, def, min, max) {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(max, Math.max(min, n));
}

/**
 * @param {unknown} v
 * @param {string} def
 * @returns {string}
 */
const str = (v, def) => (typeof v === "string" && v.trim() !== "" ? v : def);

// --------------------------------------------------------------------------------------------- parts

/**
 * "Status and next step" for ["Status", "Next step"].
 * @param {string[]} titles
 * @returns {string}
 */
function joinTitles(titles) {
  const t = titles.map((s, i) => (i === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1)));
  if (t.length <= 1) return t[0] ?? "";
  return `${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}`;
}

/**
 * @typedef {object} DocItem
 * @property {string} heading "### Status" or "" (whole file)
 * @property {string} body redacted, full
 * @property {number} cap
 * @property {boolean} fixed true for "(not found …)" lines that are never cut
 */

/**
 * @typedef {object} DocGroup
 * @property {string} name part name
 * @property {string} file
 * @property {string} heading "## …"
 * @property {DocItem[]} items
 * @property {string | null} missing the one-line text when the file is missing
 */

/**
 * @param {string} root
 * @param {string} name
 * @param {string} file
 * @param {string[]} sections
 * @param {number} cap
 * @param {string} groupTitle
 * @returns {DocGroup}
 */
function docGroup(root, name, file, sections, cap, groupTitle) {
  const shownFile = oneLine(file, NAME_CHARS);
  const text = readRepoFile(root, file, DOC_MAX_BYTES);
  if (text === null) {
    return { name, file, heading: "", items: [], missing: `## ${groupTitle}: ${shownFile} not found` };
  }
  /** @type {DocItem[]} */
  const items = [];
  if (sections.length === 0) {
    const body = redact(text.replace(/\r\n?/g, "\n").trim());
    items.push({ heading: "", body: body === "" ? "(empty)" : body, cap, fixed: body === "" });
  }
  for (const title of sections) {
    const found = extractSection(text, title);
    if (!found) {
      items.push({ heading: `### ${oneLine(title, NAME_CHARS)}`, body: `(not found in ${shownFile})`, cap, fixed: true });
      continue;
    }
    const body = redact(found.body);
    items.push({
      heading: `### ${oneLine(redact(found.title), NAME_CHARS)}`,
      body: body === "" ? "(empty)" : body,
      cap,
      fixed: body === "",
    });
  }
  return { name, file, heading: `## ${groupTitle} (from ${shownFile})`, items, missing: null };
}

/**
 * Renders doc groups (progress and extra) into at most room characters, shrinking bodies evenly.
 * @param {DocGroup[]} groups
 * @param {number} room
 * @returns {BriefPart[]} one part per group
 */
function renderDocs(groups, room) {
  // Fixed text: group headings (or missing lines), item headings, line breaks and separators.
  /** @type {Array<{ g: number, i: number, desired: number }>} */
  const flex = [];
  let fixed = 0;
  groups.forEach((group, g) => {
    if (g > 0) fixed += SEP.length;
    if (group.missing !== null) {
      fixed += group.missing.length;
      return;
    }
    fixed += group.heading.length;
    group.items.forEach((item, i) => {
      fixed += 1 + (item.heading ? item.heading.length + 1 : 0);
      if (item.fixed) fixed += item.body.length;
      else flex.push({ g, i, desired: Math.min(item.body.length, item.cap) });
    });
  });
  const marker = (/** @type {string} */ file) => `\n[… cut; the rest is in ${oneLine(file, NAME_CHARS)}]`;
  const shortMarker = (/** @type {string} */ file) => `[… see ${oneLine(file, NAME_CHARS)}]`;
  const minFlex = flex.reduce((sum, f) => {
    const file = groups[f.g].file;
    return sum + Math.min(f.desired, shortMarker(file).length);
  }, 0);

  if (fixed + minFlex > room) {
    // No room for the sections themselves: one pointer line per group, as many as fit.
    /** @type {BriefPart[]} */
    const parts = [];
    let used = 0;
    for (const group of groups) {
      const line = group.missing ?? `## ${group.heading.replace(/^## /, "")}: not shown (no room left in the brief)`;
      const cost = line.length + (used > 0 ? SEP.length : 0);
      if (used + cost <= room) {
        parts.push({ name: group.name, status: group.missing ? "missing" : "dropped", text: line, chars: line.length, note: "no room" });
        used += cost;
      } else {
        parts.push({ name: group.name, status: "dropped", text: "", chars: 0, note: "no room" });
      }
    }
    return parts;
  }

  const allot = allocateEvenly(
    flex.map((f) => f.desired),
    room - fixed,
  );
  /** @type {Map<string, number>} */
  const allotted = new Map(flex.map((f, k) => [`${f.g}:${f.i}`, allot[k]]));
  return groups.map((group, g) => {
    if (group.missing !== null) {
      return { name: group.name, status: "missing", text: group.missing, chars: group.missing.length, note: `${group.file} not found` };
    }
    let cut = false;
    const lines = [group.heading];
    group.items.forEach((item, i) => {
      let body = item.body;
      if (!item.fixed) {
        const r = cutBody(item.body, allotted.get(`${g}:${i}`) ?? 0, marker(group.file), shortMarker(group.file));
        body = r.text;
        cut = cut || r.cut;
      }
      lines.push(item.heading ? `${item.heading}\n${body}` : body);
    });
    const text = lines.join("\n");
    return { name: group.name, status: cut ? "cut" : "full", text, chars: text.length, ...(cut ? { note: "shrunk to fit" } : {}) };
  });
}

/**
 * Lines under a heading, as many as fit in room, with "… and N more" when lines are dropped.
 * @param {string} heading
 * @param {string[]} lines
 * @param {number} room
 * @param {(n: number) => string} moreLine
 * @returns {{ text: string, status: "full" | "cut" | "dropped" }}
 */
function fitLines(heading, lines, room, moreLine) {
  const all = [heading, ...lines].join("\n");
  if (all.length <= room) return { text: all, status: "full" };
  let text = heading;
  for (let k = 0; k < lines.length; k++) {
    const more = `\n${moreLine(lines.length - k - 1)}`;
    const next = `${text}\n${lines[k]}`;
    if (k === lines.length - 1 ? next.length > room : next.length + more.length > room) {
      const tail = `\n${moreLine(lines.length - k)}`;
      return text.length + tail.length <= room ? { text: text + tail, status: "cut" } : { text: "", status: "dropped" };
    }
    text = next;
  }
  return { text, status: "full" };
}

/**
 * @param {string} root
 * @param {import("./config.mjs").HermodConfig["lessons"]} lessons
 * @param {number} room
 * @returns {BriefPart}
 */
function lessonsPart(root, lessons, room) {
  const file = str(lessons?.file, DEFAULTS.lessons.file);
  const cap = int(lessons?.capChars, DEFAULTS.lessons.capChars, 0, 1e9);
  const shownFile = oneLine(file, NAME_CHARS);
  const raw = readRepoFile(root, file, LESSONS_MAX_BYTES);
  if (raw === null) {
    const text = `## Lessons: none yet (${shownFile} not found)`;
    return text.length <= room
      ? { name: "lessons", status: "missing", text, chars: text.length, note: `${file} not found` }
      : { name: "lessons", status: "dropped", text: "", chars: 0, note: "no room" };
  }
  const parsed = parseLessons(raw);
  const stats = lessonsStats(parsed, cap);
  const entries = parsed.entries.map((e) => e.text).filter((t) => t !== "");
  const heading = `## Lessons (${shownFile}, ${fmt(stats.chars)} of ${fmt(cap)} chars)`;
  if (entries.length === 0) {
    const text = `${heading}\n- none yet`;
    return text.length <= room
      ? { name: "lessons", status: "empty", text, chars: text.length }
      : { name: "lessons", status: "dropped", text: "", chars: 0, note: "no room" };
  }
  const lines = entries.map((e) => `- ${redact(e).replace(/\r\n?/g, "\n").replace(/\n/g, "\n  ")}`);
  const more = (/** @type {number} */ n) => `- … ${n} more in ${shownFile}`;
  const fitted = fitLines(heading, lines, room, more);
  if (fitted.status !== "dropped" && fitted.text !== `${heading}\n${more(lines.length)}`) {
    return { name: "lessons", status: fitted.status, text: fitted.text, chars: fitted.text.length, ...(fitted.status === "cut" ? { note: "lessons do not fit the budget" } : {}) };
  }
  // Not even the first lesson fits whole: cut it.
  const tail = lines.length > 1 ? `\n${more(lines.length - 1)}` : "";
  const firstRoom = room - heading.length - 1 - tail.length;
  const marker = " […]";
  if (firstRoom >= MIN_BODY_CHARS + marker.length) {
    const text = `${heading}\n${cutText(lines[0], firstRoom - marker.length)}${marker}${tail}`;
    return { name: "lessons", status: "cut", text, chars: text.length, note: "lessons do not fit the budget" };
  }
  if (fitted.status !== "dropped") {
    return { name: "lessons", status: "cut", text: fitted.text, chars: fitted.text.length, note: "lessons do not fit the budget" };
  }
  return { name: "lessons", status: "dropped", text: "", chars: 0, note: "no room" };
}

/**
 * @param {string} root
 * @param {import("./config.mjs").HermodConfig["skills"]} skills
 * @param {number} room
 * @returns {BriefPart}
 */
function skillsPart(root, skills, room) {
  const dir = str(skills?.dir, DEFAULTS.skills.dir);
  const shownDir = oneLine(dir, NAME_CHARS);
  const abs = resolveInside(root, dir);
  /**
   * @param {string} text
   * @param {BriefPart["status"]} status
   * @returns {BriefPart}
   */
  const single = (text, status) =>
    text.length <= room
      ? { name: "skills", status, text, chars: text.length }
      : { name: "skills", status: "dropped", text: "", chars: 0, note: "no room" };
  if (!isDirectory(abs)) return single(`## Skills: none (${shownDir} not found)`, "missing");
  const index = skillIndex(root, { dir, indexChars: int(skills?.indexChars, DEFAULTS.skills.indexChars, 10, 1000) });
  if (index.length === 0) return single(`## Skills: none in ${shownDir}`, "empty");
  const lines = index.map((s) => `- ${oneLine(redact(s.line), 400)}`);
  const fitted = fitLines("## Skills (load the full SKILL.md when one applies)", lines, room, (n) => `- … and ${n} more in ${shownDir}`);
  if (fitted.status === "dropped") return { name: "skills", status: "dropped", text: "", chars: 0, note: "no room" };
  return { name: "skills", status: fitted.status, text: fitted.text, chars: fitted.text.length, ...(fitted.status === "cut" ? { note: "index cut to fit" } : {}) };
}

/**
 * @param {string} root
 * @param {GitFacts} git
 * @param {number} maxBranches
 * @param {number} room
 * @param {number} now
 * @returns {BriefPart}
 */
function branchesPart(root, git, maxBranches, room, now) {
  if (!git.repo || maxBranches <= 0) return { name: "branches", status: "off", text: "", chars: 0 };
  const list = recentBranches(root, maxBranches + 1, { now })
    .filter((b) => b.name !== git.branch)
    .slice(0, maxBranches);
  if (list.length === 0) return { name: "branches", status: "empty", text: "", chars: 0 };
  const lines = list.map((b) => `- ${oneLine(redact(b.name), NAME_CHARS)}${b.age ? ` (${b.age})` : ""}`);
  const all = ["## Branches", ...lines].join("\n");
  if (all.length <= room) return { name: "branches", status: "full", text: all, chars: all.length };
  let text = "## Branches";
  for (const line of lines) {
    if (text.length + 1 + line.length > room) break;
    text += `\n${line}`;
  }
  if (text === "## Branches") return { name: "branches", status: "dropped", text: "", chars: 0, note: "no room" };
  return { name: "branches", status: "cut", text, chars: text.length, note: "no room for every branch" };
}

/**
 * @param {string} root
 * @param {GitFacts | null} git null when git is off
 * @param {string} version
 * @param {number} configErrors
 * @returns {string}
 */
function headerText(root, git, version, configErrors) {
  const bits = [oneLine(redact(path.basename(path.resolve(root))), NAME_CHARS) || "repository"];
  if (git && !git.repo) bits.push("not a git repository");
  if (git && git.repo) {
    bits.push(git.branch ? `branch ${oneLine(redact(git.branch), NAME_CHARS)}` : "detached HEAD");
    bits.push(git.head ? git.head.slice(0, 7) : "no commits yet");
    bits.push(`${git.uncommitted.length} uncommitted`);
  }
  bits.push(`kit ${oneLine(version, 40)}`);
  const lines = [BRIEF_TITLE, bits.join(" · ")];
  if (configErrors > 0) {
    lines.push(`${CONFIG_FILE} has ${configErrors} invalid value${configErrors === 1 ? "" : "s"} (defaults used); see validate.mjs.`);
  }
  return lines.join("\n");
}

/**
 * @param {string} toolsDir
 * @returns {string}
 */
function toolsText(toolsDir) {
  return [
    "## Tools",
    `- Search past work: node ${toolsDir}/recall.mjs "query"`,
    "- End of session: /reflect (proposes lesson/skill/check changes in the PR; a person merges)",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------- brief

/**
 * Builds the brief for root. Never throws for missing files or a missing git; the result is always within
 * the budget.
 * @param {string} root
 * @param {import("./config.mjs").HermodConfig | null} [config] default: loadConfig(root).config
 * @param {BriefOptions} [options]
 * @returns {BriefResult}
 */
export function buildBrief(root, config, options = {}) {
  const absRoot = path.resolve(root);
  let configErrors = options.configErrors ?? 0;
  let cfg = config;
  if (!isPlainObject(cfg)) {
    const loaded = loadConfig(absRoot);
    cfg = loaded.config;
    configErrors = options.configErrors ?? loaded.errors.length;
  }
  const b = isPlainObject(cfg.brief) ? cfg.brief : DEFAULTS.brief;
  const budget = int(b.budgetChars, DEFAULTS.brief.budgetChars, MIN_BRIEF_CHARS, MAX_BRIEF_CHARS);
  const includeGit = bool(b.includeGit, true);
  const now = options.now ?? Date.now();
  const git = includeGit ? (options.git ?? gatherGit(absRoot)) : null;

  const header = headerText(absRoot, git, options.kitVersion ?? kitVersion(), configErrors);
  const tools = toolsText(options.toolsDir ?? defaultToolsDir(absRoot));
  let used = header.length + SEP.length + tools.length;
  const roomFor = () => budget - used - SEP.length;
  /** @param {BriefPart} part */
  const take = (part) => {
    if (part.text !== "") used += part.chars + SEP.length;
    return part;
  };

  const lessons = bool(b.includeLessons, true)
    ? take(lessonsPart(absRoot, cfg.lessons, roomFor()))
    : { name: "lessons", status: /** @type {const} */ ("off"), text: "", chars: 0 };
  const skills = bool(b.includeSkills, true)
    ? take(skillsPart(absRoot, cfg.skills, roomFor()))
    : { name: "skills", status: /** @type {const} */ ("off"), text: "", chars: 0 };

  const progress = isPlainObject(b.progress) ? b.progress : DEFAULTS.brief.progress;
  const perSection = int(progress.maxCharsPerSection, DEFAULTS.brief.progress.maxCharsPerSection, 1, MAX_BRIEF_CHARS);
  const sections = Array.isArray(progress.sections)
    ? progress.sections.filter((s) => typeof s === "string" && s.trim() !== "")
    : [...DEFAULTS.brief.progress.sections];
  /** @type {DocGroup[]} */
  const groups = [
    docGroup(
      absRoot,
      "progress",
      str(progress.file, DEFAULTS.brief.progress.file),
      sections,
      perSection,
      joinTitles(sections.length > 0 ? sections : ["Progress"]),
    ),
  ];
  for (const extra of Array.isArray(b.extra) ? b.extra : []) {
    const entry = typeof extra === "string" ? { file: extra } : extra;
    if (!isPlainObject(entry) || typeof entry.file !== "string" || entry.file.trim() === "") continue;
    const extraSections = Array.isArray(entry.sections) ? entry.sections.filter((s) => typeof s === "string" && s.trim() !== "") : [];
    const cap = int(entry.maxChars, perSection, 1, MAX_BRIEF_CHARS);
    const title = typeof entry.title === "string" && entry.title.trim() !== "" ? oneLine(entry.title, NAME_CHARS) : oneLine(entry.file, NAME_CHARS);
    groups.push(docGroup(absRoot, `extra:${entry.file}`, entry.file, extraSections, cap, title));
  }
  // The doc groups share one block: room minus one separator per group after the first is handled inside.
  const docParts = renderDocs(groups, Math.max(0, roomFor()));
  const docText = docParts.filter((p) => p.text !== "").map((p) => p.text).join(SEP);
  if (docText !== "") used += docText.length + SEP.length;

  const branches = git
    ? take(branchesPart(absRoot, git, int(b.maxBranches, DEFAULTS.brief.maxBranches, 0, 50), roomFor(), now))
    : { name: "branches", status: /** @type {const} */ ("off"), text: "", chars: 0 };

  /** @type {BriefPart[]} */
  const parts = [
    { name: "header", status: "full", text: header, chars: header.length },
    ...docParts,
    lessons,
    skills,
    branches,
    { name: "tools", status: "full", text: tools, chars: tools.length },
  ];
  let text = parts
    .map((p) => p.text)
    .filter((t) => t !== "")
    .join(SEP);
  // The allocation above keeps every part inside the budget; this is the last line of defence.
  if (text.length > budget) text = cutText(text, budget);
  return { text, budget, chars: text.length, parts };
}

/**
 * Makes sure a stored brief can be printed: at most MAX_BRIEF_CHARS characters (a brief saved by this kit
 * always is; this guards against a damaged file).
 * @param {string} text
 * @returns {string}
 */
export function capBrief(text) {
  return text.length <= MAX_BRIEF_CHARS ? text : cutText(text, MAX_BRIEF_CHARS);
}
