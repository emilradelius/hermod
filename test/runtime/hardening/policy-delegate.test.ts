/**
 * Hardening, policy block (I): the delegate's result is cut once, before it is wrapped; a wrapped result is never
 * cut again, so its closing untrusted tag always survives.
 */
import { describe, expect, it } from "vitest";
import { DELEGATE_RESULT_CHARS, DELEGATE_WRAPPER_ROOM, limitResult, makeDelegateTool } from "../../../src/loop/delegate.js";
import { runAgent } from "../../../src/loop/index.js";
import { UNTRUSTED_TAG, createNonce, wrapUntrusted } from "../../../src/safety/index.js";
import { textMessage, toolUseMessage } from "../../../src/testing/index.js";
import type { MessageParam } from "../../../src/types.js";
import { config, toolCtx, world } from "./policy-helpers.js";

const CLOSE = `</${UNTRUSTED_TAG}>`;
const OPEN = `<${UNTRUSTED_TAG}`;

function lastToolResult(messages: MessageParam[] | undefined): string {
  const content = messages?.at(-1)?.content;
  if (!Array.isArray(content)) return "";
  const block = content[0] as { type?: string; content?: unknown } | undefined;
  return block?.type === "tool_result" && typeof block.content === "string" ? block.content : "";
}

describe("I: the delegate result keeps its closing untrusted tag", () => {
  it("end to end: a tainted child's long report comes back wrapped, cut inside, closing tag intact", async () => {
    const w = await world();
    const delegate = makeDelegateTool();
    const longReport = `Report: ${"r".repeat(DELEGATE_RESULT_CHARS + 1_000)}`;
    w.model.push(
      toolUseMessage([{ name: "delegate", input: { task: "Read the page and report." } }]),
      toolUseMessage([{ name: "fetch_page", input: { url: "https://example.test" } }]),
      textMessage(longReport),
      textMessage("Parent done."),
    );
    const result = await runAgent(
      config(w, { toolsets: [w.knowledge, w.notes, { name: "powers", tools: [delegate] }] }),
      { userMessage: "Delegate it." },
      w.deps,
    );
    expect(result.end).toBe("end_turn");
    const returned = lastToolResult(w.model.calls[3]?.messages);
    expect(returned.startsWith(OPEN)).toBe(true);
    expect(returned.trimEnd().endsWith(CLOSE)).toBe(true);
    expect(returned).toMatch(/truncated: \d+ more characters/);
    expect(returned.length).toBeLessThanOrEqual(DELEGATE_RESULT_CHARS + DELEGATE_WRAPPER_ROOM);
  });

  it("the tool keeps a wrapped result that fits whole, and cuts plain text", async () => {
    const wrapped = wrapUntrusted(`${"a".repeat(DELEGATE_RESULT_CHARS)}\n[truncated: 9 more characters]`, {
      source: "delegate",
      nonce: createNonce(),
    });
    expect(wrapped.length).toBeGreaterThan(DELEGATE_RESULT_CHARS);
    const w = await world();
    const tool = makeDelegateTool();
    const out = await tool.run({ task: "x" }, toolCtx(w.storage, "s-1", { runChild: async () => wrapped }));
    expect(out).toBe(wrapped);

    const plain = String(await tool.run({ task: "x" }, toolCtx(w.storage, "s-1", { runChild: async () => "p".repeat(9_000) })));
    expect(plain.startsWith("p".repeat(DELEGATE_RESULT_CHARS))).toBe(true);
    expect(plain).toMatch(/truncated: 5000 more characters/);
    expect(plain.length).toBeLessThan(DELEGATE_RESULT_CHARS + 60);
  });

  it("a wrapped result too long to keep whole is cut and wrapped again: it stays untrusted and closed", () => {
    const huge = wrapUntrusted("z".repeat(20_000), { source: "delegate", nonce: createNonce() });
    const out = limitResult(huge);
    expect(out.length).toBeLessThanOrEqual(DELEGATE_RESULT_CHARS + DELEGATE_WRAPPER_ROOM);
    expect(out.startsWith(OPEN)).toBe(true);
    expect(out.endsWith(CLOSE)).toBe(true);
    // Exactly one real opening and one real closing tag: the inner ones were neutralised.
    expect(out.split(OPEN)).toHaveLength(2);
    expect(out.split(CLOSE)).toHaveLength(2);
  });
});
