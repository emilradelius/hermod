/**
 * Telegram (optional): sends a message with the Bot API through an injected `fetch`.
 *
 * - POST {apiBase}/bot<token>/sendMessage with `{ chat_id: target, text }`; plain text (no parse mode, so nothing
 *   in a message is interpreted as markup). The text is the title, body and url on separate lines, at most 4,096
 *   characters (the body is shortened first, so the title and link survive).
 * - The token never appears in an error message, a returned error or a thrown error, and it is kept in a private
 *   field, so logging or serialising the channel does not reveal it.
 * - `send` never throws.
 */
import type { Channel, DeliveryMessage, DeliveryResult } from "../types.js";
import { describeError, isDeliveryMessage, truncateChars, truncateToFit } from "./util.js";

export interface TelegramChannelOptions {
  /** The bot token from BotFather ("<digits>:<secret>"). Keep it in an environment variable. */
  token: string;
  fetch?: typeof fetch;
  /** Default "https://api.telegram.org". */
  apiBase?: string;
  /** Default "telegram". */
  name?: string;
  /** Default 10 s. */
  timeoutMs?: number;
}

/** Telegram's limit for one message. Measured in UTF-16 code units, which never undercounts characters. */
export const TELEGRAM_MAX_CHARS = 4_096;
/** Real tokens have a 35-character secret; 20+ keeps the scrubbing below unambiguous. */
const TOKEN_PATTERN = /^[0-9]{1,20}:[A-Za-z0-9_-]{20,200}$/;
const CHAT_ID_PATTERN = /^(?:-?[0-9]{1,20}|@[A-Za-z0-9_]{1,64})$/;
const MAX_ERROR_CHARS = 500;

/** The message text: title, body and url on separate lines (empty ones left out), at most 4,096 characters. */
export function telegramText(message: DeliveryMessage): string {
  const title = message.title.trim();
  const body = message.body.trim();
  const url = (message.url ?? "").trim();
  const join = (text: string): string => [title, text, url].filter((line) => line !== "").join("\n");
  const fits = (text: string): boolean => text.length <= TELEGRAM_MAX_CHARS;
  const full = join(body);
  if (fits(full)) return full;
  if (fits(join("…"))) return join(truncateToFit(body, (b) => fits(join(b)), { maxUnits: TELEGRAM_MAX_CHARS }));
  return truncateToFit(full, fits, { maxUnits: TELEGRAM_MAX_CHARS }); // the title or url alone is too long
}

export class TelegramChannel implements Channel {
  readonly name: string;
  // A private field: not shown by console.log/util.inspect and not serialised by JSON.stringify.
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #apiBase: string;
  readonly #timeoutMs: number;

  constructor(options: TelegramChannelOptions) {
    const token = options?.token;
    if (typeof token !== "string" || token.trim() === "") throw new TypeError("TelegramChannel needs a bot token.");
    if (!TOKEN_PATTERN.test(token)) {
      // Never echo the token, not even a malformed one.
      throw new TypeError('TelegramChannel: the bot token is not in the expected form ("<digits>:<letters, digits, _ or ->").');
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new TypeError("TelegramChannel needs a fetch function.");
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#apiBase = normalizeApiBase(options.apiBase ?? "https://api.telegram.org");
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!(Number.isFinite(this.#timeoutMs) && this.#timeoutMs > 0)) {
      throw new RangeError("TelegramChannel: timeoutMs must be a positive number of milliseconds.");
    }
    this.name = options.name ?? "telegram";
  }

  async send(target: string, message: DeliveryMessage): Promise<DeliveryResult> {
    try {
      return await this.post(target, message);
    } catch (err) {
      return this.failure(`Telegram send failed: ${describeError(err)}`);
    }
  }

  private async post(target: string, message: DeliveryMessage): Promise<DeliveryResult> {
    if (typeof target !== "string" || !CHAT_ID_PATTERN.test(target)) {
      return this.failure("A Telegram target must be a numeric chat id or an @username.");
    }
    if (!isDeliveryMessage(message)) return this.failure("A Telegram message needs a string title and body.");
    const text = telegramText(message);
    if (text === "") return this.failure("Nothing to send: the message is empty.");
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiBase}/bot${this.#token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: target, text }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      return this.failure(`Telegram request failed: ${describeError(err)}`);
    }
    const data = await readJson(response);
    if (response.ok && data?.ok === true) return { ok: true, delivered: 1 };
    const description = typeof data?.description === "string" ? data.description : response.statusText;
    return this.failure(`Telegram API error ${response.status}${description ? `: ${description}` : ""}`);
  }

  private failure(error: string): DeliveryResult {
    return { ok: false, delivered: 0, error: truncateChars(this.scrub(error), MAX_ERROR_CHARS) };
  }

  /** Removes the token (whole, URL-encoded, or just its secret half) from text. */
  private scrub(text: string): string {
    const secret = this.#token.slice(this.#token.indexOf(":") + 1);
    const forms = [this.#token, encodeURIComponent(this.#token), secret];
    return forms.reduce((out, form) => out.split(form).join("[redacted]"), text);
  }
}

async function readJson(response: Response): Promise<{ ok?: unknown; description?: unknown } | null> {
  try {
    const data: unknown = await response.json();
    return typeof data === "object" && data !== null ? data : null;
  } catch {
    return null;
  }
}

function normalizeApiBase(apiBase: string): string {
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    throw new TypeError("TelegramChannel: apiBase must be an absolute http(s) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("TelegramChannel: apiBase must be an absolute http(s) URL.");
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new TypeError("TelegramChannel: apiBase must not contain a query, a fragment or credentials.");
  }
  return url.href.replace(/\/+$/, "");
}
