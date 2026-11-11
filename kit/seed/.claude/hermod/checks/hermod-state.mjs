// @ts-check
// Lesson as a check: Hermod's working state stays on the device (.claude/hermod/.local/, self-ignoring) unless a
// PRIVATE repository opted in to let a small summary of each session travel between devices: a person creates
// .claude/hermod/state/ALLOW_COMMIT and merges it to the default branch. This check fails a change that:
// - contains a file under .claude/hermod/.local/ (forced past its .gitignore);
// - adds a file under .claude/hermod/state/ while the marker is not on the remote default branch (origin/HEAD,
//   origin/main or origin/master), so a marker made in a session does nothing until a person merges it;
// - adds any file under .claude/hermod/state/ other than ALLOW_COMMIT and sessions/<YYYY-MM-DD>-<id8>.json;
// - adds a session summary that breaks the summary rules (lib/travel.mjs): unknown fields, or a command key that
//   is more than a program, flags, a tool's subcommand and a script name (no prose, path, value or password);
// - adds a file under .claude/hermod/usage/ (no longer written; summaries go to state/sessions/).
// Deleting such files always passes. It imports nothing, so the rules are repeated here from lib/summary.mjs and
// lib/travel.mjs; the kit's tests keep them in step. It has no `when` list: it is cheap and must see every change.

const LOCAL = ".claude/hermod/.local/";
const STATE = ".claude/hermod/state/";
const USAGE = ".claude/hermod/usage/";
const MARKER = ".claude/hermod/state/ALLOW_COMMIT";
const SESSIONS = ".claude/hermod/state/sessions/";
const DEFAULTS = ["refs/remotes/origin/main", "refs/remotes/origin/master"];
const MAX_BYTES = 16 * 1024;
const MAX_COMMANDS = 30;
const MAX_SKILLS = 100;
const MAX_COUNT = 1000000;
const SUMMARY_KEYS = ["v", "session", "date", "branch", "skills", "commands"];
const COMMAND_KEYS = ["key", "exit", "attempts", "resolved"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_NAME = /^(\d{4}-\d{2}-\d{2})-([0-9a-f]{8})\.json$/;
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BRANCH_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A key is at most three words: the program's name; then only flags ("-x" to "-xyz", "--long-name"), a tool's
// subcommand as the second word, and a package manager's script name after "run" as the third. Anything else is "…".
const PROGRAM = /^[a-z][a-z0-9._+-]*$/;
const FLAG = /^(?:-[A-Za-z]{1,3}|--[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const SUBCOMMAND = /^[a-z][a-z0-9_-]*(?::[a-z0-9_-]+)*$/;
const TOOLS = new Set(["bun", "cargo", "deno", "docker", "eslint", "gh", "git", "go", "jest", "kubectl", "make", "next", "node", "npm", "npx", "pip", "pip3", "pnpm", "prettier", "python", "python3", "supabase", "terraform", "tsc", "uv", "vercel", "vitest", "yarn"]);
const MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const RUNNERS = new Set(["run", "run-script"]);
const ELLIPSIS = "…";

/** @param {unknown} w */
const plain = (w) => typeof w === "string" && w !== "" && w.length <= 40 && !/\d{6,}/.test(w) && !/[A-Za-z0-9]{16,}/.test(w);

/** @param {string} w @param {number} i @param {string} program @param {string} second */
function keepAt(w, i, program, second) {
  if (!plain(w)) return false;
  if (FLAG.test(w)) return true;
  if (i === 1) return TOOLS.has(program) && SUBCOMMAND.test(w);
  if (i === 2) return MANAGERS.has(program) && RUNNERS.has(second) && SUBCOMMAND.test(w);
  return false;
}

/** @param {unknown} key */
function isKey(key) {
  if (typeof key !== "string" || key === "") return false;
  const words = key.split(" ");
  if (words.length > 3 || words.some((w) => w === "")) return false;
  const program = words[0] === ELLIPSIS ? "" : (words[0] ?? "");
  if (program !== "" && !(PROGRAM.test(program) && plain(program))) return false;
  return words.every((w, i) => i === 0 || w === ELLIPSIS || keepAt(w, i, program, words[1] ?? ""));
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {unknown} n @param {number} min */
const isCount = (n, min) => typeof n === "number" && Number.isInteger(n) && n >= min && n <= MAX_COUNT;

/** @param {unknown} s */
function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** @param {unknown} b */
function isBranch(b) {
  return typeof b === "string" && b !== "" && b.length <= 100 && b.split("/").every((p) => BRANCH_PART.test(p) && !/\d{6,}/.test(p) && !/[A-Za-z0-9]{16,}/.test(p));
}

/**
 * What is wrong with a session summary ("" when it may travel).
 * @param {string} text
 * @param {string} name the file's base name
 */
function summaryProblem(text, name) {
  const m = FILE_NAME.exec(name);
  if (!m) return "the name must be <YYYY-MM-DD>-<first 8 of the session id>.json";
  if (Buffer.byteLength(text) > MAX_BYTES) return "it is larger than 16 KB";
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return "it is not valid JSON";
  }
  if (!isObject(v)) return "it is not a JSON object";
  const extra = Object.keys(v).find((k) => !SUMMARY_KEYS.includes(k));
  if (extra) return `"${extra.slice(0, 30)}" is not a summary field (only ${SUMMARY_KEYS.join(", ")})`;
  if (v.v !== 1) return '"v" must be 1';
  if (typeof v.session !== "string" || !UUID.test(v.session) || !v.session.startsWith(m[2])) return '"session" must be the UUID the file name starts';
  if (!isDate(v.date) || v.date !== m[1]) return '"date" must be the file name\'s date';
  if ("branch" in v && !isBranch(v.branch)) return '"branch" must be a plain branch name';
  if (!isObject(v.skills) || Object.keys(v.skills).length > MAX_SKILLS) return '"skills" must be an object of at most 100 skills';
  for (const [s, c] of Object.entries(v.skills)) {
    if (!SKILL_NAME.test(s) || s.length > 64) return `"${s.slice(0, 30)}" is not a skill name`;
    if (!isObject(c) || Object.keys(c).some((k) => k !== "uses" && k !== "views") || !isCount(c.uses, 0) || !isCount(c.views, 0)) return `skill ${s} must be { "uses": n, "views": n }`;
  }
  if (!Array.isArray(v.commands) || v.commands.length > MAX_COMMANDS) return '"commands" must be a list of at most 30';
  for (const [i, c] of v.commands.entries()) {
    if (!isObject(c)) return `commands[${i}] must be an object`;
    const bad = Object.keys(c).find((k) => !COMMAND_KEYS.includes(k));
    if (bad) return `commands[${i}]: "${bad.slice(0, 30)}" is not a command field (no command text or output may travel)`;
    if (!isKey(c.key)) return `commands[${i}]: "key" must be at most three plain words, like "npm run build"`;
    if (!(c.exit === null || (typeof c.exit === "number" && Number.isInteger(c.exit) && Math.abs(c.exit) <= 255))) return `commands[${i}]: "exit" must be an exit code or null`;
    if (!isCount(c.attempts, 1) || typeof c.resolved !== "boolean") return `commands[${i}]: "attempts" and "resolved" are wrong`;
  }
  return "";
}

/**
 * True when the marker is on the remote default branch. Without git (the --self-test examples) the base files
 * stand for that branch.
 * @param {any} ctx
 */
function markerOnDefault(ctx) {
  const head = typeof ctx.git === "function" ? ctx.git(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]) : null;
  const target = head && head.ok ? String(head.stdout).trim() : "";
  // origin/HEAD decides when it is set; origin/main and origin/master count only when it is not.
  const refs = target.startsWith("refs/remotes/origin/") && !target.endsWith("/HEAD") ? [target] : DEFAULTS;
  return refs.some((ref) => {
    const text = typeof ctx.readAt === "function" ? ctx.readAt(ref, MARKER) : null;
    return text !== null && text !== undefined;
  });
}

/** @type {import('../lib/checks.mjs').Check} */
export default {
  id: "hermod-state",
  description:
    "Hermod's device state is never committed; a session summary travels only in a repository that opted in (.claude/hermod/state/ALLOW_COMMIT on the default branch) and only as plain-word keys, never command text or output.",
  level: "error",
  run(ctx) {
    /** @type {string[]} */
    const problems = [];
    let allowed = null;
    for (const f of ctx.changedFiles ?? []) {
      const exists = typeof ctx.read === "function" && ctx.read(f) !== null && ctx.read(f) !== undefined;
      if (!exists) continue; // deleting is always fine
      if (f.startsWith(LOCAL)) problems.push(`${f} is device state (.local/ is never committed)`);
      else if (f.startsWith(USAGE)) problems.push(`${f}: usage files are no longer written; summaries go to ${SESSIONS}`);
      else if (f === MARKER) continue;
      else if (f.startsWith(STATE)) {
        if (allowed === null) allowed = markerOnDefault(ctx);
        if (!allowed) {
          problems.push(`${f}: this repository has not opted in (${MARKER} is not on the default branch), so state stays on the device`);
          continue;
        }
        const name = f.slice(SESSIONS.length);
        if (!f.startsWith(SESSIONS) || name.includes("/")) {
          problems.push(`${f}: only ${SESSIONS}<YYYY-MM-DD>-<id8>.json may be under ${STATE}`);
          continue;
        }
        const why = summaryProblem(String(ctx.read(f)), name);
        if (why) problems.push(`${f}: ${why}`);
      }
    }
    if (problems.length === 0) return { ok: true };
    return { ok: false, message: problems.slice(0, 4).join("; ") + (problems.length > 4 ? `; and ${problems.length - 4} more` : "") };
  },
  examples: [
    { name: "passes for ordinary files", ctx: { changedFiles: ["src/a.ts"], files: { "src/a.ts": "x" } }, expect: true },
    {
      name: "fails on a file from .local/",
      ctx: { changedFiles: [".claude/hermod/.local/ledger.jsonl"], files: { ".claude/hermod/.local/ledger.jsonl": "{}" } },
      expect: false,
    },
    {
      name: "fails on a session summary when the marker is only in the working tree",
      ctx: {
        changedFiles: [".claude/hermod/state/sessions/2026-11-10-0f8fad5b.json"],
        files: {
          ".claude/hermod/state/ALLOW_COMMIT": "private\n",
          ".claude/hermod/state/sessions/2026-11-10-0f8fad5b.json": '{"v":1,"session":"0f8fad5b-d9cb-469f-a165-70867728950e","date":"2026-11-10","skills":{},"commands":[]}',
        },
      },
      expect: false,
    },
    {
      name: "passes for a valid summary when the marker is on the default branch",
      ctx: {
        changedFiles: [".claude/hermod/state/sessions/2026-11-10-0f8fad5b.json"],
        files: {
          ".claude/hermod/state/ALLOW_COMMIT": "private\n",
          ".claude/hermod/state/sessions/2026-11-10-0f8fad5b.json":
            '{"v":1,"session":"0f8fad5b-d9cb-469f-a165-70867728950e","date":"2026-11-10","branch":"claude/x","skills":{"reflect":{"uses":1,"views":2}},"commands":[{"key":"npm run build","exit":1,"attempts":2,"resolved":true}]}',
        },
        baseFiles: { ".claude/hermod/state/ALLOW_COMMIT": "private\n" },
      },
      expect: true,
    },
    {
      name: "fails on a summary that carries command output",
      ctx: {
        changedFiles: [".claude/hermod/state/sessions/2026-11-10-0f8fad5b.json"],
        files: {
          ".claude/hermod/state/sessions/2026-11-10-0f8fad5b.json":
            '{"v":1,"session":"0f8fad5b-d9cb-469f-a165-70867728950e","date":"2026-11-10","skills":{},"commands":[{"key":"npm test","exit":1,"attempts":1,"resolved":false,"out":"FAIL …"}]}',
        },
        baseFiles: { ".claude/hermod/state/ALLOW_COMMIT": "private\n" },
      },
      expect: false,
    },
    {
      name: "fails on a summary whose command key is prose",
      ctx: {
        changedFiles: [".claude/hermod/state/sessions/2026-11-10-0f8fad5b.json"],
        files: {
          ".claude/hermod/state/sessions/2026-11-10-0f8fad5b.json":
            '{"v":1,"session":"0f8fad5b-d9cb-469f-a165-70867728950e","date":"2026-11-10","skills":{},"commands":[{"key":"echo my notes","exit":1,"attempts":1,"resolved":false}]}',
        },
        baseFiles: { ".claude/hermod/state/ALLOW_COMMIT": "private\n" },
      },
      expect: false,
    },
    {
      name: "fails on another file under state/ even when opted in",
      ctx: { changedFiles: [".claude/hermod/state/notes.md"], files: { ".claude/hermod/state/notes.md": "x" }, baseFiles: { ".claude/hermod/state/ALLOW_COMMIT": "private\n" } },
      expect: false,
    },
    {
      name: "fails on a new usage file",
      ctx: { changedFiles: [".claude/hermod/usage/2026-11-10-0f8fad5b.json"], files: { ".claude/hermod/usage/2026-11-10-0f8fad5b.json": "{}" } },
      expect: false,
    },
    {
      name: "passes when a summary is deleted, and for the marker itself",
      ctx: { changedFiles: [".claude/hermod/state/sessions/2026-11-10-0f8fad5b.json", ".claude/hermod/state/ALLOW_COMMIT"], files: { ".claude/hermod/state/ALLOW_COMMIT": "private\n" } },
      expect: true,
    },
  ],
};
