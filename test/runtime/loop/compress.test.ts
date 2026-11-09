import { describe, expect, it } from "vitest";
import {
  COMPRESSION_MARKER,
  REFERENCE_ONLY,
  SUMMARY_HEADINGS,
  rebuildHistory,
  runAgent,
  selectTail,
  stripForTail,
} from "../../../src/loop/index.js";
import { apiError, FakeModelClient, makeMessage, textMessage, toolUseMessage } from "../../../src/testing/index.js";
import type { MessageParam } from "../../../src/types.js";
import { baseConfig, makeTools, noSleep, setup } from "./helpers.js";

const SUMMARY = SUMMARY_HEADINGS.map((h) => `## ${h}\n${h === "Goal" ? "Read the notes" : "none"}`).join("\n");

function thinkingToolTurn(id: string): ReturnType<typeof makeMessage> {
  return makeMessage({
    content: [
      { type: "thinking", thinking: "", signature: `sig-${id}` },
      { type: "text", text: `Reading ${id}`, citations: null },
      { type: "tool_use", id, name: "read_a", input: { id } },
    ],
    stopReason: "tool_use",
  });
}

describe("compression in the loop", () => {
  it("restarts from ONE summary message (background model, low effort) and never resends an earlier turn", async () => {
    const storage = await setup();
    const tools = makeTools();
    const model = new FakeModelClient([
      thinkingToolTurn("t1"),
      textMessage(SUMMARY, { model: "claude-haiku-5-5", usage: { input: 300, output: 80 } }),
      textMessage("Continued after the summary."),
    ]);
    const result = await runAgent(
      baseConfig([tools.set], { context: { windowTokens: 1_000, compressAtFraction: 0.5, tailTokens: 0 } }),
      { userMessage: "please read the notes" },
      { storage, model, sleep: noSleep },
    );
    expect(result.end).toBe("end_turn");
    expect(result.text).toBe("Continued after the summary.");
    const [first, summaryCall, after] = model.calls;
    expect(summaryCall?.model).toBe("claude-haiku-5-5");
    expect(summaryCall?.effort).toBe("low");
    expect(summaryCall?.purpose).toBe("summary");
    expect(summaryCall?.tools).toBeUndefined();
    // The transcript goes as text, never as replayed turns with thinking blocks.
    expect(JSON.stringify(summaryCall?.messages)).not.toContain("sig-t1");
    expect(JSON.stringify(summaryCall?.messages)).toContain("please read the notes");

    expect(after?.messages).toHaveLength(1);
    const restart = JSON.stringify(after?.messages[0]);
    expect(after?.messages[0]?.role).toBe("user");
    expect(restart).toContain(REFERENCE_ONLY);
    expect(restart).toContain("## Next steps");
    expect(restart).toContain("Continue the task");
    expect(restart).not.toContain("sig-t1");
    // System prompt and tools are unchanged by compression (frozen for the session).
    expect(after?.system).toEqual(first?.system);
    expect(after?.tools).toEqual(first?.tools);

    const costs = await storage.costs.list({ sessionId: result.sessionId });
    expect(costs.map((c) => c.purpose).sort()).toEqual(["main", "main", "summary"]);

    // The stored history is append-only, and a continued session restarts from the summary too.
    const records = await storage.messages.list(result.sessionId);
    expect(records.map((r) => r.role)).toEqual(["user", "assistant", "user", "system", "user", "assistant"]);
    expect(records[3]?.text.startsWith(COMPRESSION_MARKER)).toBe(true);
    const rebuilt = rebuildHistory(records);
    expect(rebuilt).toHaveLength(2);
    expect(JSON.stringify(rebuilt[0])).toContain(REFERENCE_ONLY);
  });

  it("at a real turn boundary keeps a budgeted tail with thinking stripped and no orphaned tool_result", async () => {
    const storage = await setup();
    const tools = makeTools();
    const t1 = thinkingToolTurn("t1");
    // Run 1 finishes a tool loop; run 2 overflows on its first call, so it compresses at a turn boundary.
    const model = new FakeModelClient([
      t1,
      textMessage("Read it."),
      { throw: apiError(413, "request too large") },
      textMessage(SUMMARY, { model: "claude-haiku-5-5" }),
      textMessage("done"),
    ]);
    const first = await runAgent(baseConfig([tools.set]), { userMessage: "read" }, { storage, model, sleep: noSleep });
    await runAgent(
      baseConfig([tools.set], { context: { tailTokens: 200 } }),
      { userMessage: "and now?", sessionId: first.sessionId },
      { storage, model, sleep: noSleep },
    );
    const after = model.calls[4]?.messages ?? [];
    expect(after.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(JSON.stringify(after[0])).toContain(REFERENCE_ONLY);
    expect(JSON.stringify(after[0])).toContain("the most recent turns follow");
    // The tail's assistant turn: text and tool_use kept, thinking (and its signature) gone.
    expect(after[1]).toEqual({ role: "assistant", content: [t1.content[1], t1.content[2]] });
    expect(JSON.stringify(after)).not.toContain("sig-t1");
    // Its tool_result is there, right after its tool_use; the original first user turn is not.
    expect(JSON.stringify(after[2])).toContain('"tool_use_id":"t1"');
    expect(JSON.stringify(after)).not.toContain('"text":"read"');
    // The request ends with the new user turn.
    expect(JSON.stringify(after[4])).toContain("and now?");
    // The request before compression still had the turn exactly as received (nothing edited in place).
    expect(model.calls[1]?.messages[1]?.content).toEqual(t1.content);
  });

  it("in the middle of a tool loop restarts from the summary alone (no tail, so no turn with stripped thinking)", async () => {
    const storage = await setup();
    const tools = makeTools();
    const t1 = thinkingToolTurn("t1");
    const model = new FakeModelClient([t1, textMessage(SUMMARY, { model: "claude-haiku-5-5" }), textMessage("done")]);
    await runAgent(
      baseConfig([tools.set], { context: { windowTokens: 1_000, compressAtFraction: 0.5, tailTokens: 200 } }),
      { userMessage: "read" },
      { storage, model, sleep: noSleep },
    );
    const after = model.calls[2]?.messages ?? [];
    expect(after.map((m) => m.role)).toEqual(["user"]);
    expect(JSON.stringify(after[0])).toContain(REFERENCE_ONLY);
    expect(JSON.stringify(after[0])).not.toContain("the most recent turns follow");
    // The tool result the model had not answered yet went to the summariser as text.
    expect(JSON.stringify(model.calls[1]?.messages)).toContain("[tool result]");
    expect(JSON.stringify(after)).not.toContain("sig-t1");
  });

  it("413 (request too large) → compress, then retry once", async () => {
    const storage = await setup();
    const tools = makeTools();
    const model = new FakeModelClient([
      thinkingToolTurn("t1"),
      { throw: apiError(413, "request too large") },
      textMessage(SUMMARY, { model: "claude-haiku-5-5" }),
      textMessage("fits now"),
    ]);
    const result = await runAgent(baseConfig([tools.set], { context: { tailTokens: 5_000 } }), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("end_turn");
    expect(model.calls.map((c) => c.purpose)).toEqual(["main", "main", "summary", "main"]);
    const retried = model.calls[3]?.messages ?? [];
    expect(JSON.stringify(retried[0])).toContain(REFERENCE_ONLY);
    // The overflow came in the middle of a tool loop: the retry restarts from the summary alone.
    expect(retried.map((m) => m.role)).toEqual(["user"]);
    expect(JSON.stringify(retried)).not.toContain("thinking");
  });

  it("a second overflow after compressing ends with 'error'", async () => {
    const storage = await setup();
    const tools = makeTools();
    const model = new FakeModelClient([
      thinkingToolTurn("t1"),
      { throw: apiError(413, "request too large") },
      textMessage(SUMMARY, { model: "claude-haiku-5-5" }),
      { throw: apiError(413, "request too large") },
    ]);
    const result = await runAgent(baseConfig([tools.set]), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("error");
  });

  it("stop_reason model_context_window_exceeded → compress and continue", async () => {
    const storage = await setup();
    const tools = makeTools();
    const model = new FakeModelClient([
      thinkingToolTurn("t1"),
      makeMessage({ content: [{ type: "text", text: "cut", citations: null }], stopReason: "model_context_window_exceeded" }),
      textMessage(SUMMARY, { model: "claude-haiku-5-5" }),
      textMessage("ok"),
    ]);
    const result = await runAgent(baseConfig([tools.set]), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("end_turn");
    expect(JSON.stringify(model.calls[3]?.messages)).not.toContain('"cut"');
  });

  it("a failed summary at the threshold does not loop: the run goes on uncompressed", async () => {
    const storage = await setup();
    const tools = makeTools();
    const model = new FakeModelClient([
      thinkingToolTurn("t1"),
      { throw: apiError(400, "bad") },
      textMessage("went on"),
    ]);
    const result = await runAgent(
      baseConfig([tools.set], { context: { windowTokens: 1_000, compressAtFraction: 0.5 } }),
      { userMessage: "go" },
      { storage, model, sleep: noSleep },
    );
    expect(result.end).toBe("end_turn");
    expect(model.calls.map((c) => c.purpose)).toEqual(["main", "summary", "main"]);
  });

  it("wraps the summary as untrusted when untrusted text was compressed", async () => {
    const storage = await setup();
    const tools = makeTools();
    const model = new FakeModelClient([
      toolUseMessage([{ name: "fetch_page", input: { url: "https://example.com" } }]),
      textMessage(SUMMARY, { model: "claude-haiku-5-5" }),
      textMessage("ok"),
    ]);
    await runAgent(baseConfig([tools.set], { context: { windowTokens: 1_000, tailTokens: 0 } }), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(JSON.stringify(model.calls[2]?.messages[0])).toContain('<untrusted_content source=\\"compression-summary\\"');
  });
});

describe("selectTail and stripForTail", () => {
  const conversation: MessageParam[] = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "s1" },
        { type: "tool_use", id: "a", name: "read_a", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "x".repeat(400) }] },
    {
      role: "assistant",
      content: [
        { type: "redacted_thinking", data: "zzz" },
        { type: "text", text: "next" },
        { type: "tool_use", id: "b", name: "read_a", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "short" }] },
  ];

  // The same conversation at a real turn boundary: the tool loop is over and a new user turn starts.
  const atBoundary: MessageParam[] = [
    ...conversation,
    { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s2" }, { type: "text", text: "done" }] },
    { role: "user", content: "go on" },
  ];

  it("never starts with a tool_result whose tool_use was cut off, and strips thinking", () => {
    for (let budget = 0; budget < 600; budget += 5) {
      const tail = selectTail(atBoundary, budget);
      if (tail.length === 0) continue;
      const first = tail[0];
      if (first?.role === "user") expect(JSON.stringify(first)).not.toContain("tool_result");
      const ids = new Set<string>();
      for (const message of tail) {
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === "tool_use") ids.add(block.id);
            if (block.type === "tool_result") expect(ids.has(block.tool_use_id)).toBe(true);
            expect(block.type).not.toBe("thinking");
            expect(block.type).not.toBe("redacted_thinking");
          }
        }
      }
    }
    expect(selectTail(atBoundary, 60).map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(selectTail(atBoundary, 0)).toEqual([]);
  });

  it("keeps no tail in the middle of a tool loop (the last message holds tool results) or after a paused turn", () => {
    expect(selectTail(conversation, 10_000)).toEqual([]);
    expect(selectTail([...atBoundary, { role: "assistant", content: [{ type: "text", text: "paused" }] }], 10_000)).toEqual([]);
    expect(selectTail(atBoundary, 10_000).at(-1)).toEqual({ role: "user", content: "go on" });
  });

  it("does not change the original messages", () => {
    const before = structuredClone(conversation);
    selectTail(conversation, 10_000);
    stripForTail(conversation[1] as MessageParam);
    expect(conversation).toEqual(before);
  });

  it("refuses to cut while a tool_use waits for its result", () => {
    expect(() => selectTail(conversation.slice(0, 2), 1_000)).toThrow(/turn boundary/);
  });

  it("drops an assistant turn that had only thinking", () => {
    expect(stripForTail({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }] })).toBeNull();
  });
});
