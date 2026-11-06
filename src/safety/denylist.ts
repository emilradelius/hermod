/**
 * The hard denylist: tool calls that are never run, in any mode, whoever asks.
 *
 * A call is matched as text: the tool name plus the JSON-serialised input, and also the tool name plus each string
 * inside the input on its own (so a shell command is seen exactly as the shell would get it). Matching is
 * case-insensitive and whitespace-tolerant (runs of whitespace, including escaped newlines and tabs, count as one
 * space). Apps can add patterns; there is deliberately no way to remove or replace a default one.
 *
 * Exec-style inputs are also read as one command line: each array of strings joined with spaces (an argv such as
 * ["find", "/", "-delete"]), and each string field of an object followed by each of its string-array fields
 * ({ command: "rm", args: ["-rf", "/"] } reads as "rm -rf /").
 *
 * Each string inside the input is also checked in a normalised form (it only adds denials, never removes one):
 * - SQL comments become spaces: block comments, and "--" line comments up to the end of their line or of the text,
 *   so "DROP", an empty block comment and "TABLE" with no space between them read as "DROP TABLE", and
 *   "TRUNCATE users -- done" reads as "TRUNCATE users";
 * - shell quoting inside words is undone the way the shell would: empty quote pairs ('' "" and empty backticks)
 *   and backslashes go, closed quote pairs without spaces lose their quotes, and $IFS / ${IFS} become a space, so
 *   "r''m -rf /" and "rm -rf $IFS/" read as "rm -rf /".
 *
 * The denylist is a backstop, not a sandbox: it catches the common forms of the worst commands, and a determined
 * caller can always spell a command some other way. What keeps a session safe is the approval policy (side effects
 * are proposals unless the agent is autonomous and the session clean) and the tools an app chooses to give.
 */

export interface DenyPattern {
  /** Stable id, reported as `pattern` when a call is denied. */
  readonly id: string;
  /** Plain English, for approval reasons and audit entries. */
  readonly description: string;
  readonly regex: RegExp;
}

export interface DenyCall {
  tool: string;
  input: unknown;
}

export interface DenyResult {
  denied: boolean;
  /** The id of the pattern that matched. */
  pattern?: string;
  /** What the pattern stands for, in plain English. */
  description?: string;
}

export interface Denylist {
  isDenied(call: DenyCall): DenyResult;
  /** Every pattern in use (defaults first). A frozen copy: changing it changes nothing. */
  readonly patterns: readonly DenyPattern[];
}

export interface DenylistOptions {
  /** More patterns: a RegExp, a regular-expression source string, or { id, description, pattern }. */
  extraPatterns?: ReadonlyArray<RegExp | string | { id: string; description?: string; pattern: RegExp | string }>;
}

/** The end of a shell word: whitespace, a separator, a closing quote or bracket, or the end. */
const END = String.raw`(?=$|[\s;&|,)}\]"'\\\x60])`;
/** An optional quote, possibly JSON-escaped. */
const Q = String.raw`(?:\\?["'\x60])?`;
/** The rest of one shell command (bounded, so matching stays linear). */
const SEG = String.raw`[^;&|\n]{0,500}?`;
/** Up to 64 words before the dangerous operand ("rm -rf build /"); each word is a run of non-space characters. */
const WORDS = String.raw`(?:[^\s;&|]{1,500}\s+){0,64}?`;
const RECURSIVE = String.raw`(?<=^|\s)${Q}(?:-[a-z]*r[a-z]*|--recursive)${Q}(?=\s|$)`;
/**
 * An operand that is the root, the home directory or everything: "/", "//", "/.", "/..", "/../..", "/*", "~", "~/",
 * "*", "./*", "$HOME", or a path made only of ".." steps ("..", "../../../../"), which climbs to the root from any
 * directory deep enough.
 */
const ROOTISH = String.raw`(?:\/+(?:\.{1,2}\/+)*\.{0,2}\*?|(?:\.\.\/+)*\.\.\/*\*?|~\/?\*?|\*|\.\/\*|\$\{?home\}?\/?\*?)`;
/** A shell: whatever is piped into it runs, whatever its flags. */
const SHELL = String.raw`(?:(?:ba|z|da|k|fi|c|tc|a|y)?sh|pwsh|powershell)\b`;
/** Another interpreter: python, perl, ruby, node, php, … */
const SCRIPTER = String.raw`(?:python[\d.]*|pypy[\d.]*|perl[\d.]*|ruby[\d.]*|node(?:js)?|deno|bun|php[\d.]*|lua[\d.]*|tclsh|osascript|rscript)\b`;
/**
 * An interpreter reading its program from the pipe: a shell with any flags, or another interpreter with no script
 * or code argument (nothing, or "-"), so "curl … | python3 -m json.tool" (data, not code) is not matched.
 */
const RUNS_STDIN = String.raw`(?:${SHELL}|${SCRIPTER}(?:\s+-(?![cemp]\b|-)[a-z]{1,10}){0,5}(?:\s+-)?\s*(?=$|[;&|)"'\x60\\]))`;
/** One pipe (not "||"). */
const PIPE = String.raw`(?<!\|)\|(?!\|)`;
/**
 * Prefixes before the interpreter in a pipe, each optionally with a path ("/usr/bin/env"): sudo, doas, env, command,
 * exec, nohup, nice, time and busybox, with flags (a flag may take one value: "-u root", "-n 10") and env-style
 * assignments ("VAR=1").
 */
const PREFIX = String.raw`(?:\S*\/)?(?:sudo|doas|env|command|exec|nohup|nice|time|busybox)\s+(?:-\S+\s+(?:\w[\w.-]{0,63}\s+)?){0,5}(?:\S+=\S*\s+){0,10}`;
const RUNNER = String.raw`(?:${PREFIX}){0,4}(?:\S*\/)?`;
/** One part of a SQL object name: a word, or a quoted name that may hold spaces ("my table", `my table`). */
const SQL_PART = String.raw`(?:"[^"\n]{1,200}"|\x60[^\x60\n]{1,200}\x60|[\w"]{1,200})`;
/** A SQL object name: parts joined by dots (a trailing full stop is not part of it). */
const SQL_NAME = String.raw`${SQL_PART}(?:\.${SQL_PART}){0,3}`;
const MODE_777 = String.raw`(?<=^|\s)${Q}(?:0?777|a\+rwx|ugo\+rwx)${Q}(?=\s|$)`;

function pattern(id: string, description: string, source: string): DenyPattern {
  return Object.freeze({ id, description, regex: new RegExp(source, "i") });
}

export const DEFAULT_DENY_PATTERNS: readonly DenyPattern[] = Object.freeze([
  pattern(
    "rm-recursive-root",
    "recursive delete of /, ~, $HOME, * or the parent directories",
    String.raw`\brm\s+(?=${SEG}${RECURSIVE})${WORDS}${Q}${ROOTISH}${Q}${END}`,
  ),
  pattern("mkfs", "formatting a file system (mkfs)", String.raw`\bmkfs(?:\.[a-z0-9]+)?\b`),
  pattern(
    "dd-to-device",
    "dd writing to a device under /dev/",
    String.raw`\bdd\b${SEG}\bof=${Q}\/dev\/(?!null\b|zero\b|stdout\b|stderr\b)`,
  ),
  pattern(
    "write-to-disk-device",
    "redirecting output onto a disk device",
    String.raw`>\s*\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|xvd[a-z]|disk\d|mmcblk\d)`,
  ),
  pattern(
    "fork-bomb",
    "a fork bomb",
    String.raw`(?<![\w:])([a-z_:][\w:]{0,30})\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1`,
  ),
  pattern(
    "chmod-777-root",
    "recursive chmod 777 of /",
    String.raw`\bchmod\s+(?=${SEG}${RECURSIVE})(?=${SEG}${MODE_777})${WORDS}${Q}\/\*?${Q}${END}`,
  ),
  pattern(
    "curl-pipe-shell",
    "downloading a script and piping it into a shell or another interpreter",
    String.raw`\b(?:curl|wget|fetch|aria2c)\b[^;&|\n]{0,500}${PIPE}(?:[^;&|\n]{0,200}${PIPE}){0,5}\s*${RUNNER}${RUNS_STDIN}|\b(?:${SHELL}|${SCRIPTER})\s+(?:-\S+\s+){0,3}${Q}(?:<\(|\$\()\s*(?:curl|wget)\b`,
  ),
  pattern(
    "find-delete-root",
    "find deleting from /, ~, $HOME or the parent directories",
    String.raw`\bfind\s+(?:-[hlp]\s+){0,3}${Q}${ROOTISH}${Q}${END}(?=${SEG}\s-(?:delete\b|exec(?:dir)?\s+(?:\S*\/)?rm\b))`,
  ),
  pattern("drop-database", "DROP DATABASE, SCHEMA or TABLE", String.raw`\bdrop\s+(?:database|schema|table)\b`),
  pattern(
    "truncate-table",
    "TRUNCATE of a table",
    String.raw`\btruncate\s+table\b|(?<=^\S*\s|[;("'\x60]\s{0,10}|\b(?:do|execute|begin|then)\s{1,10})truncate\s+(?:only\s+)?${SQL_NAME}(?:\s*,\s*${SQL_NAME}){0,20}\s*\*?\s*(?=;|$|["'\x60)\\])|\btruncate\s+(?:only\s+)?${SQL_NAME}(?:\s*,\s*${SQL_NAME}){0,20}\s*(?:;|\s(?:cascade|restrict|restart\s+identity|continue\s+identity)\b)`,
  ),
  pattern(
    "delete-without-where",
    "DELETE FROM a table without a WHERE clause",
    String.raw`\bdelete\s+from\s+(?:only\s+)?${SQL_NAME}(?:\s+(?:as\s+)?(?!where\b|using\b|returning\b)[a-z_]\w{0,60})?\s*(?:;|$|\breturning\b)`,
  ),
  pattern(
    "git-force-push-main",
    "force-pushing to main or master",
    String.raw`\bgit\s+(?:-c\s+\S+\s+){0,5}push\b(?=[^;&|\n]{0,500}?\s${Q}(?:--force(?:-with-lease)?(?:=\S*)?|-[a-z]*f[a-z]*)${Q}(?=\s|$))(?=[^;&|\n]{0,500}?[\s:/"](?:refs\/heads\/)?(?:main|master)(?![\w./-]))|\bgit\s+(?:-c\s+\S+\s+){0,5}push\b[^;&|\n]{0,500}?\s${Q}\+(?:refs\/heads\/)?(?:main|master)(?![\w./-])`,
  ),
  pattern(
    "git-delete-main",
    "deleting the main or master branch on a remote",
    String.raw`\bgit\s+push\b[^;&|\n]{0,500}?\s${Q}(?::(?:refs\/heads\/)?(?:main|master)|--delete\s+(?:\S+\s+)?(?:main|master)|-d\s+(?:\S+\s+)?(?:main|master))(?![\w./-])`,
  ),
  pattern(
    "disable-rls",
    "turning off row level security",
    String.raw`\b(?:disable|no\s+force)\s+row\s+level\s+security\b|\brow_security\s*(?:=|to)\s*${Q}off\b`,
  ),
]);

function compileExtra(entry: NonNullable<DenylistOptions["extraPatterns"]>[number], index: number): DenyPattern {
  if (entry instanceof RegExp || typeof entry === "string") {
    const source = entry instanceof RegExp ? entry.source : entry;
    return compileOne(`extra-${index + 1}`, `app pattern ${index + 1}`, source, entry instanceof RegExp ? entry.flags : "");
  }
  if (entry && typeof entry === "object" && typeof entry.id === "string") {
    const p = entry.pattern;
    const source = p instanceof RegExp ? p.source : p;
    return compileOne(entry.id, entry.description ?? entry.id, source, p instanceof RegExp ? p.flags : "");
  }
  throw new TypeError(`Denylist pattern ${index + 1} must be a RegExp, a string, or { id, pattern }.`);
}

function compileOne(id: string, description: string, source: unknown, flags: string): DenyPattern {
  if (typeof source !== "string" || source.trim() === "") {
    throw new TypeError(`Denylist pattern "${id}" is empty; give a regular expression.`);
  }
  const kept = [...new Set(flags.replace(/[gy]/g, "") + "i")].join("");
  try {
    return Object.freeze({ id, description, regex: new RegExp(source, kept) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Denylist pattern "${id}" is not a valid regular expression: ${reason}`, { cause: error });
  }
}

/** JSON.stringify that never throws: cycles, BigInts and throwing toJSON become markers. */
function safeStringify(value: unknown): { json: string; ok: boolean } {
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
    return { json: json ?? String(value), ok: true };
  } catch {
    return { json: "", ok: false };
  }
}

/** Limits of the walk over an input. An input past any of them is not inspected in part: it is denied as a whole. */
const MAX_LEAVES = 50_000;
const MAX_DEPTH = 32;
const MAX_COMMAND_LINES = 5_000;

/** Set when a walk stopped early, so the input could not be inspected in full. */
interface Walk {
  incomplete: boolean;
}

/** Every string inside the input (keys too), depth-limited. */
function stringLeaves(value: unknown, out: string[], walk: Walk, depth = 0, seen = new WeakSet<object>()): void {
  if (out.length >= MAX_LEAVES) {
    walk.incomplete = true;
    return;
  }
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (depth > MAX_DEPTH) {
    walk.incomplete = true;
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) stringLeaves(item, out, walk, depth + 1, seen);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      stringLeaves(item, out, walk, depth + 1, seen);
    }
  } catch {
    // A hostile getter; the JSON text is still checked.
  }
}

/**
 * An argv: a non-empty array of plain values with at least one string ({ args: ["-rf", "/", 0] } still counts).
 * Returns its words, or null.
 */
function argvWords(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((item) => item === null || item === undefined || ["string", "number", "boolean"].includes(typeof item))) return null;
  if (!value.some((item) => typeof item === "string")) return null;
  return value.filter((item) => item !== null && item !== undefined).map((item) => String(item));
}

/**
 * Exec-style inputs read as one command line, depth-limited: each array of strings joined with spaces
 * (["find", "/", "-delete"]), and for an object with string fields and string-array fields, each string field
 * followed by each array ({ command: "rm", args: ["-rf", "/"] } reads as "rm -rf /"). Only adds text to check.
 */
function commandLines(value: unknown, out: string[], walk: Walk, depth = 0, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (out.length >= MAX_COMMAND_LINES || depth > MAX_DEPTH) {
    walk.incomplete = true;
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  /** @returns false when the cap is reached (the walk is then incomplete). */
  const add = (line: string): boolean => {
    if (out.length >= MAX_COMMAND_LINES) {
      walk.incomplete = true;
      return false;
    }
    out.push(line);
    return true;
  };
  try {
    if (Array.isArray(value)) {
      const argv = argvWords(value);
      if (argv && !add(argv.join(" "))) return;
      for (const item of value) commandLines(item, out, walk, depth + 1, seen);
      return;
    }
    const fields = Object.values(value);
    const words = fields.filter((field): field is string => typeof field === "string");
    const argvs = fields.map(argvWords).filter((argv): argv is string[] => argv !== null);
    for (const word of words) {
      for (const argv of argvs) if (!add(`${word} ${argv.join(" ")}`)) return;
    }
    for (const field of fields) commandLines(field, out, walk, depth + 1, seen);
  } catch {
    // A hostile getter; the JSON text and the string leaves are still checked.
  }
}

/** One space for any run of whitespace, including JSON-escaped newlines, tabs and carriage returns. */
function squash(text: string): string {
  return text.replace(/\\[nrt]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Replaces every span from `open` to the first `close` after it (inclusive) with a space, in one linear pass. With
 * `toEnd`, a span that is never closed runs to the end of the text (a SQL line comment on the last line).
 */
function replaceSpans(text: string, open: string, closes: readonly string[], toEnd = false): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const start = text.indexOf(open, pos);
    if (start < 0) break;
    let end = -1;
    let closeLength = 0;
    for (const close of closes) {
      const at = text.indexOf(close, start + open.length);
      if (at >= 0 && (end < 0 || at < end)) {
        end = at;
        closeLength = close.length;
      }
    }
    if (end < 0) {
      if (!toEnd) break;
      out += `${text.slice(pos, start)} `;
      pos = text.length;
      break;
    }
    out += `${text.slice(pos, start)} `;
    pos = end + closeLength;
  }
  return pos === 0 ? text : out + text.slice(pos);
}

/** SQL comments become a space: block comments, and "--" line comments (to the line's end or the text's end). */
function withoutSqlComments(text: string): string {
  return replaceSpans(replaceSpans(text, "/*", ["*/"]), "--", ["\n", "\\n"], true);
}

/** Shell quoting inside words undone: empty quote pairs, backslashes and quote pairs without spaces go; $IFS is a space. */
function withoutShellQuoting(text: string): string {
  return text
    .replace(/\$\{?ifs\}?/gi, " ")
    .replace(/''|""|\x60\x60/g, "")
    .replace(/\\(?=\S)/g, "")
    .replace(/'([^'\s]{0,500})'|"([^"\s]{0,500})"/g, (_m, a: string | undefined, b: string | undefined) => a ?? b ?? "");
}

/** One string as matched: squashed, plus its normalised form (SQL comments and shell quoting undone) when it differs. */
function forms(text: string): string[] {
  const plain = squash(text);
  const normalised = squash(withoutShellQuoting(withoutSqlComments(text)));
  return normalised === plain ? [plain] : [plain, normalised];
}

/** Creates a denylist with the defaults plus the app's own patterns. Throws only for an invalid extra pattern. */
export function createDenylist(options: DenylistOptions = {}): Denylist {
  const extras = (options?.extraPatterns ?? []).map((entry, i) => compileExtra(entry, i));
  const patterns: readonly DenyPattern[] = Object.freeze([...DEFAULT_DENY_PATTERNS, ...extras]);

  function isDenied(call: DenyCall): DenyResult {
    const tool = typeof call?.tool === "string" ? call.tool : String(call?.tool ?? "");
    const { json, ok } = safeStringify(call?.input);
    if (!ok) {
      return {
        denied: true,
        pattern: "uninspectable-input",
        description: "the input could not be serialised, so it cannot be checked",
      };
    }
    const walk: Walk = { incomplete: false };
    const leaves: string[] = [];
    stringLeaves(call?.input, leaves, walk);
    const lines: string[] = [];
    commandLines(call?.input, lines, walk);
    if (walk.incomplete) {
      // Fail closed: a part of the input that was not read could hold exactly what the patterns look for.
      return {
        denied: true,
        pattern: "uninspectable-input",
        description: "the input is too large or too deeply nested to check in full",
      };
    }
    leaves.push(...lines);
    // The JSON text is matched as it is (its backslashes and quotes are JSON's); each string on its own is also read
    // in its normalised form, the way SQL or the shell would get it.
    const haystacks = [squash(`${tool} ${json}`), ...leaves.flatMap((leaf) => forms(`${tool} ${leaf}`))];
    for (const p of patterns) {
      for (const hay of haystacks) {
        if (p.regex.test(hay)) return { denied: true, pattern: p.id, description: p.description };
      }
    }
    return { denied: false };
  }

  return Object.freeze({ isDenied, patterns });
}

/** A shared denylist with only the defaults. */
export const defaultDenylist: Denylist = createDenylist();
