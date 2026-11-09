// Tests for the recall search engine (kit/files/.claude/hermod/lib/bm25.mjs): tokenizer, BM25 ranking, prefix
// fallback, deterministic order and snippets.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { KIT_FILES } from "./helpers.js";

interface Doc {
  text: string;
  title?: string;
  path?: string;
  line?: number;
}
interface QueryTerm {
  term: string;
  match: "exact" | "prefix" | "none";
  terms: string[];
}
interface Hit<D> {
  doc: D;
  index: number;
  score: number;
  matched: string[];
}
interface Index<D> {
  docs: D[];
  vocabulary: string[];
  avgLength: number;
}
interface Bm25Module {
  STOPWORDS: Set<string>;
  TITLE_WEIGHT: number;
  MIN_PREFIX_CHARS: number;
  fold(text: string): string;
  tokenize(text: string): string[];
  buildIndex<D extends Doc>(docs: D[]): Index<D>;
  queryTerms(index: Index<Doc>, query: string): QueryTerm[];
  search<D extends Doc>(index: Index<D>, query: string, options?: { limit?: number }): { hits: Hit<D>[]; total: number; terms: QueryTerm[] };
  snippet(text: string, terms: Iterable<string>, maxChars?: number): { text: string; anchor: number };
}

let M: Bm25Module;
beforeAll(async () => {
  M = (await import(pathToFileURL(path.join(KIT_FILES, ".claude", "hermod", "lib", "bm25.mjs")).href)) as Bm25Module;
});

const top = (docs: Doc[], query: string) => M.search(M.buildIndex(docs), query, { limit: 0 }).hits;

describe("fold", () => {
  it("removes Swedish and other diacritics, keeps case", () => {
    expect(M.fold("Rätta åtgärd ÖVER")).toBe("Ratta atgard OVER");
    // Decomposed input (a + combining diaeresis) folds the same way.
    expect(M.fold("rätta")).toBe("ratta");
    expect(M.fold("Straße Æble smørrebrød Łódź")).toBe("Strasse AEble smorrebrod Lodz");
  });
});

describe("tokenize", () => {
  it("lowercases and folds", () => {
    expect(M.tokenize("Rätta RÄTTA rätta")).toEqual(["ratta", "ratta", "ratta"]);
  });

  it("keeps snake_case words whole and adds their parts", () => {
    expect(M.tokenize("MAX_RETRIES")).toEqual(["max_retries", "max", "retries"]);
    expect(M.tokenize("__init_db__")).toEqual(["init_db", "init", "db"]);
  });

  it("splits camelCase and acronyms, keeping the whole word too", () => {
    expect(M.tokenize("fetchUser")).toEqual(["fetchuser", "fetch", "user"]);
    expect(M.tokenize("XMLHttpRequest")).toEqual(["xmlhttprequest", "xml", "http", "request"]);
    expect(M.tokenize("getUserID2fa")).toEqual(["getuserid2fa", "get", "user", "id", "fa"]);
  });

  it("drops English and Swedish stopwords and one-character tokens", () => {
    expect(M.tokenize("The cache and the version")).toEqual(["cache", "version"]);
    expect(M.tokenize("Det är inte så att vi och de")).toEqual(["inte"]);
    expect(M.tokenize("a b c x 1 2")).toEqual([]);
    for (const w of ["the", "and", "och", "att", "som", "pa", "ar"]) expect(M.STOPWORDS.has(w)).toBe(true);
  });

  it("never drops project words that look like stopwords in the other language", () => {
    // "under" is a stopword in neither list on purpose: it is a content word in English and Swedish alike.
    expect(M.tokenize("deploy under load")).toEqual(["deploy", "under", "load"]);
  });

  it("splits on punctuation, keeps digits", () => {
    expect(M.tokenize("sw.js v2-release 0042_add-notes")).toEqual([
      "sw",
      "js",
      "v2",
      "release",
      "0042_add",
      "0042",
      "add",
      "notes",
    ]);
  });

  it("handles empty, null and huge-token input", () => {
    expect(M.tokenize("")).toEqual([]);
    expect(M.tokenize(null as unknown as string)).toEqual([]);
    expect(M.tokenize("x".repeat(500))).toEqual([]);
  });
});

describe("search", () => {
  it("finds rätta for ratta, Ratta and RÄTTA (both ways)", () => {
    const docs = [{ text: "Vi måste rätta felet i bokningen." }, { text: "Unrelated text about deployment." }];
    for (const q of ["ratta", "Ratta", "rätta", "RÄTTA"]) {
      const hits = top(docs, q);
      expect(hits.map((h) => h.index)).toEqual([0]);
      expect(hits[0]!.matched).toEqual(["ratta"]);
    }
    expect(top([{ text: "ratta utan prickar" }], "rätta").length).toBe(1);
  });

  it("finds MAX_RETRIES for 'max retries' and for 'MAX_RETRIES'", () => {
    const docs = [{ text: "Raise MAX_RETRIES in upload.js." }, { text: "Nothing here." }, { text: "The retries of the app." }];
    expect(top(docs, "max retries")[0]!.index).toBe(0);
    expect(top(docs, "MAX_RETRIES")[0]!.index).toBe(0);
    // The whole identifier and both parts are query terms: the exact identifier ranks first.
    expect(top(docs, "max_retries").map((h) => h.index)).toEqual([0, 2]);
    expect(top(docs, "max_retries")[0]!.matched).toEqual(["max", "max_retries", "retries"]);
  });

  it("finds camelCase fetchUser for 'fetch user'", () => {
    const docs = [{ text: "All calls go through fetchUser in lib." }, { text: "Fetch the team." }];
    const hits = top(docs, "fetch user");
    expect(hits[0]!.index).toBe(0);
    expect(hits[0]!.matched).toEqual(["fetch", "user"]);
  });

  it("ranks a heading (title) match above a passing mention", () => {
    const docs = [
      { text: "Long notes about many things. We touched the cache version once, among other topics like routing and auth.", title: "Session notes", path: "a.md" },
      { text: "Bump it on every change.", title: "Cache version", path: "b.md" },
    ];
    const hits = top(docs, "cache version");
    expect(hits.map((h) => h.doc.path)).toEqual(["b.md", "a.md"]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("counts title tokens double", () => {
    // Same text and length: a title occurrence must weigh exactly like two body occurrences.
    const a = top([{ text: "x1 x2", title: "deploy" }, { text: "filler words here" }], "deploy")[0]!;
    const b = top([{ text: "deploy deploy x1 x2" }, { text: "filler words here" }], "deploy")[0]!;
    expect(M.TITLE_WEIGHT).toBe(2);
    expect(a.score).toBeCloseTo(b.score, 10);
  });

  it("scores rarer terms higher (idf) and repeated terms higher (tf)", () => {
    const docs = [
      { text: "common rare", path: "1" },
      { text: "common", path: "2" },
      { text: "common", path: "3" },
      { text: "common common common", path: "4" },
    ];
    const hits = top(docs, "rare common");
    expect(hits[0]!.doc.path).toBe("1");
    const commonOnly = top(docs, "common").filter((h) => h.doc.path !== "1");
    expect(commonOnly[0]!.doc.path).toBe("4");
  });

  it("falls back to prefix matches for terms of 4+ characters with no exact match", () => {
    const docs = [{ text: "The deployment failed twice." }, { text: "Deployments are on Fridays." }, { text: "Nothing." }];
    const index = M.buildIndex(docs);
    const terms = M.queryTerms(index, "deploym");
    expect(terms).toEqual([{ term: "deploym", match: "prefix", terms: ["deployment", "deployments"] }]);
    expect(M.search(index, "deploym", { limit: 0 }).hits.map((h) => h.index).sort()).toEqual([0, 1]);
    // Diacritics fold in the prefix too: "rätt" finds "rättade".
    expect(top([{ text: "Felet rättades i går." }], "rätt").length).toBe(1);
  });

  it("does not use prefix matching for short terms or when an exact match exists", () => {
    const docs = [{ text: "deployment" }, { text: "dep" }, { text: "deploy" }];
    expect(M.queryTerms(M.buildIndex(docs), "dep")[0]!.match).toBe("exact");
    expect(top([{ text: "deployment" }], "dep")).toEqual([]);
    const exact = M.queryTerms(M.buildIndex(docs), "deploy");
    expect(exact[0]).toEqual({ term: "deploy", match: "exact", terms: ["deploy"] });
    expect(top(docs, "deploy").map((h) => h.index)).toEqual([2]);
    expect(M.MIN_PREFIX_CHARS).toBe(4);
    // 3 characters with no exact match: nothing.
    expect(top([{ text: "abcdef" }], "abc")).toEqual([]);
    expect(top([{ text: "abcdef" }], "abcd").length).toBe(1);
  });

  it("orders equal scores by path, then line, and is deterministic", () => {
    const docs = [
      { text: "same words here", path: "b.md", line: 1 },
      { text: "same words here", path: "a.md", line: 9 },
      { text: "same words here", path: "a.md", line: 2 },
    ];
    const order = top(docs, "words").map((h) => `${h.doc.path}:${h.doc.line}`);
    expect(order).toEqual(["a.md:2", "a.md:9", "b.md:1"]);
    expect(top([...docs].reverse(), "words").map((h) => `${h.doc.path}:${h.doc.line}`)).toEqual(order);
  });

  it("respects the limit and reports the total", () => {
    const docs = Array.from({ length: 20 }, (_, i) => ({ text: `entry ${i} about caching`, path: `f${String(i).padStart(2, "0")}` }));
    const r = M.search(M.buildIndex(docs), "caching", { limit: 3 });
    expect(r.hits.length).toBe(3);
    expect(r.total).toBe(20);
    expect(M.search(M.buildIndex(docs), "caching").hits.length).toBe(8);
  });

  it("returns nothing for an empty index, an empty query or stopword-only queries", () => {
    expect(M.search(M.buildIndex([]), "anything").hits).toEqual([]);
    const index = M.buildIndex([{ text: "the and och" }, { text: "content" }]);
    expect(M.search(index, "").hits).toEqual([]);
    const r = M.search(index, "the och");
    expect(r.hits).toEqual([]);
    expect(r.terms).toEqual([]);
    expect(M.search(index, "missingword").terms).toEqual([{ term: "missingword", match: "none", terms: [] }]);
  });
});

describe("snippet", () => {
  it("marks matched words with «»", () => {
    const s = M.snippet("We raise MAX_RETRIES after each upload.js change.", ["max", "retries"]);
    expect(s.text).toBe("We raise «MAX_RETRIES» after each upload.js change.");
  });

  it("marks words with diacritics and camelCase words whole", () => {
    expect(M.snippet("Vi ska rätta fetchUser nu.", ["ratta", "user"]).text).toBe("Vi ska «rätta» «fetchUser» nu.");
    // Decomposed letters stay inside the mark.
    expect(M.snippet("rätta", ["ratta"]).text).toBe("«rätta»");
  });

  it("stays near maxChars, centres on the best match and shows cuts with …", () => {
    const filler = "lorem ipsum dolor ".repeat(40);
    const text = `${filler}the cache version rule ${filler}`;
    const s = M.snippet(text, ["cache", "version"], 100);
    expect(s.text).toContain("«cache» «version»");
    expect(s.text.startsWith("…")).toBe(true);
    expect(s.text.endsWith("…")).toBe(true);
    expect(s.text.replace(/[«»]/g, "").length).toBeLessThanOrEqual(100 + 2);
    expect(text.slice(s.anchor, s.anchor + 5)).toBe("cache");
  });

  it("prefers the window with the most distinct matched terms", () => {
    const text = `cache alone here. ${"x ".repeat(200)} cache and version together.`;
    const s = M.snippet(text, ["cache", "version"], 80);
    expect(s.text).toContain("«cache» and «version»");
    expect(text.slice(s.anchor, s.anchor + 5)).toBe("cache");
    expect(s.anchor).toBeGreaterThan(100);
  });

  it("collapses whitespace and handles no matches and empty text", () => {
    expect(M.snippet("line one\r\n\r\n  line two", ["two"]).text).toBe("line one line «two»");
    expect(M.snippet("short text", []).text).toBe("short text");
    expect(M.snippet("", ["x"])).toEqual({ text: "", anchor: 0 });
  });

  it("never splits a surrogate pair", () => {
    const text = `${"😀".repeat(300)} cache ${"😀".repeat(300)}`;
    const s = M.snippet(text, ["cache"], 60);
    expect(/\p{Cs}/u.test(s.text)).toBe(false);
    expect(s.text).toContain("«cache»");
  });
});
