// @ts-check
/**
 * Hermod SessionStart hook: prints the session brief on stdout (Claude Code adds it to the context).
 *
 * - First start of a session id: builds the brief (lib/brief.mjs), saves it in
 *   `.claude/hermod/.local/sessions/<id>/brief.md`, and saves the session state once (head, branch,
 *   transcript path, blob hashes of the files that were already dirty (at most 300), and the paths of all
 *   of them (at most 5,000) with dirtyTruncated set when not every dirty file was hashed).
 * - Resume, compact or clear of the same session id: prints the saved brief unchanged (frozen), even when
 *   the progress file or the lessons changed meanwhile, and leaves the session state alone.
 * - Removes session folders not touched for more than 30 days.
 * - Without a session id (or with unreadable input) it prints a fresh brief and saves nothing.
 *
 * Fails open: any error is logged to `.local/errors.log`; the hook always exits 0 and never blocks.
 */
import { loadConfig } from "../lib/config.mjs";
import { buildBrief, capBrief, cutText, gatherGit } from "../lib/brief.mjs";
import { hashFiles } from "../lib/git.mjs";
import { failOpen, isPlainObject, logError, readStdinJson, resolveRoot } from "../lib/io.mjs";
import { MAX_DIRTY_HASHES, MAX_DIRTY_PATHS, pruneOldSessions, readBrief, writeBrief, writeSessionStart } from "../lib/state.mjs";

/** Session folders older than this are removed. */
const PRUNE_DAYS = 30;
const CONTEXT = "session-start";

/**
 * @param {import("../lib/io.mjs").HookContext} ctx
 * @returns {Promise<string>}
 */
async function main(ctx) {
  /** @type {Record<string, unknown>} */
  let input = {};
  /** @type {unknown} */
  let inputError = null;
  try {
    input = await readStdinJson();
  } catch (error) {
    inputError = error;
  }
  const root = resolveRoot({ input });
  ctx.root = root;
  if (inputError) logError(root, inputError, CONTEXT);

  const rawId = isPlainObject(input) ? input.session_id : undefined;
  const sessionId = typeof rawId === "string" && rawId.trim() !== "" ? rawId : null;

  if (sessionId) {
    const cached = readBrief(root, sessionId);
    if (cached !== null && cached.trim() !== "") {
      prune(root, sessionId);
      return capBrief(cached);
    }
  }

  const { config, errors } = loadConfig(root);
  const git = gatherGit(root);
  const brief = buildBrief(root, config, { sessionId, git, configErrors: errors.length });
  let text = brief.text;

  if (sessionId) {
    try {
      const transcript = input.transcript_path;
      writeSessionStart(root, sessionId, {
        sessionId,
        startedAt: new Date().toISOString(),
        head: git.head,
        branch: git.branch,
        transcriptPath: typeof transcript === "string" && transcript !== "" ? transcript : null,
        dirty: git.repo ? hashFiles(root, git.uncommitted.slice(0, MAX_DIRTY_HASHES)) : {},
        // Every dirty path (hashed or not), so the Stop hook never counts an unhashed one as changed.
        dirtyPaths: git.repo ? git.uncommitted.slice(0, MAX_DIRTY_PATHS) : [],
        dirtyTruncated: git.repo && git.uncommitted.length > MAX_DIRTY_HASHES,
        dirtyTotal: git.repo ? git.uncommitted.length : 0,
      });
      // writeBrief redacts again (a no-op: the brief's parts are already redacted) and returns what it saved,
      // so a resume prints exactly this text.
      const saved = writeBrief(root, sessionId, text);
      text = saved.length <= brief.budget ? saved : writeBrief(root, sessionId, cutText(saved, brief.budget));
    } catch (error) {
      logError(root, error, `${CONTEXT}: saving the session state`);
    }
    prune(root, sessionId);
  }
  return text;
}

/**
 * @param {string} root
 * @param {string} sessionId
 */
function prune(root, sessionId) {
  try {
    pruneOldSessions(root, PRUNE_DAYS, { keep: [sessionId] });
  } catch (error) {
    logError(root, error, `${CONTEXT}: pruning old sessions`);
  }
}

failOpen(main, { context: CONTEXT });
