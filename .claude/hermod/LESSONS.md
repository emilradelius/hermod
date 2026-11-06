# Lessons
<!-- hermod:lessons — declarative facts, separated by a line containing only §. Cap in config.json
     (lessons.capChars). Changes go through a pull request. -->

.npmrc sets ignore-scripts=true, so after npm ci better-sqlite3 has no native binding until npm rebuild better-sqlite3 --ignore-scripts=false runs; CI runs it right after npm ci, and the SQLite tests fail with "Could not locate the bindings file" without it.
§
.npmrc sets legacy-peer-deps=true because npm 10 crashes ("Cannot read properties of null (reading 'edgesOut')") while resolving vitest's optional peers. Peers the code needs are listed as exact devDependencies, and the drivers as optional peerDependencies.
§
Secret scanners and push protection flag fake keys and PEM headers in test files. Test secrets are built from fragments at runtime, for example ["sk", "ant", "api03", body].join("-") and "-----BEGIN RSA " + "PRIVATE KEY-----"; the no-secret-literals check enforces it.
§
kit/files has zero dependencies: plain Node 22 ESM (.mjs, // @ts-check) that imports only node: builtins and relative paths, and makes no network calls. The kit-zero-deps check enforces it.
§
src/ uses only erasable TypeScript (no parameter properties, enums or namespaces), so it also runs under Node's type stripping.
§
The SDK's error classes are imported from the package index (import { APIError } from "@anthropic-ai/sdk"); Anthropic.APIError used as a type fails with TS2749. An overloaded API (529) arrives as InternalServerError with status 529, so the classifier looks at the status before the class.
§
Claude Code shows at most 10,000 characters of SessionStart output in context and moves the rest to a file with a 2,000-character preview, so the brief budget defaults to 8,000 and never exceeds 9,500.
§
A Stop hook must return at once when stop_hook_active is true. Hermod's Stop hook blocks at most once per reason per session; its state lives in .claude/hermod/.local/, which is never committed.
§
The knowledge tools (memory, skill_propose) write only through MemoryService and ProposalService, so they run in shadow and supervised mode; their writes become memory or skill proposals, never action proposals. After untrusted text, even an add to an add-only store is a proposal.
§
scripts/vendor-runtime.mjs and scripts/sync.mjs accept only a tag or a full 40-character sha; vendor-runtime also refuses a dirty checkout and skip-worktree or assume-unchanged entries, because those hide local edits from git status.
