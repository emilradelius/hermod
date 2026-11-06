// @ts-check
/**
 * Hermod check: runs the repository's checks (`.claude/hermod/checks/*.mjs`) on the files changed since a
 * base ref, or, with --self-test, runs every check's own examples against fake contexts.
 *
 *   node .claude/hermod/check.mjs [--root DIR] [--base REF] [--self-test] [--json] [--help]
 *
 * Exit code: 0 when every error-level check passes (warn checks never fail the run) or every example gives
 * its expected result; 1 when an error-level check fails, errors or is invalid (with --self-test: when an
 * example gives the wrong result or a check is invalid); 2 for a usage error or an unknown --base.
 * Read-only: it never changes a file (the checks themselves are the repository's own code).
 */
import fs from "node:fs";
import { parseArgs } from "node:util";
import { blockingFailures, runChecks, selfTest } from "./lib/checks.mjs";
import { loadConfig } from "./lib/config.mjs";
import { changedFilesSince, defaultBranchRef, head, isSafeRef, mergeBase, revParse } from "./lib/git.mjs";
import { isMainModule, resolveRoot } from "./lib/io.mjs";

export const USAGE = `Usage: node .claude/hermod/check.mjs [--root DIR] [--base REF] [--self-test] [--json] [--help]

Runs the repository's checks (checks.dir in config.json, default .claude/hermod/checks/) on the files changed
since a base ref: committed since the base, plus staged, unstaged and untracked files.

  --root DIR    the repository root (default: $CLAUDE_PROJECT_DIR, else the git top level of this folder)
  --base REF    compare with this ref (default: checks.base in config.json; "auto" = the merge base with the
                default branch, else HEAD, which means uncommitted changes only)
  --self-test   run every check's examples against fake contexts (no git) and report each example whose
                result differs from its "expect"
  --json        print the full result as JSON
  --help        show this help

Exit code: 0 when all error-level checks pass, 1 when one fails (or, with --self-test, when an example gives
the wrong result or a check is invalid), 2 for a usage error.`;

/**
 * @typedef {{ base: string | null, label: string, warning: string | null }} BaseChoice
 */

/**
 * The automatic base: the merge base of HEAD with the default branch, else HEAD.
 * @param {string} root
 * @returns {{ base: string | null, label: string }}
 */
function autoBase(root) {
  const def = defaultBranchRef(root);
  const mb = def ? mergeBase(root, "HEAD", def) : null;
  const h = head(root);
  if (mb && mb !== h) return { base: mb, label: `the merge base with ${def}` };
  return h ? { base: h, label: "HEAD (uncommitted changes only)" } : { base: null, label: "no commits yet (uncommitted files)" };
}

/**
 * @param {string} root
 * @param {string | undefined} cliBase
 * @param {string} configBase
 * @returns {BaseChoice | { error: string }}
 */
export function chooseBase(root, cliBase, configBase) {
  if (cliBase !== undefined) {
    const sha = isSafeRef(cliBase) ? revParse(root, cliBase) : null;
    if (!sha) return { error: `--base "${cliBase}" is not a commit in this repository` };
    return { base: sha, label: cliBase, warning: null };
  }
  if (configBase !== "auto") {
    const sha = revParse(root, configBase);
    if (sha) return { base: sha, label: configBase, warning: null };
    const auto = autoBase(root);
    return { ...auto, warning: `checks.base "${configBase}" is not a commit here; using ${auto.label} instead` };
  }
  return { ...autoBase(root), warning: null };
}

/**
 * @param {number} n
 * @param {string} word
 * @returns {string}
 */
const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * @param {string | null} sha
 * @returns {string}
 */
const short = (sha) => (sha ? sha.slice(0, 7) : "none");

/**
 * The plain-text report of a run.
 * @param {import("./lib/checks.mjs").RunReport} report
 * @param {string} label
 * @returns {string}
 */
export function formatRun(report, label) {
  const lines = [
    `Hermod checks: ${count(report.results.length, "check")} in ${report.dir}/, base ${short(report.base)} (${label}), ${count(report.changedFiles.length, "changed file")}`,
  ];
  for (const e of report.errors) lines.push(`error  ${e}`);
  if (report.results.length === 0) lines.push(`No checks in ${report.dir}/.`);
  for (const r of report.results) {
    const tag =
      r.status === "pass" ? "ok" : r.status === "skip" ? "skip" : r.level === "warn" ? "warn" : r.status === "fail" ? "FAIL" : "ERROR";
    const text = r.status === "pass" ? r.description : (r.message ?? r.description);
    lines.push(`${tag.padEnd(6)} ${r.id}${text ? `: ${text}` : ""}`);
  }
  const failing = blockingFailures(report.results).length + report.errors.length;
  lines.push(failing > 0 ? `failed: ${count(failing, "problem")}` : "ok");
  return `${lines.join("\n")}\n`;
}

/**
 * The plain-text report of a self-test.
 * @param {import("./lib/checks.mjs").SelfTestReport} report
 * @returns {string}
 */
export function formatSelfTest(report) {
  const examples = report.checks.reduce((n, c) => n + c.examples.length, 0);
  const lines = [`Hermod check self-test: ${count(report.checks.length, "check")} in ${report.dir}/, ${count(examples, "example")}`];
  for (const e of report.errors) lines.push(`error  ${e}`);
  if (report.checks.length === 0) lines.push(`No checks in ${report.dir}/.`);
  for (const c of report.checks) {
    if (!c.valid) {
      lines.push(`ERROR  ${c.id}: is not a valid check: ${c.errors.join("; ")}`);
      continue;
    }
    for (const ex of c.examples) {
      if (ex.ok) {
        lines.push(`ok     ${c.id}: ${ex.name}`);
        continue;
      }
      const want = ex.expect ? "pass" : "fail";
      const got = ex.actual === null ? `errored${ex.message ? ` (${ex.message})` : ""}` : ex.actual ? "passed" : `failed${ex.message ? ` (${ex.message})` : ""}`;
      lines.push(`WRONG  ${c.id}: "${ex.name}" should ${want}, but it ${got}`);
    }
  }
  lines.push(report.ok ? "ok" : `failed: ${count(report.failures + report.errors.length, "problem")}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Runs the CLI and returns the exit code (the caller sets it).
 * @param {string[]} argv arguments after the script name
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv, cwd?: string }} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  /** @type {{ root?: string, base?: string, "self-test"?: boolean, json?: boolean, help?: boolean }} */
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        root: { type: "string" },
        base: { type: "string" },
        "self-test": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    stderr.write(`check: ${error instanceof Error ? error.message : error}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const root = resolveRoot({ root: args.root ?? null, env: io.env, cwd: io.cwd, useGit: true });
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      stderr.write(`check: the root folder ${root} does not exist\n`);
      return 2;
    }
    const { config } = loadConfig(root);
    if (args["self-test"]) {
      if (args.base !== undefined) stderr.write("check: --base is ignored with --self-test\n");
      const report = await selfTest(root, { dir: config.checks.dir });
      stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatSelfTest(report));
      return report.ok ? 0 : 1;
    }
    const choice = chooseBase(root, args.base, config.checks.base);
    if ("error" in choice) {
      stderr.write(`check: ${choice.error}\n`);
      return 2;
    }
    if (choice.warning) stderr.write(`check: ${choice.warning}\n`);
    const changedFiles = changedFilesSince(root, choice.base);
    const report = await runChecks(root, { dir: config.checks.dir, base: choice.base, changedFiles });
    const ok = blockingFailures(report.results).length === 0 && report.errors.length === 0;
    if (args.json) {
      stdout.write(`${JSON.stringify({ ok, baseLabel: choice.label, ...report }, null, 2)}\n`);
    } else {
      stdout.write(formatRun(report, choice.label));
    }
    return ok ? 0 : 1;
  } catch (error) {
    stderr.write(`check failed: ${error instanceof Error ? error.message : error}\n`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 2;
    },
  );
}
