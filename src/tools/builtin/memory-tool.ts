/**
 * The `memory` tool: batch add / patch / remove on a bounded memory store, through MemoryService. It applies at once
 * only when the store's owner allows add-only writes, the batch only adds, the run is attended (a person is in the
 * chat) and the session is clean (no untrusted text); otherwise it creates a proposal. Unattended runs (scheduled
 * jobs) always propose: stricter than before, when an unattended add-only batch applied directly. It never changes
 * the running session's memory snapshot.
 */
import { z } from "zod";
import type { MemoryService } from "../../memory/memory.js";
import type { Evidence, MemoryOp, ToolDef } from "../../types.js";
import { markKnowledgeTool } from "../knowledge-mark.js";

const text = (max: number) => z.string().min(1).max(max);

export const memoryOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), text: text(500).describe("The new entry: one short declarative fact.") }),
  z.object({
    op: z.literal("patch"),
    old: text(500).describe("The entry to replace: the whole entry, or a part of it that occurs in no other entry."),
    new: text(500).describe("The full new entry that replaces it."),
  }),
  z.object({
    op: z.literal("remove"),
    old: text(500).describe("The entry to remove: the whole entry, or a part of it that occurs in no other entry."),
  }),
]);

export const memoryToolInput = z.object({
  store: text(64).describe('"memory" (environment and project facts), "user" (facts about the user), or another store.'),
  ops: z.array(memoryOpSchema).min(1).max(10).describe("Applied together: all or nothing."),
  evidence: z
    .array(
      z.object({
        messageId: text(200).describe("Id of the message that shows the fact."),
        quote: text(300).describe("Words copied exactly from that message."),
      }),
    )
    .max(10)
    .optional(),
  rationale: z.string().max(1000).optional().describe("Why this is worth remembering (shown to the person who approves)."),
});

export const MEMORY_TOOL_DESCRIPTION = [
  "Save durable facts to persistent memory: add, patch (replace a whole entry) or remove entries, in one batch.",
  "Use it for facts that will still matter in later sessions: stable preferences the user stated, environment and",
  "project facts, corrections. Write declarative facts (\"The user prefers short answers\"), not commands. Do not",
  "save one-off requests, transient errors or things you can look up again. Each store has a size cap checked on the",
  "result of the whole batch, so remove or shorten entries in the same batch when it is full.",
  "Most stores need a person's approval: then the batch becomes a proposal. Either way, the memory shown in this",
  "session's system prompt does not change during the session.",
].join(" ");

export const FROZEN_NOTE = "This session's memory snapshot does not change.";

export function makeMemoryTool(memory: MemoryService): ToolDef<typeof memoryToolInput> {
  const tool: ToolDef<typeof memoryToolInput> = {
    name: "memory",
    description: MEMORY_TOOL_DESCRIPTION,
    input: memoryToolInput,
    readOnly: false,
    capabilities: ["memory.write"],
    async run(input, ctx) {
      const evidence: Evidence[] = (input.evidence ?? []).map((item) => ({
        kind: "message",
        ref: item.messageId,
        quote: item.quote,
      }));
      const result = await memory.write({
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        store: input.store,
        ops: input.ops as MemoryOp[],
        actor: `agent:${ctx.agentId}`,
        unattended: !ctx.attended,
        evidence,
        rationale: input.rationale ?? "",
        shadow: ctx.mode === "shadow",
        // After untrusted text (web, files, tool output from outside), and in an unattended run (a scheduled job,
        // whose prompt may carry outside text and where nobody watches), a memory write is always a proposal.
        noAutoApply: ctx.tainted !== false || ctx.attended !== true,
      });
      switch (result.status) {
        case "applied":
          return `Saved. It is in memory from the next session on. ${FROZEN_NOTE}`;
        case "proposed":
          return `Proposed (id ${result.proposalId ?? "?"}), waiting for approval. ${FROZEN_NOTE}`;
        case "refused":
          return `Not saved: ${result.error ?? "the batch was refused."}`;
      }
    },
  };
  // Marked as a built-in knowledge tool: the approval policy lets it run in every mode but off (its writes are
  // proposals unless an add-only store accepts them directly).
  return markKnowledgeTool(tool);
}
