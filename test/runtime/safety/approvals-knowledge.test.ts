import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MemoryService } from "../../../src/memory/index.js";
import { ProposalService } from "../../../src/proposals/index.js";
import { createApprovalPolicy } from "../../../src/safety/index.js";
import { SkillService } from "../../../src/skills/index.js";
import { createMemoryStorage } from "../../../src/storage/index.js";
import { knowledgeToolset } from "../../../src/tools/builtin/index.js";
import type { AgentMode, ToolCapability, ToolDef } from "../../../src/types.js";

function tool(capabilities: ToolCapability[], extra: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "memory",
    description: "Proposes memory changes.",
    input: z.object({}),
    readOnly: false,
    capabilities,
    run: () => "ok",
    ...extra,
  };
}

const policy = createApprovalPolicy();
const MODES: AgentMode[] = ["shadow", "supervised", "autonomous"];

/** The built-in knowledge tools that write (the only ones the exemption is for). */
function builtInWriters(): ToolDef[] {
  const storage = createMemoryStorage();
  const memory = new MemoryService({ storage });
  const skills = new SkillService({ storage });
  const proposals = new ProposalService({ storage, memory, skills });
  return knowledgeToolset({ memory, skills, proposals, storage }).tools.filter((t) => !t.readOnly) as ToolDef[];
}

describe("approval policy: knowledge tools write only through proposals", () => {
  it("allows the built-in memory and skill_propose tools in every mode but off, attended or not, tainted or not", () => {
    const writers = builtInWriters();
    expect(writers.map((t) => t.name).sort()).toEqual(["memory", "skill_propose"]);
    for (const builtIn of writers) {
      for (const mode of MODES) {
        for (const attended of [true, false]) {
          for (const tainted of [true, false]) {
            const result = policy.decide({ mode, attended, tainted, tool: builtIn, input: { ops: [] } });
            expect(result.decision, `${builtIn.name} ${mode} attended=${attended} tainted=${tainted}`).toBe("allow");
            expect(result.reason).toMatch(/proposals/);
          }
        }
      }
    }
  });

  // Stricter than before: declared capabilities alone no longer earn the exemption (they are self-declared).
  for (const capabilities of [["memory.write"], ["skills.write"], ["read", "memory.write"]] as ToolCapability[][]) {
    it(`decides an app's own ${capabilities.join("+")} tool like any side effect`, () => {
      const own = tool(capabilities);
      for (const mode of ["shadow", "supervised"] as const) {
        for (const attended of [true, false]) {
          for (const tainted of [true, false]) {
            expect(policy.decide({ mode, attended, tainted, tool: own, input: {} }).decision, `${mode}`).toBe("propose");
          }
        }
      }
      expect(policy.decide({ mode: "autonomous", attended: true, tainted: false, tool: own, input: {} }).decision).toBe("allow");
      expect(policy.decide({ mode: "autonomous", attended: true, tainted: true, tool: own, input: {} }).decision).toBe("propose");
      expect(policy.decide({ mode: "autonomous", attended: false, tainted: true, tool: own, input: {} }).decision).toBe("deny");
    });
  }

  it("denies a knowledge tool when the agent is off", () => {
    expect(policy.decide({ mode: "off", attended: true, tainted: false, tool: tool(["memory.write"]), input: {} }).decision).toBe(
      "deny",
    );
  });

  it("still lets the hard denylist win", () => {
    const decision = policy.decide({
      mode: "autonomous",
      attended: true,
      tainted: false,
      tool: tool(["memory.write"]),
      input: { text: "rm -rf /" },
    });
    expect(decision.decision).toBe("deny");
  });

  it("treats a knowledge tool marked requiresApproval like any approval-required side effect", () => {
    const t = tool(["memory.write"], { requiresApproval: true });
    expect(policy.decide({ mode: "autonomous", attended: true, tainted: false, tool: t, input: {} }).decision).toBe("propose");
    expect(policy.decide({ mode: "autonomous", attended: false, tainted: false, tool: t, input: {} }).decision).toBe("deny");
  });

  it("does not extend the exception to a tool that mixes knowledge with other capabilities", () => {
    const mixed = tool(["memory.write", "external.write"]);
    expect(policy.decide({ mode: "shadow", attended: true, tainted: false, tool: mixed, input: {} }).decision).toBe("propose");
    expect(policy.decide({ mode: "autonomous", attended: false, tainted: true, tool: mixed, input: {} }).decision).toBe("deny");
  });

  it("does not treat a tool with no capabilities as a knowledge tool", () => {
    expect(policy.decide({ mode: "shadow", attended: true, tainted: false, tool: tool([]), input: {} }).decision).toBe("propose");
  });
});
