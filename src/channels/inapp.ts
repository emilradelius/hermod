/**
 * The in-app channel: live subscribers plus a Server-Sent Events helper for web apps.
 *
 * - `send` notifies everyone subscribed to the target right now. It succeeds even when nobody is connected:
 *   ChannelRegistry.deliver has already recorded the message as a delivery row, and those rows are the in-app
 *   outbox the app shows later (`history`, when this channel has storage).
 * - `sseResponse(target, { signal })` returns a web `Response` (text/event-stream) for a route handler: one
 *   `data:` line of JSON per new message, `: ping` heartbeats, and cleanup when the request is aborted or the
 *   client stops reading.
 */
import type { Channel, DeliveryMessage, DeliveryRecord, DeliveryResult, Id, IsoTime, Storage } from "../types.js";
import { hasControlCharacters, isDeliveryMessage } from "./util.js";

/** What a subscriber receives (and what each SSE `data:` line contains, as JSON). */
export interface InAppEvent {
  target: string;
  title: string;
  body: string;
  url: string | null;
  tag: string | null;
  jobId: Id | null;
  /** When the channel sent it. */
  at: IsoTime;
}

export type InAppListener = (event: InAppEvent) => void;

export interface InAppChannelOptions {
  /** Default "inapp". */
  name?: string;
  /** Lets `history()` read this channel's outbox (the delivery rows the registry records). */
  storage?: Pick<Storage, "deliveries">;
  now?: () => Date;
}

export interface SseOptions {
  /** Abort it when the request ends (e.g. `request.signal` in a route handler). */
  signal: AbortSignal;
  /** Default 15 s. */
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
/** A client that has not read this many queued events is disconnected (it reconnects and catches up). */
const MAX_QUEUED_EVENTS = 1_000;
const MAX_TARGET_LENGTH = 512;

export class InAppChannel implements Channel {
  readonly name: string;
  private readonly listeners = new Map<string, Set<InAppListener>>();
  private readonly storage: Pick<Storage, "deliveries"> | undefined;
  private readonly now: () => Date;

  constructor(options: InAppChannelOptions = {}) {
    this.name = options.name ?? "inapp";
    this.storage = options.storage;
    this.now = options.now ?? (() => new Date());
  }

  /** Calls `listener` for each message sent to `target` from now on. Returns an unsubscribe function. */
  subscribe(target: string, listener: InAppListener): () => void {
    assertTarget(target);
    if (typeof listener !== "function") throw new TypeError("InAppChannel.subscribe() needs a listener function.");
    // A wrapper per subscription, so the same function can subscribe twice and unsubscribe each independently.
    const entry: InAppListener = (event) => listener(event);
    let set = this.listeners.get(target);
    if (!set) {
      set = new Set();
      this.listeners.set(target, set);
    }
    set.add(entry);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.listeners.get(target);
      current?.delete(entry);
      if (current?.size === 0) this.listeners.delete(target);
    };
  }

  /** Live subscribers of a target. */
  listenerCount(target: string): number {
    return this.listeners.get(target)?.size ?? 0;
  }

  async send(target: string, message: DeliveryMessage, meta?: { jobId?: Id }): Promise<DeliveryResult> {
    if (!isTarget(target)) return { ok: false, delivered: 0, error: "An in-app target must be a short non-empty string." };
    if (!isDeliveryMessage(message)) {
      return { ok: false, delivered: 0, error: "An in-app message needs a string title and body." };
    }
    const event: InAppEvent = {
      target,
      title: message.title,
      body: message.body,
      url: message.url ?? null,
      tag: message.tag ?? null,
      jobId: meta?.jobId ?? null,
      at: this.now().toISOString(),
    };
    let delivered = 0;
    for (const listener of [...(this.listeners.get(target) ?? [])]) {
      try {
        listener({ ...event }); // each subscriber gets its own copy
        delivered += 1;
      } catch {
        // One broken subscriber must not keep the message from the others.
      }
    }
    return { ok: true, delivered };
  }

  /** The target's outbox: recorded in-app deliveries (not failed ones), as the storage lists them. */
  async history(target: string, options: { since?: IsoTime; limit?: number } = {}): Promise<DeliveryRecord[]> {
    if (!this.storage) throw new Error("InAppChannel.history() needs the storage option.");
    assertTarget(target);
    const query: { channel: string; target: string; since?: IsoTime; limit?: number } = { channel: this.name, target };
    if (options.since !== undefined) query.since = options.since;
    if (options.limit !== undefined) query.limit = options.limit;
    const rows = await this.storage.deliveries.list(query);
    return rows.filter((row) => row.status !== "failed");
  }

  /** A text/event-stream Response that streams each new message for `target` until `signal` aborts. */
  sseResponse(target: string, options: SseOptions): Response {
    assertTarget(target);
    const signal = options?.signal;
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError("InAppChannel.sseResponse() needs { signal } so the stream can end with the request.");
    }
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (!(Number.isFinite(heartbeatMs) && heartbeatMs >= 1)) {
      throw new RangeError("InAppChannel.sseResponse(): heartbeatMs must be a positive number of milliseconds.");
    }
    const stream = eventStream((write) => this.subscribe(target, (event) => write(`data: ${JSON.stringify(event)}\n\n`)), {
      signal,
      heartbeatMs,
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }
}

/**
 * A byte stream of SSE text. `open(write)` starts the source and returns its cleanup. The stream ends (and cleans
 * up once) when the signal aborts, the consumer cancels, or the consumer falls too far behind.
 */
function eventStream(
  open: (write: (text: string) => void) => () => void,
  options: { signal: AbortSignal; heartbeatMs: number },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let close: () => void = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.signal.aborted) {
        controller.close();
        return;
      }
      let closed = false;
      const cleanups: Array<() => void> = [];
      close = () => {
        if (closed) return;
        closed = true;
        for (const cleanup of cleanups.splice(0)) cleanup();
        try {
          controller.close();
        } catch {
          // Already closed or cancelled by the consumer.
        }
      };
      const write = (text: string): void => {
        if (closed) return;
        if ((controller.desiredSize ?? 0) < -MAX_QUEUED_EVENTS) {
          close();
          return;
        }
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close(); // the stream was torn down underneath us
        }
      };
      const onAbort = (): void => close();
      options.signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => options.signal.removeEventListener("abort", onAbort));
      cleanups.push(open(write));
      const heartbeat = setInterval(() => write(": ping\n\n"), options.heartbeatMs);
      heartbeat.unref();
      cleanups.push(() => clearInterval(heartbeat));
      write(": connected\n\n");
    },
    cancel() {
      close();
    },
  });
}

function isTarget(target: unknown): target is string {
  return (
    typeof target === "string" &&
    target.trim() !== "" &&
    target.length <= MAX_TARGET_LENGTH &&
    !hasControlCharacters(target)
  );
}

function assertTarget(target: unknown): asserts target is string {
  if (!isTarget(target)) throw new TypeError("An in-app target must be a short non-empty string without control characters.");
}
