// @ts-check
// Lesson as a check: kit/files is copied into other repositories and runs as their hooks, so it has zero
// dependencies and makes no network calls. A changed .mjs/.js file under kit/files/ fails when it imports
// anything but a node: builtin or a relative path, imports a networking builtin, or calls fetch/WebSocket.
// Whole-line comments are skipped.

const JS = /\.(?:mjs|js)$/;
const NETWORK = new Set(["node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dgram", "node:dns"]);
const STATIC = /^\s*(?:import|export)\b[^'"`]*?\bfrom\s*['"]([^'"]+)['"]/;
const BARE = /^\s*import\s*['"]([^'"]+)['"]/;
const DYNAMIC = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const CALLS = /\b(?:fetch|WebSocket|EventSource)\s*\(/;

/** @param {string} p */
const posix = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");

/** @param {string} spec */
function problem(spec) {
  if (spec.startsWith("./") || spec.startsWith("../")) return null;
  if (!spec.startsWith("node:")) return `imports "${spec}" (only node: builtins and relative paths)`;
  if (NETWORK.has(spec)) return `imports ${spec} (the kit makes no network calls)`;
  return null;
}

/**
 * Lines that are not whole-line comments, with their 1-based numbers.
 * @param {string} text
 * @returns {Array<[number, string]>}
 */
function codeLines(text) {
  /** @type {Array<[number, string]>} */
  const out = [];
  let inBlock = false;
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((raw, i) => {
      let line = raw;
      if (inBlock) {
        const end = line.indexOf("*/");
        if (end < 0) return;
        line = line.slice(end + 2);
        inBlock = false;
      }
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*")) return;
      if (t.startsWith("/*")) {
        const end = t.indexOf("*/", 2);
        if (end < 0) {
          inBlock = true;
          return;
        }
        line = t.slice(end + 2);
      }
      out.push([i + 1, line]);
    });
  return out;
}

/** @param {string} text */
function findings(text) {
  /** @type {string[]} */
  const found = [];
  for (const [n, line] of codeLines(text)) {
    /** @type {string[]} */
    const specs = [];
    const s = STATIC.exec(line) ?? BARE.exec(line);
    if (s?.[1]) specs.push(s[1]);
    for (const m of line.matchAll(DYNAMIC)) if (m[1]) specs.push(m[1]);
    for (const spec of specs) {
      const why = problem(spec);
      if (why) found.push(`line ${n} ${why}`);
    }
    if (CALLS.test(line)) found.push(`line ${n} makes a network call`);
  }
  return found;
}

/** @type {import('../../../kit/files/.claude/hermod/lib/checks.mjs').Check} */
export default {
  id: "kit-zero-deps",
  description: "kit/files imports only node: builtins and relative paths and makes no network calls.",
  level: "error",
  when: ["kit/files/"],
  run(ctx) {
    /** @type {string[]} */
    const hits = [];
    for (const given of ctx.changedFiles ?? []) {
      const rel = posix(given);
      if (!rel.startsWith("kit/files/") || !JS.test(rel)) continue;
      const text = ctx.read(given);
      if (text === null || text === undefined) continue; // deleted
      for (const f of findings(String(text))) hits.push(`${rel} ${f}`);
    }
    if (!hits.length) return { ok: true };
    const shown = hits.slice(0, 5).join("; ") + (hits.length > 5 ? `; and ${hits.length - 5} more` : "");
    return {
      ok: false,
      message:
        `The kit must stay dependency-free and offline: ${shown}. Use a node: builtin or a relative module, ` +
        "or move the code out of kit/files (into src/ for the runtime).",
    };
  },
  examples: [
    {
      name: "passes for node: builtins and relative imports, and for the words in comments",
      ctx: {
        changedFiles: ["kit/files/.claude/hermod/lib/x.mjs"],
        files: {
          "kit/files/.claude/hermod/lib/x.mjs":
            'import fs from "node:fs";\nimport { a } from "./a.mjs";\nexport { b } from "../b.mjs";\n// fetch(url) from "zod" is only a comment\nconst m = await import("./lazy.mjs");\n',
        },
      },
      expect: true,
    },
    {
      name: "passes for files outside kit/files",
      ctx: { changedFiles: ["src/index.ts"], files: { "src/index.ts": 'import { z } from "zod";\n' } },
      expect: true,
    },
    {
      name: "fails on a package import",
      ctx: {
        changedFiles: ["kit/files/.claude/hermod/hooks/y.mjs"],
        files: { "kit/files/.claude/hermod/hooks/y.mjs": 'import { z } from "zod";\n' },
      },
      expect: false,
    },
    {
      name: "fails on a networking builtin or a fetch call",
      ctx: {
        changedFiles: ["kit/files/.claude/hermod/lib/n.mjs", "kit/files/.claude/hermod/lib/f.mjs"],
        files: {
          "kit/files/.claude/hermod/lib/n.mjs": 'import https from "node:https";\n',
          "kit/files/.claude/hermod/lib/f.mjs": "const r = await fetch(url);\n",
        },
      },
      expect: false,
    },
  ],
};
