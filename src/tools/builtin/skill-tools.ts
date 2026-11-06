/**
 * Skill tools: skill_list and skill_view (read-only) and skill_propose (always a proposal; a person approves it).
 */
import { z } from "zod";
import { ProposalRefusedError } from "../../proposals/errors.js";
import type { ProposalService } from "../../proposals/proposals.js";
import { indexLine, type SkillService } from "../../skills/skills.js";
import type { Evidence, SkillChange, ToolDef } from "../../types.js";

const skillName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .describe("The skill's name (lowercase letters, digits and hyphens).");

export const skillListInput = z.object({});
export const skillViewInput = z.object({ name: skillName });

export const skillChangeSchema = z.discriminatedUnion("change", [
  z.object({
    change: z.literal("patch"),
    old: z.string().min(1).max(4000).describe("Text that occurs exactly once in the skill's body."),
    new: z.string().max(4000).describe("The text that replaces it."),
  }),
  z.object({
    change: z.literal("add_reference"),
    title: z.string().min(1).max(100),
    text: z.string().min(1).max(4000),
  }),
  z.object({
    change: z.literal("create"),
    description: z.string().min(1).max(1024).describe("What the skill does and when to use it; the first sentence is the index line."),
    body: z.string().min(1).max(20_000),
  }),
]);

export const skillProposeInput = z.object({
  skill: skillName,
  changes: z.array(skillChangeSchema).min(1).max(5),
  rationale: z.string().min(1).max(1000).describe("What went wrong or was missing, and why this change fixes it."),
  evidence: z
    .array(
      z.object({
        messageId: z.string().min(1).max(200),
        quote: z.string().min(1).max(300).describe("Words copied exactly from that message."),
      }),
    )
    .max(10)
    .optional(),
});

export const WAITING_NOTE = "Nothing changes until a person approves it.";

export function makeSkillTools(
  skills: SkillService,
  proposals: ProposalService,
): [ToolDef<typeof skillListInput>, ToolDef<typeof skillViewInput>, ToolDef<typeof skillProposeInput>] {
  const skillList: ToolDef<typeof skillListInput> = {
    name: "skill_list",
    description: "List the skills you have (name and one line each). Use skill_view to load one in full.",
    input: skillListInput,
    readOnly: true,
    capabilities: ["read"],
    async run(_input, ctx) {
      const list = await skills.list(ctx.agentId);
      if (list.length === 0) return "No skills yet.";
      return list.map((skill) => `- ${indexLine(skill)}${skill.status === "stale" ? " (stale)" : ""}`).join("\n");
    },
  };

  const skillView: ToolDef<typeof skillViewInput> = {
    name: "skill_view",
    description: "Load a skill in full (its description and all its steps). Call it when a skill in the index applies.",
    input: skillViewInput,
    readOnly: true,
    capabilities: ["read"],
    async run(input, ctx) {
      const skill = await skills.view(ctx.agentId, input.name);
      if (!skill) throw new Error(`There is no skill named "${input.name}". Use skill_list to see the skills.`);
      return `# ${skill.name} (version ${skill.version})\n\n${skill.description}\n\n${skill.body}`;
    },
  };

  const skillPropose: ToolDef<typeof skillProposeInput> = {
    name: "skill_propose",
    description: [
      "Propose a change to a skill: patch its steps (preferred), add a reference section, or create a new skill.",
      "Prefer patching an existing skill over creating a new one, and read it with skill_view first.",
      "This never changes a skill directly: it creates a proposal that waits for a person's approval.",
    ].join(" "),
    input: skillProposeInput,
    readOnly: false,
    capabilities: ["skills.write"],
    async run(input, ctx) {
      const evidence: Evidence[] = (input.evidence ?? []).map((item) => ({
        kind: "message",
        ref: item.messageId,
        quote: item.quote,
      }));
      try {
        const proposal = await proposals.create({
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          kind: "skill",
          target: input.skill,
          payload: { kind: "skill", skill: input.skill, changes: input.changes as SkillChange[] },
          evidence,
          rationale: input.rationale,
          createdBy: `agent:${ctx.agentId}`,
          shadow: ctx.mode === "shadow",
        });
        return `Proposed (id ${proposal.id}), waiting for approval. ${WAITING_NOTE}`;
      } catch (error) {
        if (error instanceof ProposalRefusedError) return `Not proposed: ${error.problems.join(" ")}`;
        throw error;
      }
    },
  };

  return [skillList, skillView, skillPropose];
}
