// @ts-check
// Lesson as a check: a Graphify graph maps a repository's structure. In a PUBLIC repository it must stay on the
// device (written under .claude/hermod/.local/, which is self-ignoring). In a PRIVATE repository a person can allow
// it to be committed, so it follows them between devices: create .claude/hermod/graph/ALLOW_COMMIT, and build into
// .claude/hermod/graph/graphify-out (GRAPHIFY_OUT). The marker must already be in the base commit, so opting in is
// its own reviewed change. Only graph.json, GRAPH_REPORT.md and memory/ may be committed there; everything else
// (cache, .graphify_* state, html, converted files) stays local. A deleted graph file is never a problem.
// It has no `when` list: the test is cheap, and one list of patterns cannot drift from a second one.

const ALLOWED_DIR = ".claude/hermod/graph/graphify-out/";
const MARKER = ".claude/hermod/graph/ALLOW_COMMIT";

/** @param {string} f */
const isGraphOutput = (f) =>
  /(^|\/)graphify-out[^/]*\//.test(f) || /(^|\/)GRAPH_(?:REPORT\.md|TREE\.html)$/.test(f) || /(^|\/)\.graphify_[^/]*$/.test(f);

/** @type {import('../lib/checks.mjs').Check} */
export default {
  id: "graphify-private",
  description:
    "A Graphify graph is committed only in a private repository that opted in earlier (.claude/hermod/graph/ALLOW_COMMIT in the base), and only graph.json, GRAPH_REPORT.md and memory/ under .claude/hermod/graph/graphify-out/.",
  level: "error",
  run(ctx) {
    const marker = typeof ctx.readAt === "function" ? ctx.readAt(ctx.base, MARKER) : null;
    const allowed = marker != null;
    const hits = (ctx.changedFiles ?? []).filter((f) => {
      if (!isGraphOutput(f)) return false;
      if (ctx.read(f) == null) return false; // deleted: removing a graph is the fix
      const rest = f.startsWith(ALLOWED_DIR) ? f.slice(ALLOWED_DIR.length) : null;
      return !(allowed && rest !== null && (rest === "graph.json" || rest === "GRAPH_REPORT.md" || rest.startsWith("memory/")));
    });
    if (hits.length === 0) return { ok: true };
    const shown = hits.slice(0, 5).join(", ") + (hits.length > 5 ? `, and ${hits.length - 5} more` : "");
    return {
      ok: false,
      message:
        `Graphify output in the change: ${shown}. It maps the repository. Public repository: keep it out of git ` +
        "(git rm --cached; build with GRAPHIFY_OUT=.claude/hermod/.local/graphify-out). Private repository: merge " +
        ".claude/hermod/graph/ALLOW_COMMIT first (its own change), then build into .claude/hermod/graph/graphify-out and commit only graph.json, GRAPH_REPORT.md and memory/.",
    };
  },
  examples: [
    { name: "passes for ordinary files", ctx: { changedFiles: ["src/a.ts"], files: { "src/a.ts": "x" } }, expect: true },
    { name: "fails on a graph file in the repository root", ctx: { changedFiles: ["graphify-out/graph.json"], files: { "graphify-out/graph.json": "{}" } }, expect: false },
    { name: "fails on a report in a subfolder", ctx: { changedFiles: ["app/GRAPH_REPORT.md"], files: { "app/GRAPH_REPORT.md": "#" } }, expect: false },
    { name: "fails on a renamed output folder", ctx: { changedFiles: ["graphify-out-feature/graph.json"], files: { "graphify-out-feature/graph.json": "{}" } }, expect: false },
    { name: "fails on a graphify state file", ctx: { changedFiles: [".graphify_python"], files: { ".graphify_python": "/usr/bin/python3" } }, expect: false },
    {
      name: "fails on the allowed folder when the repository did not opt in",
      ctx: { changedFiles: [".claude/hermod/graph/graphify-out/graph.json"], files: { ".claude/hermod/graph/graphify-out/graph.json": "{}" } },
      expect: false,
    },
    {
      name: "passes for the graph in the allowed folder when the repository opted in",
      ctx: {
        changedFiles: [".claude/hermod/graph/graphify-out/graph.json", ".claude/hermod/graph/graphify-out/GRAPH_REPORT.md"],
        baseFiles: { ".claude/hermod/graph/ALLOW_COMMIT": "private\n" },
        files: { ".claude/hermod/graph/graphify-out/graph.json": "{}", ".claude/hermod/graph/graphify-out/GRAPH_REPORT.md": "#" },
      },
      expect: true,
    },
    {
      name: "fails on the cache even when the repository opted in",
      ctx: {
        changedFiles: [".claude/hermod/graph/graphify-out/cache/ab.json"],
        baseFiles: { ".claude/hermod/graph/ALLOW_COMMIT": "private\n" },
        files: { ".claude/hermod/graph/graphify-out/cache/ab.json": "{}" },
      },
      expect: false,
    },
    {
      name: "fails on a graph outside the allowed folder even when the repository opted in",
      ctx: { changedFiles: ["graphify-out/graph.json"], baseFiles: { ".claude/hermod/graph/ALLOW_COMMIT": "private\n" }, files: { "graphify-out/graph.json": "{}" } },
      expect: false,
    },
    {
      name: "fails when the marker is added in the same change as the graph",
      ctx: {
        changedFiles: [".claude/hermod/graph/ALLOW_COMMIT", ".claude/hermod/graph/graphify-out/graph.json"],
        files: { ".claude/hermod/graph/ALLOW_COMMIT": "private\n", ".claude/hermod/graph/graphify-out/graph.json": "{}" },
      },
      expect: false,
    },
    {
      name: "passes for a memory file in the allowed folder when opted in earlier",
      ctx: {
        changedFiles: [".claude/hermod/graph/graphify-out/memory/q1.md"],
        baseFiles: { ".claude/hermod/graph/ALLOW_COMMIT": "private\n" },
        files: { ".claude/hermod/graph/graphify-out/memory/q1.md": "note" },
      },
      expect: true,
    },
    {
      name: "fails on a converted file in the allowed folder even when opted in earlier",
      ctx: {
        changedFiles: [".claude/hermod/graph/graphify-out/converted/a.md"],
        baseFiles: { ".claude/hermod/graph/ALLOW_COMMIT": "private\n" },
        files: { ".claude/hermod/graph/graphify-out/converted/a.md": "text" },
      },
      expect: false,
    },
    {
      name: "passes when a committed graph is deleted",
      ctx: { changedFiles: ["graphify-out/graph.json"], baseFiles: { "graphify-out/graph.json": "{}" }, files: {} },
      expect: true,
    },
  ],
};
