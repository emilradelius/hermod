/**
 * Text normalisation for matching (never for display or storage).
 *
 * Attackers hide words from simple pattern matching with look-alike characters: full-width letters (＜, ｉ),
 * HTML entities (&lt;, &#x3c;), zero-width or other invisible format characters inside a word, combining marks,
 * and a few homoglyphs from other scripts. `normalizeForMatching` folds all of these into plain lower-case text and
 * keeps a map back to the original offsets, so a match in the folded text can be reported or replaced in the
 * original text.
 */

export interface NormalizedText {
  /** The folded text: NFKC, lower case, invisible format characters and combining marks removed, entities decoded. */
  text: string;
  /** For each UTF-16 unit of `text`: the offset in the original where the character it came from starts. */
  starts: number[];
  /** For each UTF-16 unit of `text`: the offset in the original just after the character it came from. */
  ends: number[];
}

/** Characters that look like ASCII punctuation or letters but NFKC leaves alone. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  "‹": "<", // ‹
  "›": ">", // ›
  "〈": "<", // 〈 (NFKC maps it to U+3008, handled below too)
  "〉": ">",
  "〈": "<", // 〈
  "〉": ">", // 〉
  "⟨": "<", // ⟨
  "⟩": ">", // ⟩
  "˂": "<", // ˂
  "˃": ">", // ˃
  "∕": "/", // ∕
  "⁄": "/", // ⁄
  "⧸": "/", // ⧸
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "―": "-",
  "−": "-",
  // Cyrillic and Greek letters that look like Latin ones.
  "а": "a",
  "е": "e",
  "о": "o",
  "р": "p",
  "с": "c",
  "у": "y",
  "х": "x",
  "і": "i",
  "ѕ": "s",
  "ј": "j",
  "һ": "h",
  "ԁ": "d",
  "ο": "o",
  "α": "a",
  "ε": "e",
  "ι": "i",
  "ν": "v",
  "ρ": "p",
  "τ": "t",
  "Α": "a",
  "Ε": "e",
  "Ι": "i",
  "Ο": "o",
  "Ρ": "p",
  "Τ": "t",
  "С": "c",
  "Е": "e",
  "О": "o",
  "Р": "p",
  "Т": "t",
  "А": "a",
};

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  sol: "/",
  lowbar: "_",
  hyphen: "-",
  dash: "-",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
  colon: ":",
  equals: "=",
  num: "#",
  excl: "!",
  lsqb: "[",
  rsqb: "]",
  lpar: "(",
  rpar: ")",
  period: ".",
};

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));?/y;
const DROPPED = /^[\p{Cf}\p{M}]$/u;

/** Decodes the HTML entity that starts at `index`, if there is one. */
function entityAt(text: string, index: number): { value: string; length: number } | null {
  ENTITY.lastIndex = index;
  const m = ENTITY.exec(text);
  if (!m) return null;
  let value: string | undefined;
  if (m[1] !== undefined || m[2] !== undefined) {
    const code = m[1] !== undefined ? Number.parseInt(m[1], 10) : Number.parseInt(m[2] ?? "", 16);
    if (Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) {
      value = String.fromCodePoint(code);
    }
  } else if (m[3] !== undefined) {
    value = NAMED_ENTITIES[m[3].toLowerCase()];
  }
  return value === undefined ? null : { value, length: m[0].length };
}

/** Folds one character (a whole code point) into its matching form; "" when it is invisible. */
function foldChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x80) return ch.toLowerCase();
  const direct = CONFUSABLES[ch];
  if (direct !== undefined) return direct;
  let out = "";
  for (const part of ch.normalize("NFKC")) {
    if (DROPPED.test(part)) continue;
    out += CONFUSABLES[part] ?? part.toLowerCase();
  }
  return out;
}

/**
 * Folds text for pattern matching and keeps offsets back to the original. Never throws for string input.
 * Entities are decoded once (so "&amp;lt;" becomes the literal "&lt;", not "<").
 */
export function normalizeForMatching(input: string): NormalizedText {
  const original = typeof input === "string" ? input : String(input);
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < original.length) {
    let folded: string;
    let length: number;
    const entity = original.charCodeAt(i) === 0x26 ? entityAt(original, i) : null;
    if (entity) {
      folded = foldChar(entity.value);
      length = entity.length;
    } else {
      const code = original.codePointAt(i) ?? 0;
      const ch = String.fromCodePoint(code);
      length = ch.length;
      folded = foldChar(ch);
    }
    for (let k = 0; k < folded.length; k++) {
      starts.push(i);
      ends.push(i + length);
    }
    text += folded;
    i += length;
  }
  return { text, starts, ends };
}

/** Maps a [start, end) range of the folded text back to the original text. */
export function originalRange(norm: NormalizedText, start: number, end: number): { start: number; end: number } {
  if (norm.text.length === 0) return { start: 0, end: 0 };
  const s = norm.starts[Math.min(start, norm.starts.length - 1)] ?? 0;
  const e = norm.ends[Math.max(0, Math.min(end, norm.ends.length) - 1)] ?? s;
  return { start: s, end: Math.max(s, e) };
}

/** Makes invisible and control characters visible (for excerpts in findings), and keeps excerpts short. */
export function visibleExcerpt(text: string, start: number, end: number, context = 30, max = 160): string {
  const from = Math.max(0, start - context);
  const to = Math.min(text.length, end + context);
  let out = "";
  for (const ch of text.slice(from, to)) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n" || ch === "\r" || ch === "\t") out += " ";
    else if (code < 0x20 || code === 0x7f || /[\p{Cf}\p{Co}]/u.test(ch)) out += `\\u{${code.toString(16)}}`;
    else out += ch;
    if (out.length >= max) {
      out = `${out.slice(0, max)}…`;
      break;
    }
  }
  return (from > 0 ? "…" : "") + out + (to < text.length && !out.endsWith("…") ? "…" : "");
}
