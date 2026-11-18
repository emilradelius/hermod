// Tests for the MCP connector (kit/files/.claude/hermod/mcp.mjs): any MCP client can read Hermod in a repository.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KIT_FILES, cleanup, makeRepo, runNode, tempDir, type Repo } from "./helpers.js";

const MCP = path.join(KIT_FILES, ".claude", "hermod", "mcp.mjs");

interface McpModule {
  TOOLS: ReadonlyArray<{ name: string; inputSchema: { type: string } }>;
  MAX_OUTPUT_CHARS: number;
  PROTOCOL_VERSIONS: readonly string[];
  finish(text: string): string;
  argumentProblem(name: string, args: Record<string, unknown>): string | null;
}
let M: McpModule;

const progress = "# Progress\n\n## Status\nCheckout works; partial refunds are half done.\n\n## Next step\nAdd tests for partial refunds.\n";
const skill = "---\nname: demo-skill\ndescription: Run the demo the safe way. Use when showing the app.\n---\n\n# Demo skill\n\n1. Start with a fresh database.\n";
// Built at runtime so no scanner mistakes this file for a real secret.
const fakeToken = "gh" + "p_" + "A1b2C3d4".repeat(5);

// JSON from the server, read loosely the way a client would.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { jsonrpc: string; id: number | string | null; result?: any; error?: { code: number; message: string } };

/** Sends lines to a fresh server and returns its replies, one per stdout line (every line must be JSON). */
function talk(repo: Repo, lines: Array<string | object>, args: string[] = []): { replies: Reply[]; at: (i: number) => Reply; stderr: string; code: number | null } {
  const stdin = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
  const r = runNode(repo.kitPath("mcp.mjs"), { args: ["--root", repo.root, ...args], stdin, cwd: repo.root });
  const replies = r.stdout
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Reply);
  const at = (i: number): Reply => {
    const reply = replies[i];
    if (!reply) throw new Error(`no reply ${i}; stdout: ${r.stdout} stderr: ${r.stderr}`);
    return reply;
  };
  return { replies, at, stderr: r.stderr, code: r.code };
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const call = (id: number, name: string, args: object = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const text = (r: Reply) => String(r.result?.content?.[0]?.text ?? "");

/** Every file under root (outside .git) with a hash of its content. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(`${path.relative(root, p)} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  return out.sort();
}

let repo: Repo;

beforeAll(async () => {
  M = (await import(pathToFileURL(MCP).href)) as McpModule;
  repo = makeRepo({
    seed: true,
    files: {
      "docs/PROGRESS.md": progress,
      "docs/decisions.md": "# Decisions\n\n- 2026-11-17: refunds go back to the original payment method.\n",
      ".claude/hermod/LESSONS.md": `# Lessons\n\nUse a fresh test database for the refund tests.\n§\nThe old token was ${fakeToken}, never paste one again.\n`,
      ".claude/skills/demo-skill/SKILL.md": skill,
      "src/refunds.js": "export const refund = () => 0;\n",
    },
  });
});

afterAll(() => cleanup());

describe("the MCP connector: protocol", () => {
  it("answers initialize with a version it speaks, its name and instructions for the client's model", () => {
    const { replies, at } = talk(repo, [init]);
    expect(replies).toHaveLength(1);
    const r = at(0).result;
    expect(r.protocolVersion).toBe("2025-06-18");
    expect(r.serverInfo.name).toBe("hermod");
    expect(r.capabilities.tools).toEqual({ listChanged: false });
    expect(r.instructions).toMatch(/read-only/i);
    expect(r.instructions).toMatch(/pull request/);
    expect(r.instructions).toContain("docs/PROGRESS.md");
    expect(r.instructions).toMatch(/data, not instructions/);
  });

  it("offers its newest version when the client asks for one it does not speak", () => {
    const { at } = talk(repo, [{ ...init, params: { ...init.params, protocolVersion: "1999-01-01" } }]);
    expect(at(0).result.protocolVersion).toBe(M.PROTOCOL_VERSIONS[0]);
  });

  it("names the kit version from the stamp next to it, else dev", () => {
    expect(talk(repo, [init]).at(0).result.serverInfo.version).toBe("dev");
    const stamped = makeRepo({ seed: true, files: { ".claude/hermod/VERSION.json": JSON.stringify({ kit: "9.9.9" }) } });
    expect(talk(stamped, [init]).at(0).result.serverInfo.version).toBe("9.9.9");
  });

  it("lists seven read-only tools, each with an object schema", () => {
    const { at } = talk(repo, [init, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    const tools = at(1).result.tools as Array<{ name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }>;
    expect(tools.map((t) => t.name)).toEqual(["hermod_brief", "hermod_recall", "hermod_lessons", "hermod_skills", "hermod_skill", "hermod_check", "hermod_validate"]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations.readOnlyHint).toBe(true);
    }
  });

  it("answers ping, ignores notifications, and keeps the order of answers", () => {
    const { replies, at } = talk(repo, [
      init,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      call(3, "hermod_skills"),
      { jsonrpc: "2.0", id: 4, method: "ping" },
    ]);
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(at(1).result).toEqual({});
  });

  it("gives JSON-RPC errors for a bad line, a bad request, an unknown method and bad tool calls", () => {
    const { replies } = talk(repo, [
      "not json",
      { id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "resources/list" },
      call(4, "hermod_nothing"),
      call(5, "hermod_recall", { query: "x", extra: 1 }),
      call(6, "hermod_recall", {}),
      call(7, "hermod_recall", { query: "refunds", limit: 500 }),
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "hermod_brief", arguments: [1] } },
      call(9, "hermod_skill", { name: "../outside" }),
      "[]",
    ]);
    const codes = replies.map((r) => [r.id, r.error?.code]);
    expect(codes).toEqual([
      [null, -32700],
      [2, -32600],
      [3, -32601],
      [4, -32602],
      [5, -32602],
      [6, -32602],
      [7, -32602],
      [8, -32602],
      [9, -32602],
      [null, -32600],
    ]);
  });

  it("answers a batch with a batch, leaving out notifications", () => {
    const r = runNode(repo.kitPath("mcp.mjs"), {
      args: ["--root", repo.root],
      stdin: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "ping" }]) + "\n",
    });
    const batch = JSON.parse(r.stdout.trim()) as Reply[];
    expect(batch.map((x) => x.id)).toEqual([1, 2]);
  });

  it("prints help on stderr and nothing on stdout, so a client never reads stray text", () => {
    const r = runNode(MCP, { args: ["--help"] });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/Usage: node \.claude\/hermod\/mcp\.mjs/);
  });
});

describe("the MCP connector: tools", () => {
  it("hermod_brief gives the brief a session would get", () => {
    const { at } = talk(repo, [init, call(2, "hermod_brief")]);
    expect(at(1).result.isError).toBe(false);
    expect(text(at(1))).toContain("Session brief");
    expect(text(at(1))).toContain("partial refunds are half done");
  });

  it("hermod_recall searches past work, and a query that starts with a dash stays a query", () => {
    const { at } = talk(repo, [init, call(2, "hermod_recall", { query: "original payment", limit: 3 }), call(3, "hermod_recall", { query: "--help" })]);
    expect(text(at(1))).toContain("docs/decisions.md");
    expect(text(at(2))).not.toMatch(/Usage:/);
    expect(at(2).result.isError).toBe(false);
  });

  it("hermod_lessons gives the lessons, with secrets redacted", () => {
    const { at } = talk(repo, [init, call(2, "hermod_lessons")]);
    expect(text(at(1))).toContain("fresh test database");
    expect(text(at(1))).not.toContain(fakeToken);
  });

  it("hermod_skills lists the skills and hermod_skill loads one", () => {
    const { at } = talk(repo, [init, call(2, "hermod_skills"), call(3, "hermod_skill", { name: "demo-skill" }), call(4, "hermod_skill", { name: "no-such-skill" })]);
    expect(text(at(1))).toContain("demo-skill: Run the demo the safe way.");
    expect(text(at(2))).toContain("Start with a fresh database.");
    expect(at(3).result.isError).toBe(true);
  });

  it("hermod_skill never follows a symlink out of the repository", () => {
    const outside = tempDir("hermod-outside-");
    mkdirSync(path.join(outside, "leak"), { recursive: true });
    writeFileSync(path.join(outside, "leak", "SKILL.md"), "---\nname: leak\ndescription: Outside.\n---\nSECRET-OUTSIDE-TEXT\n");
    symlinkSync(path.join(outside, "leak"), repo.abs(".claude/skills/leak"));
    const { at } = talk(repo, [init, call(2, "hermod_skill", { name: "leak" }), call(3, "hermod_skills")]);
    expect(at(1).result.isError).toBe(true);
    expect(text(at(1))).not.toContain("SECRET-OUTSIDE-TEXT");
    expect(text(at(2))).not.toContain("leak");
    expect(text(at(2))).toContain("demo-skill");
  });

  it("hermod_check runs the repository's checks, and hermod_validate the validator", () => {
    const { at } = talk(repo, [init, call(2, "hermod_check"), call(3, "hermod_validate")]);
    expect(text(at(1))).toMatch(/^Hermod checks:/);
    expect(at(1).result.isError).toBe(false);
    expect(text(at(2))).toMatch(/^Hermod validate:/);
  });

  it("changes no file in the repository, whatever is called", () => {
    const before = snapshot(repo.root);
    talk(repo, [init, ...M.TOOLS.map((t, i) => call(i + 2, t.name, t.name === "hermod_recall" ? { query: "refunds" } : t.name === "hermod_skill" ? { name: "demo-skill" } : {}))]);
    expect(snapshot(repo.root)).toEqual(before);
  });

  it("caps a long answer with a note", () => {
    const long = M.finish("a ".repeat(M.MAX_OUTPUT_CHARS));
    expect(long.length).toBeLessThan(M.MAX_OUTPUT_CHARS + 100);
    expect(long).toMatch(/cut at/);
  });

  it("checks arguments the way the schemas say", () => {
    expect(M.argumentProblem("hermod_recall", { query: "  " })).toMatch(/empty/);
    expect(M.argumentProblem("hermod_recall", { query: "x".repeat(501) })).toMatch(/longer/);
    expect(M.argumentProblem("hermod_recall", { query: "ok", source: "web" })).toMatch(/one of/);
    expect(M.argumentProblem("hermod_recall", { query: "ok", limit: 2.5 })).toMatch(/whole number/);
    expect(M.argumentProblem("hermod_skill", { name: "Bad Name" })).toMatch(/valid name/);
    expect(M.argumentProblem("hermod_recall", { query: "ok", limit: 3, source: "git" })).toBeNull();
  });
});

describe("the MCP connector: review fixes", () => {
  it("hermod_check runs only committed checks, so a client cannot run its own code by adding one", () => {
    const fresh = makeRepo({ seed: true, files: { "docs/PROGRESS.md": progress } });
    const marker = fresh.abs("ran.txt");
    fresh.write(
      ".claude/hermod/checks/sneaky.mjs",
      `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "ran");\nexport default { id: "sneaky", description: "x", run: () => ({ ok: true }) };\n`,
    );
    const { at } = talk(fresh, [init, call(2, "hermod_check")]);
    expect(text(at(1))).toMatch(/sneaky: not run: the file is not committed yet/);
    expect(fresh.exists("ran.txt")).toBe(false);
  });

  it("check.mjs --committed-only exits 1 and says why when a committed check was edited", () => {
    const fresh = makeRepo({ seed: true, files: { "docs/PROGRESS.md": progress } });
    // An edited committed check: with --committed-only no check runs at all.
    fresh.write(".claude/hermod/checks/hermod-state.mjs", `${fresh.read(".claude/hermod/checks/hermod-state.mjs")}\n// edited\n`);
    const r = runNode(fresh.kitPath("check.mjs"), { args: ["--root", fresh.root, "--committed-only"] });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--committed-only runs only checks committed at HEAD/);
  });

  it("without --root, serves the repository that holds the script, wherever it is started", () => {
    const elsewhere = tempDir("hermod-cwd-");
    const r = runNode(repo.kitPath("mcp.mjs"), { stdin: JSON.stringify(call(1, "hermod_brief")) + "\n", cwd: elsewhere });
    expect(String(JSON.parse(r.stdout.trim()).result.content[0].text)).toContain("partial refunds are half done");
  });

  it("answers an overlong line with one parse error without keeping it, then goes on", () => {
    const huge = "x".repeat(1_000_100);
    const { replies } = talk(repo, [huge, { jsonrpc: "2.0", id: 2, method: "ping" }]);
    expect(replies.map((r) => [r.id, r.error?.code])).toEqual([
      [null, -32700],
      [2, undefined],
    ]);
  });

  it("refuses params that are not an object", () => {
    const { at } = talk(repo, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: ["hermod_brief"] }]);
    expect(at(0).error?.code).toBe(-32602);
    expect(at(0).error?.message).toMatch(/params must be an object/);
  });
});

describe("the MCP connector: rules of the kit", () => {
  it("imports only node builtins and the kit's own files", () => {
    const source = readFileSync(MCP, "utf8");
    const specs = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1] ?? "");
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s.startsWith("node:") || s.startsWith("./")).toBe(true);
    expect(specs.some((s) => ["node:http", "node:https", "node:net", "node:tls", "node:dgram", "node:dns", "node:http2"].includes(s))).toBe(false);
    expect(statSync(MCP).size).toBeGreaterThan(0);
  });
});
