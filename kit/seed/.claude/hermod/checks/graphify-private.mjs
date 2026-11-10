// @ts-check
// Lesson as a check: a Graphify graph maps a repository's structure, so it stays local. It is written under
// .claude/hermod/.local/ (self-ignoring). A changed graphify-out folder or graph report fails the check.

/** @type {import('../lib/checks.mjs').Check} */
export default {
  id: "graphify-private",
  description: "A Graphify graph (graphify-out/, GRAPH_REPORT.md) is never part of a change; keep it under .claude/hermod/.local/.",
  level: "error",
  when: ["**/graphify-out/**", "**/GRAPH_REPORT.md", "**/.graphify_*"],
  run(ctx) {
    const hits = (ctx.changedFiles ?? []).filter(
      (f) => /(^|\/)graphify-out\//.test(f) || /(^|\/)GRAPH_REPORT\.md$/.test(f) || /(^|\/)\.graphify_[^/]*$/.test(f),
    );
    if (hits.length === 0) return { ok: true };
    const shown = hits.slice(0, 5).join(", ") + (hits.length > 5 ? `, and ${hits.length - 5} more` : "");
    return {
      ok: false,
      message:
        `Graphify output in the change: ${shown}. It maps the repository, so keep it out of git: ` +
        "git rm --cached it, and rebuild with GRAPHIFY_OUT=.claude/hermod/.local/graphify-out.",
    };
  },
  examples: [
    { name: "passes for ordinary files", ctx: { changedFiles: ["src/a.ts"], files: { "src/a.ts": "x" } }, expect: true },
    { name: "fails on a graph file", ctx: { changedFiles: ["graphify-out/graph.json"], files: { "graphify-out/graph.json": "{}" } }, expect: false },
    { name: "fails on a report in a subfolder", ctx: { changedFiles: ["app/GRAPH_REPORT.md"], files: { "app/GRAPH_REPORT.md": "#" } }, expect: false },
  ],
};
