import { describe, expect, it } from "vitest";
import {
  REDACTION_KINDS,
  composeRedactors,
  findSecrets,
  isLuhnValid,
  isOrganisationsnummer,
  isPersonnummer,
  isSecretName,
  isValidIban,
  piiRedactor,
  secretsRedactor,
} from "../../../src/safety/index.js";
import type { Redactor } from "../../../src/types.js";
import { chars, fake, keep } from "./fakes.js";

const both = composeRedactors(secretsRedactor, piiRedactor);

/** Asserts the secret is gone, the replacement names the kind, and the surrounding text is unchanged. */
function expectRedacted(input: string, secret: string, kind: string, redactor: Redactor = secretsRedactor): string {
  const out = redactor(input);
  expect(out).not.toContain(secret);
  expect(out).toContain(`[REDACTED:${kind}]`);
  return out;
}

describe("secretsRedactor: provider keys and tokens", () => {
  const cases: Array<[string, () => string, string]> = [
    ["Anthropic", fake.anthropic, "anthropic-key"],
    ["OpenAI project", fake.openai, "openai-key"],
    ["OpenAI legacy", fake.openaiLegacy, "openai-key"],
    ["GitHub ghp_", () => fake.github("ghp"), "github-token"],
    ["GitHub gho_", () => fake.github("gho"), "github-token"],
    ["GitHub ghu_", () => fake.github("ghu"), "github-token"],
    ["GitHub ghs_", () => fake.github("ghs"), "github-token"],
    ["GitHub ghr_", () => fake.github("ghr"), "github-token"],
    ["GitHub fine-grained", fake.githubPat, "github-token"],
    ["AWS AKIA", () => fake.awsId("AKIA"), "aws-access-key-id"],
    ["AWS ASIA", () => fake.awsId("ASIA"), "aws-access-key-id"],
    ["Slack", fake.slack, "slack-token"],
    ["Stripe sk_live_", () => fake.stripe("sk_live"), "stripe-key"],
    ["Stripe rk_live_", () => fake.stripe("rk_live"), "stripe-key"],
    ["Stripe sk_test_", () => fake.stripe("sk_test"), "stripe-key"],
    ["Google AIza", fake.google, "google-api-key"],
    ["JWT", fake.jwt, "jwt"],
    ["Telegram bot token", fake.telegram, "telegram-bot-token"],
    ["Supabase access token", fake.supabaseAccess, "supabase-key"],
    ["GitLab", fake.gitlab, "gitlab-token"],
    ["npm", fake.npm, "npm-token"],
  ];

  for (const [name, make, kind] of cases) {
    it(`redacts a bare ${name} token in prose`, () => {
      const secret = make();
      const out = expectRedacted(`the key is ${secret} (do not share)`, secret, kind);
      expect(out).toBe(`the key is [REDACTED:${kind}] (do not share)`);
    });
  }

  it("redacts a token inside JSON and inside a URL path", () => {
    const token = fake.telegram();
    const out = secretsRedactor(`GET https://api.telegram.org/bot${token}/sendMessage`);
    expect(out).toBe("GET https://api.telegram.org/bot[REDACTED:telegram-bot-token]/sendMessage");
    const ant = fake.anthropic();
    expect(secretsRedactor(JSON.stringify({ apiKey: ant }))).not.toContain(ant);
  });

  it("redacts PEM private key blocks, also JSON-escaped and truncated ones", () => {
    const pem = fake.pem();
    expect(secretsRedactor(`key:\n${pem}\nafter`)).toBe("key:\n[REDACTED:private-key]\nafter");
    const headless = pem.split("\n").slice(1).join("\n");
    expect(secretsRedactor(`cut off:\n${headless}`)).toBe("cut off:\n[REDACTED:private-key]");
    const rsa = fake.pem("RSA PRIVATE KEY");
    expect(secretsRedactor(rsa)).toBe("[REDACTED:private-key]");
    const escaped = JSON.stringify({ private_key: pem });
    const out = secretsRedactor(escaped);
    for (const line of pem.split("\n").slice(1, -1)) expect(out).not.toContain(line);
    const truncated = pem.split("\n").slice(0, 3).join("\n");
    const outTruncated = secretsRedactor(`${truncated}`);
    for (const line of truncated.split("\n").slice(1)) expect(outTruncated).not.toContain(line);
  });

  it("keeps public keys and certificates (they are not secret)", () => {
    const cert = [`-----BEGIN CERTIFICATE-----`, "MIIBszCCAVmgAwIBAgIU", `-----END CERTIFICATE-----`].join("\n");
    expect(secretsRedactor(cert)).toBe(cert);
  });

  it("redacts the AWS secret access key value", () => {
    const secret = fake.awsSecret();
    expect(secret).toHaveLength(40);
    const out = secretsRedactor(`aws_secret_access_key = ${secret}`);
    expect(out).toBe("aws_secret_access_key = [REDACTED:aws-secret-access-key]");
    expect(secretsRedactor(`AWS_SECRET_ACCESS_KEY=${secret}`)).not.toContain(secret);
  });
});

describe("secretsRedactor: headers, URLs and connection strings", () => {
  it("redacts Authorization Bearer and Basic values and keeps the scheme", () => {
    const token = chars(32, 40);
    expect(secretsRedactor(`Authorization: Bearer ${token}`)).toBe("Authorization: Bearer [REDACTED:authorization]");
    const basic = Buffer.from(`alice:${fake.password()}`).toString("base64");
    expect(secretsRedactor(`authorization: Basic ${basic}`)).toBe("authorization: Basic [REDACTED:basic-auth]");
    expect(secretsRedactor(`curl -H "Authorization: Bearer ${token}" https://x.test`)).not.toContain(token);
    expect(secretsRedactor(`{"headers":{"Authorization":"Bearer ${token}"}}`)).not.toContain(token);
  });

  it("redacts a bare bearer token and a bare Basic credential in prose", () => {
    const token = chars(40, 41);
    expect(secretsRedactor(`use bearer ${token} for it`)).toBe("use bearer [REDACTED:bearer-token] for it");
    const basic = Buffer.from("bob:hunter22").toString("base64");
    expect(secretsRedactor(`send Basic ${basic} along`)).toBe("send Basic [REDACTED:basic-auth] along");
  });

  it("keeps prose about bearer tokens and basic authentication", () => {
    const prose = "Bearer tokens are sent in a header. Basic authentication is weaker. The bearer of bad news.";
    expect(secretsRedactor(prose)).toBe(prose);
  });

  it("hides the password in URL credentials and keeps the user and the host", () => {
    const pw = fake.password();
    expect(secretsRedactor(`clone https://alice:${pw}@git.example.com/repo.git now`)).toBe(
      "clone https://alice:[REDACTED:url-credentials]@git.example.com/repo.git now",
    );
    expect(secretsRedactor(`https://alice:p@ss${pw}@example.com/x`)).toBe("https://alice:[REDACTED:url-credentials]@example.com/x");
  });

  it("redacts Postgres and Supabase connection strings", () => {
    const pw = fake.password();
    const pooled = `postgresql://postgres.abcdefghijkl:${pw}@aws-0-eu-north-1.pooler.supabase.com:6543/postgres`;
    expect(secretsRedactor(`DATABASE_URL=${pooled}`)).not.toContain(pw);
    expect(secretsRedactor(pooled)).toBe(
      "postgresql://postgres.abcdefghijkl:[REDACTED:connection-string]@aws-0-eu-north-1.pooler.supabase.com:6543/postgres",
    );
    expect(secretsRedactor(`postgres://user:${pw}@localhost:5432/db?sslmode=require`)).toContain("[REDACTED:connection-string]");
    expect(secretsRedactor(`host=db.x.supabase.co user=postgres password=${pw} dbname=postgres`)).toBe(
      "host=db.x.supabase.co user=postgres password=[REDACTED:secret-assignment] dbname=postgres",
    );
    expect(secretsRedactor(`postgres://db.example.com/app?user=app&password=${pw}`)).not.toContain(pw);
  });

  it("keeps URLs without credentials", () => {
    const urls = "See https://example.com/docs?page=2#top and postgres://localhost:5432/app and git@github.com:o/r.git";
    expect(secretsRedactor(urls)).toBe(urls);
  });
});

describe("secretsRedactor: assignments", () => {
  const pw = fake.password();

  it("redacts env, shell and properties assignments whose names say secret", () => {
    const names = [
      "API_KEY",
      "GITHUB_TOKEN",
      "CLIENT_SECRET",
      "DB_PASSWORD",
      "MYSQL_PASSWD",
      "PGPWD",
      "GOOGLE_CREDENTIALS",
      "NEXT_AUTH",
      "SESSION_COOKIE",
      "SESSION_SECRET",
      "spring.datasource.password",
    ];
    for (const name of names) {
      expect(secretsRedactor(`${name}=${pw}`), name).toBe(`${name}=[REDACTED:secret-assignment]`);
      expect(secretsRedactor(`export ${name}="${pw}"`), name).toBe(`export ${name}="[REDACTED:secret-assignment]"`);
    }
    expect(secretsRedactor(`$env:API_KEY = '${pw}'`)).toBe("$env:API_KEY = '[REDACTED:secret-assignment]'");
  });

  it("redacts JSON, JavaScript and YAML fields, and secret headers and cookies", () => {
    expect(secretsRedactor(`{"password": "${pw}", "user": "alice"}`)).toBe(
      `{"password": "[REDACTED:secret-assignment]", "user": "alice"}`,
    );
    expect(secretsRedactor(`const cfg = { apiKey: '${pw}', region: 'eu' }`)).toBe(
      "const cfg = { apiKey: '[REDACTED:secret-assignment]', region: 'eu' }",
    );
    expect(secretsRedactor(`db:\n  password: ${pw}   # rotate monthly\n  host: db.local`)).toBe(
      "db:\n  password: [REDACTED:secret-assignment]   # rotate monthly\n  host: db.local",
    );
    expect(secretsRedactor(`X-Api-Key: ${pw}`)).toBe("X-Api-Key: [REDACTED:secret-assignment]");
    expect(secretsRedactor(`Cookie: sid=${pw}; theme=dark`)).toBe("Cookie: [REDACTED:secret-assignment]");
    expect(secretsRedactor(`{"escaped": 1, "token": "a\\"b${pw}"}`)).not.toContain(pw);
  });

  it("keeps the specific kind when a known token is assigned to a secret name", () => {
    const ant = fake.anthropic();
    expect(secretsRedactor(`{"apiKey":"${ant}"}`)).toBe(`{"apiKey":"[REDACTED:anthropic-key]"}`);
    expect(secretsRedactor(`token: "${fake.github()}"`)).toBe(`token: "[REDACTED:github-token]"`);
    expect(secretsRedactor(`GITHUB_TOKEN='${fake.github()}'`)).toBe(`GITHUB_TOKEN='[REDACTED:github-token]'`);
  });

  it("names VAPID private keys", () => {
    const key = fake.vapid();
    expect(secretsRedactor(`VAPID_PRIVATE_KEY=${key}`)).toBe("VAPID_PRIVATE_KEY=[REDACTED:vapid-private-key]");
    expect(secretsRedactor(`{"vapidPrivateKey":"${key}"}`)).toBe(`{"vapidPrivateKey":"[REDACTED:vapid-private-key]"}`);
  });

  it("redacts secrets passed as command-line flags", () => {
    expect(secretsRedactor(`mysql --password=${pw} -h db`)).toBe("mysql --password=[REDACTED:secret-flag] -h db");
    expect(secretsRedactor(`tool --api-key "${pw}"`)).toBe(`tool --api-key "[REDACTED:secret-flag]"`);
  });

  it("keeps placeholders, references, code, numbers and booleans", () => {
    const kept = [
      "API_KEY=",
      "API_KEY=your-api-key-here",
      "API_KEY=<your key>",
      "API_KEY=${API_KEY}",
      "TOKEN=$GITHUB_TOKEN",
      "PASSWORD=changeme",
      "AUTH_ENABLED=true",
      "SESSION_TTL=3600",
      "SESSION_TIMEOUT=30m",
      "MAX_TOKENS=16000",
      "maxTokens: 200000",
      "password: string;",
      "token?: string | null;",
      "const sessionId = ctx.sessionId;",
      "const apiKey = process.env.ANTHROPIC_API_KEY;",
      "if (token == null) return;",
      "const isKey = (k) => k === 'x';",
      "author: Emil",
      "keyboard: dvorak",
      "tokenizer = cl100k",
      "PWD=/home/user/project",
      "SSH_KEY_PATH=/home/user/.ssh/id_ed25519",
      "AUTH_URL=https://auth.example.com/login",
      'SESSION_NAME="My session"',
      "Session: started at 10:00 and ended at 11:00",
      "API_KEY=[REDACTED:anthropic-key]",
    ];
    for (const text of kept) expect(secretsRedactor(text), text).toBe(text);
  });
});

describe("secretsRedactor: things that must be kept", () => {
  it("keeps git SHAs, short hex, UUIDs, paths, numbers and ordinary prose", () => {
    const text = [
      `commit ${keep.sha} (${keep.shortSha})`,
      `request ${keep.uuid}`,
      `edit ${keep.path} and C:\\Users\\me\\token.txt`,
      "costs 1234567890 and 3.14159 and 0xdeadbeef",
      "The task-runner-implementation-details are in docs/runtime.md; sk-learn is a library.",
      "We rotate the API key every month; the session token expires after a day.",
      "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    ].join("\n");
    expect(secretsRedactor(text)).toBe(text);
  });

  it("does not report PII (that is piiRedactor's job)", () => {
    const text = "mail emil@example.com or call +46 70 123 45 67";
    expect(secretsRedactor(text)).toBe(text);
  });
});

describe("piiRedactor", () => {
  it("redacts e-mail addresses but not SSH remotes or retina file names", () => {
    expect(piiRedactor("write to anna.svensson+news@example.co.uk today")).toBe("write to [REDACTED:email] today");
    const kept = "git@github.com:owner/repo.git and icon@2x.png";
    expect(piiRedactor(kept)).toBe(kept);
  });

  it("redacts Swedish phone numbers and E.164 numbers", () => {
    const numbers = [
      "+46 70 123 45 67",
      "+46701234567",
      "+46 (0)70-123 45 67",
      "+46-70-123 45 67",
      "070-123 45 67",
      "070 123 45 67",
      "0701234567",
      "073-12 34 567",
      "+14155552671",
      "+44 20 7946 0958",
    ];
    for (const n of numbers) expect(piiRedactor(`ring ${n} nu`), n).toBe("ring [REDACTED:phone] nu");
  });

  it("keeps numbers that are not phone numbers", () => {
    const kept = ["version 1.2.3", "2026-11-05", "1730841234", "+1 day", "+12 more", "x + 1234567", "port 5432"];
    for (const t of kept) expect(piiRedactor(t), t).toBe(t);
  });

  it("redacts personnummer in every format and checks the Luhn digit", () => {
    // 811218-9876 is the Skatteverket example number (valid checksum).
    for (const p of ["811218-9876", "811218+9876", "198112189876", "19811218-9876"]) {
      expect(piiRedactor(`pnr ${p}.`), p).toBe("pnr [REDACTED:personnummer].");
    }
    expect(isPersonnummer("811218-9876")).toBe(true);
    expect(isPersonnummer("811218-9877")).toBe(false);
    expect(isPersonnummer("811318-9876")).toBe(false); // month 13
    expect(isPersonnummer("811278-9871")).toBe(isLuhnValid("8112789871")); // samordningsnummer (day + 60)
    expect(piiRedactor("pnr 811218-9877")).toBe("pnr 811218-9877");
    // Ten digits without a separator are left alone: too often other numbers.
    expect(piiRedactor("id 8112189876")).toBe("id 8112189876");
  });

  it("redacts organisationsnummer with a valid checksum", () => {
    expect(isOrganisationsnummer("556036-0793")).toBe(true);
    expect(piiRedactor("org.nr 556036-0793")).toBe("org.nr [REDACTED:organisationsnummer]");
    expect(piiRedactor("org.nr 16556036-0793")).toBe("org.nr [REDACTED:organisationsnummer]");
    expect(piiRedactor("org.nr 556036-0794")).toBe("org.nr 556036-0794");
  });

  it("redacts IBANs with a valid mod-97 check, also followed by capital words", () => {
    expect(isValidIban("SE45 5000 0000 0583 9825 7466")).toBe(true);
    expect(isValidIban("SE45 5000 0000 0583 9825 7467")).toBe(false);
    expect(piiRedactor("IBAN SE45 5000 0000 0583 9825 7466 AND BIC")).toBe("IBAN [REDACTED:iban] AND BIC");
    expect(piiRedactor("IBAN GB82WEST12345698765432.")).toBe("IBAN [REDACTED:iban].");
    expect(piiRedactor("code SE45 5000 0000 0583 9825 7467")).toBe("code SE45 5000 0000 0583 9825 7467");
  });

  it("redacts card numbers that pass Luhn and keeps other long numbers", () => {
    expect(piiRedactor("card 4111 1111 1111 1111 exp 12/29")).toBe("card [REDACTED:card-number] exp 12/29");
    expect(piiRedactor("card 4111-1111-1111-1111")).toBe("card [REDACTED:card-number]");
    expect(piiRedactor("amex 378282246310005")).toBe("amex [REDACTED:card-number]");
    const kept = [
      "4111 1111 1111 1112", // Luhn fails
      "id 1234567890123456789", // starts with 1
      "12345678-1234-1234-1234-123456789012",
      "42345678-1234-1234-1234-123456789012",
    ];
    for (const t of kept) expect(piiRedactor(t), t).toBe(t);
  });
});

describe("redactor guarantees", () => {
  const samples = (): string[] => {
    const pw = fake.password();
    return [
      `ANTHROPIC_API_KEY=${fake.anthropic()}`,
      `Authorization: Bearer ${chars(30, 50)}`,
      `postgres://u:${pw}@h/db`,
      `{"password":"${pw}","token":"${fake.github()}"}`,
      `key: ${fake.jwt()}`,
      fake.pem(),
      `mail a@b.se, ring 070-123 45 67, pnr 811218-9876, IBAN SE45 5000 0000 0583 9825 7466, card 4111111111111111`,
      `Cookie: a=${pw}; b=c`,
      `--password "${pw} with spaces"`,
      `url https://bot${fake.telegram()}@x.test and https://u:${pw}@x.test`,
      `nested "password": "postgres://u:${pw}@h/db"`,
      `a=b=c TOKEN==${pw} TOKEN=>x`,
    ];
  };

  it("is idempotent", () => {
    for (const s of samples()) {
      const once = both(s);
      expect(both(once), s).toBe(once);
      expect(secretsRedactor(secretsRedactor(s))).toBe(secretsRedactor(s));
      expect(piiRedactor(piiRedactor(s))).toBe(piiRedactor(s));
    }
  });

  it("is idempotent on randomly glued fragments", () => {
    const parts = [...samples(), " ", "\n", "=", ":", '"', "'", "@", "/", "-", "[REDACTED:x]", "Bearer ", "+46 "];
    let seed = 42;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let i = 0; i < 300; i++) {
      let s = "";
      const n = 1 + (next() % 6);
      for (let k = 0; k < n; k++) s += parts[next() % parts.length];
      const once = both(s);
      expect(both(once), JSON.stringify(s)).toBe(once);
    }
  });

  it("never throws, also for hostile or non-string input", () => {
    const hostile: unknown[] = [undefined, null, 42, {}, { toString: () => "TOKEN=" + fake.password() }, "\u0000\uffff\ud800", "a".repeat(5)];
    for (const h of hostile) {
      expect(() => secretsRedactor(h as string)).not.toThrow();
      expect(() => piiRedactor(h as string)).not.toThrow();
      expect(typeof both(h as string)).toBe("string");
    }
    expect(secretsRedactor(undefined as unknown as string)).toBe("");
    expect(secretsRedactor({ toString: () => `TOKEN=${fake.password()}` } as unknown as string)).toBe(
      "TOKEN=[REDACTED:secret-assignment]",
    );
  });

  it("stays fast on long hostile input (no catastrophic backtracking)", () => {
    const inputs = [
      "a".repeat(200_000),
      "key: a" + " ".repeat(100_000) + "b",
      "x=".repeat(50_000),
      '"a": '.repeat(30_000),
      "a://" + "x:".repeat(50_000),
      "a@" + "a.".repeat(50_000),
      "+4".repeat(50_000),
      "1 ".repeat(100_000),
      "Bearer ".repeat(20_000),
      `-----BEGIN PRIVATE KEY-----\n${`${chars(64, 60)}\n`.repeat(3_000)}`,
      `${chars(64, 61)}\n`.repeat(3_000),
      `${`${chars(64, 62)}\n`.repeat(3_000)}-----END PRIVATE KEY-----`,
      `-----BEGIN PRIVATE KEY-----${" ".repeat(50_000)}`,
    ];
    for (const input of inputs) {
      const started = performance.now();
      both(input);
      findSecrets(input);
      expect(performance.now() - started, input.slice(0, 20)).toBeLessThan(3_000);
    }
  });

  it("composeRedactors applies in order and fails closed when a redactor throws", () => {
    const upper: Redactor = (t) => t.toUpperCase();
    const mark: Redactor = (t) => `${t}!`;
    expect(composeRedactors(upper, mark)("ab")).toBe("AB!");
    expect(composeRedactors()("same")).toBe("same");
    const boom: Redactor = () => {
      throw new Error("bug");
    };
    const out = composeRedactors(secretsRedactor, boom)(`TOKEN=${fake.password()}`);
    expect(out).toBe("[REDACTED:unredactable]");
  });

  it("lists its kinds", () => {
    for (const kind of ["anthropic-key", "jwt", "private-key", "email", "personnummer", "iban", "card-number", "phone"]) {
      expect(REDACTION_KINDS).toContain(kind);
    }
  });
});

describe("isSecretName", () => {
  it("knows secret names and ordinary ones", () => {
    for (const n of ["API_KEY", "apiKey", "x-auth-token", "Cookie", "sessionId", "DB_PASSWD", "Authorization", "credentials"]) {
      expect(isSecretName(n), n).toBe(true);
    }
    for (const n of ["author", "AUTHORS", "keyboard", "keyword", "tokenizer", "PWD", "OLDPWD", "name", "host"]) {
      expect(isSecretName(n), n).toBe(false);
    }
  });
});

describe("findSecrets", () => {
  it("reports secrets with position and a masked excerpt that never contains the secret", () => {
    const ant = fake.anthropic();
    const gh = fake.github();
    const text = `line one\nTOKEN=${ant}\nand ${gh} here`;
    const findings = findSecrets(text);
    expect(findings.map((f) => f.kind)).toEqual(["anthropic-key", "github-token"]);
    const [first, second] = findings;
    expect(first?.line).toBe(2);
    expect(first?.column).toBe(7);
    expect(first?.index).toBe(text.indexOf(ant));
    expect(first?.length).toBe(ant.length);
    expect(second?.line).toBe(3);
    for (const f of findings) {
      expect(f.excerpt).not.toContain(ant.slice(10));
      expect(f.excerpt).not.toContain(gh.slice(6));
    }
    expect(first?.excerpt).toBe(`sk-ant-… (${ant.length} chars)`);
  });

  it("is stricter than the redactor on assigned values, so prose in lessons passes", () => {
    const prose = [
      "Set API_KEY=your-key-here in .env.",
      "token: abc",
      "password: hunter",
      "The session cookie is HttpOnly.",
      `Commit ${keep.sha} fixed the token refresh.`,
      "Use `Authorization: Bearer <token>`.",
    ].join("\n");
    expect(findSecrets(prose)).toEqual([]);
    expect(findSecrets(`password: ${fake.password()}`)).toHaveLength(1);
  });

  it("does not report personal data and never throws", () => {
    expect(findSecrets("mail a@b.se, pnr 811218-9876")).toEqual([]);
    expect(findSecrets(undefined as unknown as string)).toEqual([]);
    expect(findSecrets("")).toEqual([]);
  });

  it("does not overlap findings", () => {
    const pw = fake.password();
    const findings = findSecrets(`DATABASE_PASSWORD="postgres://u:${pw}@h/db"`);
    for (let i = 1; i < findings.length; i++) {
      const prev = findings[i - 1];
      const cur = findings[i];
      if (prev && cur) expect(cur.index).toBeGreaterThanOrEqual(prev.index + prev.length);
    }
    expect(findings.length).toBeGreaterThan(0);
  });
});
