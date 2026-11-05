# Hermod — instructions for Claude Code

Hermod is a learning kit for Claude Code repositories (Part A, `kit/`) and a small TypeScript agent runtime on the
Anthropic SDK (Part B, `src/`). Read `README.md` for what it is and is not, and `docs/research.md` for why it is
built this way.

## Read first, every session
1. `docs/PROGRESS.md`: where we left off. Continue from "Next step".
2. `docs/decisions.md`: every decision, one line each. Check it before asking Emil something.
3. `docs/kit.md` (Part A) or `docs/runtime.md` (Part B), for the part you are working on.

## How to work with Emil
- Plain, short English or Swedish (match him). Say plainly what was not done or not verified.
- If he is not around, don't stop for a business-rule question: pick the safest option, write it under
  "Open questions" in `docs/PROGRESS.md`, and continue. Ask only when something would break a hard rule, or needs a
  secret or an account.

## Hard rules
- **This repository is public.** Nothing app-specific, customer-related or personal goes in: no company internals, no
  personal goals or health, no real data, no real names other than Emil's. Use neutral examples. If something can only
  work with private details, stop and ask Emil.
- **No secrets, ever.** Variables are documented in `.env.example`. CI must never need a secret.
- **The agent only proposes.** Nothing in Hermod may change memory, skills, lessons, hooks or agent configuration on
  its own. Changes are pull requests a person merges, proposals a person approves, or checks a test decides. The one
  exception is explicit: a memory store whose owner allows add-only writes. The tests that prove this
  (`test/**/proposals*`, `test/**/invariants*`) must never be weakened to make something pass.
- **Never rewrite CLAUDE.md, `.claude/` or hooks automatically.** `scripts/sync.mjs` edits only the entries it owns,
  and only when a person runs it.
- **Pinned and local.** Dependencies are pinned to exact versions; nothing unpinned or `@latest`; GitHub Actions are
  pinned to commit SHAs. The kit (`kit/files/**`) has zero dependencies and makes no network calls.
- **One provider.** Model calls go only to Anthropic through `@anthropic-ai/sdk`. No other AI provider, proxy or shim.
- **No messaging tool.** The model never gets a tool that sends a message to a customer or anyone else; delivery is
  done by application code to configured targets.
- **Hooks fail open and never loop.** A kit hook must never break or block a session forever; the Stop hook blocks at
  most once per reason.
- Before writing Anthropic SDK code, load the `claude-api` skill and follow it.

## Commands
```bash
npm ci --ignore-scripts && npm rebuild better-sqlite3   # install (only better-sqlite3 runs its install script)
npm run check        # typecheck (src + kit) + lint + tests: run before every commit
npm test             # vitest; Postgres tests run when HERMOD_TEST_DATABASE_URL is set
npm run build        # runtime to dist/
npm run eval         # evals with the fake model (free, used by CI)
npm run eval:live    # opt-in: real API, needs ANTHROPIC_API_KEY, costs money (capped)
node kit/files/.claude/hermod/validate.mjs --root . --kit   # the kit validates its own skills
```

## Layout
- `kit/files/` is copied into target repos by `scripts/sync.mjs` at a pinned tag or commit. `kit/seed/` holds files
  created once in a target and owned by it afterwards. `kit/settings.hooks.json` lists the hook entries the kit owns.
- `src/` is the runtime library; `test/` its tests and the kit's tests; `evals/` the eval harness fixtures.
- This repository uses its own kit: `.claude/settings.json` points the hooks at `kit/files/.claude/hermod/hooks/`,
  and `.claude/hermod/` holds this repo's own config and lessons.

## Review before merging
- Before calling a pull request ready, run `/code-review` on it and fix what it finds (or say why not).
- Also run `/security-review` when it touches hooks that run commands, redaction, auth, push or messaging,
  scheduling, or access rules.
- Say in the pull request which reviews ran and what they found. Emil's merge decides.

## Releasing the kit
1. Bump `kit/VERSION` and add a line to `docs/PROGRESS.md`. 2. After the pull request is merged, tag the merge commit
`vX.Y.Z`. 3. In each target repo, run `node scripts/sync.mjs --target <repo> --ref vX.Y.Z`, review the diff, and open
a pull request there.

## End of every session
Update `docs/PROGRESS.md` (Status, Next step, Open questions, Not done) and add each new decision as one line in
`docs/decisions.md`. Run the reflection in `kit/files/.claude/skills/reflect/SKILL.md` if the session taught
something worth keeping (nothing to save is fine). Commit and push.
