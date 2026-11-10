# Progress log

Short on purpose, so a new session can read it whole: the current status, the next step, open questions, what is
not done or not verified, and one line per recent session. Each decision is one line in `docs/decisions.md`.

## Status (2026-11-10)
- **0.1.0 is released**: PR #1, squash commit `32589df` (2026-11-09), tagged `v0.1.0` by Emil on GitHub
  (2026-11-10).
- **Part A, the kit, is built**: session brief, lessons and skills with a validator,
  the Stop ritual check, the session ledger, `/reflect` and its evidence bundle, lessons as checks, recall (BM25),
  the curator, and the pinned sync with opt-in library skills. 795 kit tests. `docs/kit.md`.
- **Part B, the runtime, is built**: storage (memory, SQLite, Postgres), safety, the model client, tools, the loop,
  memory, skills and proposals with grounding, learning (review, triggers, curator), modes, scheduler, channels,
  the invariant suites and the eval harness. `docs/runtime.md`.
- **Three rounds of independent attacks** on the guards (taint, memory writes, side effects, costs, modes): every
  finding is fixed with mutation-checked tests.
- **Reviews:** `/code-review` (max) found 14 problems, all fixed (job leases, unpriced costs, the redaction default,
  backoff, compression in a tool loop, skill patch races, the curator writing on its own, stray files in a vendored
  build, multi-line imports, floating CI versions, `.env.example`, two speed-ups, a duplicate helper), and an
  independent verifier re-checked the runtime fixes. `/security-review`: no high-confidence vulnerabilities.
- Whole suite with Postgres: 93 files, 2,599 tests; evals 19/19; CI green.
- **Installed and merged** in Emil's three target repositories (2026-11-09), each pinned to `32589df`: the kit in
  all three, the runtime vendored into one app, and an agent plan for another, which waits for Emil's answers. This
  repository is public, so their names and details stay in their own progress logs.

## Next step
- Nothing waits for 0.1.0. A later kit or runtime change reaches the targets the same way, each in its own pull
  request there: `node scripts/sync.mjs --target <repo> --ref <tag or full sha>` and
  `node scripts/vendor-runtime.mjs --target <app>/vendor/hermod --ref <tag or full sha>`.
- For a later release, the tag is made on GitHub (Releases, Draft a new release, target the merged commit): a Claude
  Code cloud session is refused a tag push (HTTP 403), though its branch pushes work.

## Open questions
- Unattended runs: the 2026-11-05 decision let them add memories to an add-only store. The hardening made the
  built-in memory tool propose even an add in an unattended run (a job's input is often outside text). Keep the
  stricter rule, or allow adds again from unattended runs whose input is all trusted?
- An empty root commit was pushed to `main` so the empty repository had a base branch for this pull request.
- One target repository turned the ledger off, because failed command output can hold personal text. Then no
  skill use is recorded either (the curator now says so instead of calling every skill stale). A ledger mode that
  records only the command, its exit code and skill use would let such a repository turn it back on. Worth building?

## Not done / not verified
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
- 2026-11-10: Emil tagged `v0.1.0` on `32589df` on GitHub. Status and Next step say so, and the licence question is
  closed: 0.1.0 is MIT (`docs/decisions.md`).
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
