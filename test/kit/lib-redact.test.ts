// Tests for kit/files/.claude/hermod/lib/redact.mjs: every pattern family is redacted, ordinary text (git SHAs,
// UUIDs, paths) survives, redaction is idempotent and never throws.
// The sample secrets are fake and built from pieces at runtime, so secret scanners do not flag this file.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup } from "./helpers.js";
import { loadLib, type KitModule } from "./kit-lib-tests-helpers.js";

let rd: KitModule;
beforeAll(async () => {
  rd = await loadLib("redact");
});
afterAll(cleanup);

const r = (s: string, n: number) => s.repeat(n);
const mix = "Ab3Xy9Qz7Lm2";
const PEM_BEGIN = "-----BEGIN RSA " + "PRIVATE KEY-----";
const PEM_END = "-----END RSA " + "PRIVATE KEY-----";

/** One sample per pattern name: [text containing a secret, the secret part that must disappear]. */
const SAMPLES = {
  "private-key": [`${PEM_BEGIN}\nMIIEowIBAAKCAQEA${r("Qx9", 20)}\n${PEM_END}`, "MIIEowIBAAKCAQEA"],
  "url-credentials": ["postgres://admin:" + "S3cr3tPw0rd" + "@db.internal:5432/app", "S3cr3tPw0rd"],
  "anthropic-key": ["key sk-" + "ant-api03-" + r(mix, 4), r(mix, 4)],
  "openai-key": ["sk-" + "proj-" + r(mix, 3), r(mix, 3)],
  "github-token": ["gh" + "p_" + r("A1b2C3d4E5", 4), r("A1b2C3d4E5", 4)],
  "gitlab-token": ["gl" + "pat-" + r("x1Y2z3", 4), r("x1Y2z3", 4)],
  "aws-access-key-id": ["AK" + "IA" + "IOSFODNN7EXAMPLE", "IOSFODNN7EXAMPLE"],
  "aws-secret-access-key": ["aws_secret_access_key = " + "wJalrXUtnFEMI/K7MDENG/bPxRfiCY" + "EXAMPLEKEY", "wJalrXUtnFEMI"],
  "slack-token": ["xo" + "xb-" + "1234567890-" + r("aB3", 6), r("aB3", 6)],
  "slack-webhook": ["https://hooks.slack.com/services/" + "T0000/B0000/" + r("XyZ1", 6), r("XyZ1", 6)],
  "stripe-key": ["sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dc", "4eC39HqLyjWDarjtT1zdp7dc"],
  "google-api-key": ["AI" + "za" + "SyD" + r("a1B2c3D4", 4).slice(0, 32), "SyDa1B2c3D4"],
  "npm-token": ["np" + "m_" + r("a1B2c3", 6), r("a1B2c3", 6)],
  "huggingface-token": ["h" + "f_" + r("aBcD1234", 4), r("aBcD1234", 4)],
  "sendgrid-key": ["S" + "G." + r("aB1", 8) + "." + r("cD2", 10), r("cD2", 10)],
  "supabase-key": ["sb" + "p_" + r("0123456789abcdef", 3).slice(0, 40), "0123456789abcdef0123"],
  "telegram-bot-token": ["bot 123456789:" + "AAH" + r("x1Y2z", 7).slice(0, 32), r("x1Y2z", 6)],
  jwt: ["ey" + "JhbGciOiJIUzI1NiJ9.ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "dozjgNryP4J3jVmNHl0w5N"],
  "authorization-header": ["Authorization: Basic " + "dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
  "secret-header": ["X-Api-Key: " + "k3yV4lu3" + "Xq9", "k3yV4lu3Xq9"],
  "bearer-token": ["curl -H 'Bearer " + "abc123DEF456ghi789" + "'", "abc123DEF456ghi789"],
  "cli-secret-flag": ["mysql --password=" + "hunter2Secret", "hunter2Secret"],
  "cli-user-password": ["curl -u alice:" + "pa55w0rdX" + " https://x", "pa55w0rdX"],
  "secret-assignment": ["DB_PASSWORD=" + "correcthorse9", "correcthorse9"],
  "secret-json": ['{"dbPassword": "' + "zz9Top-Secret" + '"}', "zz9Top-Secret"],
  "secret-object": ["const c = { clientSecret: '" + "abcXYZ123secret" + "' }", "abcXYZ123secret"],
  "secret-yaml": ["database:\n  password: " + "Yaml5ecretValue" + "\n", "Yaml5ecretValue"],
  token: ["value " + "Zx8Kq2Lm9Np4Rt7Vw1Yb3Cd5Fg6Hj0Ks", "Zx8Kq2Lm9Np4Rt7Vw1Yb3Cd5Fg6Hj0Ks"],
  email: ["mail anna.svensson@example.se now", "anna.svensson@example.se"],
  personnummer: ["pnr 19121212-1212 here", "19121212-1212"],
} satisfies Record<string, [string, string]>;

const SHA = "3f2b8c1e0a9d4b7c6e5f4a3b2c1d0e9f8a7b6c5d";
const KEEP = [
  `commit ${SHA}`,
  `sha256 ${"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}`,
  "uuid 123e4567-e89b-12d3-a456-426614174000",
  "short abc1234 and 3f2b8c1",
  "path src/lib/redact.mjs and C:\\Users\\x\\file.ts and ./scripts/sync.mjs",
  "The token is refreshed every hour; the password rule is documented.",
  "Set API_KEY=$API_KEY in .env",
  "const token = process.env.GITHUB_TOKEN;",
  "git@github.com:org/repo.git",
  "logo@2x.png",
  "MyVeryLongIdentifierNameForTheConfigurationLoader",
  "node_modules/@anthropic-ai/sdk/package.json",
  "Exit code 1: npm run typecheck",
];

describe("redact", () => {
  it("has a sample for every pattern family", () => {
    const names = [...new Set(rd.REDACTION_PATTERNS.map((p: KitModule) => p.name))];
    expect(names.sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  for (const [name, [text, secret]] of Object.entries(SAMPLES)) {
    it(`redacts ${name}`, () => {
      const out = rd.redact(text);
      expect(out).toContain(`[REDACTED:${name}]`);
      expect(out).not.toContain(secret);
      // Also inside a longer text, next to things that must survive.
      const long = rd.redact(`before ${SHA}\n${text}\nafter src/app.ts`);
      expect(long).not.toContain(secret);
      expect(long).toContain(SHA);
      expect(long).toContain("src/app.ts");
    });
  }

  it("keeps git SHAs, hashes, UUIDs, paths and ordinary prose", () => {
    for (const text of KEEP) expect(rd.redact(text), text).toBe(text);
  });

  it("keeps the name in assignments and headers so the reader knows what it was", () => {
    expect(rd.redact("export DB_PASSWORD='" + "qwerty123x" + "'")).toBe("export DB_PASSWORD='[REDACTED:secret-assignment]'");
    expect(rd.redact("Authorization: Bearer " + r("aZ9", 8))).toMatch(/^Authorization: Bearer \[REDACTED:/);
  });

  it("is idempotent", () => {
    const all = Object.values(SAMPLES)
      .map(([t]) => t)
      .join("\n");
    const once = rd.redact(all);
    expect(rd.redact(once)).toBe(once);
    for (const [, [text]] of Object.entries(SAMPLES)) expect(rd.redact(rd.redact(text))).toBe(rd.redact(text));
  });

  it("can skip personal data, and applies extra patterns from config", () => {
    expect(rd.redact(SAMPLES.email[0], { pii: false })).toBe(SAMPLES.email[0]);
    expect(rd.redact("order ACME-123456 shipped", { extraPatterns: ["ACME-[0-9]{6}"] })).toBe("order [REDACTED:custom] shipped");
    expect(rd.redact("Code: SeCrEt-77", { extraPatterns: ["/secret-\\d+/i"] })).toBe("Code: [REDACTED:custom]");
    expect(rd.redact("x", { extraPatterns: ["(", "", "/x/g"] })).toBe("x");
  });

  it("never throws, and stays fast, on huge and binary-ish input", () => {
    expect(rd.redact(undefined)).toBe("");
    expect(rd.redact(42)).toBe("");
    expect(rd.redact("")).toBe("");
    const binary = Array.from({ length: 200_000 }, (_, i) => String.fromCharCode((i * 7919) % 65536)).join("");
    const big = `${"a".repeat(1_000_000)}=${"b".repeat(1_000_000)} ${"-".repeat(100_000)}BEGIN ${"=".repeat(100_000)}`;
    const pathological = `${"password=".repeat(20_000)} ${"x@".repeat(50_000)} ${"aB3".repeat(100_000)}`;
    const t = performance.now();
    for (const input of [binary, big, pathological, "\0\0\0".repeat(10_000)]) {
      expect(() => rd.redact(input)).not.toThrow();
      expect(typeof rd.redact(input)).toBe("string");
    }
    expect(performance.now() - t).toBeLessThan(10_000);
  });
});

describe("redactDeep", () => {
  it("redacts strings at any depth, keeps keys and other values", () => {
    const token = "gh" + "p_" + r("A1b2C3d4E5", 4);
    const out = rd.redactDeep({ [token]: 1, a: [token, { b: token, n: 3, f: false, z: null }] });
    expect(Object.keys(out)).toEqual([token, "a"]);
    expect(out.a[0]).toBe("[REDACTED:github-token]");
    expect(out.a[1]).toEqual({ b: "[REDACTED:github-token]", n: 3, f: false, z: null });
  });
});

describe("detectSecrets", () => {
  it("reports every secret family with a line, column and a masked excerpt that does not leak it", () => {
    for (const [name, [text, secret]] of Object.entries(SAMPLES)) {
      const found = rd.detectSecrets(`intro line\n${text}`);
      if (name === "email" || name === "personnummer") {
        expect(found, name).toEqual([]);
        continue;
      }
      expect(found.length, name).toBeGreaterThan(0);
      expect(found[0].line).toBeGreaterThanOrEqual(2);
      expect(found[0].column).toBeGreaterThanOrEqual(1);
      for (const f of found) expect(f.excerpt).not.toContain(secret.slice(0, 8));
    }
  });

  it("does not report placeholders, references and prose", () => {
    const prose = [
      ...KEEP,
      "password: <your password here>",
      "API_KEY=changeme",
      "token: ${{ secrets.TOKEN }}",
      "DB_PASSWORD=$DB_PASSWORD",
      'apiKey: "your-api-key-here"',
      "postgres://user:password@localhost:5432/db",
      "Use --password=$PGPASSWORD to pass it.",
      "Never commit the AWS secret access key.",
    ];
    for (const p of prose) expect(rd.detectSecrets(p), p).toEqual([]);
  });

  it("findings are sorted and never overlap", () => {
    const text = `${SAMPLES["github-token"][0]} and ${SAMPLES["secret-assignment"][0]} and ${SAMPLES.jwt[0]}`;
    const found = rd.detectSecrets(text);
    expect(found.length).toBe(3);
    for (let i = 1; i < found.length; i++) expect(found[i].index).toBeGreaterThanOrEqual(found[i - 1].index + found[i - 1].length);
  });
});

describe("helpers", () => {
  it("isSecretName", () => {
    for (const n of ["API_KEY", "dbPassword", "client-secret", "SSH_KEY", "GH_PAT", "SENTRY_DSN", "authToken"]) expect(rd.isSecretName(n), n).toBe(true);
    for (const n of ["KEYBOARD", "monkey", "PATH", "author", "passport", "KEY_COUNT", ""]) expect(rd.isSecretName(n), n).toBe(false);
  });

  it("isPersonnummer checks the date and the checksum", () => {
    expect(rd.isPersonnummer("19121212-1212")).toBe(true);
    expect(rd.isPersonnummer("121212-1212")).toBe(true);
    expect(rd.isPersonnummer("121212-1213")).toBe(false);
    expect(rd.isPersonnummer("20131312-1212")).toBe(false);
    expect(rd.isPersonnummer("12345")).toBe(false);
    expect(rd.redact("order 121212-1213")).toBe("order 121212-1213");
  });

  it("maskSecret shows only a public prefix and the length", () => {
    expect(rd.maskSecret("gh" + "p_" + r("A", 36))).toBe("ghp_… (40 chars)");
    expect(rd.maskSecret("plainsecret")).toBe("… (11 chars)");
  });

  it("looksLikeRandomToken spares hex hashes and words", () => {
    expect(rd.looksLikeRandomToken(SHA)).toBe(false);
    expect(rd.looksLikeRandomToken("MyVeryLongIdentifierNameForTheConfigurationLoader")).toBe(false);
    expect(rd.looksLikeRandomToken("Zx8Kq2Lm9Np4Rt7Vw1Yb3Cd5Fg6Hj0Ks")).toBe(true);
  });

  it("compileRedactPattern explains bad patterns", () => {
    expect(rd.compileRedactPattern("(").error).toMatch(/not a valid regular expression/);
    expect(rd.compileRedactPattern("/x/y").error).toMatch(/unsupported flags/);
    expect(rd.compileRedactPattern("x".repeat(501)).error).toMatch(/at most 500/);
    expect(rd.compileRedactPattern(5).error).toBeTruthy();
    expect(rd.compileRedactPattern("/ab/i").regex.flags).toBe("gi");
  });
});
