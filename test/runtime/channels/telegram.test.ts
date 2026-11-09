import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { TELEGRAM_MAX_CHARS, TelegramChannel, telegramText } from "../../../src/channels/telegram.js";

// A made-up token in the real shape: "<bot id>:<35-character secret>", built at runtime so that no token-shaped
// literal is committed (the no-secret-literals check).
const TOKEN = ["7712345678", "AAH3kz_fake-Token-For-Tests-0123456"].join(":");
const SECRET = TOKEN.slice(TOKEN.indexOf(":") + 1);

type FetchCall = { url: string; init: RequestInit };

/** A fetch that records calls and answers with the given response. */
function fakeFetch(answer: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return answer(call);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const okResponse = () => Response.json({ ok: true, result: { message_id: 1 } });

function expectNoToken(text: string | undefined): void {
  expect(text ?? "").not.toContain(TOKEN);
  expect(text ?? "").not.toContain(SECRET);
  expect(text ?? "").not.toContain(encodeURIComponent(TOKEN));
}

describe("telegramText", () => {
  it("puts title, body and url on separate lines, leaving out empty ones", () => {
    expect(telegramText({ title: "Brief", body: "Three things.", url: "https://example.test/inbox" })).toBe(
      "Brief\nThree things.\nhttps://example.test/inbox",
    );
    expect(telegramText({ title: "", body: "Only a body" })).toBe("Only a body");
  });

  it("stays within 4,096 characters, shortening the body so the title and link survive", () => {
    const text = telegramText({ title: "Brief", body: "ö".repeat(10_000), url: "https://example.test/x" });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(text.length).toBeGreaterThan(TELEGRAM_MAX_CHARS - 2);
    expect(text.startsWith("Brief\n")).toBe(true);
    expect(text.endsWith("…\nhttps://example.test/x")).toBe(true);
  });

  it("never splits an emoji, and copes with a title that is too long by itself", () => {
    const emoji = telegramText({ title: "t", body: "🎉".repeat(5_000) });
    expect(emoji.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(/[\uD800-\uDBFF]$/.test(emoji.replace(/…$/, ""))).toBe(false);
    expect(telegramText({ title: "T".repeat(9_000), body: "b" }).length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });
});

describe("TelegramChannel.send", () => {
  it("POSTs chat_id and plain text to the Bot API", async () => {
    const { fetch, calls } = fakeFetch(okResponse);
    const channel = new TelegramChannel({ token: TOKEN, fetch });
    const result = await channel.send("123456789", { title: "Brief", body: "Body", url: "https://example.test" });
    expect(result).toEqual({ ok: true, delivered: 1 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(call?.init.method).toBe("POST");
    expect(new Headers(call?.init.headers).get("content-type")).toBe("application/json");
    // Plain text: no parse_mode, so nothing in the message is read as markup.
    expect(JSON.parse(String(call?.init.body))).toEqual({ chat_id: "123456789", text: "Brief\nBody\nhttps://example.test" });
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses a custom apiBase (trailing slashes removed)", async () => {
    const { fetch, calls } = fakeFetch(okResponse);
    await new TelegramChannel({ token: TOKEN, fetch, apiBase: "http://localhost:8081/tg/" }).send("-1001234567890", {
      title: "t",
      body: "b",
    });
    expect(calls[0]?.url).toBe(`http://localhost:8081/tg/bot${TOKEN}/sendMessage`);
  });

  it("accepts numeric chat ids and @usernames, and refuses anything else without calling the API", async () => {
    const { fetch, calls } = fakeFetch(okResponse);
    const channel = new TelegramChannel({ token: TOKEN, fetch });
    for (const ok of ["12345", "-1001234567890", "@my_channel"]) {
      expect(await channel.send(ok, { title: "t", body: "b" })).toEqual({ ok: true, delivered: 1 });
    }
    for (const bad of ["", "abc", "12 34", "@", "@bad name", "../../setWebhook", "1;2"]) {
      expect(await channel.send(bad, { title: "t", body: "b" })).toMatchObject({ ok: false, delivered: 0 });
    }
    expect(calls).toHaveLength(3);
  });

  it("returns the API's error description", async () => {
    const { fetch } = fakeFetch(() =>
      Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 }),
    );
    expect(await new TelegramChannel({ token: TOKEN, fetch }).send("123", { title: "t", body: "b" })).toEqual({
      ok: false,
      delivered: 0,
      error: "Telegram API error 400: Bad Request: chat not found",
    });
  });

  it("copes with a response that is not JSON", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    expect(await new TelegramChannel({ token: TOKEN, fetch }).send("123", { title: "t", body: "b" })).toMatchObject({
      ok: false,
      error: "Telegram API error 502: Bad Gateway",
    });
  });

  it("refuses an empty message", async () => {
    const { fetch, calls } = fakeFetch(okResponse);
    const result = await new TelegramChannel({ token: TOKEN, fetch }).send("123", { title: " ", body: "\n" });
    expect(result).toMatchObject({ ok: false, error: "Nothing to send: the message is empty." });
    expect(calls).toHaveLength(0);
  });

  it("times out a request that hangs", async () => {
    const hanging = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const result = await new TelegramChannel({ token: TOKEN, fetch: hanging, timeoutMs: 20 }).send("123", {
      title: "t",
      body: "b",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Telegram request failed: .*(timeout|aborted)/i);
  });

  it("never throws, even when fetch returns garbage", async () => {
    const garbage = (async () => undefined) as unknown as typeof fetch;
    const result = await new TelegramChannel({ token: TOKEN, fetch: garbage }).send("123", { title: "t", body: "b" });
    expect(result).toMatchObject({ ok: false, delivered: 0 });
  });
});

describe("TelegramChannel keeps its token secret", () => {
  it("scrubs the token from network errors (whole, URL-encoded, or just the secret half)", async () => {
    for (const leak of [
      `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: ECONNRESET`,
      `bad url: /bot${encodeURIComponent(TOKEN)}/sendMessage`,
      `auth part ${SECRET} rejected`,
    ]) {
      const { fetch } = fakeFetch(() => {
        throw new TypeError(leak);
      });
      const result = await new TelegramChannel({ token: TOKEN, fetch }).send("123", { title: "t", body: "b" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("[redacted]");
      expectNoToken(result.error);
    }
  });

  it("scrubs the token from an API description", async () => {
    const { fetch } = fakeFetch(() =>
      Response.json({ ok: false, error_code: 401, description: `Unauthorized: bot${TOKEN} is not valid` }, { status: 401 }),
    );
    const result = await new TelegramChannel({ token: TOKEN, fetch }).send("123", { title: "t", body: "b" });
    expect(result.error).toBe("Telegram API error 401: Unauthorized: bot[redacted] is not valid");
  });

  it("never echoes the token in a thrown error", () => {
    const malformed = "12345:short secret with spaces";
    let message = "";
    try {
      new TelegramChannel({ token: malformed });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not in the expected form/);
    expect(message).not.toContain("short secret");
    expect(() => new TelegramChannel({ token: "" })).toThrow(/needs a bot token/);
    expect(() => new TelegramChannel({} as never)).toThrow(/needs a bot token/);
  });

  it("does not show the token when the channel is logged or serialised", () => {
    const channel = new TelegramChannel({ token: TOKEN, fetch: fakeFetch(okResponse).fetch });
    expectNoToken(inspect(channel, { depth: 5, showHidden: true }));
    expectNoToken(JSON.stringify(channel));
    expectNoToken(String(channel));
    expectNoToken(Object.values(channel).map(String).join(" "));
  });

  it("checks apiBase", () => {
    for (const apiBase of ["not a url", "ftp://example.test", "https://example.test/?q=1", "https://user:pw@example.test"]) {
      expect(() => new TelegramChannel({ token: TOKEN, apiBase })).toThrow(/apiBase/);
    }
    expect(() => new TelegramChannel({ token: TOKEN, timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});
