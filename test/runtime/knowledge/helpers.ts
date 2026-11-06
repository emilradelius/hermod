/** Shared setup for the knowledge tests: in-memory storage, the three services, a session with messages. */
import { MemoryService } from "../../../src/memory/index.js";
import { ProposalService } from "../../../src/proposals/index.js";
import { SkillService } from "../../../src/skills/index.js";
import { createMemoryStorage } from "../../../src/storage/index.js";
import type { AgentMode, MessageRecord, ProposalRecord, SessionRecord, Storage, ToolContext } from "../../../src/types.js";

export const AGENT = "agent-1";
export const OTHER_AGENT = "agent-2";
export const START = new Date("2026-11-05T10:00:00.000Z");

export interface Setup {
  storage: Storage;
  memory: MemoryService;
  skills: SkillService;
  proposals: ProposalService;
  executed: Array<{ payload: unknown; proposal: ProposalRecord }>;
  tick(ms?: number): void;
  now(): Date;
}

export function setup(options: { storage?: Storage; executeAction?: boolean; failAction?: boolean } = {}): Setup {
  let time = START.getTime();
  const now = () => new Date(time);
  const storage = options.storage ?? createMemoryStorage({ now });
  const memory = new MemoryService({ storage, now });
  const skills = new SkillService({ storage, now });
  const executed: Setup["executed"] = [];
  const proposals = new ProposalService({
    storage,
    memory,
    skills,
    now,
    ...(options.executeAction
      ? {
          executeAction: async (payload, proposal) => {
            if (options.failAction) throw new Error("the app could not run it");
            executed.push({ payload, proposal });
            return { ok: true };
          },
        }
      : {}),
  });
  return { storage, memory, skills, proposals, executed, now, tick: (ms = 1000) => void (time += ms) };
}

export async function makeSession(
  storage: Storage,
  agentId = AGENT,
  memorySnapshot = "",
): Promise<SessionRecord> {
  return storage.sessions.create({ agentId, kind: "chat", attended: true, memorySnapshot, skillsIndex: "" });
}

export async function say(
  storage: Storage,
  sessionId: string,
  text: string,
  role: MessageRecord["role"] = "user",
): Promise<MessageRecord> {
  return storage.messages.append(sessionId, { role, content: text, text });
}

export function ctx(
  storage: Storage,
  session: Pick<SessionRecord, "id" | "agentId">,
  overrides: Partial<{ mode: AgentMode; attended: boolean; tainted: boolean }> = {},
): ToolContext {
  return {
    agentId: session.agentId,
    sessionId: session.id,
    mode: overrides.mode ?? "autonomous",
    attended: overrides.attended ?? true,
    tainted: overrides.tainted ?? false,
    storage,
    now: () => START,
    newId: () => "id-" + Math.random().toString(36).slice(2),
    async audit() {},
  };
}

/** A storage whose memory.writeContent loses the race once: another writer adds `entry` just before our write. */
export function racingStorage(base: Storage, entry: string, times = 1): Storage {
  let left = times;
  const memory: Storage["memory"] = {
    ...base.memory,
    async writeContent(id, content, expectedVersion) {
      if (left > 0) {
        left--;
        const stores = await Promise.all([AGENT, OTHER_AGENT].map((a) => base.memory.listStores(a)));
        const store = stores.flat().find((s) => s.id === id);
        if (store) {
          const next = store.content === "" ? entry : `${store.content}\n§\n${entry}`;
          await base.memory.writeContent(id, next, store.version);
        }
      }
      return base.memory.writeContent(id, content, expectedVersion);
    },
  };
  return { ...base, memory };
}
