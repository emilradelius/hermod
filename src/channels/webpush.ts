/**
 * Web push through an injected sender (the `web-push` package's `sendNotification` fits), so Hermod has no
 * push dependency and holds no VAPID keys.
 *
 * - The payload is JSON `{ title, body, url, tag }` (absent fields are null), kept under 3,000 bytes so it fits
 *   the encrypted 4 KB limit: the body is shortened on a character boundary (an over-long title, then url, give
 *   way first only when the body alone cannot make room).
 * - Every subscription of the target is tried. A 404 or 410 (thrown or returned) means the subscription is gone,
 *   so it is removed. `delivered` counts successes; `ok` is true when at least one succeeded.
 * - `send` never throws.
 */
import type { Channel, DeliveryMessage, DeliveryResult } from "../types.js";
import { describeError, isDeliveryMessage, truncateChars, truncateToFit, utf8Length } from "./util.js";

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSendOptions {
  /** Seconds the push service keeps an undelivered message. */
  TTL?: number;
  urgency?: string;
  /** Replaces an undelivered message with the same topic (at most 32 URL-safe base64 characters). */
  topic?: string;
}

/** Resolves with the push service's status code, or rejects (web-push's WebPushError carries `statusCode`). */
export type PushSender = (
  subscription: PushSubscription,
  payload: string,
  options?: PushSendOptions,
) => Promise<{ statusCode: number }>;

export interface PushSubscriptionStore {
  list(target: string): Promise<PushSubscription[]>;
  /** Called for subscriptions the push service says are gone (404/410). */
  remove(endpoint: string): Promise<void>;
}

export interface WebPushChannelOptions {
  send: PushSender;
  subscriptions: PushSubscriptionStore;
  /** Default "webpush". */
  name?: string;
  /** Seconds the push service keeps an undelivered message. Default 86,400 (one day). */
  ttlSeconds?: number;
  /** "very-low" | "low" | "normal" | "high". Default "normal". */
  urgency?: string;
}

export const WEB_PUSH_MAX_PAYLOAD_BYTES = 3_000;
const MAX_TITLE_CHARS = 200;
const MAX_TAG_CHARS = 64;
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const URGENCIES = new Set(["very-low", "low", "normal", "high"]);

export interface WebPushPayload {
  title: string;
  body: string;
  url: string | null;
  tag: string | null;
}

/** The JSON payload for a message, at most `maxBytes` bytes of UTF-8. */
export function webPushPayload(message: DeliveryMessage, maxBytes = WEB_PUSH_MAX_PAYLOAD_BYTES): string {
  if (!(Number.isInteger(maxBytes) && maxBytes >= 512)) throw new RangeError("webPushPayload: maxBytes must be at least 512.");
  const fits = (payload: WebPushPayload): boolean => utf8Length(JSON.stringify(payload)) <= maxBytes;
  let base: WebPushPayload = {
    title: truncateChars(message.title, MAX_TITLE_CHARS),
    body: "",
    url: message.url ?? null,
    tag: message.tag == null ? null : truncateChars(message.tag, MAX_TAG_CHARS, ""),
  };
  // Make room for at least an empty body: drop a url that alone crowds everything out, then shorten the title.
  if (!fits(base)) base = { ...base, url: null };
  if (!fits(base)) {
    const fixed = base;
    base = { ...fixed, title: truncateToFit(fixed.title, (title) => fits({ ...fixed, title }), { maxUnits: maxBytes }) };
  }
  const body = truncateToFit(message.body, (candidate) => fits({ ...base, body: candidate }), { maxUnits: maxBytes });
  return JSON.stringify({ ...base, body });
}

type Attempt = { outcome: "sent" } | { outcome: "gone" } | { outcome: "failed"; reason: string };

export class WebPushChannel implements Channel {
  readonly name: string;
  private readonly sender: PushSender;
  private readonly subscriptions: PushSubscriptionStore;
  private readonly ttlSeconds: number;
  private readonly urgency: string;

  constructor(options: WebPushChannelOptions) {
    if (typeof options?.send !== "function") throw new TypeError("WebPushChannel needs a send(subscription, payload) function.");
    const subs = options.subscriptions;
    if (typeof subs?.list !== "function" || typeof subs.remove !== "function") {
      throw new TypeError("WebPushChannel needs subscriptions with list(target) and remove(endpoint).");
    }
    this.name = options.name ?? "webpush";
    this.sender = options.send;
    this.subscriptions = subs;
    this.ttlSeconds = options.ttlSeconds ?? 86_400;
    this.urgency = options.urgency ?? "normal";
    if (!(Number.isInteger(this.ttlSeconds) && this.ttlSeconds >= 0)) {
      throw new RangeError("WebPushChannel: ttlSeconds must be a whole number of seconds (0 or more).");
    }
    if (!URGENCIES.has(this.urgency)) {
      throw new RangeError('WebPushChannel: urgency must be "very-low", "low", "normal" or "high".');
    }
  }

  async send(target: string, message: DeliveryMessage): Promise<DeliveryResult> {
    try {
      return await this.deliver(target, message);
    } catch (err) {
      return { ok: false, delivered: 0, error: `Web push failed: ${describeError(err)}` };
    }
  }

  private async deliver(target: string, message: DeliveryMessage): Promise<DeliveryResult> {
    if (typeof target !== "string" || target.trim() === "") {
      return { ok: false, delivered: 0, error: "A web push target must be a non-empty string." };
    }
    if (!isDeliveryMessage(message)) return { ok: false, delivered: 0, error: "A web push message needs a string title and body." };
    let listed: unknown;
    try {
      listed = await this.subscriptions.list(target);
    } catch (err) {
      return { ok: false, delivered: 0, error: `Could not list the push subscriptions: ${describeError(err)}` };
    }
    const subscriptions = uniqueByEndpoint(Array.isArray(listed) ? listed : []);
    if (subscriptions.length === 0) return { ok: false, delivered: 0, error: "No push subscriptions for this target." };
    const payload = webPushPayload(message);
    const options: PushSendOptions = { TTL: this.ttlSeconds, urgency: this.urgency };
    if (message.tag != null && TOPIC_PATTERN.test(message.tag)) options.topic = message.tag;
    const attempts = await Promise.all(subscriptions.map((sub) => this.attempt(sub, payload, options)));
    const delivered = attempts.filter((a) => a.outcome === "sent").length;
    if (delivered > 0) return { ok: true, delivered };
    return { ok: false, delivered: 0, error: summarize(attempts) };
  }

  /** One subscription; removes it when the push service says it is gone. Never throws. */
  private async attempt(subscription: unknown, payload: string, options: PushSendOptions): Promise<Attempt> {
    if (!isSubscription(subscription)) return { outcome: "failed", reason: "an invalid subscription record" };
    let status: number | undefined;
    try {
      status = statusCodeOf(await this.sender(subscription, payload, { ...options }));
      if (status !== undefined && status >= 200 && status < 300) return { outcome: "sent" };
    } catch (err) {
      status = statusCodeOf(err);
      if (status === undefined) {
        // Keep the per-device endpoint URL out of stored error text.
        return { outcome: "failed", reason: describeError(err).split(subscription.endpoint).join("[endpoint]") };
      }
    }
    if (status === 404 || status === 410) {
      try {
        await this.subscriptions.remove(subscription.endpoint);
      } catch {
        // It will be reported gone again next time and removed then.
      }
      return { outcome: "gone" };
    }
    return { outcome: "failed", reason: status === undefined ? "no status code" : `HTTP ${status}` };
  }
}

function summarize(attempts: Attempt[]): string {
  const gone = attempts.filter((a) => a.outcome === "gone").length;
  const reasons = [...new Set(attempts.flatMap((a) => (a.outcome === "failed" ? [a.reason] : [])))];
  const parts: string[] = [];
  if (gone > 0) parts.push(`${gone} gone and removed`);
  if (reasons.length > 0) parts.push(`${attempts.length - gone} failed (${reasons.slice(0, 3).join("; ")})`);
  return `Web push reached none of ${attempts.length} subscription(s): ${parts.join(", ")}.`;
}

function statusCodeOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("statusCode" in value)) return undefined;
  const status = value.statusCode;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function isSubscription(value: unknown): value is PushSubscription {
  if (typeof value !== "object" || value === null) return false;
  const s = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null };
  return (
    typeof s.endpoint === "string" &&
    s.endpoint !== "" &&
    typeof s.keys === "object" &&
    s.keys !== null &&
    typeof s.keys.p256dh === "string" &&
    typeof s.keys.auth === "string"
  );
}

/** A device listed twice gets one notification. */
function uniqueByEndpoint(items: unknown[]): unknown[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!isSubscription(item)) return true; // kept, so it is reported as invalid
    if (seen.has(item.endpoint)) return false;
    seen.add(item.endpoint);
    return true;
  });
}
