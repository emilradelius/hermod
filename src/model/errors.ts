/**
 * Error → action, for the agent loop. Classify only after the SDK's own retries are exhausted (it already retries
 * 408, 409, 429, 5xx and connection errors, `maxRetries` times).
 *
 * Detection uses the SDK's typed error classes, then the HTTP status, then the API's typed `error.type` (a stream
 * that fails midway raises a plain APIError with no status). It never matches on message text: messages change.
 *
 * An SDK error that is not an HTTP error (`AnthropicError` but not `APIError`) is retried: in SDK 1.1.0 that is how a
 * dropped stream, a stream that ends early, and tool input that is not valid JSON all arrive, and the documented
 * remedy is to send the turn again (the loop caps retries). Missing credentials arrive the same way; they fail
 * before any request is sent, so the capped retries cost time but no money. Any other thrown value is aborted.
 *
 * Actions:
 * - retry: wait (`backoff`, honouring `retryAfterMs`) and send the same request again.
 * - fallback: the API is overloaded (529); switch to the configured fallback model (server-side refusal fallbacks
 *   never trigger on overload). Without one, the loop may retry with backoff or give up.
 * - compress: the request is too large; compress the conversation, then retry once.
 * - abort: retrying the same request cannot help.
 */
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AnthropicError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import type { ClassifiedError, ErrorAction } from "../types.js";
import { isRecord } from "./internal.js";

type ErrorKind = ClassifiedError["kind"];
type ApiErrorType = NonNullable<APIError["type"]>;

interface Rule {
  kind: ErrorKind;
  action: ErrorAction;
  summary: string;
}

const RULES = {
  aborted: { kind: "aborted", action: "abort", summary: "The request was cancelled before it finished" },
  timeout: { kind: "timeout", action: "retry", summary: "The request to the Anthropic API timed out" },
  connection: { kind: "connection", action: "retry", summary: "Could not reach the Anthropic API (network error)" },
  rateLimit: { kind: "rate_limit", action: "retry", summary: "The Anthropic API rate limit was reached" },
  overloaded: { kind: "overloaded", action: "fallback", summary: "The Anthropic API is overloaded" },
  server: { kind: "server", action: "retry", summary: "The Anthropic API had a server error" },
  conflict: { kind: "server", action: "retry", summary: "The Anthropic API reported a conflict; it is safe to retry" },
  tooLarge: { kind: "context_too_long", action: "compress", summary: "The request is too large for the API" },
  overflow: {
    kind: "context_too_long",
    action: "compress",
    summary: "The prompt is probably longer than the model's context window",
  },
  auth: { kind: "auth", action: "abort", summary: "The API key was rejected" },
  billing: { kind: "permission", action: "abort", summary: "The account cannot be billed for this request" },
  permission: { kind: "permission", action: "abort", summary: "The API key is not allowed to do this" },
  notFound: { kind: "not_found", action: "abort", summary: "The model or endpoint was not found (check the model id)" },
  badRequest: { kind: "bad_request", action: "abort", summary: "The API rejected the request as invalid" },
  sdk: {
    kind: "unknown",
    action: "retry",
    summary: "The SDK failed while sending or streaming the request (for example a dropped stream)",
  },
  unknown: { kind: "unknown", action: "abort", summary: "Unexpected error" },
} as const satisfies Record<string, Rule>;

/** For a status-less APIError (an `error` event in the middle of a stream), by the API's `error.type`. */
const RULE_BY_TYPE: Readonly<Record<ApiErrorType, Rule>> = {
  invalid_request_error: RULES.badRequest,
  authentication_error: RULES.auth,
  permission_error: RULES.permission,
  not_found_error: RULES.notFound,
  rate_limit_error: RULES.rateLimit,
  timeout_error: RULES.timeout,
  overloaded_error: RULES.overloaded,
  api_error: RULES.server,
  billing_error: RULES.billing,
};

/** What the loop knows about the failed request, to recognise a context-window overflow. */
export interface OverflowContext {
  /** The failed request's prompt size in tokens (from countTokens, or the last usage plus what was appended). */
  promptTokens: number;
  /** The model's real context window: `contextWindow(model)`, not the smaller window compression aims for. */
  windowTokens: number;
  /** How close to the window counts as "near". Default 0.9. */
  nearFraction?: number;
}

/**
 * Maps any thrown value to { kind, action, status?, retryAfterMs?, message }. Never throws.
 * Pass `overflow` to have a likely context-window overflow (see isLikelyContextOverflow) classified as compress.
 */
export function classifyError(error: unknown, overflow?: OverflowContext): ClassifiedError {
  try {
    const rule = overflow && isLikelyContextOverflow(error, overflow) ? RULES.overflow : ruleFor(error);
    return describe(rule, error);
  } catch {
    return { kind: "unknown", action: "abort", message: "Unexpected error (it could not be described)." };
  }
}

/**
 * True for a 400 invalid_request_error sent while the prompt was near the model's context window. The API has no
 * stable code for "prompt is too long", so this decides from the error's class and type plus the request's size,
 * never from the message text. (An overflow on the output side is `stop_reason: "model_context_window_exceeded"`.)
 */
export function isLikelyContextOverflow(error: unknown, context: OverflowContext): boolean {
  if (!(error instanceof BadRequestError) || error.type !== "invalid_request_error") return false;
  if (context === null || typeof context !== "object") return false;
  const { promptTokens, windowTokens } = context;
  const nearFraction = context.nearFraction ?? 0.9;
  if (![promptTokens, windowTokens, nearFraction].every(Number.isFinite) || windowTokens <= 0) return false;
  return promptTokens >= windowTokens * nearFraction;
}

/**
 * The server's requested delay in ms, from `retry-after-ms` or `retry-after` (seconds or an HTTP date), as the SDK
 * reads them. Undefined when absent, unreadable, not positive, or longer than a timer can wait.
 */
export function parseRetryAfter(headers: Headers | undefined | null, nowMs: number = Date.now()): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get("retry-after-ms");
  const seconds = headers.get("retry-after");
  let delay: number | undefined;
  if (ms !== null && ms.trim() !== "") delay = Number(ms);
  if ((delay === undefined || Number.isNaN(delay)) && seconds !== null && seconds.trim() !== "") {
    const asNumber = Number(seconds);
    delay = Number.isNaN(asNumber) ? Date.parse(seconds) - nowMs : asNumber * 1000;
  }
  if (delay === undefined || !Number.isFinite(delay) || delay <= 0 || delay > MAX_TIMER_MS) return undefined;
  return Math.ceil(delay);
}

export interface BackoffOptions {
  /** The first retry's delay before jitter. Default 1,000 ms. */
  baseMs?: number;
  /** No delay is longer than this, a server hint included. Default 60,000 ms. */
  capMs?: number;
  /** A number in [0, 1); injected so tests are deterministic. Default Math.random. */
  random?: () => number;
  /** The server's hint (ClassifiedError.retryAfterMs): wait at least this long, up to capMs. */
  retryAfterMs?: number;
}

/**
 * The delay before retry number `attempt` (1 for the first retry): exponential (base × 2^(attempt−1)) with equal
 * jitter (between half and all of it), never less than the server's hint, never more than the cap.
 */
export function backoff(attempt: number, options: BackoffOptions = {}): number {
  if (typeof attempt !== "number" || Number.isNaN(attempt)) {
    throw new RangeError(`backoff: attempt must be a number, 1 for the first retry (got ${String(attempt)}).`);
  }
  const baseMs = nonNegative(options.baseMs ?? 1_000, "baseMs");
  const capMs = nonNegative(options.capMs ?? 60_000, "capMs");
  const step = Math.max(1, Math.floor(attempt));
  // 2^60 ms is far past any cap; stopping there keeps 0 × 2^∞ (NaN) out of the sum.
  const exponential = Math.min(capMs, baseMs * 2 ** Math.min(step - 1, 60));
  const jittered = exponential / 2 + (exponential / 2) * unitInterval((options.random ?? Math.random)());
  const hint = options.retryAfterMs;
  const delay = typeof hint === "number" && Number.isFinite(hint) && hint > 0 ? Math.max(jittered, hint) : jittered;
  return Math.round(Math.min(capMs, delay));
}

/** The longest delay one timer can represent (setTimeout fires at once for anything longer). */
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_DETAIL_CHARS = 300;

function ruleFor(error: unknown): Rule {
  if (error instanceof APIUserAbortError) return RULES.aborted;
  if (error instanceof APIConnectionTimeoutError) return RULES.timeout;
  if (error instanceof APIConnectionError) return RULES.connection;
  if (error instanceof APIError) return ruleForApiError(error);
  // Includes RetryableError (thrown by middleware to ask for a retry) and errors the stream wrapped.
  if (error instanceof AnthropicError) return RULES.sdk;
  return RULES.unknown;
}

function ruleForApiError(error: APIError): Rule {
  if (error instanceof RateLimitError) return RULES.rateLimit;
  if (error instanceof InternalServerError) return isOverloaded(error) ? RULES.overloaded : RULES.server;
  if (error instanceof AuthenticationError) return RULES.auth;
  if (error instanceof PermissionDeniedError) return RULES.permission;
  if (error instanceof NotFoundError) return RULES.notFound;
  if (error instanceof ConflictError) return RULES.conflict;
  if (error instanceof BadRequestError || error instanceof UnprocessableEntityError) return RULES.badRequest;
  if (typeof error.status === "number") return ruleForStatus(error.status, error);
  return ruleForType(error.type);
}

/** A status-less APIError is an `error` event sent in the middle of a stream; the server failed, so retry by default. */
function ruleForType(type: string | null): Rule {
  return type !== null && Object.hasOwn(RULE_BY_TYPE, type) ? RULE_BY_TYPE[type as ApiErrorType] : RULES.server;
}

/** Statuses the SDK raises as a plain APIError (402, 408, 413, …), and any status on a hand-built APIError. */
function ruleForStatus(status: number, error: APIError): Rule {
  if (status === 529 || error.type === "overloaded_error") return RULES.overloaded;
  if (status >= 500) return RULES.server;
  if (status === 408) return RULES.timeout;
  if (status === 409) return RULES.conflict;
  if (status === 413) return RULES.tooLarge;
  if (status === 429) return RULES.rateLimit;
  if (status === 401) return RULES.auth;
  if (status === 402) return RULES.billing;
  if (status === 403) return RULES.permission;
  if (status === 404) return RULES.notFound;
  if (status >= 400) return RULES.badRequest;
  return RULES.unknown;
}

function isOverloaded(error: APIError): boolean {
  return error.status === 529 || error.type === "overloaded_error";
}

function describe(rule: Rule, error: unknown): ClassifiedError {
  const result: ClassifiedError = { kind: rule.kind, action: rule.action, message: "" };
  let label = "";
  if (error instanceof APIError) {
    if (typeof error.status === "number") result.status = error.status;
    const retryAfterMs = parseRetryAfter(error.headers);
    if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
    label = [error.status, error.type].filter((part) => part !== undefined && part !== null).join(" ");
  }
  const detail = detailOf(error);
  result.message = `${rule.summary}${label ? ` (${label})` : ""}${detail ? `: ${detail}` : "."}`;
  return result;
}

/** The API's own explanation when there is one (for people to read, never to match on), else the error message. */
function detailOf(error: unknown): string {
  if (error instanceof APIError) {
    const body: unknown = error.error;
    const inner = isRecord(body) && isRecord(body.error) ? body.error : body;
    if (isRecord(inner) && typeof inner.message === "string") return truncate(inner.message);
  }
  if (error instanceof Error) return typeof error.message === "string" ? truncate(error.message) : "";
  if (typeof error === "string") return truncate(error);
  return error === undefined || error === null ? "" : `a thrown value of type ${typeof error}`;
}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_DETAIL_CHARS) return trimmed;
  let cut = trimmed.slice(0, MAX_DETAIL_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function unitInterval(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function nonNegative(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`backoff: ${name} must be a finite number of milliseconds, 0 or more (got ${String(value)}).`);
  }
  return value;
}
