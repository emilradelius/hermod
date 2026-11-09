// Unit tests for the ledger library (kit/files/.claude/hermod/lib/ledger.mjs) and the transcript reader
// (lib/transcript.mjs): command keys, event routing, redacted output tails, rotation, reading, and the
// failure → resolution bookkeeping, called in-process against temporary git repositories.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, KIT_FILES, makeRepo, tempDir, type Repo } from "./helpers.js";

type Entry = Record<string, unknown>;
interface ToolEvent {
  kind: string;
  command?: string;
  exit?: number | null;
  output?: string;
  skill?: string;
  why: string;
}
interface RecordResult {
  action: string;
  entry: Entry | null;
  why: string;
  usedGit: boolean;
}
interface OpenFailure {
  id: string;
  key: string;
  attempts: number;
  head: string | null;
  snapshot: Record<string, string>;
  dirty: string[];
}
interface LedgerOptions {
  maxOutputChars?: number;
  maxFileBytes?: number;
  extraRedactPatterns?: string[];
  skillsDir?: string;
  now?: Date;
}
interface LedgerModule {
  MAX_CMD_CHARS: number;
  MAX_SNAPSHOT_FILES: number;
  shellWords(command: string): string[];
  commandKey(command: string): string;
  parseExitCode(error: unknown): number | null;
  classifyEvent(input: Record<string, unknown>, options?: { root?: string; skillsDir?: string }): ToolEvent;
  skillOfPath(root: string, file: string, skillsDir: string): string | null;
  redactedTail(text: string, maxChars: number, extra?: string[]): string;
  appendEntry(root: string, entry: Entry, options?: LedgerOptions): Entry;
  readLedger(root: string, options?: { session?: string | null; rotated?: boolean }): Entry[];
  readOpenFailures(root: string, sessionId: string): OpenFailure[];
  changedSinceFailure(root: string, failure: OpenFailure): string[];
  recordToolEvent(root: string, input: Record<string, unknown>, options?: LedgerOptions): RecordResult;
  ledgerPath(root: string): string;
  rotatedLedgerPath(root: string): string;
}
interface TranscriptModule {
  userText(entry: unknown): string | null;
  readUserMessages(
    file: string | null,
    options?: { limit?: number; maxChars?: number; maxBytes?: number },
  ): { ok: boolean; messages: string[]; total: number; partial: boolean; error: string | null };
}

let L: LedgerModule;
let T: TranscriptModule;
beforeAll(async () => {
  const load = async (rel: string) => import(pathToFileURL(path.join(KIT_FILES, ".claude/hermod/lib", rel)).href);
  L = (await load("ledger.mjs")) as LedgerModule;
  T = (await load("transcript.mjs")) as TranscriptModule;
});
afterAll(() => cleanup());

const failInput = (command: string, session = "s1", error = "Exit code 1\nboom"): Record<string, unknown> => ({
  session_id: session,
  hook_event_name: "PostToolUseFailure",
  tool_name: "Bash",
  tool_input: { command },
  error,
});
const okInput = (command: string, session = "s1"): Record<string, unknown> => ({
  session_id: session,
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { stdout: "", stderr: "", interrupted: false },
});

describe("commandKey", () => {
  it.each([
    ["npm test", "npm test"],
    ["npm run test -- --watch=false", "npm run test"],
    ["cd app && CI=1 npm run test", "npm run test"],
    ["cd 'my app' ; cd sub && npx vitest run test/a.test.ts", "npx vitest run"],
    ["FOO=1 BAR=two pnpm -r build", "pnpm -r build"],
    ["npm test && npm run build", "npm test"],
    ["npm test 2>&1 | tail -20", "npm test"],
    ["git status>out.txt", "git status"],
    ["node scripts/x.mjs --flag value extra", "node scripts/x.mjs --flag"],
    ["  npm\ttest  ", "npm test"],
    ["cd somewhere", "cd somewhere"],
    ["", ""],
    ["A=1", ""],
  ])("%j → %j", (command, key) => {
    expect(L.commandKey(command)).toBe(key);
  });

  it("gives different keys to different commands and the same key to variants of one command", () => {
    expect(L.commandKey("npm test")).not.toBe(L.commandKey("npm run lint"));
    expect(L.commandKey("npx vitest run a.test.ts")).toBe(L.commandKey("npx vitest run b.test.ts"));
    expect(L.commandKey("npx vitest")).not.toBe(L.commandKey("npx tsc"));
  });

  it("splits words with quotes and operators", () => {
    expect(L.shellWords(`echo "a b" 'c d' e\\ f&&ls|wc;x`)).toEqual(["echo", "a b", "c d", "e f", "&&", "ls", "|", "wc", ";", "x"]);
    expect(L.shellWords("cmd 2>&1 >> log")).toEqual(["cmd", "2>&1", ">>", "log"]);
  });

  it("never throws on hostile input", () => {
    for (const s of ['"unterminated', "\\", "&&&&||;;", "x".repeat(100000), "\0\u0001"]) {
      expect(() => L.commandKey(s)).not.toThrow();
      expect(L.commandKey(s).length).toBeLessThanOrEqual(200);
    }
  });
});

describe("classifyEvent", () => {
  it("parses the exit code from a PostToolUseFailure error", () => {
    expect(L.parseExitCode("Exit code 2\nmore")).toBe(2);
    expect(L.parseExitCode("  Exit code 127")).toBe(127);
    expect(L.parseExitCode("Command failed. Exit code 3")).toBe(3);
    expect(L.parseExitCode("no code here")).toBeNull();
    expect(L.parseExitCode(42)).toBeNull();
    expect(L.classifyEvent(failInput("npm test", "s1", "Exit code 5\nx"))).toMatchObject({ kind: "fail", exit: 5, command: "npm test" });
    expect(L.classifyEvent(failInput("npm test", "s1", "weird"))).toMatchObject({ kind: "fail", exit: null });
  });

  it("routes events as the spec says", () => {
    expect(L.classifyEvent({ ...failInput("npm test"), is_interrupt: true }).kind).toBe("ignore");
    expect(L.classifyEvent(okInput("npm test")).kind).toBe("success");
    expect(L.classifyEvent({ ...okInput("x"), tool_response: { interrupted: true } }).kind).toBe("ignore");
    expect(L.classifyEvent({ ...okInput("x"), tool_response: { exitCode: 0 } }).kind).toBe("success");
    expect(L.classifyEvent({ ...okInput("x"), tool_response: { exit_code: "2" } })).toMatchObject({ kind: "fail", exit: 2 });
    expect(L.classifyEvent({ ...okInput("x"), tool_response: "plain text" }).kind).toBe("success");
    expect(L.classifyEvent({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "reflect" } })).toMatchObject({
      kind: "skill",
      skill: "reflect",
    });
    expect(L.classifyEvent({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "" } }).kind).toBe("ignore");
    expect(L.classifyEvent({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "a b" } }).kind).toBe("ignore");
    expect(L.classifyEvent({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: {} }).kind).toBe("ignore");
    expect(L.classifyEvent({ hook_event_name: "Stop" }).kind).toBe("ignore");
    // Without hook_event_name: an error field means a failure.
    expect(L.classifyEvent({ tool_name: "Bash", tool_input: { command: "x" }, error: "Exit code 1" }).kind).toBe("fail");
  });

  it("recognises SKILL.md reads only directly inside the skills folder of this root", () => {
    const root = path.resolve("/tmp/some-repo");
    const at = (...p: string[]) => path.join(root, ...p);
    expect(L.skillOfPath(root, at(".claude", "skills", "deploy", "SKILL.md"), ".claude/skills")).toBe("deploy");
    expect(L.skillOfPath(root, ".claude/skills/deploy/SKILL.md", ".claude/skills")).toBe("deploy");
    expect(L.skillOfPath(root, at(".claude", "skills", "deploy", "references", "SKILL.md"), ".claude/skills")).toBeNull();
    expect(L.skillOfPath(root, at(".claude", "skills", ".hidden", "SKILL.md"), ".claude/skills")).toBeNull();
    expect(L.skillOfPath(root, at(".claude", "skills", "deploy", "skill.md"), ".claude/skills")).toBeNull();
    expect(L.skillOfPath(root, at("..", "other", ".claude", "skills", "x", "SKILL.md"), ".claude/skills")).toBeNull();
    expect(L.skillOfPath(root, at(".claude", "skills", "..", "skills", "x", "SKILL.md"), ".claude/skills")).toBe("x");
    expect(L.skillOfPath(root, at("docs", "skills", "x", "SKILL.md"), "docs/skills")).toBe("x");
    expect(L.skillOfPath(root, "", ".claude/skills")).toBeNull();
  });
});

describe("redactedTail", () => {
  it("keeps the end of the output within the limit, redacted", () => {
    const secret = "ghp_" + "b".repeat(36);
    const text = `${"noise\n".repeat(5000)}token ${secret}\nlast line`;
    const out = L.redactedTail(text, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("last line")).toBe(true);
    expect(out).toContain("[REDACTED:github-token]");
    expect(out).not.toContain(secret);
  });

  it("does not leak a secret cut in half at the edge of the redaction window", () => {
    // The function redacts only the last (max * 2 + 4096) characters. Put the window's start 16 characters before
    // the end of a secret, and make the rest shrink a lot when redacted (a private key block), so without the
    // first-line drop the unrecognisable 16-character remainder would land in the kept tail.
    const max = 200;
    const window = max * 2 + 4096;
    const secret = "sk-" + "ant-api03-" + "Zq8Xy7Wv6Ut5Sr4Qp3On2Ml1Kj0Ih9Gf8Ed7Cb6";
    const remainder = secret.slice(-16);
    const line = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    let block = "-----BEGIN " + "PRIVATE KEY-----\n";
    while (block.length < window - 120) block += `${line}\n`;
    block += "-----END " + "PRIVATE KEY-----";
    let after = `\n${block}\n`;
    after += `${"e".repeat(window - 16 - after.length - 4)}\nend`;
    expect(after.length).toBe(window - 16);
    const text = `${"a".repeat(10000)} ${secret}${after}`;
    const out = L.redactedTail(text, max);
    expect(out).toContain("[REDACTED:private-key]");
    expect(out.endsWith("end")).toBe(true);
    expect(out).not.toContain(remainder);
    expect(out.length).toBeLessThanOrEqual(max);
  });

  it("applies extra patterns", () => {
    expect(L.redactedTail("ticket ACME-123456 failed", 100, ["ACME-[0-9]{6}"])).not.toContain("ACME-123456");
  });
});

describe("appendEntry and readLedger", () => {
  it("redacts every string of the entry, appends one line per entry, and reads back by session", () => {
    const repo = makeRepo();
    const secret = "xoxb-" + "1234567890-" + "abcdEFGH1234ijkl";
    L.appendEntry(repo.root, { id: "a1", session: "s1", type: "fail", nested: { note: `token ${secret}` } });
    L.appendEntry(repo.root, { id: "a2", session: "s2", type: "fail" });
    const raw = readFileSync(L.ledgerPath(repo.root), "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    expect(raw).not.toContain(secret);
    expect(L.readLedger(repo.root).map((e) => e.id)).toEqual(["a1", "a2"]);
    expect(L.readLedger(repo.root, { session: "s2" }).map((e) => e.id)).toEqual(["a2"]);
  });

  it("skips torn and foreign lines", () => {
    const repo = makeRepo();
    L.appendEntry(repo.root, { id: "a1", session: "s1" });
    writeFileSync(L.ledgerPath(repo.root), `${readFileSync(L.ledgerPath(repo.root), "utf8")}{"id":"torn\n[1,2]\n"str"\n\n`);
    L.appendEntry(repo.root, { id: "a2", session: "s1" });
    expect(L.readLedger(repo.root).map((e) => e.id)).toEqual(["a1", "a2"]);
  });

  it("rotates before a line would take the file over maxFileBytes, replacing an older rotated file", () => {
    const repo = makeRepo();
    const big = "y".repeat(3000);
    for (let i = 0; i < 10; i++) L.appendEntry(repo.root, { id: `e${i}`, session: "s1", out: big }, { maxFileBytes: 10000 });
    expect(statSync(L.ledgerPath(repo.root)).size).toBeLessThanOrEqual(10000);
    expect(statSync(L.rotatedLedgerPath(repo.root)).size).toBeLessThanOrEqual(10000);
    const all = L.readLedger(repo.root).map((e) => e.id);
    // Only the two newest files survive: older entries went with the replaced ledger.1.jsonl.
    expect(all[all.length - 1]).toBe("e9");
    expect(all).not.toContain("e0");
    expect(L.readLedger(repo.root, { rotated: false }).map((e) => e.id)).toEqual(all.slice(-L.readLedger(repo.root, { rotated: false }).length));
  });

  it("refuses to write when the kit is not installed", () => {
    const dir = tempDir();
    expect(() => L.appendEntry(dir, { id: "x" })).toThrow(/not installed/);
    expect(existsSync(path.join(dir, ".claude"))).toBe(false);
  });
});

describe("recordToolEvent", () => {
  function repoWithFiles(): Repo {
    return makeRepo({ files: { "src/a.ts": "a\n", "src/b.ts": "b\n" } });
  }

  it("keeps a failure open with a snapshot of the dirty files and closes it on success", () => {
    const repo = repoWithFiles();
    repo.write("src/a.ts", "a dirty\n");
    const f = L.recordToolEvent(repo.root, failInput("npm test"));
    expect(f.action).toBe("fail");
    expect(f.usedGit).toBe(true);
    const open = L.readOpenFailures(repo.root, "s1");
    expect(open).toHaveLength(1);
    expect(open[0]?.key).toBe("npm test");
    expect(Object.keys(open[0]?.snapshot ?? {})).toEqual(["src/a.ts"]);
    expect(open[0]?.snapshot["src/a.ts"]).toMatch(/^[0-9a-f]{40,64}$/);
    expect(open[0]?.head).toMatch(/^[0-9a-f]{40,64}$/);
    repo.write("src/b.ts", "b fixed\n");
    const r = L.recordToolEvent(repo.root, okInput("npm test"));
    expect(r.action).toBe("resolved");
    expect(r.entry?.failureId).toBe(f.entry?.id);
    expect(r.entry?.changedFiles).toEqual(["src/b.ts"]);
    expect(L.readOpenFailures(repo.root, "s1")).toEqual([]);
  });

  it("does not call git for a success without an open failure", () => {
    const repo = repoWithFiles();
    const r = L.recordToolEvent(repo.root, okInput("npm test"));
    expect(r).toMatchObject({ action: "none", usedGit: false });
    expect(existsSync(L.ledgerPath(repo.root))).toBe(false);
  });

  it("records failures without a session id but never resolves them", () => {
    const repo = repoWithFiles();
    const f = L.recordToolEvent(repo.root, { ...failInput("npm test"), session_id: undefined });
    expect(f.action).toBe("fail");
    expect(f.entry?.session).toBeNull();
    expect(L.recordToolEvent(repo.root, { ...okInput("npm test"), session_id: undefined }).action).toBe("none");
  });

  it("reports a file deleted since the failure", () => {
    const repo = repoWithFiles();
    L.recordToolEvent(repo.root, failInput("npm run build"));
    repo.remove("src/a.ts");
    const r = L.recordToolEvent(repo.root, okInput("npm run build"));
    expect(r.entry?.changedFiles).toEqual(["src/a.ts"]);
  });

  it("caps the snapshot at MAX_SNAPSHOT_FILES and ignores unhashed dirty files unless a commit touched them", () => {
    const repo = repoWithFiles();
    const n = L.MAX_SNAPSHOT_FILES + 20;
    for (let i = 0; i < n; i++) repo.write(`gen/f${String(i).padStart(3, "0")}.txt`, `${i}\n`);
    L.recordToolEvent(repo.root, failInput("npm test"));
    const [open] = L.readOpenFailures(repo.root, "s1");
    expect(Object.keys(open?.snapshot ?? {})).toHaveLength(L.MAX_SNAPSHOT_FILES);
    expect(open?.dirty).toHaveLength(n);
    // Change one file beyond the snapshot (unknown hash): not reported. Change one inside: reported.
    repo.write(`gen/f${String(n - 1).padStart(3, "0")}.txt`, "changed\n");
    repo.write("gen/f000.txt", "changed\n");
    const r = L.recordToolEvent(repo.root, okInput("npm test"));
    expect(r.entry?.changedFiles).toEqual(["gen/f000.txt"]);
  });

  it("uses the time it is given", () => {
    const repo = repoWithFiles();
    const r = L.recordToolEvent(repo.root, { hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "x" }, session_id: "s" }, {
      now: new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(r.entry?.ts).toBe("2026-01-02T03:04:05.000Z");
    expect(r.entry?.type).toBe("skill");
  });
});

describe("transcript reader", () => {
  function transcript(lines: unknown[]): string {
    const file = path.join(tempDir(), "t.jsonl");
    writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
    return file;
  }
  const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", message: { role: "user", content }, ...extra });

  it("keeps the user's text and skips tool results, meta, sub-agents, command output and unknown shapes", () => {
    const file = transcript([
      user("first message"),
      user([{ type: "text", text: "second" }, { type: "image", source: {} }, { type: "text", text: "part two" }]),
      user([{ type: "tool_result", tool_use_id: "x", content: "TOOL RESULT TEXT" }]),
      user([{ type: "tool_result", tool_use_id: "y", content: "z" }, { type: "text", text: "TOOL RESULT NEIGHBOUR" }]),
      user("tool result as a string", { toolUseResult: { stdout: "x" } }),
      user("META TEXT", { isMeta: true }),
      user("SIDECHAIN TEXT", { isSidechain: true }),
      user("<local-command-stdout>COMMAND OUTPUT</local-command-stdout>"),
      user("<system-reminder>REMINDER</system-reminder>"),
      user("kept <system-reminder>REMINDER</system-reminder> around"),
      { type: "assistant", message: { role: "assistant", content: "ASSISTANT TEXT" } },
      { type: "user", message: { role: "assistant", content: "WRONG ROLE" } },
      { type: "user", message: "not an object" },
      { type: "user" },
      "{not json",
      "[1,2,3]",
      "42",
      "",
      user({ unexpected: "shape" }),
    ]);
    const r = T.readUserMessages(file);
    expect(r.ok).toBe(true);
    expect(r.messages).toEqual(["first message", "second ⏎ part two", "kept around"]);
    const all = r.messages.join("\n");
    for (const bad of ["TOOL RESULT", "META", "SIDECHAIN", "COMMAND OUTPUT", "REMINDER", "ASSISTANT", "WRONG ROLE", "tool result as"]) {
      expect(all).not.toContain(bad);
    }
  });

  it("returns the last messages, each redacted and cut", () => {
    const secret = "sk-" + "ant-api03-" + "Q1w2E3r4T5y6U7i8O9p0".repeat(2);
    const lines = Array.from({ length: 60 }, (_, i) => user(`message ${i} ${"z".repeat(i === 59 ? 1000 : 0)}`));
    lines.push(user(`my key is ${secret} please`));
    const r = T.readUserMessages(transcript(lines), { limit: 40, maxChars: 400 });
    expect(r.total).toBe(61);
    expect(r.messages).toHaveLength(40);
    expect(r.messages[0]).toBe("message 21");
    expect(r.messages.every((m) => m.length <= 400)).toBe(true);
    expect(r.messages[39]).toContain("[REDACTED:anthropic-key]");
    expect(r.messages.join("")).not.toContain(secret);
  });

  it("reads only the tail of a huge transcript, dropping the partial first line", () => {
    const lines = Array.from({ length: 3000 }, (_, i) => user(`m${i} ${"p".repeat(100)}`));
    const r = T.readUserMessages(transcript(lines), { maxBytes: 20000, limit: 1000 });
    expect(r.ok).toBe(true);
    expect(r.partial).toBe(true);
    expect(r.total).toBeLessThan(3000);
    expect(r.messages[r.messages.length - 1]?.startsWith("m2999 ")).toBe(true);
  });

  it("reports a missing or unusable transcript without throwing", () => {
    expect(T.readUserMessages(null)).toMatchObject({ ok: false, messages: [] });
    expect(T.readUserMessages(path.join(tempDir(), "missing.jsonl")).error).toMatch(/does not exist/);
    expect(T.readUserMessages(tempDir()).ok).toBe(false);
    expect(T.userText(null)).toBeNull();
  });
});
