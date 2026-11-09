import { describe, expect, it, vi } from "vitest";
import { WEB_PUSH_MAX_PAYLOAD_BYTES, WebPushChannel, webPushPayload } from "../../../src/channels/webpush.js";
import type { PushSendOptions, PushSubscription, PushSubscriptionStore } from "../../../src/channels/webpush.js";

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
/** A lone (unpaired) surrogate anywhere in the text. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function sub(n: number): PushSubscription {
  return { endpoint: `https://push.example.test/send/device-${n}`, keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` } };
}

/** An in-memory subscription store that records removals. */
function store(subs: unknown[]): PushSubscriptionStore & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    list: async () => subs as PushSubscription[],
    remove: async (endpoint) => {
      removed.push(endpoint);
    },
  };
}

/** A web-push style error: rejects with an object carrying statusCode. */
function pushError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error("Received unexpected response code"), { statusCode, body: "", endpoint: "x" });
}

describe("webPushPayload", () => {
  it("is JSON with title, body, url and tag (null when absent)", () => {
    expect(webPushPayload({ title: "Hi", body: "Body" })).toBe('{"title":"Hi","body":"Body","url":null,"tag":null}');
    expect(JSON.parse(webPushPayload({ title: "Hi", body: "Body", url: "/inbox", tag: "brief" }))).toEqual({
      title: "Hi",
      body: "Body",
      url: "/inbox",
      tag: "brief",
    });
  });

  it("keeps a long body under 3,000 bytes, cut on a character boundary with an ellipsis", () => {
    const body = "å".repeat(10_000); // 2 bytes each in UTF-8
    const payload = webPushPayload({ title: "Brief", body, url: "/inbox" });
    expect(bytes(payload)).toBeLessThanOrEqual(WEB_PUSH_MAX_PAYLOAD_BYTES);
    expect(bytes(payload)).toBeGreaterThan(WEB_PUSH_MAX_PAYLOAD_BYTES - 4); // not cut more than needed
    const parsed = JSON.parse(payload) as { body: string; url: string };
    expect(parsed.body.endsWith("…")).toBe(true);
    expect(body.startsWith(parsed.body.slice(0, -1))).toBe(true);
    expect(parsed.url).toBe("/inbox");
  });

  it("never splits an emoji (surrogate pair)", () => {
    for (const filler of ["🎉", "a🎉", "ab🎉", "👨‍👩‍👧 "]) {
      const payload = webPushPayload({ title: "t", body: filler.repeat(2_000) });
      expect(bytes(payload)).toBeLessThanOrEqual(WEB_PUSH_MAX_PAYLOAD_BYTES);
      expect(LONE_SURROGATE.test(JSON.parse(payload).body)).toBe(false);
    }
  });

  it("counts JSON escaping, so quotes, backslashes and control characters cannot push it over", () => {
    const body = '"\\\n\u0001'.repeat(2_000);
    const payload = webPushPayload({ title: '"quoted"', body });
    expect(bytes(payload)).toBeLessThanOrEqual(WEB_PUSH_MAX_PAYLOAD_BYTES);
    expect(body.startsWith(JSON.parse(payload).body.slice(0, -1))).toBe(true);
  });

  it("shortens an over-long title and tag, and drops a url too long to leave room", () => {
    const payload = JSON.parse(
      webPushPayload({ title: "T".repeat(10_000), body: "short body", url: `/${"u".repeat(5_000)}`, tag: "g".repeat(500) }),
    ) as { title: string; body: string; url: string | null; tag: string };
    expect(Array.from(payload.title)).toHaveLength(200);
    expect(payload.tag).toHaveLength(64);
    expect(payload.url).toBeNull();
    expect(payload.body).toBe("short body");
  });

  it("handles a huge body quickly", () => {
    const started = performance.now();
    const payload = webPushPayload({ title: "t", body: "x".repeat(5_000_000) });
    expect(bytes(payload)).toBeLessThanOrEqual(WEB_PUSH_MAX_PAYLOAD_BYTES);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("rejects a tiny byte limit", () => {
    expect(() => webPushPayload({ title: "t", body: "b" }, 100)).toThrow(/at least 512/);
  });
});

describe("WebPushChannel.send", () => {
  it("tries every subscription with the same payload and options", async () => {
    const send = vi.fn(async () => ({ statusCode: 201 }));
    const channel = new WebPushChannel({ send, subscriptions: store([sub(1), sub(2), sub(3)]) });
    const result = await channel.send("owner", { title: "Hi", body: "Body", tag: "morning-brief" });
    expect(result).toEqual({ ok: true, delivered: 3 });
    expect(send).toHaveBeenCalledTimes(3);
    const payload = webPushPayload({ title: "Hi", body: "Body", tag: "morning-brief" });
    expect(send.mock.calls.map((call: unknown[]) => (call[0] as PushSubscription).endpoint)).toEqual([
      sub(1).endpoint,
      sub(2).endpoint,
      sub(3).endpoint,
    ]);
    for (const call of send.mock.calls as unknown[][]) {
      expect(call[1]).toBe(payload);
      expect(call[2]).toEqual({ TTL: 86_400, urgency: "normal", topic: "morning-brief" });
    }
  });

  it("uses the tag as topic only when it is a valid topic", async () => {
    const options: PushSendOptions[] = [];
    const channel = new WebPushChannel({
      send: async (_s, _p, o) => {
        options.push(o ?? {});
        return { statusCode: 201 };
      },
      subscriptions: store([sub(1)]),
      ttlSeconds: 600,
      urgency: "high",
    });
    await channel.send("owner", { title: "t", body: "b", tag: "has spaces" });
    await channel.send("owner", { title: "t", body: "b" });
    expect(options).toEqual([
      { TTL: 600, urgency: "high" },
      { TTL: 600, urgency: "high" },
    ]);
  });

  it("removes subscriptions that are gone (404/410, thrown or returned) and counts successes", async () => {
    const subscriptions = store([sub(1), sub(2), sub(3), sub(4)]);
    const answers: Record<string, () => Promise<{ statusCode: number }>> = {
      [sub(1).endpoint]: async () => ({ statusCode: 201 }),
      [sub(2).endpoint]: async () => {
        throw pushError(410);
      },
      [sub(3).endpoint]: async () => ({ statusCode: 404 }),
      [sub(4).endpoint]: async () => {
        throw pushError(500);
      },
    };
    const channel = new WebPushChannel({
      send: (s) => (answers[s.endpoint] ?? (async () => ({ statusCode: 201 })))(),
      subscriptions,
    });
    expect(await channel.send("owner", { title: "t", body: "b" })).toEqual({ ok: true, delivered: 1 });
    expect(subscriptions.removed.sort()).toEqual([sub(2).endpoint, sub(3).endpoint]);
  });

  it("fails without naming endpoints when no subscription took it", async () => {
    const subscriptions = store([sub(1), sub(2), sub(3)]);
    const channel = new WebPushChannel({
      send: async (s) => {
        if (s.endpoint === sub(3).endpoint) throw pushError(500);
        throw pushError(410);
      },
      subscriptions,
    });
    const result = await channel.send("owner", { title: "t", body: "b" });
    expect(result.ok).toBe(false);
    expect(result.delivered).toBe(0);
    expect(result.error).toBe("Web push reached none of 3 subscription(s): 2 gone and removed, 1 failed (HTTP 500).");
    expect(result.error).not.toContain("push.example.test");
  });

  it("reports a target without subscriptions", async () => {
    const channel = new WebPushChannel({ send: async () => ({ statusCode: 201 }), subscriptions: store([]) });
    expect(await channel.send("owner", { title: "t", body: "b" })).toEqual({
      ok: false,
      delivered: 0,
      error: "No push subscriptions for this target.",
    });
  });

  it("never throws: a failing store, remover or sender becomes a result", async () => {
    const failingList = new WebPushChannel({
      send: async () => ({ statusCode: 201 }),
      subscriptions: {
        list: async () => {
          throw new Error("db down");
        },
        remove: async () => {},
      },
    });
    expect(await failingList.send("owner", { title: "t", body: "b" })).toMatchObject({
      ok: false,
      error: "Could not list the push subscriptions: db down",
    });

    const failingRemove = new WebPushChannel({
      send: async () => {
        throw pushError(410);
      },
      subscriptions: {
        list: async () => [sub(1)],
        remove: async () => {
          throw new Error("db down");
        },
      },
    });
    expect(await failingRemove.send("owner", { title: "t", body: "b" })).toMatchObject({ ok: false, delivered: 0 });

    const weirdSender = new WebPushChannel({
      send: (async () => {
        throw "a string, not an Error";
      }) as never,
      subscriptions: store([sub(1)]),
    });
    expect(await weirdSender.send("owner", { title: "t", body: "b" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("a string, not an Error"),
    });
  });

  it("keeps the endpoint out of a network error", async () => {
    const channel = new WebPushChannel({
      send: async (s) => {
        throw new Error(`connect ECONNREFUSED while posting to ${s.endpoint}`);
      },
      subscriptions: store([sub(1)]),
    });
    const result = await channel.send("owner", { title: "t", body: "b" });
    expect(result.error).toContain("connect ECONNREFUSED while posting to [endpoint]");
    expect(result.error).not.toContain("device-1");
  });

  it("does not count a send without a 2xx status code", async () => {
    const channel = new WebPushChannel({
      send: (async () => undefined) as never,
      subscriptions: store([sub(1)]),
    });
    expect(await channel.send("owner", { title: "t", body: "b" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("no status code"),
    });
  });

  it("sends once per device even if a subscription is listed twice, and skips invalid records", async () => {
    const send = vi.fn(async () => ({ statusCode: 201 }));
    const channel = new WebPushChannel({ send, subscriptions: store([sub(1), sub(1), null, { endpoint: "x" }, sub(2)]) });
    expect(await channel.send("owner", { title: "t", body: "b" })).toEqual({ ok: true, delivered: 2 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("refuses bad targets and messages", async () => {
    const send = vi.fn(async () => ({ statusCode: 201 }));
    const channel = new WebPushChannel({ send, subscriptions: store([sub(1)]) });
    expect(await channel.send("", { title: "t", body: "b" })).toMatchObject({ ok: false });
    expect(await channel.send("owner", { title: "t" } as never)).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("checks its options", () => {
    const subscriptions = store([]);
    const send = async () => ({ statusCode: 201 });
    expect(() => new WebPushChannel({ subscriptions } as never)).toThrow(/send\(subscription, payload\)/);
    expect(() => new WebPushChannel({ send } as never)).toThrow(/list\(target\) and remove\(endpoint\)/);
    expect(() => new WebPushChannel({ send, subscriptions, ttlSeconds: -1 })).toThrow(/ttlSeconds/);
    expect(() => new WebPushChannel({ send, subscriptions, urgency: "now!" })).toThrow(/urgency/);
    expect(new WebPushChannel({ send, subscriptions }).name).toBe("webpush");
  });
});
