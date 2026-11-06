// @ts-check
// Lesson as a check: everything is pinned to an exact version (CLAUDE.md, "Pinned and local"), because a floating
// tag installs or runs whatever was published last, and the kit's skills are instructions that other repositories
// copy. A changed skill, doc, script, source, package.json or workflow file fails when it names a package at a
// floating dist-tag (name@latest, @canary, @next, ...). A changed workflow file also fails on an action that is not
// pinned to a full commit SHA, a *-latest runner, an image without a sha256 digest, or a node-version that is not
// an exact x.y.z. Tests and eval fixtures are not scanned: they may hold such text as data.

const TEXT = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|json|jsonc|md|yml|yaml|txt|sh)$/;
const SCOPES = ["kit/", "docs/", "scripts/", "src/", ".github/", "CLAUDE.md", "README.md", "package.json"];
// name@tag or @scope/name@tag. An e-mail address (dev@next.example) and "`@latest`" in prose do not match.
const TAG = /(?<![\w@/.-])((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(latest|canary|next|beta|alpha|rc|nightly|experimental)(?![\w-]|\.\w)/i;
const WORKFLOW = /^\.github\/.+\.ya?ml$/;
const RUNNER = /\b(?:ubuntu|windows|macos)-latest\b/;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const EXACT = /^\d+\.\d+\.\d+$/;

/** @param {string} p */
const posix = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");

/** @param {string} rel */
const inScope = (rel) => SCOPES.some((s) => (s.endsWith("/") ? rel.startsWith(s) : rel === s));

/**
 * The value of `key:` on one YAML line, without quotes ("" when the line has no such key or no value).
 * @param {string} line
 * @param {string} key
 */
function yamlValue(line, key) {
  const m = new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*['"]?([^\\s'"#]+)`).exec(line);
  return m ? m[1] : "";
}

/**
 * What floats on one workflow line (whole-line comments are skipped by the caller).
 * @param {string} line
 * @returns {string[]}
 */
function workflowFindings(line) {
  const code = line.replace(/\s#.*$/, "");
  /** @type {string[]} */
  const found = [];
  const uses = yamlValue(code, "uses");
  if (uses && !uses.startsWith("./")) {
    const at = uses.lastIndexOf("@");
    if (uses.startsWith("docker://")) {
      if (!DIGEST.test(uses)) found.push(`${uses} has no sha256 digest`);
    } else if (at < 0 || !SHA.test(uses.slice(at + 1))) {
      found.push(`action ${uses} is not pinned to a full commit SHA`);
    }
  }
  const runner = RUNNER.exec(code);
  if (runner) found.push(`runner ${runner[0]}`);
  const image = yamlValue(code, "image") || yamlValue(code, "container");
  if (image && !image.includes("${{") && !DIGEST.test(image)) found.push(`image ${image} has no sha256 digest`);
  const node = yamlValue(code, "node-version");
  if (node && !node.includes("${{") && !EXACT.test(node)) found.push(`node-version ${node} is not an exact x.y.z`);
  return found;
}

/** @type {import('../../../kit/files/.claude/hermod/lib/checks.mjs').Check} */
export default {
  id: "no-floating-versions",
  description: "Packages, actions, runners, images and Node are pinned to exact versions; no @latest or @canary.",
  level: "error",
  when: SCOPES,
  run(ctx) {
    /** @type {string[]} */
    const hits = [];
    for (const given of ctx.changedFiles ?? []) {
      const rel = posix(given);
      if (!inScope(rel) || !TEXT.test(rel)) continue;
      const text = ctx.read(given);
      if (text === null || text === undefined) continue; // deleted
      const workflow = WORKFLOW.test(rel);
      String(text)
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .forEach((line, i) => {
          if (workflow && line.trim().startsWith("#")) return;
          const tag = TAG.exec(line);
          if (tag) hits.push(`${rel}:${i + 1} (${tag[1]}@${tag[2]})`);
          if (workflow) for (const f of workflowFindings(line)) hits.push(`${rel}:${i + 1} (${f})`);
        });
    }
    if (!hits.length) return { ok: true };
    const clip = (/** @type {string} */ s) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);
    const shown = hits.slice(0, 2).map(clip).join("; ") + (hits.length > 2 ? `; and ${hits.length - 2} more` : "");
    return {
      ok: false,
      message:
        `Floating version in ${shown}. Pin exact versions: name@1.2.3 (ask the person before a codemod or ` +
        "installer runs), actions by full commit SHA, runners like ubuntu-24.04, images with a sha256 digest, " +
        "node-version as x.y.z.",
    };
  },
  examples: [
    {
      name: "passes for exact versions, a SHA-pinned action, a digest-pinned image and the tag words in prose",
      ctx: {
        changedFiles: [".github/workflows/ci.yml", "kit/files/.claude/skills/web/SKILL.md", "docs/setup.md"],
        files: {
          ".github/workflows/ci.yml": pinnedWorkflow(),
          "kit/files/.claude/skills/web/SKILL.md":
            "Ask first, then run `npx @next/codemod@16.4.0 middleware-to-proxy .`; never `@canary` or `latest`.\n",
          "docs/setup.md": "Write to dev@next.example. The scoped package @next/env is pinned in package.json.\n",
        },
      },
      expect: true,
    },
    {
      name: "passes for tests and eval fixtures, which may hold floating tags as data",
      ctx: {
        changedFiles: ["test/sync.test.ts", "evals/fixtures/a.json"],
        files: {
          "test/sync.test.ts": 'expect(isPinned("npx some-tool@latest")).toBe(false);\n',
          "evals/fixtures/a.json": '{ "text": "run npx some-tool@canary" }\n',
        },
      },
      expect: true,
    },
    {
      name: "fails on a codemod at @canary in a kit skill",
      ctx: {
        changedFiles: ["kit/files/.claude/skills/web/references/proxy.md"],
        files: {
          "kit/files/.claude/skills/web/references/proxy.md": "Migrate with `npx @next/codemod@canary middleware-to-proxy .`.\n",
        },
      },
      expect: false,
    },
    {
      name: "fails on a package at @latest in the docs",
      ctx: { changedFiles: ["docs/setup.md"], files: { "docs/setup.md": "Start with `npx create-next-app@latest`.\n" } },
      expect: false,
    },
    {
      name: "fails on an action pinned to a tag",
      ctx: {
        changedFiles: [".github/workflows/ci.yml"],
        files: { ".github/workflows/ci.yml": pinnedWorkflow().replace(`actions/checkout@${"0".repeat(40)}`, "actions/checkout@v4") },
      },
      expect: false,
    },
    {
      name: "fails on a -latest runner",
      ctx: {
        changedFiles: [".github/workflows/ci.yml"],
        files: { ".github/workflows/ci.yml": pinnedWorkflow().replace("runs-on: ubuntu-24.04", "runs-on: ubuntu-latest") },
      },
      expect: false,
    },
    {
      name: "fails on a service image without a digest",
      ctx: {
        changedFiles: [".github/workflows/ci.yml"],
        files: { ".github/workflows/ci.yml": pinnedWorkflow().replace(/image: postgres:\S+/, "image: postgres:16") },
      },
      expect: false,
    },
    {
      name: "fails on a node-version that names only the major version",
      ctx: {
        changedFiles: [".github/workflows/ci.yml"],
        files: { ".github/workflows/ci.yml": pinnedWorkflow().replace("node-version: 22.23.4", "node-version: 22") },
      },
      expect: false,
    },
  ],
};

/** A workflow with everything pinned; the comment lines name floating versions, which are not checked. */
function pinnedWorkflow() {
  return [
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-24.04",
    "    services:",
    "      db:",
    `        image: postgres:16.15@sha256:${"a".repeat(64)}`,
    "    steps:",
    `      - uses: actions/checkout@${"0".repeat(40)} # v6.1.0`,
    "      - uses: ./.github/actions/setup",
    `      - uses: actions/setup-node@${"1".repeat(40)} # v6.5.0`,
    "        with:",
    "          node-version: 22.23.4",
    "          # not ubuntu-latest, postgres:16 or node-version: 22",
    "",
  ].join("\n");
}
