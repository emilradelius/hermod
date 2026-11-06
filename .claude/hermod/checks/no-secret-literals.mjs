// @ts-check
// Lesson as a check: secret scanners and push protection flag fake keys and PEM headers, and a real key
// pasted into a fixture would be public at once (this repository is public). A changed source, test, eval
// or doc file fails when it contains a literal that looks like a key or a private-key header. Test secrets are
// built from fragments at runtime instead, for example ["sk", "ant", "api03", body].join("-").

const TEXT = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|json|jsonl|md|yml|yaml|txt)$/;
const SCOPES = ["src/", "test/", "evals/", "kit/", "scripts/", "docs/", ".github/"];
const PATTERNS = [
  { label: "an Anthropic key", re: /sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{8,}/ },
  { label: "a private-key header", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "a GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: "an AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "a Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { label: "a Stripe live key", re: /\bsk_live_[A-Za-z0-9]{10,}/ },
  { label: "an OpenAI project key", re: /\bsk-proj-[A-Za-z0-9_-]{10,}/ },
];

/** @param {string} p */
const posix = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");

/** @type {import('../../../kit/files/.claude/hermod/lib/checks.mjs').Check} */
export default {
  id: "no-secret-literals",
  description: "No key-shaped or private-key-header literals in source, tests, evals or docs; build fakes at runtime.",
  level: "error",
  when: SCOPES,
  run(ctx) {
    /** @type {string[]} */
    const hits = [];
    for (const given of ctx.changedFiles ?? []) {
      const rel = posix(given);
      if (!SCOPES.some((s) => rel.startsWith(s)) || !TEXT.test(rel)) continue;
      const text = ctx.read(given);
      if (text === null || text === undefined) continue; // deleted
      const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
      for (const { label, re } of PATTERNS) {
        const n = lines.findIndex((line) => re.test(line));
        if (n >= 0) hits.push(`${rel}:${n + 1} (${label})`);
      }
    }
    if (!hits.length) return { ok: true };
    const shown = hits.slice(0, 5).join("; ") + (hits.length > 5 ? `; and ${hits.length - 5} more` : "");
    return {
      ok: false,
      message:
        `Secret-shaped literal in ${shown}. If it is a real secret, remove it and rotate it. If it is a test ` +
        'fake, build it from fragments at runtime (["sk", "ant", "api03", body].join("-")).',
    };
  },
  examples: [
    {
      name: "passes for fakes built from fragments and for regex sources",
      ctx: {
        changedFiles: ["test/a.test.ts", "src/safety/redact.ts"],
        files: {
          "test/a.test.ts": 'const key = ["sk", "ant", "api03", "x".repeat(40)].join("-");\nconst pem = "-----BEGIN RSA " + "PRIVATE KEY-----";\n',
          "src/safety/redact.ts": "const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;\n",
        },
      },
      expect: true,
    },
    {
      name: "passes for files outside the scanned folders",
      ctx: { changedFiles: [".env.example"], files: { ".env.example": "ANTHROPIC_API_KEY=\n" } },
      expect: true,
    },
    {
      name: "fails on a key literal in a test",
      ctx: {
        changedFiles: ["test/b.test.ts"],
        files: { "test/b.test.ts": `const key = "${["sk", "ant", "api03"].join("-")}-${"Ab1".repeat(12)}";\n` },
      },
      expect: false,
    },
    {
      name: "fails on a private-key header in a fixture",
      ctx: {
        changedFiles: ["evals/fixtures/x.json"],
        files: { "evals/fixtures/x.json": `{ "text": "${"-----BEGIN " + "PRIVATE KEY-----"}" }\n` },
      },
      expect: false,
    },
  ],
};
