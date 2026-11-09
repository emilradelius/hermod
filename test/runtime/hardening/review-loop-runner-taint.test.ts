/**
 * Review fix C9 (LOOP block): the Tool Runner adapter reads the session row's taint flag first and lists the
 * session's messages only when the flag is missing (a session stored before the flag existed). The answer is the
 * same as before; the cost of listing and serialising every stored message on every call is gone for flagged rows.
 */
import { describe, expect, it } from "vitest";
import { TAINTED_META_KEY } from "../../../src/loop/taint.js";
import { wrapUntrusted } from "../../../src/safety/index.js";
import { toBetaZodTool } from "../../../src/tools/index.js";
import type { Storage, ToolDef } from "../../../src/types.js";
import { AGENT, toolCtx, world } from "./policy-helpers.js";

/** The same storage, counting messages.list calls. */
function countingLists(inner: Storage): { storage: Storage; lists: () => number } {
  let lists = 0;
  const messages = new Proxy(inner.messages, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop === "list" && typeof value === "function") {
        return (...args: unknown[]) => {
          lists += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  const storage = new Proxy(inner, {
    get(target, prop, receiver) {
      return prop === "messages" ? messages : Reflect.get(target, prop, receiver);
    },
  });
  return { storage, lists: () => lists };
}

describe("C9: storedTaint checks the row's flag before listing messages", () => {
  it("a session marked tainted: the call is gated and no message is listed", async () => {
    const w = await world();
    const session = await w.storage.sessions.create({ agentId: AGENT, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
    await w.storage.sessions.update(session.id, { meta: { [TAINTED_META_KEY]: true } });
    for (let i = 0; i < 20; i += 1) {
      await w.storage.messages.append(session.id, { role: "user", content: [{ type: "text", text: `note ${i}` }], text: `note ${i}` });
    }
    const { storage, lists } = countingLists(w.storage);
    const save = toBetaZodTool(w.notes.tools.find((t) => t.name === "save_note") as ToolDef, () => toolCtx(storage, session.id));
    expect(String(await save.run({ text: "x" }))).toContain("proposed");
    expect(String(await save.run({ text: "y" }))).toContain("proposed");
    expect(w.executed).toEqual([]);
    expect(lists()).toBe(0);
  });

  it("a session without the flag still has its messages checked (an untrusted wrapper there taints it)", async () => {
    const w = await world();
    const session = await w.storage.sessions.create({ agentId: AGENT, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
    const wrapped = wrapUntrusted("an e-mail body", { source: "mail", nonce: "nonce-12345678" });
    await w.storage.messages.append(session.id, { role: "user", content: [{ type: "text", text: wrapped }], text: wrapped });
    const { storage, lists } = countingLists(w.storage);
    const save = toBetaZodTool(w.notes.tools.find((t) => t.name === "save_note") as ToolDef, () => toolCtx(storage, session.id));
    expect(String(await save.run({ text: "x" }))).toContain("proposed");
    expect(w.executed).toEqual([]);
    expect(lists()).toBeGreaterThan(0);
  });
});
