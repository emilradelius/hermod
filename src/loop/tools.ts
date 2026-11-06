/**
 * One round of tool calls: validate, decide (approval policy), run or propose or deny, and format the results.
 *
 * Rules (rt-spec LOOP; SDK facts §2.5, §7):
 * - Each tool_use in order. Unknown tool or input that fails the zod schema → an is_error result (eager input
 *   streaming means the API no longer validates input, so the loop always does).
 * - Every valid call goes through ApprovalPolicy.decide({ mode, attended, tainted, tool, input }):
 *   allow → run; propose → an action proposal (a draft for a person; nothing runs); deny → is_error with the reason
 *   and an audit entry. The hard denylist is part of the policy and applies in every mode.
 * - Consecutive allowed read-only calls run in parallel; everything else runs one at a time, decided at its turn
 *   (so a side effect is decided after every earlier result, untrusted ones included, has arrived).
 * - Results keep the tool_use order. A thrown error becomes is_error with `{"error":{"type","message"}}`.
 * - Output: JSON-stringified (strings as they are), redacted, then truncated (redacting first, so a cut never leaves
 *   half a secret the redactor no longer recognises), then wrapped with wrapUntrusted for a tool with
 *   untrustedOutput — which also taints the run.
 */
import { createNonce, wrapUntrusted } from "../safety/untrusted.js";
import type {
  AgentMode,
  ApprovalDecision,
  ApprovalPolicy,
  Id,
  Redactor,
  Storage,
  ToolCallRecord,
  ToolContext,
  ToolDef,
  ToolResultBlockParam,
} from "../types.js";
import type { ToolRegistry } from "../tools/registry.js";

/** Searchable text keeps at most this much of each tool output (rt-spec: 8 KB). */
export const SEARCH_TEXT_TOOL_OUTPUT_CHARS = 8 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 2_000;

/** What the tool round needs from the run. `isTainted` / `markTainted` read and change the run's one state object. */
export interface ToolEnv {
  agentId: Id;
  sessionId: Id;
  mode: AgentMode;
  attended: boolean;
  storage: Storage;
  now(): Date;
  newId(): Id;
  signal?: AbortSignal;
  redactor: Redactor;
  approvals: ApprovalPolicy;
  maxOutputChars: number;
  isTainted(): boolean;
  markTainted(): void;
  /** The stored assistant message the calls came from (evidence for proposals). */
  evidenceMessageId?: Id;
  /** "agent:<id>" or "job:<id>". */
  actor: string;
  /** For delegation tools: the function that runs a child agent. */
  runChildFor?(tool: ToolDef): ToolContext["runChild"] | undefined;
}

export interface ToolUseLike {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolOutcome {
  result: ToolResultBlockParam;
  record: ToolCallRecord;
  /** For the stored message's searchable text. */
  searchText: string;
}

type Prepared =
  | { kind: "unknown"; block: ToolUseLike }
  | { kind: "invalid"; block: ToolUseLike; tool: ToolDef; message: string }
  | { kind: "ready"; block: ToolUseLike; tool: ToolDef; input: unknown };

/** Runs one round; results are in the same order as `blocks`. Never throws for a tool's own failure. */
export async function runToolRound(
  blocks: readonly ToolUseLike[],
  registry: ToolRegistry,
  env: ToolEnv,
  onToolCall?: (record: ToolCallRecord) => void,
): Promise<ToolOutcome[]> {
  const prepared = blocks.map((block) => prepare(block, registry));
  const outcomes: ToolOutcome[] = new Array<ToolOutcome>(prepared.length);
  let i = 0;
  while (i < prepared.length) {
    const group: number[] = [];
    while (i + group.length < prepared.length) {
      const item = prepared[i + group.length] as Prepared;
      if (item.kind !== "ready" || !isParallelSafe(item.tool) || decide(item, env).decision !== "allow") break;
      group.push(i + group.length);
    }
    if (group.length > 0) {
      const done = await Promise.all(group.map((index) => handle(prepared[index] as Prepared, env)));
      done.forEach((outcome, k) => (outcomes[group[k] as number] = outcome));
      i += group.length;
    } else {
      outcomes[i] = await handle(prepared[i] as Prepared, env);
      i += 1;
    }
  }
  for (const outcome of outcomes) onToolCall?.(outcome.record);
  return outcomes;
}

/** A read-only tool with only the "read" capability that needs no approval: safe to run next to others like it. */
export function isParallelSafe(tool: ToolDef): boolean {
  return tool.readOnly === true && tool.capabilities.every((cap) => cap === "read") && tool.requiresApproval !== true;
}

function prepare(block: ToolUseLike, registry: ToolRegistry): Prepared {
  const tool = registry.get(block.name);
  if (!tool) return { kind: "unknown", block };
  const parsed = tool.input.safeParse(block.input);
  if (!parsed.success) {
    const message = parsed.error.issues
      .slice(0, 20)
      .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join(".") : "(input)"}: ${issue.message}`)
      .join("; ");
    return { kind: "invalid", block, tool, message };
  }
  return { kind: "ready", block, tool, input: parsed.data };
}

function decide(item: Extract<Prepared, { kind: "ready" }>, env: ToolEnv): { decision: ApprovalDecision; reason: string } {
  try {
    const result = env.approvals.decide({
      mode: env.mode,
      attended: env.attended,
      tainted: env.isTainted(),
      tool: item.tool,
      input: item.input,
    });
    if (result && (result.decision === "allow" || result.decision === "propose" || result.decision === "deny")) {
      return { decision: result.decision, reason: String(result.reason ?? "") };
    }
    return { decision: "deny", reason: "The approval policy gave no valid decision, so the call is denied." };
  } catch (error) {
    return { decision: "deny", reason: `The approval policy failed (${messageOf(error)}), so the call is denied.` };
  }
}

async function handle(item: Prepared, env: ToolEnv): Promise<ToolOutcome> {
  const started = Date.now();
  const { block } = item;
  if (item.kind === "unknown") {
    return errorOutcome(block, "deny", "unknown_tool", `There is no tool named ${JSON.stringify(block.name)}.`, started);
  }
  if (item.kind === "invalid") {
    return errorOutcome(block, "deny", "invalid_input", `The input does not match the schema: ${item.message}`, started);
  }
  if (env.signal?.aborted) return errorOutcome(block, "deny", "aborted", "The run was cancelled before this call ran.", started);
  const { decision, reason } = decide(item, env);
  if (decision === "deny") {
    await audit(env, "tool.deny", item.tool.name, { toolUseId: block.id, reason, mode: env.mode, attended: env.attended });
    return errorOutcome(block, "deny", "denied", `Not run: ${reason}`, started);
  }
  if (decision === "propose") return propose(item, reason, env, started);
  return run(item, env, started);
}

async function propose(
  item: Extract<Prepared, { kind: "ready" }>,
  reason: string,
  env: ToolEnv,
  started: number,
): Promise<ToolOutcome> {
  const { block, tool } = item;
  let proposalId: Id;
  try {
    const proposal = await env.storage.proposals.create({
      agentId: env.agentId,
      sessionId: env.sessionId,
      kind: "action",
      target: tool.name,
      payload: { kind: "action", tool: tool.name, input: redactDeep(item.input, env.redactor) },
      evidence: env.evidenceMessageId ? [{ kind: "message", ref: env.evidenceMessageId }] : [],
      rationale: env.redactor(reason || `The call to "${tool.name}" needs a person's approval.`),
      createdBy: env.actor,
      shadow: env.mode === "shadow",
    });
    proposalId = proposal.id;
  } catch (error) {
    return errorOutcome(block, "propose", "proposal_failed", `The call could not be queued: ${env.redactor(messageOf(error))}`, started);
  }
  await audit(env, "tool.propose", tool.name, { toolUseId: block.id, proposalId, mode: env.mode, shadow: env.mode === "shadow" });
  const content = JSON.stringify({
    status: "proposed",
    proposalId,
    message:
      `Not run. "${tool.name}" was queued as a proposal for a person to review (${reason}). ` +
      "Do not call it again for the same thing; tell the user it is waiting for approval.",
  });
  return {
    result: { type: "tool_result", tool_use_id: block.id, content },
    record: { id: block.id, name: tool.name, decision: "propose", ok: true, proposalId, durationMs: Date.now() - started },
    searchText: searchLine(tool.name, content),
  };
}

async function run(item: Extract<Prepared, { kind: "ready" }>, env: ToolEnv, started: number): Promise<ToolOutcome> {
  const { block, tool } = item;
  const ctx = toolContext(env, tool);
  let output: unknown;
  try {
    output = await tool.run(item.input, ctx);
  } catch (error) {
    const type = errorType(error);
    const body = JSON.stringify({ error: { type, message: truncate(env.redactor(messageOf(error)), MAX_ERROR_MESSAGE_CHARS) } });
    const content = tool.untrustedOutput ? wrap(body, tool, env) : body;
    return {
      result: { type: "tool_result", tool_use_id: block.id, is_error: true, content },
      record: { id: block.id, name: tool.name, decision: "allow", ok: false, error: `${type}: tool failed`, durationMs: Date.now() - started },
      searchText: searchLine(tool.name, content),
    };
  }
  if (!isParallelSafe(tool)) {
    await audit(env, "tool.run", tool.name, { toolUseId: block.id, mode: env.mode, capabilities: [...tool.capabilities] });
  }
  let content: string;
  try {
    content = formatOutput(output, tool, env);
  } catch (error) {
    content = JSON.stringify({ error: { type: "output_error", message: `The tool's output could not be serialised: ${messageOf(error)}` } });
    return {
      result: { type: "tool_result", tool_use_id: block.id, is_error: true, content },
      record: { id: block.id, name: tool.name, decision: "allow", ok: false, error: "output could not be serialised", durationMs: Date.now() - started },
      searchText: searchLine(tool.name, content),
    };
  }
  return {
    result: { type: "tool_result", tool_use_id: block.id, content },
    record: { id: block.id, name: tool.name, decision: "allow", ok: true, durationMs: Date.now() - started },
    searchText: searchLine(tool.name, content),
  };
}

/** Stringify → redact → truncate → wrap (untrusted tools; this taints the run). */
export function formatOutput(output: unknown, tool: ToolDef, env: Pick<ToolEnv, "redactor" | "maxOutputChars" | "markTainted">): string {
  const text = typeof output === "string" ? output : (JSON.stringify(output) ?? "null");
  const limited = truncate(env.redactor(text), env.maxOutputChars);
  return tool.untrustedOutput ? wrap(limited, tool, env) : limited;
}

function wrap(text: string, tool: ToolDef, env: Pick<ToolEnv, "markTainted">): string {
  env.markTainted();
  return wrapUntrusted(text, { source: `tool:${tool.name}`, nonce: createNonce() });
}

export function toolContext(env: ToolEnv, tool: ToolDef): ToolContext {
  const ctx: ToolContext = {
    agentId: env.agentId,
    sessionId: env.sessionId,
    mode: env.mode,
    attended: env.attended,
    tainted: env.isTainted(),
    storage: env.storage,
    now: env.now,
    newId: env.newId,
    audit: (action, target, details) => audit(env, action, target, details ?? {}),
  };
  if (env.signal) ctx.signal = env.signal;
  const runChild = env.runChildFor?.(tool);
  if (runChild) ctx.runChild = runChild;
  return ctx;
}

async function audit(env: ToolEnv, action: string, target: string, details: Record<string, unknown>): Promise<void> {
  await env.storage.audit.append({
    at: env.now().toISOString(),
    actor: env.actor,
    action,
    target,
    details: { ...details, sessionId: env.sessionId },
  });
}

function errorOutcome(block: ToolUseLike, decision: ApprovalDecision, type: string, message: string, started: number): ToolOutcome {
  const content = JSON.stringify({ error: { type, message } });
  return {
    result: { type: "tool_result", tool_use_id: block.id, is_error: true, content },
    record: { id: block.id, name: String(block.name), decision, ok: false, error: `${type}: ${truncate(message, 300)}`, durationMs: Date.now() - started },
    searchText: searchLine(String(block.name), content),
  };
}

function searchLine(name: string, content: string): string {
  return `[tool result ${name}] ${truncate(content, SEARCH_TEXT_TOOL_OUTPUT_CHARS)}`;
}

/** Every string inside a JSON-like value, redacted (for proposal payloads that go to storage). */
export function redactDeep(value: unknown, redactor: Redactor, depth = 0): unknown {
  if (typeof value === "string") return redactor(value);
  if (depth > 50 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redactor, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[redactor(key)] = redactDeep(item, redactor, depth + 1);
  return out;
}

/** Cuts text to `max` characters (never inside a surrogate pair) and says how much was cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}\n[truncated: ${text.length - cut.length} more characters]`;
}

function errorType(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.name === "string" && /^[A-Za-z0-9_.$-]{1,64}$/.test(error.name)) return error.name;
  } catch {
    // A hostile getter: fall through.
  }
  return "Error";
}

/** A readable message for any thrown value. Never throws (a hostile getter or toString gives a placeholder). */
export function messageOf(error: unknown): string {
  try {
    if (error instanceof Error) return typeof error.message === "string" ? error.message : "";
    if (typeof error === "string") return error;
    return JSON.stringify(error) ?? String(error);
  } catch {
    return "(the error could not be read)";
  }
}
