/**
 * A scripted, offline stand-in for the Anthropic API, so tests and evals never spend money.
 *
 * - Each call to `complete()` consumes the next scripted step: a message, a function of the request, or an error.
 * - Every request is recorded (deep copy, without the AbortSignal) for assertions.
 * - Text blocks are streamed to the callbacks in small deltas, like the real client.
 * - Errors are the SDK's own classes (built with `APIError.generate`), so the error classifier sees the
 *   same types it sees in production.
 */
import { APIConnectionError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type { ContentBlock, Message, ModelClient, ModelRequest, StopReason, StreamCallbacks, Usage } from "../types.js";

/** A scripted step: a fixed message, a function of the request, or an error to throw. */
export type FakeStep =
  | Message
  | ((request: ModelRequest, callIndex: number) => Message | Promise<Message>)
  | { throw: unknown };

export interface FakeUsageInput {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

let messageCounter = 0;
let toolUseCounter = 0;

/** A complete, valid BetaUsage object. */
export function fakeUsage(usage: FakeUsageInput = {}): Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: usage.cacheWrite ?? 0,
    cache_read_input_tokens: usage.cacheRead ?? 0,
    fallback_credit: null,
    inference_geo: null,
    input_tokens: usage.input ?? 1_000,
    iterations: null,
    output_tokens: usage.output ?? 100,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: "standard",
    speed: null,
  };
}

export interface MakeMessageOptions {
  content: ContentBlock[];
  stopReason: StopReason;
  model?: string;
  usage?: FakeUsageInput;
  refusalCategory?: NonNullable<Message["stop_details"]>["category"];
}

/** A complete, valid BetaMessage object. */
export function makeMessage(options: MakeMessageOptions): Message {
  messageCounter += 1;
  return {
    id: `msg_fake_${messageCounter}`,
    container: null,
    content: options.content,
    context_management: null,
    diagnostics: null,
    model: options.model ?? "claude-opus-5-5",
    role: "assistant",
    stop_details:
      options.stopReason === "refusal"
        ? { category: options.refusalCategory ?? null, explanation: null, type: "refusal" }
        : null,
    stop_reason: options.stopReason,
    stop_sequence: null,
    type: "message",
    usage: fakeUsage(options.usage),
  } as Message;
}

/** A final text answer (stop_reason "end_turn"). */
export function textMessage(text: string, options: { model?: string; usage?: FakeUsageInput } = {}): Message {
  return makeMessage({
    content: [{ type: "text", text, citations: null }],
    stopReason: "end_turn",
    ...options,
  });
}

export interface FakeToolCall {
  name: string;
  input: unknown;
  id?: string;
}

/** A turn that calls one or more tools (stop_reason "tool_use"), optionally with text before the calls. */
export function toolUseMessage(
  calls: FakeToolCall[],
  options: { text?: string; model?: string; usage?: FakeUsageInput } = {},
): Message {
  const content: ContentBlock[] = [];
  if (options.text) content.push({ type: "text", text: options.text, citations: null });
  for (const call of calls) {
    toolUseCounter += 1;
    content.push({ type: "tool_use", id: call.id ?? `toolu_fake_${toolUseCounter}`, name: call.name, input: call.input });
  }
  return makeMessage({ content, stopReason: "tool_use", model: options.model, usage: options.usage });
}

/** A refusal (HTTP 200, stop_reason "refusal"). */
export function refusalMessage(
  category: NonNullable<Message["stop_details"]>["category"] = null,
  options: { model?: string; usage?: FakeUsageInput } = {},
): Message {
  return makeMessage({ content: [], stopReason: "refusal", refusalCategory: category, ...options });
}

/** A turn cut off at max_tokens (optionally with a truncated tool call). */
export function maxTokensMessage(options: { text?: string; toolCall?: FakeToolCall; model?: string } = {}): Message {
  const content: ContentBlock[] = [];
  if (options.text) content.push({ type: "text", text: options.text, citations: null });
  if (options.toolCall) {
    toolUseCounter += 1;
    content.push({
      type: "tool_use",
      id: options.toolCall.id ?? `toolu_fake_${toolUseCounter}`,
      name: options.toolCall.name,
      input: options.toolCall.input,
    });
  }
  return makeMessage({ content, stopReason: "max_tokens", model: options.model });
}

/**
 * A real SDK error for a status code (the same subclass the SDK raises): 400 BadRequestError, 401
 * AuthenticationError, 403 PermissionDeniedError, 404 NotFoundError, 429 RateLimitError, 5xx/529
 * InternalServerError. Pass `retryAfterSeconds` to set the retry-after header.
 */
export function apiError(
  status: number,
  message: string,
  options: { type?: string; retryAfterSeconds?: number } = {},
): APIError {
  const headers = new Headers();
  if (options.retryAfterSeconds !== undefined) headers.set("retry-after", String(options.retryAfterSeconds));
  const type = options.type ?? defaultErrorType(status);
  return APIError.generate(status, { type: "error", error: { type, message } }, message, headers);
}

/** A network-level failure (no HTTP status). */
export function connectionError(message = "Connection error."): APIConnectionError {
  return new APIConnectionError({ message });
}

function defaultErrorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  return "api_error";
}

/** The request as recorded by the fake (no AbortSignal; deep-copied). */
export type RecordedRequest = Omit<ModelRequest, "signal">;

export class FakeModelClient implements ModelClient {
  readonly calls: RecordedRequest[] = [];
  private readonly steps: FakeStep[];

  constructor(steps: FakeStep[] = []) {
    this.steps = [...steps];
  }

  /** Adds more scripted steps at the end. */
  push(...steps: FakeStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  /** Steps not used yet. */
  get remaining(): number {
    return this.steps.length;
  }

  async complete(request: ModelRequest, callbacks?: StreamCallbacks): Promise<Message> {
    const { signal, ...rest } = request;
    if (signal?.aborted) throw new APIUserAbortError();
    const callIndex = this.calls.length;
    this.calls.push(structuredClone(rest));
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error(
        `FakeModelClient: the script is exhausted after ${callIndex} call(s); add a step for call ${callIndex + 1}.`,
      );
    }
    if (isThrowStep(step)) throw step.throw;
    const produced = typeof step === "function" ? await step(request, callIndex) : step;
    const message = structuredClone(produced);
    emit(message, callbacks);
    return message;
  }

  /** A rough token estimate (characters / 4) so code that counts tokens can be tested offline. */
  async countTokens(request: Omit<ModelRequest, "maxTokens">): Promise<number> {
    const { signal: _signal, ...rest } = request;
    return Math.ceil(JSON.stringify(rest).length / 4);
  }
}

function isThrowStep(step: FakeStep): step is { throw: unknown } {
  return typeof step === "object" && step !== null && "throw" in step && !("type" in step);
}

function emit(message: Message, callbacks: StreamCallbacks | undefined): void {
  if (!callbacks) return;
  for (const block of message.content) {
    if (block.type === "text") {
      for (const delta of splitDeltas(block.text)) callbacks.onText?.(delta);
    } else if (block.type === "thinking") {
      callbacks.onThinking?.(block.thinking);
    } else if (block.type === "tool_use") {
      callbacks.onToolUse?.({ id: block.id, name: block.name });
    }
  }
  callbacks.onMessage?.(message);
}

/** Splits text into a few deltas at character boundaries (never inside a surrogate pair). */
function splitDeltas(text: string): string[] {
  const chars = Array.from(text);
  if (chars.length <= 8) return chars.length ? [text] : [];
  const size = Math.ceil(chars.length / 3);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}
