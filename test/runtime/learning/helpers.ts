/** Shared setup for the LEARNING tests: in-memory storage, the knowledge services and a finished conversation. */
import { MemoryService } from "../../../src/memory/index.js";
import { ProposalService } from "../../../src/proposals/index.js";
import { SkillService } from "../../../src/skills/index.js";
import { createMemoryStorage } from "../../../src/storage/index.js";
import type { RecordedRequest } from "../../../src/testing/index.js";
import type { AgentMode, MessageRecord, SessionRecord, Storage } from "../../../src/types.js";

export const AGENT = "agent-1";
export const START = new Date("2026-11-05T10:00:00.000Z");
export const DAY_MS = 86_400_000;

export interface Setup {
  storage: Storage;
  memory: MemoryService;
  skills: SkillService;
  proposals: ProposalService;
  now(): Date;
  set(time: Date | number): void;
  tick(ms?: number): void;
}

export async function setup(mode: AgentMode = "autonomous"): Promise<Setup> {
  let time = START.getTime();
  const now = () => new Date(time);
  const storage = createMemoryStorage({ now });
  await storage.migrate();
  await storage.agents.upsert({ id: AGENT, name: "Notes helper", mode });
  const memory = new MemoryService({ storage, now });
  const skills = new SkillService({ storage, now });
  const proposals = new ProposalService({ storage, memory, skills, now });
  await memory.ensureStores(AGENT);
  return {
    storage,
    memory,
    skills,
    proposals,
    now,
    set: (t) => void (time = typeof t === "number" ? t : t.getTime()),
    tick: (ms = 1000) => void (time += ms),
  };
}

export interface Conversation {
  session: SessionRecord;
  userPreference: MessageRecord;
  assistantReply: MessageRecord;
  toolResult: MessageRecord;
  userOneOff: MessageRecord;
}

/** A finished chat: a stated preference, an answer, a tool result and a one-off request. */
export async function conversation(storage: Storage): Promise<Conversation> {
  const session = await storage.sessions.create({ agentId: AGENT, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
  const userText = "Please convert 5 miles. I always want metric units in answers.";
  const userPreference = await storage.messages.append(session.id, {
    role: "user",
    content: [{ type: "text", text: userText }],
    text: userText,
  });
  const assistantReply = await storage.messages.append(session.id, {
    role: "assistant",
    content: [{ type: "text", text: "5 miles is about 8 kilometres." }],
    text: "5 miles is about 8 kilometres.",
  });
  const resultText = "[tool result notes_read] The project notes live in the docs folder.";
  const toolResult = await storage.messages.append(session.id, {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "The project notes live in the docs folder." }],
    text: resultText,
  });
  const oneOffText = "Make this one shorter.";
  const userOneOff = await storage.messages.append(session.id, {
    role: "user",
    content: [{ type: "text", text: oneOffText }],
    text: oneOffText,
  });
  await storage.sessions.update(session.id, {
    status: "done",
    counters: { userTurns: 2, toolIterations: 1, lastMemoryReviewTurn: 0, lastSkillReviewIteration: 0 },
  });
  return { session: (await storage.sessions.get(session.id)) as SessionRecord, userPreference, assistantReply, toolResult, userOneOff };
}

/** The tool_result texts the model saw in a recorded request (the last user message). */
export function toolResultTexts(request: RecordedRequest | undefined): string[] {
  const last = request?.messages.at(-1);
  if (!last || !Array.isArray(last.content)) return [];
  const out: string[] = [];
  for (const block of last.content) {
    if (block.type !== "tool_result") continue;
    const content = block.content;
    if (typeof content === "string") out.push(content);
    else if (Array.isArray(content)) for (const part of content) if (part.type === "text") out.push(part.text);
  }
  return out;
}
