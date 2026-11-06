# Proposal format (what the reviewer returns)

Return one JSON object and nothing else:

```json
{
  "summary": "One sentence: what this session was about.",
  "proposals": [
    {
      "type": "check",
      "target": ".claude/hermod/checks/example-check.mjs",
      "change": "The full content of the new file.",
      "why": "One or two sentences: the mistake this prevents.",
      "evidence": [
        { "kind": "ledger", "ref": "f3a9c2", "quote": "Exit code 1 … expected" },
        { "kind": "commit", "ref": "1a2b3c4", "quote": "fix: …" }
      ]
    }
  ],
  "considered_and_skipped": ["A short reason for each thing you looked at and did not propose."]
}
```

- `type` is one of: `check`, `skill-patch`, `skill-reference`, `lesson-patch`, `lesson-remove`, `lesson-add`,
  `skill-new`.
- `target` is the repository path of the file to change or create.
- `change`:
  - for a patch: `{"old": "exact text now in the file", "new": "replacement text"}`;
  - for a removal: `{"old": "the exact lesson text"}`;
  - for a new file or lesson: the full text.
- `evidence[].kind` is one of `commit`, `diff`, `test`, `ledger`, `user`. `ref` is a sha, `path:line`, a test name, a
  ledger id, or `user`. `quote` is at most 25 words, copied exactly.
- An empty `proposals` list is a valid answer.
