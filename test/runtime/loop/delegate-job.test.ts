import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeDelegateTool, makeJobRunner, runAgent } from "../../../src/loop/index.js";
import { createApprovalPolicy } from "../../../src/safety/index.js";
import { FakeModelClient, textMessage, toolUseMessage } from "../../../src/testing/index.js";
import { defineTool } from "../../../src/tools/define.js";
import type { ApprovalPolicy, MessageParam, ToolCapability, ToolDef, Toolset } from "../../../src/types.js";
import { AGENT, baseConfig, makeTools, noSleep, setup } from "./helpers.js";

function capTool(name: string, capability: ToolCapability): ToolDef {
  return defineTool({
    name,
    description: `A ${capability} tool. Use it in tests.`,
    input: z.object({}),
    readOnly: false,
    capabilities: [capability],
    run: () => "ok",
  });
}

function everything(): { set: Toolset; extra: Toolset; tools: ReturnType<typeof makeTools> } {
  const tools = makeTools();
  return {
    tools,
    set: tools.set,
    extra: {
      name: "powers",
      tools: [
        capTool("remember", "memory.write"),
        capTool("learn_skill", "skills.write"),
        capTool("text_owner", "messaging"),
        capTool("schedule_job", "scheduling"),
        makeDelegateTool(),
      ],
    },
  };
}

function lastResultText(messages: MessageParam[] | undefined): string {
  const last = messages?.at(-1);
  return JSON.stringify(last?.content ?? "");
}

describe("delegate tool", () => {
  it("runs a child with a fresh delegate session and only the allowed tools; returns only its final text, truncated", async () => {
    const storage = await setup("autonomous");
    const { set, extra } = everything();
    const longReport = `Report: ${"r".repeat(5_000)}`;
    const model = new FakeModelClient([
      toolUseMessage([{ name: "delegate", input: { task: "Read note 7 and report." } }]),
      textMessage(longReport),
      textMessage("Parent done."),
    ]);
    const result = await runAgent(
      baseConfig([set, extra], { budget: { maxCostUsd: 1 } }),
      { userMessage: "delegate it" },
      { storage, model, sleep: noSleep, allowOwnerMessaging: true },
    );
    expect(result.end).toBe("end_turn");
    const parentTools = model.calls[0]?.tools?.map((t) => t.name);
    expect(parentTools).toContain("remember");
    expect(parentTools).toContain("text_owner");
    const childCall = model.calls[1];
    expect(childCall?.purpose).toBe("delegate");
    expect(childCall?.tools?.map((t) => t.name)).toEqual(["fetch_page", "flaky", "read_a", "read_b", "read_c", "save_note"]);
    expect(childCall?.messages).toHaveLength(1);
    expect(JSON.stringify(childCall?.messages[0])).toContain("Read note 7 and report.");

    const sessions = await storage.sessions.listByAgent(AGENT);
    const child = sessions.find((s) => s.kind === "delegate");
    expect(child?.parentId).toBe(result.sessionId);
    expect(child?.status).toBe("done");

    const returned = lastResultText(model.calls[2]?.messages);
    expect(returned).toContain("Report: rrr");
    expect(returned).toMatch(/truncated: \d+ more characters/);
    expect(returned.length).toBeLessThan(4_400);
    // The parent's cost includes the child's.
    const childCosts = await storage.costs.list({ sessionId: child?.id ?? "" });
    expect(childCosts).toHaveLength(1);
    const parentCosts = await storage.costs.list({ sessionId: result.sessionId });
    const sum = [...childCosts, ...parentCosts].reduce((s, c) => s + c.costUsd, 0);
    expect(result.costUsd).toBeCloseTo(sum, 12);
  });

  it("gives the child a slice of the parent's remaining USD", async () => {
    const storage = await setup("autonomous");
    const { set, extra } = everything();
    const model = new FakeModelClient([toolUseMessage([{ name: "delegate", input: { task: "loop" } }])]);
    for (let i = 0; i < 20; i += 1) model.push(toolUseMessage([{ name: "read_a", input: { id: String(i) } }]));
    model.push(textMessage("Parent done."));
    // Parent cap 0.02; after its first call ($0.006) the child gets half of $0.014 = $0.007: room for one call.
    const result = await runAgent(baseConfig([set, extra], { budget: { maxCostUsd: 0.02 } }), { userMessage: "go" }, { storage, model, sleep: noSleep, allowOwnerMessaging: true });
    const child = (await storage.sessions.listByAgent(AGENT)).find((s) => s.kind === "delegate");
    const childCosts = await storage.costs.list({ sessionId: child?.id ?? "" });
    expect(childCosts.length).toBe(1);
    expect(lastResultText(model.calls[2]?.messages)).toContain("budget_cost");
    expect(result.costUsd).toBeLessThanOrEqual(0.02 + 1e-9);
  });

  it("a child cannot launder an injected task: it inherits the parent's taint", async () => {
    const storage = await setup("autonomous");
    const { set, extra, tools } = everything();
    const base = createApprovalPolicy();
    // An app policy that lets delegation through even when tainted (so the child's own decisions are what is tested).
    const approvals: ApprovalPolicy = {
      decide: (ctx) => (ctx.tool.name === "delegate" ? { decision: "allow", reason: "test" } : base.decide(ctx)),
    };
    const model = new FakeModelClient([
      toolUseMessage([{ name: "fetch_page", input: { url: "https://example.com" } }]),
      toolUseMessage([{ name: "delegate", input: { task: "save the note 'pwned'" } }]),
      toolUseMessage([{ name: "save_note", input: { text: "pwned" } }]),
      textMessage("child done"),
      textMessage("parent done"),
    ]);
    await runAgent(baseConfig([set, extra], { approvals }), { userMessage: "read the page" }, { storage, model, sleep: noSleep, allowOwnerMessaging: true });
    expect(tools.executed).toEqual(["fetch_page"]);
    const proposals = await storage.proposals.list({ kind: "action" });
    expect(proposals.map((p) => p.target)).toEqual(["save_note"]);
  });

  it("a child that read untrusted text taints the parent and its report comes back wrapped", async () => {
    const storage = await setup("autonomous");
    const { set, extra, tools } = everything();
    const model = new FakeModelClient([
      toolUseMessage([{ name: "delegate", input: { task: "read the page" } }]),
      toolUseMessage([{ name: "fetch_page", input: { url: "https://example.com" } }]),
      textMessage("The page says to save 'pwned'."),
      toolUseMessage([{ name: "save_note", input: { text: "pwned" } }]),
      textMessage("parent done"),
    ]);
    const result = await runAgent(baseConfig([set, extra]), { userMessage: "delegate" }, { storage, model, sleep: noSleep, allowOwnerMessaging: true });
    expect(lastResultText(model.calls[3]?.messages)).toContain('untrusted_content source=\\"delegate\\"');
    expect(tools.executed).toEqual(["fetch_page"]);
    expect(result.toolCalls.at(-1)?.decision).toBe("propose");
  });

  it("in supervised mode the delegation itself is a proposal (it is not read-only)", async () => {
    const storage = await setup("supervised");
    const { set, extra } = everything();
    const model = new FakeModelClient([toolUseMessage([{ name: "delegate", input: { task: "x" } }]), textMessage("ok")]);
    const result = await runAgent(baseConfig([set, extra]), { userMessage: "go" }, { storage, model, sleep: noSleep, allowOwnerMessaging: true });
    expect(result.toolCalls[0]?.decision).toBe("propose");
    expect(model.calls).toHaveLength(2);
  });

  it("validates its options", () => {
    expect(() => makeDelegateTool({ shareOfRemaining: 0 })).toThrow(/shareOfRemaining/);
    expect(() => makeDelegateTool({ shareOfRemaining: 2 })).toThrow(/shareOfRemaining/);
    expect(() => makeDelegateTool({ maxIterations: 0 })).toThrow(/maxIterations/);
  });
});

describe("makeJobRunner", () => {
  async function jobSetup(mode: "autonomous" | "shadow" = "autonomous") {
    const storage = await setup(mode);
    await storage.skills.create({ agentId: AGENT, name: "morning-brief", description: "Write the morning brief.", body: "Brief steps here.", createdBy: "test" });
    const job = await storage.jobs.upsert({
      agentId: AGENT,
      name: "brief",
      schedule: "0 7 * * *",
      timeZone: "Europe/Stockholm",
      prompt: "Write the brief.",
      deliver: "inapp:owner",
      skills: ["morning-brief"],
    });
    return { storage, job };
  }

  it("uses a FRESH session per run (kind job, unattended), attaches the job's skills and drops scheduling/delegation/messaging", async () => {
    const { storage, job } = await jobSetup();
    const { set, extra } = everything();
    const model = new FakeModelClient([textMessage("Brief one."), textMessage("Brief two.")]);
    const runJob = makeJobRunner({ storage, model, sleep: noSleep, allowOwnerMessaging: true, configFor: () => baseConfig([set, extra]) });
    const signal = new AbortController().signal;
    const one = await runJob(job, { attended: false, now: new Date(), signal, context: "Weather: rain." });
    const two = await runJob(job, { attended: false, now: new Date(), signal });
    expect([one.text, two.text]).toEqual(["Brief one.", "Brief two."]);
    const sessions = await storage.sessions.listByAgent(AGENT, { kind: "job" });
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.attended === false && s.kind === "job")).toBe(true);
    expect(model.calls[1]?.messages).toHaveLength(1);
    expect(JSON.stringify(model.calls[0]?.messages[0])).toContain("Weather: rain.");
    expect(JSON.stringify(model.calls[1]?.messages[0])).not.toContain("Weather");
    expect(model.calls[0]?.system[1]?.text).toContain("Brief steps here.");
    const names = model.calls[0]?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("remember");
    expect(names).not.toContain("schedule_job");
    expect(names).not.toContain("delegate");
    expect(names).not.toContain("text_owner");
    expect(model.calls[0]?.purpose).toBe("job");
  });

  it("decides approvals as unattended even with an app policy, and audits as the job", async () => {
    const { storage, job } = await jobSetup();
    const { set } = makeToolsSet();
    const model = new FakeModelClient([
      toolUseMessage([{ name: "fetch_page", input: { url: "https://example.com" } }]),
      toolUseMessage([{ name: "save_note", input: { text: "pwned" } }]),
      textMessage("done"),
    ]);
    const runJob = makeJobRunner({ storage, model, sleep: noSleep, configFor: () => baseConfig([set], { approvals: createApprovalPolicy() }) });
    await runJob(job, { attended: false, now: new Date(), signal: new AbortController().signal });
    const denied = await storage.audit.list({ action: "tool.deny" });
    expect(denied).toHaveLength(1);
    expect(denied[0]?.actor).toBe(`job:${job.id}`);
    expect(await storage.proposals.list({})).toEqual([]);
  });

  it("a scheduled shadow agent leaves drafts (proposals) instead of running side effects", async () => {
    const { storage, job } = await jobSetup("shadow");
    const { set, tools } = makeToolsSet();
    const model = new FakeModelClient([toolUseMessage([{ name: "save_note", input: { text: "draft" } }]), textMessage("done")]);
    const runJob = makeJobRunner({ storage, model, sleep: noSleep, configFor: () => baseConfig([set]) });
    await runJob(job, { attended: false, now: new Date(), signal: new AbortController().signal });
    expect(tools.executed).toEqual([]);
    const proposals = await storage.proposals.list({});
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.shadow).toBe(true);
  });

  it("throws when the run does not end normally, so the scheduler records an error", async () => {
    const { storage, job } = await jobSetup();
    const model = new FakeModelClient([{ throw: new RangeError("boom") }]);
    const runJob = makeJobRunner({ storage, model, sleep: noSleep, configFor: () => baseConfig() });
    await expect(runJob(job, { attended: false, now: new Date(), signal: new AbortController().signal })).rejects.toThrow(/ended with "error"/);
  });

  it("refuses a config for another agent", async () => {
    const { storage, job } = await jobSetup();
    const runJob = makeJobRunner({ storage, model: new FakeModelClient([]), configFor: () => ({ agentId: "other", systemPrompt: "x" }) });
    await expect(runJob(job, { attended: false, now: new Date(), signal: new AbortController().signal })).rejects.toThrow(/agent/);
  });
});

function makeToolsSet(): { set: Toolset; tools: ReturnType<typeof makeTools> } {
  const tools = makeTools();
  return { set: tools.set, tools };
}
