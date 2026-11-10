// @ts-check
/**
 * The plain-word rule for what Hermod lets travel between devices (lib/travel.mjs) and for the ledger's summary
 * mode (ledger.mode "summary"): a command is kept only as its key, at most three words such as "npm run build",
 * never its full text or its output.
 *
 * A plain word starts with a letter (after an optional "-", "--", "./" or "../"), uses only letters, digits and
 * . _ / : + , -, is at most 40 characters long, has no run of 6 or more digits (dates of birth, personal identity
 * numbers, phone numbers), no run of 16 or more letters and digits (tokens and keys), and is left unchanged by the
 * redactor. The first word must also look like a program (lower case). A later word stays only when the program
 * takes subcommands (git, npm, node …: TOOLS_WITH_SUBCOMMANDS), or when the word is a flag ("-x", "--long") or a
 * path (it holds "/" or "."). Any other word becomes "…". So prose ("echo my notes"), quoted text, an e-mail
 * address, a "name=value" pair or a token never reaches a key.
 *
 * The seeded check `hermod-state` repeats these rules, because a check imports nothing; test/kit/travel.test.ts
 * keeps the two in step.
 */
import { redact } from "./redact.mjs";

/** A key has at most this many words. */
export const KEY_WORDS = 3;
/** A plain word is at most this many characters. */
export const MAX_WORD_CHARS = 40;
/** What a word that may not travel becomes. */
export const ELLIPSIS = "…";
/** Programs whose next words are subcommands or script names (kept); for any other program only flags and paths are. */
export const TOOLS_WITH_SUBCOMMANDS = Object.freeze([
  "bun",
  "cargo",
  "deno",
  "docker",
  "eslint",
  "gh",
  "git",
  "go",
  "jest",
  "kubectl",
  "make",
  "next",
  "node",
  "npm",
  "npx",
  "pip",
  "pip3",
  "pnpm",
  "prettier",
  "python",
  "python3",
  "supabase",
  "terraform",
  "tsc",
  "uv",
  "vercel",
  "vitest",
  "yarn",
]);
const TOOLS = new Set(TOOLS_WITH_SUBCOMMANDS);
const WORD = /^(?:-{1,2}|\.{1,2}\/)?[A-Za-z][A-Za-z0-9._/:+,-]*$/;
const PROGRAM = /^(?:\.{1,2}\/)?[a-z][a-z0-9._/+-]*$/;
const DIGIT_RUN = /\d{6,}/;
const TOKEN_RUN = /[A-Za-z0-9]{16,}/;

/**
 * True when the word may travel at all: see the rules at the top of this file.
 * @param {unknown} word
 * @returns {boolean}
 */
export function isPlainWord(word) {
  if (typeof word !== "string" || word === "" || word.length > MAX_WORD_CHARS) return false;
  if (!WORD.test(word) || DIGIT_RUN.test(word) || TOKEN_RUN.test(word)) return false;
  return redact(word) === word;
}

/**
 * True when the word may stand at position i of a key whose first word is `program`.
 * @param {string} word
 * @param {number} i
 * @param {string} program the key's first word (ELLIPSIS when it did not travel)
 * @returns {boolean}
 */
function keepWord(word, i, program) {
  if (!isPlainWord(word)) return false;
  if (i === 0) return PROGRAM.test(word);
  const base = program.slice(program.lastIndexOf("/") + 1);
  return TOOLS.has(base) || word.startsWith("-") || /[/.]/.test(word);
}

/**
 * The summary key of a command or a ledger key: its first KEY_WORDS words, each kept only when it may travel, else
 * "…" (two "…" in a row become one). "" for a text without words.
 * @param {unknown} text
 * @returns {string}
 */
export function summaryKey(text) {
  const words = String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "")
    .slice(0, KEY_WORDS);
  if (words.length === 0) return "";
  const program = keepWord(words[0], 0, "") ? words[0] : ELLIPSIS;
  /** @type {string[]} */
  const out = [program];
  for (let i = 1; i < words.length; i++) {
    const kept = keepWord(words[i], i, program) ? words[i] : ELLIPSIS;
    if (kept === ELLIPSIS && out[out.length - 1] === ELLIPSIS) continue;
    out.push(kept);
  }
  return out.join(" ");
}

/**
 * True for a key summaryKey() could have made: 1 to KEY_WORDS words separated by single spaces, each one that may
 * travel at its place, or a single "…".
 * @param {unknown} key
 * @returns {boolean}
 */
export function isSummaryKey(key) {
  if (typeof key !== "string" || key === "") return false;
  const words = key.split(" ");
  if (words.length > KEY_WORDS) return false;
  const program = words[0] ?? "";
  return words.every((w, i) => (w === ELLIPSIS ? words[i - 1] !== ELLIPSIS : keepWord(w, i, program)));
}
