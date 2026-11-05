// @ts-check
/**
 * Hermod brief: prints the brief a new session would get, built fresh from the files as they are now.
 *
 *   node .claude/hermod/brief.mjs [--root DIR] [--json] [--help]
 *
 * Read-only: it never writes a file (a session's frozen brief is in `.local/sessions/<id>/brief.md`).
 */
import fs from "node:fs";
import { parseArgs } from "node:util";
import { buildBrief } from "./lib/brief.mjs";
import { loadConfig } from "./lib/config.mjs";
import { isMainModule, resolveRoot } from "./lib/io.mjs";

export const USAGE = `Usage: node .claude/hermod/brief.mjs [--root DIR] [--json] [--help]

Prints the brief a new session would get, built fresh from the files as they are now (the progress file's
sections, the lessons, the skills index, recent branches). It never changes a file.

  --root DIR  the repository root (default: $CLAUDE_PROJECT_DIR, else the git top level of this folder)
  --json      print the parts, their sizes and the budget as JSON
  --help      show this help`;

/**
 * Runs the CLI. Returns the exit code instead of exiting (the caller sets it).
 * @param {string[]} argv arguments after the script name
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv, cwd?: string }} [io]
 * @returns {number}
 */
export function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  /** @type {{ root?: string, json?: boolean, help?: boolean }} */
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        root: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    stderr.write(`brief: ${error instanceof Error ? error.message : error}\n\n${USAGE}\n`);
    return 1;
  }
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const root = resolveRoot({ root: args.root ?? null, env: io.env, cwd: io.cwd, useGit: true });
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      stderr.write(`brief: the root folder ${root} does not exist\n`);
      return 1;
    }
    const loaded = loadConfig(root);
    const brief = buildBrief(root, loaded.config, { configErrors: loaded.errors.length });
    if (args.json) {
      const parts = brief.parts.map((p) => ({ name: p.name, status: p.status, chars: p.chars, ...(p.note ? { note: p.note } : {}), text: p.text }));
      stdout.write(
        `${JSON.stringify({ root, budget: brief.budget, chars: brief.chars, configErrors: loaded.errors, parts, text: brief.text }, null, 2)}\n`,
      );
    } else {
      stdout.write(`${brief.text}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`brief failed: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
