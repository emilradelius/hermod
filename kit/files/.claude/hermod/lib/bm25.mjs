// @ts-check
/**
 * A small BM25 search engine for recall (no dependencies, everything in memory).
 *
 * - tokenize(): NFKD + combining marks removed (å→a, ä→a, ö→o; ß→ss, æ→ae, ø→o and a few more), lowercase,
 *   split on anything that is not a letter, digit or "_". A word with "_" or camelCase is kept whole and also
 *   as its parts: `CACHE_VERSION` → cache_version, cache, version; `askClaude` → askclaude, ask, claude.
 *   Tokens shorter than 2 characters and a small English + Swedish stopword list are dropped.
 * - buildIndex()/search(): Okapi BM25 (k1 1.2, b 0.75). A document's title (the heading path of a markdown
 *   chunk, the subject of a commit) counts double. A query term with no exact match falls back to every
 *   indexed term that starts with it, when it has at least 4 characters ("deploym" → deployment, deployments).
 *   Results are ordered by score (highest first), then path, then line, so the order is always the same.
 * - snippet(): a short piece of text around the best match, with matched words marked «like this».
 */
import { safeEnd, safeStart } from "./io.mjs";

export const K1 = 1.2;
export const B = 0.75;
/** How much a title token weighs compared to a body token. */
export const TITLE_WEIGHT = 2;
/** A query term needs at least this many characters to fall back to prefix matches. */
export const MIN_PREFIX_CHARS = 4;
/** A prefix never expands to more indexed terms than this. */
export const MAX_PREFIX_TERMS = 200;
/** Tokens longer than this are ignored (hashes, base64 and other noise). */
export const MAX_TOKEN_CHARS = 64;

/**
 * Words that carry no meaning for search. Swedish words are listed as they look after folding (är → ar).
 * Kept small on purpose: a word that matters in a project must never be dropped.
 */
export const STOPWORDS = new Set([
  // English
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "do", "does", "for", "from", "had", "has",
  "have", "he", "her", "his", "if", "in", "into", "is", "it", "its", "of", "on", "or", "our", "she", "so",
  "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "was",
  "we", "were", "what", "when", "which", "who", "will", "with", "you", "your",
  // Swedish (folded)
  "alla", "ar", "att", "av", "da", "de", "dem", "den", "denna", "det", "detta", "dessa", "din", "du", "ej", "eller",
  "en", "er", "ett", "han", "hon", "hur", "jag", "ju", "mig", "min", "mitt", "na", "nagon", "nagot", "nar",
  "och", "ocksa", "oss", "pa", "sa", "sig", "sin", "sitt", "som", "till", "vad", "vara", "vi", "vid",
]);

/** Letters that NFKD does not decompose. */
const EXTRA_FOLDS = /** @type {Record<string, string>} */ ({
  ß: "ss", ẞ: "SS", æ: "ae", Æ: "AE", ø: "o", Ø: "O", œ: "oe", Œ: "OE", ł: "l", Ł: "L", đ: "d", Đ: "D",
  ð: "d", Ð: "D", þ: "th", Þ: "TH", ı: "i",
});
const EXTRA_FOLD_RE = /[ßẞæÆøØœŒłŁđĐðÐþÞı]/g;
const COMBINING = /\p{M}+/gu;
const WORD = /[\p{L}\p{N}_]+/gu;
/** A word in original (unfolded) text: combining marks belong to the word. */
const RAW_WORD = /[\p{L}\p{N}\p{M}_]+/gu;
/** A word that may have parts: it has "_", a digit, or a capital letter after its first character. */
const NEEDS_SPLIT = /_|\p{N}|.\p{Lu}/u;
/** One part of a word: an acronym before a capitalised word (XML|Http), a (capitalised) lowercase run, a
 * capital run, a number, or any other letters. */
const PART = /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{N}+|\p{L}+/gu;

/**
 * Folds text for matching: NFKD, combining marks removed, a few extra letters spelled out. Case is kept
 * (camelCase splitting needs it).
 * @param {unknown} text
 * @returns {string}
 */
export function fold(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(COMBINING, "")
    .replace(EXTRA_FOLD_RE, (c) => EXTRA_FOLDS[c] ?? c);
}

/**
 * The parts of one folded word: split at "_", at camelCase humps and between letters and digits.
 * @param {string} word
 * @returns {string[]}
 */
function wordParts(word) {
  /** @type {string[]} */
  const out = [];
  for (const piece of word.split("_")) {
    if (piece === "") continue;
    for (const m of piece.matchAll(PART)) out.push(m[0].toLowerCase());
  }
  return out;
}

/**
 * @param {string} t
 * @returns {boolean}
 */
function keep(t) {
  return t.length >= 2 && t.length <= MAX_TOKEN_CHARS && !STOPWORDS.has(t);
}

/**
 * Tokens of a text, in order (a word with parts gives the whole word first, then its parts).
 * @param {unknown} text
 * @returns {string[]}
 */
export function tokenize(text) {
  /** @type {string[]} */
  const out = [];
  for (const m of fold(text).matchAll(WORD)) {
    const word = m[0];
    const whole = word.replace(/^_+|_+$/g, "").toLowerCase();
    if (keep(whole)) out.push(whole);
    // Fast path: a plain word (no "_", no capital after the first letter, no digits) has no parts.
    if (!NEEDS_SPLIT.test(word)) continue;
    const parts = wordParts(word);
    if (parts.length > 1) {
      for (const p of parts) if (p !== whole && keep(p)) out.push(p);
    }
  }
  return out;
}

/**
 * @typedef {object} SearchDoc
 * @property {string} text body text
 * @property {string} [title] heading path or subject: its tokens count TITLE_WEIGHT times
 * @property {string} [path] used to order equal scores
 * @property {number} [line] used to order equal scores
 */

/**
 * @template {SearchDoc} D
 * @typedef {object} SearchIndex
 * @property {D[]} docs
 * @property {Array<Map<string, number>>} tfs weighted term frequencies per document
 * @property {number[]} lengths weighted document lengths
 * @property {Map<string, number[]>} postings term → indexes of the documents that contain it (ascending)
 * @property {string[]} vocabulary every indexed term, sorted
 * @property {number} avgLength
 */

/**
 * Builds an index over documents.
 * @template {SearchDoc} D
 * @param {readonly D[]} docs
 * @returns {SearchIndex<D>}
 */
export function buildIndex(docs) {
  /** @type {Array<Map<string, number>>} */
  const tfs = [];
  /** @type {number[]} */
  const lengths = [];
  /** @type {Map<string, number[]>} */
  const postings = new Map();
  let total = 0;
  docs.forEach((doc, i) => {
    /** @type {Map<string, number>} */
    const tf = new Map();
    let length = 0;
    for (const t of tokenize(doc.text)) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
      length += 1;
    }
    for (const t of tokenize(doc.title ?? "")) {
      tf.set(t, (tf.get(t) ?? 0) + TITLE_WEIGHT);
      length += TITLE_WEIGHT;
    }
    for (const t of tf.keys()) {
      const list = postings.get(t);
      if (list) list.push(i);
      else postings.set(t, [i]);
    }
    tfs.push(tf);
    lengths.push(length);
    total += length;
  });
  const vocabulary = [...postings.keys()].sort();
  return { docs: [...docs], tfs, lengths, postings, vocabulary, avgLength: docs.length > 0 ? total / docs.length : 0 };
}

/**
 * The first index in a sorted array whose value is ≥ key.
 * @param {string[]} sorted
 * @param {string} key
 * @returns {number}
 */
function lowerBound(sorted, key) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * @typedef {object} QueryTerm
 * @property {string} term the query token
 * @property {"exact" | "prefix" | "none"} match
 * @property {string[]} terms the indexed terms it matches (itself for exact; the expansions for prefix)
 */

/**
 * How each query token matches the index.
 * @param {SearchIndex<SearchDoc>} index
 * @param {string} query
 * @returns {QueryTerm[]}
 */
export function queryTerms(index, query) {
  /** @type {QueryTerm[]} */
  const out = [];
  for (const term of new Set(tokenize(query))) {
    if (index.postings.has(term)) {
      out.push({ term, match: "exact", terms: [term] });
      continue;
    }
    if (term.length >= MIN_PREFIX_CHARS) {
      /** @type {string[]} */
      const terms = [];
      for (let i = lowerBound(index.vocabulary, term); i < index.vocabulary.length; i++) {
        const v = index.vocabulary[i];
        if (!v.startsWith(term) || terms.length >= MAX_PREFIX_TERMS) break;
        terms.push(v);
      }
      if (terms.length > 0) {
        out.push({ term, match: "prefix", terms });
        continue;
      }
    }
    out.push({ term, match: "none", terms: [] });
  }
  return out;
}

/**
 * @template {SearchDoc} D
 * @typedef {object} Hit
 * @property {D} doc
 * @property {number} index position of the document in the index
 * @property {number} score
 * @property {string[]} matched indexed terms of the query found in this document, sorted
 */

/**
 * Orders hits: score (highest first), then path, then line, then position in the index.
 * @param {Hit<SearchDoc>} a
 * @param {Hit<SearchDoc>} b
 * @returns {number}
 */
export function compareHits(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  const pa = a.doc.path ?? "";
  const pb = b.doc.path ?? "";
  if (pa !== pb) return pa < pb ? -1 : 1;
  const la = a.doc.line ?? 0;
  const lb = b.doc.line ?? 0;
  if (la !== lb) return la - lb;
  return a.index - b.index;
}

/**
 * Searches the index. Every query term contributes BM25 for its exact term, or for its prefix group (the
 * group's term frequencies are added up and its document frequency counts each document once).
 * @template {SearchDoc} D
 * @param {SearchIndex<D>} index
 * @param {string} query
 * @param {{ limit?: number }} [options] limit default 8; 0 or Infinity = all hits
 * @returns {{ hits: Hit<D>[], total: number, terms: QueryTerm[] }}
 */
export function search(index, query, options = {}) {
  const terms = queryTerms(index, query);
  const n = index.docs.length;
  /** @type {Map<number, { score: number, matched: Set<string> }>} */
  const acc = new Map();
  for (const q of terms) {
    if (q.terms.length === 0) continue;
    /** @type {Map<number, number>} */
    const tfByDoc = new Map();
    for (const t of q.terms) {
      for (const d of index.postings.get(t) ?? []) {
        tfByDoc.set(d, (tfByDoc.get(d) ?? 0) + (index.tfs[d].get(t) ?? 0));
        let entry = acc.get(d);
        if (!entry) {
          entry = { score: 0, matched: new Set() };
          acc.set(d, entry);
        }
        entry.matched.add(t);
      }
    }
    const df = tfByDoc.size;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (const [d, tf] of tfByDoc) {
      const norm = index.avgLength > 0 ? index.lengths[d] / index.avgLength : 1;
      const entry = /** @type {{ score: number }} */ (acc.get(d));
      entry.score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + B * norm));
    }
  }
  /** @type {Hit<D>[]} */
  const hits = [];
  for (const [d, entry] of acc) {
    if (entry.score > 0) hits.push({ doc: index.docs[d], index: d, score: entry.score, matched: [...entry.matched].sort() });
  }
  hits.sort(compareHits);
  const limit = options.limit ?? 8;
  const cut = limit > 0 && Number.isFinite(limit) ? hits.slice(0, Math.floor(limit)) : hits;
  return { hits: cut, total: hits.length, terms };
}

/**
 * @typedef {object} Snippet
 * @property {string} text one line, whitespace collapsed, matches marked «…», "…" where the text was cut
 * @property {number} anchor offset in the original text of the match the snippet is built around (0 when none)
 */

/**
 * A piece of text of about maxChars characters (marks not counted) around the place with the most
 * distinct matched terms. A word matches when one of its tokens is in `terms`.
 * @param {unknown} text
 * @param {Iterable<string>} terms indexed terms (for example Hit.matched)
 * @param {number} [maxChars] default 240
 * @returns {Snippet}
 */
export function snippet(text, terms, maxChars = 240) {
  const s = String(text ?? "");
  const want = new Set(terms);
  const max = Math.max(20, Math.floor(maxChars));
  /** @type {Array<{ start: number, end: number, terms: string[] }>} */
  const matches = [];
  if (want.size > 0) {
    for (const m of s.matchAll(RAW_WORD)) {
      const found = tokenize(m[0]).filter((t) => want.has(t));
      if (found.length > 0) matches.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, terms: found });
    }
  }
  let best = -1;
  let bestCount = 0;
  const reach = Math.floor(max * 0.75);
  for (let i = 0; i < matches.length; i++) {
    const seen = new Set();
    for (let j = i; j < matches.length && matches[j].start < matches[i].start + reach; j++) {
      for (const t of matches[j].terms) seen.add(t);
    }
    if (seen.size > bestCount) {
      best = i;
      bestCount = seen.size;
    }
  }
  const anchor = best >= 0 ? matches[best].start : 0;
  let start = best >= 0 ? Math.max(0, anchor - Math.floor(max / 4)) : 0;
  if (start > 0 && /\S/.test(s[start - 1])) {
    // Start at a word boundary when one is near.
    const ws = s.slice(start, anchor).search(/\s/);
    start = ws >= 0 ? start + ws + 1 : anchor;
  }
  start = safeStart(s, start);
  let end = Math.min(s.length, start + max);
  if (end < s.length && /\S/.test(s[end] ?? "")) {
    // End at a word boundary when one is near (never before the anchor match).
    const from = Math.max(start, end - 40);
    const ws = s.slice(from, end).search(/\s\S*$/);
    if (ws >= 0 && from + ws > anchor) end = from + ws;
  }
  for (const m of matches) {
    if (m.start < end && m.end > end) end = m.end;
  }
  end = safeEnd(s, end);
  let out = "";
  let pos = start;
  for (const m of matches) {
    if (m.start < start || m.end > end) continue;
    out += `${s.slice(pos, m.start)}«${s.slice(m.start, m.end)}»`;
    pos = m.end;
  }
  out += s.slice(pos, end);
  out = out.replace(/\s+/g, " ").trim();
  return { text: `${start > 0 ? "…" : ""}${out}${end < s.length ? "…" : ""}`, anchor };
}
