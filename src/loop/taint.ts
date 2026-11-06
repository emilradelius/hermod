/**
 * Session taint: untrusted text (wrapped with wrapUntrusted) is in the conversation the model sees.
 *
 * Taint belongs to the conversation, not to one run: text fetched in turn 1 is still in the model's context in
 * turn 2. So once a run of a session is tainted, the session row records it (meta.tainted = true, meta.taintedAt),
 * and every later run of that session starts tainted. Sessions stored before the flag existed are recognised by
 * the opening tag of an untrusted wrapper in their messages. Nothing ever clears the flag.
 */
import { UNTRUSTED_TAG } from "../safety/untrusted.js";
import type { Id, MessageRecord, SessionRecord, Storage } from "../types.js";

/** The session meta keys the loop owns for taint. */
export const TAINTED_META_KEY = "tainted";
export const TAINTED_AT_META_KEY = "taintedAt";

const OPENING_TAG = `<${UNTRUSTED_TAG}`;

/** True when any string inside `value` (a message content, a list of messages) holds an untrusted wrapper's opening tag. */
export function containsUntrustedWrapper(value: unknown): boolean {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    // Unserialisable content cannot be checked, so it counts as untrusted (fail closed).
    return true;
  }
  return text.includes(OPENING_TAG);
}

/** The session row says untrusted text entered it. */
export function sessionMarkedTainted(session: Pick<SessionRecord, "meta"> | null | undefined): boolean {
  return session?.meta?.[TAINTED_META_KEY] === true;
}

/** A session is tainted when its row says so or any of its stored messages carries an untrusted wrapper. */
export function isSessionTainted(session: Pick<SessionRecord, "meta">, messages: readonly Pick<MessageRecord, "content">[]): boolean {
  return sessionMarkedTainted(session) || messages.some((message) => containsUntrustedWrapper(message.content));
}

/**
 * Records taint on the session row (meta.tainted = true, meta.taintedAt), keeping the rest of its meta. Does nothing
 * when the row is already marked or missing. Returns true when the row is marked afterwards.
 */
export async function markSessionTainted(storage: Storage, sessionId: Id, at: Date): Promise<boolean> {
  const current = await storage.sessions.get(sessionId);
  if (!current) return false;
  if (sessionMarkedTainted(current)) return true;
  const updated = await storage.sessions.update(sessionId, {
    meta: { ...current.meta, [TAINTED_META_KEY]: true, [TAINTED_AT_META_KEY]: at.toISOString() },
  });
  return sessionMarkedTainted(updated);
}
