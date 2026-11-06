/**
 * Hardening, policy block (E): the SDK Tool Runner adapter shares the SESSION's taint. Tools built one at a time
 * with toBetaZodTool (each with its own local flag) still see that untrusted text entered the session, and the taint
 * is recorded on the session row so it lasts across runs, as in runAgent.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TAINTED_META_KEY } from "../../../src/loop/taint.js";
import { wrapUntrusted } from "../../../src/safety/index.js";
import { defineTool, toBetaZodTool } from "../../../src/tools/index.js";
import type { Storage, ToolContext, ToolDef } from "../../../src/types.js";
import { AGENT, toolCtx, world, type World } from "./policy-helpers.js";

function tools(w: World): { fetchPage: ToolDef; saveNote: ToolDef } {
  const byName = new Map(w.notes.tools.map((t) => [t.name, t]));
  return { fetchPage: byName.get("fetch_page") as ToolDef, saveNote: byName.get("save_note") as ToolDef };
}

async function chat(w: World): Promise<string> {
  const session = await w.storage.sessions.create({ agentId: AGENT, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
  return session.id;
}

const factory = (storage: Storage, sessionId: string, extra: Partial<ToolContext> = {}) => () => ({ ...toolCtx(storage, sessionId), ...extra });

describe("E: the Tool Runner adapter shares the session's taint", () => {
  it("tools built one at a time: after fetch_page returned untrusted text, save_note is proposed, not run", async () => {
    const w = await world();
    const sessionId = await chat(w);
    const { fetchPage, saveNote } = tools(w);
    const fetch = toBetaZodTool(fetchPage, factory(w.storage, sessionId));
    const save = toBetaZodTool(saveNote, factory(w.storage, sessionId));
    expect(String(await fetch.run({ url: "https://example.test" }))).toContain("<untrusted_content");
    const out = String(await save.run({ text: "pwned" }));
    expect(out).toContain("proposed");
    expect(w.executed).toEqual([]);
    expect((await w.storage.sessions.get(sessionId))?.meta[TAINTED_META_KEY]).toBe(true);
    expect((await w.storage.proposals.list({ kind: "action" })).map((p) => p.target)).toEqual(["save_note"]);
  });

  it("taint lasts across runs: a tool built later for the same session decides as tainted", async () => {
    const w = await world();
    const sessionId = await chat(w);
    const { fetchPage, saveNote } = tools(w);
    await toBetaZodTool(fetchPage, factory(w.storage, sessionId)).run({ url: "https://example.test" });
    // A new run: fresh adapter tools, a fresh local flag, the app's ToolContext says "not tainted".
    const later = toBetaZodTool(saveNote, factory(w.storage, sessionId), { taint: { tainted: false } });
    expect(String(await later.run({ text: "x" }))).toContain("proposed");
    expect(w.executed).toEqual([]);
  });

  it("a session already marked tainted (meta.tainted, e.g. by runAgent) gates the adapter's side effects", async () => {
    const w = await world();
    const sessionId = await chat(w);
    await w.storage.sessions.update(sessionId, { meta: { [TAINTED_META_KEY]: true } });
    const save = toBetaZodTool(tools(w).saveNote, factory(w.storage, sessionId));
    expect(String(await save.run({ text: "x" }))).toContain("proposed");
    expect(w.executed).toEqual([]);
  });

  it("a session whose stored messages hold an untrusted wrapper (no flag) is tainted too", async () => {
    const w = await world();
    const sessionId = await chat(w);
    const wrapped = wrapUntrusted("an e-mail body", { source: "mail", nonce: "nonce-12345678" });
    await w.storage.messages.append(sessionId, { role: "user", content: [{ type: "text", text: wrapped }], text: wrapped });
    const save = toBetaZodTool(tools(w).saveNote, factory(w.storage, sessionId));
    expect(String(await save.run({ text: "x" }))).toContain("proposed");
    expect(w.executed).toEqual([]);
  });

  it("a session id with no stored row: tools built one at a time still share the taint in this process", async () => {
    const w = await world();
    const { fetchPage, saveNote } = tools(w);
    await toBetaZodTool(fetchPage, factory(w.storage, "app-session-1")).run({ url: "https://example.test" });
    const save = toBetaZodTool(saveNote, factory(w.storage, "app-session-1"));
    expect(String(await save.run({ text: "x" }))).toContain("proposed");
    // Another session of the same storage is not affected.
    const other = toBetaZodTool(saveNote, factory(w.storage, "app-session-2"));
    expect(String(await other.run({ text: "clean" }))).toBe("done");
    expect(w.executed).toEqual(["save_note:clean"]);
  });

  it("a clean session still runs the side effect (autonomous)", async () => {
    const w = await world();
    const sessionId = await chat(w);
    const save = toBetaZodTool(tools(w).saveNote, factory(w.storage, sessionId));
    expect(String(await save.run({ text: "milk" }))).toBe("done");
    expect(w.executed).toEqual(["save_note:milk"]);
    expect((await w.storage.sessions.get(sessionId))?.meta[TAINTED_META_KEY]).toBeUndefined();
  });

  it("a session whose taint cannot be read counts as tainted (fail closed)", async () => {
    const w = await world();
    const sessionId = await chat(w);
    const broken = new Proxy(w.storage, {
      get(target, prop, receiver) {
        if (prop === "sessions") {
          return new Proxy(target.sessions, {
            get(repo, key, r) {
              if (key === "get") return async () => Promise.reject(new Error("database is down"));
              return Reflect.get(repo, key, r) as unknown;
            },
          });
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const save = toBetaZodTool(tools(w).saveNote, factory(broken, sessionId));
    expect(String(await save.run({ text: "x" }))).toContain("proposed");
    expect(w.executed).toEqual([]);
  });

  it("an app ToolContext without a tainted flag is decided as tainted", async () => {
    const w = await world();
    const sessionId = await chat(w);
    const save = toBetaZodTool(tools(w).saveNote, factory(w.storage, sessionId, { tainted: undefined as unknown as boolean }));
    expect(String(await save.run({ text: "x" }))).toContain("proposed");
    const read = defineTool({
      name: "read_x",
      description: "Read x. Use it to look x up.",
      input: z.object({}),
      readOnly: true,
      capabilities: ["read"],
      run: () => "x",
    });
    expect(await toBetaZodTool(read, factory(w.storage, sessionId)).run({})).toBe("x");
  });
});
