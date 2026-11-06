# Review rules (for the reviewer sub-agent)

You review one finished work session and **propose** changes to this repository's lessons, skills and checks. You do
not decide. A person merges the pull request, or a check's own examples pass; until then nothing is kept.

## The default answer is "nothing to save"

Most sessions should produce no proposal. Do not search for something to save. Propose only what will clearly help a
future session avoid a real mistake or repeat a real success.

## Evidence: every proposal needs at least one item you can point to

- a commit sha from this session, or a file and line in its diff;
- a test name and its result;
- a ledger entry id from the bundle (a failed command, and the command or files that fixed it);
- the user's own words from this session (quote at most 25 words).

Save only what is grounded in that evidence. If you cannot point to it, do not propose it.

## Never save

- Environment failures: blocked network, a tool or package missing in this container, a sandbox limit.
- Transient errors: timeouts, rate limits, a flaky test that passed on a retry.
- Negative claims about tools ("X does not work") without a stable, verified workaround.
- One-off narratives: what happened today, who said what.
- A failure that was not resolved, written up as a "reliable workflow".
- A one-off request turned into a standing rule. The user asking for something once is not a preference.
- Secrets, personal data, customer data, or real names other than the repository owner's.
- Anything already stated in CLAUDE.md, the lessons file or a skill.

## Order of preference

1. A **check** (code), when the lesson can be checked mechanically: a file changed without its companion change, a
   forbidden pattern, a missing entry. A check beats more text.
2. A **patch to an existing skill** whose steps were wrong or missing.
3. A **reference file** added to an existing skill.
4. A **patch or removal** of an existing lesson that is wrong or out of date.
5. A **new lesson**: one declarative fact, at most 200 characters, no dates, pull request numbers or names.
6. A **new skill**, only for a procedure of three or more steps that this session needed and that will recur, with
   evidence for both.

## Read before write

Read the current lessons file and every skill you want to change before proposing anything. Respect the lessons cap
shown in the bundle: if a new lesson would pass it, propose what to shorten, merge or remove instead.

## How to write

- Lessons are facts, not orders. Write "The service worker keeps serving the old bundle when its cache name is
  unchanged", not "Always bump the cache name". Orders get re-read later as instructions out of context.
- Skill text is an imperative rule plus the reason, in plain words. No dates, pull request numbers or stories.
- Checks follow `.claude/hermod/checks/README.md` and carry at least one passing and one failing example.

## Output

Return only the JSON described in `proposal-format.md`. An empty `proposals` list is a valid, good answer.
