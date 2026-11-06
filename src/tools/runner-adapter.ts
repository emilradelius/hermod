/**
 * For apps that prefer the SDK's Tool Runner (`client.beta.messages.toolRunner`) over runAgent: turns Hermod tools
 * into the SDK's runnable zod tools WITHOUT giving up Hermod's rules. Every call still goes through the same path as
 * in runAgent (src/loop/tools.ts): zod validation, the approval policy with the hard denylist (allow / propose /
 * deny), proposals in storage, audit entries, redaction, truncation and untrusted wrapping.
 *
 * - `toBetaZodTool(def, ctxFactory, options)` builds one tool with `betaZodTool` from
 *   "@anthropic-ai/sdk/helpers/beta/zod". `ctxFactory()` gives the ToolContext for each call (agent, session, mode,
 *   attended, storage, …).
 * - `toBetaZodTools(registry, ctxFactory, options)` builds all of a registry's tools with one shared taint flag:
 *   once an untrustedOutput tool has returned text, later side effects are decided as tainted.
 * - Taint belongs to the session (src/loop/taint.ts), whatever the local flags: before every call the adapter reads
 *   the session's stored taint (meta.tainted, or an untrusted wrapper in its stored messages), and when a call
 *   returns untrusted text it records it on the session row (markSessionTainted) and in a per-storage, in-process
 *   list of tainted session ids (for a session id without a row). So tools built one at a time with
 *   `toBetaZodTool` share the taint of their session, and taint lasts across runs, as in runAgent. A session whose
 *   taint cannot be read counts as tainted (fail closed).
 * - The agent's mode is the STORED one: before every call the adapter reads the agent row (storage.agents.get), and
 *   the stored mode wins over ctx.mode, as in runAgent. Off set in storage denies every call (read-only ones too),
 *   shadow or supervised set there apply at once, and an agent with no row, or a row that cannot be read, counts as
 *   off (fail closed). The round re-reads the mode before its decisions too (ToolEnv.currentMode).
 * A denied, invalid or failed call is thrown as the SDK's ToolError, so the runner sends it with is_error: true.
 * Note the SDK runner runs a turn's calls concurrently; for ordered side effects use runAgent instead.
 */
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { isSessionTainted, markSessionTainted } from "../loop/taint.js";
import { runToolRound, type ToolEnv } from "../loop/tools.js";
import { createApprovalPolicy } from "../safety/approvals.js";
import { secretsRedactor } from "../safety/redact.js";
import type { AgentMode, ApprovalPolicy, Id, Redactor, Storage, ToolContext, ToolDef } from "../types.js";
import { ToolRegistry } from "./registry.js";

export interface RunnerAdapterOptions {
  approvals?: ApprovalPolicy;
  /** Default: secrets only. */
  redactor?: Redactor;
  /** Default 20,000 characters. */
  maxToolOutputChars?: number;
  /**
   * Shared taint state across the tools of one conversation. Default: a fresh one per tool. Whatever is passed, the
   * session's stored taint is read before and recorded after every call (see above).
   */
  taint?: { tainted: boolean };
  /** Allow a tool with the capability "messaging" (owner messages only). Default false. */
  allowOwnerMessaging?: boolean;
}

let callCounter = 0;

/** Sessions this process has seen tainted, per storage (covers a session id that has no stored row). */
const taintedSessions = new WeakMap<Storage, Set<Id>>();

function seenTainted(storage: Storage, sessionId: Id): boolean {
  return taintedSessions.get(storage)?.has(sessionId) === true;
}

function rememberTainted(storage: Storage, sessionId: Id): void {
  let set = taintedSessions.get(storage);
  if (!set) {
    set = new Set();
    taintedSessions.set(storage, set);
  }
  set.add(sessionId);
}

/** The agent's stored mode; null when the row is gone or cannot be read (the caller treats that as off). */
async function storedMode(storage: Storage, agentId: Id): Promise<AgentMode | null> {
  try {
    return (await storage.agents.get(agentId))?.mode ?? null;
  } catch {
    return null;
  }
}

/** The session's stored taint (row flag or an untrusted wrapper in its messages); true when it cannot be read. */
async function storedTaint(storage: Storage, sessionId: Id): Promise<boolean> {
  if (seenTainted(storage, sessionId)) return true;
  try {
    const session = await storage.sessions.get(sessionId);
    if (!session) return false;
    return isSessionTainted(session, await storage.messages.list(sessionId));
  } catch {
    return true;
  }
}

export function toBetaZodTool(
  def: ToolDef,
  ctxFactory: () => ToolContext | Promise<ToolContext>,
  options: RunnerAdapterOptions = {},
): BetaRunnableTool<unknown> {
  // Registering checks the tool (name, schema, capabilities; messaging refused unless allowed).
  const registry = new ToolRegistry([{ name: "adapter", tools: [def] }], { allowOwnerMessaging: options.allowOwnerMessaging === true });
  const tool = registry.get(def.name) as ToolDef;
  const approvals = options.approvals ?? createApprovalPolicy();
  const redactor = options.redactor ?? secretsRedactor;
  const maxOutputChars = options.maxToolOutputChars ?? 20_000;
  const taint = options.taint ?? { tainted: false };
  return betaZodTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input,
    eager_input_streaming: true,
    async run(input, runContext) {
      const ctx = await ctxFactory();
      const sessionTainted = await storedTaint(ctx.storage, ctx.sessionId);
      // The stored mode wins over ctx.mode; no readable agent row counts as off, so the policy denies the call.
      const mode = (await storedMode(ctx.storage, ctx.agentId)) ?? "off";
      let record: Promise<unknown> | null = null;
      const env: ToolEnv = {
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        mode,
        attended: ctx.attended,
        storage: ctx.storage,
        now: ctx.now,
        newId: ctx.newId,
        redactor,
        approvals,
        maxOutputChars,
        isTainted: () => ctx.tainted !== false || taint.tainted || sessionTainted || seenTainted(ctx.storage, ctx.sessionId),
        markTainted: () => {
          taint.tainted = true;
          rememberTainted(ctx.storage, ctx.sessionId);
          // Recorded on the session row too, so later runs and every other tool of the session start tainted.
          record ??= markSessionTainted(ctx.storage, ctx.sessionId, ctx.now()).catch(() => false);
        },
        actor: `agent:${ctx.agentId}`,
        // Re-read before the round's decisions: off (or a missing agent) denies, shadow applies at once.
        currentMode: () => storedMode(ctx.storage, ctx.agentId),
      };
      const signal = runContext?.signal ?? ctx.signal;
      if (signal) env.signal = signal;
      callCounter += 1;
      const id = runContext?.toolUse?.id ?? `runner_${callCounter}`;
      let outcome: Awaited<ReturnType<typeof runToolRound>>[number] | undefined;
      try {
        [outcome] = await runToolRound([{ id, name: tool.name, input }], registry, env);
      } finally {
        if (record) await record;
      }
      const content = outcome?.result.content;
      const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
      if (!outcome || outcome.result.is_error === true) throw new ToolError(text);
      return text;
    },
  }) as BetaRunnableTool<unknown>;
}

/** All of a registry's tools for the SDK Tool Runner, sharing one taint flag. */
export function toBetaZodTools(
  registry: ToolRegistry,
  ctxFactory: () => ToolContext | Promise<ToolContext>,
  options: RunnerAdapterOptions = {},
): BetaRunnableTool<unknown>[] {
  const shared = { ...options, taint: options.taint ?? { tainted: false }, allowOwnerMessaging: registry.allowOwnerMessaging };
  return registry.list().map((tool) => toBetaZodTool(tool, ctxFactory, shared));
}
