/**
 * Fake secrets for tests, built at runtime from fragments so that no secret-looking literal sits in this public
 * repository (and secret scanners stay quiet). None of these are real credentials.
 */

/** A deterministic mixed-case alphanumeric string of `n` characters. */
export function chars(n: number, seed = 7): string {
  const alphabet = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ";
  let out = "";
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[x % alphabet.length];
  }
  // Make sure the string has digits and both cases whatever the seed.
  return n >= 3 ? `a1B${out.slice(3)}` : out;
}

function upperDigits(n: number, seed = 3): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "";
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 69069 + 1) % 4294967296;
    out += alphabet[x % alphabet.length];
  }
  return out;
}

const b64url = (value: string): string => Buffer.from(value).toString("base64url");

export const fake = {
  anthropic: (): string => ["sk", "ant", "api03", chars(80, 11)].join("-"),
  openai: (): string => ["sk", "proj", chars(48, 12)].join("-"),
  openaiLegacy: (): string => ["sk", chars(48, 13)].join("-"),
  github: (prefix: "ghp" | "gho" | "ghu" | "ghs" | "ghr" = "ghp"): string => [prefix, chars(36, 14)].join("_"),
  githubPat: (): string => ["github", "pat", chars(22, 15), chars(59, 16)].join("_"),
  awsId: (kind: "AKIA" | "ASIA" = "AKIA"): string => kind + upperDigits(16),
  awsSecret: (): string => chars(30, 17) + "/" + chars(9, 18),
  slack: (): string => ["xox" + "b", "1234567890", "0987654321", chars(24, 19)].join("-"),
  stripe: (kind: "sk_live" | "rk_live" | "sk_test" = "sk_live"): string => [kind, chars(24, 20)].join("_"),
  google: (): string => "AI" + "za" + chars(35, 21).replace(/[^A-Za-z0-9_-]/g, "x"),
  jwt: (): string =>
    [b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })), b64url(JSON.stringify({ sub: "user-1", role: "service" })), chars(43, 22)].join("."),
  pem: (label = "PRIVATE KEY"): string =>
    [`-----${"BEGIN"} ${label}-----`, chars(64, 23), chars(64, 24), chars(20, 25), `-----${"END"} ${label}-----`].join("\n"),
  telegram: (): string => `${"123456789"}:${"AA" + chars(33, 26).replace(/[^A-Za-z0-9_-]/g, "x")}`,
  vapid: (): string => chars(43, 27),
  password: (): string => "Pw" + chars(14, 28),
  supabaseAccess: (): string => ["sbp", "0123456789abcdef0123456789abcdef01234567"].join("_"),
  gitlab: (): string => ["glpat", chars(20, 29)].join("-"),
  npm: (): string => ["npm", chars(36, 30)].join("_"),
};

/** A 40-hex git SHA, a UUID and other things that must survive redaction. */
export const keep = {
  sha: "3f2a9c1e5b7d4f6a8c0e2b4d6f8a0c2e4b6d8f0a",
  shortSha: "3f2a9c1",
  uuid: "123e4567-e89b-12d3-a456-426614174000",
  path: "/home/user/project/src/lib/token-store.ts",
};
