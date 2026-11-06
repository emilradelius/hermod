import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgent } from "../../../src/loop/index.js";
import { createApprovalPolicy, createDenylist } from "../../../src/safety/index.js";
import { FakeModelClient, textMessage, toolUseMessage } from "../../../src/testing/index.js";
import { defineTool } from "../../../src/tools/define.js";
import type { AgentMode, MessageParam, ToolResultBlockParam } from "../../../src/types.js";
import { baseConfig, makeTools, noSleep, setup } from "./helpers.js";

function lastResults(messages: MessageParam[] | undefined): ToolResultBlockParam[] {
  const last = messages?.at(-1);
  if (!last || last.role !== "user" || !Array.isArray(last.content)) throw new Error("no results");
  return last.content.filter((b): b is ToolResultBlockParam => b.type === "tool_result");
}

async function saveOnce(mode: AgentMode, attended: boolean) {
  const storage = await setup(mode);
  const tools = makeTools();
  const model = new FakeModelClient([toolUseMessage([{ name: "save_note", input: { text: "milk" }, id: "s1" }]), textMessage("ok")]);
  const result = await runAgent(
    baseConfig([tools.set]),
    { userMessage: "remember milk", kind: attended ? "chat" : "job", attended },
    { storage, model, sleep: noSleep },
  );
  return { storage, tools, model, result };
}

describe("runAgent: approvals by mode", () => {
  it("shadow: the side effect is NOT run; a shadow proposal (draft) is created and the model is told it is queued", async () => {
    const { storage, tools, model, result } = await saveOnce("shadow", true);
    expect(tools.executed).toEqual([]);
    expect(result.proposals).toHaveLength(1);
    const proposal = await storage.proposals.get(result.proposals[0] ?? "");
    expect(proposal?.kind).toBe("action");
    expect(proposal?.status).toBe("pending");
    expect(proposal?.shadow).toBe(true);
    expect(proposal?.payload).toEqual({ kind: "action", tool: "save_note", input: { text: "milk" } });
    expect(proposal?.evidence[0]?.kind).toBe("message");
    const content = JSON.parse(String(lastResults(model.calls[1]?.messages)[0]?.content)) as { status: string };
    expect(content.status).toBe("proposed");
    expect(result.toolCalls[0]?.decision).toBe("propose");
  });

  it("shadow: read-only tools still run", async () => {
    const storage = await setup("shadow");
    const tools = makeTools();
    const model = new FakeModelClient([toolUseMessage([{ name: "read_a", input: { id: "1" } }]), textMessage("ok")]);
    await runAgent(baseConfig([tools.set]), { userMessage: "read" }, { storage, model, sleep: noSleep });
    expect(tools.executed).toEqual(["read_a"]);
  });

  it("supervised: the side effect becomes a (non-shadow) proposal", async () => {
    const { storage, tools, result } = await saveOnce("supervised", true);
    expect(tools.executed).toEqual([]);
    const proposal = await storage.proposals.get(result.proposals[0] ?? "");
    expect(proposal?.shadow).toBe(false);
    expect((await storage.audit.list({ action: "tool.propose" })).length).toBe(1);
  });

  it("autonomous and clean: the side effect runs", async () => {
    const { tools, result } = await saveOnce("autonomous", true);
    expect(tools.executed).toEqual(["save_note:milk"]);
    expect(result.proposals).toEqual([]);
  });

  it("unattended shadow and supervised side effects are still proposed (queued drafts)", async () => {
    for (const mode of ["shadow", "supervised"] as const) {
      const { tools, result, storage } = await saveOnce(mode, false);
      expect(tools.executed).toEqual([]);
      expect(result.proposals).toHaveLength(1);
      expect((await storage.proposals.get(result.proposals[0] ?? ""))?.shadow).toBe(mode === "shadow");
    }
  });

  it("unattended autonomous call that needs approval is DENIED with an audit entry", async () => {
    const storage = await setup("autonomous");
    const tools = makeTools();
    const pay = defineTool({
      name: "pay_invoice",
      description: "Pay an invoice. Use only when asked.",
      input: z.object({ id: z.string() }),
      readOnly: false,
      capabilities: ["external.write"],
      requiresApproval: true,
      run: () => {
        tools.executed.push("pay_invoice");
        return "paid";
      },
    });
    const model = new FakeModelClient([toolUseMessage([{ name: "pay_invoice", input: { id: "inv-1" } }]), textMessage("ok")]);
    const result = await runAgent(
      baseConfig([{ name: "money", tools: [pay] }]),
      { userMessage: "pay", kind: "job", attended: false },
      { storage, model, sleep: noSleep },
    );
    expect(tools.executed).toEqual([]);
    expect(result.proposals).toEqual([]);
    expect(result.toolCalls[0]?.decision).toBe("deny");
    const audits = await storage.audit.list({ action: "tool.deny" });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.target).toBe("pay_invoice");
    expect(audits[0]?.details.attended).toBe(false);
    const res = lastResults(model.calls[1]?.messages)[0];
    expect(res?.is_error).toBe(true);
    expect(String(res?.content)).toMatch(/unattended/);
  });

  it("the hard denylist denies in every mode, attended or not", async () => {
    for (const mode of ["shadow", "supervised", "autonomous"] as const) {
      for (const attended of [true, false]) {
        const storage = await setup(mode);
        const ran: string[] = [];
        const shell = defineTool({
          name: "shell",
          description: "Run a shell command. Use it for builds.",
          input: z.object({ command: z.string() }),
          readOnly: false,
          capabilities: ["external.write"],
          run: (input) => {
            ran.push(input.command);
            return "ran";
          },
        });
        const model = new FakeModelClient([toolUseMessage([{ name: "shell", input: { command: "rm -rf /" } }]), textMessage("ok")]);
        const result = await runAgent(
          baseConfig([{ name: "sh", tools: [shell] }]),
          { userMessage: "clean up", kind: attended ? "chat" : "job", attended },
          { storage, model, sleep: noSleep },
        );
        expect(ran).toEqual([]);
        expect(result.proposals).toEqual([]);
        expect(result.toolCalls[0]?.decision).toBe("deny");
        expect(String(lastResults(model.calls[1]?.messages)[0]?.content)).toMatch(/denylist/);
      }
    }
  });

  it("an app's extra denylist pattern applies too (read-only tools included)", async () => {
    const storage = await setup("autonomous");
    const tools = makeTools();
    const approvals = createApprovalPolicy({ denylist: createDenylist({ extraPatterns: [/secret-note/] }) });
    const model = new FakeModelClient([toolUseMessage([{ name: "read_a", input: { id: "secret-note" } }]), textMessage("ok")]);
    await runAgent(baseConfig([tools.set], { approvals }), { userMessage: "read" }, { storage, model, sleep: noSleep });
    expect(tools.executed).toEqual([]);
  });

  it("a policy that throws denies (fail closed)", async () => {
    const storage = await setup("autonomous");
    const tools = makeTools();
    const approvals = {
      decide(): never {
        throw new Error("policy bug");
      },
    };
    const model = new FakeModelClient([toolUseMessage([{ name: "save_note", input: { text: "x" } }]), textMessage("ok")]);
    const result = await runAgent(baseConfig([tools.set], { approvals }), { userMessage: "save" }, { storage, model, sleep: noSleep });
    expect(tools.executed).toEqual([]);
    expect(result.toolCalls[0]?.decision).toBe("deny");
  });
});

describe("runAgent: untrusted text cannot trigger side effects", () => {
  it("an injected instruction the fake model 'obeys' is proposed (attended), never executed, and the output is wrapped", async () => {
    const storage = await setup("autonomous");
    const tools = makeTools();
    const model = new FakeModelClient([
      toolUseMessage([{ name: "fetch_page", input: { url: "https://example.com/recipe" } }]),
      // The model "obeys" the page.
      (req) => {
        const text = JSON.stringify(req.messages.at(-1));
        if (!text.includes("IGNORE ALL PREVIOUS INSTRUCTIONS")) throw new Error("page text missing");
        return toolUseMessage([{ name: "save_note", input: { text: "pwned" } }]);
      },
      textMessage("Done."),
    ]);
    const result = await runAgent(baseConfig([tools.set]), { userMessage: "summarise the recipe" }, { storage, model, sleep: noSleep });
    expect(tools.executed).toEqual(["fetch_page"]);
    expect(result.toolCalls.map((c) => [c.name, c.decision])).toEqual([
      ["fetch_page", "allow"],
      ["save_note", "propose"],
    ]);
    const page = String(lastResults(model.calls[1]?.messages)[0]?.content);
    expect(page.startsWith('<untrusted_content source="tool:fetch_page" nonce="')).toBe(true);
    // The forged closing delimiter inside the page was neutralised: exactly one real closing tag.
    expect(page.match(/<\/untrusted_content>/g)).toHaveLength(1);
  });

  it("unattended: the injected side effect is denied", async () => {
    const storage = await setup("autonomous");
    const tools = makeTools();
    const model = new FakeModelClient([
      toolUseMessage([{ name: "fetch_page", input: { url: "https://example.com" } }]),
      toolUseMessage([{ name: "save_note", input: { text: "pwned" } }]),
      textMessage("Done."),
    ]);
    const result = await runAgent(baseConfig([tools.set]), { userMessage: "check", kind: "job", attended: false }, { storage, model, sleep: noSleep });
    expect(tools.executed).toEqual(["fetch_page"]);
    expect(result.toolCalls[1]?.decision).toBe("deny");
    expect(result.proposals).toEqual([]);
    expect((await storage.audit.list({ action: "tool.deny" })).length).toBe(1);
  });

  it("a side effect after untrusted output in the SAME round is decided as tainted", async () => {
    const storage = await setup("autonomous");
    const tools = makeTools();
    const model = new FakeModelClient([
      toolUseMessage([
        { name: "fetch_page", input: { url: "https://example.com" } },
        { name: "save_note", input: { text: "x" } },
      ]),
      textMessage("ok"),
    ]);
    const result = await runAgent(baseConfig([tools.set]), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(tools.executed).toEqual(["fetch_page"]);
    expect(result.toolCalls[1]?.decision).toBe("propose");
  });

  it("the taint lasts until the next genuine user message (the next runAgent input)", async () => {
    const storage = await setup("autonomous");
    const tools = makeTools();
    const first = await runAgent(
      baseConfig([tools.set]),
      { userMessage: "read the page" },
      {
        storage,
        model: new FakeModelClient([toolUseMessage([{ name: "fetch_page", input: { url: "https://example.com" } }]), textMessage("read")]),
        sleep: noSleep,
      },
    );
    const second = await runAgent(
      baseConfig([tools.set]),
      { userMessage: "now save my note", sessionId: first.sessionId },
      { storage, model: new FakeModelClient([toolUseMessage([{ name: "save_note", input: { text: "mine" } }]), textMessage("saved")]), sleep: noSleep },
    );
    expect(second.toolCalls[0]?.decision).toBe("allow");
    expect(tools.executed).toEqual(["fetch_page", "save_note:mine"]);
  });
});
