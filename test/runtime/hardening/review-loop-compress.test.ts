/**
 * Review fix C5 (LOOP block): compression in a tool loop never replays an assistant turn with its thinking changed.
 *
 * With thinking on, the assistant turn that a trailing tool_result answers must go back with its thinking blocks
 * exactly as received, and thinking blocks replayed after a summary fail the conversation check (claude-api skill:
 * "don't compact in the middle of a tool round"; keep-tail compaction breaks). So a compression between a tool round
 * and the next model call restarts from the summary alone, and the tool loop then continues with turns that are
 * replayed unchanged.
 */
import { describe, expect, it } from "vitest";
import { REFERENCE_ONLY, SUMMARY_HEADINGS, runAgent } from "../../../src/loop/index.js";
import { apiError, FakeModelClient, makeMessage, textMessage } from "../../../src/testing/index.js";
import type { Message, MessageParam } from "../../../src/types.js";
import { baseConfig, makeTools, noSleep, setup } from "../loop/helpers.js";

const SUMMARY = SUMMARY_HEADINGS.map((h) => `## ${h}\nnone`).join("\n");

function thinkingToolTurn(id: string, input = 1_000): Message {
  return makeMessage({
    usage: { input },
    content: [
      { type: "thinking", thinking: "", signature: `sig-${id}` },
      { type: "text", text: `Reading ${id}`, citations: null },
      { type: "tool_use", id, name: "read_a", input: { id } },
    ],
    stopReason: "tool_use",
  });
}

function blocks(message: MessageParam | undefined): { type: string; tool_use_id?: string; id?: string }[] {
  if (!message || message.role === "system" || typeof message.content === "string") return [];
  return message.content as { type: string }[];
}

/**
 * Checks one main request the way the API does in a tool loop with thinking on: when the request ends with tool
 * results, the assistant turn they answer is the one received from the model, unchanged (thinking included).
 */
function expectToolLoopTurnIntact(request: MessageParam[], received: Message[]): void {
  const last = request[request.length - 1];
  expect(last?.role).toBe("user");
  const results = blocks(last).filter((b) => b.type === "tool_result");
  if (results.length === 0) return;
  const answered = request[request.length - 2];
  expect(answered?.role).toBe("assistant");
  const ids = blocks(answered).filter((b) => b.type === "tool_use").map((b) => b.id);
  expect(results.map((r) => r.tool_use_id)).toEqual(ids);
  const original = received.find((m) => m.content.some((b) => b.type === "tool_use" && ids.includes(b.id)));
  expect(original, "the answered turn came from the model").toBeDefined();
  expect(answered?.content).toEqual(original?.content);
}

describe("C5: compression in the middle of a tool loop", () => {
  it("at the threshold: the next request is the summary alone, and the loop goes on with unchanged turns", async () => {
    const storage = await setup();
    const tools = makeTools();
    const t1 = thinkingToolTurn("t1");
    // A small prompt for t2, so the threshold does not fire again.
    const t2 = thinkingToolTurn("t2", 100);
    const model = new FakeModelClient([
      t1,
      textMessage(SUMMARY, { model: "claude-haiku-5-5" }),
      t2,
      textMessage("done"),
    ]);
    const result = await runAgent(
      // A large tail budget: before the fix the tail replayed t1 with its thinking stripped.
      baseConfig([tools.set], { context: { windowTokens: 1_000, compressAtFraction: 0.5, tailTokens: 50_000 } }),
      { userMessage: "read both notes" },
      { storage, model, sleep: noSleep },
    );
    expect(result.end).toBe("end_turn");
    const main = model.calls.filter((c) => c.purpose !== "summary");
    expect(main).toHaveLength(3);
    const [, afterCompress, afterT2] = main;
    // Right after compression: no assistant turn at all, so none with stripped thinking.
    expect(afterCompress?.messages.map((m) => m.role)).toEqual(["user"]);
    expect(JSON.stringify(afterCompress?.messages)).toContain(REFERENCE_ONLY);
    expect(JSON.stringify(afterCompress?.messages)).not.toContain("sig-t1");
    // The loop continues: t2's turn goes back exactly as received, thinking and signature included.
    expect(afterT2?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    for (const call of main) expectToolLoopTurnIntact(call.messages, [t1, t2]);
    expect(JSON.stringify(afterT2?.messages)).toContain("sig-t2");
  });

  it("on an overflow (413) between a tool round and the next call: the retry is the summary alone", async () => {
    const storage = await setup();
    const tools = makeTools();
    const t1 = thinkingToolTurn("t1");
    const model = new FakeModelClient([
      t1,
      { throw: apiError(413, "request too large") },
      textMessage(SUMMARY, { model: "claude-haiku-5-5" }),
      textMessage("fits now"),
    ]);
    const result = await runAgent(baseConfig([tools.set], { context: { tailTokens: 50_000 } }), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("end_turn");
    const main = model.calls.filter((c) => c.purpose !== "summary");
    // The failed request still carried t1 exactly as received.
    expect(main[1]?.messages[1]?.content).toEqual(t1.content);
    const retried = main[2]?.messages ?? [];
    expect(retried.map((m) => m.role)).toEqual(["user"]);
    expect(JSON.stringify(retried)).not.toContain('"tool_use"');
    expect(JSON.stringify(retried)).not.toContain('"tool_result"');
    for (const call of main) expectToolLoopTurnIntact(call.messages, [t1]);
  });
});
