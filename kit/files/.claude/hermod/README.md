# Hermod in this repository

This folder is the Hermod kit: a few plain Node scripts that help Claude Code sessions in this repository
start with the right context and end with the knowledge updated. It has no dependencies, makes no network
calls and needs no secrets. It was copied here by a person running Hermod's `scripts/sync.mjs` at a pinned
tag or commit; it does not update itself.

What it does:

- **Session brief** (SessionStart hook): prints a short brief at the start of every session: where the
  work stands (from the progress file), newer work on other branches (where you left off on another
  device), the lessons, an index of the skills, recent branches. The brief is frozen for the whole session, so
  a resumed or compacted session sees the same text.
- **Session ledger** (PostToolUse hook): notes failed commands and the fix that resolved them, and which
  skills were used, in a local file. Secrets are redacted before anything is written. With
  `"ledger": { "mode": "summary" }` it keeps only each failed command's plain-word key and exit code.
- **End-of-session ritual** (Stop hook): when code changed but the progress file did not, or a check or a
  validation fails, it asks Claude to finish the job before stopping. It blocks at most once per reason and
  never more than `ritual.maxBlocksPerSession` times per session.
- **Tools** you or Claude can run (below): validate, check, recall, curator, reflect-prep, brief.

## Whose files are these?

| Path | Owner | What happens on sync |
| --- | --- | --- |
| `.claude/hermod/hooks/`, `.claude/hermod/lib/`, `.claude/hermod/*.mjs`, this `README.md` | the kit | Updated to the new version. A file changed here is reported as a conflict and kept unless sync runs with `--force`. Change Hermod instead and sync again. |
| `.claude/hermod/VERSION.json` | the kit | Rewritten: the kit version, ref, commit, the chosen optional skills and a hash of every kit file. |
| Core kit skills in `.claude/skills/` (for example `reflect/` and `curate/`) | the kit | Updated like the scripts. |
| Optional kit skills in `.claude/skills/` (for example `nextjs-16/`) | the kit, when chosen | Installed only when chosen with `--skills`; later syncs keep the choice. When a skill is no longer chosen, its files are deleted, or kept if they were changed here. |
| `.claude/hermod/config.json` | this repository | Created once from a default if missing, never overwritten. |
| `.claude/hermod/LESSONS.md` | this repository | Created once (header only), never overwritten. |
| `.claude/hermod/checks/` | this repository | `checks/README.md` is created once; the checks are yours. |
| `.claude/hermod/state/` | this repository, once a person opts in | Never touched by sync. `ALLOW_COMMIT` is made by a person only; `sessions/` holds one summary per session (below). |
| `.claude/hermod/usage/` (older usage files, read only), `history/`, `archive/` | this repository | Never touched by sync. |
| Your own skills in `.claude/skills/` | this repository | Never touched by sync. |
| `.claude/hermod/.local/` | this machine | Never committed (it holds a `.gitignore` with `*`, and the `hermod-state` check refuses it). Ledger, session state and `errors.log`. Safe to delete. |
| Hook entries in `.claude/settings.json` whose command contains `/.claude/hermod/hooks/` | the kit | Replaced by the kit's entries. Every other setting and hook is kept as it is. |

## Nothing here changes your setup by itself

- No hook or script edits `CLAUDE.md`, `.claude/settings.json`, skills, `LESSONS.md`, `config.json` or
  checks. Hooks write only under `.claude/hermod/.local/`.
- The `/reflect` and `/curate` skills only **propose** changes, as edits in a pull request. A person
  reviews and merges them. "Nothing to save" is a normal result.
- Only `scripts/sync.mjs` in the Hermod repository changes the kit's files and its hook entries, and only
  when a person runs it.
- Hooks fail open: if a hook hits an error it writes one line to `.claude/hermod/.local/errors.log` (kept
  under 100 KB) and exits without output, so a session is never broken or blocked by a bug in Hermod.

## Following you between devices

Everything in `.local/` stays on the device where it was made; a cloud session loses it when its container ends.
In a **private** repository you can let a small summary of each session travel through git, so `/reflect` and
the curator see your sessions from every device:

1. Create `.claude/hermod/state/ALLOW_COMMIT` (any text, for example `private`) and merge it to the default
   branch. It counts only on the remote default branch (`origin/HEAD`, else `origin/main` or `origin/master`), so
   a marker made during a session does nothing until you merge it. Never add it to a public repository.
2. From then on, `/reflect` writes `.claude/hermod/state/sessions/<YYYY-MM-DD>-<id8>.json` and commits it with
   the session's work: the branch, skill uses and views, and each failed command as its key (at most three words:
   the program's name, flags, a tool's subcommand and an `npm run` script name, such as `npm run build`; every
   other argument, quoted text, a value glued to a flag and a path become `…`), exit code, attempts and whether it
   was resolved. Never a full command, its output or a file name. One
   file per session, so two devices never edit the same file.
3. The Stop hook asks once, in such a repository, to write the summary, commit the session's work and push it.
   It reads push status from local refs; nothing here fetches or pushes by itself.

The seeded check `hermod-state` enforces this: it fails a change that contains `.local/` files, any file under
`state/` before the marker is on the default branch, any other file under `state/`, or a summary that breaks
these rules. In every repository, public or not, the brief shows the newest branch with work that this branch
does not have yet, with its last commit and the first lines of its progress file's Next step (labelled as data
from an unmerged branch; `brief.otherBranches: 0` turns it off).

## Checks and their trust model

A check is a small JavaScript module in `.claude/hermod/checks/<id>.mjs` that protects against one known
mistake (see `checks/README.md` for the format). The Stop hook and `check.mjs` run the checks on the files
changed in a session.

Checks are code, and they run with your permissions on your machine. Treat them like any other code:

- Hermod runs only check files committed in this repository's `.claude/hermod/checks/` folder. It never
  downloads or generates checks by itself.
- A new or changed check arrives through a pull request, and a person reads it before merging.
- A check that throws or runs longer than 5 seconds counts as failed; a `warn` check never blocks.

## Running the tools

All commands run from the repository root and accept `--root DIR`, `--json` and `--help`.

```bash
node .claude/hermod/validate.mjs [--strict]          # config.json, LESSONS.md and every skill; exit 1 on errors
node .claude/hermod/check.mjs [--base REF]           # run the repository's checks against a base ref
node .claude/hermod/check.mjs --self-test            # run every check's own examples
node .claude/hermod/recall.mjs "query" [--limit N] [--source progress|decisions|git|history|all]
node .claude/hermod/curator.mjs [--out FILE]         # report on skill and lesson health (never edits)
node .claude/hermod/reflect-prep.mjs [--session ID] [--write-usage]  # evidence bundle for /reflect, in .local/reflect/;
                                                     # --write-usage also writes the session summary (opted-in repos)
node .claude/hermod/brief.mjs                        # the brief a new session would get
```

`validate.mjs` exits with 0 when everything is valid and 1 when there are errors (or warnings with
`--strict`), so it can run in CI.

## Settings

`.claude/hermod/config.json` holds this repository's settings: the progress file and the sections the
brief shows, the lessons cap, which paths count as code for the Stop hook and which files it requires to
change, extra redaction patterns for the ledger, recall sources and curator limits. Missing keys use the
defaults (see `DEFAULTS` in `lib/config.mjs`); unknown keys and invalid values are reported by
`validate.mjs`. Paths are relative to the repository root with `/` separators. A path pattern ending in
`/` matches a folder and everything in it; `*`, `**` and `?` work as in most glob tools.

## Updating or removing

- Update: in a Hermod checkout, run
  `node scripts/sync.mjs --target <path to this repository> --ref vX.Y.Z`, review the diff and open a
  pull request. Add `--skills <names>` (or `all`, or `none`) to change which optional skills are
  installed; without it the choice recorded in `VERSION.json` is kept.
- Remove: delete the kit's files listed in `VERSION.json` and the hook entries in `.claude/settings.json`
  that point to `.claude/hermod/hooks/`. Your config, lessons and checks can stay or go.
