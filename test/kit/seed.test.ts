// The kit's own documentation must never point a target repository at a .claude/hermod/ file the kit does not
// ship: every such path in kit/files/**/*.md and kit/seed/**/*.md is either copied by sync (kit/files), created
// once by it (kit/seed), or one of the few paths that sync or the hooks create at run time.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SHIPPED = [path.join(ROOT, "kit/files"), path.join(ROOT, "kit/seed")];
/** Created at run time: the stamp by sync, the rest by the hooks and the curator. */
const RUNTIME_PREFIXES = [".claude/hermod/VERSION.json", ".claude/hermod/.local/", ".claude/hermod/usage/", ".claude/hermod/archive/"];

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

function referencedPaths(): Map<string, string> {
  const refs = new Map<string, string>();
  for (const dir of SHIPPED) {
    for (const file of markdownFiles(dir)) {
      for (const m of readFileSync(file, "utf8").matchAll(/`(\.claude\/hermod\/[^`\s]*)`/g)) {
        const ref = m[1] ?? "";
        if (/[<>*{}]/.test(ref)) continue; // placeholders and globs name a kind of path, not one path
        refs.set(ref, path.relative(ROOT, file));
      }
    }
  }
  return refs;
}

function shipped(ref: string): boolean {
  return SHIPPED.some((dir) => existsSync(path.join(dir, ref)) && (ref.endsWith("/") ? readdirSync(path.join(dir, ref)).length > 0 : true));
}

describe("kit seed and references", () => {
  it("the seed holds config.json, LESSONS.md and checks/README.md", () => {
    for (const rel of [".claude/hermod/config.json", ".claude/hermod/LESSONS.md", ".claude/hermod/checks/README.md"]) {
      expect(existsSync(path.join(ROOT, "kit/seed", rel)), rel).toBe(true);
    }
  });

  it("the checks README shows the shape the runner validates", () => {
    const text = readFileSync(path.join(ROOT, "kit/seed/.claude/hermod/checks/README.md"), "utf8");
    for (const needle of ["export default", "id:", "description:", "level:", "run(ctx)", "examples:", "--self-test"]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("every .claude/hermod/ path the kit's docs name is shipped or created at run time", () => {
    const refs = referencedPaths();
    expect(refs.size).toBeGreaterThan(5);
    const missing = [...refs].filter(([ref]) => !shipped(ref) && !RUNTIME_PREFIXES.some((p) => ref.startsWith(p)));
    expect(missing.map(([ref, file]) => `${ref} (named in ${file})`)).toEqual([]);
  });
});
