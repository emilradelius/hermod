import { describe, expect, it } from "vitest";
import { ChannelRegistry, DeliveryTargetError, parseDeliveryTarget } from "../../../src/channels/channel.js";
import { InAppChannel } from "../../../src/channels/inapp.js";
import { createMemoryStorage } from "../../../src/storage/memory.js";
import type { Channel, DeliveryMessage, DeliveryRecord, DeliveryResult, Id, Storage } from "../../../src/types.js";

/** A channel that records what it was asked to send and answers with a scripted result. */
class RecordingChannel implements Channel {
  readonly name: string;
  readonly sent: Array<{ target: string; message: DeliveryMessage; meta: { jobId?: Id } | undefined }> = [];
  answer: (target: string, message: DeliveryMessage) => Promise<DeliveryResult> | DeliveryResult;

  constructor(name: string, answer?: RecordingChannel["answer"]) {
    this.name = name;
    this.answer = answer ?? (() => ({ ok: true, delivered: 1 }));
  }

  async send(target: string, message: DeliveryMessage, meta?: { jobId?: Id }): Promise<DeliveryResult> {
    this.sent.push({ target, message: { ...message }, meta });
    return this.answer(target, message);
  }
}

const message: DeliveryMessage = { title: "Morning brief", body: "Three things today.", url: "/inbox" };

async function rows(storage: Storage, channel?: string): Promise<DeliveryRecord[]> {
  return storage.deliveries.list(channel === undefined ? {} : { channel });
}

function targetError(run: () => unknown): DeliveryTargetError {
  try {
    run();
  } catch (err) {
    if (err instanceof DeliveryTargetError) return err;
    throw err;
  }
  throw new Error("expected a DeliveryTargetError");
}

describe("parseDeliveryTarget", () => {
  it("splits at the first colon and trims both parts", () => {
    expect(parseDeliveryTarget("webpush:owner")).toEqual({ channel: "webpush", target: "owner" });
    expect(parseDeliveryTarget("  inapp : owner  ")).toEqual({ channel: "inapp", target: "owner" });
    expect(parseDeliveryTarget("hook:https://example.test/x?a=1")).toEqual({
      channel: "hook",
      target: "https://example.test/x?a=1",
    });
  });

  const malformed: Array<[unknown, RegExp]> = [
    ["", /expected "channel:target"/],
    ["owner", /expected "channel:target", e\.g\. "inapp:owner"/],
    [":owner", /the channel name before ":" is missing/],
    ["inapp:", /the target after ":" is missing/],
    ["inapp:   ", /the target after ":" is missing/],
    ["In App:owner", /the channel name "In App" must be lowercase letters/],
    ["__proto__:x", /must be lowercase letters, digits/],
    ["inapp:own\ner", /contains control characters/],
    ["inapp:own\u0000er", /contains control characters/],
    [`inapp:${"x".repeat(600)}`, /longer than 512 characters/],
    [null, /must be a string such as "inapp:owner", not null/],
    [42, /not number/],
  ];
  for (const [spec, pattern] of malformed) {
    it(`rejects ${JSON.stringify(spec)?.slice(0, 40)} as malformed`, () => {
      const err = targetError(() => parseDeliveryTarget(spec as string));
      expect(err.code).toBe("malformed");
      expect(err.message).toMatch(pattern);
    });
  }

  it("never puts raw control characters into the message", () => {
    const err = targetError(() => parseDeliveryTarget("inapp:a\u0007b"));
    expect(err.message).toContain("\\u0007");
    expect(err.message).not.toContain("\u0007");
  });
});

describe("ChannelRegistry.register and resolve", () => {
  it("resolves a registered channel and its target", () => {
    const inapp = new InAppChannel();
    const registry = new ChannelRegistry().register(inapp);
    const resolved = registry.resolve("inapp:owner");
    expect(resolved.channel).toBe(inapp);
    expect(resolved.target).toBe("owner");
  });

  it("names the registered channels when a channel is unknown", () => {
    const registry = new ChannelRegistry().register(new RecordingChannel("webpush")).register(new RecordingChannel("inapp"));
    const err = targetError(() => registry.resolve("telegram:123"));
    expect(err.code).toBe("unknown_channel");
    expect(err.message).toBe('Unknown delivery channel "telegram" in "telegram:123"; registered channels: inapp, webpush.');
    expect(targetError(() => new ChannelRegistry().resolve("inapp:owner")).message).toMatch(/no channels are registered/);
  });

  it("does not look names up on the object prototype", () => {
    const registry = new ChannelRegistry();
    expect(targetError(() => registry.resolve("constructor:x")).code).toBe("unknown_channel");
    expect(targetError(() => registry.resolve("hasownproperty:x")).code).toBe("unknown_channel");
  });

  it("refuses duplicate, invalid and incomplete channels", () => {
    const registry = new ChannelRegistry().register(new RecordingChannel("inapp"));
    expect(() => registry.register(new RecordingChannel("inapp"))).toThrow(/already registered; unregister it first/);
    for (const bad of ["", "Web", "a:b", "9lives", "x".repeat(65)]) {
      expect(() => registry.register(new RecordingChannel(bad))).toThrow(/must be lowercase letters/);
    }
    expect(() => registry.register({ name: "nosend" } as unknown as Channel)).toThrow(/send\(\) method/);
    expect(() => registry.register(null as unknown as Channel)).toThrow(/send\(\) method/);
  });

  it("unregisters, and reports registered names in order", () => {
    const registry = new ChannelRegistry().register(new RecordingChannel("webpush")).register(new RecordingChannel("inapp"));
    expect(registry.names).toEqual(["inapp", "webpush"]);
    expect(registry.unregister("webpush")).toBe(true);
    expect(registry.unregister("webpush")).toBe(false);
    expect(registry.has("webpush")).toBe(false);
    expect(() => registry.resolve("webpush:owner")).toThrow(DeliveryTargetError);
  });
});

describe("ChannelRegistry.deliver", () => {
  it("records the delivery as queued while sending, then sent", async () => {
    const storage = createMemoryStorage();
    const statusDuringSend: string[] = [];
    const channel = new RecordingChannel("inapp", async () => {
      statusDuringSend.push(...(await rows(storage)).map((row) => row.status));
      return { ok: true, delivered: 2 };
    });
    const registry = new ChannelRegistry().register(channel);
    const result = await registry.deliver("inapp:owner", message, { storage, jobId: "job-1" });
    expect(result).toEqual({ ok: true, delivered: 2 });
    expect(statusDuringSend).toEqual(["queued"]);
    const [row] = await rows(storage);
    expect(row).toMatchObject({
      channel: "inapp",
      target: "owner",
      title: "Morning brief",
      body: "Three things today.",
      url: "/inbox",
      status: "sent",
      error: null,
      jobId: "job-1",
    });
    expect(channel.sent).toEqual([{ target: "owner", message, meta: { jobId: "job-1" } }]);
  });

  it("passes no meta and records no job without a jobId", async () => {
    const storage = createMemoryStorage();
    const channel = new RecordingChannel("inapp");
    await new ChannelRegistry().register(channel).deliver("inapp:owner", { title: "t", body: "b" }, { storage });
    expect(channel.sent[0]?.meta).toBeUndefined();
    expect((await rows(storage))[0]).toMatchObject({ jobId: null, url: null, status: "sent" });
  });

  it("marks a failed send as failed and returns the error", async () => {
    const storage = createMemoryStorage();
    const registry = new ChannelRegistry().register(
      new RecordingChannel("webpush", () => ({ ok: false, delivered: 0, error: "No push subscriptions for this target." })),
    );
    const result = await registry.deliver("webpush:owner", message, { storage });
    expect(result).toEqual({ ok: false, delivered: 0, error: "No push subscriptions for this target." });
    expect((await rows(storage))[0]).toMatchObject({ status: "failed", error: "No push subscriptions for this target." });
  });

  it("turns a throwing channel into a failed delivery instead of throwing", async () => {
    const storage = createMemoryStorage();
    const registry = new ChannelRegistry().register(
      new RecordingChannel("inapp", () => {
        throw new Error("socket closed");
      }),
    );
    const result = await registry.deliver("inapp:owner", message, { storage });
    expect(result).toMatchObject({ ok: false, delivered: 0, error: "socket closed" });
    expect((await rows(storage))[0]).toMatchObject({ status: "failed", error: "socket closed" });
  });

  it("refuses a malformed result from a channel", async () => {
    const storage = createMemoryStorage();
    const registry = new ChannelRegistry().register(
      new RecordingChannel("inapp", () => undefined as unknown as DeliveryResult),
    );
    const result = await registry.deliver("inapp:owner", message, { storage });
    expect(result).toMatchObject({ ok: false, error: "the inapp channel returned an invalid result" });
  });

  it("fails a send that does not finish in time", async () => {
    const storage = createMemoryStorage();
    const registry = new ChannelRegistry({ sendTimeoutMs: 20 }).register(
      new RecordingChannel("slow", () => new Promise<DeliveryResult>(() => {})),
    );
    const result = await registry.deliver("slow:owner", message, { storage });
    expect(result).toMatchObject({ ok: false, error: "the slow channel did not finish within 20 ms" });
    expect((await rows(storage))[0]?.status).toBe("failed");
  });

  it("resolves the target at delivery time, so a registry change takes effect", async () => {
    const storage = createMemoryStorage();
    const first = new RecordingChannel("alerts");
    const second = new RecordingChannel("alerts");
    const registry = new ChannelRegistry().register(first);
    await registry.deliver("alerts:owner", message, { storage });
    registry.unregister("alerts");
    registry.register(second);
    await registry.deliver("alerts:owner", message, { storage });
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
  });

  it("records a delivery to an unknown channel as failed, and sends nothing", async () => {
    const storage = createMemoryStorage();
    const channel = new RecordingChannel("inapp");
    const registry = new ChannelRegistry().register(channel);
    const result = await registry.deliver("telegram:123", message, { storage, jobId: "job-9" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown delivery channel "telegram"/);
    expect(await rows(storage)).toEqual([
      expect.objectContaining({ channel: "telegram", target: "123", status: "failed", jobId: "job-9" }),
    ]);
    expect(channel.sent).toHaveLength(0);
  });

  it("does not record a malformed target", async () => {
    const storage = createMemoryStorage();
    const result = await new ChannelRegistry().deliver("nonsense", message, { storage });
    expect(result).toMatchObject({ ok: false, delivered: 0 });
    expect(result.error).toMatch(/Malformed delivery target/);
    expect(await rows(storage)).toEqual([]);
  });

  it("redacts secrets from the stored and returned error", async () => {
    const storage = createMemoryStorage();
    const key = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-"); // built at runtime: no key-shaped literal in the repo
    const registry = new ChannelRegistry().register(
      new RecordingChannel("inapp", () => ({ ok: false, delivered: 0, error: `upstream said: bad key ${key}` })),
    );
    const result = await registry.deliver("inapp:owner", message, { storage });
    const [row] = await rows(storage);
    expect(result.error).toContain("upstream said: bad key");
    expect(result.error).not.toContain(key);
    expect(row?.error).not.toContain(key);
    expect(row?.error).toBe(result.error);
  });

  it("uses a custom redactor when given", async () => {
    const storage = createMemoryStorage();
    const registry = new ChannelRegistry({ redact: (text) => text.replaceAll("owner", "[who]") }).register(
      new RecordingChannel("inapp", () => ({ ok: false, delivered: 0, error: "owner is away" })),
    );
    expect((await registry.deliver("inapp:owner", message, { storage })).error).toBe("[who] is away");
  });

  it("still reports a successful send when marking the row fails", async () => {
    const memory = createMemoryStorage();
    const storage: Pick<Storage, "deliveries"> = {
      deliveries: {
        add: (d) => memory.deliveries.add(d),
        list: (o) => memory.deliveries.list(o),
        mark: async () => {
          throw new Error("database is down");
        },
      },
    };
    const channel = new RecordingChannel("inapp");
    const result = await new ChannelRegistry().register(channel).deliver("inapp:owner", message, { storage });
    expect(result).toEqual({ ok: true, delivered: 1 });
    expect(channel.sent).toHaveLength(1);
  });

  it("throws when storage cannot record the delivery, before anything is sent", async () => {
    const storage: Pick<Storage, "deliveries"> = {
      deliveries: {
        add: async () => {
          throw new Error("database is down");
        },
        list: async () => [],
        mark: async () => null,
      },
    };
    const channel = new RecordingChannel("inapp");
    const registry = new ChannelRegistry().register(channel);
    await expect(registry.deliver("inapp:owner", message, { storage })).rejects.toThrow(/database is down/);
    expect(channel.sent).toHaveLength(0);
  });

  it("refuses to deliver without storage or with an invalid message", async () => {
    const registry = new ChannelRegistry().register(new RecordingChannel("inapp"));
    await expect(registry.deliver("inapp:owner", message, {} as never)).rejects.toThrow(/needs \{ storage \}/);
    await expect(
      registry.deliver("inapp:owner", { title: 1 } as unknown as DeliveryMessage, { storage: createMemoryStorage() }),
    ).rejects.toThrow(/string title and body/);
  });

  it("gives the channel a copy of the message", async () => {
    const storage = createMemoryStorage();
    const original: DeliveryMessage = { title: "t", body: "b" };
    const registry = new ChannelRegistry().register(
      new RecordingChannel("inapp", (_target, sent) => {
        sent.body = "changed by the channel";
        return { ok: true, delivered: 1 };
      }),
    );
    await registry.deliver("inapp:owner", original, { storage });
    expect(original.body).toBe("b");
  });
});
