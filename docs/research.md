# Research: what we take from Hermes Agent, and why we build our own

This is the summary of the research behind Hermod. It was done before the build started and checked against
Hermes Agent's source on 2026-11-04. It is generic on purpose: it describes mechanisms and evidence, not any
particular app.

## 1. What Hermes Agent is

Hermes Agent (Nous Research, MIT licence, `github.com/NousResearch/hermes-agent`) is an always-on personal agent
with a "closed learning loop": it remembers facts, writes its own skills and reviews its own sessions. The repository
is about 1.06 million lines of Python; the real core is about 33,000 lines.

## 2. The mechanisms worth copying (with Hermes's real numbers)

1. **Bounded memory.**
   - Two files: `MEMORY.md` (environment and project facts, cap 2,200 characters) and `USER.md` (facts about the
     user, cap 1,375 characters).
   - Entries are separated by `\n§\n` and written as declarative facts, not commands: "User prefers concise
     answers", not "Always answer concisely". Imperatives get re-read later as orders.
   - The memory tool does atomic batch add / patch / remove. The cap is checked on the final state of the batch,
     and a batch that would empty the store is refused.
   - Memory is loaded into the system prompt once per session as a **frozen snapshot**. Writes go to disk but do
     not change the running prompt, which keeps the prompt cache warm.
2. **Skills.**
   - The agentskills.io `SKILL.md` format (the same one Claude Code uses): frontmatter `name` (at most 64
     characters, lowercase letters, digits and hyphens) and `description` (at most 1,024 characters; Hermes keeps
     the one-liner it indexes at 60 or fewer), plus optional `references/`, `scripts/` and `templates/`.
   - Progressive disclosure: only an index (name plus one line) sits in the prompt; the full skill is loaded when
     it is relevant.
   - A rule in the prompt: "if a skill you loaded had wrong or missing steps, fix it before finishing."
3. **Post-turn background review** (the real engine).
   - A fork of the agent replays the conversation and decides whether to save memory or to create or patch a skill.
   - Triggers: every 10 user turns (memory) or 10 tool iterations (skills). At most 16 steps. The fork's own
     nudges are off, and it only gets the skill and memory tools plus read-only file tools.
   - Its rules: save only facts grounded in the conversation (a user message or tool result you can point to);
     never turn a one-off request into a standing preference; prefer patching an existing skill, then adding a
     reference file to an umbrella skill, over creating a new skill; read before write; a do-not-save list
     (environment failures, transient errors, negative claims about tools, one-off narratives, unresolved failures
     written up as a "reliable workflow"); "write lessons, not logs: imperative rule plus why, no dates or PR
     numbers".
   - **Its flaw:** it is told "Be ACTIVE, most sessions produce a skill update", and it writes without approval
     (`write_approval: false`). The same model writes and grades itself.
4. **Curator.** Usage counters per skill (view, use, patch). Unused for 14 days: stale. Unused for 30 days:
   archived, never deleted, with backups and an audit ledger. Pinned skills are exempt.
5. **Session search.** Every past session goes into SQLite FTS5 (tool output truncated to 8 KB for the index). The
   tool returns raw matching messages and the top session in full, with no model call.
6. **Scheduled jobs.** Each run gets a fresh agent with no history (memory still loads), the skills it names, and
   an optional pre-script whose output becomes context. Scheduling tools are disabled inside a run; approvals are
   deny-by-default because nobody is there to answer. A `[SILENT]` reply means "deliver nothing". Delivery targets
   such as `telegram:<chat>` are resolved when the job fires.
7. **Safety.**
   - Web and MCP output is wrapped in "untrusted" delimiters, and forged delimiters are neutralised.
   - Context files and memory writes are scanned for injection (for example "ignore previous instructions",
     invisible Unicode, `curl` exfiltration).
   - A hard denylist that cannot be overridden, plus approval for dangerous commands.
   - Sub-agents cannot write memory, send messages, schedule jobs or delegate.
   - `send_message` is deliberately **not** a tool the model can call.
   - Unattended runs may only add memories; patches and removals wait for approval.
8. **Context compression.** At about 50 % of the window: prune old tool outputs, keep the head and a
   token-budgeted tail, and let a cheap model write a structured summary (Goal / Constraints / Progress / Decisions
   / Files / Next steps). The summary is marked "reference only; persistent memory is authoritative".
9. **Loop design.** Explicit phases with one state object; an iteration budget; an error classifier that maps each
   error to an action (retry, fallback, compress, abort). Read-only tools run in parallel, everything else in
   order, and results keep their order. Tool errors always go back to the model as JSON strings.

## 3. The evidence, and the design rule it forces

- **SkillsBench** (arXiv 2602.12670, 84 tasks): curated skills improved results by **+16.2 points**; skills the
  agent wrote for itself changed results by **−1.3 points**.
- Practitioners report self-made skills silently degrading workflows.
- Every positive result in this area (Voyager, Agent Workflow Memory, SkillWeaver, PILOT) has an **outside check**
  that decides what is kept.

**So in Hermod the agent only proposes. A human (merging a pull request, or approving in an inbox) or an automated
test decides what is kept.** "Nothing to save" is a normal, good outcome of a review.

## 4. Why we do not install or fork Hermes

- It is Python, local-first and single-user; our apps are TypeScript on our own hosting with our own database.
- It had CVEs and exposed control panels in 2026, and was used in a real intrusion. Its skills hub has a malware
  history.
- Prompt inflation: a 40-token request becomes about 20,000 tokens of prompt.
- It changes its own agent configuration and hooks by itself, runs unpinned `@latest` add-ons with full
  permissions, and can route data to other AI providers. We have ruled out tools that do any of these.

## 5. Hermod's design principles

1. **Proposals only.** Every change to memory, skills, lessons or hooks is a reviewable diff (a pull request) or a
   proposal in an inbox. The exception is narrow and explicit: the owner of a memory store may allow add-only writes.
2. **Bounded and frozen.** Memory and lessons have hard character caps, checked on the final state. They are loaded
   once per session as a frozen snapshot.
3. **Progressive disclosure.** Only an index of skills is in the prompt; the full skill loads on demand.
4. **Grounding is checked by code.** A proposal must cite evidence (a message, a tool result, a commit, a test, a
   log line), and the code verifies that the cited evidence exists.
5. **Lessons become checks.** When a lesson can be checked by code, the proposal is a check or a test, not more
   text.
6. **Deterministic hooks.** The build-time hooks are plain Node scripts with no network and no dependencies. They
   fail open (never break a session) and never loop.
7. **Pinned and local.** Nothing unpinned, nothing `@latest`, no third-party add-ons. The kit is copied into each
   repository at a pinned version, only when a person runs the sync.
8. **One provider.** Model calls go only to Anthropic, through the official SDK.
9. **Untrusted text is data.** Web, file and tool output from outside is wrapped and neutralised, and it cannot
   trigger side-effecting tool calls on its own (taint: after untrusted input, side effects need approval).
10. **Unattended means deny-by-default.** Scheduled runs cannot schedule, delegate or message anyone; anything that
    needs approval is denied, and memory changes other than adds wait for a person.
11. **No messaging tool.** The model never gets a tool that sends a message to a customer or anyone else. Delivery
    is done by application code to configured targets.

## 6. Mapping: Hermes mechanism → Hermod

| Hermes | Hermod Part A (how we build, inside each repo) | Hermod Part B (runtime inside apps) |
|---|---|---|
| `MEMORY.md` / `USER.md`, frozen snapshot | `.claude/hermod/LESSONS.md` (bounded, `§`), printed once in the session brief | bounded memory stores in the app's database, frozen per session |
| Skills + index | curated `.claude/skills/*/SKILL.md`, index in the brief, validator | skills table with versions, index in the prompt, `skill_view` |
| Background review | `/reflect`: a reviewer sub-agent proposes changes inside the pull request | post-session review on a cheap model that writes proposals |
| Curator | monthly `/curate` report, proposals as a pull request | usage counters, stale and archive flags, never delete |
| Session search | `recall.mjs` (BM25 over progress logs, decisions, git log) | full-text search over sessions (FTS5 / tsvector) |
| Scheduled jobs | (not needed) | jobs table + `tick()`, fresh session per run, `[SILENT]` |
| Safety | session ledger with redaction, injection scan in the validator | redaction hook, untrusted wrapping, injection scan, denylist, taint |
| Compression | (Claude Code compacts itself) | prune + summarise on a cheap model, "reference only" |
| Loop design | (Claude Code) | phases, one state, budgets, error classifier, parallel read-only tools |
