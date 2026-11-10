# Progress log

Short on purpose, so a new session can read it whole: the current status, the next step, open questions, what is
not done or not verified, and one line per recent session. Each decision is one line in `docs/decisions.md`.

## Status (2026-11-10)
- **Releases**: 0.1.0 (`32589df`, tagged `v0.1.0`) and 0.2.0 (`8df3d2f`, tagged `v0.2.0`: the optional graphify
  skill). 0.3.0 is the state-travel branch (below).
- **Part A, the kit, is built**: session brief, lessons and skills with a validator,
  the Stop ritual check, the session ledger, `/reflect` and its evidence bundle, lessons as checks, recall (BM25),
  the curator, and the pinned sync with opt-in library skills. 795 kit tests. `docs/kit.md`.
- **Part B, the runtime, is built**: storage (memory, SQLite, Postgres), safety, the model client, tools, the loop,
  memory, skills and proposals with grounding, learning (review, triggers, curator), modes, scheduler, channels,
  the invariant suites and the eval harness. `docs/runtime.md`.
- **Three rounds of independent attacks** on the guards (taint, memory writes, side effects, costs, modes): every
  finding is fixed with mutation-checked tests.
- **Reviews (0.1.0):** `/code-review` (max) found 14 problems, all fixed, and an independent verifier re-checked the
  runtime fixes. `/security-review`: no high-confidence vulnerabilities.
- Whole suite with Postgres: 93 files, 2,599 tests; evals 19/19; CI green.
- **Installed and merged** in Emil's three target repositories (2026-11-09), each pinned to `32589df`: the kit in
  all three, the runtime vendored into one app, and an agent plan for another, which waits for Emil's answers. This
  repository is public, so their names and details stay in their own progress logs.

- **Graphify** (2026-11-10, PR #3, merged): an unmodified copy (Apache-2.0, upstream `5eedffa`, 0.9.105) is in Emil's
  private repository `graphify-kit`. The optional skill `graphify` (`--skills graphify`) and the seeded check
  `graphify-private` join it to the kit; the graph lives under `.claude/hermod/.local/` by default, or is committed
  in private repositories that opt in (`.claude/hermod/graph/ALLOW_COMMIT`) so it follows Emil between devices. `docs/kit.md` section 10.
- **State that follows you** (0.3.0, design approved by Emil): a private repository opts in with
  `.claude/hermod/state/ALLOW_COMMIT` (counts only on the remote default branch); then one summary per session
  travels (skill use; failed commands as plain-word keys, never text or output). `ledger.mode: "summary"`, the
  newest other branch in the brief, a Stop reminder and the check `hermod-state`. `docs/kit.md` section 11.

## Next step
- 0.3.0: merge (Emil: "I approve everything merge"), tag `v0.3.0` on GitHub on the merge commit, sync it into the
  three targets, then the opt-in pull requests in the two private ones (the state marker, the graph marker, and the
  summary-mode ledger where the ledger is off). The public target never opts in.
- Graphify (PRs #3 and #5 merged, 0.2.0 synced into two targets): run `query` and `path` once; build a graph in one private repository and check
  `graph.json` for the home path; merge `.claude/hermod/graph/ALLOW_COMMIT` there as its own pull request, then the
  graph. Then tag a release and sync with `--skills graphify`. Emil's other-device and cloud-session setup (install
  graphify there) is still to do.
- A later kit or runtime change reaches the targets the way 0.1.0 did, each in its own pull request there:
  `node scripts/sync.mjs --target <repo> --ref <tag or full sha>` and
  `node scripts/vendor-runtime.mjs --target <app>/vendor/hermod --ref <tag or full sha>`.
- For a later release, the tag is made on GitHub (Releases, Draft a new release, target the merged commit): a Claude
  Code cloud session is refused a tag push (HTTP 403), though its branch pushes work.

## Open questions
- Unattended runs: the 2026-11-05 decision let them add memories to an add-only store. The hardening made the
  built-in memory tool propose even an add in an unattended run (a job's input is often outside text). Keep the
  stricter rule, or allow adds again from unattended runs whose input is all trusted?
- An empty root commit was pushed to `main` so the empty repository had a base branch for this pull request.

## Not done / not verified
- State travel (0.3.0): tested with temporary repositories and local remote-tracking refs, not with a real remote
  or in a live Claude Code session; Windows not tested. A password typed as the second or third word of a listed
  tool's command would travel in a key (`docs/kit.md`, known limits).
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
