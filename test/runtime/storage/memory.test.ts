import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../../../src/storage/index.js";
import { runStorageConformance } from "../storage-conformance.js";

runStorageConformance("in-memory", async ({ now }) => ({
  storage: createMemoryStorage({ now }),
  cleanup: async () => {},
}));

describe("createMemoryStorage", () => {
  it("uses the injected clock and id generator", async () => {
    let n = 0;
    const storage = createMemoryStorage({ now: () => new Date("2030-01-02T03:04:05.678Z"), newId: () => `id-${++n}` });
    const session = await storage.sessions.create({
      agentId: "a",
      kind: "chat",
      attended: true,
      memorySnapshot: "",
      skillsIndex: "",
    });
    const message = await storage.messages.append(session.id, { role: "user", content: "hi", text: "hi" });
    expect(session).toMatchObject({ id: "id-1", startedAt: "2030-01-02T03:04:05.678Z" });
    expect(message).toMatchObject({ id: "id-2", createdAt: "2030-01-02T03:04:05.678Z" });
  });

  it("refuses a clock that returns an invalid date or an id generator that returns an empty id", async () => {
    const badClock = createMemoryStorage({ now: () => new Date(Number.NaN) });
    await expect(badClock.agents.upsert({ id: "a", name: "A" })).rejects.toThrow(/valid Date/);
    const badIds = createMemoryStorage({ newId: () => "" });
    await expect(
      badIds.sessions.create({ agentId: "a", kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" }),
    ).rejects.toThrow(/generated id/);
  });

  it("keeps separate instances separate", async () => {
    const one = createMemoryStorage();
    const two = createMemoryStorage();
    await one.agents.upsert({ id: "a", name: "A" });
    expect(await two.agents.list()).toEqual([]);
  });

  it("refuses a duplicate generated id instead of overwriting a record", async () => {
    const storage = createMemoryStorage({ newId: () => "same" });
    const input = { agentId: "a", kind: "chat" as const, attended: true, memorySnapshot: "", skillsIndex: "" };
    await storage.sessions.create(input);
    await expect(storage.sessions.create(input)).rejects.toThrow(/already exists/);
  });
});
