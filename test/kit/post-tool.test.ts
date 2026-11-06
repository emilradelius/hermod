// End-to-end tests for the PostToolUse / PostToolUseFailure hook (kit/files/.claude/hermod/hooks/post-tool.mjs):
// each test builds a temporary git repository with the real kit copied in and runs
// `node .claude/hermod/hooks/post-tool.mjs` with hook JSON on stdin, then reads the ledger it wrote.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, KIT_FILES, makeRepo, runHook, runNode, tempDir, type Repo, type RunResult } from "./helpers.js";

afterAll(() => cleanup());

const LEDGER = ".claude/hermod/.local/ledger.jsonl";
const ROTATED = ".claude/hermod/.local/ledger.1.jsonl";
const SHA = "0123456789abcdef0123456789abcdef01234567";

type Entry = Record<string, unknown>;

function ledger(repo: Repo, rel = LEDGER): Entry[] {
  const text = repo.read(rel);
  if (text === null) return [];
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Entry);
}

function nth(list: Entry[], i: number): Entry {
  const e = list[i];
  if (e === undefined) throw new Error(`no ledger entry ${i} (have ${list.length})`);
  return e;
}

function fail(repo: Repo, command: string, opts: { session?: string; error?: string; env?: Record<string, string> } = {}): RunResult {
  return runHook(
    repo,
    "post-tool",
    {
      session_id: opts.session ?? "s1",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command },
      error: opts.error ?? "Exit code 1\nsomething failed",
      is_interrupt: false,
      cwd: repo.root,
    },
    { env: opts.env },
  );
}

function succeed(repo: Repo, command: string, opts: { session?: string; env?: Record<string, string>; response?: object } = {}): RunResult {
  return runHook(
    repo,
    "post-tool",
    {
      session_id: opts.session ?? "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_response: opts.response ?? { stdout: "ok", stderr: "", interrupted: false, isImage: false },
      cwd: repo.root,
    },
    { env: opts.env },
  );
}

function quiet(r: RunResult): void {
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toBe("");
}

function withConfig(ledgerConfig: Record<string, unknown>): Repo {
  return makeRepo({
    kitSkills: true,
    files: {
      "src/app.ts": "export const a = 1;\n",
      ".claude/hermod/config.json": JSON.stringify({ version: 1, ledger: ledgerConfig }),
    },
  });
}

describe("post-tool hook: failures", () => {
  it("records a PostToolUseFailure with the exit code from the error, the key, the command and the output", () => {
    const repo = makeRepo({ files: { "src/app.ts": "x\n" } });
    const r = fail(repo, "cd src && CI=1 npm run test -- --watch=false", { error: "Exit code 2\nFAIL test/app.test.ts\nexpected 1" });
    quiet(r);
    const entries = ledger(repo);
    expect(entries).toHaveLength(1);
    const e = nth(entries, 0);
    expect(e.type).toBe("fail");
    expect(e.exit).toBe(2);
    expect(e.key).toBe("npm run test");
    expect(e.cmd).toBe("cd src && CI=1 npm run test -- --watch=false");
    expect(e.session).toBe("s1");
    expect(String(e.out)).toContain("expected 1");
    expect(String(e.id)).toMatch(/^[0-9a-f]{8}$/);
    expect(Number.isNaN(Date.parse(String(e.ts)))).toBe(false);
    // The local folder is never committed.
    expect(repo.read(".claude/hermod/.local/.gitignore")?.trim()).toBe("*");
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  it("records a PostToolUse whose response carries a non-zero exit code (defensive)", () => {
    const repo = makeRepo();
    for (const field of ["exitCode", "exit_code", "returnCode"]) {
      quiet(succeed(repo, `make ${field}`, { response: { stdout: "boom", stderr: "bad", [field]: 3 } }));
    }
    quiet(succeed(repo, "make zero", { response: { stdout: "fine", exitCode: 0 } }));
    const entries = ledger(repo);
    expect(entries.map((e) => [e.type, e.key, e.exit])).toEqual([
      ["fail", "make exitCode", 3],
      ["fail", "make exit_code", 3],
      ["fail", "make returnCode", 3],
    ]);
    expect(String(nth(entries, 0).out)).toContain("boom");
    expect(String(nth(entries, 0).out)).toContain("bad");
  });

  it("ignores interrupted commands in both events", () => {
    const repo = makeRepo();
    quiet(
      runHook(repo, "post-tool", {
        session_id: "s1",
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        error: "Exit code 130\ninterrupted",
        is_interrupt: true,
      }),
    );
    quiet(succeed(repo, "npm test", { response: { stdout: "", stderr: "", interrupted: true, exitCode: 1 } }));
    expect(existsSync(repo.abs(LEDGER))).toBe(false);
    expect(existsSync(repo.abs(".claude/hermod/.local/sessions/s1/open-failures.json"))).toBe(false);
  });

  it("ignores failures of other tools and Bash calls without a command", () => {
    const repo = makeRepo();
    quiet(runHook(repo, "post-tool", { session_id: "s1", hook_event_name: "PostToolUseFailure", tool_name: "Write", tool_input: {}, error: "Exit code 1" }));
    quiet(runHook(repo, "post-tool", { session_id: "s1", hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: {}, error: "Exit code 1" }));
    expect(existsSync(repo.abs(LEDGER))).toBe(false);
  });

  it("keeps cmd at most 500 characters and the output tail at most maxOutputChars", () => {
    const repo = withConfig({ maxOutputChars: 300 });
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} of the test output`);
    lines.push("THE LAST LINE");
    quiet(fail(repo, `echo ${"x".repeat(2000)}`, { error: `Exit code 1\n${lines.join("\n")}` }));
    const e = nth(ledger(repo), 0);
    expect(String(e.cmd).length).toBeLessThanOrEqual(500);
    expect(String(e.cmd).startsWith("echo xxx")).toBe(true);
    expect(String(e.out).length).toBeLessThanOrEqual(300);
    expect(String(e.out).endsWith("THE LAST LINE")).toBe(true);
    expect(String(e.out)).not.toContain("line 0 of");
  });

  it("writes nothing when the ledger is disabled", () => {
    const repo = withConfig({ enabled: false });
    quiet(fail(repo, "npm test"));
    quiet(runHook(repo, "post-tool", { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "reflect" } }));
    expect(existsSync(repo.abs(".claude/hermod/.local"))).toBe(false);
  });

  it("writes nothing in a repository without the kit", () => {
    const repo = makeRepo({ kit: false, files: { "a.txt": "a\n" } });
    const r = runNode(path.join(KIT_FILES, ".claude/hermod/hooks/post-tool.mjs"), {
      cwd: repo.root,
      env: { CLAUDE_PROJECT_DIR: repo.root },
      stdin: { session_id: "s1", hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" }, error: "Exit code 1" },
    });
    quiet(r);
    expect(existsSync(repo.abs(".claude"))).toBe(false);
  });
});

describe("post-tool hook: hostile input fails open", () => {
  for (const [name, stdin] of [
    ["not JSON", "{not json"],
    ["a JSON list", "[1,2,3]"],
    ["a JSON string", '"hello"'],
    ["empty input", ""],
    ["wrong types", JSON.stringify({ session_id: 5, hook_event_name: ["x"], tool_name: {}, tool_input: "npm test", error: 7 })],
  ] as const) {
    it(`exits 0 with no output and no ledger write for ${name}`, () => {
      const repo = makeRepo();
      quiet(runHook(repo, "post-tool", stdin));
      expect(existsSync(repo.abs(LEDGER))).toBe(false);
    });
  }

  it("logs malformed input to errors.log without the secret it contained", () => {
    const repo = makeRepo();
    const secret = "ghp_" + "Q".repeat(36);
    quiet(runHook(repo, "post-tool", `{"error": "${secret}", broken`));
    expect(existsSync(repo.abs(LEDGER))).toBe(false);
    const log = repo.read(".claude/hermod/.local/errors.log") ?? "";
    expect(log).toContain("[post-tool]");
    expect(log).not.toContain(secret);
  });
});

describe("post-tool hook: resolution", () => {
  it("resolves a failure when the same key succeeds later, listing the file that changed", () => {
    const repo = makeRepo({ files: { "src/app.ts": "export const a = 1;\n", "src/other.ts": "x\n" } });
    quiet(fail(repo, "npm test", { error: "Exit code 1\nexpected 2, got 1" }));
    repo.write("src/app.ts", "export const a = 2;\n");
    quiet(succeed(repo, "CI=1 npm test -- --run"));
    const entries = ledger(repo);
    expect(entries.map((e) => e.type)).toEqual(["fail", "resolved"]);
    const f = nth(entries, 0);
    const r = nth(entries, 1);
    expect(r.failureId).toBe(f.id);
    expect(r.key).toBe("npm test");
    expect(r.cmd).toBe("CI=1 npm test -- --run");
    expect(r.changedFiles).toEqual(["src/app.ts"]);
    // Closed: a second success writes nothing more.
    quiet(succeed(repo, "npm test"));
    expect(ledger(repo)).toHaveLength(2);
  });

  it("lists files that were already dirty at the failure only when their content changed", () => {
    const repo = makeRepo({ files: { "src/a.ts": "a\n", "src/b.ts": "b\n" } });
    repo.write("src/a.ts", "a dirty\n");
    repo.write("src/b.ts", "b dirty\n");
    quiet(fail(repo, "npm run build"));
    repo.write("src/b.ts", "b fixed\n");
    repo.write("src/new.ts", "new\n");
    quiet(succeed(repo, "npm run build"));
    const r = ledger(repo).find((e) => e.type === "resolved");
    expect(r?.changedFiles).toEqual(["src/b.ts", "src/new.ts"]);
  });

  it("counts files changed by a commit made between the failure and the fix", () => {
    const repo = makeRepo({ files: { "src/a.ts": "a\n" } });
    quiet(fail(repo, "npm test"));
    repo.commit({ files: { "src/a.ts": "a fixed\n" }, message: "fix" });
    quiet(succeed(repo, "npm test"));
    const r = ledger(repo).find((e) => e.type === "resolved");
    expect(r?.changedFiles).toEqual(["src/a.ts"]);
  });

  it("does not let different keys resolve each other", () => {
    const repo = makeRepo();
    quiet(fail(repo, "npm test"));
    repo.write("src/x.ts", "x\n");
    quiet(succeed(repo, "npm run lint"));
    quiet(succeed(repo, "npm testing"));
    expect(ledger(repo).map((e) => e.type)).toEqual(["fail"]);
    quiet(succeed(repo, "npm test"));
    expect(ledger(repo).map((e) => e.type)).toEqual(["fail", "resolved"]);
  });

  it("keeps sessions apart", () => {
    const repo = makeRepo();
    quiet(fail(repo, "npm test", { session: "session-a" }));
    quiet(succeed(repo, "npm test", { session: "session-b" }));
    expect(ledger(repo).map((e) => e.type)).toEqual(["fail"]);
    quiet(succeed(repo, "npm test", { session: "session-a" }));
    const entries = ledger(repo);
    expect(entries.map((e) => [e.type, e.session])).toEqual([
      ["fail", "session-a"],
      ["resolved", "session-a"],
    ]);
  });

  it("points a resolution at the latest of repeated failures and counts the attempts", () => {
    const repo = makeRepo();
    quiet(fail(repo, "npm test"));
    quiet(fail(repo, "npm test"));
    quiet(succeed(repo, "npm test"));
    const entries = ledger(repo);
    expect(entries.map((e) => e.type)).toEqual(["fail", "fail", "resolved"]);
    expect(nth(entries, 2).failureId).toBe(nth(entries, 1).id);
    expect(nth(entries, 2).attempts).toBe(2);
  });

  it("writes nothing for successes with no open failure", () => {
    const repo = makeRepo();
    quiet(succeed(repo, "npm test"));
    quiet(succeed(repo, "ls -la"));
    expect(existsSync(repo.abs(LEDGER))).toBe(false);
  });
});

describe("post-tool hook: fast path", () => {
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

  /** A PATH whose `git` logs every call to a marker file, then runs the real git. */
  function tracingPath(): { env: Record<string, string>; marker: string } {
    const bin = tempDir("hermod-fake-git-");
    const marker = path.join(bin, "calls.log");
    writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$*" >> "${marker}"\nexec "${realGit}" "$@"\n`);
    chmodSync(path.join(bin, "git"), 0o755);
    return { env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` }, marker };
  }

  it.skipIf(process.platform === "win32" || realGit === "")("makes no git call on a plain success, but does on a failure", () => {
    const repo = makeRepo();
    const { env, marker } = tracingPath();
    const r = succeed(repo, "npm test", { env });
    quiet(r);
    expect(existsSync(marker)).toBe(false);
    // Skill events and reads are git-free too.
    quiet(runHook(repo, "post-tool", { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "reflect" } }, { env }));
    quiet(runHook(repo, "post-tool", { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: repo.abs("src/app.ts") } }, { env }));
    expect(existsSync(marker)).toBe(false);
    // The tracing really works: a failure snapshots the dirty files with git.
    quiet(fail(repo, "npm test", { env }));
    expect(readFileSync(marker, "utf8")).toMatch(/status|hash-object|rev-parse/);
  });

  it("finishes a plain success quickly", () => {
    const repo = makeRepo();
    succeed(repo, "warm up");
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = succeed(repo, "npm test");
      quiet(r);
      times.push(r.durationMs);
    }
    // Node's own start-up dominates; the hook adds very little. Generous for slow CI machines.
    expect(Math.min(...times)).toBeLessThan(1500);
  });
});

describe("post-tool hook: skills", () => {
  it("records Skill tool uses and reads of a SKILL.md, nothing for other reads", () => {
    const repo = makeRepo();
    quiet(runHook(repo, "post-tool", { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "reflect", args: "x" } }));
    quiet(runHook(repo, "post-tool", { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "/curate" } }));
    quiet(
      runHook(repo, "post-tool", {
        session_id: "s1",
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: { file_path: repo.abs(".claude/skills/reflect/SKILL.md") },
      }),
    );
    for (const file of [".claude/skills/reflect/references/review-rules.md", "src/SKILL.md", ".claude/skills/SKILL.md", "README.md"]) {
      quiet(runHook(repo, "post-tool", { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: repo.abs(file) } }));
    }
    // Outside the repository.
    quiet(
      runHook(repo, "post-tool", {
        session_id: "s1",
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: { file_path: path.join(path.dirname(repo.root), "other", ".claude", "skills", "x", "SKILL.md") },
      }),
    );
    expect(ledger(repo).map((e) => [e.type, e.skill, e.session])).toEqual([
      ["skill", "reflect", "s1"],
      ["skill", "curate", "s1"],
      ["skill-view", "reflect", "s1"],
    ]);
  });

  it("uses the configured skills folder", () => {
    const repo = makeRepo({ files: { ".claude/hermod/config.json": JSON.stringify({ version: 1, skills: { dir: "docs/skills" } }) } });
    quiet(runHook(repo, "post-tool", { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: repo.abs("docs/skills/deploy/SKILL.md") } }));
    quiet(runHook(repo, "post-tool", { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: repo.abs(".claude/skills/reflect/SKILL.md") } }));
    expect(ledger(repo).map((e) => [e.type, e.skill])).toEqual([["skill-view", "deploy"]]);
  });
});

describe("post-tool hook: redaction", () => {
  // Fake secrets are built from fragments at run time so this file never contains one.
  const mix = "Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0Lz";
  const pw = "Hunter2" + "Hunter2x9";
  const SECRETS: Array<[string, string, string]> = [
    ["private-key", "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA" + mix + "\n" + mix + "\n-----END RSA " + "PRIVATE KEY-----", mix],
    ["url-credentials", "postgres://user:" + pw + "@db.example.com:5432/app", pw],
    ["anthropic-key", "sk-" + "ant-api03-" + mix, mix],
    ["openai-key", "sk-" + "proj-" + mix, mix],
    ["github-token", "ghp_" + "a".repeat(36), "a".repeat(36)],
    ["gitlab-token", "glpat-" + mix, mix],
    ["aws-access-key-id", "AKIA" + "IOSFODNN7EXAMPLQ", "IOSFODNN7EXAMPLQ"],
    ["aws-secret-access-key", "aws_secret_access_key=" + "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI/K7MDENG"],
    ["slack-token", "xoxb-" + "1234567890-" + mix, mix],
    ["slack-webhook", "https://hooks.slack.com/services/" + "T0000/B0000/" + mix, mix],
    ["stripe-key", "sk_" + "live_" + mix, mix],
    ["google-api-key", "AIza" + "SyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW", "SyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW"],
    ["npm-token", "npm_" + mix + "abcd", mix],
    ["huggingface-token", "hf_" + mix, mix],
    ["sendgrid-key", "SG." + "abcdefghij1234567890" + "." + mix, mix],
    ["supabase-key", "sbp_" + "0123456789abcdef".repeat(2) + "01234567", "sbp_0123"],
    ["telegram-bot-token", "123456789:" + "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq"],
    ["jwt", "eyJ" + "hbGciOiJIUzI1NiJ9" + ".eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0" + ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "dozjgNryP4J3jVmNHl0w5N"],
    ["authorization-header", "Authorization: " + "Basic " + "dXNlcjpwYXNzd29yZDEyMw==", "dXNlcjpwYXNzd29yZDEyMw"],
    ["secret-header", "x-api-key: " + mix, mix],
    ["bearer-token", "bearer " + mix, mix],
    ["cli-secret-flag", "--password=" + pw, pw],
    ["cli-user-password", "curl -u admin:" + pw + " https://example.com", pw],
    ["secret-assignment", "DB_PASSWORD=" + pw, pw],
    ["secret-json", '{"client_secret": "' + pw + '"}', pw],
    ["secret-object", "client_secret: '" + pw + "'", pw],
    ["secret-yaml", "password: " + pw, pw],
    ["token", mix + "Mn", mix],
    ["email", "someone" + "@" + "example.org", "someone@"],
    ["personnummer", "19121212" + "-1212", "19121212"],
  ];

  it("covers every pattern family in lib/redact.mjs", async () => {
    const { REDACTION_PATTERNS } = (await import(pathToFileURL(path.join(KIT_FILES, ".claude/hermod/lib/redact.mjs")).href)) as {
      REDACTION_PATTERNS: ReadonlyArray<{ name: string }>;
    };
    expect(new Set(SECRETS.map((s) => s[0]))).toEqual(new Set(REDACTION_PATTERNS.map((p) => p.name)));
  });

  it("redacts every family in the output before it reaches the ledger, and keeps git SHAs", () => {
    const repo = withConfig({ maxOutputChars: 20000 });
    const output = ["Exit code 1", `commit ${SHA}`, ...SECRETS.map(([name, secret]) => `${name}:\n${secret}\n`)].join("\n");
    quiet(fail(repo, `git show ${SHA} && npm test`, { error: output }));
    const raw = repo.read(LEDGER) ?? "";
    const e = nth(ledger(repo), 0);
    for (const [name, , fragment] of SECRETS) {
      expect(raw, name).not.toContain(fragment);
      expect(String(e.out), name).toContain(`[REDACTED:${name}]`);
    }
    expect(String(e.out)).toContain(`commit ${SHA}`);
    expect(e.cmd).toBe(`git show ${SHA} && npm test`);
  });

  for (const [name, secret, fragment] of SECRETS) {
    it(`redacts a ${name} in the command, the key and the open-failure state`, () => {
      const repo = makeRepo();
      // Put the secret first so it is part of the key, and again later in the command.
      const command = `${secret.replace(/\n/g, " ")} ${SHA}\n${secret}\necho done`;
      quiet(fail(repo, command, { error: `Exit code 1\n${secret}` }));
      quiet(succeed(repo, command));
      const raw = repo.read(LEDGER) ?? "";
      expect(raw).not.toContain(fragment);
      expect(raw).toContain("[REDACTED:");
      const state = repo.read(".claude/hermod/.local/sessions/s1/open-failures.json") ?? "";
      expect(state).not.toContain(fragment);
      // The fix still matches: both keys were redacted the same way.
      expect(ledger(repo).map((x) => x.type)).toEqual(["fail", "resolved"]);
    });
  }

  it("applies the configured extra redaction patterns", () => {
    const repo = withConfig({ extraRedactPatterns: ["ACME-[0-9]{6}"] });
    quiet(fail(repo, "deploy --ticket ACME-123456", { error: "Exit code 1\nticket ACME-654321 failed" }));
    const raw = repo.read(LEDGER) ?? "";
    expect(raw).not.toContain("ACME-123456");
    expect(raw).not.toContain("ACME-654321");
  });
});

describe("post-tool hook: rotation", () => {
  it("renames the ledger to ledger.1.jsonl when it would grow over maxFileBytes, and keeps both valid", () => {
    const repo = withConfig({ maxFileBytes: 10000, maxOutputChars: 1000 });
    const out = `Exit code 1\n${"output line\n".repeat(80)}`;
    for (let i = 0; i < 16; i++) quiet(fail(repo, `npm run job${i}`, { error: out }));
    expect(existsSync(repo.abs(ROTATED))).toBe(true);
    expect(statSync(repo.abs(LEDGER)).size).toBeLessThanOrEqual(10000);
    expect(statSync(repo.abs(ROTATED)).size).toBeLessThanOrEqual(10000);
    const current = ledger(repo);
    const rotated = ledger(repo, ROTATED);
    expect(current.length).toBeGreaterThan(0);
    expect(rotated.length).toBeGreaterThan(0);
    // The newest entry is in the current file; nothing is duplicated between the two.
    expect(nth(current, current.length - 1).key).toBe("npm run job15");
    const ids = [...rotated, ...current].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("post-tool hook: settings", () => {
  it("is registered for PostToolUse (Bash|Skill|Read) and PostToolUseFailure (Bash) in kit/settings.hooks.json", () => {
    const settings = JSON.parse(readFileSync(path.join(KIT_FILES, "..", "settings.hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    const post = settings.hooks.PostToolUse?.find((g) => g.hooks.some((h) => h.command.includes("post-tool.mjs")));
    const failure = settings.hooks.PostToolUseFailure?.find((g) => g.hooks.some((h) => h.command.includes("post-tool.mjs")));
    expect(post?.matcher).toBe("Bash|Skill|Read");
    expect(failure?.matcher).toBe("Bash");
  });

  it("does not write when the .local folder is a symlink out of the repository", () => {
    const repo = makeRepo();
    const outside = tempDir("hermod-outside-");
    mkdirSync(repo.abs(".claude/hermod"), { recursive: true });
    spawnSync("ln", ["-s", outside, repo.abs(".claude/hermod/.local")]);
    quiet(fail(repo, "npm test"));
    expect(existsSync(path.join(outside, "ledger.jsonl"))).toBe(false);
  });
});
