import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { defineTool, toBetaZodTool, toBetaZodTools, ToolRegistry } from "../../../src/tools/index.js";
import type { AgentMode, Storage, ToolContext } from "../../../src/types.js";
import { AGENT, makeTools, setup } from "./helpers.js";

function ctxFor(storage: Storage, mode: AgentMode, attended = true): () => ToolContext {
  return () => ({
    agentId: AGENT,
    sessionId: "session-runner",
    mode,
    attended,
    tainted: false,
    storage,
    now: () => new Date("2026-11-05T10:00:00.000Z"),
    newId: () => "id-1",
    audit: async () => {},
  });
}

describe("toBetaZodTool (SDK Tool Runner adapter)", () => {
  it("builds a runnable SDK tool with the JSON Schema and zod parsing", async () => {
    const storage = await setup();
    const { readA } = makeTools();
    const tool = toBetaZodTool(readA, ctxFor(storage, "autonomous"));
    expect(tool.name).toBe("read_a");
    expect((tool as { input_schema?: unknown }).input_schema).toMatchObject({ type: "object", properties: { id: { type: "string" } } });
    expect(() => tool.parse({ id: 5 })).toThrow();
    const out = await tool.run({ id: "7" });
    expect(out).toBe(JSON.stringify({ note: "read_a:7" }));
  });

  it("still goes through the approval policy: supervised side effects become proposals, nothing runs", async () => {
    const storage = await setup("supervised");
    const tools = makeTools();
    const tool = toBetaZodTool(tools.write, ctxFor(storage, "supervised"));
    const out = await tool.run({ text: "milk" });
    expect(String(out)).toContain('"status":"proposed"');
    expect(tools.executed).toEqual([]);
    const proposals = await storage.proposals.list({ kind: "action" });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.sessionId).toBe("session-runner");
  });

  it("denied calls are thrown as ToolError (the runner sends is_error: true)", async () => {
    const storage = await setup();
    const ran: string[] = [];
    const shell = defineTool({
      name: "shell",
      description: "Run a command. Use it for builds.",
      input: z.object({ command: z.string() }),
      readOnly: false,
      capabilities: ["external.write"],
      run: (input) => void ran.push(input.command),
    });
    const tool = toBetaZodTool(shell, ctxFor(storage, "autonomous"));
    await expect(tool.run({ command: "rm -rf /" })).rejects.toBeInstanceOf(ToolError);
    expect(ran).toEqual([]);
  });

  it("shares one taint flag across a registry's tools: after untrusted output, side effects are proposed", async () => {
    const storage = await setup();
    const tools = makeTools();
    const registry = new ToolRegistry([tools.set]);
    const runnable = toBetaZodTools(registry, ctxFor(storage, "autonomous"));
    const byName = new Map(runnable.map((t) => [t.name, t]));
    const page = await byName.get("fetch_page")?.run({ url: "https://example.com" });
    expect(String(page)).toContain("<untrusted_content");
    const out = await byName.get("save_note")?.run({ text: "pwned" });
    expect(String(out)).toContain("proposed");
    expect(tools.executed).toEqual(["fetch_page"]);
  });

  it("refuses a messaging tool unless allowed", () => {
    const sms = defineTool({
      name: "sms",
      description: "Send an SMS. Use never.",
      input: z.object({}),
      readOnly: false,
      capabilities: ["messaging"],
      run: () => "sent",
    });
    expect(() => toBetaZodTool(sms, () => {
      throw new Error("never");
    })).toThrow(/messaging/);
  });
});
