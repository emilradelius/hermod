# Decisions

One line per decision: the day, who decided, what, and where the details are. Newest first within each area.
"Claude" means Claude's choice within an approved plan, which Emil can change. If a later decision replaces an
earlier one, change the old line to say "replaced by …" instead of deleting it.

## What Hermod is
- 2026-11-05, Emil: build our own Hermes-style learning loop instead of installing or forking Hermes Agent: proposals
  only, a human or a test approves. `docs/research.md`.
- 2026-11-05, Emil: the agent only proposes; a person (merging a pull request, or approving in an inbox) or an
  automated test decides what is kept. Hermes's "be active" pressure is dropped; "nothing to save" is a good outcome.
- 2026-11-05, Emil: two parts. Part A (first): a kit inside each repo, committed and pinned, no network, no other AI
  provider, no `@latest`. Part B: a small TypeScript runtime on the Anthropic SDK, hosted on our own stack (Next.js +
  Postgres/Supabase, or SQLite), not Managed Agents.
- 2026-11-05, Emil: the repository is public and MIT licensed; nothing app-specific, customer-related or personal
  goes in it.

## Safety rules
- 2026-11-05, Emil: Hermod never rewrites CLAUDE.md, `.claude/` or hooks on its own, never installs or runs anything
  unpinned or `@latest`, and never sends data to a provider other than Anthropic. Every change to a repo's lessons,
  skills or hooks is a reviewable diff in a pull request; the sync script edits only the entries it owns, and only
  when a person runs it.
- 2026-11-05, Emil: AI output is a draft a person approves; the model never gets a tool that messages a customer.
- 2026-11-05, Emil: unattended (scheduled) runs are deny-by-default and may only add memories; patches and removals
  wait for approval. Sub-agents cannot write memory, send messages, schedule jobs or delegate.

## Models
- 2026-11-05, Emil: Claude Opus 5.5 for the main agent with effort set explicitly; Claude Haiku 5.5 for cheap
  background reviews and summaries. Refusal fallbacks, prompt caching (stable first), compression for long sessions.
- 2026-11-05, Claude: default effort is passed explicitly on every call: `medium` for the main agent (raise to `high`
  for multi-step agentic work), `low` for background work. `src/model/models.ts`.

## How the kit works (Claude, within the plan)
- 2026-11-05, Claude: the kit is plain Node 22 ESM (`.mjs`) with zero dependencies and no network; it is type-checked
  with JSDoc (`tsconfig.kit.json`) and tested with vitest from this repo.
- 2026-11-05, Claude: hooks fail open (an internal error never breaks or blocks a session) and log to a local,
  self-ignoring `.claude/hermod/.local/`.
- 2026-11-05, Claude: the session brief is at most 8,000 characters by default and never more than 9,500, because
  Claude Code moves hook context over 10,000 characters to a file. It is frozen per session (resume and compact
  re-print the same text).
- 2026-11-05, Claude: lessons cap 4,000 characters by default; entries are declarative facts separated by `§`.
- 2026-11-05, Claude: the Stop hook blocks at most once per reason and at most twice per session, and never when
  Claude is already continuing because of a Stop hook.
- 2026-11-05, Claude: failed commands reach the ledger through `PostToolUseFailure`; the ledger is local per
  container and redacts secrets, e-mail addresses and Swedish personal identity numbers before writing.
- 2026-11-05, Claude: `scripts/sync.mjs` accepts only a tag or a full 40-character commit SHA and reads the kit at
  that commit, never from the working tree.
- 2026-11-05, Claude: GitHub Actions are pinned to commit SHAs; npm uses `legacy-peer-deps` (npm 10 crashes on
  vitest's optional peers) and `ignore-scripts`, with better-sqlite3 rebuilt explicitly.

## Repository setup
- 2026-11-05, Claude: an empty root commit was pushed to `main` so the empty repository has a base branch for pull
  requests; all content arrives through the first pull request.
