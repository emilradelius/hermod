// Helpers for the kit's library tests (test/kit/lib-*.test.ts, test/kit/validate.test.ts).
// Owned by the kit-lib-tests agent. The shared helpers (makeRepo, runNode, runHook, cleanup) are in helpers.ts.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { KIT_FILES } from "./helpers.js";

/** The kit's .claude/hermod folder inside this checkout. */
export const KIT_HERMOD = path.join(KIT_FILES, ".claude", "hermod");

/**
 * A kit module, loosely typed. The kit is plain JavaScript with JSDoc types that the TypeScript project for the
 * tests does not read, so the tests call its exports through this type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type KitModule = Record<string, any>;

/** Imports kit/files/.claude/hermod/lib/<name>.mjs (name without ".mjs"). */
export async function loadLib(name: string): Promise<KitModule> {
  return (await import(pathToFileURL(path.join(KIT_HERMOD, "lib", `${name}.mjs`)).href)) as KitModule;
}

/** Imports kit/files/.claude/hermod/<rel> (for example "validate.mjs"). */
export async function loadKit(rel: string): Promise<KitModule> {
  return (await import(pathToFileURL(path.join(KIT_HERMOD, ...rel.split("/"))).href)) as KitModule;
}

/** A writable stream stand-in that collects what is written. */
export function collector(): { stream: NodeJS.WritableStream; text: () => string } {
  let out = "";
  const stream = {
    write(chunk: string | Uint8Array, cb?: unknown) {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (typeof cb === "function") (cb as () => void)();
      return true;
    },
    on() {
      return stream;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, text: () => out };
}

/** True when every grapheme of `part` is a whole grapheme of `whole`'s prefix (no cluster split at the end). */
export function isGraphemePrefix(whole: string, part: string): boolean {
  if (!whole.startsWith(part)) return false;
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
  let pos = 0;
  for (const { segment } of seg.segment(whole)) {
    if (pos === part.length) return true;
    if (pos > part.length) return false;
    pos += segment.length;
  }
  return pos === part.length;
}

/** True when `part` is a suffix of `whole` that starts at a grapheme boundary. */
export function isGraphemeSuffix(whole: string, part: string): boolean {
  if (!whole.endsWith(part)) return false;
  const start = whole.length - part.length;
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
  for (const { index } of seg.segment(whole)) {
    if (index === start) return true;
    if (index > start) return false;
  }
  return start === whole.length;
}
