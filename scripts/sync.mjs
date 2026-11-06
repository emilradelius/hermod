// @ts-check
/**
 * Hermod kit sync: copies the kit into a target repository at a pinned ref. A person runs it; no hook ever does.
 *
 *   node scripts/sync.mjs --target <repo> --ref <tag | full 40-hex commit sha> [--skills <names | none | all>]
 *                         [--source <hermod repo>] [--dry-run] [--force] [--allow-dirty] [--json]
 *
 * - The ref is resolved in the hermod repository (--source; default: the repository that contains this script).
 *   Branch names and short shas are refused: they can point at different commits over time.
 * - kit/files, kit/seed, kit/VERSION, kit/settings.hooks.json and kit/skills.json are read AT THAT COMMIT with
 *   `git ls-tree -r -z` and `git show <commit>:<path>`, byte for byte (each blob is checked against its object id),
 *   never from the working tree or the index.
 * - kit/files/<path> is copied to <target>/<path>; every such path is under .claude/. The stamp
 *   (.claude/hermod/VERSION.json) records which files the kit wrote and their sha256, so local edits and the
 *   repository's own files are never overwritten (local edits only with --force).
 * - Skills: every folder in kit/files/.claude/skills/ is a core skill, always synced, unless kit/skills.json
 *   ({"optional": [names]}) lists it as optional; a ref without that file has no optional skills. An optional
 *   skill is synced only when it is chosen with --skills. The stamp records the choice ("skills"), and a run
 *   without --skills keeps the last sync's choice (none on a first install); an optional skill that the last sync
 *   installed stays chosen, also when it was a core skill then. The files of a skill that is not chosen are left
 *   out of the plan, so they are deleted like files the kit no longer has (and kept when changed locally).
 * - kit/seed/<path> is created only when missing; the repository owns it from then on.
 * - The kit's hook entries are merged into .claude/settings.json; every other key, hook and order stays as it was.
 * - All or nothing: the whole plan is computed and checked first. On a conflict nothing is written (exit 1).
 *
 * It writes nothing outside <target>/.claude/, makes no network calls and runs no program except git (with an
 * argument array, never a shell string). Exit codes: 0 done or nothing to do, 1 refused or conflicts, 2 bad usage.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

/** A hook command that contains this text is one of the kit's own entries in .claude/settings.json. */
export const OWNED_HOOK_MARKER = "/.claude/hermod/hooks/";
/** The stamp (manifest) that sync writes in the target. */
export const STAMP_PATH = ".claude/hermod/VERSION.json";
/** The settings file whose hook entries sync merges. */
export const SETTINGS_PATH = ".claude/settings.json";
/** The hooks' local session data (gitignored); sync never reads or writes it. */
const LOCAL_DIR = ".claude/hermod/.local/";

const KIT_FILES_DIR = "kit/files/";
const KIT_SEED_DIR = "kit/seed/";
const KIT_VERSION_FILE = "kit/VERSION";
const KIT_HOOKS_FILE = "kit/settings.hooks.json";
/** Lists the kit's optional skills; read at the ref like kit/VERSION, never synced. */
const KIT_SKILLS_FILE = "kit/skills.json";
/** Where skills live in the target (and in kit/files/). */
const SKILLS_DIR = ".claude/skills/";
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Values of --skills that are not skill names. */
const SKILLS_KEYWORDS = ["none", "all"];

/** Lower-case paths that belong to the repository: the kit may seed them but never own them. */
const REPOSITORY_FILES = [".claude/hermod/config.json", ".claude/hermod/lessons.md"];
const REPOSITORY_DIRS = [
  ".claude/hermod/checks/",
  ".claude/hermod/usage/",
  ".claude/hermod/history/",
  ".claude/hermod/archive/",
];

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const SHORT_SHA = /^[0-9a-f]{4,39}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const KIT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EVENT_NAME = /^[A-Z][A-Za-z]*$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** A refusal or failure, explained in plain English; printed without a stack trace. */
export class SyncError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SyncError";
  }
}

/** An invalid command line (exit code 2). */
export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Defines an own enumerable property, so that a key such as "__proto__" stays an ordinary key.
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @param {unknown} value
 */
function setOwn(object, key, value) {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * A shallow copy that keeps the key order and own "__proto__" keys.
 * @param {Record<string, unknown>} source
 * @returns {Record<string, unknown>}
 */
function copyObject(source) {
  /** @type {Record<string, unknown>} */
  const copy = {};
  for (const key of Object.keys(source)) setOwn(copy, key, source[key]);
  return copy;
}

/** @param {string | Uint8Array} data */
function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The bytes with every CRLF turned into LF (the same buffer when there is none).
 * @param {Buffer} data
 * @returns {Buffer}
 */
export function crlfToLf(data) {
  let index = data.indexOf("\r\n");
  if (index === -1) return data;
  /** @type {Buffer[]} */
  const parts = [];
  let start = 0;
  while (index !== -1) {
    parts.push(data.subarray(start, index));
    start = index + 1;
    index = data.indexOf("\r\n", start);
  }
  parts.push(data.subarray(start));
  return Buffer.concat(parts);
}

/**
 * True when `data` is the content with this sha256, also when git turned its LF line endings into CRLF on
 * checkout (core.autocrlf, common on Windows): that is not a local change.
 * @param {Buffer} data
 * @param {string} hash
 */
export function sameContent(data, hash) {
  if (sha256(data) === hash) return true;
  const lf = crlfToLf(data);
  return lf !== data && sha256(lf) === hash;
}

/** @param {string} text */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * @param {Uint8Array} data
 * @returns {string | null} the text, or null when the bytes are not valid UTF-8
 */
function decodeUtf8(data) {
  try {
    return UTF8.decode(data);
  } catch {
    return null;
  }
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where JSON.parse failed, such as " (at line 3, column 5)". Never quotes the text: JSON.parse messages can
 * contain part of the input, and a settings file can hold secrets (its "env").
 * @param {unknown} error
 */
function jsonErrorPlace(error) {
  const message = messageOf(error);
  const place = /\(line (\d+) column (\d+)\)/.exec(message);
  if (place) return ` (at line ${place[1]}, column ${place[2]})`;
  if (message.includes("Unexpected end of JSON input")) return " (it ends too early)";
  return "";
}

/**
 * Orders strings by UTF-16 code units: the same on every machine (localeCompare is not).
 * @param {string} a
 * @param {string} b
 */
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {number} count
 * @param {string} noun
 */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * @param {string[]} items
 * @param {number} [max]
 */
function listSome(items, max = 5) {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/** @param {string} dir */
function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} file */
function realPath(file) {
  try {
    return realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * @param {string} a
 * @param {string} b
 */
function samePath(a, b) {
  const caseless = process.platform === "win32" || process.platform === "darwin";
  return caseless ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * @param {string} root
 * @param {string} rel posix path relative to root
 */
function toAbsolute(root, rel) {
  return path.join(root, ...rel.split("/"));
}

// ---------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------

/**
 * The value of --skills: "none", "all", or optional skill names (sorted, without duplicates).
 * @typedef {"none" | "all" | string[]} SkillsChoice
 */

/**
 * @typedef {object} Options
 * @property {string} target the target repository
 * @property {string} ref a tag or a full commit sha in the source repository
 * @property {string | undefined} source the hermod repository (undefined: the one that contains this script)
 * @property {SkillsChoice | undefined} skills the optional skills to sync (undefined: keep the last sync's choice)
 * @property {boolean} dryRun
 * @property {boolean} force overwrite kit files that were changed locally
 * @property {boolean} allowDirty run although the target has uncommitted changes under .claude/
 * @property {boolean} json
 * @property {boolean} help
 */

export const HELP = `Usage: node scripts/sync.mjs --target <repo> --ref <tag | full commit sha> [options]

Copies the Hermod kit (kit/files at the given ref of the hermod repository) into a target git
repository, creates the seed files that are missing, merges the kit's hook entries into
.claude/settings.json and records what it wrote in .claude/hermod/VERSION.json.
Nothing outside <repo>/.claude/ is touched. On a conflict nothing is written.

Options:
  --target <dir>   The target repository (its top-level folder). Required.
  --ref <ref>      A tag (for example v0.1.0) or a full 40-character commit sha. Required.
                   Branch names and short shas are refused because they can move.
  --source <dir>   The hermod repository to read the kit from
                   (default: the repository that contains this script).
  --skills <list>  The optional skills to install: names separated by commas (for example
                   anthropic-sdk,nextjs-16), or none, or all. This replaces the earlier choice.
                   Without --skills the last sync's choice is kept (none on a first install).
                   kit/skills.json at the ref lists the optional skills; every other kit skill
                   is core and always installed.
  --dry-run        Print the plan and write nothing.
  --force          Overwrite kit files that were changed in the target since the last sync.
  --allow-dirty    Run even if the target has uncommitted changes under .claude/.
  --json           Print the result as one JSON object.
  -h, --help       Show this help.

Exit codes: 0 done (or nothing to do), 1 refused or conflicts (nothing written), 2 invalid arguments.
`;

/**
 * Parses the command line. Throws UsageError for unknown, repeated or missing options.
 * @param {string[]} argv the arguments after the script path
 * @returns {Options}
 */
export function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        target: { type: "string" },
        ref: { type: "string" },
        source: { type: "string" },
        skills: { type: "string" },
        "dry-run": { type: "boolean" },
        force: { type: "boolean" },
        "allow-dirty": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
  } catch (error) {
    const unknown = /^Unknown option '([^']*)'/.exec(messageOf(error));
    throw new UsageError(unknown ? `unknown option ${unknown[1]}` : messageOf(error));
  }
  const { values, positionals, tokens } = parsed;
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  const seen = new Set();
  for (const token of tokens ?? []) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new UsageError(`--${token.name} was given more than once`);
    seen.add(token.name);
  }
  /** @type {Options} */
  const options = {
    target: values.target ?? "",
    ref: values.ref ?? "",
    source: values.source,
    skills: undefined,
    dryRun: values["dry-run"] === true,
    force: values.force === true,
    allowDirty: values["allow-dirty"] === true,
    json: values.json === true,
    help: values.help === true,
  };
  if (options.help) return options;
  if (options.target === "") throw new UsageError("--target <repo> is required");
  if (options.ref === "") throw new UsageError("--ref <tag | full commit sha> is required");
  if (options.source === "") throw new UsageError("--source needs a folder");
  if (values.skills !== undefined) options.skills = parseSkillsOption(values.skills);
  return options;
}

/**
 * Parses the value of --skills: "none", "all", or skill names separated by commas (spaces around a name are
 * allowed). Whether a name is an optional skill of the kit is checked later, against the kit at the ref.
 * @param {string} value
 * @returns {SkillsChoice}
 */
export function parseSkillsOption(value) {
  const names = value.split(",").map((name) => name.trim());
  if (names.length === 1 && names[0] === "") {
    throw new UsageError("--skills needs optional skill names separated by commas, or none, or all");
  }
  if (names.length === 1 && (names[0] === "none" || names[0] === "all")) return names[0];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const name of names) {
    if (name === "") throw new UsageError(`--skills has an empty name in ${JSON.stringify(value)}`);
    if (SKILLS_KEYWORDS.includes(name)) throw new UsageError(`--skills ${name} cannot be combined with skill names`);
    if (!SKILL_NAME.test(name)) {
      throw new UsageError(`--skills: ${JSON.stringify(name)} is not a skill name (lower-case letters, digits and hyphens)`);
    }
    if (seen.has(name)) throw new UsageError(`--skills names ${name} more than once`);
    seen.add(name);
  }
  return [...seen].sort(byCodeUnit);
}

// ---------------------------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------------------------

/** Variables that would point git at another repository than the folder it runs in. */
const GIT_LOCATION_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

/**
 * The environment for git: the caller's, minus repository redirection; no prompts; no optional lock or index
 * writes (so `git status` writes nothing in the target); no network (no lazy fetch, only the file protocol).
 * @returns {NodeJS.ProcessEnv}
 */
function gitEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env };
  for (const name of GIT_LOCATION_VARIABLES) delete env[name];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_ALLOW_PROTOCOL = "file";
  return env;
}

/**
 * Runs git with an argument array (never a shell string).
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ ok: boolean, stdout: Buffer, stderr: string }}
 */
function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    env: gitEnv(),
    encoding: "buffer",
    maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
    if (code === "ENOENT") throw new SyncError("git was not found. Install git and make sure it is on PATH.");
    if (code === "ETIMEDOUT") {
      throw new SyncError(`git ${args[0]} did not finish within ${GIT_TIMEOUT_MS / 1000} seconds (in ${cwd}).`);
    }
    if (code === "ENOBUFS") throw new SyncError(`git ${args[0]} printed more than ${GIT_MAX_BUFFER} bytes (in ${cwd}).`);
    throw new SyncError(`could not run git ${args[0]} in ${cwd}: ${result.error.message}`);
  }
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr.toString("utf8").trim() };
}

/** @param {Buffer} stdout */
function gitText(stdout) {
  return stdout.toString("utf8").trim();
}

/**
 * @param {string} dir
 * @param {string} fullRef such as refs/heads/main
 */
function refExists(dir, fullRef) {
  return git(dir, ["show-ref", "--verify", "--quiet", fullRef]).ok;
}

/**
 * The repository's common git folder (the same for all worktrees of one repository), as a real path.
 * @param {string} dir
 */
function commonDirOf(dir) {
  const common = git(dir, ["rev-parse", "--git-common-dir"]);
  if (!common.ok) throw new SyncError(`${dir} is not a git repository (${common.stderr}).`);
  return realPath(path.resolve(dir, gitText(common.stdout)));
}

// ---------------------------------------------------------------------------------------------------------------
// The ref
// ---------------------------------------------------------------------------------------------------------------

/**
 * A conservative tag-name check, so that `refs/tags/<name>` can only mean that exact ref (no revision syntax such
 * as `~1`, `^{...}` or `@{...}`).
 * @param {string} name
 */
export function isSafeTagName(name) {
  if (name.length === 0 || name.length > 200) return false;
  if (!/^[A-Za-z0-9._+@/-]+$/.test(name)) return false;
  if (name.startsWith("-") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{") || name === "@") return false;
  return name.split("/").every((part) => part.length > 0 && !part.startsWith("."));
}

/**
 * Resolves --ref to a commit of the source repository. Only a tag or a full 40-hex commit sha is accepted: a
 * branch or a short sha can point at a different commit tomorrow.
 * @param {string} sourceDir
 * @param {string} ref
 * @returns {string} the full commit sha
 */
export function resolveRef(sourceDir, ref) {
  if (FULL_SHA.test(ref)) {
    const sha = ref.toLowerCase();
    const peeled = git(sourceDir, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
    if (peeled.ok) return gitText(peeled.stdout);
    const type = git(sourceDir, ["cat-file", "-t", sha]);
    if (type.ok) throw new SyncError(`${ref} is a ${gitText(type.stdout)} in ${sourceDir}, not a commit.`);
    throw new SyncError(`commit ${ref} was not found in ${sourceDir}. Fetch it first (git fetch), or check the sha.`);
  }
  const advice = "Use a tag (for example v0.1.0) or a full 40-character commit sha";
  if (!isSafeTagName(ref)) throw new SyncError(`"${ref}" is not a tag name or a full commit sha. ${advice}.`);
  const shown = git(sourceDir, ["show-ref", "--verify", `refs/tags/${ref}`]);
  if (!shown.ok) {
    if (refExists(sourceDir, `refs/heads/${ref}`) || refExists(sourceDir, `refs/remotes/${ref}`)) {
      throw new SyncError(`"${ref}" is a branch, and a branch moves. ${advice}.`);
    }
    if (SHORT_SHA.test(ref)) {
      throw new SyncError(
        `"${ref}" looks like a short commit sha, which can become ambiguous. ${advice} (git rev-parse ${ref} prints it).`,
      );
    }
    throw new SyncError(
      `"${ref}" is not a tag in ${sourceDir} (if it was just published, fetch it with git fetch --tags). ${advice}.`,
    );
  }
  const objectId = gitText(shown.stdout).split(" ")[0];
  const peeled = git(sourceDir, ["rev-parse", "--verify", "--quiet", `${objectId}^{commit}`]);
  if (!peeled.ok) throw new SyncError(`tag "${ref}" does not point at a commit.`);
  return gitText(peeled.stdout);
}

// ---------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------

/**
 * Why `rel` is not a safe, portable path under .claude/ in the target, or null when it is.
 * @param {string} rel posix path relative to the target's top-level folder
 * @returns {string | null}
 */
export function unsafePathReason(rel) {
  if (rel.length === 0) return "is empty";
  if (rel.length > 400) return "is longer than 400 characters";
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return "is absolute";
  if (rel.includes("\\")) return "contains a backslash";
  if (rel.includes("\uFFFD")) return "is not valid UTF-8";
  for (const char of rel) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return "contains a control character";
  }
  if (/[<>:"|?*]/.test(rel)) return "contains a character that Windows does not allow in file names";
  const parts = rel.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return 'has an empty, "." or ".." part';
    if (part.toLowerCase() === ".git") return "has a .git part";
    if (part.endsWith(".") || part.endsWith(" ")) return "has a part that ends with a dot or a space";
    if (WINDOWS_RESERVED_NAME.test(part)) return "has a part that is a reserved file name on Windows";
  }
  if (parts.length < 2 || parts[0] !== ".claude") return "is outside .claude/";
  return null;
}

/**
 * Paths that neither kit files nor seeds may use.
 * @param {string} lower the path in lower case
 * @returns {string | null}
 */
function reservedPathReason(lower) {
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (name === "claude.md" || name === "claude.local.md") return "is a CLAUDE.md file, which sync never touches";
  if (lower === STAMP_PATH.toLowerCase()) return "is the sync stamp, which only sync itself writes";
  if (lower === SETTINGS_PATH || lower === ".claude/settings.local.json") {
    return "is a settings file (sync only merges hook entries into .claude/settings.json)";
  }
  if (lower.startsWith(LOCAL_DIR)) return "is under .claude/hermod/.local/ (local session data)";
  return null;
}

/**
 * Why the kit may not own this path (as a kit file, or as an entry of a stamp), or null when it may.
 * @param {string} rel
 * @returns {string | null}
 */
export function kitFileProblem(rel) {
  const unsafe = unsafePathReason(rel);
  if (unsafe) return unsafe;
  const lower = rel.toLowerCase();
  const reserved = reservedPathReason(lower);
  if (reserved) return reserved;
  if (REPOSITORY_FILES.includes(lower) || REPOSITORY_DIRS.some((dir) => lower.startsWith(dir))) {
    return "belongs to the repository (the kit may only seed it)";
  }
  return null;
}

/**
 * Why a seed may not use this path, or null when it may.
 * @param {string} rel
 * @returns {string | null}
 */
export function seedProblem(rel) {
  return unsafePathReason(rel) ?? reservedPathReason(rel.toLowerCase());
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the kit at the commit
// ---------------------------------------------------------------------------------------------------------------

/** @typedef {{ mode: string, type: string, oid: string, path: string }} TreeEntry */

/**
 * Parses `git ls-tree -r -z` output: one "<mode> <type> <object>\t<path>" record per NUL.
 * @param {Buffer} output
 * @returns {TreeEntry[]}
 */
export function parseLsTree(output) {
  /** @type {TreeEntry[]} */
  const entries = [];
  for (const record of output.toString("utf8").split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const meta = tab === -1 ? [] : record.slice(0, tab).split(" ");
    if (meta.length !== 3) {
      throw new SyncError(`unexpected output from git ls-tree: ${JSON.stringify(record.slice(0, 200))}`);
    }
    entries.push({ mode: meta[0], type: meta[1], oid: meta[2], path: record.slice(tab + 1) });
  }
  return entries;
}

/**
 * The git object id of a blob with this content (sha1; sha256 in a sha256 repository).
 * @param {Buffer} data
 * @param {number} hexLength
 */
function gitBlobId(data, hexLength) {
  const algorithm = hexLength === 64 ? "sha256" : "sha1";
  return createHash(algorithm).update(`blob ${data.length}\0`).update(data).digest("hex");
}

/** @param {string} mode */
function describeMode(mode) {
  if (mode === "120000") return "a symbolic link";
  if (mode === "160000") return "a submodule";
  return `an entry with mode ${mode}`;
}

/**
 * Reads one blob of the commit byte for byte, and refuses if the bytes do not hash to the object id in the tree
 * (a textconv or filter would change them).
 * @param {string} sourceDir
 * @param {string} commit
 * @param {TreeEntry} entry
 * @returns {Buffer}
 */
function readBlob(sourceDir, commit, entry) {
  const shown = git(sourceDir, ["show", "--no-textconv", `${commit}:${entry.path}`]);
  if (!shown.ok) throw new SyncError(`could not read ${entry.path} at ${commit}: ${shown.stderr}`);
  if (gitBlobId(shown.stdout, entry.oid.length) !== entry.oid) {
    throw new SyncError(
      `git show returned other bytes for ${entry.path} than commit ${commit} records; check the textconv and filter settings of ${sourceDir}.`,
    );
  }
  return shown.stdout;
}

/**
 * @param {Buffer} data
 * @param {string} at the ref and commit, for messages
 */
function parseKitVersion(data, at) {
  const text = decodeUtf8(data);
  const version = text === null ? "" : stripBom(text).trim();
  if (!KIT_VERSION_PATTERN.test(version)) {
    throw new SyncError(
      `${KIT_VERSION_FILE} at ${at} must hold one version such as 0.1.0 (found ${JSON.stringify(version.slice(0, 40))}).`,
    );
  }
  return version;
}

/**
 * Parses and checks kit/settings.hooks.json: { "hooks": { "<Event>": [ { "matcher"?: string, "hooks": [ { "type":
 * "command", "command": "...", "timeout"?: number } ] } ] } }. Every command must contain OWNED_HOOK_MARKER;
 * otherwise a later sync could not find (and replace) the entries it added.
 * @param {Buffer} data
 * @param {string} at the ref and commit, for messages
 * @returns {Record<string, unknown[]>}
 */
export function parseKitHooks(data, at) {
  const fail = (/** @type {string} */ why) => new SyncError(`${KIT_HOOKS_FILE} at ${at} ${why}`);
  const text = decodeUtf8(data);
  let parsed;
  try {
    parsed = JSON.parse(stripBom(text ?? ""));
  } catch (error) {
    throw fail(`is not valid JSON${jsonErrorPlace(error)}.`);
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.hooks)) throw fail('must be an object with a "hooks" object.');
  const extra = Object.keys(parsed).filter((key) => key !== "hooks");
  if (extra.length > 0) throw fail(`may only contain "hooks" (found ${extra.map((key) => JSON.stringify(key)).join(", ")}).`);
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    const where = `hooks.${event}`;
    if (!EVENT_NAME.test(event)) throw fail(`has an invalid event name ${JSON.stringify(event)}.`);
    if (!Array.isArray(groups) || groups.length === 0) throw fail(`${where} must be a non-empty list of matcher groups.`);
    for (const group of groups) {
      if (!isPlainObject(group)) throw fail(`${where} has a matcher group that is not an object.`);
      const unknown = Object.keys(group).filter((key) => key !== "matcher" && key !== "hooks");
      if (unknown.length > 0) throw fail(`${where} has a matcher group with unknown keys (${unknown.join(", ")}).`);
      if (Object.hasOwn(group, "matcher") && typeof group.matcher !== "string") {
        throw fail(`${where} has a matcher that is not a string.`);
      }
      if (!Array.isArray(group.hooks) || group.hooks.length === 0) throw fail(`${where} has a group without hooks.`);
      for (const handler of group.hooks) {
        if (!isPlainObject(handler) || handler.type !== "command" || typeof handler.command !== "string") {
          throw fail(`${where} has a hook that is not {"type": "command", "command": "..."}.`);
        }
        if (!handler.command.includes(OWNED_HOOK_MARKER)) {
          throw fail(
            `${where} has a command without ${OWNED_HOOK_MARKER}; sync recognizes its own entries by that text, so it could not replace this one later.`,
          );
        }
        const timeout = handler.timeout;
        if (Object.hasOwn(handler, "timeout") && !(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0)) {
          throw fail(`${where} has a timeout that is not a positive number.`);
        }
      }
    }
  }
  return /** @type {Record<string, unknown[]>} */ (parsed.hooks);
}

/**
 * The skill folders among target paths: the <name> of every .claude/skills/<name>/... path, sorted.
 * @param {Iterable<string>} paths
 * @returns {string[]}
 */
function skillFolders(paths) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const rel of paths) {
    if (!rel.startsWith(SKILLS_DIR)) continue;
    const slash = rel.indexOf("/", SKILLS_DIR.length);
    if (slash !== -1) names.add(rel.slice(SKILLS_DIR.length, slash));
  }
  return [...names].sort(byCodeUnit);
}

/**
 * Parses and checks kit/skills.json: { "optional": ["<skill>", ...] }, the skills that a target gets only when it
 * chooses them with --skills. Each name must be a skill folder of kit/files/.claude/skills/ at the same commit.
 * @param {Buffer} data
 * @param {string} at the ref and commit, for messages
 * @param {string[]} folders the skill folders of kit/files/.claude/skills/ at that commit
 * @returns {string[]} the optional skills, sorted
 */
export function parseKitSkills(data, at, folders) {
  const fail = (/** @type {string} */ why) => new SyncError(`${KIT_SKILLS_FILE} at ${at} ${why}`);
  const text = decodeUtf8(data);
  let parsed;
  try {
    parsed = JSON.parse(stripBom(text ?? ""));
  } catch (error) {
    throw fail(`is not valid JSON${jsonErrorPlace(error)}.`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.optional)) {
    throw fail('must be an object with an "optional" list of skill names, such as {"optional": ["nextjs-16"]}.');
  }
  const extra = Object.keys(parsed).filter((key) => key !== "optional");
  if (extra.length > 0) throw fail(`may only contain "optional" (found ${extra.map((key) => JSON.stringify(key)).join(", ")}).`);
  /** @type {Set<string>} */
  const optional = new Set();
  for (const name of parsed.optional) {
    if (typeof name !== "string" || !SKILL_NAME.test(name)) {
      throw fail(`lists ${JSON.stringify(name)}, which is not a skill name (lower-case letters, digits and hyphens).`);
    }
    if (SKILLS_KEYWORDS.includes(name)) throw fail(`lists "${name}", which cannot be a skill name: --skills ${name} has its own meaning.`);
    if (optional.has(name)) throw fail(`lists "${name}" more than once.`);
    if (!folders.includes(name)) throw fail(`lists "${name}", but kit/files/${SKILLS_DIR}${name}/ does not exist at that commit.`);
    optional.add(name);
  }
  return [...optional].sort(byCodeUnit);
}

/**
 * Refuses kit paths that are the same file on a case-insensitive file system (Windows, macOS), or a file that is
 * also a folder of another path.
 * @param {string[]} paths
 * @param {string} at
 */
function checkPathCollisions(paths, at) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const rel of paths) {
    const other = seen.get(rel.toLowerCase());
    if (other !== undefined) {
      throw new SyncError(`the kit at ${at} has both ${other} and ${rel}, which are one file on Windows and macOS.`);
    }
    seen.set(rel.toLowerCase(), rel);
  }
  for (const rel of paths) {
    const parts = rel.toLowerCase().split("/");
    for (let count = 1; count < parts.length; count += 1) {
      const file = seen.get(parts.slice(0, count).join("/"));
      if (file !== undefined) throw new SyncError(`the kit at ${at} has a file ${file} and also ${rel} inside it.`);
    }
  }
}

/**
 * @typedef {object} Kit
 * @property {string} version kit/VERSION at the commit
 * @property {Map<string, Buffer>} files target path -> content, from kit/files
 * @property {Map<string, Buffer>} seeds target path -> content, from kit/seed
 * @property {Record<string, unknown[]>} hooks the "hooks" object of kit/settings.hooks.json
 * @property {KitSkills} skills the skill folders of kit/files/.claude/skills/
 */

/**
 * @typedef {object} KitSkills
 * @property {string[]} core always synced (every skill folder that kit/skills.json does not list), sorted
 * @property {string[]} optional synced only when chosen (kit/skills.json; none without that file), sorted
 */

/**
 * A ref and its commit, for messages.
 * @param {string} ref
 * @param {string} commit
 */
function describeRef(ref, commit) {
  return `${ref} (${commit.slice(0, 12)})`;
}

/**
 * Reads and checks the kit at a commit of the hermod repository (never the working tree).
 * @param {string} sourceDir
 * @param {string} commit
 * @param {string} ref as given, for messages
 * @returns {Kit}
 */
export function readKitAt(sourceDir, commit, ref) {
  const at = describeRef(ref, commit);
  const listed = git(sourceDir, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", "kit"]);
  if (!listed.ok) throw new SyncError(`could not list kit/ at ${at}: ${listed.stderr}`);
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  /** @type {Map<string, Buffer>} */
  const seeds = new Map();
  /** @type {Buffer | null} */
  let versionData = null;
  /** @type {Buffer | null} */
  let hooksData = null;
  /** @type {Buffer | null} */
  let skillsData = null;
  for (const entry of parseLsTree(listed.stdout)) {
    const isFile = entry.path.startsWith(KIT_FILES_DIR);
    const isSeed = entry.path.startsWith(KIT_SEED_DIR);
    const isVersion = entry.path === KIT_VERSION_FILE;
    const isHooks = entry.path === KIT_HOOKS_FILE;
    const isSkills = entry.path === KIT_SKILLS_FILE;
    if (!isFile && !isSeed && !isVersion && !isHooks && !isSkills) continue; // e.g. kit/README.md is not synced
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new SyncError(`${entry.path} at ${at} is ${describeMode(entry.mode)}; the kit may hold only regular files.`);
    }
    if (isVersion) versionData = readBlob(sourceDir, commit, entry);
    else if (isHooks) hooksData = readBlob(sourceDir, commit, entry);
    else if (isSkills) skillsData = readBlob(sourceDir, commit, entry);
    else {
      const rel = entry.path.slice(isFile ? KIT_FILES_DIR.length : KIT_SEED_DIR.length);
      const problem = isFile ? kitFileProblem(rel) : seedProblem(rel);
      if (problem) throw new SyncError(`${entry.path} at ${at} cannot be synced: ${rel} ${problem}.`);
      if (isSeed && files.has(rel)) throw new SyncError(`${rel} is in both kit/files and kit/seed at ${at}.`);
      (isFile ? files : seeds).set(rel, readBlob(sourceDir, commit, entry));
    }
  }
  if (files.size === 0) throw new SyncError(`kit/files at ${at} has no files; is ${sourceDir} the hermod repository?`);
  if (versionData === null) throw new SyncError(`${KIT_VERSION_FILE} is missing at ${at}.`);
  if (hooksData === null) throw new SyncError(`${KIT_HOOKS_FILE} is missing at ${at}.`);
  checkPathCollisions([...files.keys(), ...seeds.keys()], at);
  const version = parseKitVersion(versionData, at);
  const hooks = parseKitHooks(hooksData, at);
  const folders = skillFolders(files.keys());
  const optional = skillsData === null ? [] : parseKitSkills(skillsData, at, folders);
  const core = folders.filter((name) => !optional.includes(name));
  return { version, files, seeds, hooks, skills: { core, optional } };
}

// ---------------------------------------------------------------------------------------------------------------
// The target
// ---------------------------------------------------------------------------------------------------------------

/**
 * What is at a target path:
 * - missing: nothing (sync may create it);
 * - file: a regular file, with its bytes;
 * - other: something that is not a regular file (a folder, a symbolic link);
 * - blocked: a folder on the way is a symbolic link or a file, so sync may not write below it.
 * @typedef {{ kind: "missing" } | { kind: "file", data: Buffer } | { kind: "other", reason: string }
 *   | { kind: "blocked", reason: string }} TargetState
 */

/**
 * Looks at a target path without following symbolic links: sync never writes through a link (it could lead
 * outside .claude/).
 * @param {string} root
 * @param {string} rel posix path under .claude/
 * @returns {TargetState}
 */
export function inspectTarget(root, rel) {
  const parts = rel.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const shown = parts.slice(0, index + 1).join("/");
    const last = index === parts.length - 1;
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return { kind: "missing" };
      throw new SyncError(`could not look at ${shown} in the target: ${messageOf(error)}`);
    }
    if (stat.isSymbolicLink()) {
      return last
        ? { kind: "other", reason: "is a symbolic link (sync never writes through links)" }
        : { kind: "blocked", reason: `is inside ${shown}, which is a symbolic link (sync never writes through links)` };
    }
    if (last) {
      if (stat.isFile()) return { kind: "file", data: readFileSync(current) };
      return { kind: "other", reason: stat.isDirectory() ? "is a folder, not a file" : "is not a regular file" };
    }
    if (!stat.isDirectory()) return { kind: "blocked", reason: `is inside ${shown}, which is a file, not a folder` };
  }
  return { kind: "missing" };
}

/**
 * Checks the target folder: the top-level folder of a git working tree, and not the hermod repository itself.
 * @param {string} targetOption
 * @param {string} sourceCommonDir
 * @returns {string} the absolute target folder
 */
function resolveTarget(targetOption, sourceCommonDir) {
  const root = path.resolve(targetOption);
  if (!isDirectory(root)) throw new SyncError(`the target ${root} does not exist or is not a folder.`);
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || gitText(inside.stdout) !== "true") {
    throw new SyncError(
      `the target ${root} is not a git repository with a working tree. Sync writes only into git repositories, so that every change can be reviewed and undone.`,
    );
  }
  const prefix = git(root, ["rev-parse", "--show-prefix"]);
  if (!prefix.ok || gitText(prefix.stdout) !== "") {
    throw new SyncError(
      `the target ${root} is inside a git repository but is not its top-level folder; pass the top-level folder (git -C "${root}" rev-parse --show-toplevel prints it).`,
    );
  }
  if (samePath(commonDirOf(root), sourceCommonDir)) {
    throw new SyncError(
      `the target ${root} is the hermod repository itself; hermod runs its kit straight from kit/files and is never a sync target.`,
    );
  }
  return root;
}

/**
 * The paths of `git status --porcelain=v1 -z` output ("XY path\0", and after a rename or copy the old path).
 * @param {Buffer} output
 * @returns {string[]}
 */
export function parsePorcelainPaths(output) {
  const fields = output.toString("utf8").split("\0");
  /** @type {string[]} */
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) continue;
    paths.push(field.slice(3));
    if (/[RC]/.test(field.slice(0, 2)) && index + 1 < fields.length) {
      index += 1;
      paths.push(fields[index]);
    }
  }
  return paths.filter((rel) => rel !== "");
}

/**
 * Paths under .claude/ with uncommitted changes (staged, unstaged or untracked), except the hooks' local data.
 * @param {string} root
 * @returns {string[]}
 */
function uncommittedClaudePaths(root) {
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".claude"]);
  if (!status.ok) throw new SyncError(`git status failed in the target: ${status.stderr}`);
  return parsePorcelainPaths(status.stdout).filter((rel) => !rel.startsWith(LOCAL_DIR));
}

/**
 * @typedef {object} Stamp
 * @property {string} kit
 * @property {string} ref
 * @property {string} commit
 * @property {string} syncedAt
 * @property {string[] | null} skills the optional skills chosen, sorted (null: a stamp from before optional skills)
 * @property {Map<string, string>} files target path -> sha256 of what sync wrote
 */

/**
 * Parses and checks a stamp. Every listed path must be one the kit may own, so that a damaged or hostile stamp
 * can never make sync overwrite or delete anything else.
 * @param {Buffer} data
 * @returns {Stamp}
 */
export function parseStamp(data) {
  const fix = `Restore it from git (git checkout -- ${STAMP_PATH}) and run sync again.`;
  const text = decodeUtf8(data);
  /** @type {unknown} */
  let parsed;
  try {
    parsed = text === null ? undefined : JSON.parse(stripBom(text));
  } catch {
    parsed = undefined;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.files)) {
    throw new SyncError(`${STAMP_PATH} in the target is not a valid sync stamp (a JSON object with a "files" object). ${fix}`);
  }
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const [rel, hash] of Object.entries(parsed.files)) {
    if (typeof hash !== "string" || !SHA256_HEX.test(hash)) {
      throw new SyncError(`${STAMP_PATH} in the target has an invalid sha256 for ${JSON.stringify(rel)}. ${fix}`);
    }
    const problem = kitFileProblem(rel);
    if (problem) {
      throw new SyncError(
        `${STAMP_PATH} in the target lists ${JSON.stringify(rel)}, which ${problem}; sync never writes or deletes such a file. ${fix}`,
      );
    }
    files.set(rel, hash);
  }
  /** @type {string[] | null} */
  let skills = null;
  if (Object.hasOwn(parsed, "skills")) {
    const list = parsed.skills;
    if (!Array.isArray(list) || !list.every((name) => typeof name === "string" && SKILL_NAME.test(name))) {
      throw new SyncError(`${STAMP_PATH} in the target has a "skills" entry that is not a list of skill names. ${fix}`);
    }
    skills = [...new Set(/** @type {string[]} */ (list))].sort(byCodeUnit);
  }
  const record = parsed;
  const field = (/** @type {string} */ name) => (typeof record[name] === "string" ? String(record[name]) : "");
  return { kit: field("kit"), ref: field("ref"), commit: field("commit"), syncedAt: field("syncedAt"), skills, files };
}

// ---------------------------------------------------------------------------------------------------------------
// Choosing the optional skills
// ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} SkillSelection
 * @property {string[]} core the kit's core skills (always synced)
 * @property {string[]} chosen the optional skills that are synced, sorted
 * @property {string[]} notChosen the optional skills that are left out, sorted
 * @property {"option" | "stamp" | "default"} from where the choice comes from: --skills, the previous stamp, or
 *   the default of a first install (none)
 */

/**
 * Decides which optional skills are synced. With --skills: the names it gives (or all, or none); a name that is
 * not an optional skill of the kit is refused. Without it: the last sync's choice, which is the stamp's "skills"
 * plus every optional skill that the stamp lists files of, so that a re-sync never drops a skill that was
 * installed (one that was a core skill then, or from a stamp written before "skills" existed). On a first
 * install: none.
 * @param {KitSkills} kitSkills
 * @param {SkillsChoice | undefined} requested
 * @param {Stamp | null} previous
 * @param {string} at the ref and commit, for messages
 * @returns {SkillSelection}
 */
export function chooseSkills(kitSkills, requested, previous, at) {
  const { core, optional } = kitSkills;
  /** @type {Set<string>} */
  let chosen;
  /** @type {SkillSelection["from"]} */
  let from = "option";
  if (requested === "all") chosen = new Set(optional);
  else if (requested === "none") chosen = new Set();
  else if (requested !== undefined) {
    const wrong = requested.filter((name) => !optional.includes(name));
    if (wrong.length > 0) throw new SyncError(notOptionalMessage(wrong, kitSkills, at));
    chosen = new Set(requested);
  } else if (previous === null) {
    chosen = new Set();
    from = "default";
  } else {
    chosen = new Set([...(previous.skills ?? []), ...skillFolders(previous.files.keys())]);
    from = "stamp";
  }
  return {
    core,
    chosen: optional.filter((name) => chosen.has(name)),
    notChosen: optional.filter((name) => !chosen.has(name)),
    from,
  };
}

/**
 * Why these --skills names cannot be chosen, and which optional skills can.
 * @param {string[]} wrong names that are not optional skills of the kit
 * @param {KitSkills} kitSkills
 * @param {string} at the ref and commit
 */
function notOptionalMessage(wrong, kitSkills, at) {
  const names = wrong.map((name) => JSON.stringify(name)).join(", ");
  const verb = wrong.length === 1 ? "is not an optional skill" : "are not optional skills";
  const core = wrong.filter((name) => kitSkills.core.includes(name));
  const coreNote = core.length === 0 ? "" : `; ${core.join(", ")} ${core.length === 1 ? "is a core skill" : "are core skills"}, always synced`;
  const available = kitSkills.optional.length > 0 ? kitSkills.optional.join(", ") : "none";
  return `--skills: ${names} ${verb} of the kit at ${at}${coreNote}. Optional skills: ${available}.`;
}

/**
 * The kit files without the files of the optional skills that are not chosen.
 * @param {Map<string, Buffer>} files
 * @param {string[]} skipped skill names
 * @returns {Map<string, Buffer>}
 */
function withoutSkills(files, skipped) {
  if (skipped.length === 0) return files;
  const prefixes = skipped.map((name) => `${SKILLS_DIR}${name}/`);
  return new Map([...files].filter(([rel]) => !prefixes.some((prefix) => rel.startsWith(prefix))));
}

// ---------------------------------------------------------------------------------------------------------------
// Planning (writes nothing)
// ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} FilePlan
 * @property {string[]} add kit files to create
 * @property {string[]} update kit files to overwrite
 * @property {string[]} forced the part of `update` that overwrites local changes (--force)
 * @property {string[]} delete files of the previous sync that the kit no longer has (unchanged, so safe to delete)
 * @property {string[]} unchanged kit files that already have the kit's content
 * @property {string[]} seed seed files to create
 * @property {{ path: string, reason: string }[]} conflict reasons to refuse; nothing is written when there are any
 * @property {{ path: string, reason: string }[]} kept files of the previous sync left in place and no longer tracked
 * @property {Map<string, string>} manifest the new stamp's files: target path -> sha256
 */

const REASON_REPOSITORY_FILE =
  "already exists and was not written by a previous sync, so it belongs to the repository: rename or move it, then run sync again";
const REASON_CHANGED_LOCALLY =
  "was changed in this repository since the last sync: move the change into hermod, or run again with --force to overwrite it";

/**
 * Decides what happens to each kit file, each file of the previous stamp and each seed. Reads the target only
 * through `inspect`, and writes nothing.
 * @param {object} input
 * @param {Map<string, Buffer>} input.files the kit files
 * @param {Map<string, Buffer>} input.seeds the seed files
 * @param {Map<string, string> | null} input.previous the previous stamp's files (null on a first install)
 * @param {(rel: string) => TargetState} input.inspect
 * @param {boolean} input.force
 * @param {string[]} [input.notChosen] optional skills this sync leaves out (their files are not in `files`)
 * @returns {FilePlan}
 */
export function planFiles({ files, seeds, previous, inspect, force, notChosen = [] }) {
  /** @type {FilePlan} */
  const plan = {
    add: [],
    update: [],
    forced: [],
    delete: [],
    unchanged: [],
    seed: [],
    conflict: [],
    kept: [],
    manifest: new Map(),
  };
  const before = previous ?? new Map();
  for (const rel of [...files.keys()].sort(byCodeUnit)) {
    const hash = sha256(/** @type {Buffer} */ (files.get(rel)));
    const state = inspect(rel);
    if (state.kind === "other" || state.kind === "blocked") {
      plan.conflict.push({ path: rel, reason: state.reason });
      continue;
    }
    plan.manifest.set(rel, hash);
    const previousHash = before.get(rel);
    if (state.kind === "missing") plan.add.push(rel);
    else if (sameContent(state.data, hash)) plan.unchanged.push(rel);
    else if (previousHash === undefined) plan.conflict.push({ path: rel, reason: REASON_REPOSITORY_FILE });
    else if (sameContent(state.data, previousHash)) plan.update.push(rel);
    else if (force) {
      plan.update.push(rel);
      plan.forced.push(rel);
    } else plan.conflict.push({ path: rel, reason: REASON_CHANGED_LOCALLY });
  }
  /** @param {string} rel */
  const droppedSkill = (rel) => notChosen.find((name) => rel.startsWith(`${SKILLS_DIR}${name}/`));
  for (const [rel, previousHash] of [...before.entries()].sort(([a], [b]) => byCodeUnit(a, b))) {
    if (files.has(rel)) continue;
    const state = inspect(rel);
    if (state.kind === "missing") continue;
    const skill = droppedSkill(rel);
    const gone = skill ? `belongs to the optional skill ${skill}, which this sync does not install (--skills)` : "is no longer in the kit";
    if (seeds.has(rel)) plan.kept.push({ path: rel, reason: "is a seed from this kit version on, so the repository owns it now" });
    else if (state.kind !== "file") {
      plan.kept.push({ path: rel, reason: `${gone}; it was left in place because it ${state.reason}` });
    } else if (sameContent(state.data, previousHash)) plan.delete.push(rel);
    else {
      plan.kept.push({
        path: rel,
        reason: `${gone} but was changed in this repository, so it was left in place (and is no longer tracked)`,
      });
    }
  }
  for (const rel of [...seeds.keys()].sort(byCodeUnit)) {
    const state = inspect(rel);
    if (state.kind === "missing") plan.seed.push(rel);
    else if (state.kind === "blocked") plan.conflict.push({ path: rel, reason: state.reason });
  }
  return plan;
}

/**
 * True for a hook handler that the kit owns: its command contains OWNED_HOOK_MARKER.
 * @param {unknown} handler
 */
function isOwnedHandler(handler) {
  return isPlainObject(handler) && typeof handler.command === "string" && handler.command.includes(OWNED_HOOK_MARKER);
}

/**
 * Merges the kit's hook entries into parsed settings.json content and returns the new content (the input is not
 * changed). In every hooks.<Event> list, handlers whose command contains OWNED_HOOK_MARKER are removed; matcher
 * groups (and event lists) that became empty by that are dropped; then the kit's groups are appended to their
 * events. Every other key, event, group, handler and order is kept exactly.
 * @param {unknown} settings parsed .claude/settings.json
 * @param {Record<string, unknown[]>} kitHooks the "hooks" object of kit/settings.hooks.json
 * @returns {Record<string, unknown>}
 */
export function mergeHookSettings(settings, kitHooks) {
  if (!isPlainObject(settings)) throw new SyncError(`${SETTINGS_PATH} must hold a JSON object ({ ... }); sync will not change it.`);
  const hadHooks = Object.hasOwn(settings, "hooks");
  const oldHooks = hadHooks ? settings.hooks : {};
  if (!isPlainObject(oldHooks)) throw new SyncError(`"hooks" in ${SETTINGS_PATH} must be an object; sync will not change it.`);
  /** @type {Record<string, unknown>} */
  const hooks = {};
  /** @type {Set<string>} */
  const emptied = new Set();
  for (const event of Object.keys(oldHooks)) {
    const groups = oldHooks[event];
    if (!Array.isArray(groups)) {
      setOwn(hooks, event, groups);
      continue;
    }
    /** @type {unknown[]} */
    const kept = [];
    let removed = false;
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const handlers = group.hooks.filter((handler) => !isOwnedHandler(handler));
      if (handlers.length === group.hooks.length) {
        kept.push(group);
        continue;
      }
      removed = true;
      if (handlers.length === 0) continue;
      const copy = copyObject(group);
      setOwn(copy, "hooks", handlers);
      kept.push(copy);
    }
    if (removed && kept.length === 0) emptied.add(event);
    setOwn(hooks, event, kept);
  }
  for (const event of Object.keys(kitHooks)) {
    const current = Object.hasOwn(hooks, event) ? hooks[event] : [];
    if (!Array.isArray(current)) throw new SyncError(`"hooks.${event}" in ${SETTINGS_PATH} must be a list; sync will not change it.`);
    setOwn(hooks, event, [...current, ...JSON.parse(JSON.stringify(kitHooks[event]))]);
    emptied.delete(event);
  }
  for (const event of emptied) delete hooks[event];
  const merged = copyObject(settings);
  if (Object.keys(hooks).length > 0 || (hadHooks && Object.keys(oldHooks).length === 0)) setOwn(merged, "hooks", hooks);
  else delete merged.hooks;
  return merged;
}

/**
 * Parses .claude/settings.json; refuses (never repairs) a file that is not valid UTF-8 JSON.
 * @param {Buffer} data
 * @returns {unknown}
 */
export function parseSettings(data) {
  const fix = "Fix it by hand, then run sync again; sync never rewrites a file it cannot read.";
  const text = decodeUtf8(data);
  if (text === null) throw new SyncError(`${SETTINGS_PATH} in the target is not valid UTF-8 text. ${fix}`);
  try {
    return JSON.parse(stripBom(text));
  } catch (error) {
    throw new SyncError(`${SETTINGS_PATH} in the target is not valid JSON${jsonErrorPlace(error)}. ${fix}`);
  }
}

/** @typedef {{ action: "create" | "update" | "unchanged", text: string }} WritePlan */

/**
 * The new .claude/settings.json: written only when its content changes (formatting alone is not a change).
 * @param {(rel: string) => TargetState} inspect
 * @param {Record<string, unknown[]>} kitHooks
 * @returns {WritePlan}
 */
function planSettings(inspect, kitHooks) {
  const state = inspect(SETTINGS_PATH);
  if (state.kind === "other" || state.kind === "blocked") {
    throw new SyncError(`${SETTINGS_PATH} in the target ${state.reason}; sync will not write it.`);
  }
  const current = state.kind === "file" ? parseSettings(state.data) : {};
  const merged = mergeHookSettings(current, kitHooks);
  const changed = JSON.stringify(merged) !== JSON.stringify(current);
  /** @type {WritePlan["action"]} */
  const action = !changed ? "unchanged" : state.kind === "file" ? "update" : "create";
  return { action, text: `${JSON.stringify(merged, null, 2)}\n` };
}

/**
 * @param {Map<string, string>} a
 * @param {Map<string, string>} b
 */
function sameEntries(a, b) {
  return a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
}

/**
 * @param {string[]} a
 * @param {string[]} b
 */
function sameList(a, b) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * The new stamp. It is written when its content changes, and also when anything else is written (so that
 * syncedAt says when the target last changed); never on a run that changes nothing.
 * @param {Stamp | null} previous
 * @param {{ kit: string, ref: string, commit: string, skills: string[], files: Map<string, string> }} next
 * @param {boolean} anythingElse whether other files are written
 * @param {Date} now
 * @returns {WritePlan}
 */
function planStamp(previous, next, anythingElse, now) {
  const files = Object.fromEntries([...next.files].sort(([a], [b]) => byCodeUnit(a, b)));
  const stamp = { kit: next.kit, ref: next.ref, commit: next.commit, syncedAt: now.toISOString(), skills: next.skills, files };
  const text = `${JSON.stringify(stamp, null, 2)}\n`;
  if (previous === null) return { action: "create", text };
  const same =
    previous.kit === next.kit &&
    previous.ref === next.ref &&
    previous.commit === next.commit &&
    previous.skills !== null &&
    sameList(previous.skills, next.skills) &&
    sameEntries(previous.files, next.files);
  return { action: same && !anythingElse ? "unchanged" : "update", text };
}

/**
 * Compares the x.y.z part of two versions: negative when a is older than b, 0 when equal or not comparable.
 * @param {string} a
 * @param {string} b
 */
function compareVersions(a, b) {
  const pattern = /^(\d+)\.(\d+)\.(\d+)/;
  const left = pattern.exec(a);
  const right = pattern.exec(b);
  if (!left || !right) return 0;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Applying the plan
// ---------------------------------------------------------------------------------------------------------------

/**
 * Writes a file through a temporary file and a rename, so it is never left half written.
 * @param {string} file
 * @param {Uint8Array} data
 * @param {boolean} [exclusive] never replace an existing file (for seeds)
 * @returns {boolean} whether the file was written
 */
function writeFileSafely(file, data, exclusive = false) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString("hex")}.hermod-sync.tmp`;
  try {
    writeFileSync(temp, data, { flag: "wx" });
    if (exclusive && existsSync(file)) {
      unlinkSync(temp);
      return false;
    }
    renameSync(temp, file);
    return true;
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // the temporary file was not created, or is already gone
    }
    throw error;
  }
}

/**
 * Deletes a file of the previous sync, then the folders that it leaves empty (never .claude/ itself).
 * @param {string} root
 * @param {string} rel
 */
function removeFile(root, rel) {
  unlinkSync(toAbsolute(root, rel));
  const parts = rel.split("/");
  for (let count = parts.length - 1; count > 1; count -= 1) {
    try {
      rmdirSync(toAbsolute(root, parts.slice(0, count).join("/")));
    } catch {
      return; // not empty (or already gone): stop here
    }
  }
}

/**
 * Writes the plan: kit files, seeds, deletions, settings, and the stamp last, so that an interrupted run can just
 * be run again (files that already have the kit's content count as unchanged).
 * @param {string} root
 * @param {Kit} kit
 * @param {FilePlan} files
 * @param {WritePlan} settings
 * @param {WritePlan} stamp
 */
function applyPlan(root, kit, files, settings, stamp) {
  let done = 0;
  try {
    for (const rel of [...files.add, ...files.update]) {
      writeFileSafely(toAbsolute(root, rel), /** @type {Buffer} */ (kit.files.get(rel)));
      done += 1;
    }
    for (const rel of files.seed) {
      if (writeFileSafely(toAbsolute(root, rel), /** @type {Buffer} */ (kit.seeds.get(rel)), true)) done += 1;
    }
    for (const rel of files.delete) {
      removeFile(root, rel);
      done += 1;
    }
    if (settings.action !== "unchanged") {
      writeFileSafely(toAbsolute(root, SETTINGS_PATH), Buffer.from(settings.text, "utf8"));
      done += 1;
    }
    if (stamp.action !== "unchanged") writeFileSafely(toAbsolute(root, STAMP_PATH), Buffer.from(stamp.text, "utf8"));
  } catch (error) {
    throw new SyncError(
      `writing to the target failed after ${plural(done, "change")}: ${messageOf(error)}. Fix the cause and run sync again (it continues where it stopped); git -C "${root}" status shows what changed.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} PlanSummary
 * @property {string[]} add
 * @property {string[]} update
 * @property {string[]} forced
 * @property {string[]} delete
 * @property {string[]} unchanged
 * @property {string[]} seed
 * @property {{ path: string, reason: string }[]} conflict
 * @property {{ path: string, reason: string }[]} kept
 * @property {"create" | "update" | "unchanged"} settings
 * @property {"create" | "update" | "unchanged"} stamp
 */

/**
 * @typedef {object} SyncResult
 * @property {boolean} ok false on conflicts
 * @property {boolean} applied whether this run wrote anything
 * @property {boolean} dryRun
 * @property {string} source
 * @property {string} target
 * @property {string} ref as given
 * @property {string} commit
 * @property {string} kit the kit version
 * @property {{ kit: string, ref: string, commit: string, syncedAt: string } | null} previous the previous stamp
 * @property {SkillSelection} skills which skills are synced
 * @property {PlanSummary} plan
 * @property {string[]} warnings
 * @property {string} [error]
 */

/**
 * @param {string | undefined} sourceOption
 * @returns {{ dir: string, commonDir: string }}
 */
function resolveSource(sourceOption) {
  const dir = path.resolve(sourceOption ?? path.join(path.dirname(SCRIPT_PATH), ".."));
  if (!isDirectory(dir)) throw new SyncError(`the hermod repository ${dir} does not exist or is not a folder (--source).`);
  const common = git(dir, ["rev-parse", "--git-common-dir"]);
  if (!common.ok) {
    throw new SyncError(
      `${dir} is not a git repository, so the kit cannot be read at a pinned ref. Pass --source <a hermod checkout>.`,
    );
  }
  return { dir, commonDir: realPath(path.resolve(dir, gitText(common.stdout))) };
}

/**
 * Checks everything, plans, and applies the plan unless it is a dry run or has conflicts. Throws SyncError when it
 * refuses before planning (a floating ref, an unusable target, uncommitted changes, unreadable settings).
 * @param {Options} options
 * @param {Date} [now]
 * @returns {SyncResult}
 */
export function runSync(options, now = new Date()) {
  const source = resolveSource(options.source);
  const commit = resolveRef(source.dir, options.ref);
  const target = resolveTarget(options.target, source.commonDir);
  if (!options.allowDirty) {
    const dirty = uncommittedClaudePaths(target);
    if (dirty.length > 0) {
      throw new SyncError(
        `the target has uncommitted changes under .claude/ (${listSome(dirty)}). Commit or stash them first, so that the sync's changes can be reviewed on their own, or run again with --allow-dirty.`,
      );
    }
  }
  const kit = readKitAt(source.dir, commit, options.ref);
  const inspect = (/** @type {string} */ rel) => inspectTarget(target, rel);
  const stampState = inspect(STAMP_PATH);
  if (stampState.kind === "other" || stampState.kind === "blocked") {
    throw new SyncError(`${STAMP_PATH} in the target ${stampState.reason}.`);
  }
  const previous = stampState.kind === "file" ? parseStamp(stampState.data) : null;
  const skills = chooseSkills(kit.skills, options.skills, previous, describeRef(options.ref, commit));
  const files = planFiles({
    files: withoutSkills(kit.files, skills.notChosen),
    seeds: kit.seeds,
    previous: previous?.files ?? null,
    inspect,
    force: options.force,
    notChosen: skills.notChosen,
  });
  const settings = planSettings(inspect, kit.hooks);
  const writesFiles = files.add.length + files.update.length + files.delete.length + files.seed.length > 0;
  const anythingElse = writesFiles || settings.action !== "unchanged";
  const stamp = planStamp(
    previous,
    { kit: kit.version, ref: options.ref, commit, skills: skills.chosen, files: files.manifest },
    anythingElse,
    now,
  );
  /** @type {string[]} */
  const warnings = [];
  if (previous && compareVersions(kit.version, previous.kit) < 0) {
    warnings.push(`kit ${kit.version} is older than the installed kit ${previous.kit}.`);
  }
  if (git(target, ["check-ignore", "-q", "--", STAMP_PATH]).ok) {
    warnings.push(`git ignores ${STAMP_PATH} in the target, so the synced files cannot be committed; check its .gitignore.`);
  }
  /** @type {SyncResult} */
  const result = {
    ok: true,
    applied: false,
    dryRun: options.dryRun,
    source: source.dir,
    target,
    ref: options.ref,
    commit,
    kit: kit.version,
    previous: previous && { kit: previous.kit, ref: previous.ref, commit: previous.commit, syncedAt: previous.syncedAt },
    skills,
    plan: {
      add: files.add,
      update: files.update,
      forced: files.forced,
      delete: files.delete,
      unchanged: files.unchanged,
      seed: files.seed,
      conflict: files.conflict,
      kept: files.kept,
      settings: settings.action,
      stamp: stamp.action,
    },
    warnings,
  };
  if (files.conflict.length > 0) {
    return { ...result, ok: false, error: `${plural(files.conflict.length, "conflict")}; nothing was written.` };
  }
  if (options.dryRun) return result;
  applyPlan(target, kit, files, settings, stamp);
  return { ...result, applied: anythingElse || stamp.action !== "unchanged" };
}

/** @param {"create" | "update" | "unchanged"} action */
function describeAction(action) {
  return action === "create" ? "create" : action === "update" ? "update" : "unchanged";
}

/** Where the choice of optional skills came from, for people. */
const SKILLS_FROM = {
  option: "from --skills",
  stamp: "as in the last sync",
  default: "the default on a first install",
};

/**
 * The skills lines of the human output.
 * @param {SkillSelection} skills
 * @returns {string[]}
 */
function formatSkills(skills) {
  const names = (/** @type {string[]} */ list) => (list.length > 0 ? list.join(", ") : "none");
  const lines = [`  skills  core: ${names(skills.core)}`];
  if (skills.chosen.length + skills.notChosen.length === 0) lines.push("          optional: none");
  else {
    lines.push(`          optional, chosen: ${names(skills.chosen)} (${SKILLS_FROM[skills.from]})`);
    lines.push(`          optional, not chosen: ${names(skills.notChosen)}`);
  }
  return lines;
}

/**
 * The plan and the outcome, for people.
 * @param {SyncResult} result
 * @returns {string}
 */
export function formatResult(result) {
  const { plan, previous } = result;
  /** @type {string[]} */
  const lines = [`Hermod sync: kit ${result.kit} at ${result.ref} (${result.commit.slice(0, 12)})`];
  lines.push(`  source  ${result.source}`, `  target  ${result.target}`);
  lines.push(
    previous
      ? `  before  kit ${previous.kit || "?"} at ${previous.ref || "?"} (${previous.commit.slice(0, 12) || "?"})`
      : "  before  no stamp (first install)",
  );
  lines.push(...formatSkills(result.skills));
  lines.push("");
  const row = (/** @type {string} */ label, /** @type {string} */ text) => lines.push(`  ${label.padEnd(10)} ${text}`);
  for (const rel of plan.add) row("add", rel);
  for (const rel of plan.update) row("update", plan.forced.includes(rel) ? `${rel} (local changes overwritten: --force)` : rel);
  for (const rel of plan.delete) row("delete", rel);
  for (const item of plan.conflict) row("conflict", `${item.path} ${item.reason}`);
  for (const item of plan.kept) row("keep", `${item.path} ${item.reason}`);
  for (const rel of plan.seed) row("seed", rel);
  row("unchanged", plural(plan.unchanged.length, "file"));
  row("settings", `${SETTINGS_PATH}: ${describeAction(plan.settings)}`);
  row("stamp", `${STAMP_PATH}: ${describeAction(plan.stamp)}`);
  for (const warning of result.warnings) lines.push(`  note: ${warning}`);
  lines.push("");
  if (!result.ok) {
    lines.push(`${plural(plan.conflict.length, "conflict")}: nothing was written. Resolve them and run sync again.`);
  } else if (result.dryRun) {
    lines.push("Dry run: nothing was written.");
  } else if (!result.applied) {
    lines.push(`Nothing to do: the target already has kit ${result.kit} at ${result.ref}.`);
  } else {
    const counts = [
      `${plan.add.length} added`,
      `${plan.update.length} updated`,
      `${plan.delete.length} deleted`,
      `${plan.seed.length} seeded`,
      `settings ${describeAction(plan.settings)}`,
    ].join(", ");
    lines.push(`Done: ${counts}. Review the changes (git -C "${result.target}" status) and commit them in a pull request.`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Runs the command line and returns the exit code: 0 done or nothing to do, 1 refused or conflicts (nothing
 * written), 2 invalid arguments.
 * @param {string[]} argv the arguments after the script path
 * @returns {number}
 */
export function main(argv) {
  const json = argv.includes("--json");
  /** @param {string} message */
  const refuse = (message) => {
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, applied: false, error: message, plan: null }, null, 2)}\n`);
    else process.stderr.write(`hermod sync: ${message}\n`);
  };
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    refuse(`${messageOf(error)}. Run with --help for usage.`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    const result = runSync(options);
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatResult(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    refuse(error instanceof SyncError ? error.message : `unexpected error: ${error instanceof Error ? error.stack : String(error)}`);
    return 1;
  }
}

/** True when this file is the program node was started with (not when it is imported, e.g. by tests). */
function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const started = realpathSync(entry);
    const self = realpathSync(SCRIPT_PATH);
    return process.platform === "win32" ? started.toLowerCase() === self.toLowerCase() : started === self;
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = main(process.argv.slice(2));
