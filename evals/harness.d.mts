/** Types for evals/harness.mjs (plain JavaScript, so `npm run eval` needs no TypeScript). */
export declare const AGENT_ID: string;
export declare const OWNER: string;

/** A scenario fixture (evals/fixtures/*.json); the format is documented in evals/README.md. */
export interface Fixture {
  name: string;
  about: string;
  storage?: "memory" | "sqlite";
  agent?: { mode?: "off" | "shadow" | "supervised" | "autonomous" };
  config?: Record<string, unknown> & { toolsets?: Array<"knowledge" | "notes"> };
  seed?: Record<string, unknown>;
  run: Record<string, unknown> & { type: "chat" | "job" | "review" };
  steps: Array<Record<string, unknown>>;
  expect: Record<string, unknown>;
}

export interface ScenarioResult {
  name: string;
  ok: boolean;
  failures: string[];
  summary: string;
}

export interface HarnessOptions {
  /** The public API ("hermod"): the built dist/index.js, or src/index.ts in tests. */
  lib: unknown;
  /** "hermod/testing". */
  testing: unknown;
  /** Opens a fresh better-sqlite3 database, for fixtures with "storage": "sqlite". */
  openSqlite?: () => unknown | Promise<unknown>;
}

export declare function validateFixture(fixture: unknown): string[];
export declare function runScenario(fixture: Fixture, options: HarnessOptions): Promise<ScenarioResult>;
export declare function runEval(fixtures: Fixture[], options: HarnessOptions): Promise<ScenarioResult[]>;
export declare function formatTable(results: ScenarioResult[]): string;
