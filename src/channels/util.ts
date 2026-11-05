/** Small helpers shared by the channels and the scheduler. */
import type { DeliveryMessage, Redactor } from "../types.js";

/** A readable one-line description of anything thrown. Never throws. */
export function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message.trim() || err.name || "Error";
    if (typeof err === "string") return err.trim() || "an empty error";
    if (typeof err === "object" && err !== null && "message" in err && typeof err.message === "string") {
      return err.message.trim() || "an error without a message";
    }
    const json = JSON.stringify(err);
    return json === undefined ? String(err) : json;
  } catch {
    return "an error that could not be described";
  }
}

/** JSON-quoted (control characters escaped) and shortened, for values shown in messages. */
export function quote(text: string, max = 60): string {
  return JSON.stringify(text.length > max ? `${text.slice(0, max - 3)}...` : text);
}

/** True when the text contains C0/C1 control characters or DEL. */
export function hasControlCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return true;
  }
  return false;
}

/** Bytes in the UTF-8 encoding. */
export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The first `units` UTF-16 code units, never ending inside a surrogate pair. */
export function headUnits(text: string, units: number): string {
  if (text.length <= units) return text;
  const head = text.slice(0, units);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/** At most `max` code points; a shortened text ends with `ellipsis` (counted within `max`). */
export function truncateChars(text: string, max: number, ellipsis = "…"): string {
  if (text.length <= max) return text; // at most `max` UTF-16 units, so at most `max` code points
  // 2 * max + 2 units hold at least max + 1 code points, so a head this short means the whole text is short.
  const chars = Array.from(headUnits(text, max * 2 + 2));
  if (chars.length <= max) return text;
  const keep = Math.max(0, max - Array.from(ellipsis).length);
  return chars.slice(0, keep).join("") + ellipsis;
}

/**
 * The longest prefix of `text` (whole code points) that `fits` once `ellipsis` is added; the text itself when it
 * fits; "" when nothing does. `maxUnits` bounds the work for huge inputs: a caller passes a length no fitting
 * prefix can exceed. `fits` must be monotonic (a shorter candidate never fits worse).
 */
export function truncateToFit(
  text: string,
  fits: (candidate: string) => boolean,
  options: { ellipsis?: string; maxUnits?: number } = {},
): string {
  const ellipsis = options.ellipsis ?? "…";
  const maxUnits = options.maxUnits ?? text.length;
  const cutAlready = text.length > maxUnits;
  if (!cutAlready && fits(text)) return text;
  const chars = Array.from(headUnits(text, maxUnits));
  // Keep at most every code point we have when the text was already cut, else at least one fewer.
  let low = 0;
  let high = cutAlready ? chars.length : chars.length - 1;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = chars.slice(0, mid).join("") + ellipsis;
    if (fits(candidate)) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/** A DeliveryMessage with string title and body (url and tag optional strings). */
export function isDeliveryMessage(value: unknown): value is DeliveryMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  const optionalString = (v: unknown): boolean => v === undefined || v === null || typeof v === "string";
  return typeof m.title === "string" && typeof m.body === "string" && optionalString(m.url) && optionalString(m.tag);
}

/**
 * Minimal secret redaction for error text that is stored (job.lastError, delivery.error).
 * NOTE: a stand-in until src/safety/redact.ts (secretsRedactor) exists; replace it with that one.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\b[0-9]{5,15}:[A-Za-z0-9_-]{30,}/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/(\/\/[^/\s:@]+):[^/\s@]+@/g, "$1:[REDACTED]@"],
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD))=[^\s&"']+/gi, "$1=[REDACTED]"],
];

export const defaultRedactor: Redactor = (text) =>
  SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
