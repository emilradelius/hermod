/**
 * The job scheduler: `tick()` claims due jobs with a lease, runs each one unattended, delivers its text and sets
 * the next run time.
 *
 * For each due job (claimed one at a time, so each lease starts when that job starts):
 * 1. Its schedule and time zone must be valid; otherwise it is an error and the job is parked (nextRunAt null)
 *    until someone fixes it.
 * 2. Its agent must exist. An agent in mode "off" → skipped: no pre-step, no run, no API call.
 * 3. Its delivery target must resolve now (fire time), so a misconfigured target costs no run.
 * 4. Its pre-step, if it names one, is looked up among the registered functions (never code from the job record):
 *    not registered → error; returns null → skipped (nothing to do); returns text → context for the run.
 * 5. `runJob(job, { context, attended: false, now, signal })` is the app's function. It MUST start a fresh session
 *    (no history) with the memory snapshot and the job's skills, a tool registry without scheduling, delegation or
 *    messaging, and deny-by-default approvals. The runJob built on runAgent lives in the loop block
 *    (src/loop/job-runner.ts).
 * 6. Final text exactly "[SILENT]" (trimmed) → silent: nothing is delivered. Empty text → error. Otherwise the text
 *    is delivered to the job's target, resolved again at delivery time.
 * 7. The outcome is saved with `jobs.finish`: nextRunAt is the next cron time after now in the job's zone, so runs
 *    missed while nothing was ticking collapse into one. On an error, failures + 1, lastError (redacted), and
 *    nextRunAt = the later of the next cron time and now + backoff (1, 2, 4 … up to 60 minutes).
 *
 * Leases: `leaseMs` (default 5 minutes) must be longer than the longest run (keep the run's wall-clock budget
 * below it). The run's signal aborts when the lease runs out, and output that arrives after that is not delivered,
 * because another scheduler may already have claimed the job.
 */
import { randomUUID } from "node:crypto";
import type { ChannelRegistry } from "../channels/channel.js";
import { parseDeliveryTarget } from "../channels/channel.js";
import { defaultRedactor, describeError, truncateChars } from "../channels/util.js";
import type { DeliveryMessage, JobRecord, NewJob, PreStep, Redactor, Storage, TickReport } from "../types.js";
import { nextRun } from "./cron.js";

/** A run whose final text is exactly this (after trimming) delivers nothing. */
export const SILENT = "[SILENT]";
export const DEFAULT_LEASE_MS = 5 * 60_000;
export const MAX_BACKOFF_MS = 60 * 60_000;
const BASE_BACKOFF_MS = 60_000;
const DEFAULT_MAX_JOBS_PER_TICK = 25;
const MAX_ERROR_CHARS = 1_000;

export interface JobRunContext {
  /** The pre-step's text, when the job has a pre-step (volatile context for the run). */
  context?: string;
  /** Always false: nobody is there to answer, so approvals are deny-by-default. */
  attended: false;
  /** The tick's time. */
  now: Date;
  /** Aborts when the job's lease runs out; pass it on to the run (RunInput.signal). */
  signal: AbortSignal;
}

/**
 * Runs one job and returns its final text. It MUST start a fresh session (no history); see step 5 above. The
 * runJob built on runAgent lives in the loop block (src/loop/job-runner.ts).
 */
export type JobRunner = (job: JobRecord, ctx: JobRunContext) => Promise<{ text: string }>;

export interface SchedulerOptions {
  storage: Storage;
  channels: Pick<ChannelRegistry, "resolve" | "deliver">;
  runJob: JobRunner;
  /** Pre-steps by name. A job names one; the job record never carries code. */
  preSteps?: Record<string, PreStep>;
  /** This scheduler's lease owner id. Default: a random id per instance. */
  worker?: string;
  /** How long a claimed job is leased. Default 5 minutes; must be longer than the longest run. */
  leaseMs?: number;
  /** At most this many jobs per tick; they run one after another. Default 25. */
  maxJobsPerTick?: number;
  now?: () => Date;
  /** Applied to error text before it is stored or reported. Default: a secrets redactor. */
  redact?: Redactor;
  /** Builds the delivered message. Default: `{ title: job.name, body: text }`. */
  formatMessage?: (job: JobRecord, text: string) => DeliveryMessage;
}

type JobStatus = NonNullable<JobRecord["lastStatus"]>;
type JobOutcome = Pick<JobRecord, "lastRunAt" | "lastStatus" | "lastError" | "nextRunAt" | "failures">;

/** What happened to one job before its outcome was saved. */
interface Evaluation {
  status: JobStatus;
  /** Already redacted and shortened. */
  error?: string;
  /** runJob was called. */
  ran: boolean;
  /** The message was delivered. */
  delivered: boolean;
}

interface Lease {
  signal: AbortSignal;
  expired(): boolean;
  stop(): void;
}

/** 1, 2, 4, 8, 16, 32, then 60 minutes after the 1st, 2nd, 3rd … consecutive failure. */
export function failureBackoffMs(failures: number): number {
  if (!(failures >= 1)) return 0;
  const exponent = Math.min(Math.floor(failures) - 1, 6);
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exponent);
}

export class Scheduler {
  readonly worker: string;
  private readonly storage: Storage;
  private readonly channels: Pick<ChannelRegistry, "resolve" | "deliver">;
  private readonly runJob: JobRunner;
  private readonly preSteps: ReadonlyMap<string, PreStep>;
  private readonly leaseMs: number;
  private readonly maxJobsPerTick: number;
  private readonly now: () => Date;
  private readonly redact: Redactor;
  private readonly formatMessage: (job: JobRecord, text: string) => DeliveryMessage;

  constructor(options: SchedulerOptions) {
    const { storage, channels, runJob } = options ?? ({} as SchedulerOptions);
    if (typeof storage?.jobs?.claimDue !== "function" || typeof storage.agents?.get !== "function") {
      throw new TypeError("Scheduler needs { storage } (a Storage with jobs, agents and deliveries).");
    }
    if (typeof channels?.resolve !== "function" || typeof channels.deliver !== "function") {
      throw new TypeError("Scheduler needs { channels } (a ChannelRegistry).");
    }
    if (typeof runJob !== "function") throw new TypeError("Scheduler needs { runJob } (a function that runs one job).");
    this.storage = storage;
    this.channels = channels;
    this.runJob = runJob;
    this.preSteps = preStepMap(options.preSteps);
    this.worker = options.worker ?? `scheduler-${randomUUID()}`;
    if (typeof this.worker !== "string" || this.worker.trim() === "" || this.worker.length > 200) {
      throw new TypeError("Scheduler: worker must be a non-empty string of at most 200 characters.");
    }
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!(Number.isFinite(this.leaseMs) && this.leaseMs >= 1)) {
      throw new RangeError("Scheduler: leaseMs must be a positive number of milliseconds.");
    }
    this.maxJobsPerTick = options.maxJobsPerTick ?? DEFAULT_MAX_JOBS_PER_TICK;
    if (!(Number.isSafeInteger(this.maxJobsPerTick) && this.maxJobsPerTick >= 1)) {
      throw new RangeError("Scheduler: maxJobsPerTick must be a whole number of at least 1.");
    }
    this.now = options.now ?? (() => new Date());
    this.redact = options.redact ?? defaultRedactor;
    this.formatMessage = options.formatMessage ?? ((job, text) => ({ title: job.name, body: text }));
  }

  /**
   * Runs every job that is due, one at a time, and reports what happened. `now` (default: the clock) is used for
   * claiming and for the next run times. Throws only when storage cannot claim jobs.
   */
  async tick(now?: Date): Promise<TickReport> {
    if (now !== undefined && !isValidDate(now)) throw new TypeError("Scheduler.tick: now must be a valid Date.");
    const report: TickReport = { claimed: 0, ran: 0, silent: 0, skipped: 0, delivered: 0, failed: 0, jobs: [] };
    for (let i = 0; i < this.maxJobsPerTick; i++) {
      const at = now ?? this.clock();
      const [job] = await this.storage.jobs.claimDue(at.toISOString(), {
        leaseMs: this.leaseMs,
        worker: this.worker,
        limit: 1,
      });
      if (!job) break;
      report.claimed += 1;
      await this.fire(job, at, report);
    }
    return report;
  }

  /** Evaluates one claimed job, saves its outcome (which releases the lease) and adds it to the report. */
  private async fire(job: JobRecord, now: Date, report: TickReport): Promise<void> {
    const lease = startLease(this.leaseMs);
    try {
      let next: Date | null = null;
      let scheduleError: string | null = null;
      try {
        next = nextRun(job.schedule, now, job.timeZone);
      } catch (err) {
        scheduleError = describeError(err);
      }
      const evaluation =
        scheduleError === null
          ? await this.evaluate(job, now, lease)
          : this.fail(`The job's schedule cannot be used: ${scheduleError}`);
      let status = evaluation.status;
      let error = evaluation.error;
      try {
        await this.storage.jobs.finish(job.id, this.outcome(job, now, evaluation, next));
      } catch (err) {
        status = "error";
        error = this.clean(`The job's outcome could not be saved: ${describeError(err)}`);
      }
      if (evaluation.ran) report.ran += 1;
      if (evaluation.delivered) report.delivered += 1;
      if (status === "silent") report.silent += 1;
      if (status === "skipped") report.skipped += 1;
      if (status === "error") report.failed += 1;
      const entry: TickReport["jobs"][number] = { id: job.id, name: job.name, status };
      if (error !== undefined) entry.error = error;
      report.jobs.push(entry);
    } finally {
      lease.stop();
    }
  }

  /** Steps 2-6 for one job. Never throws. */
  private async evaluate(job: JobRecord, now: Date, lease: Lease): Promise<Evaluation> {
    let ran = false;
    try {
      // claimDue returns only enabled jobs; a disabled one is never run, whatever the adapter does.
      if (job.enabled !== true) return skipped();
      const agent = await this.storage.agents.get(job.agentId);
      if (!agent) return this.fail(`The job's agent ${JSON.stringify(job.agentId)} does not exist.`);
      if (agent.mode === "off") return skipped();
      try {
        this.channels.resolve(job.deliver);
      } catch (err) {
        return this.fail(`The delivery target cannot be used: ${describeError(err)}`);
      }
      let context: string | undefined;
      if (job.preStep !== null && job.preStep !== undefined) {
        const result = await this.runPreStep(job, now);
        if (typeof result !== "string") return result;
        context = result;
      }
      if (lease.expired()) return this.fail(`The job's lease (${this.leaseMs} ms) ran out before the run started.`);
      const ctx: JobRunContext = { attended: false, now, signal: lease.signal };
      if (context !== undefined) ctx.context = context;
      ran = true;
      let output: unknown;
      try {
        output = await this.runJob(structuredClone(job), ctx);
      } catch (err) {
        return this.fail(`The run failed: ${describeError(err)}`, true);
      }
      const text = textOf(output);
      if (text === null) return this.fail("The run returned no text.", true);
      const trimmed = text.trim();
      if (trimmed === SILENT) return { status: "silent", ran: true, delivered: false };
      if (trimmed === "") return this.fail("The run returned empty text, so nothing was delivered.", true);
      if (lease.expired()) {
        return this.fail(
          `The run took longer than the job's lease (${this.leaseMs} ms), so its output was not delivered: another ` +
            "scheduler may have run the job too. Raise leaseMs or lower the run's time budget.",
          true,
        );
      }
      const result = await this.channels.deliver(job.deliver, this.formatMessage(structuredClone(job), trimmed), {
        storage: this.storage,
        jobId: job.id,
      });
      if (!result.ok) return this.fail(`Delivery to ${JSON.stringify(job.deliver)} failed: ${result.error ?? "no reason given"}`, true);
      return { status: "ok", ran: true, delivered: true };
    } catch (err) {
      return this.fail(`The job failed: ${describeError(err)}`, ran);
    }
  }

  /** The pre-step's text, or the evaluation that ends the job here (skipped or error). */
  private async runPreStep(job: JobRecord, now: Date): Promise<string | Evaluation> {
    const name = job.preStep;
    const step = typeof name === "string" ? this.preSteps.get(name) : undefined;
    if (!step) return this.fail(`Pre-step ${JSON.stringify(name)} is not registered.`);
    let output: unknown;
    try {
      output = await step({ job: structuredClone(job), now, storage: this.storage });
    } catch (err) {
      return this.fail(`Pre-step ${JSON.stringify(name)} failed: ${describeError(err)}`);
    }
    if (output === null) return skipped();
    if (typeof output !== "string") {
      return this.fail(`Pre-step ${JSON.stringify(name)} must return text or null, not ${typeof output}.`);
    }
    return output;
  }

  private outcome(job: JobRecord, now: Date, evaluation: Evaluation, next: Date | null): JobOutcome {
    const lastRunAt = now.toISOString();
    const previous = Number.isSafeInteger(job.failures) && job.failures > 0 ? job.failures : 0;
    if (evaluation.status === "error") {
      const failures = previous + 1;
      const retryAt = now.getTime() + failureBackoffMs(failures);
      const nextRunAt = next === null ? null : new Date(Math.max(next.getTime(), retryAt)).toISOString();
      return { lastRunAt, lastStatus: "error", lastError: evaluation.error ?? "The job failed.", nextRunAt, failures };
    }
    const nextRunAt = next === null ? null : next.toISOString();
    if (evaluation.status === "skipped") {
      // A skip says nothing about whether the job works: keep the failure count and the last error.
      return { lastRunAt, lastStatus: "skipped", lastError: job.lastError ?? null, nextRunAt, failures: previous };
    }
    return { lastRunAt, lastStatus: evaluation.status, lastError: null, nextRunAt, failures: 0 };
  }

  private fail(message: string, ran = false): Evaluation {
    return { status: "error", error: this.clean(message), ran, delivered: false };
  }

  /** Redacts, then shortens (in that order, so a secret is never cut into a piece the redactor misses). */
  private clean(text: string): string {
    try {
      return truncateChars(this.redact(text), MAX_ERROR_CHARS);
    } catch {
      return "The error text could not be redacted, so it was not kept.";
    }
  }

  private clock(): Date {
    const date = this.now();
    if (!isValidDate(date)) throw new TypeError("The scheduler's clock returned something that is not a valid Date.");
    return date;
  }
}

function skipped(): Evaluation {
  return { status: "skipped", ran: false, delivered: false };
}

function textOf(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const text = (output as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

function preStepMap(preSteps: Record<string, PreStep> | undefined): ReadonlyMap<string, PreStep> {
  // Own enumerable keys only, so names like "constructor" or "__proto__" never reach Object.prototype.
  const entries = Object.entries(preSteps ?? {});
  for (const [name, step] of entries) {
    if (typeof step !== "function") throw new TypeError(`Scheduler: pre-step ${JSON.stringify(name)} must be a function.`);
  }
  return new Map(entries);
}

/** A lease clock in real time (not the injectable `now`), because leases guard real concurrency. */
function startLease(ms: number): Lease {
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(new Error(`The job's lease of ${ms} ms ran out.`)), ms);
  timer.unref();
  return {
    signal: controller.signal,
    expired: () => controller.signal.aborted || performance.now() - started >= ms,
    stop: () => clearTimeout(timer),
  };
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Saves a job with its first nextRunAt: the next cron time after `now` in the job's zone. Checks the schedule, the
 * time zone and the form of the delivery target (the channel itself is resolved when the job fires, so it may be
 * registered later). Re-scheduling an existing job (same id, or same agent and name) with the same schedule and
 * time zone keeps its nextRunAt, so calling this at every start-up neither skips nor repeats a run. An explicit
 * `nextRunAt` wins.
 */
export async function scheduleJob(storage: Pick<Storage, "jobs">, job: NewJob, now: Date = new Date()): Promise<JobRecord> {
  if (!isValidDate(now)) throw new TypeError("scheduleJob: now must be a valid Date.");
  parseDeliveryTarget(job.deliver);
  const first = nextRun(job.schedule, now, job.timeZone).toISOString();
  if (job.preStep !== undefined && job.preStep !== null && (typeof job.preStep !== "string" || job.preStep.trim() === "")) {
    throw new TypeError("scheduleJob: preStep must be the name of a registered pre-step, or null.");
  }
  let nextRunAt = job.nextRunAt ?? first;
  if (job.nextRunAt === undefined || job.nextRunAt === null) {
    const existing = await findJob(storage, job);
    if (existing?.nextRunAt && existing.schedule === job.schedule && existing.timeZone === job.timeZone) {
      nextRunAt = existing.nextRunAt;
    }
  }
  return storage.jobs.upsert({ ...job, nextRunAt });
}

async function findJob(storage: Pick<Storage, "jobs">, job: NewJob): Promise<JobRecord | null> {
  if (job.id !== undefined) return storage.jobs.get(job.id);
  const jobs = await storage.jobs.list({ agentId: job.agentId });
  return jobs.find((candidate) => candidate.name === job.name) ?? null;
}

export interface TimerOptions {
  /** Default 60 s. */
  intervalMs?: number;
  /** Receives anything a tick throws (e.g. storage is down). Default: console.error. */
  onError?: (error: unknown) => void;
  /** Receives each tick's report. */
  onTick?: (report: TickReport) => void;
}

/**
 * Ticks the scheduler every `intervalMs` (an unref'd interval, so it never keeps the process alive). Ticks never
 * overlap: while one is running, the interval does nothing. Returns `stop()`, which resolves once any running
 * tick has finished.
 */
export function startTimer(scheduler: { tick(): Promise<TickReport> }, options: TimerOptions = {}): () => Promise<void> {
  if (typeof scheduler?.tick !== "function") throw new TypeError("startTimer needs a scheduler with a tick() method.");
  const intervalMs = options.intervalMs ?? 60_000;
  if (!(Number.isFinite(intervalMs) && intervalMs >= 1)) {
    throw new RangeError("startTimer: intervalMs must be a positive number of milliseconds.");
  }
  const onError = options.onError ?? ((error: unknown) => console.error("Hermod scheduler: a tick failed:", error));
  let busy = false;
  let stopped = false;
  let current: Promise<void> = Promise.resolve();
  const run = (): void => {
    if (stopped || busy) return;
    busy = true;
    current = Promise.resolve()
      .then(() => scheduler.tick())
      .then(
        (report) => quietly(() => options.onTick?.(report)),
        (err: unknown) => quietly(() => onError(err)),
      )
      .finally(() => {
        busy = false;
      });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    return current;
  };
}

/** Runs a callback; a callback that throws must not stop the timer. */
function quietly(callback: () => void): void {
  try {
    callback();
  } catch {
    // ignored on purpose
  }
}
