import { describe, expect, it, vi } from "vitest";
import { ChannelRegistry, DeliveryTargetError } from "../../../src/channels/channel.js";
import { InAppChannel } from "../../../src/channels/inapp.js";
import type { InAppEvent } from "../../../src/channels/inapp.js";
import { CronError } from "../../../src/scheduler/cron.js";
import { Scheduler, failureBackoffMs, scheduleJob } from "../../../src/scheduler/scheduler.js";
import type { JobRunContext, SchedulerOptions } from "../../../src/scheduler/scheduler.js";
import { createMemoryStorage } from "../../../src/storage/memory.js";
import type {
  AgentMode,
  Channel,
  DeliveryMessage,
  DeliveryResult,
  JobRecord,
  NewJob,
  PreStep,
  Storage,
} from "../../../src/types.js";

const AGENT = "agent-1";
const at = (iso: string): Date => new Date(iso);
const iso = (text: string): string => new Date(text).toISOString();

/** 07:30 every day in Stockholm: 06:30 UTC in November (CET). */
const BRIEF: NewJob = {
  agentId: AGENT,
  name: "Morning brief",
  schedule: "30 7 * * *",
  timeZone: "Europe/Stockholm",
  prompt: "Write the morning brief.",
  deliver: "inapp:owner",
};

class RecordingChannel implements Channel {
  readonly name: string;
  readonly sent: Array<{ target: string; message: DeliveryMessage }> = [];
  constructor(
    name: string,
    readonly answer: () => DeliveryResult = () => ({ ok: true, delivered: 1 }),
  ) {
    this.name = name;
  }
  async send(target: string, message: DeliveryMessage): Promise<DeliveryResult> {
    this.sent.push({ target, message });
    return this.answer();
  }
}

interface Harness {
  storage: Storage;
  channels: ChannelRegistry;
  inapp: InAppChannel;
  scheduler: Scheduler;
  runs: Array<{ job: JobRecord; ctx: JobRunContext }>;
  /** What the fake run answers; change it per test. */
  reply: (job: JobRecord, ctx: JobRunContext) => Promise<{ text: string }> | { text: string };
}

async function harness(options: Partial<SchedulerOptions> & { mode?: AgentMode } = {}): Promise<Harness> {
  const { mode = "supervised", ...schedulerOptions } = options;
  const storage = options.storage ?? createMemoryStorage();
  if (!(await storage.agents.get(AGENT))) await storage.agents.upsert({ id: AGENT, name: "Helper", mode });
  const inapp = new InAppChannel({ storage });
  const channels = new ChannelRegistry().register(inapp);
  const h: Harness = {
    storage,
    channels,
    inapp,
    runs: [],
    reply: (job) => ({ text: `Report for ${job.name}.` }),
    scheduler: undefined as unknown as Scheduler,
  };
  h.scheduler = new Scheduler({
    storage,
    channels,
    worker: "worker-a",
    runJob: async (job, ctx) => {
      h.runs.push({ job, ctx });
      return h.reply(job, ctx);
    },
    ...schedulerOptions,
  });
  return h;
}

async function job(storage: Storage, id: string): Promise<JobRecord> {
  const record = await storage.jobs.get(id);
  if (!record) throw new Error(`job ${id} not found`);
  return record;
}

describe("Scheduler.tick", () => {
  it("runs a due job once and gives it its next time in its own zone", async () => {
    const h = await harness();
    const scheduled = await scheduleJob(h.storage, BRIEF, at("2026-11-05T06:00:00Z"));
    expect(scheduled.nextRunAt).toBe(iso("2026-11-05T06:30:00Z")); // 07:30 CET
    const live: InAppEvent[] = [];
    h.inapp.subscribe("owner", (event) => live.push(event));

    expect((await h.scheduler.tick(at("2026-11-05T06:29:59Z"))).claimed).toBe(0);
    const report = await h.scheduler.tick(at("2026-11-05T06:30:10Z"));
    expect(report).toEqual({
      claimed: 1,
      ran: 1,
      silent: 0,
      skipped: 0,
      delivered: 1,
      failed: 0,
      jobs: [{ id: scheduled.id, name: "Morning brief", status: "ok" }],
    });
    expect(await job(h.storage, scheduled.id)).toMatchObject({
      lastRunAt: iso("2026-11-05T06:30:10Z"),
      lastStatus: "ok",
      lastError: null,
      failures: 0,
      nextRunAt: iso("2026-11-06T06:30:00Z"),
      lockedUntil: null,
      lockedBy: null,
    });
    expect((await h.scheduler.tick(at("2026-11-05T06:30:20Z"))).claimed).toBe(0);
    expect(h.runs).toHaveLength(1);

    const [run] = h.runs;
    expect(run?.ctx.attended).toBe(false);
    expect(run?.ctx.context).toBeUndefined();
    expect(run?.ctx.now.toISOString()).toBe(iso("2026-11-05T06:30:10Z"));
    expect(run?.ctx.signal.aborted).toBe(false);
    expect(await h.storage.deliveries.list({})).toEqual([
      expect.objectContaining({
        channel: "inapp",
        target: "owner",
        title: "Morning brief",
        body: "Report for Morning brief.",
        status: "sent",
        jobId: scheduled.id,
      }),
    ]);
    expect(live.map((event) => event.body)).toEqual(["Report for Morning brief."]);
  });

  it("computes next times in other zones too", async () => {
    const h = await harness();
    const ny = await scheduleJob(
      h.storage,
      { ...BRIEF, name: "NY", schedule: "0 9 * * 1-5", timeZone: "America/New_York" },
      at("2026-11-06T13:00:00Z"),
    );
    expect(ny.nextRunAt).toBe(iso("2026-11-06T14:00:00Z")); // Friday 09:00 EST
    await h.scheduler.tick(at("2026-11-06T14:00:00Z"));
    expect((await job(h.storage, ny.id)).nextRunAt).toBe(iso("2026-11-09T14:00:00Z")); // Monday
  });

  it("collapses runs missed while nothing was ticking into one", async () => {
    const h = await harness();
    const scheduled = await scheduleJob(h.storage, { ...BRIEF, schedule: "0 * * * *", timeZone: "UTC" }, at("2026-11-05T00:30Z"));
    const report = await h.scheduler.tick(at("2026-11-05T05:10Z"));
    expect(report.ran).toBe(1);
    expect((await job(h.storage, scheduled.id)).nextRunAt).toBe(iso("2026-11-05T06:00Z"));
  });

  it("never runs the same job twice when two schedulers tick at once", async () => {
    const storage = createMemoryStorage();
    await storage.agents.upsert({ id: AGENT, name: "Helper", mode: "autonomous" });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push((await scheduleJob(storage, { ...BRIEF, name: `Job ${i}` }, at("2026-11-05T06:00Z"))).id);
    }
    const runsPerJob = new Map<string, number>();
    const channels = new ChannelRegistry().register(new InAppChannel());
    const make = (worker: string) =>
      new Scheduler({
        storage,
        channels,
        worker,
        runJob: async (j) => {
          runsPerJob.set(j.id, (runsPerJob.get(j.id) ?? 0) + 1);
          await new Promise((resolve) => setTimeout(resolve, 2)); // let the other scheduler interleave
          return { text: "done" };
        },
      });
    const [a, b] = [make("worker-a"), make("worker-b")];
    const now = at("2026-11-05T06:30:00Z");
    const [ra, rb] = await Promise.all([a.tick(now), b.tick(now)]);
    expect(ra.claimed + rb.claimed).toBe(6);
    expect(ra.claimed).toBeGreaterThan(0);
    expect(rb.claimed).toBeGreaterThan(0);
    expect(ids.map((id) => runsPerJob.get(id))).toEqual([1, 1, 1, 1, 1, 1]);
    expect(await storage.deliveries.list({})).toHaveLength(6);
    const again = await Promise.all([a.tick(now), b.tick(now)]);
    expect(again.map((r) => r.claimed)).toEqual([0, 0]);
  });

  it("does not let a second scheduler take a job whose run is still in progress", async () => {
    const storage = createMemoryStorage();
    await storage.agents.upsert({ id: AGENT, name: "Helper", mode: "autonomous" });
    await scheduleJob(storage, BRIEF, at("2026-11-05T06:00Z"));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const channels = new ChannelRegistry().register(new InAppChannel());
    const slow = new Scheduler({
      storage,
      channels,
      worker: "slow",
      runJob: async () => {
        runs += 1;
        await gate;
        return { text: "done" };
      },
    });
    const other = new Scheduler({ storage, channels, worker: "other", runJob: async () => ({ text: "twice!" }) });
    const now = at("2026-11-05T06:30:00Z");
    const first = slow.tick(now);
    await vi.waitFor(() => expect(runs).toBe(1));
    expect((await other.tick(now)).claimed).toBe(0);
    release();
    expect((await first).ran).toBe(1);
    expect(runs).toBe(1);
  });

  it("skips jobs of an agent that is off: no pre-step, no run, no delivery", async () => {
    const preStep = vi.fn<PreStep>(async () => "context");
    const h = await harness({ mode: "off", preSteps: { "inbox-check": preStep } });
    const scheduled = await scheduleJob(h.storage, { ...BRIEF, preStep: "inbox-check" }, at("2026-11-05T06:00Z"));
    const report = await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect(report).toMatchObject({ claimed: 1, ran: 0, skipped: 1, delivered: 0, failed: 0 });
    expect(report.jobs).toEqual([{ id: scheduled.id, name: "Morning brief", status: "skipped" }]);
    expect(h.runs).toHaveLength(0);
    expect(preStep).not.toHaveBeenCalled();
    expect(await h.storage.deliveries.list({})).toEqual([]);
    expect(await job(h.storage, scheduled.id)).toMatchObject({
      lastStatus: "skipped",
      failures: 0,
      nextRunAt: iso("2026-11-06T06:30Z"),
    });
  });

  it("delivers nothing for [SILENT]", async () => {
    const h = await harness();
    const scheduled = await scheduleJob(h.storage, BRIEF, at("2026-11-05T06:00Z"));
    const live = vi.fn();
    h.inapp.subscribe("owner", live);
    h.reply = () => ({ text: "  [SILENT]\n" });
    const report = await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect(report).toMatchObject({ ran: 1, silent: 1, delivered: 0, failed: 0 });
    expect(report.jobs[0]?.status).toBe("silent");
    expect(await h.storage.deliveries.list({})).toEqual([]);
    expect(live).not.toHaveBeenCalled();
    expect(await job(h.storage, scheduled.id)).toMatchObject({ lastStatus: "silent", nextRunAt: iso("2026-11-06T06:30Z") });
  });

  it("delivers text that only mentions [SILENT]", async () => {
    const h = await harness();
    await scheduleJob(h.storage, BRIEF, at("2026-11-05T06:00Z"));
    h.reply = () => ({ text: "Nothing new. [SILENT]" });
    expect((await h.scheduler.tick(at("2026-11-05T06:30Z"))).delivered).toBe(1);
    expect((await h.storage.deliveries.list({}))[0]?.body).toBe("Nothing new. [SILENT]");
  });

  it("skips the run when the pre-step says there is nothing to do", async () => {
    const h = await harness({ preSteps: { "inbox-check": async () => null } });
    const scheduled = await scheduleJob(h.storage, { ...BRIEF, preStep: "inbox-check" }, at("2026-11-05T06:00Z"));
    const report = await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect(report).toMatchObject({ ran: 0, skipped: 1 });
    expect(h.runs).toHaveLength(0);
    expect((await job(h.storage, scheduled.id)).lastStatus).toBe("skipped");
  });

  it("passes the pre-step's text to the run as context", async () => {
    const seen: Array<Parameters<PreStep>[0]> = [];
    const h = await harness({
      preSteps: {
        "inbox-check": async (ctx) => {
          seen.push(ctx);
          return "3 new e-mails";
        },
      },
    });
    const scheduled = await scheduleJob(h.storage, { ...BRIEF, preStep: "inbox-check" }, at("2026-11-05T06:00Z"));
    await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect(h.runs[0]?.ctx.context).toBe("3 new e-mails");
    expect(seen[0]?.job.id).toBe(scheduled.id);
    expect(seen[0]?.now.toISOString()).toBe(iso("2026-11-05T06:30Z"));
    expect(seen[0]?.storage).toBe(h.storage);
  });

  it("fails a job whose pre-step is not registered, without running it", async () => {
    for (const name of ["missing", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const h = await harness({ preSteps: { "inbox-check": async () => "x" } });
      const scheduled = await scheduleJob(h.storage, { ...BRIEF, preStep: name }, at("2026-11-05T06:00Z"));
      const report = await h.scheduler.tick(at("2026-11-05T06:30Z"));
      expect(report.jobs[0]).toEqual({
        id: scheduled.id,
        name: "Morning brief",
        status: "error",
        error: `Pre-step ${JSON.stringify(name)} is not registered.`,
      });
      expect(h.runs).toHaveLength(0);
      expect((await job(h.storage, scheduled.id)).failures).toBe(1);
    }
  });

  it("fails a job whose pre-step throws or returns something other than text", async () => {
    const h = await harness({
      preSteps: {
        broken: async () => {
          throw new Error("mailbox unreachable");
        },
        weird: (async () => 42) as unknown as PreStep,
      },
    });
    const a = await scheduleJob(h.storage, { ...BRIEF, name: "A", preStep: "broken" }, at("2026-11-05T06:00Z"));
    const b = await scheduleJob(h.storage, { ...BRIEF, name: "B", preStep: "weird" }, at("2026-11-05T06:00Z"));
    await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect((await job(h.storage, a.id)).lastError).toBe('Pre-step "broken" failed: mailbox unreachable');
    expect((await job(h.storage, b.id)).lastError).toBe('Pre-step "weird" must return text or null, not number.');
    expect(h.runs).toHaveLength(0);
  });

  it("resolves the delivery target when the job fires", async () => {
    const h = await harness();
    // "alerts" is not registered yet: scheduling checks only the form of the target.
    const scheduled = await scheduleJob(h.storage, { ...BRIEF, deliver: "alerts:owner" }, at("2026-11-05T06:00Z"));
    const first = new RecordingChannel("alerts");
    h.channels.register(first);
    await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect(first.sent).toEqual([{ target: "owner", message: { title: "Morning brief", body: "Report for Morning brief." } }]);

    h.channels.unregister("alerts");
    const second = new RecordingChannel("alerts");
    h.channels.register(second);
    await h.scheduler.tick(at("2026-11-06T06:30Z"));
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);

    h.channels.unregister("alerts");
    const report = await h.scheduler.tick(at("2026-11-07T06:30Z"));
    expect(report.jobs[0]?.status).toBe("error");
    expect(report.jobs[0]?.error).toMatch(/^The delivery target cannot be used: Unknown delivery channel "alerts"/);
    expect(h.runs).toHaveLength(2); // no run is wasted on a target that cannot be reached
    expect((await job(h.storage, scheduled.id)).failures).toBe(1);
  });

  it("records a failed delivery as an error", async () => {
    const h = await harness();
    h.channels.register(new RecordingChannel("push", () => ({ ok: false, delivered: 0, error: "No push subscriptions." })));
    const scheduled = await scheduleJob(h.storage, { ...BRIEF, deliver: "push:owner" }, at("2026-11-05T06:00Z"));
    const report = await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect(report).toMatchObject({ ran: 1, delivered: 0, failed: 1 });
    expect((await job(h.storage, scheduled.id)).lastError).toBe('Delivery to "push:owner" failed: No push subscriptions.');
  });

  it("backs off a failing job (1, 2, 4 … 60 minutes) and records a redacted error", async () => {
    const key = `sk-ant-api03-${"a".repeat(40)}`;
    const h = await harness();
    h.reply = () => {
      throw new Error(`Upstream rejected key ${key} (401)`);
    };
    const every = { ...BRIEF, schedule: "* * * * *", timeZone: "UTC" };
    const scheduled = await scheduleJob(h.storage, every, at("2026-11-05T09:59:30Z"));
    expect(scheduled.nextRunAt).toBe(iso("2026-11-05T10:00Z"));
    const expected: Array<[string, number, string]> = [
      ["2026-11-05T10:00Z", 1, "2026-11-05T10:01Z"],
      ["2026-11-05T10:01Z", 2, "2026-11-05T10:03Z"],
      ["2026-11-05T10:03Z", 3, "2026-11-05T10:07Z"],
      ["2026-11-05T10:07Z", 4, "2026-11-05T10:15Z"],
      ["2026-11-05T10:15Z", 5, "2026-11-05T10:31Z"],
      ["2026-11-05T10:31Z", 6, "2026-11-05T11:03Z"],
      ["2026-11-05T11:03Z", 7, "2026-11-05T12:03Z"],
      ["2026-11-05T12:03Z", 8, "2026-11-05T13:03Z"],
    ];
    for (const [now, failures, next] of expected) {
      expect((await h.scheduler.tick(at(now))).failed).toBe(1);
      const record = await job(h.storage, scheduled.id);
      expect([record.failures, record.nextRunAt]).toEqual([failures, iso(next)]);
      // Not due again before the backoff ends.
      expect((await h.scheduler.tick(new Date(new Date(next).getTime() - 1))).claimed).toBe(0);
    }
    const failed = await job(h.storage, scheduled.id);
    expect(failed.lastStatus).toBe("error");
    expect(failed.lastError).toMatch(/^The run failed: Upstream rejected key .*\(401\)$/);
    expect(failed.lastError).not.toContain(key);

    h.reply = () => ({ text: "Back to normal." });
    await h.scheduler.tick(at("2026-11-05T13:03Z"));
    expect(await job(h.storage, scheduled.id)).toMatchObject({
      lastStatus: "ok",
      lastError: null,
      failures: 0,
      nextRunAt: iso("2026-11-05T13:04Z"),
    });
  });

  it("keeps the cron time when it is later than the backoff", async () => {
    const h = await harness();
    h.reply = () => {
      throw new Error("boom");
    };
    const scheduled = await scheduleJob(h.storage, BRIEF, at("2026-11-05T06:00Z"));
    const report = await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect(report.jobs[0]).toMatchObject({ status: "error", error: "The run failed: boom" });
    expect((await job(h.storage, scheduled.id)).nextRunAt).toBe(iso("2026-11-06T06:30Z"));
  });

  it("uses a custom redactor for stored errors", async () => {
    const h = await harness({ redact: (text) => text.replaceAll("hunter2", "[gone]") });
    h.reply = () => {
      throw new Error("password hunter2 rejected");
    };
    const scheduled = await scheduleJob(h.storage, BRIEF, at("2026-11-05T06:00Z"));
    await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect((await job(h.storage, scheduled.id)).lastError).toBe("The run failed: password [gone] rejected");
  });

  it("never runs a disabled job", async () => {
    const h = await harness();
    const off = await scheduleJob(h.storage, { ...BRIEF, name: "Off", enabled: false }, at("2026-11-05T06:00Z"));
    const later = await scheduleJob(h.storage, { ...BRIEF, name: "Later" }, at("2026-11-05T06:00Z"));
    await h.storage.jobs.setEnabled(later.id, false);
    expect((await h.scheduler.tick(at("2026-11-05T06:30Z"))).claimed).toBe(0);
    expect((await h.scheduler.tick(at("2026-11-08T06:30Z"))).claimed).toBe(0);
    expect(h.runs).toHaveLength(0);
    expect((await job(h.storage, off.id)).lastRunAt).toBeNull();
    await h.storage.jobs.setEnabled(later.id, true);
    expect((await h.scheduler.tick(at("2026-11-08T06:30Z"))).ran).toBe(1);
  });

  it("does not run a disabled job even if an adapter hands it out", async () => {
    const memory = createMemoryStorage();
    const storage: Storage = {
      ...memory,
      jobs: {
        ...memory.jobs,
        claimDue: async (now, options) => {
          const claimed = await memory.jobs.claimDue(now, options);
          return claimed.map((j) => ({ ...j, enabled: false }));
        },
      },
    };
    const h = await harness({ storage });
    await scheduleJob(storage, BRIEF, at("2026-11-05T06:00Z"));
    expect((await h.scheduler.tick(at("2026-11-05T06:30Z"))).skipped).toBe(1);
    expect(h.runs).toHaveLength(0);
  });

  it("parks a job whose stored schedule or time zone is broken", async () => {
    const h = await harness();
    const badCron = await h.storage.jobs.upsert({ ...BRIEF, name: "Bad cron", schedule: "61 * * * *", nextRunAt: iso("2026-11-05T06:00Z") });
    const badZone = await h.storage.jobs.upsert({ ...BRIEF, name: "Bad zone", timeZone: "Mars/Olympus", nextRunAt: iso("2026-11-05T06:00Z") });
    const report = await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect(report.failed).toBe(2);
    expect(h.runs).toHaveLength(0);
    expect(await job(h.storage, badCron.id)).toMatchObject({ lastStatus: "error", nextRunAt: null, failures: 1 });
    expect((await job(h.storage, badCron.id)).lastError).toMatch(/^The job's schedule cannot be used: Invalid cron expression/);
    expect((await job(h.storage, badZone.id)).lastError).toMatch(/Unknown time zone "Mars\/Olympus"/);
    expect((await h.scheduler.tick(at("2026-11-09T06:30Z"))).claimed).toBe(0);
  });

  it("fails a job whose agent does not exist", async () => {
    const h = await harness();
    const scheduled = await scheduleJob(h.storage, { ...BRIEF, agentId: "ghost" }, at("2026-11-05T06:00Z"));
    await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect((await job(h.storage, scheduled.id)).lastError).toBe('The job\'s agent "ghost" does not exist.');
    expect(h.runs).toHaveLength(0);
  });

  it("fails a run without text and does not deliver empty text", async () => {
    const answers: unknown[] = [{ text: "   " }, {}, null, { text: 5 }];
    for (const answer of answers) {
      const h = await harness();
      h.reply = () => answer as { text: string };
      const scheduled = await scheduleJob(h.storage, BRIEF, at("2026-11-05T06:00Z"));
      const report = await h.scheduler.tick(at("2026-11-05T06:30Z"));
      expect(report).toMatchObject({ ran: 1, delivered: 0, failed: 1 });
      expect((await job(h.storage, scheduled.id)).lastError).toMatch(/^The run returned (no|empty) text/);
      expect(await h.storage.deliveries.list({})).toEqual([]);
    }
  });

  it("gives the run a copy of the job, so the run cannot redirect its delivery", async () => {
    const h = await harness();
    const attacker = new RecordingChannel("evil");
    h.channels.register(attacker);
    h.reply = (j) => {
      j.deliver = "evil:attacker";
      return { text: "hello" };
    };
    await scheduleJob(h.storage, BRIEF, at("2026-11-05T06:00Z"));
    await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect(attacker.sent).toHaveLength(0);
    expect((await h.storage.deliveries.list({}))[0]).toMatchObject({ channel: "inapp", target: "owner" });
  });

  it("does not deliver output that arrives after the lease ran out", async () => {
    const h = await harness({ leaseMs: 30 });
    h.reply = async (_job, ctx) => {
      await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
      return { text: "too late" };
    };
    const scheduled = await scheduleJob(h.storage, BRIEF, at("2026-11-05T06:00Z"));
    const report = await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect(h.runs[0]?.ctx.signal.aborted).toBe(true);
    expect(report).toMatchObject({ ran: 1, delivered: 0, failed: 1 });
    expect((await job(h.storage, scheduled.id)).lastError).toMatch(/took longer than the job's lease \(30 ms\)/);
    expect(await h.storage.deliveries.list({})).toEqual([]);
  });

  it("uses formatMessage for the delivered message", async () => {
    const h = await harness({
      formatMessage: (j, text) => ({ title: `${j.name} (Hermod)`, body: text.toUpperCase(), url: "/jobs", tag: j.id }),
    });
    const scheduled = await scheduleJob(h.storage, BRIEF, at("2026-11-05T06:00Z"));
    await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect((await h.storage.deliveries.list({}))[0]).toMatchObject({
      title: "Morning brief (Hermod)",
      body: "REPORT FOR MORNING BRIEF.",
      url: "/jobs",
      jobId: scheduled.id,
    });
  });

  it("caps the jobs per tick and leaves the rest for the next tick", async () => {
    const h = await harness({ maxJobsPerTick: 2 });
    for (const name of ["A", "B", "C"]) await scheduleJob(h.storage, { ...BRIEF, name }, at("2026-11-05T06:00Z"));
    expect((await h.scheduler.tick(at("2026-11-05T06:30Z"))).claimed).toBe(2);
    expect((await h.scheduler.tick(at("2026-11-05T06:30Z"))).claimed).toBe(1);
  });

  it("uses its clock when tick() gets no time", async () => {
    const h = await harness({ now: () => at("2026-11-05T06:30:05Z") });
    const scheduled = await scheduleJob(h.storage, BRIEF, at("2026-11-05T06:00Z"));
    expect((await h.scheduler.tick()).ran).toBe(1);
    expect((await job(h.storage, scheduled.id)).lastRunAt).toBe(iso("2026-11-05T06:30:05Z"));
  });

  it("reports a job whose outcome could not be saved", async () => {
    const memory = createMemoryStorage();
    const storage: Storage = {
      ...memory,
      jobs: {
        ...memory.jobs,
        finish: async () => {
          throw new Error("disk full");
        },
      },
    };
    const h = await harness({ storage });
    await scheduleJob(storage, BRIEF, at("2026-11-05T06:00Z"));
    const report = await h.scheduler.tick(at("2026-11-05T06:30Z"));
    expect(report).toMatchObject({ claimed: 1, ran: 1, delivered: 1, failed: 1 });
    expect(report.jobs[0]).toMatchObject({ status: "error", error: "The job's outcome could not be saved: disk full" });
  });

  it("checks its options", () => {
    const storage = createMemoryStorage();
    const channels = new ChannelRegistry();
    const runJob = async () => ({ text: "x" });
    expect(() => new Scheduler({} as SchedulerOptions)).toThrow(/needs \{ storage \}/);
    expect(() => new Scheduler({ storage, runJob } as unknown as SchedulerOptions)).toThrow(/needs \{ channels \}/);
    expect(() => new Scheduler({ storage, channels } as unknown as SchedulerOptions)).toThrow(/needs \{ runJob \}/);
    expect(() => new Scheduler({ storage, channels, runJob, leaseMs: 0 })).toThrow(/leaseMs/);
    expect(() => new Scheduler({ storage, channels, runJob, maxJobsPerTick: 0 })).toThrow(/maxJobsPerTick/);
    expect(() => new Scheduler({ storage, channels, runJob, worker: " " })).toThrow(/worker/);
    expect(() => new Scheduler({ storage, channels, runJob, preSteps: { x: "code" as unknown as PreStep } })).toThrow(
      /pre-step "x" must be a function/,
    );
    const scheduler = new Scheduler({ storage, channels, runJob });
    expect(scheduler.worker).toMatch(/^scheduler-[0-9a-f-]{36}$/);
    expect(new Scheduler({ storage, channels, runJob }).worker).not.toBe(scheduler.worker);
    return expect(scheduler.tick(new Date("nope"))).rejects.toThrow(/valid Date/);
  });
});

describe("failureBackoffMs", () => {
  it("doubles from one minute up to an hour", () => {
    const minutes = [1, 2, 3, 4, 5, 6, 7, 8, 1_000].map((n) => failureBackoffMs(n) / 60_000);
    expect(minutes).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
    expect([0, -1, Number.NaN].map(failureBackoffMs)).toEqual([0, 0, 0]);
  });
});

describe("scheduleJob", () => {
  it("computes the first run in the job's zone", async () => {
    const storage = createMemoryStorage();
    const created = await scheduleJob(storage, BRIEF, at("2026-07-01T12:00Z"));
    expect(created.nextRunAt).toBe(iso("2026-07-02T05:30Z")); // 07:30 CEST
    expect(created).toMatchObject({ enabled: true, failures: 0, lastStatus: null });
  });

  it("rejects a bad schedule, time zone, target or pre-step name", async () => {
    const storage = createMemoryStorage();
    const now = at("2026-11-05T06:00Z");
    await expect(scheduleJob(storage, { ...BRIEF, schedule: "0 0 30 2 *" }, now)).rejects.toThrow(CronError);
    await expect(scheduleJob(storage, { ...BRIEF, timeZone: "Nowhere/City" }, now)).rejects.toThrow(/Unknown time zone/);
    await expect(scheduleJob(storage, { ...BRIEF, deliver: "owner" }, now)).rejects.toThrow(DeliveryTargetError);
    await expect(scheduleJob(storage, { ...BRIEF, preStep: " " }, now)).rejects.toThrow(/preStep/);
    expect(await storage.jobs.list()).toEqual([]);
  });

  it("keeps the next run when an unchanged job is scheduled again, and recomputes it when the schedule changes", async () => {
    const storage = createMemoryStorage();
    const first = await scheduleJob(storage, BRIEF, at("2026-11-05T06:00Z"));
    const again = await scheduleJob(storage, { ...BRIEF, prompt: "A new prompt." }, at("2026-11-05T12:00Z"));
    expect(again.id).toBe(first.id);
    expect(again.nextRunAt).toBe(iso("2026-11-05T06:30Z")); // still due: a restart neither skips nor repeats it
    const moved = await scheduleJob(storage, { ...BRIEF, schedule: "0 8 * * *" }, at("2026-11-05T12:00Z"));
    expect(moved.nextRunAt).toBe(iso("2026-11-06T07:00Z"));
  });

  it("uses an explicit nextRunAt", async () => {
    const storage = createMemoryStorage();
    const now = at("2026-11-05T06:00Z");
    expect((await scheduleJob(storage, { ...BRIEF, nextRunAt: iso("2026-11-05T06:01Z") }, now)).nextRunAt).toBe(
      iso("2026-11-05T06:01Z"),
    );
  });
});
