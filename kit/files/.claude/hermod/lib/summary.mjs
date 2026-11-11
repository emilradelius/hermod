// @ts-check
/**
 * The rule for what of a command may travel between devices (lib/travel.mjs) or stay in the ledger's summary mode
 * (ledger.mode "summary"): its key, at most three words such as "npm run build". Never its full text, its output,
 * a file name, a password or prose.
 *
 * Word by word, from the command's own tokens (lib/ledger.mjs: summaryKeyOf), each one that does not qualify
 * becomes "…":
 * - a token that was quoted, or holds a space, never qualifies;
 * - the first word is the program: only its name stays (its folder is dropped), lower case, like "git" or
 *   "check.sh";
 * - a later word stays only when it is a flag: one to three letters ("-x", "-rn") or a long name ("--fix",
 *   "--dry-run"). A value glued to a flag ("-pSecret", "-uuser:pass") is no flag and becomes "…";
 * - the second word also stays when the program takes subcommands (git, npm, node …: TOOLS_WITH_SUBCOMMANDS) and
 *   the word looks like one: lower case letters, digits, "-", "_", ":" ("push", "run", "typecheck:kit");
 * - the third word also stays when it is a script name after "run" or "run-script" of a package manager
 *   ("npm run build").
 * Every kept word is also a plain word: at most 40 characters, no run of 6 or more digits (dates of birth,
 * identity numbers, phone numbers), no run of 16 or more letters and digits (tokens and keys), and left unchanged
 * by the redactor.
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
/** Programs whose second word is a subcommand, which may stay. */
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
/** Package managers whose "run" is followed by a script name, which may stay. */
export const PACKAGE_MANAGERS = Object.freeze(["bun", "npm", "pnpm", "yarn"]);
const TOOLS = new Set(TOOLS_WITH_SUBCOMMANDS);
const MANAGERS = new Set(PACKAGE_MANAGERS);
const RUNNERS = new Set(["run", "run-script"]);
const WORD = /^(?:-{1,2}|\.{1,2}\/)?[A-Za-z][A-Za-z0-9._/:+,-]*$/;
const PROGRAM = /^[a-z][a-z0-9._+-]*$/;
const FLAG = /^(?:-[A-Za-z]{1,3}|--[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const SUBCOMMAND = /^[a-z][a-z0-9_-]*(?::[a-z0-9_-]+)*$/;
const DIGIT_RUN = /\d{6,}/;
const TOKEN_RUN = /[A-Za-z0-9]{16,}/;

/**
 * @typedef {object} Token
 * @property {string} text the token without its quotes
 * @property {boolean} [quoted] some of it was quoted or escaped
 */

/**
 * True for a plain word: see the rules at the top of this file.
 * @param {unknown} word
 * @returns {boolean}
 */
export function isPlainWord(word) {
  if (typeof word !== "string" || word === "" || word.length > MAX_WORD_CHARS) return false;
  if (!WORD.test(word) || DIGIT_RUN.test(word) || TOKEN_RUN.test(word)) return false;
  return redact(word) === word;
}

/**
 * The program's name (its folder dropped) when it may travel, else null.
 * @param {string} text
 * @returns {string | null}
 */
function programName(text) {
  const name = text.slice(text.lastIndexOf("/") + 1);
  return PROGRAM.test(name) && isPlainWord(name) ? name : null;
}

/**
 * True when the word may stand at position i (1 or 2) of a key whose first words are program and second.
 * @param {string} word
 * @param {number} i
 * @param {string} program the program's name ("" when it did not travel)
 * @param {string} second the key's second word
 * @returns {boolean}
 */
function keepAt(word, i, program, second) {
  if (!isPlainWord(word)) return false;
  if (FLAG.test(word)) return true;
  if (i === 1) return TOOLS.has(program) && SUBCOMMAND.test(word);
  if (i === 2) return MANAGERS.has(program) && RUNNERS.has(second) && SUBCOMMAND.test(word);
  return false;
}

/**
 * The summary key of a command's first tokens (at most KEY_WORDS are used): one word per token, "…" where a token
 * may not travel. "" without tokens.
 * @param {ReadonlyArray<Token | string>} tokens
 * @returns {string}
 */
export function summaryKeyFromTokens(tokens) {
  const list = tokens.slice(0, KEY_WORDS).map((t) => (typeof t === "string" ? { text: t, quoted: false } : t));
  if (list.length === 0) return "";
  /** @param {Token} t */
  const usable = (t) => typeof t.text === "string" && t.text !== "" && !t.quoted && !/\s/.test(t.text);
  const program = usable(list[0]) ? programName(list[0].text) : null;
  /** @type {string[]} */
  const out = [program ?? ELLIPSIS];
  for (let i = 1; i < list.length; i++) {
    const t = list[i];
    out.push(usable(t) && keepAt(t.text, i, program ?? "", out[1] ?? "") ? t.text : ELLIPSIS);
  }
  return out.join(" ");
}

/**
 * The summary key of plain text, split on white space; a word holding a quote or a backslash counts as quoted.
 * For a shell command prefer lib/ledger.mjs summaryKeyOf, which knows where the shell's quotes were.
 * @param {unknown} text
 * @returns {string}
 */
export function summaryKey(text) {
  const words = String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  return summaryKeyFromTokens(words.map((w) => ({ text: w, quoted: /["'`\\]/.test(w) })));
}

/**
 * True for a key summaryKeyFromTokens() could have made: 1 to KEY_WORDS words separated by single spaces, each one
 * that may stand at its place, or "…".
 * @param {unknown} key
 * @returns {boolean}
 */
export function isSummaryKey(key) {
  if (typeof key !== "string" || key === "") return false;
  const words = key.split(" ");
  if (words.length > KEY_WORDS || words.some((w) => w === "")) return false;
  const program = words[0] === ELLIPSIS ? "" : words[0];
  if (program !== "" && !(PROGRAM.test(program) && isPlainWord(program))) return false;
  return words.every((w, i) => i === 0 || w === ELLIPSIS || keepAt(w, i, program, words[1] ?? ""));
}
