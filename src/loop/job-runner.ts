/**
 * The runJob function the Scheduler expects, built on runAgent.
 *
 * Every run of a job:
 * - starts a FRESH session (kind "job", attended false): no history, a new frozen memory snapshot;
 * - attaches the job's skills (full bodies in the system prompt) on top of the config's attachSkills;
 * - gets the agent's registry WITHOUT scheduling, delegation and messaging tools;
 * - decides approvals as unattended, whatever the config's policy is told: nobody can approve now, so an
 *   autonomous call that needs approval is denied, while shadow and supervised side effects become proposals;
 * - gets the pre-step's text (if any) as context and the lease's abort signal. Fail closed (stricter since the
 *   hardening pass): the pre-step's text is OUTSIDE text by default (an inbox check, a fetched page), wrapped with
 *   wrapUntrusted (source "pre-step:<job name>"), so the run starts tainted: side effects in an unattended run are
 *   denied and an add-only memory store takes no direct add. An app whose pre-steps produce only its own data opts
 *   out with `trustPreStepOutput: true`.
 * A run that does not end with "end_turn" throws, so the scheduler records an error and delivers nothing.
 */
import { createApprovalPolicy } from "../safety/approvals.js";
import { createNonce, wrapUntrusted } from "../safety/untrusted.js";
import { ToolRegistry } from "../tools/registry.js";
import type { AgentConfig, ApprovalPolicy, JobRecord, RunInput, RunResult, ToolCapability } from "../types.js";
import { runAgentWith, type LoopDeps } from "./agent.js";
import type { KnowledgeSource } from "./knowledge.js";
import type { JobRunContext, JobRunner } from "../scheduler/scheduler.js";

export const JOB_EXCLUDED_CAPABILITIES: readonly ToolCapability[] = Object.freeze(["scheduling", "delegation", "messaging"]);

export interface JobRunnerOptions extends Omit<LoopDeps, "knowledge"> {
  /** The agent configuration for a job (its agentId must be the job's agentId). */
  configFor(job: JobRecord): AgentConfig | Promise<AgentConfig>;
  knowledge?: KnowledgeSource;
  /** Called after every run (for logs or tests). */
  onResult?(job: JobRecord, result: RunResult): void;
  /**
   * The pre-steps produce only the app's own data (counts, dates, ids), never outside text: their output is passed
   * as trusted context and does not taint the run. Default false: pre-step output is wrapped as untrusted.
   */
  trustPreStepOutput?: boolean;
}

/** A policy that always decides as if nobody were there (deny-by-default for approvals). */
export function unattendedPolicy(inner: ApprovalPolicy): ApprovalPolicy {
  return Object.freeze({
    decide(ctx: Parameters<ApprovalPolicy["decide"]>[0]) {
      return inner.decide({ ...ctx, attended: false });
    },
  });
}

export function makeJobRunner(options: JobRunnerOptions): JobRunner {
  const { configFor, onResult, trustPreStepOutput, ...deps } = options;
  if (typeof configFor !== "function") throw new TypeError("makeJobRunner needs configFor(job) → AgentConfig.");
  if (!deps.storage || typeof deps.model?.complete !== "function") throw new TypeError("makeJobRunner needs { storage, model }.");
  return async (job: JobRecord, ctx: JobRunContext): Promise<{ text: string }> => {
    const base = await configFor(job);
    if (!base || base.agentId !== job.agentId) {
      throw new Error(`makeJobRunner: configFor(job) must return the config of agent "${job.agentId}".`);
    }
    const registry = new ToolRegistry(base.toolsets ?? []);
    const config: AgentConfig = {
      ...base,
      toolsets: registry.without(JOB_EXCLUDED_CAPABILITIES).toolsets(),
      attachSkills: [...new Set([...(base.attachSkills ?? []), ...(job.skills ?? [])])],
      approvals: unattendedPolicy(base.approvals ?? createApprovalPolicy()),
    };
    const input: RunInput = { kind: "job", attended: false, userMessage: job.prompt, signal: ctx.signal };
    if (ctx.context !== undefined && ctx.context !== "") {
      // Wrapped here with the job's name as the source; the loop must not wrap it a second time.
      input.context = trustPreStepOutput === true
        ? ctx.context
        : wrapUntrusted(ctx.context, { source: `pre-step:${job.name}`, nonce: createNonce() });
      input.contextTrusted = true;
    }
    const result = await runAgentWith(config, input, { ...deps, now: deps.now ?? (() => new Date()) }, { actor: `job:${job.id}` });
    onResult?.(job, result);
    if (result.end !== "end_turn") {
      const why = result.errors.at(-1)?.message;
      throw new Error(`The job's run ended with "${result.end}"${why ? `: ${why}` : ""}.`);
    }
    return { text: result.text };
  };
}
