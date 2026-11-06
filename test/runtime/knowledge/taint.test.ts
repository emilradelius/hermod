import { describe, expect, it } from "vitest";
import { makeMemoryTool } from "../../../src/tools/builtin/index.js";
import { AGENT, ctx, makeSession, setup } from "./helpers.js";

const ADD = { store: "user", ops: [{ op: "add", text: "User prefers short answers." }] } as never;

describe("memory tool after untrusted text (taint)", () => {
  it("never applies directly, even to a store whose owner allows add-only writes", async () => {
    const s = setup();
    await s.memory.ensureStores(AGENT, [{ name: "user", capChars: 1375, autoApply: "add" }]);
    const session = await makeSession(s.storage);
    const tool = makeMemoryTool(s.memory);

    const out = await tool.run(ADD, ctx(s.storage, session, { tainted: true }));

    expect(String(out)).toMatch(/^Proposed/);
    expect(await s.memory.entries(AGENT, "user")).toEqual([]);
    const pending = await s.proposals.list({ agentId: AGENT, status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe("memory");
  });

  it("still applies an add directly in a clean session when the owner allows add-only writes", async () => {
    const s = setup();
    await s.memory.ensureStores(AGENT, [{ name: "user", capChars: 1375, autoApply: "add" }]);
    const session = await makeSession(s.storage);
    const tool = makeMemoryTool(s.memory);

    const out = await tool.run(ADD, ctx(s.storage, session, { tainted: false }));

    expect(String(out)).toMatch(/^Saved/);
    expect(await s.memory.entries(AGENT, "user")).toEqual(["User prefers short answers."]);
  });

  it("never applies directly in shadow mode either", async () => {
    const s = setup();
    await s.memory.ensureStores(AGENT, [{ name: "user", capChars: 1375, autoApply: "add" }]);
    const session = await makeSession(s.storage);
    const out = await makeMemoryTool(s.memory).run(ADD, ctx(s.storage, session, { mode: "shadow" }));
    expect(String(out)).toMatch(/^Proposed/);
    expect(await s.memory.entries(AGENT, "user")).toEqual([]);
  });
});
