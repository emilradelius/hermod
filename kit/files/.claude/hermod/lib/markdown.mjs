// @ts-check
/**
 * Markdown helpers used by the brief, recall and the validators.
 * - parseSections(): ATX headings ("## Title"); headings inside fenced code (``` or ~~~) and inside HTML
 *   comments are ignored. Setext headings (underlined with === or ---) are not recognised.
 * - findSection(): a heading whose text equals the title, else the first one that starts with it
 *   (case-insensitive, markdown emphasis ignored), any level.
 * - chunkMarkdown(): pieces of at most maxChars for search, split at headings and blank lines and never
 *   across a heading, each with its line range and heading path.
 * Line numbers are 1-based. "\r\n" and "\n" line endings are both handled.
 */
import { safeEnd } from "./io.mjs";

/**
 * @typedef {object} Section
 * @property {string} title heading text without the #s
 * @property {number} level 1-6
 * @property {number} line line of the heading
 * @property {number} endLine last line of the section: the line before the next heading of the same or a
 *   higher level, or the last line of the text
 * @property {string[]} path titles from the outermost heading down to this one
 * @property {string} body the lines after the heading up to endLine (subsections included)
 */

/**
 * @typedef {object} Chunk
 * @property {number} startLine
 * @property {number} endLine
 * @property {string} text
 * @property {string[]} headingPath titles of the enclosing headings, outermost first
 */

/**
 * @typedef {object} LineInfo
 * @property {{ level: number, title: string } | null} heading
 * @property {boolean} fence the line is a fence delimiter or inside fenced code
 * @property {boolean} blank
 */

/**
 * @param {unknown} text
 * @returns {string[]}
 */
export function splitLines(text) {
  return String(text ?? "").split(/\r?\n/);
}

/**
 * Number of real lines (a final newline does not start another line).
 * @param {string[]} lines
 * @param {unknown} text
 * @returns {number}
 */
function lineCount(lines, text) {
  return String(text ?? "").endsWith("\n") ? lines.length - 1 : lines.length;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * @param {string} raw text after the opening #s
 * @returns {string}
 */
function cleanTitle(raw) {
  return raw.replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();
}

/**
 * Classifies every line: heading, part of fenced code, or blank.
 * @param {string[]} lines
 * @returns {LineInfo[]}
 */
function scanLines(lines) {
  /** @type {LineInfo[]} */
  const out = [];
  /** @type {{ char: string, length: number } | null} */
  let fence = null;
  let inComment = false;
  for (const line of lines) {
    const blank = line.trim() === "";
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      out.push({ heading: null, fence: true, blank });
      continue;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      out.push({ heading: null, fence: false, blank });
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      out.push({ heading: null, fence: true, blank });
      continue;
    }
    const commentStart = line.lastIndexOf("<!--");
    if (commentStart !== -1 && !line.slice(commentStart).includes("-->")) inComment = true;
    const h = line.trimStart().startsWith("<!--") ? null : HEADING.exec(line);
    out.push({ heading: h ? { level: h[1].length, title: cleanTitle(h[2] ?? "") } : null, fence: false, blank });
  }
  return out;
}

/**
 * All ATX sections of a markdown text, in document order.
 * @param {unknown} text
 * @returns {Section[]}
 */
export function parseSections(text) {
  const lines = splitLines(text);
  const total = lineCount(lines, text);
  const info = scanLines(lines);
  /** @type {Section[]} */
  const sections = [];
  // One pass: the stack holds the sections that are still open (strictly increasing levels). A heading
  // closes every open section of the same or a deeper level; that is where those sections end.
  /** @type {Section[]} */
  const open = [];
  for (let i = 0; i < total; i++) {
    const h = info[i].heading;
    if (!h) continue;
    while (open.length > 0 && open[open.length - 1].level >= h.level) {
      /** @type {Section} */ (open.pop()).endLine = i;
    }
    const s = { title: h.title, level: h.level, line: i + 1, endLine: total, path: [...open.map((o) => o.title), h.title], body: "" };
    open.push(s);
    sections.push(s);
  }
  // Each line sits in at most six bodies (one per heading level), so building the bodies is linear too.
  for (const s of sections) s.body = lines.slice(s.line, s.endLine).join("\n");
  return sections;
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
 * Finds a section by title: an exact match first (case-insensitive), else the first heading that starts
 * with the title. Accepts markdown text or the result of parseSections.
 * @param {unknown} source
 * @param {string} title
 * @returns {Section | null}
 */
export function findSection(source, title) {
  const sections = Array.isArray(source) ? /** @type {Section[]} */ (source) : parseSections(source);
  const want = normTitle(title);
  if (want === "") return null;
  return (
    sections.find((s) => normTitle(s.title) === want) ?? sections.find((s) => normTitle(s.title).startsWith(want)) ?? null
  );
}

/**
 * Splits a block that is too long into pieces of whole lines (a line that alone is too long is cut, never
 * inside a surrogate pair).
 * @param {string[]} block
 * @param {number} firstLine 1-based line number of block[0]
 * @param {number} maxChars
 * @returns {Array<{ startLine: number, endLine: number, text: string }>}
 */
function splitBlock(block, firstLine, maxChars) {
  /** @type {Array<{ startLine: number, endLine: number, text: string }>} */
  const pieces = [];
  /** @type {{ startLine: number, endLine: number, text: string } | null} */
  let cur = null;
  block.forEach((line, k) => {
    const n = firstLine + k;
    if (cur && cur.text.length + 1 + line.length <= maxChars) {
      cur.text += `\n${line}`;
      cur.endLine = n;
      return;
    }
    if (cur) pieces.push(cur);
    cur = null;
    let rest = line;
    while (rest.length > maxChars) {
      const cut = safeEnd(rest, maxChars) || maxChars;
      pieces.push({ startLine: n, endLine: n, text: rest.slice(0, cut) });
      rest = rest.slice(cut);
    }
    cur = { startLine: n, endLine: n, text: rest };
  });
  if (cur) pieces.push(cur);
  return pieces;
}

/**
 * Chunks markdown for search. Chunks hold at most maxChars characters, start at a heading or after a blank
 * line, never contain text from two different sections, and skip empty text. The first chunk of a section
 * starts with its heading line.
 * @param {unknown} text
 * @param {{ maxChars?: number }} [options] default 800 (minimum 50)
 * @returns {Chunk[]}
 */
export function chunkMarkdown(text, options = {}) {
  const maxChars = Math.max(50, Math.floor(options.maxChars ?? 800));
  const lines = splitLines(text);
  const total = lineCount(lines, text);
  const info = scanLines(lines);
  /** @type {Chunk[]} */
  const chunks = [];
  /** @type {Array<{ level: number, title: string }>} */
  const stack = [];
  /** @type {Chunk | null} */
  let cur = null;
  const flush = () => {
    if (cur && cur.text.trim() !== "") chunks.push(cur);
    cur = null;
  };
  const headingPath = () => stack.map((s) => s.title);
  let i = 0;
  while (i < total) {
    const h = info[i].heading;
    if (h) {
      flush();
      while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
      stack.push(h);
      const line = lines[i].length > maxChars ? lines[i].slice(0, safeEnd(lines[i], maxChars)) : lines[i];
      cur = { startLine: i + 1, endLine: i + 1, text: line, headingPath: headingPath() };
      i++;
      continue;
    }
    if (info[i].blank && !info[i].fence) {
      i++;
      continue;
    }
    const start = i;
    /** @type {string[]} */
    const block = [];
    while (i < total && !info[i].heading && (info[i].fence || !info[i].blank)) {
      block.push(lines[i]);
      i++;
    }
    const blockText = block.join("\n");
    const endLine = start + block.length;
    if (cur && cur.text.length + 2 + blockText.length <= maxChars) {
      cur.text += `\n\n${blockText}`;
      cur.endLine = endLine;
      continue;
    }
    flush();
    if (blockText.length <= maxChars) {
      cur = { startLine: start + 1, endLine, text: blockText, headingPath: headingPath() };
      continue;
    }
    const pieces = splitBlock(block, start + 1, maxChars);
    pieces.forEach((p, k) => {
      const chunk = { ...p, headingPath: headingPath() };
      if (k < pieces.length - 1) {
        if (chunk.text.trim() !== "") chunks.push(chunk);
      } else {
        cur = chunk;
      }
    });
  }
  flush();
  return chunks;
}
