# The kit (Part A): developer guide

For people changing the kit. Target repositories get [`kit/files/.claude/hermod/README.md`](../kit/files/.claude/hermod/README.md)
instead. The code wins where this page differs. Paths without a prefix are under `kit/files/.claude/hermod/`.

## 1. What the kit is

| Piece | Files |
|---|---|
| Session brief | `hooks/session-start.mjs`, `lib/brief.mjs`, `brief.mjs` |
| Lessons | target's `.claude/hermod/LESSONS.md`, `lib/lessons.mjs` |
| Skills and validator | `kit/files/.claude/skills/`, `lib/skills.mjs`, `lib/frontmatter.mjs`, `validate.mjs` |
| Stop ritual check | `hooks/stop.mjs` |
| Session ledger | `hooks/post-tool.mjs`, `lib/ledger.mjs` |
| /reflect, reflect-prep | `kit/files/.claude/skills/reflect/`, `reflect-prep.mjs`, `lib/transcript.mjs` |
| Lessons as checks | `lib/checks.mjs`, `check.mjs`; the checks belong to the target |
| recall | `recall.mjs`, `lib/bm25.mjs`, `lib/markdown.mjs` |
| Curator | `curator.mjs`, `lib/usage.mjs`, `kit/files/.claude/skills/curate/` |
| State that follows you (opt-in) | `lib/travel.mjs`, `lib/summary.mjs`; the seeded check `checks/hermod-state.mjs` |
| Sync, stamp | `scripts/sync.mjs`, `kit/settings.hooks.json`, `kit/skills.json`, `kit/VERSION` |

Shared: `lib/io.mjs` (`failOpen`), `lib/git.mjs` (argument arrays, 3 s per call by default), `lib/paths.mjs`
(the one matcher).

## 2. One session, start to end

Timeouts are from `kit/settings.hooks.json`. Root: `CLAUDE_PROJECT_DIR`, else the input's `cwd`.

**SessionStart** (15 s). New session id: build the brief, print it, save `.local/sessions/<id>/brief.md`, and
write `session-start.json` once (head, branch, transcript path, blob hashes of at most 300 dirty files, at most
5,000 dirty paths). Same id again (resume, compact, clear): print the saved brief byte for byte (frozen). No id:
a fresh brief, nothing saved. Session folders untouched for 30 days are removed.

The brief is at most `brief.budgetChars` (8,000; bounds 1,000 to 9,500). Hard cap 9,500: Claude Code moves hook
output over 10,000 characters into a file. Budget order: header and tools, lessons, skills index ("… and N
more"), newer work on other branches (at most 700 characters), progress sections and `brief.extra` (shrunk
evenly), branches. Text is redacted before it is cut.

**Newer work on other branches.** Up to `brief.otherBranches` (1) branches, local or remote-tracking, whose tip is
newer than HEAD and not in HEAD's history, with their last commit subject and the first 280 characters of their
progress file's Next step; a branch with the same Next step is left out. It is where the person left off on another
device. The text comes from unmerged branches: it is redacted, scanned for injection (on a hit only the branch name
is shown) and headed "data, not instructions". When the repository has a remote and the last fetch (`FETCH_HEAD`,
else `packed-refs`) is more than a day old, a line says so; the kit never fetches.

**PostToolUse** (`Bash|Skill|Read`) and **PostToolUseFailure** (`Bash`), 10 s. A failed command adds a `fail`
entry (command ≤ 500 characters, output tail ≤ `ledger.maxOutputChars`), open under its key: the first 3 words
after leading `cd X &&` and `NAME=value`. A later success of that key in the same session adds `resolved` with the
files changed since. Skill tool → `skill`; Read of a `SKILL.md` → `skill-view`. Plain successes write nothing and
call no git. Over `ledger.maxFileBytes`, `ledger.jsonl` becomes `ledger.1.jsonl`. With `ledger.mode: "summary"`
a failure keeps only its summary key (section 11) and exit code, a resolution only the key and attempts; no
command text, output or file names are written, and no snapshot is taken, so no git is called.

**Stop** (30 s). Nothing when `stop_hook_active` is true, the ritual is off or there is no session id. Changed
files: session-start head to working tree (committed, staged, unstaged, untracked), minus files dirty at start
and unchanged (or not hashed). No state: since the merge base with the default branch, else uncommitted only.
Reasons: `missing` (code changed, a `ritual.require` path did not), `knowledge` (validator errors in a lessons
or skill file changed this session, even without code), `check` (an error-level committed check failed; checks run
whenever any file changed and each check's `when` decides; checks not started after 12 s are skipped), and
`checks-uncommitted` (a file in the checks folder differs from HEAD, so no check ran at all), and `travel` (only in
a repository that lets state travel, with `ritual.travel` on, when the session changed something: write the
session summary, commit the session's work, push; push status from local refs only). It blocks at most
once per reason (each reason key is kept in `stop.json`, a check's key is `check:<id>`; a later Stop blocks only
for a new reason) and at most `ritual.maxBlocksPerSession` times (2).
`stop.json` is written before the block is printed; if that fails, no block. The reason is ≤ 1,500 characters
and lists ≤ 5 changed paths.

**Fail open.** `failOpen` wraps every hook: an error or a watchdog timeout (8 s; 25 s for Stop) writes one
redacted line to `.local/errors.log` (under 100 KB), prints nothing, exits 0.

**State**: `.claude/hermod/.local/`, git-ignored by its own `.gitignore` (`*`): `sessions/<id>/`, `ledger.jsonl`,
`errors.log`, `reflect/`. Writes through a symlink out of the repository are refused. It stays on the device; what
may travel, in a repository that opted in, is in section 11.

## 3. config.json

Owned by the target. Missing or invalid values use `DEFAULTS` (`lib/config.mjs`); unknown keys warn. Objects merge
by key; lists replace. The seed equals `DEFAULTS` (tested).

| Key | Default (bounds) | Effect |
|---|---|---|
| `version` | 1 | Must be 1. |
| `brief.budgetChars` | 8000 (1000–9500) | Brief limit. |
| `brief.progress` | `docs/PROGRESS.md`, `["Status", "Next step"]`, 2500 per section (100–9500) | Headings shown (prefix match, any level). |
| `brief.includeLessons`, `includeSkills`, `includeGit` | true | Switch parts off. |
| `brief.maxBranches` | 6 (0–50) | Branches listed. |
| `brief.otherBranches` | 1 (0–3) | Newer branches shown with their Next step; 0 is off. |
| `brief.extra` | `[]` | `{ file, sections?, maxChars?, title? }` |
| `lessons.file`, `capChars`, `maxEntryChars` | `.claude/hermod/LESSONS.md`, 4000 (500–20000), 400 (50–2000) | Caps. |
| `skills.dir`, `indexChars` | `.claude/skills`, 60 (30–200) | Index line length. |
| `ritual.enabled` | true | Stop hook on. |
| `ritual.codePaths` | `src/ app/ lib/ scripts/ supabase/ public/ tests/ test/` | What is code. |
| `ritual.ignorePaths` | `.claude/ docs/ **/*.md` | Never code. |
| `ritual.require` | `docs/PROGRESS.md` (why: "Status, Next step, Not done") | Must change with code. |
| `ritual.remind` | `[]` | Shown in a block; never blocks. |
| `ritual.runChecks`, `validateKnowledge` | true | Checks, validation at Stop. |
| `ritual.maxBlocksPerSession` | 2 (1–5) | Block limit. |
| `ritual.travel` | true | The Stop reminder to write, commit and push, in a repository that lets state travel. |
| `ledger.enabled`, `maxOutputChars`, `maxFileBytes` | true, 2000 (200–20000), 2000000 (10000–100000000) | Ledger size. |
| `ledger.mode` | `"full"` (or `"summary"`) | `"summary"`: keys and exit codes only, never command text or output. |
| `ledger.extraRedactPatterns` | `[]` | Extra regexes, ledger only. |
| `recall.sources` | `docs/PROGRESS.md`, `docs/progress-archive/**/*.md`, `docs/decisions.md`, `.claude/hermod/history/**/*.md` | Searched files. |
| `recall.git`, `gitMaxCommits`, `limit`, `snippetChars` | true, 3000 (0–100000), 8 (1–100), 240 (40–2000) | Search. |
| `checks.dir`, `base` | `.claude/hermod/checks`, `auto` | `check.mjs` base. |
| `curator.staleDays`, `archiveDays` | 14, 30 (1–3650) | Days unused. |
| `curator.pinned` | `[]` | Never stale. |
| `curator.maxSkillLines`, `maxSkillChars` | 500, 20000 | "Too long". |
| `curator.overlapThreshold` | 0.55 (0–1) | Merge hint. |

Paths are repository-relative with `/` (no absolute, no `..`). `dir/` is a folder; `*`, `**`, `?` are globs.

## 4. Formats and limits

**LESSONS.md.** An optional H1 and the first HTML comment are the header. Entries are split on lines holding
only `§`. Errors: entries over `capChars`; an empty, duplicate (case and spacing ignored) or
over-`maxEntryChars` entry; an entry starting with `#`; injection errors; secrets. Warnings: over 300 characters,
an imperative start ("always", "never" …), a date, a pull request or issue reference.

**SKILL.md** (agentskills.io). Errors: no `SKILL.md` or frontmatter; `name` missing, not
`^[a-z0-9]+(-[a-z0-9]+)*$`, over 64 or not the folder name; `description` missing, empty or over 1,024; a link into
`references/`, `scripts/`, `templates/` or `assets/` that is missing or leaves the folder; injection errors;
secrets. Warnings: frontmatter keys outside agentskills.io and Claude Code's (`lib/skills.mjs`); first sentence over `skills.indexChars`; body over `curator.maxSkillLines`; other folder entries;
`description` + `when_to_use` over 1,536. Index line: `name: <first sentence cut at a word>`.

## 5. Checks

`.claude/hermod/checks/<id>.mjs` exports `{ id, description, level, when?, run(ctx), examples }`; `id` is the
file name, `level` `error` or `warn` (never blocks), at least one passing and one failing example. `ctx`: `root`,
`base`, `changedFiles`, `read`, `readAt`, `diff`, `git` (never throws). Each check runs in a worker thread, 4 at a
time, at most 5 s; a throw, timeout or bad return fails; messages are cut to 500 characters.

`check.mjs --self-test` runs the examples on a fake `ctx` from `files`, `baseFiles` and `changedFiles` (no git).
The Stop hook runs committed checks only, against the session-start head. `check.mjs` also runs uncommitted ones,
against `--base`, else `checks.base`. Exit 0 pass, 1 fail, 2 usage. A new check: one known mistake, a narrow
`when`, both kinds of example, then `--self-test`.

```js
// @ts-check
const pkg = (v) => ({ "package.json": `{\n  "version": "${v}"\n}\n` });
/** @type {import('../lib/checks.mjs').Check} */
export default {
  id: "changelog-with-version",
  description: "A version bump in package.json comes with a CHANGELOG.md change",
  level: "error",
  when: ["package.json"],
  run(ctx) {
    const bumped = /^[+-]\s*"version"\s*:/m.test(ctx.diff("package.json"));
    if (!bumped || ctx.changedFiles.includes("CHANGELOG.md")) return { ok: true };
    return { ok: false, message: "package.json has a new version; update CHANGELOG.md" };
  },
  examples: [
    { name: "with a changelog", expect: true,
      ctx: { changedFiles: ["package.json", "CHANGELOG.md"], files: pkg("1.1.0"), baseFiles: pkg("1.0.0") } },
    { name: "without one", expect: false,
      ctx: { changedFiles: ["package.json"], files: pkg("1.1.0"), baseFiles: pkg("1.0.0") } },
  ],
};
```

## 6. /reflect, recall and the curator

Each only proposes or reports.

- **reflect-prep.mjs** reads the session state, git since the start head, this session's ledger, the user's last
  40 messages from the transcript (≤ 400 characters each), lessons, skills, checks and the validator. It writes a
  redacted bundle under 40,000 bytes to `.local/reflect/<session>.md`, which lists earlier sessions on the same branch
  from their summaries (any device). `--write-usage` writes this session's summary (section 11) when the
  repository lets state travel, and otherwise writes nothing and says why.
- **/reflect**: an independent sub-agent reads the bundle and `references/review-rules.md` and answers in
  `references/proposal-format.md`. The session checks the evidence, edits files, runs `validate.mjs` and
  `check.mjs --self-test`, and commits `hermod: proposals from /reflect`. A person merges.
- **recall.mjs** reads `recall.sources` (800-character chunks) and commit messages. BM25 (k1 1.2, b 0.75),
  headings count double, diacritics fold, identifiers split, 4+ letter words fall back to prefixes. Writes nothing.
- **curator.mjs** reads skills, git dates, the session summaries (`state/sessions/*.json`, every device's), older
  `usage/*.json` files (a session is counted once), the local ledger, lessons and `VERSION.json`. Pinned
  and kit-owned skills are exempt. With the ledger off no use is recorded, so no skill is called stale or an archive
  candidate, and the report says so. Lessons: near-duplicates at Jaccard 0.6, restating a skill at 80 %. Output to
  stdout or `--out` (inside `.local/`, or absolute outside the repository). **/curate** (person-started:
  `disable-model-invocation: true`) proposes a pull request; it archives, never deletes.

## 7. Safety properties

| Property | Enforced in | Tested in (`test/kit/`) |
|---|---|---|
| Zero dependencies, no network (imports, `fetch`) | `.claude/hermod/checks/kit-zero-deps.mjs` (this repo's check) | its examples, `check.mjs --self-test` in CI |
| Redaction: 30 secret and 2 personal-data patterns (e-mail, Swedish personal identity number); SHAs and UUIDs kept | `lib/redact.mjs`, on the ledger, session state, brief, `errors.log`, Stop reason, reflect bundle, curator report | `lib-redact`, `post-tool`, `brief`, `session-start`, `reflect-prep` |
| Injection scan: 14 rules (English and Swedish overrides, role hijacks, exfiltration, shells) and hidden Unicode | `lib/injection.mjs` via the lessons and skill validators | `lib-injection`, `lib-lessons`, `lib-skills` |
| Fail open, never loop | `failOpen`; `stop_hook_active`, fingerprints, block limit | `lib-io`, `stop`, `session-start` |
| Never rewrites CLAUDE.md, `.claude/` or hooks | hooks write only `.local/`; CLIs also write only the session summary and `--out` | `reflect-prep`, `curator`, `validate`, `brief`, `post-tool` |
| Device state never travels; a session summary travels only after a person merged the marker, as plain-word keys | `lib/travel.mjs`, `lib/summary.mjs`, the seeded `hermod-state` check, sync's path rules | `travel`, `reflect-prep`, `seed` |
| Sync touches only its files and hook entries, at a pinned ref | `scripts/sync.mjs` | `sync` |

## 8. Sync and releases

`node scripts/sync.mjs --target ../repo --ref v0.1.0 [--skills a,b|all|none] [--dry-run] [--json]`

- `--ref` is a tag or a 40-character SHA; branches, short SHAs and `HEAD` are refused. Files are read at that
  commit, never from the working tree.
- It copies `kit/files/**` (all under `.claude/`). Seeds (`config.json`, `LESSONS.md`, `checks/README.md`, `checks/graphify-private.mjs`, `checks/hermod-state.mjs`) are created only if missing. No kit file or seed may be an `ALLOW_COMMIT` marker or lie under `.claude/hermod/state/`: opting in is a person's act.
- Stamp `.claude/hermod/VERSION.json`: `kit`, `ref`, `commit`, `syncedAt`, `skills`, a sha256 per file.
- Conflicts: a file at a kit path that no sync wrote (even with `--force`); a kit file changed locally (unless
  `--force`). Dropped kit files are deleted only if unchanged. On a conflict nothing is written (exit 1).
- Uncommitted changes under `.claude/` are refused unless `--allow-dirty`. In `.claude/settings.json` only
  handlers whose command contains `/.claude/hermod/hooks/` are replaced.
- Skills: `reflect`, `curate` are core; `kit/skills.json` lists the optional ones. Default: none on a first
  install, then the stamp's choice.
- `--dry-run` writes nothing. Exit 0 done, 1 refused, 2 usage.

Releases: "Releasing the kit" in [`CLAUDE.md`](../CLAUDE.md).

## 9. Working on the kit

Hermod uses its own kit: `.claude/settings.json` runs the hooks from `kit/files/` directly (no sync
needed), and `.claude/hermod/config.json` sets `skills.dir` to `kit/files/.claude/skills` and counts `kit/` as code.

```bash
npm run typecheck:kit
npx vitest run test/kit
node kit/files/.claude/hermod/validate.mjs --root . --kit
node kit/files/.claude/hermod/check.mjs --root . --self-test
```

Tests run hooks and CLIs in temporary git repositories (`test/kit/helpers.ts`: `makeRepo`, `runHook`) and import
libraries directly (`test/kit/kit-lib-tests-helpers.ts`). Rules:

- Build fake secrets at runtime, e.g. `["sk", "ant", "api03", body].join("-")` (`no-secret-literals` enforces it).
- Pin everything exactly: no `@latest` or `@canary` in docs, skills or scripts, actions by full commit SHA, runners,
  images and Node by exact version (`no-floating-versions` enforces it).
- A test must fail when the behaviour breaks; never weaken `test/**/proposals*` or `test/**/invariants*`.
- Kit files start with `// @ts-check` and import only `node:` builtins and relative paths.
- Change `DEFAULTS`, the seed `config.json` and this page together.

## 10. Known limits

- The Stop hook checks that a required file changed, not that it is right, and gives up after the block limit.
- Redaction and injection scans are patterns; new formats get through. recall prints repository text unredacted.
- Checks are not sandboxed: the worker stops hangs, not file access. Review them like code.
- `.local/` is per machine; a cloud container loses the ledger. Only in a repository that opted in does a summary
  of each session travel, and only once the session commits and pushes it. A new transcript format leaves
  reflect-prep without messages.
- A summary key keeps a lower-case word as a listed tool's subcommand (`git anything`) or as a script name after
  `npm run`; a secret or a name typed exactly there would travel. Glued flag values, paths, quoted text, e-mail
  addresses, identity numbers, `name=value` pairs and other arguments never do.
- The hooks run only when Claude Code starts in the repository (its project folder). A session started above it,
  for example one cloud session over several repositories, gets no brief, no ledger and no Stop check, and
  reflect-prep finds no session; /reflect's evidence then has to be gathered by hand.
- Targets update only when a person runs sync. recall is keyword search, not semantic.
- CI runs on Linux only. hermod's CI runs its own checks on the diff against `main`; a target's CI runs only what
  that repository adds (for example the validator).

## 10. Graphify (optional skill)

Graphify is a separate tool that turns code into a queryable graph (tree-sitter, local, no model call in code-only
mode). Hermod does not contain it and does not depend on it. `--skills graphify` installs a skill that tells Claude
when to ask the graph instead of grepping, and how to do it safely:

- The graph maps a repository, so where it lives is a per-repository choice (Emil, 2026-11-10: it must follow him
  between devices). Default, and always for a public repository: `.claude/hermod/.local/graphify-out`, which the
  hooks keep out of git; another device rebuilds it. A person opts a **private** repository in by creating
  `.claude/hermod/graph/ALLOW_COMMIT` (and a `.gitignore` there for `cache/` and `.graphify_*`); the graph is then
  built into `.claude/hermod/graph/graphify-out` and committed. The seeded check `graphify-private` fails any graph
  output in a change except `graph.json`, the report and `memory/` in that folder of an opted-in repository.
- Always `--code-only`, never another model provider, and never `graphify install`, `graphify hook install` or
  `graphify uninstall` (they edit `CLAUDE.md`, settings and git hooks, which only sync may do).
- The tool is installed by a person, pinned to a full commit of the private `graphify-kit` copy. Sync does not
  install it and runs no program except git. A repository that never chooses the skill never sees any of this,
  except the seeded check, which does nothing when no graph file is in a change. Another device or a cloud session
  needs graphify installed (a setup step) before it can rebuild; a committed graph can be queried once it is.
- Verified by a person on Windows (graphify 0.9.105, a real repository): build, `god-nodes`, `explain`, `affected`. Not yet run: `query`, `path`, and any use in a live Claude Code session.


## 11. State that follows you between devices (opt-in, private repositories)

A person who works on several devices (a laptop, a phone, cloud sessions) decides per repository whether
Hermod's working state follows them through git. A **public** repository (Hermod included) never opts in: its state stays in `.local/`.

| State | Where | Kind | Travels |
|---|---|---|---|
| Lessons, skills, checks, config | committed | lived | yes, through pull requests a person merges (as before) |
| Proposals | edits on the working branch, listed in the pull request | lived | when the branch is pushed |
| Decisions, progress | the repository's `docs/` | lived | yes; the brief also shows newer branches' Next step |
| Curation results | `archive/`, through a `/curate` pull request | lived | yes |
| Ledger and skill use | `.local/ledger.jsonl` | lived; can hold personal text | **only as a session summary**, opted-in only |
| Session hook state, frozen brief, reflect bundle, `errors.log`, curator report | `.local/` | derived | never; rebuilt on each device |

**Opting in.** A person creates `.claude/hermod/state/ALLOW_COMMIT` and merges it to the default branch. It counts
only on the remote default branch (`origin/HEAD`'s branch when `origin/HEAD` is set, and nothing when that branch is
gone; without it `origin/main`, else `origin/master`; a local branch never counts), so a marker created during a
session has no effect until a person merges it. Sync refuses to ship
one; the hooks and scripts never write one.

**What travels.** One file per session, `.claude/hermod/state/sessions/<YYYY-MM-DD>-<id8>.json`, written by
`reflect-prep.mjs --write-usage` and committed with the session's work:

```json
{ "v": 1, "session": "<uuid>", "date": "2026-11-10", "branch": "claude/x",
  "skills": { "reflect": { "uses": 1, "views": 2 } },
  "commands": [ { "key": "npm run build", "exit": 1, "attempts": 2, "resolved": true } ] }
```

A command's **key** (`lib/summary.mjs`, built from the shell's own tokens by `summaryKeyOf` in `lib/ledger.mjs`) is
at most three words, and every word that does not qualify becomes `…`. A quoted or escaped token never qualifies.
The first word is the program: only its name stays (its folder dropped), in lower case. A later word stays only
when it is a flag of one to three letters (`-x`, `-rn`) or a long name (`--fix`), when it is the second word and
the program takes subcommands (`TOOLS_WITH_SUBCOMMANDS`: `git push`, `npm run`), or when it is the third word and
names a script after a package manager's `run` (`npm run build`). Every kept word is also plain: at most 40
characters, no run of 6+ digits or 16+ letters and digits, unchanged by the redactor. So a value glued to a flag,
a path, a file name and prose never travel: `mysql -uroot -pSecret shop` → `mysql … …`, `cat "notes/x y.md"` →
`cat …`, `node scripts/sync.mjs --target` → `node … --target`. The session id must be a UUID (an 8-digit prefix
alone could be a date of birth). One file per session means two devices never edit the same file, so there are
no merge conflicts.

**What enforces it.** The seeded check `hermod-state` (an error) fails a change that contains `.local/` files, a
new `usage/` file, any file under `state/` while the marker is not on the remote default branch, any file under
`state/` other than the marker and `sessions/*.json`, or a summary that breaks the rules above. It imports nothing,
so it repeats the rules; `test/kit/travel.test.ts` keeps the two in step and checks that hermod's own copy is the
seed. The Stop hook's `travel` reason asks, once, for the summary, the commit and the push.
