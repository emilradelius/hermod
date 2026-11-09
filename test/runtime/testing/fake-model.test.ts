import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  BadRequestError,
  InternalServerError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  FakeModelClient,
  apiError,
  connectionError,
  refusalMessage,
  textMessage,
  toolUseMessage,
} from "../../../src/testing/index.js";
import type { ModelRequest } from "../../../src/types.js";

function request(text = "hi"): ModelRequest {
  return {
    model: "claude-opus-5-5",
    system: [{ type: "text", text: "You are a test." }],
    messages: [{ role: "user", content: text }],
    maxTokens: 1000,
    effort: "medium",
  };
}

describe("FakeModelClient", () => {
  it("returns scripted messages in order and records each request", async () => {
    const fake = new FakeModelClient([textMessage("one"), textMessage("two")]);
    const a = await fake.complete(request("first"));
    const b = await fake.complete(request("second"));
    expect(a.content[0]).toMatchObject({ type: "text", text: "one" });
    expect(b.content[0]).toMatchObject({ type: "text", text: "two" });
    expect(fake.calls.map((c) => c.messages[0]?.content)).toEqual(["first", "second"]);
    expect(fake.remaining).toBe(0);
  });

  it("records a deep copy, so later mutation of the request does not change the record", async () => {
    const fake = new FakeModelClient([textMessage("ok")]);
    const req = request("original");
    await fake.complete(req);
    (req.messages[0] as { content: string }).content = "mutated";
    expect(fake.calls[0]?.messages[0]?.content).toBe("original");
  });

  it("throws a clear error when the script is exhausted", async () => {
    const fake = new FakeModelClient([textMessage("only")]);
    await fake.complete(request());
    await expect(fake.complete(request())).rejects.toThrow(/exhausted after 1 call/);
  });

  it("passes the request to function steps", async () => {
    const fake = new FakeModelClient([(req, i) => textMessage(`echo ${String(req.messages[0]?.content)} #${i}`)]);
    const msg = await fake.complete(request("ping"));
    expect(msg.content[0]).toMatchObject({ text: "echo ping #0" });
  });

  it("throws scripted SDK errors of the right class", async () => {
    const fake = new FakeModelClient([
      { throw: apiError(429, "slow down", { retryAfterSeconds: 3 }) },
      { throw: apiError(529, "overloaded") },
      { throw: apiError(400, "prompt is too long: 250000 tokens > 200000 maximum") },
      { throw: connectionError() },
    ]);
    const rate = await fake.complete(request()).catch((e: unknown) => e);
    expect(rate).toBeInstanceOf(RateLimitError);
    expect((rate as RateLimitError).headers?.get("retry-after")).toBe("3");
    const overloaded = await fake.complete(request()).catch((e: unknown) => e);
    expect(overloaded).toBeInstanceOf(InternalServerError);
    expect((overloaded as APIError).status).toBe(529);
    expect(await fake.complete(request()).catch((e: unknown) => e)).toBeInstanceOf(BadRequestError);
    expect(await fake.complete(request()).catch((e: unknown) => e)).toBeInstanceOf(APIConnectionError);
  });

  it("streams text deltas that join back to the full text, then the message", async () => {
    const text = "Hej Emil, här är en lång mening med åäö och 🎉 emoji för att testa.";
    const fake = new FakeModelClient([textMessage(text)]);
    const deltas: string[] = [];
    let final: unknown;
    await fake.complete(request(), { onText: (d) => deltas.push(d), onMessage: (m) => (final = m) });
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe(text);
    expect(final).toBeDefined();
  });

  it("reports tool calls and refusals with valid shapes", async () => {
    const fake = new FakeModelClient([
      toolUseMessage([{ name: "lookup", input: { q: "x" } }], { text: "Let me check." }),
      refusalMessage("cyber"),
    ]);
    const seen: string[] = [];
    const tool = await fake.complete(request(), { onToolUse: (b) => seen.push(b.name) });
    expect(tool.stop_reason).toBe("tool_use");
    expect(tool.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect(seen).toEqual(["lookup"]);
    const refusal = await fake.complete(request());
    expect(refusal.stop_reason).toBe("refusal");
    expect(refusal.stop_details?.category).toBe("cyber");
  });

  it("refuses to run when the signal is already aborted", async () => {
    const fake = new FakeModelClient([textMessage("never")]);
    const controller = new AbortController();
    controller.abort();
    await expect(fake.complete({ ...request(), signal: controller.signal })).rejects.toBeInstanceOf(
      APIUserAbortError,
    );
    expect(fake.remaining).toBe(1);
  });

  it("estimates tokens offline", async () => {
    const fake = new FakeModelClient();
    const n = await fake.countTokens({ ...request("x".repeat(4000)) });
    expect(n).toBeGreaterThan(1000);
  });
});
