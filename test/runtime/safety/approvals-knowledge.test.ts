import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApprovalPolicy } from "../../../src/safety/index.js";
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

describe("approval policy: knowledge tools write only through proposals", () => {
  for (const capabilities of [["memory.write"], ["skills.write"], ["read", "memory.write"]] as ToolCapability[][]) {
    it(`allows a ${capabilities.join("+")} tool in every mode but off, attended or not, tainted or not`, () => {
      for (const mode of MODES) {
        for (const attended of [true, false]) {
          for (const tainted of [true, false]) {
            const result = policy.decide({ mode, attended, tainted, tool: tool(capabilities), input: { ops: [] } });
            expect(result.decision, `${mode} attended=${attended} tainted=${tainted}`).toBe("allow");
            expect(result.reason).toMatch(/proposals/);
          }
        }
      }
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
