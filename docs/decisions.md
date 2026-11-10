# Decisions

One line per decision: the day, who decided, what, and where the details are. Newest first within each area.
"Claude" means Claude's choice within an approved plan, which Emil can change. If a later decision replaces an
earlier one, change the old line to say "replaced by …" instead of deleting it.

## What Hermod is
- 2026-11-10, Emil: `v0.1.0` is tagged on `32589df` (a GitHub release) under the MIT licence. The open question
  (MIT lets anyone reuse Hermod, also commercially; decide before the first tagged release) was put to him first.
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
- 2026-11-06, Claude (from Emil's spec: "`send_message` is deliberately not a model-callable tool"): the registry
  refuses every tool with the capability `messaging`; the `allowOwnerMessaging` opt-in is removed. A message to the
  owner is delivered by application code through a channel, like every other message.
- 2026-11-06, Claude (pending Emil, see Open questions in `docs/PROGRESS.md`): the built-in memory tool proposes
  even an add in an unattended run, and the post-session review writes an add-only batch directly only for a clean,
  attended conversation that quotes the person's own words and did not search other sessions.
- 2026-11-06, Claude: fail closed on outside text. Taint lasts for the whole session (`meta.tainted`, never cleared);
  pre-step output, unmarked `RunInput.context` and the output of `external.write` and `messaging` tools are
  untrusted unless the app marks them trusted (`trustPreStepOutput`, `contextTrusted`, `untrustedOutput: false`).
- 2026-11-06, Claude: cost caps bound output: `max_tokens` is clamped before every call to what the run and monthly
  caps leave (the month re-read each time, concurrent runs reserved in-process), and the refusal fallback is sent
  only when two attempts fit. `docs/runtime.md`.
- 2026-11-06, Claude: `approve` refuses shadow drafts (they are scored, never run); one case-insensitive non-human
  actor check for modes and proposals; the knowledge-tool exemption is bound to the built-in tools' own functions;
  the denylist fails closed on an input it cannot read in full.
- 2026-11-05, Emil: unattended (scheduled) runs are deny-by-default and may only add memories; patches and removals
  wait for approval (tightened by Claude on 2026-11-06, pending Emil: see above). Sub-agents cannot write memory,
  send messages, schedule jobs or delegate.

## Models
- 2026-11-05, Emil: Claude Opus 5.5 for the main agent with effort set explicitly; Claude Haiku 5.5 for cheap
  background reviews and summaries. Refusal fallbacks, prompt caching (stable first), compression for long sessions.
- 2026-11-05, Claude: default effort is passed explicitly on every call: `medium` for the main agent (raise to `high`
  for multi-step agentic work), `low` for background work. `src/model/models.ts`.

## How the kit works (Claude, within the plan)
- 2026-11-06, Claude: library skills (`anthropic-sdk`, `nextjs-16`, `supabase-rls`) are opt-in per repository
  (`sync --skills`, recorded in the stamp; a re-sync keeps the choice); `reflect` and `curate` are always installed.
- 2026-11-06, Claude: the Stop hook runs the checks whenever files changed (each check's `when` list decides),
  blocks at most once per reason (a check's key is its id), and runs no check while a committed file in the checks
  folder differs from HEAD. Found by `/code-review` on the target pull requests.
- 2026-11-05, Claude: the kit is plain Node 22 ESM (`.mjs`) with zero dependencies and no network; it is type-checked
  with JSDoc (`tsconfig.kit.json`) and tested with vitest from this repo.
- 2026-11-05, Claude: hooks fail open (an internal error never breaks or blocks a session) and log to a local,
  self-ignoring `.claude/hermod/.local/`.
- 2026-11-05, Claude: the session brief is at most 8,000 characters by default and never more than 9,500, because
  Claude Code moves hook context over 10,000 characters to a file. It is frozen per session (resume and compact
  re-print the same text).
- 2026-11-05, Claude: lessons cap 4,000 characters by default; entries are declarative facts separated by `§`.
- 2026-11-05, Claude: the Stop hook blocks at most once per reason and at most twice per session, and never when
  Claude is already continuing because of a Stop hook (made exact on 2026-11-06, see above).
- 2026-11-05, Claude: failed commands reach the ledger through `PostToolUseFailure`; the ledger is local per
  container and redacts secrets, e-mail addresses and Swedish personal identity numbers before writing.
- 2026-11-05, Claude: `scripts/sync.mjs` accepts only a tag or a full 40-character commit SHA and reads the kit at
  that commit, never from the working tree.
- 2026-11-05, Claude: GitHub Actions are pinned to commit SHAs; npm uses `legacy-peer-deps` (npm 10 crashes on
  vitest's optional peers) and `ignore-scripts`, with better-sqlite3 rebuilt explicitly.

- 2026-11-10, Emil ("yes, go ahead"): Graphify (Apache-2.0) is used as a separate tool, kept as an unmodified,
  pinned copy in the private repository `graphify-kit`, and joined to Hermod by an optional skill, not merged
  into the kit (the kit has zero dependencies and no network; graphify is Python with about 35 dependencies and
  several model providers).
- 2026-11-10, Claude: the graph is written under `.claude/hermod/.local/` and a seeded check fails any change that
  contains graph output, because the graph maps a private repository and Hermod is public. Code-only, Anthropic only.

## Repository setup
- 2026-11-09, Emil ("merge them", on Claude's advice): PR #1 was squash-merged as `32589df`, so the branch's commit
  messages that name the target repositories stay out of `main`'s history. The tag `v0.1.0` belongs on that commit.
- 2026-11-05, Claude: an empty root commit was pushed to `main` so the empty repository has a base branch for pull
  requests; all content arrives through the first pull request.
