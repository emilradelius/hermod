/**
 * The approval policy: decides for every tool call whether it runs ("allow"), becomes a proposal a person approves
 * ("propose"), or is refused ("deny").
 *
 * Order (first match wins):
 * 1. The hard denylist matches → deny, in every mode.
 * 2. Mode "off" (or an unknown mode) → deny: nothing runs.
 * 3. A read-only tool → allow, in every mode including shadow, tainted or not. A read-only tool that is marked
 *    requiresApproval is treated like a side effect below: "always needs a person's approval" wins over read-only.
 * 4. A side effect:
 *    - shadow → propose (a draft that is never run);
 *    - supervised → propose;
 *    - autonomous → allow, unless the session is tainted or the tool requires approval: then propose.
 * 5. Unattended runs (scheduled jobs): a proposal is a queued draft that waits for nobody, so shadow and supervised
 *    side effects are proposed in unattended runs too (a scheduled shadow agent leaves drafts to score). What an
 *    unattended run never gets is an approval it would need right now: an autonomous call that needs approval, or
 *    one made after untrusted text, is denied (deny by default). The caller records denials in the audit log.
 *
 * A tool is read-only only when it says so AND has no capability other than "read"; a tool that claims to be
 * read-only but declares a write, messaging, scheduling or delegation capability is treated as a side effect.
 */
import type { ApprovalContext, ApprovalDecision, ApprovalPolicy, ToolDef } from "../types.js";
import { defaultDenylist, type DenyResult, type Denylist } from "./denylist.js";

export interface ApprovalPolicyOptions {
  /** An app's denylist (from createDenylist). The built-in patterns are always checked too, whatever is passed. */
  denylist?: Denylist;
}

export interface Decision {
  decision: ApprovalDecision;
  reason: string;
}

const MODES = new Set(["off", "shadow", "supervised", "autonomous"]);

function toolName(tool: ToolDef | undefined): string {
  return typeof tool?.name === "string" && tool.name !== "" ? tool.name : "(unnamed tool)";
}

function isReadOnly(tool: ToolDef): boolean {
  const caps = Array.isArray(tool.capabilities) ? tool.capabilities : [];
  return tool.readOnly === true && caps.every((c) => c === "read");
}

/** A side effect that becomes a draft: proposed in attended and unattended runs alike (a proposal waits for nobody). */
function propose(name: string, why: string): Decision {
  return { decision: "propose", reason: `"${name}" ${why}, so it becomes a proposal a person approves.` };
}

/** An autonomous side effect that needs a person's approval: proposed when someone is there, denied otherwise. */
function proposeOrDeny(attended: boolean, name: string, why: string): Decision {
  if (attended) return { decision: "propose", reason: `"${name}" ${why}, so it becomes a proposal a person approves.` };
  return {
    decision: "deny",
    reason: `"${name}" ${why}, and this run is unattended (nobody can approve it now), so it is denied.`,
  };
}

function checkDenylists(denylists: readonly Denylist[], tool: string, input: unknown): DenyResult {
  for (const list of denylists) {
    const result = list.isDenied({ tool, input });
    if (result.denied) return result;
  }
  return { denied: false };
}

function decideSafely(ctx: ApprovalContext, denylists: readonly Denylist[]): Decision {
  const name = toolName(ctx.tool);
  const denied = checkDenylists(denylists, name, ctx.input);
  if (denied.denied) {
    const what = denied.description ? `${denied.description} (${denied.pattern})` : (denied.pattern ?? "a denied pattern");
    return { decision: "deny", reason: `"${name}" matches the hard denylist: ${what}. It never runs, in any mode.` };
  }
  if (!MODES.has(ctx.mode)) {
    return { decision: "deny", reason: `Unknown agent mode "${String(ctx.mode)}", so "${name}" is denied.` };
  }
  if (ctx.mode === "off") return { decision: "deny", reason: `The agent is off, so "${name}" does not run.` };
  if (!ctx.tool || typeof ctx.tool !== "object") {
    return { decision: "deny", reason: "The call has no tool definition, so it is denied." };
  }

  const attended = ctx.attended === true;
  const tainted = ctx.tainted !== false;
  const needsApproval = ctx.tool.requiresApproval === true;

  if (isReadOnly(ctx.tool) && !needsApproval) {
    return { decision: "allow", reason: `"${name}" is read-only, so it runs.` };
  }
  const readOnlyNote = isReadOnly(ctx.tool) ? "is read-only but always needs a person's approval" : null;

  switch (ctx.mode) {
    case "shadow":
      return propose(name, readOnlyNote ?? "has side effects and the agent is in shadow mode (drafts only)");
    case "supervised":
      return propose(name, readOnlyNote ?? "has side effects and the agent is supervised");
    case "autonomous":
      if (needsApproval) return proposeOrDeny(attended, name, readOnlyNote ?? "always needs a person's approval");
      if (tainted) {
        return proposeOrDeny(attended, name, "has side effects and untrusted text has entered this session");
      }
      return { decision: "allow", reason: `"${name}" has side effects; the agent is autonomous and the session is clean.` };
    default:
      return { decision: "deny", reason: `Unknown agent mode, so "${name}" is denied.` };
  }
}

/** Creates the approval policy. `decide` never throws: if anything goes wrong it denies, with the reason. */
export function createApprovalPolicy(options: ApprovalPolicyOptions = {}): ApprovalPolicy {
  const custom = options?.denylist;
  const denylists = custom && custom !== defaultDenylist ? [defaultDenylist, custom] : [defaultDenylist];
  return Object.freeze({
    decide(ctx: ApprovalContext): Decision {
      try {
        return decideSafely(ctx, denylists);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { decision: "deny", reason: `The call could not be checked (${reason}), so it is denied.` };
      }
    },
  });
}
