/**
 * One conformance suite for every Storage adapter (in-memory, SQLite, Postgres).
 *
 * Each adapter's test file calls runStorageConformance(name, makeStorage). makeStorage must return a fresh, empty
 * storage and pass `now` on to the adapter, so the suite controls the clock; the suite calls migrate() itself.
 *
 * The orders the suite pins (they are part of the contract):
 * - agents.list: createdAt, then id (oldest first).
 * - sessions.listByAgent: startedAt, newest first.
 * - messages.list: seq ascending. messages.search: best score first.
 * - memory.listStores, skills.list, jobs.list: by name (code point order).
 * - skills.versions: version ascending (oldest first).
 * - proposals.list (createdAt), audit.list (at), costs.list (at), deliveries.list (createdAt): newest first.
 * - jobs.claimDue: nextRunAt ascending, then id.
 * Equal times keep the newest-written record first in every newest-first list.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageError } from "../../src/storage/index.js";
import type {
  AgentRecord,
  JobRecord,
  MessageParam,
  MessageRecord,
  NewJob,
  NewProposal,
  NewSession,
  ProposalRecord,
  Storage,
} from "../../src/types.js";

export interface ConformanceOptions {
  /** The suite's clock; pass it to the adapter as its `now` option. */
  now: () => Date;
}

export type MakeStorage = (options: ConformanceOptions) => Promise<{ storage: Storage; cleanup: () => Promise<void> }>;

const T0 = Date.parse("2026-11-05T08:00:00.000Z");
/** T0 plus some minutes, as an ISO string. */
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const CONTRACT: Record<string, string[]> = {
  agents: ["get", "list", "update", "upsert"],
  sessions: ["create", "get", "listByAgent", "update"],
  messages: ["append", "get", "list", "search"],
  memory: ["ensureStore", "getStore", "listStores", "setPolicy", "writeContent"],
  skills: ["bump", "create", "get", "list", "setPinned", "setStatus", "update", "versions"],
  proposals: ["create", "get", "list", "setScore", "transition"],
  audit: ["append", "list"],
  costs: ["add", "list", "sum"],
  jobs: ["claimDue", "finish", "get", "list", "setEnabled", "upsert"],
  deliveries: ["add", "list", "mark"],
};

/** Every callable property reachable on an object, including through its prototype chain. */
function methodNames(repo: object): string[] {
  const names = new Set<string>();
  for (let level: object | null = repo; level !== null && level !== Object.prototype; level = Object.getPrototypeOf(level)) {
    for (const key of Object.getOwnPropertyNames(level)) {
      const value: unknown = Reflect.get(level, key);
      if (key !== "constructor" && typeof value === "function") names.add(key);
    }
  }
  return [...names].sort();
}

const isIso = (value: unknown) => typeof value === "string" && new Date(value).toISOString() === value;

const HOSTILE_QUERIES = [
  '"',
  "'",
  '""',
  "''",
  '"unterminated',
  "(",
  ")",
  "()",
  "(ratta",
  "ratta)",
  "AND",
  "OR",
  "NOT",
  "NEAR",
  "NEAR(ratta felet)",
  "NEAR(ratta felet, 2)",
  "ratta AND felet",
  "ratta OR",
  "OR OR OR",
  "NOT ratta",
  "*",
  "ratta*",
  "*ratta",
  "^ratta",
  "ratta:felet",
  "text:ratta",
  "{text}:ratta",
  "-ratta",
  "+ratta",
  "ratta -felet",
  "'; drop table x; --",
  '"; DROP TABLE messages; --',
  "1 = 1; --",
  "%",
  "_",
  "\\",
  "\\\\",
  "$1",
  "?",
  ":memory:",
  "\u0000",
  "a\u0000b",
  "\uD800",
  "\uDC00x",
  "😀",
  "🔥 ratta 🔥",
  "‮ratta",
  "​",
  "日本語",
  "Ελληνικά",
  "x".repeat(5000),
  "ratta ".repeat(500),
  "<b>ratta</b>",
  "[ratta]",
  "ratta|felet",
  "ratta & felet",
  "ratta <-> felet",
  "!ratta",
  "ratta:*",
  "null",
  "undefined",
  "  ",
  "\n\t",
  "...",
  "—",
  "@#$%^&*",
];

export function runStorageConformance(name: string, makeStorage: MakeStorage): void {
  describe(`Storage conformance: ${name}`, () => {
    let storage: Storage;
    let cleanup: () => Promise<void>;
    let now = T0;
    const setNow = (minutes: number) => {
      now = T0 + minutes * 60_000;
    };
    const tick = () => {
      now += 1_000;
    };

    beforeEach(async () => {
      now = T0;
      const made = await makeStorage({ now: () => new Date(now) });
      storage = made.storage;
      cleanup = made.cleanup;
      await storage.migrate();
    });

    afterEach(async () => {
      await storage.close();
      await cleanup();
    });

    const newSession = (overrides: Partial<NewSession> = {}) =>
      storage.sessions.create({
        agentId: "agent-a",
        kind: "chat",
        attended: true,
        memorySnapshot: "User prefers short answers.",
        skillsIndex: "release-notes: Write release notes",
        ...overrides,
      });
    const textMessage = (text: string, role: MessageRecord["role"] = "user") => ({
      role,
      content: [{ type: "text" as const, text }],
      text,
    });
    const proposalInput = (overrides: Partial<NewProposal> = {}): NewProposal => ({
      agentId: "agent-a",
      sessionId: null,
      kind: "memory",
      target: "memory",
      payload: { kind: "memory", store: "memory", ops: [{ op: "add", text: "The project uses pnpm." }] },
      evidence: [{ kind: "message", ref: "m-1", quote: "we use pnpm" }],
      rationale: "Stated by the user.",
      createdBy: "review",
      ...overrides,
    });
    const jobInput = (overrides: Partial<NewJob> = {}): NewJob => ({
      agentId: "agent-a",
      name: "morning-brief",
      schedule: "0 7 * * *",
      timeZone: "Europe/Stockholm",
      prompt: "Summarise today's calendar.",
      deliver: "inapp:owner",
      ...overrides,
    });
    const costInput = (overrides: Partial<Parameters<Storage["costs"]["add"]>[0]> = {}) => ({
      at: at(0),
      agentId: "agent-a",
      sessionId: null,
      model: "claude-opus-5-5",
      purpose: "main" as const,
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      costUsd: 0.0125,
      ...overrides,
    });
    const newSkill = (name = "release-notes", agentId = "agent-a") =>
      storage.skills.create({
        agentId,
        name,
        description: "Write release notes. Use for every tagged release.",
        body: "1. Read the changelog.\n2. Group by area.",
        createdBy: "user:emil",
      });

    describe("shape and migrations", () => {
      it("each repository has exactly the methods of the contract", () => {
        for (const [repo, methods] of Object.entries(CONTRACT)) {
          expect(methodNames(Reflect.get(storage, repo) as object), repo).toEqual([...methods].sort());
        }
      });

      it("audit has only append and list: there is no way to change or remove an entry", () => {
        expect(methodNames(storage.audit)).toEqual(["append", "list"]);
        for (const forbidden of ["update", "delete", "remove", "clear", "set", "replace", "truncate"]) {
          expect(Reflect.get(storage.audit, forbidden)).toBeUndefined();
        }
      });

      it("messages are append-only: no update or delete method", () => {
        expect(methodNames(storage.messages)).toEqual(["append", "get", "list", "search"]);
      });

      it("migrate() is idempotent and keeps existing data", async () => {
        await storage.agents.upsert({ id: "agent-a", name: "Assistant" });
        await storage.migrate();
        await storage.migrate();
        expect((await storage.agents.get("agent-a"))?.name).toBe("Assistant");
      });
    });

    describe("agents", () => {
      it("upsert creates an agent with safe defaults (shadow mode, no cost cap)", async () => {
        const agent = await storage.agents.upsert({ id: "agent-a", name: "Assistant" });
        expect(agent).toEqual<AgentRecord>({
          id: "agent-a",
          name: "Assistant",
          mode: "shadow",
          accuracyBar: 0.9,
          minSamples: 20,
          monthlyCostCapUsd: null,
          createdAt: at(0),
          updatedAt: at(0),
        });
        expect(await storage.agents.get("agent-a")).toEqual(agent);
      });

      it("upsert of an existing agent changes the name and the given fields only and keeps createdAt", async () => {
        await storage.agents.upsert({ id: "agent-a", name: "Assistant", mode: "supervised", monthlyCostCapUsd: 25 });
        setNow(5);
        const updated = await storage.agents.upsert({ id: "agent-a", name: "Renamed", accuracyBar: 0.8 });
        expect(updated).toMatchObject({
          name: "Renamed",
          mode: "supervised",
          accuracyBar: 0.8,
          minSamples: 20,
          monthlyCostCapUsd: 25,
          createdAt: at(0),
          updatedAt: at(5),
        });
      });

      it("get returns null for an unknown id; list is ordered by createdAt, then id", async () => {
        expect(await storage.agents.get("nobody")).toBeNull();
        setNow(2);
        await storage.agents.upsert({ id: "b-late", name: "B" });
        setNow(1);
        await storage.agents.upsert({ id: "z-early", name: "Z" });
        await storage.agents.upsert({ id: "a-early", name: "A" });
        expect((await storage.agents.list()).map((a) => a.id)).toEqual(["a-early", "z-early", "b-late"]);
      });

      it("update changes the given fields, can clear the cost cap, and returns null for an unknown id", async () => {
        await storage.agents.upsert({ id: "agent-a", name: "Assistant", monthlyCostCapUsd: 10 });
        setNow(3);
        const updated = await storage.agents.update("agent-a", { mode: "off", monthlyCostCapUsd: null });
        expect(updated).toMatchObject({ mode: "off", monthlyCostCapUsd: null, updatedAt: at(3), createdAt: at(0) });
        expect(await storage.agents.get("agent-a")).toEqual(updated);
        expect(await storage.agents.update("nobody", { mode: "off" })).toBeNull();
      });

      it("update with an empty patch changes nothing; fields outside the patch type are ignored", async () => {
        const agent = await storage.agents.upsert({ id: "agent-a", name: "Assistant" });
        setNow(4);
        expect(await storage.agents.update("agent-a", {})).toEqual(agent);
        const sneaky = { mode: "off", name: "Hijacked", createdAt: at(99) } as Parameters<Storage["agents"]["update"]>[1];
        const updated = await storage.agents.update("agent-a", sneaky);
        expect(updated).toMatchObject({ mode: "off", name: "Assistant", createdAt: at(0) });
      });

      it("rejects invalid values with a StorageError and stores nothing", async () => {
        const bad: Array<Parameters<Storage["agents"]["upsert"]>[0]> = [
          { id: "", name: "Empty id" },
          { id: "agent-a", name: "" },
          { id: "agent-a", name: "A", mode: "rogue" as AgentRecord["mode"] },
          { id: "agent-a", name: "A", accuracyBar: 1.5 },
          { id: "agent-a", name: "A", minSamples: -1 },
          { id: "agent-a", name: "A", minSamples: 2.5 },
          { id: "agent-a", name: "A", monthlyCostCapUsd: -5 },
          { id: "agent-a", name: "A", monthlyCostCapUsd: Number.NaN },
          { id: "line\nbreak", name: "A" },
        ];
        for (const input of bad) await expect(storage.agents.upsert(input)).rejects.toBeInstanceOf(StorageError);
        expect(await storage.agents.list()).toEqual([]);
        await storage.agents.upsert({ id: "agent-a", name: "A" });
        await expect(storage.agents.update("agent-a", { mode: "rogue" as AgentRecord["mode"] })).rejects.toBeInstanceOf(
          StorageError,
        );
        expect((await storage.agents.get("agent-a"))?.mode).toBe("shadow");
      });
    });

    describe("sessions", () => {
      it("create fills in defaults: a new id, running, no parent, zero counters, empty meta, startedAt now", async () => {
        const session = await newSession();
        expect(session.id).toEqual(expect.any(String));
        expect(session.id.length).toBeGreaterThan(0);
        expect(session).toMatchObject({
          agentId: "agent-a",
          kind: "chat",
          parentId: null,
          attended: true,
          startedAt: at(0),
          endedAt: null,
          status: "running",
          memorySnapshot: "User prefers short answers.",
          skillsIndex: "release-notes: Write release notes",
          counters: { userTurns: 0, toolIterations: 0, lastMemoryReviewTurn: 0, lastSkillReviewIteration: 0 },
          meta: {},
        });
        expect(await storage.sessions.get(session.id)).toEqual(session);
        const other = await newSession();
        expect(other.id).not.toBe(session.id);
      });

      it("create keeps a given id, parent, meta and startedAt, and refuses a duplicate id", async () => {
        const parent = await newSession({ id: "s-parent" });
        const child = await newSession({
          id: "s-child",
          kind: "delegate",
          attended: false,
          parentId: parent.id,
          meta: { task: "summarise", depth: 1, tags: ["a", "b"] },
          startedAt: "2026-11-05T10:00:00+02:00",
        });
        expect(child).toMatchObject({
          id: "s-child",
          kind: "delegate",
          attended: false,
          parentId: "s-parent",
          meta: { task: "summarise", depth: 1, tags: ["a", "b"] },
          startedAt: at(0),
        });
        await expect(newSession({ id: "s-parent" })).rejects.toBeInstanceOf(StorageError);
        expect((await storage.sessions.get("s-parent"))?.kind).toBe("chat");
      });

      it("get returns null for an unknown id", async () => {
        expect(await storage.sessions.get("missing")).toBeNull();
      });

      it("update changes endedAt, status, counters and meta only; the frozen snapshot never changes", async () => {
        const session = await newSession({ meta: { a: 1 } });
        const counters = { userTurns: 3, toolIterations: 7, lastMemoryReviewTurn: 0, lastSkillReviewIteration: 5 };
        const updated = await storage.sessions.update(session.id, {
          endedAt: at(9),
          status: "done",
          counters,
          meta: { b: 2 },
        });
        expect(updated).toMatchObject({ endedAt: at(9), status: "done", counters, meta: { b: 2 } });
        const sneaky = { memorySnapshot: "Injected!", skillsIndex: "x", agentId: "agent-b" } as Parameters<
          Storage["sessions"]["update"]
        >[1];
        const after = await storage.sessions.update(session.id, sneaky);
        expect(after).toMatchObject({
          memorySnapshot: "User prefers short answers.",
          skillsIndex: "release-notes: Write release notes",
          agentId: "agent-a",
        });
        expect(await storage.sessions.update("missing", { status: "done" })).toBeNull();
      });

      it("update rejects invalid values", async () => {
        const session = await newSession();
        await expect(storage.sessions.update(session.id, { status: "paused" as "done" })).rejects.toBeInstanceOf(
          StorageError,
        );
        await expect(
          storage.sessions.update(session.id, {
            counters: { userTurns: -1, toolIterations: 0, lastMemoryReviewTurn: 0, lastSkillReviewIteration: 0 },
          }),
        ).rejects.toBeInstanceOf(StorageError);
        await expect(storage.sessions.update(session.id, { endedAt: "yesterday" })).rejects.toBeInstanceOf(StorageError);
        expect((await storage.sessions.get(session.id))?.status).toBe("running");
      });

      it("listByAgent lists newest startedAt first, filters by kind, honours limit and excludes other agents", async () => {
        await newSession({ id: "s-middle", startedAt: at(5) });
        await newSession({ id: "s-old", startedAt: at(1) });
        await newSession({ id: "s-new", startedAt: at(9), kind: "job", attended: false });
        await newSession({ id: "s-other-agent", agentId: "agent-b", startedAt: at(10) });
        const ids = async (options?: Parameters<Storage["sessions"]["listByAgent"]>[1]) =>
          (await storage.sessions.listByAgent("agent-a", options)).map((s) => s.id);
        expect(await ids()).toEqual(["s-new", "s-middle", "s-old"]);
        expect(await ids({ kind: "chat" })).toEqual(["s-middle", "s-old"]);
        expect(await ids({ limit: 2 })).toEqual(["s-new", "s-middle"]);
        expect(await ids({ limit: 0 })).toEqual([]);
        expect(await storage.sessions.listByAgent("nobody")).toEqual([]);
      });

      it("listByAgent keeps the newest-created first when startedAt is equal", async () => {
        await newSession({ id: "first" });
        await newSession({ id: "second" });
        await newSession({ id: "third" });
        expect((await storage.sessions.listByAgent("agent-a")).map((s) => s.id)).toEqual(["third", "second", "first"]);
      });
    });

    describe("messages", () => {
      it("append numbers messages 0, 1, 2 … per session, independently for each session", async () => {
        const a = await newSession();
        const b = await newSession();
        const a0 = await storage.messages.append(a.id, textMessage("first"));
        const a1 = await storage.messages.append(a.id, textMessage("second", "assistant"));
        const b0 = await storage.messages.append(b.id, textMessage("other"));
        const a2 = await storage.messages.append(a.id, textMessage("third"));
        expect([a0.seq, a1.seq, a2.seq, b0.seq]).toEqual([0, 1, 2, 0]);
        expect(a0).toMatchObject({ sessionId: a.id, role: "user", text: "first", createdAt: at(0) });
        expect(new Set([a0.id, a1.id, a2.id, b0.id]).size).toBe(4);
      });

      it("list returns a session's messages in seq order; get finds one by id", async () => {
        const s = await newSession();
        for (const text of ["one", "two", "three"]) await storage.messages.append(s.id, textMessage(text));
        const list = await storage.messages.list(s.id);
        expect(list.map((m) => [m.seq, m.text])).toEqual([
          [0, "one"],
          [1, "two"],
          [2, "three"],
        ]);
        expect(await storage.messages.get(list[1]!.id)).toEqual(list[1]);
        expect(await storage.messages.get("missing")).toBeNull();
        expect(await storage.messages.list("missing")).toEqual([]);
      });

      it("append refuses an unknown session and an invalid role", async () => {
        await expect(storage.messages.append("missing", textMessage("x"))).rejects.toBeInstanceOf(StorageError);
        const s = await newSession();
        await expect(
          storage.messages.append(s.id, { role: "tool" as "user", content: "x", text: "x" }),
        ).rejects.toBeInstanceOf(StorageError);
        expect(await storage.messages.list(s.id)).toEqual([]);
      });

      it("concurrent appends to one session never reuse a seq", async () => {
        const s = await newSession();
        const appended = await Promise.all(
          Array.from({ length: 25 }, (_, i) => storage.messages.append(s.id, textMessage(`message ${i}`))),
        );
        const seqs = appended.map((m) => m.seq).sort((x, y) => x - y);
        expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i));
        expect((await storage.messages.list(s.id)).map((m) => m.seq)).toEqual(seqs);
      });

      it("keeps content blocks exactly (thinking with signature, tool_use input, tool_result) and plain strings", async () => {
        const s = await newSession();
        const assistant: MessageParam["content"] = [
          { type: "thinking", thinking: "Check the calendar first.", signature: "EqQBCkYIARgCKkBsig==" },
          { type: "text", text: "Let me look." },
          {
            type: "tool_use",
            id: "toolu_01",
            name: "calendar_read",
            input: { day: "2026-11-05", filters: { busy: true, ids: [1, 2, 3] }, note: null },
          },
        ];
        const user: MessageParam["content"] = [
          { type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "3 events" }], is_error: false },
        ];
        const m1 = await storage.messages.append(s.id, { role: "assistant", content: assistant, text: "Let me look." });
        const m2 = await storage.messages.append(s.id, { role: "user", content: user, text: "3 events" });
        const m3 = await storage.messages.append(s.id, { role: "user", content: "Just a string", text: "Just a string" });
        expect((await storage.messages.get(m1.id))?.content).toEqual(assistant);
        expect((await storage.messages.get(m2.id))?.content).toEqual(user);
        expect((await storage.messages.get(m3.id))?.content).toBe("Just a string");
      });

      it("stores hostile text: SQL, quotes, emoji and RTL as given; NUL and lone surrogates become U+FFFD", async () => {
        const s = await newSession();
        const safe = `'; DROP TABLE messages; -- "quoted" \\ back 😀 ‮evil‬ ${"long ".repeat(2000)}`;
        const m1 = await storage.messages.append(s.id, { role: "user", content: [{ type: "text", text: safe }], text: safe });
        expect((await storage.messages.get(m1.id))?.text).toBe(safe);
        const nasty = "a\u0000b \uD800 c\uDC00 😀";
        const m2 = await storage.messages.append(s.id, {
          role: "user",
          content: [{ type: "text", text: nasty }],
          text: nasty,
        });
        const cleaned = "a�b � c� 😀";
        expect(m2.text).toBe(cleaned);
        const back = await storage.messages.get(m2.id);
        expect(back?.text).toBe(cleaned);
        expect(back?.content).toEqual([{ type: "text", text: cleaned }]);
        expect((await storage.sessions.get(s.id))?.id).toBe(s.id);
      });
    });

    describe("search", () => {
      async function seed() {
        const s1 = await newSession({ id: "s1" });
        const s2 = await newSession({ id: "s2" });
        const s3 = await newSession({ id: "s3", agentId: "agent-b" });
        await storage.messages.append(s1.id, textMessage("Rätta felet i koden och kör testerna igen."));
        tick();
        await storage.messages.append(s1.id, textMessage("Unrelated chatter about lunch.", "assistant"));
        tick();
        await storage.messages.append(s2.id, textMessage("We should fix the deploy script before Friday."));
        tick();
        await storage.messages.append(s2.id, textMessage("Över och ut, sa piloten på radion."));
        tick();
        await storage.messages.append(s3.id, textMessage("Agent B also has to rätta something."));
        return { s1, s2, s3 };
      }

      it("finds a word and returns the hit's ids, seq, role, createdAt, a snippet and a score", async () => {
        const { s2 } = await seed();
        const hits = await storage.messages.search("deploy");
        expect(hits).toHaveLength(1);
        const [hit] = hits;
        const message = (await storage.messages.list(s2.id))[0]!;
        expect(hit).toMatchObject({ sessionId: s2.id, messageId: message.id, seq: 0, role: "user" });
        expect(hit!.createdAt).toBe(message.createdAt);
        expect(Number.isFinite(hit!.score)).toBe(true);
        expect(hit!.snippet.toLowerCase()).toContain("deploy");
        expect(hit!.snippet.length).toBeLessThan(400);
      });

      it("folds case and Swedish diacritics both ways: ratta finds Rätta, RÄTTA finds rätta, over finds Över", async () => {
        await seed();
        const sessionsFor = async (query: string, agentId?: string) =>
          (await storage.messages.search(query, agentId ? { agentId } : {})).map((h) => h.sessionId).sort();
        expect(await sessionsFor("ratta", "agent-a")).toEqual(["s1"]);
        expect(await sessionsFor("RÄTTA")).toEqual(["s1", "s3"]);
        expect(await sessionsFor("rätta")).toEqual(["s1", "s3"]);
        expect(await sessionsFor("over")).toEqual(["s2"]);
        expect(await sessionsFor("pa radion")).toEqual(["s2"]);
        const [hit] = await storage.messages.search("ratta", { agentId: "agent-a" });
        expect(hit!.snippet).toContain("Rätta");
      });

      it("matches whole words, not prefixes or substrings", async () => {
        await seed();
        expect(await storage.messages.search("rätt")).toEqual([]);
        expect(await storage.messages.search("eploy")).toEqual([]);
        expect(await storage.messages.search("deplo")).toEqual([]);
      });

      it("treats several words as any-of and ranks messages with more matching words first", async () => {
        const s = await newSession();
        await storage.messages.append(s.id, textMessage("alpha and some other words here"));
        tick();
        await storage.messages.append(s.id, textMessage("alpha and beta and other words here"));
        tick();
        await storage.messages.append(s.id, textMessage("beta only with other words here"));
        tick();
        await storage.messages.append(s.id, textMessage("nothing relevant at all in this one"));
        const hits = await storage.messages.search("alpha beta");
        expect(hits.map((h) => h.seq).sort()).toEqual([0, 1, 2]);
        expect(hits[0]!.seq).toBe(1);
        for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
      });

      it("ranks equal matches newest first", async () => {
        const a = await newSession();
        const b = await newSession();
        const older = await storage.messages.append(a.id, textMessage("identical needle text"));
        tick();
        const newer = await storage.messages.append(b.id, textMessage("identical needle text"));
        expect((await storage.messages.search("needle")).map((h) => h.messageId)).toEqual([newer.id, older.id]);
      });

      it("filters by agent, excludes a session, and honours limit (default 20)", async () => {
        await seed();
        expect((await storage.messages.search("rätta", { agentId: "agent-b" })).map((h) => h.sessionId)).toEqual(["s3"]);
        expect((await storage.messages.search("rätta", { excludeSessionId: "s1" })).map((h) => h.sessionId)).toEqual([
          "s3",
        ]);
        expect(await storage.messages.search("rätta", { agentId: "agent-a", excludeSessionId: "s1" })).toEqual([]);
        expect(await storage.messages.search("rätta", { agentId: "nobody" })).toEqual([]);
        expect(await storage.messages.search("rätta", { limit: 1 })).toHaveLength(1);
        expect(await storage.messages.search("rätta", { limit: 0 })).toEqual([]);
        const s = await newSession();
        for (let i = 0; i < 25; i++) await storage.messages.append(s.id, textMessage(`repeated keyword number ${i}`));
        expect(await storage.messages.search("keyword")).toHaveLength(20);
        expect(await storage.messages.search("keyword", { limit: 25 })).toHaveLength(25);
      });

      it("searches query-syntax words literally: AND, OR, NOT and NEAR are just words", async () => {
        const s = await newSession();
        await storage.messages.append(s.id, textMessage("this and that"));
        await storage.messages.append(s.id, textMessage("now or never"));
        await storage.messages.append(s.id, textMessage("do not panic"));
        await storage.messages.append(s.id, textMessage("near the end"));
        const seqsFor = async (query: string) => (await storage.messages.search(query)).map((h) => h.seq).sort();
        expect(await seqsFor("AND")).toEqual([0]);
        expect(await seqsFor("OR")).toEqual([1]);
        expect(await seqsFor("NOT")).toEqual([2]);
        expect(await seqsFor("NEAR")).toEqual([3]);
        expect(await seqsFor('"and" OR (near)')).toEqual([0, 1, 3]);
      });

      it("never throws on hostile queries, and the data is intact afterwards", async () => {
        const { s1 } = await seed();
        for (const query of HOSTILE_QUERIES) {
          const hits = await storage.messages.search(query);
          expect(Array.isArray(hits), JSON.stringify(query.slice(0, 40))).toBe(true);
        }
        const notAString = 42 as unknown as string;
        expect(await storage.messages.search(notAString)).toEqual([]);
        expect(await storage.messages.list(s1.id)).toHaveLength(2);
        expect((await storage.messages.search("ratta", { agentId: "agent-a" })).map((h) => h.sessionId)).toEqual(["s1"]);
      });

      it("returns [] for queries without any word (punctuation, operators, whitespace)", async () => {
        await seed();
        for (const query of ["", "   ", '"', "()", "*", "...", "@#$%^&*", "— –", "'\"", "\u0000", "😀"]) {
          expect(await storage.messages.search(query), JSON.stringify(query)).toEqual([]);
        }
      });

      it("finds words in hostile queries: quotes and operators around a word still find it", async () => {
        await seed();
        for (const query of ['"ratta"', "(ratta)", "ratta*", "-ratta", "ratta:*", "NEAR(ratta felet)"]) {
          const hits = await storage.messages.search(query, { agentId: "agent-a" });
          expect(hits.map((h) => h.sessionId), query).toEqual(["s1"]);
        }
      });
    });

    describe("memory stores", () => {
      it("ensureStore creates an empty store at version 0 and returns the existing one on later calls", async () => {
        const store = await storage.memory.ensureStore("agent-a", "memory", { capChars: 2200, autoApply: "none" });
        expect(store).toMatchObject({
          agentId: "agent-a",
          name: "memory",
          capChars: 2200,
          autoApply: "none",
          content: "",
          version: 0,
          updatedAt: at(0),
        });
        const again = await storage.memory.ensureStore("agent-a", "memory", { capChars: 99, autoApply: "add" });
        expect(again).toEqual(store);
        expect(await storage.memory.getStore("agent-a", "memory")).toEqual(store);
      });

      it("concurrent ensureStore calls create one store", async () => {
        const stores = await Promise.all(
          Array.from({ length: 5 }, () => storage.memory.ensureStore("agent-a", "user", { capChars: 1375, autoApply: "none" })),
        );
        expect(new Set(stores.map((s) => s.id)).size).toBe(1);
        expect(await storage.memory.listStores("agent-a")).toHaveLength(1);
      });

      it("getStore returns null when missing; listStores lists one agent's stores by name", async () => {
        expect(await storage.memory.getStore("agent-a", "memory")).toBeNull();
        await storage.memory.ensureStore("agent-a", "user", { capChars: 1375, autoApply: "none" });
        await storage.memory.ensureStore("agent-a", "memory", { capChars: 2200, autoApply: "none" });
        await storage.memory.ensureStore("agent-b", "memory", { capChars: 2200, autoApply: "none" });
        expect((await storage.memory.listStores("agent-a")).map((s) => s.name)).toEqual(["memory", "user"]);
        expect(await storage.memory.listStores("nobody")).toEqual([]);
      });

      it("writeContent writes only at the expected version; a conflict returns null and writes nothing", async () => {
        const store = await storage.memory.ensureStore("agent-a", "memory", { capChars: 2200, autoApply: "none" });
        setNow(1);
        const v1 = await storage.memory.writeContent(store.id, "The project uses pnpm.", 0);
        expect(v1).toMatchObject({ content: "The project uses pnpm.", version: 1, updatedAt: at(1) });
        setNow(2);
        expect(await storage.memory.writeContent(store.id, "Stale write", 0)).toBeNull();
        expect(await storage.memory.writeContent(store.id, "Future write", 5)).toBeNull();
        expect(await storage.memory.getStore("agent-a", "memory")).toEqual(v1);
        const v2 = await storage.memory.writeContent(store.id, "The project uses pnpm.\n§\nTests use vitest.", 1);
        expect(v2).toMatchObject({ version: 2, updatedAt: at(2) });
        expect(await storage.memory.writeContent("missing", "x", 0)).toBeNull();
      });

      it("concurrent writes at the same version: exactly one wins", async () => {
        const store = await storage.memory.ensureStore("agent-a", "memory", { capChars: 2200, autoApply: "none" });
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) => storage.memory.writeContent(store.id, `writer ${i}`, 0)),
        );
        const winners = results.filter((r) => r !== null);
        expect(winners).toHaveLength(1);
        const stored = await storage.memory.getStore("agent-a", "memory");
        expect(stored).toMatchObject({ version: 1, content: winners[0]!.content });
      });

      it("setPolicy changes capChars and autoApply but not the content or version", async () => {
        const store = await storage.memory.ensureStore("agent-a", "memory", { capChars: 2200, autoApply: "none" });
        await storage.memory.writeContent(store.id, "Fact.", 0);
        const changed = await storage.memory.setPolicy(store.id, { autoApply: "add" });
        expect(changed).toMatchObject({ capChars: 2200, autoApply: "add", content: "Fact.", version: 1 });
        expect(await storage.memory.setPolicy(store.id, { capChars: 1000 })).toMatchObject({ capChars: 1000, autoApply: "add" });
        expect(await storage.memory.setPolicy("missing", { capChars: 1 })).toBeNull();
        await expect(storage.memory.setPolicy(store.id, { autoApply: "all" as "add" })).rejects.toBeInstanceOf(StorageError);
        await expect(storage.memory.setPolicy(store.id, { capChars: -1 })).rejects.toBeInstanceOf(StorageError);
        expect((await storage.memory.getStore("agent-a", "memory"))?.autoApply).toBe("add");
      });

      it("rejects invalid store defaults and content", async () => {
        await expect(storage.memory.ensureStore("agent-a", "", { capChars: 10, autoApply: "none" })).rejects.toBeInstanceOf(
          StorageError,
        );
        await expect(
          storage.memory.ensureStore("agent-a", "memory", { capChars: 1.5, autoApply: "none" }),
        ).rejects.toBeInstanceOf(StorageError);
        const store = await storage.memory.ensureStore("agent-a", "memory", { capChars: 10, autoApply: "none" });
        await expect(storage.memory.writeContent(store.id, 42 as unknown as string, 0)).rejects.toBeInstanceOf(StorageError);
        await expect(storage.memory.writeContent(store.id, "x", -1)).rejects.toBeInstanceOf(StorageError);
      });
    });

    describe("skills", () => {
      it("create starts at version 1, active, unpinned, unused, and writes the first version row", async () => {
        const skill = await newSkill();
        expect(skill).toMatchObject({
          agentId: "agent-a",
          name: "release-notes",
          version: 1,
          status: "active",
          pinned: false,
          createdAt: at(0),
          updatedAt: at(0),
          lastUsedAt: null,
          counters: { views: 0, uses: 0, patches: 0 },
        });
        expect(await storage.skills.versions(skill.id)).toEqual([
          {
            skillId: skill.id,
            version: 1,
            description: skill.description,
            body: skill.body,
            createdAt: at(0),
            createdBy: "user:emil",
            proposalId: null,
          },
        ]);
        const pinned = await storage.skills.create({
          agentId: "agent-a",
          name: "pinned-skill",
          description: "d",
          body: "b",
          createdBy: "user:emil",
          pinned: true,
        });
        expect(pinned.pinned).toBe(true);
      });

      it("refuses a duplicate name for the same agent but allows it for another agent", async () => {
        await newSkill();
        await expect(newSkill()).rejects.toBeInstanceOf(StorageError);
        await expect(newSkill("release-notes", "agent-b")).resolves.toMatchObject({ agentId: "agent-b" });
        expect(await storage.skills.list("agent-a")).toHaveLength(1);
      });

      it("get finds by agent and name; list orders by name and filters by status", async () => {
        await newSkill("zeta");
        const alpha = await newSkill("alpha");
        await newSkill("mid");
        await newSkill("other", "agent-b");
        expect(await storage.skills.get("agent-a", "alpha")).toEqual(alpha);
        expect(await storage.skills.get("agent-b", "alpha")).toBeNull();
        expect((await storage.skills.list("agent-a")).map((s) => s.name)).toEqual(["alpha", "mid", "zeta"]);
        await storage.skills.setStatus(alpha.id, "stale");
        expect((await storage.skills.list("agent-a", { status: "stale" })).map((s) => s.name)).toEqual(["alpha"]);
        expect((await storage.skills.list("agent-a", { status: "active" })).map((s) => s.name)).toEqual(["mid", "zeta"]);
      });

      it("update writes a new version row and never overwrites history (versions are oldest first)", async () => {
        const skill = await newSkill();
        setNow(1);
        const v2 = await storage.skills.update(
          skill.id,
          { description: "Write release notes.", body: "Step one." },
          { createdBy: "review", proposalId: "p-1" },
        );
        expect(v2).toMatchObject({ version: 2, description: "Write release notes.", body: "Step one.", updatedAt: at(1) });
        setNow(2);
        await storage.skills.update(skill.id, { description: "v3", body: "Step two." }, { createdBy: "user:emil", proposalId: null });
        const versions = await storage.skills.versions(skill.id);
        expect(versions.map((v) => [v.version, v.body, v.createdBy, v.proposalId, v.createdAt])).toEqual([
          [1, "1. Read the changelog.\n2. Group by area.", "user:emil", null, at(0)],
          [2, "Step one.", "review", "p-1", at(1)],
          [3, "Step two.", "user:emil", null, at(2)],
        ]);
        expect(await storage.skills.update("missing", { description: "d", body: "b" }, { createdBy: "x", proposalId: null })).toBeNull();
        expect(await storage.skills.versions("missing")).toEqual([]);
      });

      it("concurrent updates each get their own version", async () => {
        const skill = await newSkill();
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            storage.skills.update(skill.id, { description: `d${i}`, body: `b${i}` }, { createdBy: "review", proposalId: null }),
          ),
        );
        expect(results.map((r) => r?.version).sort()).toEqual([2, 3, 4, 5, 6]);
        expect((await storage.skills.versions(skill.id)).map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6]);
      });

      it("setStatus archived keeps the skill and its history (nothing is ever deleted)", async () => {
        const skill = await newSkill();
        await storage.skills.update(skill.id, { description: "d", body: "b" }, { createdBy: "review", proposalId: null });
        const archived = await storage.skills.setStatus(skill.id, "archived");
        expect(archived).toMatchObject({ status: "archived", version: 2, updatedAt: at(0) });
        expect(await storage.skills.get("agent-a", "release-notes")).toEqual(archived);
        expect((await storage.skills.list("agent-a", { status: "archived" })).map((s) => s.id)).toEqual([skill.id]);
        expect(await storage.skills.versions(skill.id)).toHaveLength(2);
        expect(await storage.skills.setStatus(skill.id, "active")).toMatchObject({ status: "active" });
        expect(await storage.skills.setStatus("missing", "archived")).toBeNull();
        await expect(storage.skills.setStatus(skill.id, "deleted" as "archived")).rejects.toBeInstanceOf(StorageError);
      });

      it("setPinned pins and unpins", async () => {
        const skill = await newSkill();
        expect(await storage.skills.setPinned(skill.id, true)).toMatchObject({ pinned: true });
        expect(await storage.skills.setPinned(skill.id, false)).toMatchObject({ pinned: false });
        expect(await storage.skills.setPinned("missing", true)).toBeNull();
      });

      it("bump counts views, uses and patches and keeps the latest lastUsedAt", async () => {
        const skill = await newSkill();
        await storage.skills.bump(skill.id, "views", at(5));
        await storage.skills.bump(skill.id, "views", at(3));
        await storage.skills.bump(skill.id, "uses", at(4));
        await storage.skills.bump(skill.id, "patches", at(2));
        const bumped = await storage.skills.get("agent-a", "release-notes");
        expect(bumped).toMatchObject({ counters: { views: 2, uses: 1, patches: 1 }, lastUsedAt: at(5), version: 1, updatedAt: at(0) });
        await storage.skills.bump(skill.id, "uses", at(7));
        expect((await storage.skills.get("agent-a", "release-notes"))?.lastUsedAt).toBe(at(7));
      });

      it("bump of an unknown skill does nothing; an unknown counter is refused (no SQL from the caller)", async () => {
        const skill = await newSkill();
        await expect(storage.skills.bump("missing", "views", at(1))).resolves.toBeUndefined();
        const hostile = "views = 0, name = 'x' --" as "views";
        await expect(storage.skills.bump(skill.id, hostile, at(1))).rejects.toBeInstanceOf(StorageError);
        await expect(storage.skills.bump(skill.id, "views", "not a time")).rejects.toBeInstanceOf(StorageError);
        expect(await storage.skills.get("agent-a", "release-notes")).toMatchObject({
          name: "release-notes",
          counters: { views: 0, uses: 0, patches: 0 },
        });
      });
    });

    describe("proposals", () => {
      it("create fills in defaults: pending, undecided, unscored, not shadow, createdAt now", async () => {
        const proposal = await storage.proposals.create(proposalInput());
        expect(proposal).toMatchObject<Partial<ProposalRecord>>({
          agentId: "agent-a",
          sessionId: null,
          kind: "memory",
          target: "memory",
          status: "pending",
          createdBy: "review",
          createdAt: at(0),
          decidedAt: null,
          decidedBy: null,
          decisionNote: null,
          score: null,
          shadow: false,
        });
        expect(proposal.payload).toEqual(proposalInput().payload);
        expect(proposal.evidence).toEqual(proposalInput().evidence);
        expect(await storage.proposals.get(proposal.id)).toEqual(proposal);
        const shadow = await storage.proposals.create(
          proposalInput({ id: "p-shadow", shadow: true, kind: "action", target: "send_reply", payload: { kind: "action", tool: "send_reply", input: { to: "x" }, draftText: "Hi" } }),
        );
        expect(shadow).toMatchObject({ id: "p-shadow", shadow: true, kind: "action" });
      });

      it("create refuses a duplicate id, an invalid kind and a payload of another kind", async () => {
        await storage.proposals.create(proposalInput({ id: "p-1" }));
        await expect(storage.proposals.create(proposalInput({ id: "p-1" }))).rejects.toBeInstanceOf(StorageError);
        await expect(storage.proposals.create(proposalInput({ kind: "bogus" as "memory" }))).rejects.toBeInstanceOf(StorageError);
        await expect(storage.proposals.create(proposalInput({ kind: "skill" }))).rejects.toBeInstanceOf(StorageError);
        expect(await storage.proposals.list()).toHaveLength(1);
      });

      it("get returns null when missing; list is newest first with agent, status, kind and session filters", async () => {
        expect(await storage.proposals.get("missing")).toBeNull();
        await storage.proposals.create(proposalInput({ id: "p-old" }));
        setNow(1);
        await storage.proposals.create(proposalInput({ id: "p-session", sessionId: "s-1" }));
        setNow(2);
        await storage.proposals.create(
          proposalInput({ id: "p-skill", kind: "skill", target: "release-notes", payload: { kind: "skill", skill: "release-notes", changes: [] } }),
        );
        setNow(3);
        await storage.proposals.create(proposalInput({ id: "p-other", agentId: "agent-b" }));
        await storage.proposals.transition("p-old", ["pending"], "rejected", { at: at(4), by: "user:emil" });
        const ids = async (options?: Parameters<Storage["proposals"]["list"]>[0]) =>
          (await storage.proposals.list(options)).map((p) => p.id);
        expect(await ids()).toEqual(["p-other", "p-skill", "p-session", "p-old"]);
        expect(await ids({ agentId: "agent-a" })).toEqual(["p-skill", "p-session", "p-old"]);
        expect(await ids({ status: "pending", agentId: "agent-a" })).toEqual(["p-skill", "p-session"]);
        expect(await ids({ kind: "skill" })).toEqual(["p-skill"]);
        expect(await ids({ sessionId: "s-1" })).toEqual(["p-session"]);
        expect(await ids({ limit: 2 })).toEqual(["p-other", "p-skill"]);
      });

      it("list keeps the newest-created first when createdAt is equal", async () => {
        for (const id of ["one", "two", "three"]) await storage.proposals.create(proposalInput({ id }));
        expect((await storage.proposals.list()).map((p) => p.id)).toEqual(["three", "two", "one"]);
      });

      it("transition is compare-and-set: a second approve returns null and applying twice is impossible", async () => {
        const p = await storage.proposals.create(proposalInput());
        const approved = await storage.proposals.transition(p.id, ["pending"], "approved", {
          at: at(1),
          by: "user:emil",
          note: "Looks right.",
        });
        expect(approved).toMatchObject({ status: "approved", decidedAt: at(1), decidedBy: "user:emil", decisionNote: "Looks right." });
        expect(await storage.proposals.transition(p.id, ["pending"], "approved", { at: at(2), by: "user:other" })).toBeNull();
        const applied = await storage.proposals.transition(p.id, ["approved"], "applied", { at: at(3), by: "system" });
        expect(applied).toMatchObject({ status: "applied", decidedAt: at(3), decidedBy: "system", decisionNote: "Looks right." });
        expect(await storage.proposals.transition(p.id, ["approved"], "applied", { at: at(4), by: "system" })).toBeNull();
        expect(await storage.proposals.get(p.id)).toEqual(applied);
      });

      it("concurrent approvals: exactly one wins", async () => {
        const p = await storage.proposals.create(proposalInput());
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            storage.proposals.transition(p.id, ["pending"], "approved", { at: at(1), by: `user:${i}` }),
          ),
        );
        const winners = results.filter((r) => r !== null);
        expect(winners).toHaveLength(1);
        expect((await storage.proposals.get(p.id))?.decidedBy).toBe(winners[0]!.decidedBy);
      });

      it("transition accepts several from-statuses, can clear the note, and returns null for none or an unknown id", async () => {
        const p = await storage.proposals.create(proposalInput());
        await storage.proposals.transition(p.id, ["pending"], "approved", { at: at(1), by: "u", note: "n" });
        const expired = await storage.proposals.transition(p.id, ["pending", "approved"], "expired", {
          at: at(2),
          by: "system",
          note: null,
        });
        expect(expired).toMatchObject({ status: "expired", decisionNote: null });
        expect(await storage.proposals.transition(p.id, [], "pending", { at: at(3), by: "u" })).toBeNull();
        expect(await storage.proposals.transition("missing", ["pending"], "approved", { at: at(3), by: "u" })).toBeNull();
        await expect(
          storage.proposals.transition(p.id, ["expired"], "done" as "applied", { at: at(3), by: "u" }),
        ).rejects.toBeInstanceOf(StorageError);
        await expect(
          storage.proposals.transition(p.id, ["expired"], "pending", { at: "soon", by: "u" }),
        ).rejects.toBeInstanceOf(StorageError);
        expect((await storage.proposals.get(p.id))?.status).toBe("expired");
      });

      it("setScore records a shadow-mode score", async () => {
        const p = await storage.proposals.create(proposalInput({ shadow: true }));
        expect(await storage.proposals.setScore(p.id, "small_edit")).toMatchObject({ score: "small_edit", status: "pending" });
        expect(await storage.proposals.setScore("missing", "as_is")).toBeNull();
        await expect(storage.proposals.setScore(p.id, "great" as "as_is")).rejects.toBeInstanceOf(StorageError);
      });
    });

    describe("audit", () => {
      it("append keeps the entry as given (with a new id unless one is given); list is newest first", async () => {
        const first = await storage.audit.append({
          at: at(1),
          actor: "user:emil",
          action: "mode.set",
          target: "agent-a",
          details: { from: "shadow", to: "supervised", nested: { list: [1, "two"] } },
        });
        expect(first).toMatchObject({ at: at(1), actor: "user:emil", action: "mode.set", target: "agent-a" });
        expect(first.details).toEqual({ from: "shadow", to: "supervised", nested: { list: [1, "two"] } });
        const given = await storage.audit.append({ id: "a-given", at: at(3), actor: "system", action: "proposal.apply", target: "p-1", details: {} });
        expect(given.id).toBe("a-given");
        await storage.audit.append({ at: at(2), actor: "review", action: "proposal.create", target: "p-1", details: {} });
        expect((await storage.audit.list()).map((e) => e.at)).toEqual([at(3), at(2), at(1)]);
      });

      it("list filters by target, actor and action and honours limit", async () => {
        await storage.audit.append({ at: at(1), actor: "review", action: "proposal.create", target: "p-1", details: {} });
        await storage.audit.append({ at: at(2), actor: "user:emil", action: "proposal.approve", target: "p-1", details: {} });
        await storage.audit.append({ at: at(3), actor: "user:emil", action: "mode.set", target: "agent-a", details: {} });
        const actions = async (options?: Parameters<Storage["audit"]["list"]>[0]) =>
          (await storage.audit.list(options)).map((e) => e.action);
        expect(await actions({ target: "p-1" })).toEqual(["proposal.approve", "proposal.create"]);
        expect(await actions({ actor: "user:emil" })).toEqual(["mode.set", "proposal.approve"]);
        expect(await actions({ action: "mode.set" })).toEqual(["mode.set"]);
        expect(await actions({ actor: "user:emil", target: "p-1" })).toEqual(["proposal.approve"]);
        expect(await actions({ limit: 1 })).toEqual(["mode.set"]);
      });

      it("refuses a duplicate id and keeps the first entry unchanged", async () => {
        await storage.audit.append({ id: "a-1", at: at(1), actor: "system", action: "first", target: "t", details: {} });
        await expect(
          storage.audit.append({ id: "a-1", at: at(2), actor: "attacker", action: "overwrite", target: "t", details: {} }),
        ).rejects.toBeInstanceOf(StorageError);
        expect((await storage.audit.list()).map((e) => [e.id, e.action])).toEqual([["a-1", "first"]]);
      });
    });

    describe("costs", () => {
      it("add stores a cost; list is newest first with agent and session filters", async () => {
        const first = await storage.costs.add(costInput({ at: at(1), sessionId: "s-1" }));
        expect(first).toMatchObject({ ...costInput({ at: at(1), sessionId: "s-1" }) });
        await storage.costs.add(costInput({ at: at(3), purpose: "review", model: "claude-haiku-5-5" }));
        await storage.costs.add(costInput({ at: at(2), agentId: "agent-b" }));
        expect((await storage.costs.list()).map((c) => c.at)).toEqual([at(3), at(2), at(1)]);
        expect((await storage.costs.list({ agentId: "agent-a" })).map((c) => c.at)).toEqual([at(3), at(1)]);
        expect((await storage.costs.list({ sessionId: "s-1" })).map((c) => c.id)).toEqual([first.id]);
        expect(await storage.costs.list({ limit: 1 })).toHaveLength(1);
      });

      it("sum adds one agent's costs since a time (inclusive) and is 0 when there are none", async () => {
        expect(await storage.costs.sum({ agentId: "agent-a", since: at(0) })).toBe(0);
        await storage.costs.add(costInput({ at: at(-60), costUsd: 100 }));
        await storage.costs.add(costInput({ at: at(0), costUsd: 0.1 }));
        await storage.costs.add(costInput({ at: at(10), costUsd: 0.2 }));
        await storage.costs.add(costInput({ at: at(5), agentId: "agent-b", costUsd: 50 }));
        expect(await storage.costs.sum({ agentId: "agent-a", since: at(0) })).toBeCloseTo(0.3, 10);
        expect(await storage.costs.sum({ agentId: "agent-a", since: at(10) })).toBeCloseTo(0.2, 10);
        expect(await storage.costs.sum({ agentId: "agent-a", since: at(11) })).toBe(0);
        expect(await storage.costs.sum({ agentId: "agent-a", since: "2026-11-01" })).toBeCloseTo(100.3, 10);
        expect(await storage.costs.sum({ agentId: "agent-b", since: at(0) })).toBe(50);
      });

      it("rejects negative or non-finite amounts and an unknown purpose", async () => {
        await expect(storage.costs.add(costInput({ costUsd: -1 }))).rejects.toBeInstanceOf(StorageError);
        await expect(storage.costs.add(costInput({ inputTokens: Number.NaN }))).rejects.toBeInstanceOf(StorageError);
        await expect(storage.costs.add(costInput({ outputTokens: 1.5 }))).rejects.toBeInstanceOf(StorageError);
        await expect(storage.costs.add(costInput({ purpose: "fun" as "main" }))).rejects.toBeInstanceOf(StorageError);
        expect(await storage.costs.list()).toEqual([]);
      });
    });

    describe("jobs", () => {
      it("upsert creates an enabled job that has never run and is not leased", async () => {
        const job = await storage.jobs.upsert(jobInput());
        expect(job).toEqual<JobRecord>({
          id: job.id,
          agentId: "agent-a",
          name: "morning-brief",
          schedule: "0 7 * * *",
          timeZone: "Europe/Stockholm",
          prompt: "Summarise today's calendar.",
          skills: [],
          preStep: null,
          deliver: "inapp:owner",
          enabled: true,
          nextRunAt: null,
          lastRunAt: null,
          lastStatus: null,
          lastError: null,
          failures: 0,
          lockedUntil: null,
          lockedBy: null,
        });
        expect(await storage.jobs.get(job.id)).toEqual(job);
        expect(await storage.jobs.get("missing")).toBeNull();
      });

      it("upsert by id updates the given fields and keeps run state; without an id it matches by agent and name", async () => {
        const job = await storage.jobs.upsert(jobInput({ id: "j-1", skills: ["calendar"], nextRunAt: at(0) }));
        await storage.jobs.claimDue(at(0), { leaseMs: 60_000, worker: "w" });
        await storage.jobs.finish("j-1", { lastRunAt: at(0), lastStatus: "error", lastError: "boom", nextRunAt: at(5), failures: 1 });
        const updated = await storage.jobs.upsert({ ...jobInput(), id: "j-1", prompt: "New prompt", preStep: "fetch-calendar" });
        expect(updated).toMatchObject({
          id: job.id,
          prompt: "New prompt",
          preStep: "fetch-calendar",
          skills: ["calendar"],
          nextRunAt: at(5),
          lastStatus: "error",
          lastError: "boom",
          failures: 1,
        });
        const byName = await storage.jobs.upsert(jobInput({ schedule: "30 6 * * 1-5", enabled: false }));
        expect(byName).toMatchObject({ id: "j-1", schedule: "30 6 * * 1-5", enabled: false, prompt: "Summarise today's calendar." });
        expect(await storage.jobs.list()).toHaveLength(1);
      });

      it("upsert refuses to give a second job the same agent and name", async () => {
        await storage.jobs.upsert(jobInput({ id: "j-1" }));
        await storage.jobs.upsert(jobInput({ id: "j-2", name: "evening" }));
        await expect(storage.jobs.upsert(jobInput({ id: "j-3" }))).rejects.toBeInstanceOf(StorageError);
        await expect(storage.jobs.upsert(jobInput({ id: "j-2" }))).rejects.toBeInstanceOf(StorageError);
        expect((await storage.jobs.list()).map((j) => [j.id, j.name])).toEqual([
          ["j-2", "evening"],
          ["j-1", "morning-brief"],
        ]);
        await expect(storage.jobs.upsert(jobInput({ skills: [""] }))).rejects.toBeInstanceOf(StorageError);
        await expect(storage.jobs.upsert(jobInput({ nextRunAt: "tomorrow" }))).rejects.toBeInstanceOf(StorageError);
      });

      it("list orders by name and filters by agent", async () => {
        await storage.jobs.upsert(jobInput({ name: "zeta" }));
        await storage.jobs.upsert(jobInput({ name: "alpha" }));
        await storage.jobs.upsert(jobInput({ name: "beta", agentId: "agent-b" }));
        expect((await storage.jobs.list()).map((j) => j.name)).toEqual(["alpha", "beta", "zeta"]);
        expect((await storage.jobs.list({ agentId: "agent-a" })).map((j) => j.name)).toEqual(["alpha", "zeta"]);
      });

      it("claimDue leases only enabled, due jobs that are not leased or whose lease expired", async () => {
        await storage.jobs.upsert(jobInput({ name: "expired-lease", nextRunAt: at(-30) }));
        await storage.jobs.claimDue(at(-30), { leaseMs: 29 * 60_000, worker: "old-worker" });
        await storage.jobs.upsert(jobInput({ name: "leased", nextRunAt: at(-20) }));
        expect((await storage.jobs.claimDue(at(-20), { leaseMs: 25 * 60_000, worker: "other" })).map((j) => j.name)).toEqual([
          "leased",
        ]);
        await storage.jobs.upsert(jobInput({ name: "due", nextRunAt: at(-10) }));
        await storage.jobs.upsert(jobInput({ name: "due-exactly-now", nextRunAt: at(0) }));
        await storage.jobs.upsert(jobInput({ name: "future", nextRunAt: at(10) }));
        await storage.jobs.upsert(jobInput({ name: "disabled", nextRunAt: at(-10), enabled: false }));
        await storage.jobs.upsert(jobInput({ name: "no-next-run", nextRunAt: null }));

        const claimed = await storage.jobs.claimDue(at(0), { leaseMs: 60_000, worker: "w1" });
        expect(claimed.map((j) => j.name)).toEqual(["expired-lease", "due", "due-exactly-now"]);
        for (const job of claimed) expect(job).toMatchObject({ lockedBy: "w1", lockedUntil: at(1) });
        expect(await storage.jobs.claimDue(at(0), { leaseMs: 60_000, worker: "w2" })).toEqual([]);
        expect((await storage.jobs.get(claimed[0]!.id))?.lockedBy).toBe("w1");

        const later = await storage.jobs.claimDue(at(5), { leaseMs: 60_000, worker: "w3" });
        expect(later.map((j) => j.name)).toEqual(["expired-lease", "leased", "due", "due-exactly-now"]);
      });

      it("claimDue honours limit (default 10) and takes the most overdue first", async () => {
        for (let i = 0; i < 12; i++) {
          await storage.jobs.upsert(jobInput({ name: `job-${String(i).padStart(2, "0")}`, nextRunAt: at(-i) }));
        }
        const two = await storage.jobs.claimDue(at(0), { leaseMs: 1_000, worker: "w", limit: 2 });
        expect(two.map((j) => j.name)).toEqual(["job-11", "job-10"]);
        expect(await storage.jobs.claimDue(at(0), { leaseMs: 1_000, worker: "w", limit: 0 })).toEqual([]);
        expect(await storage.jobs.claimDue(at(0), { leaseMs: 1_000, worker: "w" })).toHaveLength(10);
        await expect(storage.jobs.claimDue(at(0), { leaseMs: 0, worker: "w" })).rejects.toBeInstanceOf(StorageError);
        await expect(storage.jobs.claimDue(at(0), { leaseMs: 1_000, worker: "" })).rejects.toBeInstanceOf(StorageError);
        await expect(storage.jobs.claimDue("now", { leaseMs: 1_000, worker: "w" })).rejects.toBeInstanceOf(StorageError);
      });

      it("two concurrent claimers never get the same job", async () => {
        for (let i = 0; i < 20; i++) await storage.jobs.upsert(jobInput({ name: `job-${i}`, nextRunAt: at(-1) }));
        const [a, b] = await Promise.all([
          storage.jobs.claimDue(at(0), { leaseMs: 60_000, worker: "w1", limit: 20 }),
          storage.jobs.claimDue(at(0), { leaseMs: 60_000, worker: "w2", limit: 20 }),
        ]);
        const idsA = new Set(a.map((j) => j.id));
        expect(b.filter((j) => idsA.has(j.id))).toEqual([]);
        expect(idsA.size + b.length).toBe(20);
        for (const job of a) expect(job.lockedBy).toBe("w1");
        for (const job of b) expect(job.lockedBy).toBe("w2");
        for (const job of await storage.jobs.list()) expect(job.lockedBy).toBe(idsA.has(job.id) ? "w1" : "w2");

        const many = await Promise.all(
          ["x1", "x2", "x3", "x4"].map((worker) => storage.jobs.claimDue(at(2), { leaseMs: 60_000, worker, limit: 5 })),
        );
        const all = many.flat().map((j) => j.id);
        expect(new Set(all).size).toBe(all.length);
        expect(all.length).toBe(20);
      });

      it("finish records the outcome and releases the lease", async () => {
        const job = await storage.jobs.upsert(jobInput({ nextRunAt: at(0) }));
        await storage.jobs.claimDue(at(0), { leaseMs: 600_000, worker: "w1" });
        const done = await storage.jobs.finish(job.id, {
          lastRunAt: at(0),
          lastStatus: "silent",
          lastError: null,
          nextRunAt: at(60),
          failures: 0,
        });
        expect(done).toMatchObject({ lastRunAt: at(0), lastStatus: "silent", nextRunAt: at(60), lockedUntil: null, lockedBy: null });
        expect(await storage.jobs.claimDue(at(30), { leaseMs: 1_000, worker: "w2" })).toEqual([]);
        expect((await storage.jobs.claimDue(at(60), { leaseMs: 1_000, worker: "w2" })).map((j) => j.id)).toEqual([job.id]);
        expect(
          await storage.jobs.finish("missing", { lastRunAt: null, lastStatus: null, lastError: null, nextRunAt: null, failures: 0 }),
        ).toBeNull();
        await expect(
          storage.jobs.finish(job.id, { lastRunAt: at(0), lastStatus: "great" as "ok", lastError: null, nextRunAt: null, failures: 0 }),
        ).rejects.toBeInstanceOf(StorageError);
      });

      it("setEnabled turns a job off and on; a disabled job is never claimed", async () => {
        const job = await storage.jobs.upsert(jobInput({ nextRunAt: at(-1) }));
        expect(await storage.jobs.setEnabled(job.id, false)).toMatchObject({ enabled: false });
        expect(await storage.jobs.claimDue(at(0), { leaseMs: 1_000, worker: "w" })).toEqual([]);
        expect(await storage.jobs.setEnabled(job.id, true)).toMatchObject({ enabled: true });
        expect(await storage.jobs.claimDue(at(0), { leaseMs: 1_000, worker: "w" })).toHaveLength(1);
        expect(await storage.jobs.setEnabled("missing", true)).toBeNull();
      });
    });

    describe("deliveries", () => {
      const delivery = (overrides: Partial<Parameters<Storage["deliveries"]["add"]>[0]> = {}) => ({
        channel: "inapp",
        target: "inapp:owner",
        title: "Morning brief",
        body: "Three meetings today.",
        url: null,
        jobId: null,
        ...overrides,
      });

      it("add queues a delivery with createdAt now and no error", async () => {
        const added = await storage.deliveries.add(delivery({ url: "/today", jobId: "j-1" }));
        expect(added).toMatchObject({
          channel: "inapp",
          target: "inapp:owner",
          title: "Morning brief",
          body: "Three meetings today.",
          url: "/today",
          jobId: "j-1",
          createdAt: at(0),
          status: "queued",
          error: null,
        });
        expect((await storage.deliveries.add(delivery({ id: "d-given" }))).id).toBe("d-given");
        await expect(storage.deliveries.add(delivery({ id: "d-given" }))).rejects.toBeInstanceOf(StorageError);
      });

      it("mark sets the status and error; marking again without an error clears it", async () => {
        const added = await storage.deliveries.add(delivery());
        expect(await storage.deliveries.mark(added.id, "failed", "410 Gone")).toMatchObject({ status: "failed", error: "410 Gone" });
        expect(await storage.deliveries.mark(added.id, "sent")).toMatchObject({ status: "sent", error: null });
        expect(await storage.deliveries.mark("missing", "sent")).toBeNull();
        await expect(storage.deliveries.mark(added.id, "lost" as "sent")).rejects.toBeInstanceOf(StorageError);
      });

      it("list is newest first and filters by target, channel and since (inclusive)", async () => {
        await storage.deliveries.add(delivery({ id: "d-1" }));
        setNow(1);
        await storage.deliveries.add(delivery({ id: "d-2", channel: "webpush", target: "webpush:owner" }));
        setNow(2);
        await storage.deliveries.add(delivery({ id: "d-3" }));
        const ids = async (options: Parameters<Storage["deliveries"]["list"]>[0]) =>
          (await storage.deliveries.list(options)).map((d) => d.id);
        expect(await ids({})).toEqual(["d-3", "d-2", "d-1"]);
        expect(await ids({ target: "inapp:owner" })).toEqual(["d-3", "d-1"]);
        expect(await ids({ channel: "webpush" })).toEqual(["d-2"]);
        expect(await ids({ since: at(1) })).toEqual(["d-3", "d-2"]);
        expect(await ids({ since: at(1), target: "inapp:owner" })).toEqual(["d-3"]);
        expect(await ids({ limit: 1 })).toEqual(["d-3"]);
      });
    });

    describe("times", () => {
      it("returns every time in toISOString() format and normalises offsets to UTC", async () => {
        const session = await newSession({ startedAt: "2026-11-05T09:30:00.5+01:00" });
        expect(session.startedAt).toBe("2026-11-05T08:30:00.500Z");
        const entry = await storage.audit.append({ at: "2026-11-05", actor: "system", action: "a", target: "t", details: {} });
        expect(entry.at).toBe("2026-11-05T00:00:00.000Z");
        const records: unknown[] = [
          session.startedAt,
          entry.at,
          (await storage.agents.upsert({ id: "agent-a", name: "A" })).createdAt,
          (await storage.memory.ensureStore("agent-a", "memory", { capChars: 1, autoApply: "none" })).updatedAt,
          (await newSkill()).createdAt,
          (await storage.proposals.create(proposalInput())).createdAt,
          (await storage.deliveries.add({ channel: "c", target: "t", title: "", body: "", url: null, jobId: null })).createdAt,
        ];
        for (const value of records) expect(isIso(value), String(value)).toBe(true);
      });

      it("refuses times that are not ISO 8601 with a zone", async () => {
        for (const bad of ["2026-11-05T10:00:00", "05/11/2026", "Nov 5 2026", "2026-02-30", "2026-11-05T25:00:00Z", "", "now"]) {
          await expect(
            storage.audit.append({ at: bad, actor: "system", action: "a", target: "t", details: {} }),
            bad,
          ).rejects.toBeInstanceOf(StorageError);
        }
        expect(await storage.audit.list()).toEqual([]);
      });
    });

    describe("copies: callers can never change stored state through objects", () => {
      it("mutating returned records does not change storage", async () => {
        const agent = await storage.agents.upsert({ id: "agent-a", name: "A" });
        agent.name = "mutated";
        const session = await newSession({ meta: { list: [1] } });
        (session.meta.list as number[]).push(2);
        session.counters.userTurns = 99;
        const message = await storage.messages.append(session.id, textMessage("hello world"));
        (message.content as Array<{ text: string }>)[0]!.text = "mutated";
        const store = await storage.memory.ensureStore("agent-a", "memory", { capChars: 10, autoApply: "none" });
        store.content = "mutated";
        const skill = await newSkill();
        skill.counters.views = 99;
        const proposal = await storage.proposals.create(proposalInput());
        (proposal.evidence as unknown[]).push("forged");
        (proposal.payload as { store: string }).store = "user";
        const entry = await storage.audit.append({ at: at(0), actor: "a", action: "b", target: "c", details: { x: 1 } });
        entry.details.x = 2;
        const job = await storage.jobs.upsert(jobInput({ skills: ["one"] }));
        job.skills.push("two");

        const fetched = await Promise.all([
          storage.agents.get("agent-a"),
          storage.sessions.get(session.id),
          storage.messages.get(message.id),
          storage.memory.getStore("agent-a", "memory"),
          storage.skills.get("agent-a", skill.name),
          storage.proposals.get(proposal.id),
          storage.audit.list(),
          storage.jobs.get(job.id),
        ]);
        const [a, s, m, st, sk, p, au, j] = fetched;
        expect(a?.name).toBe("A");
        expect(s?.meta).toEqual({ list: [1] });
        expect(s?.counters.userTurns).toBe(0);
        expect(m?.content).toEqual([{ type: "text", text: "hello world" }]);
        expect(st?.content).toBe("");
        expect(sk?.counters.views).toBe(0);
        expect(p?.evidence).toEqual(proposalInput().evidence);
        expect(p?.payload).toEqual(proposalInput().payload);
        expect(au?.[0]?.details).toEqual({ x: 1 });
        expect(j?.skills).toEqual(["one"]);

        // Mutating a fetched copy does not change the next fetch either.
        s!.meta.list = "mutated again";
        (await storage.skills.versions(skill.id))[0]!.body = "mutated";
        (await storage.messages.list(session.id))[0]!.text = "mutated";
        (await storage.jobs.list())[0]!.skills.push("three");
        expect((await storage.sessions.get(session.id))?.meta).toEqual({ list: [1] });
        expect((await storage.skills.versions(skill.id))[0]?.body).toBe(skill.body);
        expect((await storage.messages.list(session.id))[0]?.text).toBe("hello world");
        expect((await storage.jobs.list())[0]?.skills).toEqual(["one"]);
      });

      it("mutating input objects after a write does not change storage", async () => {
        const meta = { tags: ["a"] };
        const session = await newSession({ meta });
        meta.tags.push("b");
        const content = [{ type: "text" as const, text: "original" }];
        const message = await storage.messages.append(session.id, { role: "user", content, text: "original" });
        content[0]!.text = "changed";
        const input = proposalInput();
        const proposal = await storage.proposals.create(input);
        (input.evidence[0] as { quote?: string }).quote = "changed";
        const details = { level: 1 };
        await storage.audit.append({ at: at(0), actor: "a", action: "b", target: "c", details });
        details.level = 2;
        const skills = ["one"];
        const job = await storage.jobs.upsert(jobInput({ skills }));
        skills.push("two");

        expect((await storage.sessions.get(session.id))?.meta).toEqual({ tags: ["a"] });
        expect((await storage.messages.get(message.id))?.content).toEqual([{ type: "text", text: "original" }]);
        expect((await storage.proposals.get(proposal.id))?.evidence).toEqual([{ kind: "message", ref: "m-1", quote: "we use pnpm" }]);
        expect((await storage.audit.list())[0]?.details).toEqual({ level: 1 });
        expect((await storage.jobs.get(job.id))?.skills).toEqual(["one"]);
      });

      it("JSON fields hold what a JSON round trip keeps (dates as strings, undefined dropped)", async () => {
        const session = await newSession({ meta: { when: new Date(T0), gone: undefined, n: 1 } as Record<string, unknown> });
        expect(session.meta).toEqual({ when: at(0), n: 1 });
        expect(await storage.sessions.get(session.id)).toEqual(session);
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        await expect(newSession({ meta: circular })).rejects.toBeInstanceOf(StorageError);
      });
    });
  });
}
