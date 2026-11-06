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
 * A denied, invalid or failed call is thrown as the SDK's ToolError, so the runner sends it with is_error: true.
 * Note the SDK runner runs a turn's calls concurrently; for ordered side effects use runAgent instead.
 */
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { runToolRound, type ToolEnv } from "../loop/tools.js";
import { createApprovalPolicy } from "../safety/approvals.js";
import { secretsRedactor } from "../safety/redact.js";
import type { ApprovalPolicy, Redactor, ToolContext, ToolDef } from "../types.js";
import { ToolRegistry } from "./registry.js";

export interface RunnerAdapterOptions {
  approvals?: ApprovalPolicy;
  /** Default: secrets only. */
  redactor?: Redactor;
  /** Default 20,000 characters. */
  maxToolOutputChars?: number;
  /** Shared taint state across the tools of one conversation. Default: a fresh one per tool. */
  taint?: { tainted: boolean };
  /** Allow a tool with the capability "messaging" (owner messages only). Default false. */
  allowOwnerMessaging?: boolean;
}

let callCounter = 0;

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
      const env: ToolEnv = {
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        mode: ctx.mode,
        attended: ctx.attended,
        storage: ctx.storage,
        now: ctx.now,
        newId: ctx.newId,
        redactor,
        approvals,
        maxOutputChars,
        isTainted: () => ctx.tainted || taint.tainted,
        markTainted: () => {
          taint.tainted = true;
        },
        actor: `agent:${ctx.agentId}`,
      };
      const signal = runContext?.signal ?? ctx.signal;
      if (signal) env.signal = signal;
      callCounter += 1;
      const id = runContext?.toolUse?.id ?? `runner_${callCounter}`;
      const [outcome] = await runToolRound([{ id, name: tool.name, input }], registry, env);
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
