/**
 * The runJob function the Scheduler expects, built on runAgent.
 *
 * Every run of a job:
 * - starts a FRESH session (kind "job", attended false): no history, a new frozen memory snapshot;
 * - attaches the job's skills (full bodies in the system prompt) on top of the config's attachSkills;
 * - gets the agent's registry WITHOUT scheduling, delegation and messaging tools;
 * - decides approvals as unattended, whatever the config's policy is told: nobody can approve now, so an
 *   autonomous call that needs approval is denied, while shadow and supervised side effects become proposals;
 * - gets the pre-step's text (if any) as context and the lease's abort signal.
 * A run that does not end with "end_turn" throws, so the scheduler records an error and delivers nothing.
 */
import { createApprovalPolicy } from "../safety/approvals.js";
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
  const { configFor, onResult, ...deps } = options;
  if (typeof configFor !== "function") throw new TypeError("makeJobRunner needs configFor(job) → AgentConfig.");
  if (!deps.storage || typeof deps.model?.complete !== "function") throw new TypeError("makeJobRunner needs { storage, model }.");
  return async (job: JobRecord, ctx: JobRunContext): Promise<{ text: string }> => {
    const base = await configFor(job);
    if (!base || base.agentId !== job.agentId) {
      throw new Error(`makeJobRunner: configFor(job) must return the config of agent "${job.agentId}".`);
    }
    const registry = new ToolRegistry(base.toolsets ?? [], { allowOwnerMessaging: deps.allowOwnerMessaging === true });
    const config: AgentConfig = {
      ...base,
      toolsets: registry.without(JOB_EXCLUDED_CAPABILITIES).toolsets(),
      attachSkills: [...new Set([...(base.attachSkills ?? []), ...(job.skills ?? [])])],
      approvals: unattendedPolicy(base.approvals ?? createApprovalPolicy()),
    };
    const input: RunInput = { kind: "job", attended: false, userMessage: job.prompt, signal: ctx.signal };
    if (ctx.context !== undefined) input.context = ctx.context;
    const result = await runAgentWith(config, input, { ...deps, now: deps.now ?? (() => new Date()) }, { actor: `job:${job.id}` });
    onResult?.(job, result);
    if (result.end !== "end_turn") {
      const why = result.errors.at(-1)?.message;
      throw new Error(`The job's run ended with "${result.end}"${why ? `: ${why}` : ""}.`);
    }
    return { text: result.text };
  };
}
