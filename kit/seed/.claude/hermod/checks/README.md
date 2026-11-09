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
  path)` (text at a ref, or null), `diff(path)` (unified diff from base, "" when none) and `git(args)` (below).
  `run` may be async.
- `when` patterns: `dir/` matches everything under it, a plain path matches exactly, and `*` / `**` are globs.
- `git(args)` never throws and returns `{ ok, code, stdout, stderr, error }`, not a string: read `stdout` only
  when `ok` is true. Unlike `when`, its pathspecs are literal (no globs), so `ctx.git(['ls-files', '--',
  'src/*.ts'])` lists nothing; list the folder and filter the paths in code.
- In `--self-test`, `read` reads the example's `files`, `readAt` its `baseFiles`, and `git` always fails, so the
  examples never reach code that uses git. Try that code with a real `node .claude/hermod/check.mjs` run, which
  also runs checks that are not committed yet.

## Rules

- Plain Node 22, no dependencies, no network, no writes. Fast and deterministic: each check runs in its own
  worker and is stopped after 5 seconds.
- Read the repository's files as text and never run them: no `eval`, `new Function` or `node:vm`, and no
  `import` of an app or data file. `node:vm` is not a security boundary, so a pull request's files would run as
  code on the machine that runs the checks. Parse a data file instead.
- A failing message says what is wrong and how to fix it, in one or two sentences.
- No secrets or personal data in examples; build fake ones from pieces at runtime.
- New and changed checks go through a pull request a person merges. `/reflect` may propose one when a lesson
  can be checked by code.
