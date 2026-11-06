/**
 * The eval harness (evals/harness.mjs, evals/live.mjs) run against the sources: every fixture passes, the harness
 * notices when the behaviour a fixture expects does not happen, and the live runner's gate and cost cap hold.
 * (`npm run eval` runs the same fixtures against the built library.)
 */
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatTable, runEval, runScenario, validateFixture, type Fixture } from "../../evals/harness.mjs";
import { CappedModelClient, LIVE_CAP_USD, LIVE_SCENARIOS, LiveCapError, liveGate, runLive } from "../../evals/live.mjs";
import * as lib from "../../src/index.js";
import * as testing from "../../src/testing/index.js";

const DIR = join(import.meta.dirname, "..", "..", "evals", "fixtures");
const FIXTURES: Fixture[] = readdirSync(DIR)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(DIR, file), "utf8")) as Fixture);
const options = { lib, testing, openSqlite: () => new Database(":memory:") };

function fixture(name: string): Fixture {
  const found = FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture ${name}`);
  return structuredClone(found);
}

async function outcome(f: Fixture) {
  return runScenario(f, options);
}

describe("eval fixtures", () => {
  it("are valid, uniquely named and cover the required scenarios", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(10);
    for (const f of FIXTURES) expect(validateFixture(f), f.name).toEqual([]);
    const names = FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of [
      "plain-answer",
      "tool-round",
      "memory-write-proposal",
      "memory-autoapply-add",
      "review-ungrounded-refused",
      "refusal",
      "rate-limit-retry",
      "untrusted-injection-blocked",
      "scheduled-silent",
      "shadow-draft",
    ]) {
      expect(names).toContain(required);
    }
    expect(FIXTURES.some((f) => f.storage === "sqlite")).toBe(true);
  });

  it("all pass against the sources", async () => {
    const results = await runEval(FIXTURES, options);
    const failed = results.filter((r) => !r.ok);
    expect(failed, formatTable(results)).toEqual([]);
    expect(results).toHaveLength(FIXTURES.length);
  });
});

describe("the harness fails a scenario when the behaviour does not happen", () => {
  it("a side effect that was expected to run, but was blocked, is reported", async () => {
    const f = fixture("untrusted-injection-blocked");
    f.expect.ran = ["fetch_page", "save_note", "send_invoice"];
    const r = await outcome(f);
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/app tools that ran/);
  });

  it("the same expectations in a different world fail: an agent that is not off", async () => {
    const f = fixture("off-means-off");
    f.agent = { mode: "autonomous" };
    const r = await outcome(f);
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/thrown error/);
    expect(r.failures.join("\n")).toMatch(/model calls/);
  });

  it("a store without add-only writes does not take the add the autoApply fixture expects", async () => {
    const f = fixture("memory-autoapply-add");
    const seed = f.seed as { stores: Array<{ autoApply: string }> };
    seed.stores[0] = { ...seed.stores[0], autoApply: "none" };
    const r = await outcome(f);
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/proposal count: expected 0, got 1/);
    expect(r.failures.join("\n")).toMatch(/store user entries/);
  });

  it("a job that says something is not silent", async () => {
    const f = fixture("scheduled-silent");
    f.steps = [{ toolUse: [{ name: "read_note", input: { id: "inbox" } }] }, { text: "Something needs you." }];
    const r = await outcome(f);
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/tick\.silent/);
    expect(r.failures.join("\n")).toMatch(/deliveries: expected 0, got 1/);
  });

  it("a grounded quote is not refused (and, from the user, writes to the add-only store)", async () => {
    const f = fixture("review-ungrounded-refused");
    const step = f.steps[0] as { toolUse: Array<{ input: { evidence: Array<{ quote: string }> } }> };
    const first = step.toolUse[0];
    if (!first) throw new Error("fixture changed");
    first.input.evidence[0] = { ...first.input.evidence[0], quote: "I always want metric units" } as { quote: string };
    const r = await outcome(f);
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/review refused: expected 2, got 1/);
    expect(r.failures.join("\n")).toMatch(/store user content \(unchanged\)/);
  });

  it("retries run out: four 429s end the run with an error", async () => {
    const f = fixture("rate-limit-retry");
    const limited = { error: { status: 429, message: "Rate limited.", retryAfterSeconds: 0 } };
    f.steps = [limited, limited, limited, limited, { text: "Hello. What can I do?" }];
    const r = await outcome(f);
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/end: expected "end_turn", got "error"/);
    expect(r.failures.join("\n")).toMatch(/scripted step\(s\) were never used/);
  });

  it("an unused scripted step, a missing toolset or a broken fixture is reported, never ignored", async () => {
    const extra = fixture("plain-answer");
    extra.steps.push({ text: "never asked for" });
    expect((await outcome(extra)).failures.join("\n")).toMatch(/never used/);

    const unknown = fixture("plain-answer");
    unknown.config = { toolsets: ["web"] as unknown as Array<"notes"> };
    const [result] = await runEval([unknown], options);
    expect(result?.ok).toBe(false);
    expect(result?.failures.join("\n")).toMatch(/unknown toolset/);

    expect(validateFixture({})).not.toEqual([]);
    expect(validateFixture({ ...fixture("plain-answer"), expect: {} })).toContain("expect must hold at least one expectation");
    expect(validateFixture({ ...fixture("plain-answer"), steps: [{ text: "a", refusal: null }] })).not.toEqual([]);
    expect(validateFixture({ ...fixture("plain-answer"), name: "Not Kebab" })).not.toEqual([]);
  });

  it("the table shows each failure and the totals", async () => {
    const f = fixture("plain-answer");
    f.expect.text = "something else";
    const table = formatTable(await runEval([fixture("plain-answer"), f], options));
    expect(table).toMatch(/PASS\s+plain-answer/);
    expect(table).toMatch(/FAIL\s+plain-answer/);
    expect(table).toMatch(/- text: expected "something else"/);
    expect(table).toMatch(/1 passed, 1 failed/);
  });
});

describe("live evals: the gate and the cost cap", () => {
  it("run only with HERMOD_LIVE=1 and a key, and never in CI", () => {
    const key = ["sk", "ant", "test", "0000"].join("-");
    expect(liveGate({})).toMatch(/HERMOD_LIVE=1/);
    expect(liveGate({ HERMOD_LIVE: "1" })).toMatch(/HERMOD_LIVE=1/);
    expect(liveGate({ ANTHROPIC_API_KEY: key })).toMatch(/HERMOD_LIVE=1/);
    expect(liveGate({ HERMOD_LIVE: "true", ANTHROPIC_API_KEY: key })).not.toBeNull();
    expect(liveGate({ HERMOD_LIVE: "1", ANTHROPIC_API_KEY: key, CI: "true" })).toMatch(/never run in CI/);
    expect(liveGate({ HERMOD_LIVE: "1", ANTHROPIC_API_KEY: key, CI: "1" })).toMatch(/never run in CI/);
    expect(liveGate({ HERMOD_LIVE: "1", ANTHROPIC_API_KEY: key })).toBeNull();
    expect(liveGate({ HERMOD_LIVE: "1", ANTHROPIC_API_KEY: key, CI: "false" })).toBeNull();
  });

  it("when the gate is closed, runLive exits 0 without making a client", async () => {
    const lines: string[] = [];
    let made = 0;
    const makeClient = () => {
      made += 1;
      return new testing.FakeModelClient();
    };
    expect(await runLive({ lib, env: {}, log: (l) => lines.push(l), makeClient })).toBe(0);
    expect(await runLive({ lib, env: { HERMOD_LIVE: "1", ANTHROPIC_API_KEY: "x", CI: "true" }, log: (l) => lines.push(l), makeClient })).toBe(0);
    expect(made).toBe(0);
    expect(lines.join("\n")).toMatch(/npm run eval:live/);
  });

  it("the capped client refuses a call that could take the run past the cap, before sending it", async () => {
    // Each call really costs about $0.22 (50k input tokens on Opus 5.5); the estimate for the next call is ~$0.08.
    const inner = new testing.FakeModelClient(
      Array.from({ length: 5 }, () => testing.textMessage("ok", { usage: { input: 50_000, output: 1_000 } })),
    );
    const tracker = new lib.CostTracker({ capUsd: LIVE_CAP_USD });
    const client = new CappedModelClient({ inner, tracker, lib });
    const request = {
      model: "claude-opus-5-5",
      system: [{ type: "text" as const, text: "Be brief." }],
      messages: [{ role: "user" as const, content: "Hi" }],
      maxTokens: 2048,
      effort: "low" as const,
    };
    expect(client.estimate(request)).toBeGreaterThan(lib.estimateMaxCost("claude-opus-5-5", 10, 2048));
    await client.complete(request);
    await client.complete(request);
    await expect(client.complete(request)).rejects.toBeInstanceOf(LiveCapError);
    expect(inner.calls).toHaveLength(2);
    expect(client.calls).toBe(2);
    expect(tracker.totalUsd).toBeLessThanOrEqual(LIVE_CAP_USD);
    expect(client.stopped).toMatch(/stopped before a call/);
    // Once stopped, it stays stopped.
    await expect(client.complete(request)).rejects.toBeInstanceOf(LiveCapError);
    expect(inner.calls).toHaveLength(2);
  });

  it("the live scenarios pass with a well-behaved (scripted) model, and stop at the cap", async () => {
    const env = { HERMOD_LIVE: "1", ANTHROPIC_API_KEY: "x" };
    const script = () =>
      new testing.FakeModelClient([
        testing.textMessage("Stockholm."),
        testing.toolUseMessage([{ name: "memory", input: { store: "user", ops: [{ op: "add", text: "User prefers metric units." }] } }]),
        testing.textMessage("I proposed saving that."),
        testing.textMessage("Nothing to save."),
      ]);
    const lines: string[] = [];
    expect(await runLive({ lib, env, log: (l) => lines.push(l), makeClient: script })).toBe(0);
    expect(lines.filter((l) => l.startsWith("PASS"))).toHaveLength(LIVE_SCENARIOS.length);

    // A model whose every call is expensive: the cap stops the run and the rest is not run.
    const pricey = () =>
      new testing.FakeModelClient(Array.from({ length: 10 }, () => testing.textMessage("ok", { usage: { input: 110_000, output: 1_000 } })));
    const capped: string[] = [];
    expect(await runLive({ lib, env, log: (l) => capped.push(l), makeClient: pricey })).toBe(1);
    expect(capped.join("\n")).toMatch(/not run: the cost cap was reached|cost cap/);
    const spent = Number(/\$([0-9.]+) of the \$0\.50 cap/.exec(capped[0] ?? "")?.[1]);
    expect(spent).toBeLessThanOrEqual(LIVE_CAP_USD);
  });

  it("a live scenario that finds memory written without approval fails", async () => {
    const env = { HERMOD_LIVE: "1", ANTHROPIC_API_KEY: "x" };
    const lines: string[] = [];
    const memoryScenario = LIVE_SCENARIOS.find((s) => s.name === "live-memory-proposal");
    if (!memoryScenario) throw new Error("no memory scenario");
    // Same scenario, but the store's owner allowed add-only writes behind its back: the check must notice the write.
    const sneaky = {
      name: "sneaky",
      run: async (l: unknown, client: Parameters<typeof memoryScenario.run>[1], remaining: () => number) => {
        const original = lib.MemoryService.prototype.ensureStores;
        lib.MemoryService.prototype.ensureStores = function (agentId, specs) {
          return original.call(this, agentId, (specs ?? []).map((s) => ({ ...s, autoApply: "add" as const })));
        };
        try {
          return await memoryScenario.run(l, client, remaining);
        } finally {
          lib.MemoryService.prototype.ensureStores = original;
        }
      },
    };
    const makeClient = () =>
      new testing.FakeModelClient([
        testing.toolUseMessage([{ name: "memory", input: { store: "user", ops: [{ op: "add", text: "User prefers metric units." }] } }]),
        testing.textMessage("Saved."),
      ]);
    expect(await runLive({ lib, env, log: (l) => lines.push(l), makeClient, scenarios: [sneaky] })).toBe(1);
    expect(lines.join("\n")).toMatch(/store user was written without approval/);
  });
});
