/**
 * A stub of the part of the Anthropic SDK client that AnthropicModelClient uses: `beta.messages.stream()` and
 * `beta.messages.countTokens()`. Every call is recorded. A stub stream delivers its scripted events to the listeners
 * asynchronously (as the real one does, after the caller has attached them), then resolves or rejects
 * `finalMessage()`. Calling `abort()` stops delivery and rejects with APIUserAbortError, like the real stream.
 */
import Anthropic, { APIUserAbortError } from "@anthropic-ai/sdk";
import type { CountTokensParams, StreamParams } from "../../../src/model/index.js";
import type { Message } from "../../../src/types.js";

export type StubEvent =
  | { text: string }
  | { thinking: string }
  | { toolStart: { id: string; name: string } }
  /** Any raw stream event, delivered as a "streamEvent". */
  | { raw: Record<string, unknown> };

export interface StubScript {
  events?: StubEvent[];
  /** finalMessage() resolves with this message … */
  message?: Message;
  /** … or rejects with this error, after the events. */
  error?: unknown;
  /** Keep delivering and resolve even after abort() (a response that was already fully received). */
  ignoreAbort?: boolean;
}

type Listener = (...args: unknown[]) => void;

export class StubStream {
  readonly listeners = new Map<string, Listener[]>();
  readonly script: StubScript;
  aborted = false;
  finalMessageCalls = 0;

  constructor(script: StubScript) {
    this.script = script;
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  abort(): void {
    this.aborted = true;
  }

  async finalMessage(): Promise<Message> {
    this.finalMessageCalls += 1;
    await Promise.resolve();
    const stopped = (): boolean => this.aborted && !this.script.ignoreAbort;
    for (const event of this.script.events ?? []) {
      if (stopped()) break;
      this.deliver(event);
    }
    if (stopped()) throw new APIUserAbortError();
    if ("error" in this.script) throw this.script.error;
    if (!this.script.message) throw new Error("StubStream: the script has neither a message nor an error.");
    return this.script.message;
  }

  private deliver(event: StubEvent): void {
    if ("text" in event) this.emit("text", event.text, "");
    else if ("thinking" in event) this.emit("thinking", event.thinking, "");
    else if ("toolStart" in event) {
      const block = { type: "tool_use", id: event.toolStart.id, name: event.toolStart.name, input: {} };
      this.emit("streamEvent", { type: "content_block_start", index: 0, content_block: block }, {});
    } else this.emit("streamEvent", event.raw, {});
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

export interface StubCall<P> {
  params: P;
  options: Record<string, unknown> | undefined;
}

export interface Stub {
  client: Anthropic;
  streamCalls: Array<StubCall<StreamParams>>;
  countCalls: Array<StubCall<CountTokensParams>>;
  streams: StubStream[];
}

export function stubClient(scripts: StubScript[] = [], inputTokens = 1_234): Stub {
  const queue = [...scripts];
  const stub: Omit<Stub, "client"> = { streamCalls: [], countCalls: [], streams: [] };
  const fake = {
    beta: {
      messages: {
        stream(params: StreamParams, options?: Record<string, unknown>): StubStream {
          stub.streamCalls.push({ params, options });
          const script = queue.shift();
          if (!script) throw new Error("stubClient: no scripted stream left.");
          const stream = new StubStream(script);
          stub.streams.push(stream);
          return stream;
        },
        async countTokens(params: CountTokensParams, options?: Record<string, unknown>) {
          stub.countCalls.push({ params, options });
          return { input_tokens: inputTokens, context_management: null };
        },
      },
    },
  };
  return { ...stub, client: fake as unknown as Anthropic };
}

/** Freezes a value and everything inside it, so any mutation throws (ES modules run in strict mode). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Counts cache breakpoints the way the API sees them: the top-level field, plus every non-null `cache_control` in the
 * request body except inside tool `input` (model-written data, not markers).
 */
export function countBreakpoints(params: unknown): number {
  const body = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
  let count = 0;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "input") continue;
      if (key === "cache_control" && child !== null) count += 1;
      else walk(child);
    }
  };
  if (body.cache_control) count += 1;
  walk(body.tools);
  walk(body.system);
  walk(body.messages);
  return count;
}
