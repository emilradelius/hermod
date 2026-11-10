---
name: graphify
description: Query a local code knowledge graph instead of grepping. Use when exploring an unfamiliar codebase, finding what calls or depends on something, tracing how two things connect, or sizing a change before editing; and before you read many files just to understand structure.
---

# Graphify: ask the graph, then read the few files that matter

Graphify (a separate tool, not part of Hermod) parses code with tree-sitter into a graph of files, functions,
classes, imports and calls. A query returns a small subgraph, so you read a few files instead of searching many.
Code parsing is local: no model call, nothing leaves the machine.

## Hard rules

1. **The graph is private.** It maps the repository's structure. Keep it out of git: always write it under
   `.claude/hermod/.local/` (self-ignoring), never to the default `graphify-out/` in the repository. Never commit,
   paste or upload `graph.json`, `graph.html` or `GRAPH_REPORT.md`. A check in `.claude/hermod/checks/` fails when
   one is changed in a commit.
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

## Procedure

1. Check whether a graph exists: `ls .claude/hermod/.local/graphify-out/graph.json`.
2. If not, or after large changes, build it (code only, output under `.local`):
   ```bash
   GRAPHIFY_OUT=.claude/hermod/.local/graphify-out graphify extract . --code-only --no-viz
   ```
   Re-runs skip unchanged files, so a rebuild is cheap.
3. Ask, with `--graph` pointing at that file:
   ```bash
   G=.claude/hermod/.local/graphify-out/graph.json
   graphify query "how does login reach the database" --graph $G
   graphify explain "SessionStore" --graph $G
   graphify path "Router" "Database" --graph $G
   graphify affected "parseConfig" --graph $G      # what breaks if this changes
   graphify god-nodes --graph $G                   # the most connected hubs
   ```
   `query`, `explain` and `path` exit 3 when a name is ambiguous (the candidates are listed) and 4 when nothing
   matches: pick a candidate or rephrase.
4. Read the files the answer names. Edit as usual.

## When not to use it

- A repository of a few files: reading them is cheaper than building a graph.
- Questions about behaviour at run time, data, or text in docs: the graph holds structure only.
- When the graph is older than the last big change and you cannot rebuild: say so, and fall back to search.
