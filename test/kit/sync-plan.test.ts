// The sync's planning half on its own: kitFromEntries, planSync and planWrites. The Hermod Control Room uses them to
// propose a sync as a pull request, reading the kit and the target through GitHub's API instead of git and a folder.
// These tests read the fixture kit and the target the way the Control Room does (tree entries and blobs, an
// in-memory target) and check that the planned writes are exactly what the real script applies.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TARGET_FILES, SYNC_SCRIPT, Sandbox, kitV1, kitV2, listFiles, writeKit } from "./sync-helpers.js";

type Entry = { mode: string; type: string; oid: string; path: string };
type TargetState = { kind: "missing" } | { kind: "file"; data: Buffer } | { kind: "other"; reason: string } | { kind: "blocked"; reason: string };
type Kit = { version: string; files: Map<string, Buffer>; seeds: Map<string, Buffer>; hooks: Record<string, unknown[]>; skills: { core: string[]; optional: string[] } };
type Write = { path: string; data: Buffer | null; seed: boolean };
type Plan = { files: unknown; settings: unknown; stamp: unknown; warnings: string[] };

interface SyncModule {
  kitFromEntries(entries: Entry[], read: (entry: Entry) => Buffer, at: string, source: string): Kit;
  readKitAt(sourceDir: string, commit: string, ref: string): Kit;
  parseLsTree(output: Buffer): Entry[];
  planSync(input: { kit: Kit; ref: string; commit: string; inspect: (rel: string) => TargetState; skills: undefined | "none" | "all" | string[]; force: boolean }, now?: Date): Plan;
  planWrites(kit: Kit, files: unknown, settings: unknown, stamp: unknown): Write[];
}

let sync: SyncModule;
let sandbox: Sandbox;
let source: { dir: string; v1: string; v2: string };

beforeAll(async () => {
  sync = (await import(pathToFileURL(SYNC_SCRIPT).href)) as SyncModule;
  sandbox = new Sandbox();
  const dir = sandbox.dir("hermod");
  sandbox.initRepo(dir);
  writeKit(dir, kitV1());
  const v1 = sandbox.commitAll(dir, "kit 0.1.0");
  writeKit(dir, kitV2());
  const v2 = sandbox.commitAll(dir, "kit 0.2.0");
  source = { dir, v1, v2 };
});

afterAll(() => {
  sandbox.cleanup();
});

/** The kit at a commit, read like the Control Room reads it: the tree's entries, then each blob by its id. */
function remoteKit(commit: string, read?: (entry: Entry, data: Buffer) => Buffer): Kit {
  const listed = spawnSync("git", ["ls-tree", "-r", "-z", "--full-tree", commit, "--", "kit"], { cwd: source.dir, env: sandbox.env });
  const blob = (entry: Entry) => {
    const data = spawnSync("git", ["cat-file", "blob", entry.oid], { cwd: source.dir, env: sandbox.env }).stdout;
    return read ? read(entry, data) : data;
  };
  return sync.kitFromEntries(sync.parseLsTree(listed.stdout), blob, `${commit.slice(0, 12)}`, "the fixture");
}

/** A target held in memory, path -> bytes, answered like a folder (missing, a file, a folder, or below a file). */
function memoryInspect(files: Map<string, Buffer>): (rel: string) => TargetState {
  return (rel) => {
    const data = files.get(rel);
    if (data) return { kind: "file", data };
    if ([...files.keys()].some((p) => p.startsWith(`${rel}/`))) return { kind: "other", reason: "is a folder, not a file" };
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      if (files.has(parts.slice(0, i).join("/"))) return { kind: "blocked", reason: `is inside ${parts.slice(0, i).join("/")}, which is a file, not a folder` };
    }
    return { kind: "missing" };
  };
}

/** Every file under the target's .claude/, path -> bytes. */
function claudeFiles(target: string): Map<string, Buffer> {
  return new Map(listFiles(target, ".claude").map((rel) => [rel, readFileSync(path.join(target, ...rel.split("/")))]));
}

/** The files after applying planned writes to a copy of `before`. */
function applied(before: Map<string, Buffer>, writes: Write[]): Map<string, Buffer> {
  const after = new Map(before);
  for (const w of writes) {
    if (w.data === null) after.delete(w.path);
    else if (!(w.seed && after.has(w.path))) after.set(w.path, w.data);
  }
  return after;
}

/** The stamp's text without its time, which differs between two runs. */
function withoutTime(files: Map<string, Buffer>): Map<string, string> {
  return new Map(
    [...files].map(([rel, data]) => {
      if (rel !== ".claude/hermod/VERSION.json") return [rel, data.toString("base64")];
      const stamp = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      delete stamp.syncedAt;
      return [rel, JSON.stringify(stamp)];
    }),
  );
}

function runSync(target: string, ref: string): void {
  const run = spawnSync(process.execPath, [SYNC_SCRIPT, "--source", source.dir, "--target", target, "--ref", ref], { env: sandbox.env, encoding: "utf8" });
  expect(run.status, run.stdout + run.stderr).toBe(0);
}

describe("sync, planned from data", () => {
  it("reads the same kit from tree entries and blobs as from the local repository", () => {
    expect(remoteKit(source.v1)).toEqual(sync.readKitAt(source.dir, source.v1, source.v1));
    expect(remoteKit(source.v2)).toEqual(sync.readKitAt(source.dir, source.v2, source.v2));
  });

  it("refuses bytes that do not hash to the entry's object id", () => {
    const tampered = (entry: Entry, data: Buffer) => (entry.path.endsWith("VERSION") ? Buffer.from("9.9.9\n") : data);
    expect(() => remoteKit(source.v1, tampered)).toThrow(/do not hash to its object id/);
  });

  it("plans exactly what the real script writes, on a first install and on an upgrade", () => {
    for (const [from, to] of [[null, source.v1], [source.v1, source.v2]] as const) {
      const target = sandbox.makeTarget(DEFAULT_TARGET_FILES);
      if (from) {
        runSync(target, from);
        sandbox.commitAll(target, `sync ${from}`);
      }
      const before = claudeFiles(target);
      const kit = remoteKit(to);
      const plan = sync.planSync({ kit, ref: to, commit: to, inspect: memoryInspect(before), skills: undefined, force: false });
      const writes = sync.planWrites(kit, plan.files, plan.settings, plan.stamp);
      expect(writes.length).toBeGreaterThan(0);
      if (from) expect(writes.some((w) => w.data === null)).toBe(true); // the upgrade deletes what the kit dropped

      runSync(target, to);
      expect(withoutTime(applied(before, writes))).toEqual(withoutTime(claudeFiles(target)));
    }
  });

  it("skips folder entries, as GitHub's recursive tree lists them", () => {
    const listed = spawnSync("git", ["ls-tree", "-r", "-t", "-z", "--full-tree", source.v2, "--", "kit"], { cwd: source.dir, env: sandbox.env });
    const entries = sync.parseLsTree(listed.stdout);
    expect(entries.some((e) => e.type === "tree")).toBe(true);
    const read = (e: Entry) => spawnSync("git", ["cat-file", "blob", e.oid], { cwd: source.dir, env: sandbox.env }).stdout;
    expect(sync.kitFromEntries(entries, read, "v2", "the fixture")).toEqual(remoteKit(source.v2));
  });

  it("checks the ref and commit it records, and never writes a plan with conflicts", () => {
    const kit = remoteKit(source.v2);
    const plan = (ref: string, commit: string) => () => sync.planSync({ kit, ref, commit, inspect: memoryInspect(new Map()), skills: undefined, force: false });
    expect(plan("main", source.v2.slice(0, 7))).toThrow(/full sha/);
    expect(plan(source.v2.slice(0, 12), source.v2)).toThrow(/full commit sha or a tag/);
    expect(plan("../x", source.v2)).toThrow(/full commit sha or a tag/);
    expect(plan("v0.2.0", source.v2)).not.toThrow();
    expect(plan(source.v2, source.v2)).not.toThrow();

    // A kit file changed in the target: the plan has a conflict, and planWrites refuses it.
    const target = sandbox.makeTarget(DEFAULT_TARGET_FILES);
    runSync(target, source.v1);
    const files = claudeFiles(target);
    const changed = [...files.keys()].find((p) => p.startsWith(".claude/skills/reflect/"))!;
    files.set(changed, Buffer.from("changed here\n"));
    const conflicted = sync.planSync({ kit, ref: source.v2, commit: source.v2, inspect: memoryInspect(files), skills: undefined, force: false });
    expect((conflicted.files as { conflict: unknown[] }).conflict.length).toBeGreaterThan(0);
    expect(() => sync.planWrites(kit, conflicted.files, conflicted.settings, conflicted.stamp)).toThrow(/nothing may be written/);
  });

  it("plans nothing for a target that is already at the release", () => {
    const target = sandbox.makeTarget(DEFAULT_TARGET_FILES);
    runSync(target, source.v2);
    const kit = remoteKit(source.v2);
    const plan = sync.planSync({ kit, ref: source.v2, commit: source.v2, inspect: memoryInspect(claudeFiles(target)), skills: undefined, force: false });
    expect(sync.planWrites(kit, plan.files, plan.settings, plan.stamp)).toEqual([]);
  });
});
