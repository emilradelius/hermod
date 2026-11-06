# Progress log

Short on purpose, so a new session can read it whole: the current status, the next step, open questions, what is
not done or not verified, and one line per recent session. Each decision is one line in `docs/decisions.md`.

## Status (2026-11-06)
- **Part A, the kit, is built** on the working branch (PR #1): session brief, lessons and skills with a validator,
  the Stop ritual check, the session ledger, `/reflect` and its evidence bundle, lessons as checks, recall (BM25),
  the curator, and the pinned sync with opt-in library skills. 794 kit tests. `docs/kit.md`.
- **Part B, the runtime, is built**: storage (memory, SQLite, Postgres), safety, the model client, tools, the loop,
  memory, skills and proposals with grounding, learning (review, triggers, curator), modes, scheduler, channels,
  the invariant suites and the eval harness. `docs/runtime.md`.
- **Three rounds of independent attacks** on the guards (taint, memory writes, side effects, costs, modes): every
  finding is fixed with mutation-checked tests. Whole suite with Postgres: 87 files, 2,538 tests; evals 19/19; CI
  green.
- **Installed**, each as a draft pull request: life#1 (kit), life#2 (the Brain module on the vendored runtime,
  stacked on #1), J-E-App-building-#7 (kit), smartbox-backbone#91 (kit, and the agent plan for Emil's approval).

## Next step
- Emil reviews and merges this pull request. Then tag the merge commit `v0.1.0`, re-sync the kit into life, J-E
  and SmartBox at the tag (`node scripts/sync.mjs --target <repo> --ref v0.1.0`, each in its own pull request), and
  re-vendor life's runtime at the tag (`node scripts/vendor-runtime.mjs --target ../life/vendor/hermod --ref
  v0.1.0`).

## Open questions
- Unattended runs: the 2026-11-05 decision let them add memories to an add-only store. The hardening made the
  built-in memory tool propose even an add in an unattended run (a job's input is often outside text). Keep the
  stricter rule, or allow adds again from unattended runs whose input is all trusted?
- The licence is MIT, as asked. MIT lets anyone reuse Hermod, also commercially. If Hermod itself may become a paid
  product, decide the licence before the first tagged release.
- An empty root commit was pushed to `main` so the empty repository had a base branch for this pull request.
- life turned the ledger off (failed command output can hold personal text). A ledger mode that records only the
  command and its exit code would let it come back. Worth building?

## Not done / not verified
- No live API call was made: `npm run eval:live` needs `HERMOD_LIVE=1` and a key, and was not run. Every model call
  in the tests and evals is the fake client.
- The hooks were tested as processes (vitest runs them with real stdin and git repositories), not in a live Claude
  Code session on Emil's computer. Windows was not tested.
- Known limits, written in `docs/runtime.md` and `docs/kit.md`: cost reservations are per process; token estimates
  are estimates; the denylist and the injection scan are backstops; prompt injection is mitigated, not solved.
- `npm audit` reports 9 moderate findings, all from one advisory in `minimatch` < 11.0.1, pulled in only by the lint
  tooling (dev-time, no runtime exposure). Revisit when ESLint and typescript-eslint move past it.

## Recent sessions
- 2026-11-05/06: the first build: the kit and the runtime with tests and evals, three hardening rounds after
  independent attacks, the kit in life, J-E and SmartBox, life's Brain module, the SmartBox agent plan, and the
  reviews.
