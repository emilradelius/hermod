#!/usr/bin/env node
// @ts-check
/**
 * Copies a pinned build of the Hermod runtime into an app, for example life's `vendor/hermod/`.
 *
 *   node scripts/vendor-runtime.mjs --target ../life/vendor/hermod --ref <tag | full commit sha> [--dry-run]
 *
 * Pinned and reviewable, like scripts/sync.mjs:
 * - the ref must be a tag or a full 40-character commit sha (branch names and short shas move);
 * - this checkout must be clean and its HEAD must be exactly that commit, so the build is that commit's code (no
 *   untracked or ignored file under src/ either, since the build compiles everything there);
 * - the target gets dist/, LICENSE, a README and VERSION.json (version, commit, a sha256 per file). Files the previous
 *   stamp listed and the new build no longer has are removed; nothing else in the target is touched.
 * The app commits the result in a pull request a person reviews. The vendored code imports `@anthropic-ai/sdk` and
 * `zod`, which the app must already depend on (it resolves them from its own node_modules).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const USAGE = `Usage: node scripts/vendor-runtime.mjs --target <dir> --ref <tag | full commit sha> [--dry-run]

Builds the Hermod runtime at the given commit (this checkout must be clean and at that commit) and copies dist/,
LICENSE, a README and VERSION.json into <dir>. Exit 1 on any refusal; nothing is written on a refusal.`;

/** @param {string[]} args @param {{cwd?: string}} [options] */
function git(args, options = {}) {
  const r = spawnSync("git", args, { cwd: options.cwd ?? REPO, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** @param {string} message */
function fail(message) {
  process.stderr.write(`vendor-runtime: ${message}\n`);
  process.exit(1);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{target?: string, ref?: string, dryRun: boolean}} */
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--target") out.target = argv[++i];
    else if (a === "--ref") out.ref = argv[++i];
    else fail(`unknown option "${a}".\n${USAGE}`);
  }
  if (!out.target) fail(`--target is required.\n${USAGE}`);
  if (!out.ref) fail(`--ref is required.\n${USAGE}`);
  return /** @type {{target: string, ref: string, dryRun: boolean}} */ (out);
}

/** A tag or a full sha, resolved to a commit; anything that can move is refused. @param {string} ref */
function resolvePinnedRef(ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const r = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (!r.ok) fail(`commit ${ref} does not exist in this checkout.`);
    return r.out;
  }
  const tag = git(["show-ref", "--verify", "--quiet", `refs/tags/${ref}`]);
  if (!tag.ok) fail(`"${ref}" is neither a tag nor a full 40-character commit sha. Branch names and short shas move.`);
  return git(["rev-parse", `refs/tags/${ref}^{commit}`]).out;
}

/** @param {string} dir @param {string} [base] @returns {string[]} */
function listFiles(dir, base = dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/** @param {Buffer | string} data */
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function main() {
  const { target, ref, dryRun } = parseArgs(process.argv.slice(2));
  const commit = resolvePinnedRef(ref);
  const headSha = git(["rev-parse", "HEAD"]).out;
  if (headSha !== commit) fail(`this checkout is at ${headSha}, not at ${ref} (${commit}). Check that commit out first.`);
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).out;
  if (dirty) fail("this checkout has uncommitted changes to tracked files, so the build would not be that commit's code.");
  // skip-worktree / assume-unchanged entries hide local edits from git status, so refuse them too.
  const hidden = git(["ls-files", "-v"]).out.split("\n").filter((line) => /^[a-zS]/.test(line) && !line.startsWith("H "));
  if (hidden.length) fail(`${hidden.length} tracked file(s) are marked skip-worktree or assume-unchanged; clear them first.`);
  // npm run build compiles everything under src/ (tsconfig.build.json), tracked or not: an untracked or git-ignored
  // file there would end up in a build stamped as exactly this commit.
  const stray = git(["status", "--porcelain", "--untracked-files=all", "--ignored", "--", "src", "tsconfig.json", "tsconfig.build.json"]).out;
  if (stray) {
    const paths = stray.split("\n").map((line) => line.slice(3)).slice(0, 5).join(", ");
    fail(`untracked or ignored files under src/ would be compiled into the build (${paths}); remove them first.`);
  }

  const targetDir = path.resolve(target);
  if (targetDir === REPO || targetDir.startsWith(REPO + path.sep)) fail("the target must be outside the hermod checkout.");
  const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));

  const build = spawnSync("npm", ["run", "build"], { cwd: REPO, encoding: "utf8", shell: process.platform === "win32" });
  if (build.status !== 0) fail(`the build failed:\n${build.stdout ?? ""}${build.stderr ?? ""}`);
  const distDir = path.join(REPO, "dist");
  const distFiles = listFiles(distDir).filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"));

  /** @type {Record<string, Buffer>} */
  const files = {};
  for (const f of distFiles) files[`dist/${f}`] = readFileSync(path.join(distDir, f));
  files["LICENSE"] = readFileSync(path.join(REPO, "LICENSE"));
  files["README.md"] = Buffer.from(
    `# Hermod runtime (vendored)\n\nA pinned build of https://github.com/emilradelius/hermod at commit ${commit}` +
      ` (version ${pkg.version}). Do not edit these files: update them from a hermod checkout with\n\n` +
      "```bash\nnode scripts/vendor-runtime.mjs --target <this folder> --ref <tag or full commit sha>\n```\n\n" +
      "and review the diff in a pull request. VERSION.json lists every file with its sha256.\n",
  );

  const stampPath = path.join(targetDir, "VERSION.json");
  const previous = existsSync(stampPath) ? JSON.parse(readFileSync(stampPath, "utf8")) : null;
  const removed = previous ? Object.keys(previous.files ?? {}).filter((f) => !(f in files)) : [];
  const stamp = {
    name: "hermod",
    version: pkg.version,
    ref,
    commit,
    builtAt: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(files).map(([f, data]) => [f, sha256(data)])),
  };

  process.stdout.write(
    `vendor-runtime: ${Object.keys(files).length} files from ${ref} (${commit.slice(0, 12)}) into ${targetDir}` +
      `${removed.length ? `, removing ${removed.length} old file(s)` : ""}${dryRun ? " (dry run: nothing written)" : ""}\n`,
  );
  if (dryRun) return;
  for (const f of removed) {
    const full = path.join(targetDir, f);
    if (full.startsWith(targetDir + path.sep)) rmSync(full, { force: true });
  }
  for (const [f, data] of Object.entries(files)) {
    const full = path.join(targetDir, f);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
  writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
}

main();
