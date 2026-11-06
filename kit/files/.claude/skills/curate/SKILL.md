---
name: curate
description: Monthly tidy-up of this repo's skills and lessons. Reports unused, overlapping and too-long items and proposes merges or archiving as a pull request. Use once a month, or when asked to curate, tidy or prune skills and lessons.
disable-model-invocation: true
---

# Curate: a monthly tidy-up, proposed as a pull request

The curator script only reports. You propose; a person merges. Nothing is deleted: an archived skill moves to
`.claude/hermod/archive/skills/<name>/` with a line in `.claude/hermod/archive/LEDGER.md`.

## Steps

1. Run `node .claude/hermod/curator.mjs --out .claude/hermod/.local/curator-report.md` and read the report.
2. Decide one action per finding, or none:
   - **Stale or archive candidate** (unused for 14 or 30 days, not pinned; never reported while the ledger is off,
     because then no use is recorded): move the skill folder to
     `.claude/hermod/archive/skills/<name>/` and add a line to `.claude/hermod/archive/LEDGER.md` with the date, what
     moved, why, and the report's numbers as evidence.
   - **Overlapping skills**: merge the smaller into the larger, keep the clearer name, carry over unique steps, and
     archive the other one the same way.
   - **Too long**: move detail into `references/` files and keep `SKILL.md` as the procedure.
   - **Lessons**: merge near-duplicates, fold a lesson that restates a skill into that skill, shorten to fit the cap.
   - **Flagged but still right**: leave it and say why.
3. Check the result with `node .claude/hermod/validate.mjs`.
4. Open a pull request titled "Hermod: monthly curation" that lists each change with the report's evidence. A person
   merges it.

## Rules

- Pinned skills (`curator.pinned` in `.claude/hermod/config.json`) are never archived.
- Usage comes from `.claude/hermod/usage/*.json`, which `/reflect` writes per session. A skill with no usage data is
  measured from the day it was added.
- Never delete a skill, the lessons file or any history. Archive instead.
