# Hermod

Hermod helps Claude Code, and agents inside your own apps, learn from their work **without letting the AI change
its own rules**.

It borrows the useful parts of a "learning loop" (bounded memory, curated skills, a review at the end of a session,
search over past work, scheduled runs) and adds the one rule the research supports: **the agent only proposes; a
person or a test decides.** See [`docs/research.md`](docs/research.md) for the evidence.

## The two parts

### Part A: the kit, for building software with Claude Code

A folder of small, plain Node scripts and skills that lives **inside each repository**, committed and pinned. It
needs no network, no extra AI provider and no installs. It gives every Claude Code session (local or cloud):

| Piece | What it does |
|---|---|
| **Session brief** (SessionStart hook) | A short, frozen brief at the start of each session: status and next step from the progress file, the lessons, the skills index, branches. Never more than 8,000 characters by default. |
| **Lessons** (`.claude/hermod/LESSONS.md`) | Short facts that save time, capped at about 4,000 characters, checked by a validator. |
| **Curated skills** (`.claude/skills/*/SKILL.md`) | Step-by-step procedures in the open `SKILL.md` format, checked by a validator. |
| **Ritual check** (Stop hook) | If a session changed code but not the progress file, it blocks once with a clear reason. It never loops. |
| **Session ledger** (PostToolUse hook) | Failed commands, and what fixed them, go to a local, git-ignored file, with secrets redacted. |
| **`/reflect`** | At the end of a session, an independent reviewer proposes lesson, skill or check changes, each with evidence, inside the pull request. "Nothing to save" is a fine outcome. |
| **Checks** | A lesson that can be checked by code becomes a check, with its own passing and failing examples. |
| **`recall`** | `node .claude/hermod/recall.mjs "query"` searches progress logs, decisions and git history (BM25, no dependencies). |
| **`/curate`** | A monthly report of unused, overlapping and too-long skills and lessons, turned into a pull request. |
| **`sync`** | Copies a pinned version of the kit into a repository, touching only the files and hook entries it owns. |

### Part B: the runtime, for agents inside apps

A small TypeScript library on the official Anthropic SDK (`@anthropic-ai/sdk`), for agents that run inside your own
app, on your own hosting, with your data in your own database:

- an agent loop with a tool registry, parallel read-only tools, budgets, an error classifier and a cost ledger;
- storage adapters for Postgres (Supabase) and SQLite, with full-text search over past sessions;
- bounded memory with a frozen snapshot per session, skills with versions, and **proposals** that wait for approval;
- modes (off, shadow, supervised, autonomous) with shadow scoring against an accuracy bar;
- a post-session review on a cheap model that writes proposals only, and a curator that never deletes;
- a scheduler (`tick()`), delivery channels (in-app, web push, optional Telegram), and safety hooks (redaction,
  untrusted-content wrapping, injection scan, a hard denylist, sub-agents with blocked tools);
- an eval harness with a fake model, so tests never cost money.

## What Hermod is not

- **Not a self-improving agent.** It never changes its own instructions, skills, hooks or memory on its own. The one
  exception is explicit: a memory store whose owner allows add-only writes.
- **Not a plugin marketplace.** Nothing is downloaded at runtime, nothing is `@latest`, and the kit has no
  dependencies.
- **Not multi-provider.** Model calls go only to Anthropic.
- **Not a hosted service.** Your data stays in your database.
- **Not a fork of Hermes Agent.** It borrows ideas, not code.

## Install the kit in a repository

From a checkout of this repository:

```bash
node scripts/sync.mjs --target ../your-repo --ref v0.1.0 --dry-run
```

```bash
node scripts/sync.mjs --target ../your-repo --ref v0.1.0
```

`--ref` must be a tag or a full commit SHA, so the version is pinned. Review the diff in your repository and open a
pull request there. The sync never touches your CLAUDE.md, your own skills, your lessons or your settings, except the
hook entries it owns. Details: [`docs/kit.md`](docs/kit.md).

The core skills (`reflect`, `curate`) are always installed. The library skills that `kit/skills.json` lists as
optional (`anthropic-sdk`, `nextjs-16`, `supabase-rls`) are installed only when you choose them, for example with
`--skills nextjs-16,supabase-rls`, or `--skills all`, or `--skills none` to remove them again. A later sync keeps
the same choice unless you pass `--skills` again.

## Develop

```bash
npm ci && npm rebuild better-sqlite3 --ignore-scripts=false
```

```bash
npm run check
```

`npm run check` runs the type checks, the linter and the tests. `npm run eval` runs the evals with the fake model;
`npm run eval:live` is opt-in and needs `ANTHROPIC_API_KEY` (it costs money, capped per run). CI needs no secrets.

## Status and licence

Where the work stands: [`docs/PROGRESS.md`](docs/PROGRESS.md). Decisions: [`docs/decisions.md`](docs/decisions.md).
MIT licence (see [`LICENSE`](LICENSE)).
