/**
 * Review fixes in the scheduler and the channels (STORE block):
 * - C1: a scheduler whose lease ran out and was taken over never releases the other scheduler's lease (jobs.finish
 *   is checked against the worker id), so the same job never runs twice at once.
 * - C3: the scheduler and the channel registry redact with secretsRedactor by default (Stripe, Supabase, Google keys
 *   and JSON password fields too), not a narrower stand-in.
 * - C4: the next run and the failure backoff count from the end of the run, so a slow job is not due again at once
 *   and one tick never re-runs a slow failing job back to back.
 */
import { describe, expect, it, vi } from "vitest";
import { ChannelRegistry } from "../../../src/channels/channel.js";
import { InAppChannel } from "../../../src/channels/inapp.js";
import * as channelUtil from "../../../src/channels/util.js";
import { Scheduler, scheduleJob } from "../../../src/scheduler/scheduler.js";
import { createMemoryStorage } from "../../../src/storage/memory.js";
import type { Channel, DeliveryMessage, DeliveryResult, NewJob, Storage } from "../../../src/types.js";
import { chars, fake } from "../safety/fakes.js";

const AGENT = "agent-1";
const at = (text: string): Date => new Date(text);
const iso = (text: string): string => new Date(text).toISOString();
const MIN = 60_000;

const EVERY_MINUTE: NewJob = {
  agentId: AGENT,
  name: "Every minute",
  schedule: "* * * * *",
  timeZone: "UTC",
  prompt: "Check.",
  deliver: "inapp:owner",
};

async function storageWithAgent(): Promise<Storage> {
  const storage = createMemoryStorage();
  await storage.agents.upsert({ id: AGENT, name: "Helper", mode: "autonomous" });
  return storage;
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Secrets the old stand-in redactor missed, built at runtime (none is real). */
function missedSecrets(): Array<[string, string]> {
  const password = fake.password();
  return [
    ["stripe", fake.stripe("sk_live")],
    ["stripe-restricted", fake.stripe("rk_live")],
    ["supabase-access", fake.supabaseAccess()],
    ["supabase-secret", ["sb", "secret", chars(32, 41)].join("_")],
    ["google", fake.google()],
    ["json-password", password],
  ];
}

function errorWith(name: string, secret: string): string {
  return name === "json-password" ? `bad config {"password": "${secret}", "user": "app"}` : `rejected ${secret} (401)`;
}

describe("C1: a scheduler that lost its lease never releases the lease another scheduler holds", () => {
  it("the late scheduler saves nothing, the job stays leased to the new holder, and no third scheduler runs it", async () => {
    const storage = await storageWithAgent();
    const job = await scheduleJob(storage, EVERY_MINUTE, at("2026-11-06T09:59:30Z"));
    const channels = new ChannelRegistry().register(new InAppChannel({ storage }));
    const runs: string[] = [];
    const aGate = gate();
    const bGate = gate();
    const make = (worker: string, leaseMs: number, hold: Promise<void>) =>
      new Scheduler({
        storage,
        channels,
        worker,
        leaseMs,
        runJob: async () => {
          runs.push(worker);
          await hold;
          return { text: `done by ${worker}` };
        },
      });
    const a = make("A", 30, aGate.wait);
    const b = make("B", 60 * MIN, bGate.wait);
    const c = make("C", 60 * MIN, Promise.resolve());

    const aTick = a.tick(at("2026-11-06T10:00:00Z"));
    await vi.waitFor(() => expect(runs).toEqual(["A"]));
    // A's lease (30 ms from 10:00) has run out by 10:01: B claims the job and starts running it.
    const bTick = b.tick(at("2026-11-06T10:01:00Z"));
    await vi.waitFor(() => expect(runs).toEqual(["A", "B"]));
    await new Promise((resolve) => setTimeout(resolve, 40)); // A's lease is over in real time too
    aGate.open();
    const aReport = await aTick;
    expect(aReport.jobs).toHaveLength(1);
    expect(aReport.jobs[0]?.status).toBe("error");
    expect(aReport.jobs[0]?.error).toMatch(/lease \(30 ms\) was lost before its outcome was saved/);
    // B still holds the job; A's outcome was not written over it.
    expect(await storage.jobs.get(job.id)).toMatchObject({ lockedBy: "B", lastStatus: null, failures: 0 });
    // A third scheduler cannot take the job while B's run is still in progress.
    expect((await c.tick(at("2026-11-06T10:02:00Z"))).claimed).toBe(0);
    expect(runs).toEqual(["A", "B"]);

    bGate.open();
    const bReport = await bTick;
    expect(bReport).toMatchObject({ ran: 1, delivered: 1, failed: 0 });
    expect(await storage.jobs.get(job.id)).toMatchObject({ lockedBy: null, lastStatus: "ok", failures: 0 });
    // A delivered nothing (its output came after its lease); only B's output went out.
    expect((await storage.deliveries.list({})).map((d) => d.body)).toEqual(["done by B"]);
  });

  it("the scheduler passes its own worker id to jobs.finish", async () => {
    const memory = await storageWithAgent();
    const finished: unknown[][] = [];
    const storage: Storage = {
      ...memory,
      jobs: {
        ...memory.jobs,
        finish: async (...args) => {
          finished.push(args);
          return memory.jobs.finish(...args);
        },
      },
    };
    await scheduleJob(storage, EVERY_MINUTE, at("2026-11-06T09:59:30Z"));
    const scheduler = new Scheduler({
      storage,
      channels: new ChannelRegistry().register(new InAppChannel({ storage })),
      worker: "worker-7",
      runJob: async () => ({ text: "ok" }),
    });
    expect(await scheduler.tick(at("2026-11-06T10:00:00Z"))).toMatchObject({ ran: 1, delivered: 1, failed: 0 });
    expect(finished).toHaveLength(1);
    expect(finished[0]?.[2]).toBe("worker-7");
  });
});

describe("C3: secretsRedactor is the default redactor of the scheduler and the channel registry", () => {
  it("the stand-in redactor is gone from the channel helpers", () => {
    expect(Object.keys(channelUtil)).not.toContain("defaultRedactor");
  });

  it("the scheduler hides Stripe, Supabase and Google keys and JSON passwords in the stored error", async () => {
    for (const [name, secret] of missedSecrets()) {
      const storage = await storageWithAgent();
      const job = await scheduleJob(storage, EVERY_MINUTE, at("2026-11-06T09:59:30Z"));
      const scheduler = new Scheduler({
        storage,
        channels: new ChannelRegistry().register(new InAppChannel({ storage })),
        runJob: async () => {
          throw new Error(errorWith(name, secret));
        },
      });
      const report = await scheduler.tick(at("2026-11-06T10:00:00Z"));
      const stored = (await storage.jobs.get(job.id))?.lastError ?? "";
      expect(stored, name).toMatch(/^The run failed: /);
      expect(stored, name).toContain("[REDACTED:");
      expect(stored, name).not.toContain(secret);
      expect(report.jobs[0]?.error, name).toBe(stored);
    }
  });

  it("the channel registry hides them in the stored and returned delivery error", async () => {
    const message: DeliveryMessage = { title: "Hi", body: "Hello" };
    for (const [name, secret] of missedSecrets()) {
      const storage = createMemoryStorage();
      const failing: Channel = {
        name: "inapp",
        send: async (): Promise<DeliveryResult> => ({ ok: false, delivered: 0, error: errorWith(name, secret) }),
      };
      const result = await new ChannelRegistry().register(failing).deliver("inapp:owner", message, { storage });
      const [row] = await storage.deliveries.list({});
      expect(result.error, name).toContain("[REDACTED:");
      expect(result.error, name).not.toContain(secret);
      expect(row?.error, name).toBe(result.error);
    }
  });
});

describe("C4: the next run and the backoff count from the end of the run", () => {
  it("one tick runs a slow failing job once, and its retry starts after the run ended", async () => {
    const storage = await storageWithAgent();
    await storage.jobs.upsert({ ...EVERY_MINUTE, nextRunAt: iso("2026-11-06T10:00:00Z") });
    let clock = Date.parse("2026-11-06T10:00:00Z");
    let runs = 0;
    const scheduler = new Scheduler({
      storage,
      channels: new ChannelRegistry().register(new InAppChannel({ storage })),
      now: () => new Date(clock),
      leaseMs: 60 * MIN,
      runJob: async () => {
        runs += 1;
        clock += 6 * MIN; // each paid run takes 6 minutes and then fails (a timeout, say)
        throw new Error("upstream timed out");
      },
    });
    const report = await scheduler.tick();
    expect(runs).toBe(1);
    expect(report).toMatchObject({ claimed: 1, ran: 1, failed: 1 });
    const [job] = await storage.jobs.list();
    // Ended 10:06; the 1-minute backoff and the next cron minute both count from then.
    expect(job).toMatchObject({ failures: 1, lastRunAt: iso("2026-11-06T10:00:00Z"), nextRunAt: iso("2026-11-06T10:07:00Z") });
    expect((await scheduler.tick()).claimed).toBe(0); // 10:06: not due again yet

    clock = Date.parse("2026-11-06T10:07:00Z");
    await scheduler.tick();
    expect(runs).toBe(2);
    // Second failure: 2 minutes of backoff from 10:13, when the run ended.
    expect((await storage.jobs.list())[0]).toMatchObject({ failures: 2, nextRunAt: iso("2026-11-06T10:15:00Z") });
  });

  it("a successful run that outlasts its interval is not due again at once", async () => {
    const storage = await storageWithAgent();
    await storage.jobs.upsert({ ...EVERY_MINUTE, schedule: "*/5 * * * *", nextRunAt: iso("2026-11-06T10:00:00Z") });
    let clock = Date.parse("2026-11-06T10:00:00Z");
    let runs = 0;
    const scheduler = new Scheduler({
      storage,
      channels: new ChannelRegistry().register(new InAppChannel({ storage })),
      now: () => new Date(clock),
      leaseMs: 60 * MIN,
      runJob: async () => {
        runs += 1;
        clock += 7 * MIN;
        return { text: "slow but fine" };
      },
    });
    expect((await scheduler.tick()).ran).toBe(1);
    expect(runs).toBe(1);
    expect((await storage.jobs.list())[0]).toMatchObject({ lastStatus: "ok", nextRunAt: iso("2026-11-06T10:10:00Z") });
  });

  it("with an explicit tick time, the run's duration by the scheduler's clock is added; a quick run keeps exact times", async () => {
    const storage = await storageWithAgent();
    const job = await storage.jobs.upsert({ ...EVERY_MINUTE, nextRunAt: iso("2026-11-06T10:00:00Z") });
    let clock = Date.parse("2026-11-06T12:00:00Z"); // the clock and the tick time need not agree
    let took = 0;
    const scheduler = new Scheduler({
      storage,
      channels: new ChannelRegistry().register(new InAppChannel({ storage })),
      now: () => new Date(clock),
      leaseMs: 60 * MIN,
      runJob: async () => {
        clock += took;
        throw new Error("boom");
      },
    });
    took = 999; // under a second: no shift at all
    await scheduler.tick(at("2026-11-06T10:00:00Z"));
    expect(await storage.jobs.get(job.id)).toMatchObject({ failures: 1, nextRunAt: iso("2026-11-06T10:01:00Z") });
    took = 4 * MIN + 30_000;
    await scheduler.tick(at("2026-11-06T10:01:00Z"));
    // Ended 10:05:30; 2 minutes of backoff → 10:07:30, later than the next cron minute (10:06).
    expect(await storage.jobs.get(job.id)).toMatchObject({
      failures: 2,
      lastRunAt: iso("2026-11-06T10:01:00Z"),
      nextRunAt: iso("2026-11-06T10:07:30Z"),
    });
    took = -10 * MIN; // a clock that jumps back never moves the times before the tick
    await scheduler.tick(at("2026-11-06T10:07:30Z"));
    expect(await storage.jobs.get(job.id)).toMatchObject({ failures: 3, nextRunAt: iso("2026-11-06T10:11:30Z") });
  });

  it("a clock that fails while measuring the run does not lose the outcome", async () => {
    const storage = await storageWithAgent();
    const job = await storage.jobs.upsert({ ...EVERY_MINUTE, nextRunAt: iso("2026-11-06T10:00:00Z") });
    let broken = false;
    const scheduler = new Scheduler({
      storage,
      channels: new ChannelRegistry().register(new InAppChannel({ storage })),
      now: () => (broken ? new Date(Number.NaN) : at("2026-11-06T10:00:00Z")),
      runJob: async () => {
        broken = true;
        return { text: "fine" };
      },
    });
    expect((await scheduler.tick(at("2026-11-06T10:00:00Z"))).delivered).toBe(1);
    expect(await storage.jobs.get(job.id)).toMatchObject({ lastStatus: "ok", nextRunAt: iso("2026-11-06T10:01:00Z"), lockedBy: null });
  });
});
