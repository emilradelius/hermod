/**
 * Delivery channels and the registry that resolves targets such as "webpush:owner" or "telegram:12345".
 *
 * - Targets are resolved when a message is delivered, not when a job is scheduled, so a registry change between
 *   scheduling and firing takes effect.
 * - Every delivery is recorded through `storage.deliveries` (queued, then sent or failed); those rows are also the
 *   in-app outbox.
 * - Channels are used by application code and the scheduler. They are never exposed to the model as tools.
 */
import type { Channel, DeliveryMessage, DeliveryResult, Id, Redactor, Storage } from "../types.js";
import { defaultRedactor, describeError, hasControlCharacters, isDeliveryMessage, quote, truncateChars } from "./util.js";

/** Channel names: lowercase letters, digits, "-" and "_", starting with a letter. */
export const CHANNEL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_SPEC_LENGTH = 512;
const MAX_ERROR_CHARS = 1_000;
const DEFAULT_SEND_TIMEOUT_MS = 30_000;

/** A delivery target that cannot be used: malformed, or naming a channel that is not registered. */
export class DeliveryTargetError extends Error {
  readonly code: "malformed" | "unknown_channel";
  constructor(code: "malformed" | "unknown_channel", message: string) {
    super(message);
    this.name = "DeliveryTargetError";
    this.code = code;
  }
}

/** Splits "channel:target" (at the first colon) and checks its form. Does not look the channel up. */
export function parseDeliveryTarget(spec: string): { channel: string; target: string } {
  if (typeof spec !== "string") {
    throw new DeliveryTargetError(
      "malformed",
      `A delivery target must be a string such as "inapp:owner", not ${spec === null ? "null" : typeof spec}.`,
    );
  }
  const text = spec.trim();
  const malformed = (reason: string): DeliveryTargetError =>
    new DeliveryTargetError("malformed", `Malformed delivery target ${quote(text)}: ${reason}.`);
  if (text.length > MAX_SPEC_LENGTH) throw malformed(`it is longer than ${MAX_SPEC_LENGTH} characters`);
  if (hasControlCharacters(text)) throw malformed("it contains control characters");
  const colon = text.indexOf(":");
  if (colon < 0) throw malformed('expected "channel:target", e.g. "inapp:owner"');
  const channel = text.slice(0, colon).trim();
  const target = text.slice(colon + 1).trim();
  if (channel === "") throw malformed('the channel name before ":" is missing');
  if (target === "") throw malformed('the target after ":" is missing');
  if (!CHANNEL_NAME_PATTERN.test(channel)) {
    throw malformed(`the channel name ${quote(channel)} must be lowercase letters, digits, "-" or "_", starting with a letter`);
  }
  return { channel, target };
}

export interface ChannelRegistryOptions {
  /** Applied to error text before it is stored or returned. Default: a secrets redactor. */
  redact?: Redactor;
  /** A send that has not finished after this long counts as failed. Default 30 s. */
  sendTimeoutMs?: number;
}

export interface DeliverOptions {
  /** Where the delivery is recorded. */
  storage: Pick<Storage, "deliveries">;
  jobId?: Id | null;
}

export class ChannelRegistry {
  private readonly channels = new Map<string, Channel>();
  private readonly redact: Redactor;
  private readonly sendTimeoutMs: number;

  constructor(options: ChannelRegistryOptions = {}) {
    this.redact = options.redact ?? defaultRedactor;
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    if (!(Number.isFinite(this.sendTimeoutMs) && this.sendTimeoutMs > 0)) {
      throw new RangeError("ChannelRegistry: sendTimeoutMs must be a positive number of milliseconds.");
    }
  }

  /** Adds a channel under its name. Throws if the name is taken (unregister first to replace a channel). */
  register(channel: Channel): this {
    if (typeof channel !== "object" || channel === null || typeof channel.send !== "function") {
      throw new TypeError("ChannelRegistry.register() needs a channel with a name and a send() method.");
    }
    const name: unknown = channel.name;
    if (typeof name !== "string" || !CHANNEL_NAME_PATTERN.test(name)) {
      throw new TypeError(
        `Channel name ${typeof name === "string" ? quote(name) : `(${typeof name})`} must be lowercase letters, ` +
          'digits, "-" or "_", starting with a letter.',
      );
    }
    if (this.channels.has(name)) {
      throw new Error(`A channel named "${name}" is already registered; unregister it first to replace it.`);
    }
    this.channels.set(name, channel);
    return this;
  }

  /** Removes a channel; true if it was registered. */
  unregister(name: string): boolean {
    return this.channels.delete(name);
  }

  has(name: string): boolean {
    return this.channels.has(name);
  }

  /** Registered channel names, sorted. */
  get names(): string[] {
    return [...this.channels.keys()].sort();
  }

  /** Resolves "channel:target" now. Throws DeliveryTargetError for a malformed spec or an unknown channel. */
  resolve(spec: string): { channel: Channel; target: string } {
    const { channel, target } = this.lookup(spec);
    return { channel, target };
  }

  /**
   * Resolves the target now, records a delivery row (queued), sends, and marks the row sent or failed.
   * Channel problems (unknown channel, a failed, slow or throwing send) come back as `{ ok: false, error }`; a
   * malformed spec is not recorded. Storage errors when adding the row, and programmer errors (no storage, a
   * message without a string title and body), throw. If marking the row fails after the send, the send's result
   * is still returned (the row stays queued), so a sent message is never reported as failed and sent again.
   */
  async deliver(spec: string, message: DeliveryMessage, options: DeliverOptions): Promise<DeliveryResult> {
    const storage = options?.storage;
    if (typeof storage?.deliveries?.add !== "function") {
      throw new TypeError("ChannelRegistry.deliver() needs { storage } to record the delivery.");
    }
    if (!isDeliveryMessage(message)) {
      throw new TypeError("ChannelRegistry.deliver() needs a message with a string title and body.");
    }
    const jobId = options.jobId ?? null;
    let resolved: { name: string; channel: Channel; target: string };
    try {
      resolved = this.lookup(spec);
    } catch (err) {
      const error = this.clean(describeError(err));
      if (err instanceof DeliveryTargetError && err.code === "unknown_channel") {
        const { channel, target } = parseDeliveryTarget(spec);
        const row = await storage.deliveries.add({ channel, target, ...recordFields(message), jobId });
        await markQuietly(storage, row.id, "failed", error);
      }
      return { ok: false, delivered: 0, error };
    }
    const row = await storage.deliveries.add({
      channel: resolved.name,
      target: resolved.target,
      ...recordFields(message),
      jobId,
    });
    const result = await this.send(resolved, message, jobId);
    await markQuietly(storage, row.id, result.ok ? "sent" : "failed", result.ok ? null : (result.error ?? null));
    return result;
  }

  private lookup(spec: string): { name: string; channel: Channel; target: string } {
    const { channel: name, target } = parseDeliveryTarget(spec);
    const channel = this.channels.get(name);
    if (!channel) {
      const known = this.channels.size ? `registered channels: ${this.names.join(", ")}` : "no channels are registered";
      throw new DeliveryTargetError("unknown_channel", `Unknown delivery channel ${quote(name)} in ${quote(spec.trim())}; ${known}.`);
    }
    return { name, channel, target };
  }

  /** Sends with a timeout; never throws. */
  private async send(
    resolved: { name: string; channel: Channel; target: string },
    message: DeliveryMessage,
    jobId: Id | null,
  ): Promise<DeliveryResult> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<DeliveryResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, delivered: 0, error: `the ${resolved.name} channel did not finish within ${this.sendTimeoutMs} ms` }),
        this.sendTimeoutMs,
      );
      timer.unref();
    });
    const sent = Promise.resolve()
      .then(() => resolved.channel.send(resolved.target, { ...message }, jobId === null ? undefined : { jobId }))
      .then(
        (value) => normalizeResult(value, resolved.name),
        (err: unknown): DeliveryResult => ({ ok: false, delivered: 0, error: describeError(err) }),
      );
    try {
      const result = await Promise.race([sent, timedOut]);
      return result.ok ? result : { ...result, error: this.clean(result.error ?? "the delivery failed") };
    } finally {
      clearTimeout(timer);
    }
  }

  private clean(text: string): string {
    return truncateChars(this.redact(text), MAX_ERROR_CHARS);
  }
}

function recordFields(message: DeliveryMessage): { title: string; body: string; url: string | null } {
  return { title: message.title, body: message.body, url: message.url ?? null };
}

/** Accepts only a well-formed DeliveryResult from a channel. */
function normalizeResult(value: unknown, channelName: string): DeliveryResult {
  if (typeof value !== "object" || value === null || typeof (value as { ok?: unknown }).ok !== "boolean") {
    return { ok: false, delivered: 0, error: `the ${channelName} channel returned an invalid result` };
  }
  const { ok, delivered, error } = value as { ok: boolean; delivered?: unknown; error?: unknown };
  const count =
    typeof delivered === "number" && Number.isFinite(delivered) && delivered >= 0 ? Math.floor(delivered) : ok ? 1 : 0;
  if (ok) return { ok, delivered: count };
  const reason = typeof error === "string" && error.trim() !== "" ? error : `the ${channelName} channel reported a failure`;
  return { ok, delivered: count, error: reason };
}

async function markQuietly(
  storage: Pick<Storage, "deliveries">,
  id: Id,
  status: "sent" | "failed",
  error: string | null,
): Promise<void> {
  try {
    await storage.deliveries.mark(id, status, error);
  } catch {
    // The outcome of the send is what matters to the caller; the row stays "queued".
  }
}
