// @ts-check
/**
 * Reads the user's own messages from a Claude Code session transcript (JSONL, one JSON object per line).
 *
 * Defensive by design: the transcript format is Claude Code's, not ours, so
 * - lines that are not JSON, or not objects, or of an unknown shape are skipped (never an error);
 * - only entries with `type: "user"` count, and only their text: a string `message.content`, or the text of
 *   `{ type: "text" }` blocks in a content list; tool results, images and other blocks are skipped;
 * - meta entries (`isMeta: true`), sub-agent entries (`isSidechain: true`), tool-result entries
 *   (`toolUseResult` present) and command output (`<local-command-stdout>…`) are skipped, and
 *   `<system-reminder>…</system-reminder>` blocks are removed from the text;
 * - only the end of a very large transcript is read (TAIL_BYTES).
 *
 * Every message is redacted (lib/redact.mjs) before it is returned, then cut to maxChars.
 */
import fs from "node:fs";
import { isPlainObject, stripBom, truncateChars } from "./io.mjs";
import { redact } from "./redact.mjs";

/** Only this much of the end of a transcript is read. */
export const TAIL_BYTES = 8 * 1024 * 1024;
/** Default number of messages returned (the last ones). */
export const DEFAULT_LIMIT = 40;
/** Default length of one message. */
export const DEFAULT_MAX_CHARS = 400;

/**
 * @typedef {object} UserMessages
 * @property {boolean} ok false when the transcript could not be read
 * @property {string[]} messages the last `limit` messages, oldest first, redacted and cut
 * @property {number} total user messages found in the part that was read
 * @property {boolean} partial true when only the end of the file was read
 * @property {string | null} error plain-English reason when ok is false
 */

/**
 * Reads at most maxBytes from the end of a file as UTF-8. When the file is larger, the first (partial) line
 * is dropped. Throws on read errors.
 * @param {string} file
 * @param {number} maxBytes
 * @returns {{ text: string, partial: boolean }}
 */
export function readTail(file, maxBytes = TAIL_BYTES) {
  const fd = fs.openSync(file, "r");
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    const size = Math.min(st.size, Math.max(0, Math.floor(maxBytes)));
    const start = st.size - size;
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = fs.readSync(fd, buf, read, size - read, start + read);
      if (n === 0) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    } else {
      text = stripBom(text);
    }
    return { text, partial: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The user's own words in one transcript entry, or null when the entry is not a user message.
 * @param {unknown} entry a parsed transcript line
 * @returns {string | null}
 */
export function userText(entry) {
  if (!isPlainObject(entry) || entry.type !== "user") return null;
  if (entry.isMeta === true || entry.isSidechain === true || entry.toolUseResult !== undefined) return null;
  const message = entry.message;
  if (!isPlainObject(message)) return null;
  if (message.role !== undefined && message.role !== "user") return null;
  const content = message.content;
  /** @type {string[]} */
  const parts = [];
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (isPlainObject(block) && block.type === "tool_result") return null;
      if (isPlainObject(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  } else {
    return null;
  }
  const text = parts
    .join("\n")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
  if (text === "") return null;
  if (/^<local-command-(?:stdout|stderr)>/.test(text)) return null;
  return text;
}

/**
 * The last `limit` user messages of a transcript, redacted and cut to maxChars each. Never throws.
 * @param {string | null | undefined} file absolute path of the transcript (JSONL)
 * @param {{ limit?: number, maxChars?: number, maxBytes?: number, extraPatterns?: ReadonlyArray<string | RegExp> }} [options]
 * @returns {UserMessages}
 */
export function readUserMessages(file, options = {}) {
  const limit = Math.max(0, Math.floor(options.limit ?? DEFAULT_LIMIT));
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS));
  if (typeof file !== "string" || file.trim() === "" || file.includes("\0")) {
    return { ok: false, messages: [], total: 0, partial: false, error: "no transcript path was saved for this session" };
  }
  /** @type {{ text: string, partial: boolean }} */
  let tail;
  try {
    tail = readTail(file, options.maxBytes ?? TAIL_BYTES);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    const why = code === "ENOENT" ? "it does not exist (any more)" : error instanceof Error ? error.message : String(error);
    return { ok: false, messages: [], total: 0, partial: false, error: `the transcript could not be read: ${why}` };
  }
  /** @type {string[]} */
  const found = [];
  for (const line of tail.text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed[0] !== "{") continue;
    /** @type {unknown} */
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const text = userText(entry);
    if (text !== null) found.push(text);
  }
  const last = limit === 0 ? [] : found.slice(-limit);
  const messages = last.map((t) =>
    truncateChars(redact(t, { extraPatterns: options.extraPatterns }).replace(/\s*\n\s*/g, " ⏎ ").replace(/[ \t]{2,}/g, " "), maxChars),
  );
  return { ok: true, messages, total: found.length, partial: tail.partial, error: null };
}
