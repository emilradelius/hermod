/**
 * The real ModelClient: one streamed `client.beta.messages.stream(...)` call per `complete()`.
 *
 * Request rules (SDK facts sheet §2.6–§2.9, the claude-api skill):
 * - System blocks as given, plus a cache breakpoint on the last one (tools + system are the stable prefix), and
 *   top-level automatic caching for the growing conversation. Never more than 4 breakpoints in one request.
 * - `output_config.effort` always sent; thinking always `{ type: "adaptive" }` (never disabled, never budget_tokens).
 * - Never temperature, top_p or top_k (a 400 on API version 2026-10-21), never a prefill, never tool_choice.
 * - Server-side refusal fallback (`fallbacks: "default"` + beta `server-side-fallback-2026-07-01`) on models that
 *   accept it, unless the request turns it off. None on Haiku 5.5.
 * SDK errors are re-thrown unchanged; classify them with classifyError() from ./errors.js.
 */
import Anthropic, { APIUserAbortError } from "@anthropic-ai/sdk";
// Extensionless on purpose: the package maps it to the ESM build, the same declarations the root import uses.
import type { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type { Message, ModelClient, ModelRequest, StreamCallbacks } from "../types.js";
import { isRecord, show } from "./internal.js";
import { EFFORTS, isEffort, supportsServerFallback } from "./models.js";

/** The beta header that the `fallbacks: "default"` form needs (the list form uses -2026-06-01 instead). */
export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** The API rejects a request with more cache_control breakpoints than this (the automatic one counts). */
export const MAX_CACHE_BREAKPOINTS = 4;

export type StreamParams = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
export type CountTokensParams = Anthropic.Beta.Messages.MessageCountTokensParams;
type SharedParams = Pick<StreamParams, "model" | "messages" | "system" | "tools" | "cache_control" | "output_config" | "thinking">;
type CacheControl = Anthropic.Beta.BetaCacheControlEphemeral;
type SystemBlock = Anthropic.Beta.BetaTextBlockParam;
/** What relayEvents uses of the SDK stream. (ReturnType of the generic `stream` method degrades to `any`.) */
type MessageStream = Pick<BetaMessageStream, "on" | "abort">;

/**
 * The SDK request for one model call. Pure: it never changes `req` (blocks it adds a breakpoint to are copied), and
 * it reads only the fields it maps, so stray keys on `req` (temperature, tool_choice, …) never reach the API.
 * Throws a plain error for a request that cannot be sent (bad effort, too many breakpoints, …).
 */
export function buildStreamParams(req: ModelRequest): StreamParams {
  checkMaxTokens(req);
  const params: StreamParams = { ...sharedParams(req), max_tokens: req.maxTokens, stream: true };
  if (req.refusalFallback !== false && supportsServerFallback(req.model)) {
    params.betas = [SERVER_FALLBACK_BETA];
    params.fallbacks = "default";
  }
  return params;
}

/** The token-count request: the same prompt as buildStreamParams, without max_tokens, stream and fallbacks. */
export function buildCountTokensParams(req: Omit<ModelRequest, "maxTokens">): CountTokensParams {
  return sharedParams(req);
}

export interface AnthropicModelClientOptions {
  /** A ready SDK client (tests pass a stub). Without one, a client is made from `apiKey` or the environment. */
  client?: Anthropic;
  /** Default: the SDK's own lookup (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, an `ant auth login` profile). */
  apiKey?: string;
  /** The SDK's own retries per call before an error reaches the loop. Default 2. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default: the SDK's (10 minutes). */
  timeoutMs?: number;
}

export class AnthropicModelClient implements ModelClient {
  readonly #client: Anthropic;
  /** Applied to every call; set only for options given next to an injected client. */
  readonly #perRequest: Anthropic.RequestOptions;

  constructor(options: AnthropicModelClientOptions = {}) {
    const { client, apiKey, maxRetries, timeoutMs } = options;
    if (maxRetries !== undefined && (!Number.isSafeInteger(maxRetries) || maxRetries < 0)) {
      throw new RangeError(`AnthropicModelClient: maxRetries must be a whole number, 0 or more (got ${show(maxRetries)}).`);
    }
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new RangeError(`AnthropicModelClient: timeoutMs must be a positive number of ms (got ${show(timeoutMs)}).`);
    }
    if (client !== undefined && apiKey !== undefined) {
      throw new TypeError("AnthropicModelClient: pass either `client` or `apiKey`, not both.");
    }
    const timeout = timeoutMs === undefined ? {} : { timeout: timeoutMs };
    if (client !== undefined) {
      this.#client = client;
      this.#perRequest = { ...(maxRetries === undefined ? {} : { maxRetries }), ...timeout };
    } else {
      this.#client = new Anthropic({ ...(apiKey === undefined ? {} : { apiKey }), maxRetries: maxRetries ?? 2, ...timeout });
      this.#perRequest = {};
    }
  }

  async complete(req: ModelRequest, callbacks?: StreamCallbacks): Promise<Message> {
    if (req.signal?.aborted) throw new APIUserAbortError();
    const params = buildStreamParams(req);
    const stream = this.#client.beta.messages.stream(params, this.#options(req.signal));
    // Listeners and finalMessage() are attached before any await, so no stream event or error is missed.
    const relay = relayEvents(stream, callbacks);
    let message: Message;
    try {
      message = await stream.finalMessage();
    } catch (error) {
      throw relay.failed ? relay.error : error;
    }
    if (relay.failed) throw relay.error;
    callbacks?.onMessage?.(message);
    return message;
  }

  async countTokens(req: Omit<ModelRequest, "maxTokens">): Promise<number> {
    if (req.signal?.aborted) throw new APIUserAbortError();
    const params = buildCountTokensParams(req);
    const result = await this.#client.beta.messages.countTokens(params, this.#options(req.signal));
    return result.input_tokens;
  }

  #options(signal: AbortSignal | undefined): Anthropic.RequestOptions {
    return signal === undefined ? { ...this.#perRequest } : { ...this.#perRequest, signal };
  }
}

interface Relay {
  failed: boolean;
  error: unknown;
}

/**
 * Forwards text and thinking deltas, and each tool_use block as it starts. A callback that throws stops the stream
 * (no more tokens are paid for) and complete() rethrows that callback's own error, not the abort it caused.
 */
function relayEvents(stream: MessageStream, callbacks: StreamCallbacks | undefined): Relay {
  const relay: Relay = { failed: false, error: undefined };
  if (!callbacks) return relay;
  const deliver = (call: () => void): void => {
    if (relay.failed) return;
    try {
      call();
    } catch (error) {
      relay.failed = true;
      relay.error = error;
      stream.abort();
    }
  };
  stream.on("text", (delta) => deliver(() => callbacks.onText?.(delta)));
  stream.on("thinking", (delta) => deliver(() => callbacks.onThinking?.(delta)));
  stream.on("streamEvent", (event) => {
    if (event.type !== "content_block_start" || event.content_block.type !== "tool_use") return;
    const { id, name } = event.content_block;
    deliver(() => callbacks.onToolUse?.({ id, name }));
  });
  return relay;
}

function sharedParams(req: Omit<ModelRequest, "maxTokens">): SharedParams {
  checkRequest(req);
  const { system, cacheControl } = cacheLayout(req);
  const tools = req.tools ?? [];
  return {
    model: req.model,
    messages: [...req.messages],
    ...(system.length > 0 ? { system } : {}),
    // In the given order: the registry sorts them, and a stable order keeps the prompt cache warm.
    ...(tools.length > 0 ? { tools: [...tools] } : {}),
    ...(cacheControl ? { cache_control: cacheControl } : {}),
    output_config: { effort: req.effort },
    thinking: { type: "adaptive", display: req.thinkingDisplay ?? "omitted" },
  };
}

/**
 * Where the breakpoints go. Markers the caller already set are kept and counted; then, while slots remain, one on
 * the last system block (the stable prefix: tools + system), then top-level automatic caching (the conversation).
 */
function cacheLayout(req: Omit<ModelRequest, "maxTokens">): { system: SystemBlock[]; cacheControl?: CacheControl } {
  const scan = scanMarkers(req);
  if (scan.count > MAX_CACHE_BREAKPOINTS) {
    throw new RangeError(
      `The request already has ${scan.count} cache_control breakpoints; the API allows at most ${MAX_CACHE_BREAKPOINTS}.`,
    );
  }
  let free = MAX_CACHE_BREAKPOINTS - scan.count;
  const system = [...req.system];
  const lastIndex = system.length - 1;
  const last = system[lastIndex];
  if (last !== undefined && isRecord(last) && last.cache_control == null && free > 0) {
    // A 1-hour marker later in the conversation needs this earlier one to be 1-hour too (longer TTLs come first).
    const marker: CacheControl = scan.longTtlInMessages ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
    system[lastIndex] = { ...last, cache_control: marker };
    free -= 1;
  }
  // A marker on the very last block already caches the whole conversation; adding the automatic one there is a
  // no-op at the same TTL and a 400 at a different one.
  const automatic = free > 0 && !scan.lastBlockMarked;
  return automatic ? { system, cacheControl: { type: "ephemeral" } } : { system };
}

interface MarkerScan {
  /** cache_control markers already on tools, system blocks and message content blocks. */
  count: number;
  /** One of the message markers has the 1-hour TTL. */
  longTtlInMessages: boolean;
  /** The last content block of the last message has its own marker. */
  lastBlockMarked: boolean;
}

/**
 * Counts markers where the API reads them: tools, system blocks, message content blocks, and the blocks inside a
 * content block's `content` array (tool_result, search_result). Never inside tool `input` or other data, so a model's
 * tool arguments that contain a "cache_control" key cannot use up the slots.
 */
function scanMarkers(req: Omit<ModelRequest, "maxTokens">): MarkerScan {
  const scan: MarkerScan = { count: 0, longTtlInMessages: false, lastBlockMarked: false };
  for (const tool of req.tools ?? []) if (markerOf(tool) !== undefined) scan.count += 1;
  for (const block of req.system) if (markerOf(block) !== undefined) scan.count += 1;
  req.messages.forEach((message, messageIndex) => {
    const blocks: unknown[] = isRecord(message) && Array.isArray(message.content) ? message.content : [];
    blocks.forEach((block, blockIndex) => {
      for (const marker of markersIn(block)) {
        scan.count += 1;
        if (isRecord(marker) && marker.ttl === "1h") scan.longTtlInMessages = true;
      }
      if (messageIndex === req.messages.length - 1 && blockIndex === blocks.length - 1) {
        scan.lastBlockMarked = markerOf(block) !== undefined;
      }
    });
  });
  return scan;
}

function markersIn(block: unknown): unknown[] {
  const own = markerOf(block);
  const markers = own === undefined ? [] : [own];
  const nested = isRecord(block) ? block.content : undefined;
  if (Array.isArray(nested)) {
    for (const inner of nested) {
      const marker = markerOf(inner);
      if (marker !== undefined) markers.push(marker);
    }
  }
  return markers;
}

/** The block's cache_control value, or undefined when it has none (null counts as none). */
function markerOf(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const marker = value.cache_control;
  return marker === null ? undefined : marker;
}

function checkRequest(req: Omit<ModelRequest, "maxTokens">): void {
  if (!isRecord(req)) throw new TypeError(`ModelRequest must be an object (got ${show(req)}).`);
  if (typeof req.model !== "string" || req.model.trim() === "") {
    throw new TypeError(`ModelRequest.model must be a model id such as "claude-opus-5-5" (got ${show(req.model)}).`);
  }
  if (!isEffort(req.effort)) {
    throw new TypeError(
      `ModelRequest.effort must be one of ${EFFORTS.join(", ")} (got ${show(req.effort)}); it is always sent explicitly.`,
    );
  }
  if (!Array.isArray(req.system)) throw new TypeError(`ModelRequest.system must be an array of text blocks (got ${show(req.system)}).`);
  if (!Array.isArray(req.messages)) throw new TypeError(`ModelRequest.messages must be an array (got ${show(req.messages)}).`);
  if (req.tools !== undefined && !Array.isArray(req.tools)) {
    throw new TypeError(`ModelRequest.tools must be an array when given (got ${show(req.tools)}).`);
  }
  if (req.thinkingDisplay !== undefined && req.thinkingDisplay !== "summarized" && req.thinkingDisplay !== "omitted") {
    throw new TypeError(`ModelRequest.thinkingDisplay must be "summarized" or "omitted" (got ${show(req.thinkingDisplay)}).`);
  }
  if (req.refusalFallback !== undefined && typeof req.refusalFallback !== "boolean") {
    throw new TypeError(`ModelRequest.refusalFallback must be true or false when given (got ${show(req.refusalFallback)}).`);
  }
}

function checkMaxTokens(req: ModelRequest): void {
  // Streaming rules out max_tokens 0 (cache pre-warming), so at least 1.
  if (!isRecord(req) || !Number.isSafeInteger(req.maxTokens) || req.maxTokens < 1) {
    throw new RangeError(`ModelRequest.maxTokens must be a whole number, 1 or more (got ${show(isRecord(req) ? req.maxTokens : req)}).`);
  }
}
