# The runtime (Part B): developer guide

For people changing the runtime or building an app on it. The code wins where this page differs. The contract is
[`src/types.ts`](../src/types.ts); the public API is `src/index.ts`, plus `hermod/testing` for the fake model.

## 1. What the runtime is

A TypeScript library for agents inside your own app, on your own hosting and database: one folder per block under
`src/` (`model`, `loop`, `tools`, `memory`, `skills`, `proposals`, `learning`, `modes`, `scheduler`, `channels`,
`safety`, `storage`, `testing`).

- **One provider.** Model calls go only to Anthropic, through `@anthropic-ai/sdk` 1.1.0; the only other dependency
  is `zod` 4.6.7. Database drivers are optional peers.
- **The agent only proposes.** Memory, skill and side-effect changes become proposals a person approves. The one
  exception: an add-only batch to a memory store whose owner set `autoApply: "add"`.
- **No messaging tool.** No built-in tool messages anyone; the registry refuses a `messaging` tool unless the app
  sets `allowOwnerMessaging` (owner only). Delivery is application code.
- **No autonomy by default.** A new agent starts in `shadow` (`AGENT_DEFAULTS`). Only a person changes the mode.
- **Not a sandbox.** Tools run in the app's process. The runtime decides whether a call runs, not what it can reach.

## 2. A minimal example

One read-only tool; the real client in the app, the fake model in a test. It type-checks and runs.

```ts
import { z } from "zod";
import { AnthropicModelClient, createMemoryStorage, defineTool, runAgent, setMode, type AgentConfig } from "hermod";
import { FakeModelClient, textMessage, toolUseMessage } from "hermod/testing";

const notes = new Map([["Shopping", "Milk, bread, coffee."]]);
const readNote = defineTool({
  name: "read_note",
  description: "Read one note by its title.",
  input: z.object({ title: z.string().min(1).max(200) }),
  readOnly: true,
  capabilities: ["read"],
  run: ({ title }) => notes.get(title) ?? "(no note with that title)",
});
const config: AgentConfig = {
  agentId: "notes",
  systemPrompt: "You answer questions about the user's notes. Be brief.",
  toolsets: [{ name: "notes", tools: [readNote] }],
  budget: { maxCostUsd: 0.2 },
};

const storage = createMemoryStorage(); // apps: createSqliteStorage(db) or createPostgresStorage(…)
await storage.migrate();
await storage.agents.upsert({ id: "notes", name: "Notes helper" }); // starts in shadow
await setMode(storage, "notes", "supervised", "user:owner");

// App: the real client (the SDK reads ANTHROPIC_API_KEY).
export const ask = (question: string) =>
  runAgent(config, { userMessage: question }, { storage, model: new AnthropicModelClient() });

// Test: one scripted step per model call; no network, no cost.
const fake = new FakeModelClient([
  toolUseMessage([{ name: "read_note", input: { title: "Shopping" } }]),
  textMessage("Milk, bread and coffee."),
]);
const result = await runAgent(config, { userMessage: "What is on my shopping list?" }, {
  storage, model: fake, sleep: async () => {},
});
// result.end === "end_turn", fake.calls.length === 2, result.toolCalls[0].decision === "allow"
```

Also in `hermod/testing`: `refusalMessage()`, `maxTokensMessage()`, `apiError(status, message)`, `connectionError()`.

## 3. The run, start to end

`runAgent(config, input, deps)` throws only for programmer errors and `AgentOffError` (before any write or model
call). Model and tool errors end the run with a reason. Phases: prepare → request → tools → (compress) → finish.

**Sessions.** No `input.sessionId`: a new row (kind `chat` by default; attended by default only for a chat). The
memory snapshot and skills index are read once (`deps.knowledge`), redacted and stored on the row: the **frozen
snapshot**. A continued session reuses them and rebuilds its history after the last compression marker; an
unanswered `tool_use` gets a "not run" result. An unattended run sets `meta.unattendedRun` once, never cleared.

**Requests.** System block 1: `HERMOD_RULES`, `UNTRUSTED_RULES`, the agent's prompt. Block 2: frozen memory, skills
index, attached skills. Both stay stable for the prompt cache. `input.context` goes into the user message.
Defaults: `claude-opus-5-5`, effort `medium` (always sent), `maxTokens` 16,000, adaptive thinking, tools sorted by
name. The server-side refusal fallback is on for Opus 5.5 and Sonnet 5.5, not Haiku 5.5. Each call writes a cost row.

**The tool round.** Each `tool_use` in order. Unknown tool or invalid input (zod) → `is_error`. Otherwise
`ApprovalPolicy.decide`: allow (run), propose (an action proposal) or deny (`is_error` plus a `tool.deny` audit
entry). Consecutive allowed read-only calls (only `read`, no approval needed) run in
parallel; everything else runs one at a time, decided after every earlier result arrived. The mode is re-read
before every model call and every group or call: `off` mid-round denies the rest and ends the run `aborted`. Results
keep their order. Output is redacted, cut to `maxToolOutputChars` (20,000) and wrapped if untrusted. A throw becomes
`{"error":{"type","message"}}`.

**Approvals** (`createApprovalPolicy`; off denies everything):

| Mode | Read-only | Side effect, clean | Side effect, tainted or `requiresApproval` |
|---|---|---|---|
| any (hard denylist match) | deny | deny | deny |
| shadow | allow | propose (draft) | propose (draft) |
| supervised | allow | propose | propose |
| autonomous, attended | allow | allow | propose |
| autonomous, unattended | allow | allow | deny |

A read-only tool with `requiresApproval` counts as a side effect. Built-in knowledge tools are allowed in every
mode but off (section 8). A failing `decide` denies.

**Taint** belongs to the **session**: once set (`meta.tainted`, `meta.taintedAt`) it lasts for every later run and
is never cleared. Sources: a tool with `untrustedOutput: true`; by default a tool with
`external.write` or `messaging` (output and errors; opt out with `untrustedOutput: false`); `input.context` unless
`contextTrusted: true`; pre-step output unless the job runner has `trustPreStepOutput: true`; an untrusted wrapper in
any stored message of the session; a tainted parent or child. A summary of a tainted conversation is wrapped too.
In a tainted session no memory add applies directly.

**Budgets.** Defaults: 20 model calls, USD 1.00 per run, no wall clock. Before every attempt (retry, fallback
model, summary, a child's calls) the loop re-reads the month's spend and **clamps** `max_tokens` so the worst case
(whole prompt as a cache write plus every output token) fits under min(run cap left, monthly cap left). Prompt sizes
are conservative (non-ASCII at a token per code point or more, the last real size a floor, Haiku's long-prompt tier
when it could apply). The refusal fallback stays only when two attempts fit. Under 128 output tokens (or
`maxTokens`, if lower) the call is not made: `budget_cost`. A call in flight **reserves** its worst case against the
monthly cap until its cost is recorded.

**Compression.** At 0.5 of `windowTokens` (200,000), at a turn boundary, Haiku 5.5 summarises under six headings
(Goal … Next steps). The conversation restarts from it plus about 20,000 tokens of tail without thinking; nothing is
edited in place. At most 3 per run.

**Delegation.** `makeDelegateTool()` is a side effect (`delegation`). The child gets a fresh session, no
`memory.write`, `skills.write`, `messaging`, `scheduling` or `delegation` tools, 10 calls, half the parent's
remaining budget and its taint. Only its final text returns (4,000 characters), wrapped if the child was tainted.

**Errors.** `classifyError` uses SDK error classes, never message text. Rate limit, overload, 5xx, connection,
timeout → 3 retries (`backoff`: 1 s doubling, jitter, 60 s cap), then `fallbackModel` if set (one switch, 3 more).
Too large → compress, retry once. Auth, permission, not found, bad request → abort.

**End reasons:** `end_turn`, `refusal` (no tools, text dropped, `refusalCategory`, audited), `max_tokens` (a cut
`tool_use` never runs), `budget_iterations`, `budget_cost`, `budget_time`, `error`, `aborted`. `pause_turn` is sent
again. `RunResult.proposals` lists the run's proposals (action, memory, skill, a child's) in creation order.

## 4. Modes

`off`: `AgentOffError`, jobs skipped, review and curator refuse; no data, no API call. The other three follow the
table. Shadow drafts (`shadow: true`) are scored, never approved.

`setMode(storage, agentId, mode, by)` changes a mode: it refuses Hermod's own actors (`agent:…`, `job:…`, `review`,
`system` and others, any case; `src/safety/actors.ts`) and audits the change (`storage.agents.update` does neither).
`scoreDraft(proposals, id, "as_is" | "small_edit" | "wrong", by)` scores a shadow or action proposal.
`shadowStats(storage, agentId)` gives accuracy = (as_is + 0.5 × small_edit) / n; `meetsBar(stats, agent)` checks
`accuracyBar` (default 0.9) and `minSamples` (20). It only reports: nothing calls `setMode` on its own
(`test/runtime/learning/modes.test.ts`, "no automatic promotion").

## 5. Knowledge

```ts
const memory = new MemoryService({ storage });
const skills = new SkillService({ storage });
const proposals = new ProposalService({ storage, memory, skills }); // + executeAction for approved actions
await memory.ensureStores("notes"); // "memory" 2,200 and "user" 1,375 characters, autoApply "none"
config.toolsets = [knowledgeToolset({ memory, skills, proposals, storage })];
const deps = { storage, model, knowledge: knowledgeDeps({ memory, skills }) };
```

**Memory.** Facts joined by `MEMORY_SEPARATOR` (`"\n§\n"`). A batch (add, patch, remove; 10 ops per tool call)
applies all or nothing; the cap is checked on the final content. Refused: emptying a non-empty store, duplicates, an
entry over 500 characters, a line of only `§`, injection. Writes are version-checked. **An add applies directly
only** when the store has `autoApply: "add"`, the batch only adds, and the memory tool runs attended, not in shadow
and untainted. Everything else is a pending proposal. App code calling `MemoryService.write` must pass `shadow` and
`noAutoApply` itself. The running snapshot never changes.

**Skills.** Name `^[a-z0-9]+(-[a-z0-9]+)*$` (≤ 64), description ≤ 1,024 (first sentence, cut at 60, is the index
line), body ≤ 20,000. Every change is a new version row; statuses active, stale, archived; nothing is deleted.
`skill_propose` (patch, add_reference, create) is always a proposal.

**Proposals.** Kinds `memory`, `skill`, `action`. Memory and skill proposals must apply now and pass the injection
scan; evidence, when given, must verify: a quote (≤ 300 characters, case-sensitive) must occur in the named message
of the same agent, and with `requireGrounding` an empty list fails. `approve(id, by)` goes pending → approved →
applied by compare-and-set (never twice, never a shadow draft): memory is re-checked against the current content
(else rejected, "Could not apply: …"), a skill gets a new version, an action runs through `executeAction` or waits
for `markApplied`. `approve`, `reject`, `markApplied` and `score` need a person. Every transition is audited; audit
has no update or delete.

## 6. Learning

**Review.** `reviewSession(sessionId, { storage, model, memory, skills, proposals })` runs a fork: kind `review`,
unattended, Haiku 5.5 at effort low, at most 16 calls, USD 0.25. Tools: `memory`, `skill_propose`, `skill_list`,
`skill_view`, `session_read`, `session_search`; nothing else. Each write cites a verified `{ messageId, quote }`;
refusals go back to the reviewer. "Nothing to save." is a good result. **Direct write only** for an add-only
batch to an `autoApply: "add"` store, when the reviewed session is an attended chat never continued unattended and
untainted, every quote is the person's own words (not tool output, the assistant, app context or a compression
summary), and the review has not called `session_search`.

**Triggers.** `shouldReview(counters)`: 10 user turns since the last memory review, or 10 tool rounds since the last
skill review. Call `markReviewed` after the run ends.

**Curator.** `curate(storage, { agentId, now })`: unused 14 days → stale, 30 → archived; pinned exempt. Only the
status flag changes, audited; nothing is deleted.

## 7. Scheduler and channels

```ts
const channels = new ChannelRegistry().register(new InAppChannel({ storage }));
const scheduler = new Scheduler({
  storage, channels,
  runJob: makeJobRunner({ ...deps, configFor: () => config }),
  preSteps: { "count-notes": async () => "3 notes changed today." },
});
await scheduleJob(storage, { agentId: "notes", name: "daily", schedule: "0 8 * * *", timeZone: "Europe/Stockholm",
  prompt: "Summarise today's notes.", deliver: "inapp:owner", preStep: "count-notes" });
const stop = startTimer(scheduler); // tick() every 60 s, never overlapping
```

`tick()` leases due jobs (5 minutes; keep the run's wall clock below it), at most 25 per tick. Agent off →
skipped. A pre-step is a registered function, never code from the row; null skips the run. `makeJobRunner`: a fresh
session (kind `job`, unattended), the job's skills attached, no `scheduling`, `delegation` or `messaging` tools, and
`unattendedPolicy`: **deny by default** for what needs a person now; shadow and supervised side effects still become
proposals. A run that does not end `end_turn` is an error. Final text exactly `[SILENT]` → nothing delivered. Errors:
`failures + 1`, redacted `lastError`, backoff 1, 2, 4 … 60 minutes. Cron: 5 fields, in the job's time zone.

`ChannelRegistry.deliver("channel:target", message, { storage })` resolves the target at send time and records a
delivery row (30 s timeout). Channels: `InAppChannel` (subscribers, `history(target)`, `sseResponse`),
`WebPushChannel({ send, subscriptions })` (payload ≤ 3,000 bytes), `TelegramChannel({ token, fetch })` (plain text,
the token never in an error). **No channel is ever a tool.**

## 8. Safety

- **Redaction.** `secretsRedactor` (the default) and `piiRedactor` (e-mail, phone, personnummer, IBAN, cards);
  `composeRedactors`. Applied to user message, context, snapshot, tool output (before the cut), action proposals and
  errors.
- **Untrusted wrapping.** `<untrusted_content source="…" nonce="…">…</untrusted_content>`. Forged delimiters (any
  case, spacing, entities, look-alike characters) become `[forged delimiter removed]`. There is no unwrap.
- **Injection scan.** Overrides (English, Swedish), role hijacks, fake role markers, prompt leaks, exfiltration,
  hidden Unicode. An error refuses a memory or skill write or proposal.
- **Denylist.** 14 default patterns, such as `rm -rf /`, `mkfs`, fork bombs, `curl | sh`, `DROP TABLE`, `DELETE`
  without `WHERE`, force-pushing main and disabling RLS. Matched on the JSON input, each string and exec-style argv,
  also with SQL comments and shell quoting undone. Apps add patterns; defaults cannot be removed. Input it cannot
  read in full (depth over 32, over 50,000 strings or 5,000 command lines, unserialisable) is denied.
- **Knowledge-tool mark** (`src/tools/knowledge-mark.ts`): the built-in `memory` and `skill_propose` tools skip the
  side-effect rules, as they write only through proposals. The mark is their `run` function in a private `WeakSet`:
  an app tool declaring `memory.write`, or a copy with a new `run`, is a side effect.
- **SDK Tool Runner.** `toBetaZodTools(registry, ctxFactory)` keeps these checks, but runs a turn's calls at once.

## 9. Storage

One async `Storage` interface: messages and audit append-only, search over plain words only, proposals
compare-and-set, jobs leased.

- `createMemoryStorage()`: tests and evals.
- `createSqliteStorage(db, { prefix })`: a better-sqlite3 `Database`; tables prefixed `hermod_` by default; FTS5
  (`unicode61 remove_diacritics 2`, bm25). Pragmas such as WAL are the app's.
- `createPostgresStorage(fromPostgresJs(sql) | fromPg(client), { schema })`: schema `hermod` by default; folded text,
  `to_tsvector('simple', …)` and GIN. RLS is on for every table with **no policies**; writing them is the app's job.

`migrate()` is idempotent and versioned (`SQLITE_MIGRATIONS`, `PG_MIGRATIONS`, version 1); a schema change is a new
version. All three adapters pass `runStorageConformance`
([`test/runtime/storage-conformance.ts`](../test/runtime/storage-conformance.ts)): change one, change all three.

## 10. Tests and evals

```bash
npm test       # Postgres tests skip without HERMOD_TEST_DATABASE_URL
npm run eval   # build, then the fixtures with the fake model (CI runs it)
HERMOD_LIVE=1 ANTHROPIC_API_KEY=<key> npm run eval:live   # opt-in, real API, at most USD 0.50 per run
```

- **Invariants** (protected, never weaken): `test/runtime/invariants.test.ts` (the seven rules),
  `invariants-loop.test.ts`, `invariants-policy.test.ts`.
- **Hardening** (`test/runtime/hardening/`; the first round's in `test/runtime/loop/`): a test per bypass the attack
  rounds found, each checked to fail without its guard. A new guard needs the same.
- **Postgres:** a random schema per test. `HERMOD_REQUIRE_PG_TESTS=1` (CI) fails without a database.
- **Evals** run the built `dist/` ([`evals/README.md`](../evals/README.md)). Live mode never runs in CI.
- **Vendoring:** `node scripts/vendor-runtime.mjs --target <app>/vendor/hermod --ref <tag | full sha>` builds this
  clean checkout (HEAD must be that ref) and copies `dist/`, `LICENSE`, a README and `VERSION.json` into the app,
  which commits it in a pull request.

## 11. Known limits

- **Reservations are per process.** Other processes see spend only once it is recorded; two processes can together
  pass a monthly cap.
- **Estimates are estimates.** The worst case is high on purpose, so tight caps end runs early.
- **The denylist is a backstop, not a sandbox.** Another spelling gets through; the approval policy and the app's
  tools protect.
- **Prompt injection is mitigated, not solved.** Read-only tools still run after untrusted text, and the model can
  be misled in what it says.
- **Redaction and the scan are patterns.** Assistant content is never redacted (thinking stays intact); only its
  search text is.
- `contextTrusted`, `trustPreStepOutput` and `untrustedOutput: false` are promises the runtime cannot check.
- Nothing sets the `expired` status: proposals wait until a person decides.
