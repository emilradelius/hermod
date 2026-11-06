import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRegistry } from "../../../src/channels/channel.js";
import { InAppChannel } from "../../../src/channels/inapp.js";
import type { InAppEvent } from "../../../src/channels/inapp.js";
import { createMemoryStorage } from "../../../src/storage/memory.js";

const fixedNow = () => new Date("2026-11-05T07:30:00.000Z");

/** Reads SSE text from a response body chunk by chunk. */
function sseReader(response: Response) {
  const body = response.body;
  if (!body) throw new Error("no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  return {
    async next(): Promise<string | null> {
      const { value, done } = await reader.read();
      return done ? null : decoder.decode(value);
    },
    cancel: () => reader.cancel(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("InAppChannel subscribers", () => {
  it("delivers to the target's live subscribers only", async () => {
    const channel = new InAppChannel({ now: fixedNow });
    const owner: InAppEvent[] = [];
    const other: InAppEvent[] = [];
    channel.subscribe("owner", (event) => owner.push(event));
    channel.subscribe("someone-else", (event) => other.push(event));
    const result = await channel.send("owner", { title: "Hi", body: "Body", url: "/x", tag: "t1" }, { jobId: "job-1" });
    expect(result).toEqual({ ok: true, delivered: 1 });
    expect(owner).toEqual([
      { target: "owner", title: "Hi", body: "Body", url: "/x", tag: "t1", jobId: "job-1", at: "2026-11-05T07:30:00.000Z" },
    ]);
    expect(other).toEqual([]);
  });

  it("stops delivering after unsubscribe and forgets empty targets", async () => {
    const channel = new InAppChannel();
    const seen: string[] = [];
    const unsubscribe = channel.subscribe("owner", (event) => seen.push(event.body));
    expect(channel.listenerCount("owner")).toBe(1);
    await channel.send("owner", { title: "t", body: "one" });
    unsubscribe();
    unsubscribe(); // idempotent
    await channel.send("owner", { title: "t", body: "two" });
    expect(seen).toEqual(["one"]);
    expect(channel.listenerCount("owner")).toBe(0);
    expect((channel as unknown as { listeners: Map<string, unknown> }).listeners.size).toBe(0);
  });

  it("lets the same function subscribe twice and unsubscribe each separately", async () => {
    const channel = new InAppChannel();
    const listener = vi.fn();
    const first = channel.subscribe("owner", listener);
    channel.subscribe("owner", listener);
    await channel.send("owner", { title: "t", body: "b" });
    expect(listener).toHaveBeenCalledTimes(2);
    first();
    await channel.send("owner", { title: "t", body: "b" });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("keeps delivering to the others when one subscriber throws", async () => {
    const channel = new InAppChannel();
    const good = vi.fn();
    channel.subscribe("owner", () => {
      throw new Error("broken tab");
    });
    channel.subscribe("owner", good);
    expect(await channel.send("owner", { title: "t", body: "b" })).toEqual({ ok: true, delivered: 1 });
    expect(good).toHaveBeenCalledOnce();
  });

  it("gives each subscriber its own copy of the event", async () => {
    const channel = new InAppChannel();
    const bodies: string[] = [];
    channel.subscribe("owner", (event) => {
      event.body = "mutated";
    });
    channel.subscribe("owner", (event) => bodies.push(event.body));
    await channel.send("owner", { title: "t", body: "original" });
    expect(bodies).toEqual(["original"]);
  });

  it("succeeds with nobody connected (the registry's delivery row is the outbox)", async () => {
    expect(await new InAppChannel().send("owner", { title: "t", body: "b" })).toEqual({ ok: true, delivered: 0 });
  });

  it("refuses bad targets and messages without throwing from send", async () => {
    const channel = new InAppChannel();
    expect(await channel.send("", { title: "t", body: "b" })).toMatchObject({ ok: false });
    expect(await channel.send("own\ner", { title: "t", body: "b" })).toMatchObject({ ok: false });
    expect(await channel.send("owner", { title: 5 } as never)).toMatchObject({ ok: false });
    expect(() => channel.subscribe("", () => {})).toThrow(/in-app target/);
    expect(() => channel.subscribe("owner", "nope" as never)).toThrow(/listener function/);
  });
});

describe("InAppChannel.history", () => {
  it("lists the target's recorded in-app deliveries, without failed ones", async () => {
    const storage = createMemoryStorage();
    const channel = new InAppChannel({ storage });
    const registry = new ChannelRegistry().register(channel);
    await registry.deliver("inapp:owner", { title: "a", body: "first" }, { storage });
    await registry.deliver("inapp:owner", { title: "b", body: "second" }, { storage });
    await registry.deliver("inapp:someone", { title: "c", body: "other target" }, { storage });
    const failed = await storage.deliveries.add({ channel: "inapp", target: "owner", title: "x", body: "lost", url: null, jobId: null });
    await storage.deliveries.mark(failed.id, "failed", "nope");
    const history = await channel.history("owner");
    expect(history.map((row) => row.body).sort()).toEqual(["first", "second"]);
    expect(history.every((row) => row.status === "sent")).toBe(true);
  });

  it("needs storage", async () => {
    await expect(new InAppChannel().history("owner")).rejects.toThrow(/needs the storage option/);
  });
});

describe("InAppChannel.sseResponse", () => {
  it("is an event stream with no caching or proxy buffering", () => {
    const response = new InAppChannel().sseResponse("owner", { signal: new AbortController().signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });

  it("streams each new message as one data line of JSON", async () => {
    const channel = new InAppChannel({ now: fixedNow });
    const abort = new AbortController();
    const reader = sseReader(channel.sseResponse("owner", { signal: abort.signal }));
    expect(await reader.next()).toBe(": connected\n\n");
    await channel.send("owner", { title: "Hi", body: "Body" }, { jobId: "job-1" });
    const chunk = await reader.next();
    expect(chunk).toBe(
      `data: ${JSON.stringify({
        target: "owner",
        title: "Hi",
        body: "Body",
        url: null,
        tag: null,
        jobId: "job-1",
        at: "2026-11-05T07:30:00.000Z",
      })}\n\n`,
    );
    abort.abort();
  });

  it("cannot be tricked into extra events by newlines in a message", async () => {
    const channel = new InAppChannel();
    const abort = new AbortController();
    const reader = sseReader(channel.sseResponse("owner", { signal: abort.signal }));
    await reader.next(); // ": connected"
    const hostile = "line one\n\ndata: {\"title\":\"forged\"}\n\nevent: admin\r\nid: 9\r\rretry: 1";
    await channel.send("owner", { title: "t\n\nevent: x", body: hostile });
    const chunk = (await reader.next()) ?? "";
    const lines = chunk.split(/\r\n|\r|\n/);
    expect(lines.filter((line) => line !== "")).toHaveLength(1);
    expect(lines[0]?.startsWith("data: ")).toBe(true);
    expect(JSON.parse((lines[0] ?? "").slice("data: ".length)).body).toBe(hostile);
    abort.abort();
  });

  it("sends heartbeats", async () => {
    vi.useFakeTimers();
    const channel = new InAppChannel();
    const abort = new AbortController();
    const reader = sseReader(channel.sseResponse("owner", { signal: abort.signal, heartbeatMs: 1_000 }));
    expect(await reader.next()).toBe(": connected\n\n");
    vi.advanceTimersByTime(1_000);
    expect(await reader.next()).toBe(": ping\n\n");
    vi.advanceTimersByTime(1_000);
    expect(await reader.next()).toBe(": ping\n\n");
    abort.abort();
  });

  it("ends the stream and cleans up when the request is aborted", async () => {
    vi.useFakeTimers();
    const channel = new InAppChannel();
    const abort = new AbortController();
    const reader = sseReader(channel.sseResponse("owner", { signal: abort.signal, heartbeatMs: 1_000 }));
    await reader.next();
    expect(channel.listenerCount("owner")).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    abort.abort();
    expect(channel.listenerCount("owner")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await reader.next()).toBeNull();
    // Sending afterwards reaches nobody and does not throw.
    expect(await channel.send("owner", { title: "t", body: "b" })).toEqual({ ok: true, delivered: 0 });
  });

  it("cleans up when the client cancels the stream", async () => {
    vi.useFakeTimers();
    const channel = new InAppChannel();
    const reader = sseReader(channel.sseResponse("owner", { signal: new AbortController().signal }));
    await reader.next();
    await reader.cancel();
    expect(channel.listenerCount("owner")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes at once for a request that is already aborted", async () => {
    const channel = new InAppChannel();
    const abort = new AbortController();
    abort.abort();
    const reader = sseReader(channel.sseResponse("owner", { signal: abort.signal }));
    expect(await reader.next()).toBeNull();
    expect(channel.listenerCount("owner")).toBe(0);
  });

  it("disconnects a client that stops reading instead of buffering forever", async () => {
    const channel = new InAppChannel();
    const response = channel.sseResponse("owner", { signal: new AbortController().signal });
    for (let i = 0; i < 1_100; i++) await channel.send("owner", { title: "t", body: `message ${i}` });
    expect(channel.listenerCount("owner")).toBe(0);
    await response.body?.cancel();
  });

  it("checks its options", () => {
    const channel = new InAppChannel();
    expect(() => channel.sseResponse("owner", {} as never)).toThrow(/needs \{ signal \}/);
    expect(() => channel.sseResponse("owner", { signal: new AbortController().signal, heartbeatMs: 0 })).toThrow(
      /heartbeatMs/,
    );
    expect(() => channel.sseResponse("", { signal: new AbortController().signal })).toThrow(/in-app target/);
  });
});
