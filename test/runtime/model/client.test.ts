import { APIConnectionError, APIUserAbortError, RateLimitError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  AnthropicModelClient,
  EFFORTS,
  MAX_CACHE_BREAKPOINTS,
  MODELS,
  SERVER_FALLBACK_BETA,
  buildCountTokensParams,
  buildStreamParams,
} from "../../../src/model/index.js";
import { apiError, textMessage, toolUseMessage } from "../../../src/testing/index.js";
import type { MessageParam, ModelClient, ModelRequest, StreamCallbacks, TextBlockParam, ToolParam } from "../../../src/types.js";
import { countBreakpoints, deepFreeze, stubClient } from "./stub-sdk.js";

const STABLE: TextBlockParam = { type: "text", text: "Stable rules and the agent's own prompt." };
const SNAPSHOT: TextBlockParam = { type: "text", text: "Frozen memory snapshot and skills index." };
const EPHEMERAL = { type: "ephemeral" } as const;

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: MODELS.opus55,
    system: [STABLE, SNAPSHOT],
    messages: [{ role: "user", content: "Hello" }],
    maxTokens: 16_000,
    effort: "medium",
    ...overrides,
  };
}

function tool(name: string, extra: Partial<ToolParam> = {}): ToolParam {
  return { name, description: `Call ${name} when you need it.`, input_schema: { type: "object", properties: {} }, ...extra };
}

/** A user turn whose single text block carries a caller-set marker. */
function markedTurn(text: string, ttl?: "5m" | "1h"): MessageParam {
  const cache_control = ttl ? { type: "ephemeral" as const, ttl } : EPHEMERAL;
  return { role: "user", content: [{ type: "text", text, cache_control }] };
}

const ALLOWED_KEYS = new Set([
  "model",
  "max_tokens",
  "stream",
  "system",
  "messages",
  "tools",
  "cache_control",
  "output_config",
  "thinking",
  "betas",
  "fallbacks",
]);

describe("buildStreamParams: the request for each model", () => {
  it("Opus 5.5: cache breakpoints, explicit effort, adaptive thinking and the server-side refusal fallback", () => {
    expect(buildStreamParams(request())).toStrictEqual({
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "Hello" }],
      system: [STABLE, { ...SNAPSHOT, cache_control: EPHEMERAL }],
      cache_control: EPHEMERAL,
      output_config: { effort: "medium" },
      thinking: { type: "adaptive", display: "omitted" },
      max_tokens: 16_000,
      stream: true,
      betas: [SERVER_FALLBACK_BETA],
      fallbacks: "default",
    });
    expect(SERVER_FALLBACK_BETA).toBe("server-side-fallback-2026-07-01");
  });

  it("Haiku 5.5: no fallbacks parameter and no beta header at all", () => {
    const params = buildStreamParams(request({ model: MODELS.haiku55, effort: "low", maxTokens: 4_000 }));
    expect("fallbacks" in params).toBe(false);
    expect("betas" in params).toBe(false);
    expect(params.output_config).toStrictEqual({ effort: "low" });
    expect(params.max_tokens).toBe(4_000);
  });

  it("Sonnet 5.5 gets the fallback; a model Hermod does not know does not", () => {
    expect(buildStreamParams(request({ model: MODELS.sonnet55 })).fallbacks).toBe("default");
    const other = buildStreamParams(request({ model: "claude-opus-4-8" }));
    expect("fallbacks" in other || "betas" in other).toBe(false);
  });

  it("refusalFallback: false turns the fallback off; true cannot turn it on for Haiku", () => {
    const off = buildStreamParams(request({ refusalFallback: false }));
    expect("fallbacks" in off || "betas" in off).toBe(false);
    const haiku = buildStreamParams(request({ model: MODELS.haiku55, refusalFallback: true }));
    expect("fallbacks" in haiku || "betas" in haiku).toBe(false);
  });
});

describe("buildStreamParams: never sampling parameters, prefill or forced tool choice", () => {
  it("ignores stray keys on the request, even ones that try to override the rules", () => {
    const hostile = {
      ...request(),
      temperature: 0.2,
      top_p: 0.9,
      top_k: 5,
      tool_choice: { type: "any" },
      stop_sequences: ["STOP"],
      speed: "fast",
      max_tokens: 1,
      thinking: { type: "disabled" },
      output_config: { effort: "max" },
      betas: ["something-else"],
      fallbacks: [{ model: "claude-haiku-4-5" }],
      signal: new AbortController().signal,
      purpose: "main",
    } as unknown as ModelRequest;
    const params = buildStreamParams(hostile);
    for (const key of ["temperature", "top_p", "top_k", "tool_choice", "stop_sequences", "speed", "signal", "purpose"]) {
      expect(key in params).toBe(false);
    }
    expect(params.max_tokens).toBe(16_000);
    expect(params.thinking).toStrictEqual({ type: "adaptive", display: "omitted" });
    expect(params.output_config).toStrictEqual({ effort: "medium" });
    expect(params.betas).toStrictEqual([SERVER_FALLBACK_BETA]);
    expect(params.fallbacks).toBe("default");
  });

  it("for every model, effort and display, uses only the allowed keys and always sets effort and adaptive thinking", () => {
    for (const model of [...Object.values(MODELS), "claude-opus-4-8"]) {
      for (const effort of EFFORTS) {
        for (const thinkingDisplay of [undefined, "summarized", "omitted"] as const) {
          const params = buildStreamParams(request({ model, effort, thinkingDisplay, tools: [tool("lookup")] }));
          for (const key of Object.keys(params)) expect(ALLOWED_KEYS.has(key)).toBe(true);
          expect(params.output_config).toStrictEqual({ effort });
          expect(params.thinking).toStrictEqual({ type: "adaptive", display: thinkingDisplay ?? "omitted" });
          expect(JSON.stringify(params)).not.toMatch(/budget_tokens|"disabled"|temperature|top_p|top_k|tool_choice/);
        }
      }
    }
  });

  it("refuses a request without a valid effort or with an unknown thinking display", () => {
    for (const effort of [undefined, "", "extreme", "MAX", null]) {
      expect(() => buildStreamParams(request({ effort: effort as ModelRequest["effort"] }))).toThrow(/effort must be one of/);
    }
    expect(() => buildStreamParams(request({ thinkingDisplay: "updates" as "omitted" }))).toThrow(/thinkingDisplay/);
  });
});

describe("buildStreamParams: cache breakpoints", () => {
  it("marks only the last system block, keeps the earlier ones as given, and adds top-level automatic caching", () => {
    const req = request();
    const params = buildStreamParams(req);
    const system = params.system as TextBlockParam[];
    expect(system[0]).toBe(STABLE);
    expect(system[1]).toStrictEqual({ ...SNAPSHOT, cache_control: EPHEMERAL });
    expect(params.cache_control).toStrictEqual(EPHEMERAL);
    expect(countBreakpoints(params)).toBe(2);
  });

  it("with no system blocks sends no system field and uses automatic caching only", () => {
    const params = buildStreamParams(request({ system: [] }));
    expect("system" in params).toBe(false);
    expect(params.cache_control).toStrictEqual(EPHEMERAL);
    expect(countBreakpoints(params)).toBe(1);
  });

  it("counts the caller's own markers and adds only as many as fit in 4", () => {
    const turns = (n: number): MessageParam[] => {
      const out: MessageParam[] = [];
      for (let i = 0; i < n; i += 1) out.push(markedTurn(`turn ${i}`), { role: "assistant", content: `reply ${i}` });
      return [...out, { role: "user", content: "latest question" }];
    };
    const two = buildStreamParams(request({ messages: turns(2) }));
    expect(countBreakpoints(two)).toBe(4);
    expect(two.cache_control).toStrictEqual(EPHEMERAL);
    const three = buildStreamParams(request({ messages: turns(3) }));
    expect(countBreakpoints(three)).toBe(4);
    expect((three.system as TextBlockParam[])[1]?.cache_control).toStrictEqual(EPHEMERAL);
    expect("cache_control" in three).toBe(false);
    const four = buildStreamParams(request({ messages: turns(4) }));
    expect(countBreakpoints(four)).toBe(4);
    expect((four.system as TextBlockParam[])[1]).toBe(SNAPSHOT);
    expect(() => buildStreamParams(request({ messages: turns(5) }))).toThrow(
      /already has 5 cache_control breakpoints; the API allows at most 4/,
    );
  });

  it("counts markers on tools and inside tool_result content", () => {
    const tools = [tool("a", { cache_control: EPHEMERAL }), tool("b")];
    const messages: MessageParam[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "a", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "result", cache_control: EPHEMERAL }],
          },
          { type: "text", text: "and then?" },
        ],
      },
    ];
    const params = buildStreamParams(request({ tools, messages }));
    expect(countBreakpoints(params)).toBe(4);
    const crowded = buildStreamParams(request({ tools: [tools[0] as ToolParam, tool("c", { cache_control: EPHEMERAL })], messages }));
    expect(countBreakpoints(crowded)).toBe(MAX_CACHE_BREAKPOINTS);
    expect("cache_control" in crowded).toBe(false);
  });

  it("does not let cache_control keys inside model-written tool input use up the slots", () => {
    const input = { cache_control: EPHEMERAL, nested: [{ cache_control: EPHEMERAL }, { cache_control: EPHEMERAL }], more: { cache_control: EPHEMERAL } };
    const messages: MessageParam[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "x", input }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "ok" }] },
    ];
    const params = buildStreamParams(request({ messages }));
    expect((params.system as TextBlockParam[])[1]?.cache_control).toStrictEqual(EPHEMERAL);
    expect(params.cache_control).toStrictEqual(EPHEMERAL);
    expect(countBreakpoints(params)).toBe(2);
  });

  it("keeps a marker the caller already put on the last system block instead of adding a second one", () => {
    const oneHour = { ...SNAPSHOT, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } };
    const params = buildStreamParams(request({ system: [STABLE, oneHour] }));
    expect((params.system as TextBlockParam[])[1]).toBe(oneHour);
    expect(countBreakpoints(params)).toBe(2);
  });

  it("skips automatic caching when the last block already has its own marker", () => {
    const params = buildStreamParams(request({ messages: [markedTurn("latest", "5m")] }));
    expect("cache_control" in params).toBe(false);
    expect(countBreakpoints(params)).toBe(2);
  });

  it("uses the 1-hour TTL on its system marker when a later marker is 1-hour (longer TTLs must come first)", () => {
    const messages: MessageParam[] = [markedTurn("old", "1h"), { role: "assistant", content: "ok" }, { role: "user", content: "new" }];
    const params = buildStreamParams(request({ messages }));
    expect((params.system as TextBlockParam[])[1]?.cache_control).toStrictEqual({ type: "ephemeral", ttl: "1h" });
    expect(params.cache_control).toStrictEqual(EPHEMERAL);
  });

  it("never sends more than 4 breakpoints, wherever the caller's markers are", () => {
    const places = ["tool", "firstSystem", "lastSystem", "olderTurn", "lastTurn"] as const;
    for (let mask = 0; mask < 2 ** places.length; mask += 1) {
      const on = (place: (typeof places)[number]): boolean => (mask & (1 << places.indexOf(place))) !== 0;
      const req = request({
        tools: [tool("t", on("tool") ? { cache_control: EPHEMERAL } : {})],
        system: [on("firstSystem") ? { ...STABLE, cache_control: EPHEMERAL } : STABLE, on("lastSystem") ? { ...SNAPSHOT, cache_control: EPHEMERAL } : SNAPSHOT],
        messages: [
          on("olderTurn") ? markedTurn("older") : { role: "user", content: "older" },
          { role: "assistant", content: "reply" },
          on("lastTurn") ? markedTurn("latest") : { role: "user", content: "latest" },
        ],
      });
      const callers = places.filter(on).length;
      if (callers > MAX_CACHE_BREAKPOINTS) {
        expect(() => buildStreamParams(req)).toThrow(/at most 4/);
        continue;
      }
      const params = buildStreamParams(req);
      // Ours, in priority order: the last system block (unless the caller marked it), then automatic caching
      // (unless the last block is already marked), each only while a slot is free.
      const systemMarker = !on("lastSystem") && callers < MAX_CACHE_BREAKPOINTS ? 1 : 0;
      const automatic = callers + systemMarker < MAX_CACHE_BREAKPOINTS && !on("lastTurn") ? 1 : 0;
      expect(countBreakpoints(params)).toBe(callers + systemMarker + automatic);
      expect(countBreakpoints(params)).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
      expect(Boolean((params.system as TextBlockParam[])[1]?.cache_control)).toBe(on("lastSystem") || systemMarker === 1);
      expect("cache_control" in params).toBe(automatic === 1);
    }
  });
});

describe("buildStreamParams: tools", () => {
  it("passes tools through in the given order, as a copy", () => {
    const tools = [tool("zeta"), tool("alpha"), tool("mid")];
    const params = buildStreamParams(request({ tools }));
    expect(params.tools).toStrictEqual(tools);
    expect(params.tools).not.toBe(tools);
    expect(params.tools?.map((t) => ("name" in t ? t.name : ""))).toStrictEqual(["zeta", "alpha", "mid"]);
  });

  it("sends no tools field when there are none", () => {
    expect("tools" in buildStreamParams(request())).toBe(false);
    expect("tools" in buildStreamParams(request({ tools: [] }))).toBe(false);
  });
});

describe("buildStreamParams: purity", () => {
  it("never mutates the request (deep-frozen input works; nothing changes)", () => {
    const req = deepFreeze(
      request({
        tools: [tool("lookup"), tool("search", { cache_control: EPHEMERAL })],
        messages: [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "assistant", content: [{ type: "text", text: "answer", citations: null }] },
          { role: "user", content: "second" },
        ],
      }),
    );
    const before = JSON.stringify(req);
    const params = buildStreamParams(req);
    buildCountTokensParams(req);
    expect(JSON.stringify(req)).toBe(before);
    expect(params.system).not.toBe(req.system);
    expect(params.messages).not.toBe(req.messages);
    expect(params.messages).toStrictEqual(req.messages);
    // Changing the output afterwards does not reach the request either.
    params.messages.push({ role: "user", content: "added later" });
    expect(req.messages).toHaveLength(3);
  });

  it("gives the same params for the same request", () => {
    const req = request({ tools: [tool("a")] });
    expect(buildStreamParams(req)).toStrictEqual(buildStreamParams(req));
  });
});

describe("buildStreamParams: requests that cannot be sent", () => {
  it("rejects a max_tokens that is not a whole number of at least 1", () => {
    for (const maxTokens of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "16000", undefined]) {
      expect(() => buildStreamParams(request({ maxTokens: maxTokens as number }))).toThrow(/maxTokens must be a whole number/);
    }
  });

  it("rejects a missing model and fields of the wrong shape, with plain messages", () => {
    for (const model of ["", "   ", 42, undefined]) {
      expect(() => buildStreamParams(request({ model: model as string }))).toThrow(/model must be a model id/);
    }
    expect(() => buildStreamParams(request({ system: "rules" as unknown as TextBlockParam[] }))).toThrow(/system must be an array/);
    expect(() => buildStreamParams(request({ messages: {} as unknown as MessageParam[] }))).toThrow(/messages must be an array/);
    expect(() => buildStreamParams(request({ tools: tool("x") as unknown as ToolParam[] }))).toThrow(/tools must be an array/);
    expect(() => buildStreamParams(request({ refusalFallback: "no" as unknown as boolean }))).toThrow(/refusalFallback/);
    expect(() => buildStreamParams(null as unknown as ModelRequest)).toThrow(/maxTokens|ModelRequest/);
  });
});

describe("buildCountTokensParams", () => {
  it("is the stream request without max_tokens, stream, fallbacks and the fallback beta", () => {
    const req = request({ tools: [tool("lookup")] });
    const { max_tokens: _max, stream: _stream, betas: _betas, fallbacks: _fallbacks, ...rest } = buildStreamParams(req);
    expect(buildCountTokensParams(req)).toStrictEqual(rest);
  });
});

describe("AnthropicModelClient.complete", () => {
  it("implements ModelClient and streams through client.beta.messages.stream with the built params", async () => {
    const reply = textMessage("Hi there");
    const stub = stubClient([{ events: [{ text: "Hi" }, { text: " there" }], message: reply }]);
    const client: ModelClient = new AnthropicModelClient({ client: stub.client });
    const controller = new AbortController();
    const req = request({ signal: controller.signal });
    const message = await client.complete(req);
    expect(message).toBe(reply);
    expect(stub.streamCalls).toHaveLength(1);
    expect(stub.streamCalls[0]?.params).toStrictEqual(buildStreamParams(req));
    expect(stub.streamCalls[0]?.options?.signal).toBe(controller.signal);
    expect(stub.streams[0]?.finalMessageCalls).toBe(1);
  });

  it("sends no signal option when the request has none", async () => {
    const stub = stubClient([{ message: textMessage("ok") }]);
    await new AnthropicModelClient({ client: stub.client }).complete(request());
    expect(stub.streamCalls[0]?.options).toStrictEqual({});
  });

  it("forwards thinking and text deltas and tool_use starts in order, then the final message", async () => {
    const final = toolUseMessage([{ name: "lookup", input: { q: "x" }, id: "toolu_1" }], { text: "Let me check." });
    const stub = stubClient([
      {
        events: [
          { thinking: "Need data." },
          { text: "Let me " },
          { text: "check." },
          { raw: { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } } },
          { raw: { type: "content_block_start", index: 2, content_block: { type: "text", text: "", citations: null } } },
          { toolStart: { id: "toolu_1", name: "lookup" } },
          { raw: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } } },
        ],
        message: final,
      },
    ]);
    const log: string[] = [];
    const callbacks: StreamCallbacks = {
      onThinking: (d) => log.push(`thinking:${d}`),
      onText: (d) => log.push(`text:${d}`),
      onToolUse: (b) => log.push(`tool:${b.name}#${b.id}`),
      onMessage: (m) => log.push(`message:${m.stop_reason ?? ""}`),
    };
    const message = await new AnthropicModelClient({ client: stub.client }).complete(request(), callbacks);
    expect(message).toBe(final);
    expect(log).toStrictEqual([
      "thinking:Need data.",
      "text:Let me ",
      "text:check.",
      "tool:lookup#toolu_1",
      "message:tool_use",
    ]);
  });

  it("attaches no listeners when there are no callbacks", async () => {
    const stub = stubClient([{ events: [{ text: "x" }], message: textMessage("x") }]);
    await new AnthropicModelClient({ client: stub.client }).complete(request());
    expect(stub.streams[0]?.listeners.size).toBe(0);
  });

  it("re-throws SDK errors unchanged (the same object), so the loop can classify them", async () => {
    const errors: unknown[] = [apiError(429, "Slow down", { retryAfterSeconds: 2 }), new APIConnectionError({ message: "reset" }), new Error("odd"), "a thrown string"];
    for (const error of errors) {
      const stub = stubClient([{ events: [{ text: "partial" }], error }]);
      const outcome = await new AnthropicModelClient({ client: stub.client }).complete(request(), { onText: () => undefined }).catch((e: unknown) => ({ caught: e }));
      expect(outcome).toStrictEqual({ caught: error });
      expect((outcome as { caught: unknown }).caught).toBe(error);
    }
    const rate = apiError(429, "Slow down");
    const stub = stubClient([{ error: rate }]);
    await expect(new AnthropicModelClient({ client: stub.client }).complete(request())).rejects.toBeInstanceOf(RateLimitError);
  });

  it("does not call the API at all when the signal is already aborted", async () => {
    const stub = stubClient([{ message: textMessage("never") }]);
    const controller = new AbortController();
    controller.abort();
    await expect(new AnthropicModelClient({ client: stub.client }).complete(request({ signal: controller.signal }))).rejects.toBeInstanceOf(APIUserAbortError);
    expect(stub.streamCalls).toHaveLength(0);
  });

  it("validates the request before calling the API", async () => {
    const stub = stubClient([{ message: textMessage("never") }]);
    await expect(new AnthropicModelClient({ client: stub.client }).complete(request({ maxTokens: 0 }))).rejects.toThrow(/maxTokens/);
    expect(stub.streamCalls).toHaveLength(0);
  });

  it("stops the stream when a callback throws, and rethrows that callback's own error", async () => {
    const bug = new TypeError("the UI broke");
    const stub = stubClient([{ events: [{ text: "one" }, { text: "two" }, { text: "three" }, { toolStart: { id: "t", name: "n" } }], message: textMessage("onetwothree") }]);
    const seen: string[] = [];
    const failing: StreamCallbacks = {
      onText: (d) => {
        seen.push(d);
        if (d === "two") throw bug;
      },
      onToolUse: () => seen.push("tool"),
      onMessage: () => seen.push("message"),
    };
    await expect(new AnthropicModelClient({ client: stub.client }).complete(request(), failing)).rejects.toBe(bug);
    expect(stub.streams[0]?.aborted).toBe(true);
    expect(seen).toStrictEqual(["one", "two"]);
  });

  it("still rethrows the callback's error when the stream finished anyway", async () => {
    const bug = new Error("tool callback failed");
    const stub = stubClient([{ events: [{ toolStart: { id: "t1", name: "lookup" } }, { text: "after" }], message: textMessage("done"), ignoreAbort: true }]);
    const texts: string[] = [];
    const callbacks: StreamCallbacks = {
      onToolUse: () => {
        throw bug;
      },
      onText: (d) => texts.push(d),
    };
    await expect(new AnthropicModelClient({ client: stub.client }).complete(request(), callbacks)).rejects.toBe(bug);
    expect(texts).toStrictEqual([]);
  });

  it("lets an error thrown by onMessage reach the caller unchanged", async () => {
    const bug = new Error("store failed");
    const stub = stubClient([{ message: textMessage("ok") }]);
    const onMessage = () => {
      throw bug;
    };
    await expect(new AnthropicModelClient({ client: stub.client }).complete(request(), { onMessage })).rejects.toBe(bug);
  });
});

describe("AnthropicModelClient options", () => {
  it("applies maxRetries and timeoutMs to every call made with an injected client", async () => {
    const stub = stubClient([{ message: textMessage("ok") }]);
    const client = new AnthropicModelClient({ client: stub.client, maxRetries: 5, timeoutMs: 30_000 });
    const controller = new AbortController();
    await client.complete(request({ signal: controller.signal }));
    expect(stub.streamCalls[0]?.options).toStrictEqual({ maxRetries: 5, timeout: 30_000, signal: controller.signal });
    await client.countTokens(request());
    expect(stub.countCalls[0]?.options).toStrictEqual({ maxRetries: 5, timeout: 30_000 });
  });

  it("refuses both a client and an API key, and nonsense retry or timeout values", () => {
    const { client } = stubClient();
    expect(() => new AnthropicModelClient({ client, apiKey: "sk-ant-test" })).toThrow(/either `client` or `apiKey`/);
    for (const maxRetries of [-1, 1.5, Number.NaN]) {
      expect(() => new AnthropicModelClient({ client, maxRetries })).toThrow(/maxRetries/);
    }
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new AnthropicModelClient({ client, timeoutMs })).toThrow(/timeoutMs/);
    }
  });

  it("builds its own SDK client from an API key, or from the environment at request time", () => {
    expect(() => new AnthropicModelClient({ apiKey: "sk-ant-test", maxRetries: 0, timeoutMs: 1_000 })).not.toThrow();
    expect(() => new AnthropicModelClient()).not.toThrow();
  });
});

describe("AnthropicModelClient.countTokens", () => {
  it("counts with client.beta.messages.countTokens and the count params, and returns input_tokens", async () => {
    const stub = stubClient([], 4_321);
    const controller = new AbortController();
    const { maxTokens: _maxTokens, ...withoutMax } = request({ tools: [tool("lookup")], signal: controller.signal });
    const count = await new AnthropicModelClient({ client: stub.client }).countTokens(withoutMax);
    expect(count).toBe(4_321);
    const call = stub.countCalls[0];
    expect(call?.params).toStrictEqual(buildCountTokensParams(withoutMax));
    for (const key of ["max_tokens", "stream", "fallbacks", "betas"]) expect(key in (call?.params ?? {})).toBe(false);
    expect(call?.options?.signal).toBe(controller.signal);
  });

  it("does not call the API when the signal is already aborted", async () => {
    const stub = stubClient();
    const controller = new AbortController();
    controller.abort();
    await expect(new AnthropicModelClient({ client: stub.client }).countTokens({ ...request(), signal: controller.signal })).rejects.toBeInstanceOf(APIUserAbortError);
    expect(stub.countCalls).toHaveLength(0);
  });
});
