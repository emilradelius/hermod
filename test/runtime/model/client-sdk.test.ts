/**
 * AnthropicModelClient against the real SDK 1.1.0 client, with an injected `fetch` that serves scripted responses.
 * No network: this checks what actually goes over the wire (body, headers) and that the real stream delivers deltas,
 * tool_use starts, the final message and typed errors the way the client and the classifier expect.
 */
import Anthropic, { APIError, APIUserAbortError, AnthropicError, InternalServerError, RateLimitError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicModelClient, MODELS, SERVER_FALLBACK_BETA, classifyError } from "../../../src/model/index.js";
import type { ModelRequest, StreamCallbacks } from "../../../src/types.js";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

type Respond = (call: Captured, index: number) => Response;

function fakeFetch(respond: Respond): { fetch: typeof globalThis.fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Captured = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      signal: init?.signal,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

/** An SSE response that sends one event per read and errors like fetch does when the request is aborted. */
function sseResponse(events: Array<Record<string, unknown>>, signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  let index = 0;
  let finished = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => {
        if (finished) return;
        finished = true;
        controller.error(new DOMException("This operation was aborted", "AbortError"));
      });
    },
    pull(controller) {
      if (finished) return;
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        finished = true;
        controller.close();
      } else {
        controller.enqueue(encoder.encode(chunk));
      }
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function messageStart(model: string): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      id: "msg_sdk_1",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      container: null,
      context_management: null,
      usage: {
        input_tokens: 25,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: null,
        server_tool_use: null,
        service_tier: "standard",
        inference_geo: null,
        iterations: null,
        fallback_credit: null,
        output_tokens_details: null,
        speed: null,
      },
    },
  };
}

/** A turn with a thinking block, a text block and a tool call, streamed in pieces. */
function toolTurn(model: string, toolJson: [string, string] = ['{"q": ', '"hermod"}']): Array<Record<string, unknown>> {
  return [
    messageStart(model),
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking the files." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_abc" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "", citations: null } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "I'll look" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " it up." } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_sdk_1", name: "lookup", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: toolJson[0] } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: toolJson[1] } },
    { type: "content_block_stop", index: 2 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null, stop_details: null, container: null },
      usage: { output_tokens: 57 },
    },
    { type: "message_stop" },
  ];
}

function sdkClient(respond: Respond, maxRetries = 0): { client: AnthropicModelClient; calls: Captured[] } {
  const { fetch, calls } = fakeFetch(respond);
  const sdk = new Anthropic({ apiKey: "test-key", baseURL: "https://api.example.test", maxRetries, fetch });
  return { client: new AnthropicModelClient({ client: sdk }), calls };
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: MODELS.opus55,
    system: [{ type: "text", text: "Stable rules." }],
    messages: [{ role: "user", content: "Find hermod." }],
    tools: [{ name: "lookup", description: "Look something up.", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
    maxTokens: 16_000,
    effort: "medium",
    ...overrides,
  };
}

describe("AnthropicModelClient on the real SDK (injected fetch, no network)", () => {
  it("sends the beta request with the fallback header and only the allowed body fields", async () => {
    const { client, calls } = sdkClient((call) => sseResponse(toolTurn(MODELS.opus55), call.signal));
    await client.complete(request());
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://api.example.test/v1/messages?beta=true");
    expect(call?.headers.get("anthropic-beta")).toBe(SERVER_FALLBACK_BETA);
    expect(Object.keys(call?.body ?? {}).sort()).toStrictEqual(
      ["cache_control", "fallbacks", "max_tokens", "messages", "model", "output_config", "stream", "system", "thinking", "tools"].sort(),
    );
    expect(call?.body).toMatchObject({
      model: "claude-opus-5-5",
      stream: true,
      fallbacks: "default",
      output_config: { effort: "medium" },
      thinking: { type: "adaptive", display: "omitted" },
      cache_control: { type: "ephemeral" },
      system: [{ type: "text", text: "Stable rules.", cache_control: { type: "ephemeral" } }],
    });
  });

  it("sends no fallback and no fallback beta header for Haiku 5.5", async () => {
    const { client, calls } = sdkClient((call) => sseResponse(toolTurn(MODELS.haiku55), call.signal));
    await client.complete(request({ model: MODELS.haiku55, effort: "low" }));
    expect(calls[0]?.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
    expect("fallbacks" in (calls[0]?.body ?? {})).toBe(false);
  });

  it("delivers thinking and text deltas and the tool_use start in order, and returns the assembled message", async () => {
    const { client } = sdkClient((call) => sseResponse(toolTurn(MODELS.opus55), call.signal));
    const log: string[] = [];
    const callbacks: StreamCallbacks = {
      onThinking: (d) => log.push(`thinking:${d}`),
      onText: (d) => log.push(`text:${d}`),
      onToolUse: (b) => log.push(`tool:${b.name}#${b.id}`),
      onMessage: (m) => log.push(`message:${m.id}`),
    };
    const message = await client.complete(request(), callbacks);
    expect(log).toStrictEqual([
      "thinking:Checking the files.",
      "text:I'll look",
      "text: it up.",
      "tool:lookup#toolu_sdk_1",
      "message:msg_sdk_1",
    ]);
    expect(message.stop_reason).toBe("tool_use");
    expect(message.usage.output_tokens).toBe(57);
    expect(JSON.parse(JSON.stringify(message.content))).toStrictEqual([
      { type: "thinking", thinking: "Checking the files.", signature: "sig_abc" },
      { type: "text", text: "I'll look it up.", citations: null },
      { type: "tool_use", id: "toolu_sdk_1", name: "lookup", input: { q: "hermod" } },
    ]);
  });

  it("counts tokens on the beta count endpoint without max_tokens, stream, fallbacks or the fallback beta", async () => {
    const { client, calls } = sdkClient(() => jsonResponse(200, { input_tokens: 777, context_management: null }));
    const { maxTokens: _maxTokens, ...withoutMax } = request();
    expect(await client.countTokens(withoutMax)).toBe(777);
    expect(calls[0]?.url).toBe("https://api.example.test/v1/messages/count_tokens?beta=true");
    expect(calls[0]?.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
    for (const key of ["max_tokens", "stream", "fallbacks", "betas"]) expect(key in (calls[0]?.body ?? {})).toBe(false);
    expect(calls[0]?.body).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "medium" } });
  });
});

describe("AnthropicModelClient on the real SDK: errors", () => {
  it("a 429 arrives as the SDK's RateLimitError, and classifies as retry with the server's delay", async () => {
    const body = { type: "error", error: { type: "rate_limit_error", message: "Slow down" } };
    const { client } = sdkClient(() => jsonResponse(429, body, { "retry-after": "7" }));
    const error = await client.complete(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(classifyError(error)).toStrictEqual({
      kind: "rate_limit",
      action: "retry",
      status: 429,
      retryAfterMs: 7_000,
      message: "The Anthropic API rate limit was reached (429 rate_limit_error): Slow down",
    });
  });

  it("a 529 arrives as InternalServerError with status 529, and classifies as fallback", async () => {
    const body = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
    const { client } = sdkClient(() => jsonResponse(529, body));
    const error = await client.complete(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InternalServerError);
    expect(classifyError(error)).toMatchObject({ kind: "overloaded", action: "fallback", status: 529 });
  });

  it("an error event in the middle of the stream arrives as an APIError without a status, classified by its type", async () => {
    const events = [
      messageStart(MODELS.opus55),
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Part" } },
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ];
    const { client } = sdkClient((call) => sseResponse(events, call.signal));
    const error = await client.complete(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).status).toBeUndefined();
    expect((error as APIError).type).toBe("overloaded_error");
    const classified = classifyError(error);
    expect(classified).toMatchObject({ kind: "overloaded", action: "fallback" });
    expect(classified.status).toBeUndefined();
  });

  it("tool input that is not valid JSON arrives as a plain AnthropicError and classifies as retry", async () => {
    const { client } = sdkClient((call) => sseResponse(toolTurn(MODELS.opus55, ['{"q": ', "}"]), call.signal));
    const error = await client.complete(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnthropicError);
    expect(error).not.toBeInstanceOf(APIError);
    expect(classifyError(error)).toMatchObject({ kind: "unknown", action: "retry" });
  });

  it("uses the injected client's retries, overridden per call by maxRetries", async () => {
    const body = { type: "error", error: { type: "api_error", message: "Internal error" } };
    const { fetch, calls } = fakeFetch(() => jsonResponse(500, body, { "retry-after-ms": "1" }));
    const sdk = new Anthropic({ apiKey: "test-key", baseURL: "https://api.example.test", maxRetries: 5, fetch });
    const error = await new AnthropicModelClient({ client: sdk, maxRetries: 1 }).complete(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InternalServerError);
    expect(calls).toHaveLength(2);
  });

  it("a caller abort in the middle of the stream ends with APIUserAbortError", async () => {
    const controller = new AbortController();
    const { client } = sdkClient((call) => sseResponse(toolTurn(MODELS.opus55), call.signal));
    const onText = () => controller.abort();
    const error = await client.complete(request({ signal: controller.signal }), { onText }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIUserAbortError);
    expect(classifyError(error)).toMatchObject({ kind: "aborted", action: "abort" });
  });

  it("a callback that throws aborts the HTTP request and its own error comes back unchanged", async () => {
    const bug = new RangeError("renderer failed");
    const { client, calls } = sdkClient((call) => sseResponse(toolTurn(MODELS.opus55), call.signal));
    const seen: string[] = [];
    const callbacks: StreamCallbacks = {
      onText: (d) => {
        seen.push(d);
        throw bug;
      },
      onToolUse: (b) => seen.push(b.name),
    };
    await expect(client.complete(request(), callbacks)).rejects.toBe(bug);
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(seen).toStrictEqual(["I'll look"]);
  });
});
