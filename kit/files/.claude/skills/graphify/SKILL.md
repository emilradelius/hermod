---
name: graphify
description: Query a local code knowledge graph instead of grepping. Use when exploring an unfamiliar codebase, finding what calls or depends on something, tracing how two things connect, or sizing a change before editing; and before you read many files just to understand structure.
---

# Graphify: ask the graph, then read the few files that matter

Graphify (a separate tool, not part of Hermod) parses code with tree-sitter into a graph of files, functions,
classes, imports and calls. A query returns a small subgraph, so you read a few files instead of searching many.
Code parsing is local: no model call, nothing leaves the machine.

## Hard rules

1. **The graph maps the repository, so it lives in one of two places.** Default, and always in a public
   repository: `.claude/hermod/.local/graphify-out` (self-ignoring; it stays on the device and is rebuilt on
   another). In a **private** repository that a person has opted in, by creating `.claude/hermod/graph/ALLOW_COMMIT`,
   build into `.claude/hermod/graph/graphify-out` so the graph is committed and follows the person between devices.
   Never create `ALLOW_COMMIT` yourself. Commit only `graph.json`, `GRAPH_REPORT.md` and `memory/` there, never
   `cache/` or `.graphify_*` (a `.claude/hermod/graph/.gitignore` listing both makes that automatic). Never paste or
   upload the graph, and never write it anywhere else, in particular not the default `graphify-out/` in the
   repository root. A check in `.claude/hermod/checks/` fails a change that breaks this.
2. **Code only.** Always pass `--code-only`. Never run the document, image or video pass: it sends file contents to
   a model, and this repository allows Anthropic only. Never pass `--backend` with another provider.
3. **Do not install it into the assistant.** Never run `graphify install`, `graphify hook install` or
   `graphify uninstall`: they edit `CLAUDE.md`, settings and git hooks, which only Hermod's sync may do.
4. **Trust the tags.** `EXTRACTED` is read from the source; `INFERRED` is a guess. Open the file before you rely on
   an `INFERRED` edge. A missing edge is not proof that nothing calls something.

## Setup (a person does this once per computer)

The tool is pinned to the private copy `graphify-kit`, at a tag or full commit sha, never a branch:

```bash
uv tool install "git+https://github.com/<owner>/graphify-kit@<full sha>"
graphify --version
```

`uv tool install` ignores graphify's `uv.lock`, so its dependencies resolve from version ranges: two computers on
the same sha can run different dependency versions. Note `uv tool list` next to a result you rely on. Graphify
also refreshes assistant skill files it installed earlier, on any command that is not `--version` or `--help`;
if it was ever installed into an assistant on this computer, expect those files to change outside the repository.

## Procedure

Verified on Windows PowerShell with graphify 0.9.105 on a real repository: the build, `god-nodes`, `explain` and
`affected` (the graph landed under `.local`, nothing appeared in the repository root, and no model was called).
`query` and `path` have not been run yet. If a command fails or the graph is not where step 1 looks, stop and tell
the person; do not fall back to the default `graphify-out/`.

1. Pick the folder: `D=.claude/hermod/graph/graphify-out` if `.claude/hermod/graph/ALLOW_COMMIT` exists,
   otherwise `D=.claude/hermod/.local/graphify-out`. Check whether `$D/graph.json` exists. After a `git pull` from
   another device, a committed graph may already be there.
2. If not, or after large changes, build it (code only):
   ```bash
   GRAPHIFY_OUT=$D graphify extract . --code-only --no-viz
   ```
   In PowerShell set the variable first: `$env:GRAPHIFY_OUT = ".claude/hermod/graph/graphify-out"` (or the `.local`
   path). Re-runs skip unchanged files, so a rebuild is cheap. In a repository that commits its graph, commit the
   rebuilt `graph.json` and report in the same pull request as the code change they describe. On a merge conflict in
   them, rebuild; never merge the JSON by hand.
3. Ask, with `--graph` pointing at that file:
   ```bash
   G=$D/graph.json
   graphify query "how does login reach the database" --graph $G
   graphify explain "SessionStore" --graph $G
   graphify path "Router" "Database" --graph $G
   graphify affected "parseConfig" --graph $G --depth 1   # what breaks if this changes; depth 2 can list 100+ lines
   graphify god-nodes --graph $G                          # the most connected hubs
   ```
   `query`, `explain` and `path` exit 3 when a name is ambiguous (the candidates are listed) and 4 when nothing
   matches: pick a candidate or rephrase.
4. Read the files the answer names. Edit as usual.

## When not to use it

- A repository of a few files: reading them is cheaper than building a graph.
- Questions about behaviour at run time, data, or text in docs: the graph holds structure only.
- When the graph is older than the last big change and you cannot rebuild: say so, and fall back to search.
