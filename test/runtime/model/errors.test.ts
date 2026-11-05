import {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AnthropicError,
  BadRequestError,
  RetryableError,
} from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { backoff, classifyError, isLikelyContextOverflow, parseRetryAfter } from "../../../src/model/index.js";
import { apiError, connectionError } from "../../../src/testing/index.js";
import type { ClassifiedError } from "../../../src/types.js";

/** An `error` event in the middle of a stream: the SDK raises a plain APIError with no status. */
function midStreamError(type: string | null, message = "Something failed"): APIError {
  const body = { type: "error", error: { type, message } };
  return new APIError(undefined, body, undefined, new Headers(), type as APIError["type"]);
}

function pick(error: unknown): Pick<ClassifiedError, "kind" | "action" | "status"> {
  const { kind, action, status } = classifyError(error);
  return status === undefined ? { kind, action } : { kind, action, status };
}

describe("classifyError: every row of the error table", () => {
  const rows: Array<[string, unknown, Pick<ClassifiedError, "kind" | "action" | "status">]> = [
    ["network failure", connectionError(), { kind: "connection", action: "retry" }],
    ["request timeout", new APIConnectionTimeoutError(), { kind: "timeout", action: "retry" }],
    ["caller abort", new APIUserAbortError(), { kind: "aborted", action: "abort" }],
    ["429 rate_limit_error", apiError(429, "Slow down"), { kind: "rate_limit", action: "retry", status: 429 }],
    ["500 api_error", apiError(500, "Internal error"), { kind: "server", action: "retry", status: 500 }],
    ["503", apiError(503, "Unavailable"), { kind: "server", action: "retry", status: 503 }],
    ["529 overloaded_error", apiError(529, "Overloaded"), { kind: "overloaded", action: "fallback", status: 529 }],
    ["500 with type overloaded_error", apiError(500, "Overloaded", { type: "overloaded_error" }), { kind: "overloaded", action: "fallback", status: 500 }],
    ["408 (plain APIError)", apiError(408, "Request timeout", { type: "timeout_error" }), { kind: "timeout", action: "retry", status: 408 }],
    ["409 ConflictError", apiError(409, "Conflict"), { kind: "server", action: "retry", status: 409 }],
    ["400 invalid_request_error", apiError(400, "messages: field required"), { kind: "bad_request", action: "abort", status: 400 }],
    [
      "400 preserved-thinking mismatch",
      apiError(400, "Invalid `signature` in `thinking` block: bound to a different conversation"),
      { kind: "bad_request", action: "abort", status: 400 },
    ],
    ["413 request_too_large", apiError(413, "Request too large"), { kind: "context_too_long", action: "compress", status: 413 }],
    ["401", apiError(401, "invalid x-api-key"), { kind: "auth", action: "abort", status: 401 }],
    ["402 billing_error", apiError(402, "Credit balance too low", { type: "billing_error" }), { kind: "permission", action: "abort", status: 402 }],
    ["403", apiError(403, "Not allowed"), { kind: "permission", action: "abort", status: 403 }],
    ["404", apiError(404, "model: claude-nope"), { kind: "not_found", action: "abort", status: 404 }],
    ["422", apiError(422, "Unprocessable", { type: "invalid_request_error" }), { kind: "bad_request", action: "abort", status: 422 }],
  ];

  for (const [name, error, expected] of rows) {
    it(`${name} → ${expected.kind} / ${expected.action}`, () => {
      expect(pick(error)).toEqual(expected);
    });
  }

  it("the test errors are the real SDK classes (so the rows above test real detection)", () => {
    expect(apiError(400, "x")).toBeInstanceOf(BadRequestError);
    expect(apiError(408, "x").constructor).toBe(APIError);
    expect(apiError(413, "x").constructor).toBe(APIError);
  });
});

describe("classifyError: errors raised in the middle of a stream (no HTTP status)", () => {
  it("uses the API's typed error.type", () => {
    expect(pick(midStreamError("overloaded_error"))).toEqual({ kind: "overloaded", action: "fallback" });
    expect(pick(midStreamError("api_error"))).toEqual({ kind: "server", action: "retry" });
    expect(pick(midStreamError("rate_limit_error"))).toEqual({ kind: "rate_limit", action: "retry" });
    expect(pick(midStreamError("invalid_request_error"))).toEqual({ kind: "bad_request", action: "abort" });
    expect(pick(midStreamError("authentication_error"))).toEqual({ kind: "auth", action: "abort" });
    expect(pick(midStreamError("billing_error"))).toEqual({ kind: "permission", action: "abort" });
  });

  it("treats a missing or new error type as a server failure worth retrying", () => {
    expect(pick(midStreamError(null))).toEqual({ kind: "server", action: "retry" });
    expect(pick(midStreamError("brand_new_error"))).toEqual({ kind: "server", action: "retry" });
    expect(pick(midStreamError("constructor"))).toEqual({ kind: "server", action: "retry" });
  });
});

describe("classifyError: SDK errors that are not HTTP errors, and everything else", () => {
  it("retries SDK stream failures (dropped stream, bad tool JSON, middleware RetryableError)", () => {
    const dropped = new AnthropicError("terminated");
    const badJson = new AnthropicError("Unable to parse tool parameter JSON from model.");
    const wrapped = Object.assign(new AnthropicError("Unexpected token"), { cause: new SyntaxError("Unexpected token") });
    for (const error of [dropped, badJson, wrapped, new RetryableError()]) {
      expect(pick(error)).toEqual({ kind: "unknown", action: "retry" });
    }
  });

  it("aborts on anything that is not an SDK error (a bug in our code or a callback)", () => {
    for (const error of [new TypeError("x is undefined"), new Error("boom"), "a string", 42, undefined, null, { any: "object" }]) {
      expect(pick(error)).toEqual({ kind: "unknown", action: "abort" });
    }
  });

  it("never throws, even for hostile thrown values", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("trap");
      },
      getPrototypeOf() {
        throw new Error("trap");
      },
    });
    const badToString = { toString: () => { throw new Error("nope"); } };
    const weirdMessage = Object.assign(new Error("x"), { message: { not: "a string" } });
    for (const value of [hostile, badToString, weirdMessage]) {
      const result = classifyError(value);
      expect(result.action).toBe("abort");
      expect(typeof result.message).toBe("string");
    }
  });
});

describe("classifyError: detection never reads the message text", () => {
  it("classifies by class and status even when the message says something else", () => {
    expect(pick(apiError(500, "rate limit exceeded, overloaded, prompt is too long"))).toEqual({ kind: "server", action: "retry", status: 500 });
    expect(pick(apiError(429, "The server is overloaded"))).toEqual({ kind: "rate_limit", action: "retry", status: 429 });
    expect(pick(apiError(400, "prompt is too long: 1200000 tokens > 1000000 maximum"))).toEqual({ kind: "bad_request", action: "abort", status: 400 });
  });

  it("writes a plain-English message with the status, type and the API's own words, kept short", () => {
    expect(classifyError(apiError(429, "Slow down")).message).toBe(
      "The Anthropic API rate limit was reached (429 rate_limit_error): Slow down",
    );
    expect(classifyError(connectionError()).message).toBe("Could not reach the Anthropic API (network error): Connection error.");
    const long = classifyError(apiError(400, "x".repeat(5_000))).message;
    expect(long.length).toBeLessThan(400);
    expect(long.endsWith("…")).toBe(true);
    const emoji = classifyError(apiError(400, `${"a".repeat(299)}🎉🎉`)).message;
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("classifyError: retry-after", () => {
  it("reports the server's retry-after as retryAfterMs", () => {
    expect(classifyError(apiError(429, "Slow down", { retryAfterSeconds: 3 })).retryAfterMs).toBe(3_000);
    expect(classifyError(apiError(529, "Overloaded", { retryAfterSeconds: 1.5 })).retryAfterMs).toBe(1_500);
    expect(classifyError(apiError(429, "Slow down")).retryAfterMs).toBeUndefined();
    expect(classifyError(connectionError()).retryAfterMs).toBeUndefined();
  });

  it("parseRetryAfter reads retry-after-ms first, then retry-after as seconds or an HTTP date", () => {
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "250", "retry-after": "9" }))).toBe(250);
    expect(parseRetryAfter(new Headers({ "retry-after": "2" }))).toBe(2_000);
    expect(parseRetryAfter(new Headers({ "retry-after": "0.0004" }))).toBe(1);
    const now = Date.parse("2026-11-05T20:00:00Z");
    expect(parseRetryAfter(new Headers({ "retry-after": "Thu, 05 Nov 2026 20:00:30 GMT" }), now)).toBe(30_000);
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "soon", "retry-after": "4" }))).toBe(4_000);
  });

  it("parseRetryAfter ignores missing, zero, negative, past, unreadable and absurd values", () => {
    const now = Date.parse("2026-11-05T20:00:00Z");
    for (const value of ["0", "-5", "soon", "", "  ", "Thu, 05 Nov 2026 19:00:00 GMT", String(10 ** 12), "Infinity", "NaN"]) {
      expect(parseRetryAfter(new Headers({ "retry-after": value }), now)).toBeUndefined();
    }
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(new Headers())).toBeUndefined();
  });
});

describe("isLikelyContextOverflow", () => {
  const tooLong = apiError(400, "prompt is too long");
  const unrelated = apiError(400, "tools.0: unknown field");

  it("is true for a 400 invalid_request_error sent while the prompt was near the window", () => {
    expect(isLikelyContextOverflow(tooLong, { promptTokens: 950_000, windowTokens: 1_000_000 })).toBe(true);
    expect(isLikelyContextOverflow(tooLong, { promptTokens: 900_000, windowTokens: 1_000_000 })).toBe(true);
    expect(isLikelyContextOverflow(tooLong, { promptTokens: 1_200_000, windowTokens: 1_000_000 })).toBe(true);
  });

  it("is false when the prompt was well inside the window, whatever the message says", () => {
    expect(isLikelyContextOverflow(tooLong, { promptTokens: 899_999, windowTokens: 1_000_000 })).toBe(false);
    expect(isLikelyContextOverflow(tooLong, { promptTokens: 2_000, windowTokens: 1_000_000 })).toBe(false);
  });

  it("decides from size, not wording: an unrelated message near the window still counts", () => {
    expect(isLikelyContextOverflow(unrelated, { promptTokens: 990_000, windowTokens: 1_000_000 })).toBe(true);
  });

  it("is false for other error classes and types", () => {
    const near = { promptTokens: 999_999, windowTokens: 1_000_000 };
    for (const error of [apiError(413, "too large"), apiError(500, "x"), apiError(400, "x", { type: "billing_error" }), midStreamError("invalid_request_error"), new Error("prompt is too long"), "prompt is too long"]) {
      expect(isLikelyContextOverflow(error, near)).toBe(false);
    }
  });

  it("takes a custom nearFraction and returns false for nonsense sizes", () => {
    expect(isLikelyContextOverflow(tooLong, { promptTokens: 600_000, windowTokens: 1_000_000, nearFraction: 0.5 })).toBe(true);
    expect(isLikelyContextOverflow(tooLong, { promptTokens: 600_000, windowTokens: 1_000_000, nearFraction: 0.7 })).toBe(false);
    for (const context of [
      { promptTokens: Number.NaN, windowTokens: 1_000_000 },
      { promptTokens: 10, windowTokens: 0 },
      { promptTokens: 10, windowTokens: -5 },
      { promptTokens: 10, windowTokens: Number.POSITIVE_INFINITY },
    ]) {
      expect(isLikelyContextOverflow(tooLong, context)).toBe(false);
    }
    expect(isLikelyContextOverflow(tooLong, null as unknown as { promptTokens: number; windowTokens: number })).toBe(false);
  });

  it("lets classifyError turn a likely overflow into compress", () => {
    expect(pick(tooLong)).toEqual({ kind: "bad_request", action: "abort", status: 400 });
    const classified = classifyError(tooLong, { promptTokens: 960_000, windowTokens: 1_000_000 });
    expect(classified).toMatchObject({ kind: "context_too_long", action: "compress", status: 400 });
    expect(classifyError(tooLong, { promptTokens: 1_000, windowTokens: 1_000_000 }).action).toBe("abort");
  });
});

describe("backoff", () => {
  const fixed = (value: number) => () => value;

  it("grows exponentially with equal jitter (between half and all of the step)", () => {
    expect(backoff(1, { random: fixed(0) })).toBe(500);
    expect(backoff(1, { random: fixed(0.999999) })).toBe(1_000);
    expect(backoff(2, { random: fixed(0) })).toBe(1_000);
    expect(backoff(3, { random: fixed(0.5) })).toBe(3_000);
    expect(backoff(4, { baseMs: 100, random: fixed(0) })).toBe(400);
  });

  it("never waits longer than the cap, however many attempts", () => {
    for (const attempt of [10, 100, 1e9, Number.POSITIVE_INFINITY]) {
      expect(backoff(attempt, { random: fixed(0.999999) })).toBe(60_000);
      expect(backoff(attempt, { capMs: 5_000, random: fixed(0.999999) })).toBe(5_000);
    }
  });

  it("honours the server's hint, but still within the cap", () => {
    expect(backoff(1, { random: fixed(0), retryAfterMs: 7_000 })).toBe(7_000);
    expect(backoff(1, { random: fixed(0), retryAfterMs: 100 })).toBe(500);
    expect(backoff(1, { random: fixed(0), retryAfterMs: 10 ** 9 })).toBe(60_000);
    expect(backoff(1, { random: fixed(0), retryAfterMs: Number.NaN })).toBe(500);
  });

  it("treats attempts below 1 as the first retry and survives a broken random source", () => {
    expect(backoff(0, { random: fixed(0) })).toBe(500);
    expect(backoff(-3, { random: fixed(0) })).toBe(500);
    expect(backoff(1, { random: fixed(Number.NaN) })).toBe(500);
    expect(backoff(1, { random: fixed(7) })).toBe(1_000);
    expect(backoff(1, { random: fixed(-7) })).toBe(500);
    expect(backoff(Number.POSITIVE_INFINITY, { baseMs: 0 })).toBe(0);
  });

  it("varies with the default random source but stays in range", () => {
    for (let i = 0; i < 50; i += 1) {
      const delay = backoff(2);
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThanOrEqual(2_000);
    }
  });

  it("rejects a non-number attempt and invalid base or cap", () => {
    expect(() => backoff(Number.NaN)).toThrow(/attempt must be a number/);
    expect(() => backoff("2" as unknown as number)).toThrow(/attempt must be a number/);
    expect(() => backoff(1, { baseMs: -1 })).toThrow(/baseMs/);
    expect(() => backoff(1, { capMs: Number.POSITIVE_INFINITY })).toThrow(/capMs/);
  });
});
