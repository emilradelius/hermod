import { describe, expect, it } from "vitest";
import { runAgent } from "../../../src/loop/index.js";
import {
  FakeModelClient,
  makeMessage,
  maxTokensMessage,
  refusalMessage,
  textMessage,
  toolUseMessage,
} from "../../../src/testing/index.js";
import type { MessageParam, ToolResultBlockParam } from "../../../src/types.js";
import { AGENT, baseConfig, fakeSecret, makeTools, noSleep, setup } from "./helpers.js";

function resultsOf(message: MessageParam | undefined): ToolResultBlockParam[] {
  if (!message || message.role !== "user" || !Array.isArray(message.content)) throw new Error("not a user message");
  return message.content.filter((b): b is ToolResultBlockParam => b.type === "tool_result");
}

describe("runAgent: plain answers", () => {
  it("answers with text, stores both messages, records the cost and closes the session", async () => {
    const storage = await setup();
    const model = new FakeModelClient([textMessage("Hello there.")]);
    const deltas: string[] = [];
    const phases: string[] = [];
    const result = await runAgent(
      baseConfig(),
      { userMessage: "Hi", callbacks: { onText: (d) => deltas.push(d), onPhase: (p) => phases.push(p) } },
      { storage, model, sleep: noSleep },
    );
    expect(result.end).toBe("end_turn");
    expect(result.text).toBe("Hello there.");
    expect(result.iterations).toBe(1);
    expect(deltas.join("")).toBe("Hello there.");
    expect(phases[0]).toBe("prepare");
    expect(phases.at(-1)).toBe("finish");

    const request = model.calls[0];
    expect(request?.effort).toBe("medium");
    expect(request?.model).toBe("claude-opus-5-5");
    expect(request?.system).toHaveLength(2);
    expect(request?.system[0]?.text).toContain("You help with notes.");
    expect(request?.system[0]?.text).toContain("untrusted_content");
    expect(request?.tools).toBeUndefined();

    const messages = await storage.messages.list(result.sessionId);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const costs = await storage.costs.list({ sessionId: result.sessionId });
    expect(costs).toHaveLength(1);
    expect(costs[0]?.purpose).toBe("main");
    expect(costs[0]?.costUsd).toBeCloseTo(result.costUsd, 12);
    expect(result.costUsd).toBeGreaterThan(0);
    const session = await storage.sessions.get(result.sessionId);
    expect(session?.status).toBe("done");
    expect(session?.endedAt).not.toBeNull();
    expect(session?.counters.userTurns).toBe(1);
  });

  it("puts volatile context in a <context> block of the user message, never in the system prompt, and redacts it", async () => {
    const storage = await setup();
    const model = new FakeModelClient([textMessage("ok")]);
    const secret = fakeSecret();
    await runAgent(baseConfig(), { userMessage: `my key is ${secret}`, context: "Today is Thursday." }, { storage, model });
    const request = model.calls[0];
    const first = request?.messages[0];
    const text = JSON.stringify(first);
    expect(text).toContain("<context>\\nToday is Thursday.\\n</context>");
    expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED:");
    expect(JSON.stringify(request?.system)).not.toContain("Thursday");
    const stored = await storage.messages.list((await storage.sessions.listByAgent(AGENT))[0]?.id ?? "");
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  it("appends the assistant message verbatim, thinking blocks and signatures included", async () => {
    const storage = await setup();
    const tools = makeTools();
    const withThinking = makeMessage({
      content: [
        { type: "thinking", thinking: "", signature: "sig-abc" },
        { type: "tool_use", id: "toolu_1", name: "read_a", input: { id: "n1" } },
      ],
      stopReason: "tool_use",
    });
    const model = new FakeModelClient([withThinking, textMessage("done")]);
    await runAgent(baseConfig([tools.set]), { userMessage: "read n1" }, { storage, model, sleep: noSleep });
    const second = model.calls[1];
    expect(second?.messages[1]).toEqual({ role: "assistant", content: withThinking.content });
    const stored = await storage.messages.list((await storage.sessions.listByAgent(AGENT))[0]?.id ?? "");
    expect(stored[1]?.content).toEqual(withThinking.content);
  });

  it("throws a clear programmer error for a missing agent, before any model call", async () => {
    const storage = await setup();
    const model = new FakeModelClient([]);
    await expect(runAgent({ agentId: "nobody", systemPrompt: "x" }, { userMessage: "hi" }, { storage, model })).rejects.toThrow(
      /no agent "nobody"/,
    );
    expect(model.calls).toHaveLength(0);
  });

  it("throws for bad configuration (unknown model, bad effort) before anything happens", async () => {
    const storage = await setup();
    const model = new FakeModelClient([]);
    await expect(runAgent(baseConfig([], { model: "gpt-5" }), { userMessage: "hi" }, { storage, model })).rejects.toThrow(/no known price/);
    await expect(
      runAgent(baseConfig([], { effort: "ultra" as never }), { userMessage: "hi" }, { storage, model }),
    ).rejects.toThrow(/effort/);
    expect(await storage.sessions.listByAgent(AGENT)).toHaveLength(0);
  });
});

describe("runAgent: tool rounds", () => {
  it("runs consecutive read-only calls in parallel and returns all results in ONE user message, in tool_use order", async () => {
    const storage = await setup();
    const tools = makeTools();
    const model = new FakeModelClient([
      toolUseMessage([
        { name: "read_a", input: { id: "1" }, id: "t1" },
        { name: "read_b", input: { id: "2" }, id: "t2" },
        { name: "read_c", input: { id: "3" }, id: "t3" },
      ]),
      textMessage("All read."),
    ]);
    const result = await runAgent(baseConfig([tools.set]), { userMessage: "read all" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("end_turn");
    // All three started before any ended: they ran concurrently.
    expect(tools.events.slice(0, 3).every((e) => e.startsWith("start:"))).toBe(true);
    const second = model.calls[1];
    expect(second?.messages).toHaveLength(3);
    const results = resultsOf(second?.messages[2]);
    expect(results.map((r) => r.tool_use_id)).toEqual(["t1", "t2", "t3"]);
    expect(results.map((r) => r.content)).toEqual([
      JSON.stringify({ note: "read_a:1" }),
      JSON.stringify({ note: "read_b:2" }),
      JSON.stringify({ note: "read_c:3" }),
    ]);
    expect(second?.tools?.map((t) => t.name)).toEqual(["fetch_page", "flaky", "read_a", "read_b", "read_c", "save_note"]);
    const session = await storage.sessions.get(result.sessionId);
    expect(session?.counters.toolIterations).toBe(1);
  });

  it("runs side-effect calls one at a time, in order", async () => {
    const storage = await setup("autonomous");
    const tools = makeTools();
    const model = new FakeModelClient([
      toolUseMessage([
        { name: "save_note", input: { text: "one" } },
        { name: "save_note", input: { text: "two" } },
        { name: "save_note", input: { text: "three" } },
      ]),
      textMessage("Saved."),
    ]);
    await runAgent(baseConfig([tools.set]), { userMessage: "save" }, { storage, model, sleep: noSleep });
    expect(tools.events).toEqual([
      "start:save_note:one",
      "end:save_note:one",
      "start:save_note:two",
      "end:save_note:two",
      "start:save_note:three",
      "end:save_note:three",
    ]);
    const audits = await storage.audit.list({ action: "tool.run" });
    expect(audits).toHaveLength(3);
  });

  it("returns is_error results for an unknown tool, invalid input and a thrown error (as JSON)", async () => {
    const storage = await setup();
    const tools = makeTools();
    const model = new FakeModelClient([
      toolUseMessage([
        { name: "drop_database", input: {}, id: "u1" },
        { name: "read_a", input: { id: 42, extra: "x" }, id: "u2" },
        { name: "flaky", input: {}, id: "u3" },
        { name: "read_a", input: "not an object", id: "u4" },
      ]),
      textMessage("Sorry."),
    ]);
    const result = await runAgent(baseConfig([tools.set]), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("end_turn");
    const results = resultsOf(model.calls[1]?.messages[2]);
    expect(results.every((r) => r.is_error === true)).toBe(true);
    const parsed = results.map((r) => JSON.parse(String(r.content)) as { error: { type: string; message: string } });
    expect(parsed[0]?.error.type).toBe("unknown_tool");
    expect(parsed[1]?.error.type).toBe("invalid_input");
    expect(parsed[1]?.error.message).toMatch(/id/);
    expect(parsed[2]).toEqual({ error: { type: "TypeError", message: "disk is on fire" } });
    expect(parsed[3]?.error.type).toBe("invalid_input");
    expect(tools.executed).toEqual([]);
    expect(result.toolCalls.map((c) => c.ok)).toEqual([false, false, false, false]);
  });

  it("redacts and truncates tool output (redaction first, so a cut never leaves half a secret)", async () => {
    const storage = await setup();
    const secret = fakeSecret();
    const { defineTool } = await import("../../../src/tools/define.js");
    const { z } = await import("zod");
    const leaky = defineTool({
      name: "leaky",
      description: "Returns a long text. Use it to test.",
      input: z.object({}),
      readOnly: true,
      capabilities: ["read"],
      run: () => `${"a".repeat(30)} ${secret} ${"b".repeat(500)}`,
    });
    const model = new FakeModelClient([toolUseMessage([{ name: "leaky", input: {} }]), textMessage("ok")]);
    await runAgent(
      baseConfig([{ name: "t", tools: [leaky] }], { maxToolOutputChars: 60 }),
      { userMessage: "go" },
      { storage, model, sleep: noSleep },
    );
    const content = String(resultsOf(model.calls[1]?.messages[2])[0]?.content);
    expect(content).not.toContain(secret.slice(0, 20));
    expect(content).toContain("[REDACTED:");
    expect(content).toMatch(/\[truncated: \d+ more characters\]/);
  });

  it("pause_turn: appends the paused turn and sends again without an extra user message", async () => {
    const storage = await setup();
    const paused = makeMessage({ content: [{ type: "text", text: "Working…", citations: null }], stopReason: "pause_turn" });
    const model = new FakeModelClient([paused, textMessage("Finished.")]);
    const result = await runAgent(baseConfig(), { userMessage: "long task" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("end_turn");
    expect(result.text).toBe("Finished.");
    expect(model.calls[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("refusal: ends with the category, runs no tools and discards the partial output", async () => {
    const storage = await setup();
    const tools = makeTools();
    const refused = makeMessage({
      content: [
        { type: "text", text: "partial", citations: null },
        { type: "tool_use", id: "x1", name: "save_note", input: { text: "nope" } },
      ],
      stopReason: "refusal",
      refusalCategory: "cyber",
    });
    const model = new FakeModelClient([refused]);
    const result = await runAgent(baseConfig([tools.set]), { userMessage: "do it" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("refusal");
    expect(result.refusalCategory).toBe("cyber");
    expect(result.text).toBe("");
    expect(tools.executed).toEqual([]);
    expect(model.calls).toHaveLength(1);
    expect((await storage.audit.list({ action: "model.refusal" }))[0]?.details.category).toBe("cyber");
  });

  it("refusal with a null category is a valid end", async () => {
    const storage = await setup();
    const result = await runAgent(baseConfig(), { userMessage: "x" }, { storage, model: new FakeModelClient([refusalMessage(null)]) });
    expect(result.end).toBe("refusal");
    expect(result.refusalCategory).toBeNull();
  });

  it("max_tokens with a tool_use: the truncated call is never run and never kept in the history", async () => {
    const storage = await setup();
    const tools = makeTools();
    const model = new FakeModelClient([maxTokensMessage({ text: "Saving", toolCall: { name: "save_note", input: { text: "half" } } })]);
    const result = await runAgent(baseConfig([tools.set]), { userMessage: "save" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("max_tokens");
    expect(tools.executed).toEqual([]);
    const stored = await storage.messages.list(result.sessionId);
    expect(stored.map((m) => m.role)).toEqual(["user"]);
  });

  it("does not run tool_use blocks that come before a server-side fallback block, and echoes the turn by the rules", async () => {
    const storage = await setup();
    const tools = makeTools();
    const message = makeMessage({
      content: [
        { type: "thinking", thinking: "", signature: "s1" },
        { type: "tool_use", id: "before", name: "save_note", input: { text: "early" } },
        { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" }, trigger: "refusal" } as never,
        { type: "tool_use", id: "after", name: "read_a", input: { id: "9" } },
      ],
      stopReason: "tool_use",
    });
    const model = new FakeModelClient([message, textMessage("ok")]);
    await runAgent(baseConfig([tools.set]), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(tools.executed).toEqual(["read_a"]);
    const echoed = model.calls[1]?.messages[1];
    const types = Array.isArray(echoed?.content) ? echoed.content.map((b) => b.type) : [];
    expect(types).toEqual(["fallback", "tool_use"]);
    expect(resultsOf(model.calls[1]?.messages[2]).map((r) => r.tool_use_id)).toEqual(["after"]);
  });

  it("a continued session replays the stored history and repairs a dangling tool_use", async () => {
    const storage = await setup();
    const first = await runAgent(baseConfig(), { userMessage: "first" }, { storage, model: new FakeModelClient([textMessage("one")]) });
    // Simulate a crash in the middle of a tool round: an assistant tool_use with no result stored.
    await storage.messages.append(first.sessionId, {
      role: "assistant",
      content: [{ type: "tool_use", id: "dangling", name: "read_a", input: { id: "1" } }],
      text: "",
    });
    const model = new FakeModelClient([textMessage("two")]);
    const second = await runAgent(baseConfig(), { userMessage: "second", sessionId: first.sessionId }, { storage, model });
    expect(second.sessionId).toBe(first.sessionId);
    const roles = model.calls[0]?.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "assistant", "user", "user"]);
    expect(resultsOf(model.calls[0]?.messages[3])[0]?.tool_use_id).toBe("dangling");
    const session = await storage.sessions.get(first.sessionId);
    expect(session?.counters.userTurns).toBe(2);
  });

  it("refuses to continue a session of another agent", async () => {
    const storage = await setup();
    await storage.agents.upsert({ id: "agent-2", name: "Other" });
    const other = await runAgent({ agentId: "agent-2", systemPrompt: "x" }, { userMessage: "hi" }, { storage, model: new FakeModelClient([textMessage("x")]) });
    await expect(
      runAgent(baseConfig(), { userMessage: "steal", sessionId: other.sessionId }, { storage, model: new FakeModelClient([]) }),
    ).rejects.toThrow(/belongs to agent/);
  });
});
