// Tests for the curator (kit/files/.claude/hermod/curator.mjs and lib/usage.mjs): the CLI is run end to end with
// `node` in temporary git repositories with the real kit copied in; skills are committed on fixed dates and the
// report date is fixed with --now, so every day count is exact.
import { existsSync, mkdirSync, readdirSync, symlinkSync, utimesSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KIT_FILES, cleanup, makeRepo, runNode, tempDir, type Files, type Repo, type RunResult } from "./helpers.js";
import { snapshot } from "./sync-helpers.js";
// @ts-expect-error -- plain .mjs without type declarations
import * as curator from "../../kit/files/.claude/hermod/curator.mjs";
// @ts-expect-error -- plain .mjs without type declarations
import * as usageLib from "../../kit/files/.claude/hermod/lib/usage.mjs";

afterAll(() => cleanup());

/** The kit's own skills (kit/files/.claude/skills/<name>/SKILL.md). */
const KIT_SKILLS = readdirSync(path.join(KIT_FILES, ".claude", "skills")).filter((n) =>
  existsSync(path.join(KIT_FILES, ".claude", "skills", n, "SKILL.md")),
);

const FOOTER = "This report changes nothing. /curate turns it into a pull request a person merges.";

interface SkillRow {
  name: string;
  status: string;
  uses: number;
  views: number;
  sessions: number;
  lastUsed: string | null;
  created: string | null;
  createdFrom: string | null;
  since: string | null;
  idleDays: number | null;
  lastModified: string | null;
  patches: number;
  lines: number;
  chars: number;
  descriptionChars: number;
  firstSentenceChars: number;
  pinned: boolean;
  kit: boolean;
}
interface Report {
  date: string;
  usage: { tracked: boolean; files: number; invalidFiles: string[]; ledgerEvents: number; ledgerSkipped: number; unknownSkills: string[] };
  skills: SkillRow[];
  overlaps: Array<{ a: string; b: string; similarity: number }>;
  tooLong: Array<{ name: string; lines: number; chars: number; overLines: boolean; overChars: boolean }>;
  lessons: {
    found: boolean;
    chars: number;
    cap: number;
    percent: number;
    entries: number;
    duplicates: Array<{ a: number; b: number; similarity: number }>;
    restates: Array<{ lesson: number; skill: string; share: number; kit: boolean }>;
  };
  actions: Array<{ kind: string; target: string; text: string }>;
  configErrors: string[];
}

function skillFile(name: string, description: string, body: string): Files {
  return { [`.claude/skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n` };
}

const DEPLOY = skillFile(
  "deploy-steps",
  "Deploy the web service to production. Use when shipping a release.",
  "# Deploy\n\n1. Build the container image with the pinned toolchain.\n2. Push the image to the registry.\n3. Run the database migrations against staging first.\n4. Promote the staging deployment after the smoke tests pass.\n5. Watch the error dashboard for fifteen minutes.\n",
);
const PHOTOS = skillFile(
  "photo-resize",
  "Resize uploaded photographs into thumbnails. Use when changing image handling.",
  "# Photos\n\nThumbnails are square, cropped around the centre, encoded as webp with quality eighty. Originals stay untouched in cold storage; exif orientation is applied before cropping.\n",
);

/** A date at noon UTC, for commit dates. */
const at = (day: string) => `${day}T12:00:00+00:00`;

function repoWith(skillsByDay: Array<{ day: string; files: Files }>, files: Files = {}): Repo {
  return makeRepo({ kitSkills: false, files, commits: skillsByDay.map((c) => ({ files: c.files, date: at(c.day), message: `add ${c.day}` })) });
}

function run(repo: Repo, ...args: string[]): RunResult {
  return runNode(repo.kitPath("curator.mjs"), { cwd: repo.root, args, env: { CLAUDE_PROJECT_DIR: repo.root } });
}

function report(repo: Repo, now: string, ...args: string[]): Report {
  const r = run(repo, "--json", "--now", now, ...args);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Report;
}

function row(rep: Report, name: string): SkillRow {
  const s = rep.skills.find((x) => x.name === name);
  expect(s, `skill ${name} in the report`).toBeDefined();
  return s as SkillRow;
}

const config = (curatorSettings: Record<string, unknown>, extra: Record<string, unknown> = {}): Files => ({
  ".claude/hermod/config.json": JSON.stringify({ version: 1, curator: curatorSettings, ...extra }),
});

const usageFile = (date: string, session: string, skills: Record<string, unknown>): string => JSON.stringify({ session, date, skills });

const lessonsText = (...entries: string[]) => `# Lessons\n<!-- hermod:lessons -->\n\n${entries.join("\n§\n")}\n`;

// ------------------------------------------------------------------------------------------ status

describe("status by days without use", () => {
  const repo = repoWith([{ day: "2026-10-01", files: DEPLOY }]);

  it.each([
    ["2026-10-01", 0, "active"],
    ["2026-10-14", 13, "active"],
    ["2026-10-15", 14, "stale"],
    ["2026-10-30", 29, "stale"],
    ["2026-10-31", 30, "archive-candidate"],
    ["2027-03-01", 151, "archive-candidate"],
  ])("on %s (%i days after it was added) the skill is %s", (now, days, status) => {
    const s = row(report(repo, now), "deploy-steps");
    expect(s.created).toBe("2026-10-01");
    expect(s.createdFrom).toBe("git");
    expect(s.lastUsed).toBeNull();
    expect(s.idleDays).toBe(days);
    expect(s.status).toBe(status);
  });

  it("uses the configured thresholds, exactly at the boundary", () => {
    const custom = repoWith([{ day: "2026-10-01", files: DEPLOY }], config({ staleDays: 3, archiveDays: 5 }));
    expect(row(report(custom, "2026-10-03"), "deploy-steps").status).toBe("active");
    expect(row(report(custom, "2026-10-04"), "deploy-steps").status).toBe("stale");
    expect(row(report(custom, "2026-10-05"), "deploy-steps").status).toBe("stale");
    expect(row(report(custom, "2026-10-06"), "deploy-steps").status).toBe("archive-candidate");
  });

  it("suggests archiving an archive candidate and reviewing a stale skill, with the numbers", () => {
    const two = repoWith([
      { day: "2026-09-01", files: DEPLOY },
      { day: "2026-10-20", files: PHOTOS },
    ]);
    const rep = report(two, "2026-11-05");
    expect(row(rep, "deploy-steps").status).toBe("archive-candidate");
    expect(row(rep, "photo-resize").status).toBe("stale");
    const archive = rep.actions.filter((a) => a.kind === "archive");
    expect(archive.map((a) => a.target)).toEqual(["deploy-steps"]);
    expect(archive[0]?.text).toContain("65 days without use");
    expect(archive[0]?.text).toContain("added 2026-09-01");
    expect(archive[0]?.text).toContain("uses 0, views 0");
    const stale = rep.actions.filter((a) => a.kind === "review-stale");
    expect(stale.map((a) => a.target)).toEqual(["photo-resize"]);
    expect(stale[0]?.text).toContain("16 days without use");
  });

  it("a skill created on a later commit is measured from the commit that added SKILL.md, not the last edit", () => {
    const edited = repoWith([
      { day: "2026-09-01", files: DEPLOY },
      { day: "2026-10-30", files: { ".claude/skills/deploy-steps/SKILL.md": `${DEPLOY[".claude/skills/deploy-steps/SKILL.md"]}\nOne more line.\n` } },
    ]);
    const s = row(report(edited, "2026-11-05"), "deploy-steps");
    expect(s.created).toBe("2026-09-01");
    expect(s.lastModified).toBe("2026-10-30");
    expect(s.patches).toBe(2);
    expect(s.status).toBe("archive-candidate");
  });

  it("an uncommitted skill is measured from its file date", () => {
    const r = makeRepo({ kitSkills: false });
    r.write(".claude/skills/photo-resize/SKILL.md", PHOTOS[".claude/skills/photo-resize/SKILL.md"] as string);
    const t = new Date("2026-10-10T12:00:00");
    utimesSync(r.abs(".claude/skills/photo-resize/SKILL.md"), t, t);
    const s = row(report(r, "2026-11-09"), "photo-resize");
    expect(s.createdFrom).toBe("mtime");
    expect(s.created).toBe("2026-10-10");
    expect(s.idleDays).toBe(30);
    expect(s.status).toBe("archive-candidate");
    expect(s.lastModified).toBeNull();
    expect(s.patches).toBe(0);
  });

  it("works in a folder that is not a git repository", () => {
    const r = makeRepo({ kitSkills: false, git: false, files: DEPLOY });
    const t = new Date("2026-10-20T12:00:00");
    utimesSync(r.abs(".claude/skills/deploy-steps/SKILL.md"), t, t);
    const s = row(report(r, "2026-11-05"), "deploy-steps");
    expect(s.created).toBe("2026-10-20");
    expect(s.status).toBe("stale");
  });
});

describe("pinned and kit skills", () => {
  it("a pinned skill is never stale or an archive candidate", () => {
    const repo = repoWith([{ day: "2026-01-01", files: { ...DEPLOY, ...PHOTOS } }], config({ pinned: ["deploy-steps"] }));
    const rep = report(repo, "2026-11-05");
    const s = row(rep, "deploy-steps");
    expect(s.pinned).toBe(true);
    expect(s.status).toBe("pinned");
    expect(s.idleDays).toBeGreaterThan(300);
    expect(row(rep, "photo-resize").status).toBe("archive-candidate");
    expect(rep.actions.some((a) => a.target === "deploy-steps")).toBe(false);
    expect(rep.actions.some((a) => a.kind === "archive" && a.target === "photo-resize")).toBe(true);
  });

  it("with the ledger off, skill use is not recorded: no skill is stale or an archive candidate, and the report says so", () => {
    const off = repoWith([{ day: "2026-01-01", files: { ...DEPLOY, ...PHOTOS } }], config({}, { ledger: { enabled: false } }));
    const rep = report(off, "2026-11-05");
    expect(rep.usage.tracked).toBe(false);
    for (const name of ["deploy-steps", "photo-resize"]) {
      expect(row(rep, name).idleDays).toBeGreaterThan(300);
      expect(row(rep, name).status).toBe("active");
    }
    expect(rep.actions.some((a) => a.kind === "archive" || a.kind === "review-stale")).toBe(false);
    expect(curator.formatReport(rep)).toContain("Skill use is not recorded while the ledger is off");
    // The same repository with the ledger on (the default) does call them out.
    const on = repoWith([{ day: "2026-01-01", files: { ...DEPLOY, ...PHOTOS } }]);
    const onRep = report(on, "2026-11-05");
    expect(onRep.usage.tracked).toBe(true);
    expect(row(onRep, "deploy-steps").status).toBe("archive-candidate");
    expect(curator.formatReport(onRep)).not.toContain("not recorded");
  });

  it("skills the kit owns (listed in VERSION.json) are exempt; the repo's own are not", () => {
    const repo = makeRepo({
      files: DEPLOY,
      commits: [
        {
          date: at("2026-01-01"),
          files: {
            ".claude/hermod/VERSION.json": JSON.stringify({
              kit: "0.1.0",
              files: Object.fromEntries([
                ...KIT_SKILLS.map((n) => [`.claude/skills/${n}/SKILL.md`, "x"]),
                [".claude/hermod/curator.mjs", "z"],
              ]),
            }),
          },
        },
      ],
    });
    const rep = report(repo, "2027-06-01");
    expect(KIT_SKILLS).toContain("reflect");
    for (const name of KIT_SKILLS) expect(row(rep, name).status).toBe("kit");
    expect(row(rep, "deploy-steps").status).toBe("archive-candidate");
    expect(rep.actions.filter((a) => a.kind === "archive").map((a) => a.target)).toEqual(["deploy-steps"]);
  });
});

// ------------------------------------------------------------------------------------------- usage

describe("usage", () => {
  const skills = [{ day: "2026-09-01", files: { ...DEPLOY, ...PHOTOS } }];

  it("counts usage files and measures from the last use", () => {
    const repo = repoWith(skills, {
      ".claude/hermod/usage/2026-10-10-aaaa1111.json": usageFile("2026-10-10", "aaaa1111-s", { "deploy-steps": { uses: 2, views: 1 } }),
      ".claude/hermod/usage/2026-10-20-bbbb2222.json": usageFile("2026-10-20", "bbbb2222-s", { "deploy-steps": { uses: 1, views: 0 }, "photo-resize": { uses: 0, views: 0 } }),
    });
    const before = report(repo, "2026-11-02");
    const d = row(before, "deploy-steps");
    expect(before.usage.files).toBe(2);
    expect(d.uses).toBe(3);
    expect(d.views).toBe(1);
    expect(d.sessions).toBe(2);
    expect(d.lastUsed).toBe("2026-10-20");
    expect(d.since).toBe("2026-10-20");
    expect(d.idleDays).toBe(13);
    expect(d.status).toBe("active");
    // A zero count is not a use.
    const p = row(before, "photo-resize");
    expect(p.lastUsed).toBeNull();
    expect(p.status).toBe("archive-candidate");

    expect(row(report(repo, "2026-11-03"), "deploy-steps").status).toBe("stale");
    expect(row(report(repo, "2026-11-19"), "deploy-steps").status).toBe("archive-candidate");
  });

  it("a view alone counts as a use", () => {
    const repo = repoWith(skills, {
      ".claude/hermod/usage/2026-11-01-cccc3333.json": usageFile("2026-11-01", "c", { "photo-resize": { views: 1 } }),
    });
    const p = row(report(repo, "2026-11-05"), "photo-resize");
    expect(p.views).toBe(1);
    expect(p.uses).toBe(0);
    expect(p.lastUsed).toBe("2026-11-01");
    expect(p.status).toBe("active");
  });

  it("a use older than the skill's creation does not make it older (the later date counts)", () => {
    const repo = repoWith([{ day: "2026-10-25", files: DEPLOY }], {
      ".claude/hermod/usage/2026-09-01-dddd4444.json": usageFile("2026-09-01", "d", { "deploy-steps": { uses: 5 } }),
    });
    const s = row(report(repo, "2026-11-05"), "deploy-steps");
    expect(s.since).toBe("2026-10-25");
    expect(s.idleDays).toBe(11);
    expect(s.status).toBe("active");
  });

  it("adds the local ledger's skill events, but not for sessions that already have a usage file", () => {
    const ledger = [
      { id: "1", ts: "2026-10-15T09:00:00.000Z", session: "covered", type: "skill", skill: "deploy-steps" },
      { id: "2", ts: "2026-11-01T09:00:00.000Z", session: "fresh", type: "skill", skill: "photo-resize" },
      { id: "3", ts: "2026-11-01T09:01:00.000Z", session: "fresh", type: "skill-view", skill: "photo-resize" },
      { id: "4", ts: "2026-11-01T09:02:00.000Z", session: "fresh", type: "fail", key: "npm test", cmd: "npm test", exit: 1, out: "" },
      { id: "5", ts: "2026-11-01T09:03:00.000Z", session: "fresh", type: "skill", skill: "no-such-skill" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const repo = repoWith(skills, {
      ".claude/hermod/usage/2026-10-15-covered.json": usageFile("2026-10-15", "covered", { "deploy-steps": { uses: 1, views: 0 } }),
      ".claude/hermod/.local/ledger.jsonl": `${ledger}\nnot json\n`,
    });
    const rep = report(repo, "2026-11-05");
    expect(rep.usage.ledgerSkipped).toBe(1);
    expect(rep.usage.ledgerEvents).toBe(3);
    expect(row(rep, "deploy-steps").uses).toBe(1);
    const p = row(rep, "photo-resize");
    expect(p.uses).toBe(1);
    expect(p.views).toBe(1);
    expect(p.sessions).toBe(1);
    expect(p.lastUsed).toBe("2026-11-01");
    expect(rep.usage.unknownSkills).toEqual(["no-such-skill"]);
  });

  it("skips broken or hostile usage files and says so", () => {
    const repo = repoWith(skills, {
      ".claude/hermod/usage/2026-10-30-good.json": usageFile("2026-10-30", "g", { "deploy-steps": { uses: 1 } }),
      ".claude/hermod/usage/2026-10-31-broken.json": "{ not json",
      ".claude/hermod/usage/2026-10-31-negative.json": usageFile("2026-10-31", "n", { "deploy-steps": { uses: -4 } }),
      ".claude/hermod/usage/2026-10-31-huge.json": usageFile("2026-10-31", "h", { "deploy-steps": { uses: 1e12 } }),
      ".claude/hermod/usage/2026-10-31-text.json": usageFile("2026-10-31", "t", { "deploy-steps": { uses: "9" } }),
      ".claude/hermod/usage/2026-10-31-list.json": "[1, 2]",
      ".claude/hermod/usage/2026-13-45-baddate.json": JSON.stringify({ session: "b", date: "2026-13-45", skills: {} }),
      ".claude/hermod/usage/2026-11-04-proto.json": '{"session":"p","date":"2026-11-04","skills":{"__proto__":{"uses":3}}}',
      ".claude/hermod/usage/notes.txt": "ignored",
    });
    const rep = report(repo, "2026-11-05");
    expect(rep.usage.files).toBe(2);
    expect(rep.usage.invalidFiles).toHaveLength(6);
    expect(rep.usage.invalidFiles).toContain(".claude/hermod/usage/2026-10-31-broken.json");
    const d = row(rep, "deploy-steps");
    expect(d.uses).toBe(1);
    expect(d.lastUsed).toBe("2026-10-30");
    expect(rep.usage.unknownSkills).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).uses).toBeUndefined();
    const md = run(repo, "--now", "2026-11-05").stdout;
    expect(md).toContain("Skipped 6 unreadable usage files");
  });

  it("takes the date from the file name when the file has none", () => {
    const parsed = usageLib.parseUsageFile({ session: "x", skills: { a: { uses: 1 } } }, "2026-10-02-x.json");
    expect(parsed.date).toBe("2026-10-02");
    expect(usageLib.parseUsageFile({ skills: {} }, "nodate.json")).toBeNull();
  });

  it("date helpers", () => {
    expect(usageLib.isDate("2026-02-29")).toBe(false);
    expect(usageLib.isDate("2028-02-29")).toBe(true);
    expect(usageLib.isDate("2026-1-01")).toBe(false);
    expect(usageLib.daysBetween("2026-10-25", "2026-11-05")).toBe(11);
    // Across a daylight-saving change the count stays whole.
    expect(usageLib.daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(usageLib.laterDate(null, "2026-01-01")).toBe("2026-01-01");
    expect(usageLib.laterDate("2026-02-01", "2026-01-01")).toBe("2026-02-01");
  });
});

// ------------------------------------------------------------------------------------- overlap, size

describe("overlap", () => {
  const nearCopy = skillFile(
    "deploy-release",
    "Deploy the web service to production. Use when shipping a release.",
    "# Deploy\n\n1. Build the container image with the pinned toolchain.\n2. Push the image to the registry.\n3. Run the database migrations against staging first.\n4. Promote the staging deployment after the smoke tests pass.\n5. Watch the error dashboard for twenty minutes.\n",
  );

  it("finds a near-copy and nothing between unrelated skills", () => {
    const repo = repoWith([{ day: "2026-11-01", files: { ...DEPLOY, ...nearCopy, ...PHOTOS } }]);
    const rep = report(repo, "2026-11-05");
    expect(rep.overlaps).toHaveLength(1);
    expect(rep.overlaps[0]).toMatchObject({ a: "deploy-release", b: "deploy-steps" });
    expect(rep.overlaps[0]?.similarity).toBeGreaterThan(0.85);
    expect(rep.overlaps[0]?.similarity).toBeLessThan(1);
    const merge = rep.actions.filter((a) => a.kind === "merge-skills");
    expect(merge).toHaveLength(1);
    expect(merge[0]?.text).toMatch(/similarity 0\.9\d \(threshold 0\.55\)/);
    const md = run(repo, "--now", "2026-11-05").stdout;
    expect(md).toMatch(/- deploy-release and deploy-steps: similarity 0\.\d\d → consider merging/);
  });

  it("respects overlapThreshold", () => {
    const repo = repoWith([{ day: "2026-11-01", files: { ...DEPLOY, ...nearCopy } }], config({ overlapThreshold: 1 }));
    expect(report(repo, "2026-11-05").overlaps).toEqual([]);
  });

  it("jaccard and containment", () => {
    const s = (...t: string[]) => new Set(t);
    expect(curator.jaccard(s("a", "b"), s("b", "c"))).toBeCloseTo(1 / 3);
    expect(curator.jaccard(s(), s())).toBe(0);
    expect(curator.containment(s("a", "b"), s("a", "b", "c", "d"))).toBe(1);
    expect(curator.containment(s("a", "b", "x", "y"), s("a", "b", "c"))).toBe(0.5);
    expect(curator.containment(s(), s("a"))).toBe(0);
  });
});

describe("too long", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1}.`).join("\n");

  it("by lines: over maxSkillLines, not at it", () => {
    // The body is a blank line, then the lines, as skillFile writes it (so lines(19) gives 20 body lines).
    const repo = repoWith(
      [{ day: "2026-11-01", files: { ...skillFile("at-limit", "Exactly at the limit.", lines(19)), ...skillFile("over-limit", "One line over.", lines(20)) } }],
      config({ maxSkillLines: 20 }),
    );
    const rep = report(repo, "2026-11-05");
    expect(row(rep, "at-limit").lines).toBe(20);
    expect(row(rep, "over-limit").lines).toBe(21);
    expect(rep.tooLong.map((t) => t.name)).toEqual(["over-limit"]);
    expect(rep.tooLong[0]).toMatchObject({ overLines: true, overChars: false });
    const action = rep.actions.find((a) => a.kind === "shorten-skill");
    expect(action?.text).toBe("Move detail of skill over-limit into references/: 21 lines (max 20).");
  });

  it("by chars: over maxSkillChars, not at it", () => {
    const head = (name: string) => `---\nname: ${name}\ndescription: Long text.\n---\n\n`;
    const exact = head("exact");
    const over = head("over");
    const repo = repoWith(
      [
        {
          day: "2026-11-01",
          files: {
            ".claude/skills/exact/SKILL.md": exact + "x".repeat(1000 - exact.length),
            ".claude/skills/over/SKILL.md": over + "y".repeat(1001 - over.length),
          },
        },
      ],
      config({ maxSkillChars: 1000 }),
    );
    const rep = report(repo, "2026-11-05");
    expect(row(rep, "exact").chars).toBe(1000);
    expect(row(rep, "over").chars).toBe(1001);
    expect(rep.tooLong).toEqual([{ name: "over", lines: 2, chars: 1001, overLines: false, overChars: true }]);
    expect(rep.actions.find((a) => a.kind === "shorten-skill")?.text).toBe("Move detail of skill over into references/: 1,001 chars (max 1,000).");
  });
});

// ------------------------------------------------------------------------------------------ lessons

describe("lessons", () => {
  const releaseSkill = skillFile(
    "release-notes",
    "Write the release notes. Use when preparing a release.",
    "The release script builds the changelog from merged pull requests and tags the version.\nReviewers check the wording before publishing.\n",
  );

  it("finds near-duplicate lessons and leaves distinct ones alone", () => {
    const repo = repoWith([{ day: "2026-11-01", files: PHOTOS }], {
      ".claude/hermod/LESSONS.md": lessonsText(
        "The staging database resets every night at midnight, so test data disappears.",
        "Invoices are generated on the first weekday of each month.",
        "The staging database resets every night at midnight, so test data is lost.",
      ),
    });
    const rep = report(repo, "2026-11-05");
    expect(rep.lessons.entries).toBe(3);
    expect(rep.lessons.duplicates).toHaveLength(1);
    expect(rep.lessons.duplicates[0]).toMatchObject({ a: 1, b: 3 });
    expect(rep.lessons.duplicates[0]?.similarity).toBeGreaterThanOrEqual(0.6);
    expect(rep.actions.find((a) => a.kind === "merge-lessons")?.text).toMatch(/^Merge lessons 1 and 3: similarity 0\.\d\d \(threshold 0\.60\)\.$/);
    expect(rep.lessons.restates).toEqual([]);
    const md = run(repo, "--now", "2026-11-05").stdout;
    expect(md).toContain('Lessons 1 and 3 are near-duplicates');
    expect(md).toContain('"The staging database resets every night at midnight, so test data disappears."');
  });

  it("finds a lesson that restates a skill", () => {
    const repo = repoWith([{ day: "2026-11-01", files: { ...releaseSkill, ...PHOTOS } }], {
      ".claude/hermod/LESSONS.md": lessonsText(
        "The release script builds the changelog from merged pull requests.",
        "The release script needs a clean working tree and a signed tag from the maintainer.",
        "Short fact.",
      ),
    });
    const rep = report(repo, "2026-11-05");
    expect(rep.lessons.restates).toHaveLength(1);
    expect(rep.lessons.restates[0]).toMatchObject({ lesson: 1, skill: "release-notes", share: 1, kit: false });
    expect(rep.actions.find((a) => a.kind === "fold-lesson")?.text).toBe(
      "Fold lesson 1 into skill release-notes: 100% of its words are in the skill (threshold 80%).",
    );
  });

  it("restating needs 80% of the lesson's words, not less", () => {
    // 5 distinct tokens, 4 in the skill = exactly 80%; 5 of which 3 = 60%.
    const skill = skillFile("words", "Alpha bravo.", "alpha bravo charlie delta");
    const repo = repoWith([{ day: "2026-11-01", files: skill }], {
      ".claude/hermod/LESSONS.md": lessonsText("alpha bravo charlie delta zulu", "alpha bravo charlie yankee zulu"),
    });
    const rep = report(repo, "2026-11-05");
    expect(rep.lessons.restates.map((r) => r.lesson)).toEqual([1]);
    expect(rep.lessons.restates[0]?.share).toBe(0.8);
  });

  it("reports cap use and suggests making room near the cap", () => {
    const entry = "a".repeat(300);
    const full = lessonsText(...Array.from({ length: 12 }, (_, i) => `${entry}${i}`));
    const repo = repoWith([], { ".claude/hermod/LESSONS.md": full });
    const rep = report(repo, "2026-11-05");
    expect(rep.lessons.cap).toBe(4000);
    expect(rep.lessons.chars).toBeGreaterThan(3600);
    expect(rep.lessons.percent).toBeCloseTo(rep.lessons.chars / 4000);
    expect(rep.actions.some((a) => a.kind === "trim-lessons")).toBe(true);
    const small = repoWith([], { ".claude/hermod/LESSONS.md": lessonsText("One fact.") });
    expect(report(small, "2026-11-05").actions.some((a) => a.kind === "trim-lessons")).toBe(false);
  });

  it("a missing lessons file is one line, not an error", () => {
    const repo = repoWith([]);
    const r = run(repo, "--now", "2026-11-05");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(".claude/hermod/LESSONS.md not found");
  });
});

// ------------------------------------------------------------------------------------------- output

describe("the markdown report", () => {
  it("has every section, the table, numbered actions and the footer", () => {
    const repo = repoWith([{ day: "2026-09-01", files: { ...DEPLOY, ...PHOTOS } }], {
      ".claude/hermod/LESSONS.md": lessonsText("One fact."),
    });
    const r = run(repo, "--now", "2026-11-05");
    expect(r.code, r.stderr).toBe(0);
    const md = r.stdout;
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## Summary", "## Skills", "## Overlaps", "## Too long", "## Lessons", "## Suggested actions"]);
    expect(md.startsWith("# Hermod curator report (2026-11-05)\n")).toBe(true);
    expect(md).toContain("| deploy-steps | archive-candidate | 0 | 0 | never | 2026-09-01 | 65 |");
    expect(md).toContain("1. Archive skill deploy-steps: 65 days without use");
    expect(md).toContain("2. Archive skill photo-resize:");
    expect(md.trimEnd().endsWith(FOOTER)).toBe(true);
  });

  it("escapes table-breaking characters in skill folder names", () => {
    const repo = repoWith([{ day: "2026-11-01", files: skillFile("odd|name", "Odd.", "Body `code`.") }]);
    const md = run(repo, "--now", "2026-11-05").stdout;
    expect(md).toContain("| odd\\|name | active |");
  });

  it("an empty skill folder is listed as invalid and left out of the rest", () => {
    const repo = repoWith([]);
    mkdirSync(repo.abs(".claude/skills/empty"), { recursive: true });
    const rep = report(repo, "2026-11-05");
    expect(row(rep, "empty").status).toBe("invalid");
    expect(rep.actions).toEqual([]);
  });

  it("reports an invalid config and uses the defaults", () => {
    const repo = repoWith([{ day: "2026-10-01", files: DEPLOY }], { ".claude/hermod/config.json": "{ nope" });
    const rep = report(repo, "2026-10-15");
    expect(rep.configErrors.length).toBe(1);
    expect(row(rep, "deploy-steps").status).toBe("stale");
  });
});

// --------------------------------------------------------------------------------------- read only

describe("read only", () => {
  function busyRepo(): Repo {
    return repoWith([{ day: "2026-09-01", files: { ...DEPLOY, ...PHOTOS } }], {
      ".claude/hermod/LESSONS.md": lessonsText("The staging database resets every night.", "The staging database resets every night at midnight."),
      ".claude/hermod/usage/2026-10-01-x.json": usageFile("2026-10-01", "x", { "deploy-steps": { uses: 1 } }),
      ".claude/hermod/.local/ledger.jsonl": `${JSON.stringify({ ts: "2026-10-02T00:00:00Z", session: "y", type: "skill", skill: "photo-resize" })}\n`,
      ".claude/hermod/config.json": JSON.stringify({ version: 1, curator: { pinned: ["photo-resize"] } }),
    });
  }

  it("never changes a file, the .git folder included", () => {
    const repo = busyRepo();
    const outside = path.join(tempDir("hermod-curator-out-"), "report.md");
    const before = snapshot(repo.root);
    for (const args of [[], ["--json"], ["--now", "2026-11-05"], ["--help"], ["--bogus"], ["--out", outside], ["--out", "docs/report.md"]]) {
      run(repo, ...args);
    }
    expect(snapshot(repo.root)).toEqual(before);
    expect(repo.read("docs/report.md")).toBeNull();
  });

  it("--out writes only under .claude/hermod/.local/ inside the repository", () => {
    const repo = busyRepo();
    const before = snapshot(repo.root, (rel) => !rel.startsWith(".claude/hermod/.local"));
    const r = run(repo, "--now", "2026-11-05", "--out", ".claude/hermod/.local/curator-report.md");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Wrote .claude/hermod/.local/curator-report.md");
    expect(r.stdout).toContain(FOOTER);
    const text = repo.read(".claude/hermod/.local/curator-report.md") ?? "";
    expect(text).toContain("## Suggested actions");
    expect(text.trimEnd().endsWith(FOOTER)).toBe(true);
    expect(snapshot(repo.root, (rel) => !rel.startsWith(".claude/hermod/.local"))).toEqual(before);
    expect(repo.read(".claude/hermod/.local/.gitignore")).toBe("*\n");

    const j = run(repo, "--json", "--now", "2026-11-05", "--out", ".claude/hermod/.local/r.json");
    expect(j.code, j.stderr).toBe(0);
    expect(JSON.parse(repo.read(".claude/hermod/.local/r.json") ?? "").date).toBe("2026-11-05");
  });

  it("--out refuses repository files, relative paths that leave the repository, and symlinks out of .local", () => {
    const repo = busyRepo();
    for (const out of ["docs/report.md", "README.md", ".claude/hermod/LESSONS.md", "../escape.md", ".claude/hermod/.local"]) {
      const r = run(repo, "--out", out);
      expect(r.code, out).toBe(1);
      expect(r.stdout, out).toBe("");
    }
    expect(repo.read(".claude/hermod/LESSONS.md")).toContain("staging database");
    expect(repo.exists("../escape.md")).toBe(false);

    const elsewhere = tempDir("hermod-curator-link-");
    mkdirSync(repo.abs(".claude/hermod/.local"), { recursive: true });
    symlinkSync(elsewhere, repo.abs(".claude/hermod/.local/link"));
    const r = run(repo, "--out", ".claude/hermod/.local/link/report.md");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("leads outside");
  });

  it("--out with an absolute path outside the repository is allowed", () => {
    const repo = busyRepo();
    const file = path.join(tempDir("hermod-curator-abs-"), "report.md");
    const r = run(repo, "--now", "2026-11-05", "--out", file);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Wrote ${file}`);
  });

  it("rejects bad arguments with exit 2", () => {
    const repo = busyRepo();
    expect(run(repo, "--now", "2026-02-30").code).toBe(2);
    expect(run(repo, "--now", "yesterday").code).toBe(2);
    expect(run(repo, "extra").code).toBe(2);
    expect(run(repo, "--bogus").code).toBe(2);
    const h = run(repo, "--help");
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("Usage: node .claude/hermod/curator.mjs");
  });

  it("finds the root from --root when run elsewhere", () => {
    const repo = busyRepo();
    const r = runNode(repo.kitPath("curator.mjs"), { cwd: tempDir(), args: ["--root", repo.root, "--json", "--now", "2026-11-05"] });
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as Report).skills.map((s) => s.name)).toEqual(["deploy-steps", "photo-resize"]);
  });
});
