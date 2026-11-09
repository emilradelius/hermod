/**
 * The public API (src/index.ts): every block's exports reach the main entry point unchanged (a name two blocks share
 * would silently drop out of `export *`), the fake model stays in "hermod/testing", and the built library imports
 * cleanly with plain node and exports exactly the same names as the sources.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as channels from "../../src/channels/index.js";
import * as root from "../../src/index.js";
import * as learning from "../../src/learning/index.js";
import * as loop from "../../src/loop/index.js";
import * as memory from "../../src/memory/index.js";
import * as model from "../../src/model/index.js";
import * as modes from "../../src/modes/index.js";
import * as proposals from "../../src/proposals/index.js";
import * as safety from "../../src/safety/index.js";
import * as scheduler from "../../src/scheduler/index.js";
import * as skills from "../../src/skills/index.js";
import * as storage from "../../src/storage/index.js";
import * as testing from "../../src/testing/index.js";
import * as builtin from "../../src/tools/builtin/index.js";
import * as tools from "../../src/tools/index.js";
import * as types from "../../src/types.js";

const REPO = join(import.meta.dirname, "..", "..");

const BLOCKS: Record<string, Record<string, unknown>> = {
  types,
  storage,
  safety,
  model,
  tools,
  builtin,
  loop,
  memory,
  skills,
  proposals,
  learning,
  modes,
  scheduler,
  channels,
};

/** Names exported under another name because two blocks share them (memory's is the public one). */
const RENAMED: Record<string, Record<string, string>> = { loop: { DEFAULT_MEMORY_STORES: "DEFAULT_SNAPSHOT_STORES" } };

describe("the public API", () => {
  const api = root as Record<string, unknown>;

  it("re-exports every runtime export of every block, as the same value", () => {
    for (const [block, mod] of Object.entries(BLOCKS)) {
      const names = Object.keys(mod);
      expect(names.length, block).toBeGreaterThan(0);
      for (const name of names) {
        const exported = RENAMED[block]?.[name] ?? name;
        expect(api[exported], `${block}.${name}`).toBe(mod[name]);
      }
    }
    expect(root.VERSION).toBe("0.1.0");
    expect(root.DEFAULT_MEMORY_STORES).toBe(memory.DEFAULT_MEMORY_STORES);
    expect(root.DEFAULT_SNAPSHOT_STORES).toEqual(["memory", "user"]);
  });

  it("exports nothing that is not from a block (besides VERSION)", () => {
    const known = new Set<string>(["VERSION"]);
    for (const [block, mod] of Object.entries(BLOCKS)) for (const name of Object.keys(mod)) known.add(RENAMED[block]?.[name] ?? name);
    expect(Object.keys(api).filter((name) => !known.has(name))).toEqual([]);
  });

  it("keeps the fake model and its builders out of the main entry point", () => {
    for (const name of Object.keys(testing)) expect(api[name], name).toBeUndefined();
  });

  it("builds, and the built entry points import cleanly with node and export the same names", () => {
    // Inside node_modules so the build resolves its dependencies like an installed package would.
    const out = mkdtempSync(join(REPO, "node_modules", ".hermod-build-"));
    try {
      execFileSync(process.execPath, [join(REPO, "node_modules", "typescript", "bin", "tsc"), "-p", join(REPO, "tsconfig.build.json"), "--outDir", out], {
        cwd: REPO,
        stdio: "pipe",
      });
      const script = [
        `const main = await import(${JSON.stringify(pathToFileURL(join(out, "index.js")).href)});`,
        `const fake = await import(${JSON.stringify(pathToFileURL(join(out, "testing", "index.js")).href)});`,
        "const client = new fake.FakeModelClient([fake.textMessage('ok')]);",
        "const reply = await client.complete({ model: 'claude-opus-5-5', system: [], messages: [], maxTokens: 10, effort: 'low' });",
        "console.log(JSON.stringify({ main: Object.keys(main).sort(), testing: Object.keys(fake).sort(), version: main.VERSION, reply: reply.content[0].text }));",
      ].join("\n");
      const printed = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: REPO, encoding: "utf8" });
      const built = JSON.parse(printed) as { main: string[]; testing: string[]; version: string; reply: string };
      // Type-only exports vanish from both; every runtime name of the sources is in the build and vice versa.
      expect(built.main).toEqual(Object.keys(api).sort());
      expect(built.testing).toEqual(Object.keys(testing).sort());
      expect(built.version).toBe("0.1.0");
      expect(built.reply).toBe("ok");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
