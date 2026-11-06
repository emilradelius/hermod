import { describe, expect, it } from "vitest";
import { runAgent } from "../../../src/loop/index.js";
import { apiError, connectionError, FakeModelClient, textMessage, toolUseMessage } from "../../../src/testing/index.js";
import { AGENT, baseConfig, makeTools, noSleep, setup } from "./helpers.js";

describe("runAgent: errors", () => {
  it("429 then success: retries after the injected sleep, honouring retry-after", async () => {
    const storage = await setup();
    const sleeps: number[] = [];
    const model = new FakeModelClient([{ throw: apiError(429, "slow down", { retryAfterSeconds: 7 }) }, textMessage("ok")]);
    const result = await runAgent(baseConfig(), { userMessage: "hi" }, { storage, model, sleep: async (ms) => void sleeps.push(ms) });
    expect(result.end).toBe("end_turn");
    expect(result.text).toBe("ok");
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(7_000);
    expect(result.errors[0]?.kind).toBe("rate_limit");
    expect(model.calls).toHaveLength(2);
  });

  it("a connection error is retried too", async () => {
    const storage = await setup();
    const model = new FakeModelClient([{ throw: connectionError() }, textMessage("ok")]);
    const result = await runAgent(baseConfig(), { userMessage: "hi" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("end_turn");
  });

  it("529 persistent: after 3 retries the fallback model is used (one switch), and the switch is audited", async () => {
    const storage = await setup();
    const overloaded = (): { throw: unknown } => ({ throw: apiError(529, "overloaded") });
    const model = new FakeModelClient([overloaded(), overloaded(), overloaded(), overloaded(), textMessage("from fallback", { model: "claude-opus-5" })]);
    const result = await runAgent(
      baseConfig([], { fallbackModel: "claude-opus-5" }),
      { userMessage: "hi" },
      { storage, model, sleep: noSleep },
    );
    expect(result.end).toBe("end_turn");
    expect(model.calls.map((c) => c.model)).toEqual([
      "claude-opus-5-5",
      "claude-opus-5-5",
      "claude-opus-5-5",
      "claude-opus-5-5",
      "claude-opus-5",
    ]);
    const costs = await storage.costs.list({ sessionId: result.sessionId });
    expect(costs[0]?.model).toBe("claude-opus-5");
    expect((await storage.audit.list({ action: "model.fallback" }))[0]?.target).toBe("claude-opus-5");
  });

  it("529 persistent without a fallback model ends with 'error' (never throws)", async () => {
    const storage = await setup();
    const steps = Array.from({ length: 4 }, () => ({ throw: apiError(529, "overloaded") }));
    const model = new FakeModelClient(steps);
    const result = await runAgent(baseConfig(), { userMessage: "hi" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("error");
    expect(model.calls).toHaveLength(4);
    expect((await storage.sessions.get(result.sessionId))?.status).toBe("error");
  });

  it("the fallback model is switched to only once", async () => {
    const storage = await setup();
    const steps = Array.from({ length: 8 }, () => ({ throw: apiError(500, "boom") }));
    const model = new FakeModelClient(steps);
    const result = await runAgent(baseConfig([], { fallbackModel: "claude-haiku-5-5" }), { userMessage: "hi" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("error");
    expect(model.calls.filter((c) => c.model === "claude-haiku-5-5")).toHaveLength(4);
    expect(model.remaining).toBe(0);
  });

  it("401 ends the run with 'error' at once: no retry, no fallback", async () => {
    const storage = await setup();
    const model = new FakeModelClient([{ throw: apiError(401, "bad key") }]);
    const result = await runAgent(baseConfig([], { fallbackModel: "claude-opus-5" }), { userMessage: "hi" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("error");
    expect(result.errors[0]?.kind).toBe("auth");
    expect(model.calls).toHaveLength(1);
  });

  it("a non-SDK error thrown by the client ends the run with 'error'", async () => {
    const storage = await setup();
    const model = new FakeModelClient([{ throw: new RangeError("client bug") }]);
    const result = await runAgent(baseConfig(), { userMessage: "hi" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("error");
  });

  it("an aborted signal ends the run with 'aborted' and makes no call", async () => {
    const storage = await setup();
    const controller = new AbortController();
    controller.abort();
    const model = new FakeModelClient([textMessage("never")]);
    const result = await runAgent(baseConfig(), { userMessage: "hi", signal: controller.signal }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("aborted");
    expect(model.calls).toHaveLength(0);
    expect((await storage.sessions.get(result.sessionId))?.status).toBe("aborted");
  });
});

describe("runAgent: budgets", () => {
  const loopForever = (): FakeModelClient => {
    const model = new FakeModelClient();
    for (let i = 0; i < 50; i += 1) model.push(toolUseMessage([{ name: "read_a", input: { id: String(i) } }]));
    return model;
  };

  it("the iteration budget ends the run cleanly", async () => {
    const storage = await setup();
    const tools = makeTools();
    const model = loopForever();
    const result = await runAgent(baseConfig([tools.set], { budget: { maxIterations: 3 } }), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("budget_iterations");
    expect(model.calls).toHaveLength(3);
    expect(result.iterations).toBe(3);
    expect((await storage.sessions.get(result.sessionId))?.status).toBe("done");
  });

  it("the USD budget stops before the call that would go over it", async () => {
    const storage = await setup();
    const tools = makeTools();
    const model = loopForever();
    // Each fake call costs 1000 input x $4/MTok + 100 output x $20/MTok = $0.006.
    const result = await runAgent(baseConfig([tools.set], { budget: { maxCostUsd: 0.01 } }), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("budget_cost");
    expect(result.costUsd).toBeLessThanOrEqual(0.012 + 1e-9);
    expect(model.calls.length).toBeGreaterThanOrEqual(1);
    expect(model.calls.length).toBeLessThanOrEqual(2);
  });

  it("a zero USD budget makes no call", async () => {
    const storage = await setup();
    const model = new FakeModelClient([textMessage("x")]);
    const result = await runAgent(baseConfig([], { budget: { maxCostUsd: 0 } }), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("budget_cost");
    expect(model.calls).toHaveLength(0);
  });

  it("the agent's monthly cap counts what was spent earlier this month", async () => {
    const storage = await setup("autonomous", { monthlyCostCapUsd: 1 });
    const now = new Date("2026-11-20T12:00:00.000Z");
    const base = { agentId: AGENT, sessionId: null, model: "claude-opus-5-5", purpose: "main" as const, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await storage.costs.add({ ...base, at: "2026-11-02T00:00:00.000Z", costUsd: 0.999 });
    await storage.costs.add({ ...base, at: "2026-10-31T23:59:59.000Z", costUsd: 50 }); // last month: not counted
    const model = new FakeModelClient([textMessage("x")]);
    const result = await runAgent(baseConfig(), { userMessage: "go" }, { storage, model, sleep: noSleep, now: () => now });
    expect(result.end).toBe("budget_cost");
    expect(model.calls).toHaveLength(0);

    const roomy = await setup("autonomous", { monthlyCostCapUsd: 1 });
    await roomy.costs.add({ ...base, at: "2026-10-31T23:59:59.000Z", costUsd: 50 });
    const ok = await runAgent(baseConfig(), { userMessage: "go" }, { storage: roomy, model: new FakeModelClient([textMessage("x")]), sleep: noSleep, now: () => now });
    expect(ok.end).toBe("end_turn");
  });

  it("the wall-clock budget ends the run", async () => {
    const storage = await setup();
    const tools = makeTools();
    let t = Date.parse("2026-11-05T10:00:00.000Z");
    const model = new FakeModelClient();
    for (let i = 0; i < 10; i += 1) {
      model.push(() => {
        t += 600;
        return toolUseMessage([{ name: "read_a", input: { id: "x" } }]);
      });
    }
    const result = await runAgent(
      baseConfig([tools.set], { budget: { maxWallMs: 1_000 } }),
      { userMessage: "go" },
      { storage, model, sleep: noSleep, now: () => new Date(t) },
    );
    expect(result.end).toBe("budget_time");
    expect(model.calls).toHaveLength(2);
  });

  it("onCost reports each call and the running total", async () => {
    const storage = await setup();
    const tools = makeTools();
    const seen: Array<{ usd: number; totalUsd: number }> = [];
    const model = new FakeModelClient([toolUseMessage([{ name: "read_a", input: { id: "1" } }]), textMessage("ok")]);
    const result = await runAgent(
      baseConfig([tools.set]),
      { userMessage: "go", callbacks: { onCost: (e) => seen.push(e) } },
      { storage, model, sleep: noSleep },
    );
    expect(seen).toHaveLength(2);
    expect(seen[1]?.totalUsd).toBeCloseTo(result.costUsd, 12);
    expect((seen[0]?.usd ?? 0) + (seen[1]?.usd ?? 0)).toBeCloseTo(result.costUsd, 12);
  });
});
