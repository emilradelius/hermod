#!/usr/bin/env node
/**
 * Hermod's evals: `npm run eval` (offline, free, used by CI) and `npm run eval:live` (opt-in, real API, capped).
 *
 * Imports the BUILT library (../dist), so run `npm run build` first (both npm scripts do). Offline mode checks the
 * public exports of both entry points, then runs every fixture in evals/fixtures/*.json with the scripted fake
 * model, prints a table and exits 1 on any failure.
 *
 * Live mode (--live) runs a small subset against the real API, only when HERMOD_LIVE=1 and ANTHROPIC_API_KEY are both
 * set and CI is not; otherwise it says how to enable it and exits 0. Every call goes through a hard USD 0.50 cap.
 *
 * Options: --live, --only <name> (run one fixture), --list.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatTable, runEval } from "./harness.mjs";
import { runLive } from "./live.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

async function loadLibrary() {
  try {
    return {
      lib: await import(new URL("../dist/index.js", import.meta.url).href),
      testing: await import(new URL("../dist/testing/index.js", import.meta.url).href),
    };
  } catch (error) {
    console.error(`Could not import the built library (${error?.message ?? error}). Run "npm run build" first.`);
    process.exit(1);
  }
}

/** Names that must be importable from each entry point (a smoke test of the build and of src/index.ts). */
const REQUIRED_EXPORTS = {
  lib: [
    "VERSION", "MEMORY_SEPARATOR", "AgentOffError",
    "createMemoryStorage", "createSqliteStorage", "createPostgresStorage",
    "secretsRedactor", "piiRedactor", "wrapUntrusted", "scanForInjection", "createApprovalPolicy", "defaultDenylist",
    "AnthropicModelClient", "DEFAULTS", "MODELS", "PRICING", "costOf", "CostTracker", "classifyError", "backoff",
    "defineTool", "ToolRegistry", "knowledgeToolset",
    "runAgent", "makeDelegateTool", "makeJobRunner", "compressConversation",
    "MemoryService", "DEFAULT_MEMORY_STORES", "DEFAULT_SNAPSHOT_STORES", "SkillService", "ProposalService", "verifyEvidence",
    "reviewSession", "shouldReview", "curate",
    "getMode", "setMode", "scoreDraft", "shadowStats", "meetsBar",
    "Scheduler", "scheduleJob", "nextRun", "SILENT",
    "ChannelRegistry", "InAppChannel", "WebPushChannel", "TelegramChannel",
  ],
  testing: ["FakeModelClient", "textMessage", "toolUseMessage", "refusalMessage", "apiError", "connectionError", "fakeUsage"],
};

async function checkExports(lib, testing) {
  const failures = [];
  for (const [where, mod] of [["lib", lib], ["testing", testing]]) {
    for (const name of REQUIRED_EXPORTS[where]) {
      if (mod[name] === undefined) failures.push(`${where === "lib" ? "hermod" : "hermod/testing"} does not export ${name}`);
    }
  }
  const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));
  if (lib.VERSION !== pkg.version) failures.push(`VERSION is ${lib.VERSION}, package.json says ${pkg.version}`);
  if (Array.isArray(lib.DEFAULT_MEMORY_STORES) && typeof lib.DEFAULT_MEMORY_STORES[0] !== "object") {
    failures.push("DEFAULT_MEMORY_STORES should be the memory block's store specs (objects with caps)");
  }
  if (lib.FakeModelClient !== undefined) failures.push("the fake model leaks into the main entry point");
  const count = Object.keys(lib).length;
  return { name: "exports", ok: failures.length === 0, failures, summary: `${count} names from hermod, ${Object.keys(testing).length} from hermod/testing` };
}

async function loadFixtures() {
  const dir = join(here, "fixtures");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  const fixtures = [];
  for (const file of files) {
    try {
      fixtures.push(JSON.parse(await readFile(join(dir, file), "utf8")));
    } catch (error) {
      fixtures.push({ name: file, broken: `cannot parse ${file}: ${error.message}` });
    }
  }
  const names = new Set();
  for (const fixture of fixtures) {
    if (names.has(fixture.name)) fixture.broken = `duplicate fixture name ${fixture.name}`;
    names.add(fixture.name);
  }
  return fixtures;
}

async function openSqlite() {
  const { default: Database } = await import("better-sqlite3");
  return new Database(":memory:");
}

async function main() {
  const { lib, testing } = await loadLibrary();
  if (args.includes("--live")) {
    process.exit(await runLive({ lib, testing, env: process.env, log: (line) => console.log(line) }));
  }
  let fixtures = await loadFixtures();
  if (args.includes("--list")) {
    for (const fixture of fixtures) console.log(`${fixture.name}: ${fixture.about ?? ""}`);
    return;
  }
  const only = args.indexOf("--only");
  if (only !== -1) {
    const name = args[only + 1];
    fixtures = fixtures.filter((fixture) => fixture.name === name);
    if (fixtures.length === 0) {
      console.error(`No fixture named ${JSON.stringify(name)}.`);
      process.exit(1);
    }
  }
  const results = [await checkExports(lib, testing)];
  const runnable = [];
  for (const fixture of fixtures) {
    if (fixture.broken) results.push({ name: fixture.name, ok: false, failures: [fixture.broken], summary: "" });
    else runnable.push(fixture);
  }
  results.push(...(await runEval(runnable, { lib, testing, openSqlite })));
  console.log(`Hermod evals (offline, scripted model) — hermod ${lib.VERSION}\n`);
  console.log(formatTable(results));
  if (results.some((result) => !result.ok)) process.exit(1);
}

await main();
