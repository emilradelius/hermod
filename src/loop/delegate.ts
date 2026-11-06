/**
 * The delegate tool: runs a sub-agent on one task and returns only its final text.
 *
 * The child (built by runAgent through ToolContext.runChild):
 * - gets a FRESH session (kind "delegate", parentId = the parent's session) with its own frozen snapshot;
 * - gets the parent's registry WITHOUT memory.write, skills.write, messaging, scheduling and delegation (so it can
 *   never write knowledge, message anyone, schedule anything or delegate further);
 * - gets a slice of what is left of the parent's USD budget (default half), counted against the parent too;
 * - inherits the parent's mode, attended flag and taint (a tainted parent cannot launder a task through a child);
 * - returns only its final text, cut to 4,000 characters. If the child read untrusted text, the parent becomes
 *   tainted and the text comes back wrapped as untrusted. The text is cut once, before it is wrapped; the tool never
 *   cuts a wrapped result again (that could drop the closing tag). A wrapped result longer than the cut plus room
 *   for the wrapper is cut and wrapped once more, so it always ends with its closing tag and stays untrusted.
 * The delegate tool itself has the capability "delegation" (a side effect for the approval policy).
 */
import { z } from "zod";
import { createNonce, wrapUntrusted } from "../safety/untrusted.js";
import type { Effort, ToolCapability, ToolDef } from "../types.js";
import { containsUntrustedWrapper } from "./taint.js";
import { truncate } from "./tools.js";

export const DELEGATE_SETTINGS: unique symbol = Symbol.for("hermod.delegate.settings");
export const DELEGATE_EXCLUDED_CAPABILITIES: readonly ToolCapability[] = Object.freeze([
  "memory.write",
  "skills.write",
  "messaging",
  "scheduling",
  "delegation",
]);
export const DELEGATE_RESULT_CHARS = 4_000;
/** Room for the untrusted wrapper (tags, source, nonce) and the truncation note around a cut result. */
export const DELEGATE_WRAPPER_ROOM = 256;
export const DEFAULT_DELEGATE_SHARE = 0.5;
export const DEFAULT_DELEGATE_ITERATIONS = 10;

export interface DelegateSettings {
  /** The child's instructions. Default: the parent's systemPrompt. */
  systemPrompt?: string;
  /** Default: the parent's model. */
  model?: string;
  /** Default: the parent's effort. */
  effort?: Effort;
  /** Model calls the child may make. Default 10. */
  maxIterations?: number;
  /** Share (0..1] of the parent's remaining USD the child may spend. Default 0.5. */
  shareOfRemaining?: number;
}

export interface DelegateOptions extends DelegateSettings {
  /** Tool name. Default "delegate". */
  name?: string;
  description?: string;
}

const DelegateInput = z.object({
  task: z
    .string()
    .min(1)
    .max(20_000)
    .describe("The complete task for the sub-agent: what to find out or do, and what to report back."),
  toolsets: z
    .array(z.string().min(1).max(64))
    .max(20)
    .optional()
    .describe("Limit the sub-agent to these toolsets (default: every toolset it is allowed)."),
});

type DelegateTool = ToolDef<typeof DelegateInput> & { [DELEGATE_SETTINGS]: DelegateSettings };

export function makeDelegateTool(options: DelegateOptions = {}): ToolDef<typeof DelegateInput> {
  const share = options.shareOfRemaining ?? DEFAULT_DELEGATE_SHARE;
  if (typeof share !== "number" || !(share > 0) || share > 1) {
    throw new RangeError(`makeDelegateTool: shareOfRemaining must be a number in (0, 1] (got ${String(share)}).`);
  }
  const iterations = options.maxIterations ?? DEFAULT_DELEGATE_ITERATIONS;
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new RangeError(`makeDelegateTool: maxIterations must be a whole number, 1 or more (got ${String(iterations)}).`);
  }
  const settings: DelegateSettings = { shareOfRemaining: share, maxIterations: iterations };
  if (options.systemPrompt !== undefined) settings.systemPrompt = options.systemPrompt;
  if (options.model !== undefined) settings.model = options.model;
  if (options.effort !== undefined) settings.effort = options.effort;
  const tool: DelegateTool = {
    name: options.name ?? "delegate",
    description:
      options.description ??
      "Hand one self-contained task to a sub-agent and get back only its final report. Use it for research or " +
        "reading that would fill this conversation; the sub-agent cannot change memory or skills, message anyone, " +
        "schedule jobs or delegate further.",
    input: DelegateInput,
    readOnly: false,
    capabilities: ["delegation"],
    async run(input, ctx) {
      if (typeof ctx.runChild !== "function") {
        throw new Error("Delegation is not available in this run (no runChild in the tool context).");
      }
      const text = await ctx.runChild(input.task, input.toolsets ? { toolsets: input.toolsets } : {});
      return limitResult(text);
    },
    [DELEGATE_SETTINGS]: Object.freeze(settings),
  };
  Object.defineProperty(tool, DELEGATE_SETTINGS, { enumerable: false });
  return tool;
}

/**
 * The delegate's result, at most DELEGATE_RESULT_CHARS plus room for the wrapper. Plain text is cut. Text that holds
 * an untrusted wrapper was cut before it was wrapped (runChild does that); it is kept whole when it fits, and
 * otherwise cut and wrapped again, so the closing tag is never cut off and the text stays untrusted.
 */
export function limitResult(text: string): string {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (!containsUntrustedWrapper(value)) return truncate(value, DELEGATE_RESULT_CHARS);
  if (value.length <= DELEGATE_RESULT_CHARS + DELEGATE_WRAPPER_ROOM) return value;
  return wrapUntrusted(truncate(value, DELEGATE_RESULT_CHARS), { source: "delegate", nonce: createNonce() });
}

/** The settings a delegate tool was made with (defaults for any other delegation tool). */
export function delegateSettingsOf(tool: ToolDef): DelegateSettings {
  const value = (tool as Partial<DelegateTool>)[DELEGATE_SETTINGS];
  return value && typeof value === "object" ? value : { shareOfRemaining: DEFAULT_DELEGATE_SHARE, maxIterations: DEFAULT_DELEGATE_ITERATIONS };
}
