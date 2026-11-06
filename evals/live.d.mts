/** Types for evals/live.mjs. */
import type { ModelClient, ModelRequest, Message, StreamCallbacks } from "../src/types.js";

export declare const LIVE_CAP_USD: number;
export declare const LIVE_MAX_TOKENS: number;

export declare class LiveCapError extends Error {}

export declare class CappedModelClient implements ModelClient {
  constructor(options: { inner: ModelClient; tracker: unknown; lib: unknown });
  calls: number;
  stopped: string | null;
  estimate(request: ModelRequest): number;
  complete(request: ModelRequest, callbacks?: StreamCallbacks): Promise<Message>;
}

export declare function liveGate(env: Record<string, string | undefined>): string | null;

export interface LiveScenario {
  name: string;
  run(lib: unknown, client: ModelClient, remainingUsd: () => number): Promise<{ failures: string[]; summary: string }>;
}

export declare const LIVE_SCENARIOS: LiveScenario[];

export declare function runLive(options: {
  lib: unknown;
  testing?: unknown;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  makeClient?: () => ModelClient;
  scenarios?: LiveScenario[];
}): Promise<number>;
