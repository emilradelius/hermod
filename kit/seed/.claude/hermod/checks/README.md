# Checks

A check is a lesson that code can check. Each file here, `<id>.mjs`, protects against one known mistake. The
Stop hook runs the committed checks on the files a session changed, and `node .claude/hermod/check.mjs` runs
them by hand (`--self-test` runs every check's examples instead). This folder belongs to this repository: the
kit's sync never changes it.

## The shape

```js
// @ts-check
/** @type {import('../lib/checks.mjs').Check} */
export default {
  id: "no-todo-in-config",            // the file name without .mjs
  description: "One line: the mistake this protects against.",
  level: "error",                     // "warn" reports but never blocks
  when: ["config/"],                  // optional: run only when a changed file matches
  run(ctx) {
    const bad = ctx.changedFiles.filter((f) => f.startsWith("config/") && (ctx.read(f) ?? "").includes("TODO"));
    return bad.length === 0 ? { ok: true } : { ok: false, message: `TODO left in ${bad.join(", ")}.` };
  },
  examples: [                         // at least one passing and one failing example
    { name: "passes for a clean file", ctx: { changedFiles: ["config/app.json"], files: { "config/app.json": "{}" } }, expect: true },
    { name: "fails on a TODO", ctx: { changedFiles: ["config/app.json"], files: { "config/app.json": "TODO" } }, expect: false },
  ],
};
```

- `ctx` holds `root`, `base`, `changedFiles` (posix paths), `read(path)` (working tree, or null), `readAt(ref,
  path)` (text at a ref, or null), `diff(path)` (unified diff from base, "" when none) and `git(args)` (never
  throws). `run` may be async.
- `when` patterns: `dir/` matches everything under it, a plain path matches exactly, and `*` / `**` are globs.
- In `--self-test`, `read` reads the example's `files`, `readAt` its `baseFiles`, and `git` always fails.

## Rules

- Plain Node 22, no dependencies, no network, no writes. Fast and deterministic: each check runs in its own
  worker and is stopped after 5 seconds.
- A failing message says what is wrong and how to fix it, in one or two sentences.
- No secrets or personal data in examples; build fake ones from pieces at runtime.
- New and changed checks go through a pull request a person merges. `/reflect` may propose one when a lesson
  can be checked by code.
