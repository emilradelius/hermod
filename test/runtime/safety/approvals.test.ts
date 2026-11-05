import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApprovalPolicy, createDenylist } from "../../../src/safety/index.js";
import type { AgentMode, ApprovalContext, ApprovalDecision, ToolCapability, ToolDef } from "../../../src/types.js";

function tool(opts: { readOnly: boolean; requiresApproval?: boolean; capabilities?: ToolCapability[]; name?: string }): ToolDef {
  return {
    name: opts.name ?? (opts.readOnly ? "read_notes" : "write_notes"),
    description: "test tool",
    input: z.object({ command: z.string() }),
    readOnly: opts.readOnly,
    capabilities: opts.capabilities ?? (opts.readOnly ? ["read"] : ["internal.write"]),
    requiresApproval: opts.requiresApproval,
    run: () => "ok",
  };
}

const SAFE_INPUT = { command: "ls -la" };
const DENIED_INPUT = { command: "rm -rf /" };

interface Row {
  mode: AgentMode;
  attended: boolean;
  tainted: boolean;
  readOnly: boolean;
  requiresApproval: boolean;
  denied: boolean;
}

/** The rules of rt-spec.md, written out independently of the implementation. */
function expected(r: Row): ApprovalDecision {
  if (r.denied) return "deny";
  if (r.mode === "off") return "deny";
  if (r.readOnly && !r.requiresApproval) return "allow";
  let decision: ApprovalDecision;
  if (r.mode === "shadow" || r.mode === "supervised") decision = "propose";
  else decision = r.tainted || r.requiresApproval ? "propose" : "allow";
  // Only an autonomous run needs an approval right now; shadow and supervised proposals are queued drafts.
  if (decision === "propose" && !r.attended && r.mode === "autonomous") return "deny";
  return decision;
}

function context(r: Row): ApprovalContext {
  return {
    mode: r.mode,
    attended: r.attended,
    tainted: r.tainted,
    tool: tool({ readOnly: r.readOnly, requiresApproval: r.requiresApproval }),
    input: r.denied ? DENIED_INPUT : SAFE_INPUT,
  };
}

const rows: Row[] = [];
for (const mode of ["off", "shadow", "supervised", "autonomous"] as const) {
  for (const attended of [true, false]) {
    for (const tainted of [true, false]) {
      for (const readOnly of [true, false]) {
        for (const requiresApproval of [true, false]) {
          for (const denied of [true, false]) rows.push({ mode, attended, tainted, readOnly, requiresApproval, denied });
        }
      }
    }
  }
}

const policy = createApprovalPolicy();

describe("createApprovalPolicy: every combination", () => {
  it("covers all 128 combinations of mode x attended x tainted x readOnly x requiresApproval x denied", () => {
    expect(rows).toHaveLength(128);
  });

  for (const r of rows) {
    const label = `${r.mode} ${r.attended ? "attended" : "unattended"} ${r.tainted ? "tainted" : "clean"} ${
      r.readOnly ? "read-only" : "side-effect"
    }${r.requiresApproval ? " requiresApproval" : ""}${r.denied ? " DENYLISTED" : ""}`;
    it(`${label} -> ${expected(r)}`, () => {
      const result = policy.decide(context(r));
      expect(result.decision).toBe(expected(r));
      expect(result.reason).toMatch(/\w+ \w+ \w+/);
      expect(result.reason.length).toBeLessThan(300);
    });
  }

  it("never proposes in an unattended autonomous run", () => {
    for (const r of rows.filter((x) => !x.attended && x.mode === "autonomous")) {
      expect(policy.decide(context(r)).decision).not.toBe("propose");
    }
  });

  it("still leaves drafts in unattended shadow and supervised runs (a scheduled shadow agent is scored)", () => {
    for (const r of rows.filter((x) => !x.attended && (x.mode === "shadow" || x.mode === "supervised"))) {
      if (r.denied || (r.readOnly && !r.requiresApproval)) continue;
      expect(policy.decide(context(r)).decision).toBe("propose");
    }
  });

  it("never allows a denylisted call", () => {
    for (const r of rows.filter((x) => x.denied)) expect(policy.decide(context(r)).decision).toBe("deny");
  });

  it("never allows anything when the agent is off", () => {
    for (const r of rows.filter((x) => x.mode === "off")) expect(policy.decide(context(r)).decision).toBe("deny");
  });

  it("never allows a side effect in shadow or supervised mode", () => {
    for (const r of rows.filter((x) => !x.readOnly && (x.mode === "shadow" || x.mode === "supervised"))) {
      expect(policy.decide(context(r)).decision).not.toBe("allow");
    }
  });
});

describe("createApprovalPolicy: key cases spelled out", () => {
  const cases: Array<[string, Row, ApprovalDecision]> = [
    ["autonomous clean side effect runs", { mode: "autonomous", attended: false, tainted: false, readOnly: false, requiresApproval: false, denied: false }, "allow"],
    ["autonomous tainted side effect is proposed when attended", { mode: "autonomous", attended: true, tainted: true, readOnly: false, requiresApproval: false, denied: false }, "propose"],
    ["autonomous tainted side effect is denied when unattended", { mode: "autonomous", attended: false, tainted: true, readOnly: false, requiresApproval: false, denied: false }, "deny"],
    ["autonomous approval-required side effect is proposed", { mode: "autonomous", attended: true, tainted: false, readOnly: false, requiresApproval: true, denied: false }, "propose"],
    ["shadow read is allowed", { mode: "shadow", attended: true, tainted: true, readOnly: true, requiresApproval: false, denied: false }, "allow"],
    ["shadow side effect is a draft", { mode: "shadow", attended: true, tainted: false, readOnly: false, requiresApproval: false, denied: false }, "propose"],
    ["shadow side effect in a scheduled run is still a draft (a proposal waits for nobody)", { mode: "shadow", attended: false, tainted: false, readOnly: false, requiresApproval: false, denied: false }, "propose"],
    ["supervised side effect is proposed", { mode: "supervised", attended: true, tainted: false, readOnly: false, requiresApproval: false, denied: false }, "propose"],
    ["denylist beats a read-only autonomous tool", { mode: "autonomous", attended: true, tainted: false, readOnly: true, requiresApproval: false, denied: true }, "deny"],
    ["read-only but approval-required is proposed", { mode: "autonomous", attended: true, tainted: false, readOnly: true, requiresApproval: true, denied: false }, "propose"],
  ];
  for (const [name, row, decision] of cases) {
    it(name, () => {
      expect(policy.decide(context(row)).decision).toBe(decision);
    });
  }

  it("explains decisions in plain English with the tool name", () => {
    const denied = policy.decide(context({ ...cases[0]![1], denied: true }));
    expect(denied.reason).toContain('"write_notes"');
    expect(denied.reason).toMatch(/denylist/);
    expect(denied.reason).toMatch(/rm-recursive-root/);
    const unattended = policy.decide(context(cases[2]![1]));
    expect(unattended.reason).toMatch(/unattended/);
    expect(unattended.reason).toMatch(/untrusted/);
    const shadow = policy.decide(context(cases[5]![1]));
    expect(shadow.reason).toMatch(/shadow/);
    expect(shadow.reason).toMatch(/proposal/);
    expect(policy.decide(context({ ...cases[0]![1], mode: "off" })).reason).toMatch(/off/);
  });
});

describe("createApprovalPolicy: fails closed", () => {
  it("treats a tool that claims read-only but declares a write capability as a side effect", () => {
    const sneaky = tool({ readOnly: true, capabilities: ["read", "external.write"], name: "sneaky" });
    expect(policy.decide({ mode: "supervised", attended: true, tainted: false, tool: sneaky, input: SAFE_INPUT }).decision).toBe("propose");
    expect(policy.decide({ mode: "autonomous", attended: false, tainted: true, tool: sneaky, input: SAFE_INPUT }).decision).toBe("deny");
    const messaging = tool({ readOnly: true, capabilities: ["messaging"], name: "notify" });
    expect(policy.decide({ mode: "shadow", attended: true, tainted: false, tool: messaging, input: {} }).decision).toBe("propose");
  });

  it("denies unknown modes, missing tools and uninspectable input, and never throws", () => {
    const t = tool({ readOnly: true });
    expect(policy.decide({ mode: "godmode" as AgentMode, attended: true, tainted: false, tool: t, input: {} }).decision).toBe("deny");
    expect(policy.decide({ mode: "autonomous", attended: true, tainted: false, tool: undefined as unknown as ToolDef, input: {} }).decision).toBe(
      "deny",
    );
    const hostile = {
      toJSON() {
        throw new Error("no");
      },
    };
    expect(policy.decide({ mode: "autonomous", attended: true, tainted: false, tool: t, input: hostile }).decision).toBe("deny");
    expect(() => policy.decide(undefined as unknown as ApprovalContext)).not.toThrow();
    expect(policy.decide(undefined as unknown as ApprovalContext).decision).toBe("deny");
  });

  it("treats a missing tainted flag as tainted and a missing attended flag as unattended", () => {
    const side = tool({ readOnly: false });
    const loose = { mode: "autonomous", tool: side, input: SAFE_INPUT } as unknown as ApprovalContext;
    expect(policy.decide(loose).decision).toBe("deny");
    expect(policy.decide({ ...loose, attended: true }).decision).toBe("propose");
    expect(policy.decide({ ...loose, attended: true, tainted: false }).decision).toBe("allow");
  });
});

describe("createApprovalPolicy: denylists", () => {
  it("uses the app's extra patterns", () => {
    const p = createApprovalPolicy({ denylist: createDenylist({ extraPatterns: [/\bdeploy\s+production\b/] }) });
    const t = tool({ readOnly: false });
    expect(p.decide({ mode: "autonomous", attended: true, tainted: false, tool: t, input: { command: "deploy production" } }).decision).toBe(
      "deny",
    );
    expect(p.decide({ mode: "autonomous", attended: true, tainted: false, tool: t, input: SAFE_INPUT }).decision).toBe("allow");
  });

  it("still applies the built-in patterns when a hand-made denylist never denies", () => {
    const permissive = { isDenied: () => ({ denied: false }), patterns: [] };
    const p = createApprovalPolicy({ denylist: permissive });
    const t = tool({ readOnly: true });
    expect(p.decide({ mode: "autonomous", attended: true, tainted: false, tool: t, input: DENIED_INPUT }).decision).toBe("deny");
  });

  it("is frozen", () => {
    expect(() => {
      (policy as unknown as { decide: unknown }).decide = () => ({ decision: "allow", reason: "" });
    }).toThrow();
  });
});
