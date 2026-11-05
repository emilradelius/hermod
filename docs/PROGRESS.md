# Progress log

Short on purpose, so a new session can read it whole: the current status, the next step, open questions, what is
not done or not verified, and one line per recent session. Each decision is one line in `docs/decisions.md`.

## Status (2026-11-05)
- First build session in progress (see "Recent sessions"). The repository was created empty; an empty root commit
  on `main` gives the first pull request a base.
- Done on the working branch: docs (README, CLAUDE.md, research, decisions), MIT licence, pinned toolchain, CI without
  secrets, the runtime contract (`src/types.ts`), the fake model client with tests, the `/reflect` and `/curate`
  skills.
- In progress: the kit's scripts and hooks (Part A), and the runtime modules (Part B).

## Next step
- Finish Part A and Part B on the working branch, with tests and a green CI; run `/code-review` and
  `/security-review`; then install the kit in the target repositories, each through its own pull request.

## Open questions
- The licence is MIT, as asked. MIT lets anyone reuse Hermod, also commercially. If Hermod itself may become a paid
  product, decide the licence before the first tagged release.

## Not done / not verified
- Nothing is verified yet beyond the toolchain smoke test and the fake model client's tests.

## Recent sessions
- 2026-11-05: first build session (in progress).
