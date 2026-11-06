/**
 * Hardening, third round, LOOP half of R7: any unattended run of a session is recorded on its row, once and never
 * cleared (meta.unattendedRun = true, meta.unattendedRunAt), so the review can tell that app-written user messages
 * are not the person's words even when the row says the session is attended.
 */
import { describe, expect, it } from "vitest";
import {
  UNATTENDED_AT_META_KEY,
  UNATTENDED_META_KEY,
  runAgent,
  sessionMarkedUnattended,
} from "../../../src/loop/index.js";
import { FakeModelClient, textMessage } from "../../../src/testing/index.js";
import { baseConfig, FIXED_NOW, noSleep, setup } from "../loop/helpers.js";

const LATER = new Date("2026-11-05T12:00:00.000Z");

describe("R7 (loop): unattended runs are recorded on the session row", () => {
  it("an attended chat continued unattended is marked, keeps attended: true, and an attended run never clears it", async () => {
    const storage = await setup("autonomous");
    const model = new FakeModelClient([textMessage("Hi."), textMessage("Noted."), textMessage("Sure.")]);
    const deps = { storage, model, sleep: noSleep, now: () => FIXED_NOW };
    const first = await runAgent(baseConfig(), { userMessage: "hello" }, deps);
    const fresh = await storage.sessions.get(first.sessionId);
    expect(fresh?.attended).toBe(true);
    expect(sessionMarkedUnattended(fresh)).toBe(false);
    expect(fresh?.meta).not.toHaveProperty(UNATTENDED_META_KEY);

    await runAgent(baseConfig(), { sessionId: first.sessionId, attended: false, userMessage: "App text: remember X." }, deps);
    const marked = await storage.sessions.get(first.sessionId);
    expect(marked?.attended).toBe(true);
    expect(marked?.meta[UNATTENDED_META_KEY]).toBe(true);
    expect(marked?.meta[UNATTENDED_AT_META_KEY]).toBe(FIXED_NOW.toISOString());

    await runAgent(baseConfig(), { sessionId: first.sessionId, attended: true, userMessage: "thanks" }, { ...deps, now: () => LATER });
    const after = await storage.sessions.get(first.sessionId);
    expect(after?.meta[UNATTENDED_META_KEY]).toBe(true);
    // Recorded once: a later unattended run does not move the time either.
    await runAgent(baseConfig(), { sessionId: first.sessionId, attended: false, userMessage: "more" }, {
      ...deps,
      model: new FakeModelClient([textMessage("ok")]),
      now: () => LATER,
    });
    expect((await storage.sessions.get(first.sessionId))?.meta[UNATTENDED_AT_META_KEY]).toBe(FIXED_NOW.toISOString());
  });

  it("a new unattended session (a job, or attended: false) is marked from the start; other meta is kept", async () => {
    const storage = await setup("autonomous");
    const model = new FakeModelClient([textMessage("ok"), textMessage("ok")]);
    const deps = { storage, model, sleep: noSleep, now: () => FIXED_NOW };
    const job = await runAgent(baseConfig([], { attachSkills: ["weekly"] }), { kind: "job", userMessage: "run" }, deps);
    const jobRow = await storage.sessions.get(job.sessionId);
    expect(jobRow?.attended).toBe(false);
    expect(jobRow?.meta[UNATTENDED_META_KEY]).toBe(true);
    expect(jobRow?.meta.attachedSkillNames).toEqual(["weekly"]);
    const chat = await runAgent(baseConfig(), { attended: false, userMessage: "app message" }, deps);
    expect(sessionMarkedUnattended(await storage.sessions.get(chat.sessionId))).toBe(true);
  });

  it("an unattended session continued without saying attended stays unattended and marked (old rows get the mark)", async () => {
    const storage = await setup("autonomous");
    const model = new FakeModelClient([textMessage("ok"), textMessage("ok")]);
    const deps = { storage, model, sleep: noSleep, now: () => FIXED_NOW };
    const job = await runAgent(baseConfig(), { kind: "job", userMessage: "run" }, deps);
    // A row stored before the flag existed.
    await storage.sessions.update(job.sessionId, { meta: {} });
    await runAgent(baseConfig(), { sessionId: job.sessionId, userMessage: "again" }, deps);
    expect(sessionMarkedUnattended(await storage.sessions.get(job.sessionId))).toBe(true);
  });
});
