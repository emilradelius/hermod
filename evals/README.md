# Hermod evals

The evals run whole scenarios through the **built** library (`dist/`), the way an app would use it: a real agent loop,
real storage, real knowledge services and approval policy. Only the model is scripted (`FakeModelClient` from
`hermod/testing`), so the offline evals are free, deterministic and never touch the network.

## What they prove

Each fixture in `fixtures/` is one scenario with its expectations. Together they show, end to end:

- a plain answer, and a tool round whose result goes back to the model;
- the agent only proposes: a memory write is a pending proposal; the one exception (an add-only batch to a store whose
  owner allows add-only writes) applies directly, but a patch or removal on that store is still a proposal;
  `skill_propose` never changes a skill;
- the post-session review proposes only what it can ground: a quote that is not in the cited message (or a message
  from another session) is refused by code, and a fact grounded in tool output is never written directly;
- a refusal ends the run with its category and runs no tools; a 429 and a 529 are retried, then the call succeeds;
- untrusted text cannot trigger side effects: after an injected page, the "obeyed" calls are proposed, not run (and
  the control scenario shows the same call runs in a clean session);
- a scheduled job that ends with `[SILENT]` delivers nothing (and the control delivers once);
- shadow mode runs no side effects and leaves drafts (on SQLite); off means off (`AgentOffError`, no model call, no
  session, no cost); the hard denylist applies in every mode;
- the build itself: both entry points (`hermod`, `hermod/testing`) import with plain node and export the public API.

The same fixtures also run under vitest against the sources (`test/runtime/evals.test.ts`), which also checks that the
harness reports a failure when the expected behaviour does not happen. The invariant suites in
`test/runtime/invariants.test.ts` go deeper on the same rules.

## How to run

```bash
npm run eval                      # build, then every fixture; prints a table, exits 1 on any failure (CI runs this)
node evals/run.mjs --list         # the scenarios and what each proves (after a build)
node evals/run.mjs --only refusal # one scenario
```

## Fixture format

```jsonc
{
  "name": "kebab-case-name",
  "about": "What the scenario proves, in one sentence.",
  "storage": "memory",                       // or "sqlite" (better-sqlite3, in memory)
  "agent": { "mode": "autonomous" },         // off | shadow | supervised | autonomous
  "config": { "toolsets": ["knowledge", "notes"] },  // plus any AgentConfig field (budget, maxTokens, ...)
  "seed": {
    "stores": [{ "name": "user", "capChars": 1375, "autoApply": "none", "entries": ["..."] }],
    "skills": [{ "name": "weekly-review", "description": "...", "body": "..." }],
    "sessions": [{ "key": "past", "messages": [{ "role": "user", "text": "..." }, { "role": "tool_result", "text": "..." }] }],
    "page": "what fetch_page returns"
  },
  "run": { "type": "chat", "userMessage": "..." },  // or { "type": "review", "session": "past" }
                                                     // or { "type": "job", "job": {...}, "createdAt": "...", "tickAt": "..." }
  "steps": [                                         // the scripted model, one entry per call
    { "text": "..." },
    { "toolUse": [{ "name": "memory", "input": { ... } }] },
    { "refusal": "cyber" },
    { "error": { "status": 429, "message": "...", "retryAfterSeconds": 0 } },
    { "connectionError": "..." }
  ],
  "expect": { "end": "end_turn", "proposals": { "count": 1, "kinds": ["memory"], "statuses": ["pending"] } }
}
```

`"{{msg:<session key>:<index>}}"` inside a step is replaced by the id of that seeded message (for evidence quotes).
The `notes` toolset has `read_note` (read), `fetch_page` (read, untrusted output), `save_note` (internal write),
`send_invoice` (external write, always needs approval) and `run_shell` (external write); the harness records which of
them actually ran.

Expectations: `end`, `throws`, `text`, `textIncludes`, `refusalCategory`, `modelCalls`, `models`, `errors` (classified
kinds), `toolCalls` (`[name, decision]` pairs), `ran`, `proposals` (`count`, `kinds`, `statuses`, `targets`, `shadow`,
`createdBy`), `stores` (`unchanged` or `entries`), `skills` (`version`, or `null` for absent), `costRecorded`,
`costRows`, `writesNothing`, `deliveries`, `tick` (TickReport fields), `review` (`refused`, `applied`,
`refusedIncludes`), `audit` (count per action), `requestIncludes` / `requestExcludes`. Every scripted step must be
used unless `"scriptUsed": false`.

## Live mode (opt-in, costs money)

```bash
HERMOD_LIVE=1 ANTHROPIC_API_KEY=<your key> npm run eval:live
```

Without both variables, or when `CI` is set, it prints how to enable it and exits 0: **it never runs in CI**, and CI
needs no secret. It runs three small scenarios against the real API (`AnthropicModelClient`): a plain answer on Opus
5.5 (effort low), a memory write that must stay a proposal, and a post-session review on Haiku 5.5. The checks are
loose: an answer arrives, cost is recorded, and nothing is written to memory or skills without approval.

**Cost: at most USD 0.50 per run, enforced in code.** Every call goes through a capped client with a `CostTracker`:
before each call it estimates the most that call can cost (the whole prompt as a cache write, every output token,
doubled when the model has a server-side refusal fallback) and does not send it if that could take the run past the
cap; the rest of the run is then reported as not run. A typical run costs a few cents.
