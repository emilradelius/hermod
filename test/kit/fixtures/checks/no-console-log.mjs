// @ts-check
/**
 * An example check, used only by the kit's tests (test/kit/checks.test.ts and stop.test.ts copy it into
 * `.claude/hermod/checks/` of a temporary repository). It shows the format a repository's own checks use.
 */
/** @type {import('../lib/checks.mjs').Check} */
export default {
  id: "no-console-log",
  description: "New lines in src/ do not call console.log (use the logger)",
  level: "error",
  when: ["src/"],
  run(ctx) {
    const offenders = ctx.changedFiles.filter(
      (f) =>
        f.startsWith("src/") &&
        ctx
          .diff(f)
          .split("\n")
          .some((line) => line.startsWith("+") && !line.startsWith("+++") && line.includes("console.log(")),
    );
    return offenders.length > 0
      ? { ok: false, message: `console.log added in ${offenders.join(", ")}` }
      : { ok: true };
  },
  examples: [
    {
      name: "passes when nothing in src/ changed",
      ctx: { changedFiles: ["docs/PROGRESS.md"], files: {}, baseFiles: {} },
      expect: true,
    },
    {
      name: "passes when the new line uses the logger",
      ctx: {
        changedFiles: ["src/app.ts"],
        files: { "src/app.ts": 'log.info("hi");\n' },
        baseFiles: { "src/app.ts": "" },
      },
      expect: true,
    },
    {
      name: "fails when a new line calls console.log",
      ctx: {
        changedFiles: ["src/app.ts"],
        files: { "src/app.ts": 'console.log("hi");\n' },
        baseFiles: { "src/app.ts": "" },
      },
      expect: false,
    },
  ],
};
