---
name: reflect
description: Proposes lessons, skills or checks at session end. An independent reviewer drafts each change with its evidence, as a diff in the pull request for a person to merge. Use at the end of a work session, before the final commit, or when asked to reflect, save a lesson or fix a skill.
---

# Reflect: propose what this session taught, with evidence

Nothing written here is kept until a person merges the pull request, or a check's own examples pass. "Nothing to
save" is a good and common outcome.

## Steps

1. **Gather the evidence.** Run `node .claude/hermod/reflect-prep.mjs`. It writes an evidence bundle (this session's
   commits and diff summary, failed commands and what fixed them, the user's messages from this session, the current
   lessons, skills and checks) to `.claude/hermod/.local/reflect/` and prints the path. Read it.
2. **Ask an independent reviewer.** Start one sub-agent (Agent tool, general-purpose) with only this task:
   "Read `<bundle path>` and `.claude/skills/reflect/references/review-rules.md` and follow the rules exactly. You may
   read any file in the repository; do not edit anything. Return only the JSON described in
   `.claude/skills/reflect/references/proposal-format.md`." Do not tell it what you think should be saved.
3. **Check each proposal yourself** before applying it. Drop it, and say why, when:
   - its evidence does not exist (`git cat-file -e <sha>`, the file and line, the ledger id or the quoted words in
     the bundle);
   - it repeats CLAUDE.md, an existing lesson or a skill;
   - it falls under "Never save" in `references/review-rules.md`;
   - it breaks the lessons cap or a format rule.
4. **Apply what survives** as plain file edits:
   - lessons: `.claude/hermod/LESSONS.md` (entries separated by a line containing only `§`);
   - skills: the skill's `SKILL.md`, or a new file in its `references/`;
   - checks: `.claude/hermod/checks/<id>.mjs` with at least one passing and one failing example
     (format: `.claude/hermod/checks/README.md`).

   Then run `node .claude/hermod/validate.mjs` and `node .claude/hermod/check.mjs --self-test`. Fix or drop proposals
   until both pass.
5. **Record the session** for the curator and your other devices: `node .claude/hermod/reflect-prep.mjs --write-usage`.
   In a repository that lets state travel (`.claude/hermod/state/ALLOW_COMMIT` on the default branch) it writes
   `.claude/hermod/state/sessions/<date>-<id8>.json` (skill use, failed commands as plain-word keys, never output);
   commit it with the rest. Elsewhere it writes nothing and says why. Never create `ALLOW_COMMIT` yourself.
6. **Hand it to a person.** Commit the changes on the working branch as one commit, `hermod: proposals from
   /reflect`, and list them in the pull request under **Hermod proposals**: what, why, evidence. If there were none,
   write "Hermod proposals: nothing to save". Never push to the default branch and never merge.

## Always

- You propose; a person decides. Never describe a proposal as accepted.
- Lessons are declarative facts ("X happens when Y"), not commands. No dates, pull request numbers or stories.
- Prefer a check over more text when the lesson can be checked by code.
- No secrets, personal data or customer data in lessons, skills or checks.
- If a skill you used in this session had wrong or missing steps, propose the fix to that skill.
