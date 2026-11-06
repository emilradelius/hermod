// @ts-check
/**
 * Redaction of secrets and personal data, and secret detection for the validators.
 *
 * redact(text) replaces every match with "[REDACTED:<pattern name>]" (for assignments, headers and URL
 * credentials only the secret part is replaced, so "DB_PASSWORD=[REDACTED:secret-assignment]" still says
 * what it was). It is aggressive on purpose: it runs before a hook writes anything to disk.
 * detectSecrets(text) uses the same secret patterns with stricter checks, so that ordinary prose in
 * LESSONS.md or a SKILL.md does not fail validation.
 *
 * Kept on purpose: 40-hex git SHAs and other hex hashes, short hex, UUIDs, ordinary words, long
 * identifiers and file paths.
 *
 * Redact before you truncate: a secret cut in half by truncation may no longer be recognisable.
 */

/**
 * @typedef {object} RedactionPattern
 * @property {string} name stable id, used in the replacement "[REDACTED:<name>]"
 * @property {string} description plain English, for validator messages ("a GitHub token")
 * @property {"secret" | "pii"} kind
 * @property {RegExp} regex global, with the "d" flag (match indices)
 * @property {string[]} [groups] named groups that hold the secret (the first one that matched); default:
 *   the whole match
 * @property {(secret: string, match: RegExpExecArray) => boolean} [accept] false keeps the text
 * @property {(secret: string, match: RegExpExecArray) => boolean} [confident] detectSecrets reports a match
 *   only when this is true (default: accept)
 */

/**
 * @typedef {object} SecretFinding
 * @property {string} id the pattern name
 * @property {string} description what it looks like, in plain English
 * @property {number} index offset of the secret in the text
 * @property {number} length
 * @property {number} line 1-based
 * @property {number} column 1-based
 * @property {string} excerpt a masked preview that never contains the secret itself
 */

/**
 * @typedef {object} RedactOptions
 * @property {ReadonlyArray<string | RegExp>} [extraPatterns] more patterns (config ledger.extraRedactPatterns);
 *   strings are regular-expression sources, or "/source/flags"; invalid ones are skipped
 * @property {boolean} [pii] also redact e-mail addresses and Swedish personal identity numbers (default true)
 */

/** Characters that may surround a token without being part of it. */
const T = "A-Za-z0-9_-";

const STRONG_NAME_PARTS = new Set([
  "TOKEN",
  "TOKENS",
  "SECRET",
  "SECRETS",
  "PASSWORD",
  "PASSWORDS",
  "PASSWD",
  "PASSPHRASE",
  "CREDENTIAL",
  "CREDENTIALS",
  "CREDS",
  "APIKEY",
  "APITOKEN",
  "PRIVATEKEY",
  "ACCESSKEY",
  "SECRETKEY",
  "AUTHTOKEN",
  "ACCESSTOKEN",
  "CLIENTSECRET",
]);
/** These only count as the last part of a name: SSH_KEY, DB_PASS, BASIC_AUTH, SENTRY_DSN, GH_PAT. */
const WEAK_NAME_PARTS = new Set(["KEY", "KEYS", "PASS", "AUTH", "DSN", "PAT"]);

const PLACEHOLDER_WORDS = new Set([
  "changeme",
  "change-me",
  "change_me",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api-key",
  "api_key",
  "key",
  "example",
  "sample",
  "dummy",
  "placeholder",
  "redacted",
  "none",
  "null",
  "nil",
  "undefined",
  "true",
  "false",
  "todo",
  "tbd",
  "test",
  "testing",
  "foo",
  "bar",
  "baz",
  "default",
  "empty",
  "hidden",
  "masked",
  "required",
  "optional",
  "string",
  "value",
  "postgres",
  "root",
  "admin",
  "pass",
  "user",
]);

const FILE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "ico",
  "css",
  "scss",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "json",
  "md",
  "txt",
  "html",
  "map",
  "pdf",
  "woff",
  "woff2",
]);

/**
 * Splits an identifier into upper-case parts: "apiKey" → ["API", "KEY"], "x-api-key" → ["X", "API", "KEY"].
 * @param {string} name
 * @returns {string[]}
 */
function nameParts(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toUpperCase());
}

/**
 * True when a variable or key name says it holds a secret (API_KEY, dbPassword, "client-secret").
 * @param {string} name
 * @returns {boolean}
 */
export function isSecretName(name) {
  const parts = nameParts(name);
  if (parts.length === 0) return false;
  if (parts.some((p) => STRONG_NAME_PARTS.has(p))) return true;
  return WEAK_NAME_PARTS.has(parts[parts.length - 1]);
}

/**
 * Values that are clearly not a secret: references to variables, templates, masks, and earlier redactions.
 * @param {string} value
 * @returns {boolean}
 */
function isObviousPlaceholder(value) {
  const v = value.trim();
  if (v === "") return true;
  if (/^\$[{(A-Za-z_]/.test(v)) return true; // $VAR, ${VAR}, $(cmd)
  if (/^%[A-Za-z_][A-Za-z0-9_]*%$/.test(v)) return true; // %VAR% on Windows
  if (/^<[^<>]*>$/.test(v) || /^\{\{.*\}\}$/.test(v) || /^\[REDACTED/.test(v)) return true;
  if (/^(.)\1*$/.test(v)) return true; // ***, xxxx, ....
  if (v === "..." || v === "…") return true;
  return false;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isPlaceholderWord(value) {
  const v = value.trim().toLowerCase();
  if (PLACEHOLDER_WORDS.has(v)) return true;
  return /^(your|my|the|some|example|sample|dummy|fake|test)[-_ ]/.test(v) || /[-_ ](here|goes-here|placeholder)$/.test(v);
}

/**
 * process.env.API_KEY, config.apiKey, getToken(): code, not a value.
 * @param {string} value
 * @returns {boolean}
 */
function isCodeLike(value) {
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) || /[()[\]]/.test(value);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isPathLike(value) {
  return /^(?:\.{0,2}\/|~\/|[A-Za-z]:[\\/])/.test(value) || /^[\w.-]+(?:\/[\w.-]+)+$/.test(value);
}

/**
 * @param {string} s
 * @returns {{ upper: number, lower: number, digit: number, symbol: number }}
 */
function charCounts(s) {
  let upper = 0;
  let lower = 0;
  let digit = 0;
  let symbol = 0;
  for (const ch of s) {
    if (ch >= "A" && ch <= "Z") upper++;
    else if (ch >= "a" && ch <= "z") lower++;
    else if (ch >= "0" && ch <= "9") digit++;
    else if (/[!@#$%^&*+/=?~]/.test(ch)) symbol++;
  }
  return { upper, lower, digit, symbol };
}

/**
 * Share of the characters that sit in word-like runs ("profile", "Settings"). Random tokens score low.
 * @param {string} s
 * @returns {number}
 */
function wordCoverage(s) {
  let covered = 0;
  for (const m of s.matchAll(/[a-z]{4,}|[A-Z][a-z]{3,}/g)) covered += m[0].length;
  return s.length === 0 ? 0 : covered / s.length;
}

/**
 * A long run of mixed-case letters and digits that does not read like words, a hex hash or a UUID.
 * @param {string} s
 * @returns {boolean}
 */
export function looksLikeRandomToken(s) {
  if (s.length < 32) return false;
  if (/^[0-9a-f-]+$/.test(s) || /^[0-9A-F-]+$/.test(s)) return false; // hex hashes, git SHAs, UUIDs
  const c = charCounts(s);
  if (c.upper < 2 || c.lower < 2 || c.digit < 2) return false;
  return wordCoverage(s) < 0.5;
}

/**
 * A credential-shaped value: letters and digits mixed, or long and mixed-case.
 * @param {string} s
 * @returns {boolean}
 */
function looksLikeCredential(s) {
  if (isObviousPlaceholder(s) || isPlaceholderWord(s)) return false;
  const c = charCounts(s);
  const letters = c.upper + c.lower;
  if (s.length >= 16 && c.digit > 0 && letters > 0) return true;
  return s.length >= 20 && c.upper > 0 && c.lower > 0;
}

/**
 * The strict test detectSecrets uses for assignment-style values (API_KEY=..., "password": "...").
 * @param {string} value
 * @returns {boolean}
 */
function isConfidentValue(value) {
  const v = value.trim();
  if (v.length < 8 || /\s/.test(v)) return false;
  if (isObviousPlaceholder(v) || isPlaceholderWord(v) || isCodeLike(v) || isPathLike(v)) return false;
  if (/^\d+$/.test(v)) return false;
  const c = charCounts(v);
  return c.digit > 0 || c.symbol > 0 || (c.upper > 0 && c.lower > 0) || v.length >= 16;
}

/**
 * @param {string} secret
 * @returns {boolean}
 */
function acceptValue(secret) {
  return !isObviousPlaceholder(secret);
}

/**
 * @param {string} secret
 * @param {RegExpExecArray} m
 * @returns {boolean}
 */
function acceptBareValue(secret, m) {
  if (!acceptValue(secret)) return false;
  return m.groups?.bare === undefined || !isCodeLike(secret);
}

/**
 * Luhn checksum over a string of digits.
 * @param {string} digits
 * @returns {boolean}
 */
function luhnValid(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Swedish personnummer / samordningsnummer: a valid date (day + 60 for samordningsnummer) and checksum.
 * @param {string} raw
 * @returns {boolean}
 */
export function isPersonnummer(raw) {
  const digits = raw.replace(/[-+]/g, "");
  if (!/^\d{10}(?:\d{2})?$/.test(digits)) return false;
  const ten = digits.length === 12 ? digits.slice(2) : digits;
  if (digits.length === 12 && !/^(?:18|19|20)/.test(digits)) return false;
  const month = Number(ten.slice(2, 4));
  let day = Number(ten.slice(4, 6));
  if (day > 60) day -= 60;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  return luhnValid(ten);
}

/**
 * @param {string} name
 * @param {string} description
 * @param {"secret" | "pii"} kind
 * @param {RegExp} regex
 * @param {Omit<Partial<RedactionPattern>, "name" | "description" | "kind" | "regex">} [extra]
 * @returns {RedactionPattern}
 */
function pattern(name, description, kind, regex, extra = {}) {
  const flags = regex.flags.includes("d") ? regex.flags : `${regex.flags}d`;
  return Object.freeze({
    name,
    description,
    kind,
    regex: new RegExp(regex.source, flags.includes("g") ? flags : `${flags}g`),
    ...extra,
  });
}

const VALUE_GROUPS = ["dq", "sq", "bare"];
const LOCAL_HOSTS = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w.-]*example\.(?:com|org|net))(?::\d+)?$/i;

/**
 * The built-in patterns, in the order they are applied. Specific formats come before the generic ones.
 * @type {ReadonlyArray<RedactionPattern>}
 */
export const REDACTION_PATTERNS = Object.freeze([
  pattern(
    "private-key",
    "a private key block",
    "secret",
    /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----/,
  ),
  pattern(
    "private-key",
    "the start of a private key block",
    "secret",
    /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----(?:(?:\r?\n|\\r?\\n)[ \t]*(?:[A-Za-z0-9+/=]{1,200}|[A-Za-z-]+:[^\r\n\\]*)?)*/,
  ),
  pattern(
    "private-key",
    "the end of a private key block",
    "secret",
    /(?:[A-Za-z0-9+/=]{16,200}[ \t]*(?:\r?\n|\\r?\\n)[ \t]*)+-----END (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----/,
  ),
  pattern(
    "url-credentials",
    "a password in a URL (user:password@host)",
    "secret",
    /\b[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s:@/?#'"<>]+:(?<secret>[^\s/?#'"<>]+)@(?<host>[^\s@/?#'"<>]+)/,
    {
      groups: ["secret"],
      accept: (secret) => acceptValue(secret),
      confident: (secret, m) => !LOCAL_HOSTS.test(m.groups?.host ?? "") && !isPlaceholderWord(secret) && !isObviousPlaceholder(secret),
    },
  ),
  pattern("anthropic-key", "an Anthropic API key", "secret", new RegExp(`(?<![${T}])sk-ant-[A-Za-z0-9_-]{20,}`)),
  pattern(
    "openai-key",
    "an OpenAI-style API key (sk-…)",
    "secret",
    new RegExp(`(?<![${T}])sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}`),
    { accept: (s) => /\d/.test(s) && /[A-Za-z]/.test(s.slice(3)) },
  ),
  pattern(
    "github-token",
    "a GitHub token",
    "secret",
    /(?<![A-Za-z0-9_])(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})(?![A-Za-z0-9_])/,
  ),
  pattern("gitlab-token", "a GitLab token", "secret", new RegExp(`(?<![${T}])glpat-[A-Za-z0-9_-]{20,}`)),
  pattern(
    "aws-access-key-id",
    "an AWS access key id",
    "secret",
    /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/,
  ),
  pattern(
    "aws-secret-access-key",
    "an AWS secret access key",
    "secret",
    /(?<![A-Za-z0-9_])aws_?secret_?access_?key["']?\s*[:=]\s*["']?(?<secret>[A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i,
    { groups: ["secret"] },
  ),
  pattern(
    "slack-token",
    "a Slack token",
    "secret",
    new RegExp(`(?<![${T}])(?:xox[abprs]-[A-Za-z0-9-]{10,}|xapp-\\d-[A-Za-z0-9-]{10,})`),
  ),
  pattern(
    "slack-webhook",
    "a Slack webhook URL",
    "secret",
    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/]{20,}/,
  ),
  pattern(
    "stripe-key",
    "a Stripe secret key",
    "secret",
    /(?<![A-Za-z0-9_])(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{24,})/,
  ),
  pattern(
    "google-api-key",
    "a Google API key",
    "secret",
    new RegExp(`(?<![${T}])(?:AIza[0-9A-Za-z_-]{35}|GOCSPX-[0-9A-Za-z_-]{28}|ya29\\.[0-9A-Za-z_-]{20,})(?![${T}])`),
  ),
  pattern("npm-token", "an npm token", "secret", /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/),
  pattern("huggingface-token", "a Hugging Face token", "secret", /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}/),
  pattern("sendgrid-key", "a SendGrid API key", "secret", /(?<![A-Za-z0-9_])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/),
  pattern(
    "supabase-key",
    "a Supabase access token or secret key",
    "secret",
    /(?<![A-Za-z0-9_])(?:sbp_[a-f0-9]{40}|sb_secret_[A-Za-z0-9_-]{20,})/,
  ),
  pattern(
    "telegram-bot-token",
    "a Telegram bot token",
    "secret",
    new RegExp(`(?<![A-Za-z0-9_:])\\d{8,10}:[A-Za-z0-9_-]{35}(?![${T}])`),
  ),
  pattern(
    "jwt",
    "a JSON Web Token",
    "secret",
    new RegExp(`(?<![${T}])eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]*`),
  ),
  pattern(
    "authorization-header",
    "an Authorization header value",
    "secret",
    new RegExp(
      `(?<![${T}])(?:proxy-)?authorization["']?\\s*[:=]\\s*["']?(?:(?<scheme>bearer|basic|token|bot|digest|negotiate|ntlm|apikey|key)\\s+)?(?<secret>[A-Za-z0-9._~+/=:-]{6,})`,
      "i",
    ),
    {
      groups: ["secret"],
      accept: (secret, m) => (m.groups?.scheme ? acceptValue(secret) : looksLikeCredential(secret)),
      confident: (secret) => looksLikeCredential(secret),
    },
  ),
  pattern(
    "secret-header",
    "an API key header value",
    "secret",
    new RegExp(
      `(?<![${T}])(?:x-)?(?:api-key|apikey|auth-token|access-token|private-token|goog-api-key|session-token)["']?\\s*:\\s*["']?(?<secret>[A-Za-z0-9._~+/=-]{8,})`,
      "i",
    ),
    { groups: ["secret"], accept: (s) => acceptValue(s), confident: (s) => looksLikeCredential(s) },
  ),
  pattern("bearer-token", "a bearer token", "secret", new RegExp(`(?<![${T}])bearer\\s+(?<secret>[A-Za-z0-9._~+/-]{16,}=*)`, "i"), {
    groups: ["secret"],
    accept: (s) => looksLikeCredential(s),
  }),
  pattern(
    "cli-secret-flag",
    "a secret passed as a command-line option",
    "secret",
    new RegExp(
      `(?<![${T}])--?(?:password|passwd|pass|token|api-key|apikey|api-token|secret|client-secret|access-token|auth-token|private-key)(?:=|[ \\t]+)(?:"(?<dq>[^"\\n]*)"|'(?<sq>[^'\\n]*)'|(?<bare>[^\\s"'\`;&|<>]+))`,
      "i",
    ),
    {
      groups: VALUE_GROUPS,
      accept: (s, m) => !s.startsWith("-") && acceptBareValue(s, m),
      confident: (s) => !s.startsWith("-") && isConfidentValue(s),
    },
  ),
  pattern(
    "cli-user-password",
    "a password in a --user option",
    "secret",
    new RegExp(`(?<![${T}])(?:-u|--user)(?:=|[ \\t]+)["']?[^\\s:"']+:(?<secret>[^\\s"']+)`),
    { groups: ["secret"], accept: (s) => acceptValue(s), confident: (s) => isConfidentValue(s) },
  ),
  pattern(
    "secret-assignment",
    "a secret assigned to a variable (NAME=value)",
    "secret",
    /(?<![A-Za-z0-9_$.-])(?<name>[A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:"(?<dq>[^"\n]*)"|'(?<sq>[^'\n]*)'|(?<bare>[^\s"'`;&|<>]+))/,
    {
      groups: VALUE_GROUPS,
      accept: (s, m) => isSecretName(m.groups?.name ?? "") && acceptBareValue(s, m),
      confident: (s, m) => isSecretName(m.groups?.name ?? "") && isConfidentValue(s),
    },
  ),
  pattern(
    "secret-json",
    "a secret in a JSON field",
    "secret",
    /(?<q>["'])(?<name>[^"'\n]{1,64})\k<q>\s*:\s*"(?<dq>(?:[^"\\\n]|\\.)*)"|(?<q2>["'])(?<name2>[^"'\n]{1,64})\k<q2>\s*:\s*'(?<sq>[^'\n]*)'/,
    {
      groups: ["dq", "sq"],
      accept: (s, m) => isSecretName(m.groups?.name ?? m.groups?.name2 ?? "") && acceptValue(s),
      confident: (s, m) => isSecretName(m.groups?.name ?? m.groups?.name2 ?? "") && isConfidentValue(s),
    },
  ),
  pattern(
    "secret-object",
    "a secret in an object or YAML field",
    "secret",
    /(?<![A-Za-z0-9_$."'-])(?<name>[A-Za-z_$][A-Za-z0-9_$-]*)[ \t]*:[ \t]*(?:"(?<dq>[^"\n]*)"|'(?<sq>[^'\n]*)')/,
    {
      groups: ["dq", "sq"],
      accept: (s, m) => isSecretName(m.groups?.name ?? "") && acceptValue(s),
      confident: (s, m) => isSecretName(m.groups?.name ?? "") && isConfidentValue(s),
    },
  ),
  pattern(
    "secret-yaml",
    "a secret in a YAML field",
    "secret",
    /^[ \t]*(?:-[ \t]+)?(?<name>[A-Za-z_][A-Za-z0-9_-]*)[ \t]*:[ \t]+(?<bare>[^\s"'#][^\n\r]*?)(?=[ \t]+#|[ \t]*\r?$)/m,
    {
      groups: ["bare"],
      accept: (s, m) => isSecretName(m.groups?.name ?? "") && acceptValue(s) && !isCodeLike(s),
      confident: (s, m) => isSecretName(m.groups?.name ?? "") && isConfidentValue(s),
    },
  ),
  pattern(
    "token",
    "a long random token",
    "secret",
    /(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])/,
    { accept: (s) => looksLikeRandomToken(s) },
  ),
  pattern(
    "email",
    "an e-mail address",
    "pii",
    /(?<![A-Za-z0-9._%+-])(?<local>[A-Za-z0-9._%+-]{1,64})@(?<domain>(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?<tld>[A-Za-z]{2,24}))(?![A-Za-z0-9-])/,
    {
      accept: (_s, m) =>
        (m.groups?.local ?? "").toLowerCase() !== "git" && !FILE_EXTENSIONS.has((m.groups?.tld ?? "").toLowerCase()),
    },
  ),
  pattern(
    "personnummer",
    "a Swedish personal identity number",
    "pii",
    /(?<![0-9A-Za-z+-])(?:(?:18|19|20)\d{6}|\d{6})[-+]?\d{4}(?![0-9A-Za-z])/,
    { accept: (s) => isPersonnummer(s) },
  ),
]);

/**
 * @typedef {{ start: number, end: number, secret: string }} Span
 */

/**
 * Finds the spans one pattern would replace.
 * @param {string} text
 * @param {RedactionPattern} p
 * @param {"redact" | "detect"} mode
 * @returns {Span[]}
 */
function findSpans(text, p, mode) {
  /** @type {Span[]} */
  const spans = [];
  const re = p.regex;
  re.lastIndex = 0;
  const check = mode === "detect" ? (p.confident ?? p.accept) : p.accept;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    let start = m.index;
    let end = m.index + m[0].length;
    let secret = m[0];
    if (p.groups) {
      const groupName = p.groups.find((g) => m.groups?.[g] !== undefined);
      const indices = groupName ? m.indices?.groups?.[groupName] : undefined;
      if (!groupName || !indices) continue;
      [start, end] = indices;
      secret = m.groups?.[groupName] ?? "";
    }
    if (secret === "" || (check && !check(secret, m))) continue;
    spans.push({ start, end, secret });
  }
  re.lastIndex = 0;
  return spans;
}

/**
 * @param {string} text
 * @param {Span[]} spans sorted, non-overlapping
 * @param {string} replacement
 * @returns {string}
 */
function replaceSpans(text, spans, replacement) {
  if (spans.length === 0) return text;
  let out = "";
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) continue;
    out += text.slice(pos, s.start) + replacement;
    pos = s.end;
  }
  return out + text.slice(pos);
}

/**
 * Compiles one extra redaction pattern from config. Plain text is a regular-expression source;
 * "/source/flags" sets flags (i, m, s, u). The "g" flag is always added.
 * @param {string | RegExp} source
 * @returns {{ regex: RegExp | null, error: string | null }}
 */
export function compileRedactPattern(source) {
  if (source instanceof RegExp) {
    const flags = source.flags.includes("g") ? source.flags : `${source.flags}g`;
    return { regex: new RegExp(source.source, flags), error: null };
  }
  if (typeof source !== "string" || source.trim() === "") {
    return { regex: null, error: "a redaction pattern must be a non-empty regular expression" };
  }
  if (source.length > 500) return { regex: null, error: "a redaction pattern must be at most 500 characters" };
  let body = source;
  let flags = "";
  const literal = /^\/(.+)\/([a-z]*)$/s.exec(source);
  if (literal) {
    body = literal[1];
    flags = literal[2];
    if (/[^imsu]/.test(flags)) {
      return { regex: null, error: `redaction pattern "${source}" has unsupported flags "${flags}" (use i, m, s or u)` };
    }
  }
  try {
    return { regex: new RegExp(body, `${flags}g`), error: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { regex: null, error: `redaction pattern "${source}" is not a valid regular expression: ${reason}` };
  }
}

/**
 * @param {string} text
 * @param {RegExp} regex global
 * @returns {string}
 */
function replaceCustom(text, regex) {
  regex.lastIndex = 0;
  /** @type {Span[]} */
  const spans = [];
  for (let m = regex.exec(text); m !== null; m = regex.exec(text)) {
    if (m[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    spans.push({ start: m.index, end: m.index + m[0].length, secret: m[0] });
  }
  regex.lastIndex = 0;
  return replaceSpans(text, spans, "[REDACTED:custom]");
}

/**
 * Replaces secrets (and, by default, e-mail addresses and Swedish personal identity numbers) in text.
 * Never throws; non-string input gives "".
 * @param {unknown} text
 * @param {RedactOptions} [options]
 * @returns {string}
 */
export function redact(text, options = {}) {
  if (typeof text !== "string") return "";
  if (text === "") return text;
  let out = text;
  for (const extra of options.extraPatterns ?? []) {
    const { regex } = compileRedactPattern(extra);
    if (regex) out = replaceCustom(out, regex);
  }
  const pii = options.pii ?? true;
  for (const p of REDACTION_PATTERNS) {
    if (p.kind === "pii" && !pii) continue;
    out = replaceSpans(out, findSpans(out, p, "redact"), `[REDACTED:${p.name}]`);
  }
  return out;
}

/**
 * Redacts every string inside a JSON-like value (object keys are kept). Returns a new value.
 * @param {unknown} value
 * @param {RedactOptions} [options]
 * @returns {unknown}
 */
export function redactDeep(value, options = {}) {
  /**
   * @param {unknown} v
   * @param {number} depth
   * @returns {unknown}
   */
  const walk = (v, depth) => {
    if (typeof v === "string") return redact(v, options);
    if (depth > 50 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, item] of Object.entries(v)) out[k] = walk(item, depth + 1);
    return out;
  };
  return walk(value, 0);
}

/** Public, fixed prefixes of well-known token formats; showing them reveals nothing secret. */
const KNOWN_PREFIX =
  /^(?:sk-ant-|sk-proj-|sk-|gh[pousr]_|github_pat_|glpat-|AKIA|ASIA|ABIA|ACCA|xox[abprs]-|xapp-|sk_live_|rk_live_|sk_test_|rk_test_|whsec_|AIza|GOCSPX-|ya29\.|npm_|hf_|SG\.|sbp_|sb_secret_|eyJ|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

/**
 * A preview of a secret that never reveals it: a known public prefix (like "ghp_") if there is one,
 * then the length.
 * @param {string} secret
 * @returns {string}
 */
export function maskSecret(secret) {
  const s = String(secret ?? "");
  const prefix = KNOWN_PREFIX.exec(s)?.[0] ?? "";
  return `${prefix}… (${s.length} chars)`;
}

/**
 * @param {string} text
 * @returns {number[]} offsets where each line starts
 */
function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/**
 * @param {number[]} starts
 * @param {number} index
 * @returns {{ line: number, column: number }}
 */
function position(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - starts[lo] + 1 };
}

/**
 * Finds things that look like secrets, for the validators. Personal data is not reported.
 * Findings are sorted by position and never overlap.
 * @param {unknown} text
 * @returns {SecretFinding[]}
 */
export function detectSecrets(text) {
  if (typeof text !== "string" || text === "") return [];
  /** @type {Array<Span & { p: RedactionPattern }>} */
  const all = [];
  for (const p of REDACTION_PATTERNS) {
    if (p.kind !== "secret") continue;
    for (const span of findSpans(text, p, "detect")) {
      if (all.some((a) => span.start < a.end && a.start < span.end)) continue;
      all.push({ ...span, p });
    }
  }
  all.sort((a, b) => a.start - b.start);
  const starts = lineStarts(text);
  return all.map((a) => ({
    id: a.p.name,
    description: a.p.description,
    index: a.start,
    length: a.end - a.start,
    ...position(starts, a.start),
    excerpt: maskSecret(a.secret),
  }));
}
