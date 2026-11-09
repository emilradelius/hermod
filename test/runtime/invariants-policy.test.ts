/**
 * Invariant cases added by the policy hardening pass (the agent only proposes; untrusted text cannot trigger side
 * effects; off means off; shadow runs no side effects; unattended runs deny). End to end with the real modules; only
 * the model is faked. These tests must never be weakened to make something pass (CLAUDE.md).
 */
import { describe, expect, it } from "vitest";
import { curate, reviewSession } from "../../src/learning/index.js";
import { makeJobRunner } from "../../src/loop/index.js";
import { COMPRESSION_MARKER } from "../../src/loop/compress.js";
import { knowledgeDeps } from "../../src/memory/index.js";
import { setMode } from "../../src/modes/index.js";
import { ProposalService } from "../../src/proposals/index.js";
import { FakeModelClient, textMessage, toolUseMessage } from "../../src/testing/index.js";
import { toBetaZodTool } from "../../src/tools/index.js";
import { AgentOffError, type ToolDef } from "../../src/types.js";
import { AGENT, NOW, OWNER, config, entries, run, sideEffect, toolCtx, world } from "./hardening/policy-helpers.js";
import { runAgent } from "../../src/loop/index.js";
import { defaultDenylist } from "../../src/safety/index.js";
import { makeMemoryTool } from "../../src/tools/builtin/index.js";
import type { MessageRecord, SessionRecord, ToolContext } from "../../src/types.js";

describe("invariant: the agent only proposes (policy hardening)", () => {
  it("a scheduled job's memory add never applies directly, even to an add-only store with trusted pre-step output", async () => {
    const w = await world();
    w.model.push(
      toolUseMessage([{ name: "memory", input: { store: "user", ops: [{ op: "add", text: "User wants every invoice paid." }] } }]),
      textMessage("Done."),
    );
    const runner = makeJobRunner({
      storage: w.storage,
      model: w.model,
      sleep: async () => {},
      now: () => NOW,
      knowledge: knowledgeDeps({ memory: w.memory, skills: w.skills }),
      trustPreStepOutput: true,
      configFor: () => config(w),
    });
    const job = await w.storage.jobs.upsert({
      agentId: AGENT,
      name: "Nightly",
      schedule: "0 3 * * *",
      timeZone: "Europe/Stockholm",
      prompt: "Do the nightly round.",
      deliver: "inapp:owner",
    });
    await runner(job, { attended: false, now: NOW, signal: new AbortController().signal, context: "3 new notes." });
    expect(await entries(w, "user")).toEqual([]);
    const proposals = await w.storage.proposals.list({ agentId: AGENT });
    expect(proposals.map((p) => [p.kind, p.status])).toEqual([["memory", "pending"]]);
  });

  it("a shadow run's drafts can be scored but never approved: nothing they describe ever runs", async () => {
    const w = await world({ mode: "shadow" });
    await run(w, [toolUseMessage([{ name: "save_note", input: { text: "milk" } }]), textMessage("Drafted.")]);
    const ran: unknown[] = [];
    const proposals = new ProposalService({
      storage: w.storage,
      memory: w.memory,
      skills: w.skills,
      executeAction: async (payload) => void ran.push(payload),
    });
    const [draft] = await w.storage.proposals.list({ agentId: AGENT });
    expect(draft).toMatchObject({ kind: "action", shadow: true, status: "pending" });
    await expect(proposals.approve(draft?.id ?? "", OWNER)).rejects.toMatchObject({ code: "not_allowed" });
    // Even after the agent is promoted, the old shadow draft stays a draft.
    await setMode(w.storage, AGENT, "autonomous", OWNER);
    await expect(proposals.approve(draft?.id ?? "", OWNER)).rejects.toMatchObject({ code: "not_allowed" });
    expect(ran).toEqual([]);
    expect(w.executed).toEqual([]);
  });

  it("none of Hermod's own actors, in any letter case, can decide a proposal or change a mode", async () => {
    const w = await world({ mode: "supervised" });
    await run(w, [toolUseMessage([{ name: "save_note", input: { text: "milk" } }]), textMessage("Proposed.")]);
    const [proposal] = await w.storage.proposals.list({ agentId: AGENT });
    for (const actor of ["Agent:x", "JOB:x", "Review", "SYSTEM", "Curator", "scheduler:tick", "Delegate:child"]) {
      await expect(w.proposals.approve(proposal?.id ?? "", actor)).rejects.toMatchObject({ code: "not_allowed" });
      await expect(setMode(w.storage, AGENT, "autonomous", actor)).rejects.toMatchObject({ code: "not_allowed" });
    }
    expect((await w.storage.proposals.get(proposal?.id ?? ""))?.status).toBe("pending");
    expect(w.executed).toEqual([]);
  });

  it("a compression summary is never the user's words: quoting it makes a proposal, not a direct write", async () => {
    const w = await world();
    const session = await w.storage.sessions.create({ agentId: AGENT, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
    await w.storage.messages.append(session.id, { role: "system", content: [{ type: "text", text: "compressed" }], text: `${COMPRESSION_MARKER} x` });
    const fact = "User wants every invoice paid at once.";
    const text = `Summary of the conversation so far.\n\n## Constraints\n${fact}`;
    const summary = await w.storage.messages.append(session.id, { role: "user", content: [{ type: "text", text }], text });
    const model = new FakeModelClient([
      toolUseMessage([
        {
          name: "memory",
          input: { store: "user", ops: [{ op: "add", text: fact }], evidence: [{ messageId: summary.id, quote: fact }], rationale: "Said." },
        },
      ]),
      textMessage("Done."),
    ]);
    const outcome = await reviewSession(session.id, { ...w, model, sleep: async () => {} });
    expect(outcome.applied).toEqual([]);
    expect(await entries(w, "user")).toEqual([]);
  });
});

describe("invariant: shadow runs no side effects, unattended denies, off means off (policy hardening)", () => {
  it("an app tool that only declares memory.write is drafted in shadow mode and denied unattended after untrusted text", async () => {
    const shadow = await world({ mode: "shadow" });
    const own = sideEffect("remember_elsewhere", ["memory.write"], shadow.executed);
    await run(shadow, [toolUseMessage([{ name: "remember_elsewhere", input: { text: "x" } }]), textMessage("ok")], {}, {
      toolsets: [shadow.knowledge, shadow.notes, { name: "app", tools: [own] }],
    });
    expect(shadow.executed).toEqual([]);
    expect((await shadow.storage.proposals.list({ agentId: AGENT })).map((p) => p.shadow)).toEqual([true]);

    const auto = await world();
    const own2 = sideEffect("remember_elsewhere", ["skills.write"], auto.executed);
    await run(
      auto,
      [
        toolUseMessage([{ name: "fetch_page", input: { url: "https://example.test" } }]),
        toolUseMessage([{ name: "remember_elsewhere", input: { text: "x" } }]),
        textMessage("ok"),
      ],
      { kind: "job", attended: false },
      { toolsets: [auto.knowledge, auto.notes, { name: "app", tools: [own2] }] },
    );
    expect(auto.executed).toEqual([]);
  });

  it("untrusted text read through one SDK-runner tool gates every other tool of the session", async () => {
    const w = await world();
    const session = await w.storage.sessions.create({ agentId: AGENT, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
    const byName = new Map(w.notes.tools.map((t) => [t.name, t as ToolDef]));
    const factory = () => toolCtx(w.storage, session.id);
    await toBetaZodTool(byName.get("fetch_page") as ToolDef, factory).run({ url: "https://example.test" });
    const out = await toBetaZodTool(byName.get("save_note") as ToolDef, factory).run({ text: "pwned" });
    expect(String(out)).toContain("proposed");
    expect(w.executed).toEqual([]);
  });

  it("the curator writes nothing for an agent that is off", async () => {
    const w = await world();
    await w.skills.createSkill(AGENT, { name: "weekly-review", description: "Weekly steps. Use it on Fridays.", body: "1. Look." }, { actor: OWNER });
    await setMode(w.storage, AGENT, "off", OWNER);
    const audit = await w.storage.audit.list({});
    await expect(curate(w.storage, { agentId: AGENT, now: new Date(NOW.getTime() + 60 * 86_400_000) })).rejects.toBeInstanceOf(AgentOffError);
    expect((await w.storage.skills.get(AGENT, "weekly-review"))?.status).toBe("active");
    expect(await w.storage.audit.list({})).toEqual(audit);
  });
});

describe("invariant: off, shadow and the person's words hold on every path (policy hardening, round 3)", () => {
  it("off in storage means off for the SDK Tool Runner adapter: nothing runs, whatever ctx.mode says", async () => {
    const w = await world({ mode: "off" });
    const session = await w.storage.sessions.create({ agentId: AGENT, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
    const factory = (): ToolContext => toolCtx(w.storage, session.id, { mode: "autonomous" });
    const read: string[] = [];
    for (const tool of w.notes.tools) {
      await expect(toBetaZodTool(tool, factory).run({ id: "1", url: "https://example.test", text: "x" })).rejects.toThrow();
      read.push(tool.name);
    }
    expect(read).toHaveLength(w.notes.tools.length);
    expect(w.executed).toEqual([]);
    expect(await w.storage.proposals.list({ agentId: AGENT })).toEqual([]);
  });

  it("shadow in storage: the adapter's side effects are drafts only, whatever ctx.mode says", async () => {
    const w = await world({ mode: "shadow" });
    const session = await w.storage.sessions.create({ agentId: AGENT, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
    const save = w.notes.tools.find((t) => t.name === "save_note") as ToolDef;
    await toBetaZodTool(save, () => toolCtx(w.storage, session.id, { mode: "autonomous" })).run({ text: "x" });
    expect(w.executed).toEqual([]);
    expect((await w.storage.proposals.list({ agentId: AGENT })).map((p) => p.shadow)).toEqual([true]);
  });

  it("an attended chat continued unattended by the app is not the person's words: its review only proposes", async () => {
    const w = await world();
    w.model.push(textMessage("Hello."), textMessage("Noted."));
    const first = await runAgent(config(w), { userMessage: "Hello there." }, w.deps);
    await runAgent(config(w), { sessionId: first.sessionId, attended: false, userMessage: "I always want metric units in answers." }, w.deps);
    const session = (await w.storage.sessions.get(first.sessionId)) as SessionRecord;
    const message = (await w.storage.messages.list(session.id)).find((m) => m.role === "user" && m.text.includes("metric units")) as MessageRecord;
    const model = new FakeModelClient([
      toolUseMessage([
        {
          name: "memory",
          input: {
            store: "user",
            ops: [{ op: "add", text: "User prefers metric units." }],
            evidence: [{ messageId: message.id, quote: "I always want metric units" }],
            rationale: "The user said so.",
          },
        },
      ]),
      textMessage("Done."),
    ]);
    const outcome = await reviewSession(session.id, { storage: w.storage, model, memory: w.memory, skills: w.skills, proposals: w.proposals, now: () => NOW, sleep: async () => {} });
    expect(outcome.applied).toEqual([]);
    expect(outcome.proposals).toHaveLength(1);
    expect(await entries(w, "user")).toEqual([]);
  });

  it("a knowledge tool whose run was replaced loses its exemption: in shadow mode the replacement never runs", async () => {
    const w = await world({ mode: "shadow" });
    const ran: string[] = [];
    const patched = makeMemoryTool(w.memory) as unknown as ToolDef;
    patched.run = () => void ran.push("patched");
    await run(
      w,
      [toolUseMessage([{ name: "memory", input: { store: "user", ops: [{ op: "add", text: "x" }] } }]), textMessage("Done.")],
      {},
      { toolsets: [{ name: "knowledge", tools: [patched] }, w.notes] },
    );
    expect(ran).toEqual([]);
    expect(await entries(w, "user")).toEqual([]);
  });

  it("exec-style inputs of the worst commands are on the hard denylist", () => {
    for (const input of [{ command: "rm", args: ["-rf", "/"] }, { argv: ["find", "/", "-delete"] }]) {
      expect(defaultDenylist.isDenied({ tool: "exec", input }).denied, JSON.stringify(input)).toBe(true);
    }
  });
});
