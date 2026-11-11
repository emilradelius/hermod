# Progress log

Short on purpose, so a new session can read it whole: the current status, the next step, open questions, what is
not done or not verified, and one line per recent session. Each decision is one line in `docs/decisions.md`.

## Status (2026-11-11)
- **Releases**: 0.1.0 (`32589df`, tag `v0.1.0`), 0.2.0 (`8df3d2f`, tag `v0.2.0`: the graphify skill), 0.3.0
  (`2143d5c`, PR #7: state travel) and 0.3.1 (`ca5d679`, PR #8: the opt-in reads `origin/HEAD` the way the check
  does). The tag `v0.3.1` waits for Emil.
- **Part A, the kit** (`docs/kit.md`): the brief, lessons and skills with a validator, the Stop ritual, the ledger,
  `/reflect`, lessons as checks, recall, the curator, pinned sync with opt-in library skills, Graphify (section 10)
  and state that follows you between devices (section 11).
- **Part B, the runtime** (`docs/runtime.md`): storage (memory, SQLite, Postgres), safety, the model client, tools,
  the loop, memory, skills and proposals, learning, modes, scheduler, channels, invariant suites and evals.
- **Hardening and reviews**: three rounds of independent attacks, each finding fixed with mutation-checked tests;
  `/code-review` and `/security-review` on 0.1.0 and on 0.3.0, every finding fixed. `npm run check` (2026-11-11,
  without Postgres): 94 files, 2,538 tests; evals 19/19; CI green.
- **Targets** (three, all merged): each pinned to 0.3.1; the runtime (0.1.0) vendored into one app; an agent plan for
  another waits for Emil. The two private ones opted in to state travel and a committed code map; the public one
  never opts in. This repository is public, so their names and details stay in their own progress logs.
- **Graphify**: an unmodified copy (Apache-2.0, upstream `5eedffa`, 0.9.105) is in Emil's private `graphify-kit`;
  the optional skill `graphify` and the seeded check `graphify-private` join it to the kit.
- **Control Room** (2026-11-11): a private claude.ai page for Emil, with no server, account or token. It shows his
  live Claude Code sessions (his own sign-in, through the Claude Code connector), how the repositories connect, each
  repository's state (a snapshot Claude writes into the page's data) and a code map viewer that reads a
  `graph.json` in the browser only.

## Next step
- Emil: tag `v0.3.1` on GitHub on `ca5d679` (0.3.0 needs no tag of its own: no target is pinned to it). Then build
  the code map once in each opted-in private repository (the `graphify` skill), search `graph.json` for the user name
  and for `\\` first, and commit it there in a pull request if neither is there.
- After a change to the kit or to a target's state, Claude refreshes the Control Room's repository details (the
  page's data), so the page stays true.
- Graphify: the two private targets opted in (their markers are merged). Still to do: run `query` and `path` once,
  and Emil's other-device and cloud-session setup (install graphify there).
- A later kit or runtime change reaches the targets the way 0.1.0 did, each in its own pull request there:
  `node scripts/sync.mjs --target <repo> --ref <tag or full sha>` and
  `node scripts/vendor-runtime.mjs --target <app>/vendor/hermod --ref <tag or full sha>`.
- For a later release, the tag is made on GitHub (Releases, Draft a new release, target the merged commit): a Claude
  Code cloud session is refused a tag push (HTTP 403), though its branch pushes work.

## Open questions
- Two places could show the code map: the Control Room (on claude.ai, no setup; Emil opens a `graph.json`) and a
  separate sign-in page another session built for the maps (not deployed; it needs a GitHub sign-in app, two tokens
  and a hosting project, and builds the maps in GitHub Actions). Keep both, or pick one?
- Unattended runs: the 2026-11-05 decision let them add memories to an add-only store. The hardening made the
  built-in memory tool propose even an add in an unattended run (a job's input is often outside text). Keep the
  stricter rule, or allow adds again from unattended runs whose input is all trusted?
- An empty root commit was pushed to `main` so the empty repository had a base branch for this pull request.

## Not done / not verified
- Nothing has travelled yet: the first session summary comes from the next `/reflect` in an opted-in repository,
  and no code map is committed.
- Control Room: the live session list was not tried through the connector (the page was looked at outside
  claude.ai); the repository details are a snapshot, not live.
- State travel (0.3.0): tested with temporary repositories and local remote-tracking refs, not with a real remote
  or in a live Claude Code session; Windows not tested. A lower-case word in a listed tool's subcommand place, or an
  `npm run` script name, travels as it is (`docs/kit.md`, known limits).
- Graphify: Emil ran the build, `god-nodes`, `explain` and `affected` on Windows (0.9.105) and they worked. `query`
  and `path` are not run yet, and no live Claude Code session has used the skill.
- No live API call was made: `npm run eval:live` needs `HERMOD_LIVE=1` and a key, and was not run. Every model call
  in the tests and evals is the fake client.
- The hooks were tested as processes (vitest runs them with real stdin and git repositories), not in a live Claude
  Code session on Emil's computer. Windows was not tested.
- This session was started above the repositories, so no kit hook ran in any of them (no brief, ledger or Stop
  check), and reflect-prep found no session: /reflect ran on evidence gathered by hand (`docs/kit.md`, known
  limits). A session started inside a repository gets all of it.
- Known limits, written in `docs/runtime.md` and `docs/kit.md`: cost reservations are per process; token estimates
  are estimates; the denylist and the injection scan are backstops; prompt injection is mitigated, not solved.
- `npm audit` reports 9 moderate findings, all from one advisory in `minimatch` < 11.0.1, pulled in only by the lint
  tooling (dev-time, no runtime exposure). Revisit when ESLint and typescript-eslint move past it.

## Recent sessions
- 2026-11-11: 0.3.1 merged (PR #8) and synced into all three targets (merged); the two private ones opted in
  (merged); the Control Room page for Emil.
- 2026-11-11: kit 0.3.1: the opt-in reads `origin/HEAD` the way the `hermod-state` check does (when it is set, only its
  branch counts, also when that branch is gone), so the Stop reminder never asks for a commit the check refuses.
- 2026-11-10: kit 0.3.0: state that follows you between devices, opt-in for private repositories (session summaries,
  ledger summary mode, newer branches in the brief, the Stop reminder, the `hermod-state` check); 27 new tests.
- 2026-11-10: kit 0.2.0 prepared (optional `graphify` skill, seeded `graphify-private` check, opt-in committed graph in private repos; PRs #3, #5). Tag `v0.2.0` goes on the merge commit of the release PR.
- 2026-11-10: Emil tagged `v0.1.0` on `32589df` on GitHub. Status and Next step say so, and the licence question is
  closed: 0.1.0 is MIT (`docs/decisions.md`).
- 2026-11-10: Graphify joined as an optional skill and a seeded check (draft PR); the copy is in the private `graphify-kit`.
- 2026-11-09: PR #1 squash-merged as `32589df` (0.1.0) on Emil's word, and the pull requests in the three targets
  too; each target pinned to `32589df` in a follow-up pull request. The tag could not be pushed (see Next step).
- 2026-11-06: /reflect, on evidence gathered by hand: a check, `no-floating-versions` (no `@latest`/`@canary`,
  actions by SHA, exact runners, images and Node), and the seeded checks README now documents `ctx.git`'s result
  and literal pathspecs and that a check never runs repository files.
- 2026-11-06: an independent audit of the records, with fixes: the registry refuses every messaging tool (the
  owner-messaging opt-in is gone), the Next.js skill no longer suggests an unpinned codemod, neutral test examples
  and wording for the target repositories, a token built at runtime (and a check for it), the curator with the
  ledger off, and two stale paragraphs in `docs/kit.md`.
- 2026-11-05/06: the first build: the kit and the runtime with tests and evals, three hardening rounds after
  independent attacks, the kit in the three target repositories (the runtime vendored into one app, an agent plan
  for another), and the reviews.
