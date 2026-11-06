/**
 * Live evals: a SMALL subset against the real Anthropic API. Opt-in only; it never runs in CI.
 *
 * - Runs only when HERMOD_LIVE=1 and ANTHROPIC_API_KEY are both set and CI is not set; otherwise it prints how to
 *   enable it and returns 0 without making a client.
 * - Every model call goes through CappedModelClient: before a call it estimates the most that call can cost (the
 *   whole prompt written to the cache, every output token generated, twice over when the model has a server-side
 *   refusal fallback) and refuses to send it if the run's CostTracker would go over LIVE_CAP_USD. After the call it
 *   records the real usage. So the run as a whole stops before any call that could take it past USD 0.50.
 * - The checks are loose (models vary): an answer arrives, cost is recorded, and nothing is ever written to memory
 *   or skills without approval (proposals only).
 */
import { AGENT_ID } from "./harness.mjs";

/** The hard cap for one live run, in US dollars. */
export const LIVE_CAP_USD = 0.5;
/** Output tokens per main-model call in live runs (small on purpose). */
export const LIVE_MAX_TOKENS = 2048;

export class LiveCapError extends Error {
  constructor(message) {
    super(message);
    this.name = "LiveCapError";
  }
}

/** Characters per token, on the low side, so the prompt estimate errs high. */
const CHARS_PER_TOKEN = 3;

/** A ModelClient that refuses any call that could take the tracker past its cap, and records what each call cost. */
export class CappedModelClient {
  constructor({ inner, tracker, lib }) {
    this.inner = inner;
    this.tracker = tracker;
    this.lib = lib;
    this.calls = 0;
    this.stopped = null;
  }

  /** The most this request can cost (USD). */
  estimate(request) {
    const promptChars = JSON.stringify({ system: request.system, tools: request.tools ?? [], messages: request.messages }).length;
    const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
    const one = this.lib.estimateMaxCost(request.model, promptTokens, request.maxTokens);
    // A server-side refusal fallback can bill a second attempt on another model; count it as a second attempt.
    const fallback = request.refusalFallback !== false && this.lib.supportsServerFallback(request.model);
    return fallback ? one * 2 : one;
  }

  async complete(request, callbacks) {
    const estimate = this.estimate(request);
    if (this.tracker.wouldExceed(estimate)) {
      this.stopped = `stopped before a call that could cost up to $${estimate.toFixed(4)} ` +
        `($${this.tracker.totalUsd.toFixed(4)} of the $${this.tracker.capUsd.toFixed(2)} cap spent)`;
      throw new LiveCapError(`Live eval cost cap: ${this.stopped}.`);
    }
    this.calls += 1;
    const message = await this.inner.complete(request, callbacks);
    this.tracker.add(request.model, message.usage);
    return message;
  }
}

const HOW_TO = [
  "Live evals are off. They call the real Anthropic API and cost money (at most USD 0.50 per run).",
  "To run them on your own machine (never in CI):",
  "  HERMOD_LIVE=1 ANTHROPIC_API_KEY=<your key> npm run eval:live",
].join("\n");

/** Decides whether a live run may start. Returns null when it may, or the reason it may not. */
export function liveGate(env) {
  const ci = env.CI;
  if (ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false") return "Live evals never run in CI (CI is set).";
  if (env.HERMOD_LIVE !== "1" || !env.ANTHROPIC_API_KEY) return HOW_TO;
  return null;
}

async function setupWorld(lib, stores) {
  const storage = lib.createMemoryStorage();
  await storage.migrate();
  await storage.agents.upsert({ id: AGENT_ID, name: "Live eval agent", mode: "autonomous" });
  const memory = new lib.MemoryService({ storage });
  const skills = new lib.SkillService({ storage });
  const proposals = new lib.ProposalService({ storage, memory, skills });
  await memory.ensureStores(AGENT_ID, stores);
  return { storage, memory, skills, proposals };
}

async function costFacts(storage) {
  const rows = await storage.costs.list({ agentId: AGENT_ID });
  return { rows: rows.length, usd: rows.reduce((sum, row) => sum + row.costUsd, 0) };
}

async function knowledgeIsUntouched(w, failures) {
  for (const store of await w.storage.memory.listStores(AGENT_ID)) {
    if (store.content !== "") failures.push(`store ${store.name} was written without approval`);
  }
  if ((await w.storage.skills.list(AGENT_ID)).length > 0) failures.push("a skill was created without approval");
  const notPending = (await w.storage.proposals.list({ agentId: AGENT_ID })).filter((p) => p.status !== "pending");
  if (notPending.length > 0) failures.push(`${notPending.length} proposal(s) are not pending`);
}

/** The live subset. Each returns a list of failures (empty = pass) and a one-line summary. */
export const LIVE_SCENARIOS = [
  {
    name: "live-plain-answer",
    async run(lib, client, remainingUsd) {
      const w = await setupWorld(lib);
      const result = await lib.runAgent(
        {
          agentId: AGENT_ID,
          systemPrompt: "You are a terse assistant. Answer in one short sentence.",
          effort: "low",
          maxTokens: LIVE_MAX_TOKENS,
          budget: { maxIterations: 2, maxCostUsd: Math.min(0.15, remainingUsd()) },
        },
        { userMessage: "What is the capital of Sweden?" },
        { storage: w.storage, model: client },
      );
      const failures = [];
      if (result.end !== "end_turn") failures.push(`end: ${result.end}`);
      if (result.text.trim() === "") failures.push("no answer text");
      const cost = await costFacts(w.storage);
      if (cost.rows === 0 || !(cost.usd > 0)) failures.push("no cost recorded");
      await knowledgeIsUntouched(w, failures);
      return { failures, summary: `${result.end}; $${cost.usd.toFixed(4)}; ${JSON.stringify(result.text.slice(0, 60))}` };
    },
  },
  {
    name: "live-memory-proposal",
    async run(lib, client, remainingUsd) {
      const w = await setupWorld(lib, [{ name: "user", capChars: 1375, autoApply: "none" }]);
      const result = await lib.runAgent(
        {
          agentId: AGENT_ID,
          systemPrompt: "You help the user. Save lasting preferences with the memory tool.",
          effort: "low",
          maxTokens: LIVE_MAX_TOKENS,
          toolsets: [lib.knowledgeToolset(w)],
          memoryStores: ["user"],
          budget: { maxIterations: 4, maxCostUsd: Math.min(0.2, remainingUsd()) },
        },
        { userMessage: "Please remember for future sessions: I prefer metric units." },
        { storage: w.storage, model: client, knowledge: lib.knowledgeDeps(w) },
      );
      const failures = [];
      if (result.end !== "end_turn") failures.push(`end: ${result.end}`);
      const cost = await costFacts(w.storage);
      if (cost.rows === 0 || !(cost.usd > 0)) failures.push("no cost recorded");
      await knowledgeIsUntouched(w, failures);
      const proposed = (await w.storage.proposals.list({ agentId: AGENT_ID })).length;
      return { failures, summary: `${result.end}; ${proposed} proposal(s); $${cost.usd.toFixed(4)}` };
    },
  },
  {
    name: "live-review",
    async run(lib, client, remainingUsd) {
      const w = await setupWorld(lib, [{ name: "user", capChars: 1375, autoApply: "none" }]);
      const session = await w.storage.sessions.create({ agentId: AGENT_ID, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
      const said = "Please convert 5 miles. I always want metric units in answers.";
      await w.storage.messages.append(session.id, { role: "user", content: [{ type: "text", text: said }], text: said });
      const reply = "5 miles is about 8 kilometres.";
      await w.storage.messages.append(session.id, { role: "assistant", content: [{ type: "text", text: reply }], text: reply });
      await w.storage.sessions.update(session.id, { status: "done" });
      const outcome = await lib.reviewSession(
        session.id,
        { storage: w.storage, model: client, memory: w.memory, skills: w.skills, proposals: w.proposals },
        { maxIterations: 6, maxCostUsd: Math.min(0.05, remainingUsd()) },
      );
      const failures = [];
      if (outcome.end !== "end_turn") failures.push(`end: ${outcome.end}`);
      const cost = await costFacts(w.storage);
      if (cost.rows === 0 || !(cost.usd > 0)) failures.push("no cost recorded");
      await knowledgeIsUntouched(w, failures);
      const notByReview = (await w.storage.proposals.list({ agentId: AGENT_ID })).filter((p) => p.createdBy !== "review");
      if (notByReview.length > 0) failures.push("a review proposal is not attributed to the review");
      return {
        failures,
        summary: `${outcome.end}; ${outcome.proposals.length} proposal(s), ${outcome.refused.length} refused; $${cost.usd.toFixed(4)}`,
      };
    },
  },
];

/**
 * Runs the live subset. Returns the process exit code (0 when it may not start, or when every scenario passed).
 * `makeClient` is for tests; by default it is the real AnthropicModelClient (the key comes from the environment).
 */
export async function runLive({ lib, env, log, makeClient, scenarios = LIVE_SCENARIOS }) {
  const blocked = liveGate(env);
  if (blocked !== null) {
    log(blocked);
    return 0;
  }
  const tracker = new lib.CostTracker({ capUsd: LIVE_CAP_USD });
  const inner = makeClient ? makeClient() : new lib.AnthropicModelClient({ maxRetries: 1 });
  const client = new CappedModelClient({ inner, tracker, lib });
  const remainingUsd = () => tracker.remainingUsd;
  const rows = [];
  for (const scenario of scenarios) {
    if (client.stopped) {
      rows.push({ name: scenario.name, ok: false, failures: ["not run: the cost cap was reached"], summary: "" });
      continue;
    }
    try {
      const { failures, summary } = await scenario.run(lib, client, remainingUsd);
      if (client.stopped) failures.push(`cost cap: ${client.stopped}`);
      rows.push({ name: scenario.name, ok: failures.length === 0, failures, summary });
    } catch (error) {
      rows.push({ name: scenario.name, ok: false, failures: [`${error?.name ?? "Error"}: ${error?.message ?? error}`], summary: "" });
    }
  }
  log(`Hermod live evals — ${client.calls} API call(s), $${tracker.totalUsd.toFixed(4)} of the $${LIVE_CAP_USD.toFixed(2)} cap\n`);
  for (const row of rows) {
    log(`${row.ok ? "PASS" : "FAIL"}  ${row.name}  ${row.summary}`);
    for (const failure of row.failures) log(`      - ${failure}`);
  }
  return rows.every((row) => row.ok) ? 0 : 1;
}
