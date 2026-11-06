// @ts-check
/**
 * Hermod PostToolUse / PostToolUseFailure hook: keeps the session ledger (lib/ledger.mjs).
 *
 * Registered for PostToolUse (matcher "Bash|Skill|Read") and PostToolUseFailure (matcher "Bash").
 * - A failed Bash command → a "fail" entry in `.claude/hermod/.local/ledger.jsonl` (command and output tail,
 *   redacted), kept open for its command key.
 * - A later success of the same key in the same session → a "resolved" entry with the files changed since.
 * - The Skill tool → a "skill" entry; a Read of `.claude/skills/<name>/SKILL.md` → a "skill-view" entry.
 * - Everything else (and interrupted commands) writes nothing. A plain success with no open failure makes no
 *   git call at all.
 *
 * Prints nothing. Fails open: any error is logged to `.local/errors.log` and the hook exits 0.
 */
import fs from "node:fs";
import { loadConfig } from "../lib/config.mjs";
import { failOpen, hermodPath, isMainModule, readStdinJson, resolveRoot } from "../lib/io.mjs";
import { recordToolEvent } from "../lib/ledger.mjs";

const CONTEXT = "post-tool";
/** The hook's own watchdog (Claude Code's timeout for it is 10 s). */
export const HOOK_TIMEOUT_MS = 8000;

/**
 * @param {import("../lib/io.mjs").HookContext} ctx
 * @returns {Promise<string>}
 */
export async function main(ctx) {
  const input = await readStdinJson();
  const root = resolveRoot({ input });
  ctx.root = root;
  if (!fs.existsSync(hermodPath(root))) return "";
  const { config } = loadConfig(root);
  if (!config.ledger.enabled) return "";
  recordToolEvent(root, input, {
    maxOutputChars: config.ledger.maxOutputChars,
    maxFileBytes: config.ledger.maxFileBytes,
    extraRedactPatterns: config.ledger.extraRedactPatterns,
    skillsDir: config.skills.dir,
  });
  return "";
}

if (isMainModule(import.meta.url)) {
  failOpen(main, { context: CONTEXT, timeoutMs: HOOK_TIMEOUT_MS });
}
