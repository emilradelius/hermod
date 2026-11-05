/**
 * Redaction of secrets and personal data.
 *
 * - `secretsRedactor`: API keys and tokens of the common providers, private keys, Authorization values, passwords in
 *   URLs and connection strings, and values assigned to secret-looking names (env, shell, JSON, YAML, headers).
 * - `piiRedactor`: e-mail addresses, phone numbers, Swedish personnummer and organisationsnummer, IBANs and card
 *   numbers (checksums are verified, so ordinary numbers stay).
 * - `composeRedactors(...)` chains redactors; `findSecrets(text)` reports secrets for validators without changing text.
 *
 * Every match becomes "[REDACTED:<kind>]". For assignments, headers and URLs only the secret part is replaced, so
 * "DB_PASSWORD=[REDACTED:secret-assignment]" still says what it was. Kept on purpose: git SHAs and other hex, UUIDs,
 * ordinary prose, file paths and plain numbers. Redactors are idempotent and never throw (if something unexpected
 * happens inside, the whole text is replaced rather than returned unredacted).
 *
 * Redact before you truncate: a secret cut in half may no longer be recognisable.
 */
import type { Redactor } from "../types.js";

export interface SecretFinding {
  /** The kind of secret, the same word the redactor puts in "[REDACTED:<kind>]". */
  kind: string;
  /** UTF-16 offset of the secret in the text. */
  index: number;
  length: number;
  /** 1-based line and column. */
  line: number;
  column: number;
  /** A masked preview that never contains the secret (a public prefix such as "ghp_" at most, and the length). */
  excerpt: string;
}

interface Span {
  start: number;
  end: number;
  kind: string;
  secret: string;
}

interface Rule {
  kind: string;
  category: "secret" | "pii";
  /** Global, with the "d" flag (match indices). */
  regex: RegExp;
  /** Named groups that hold the secret (the first that matched); default: the whole match. */
  groups?: readonly string[];
  /** False keeps the text. `strict` is true for findSecrets (fewer false positives). */
  accept?: (secret: string, m: RegExpExecArray, strict: boolean) => boolean;
  /** A more specific kind for this match. */
  kindOf?: (m: RegExpExecArray) => string;
  /** When the match is rejected, retry with it cut at the last of these separators (numbers followed by more). */
  shrinkAt?: RegExp;
  /** Skip the rule unless the text matches this (a cheap precheck for rules that scan many lines). */
  hint?: RegExp;
}

const REPLACEMENT_PREFIX = "[REDACTED:";
const UNREDACTABLE = "[REDACTED:unredactable]";

// ─── Value heuristics ───────────────────────────────────────────────────────────────────────────────────────

const SECRET_WORDS = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH|COOKIE|SESSION/;
/** Words that may hold a passphrase with spaces in it; the others (KEY, AUTH, SESSION, PWD) need a one-word value. */
const STRONG_WORDS = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|COOKIE/;
/** Ordinary words that contain a secret word ("keyboard", "author", "tokenizer"); removed before the test. */
const INNOCENT_WORDS =
  /KEYBOARD|KEYWORD|KEYFRAME|KEYSTROKE|KEYCODE|KEYMAP|KEYNOTE|MONKEY|DONKEY|TURKEY|HOCKEY|JOCKEY|WHISKEY|TOKENIZ|AUTHOR(?!IZ)/g;
/** Names whose values are locations, not secrets, when the value is a plain URL or path. */
const LOCATION_WORDS = /URL|URI|HOST|ENDPOINT|ORIGIN|DOMAIN|PATH|FILE|DIR|ISSUER|AUDIENCE|REDIRECT|CALLBACK/;

function upperName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** True when a variable or key name says it holds a secret (API_KEY, dbPassword, "x-auth-token", Cookie). */
export function isSecretName(name: string): boolean {
  const upper = upperName(name);
  // The shell's PWD and OLDPWD are the working directory, not a password.
  if (upper === "PWD" || upper === "OLDPWD") return false;
  return SECRET_WORDS.test(upper.replace(INNOCENT_WORDS, "-"));
}

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
  "yes",
  "no",
  "on",
  "off",
  "enabled",
  "disabled",
  "required",
  "optional",
  "todo",
  "tbd",
  "default",
  "empty",
  "hidden",
  "masked",
  "string",
  "value",
  "xxx",
]);

const TYPE_ANNOTATION =
  /^(?:string|number|boolean|unknown|any|null|undefined|never|void|object|bigint|symbol|date|buffer)(?:\[\])?(?:\s*\|\s*(?:string|number|boolean|null|undefined)(?:\[\])?)*\s*[;,]?$/i;

/** Values that are clearly not a secret: references, templates, masks, earlier redactions, numbers, booleans. */
function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v === "" || v.includes(REPLACEMENT_PREFIX)) return true;
  if (/^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(v) || /^\$\(/.test(v) || /^\$\{\{.*\}\}$/.test(v)) return true;
  if (/^%[A-Za-z_][A-Za-z0-9_]*%$/.test(v)) return true;
  if (/^<[^<>]*>$/.test(v) || /^\{\{.*\}\}$/.test(v) || /^\{%.*%\}$/.test(v)) return true;
  if (/^(.)\1*$/su.test(v) || v === "..." || v === "…") return true;
  if (/^[-+]?\d+(?:[.,]\d+)?$/.test(v)) return true;
  if (/^\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|m|min|mins|h|hr|hrs|d|days?|w|k|kb|mb|gb|%)$/i.test(v)) return true;
  if (TYPE_ANNOTATION.test(v)) return true;
  const lower = v.toLowerCase();
  if (PLACEHOLDER_WORDS.has(lower)) return true;
  return /^(?:your|my|the|some|example|sample|dummy|fake)[-_ ]/.test(lower) || /[-_ ](?:here|goes-here|placeholder)$/.test(lower);
}

/** process.env.API_KEY, config.apiKey, getToken(), `x;`: code, not a value. */
function isCodeLike(value: string): boolean {
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) || /[()[\]{}]/.test(value) || /[;,]$/.test(value);
}

function isPathLike(value: string): boolean {
  return /^(?:\.{1,2}\/|~\/|\/|[A-Za-z]:[\\/])[\w.\-~/\\ @+]*$/.test(value) && /[/\\]/.test(value);
}

function isPlainUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^\s@?#]+$/i.test(value);
}

function charClasses(s: string): { upper: number; lower: number; digit: number; symbol: number } {
  let upper = 0;
  let lower = 0;
  let digit = 0;
  let symbol = 0;
  for (const ch of s) {
    if (ch >= "A" && ch <= "Z") upper++;
    else if (ch >= "a" && ch <= "z") lower++;
    else if (ch >= "0" && ch <= "9") digit++;
    else if (/[!@#$%^&*+/=?~_.-]/.test(ch)) symbol++;
  }
  return { upper, lower, digit, symbol };
}

/** A credential-shaped value: letters and digits mixed, or long and mixed case. */
function looksLikeCredential(s: string): boolean {
  if (isPlaceholder(s)) return false;
  const c = charClasses(s);
  if (s.length >= 16 && c.digit > 0 && c.upper + c.lower > 0) return true;
  return s.length >= 20 && c.upper > 0 && c.lower > 0;
}

/** Should the value assigned to `name` be redacted? */
function acceptAssigned(name: string, value: string, strict: boolean, bare: boolean): boolean {
  if (!isSecretName(name)) return false;
  const v = value.trim();
  if (isPlaceholder(v)) return false;
  if (/\s/.test(v) && !STRONG_WORDS.test(upperName(name))) return false;
  if (LOCATION_WORDS.test(upperName(name)) && (isPlainUrl(v) || isPathLike(v))) return false;
  if (isPathLike(v)) return false;
  if (bare && isCodeLike(v)) return false;
  if (!strict) return true;
  if (v.length < 8 || /\s/.test(v) || isCodeLike(v)) return false;
  const c = charClasses(v);
  return c.digit > 0 || c.symbol > 0 || (c.upper > 0 && c.lower > 0) || v.length >= 16;
}

function assignedName(m: RegExpExecArray): string {
  return m.groups?.["name"] ?? m.groups?.["name2"] ?? "";
}

function assignmentKind(m: RegExpExecArray): string {
  const upper = upperName(assignedName(m));
  if (upper.includes("VAPID")) return "vapid-private-key";
  if (/AWSSECRETACCESSKEY/.test(upper)) return "aws-secret-access-key";
  return "secret-assignment";
}

// ─── Checksums ──────────────────────────────────────────────────────────────────────────────────────────────

/** Luhn checksum over a string of digits (other characters are ignored). */
export function isLuhnValid(input: string): boolean {
  const digits = input.replace(/\D/g, "");
  if (digits.length < 2) return false;
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

/** Swedish personnummer or samordningsnummer (day + 60): a plausible date and a valid Luhn check digit. */
export function isPersonnummer(raw: string): boolean {
  const digits = raw.replace(/[-+]/g, "");
  if (!/^\d{10}(?:\d{2})?$/.test(digits)) return false;
  if (digits.length === 12 && !/^(?:18|19|20)/.test(digits)) return false;
  const ten = digits.length === 12 ? digits.slice(2) : digits;
  const month = Number(ten.slice(2, 4));
  let day = Number(ten.slice(4, 6));
  if (day > 60) day -= 60;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  return isLuhnValid(ten);
}

/** Swedish organisationsnummer: ten digits (optionally "16" first), third digit 2 or more, valid Luhn check digit. */
export function isOrganisationsnummer(raw: string): boolean {
  const digits = raw.replace(/-/g, "");
  if (!/^(?:16)?\d{10}$/.test(digits)) return false;
  const ten = digits.length === 12 ? digits.slice(2) : digits;
  if (ten[0] === "0" || Number(ten[2]) < 2) return false;
  return isLuhnValid(ten);
}

/** IBAN with a valid ISO 13616 mod-97 check (spaces allowed). */
export function isValidIban(raw: string): boolean {
  const iban = raw.replace(/ /g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

function isCardNumber(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 13 && digits.length <= 19 && /^[2-6]/.test(digits) && isLuhnValid(digits);
}

/** "Basic <base64>" is a credential when it decodes to readable "user:password". */
function isBasicCredential(value: string): boolean {
  if (value.length < 8 || value.length % 4 === 1) return false;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  return decoded.includes(":") && /^[\x20-\x7e]+$/.test(decoded);
}

// ─── Rules ──────────────────────────────────────────────────────────────────────────────────────────────────

function rule(kind: string, category: Rule["category"], regex: RegExp, extra: Partial<Rule> = {}): Rule {
  let flags = regex.flags;
  if (!flags.includes("g")) flags += "g";
  if (!flags.includes("d")) flags += "d";
  return { kind, category, regex: new RegExp(regex.source, flags), ...extra };
}

const VALUE_GROUPS = ["dq", "sq", "bare"] as const;
const DB_SCHEMES = /^(?:postgres|postgresql|mysql|mariadb|mongodb|mongodb\+srv|redis|rediss|amqp|amqps|mssql|sqlserver)$/i;
const PEM_LABEL = String.raw`-----(?:BEGIN|END) (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----`;

const RULES: readonly Rule[] = [
  rule(
    "private-key",
    "secret",
    new RegExp(`${PEM_LABEL.replace("(?:BEGIN|END)", "BEGIN")}[\\s\\S]*?${PEM_LABEL.replace("(?:BEGIN|END)", "END")}`),
    { hint: /PRIVATE KEY/ },
  ),
  // A key block cut off before its end (truncated output): the header and the base64 lines after it.
  rule(
    "private-key",
    "secret",
    new RegExp(`${PEM_LABEL.replace("(?:BEGIN|END)", "BEGIN")}(?:(?:\\r?\\n|\\\\r?\\\\n)[ \\t]*(?:[A-Za-z0-9+/=]{1,200}|[A-Za-z-]+:[^\\r\\n\\\\]*)?){0,200}`),
    { hint: /PRIVATE KEY/ },
  ),
  // The tail of a key block whose header was cut off.
  rule(
    "private-key",
    "secret",
    // Starts at a line start and spans at most 100 lines (a 4096-bit RSA key is about 50), so it stays linear.
    new RegExp(`(?<=^|\\n|\\\\n)[ \\t]*(?:[A-Za-z0-9+/=]{16,200}[ \\t]*(?:\\r?\\n|\\\\r?\\\\n)[ \\t]*){1,100}${PEM_LABEL.replace("(?:BEGIN|END)", "END")}`),
    { hint: /END [A-Z0-9 ]*PRIVATE KEY/ },
  ),
  rule("anthropic-key", "secret", /(?<![\w-])sk-ant-[A-Za-z0-9_-]{20,}/),
  rule("openai-key", "secret", /(?<![\w-])sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/, {
    accept: (s) => /\d/.test(s) && /[A-Za-z]/.test(s.slice(3)),
  }),
  rule("github-token", "secret", /(?<![A-Za-z0-9_])(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/),
  rule("gitlab-token", "secret", /(?<![\w-])glpat-[A-Za-z0-9_-]{20,}/),
  rule("aws-access-key-id", "secret", /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/),
  rule(
    "aws-secret-access-key",
    "secret",
    /(?<![A-Za-z0-9])aws_?secret_?access_?key["']?\s*[:=]\s*["']?(?<secret>[A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i,
    { groups: ["secret"] },
  ),
  rule("slack-token", "secret", /(?<![\w-])(?:xox[abprs]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,})/),
  rule("slack-webhook", "secret", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/]{20,}/),
  rule("stripe-key", "secret", /(?<![A-Za-z0-9_])(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{20,})/),
  rule("google-api-key", "secret", /(?<![\w-])(?:AIza[0-9A-Za-z_-]{35}|GOCSPX-[0-9A-Za-z_-]{28}|ya29\.[0-9A-Za-z_-]{20,})(?![\w-])/),
  rule("npm-token", "secret", /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/),
  rule("supabase-key", "secret", /(?<![A-Za-z0-9_])(?:sbp_[a-f0-9]{40}|sb_secret_[A-Za-z0-9_-]{20,})/),
  // "123456789:AA…" alone or in an API URL (".../bot123456789:AA.../sendMessage"; "bot" is kept).
  rule("telegram-bot-token", "secret", /(?<![\w:])(?:bot)?(?<secret>\d{8,10}:[A-Za-z0-9_-]{35})(?![\w-])/, {
    groups: ["secret"],
  }),
  rule("jwt", "secret", /(?<![\w-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/),
  // scheme://user:password@host keeps the user and the host.
  rule(
    "url-credentials",
    "secret",
    /\b(?<scheme>[A-Za-z][A-Za-z0-9+.-]{1,20}):\/\/(?<user>[^\s:@/?#'"<>]*):(?<secret>[^\s/?#'"<>]+)@(?<host>[^\s@/?#'"<>]+)/,
    {
      groups: ["secret"],
      accept: (s) => !isPlaceholder(s),
      kindOf: (m) => (DB_SCHEMES.test(m.groups?.["scheme"] ?? "") ? "connection-string" : "url-credentials"),
    },
  ),
  rule(
    "authorization",
    "secret",
    /(?<![\w-])(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:(?<scheme>bearer|basic|token|bot|digest|apikey|key)\s+)?(?<secret>[A-Za-z0-9._~+/=:-]{6,})/i,
    {
      groups: ["secret"],
      accept: (s, m, strict) => (m.groups?.["scheme"] && !strict ? !isPlaceholder(s) : looksLikeCredential(s)),
      kindOf: (m) => ((m.groups?.["scheme"] ?? "").toLowerCase() === "basic" ? "basic-auth" : "authorization"),
    },
  ),
  rule("bearer-token", "secret", /(?<![\w-])bearer\s+(?<secret>[A-Za-z0-9._~+/-]{16,}=*)/i, {
    groups: ["secret"],
    accept: (s) => looksLikeCredential(s),
  }),
  rule("basic-auth", "secret", /(?<![\w-])basic\s+(?<secret>[A-Za-z0-9+/]{8,}={0,2})(?![\w+/=])/i, {
    groups: ["secret"],
    accept: (s) => isBasicCredential(s),
  }),
  rule(
    "secret-flag",
    "secret",
    /(?<![\w-])--?(?<name>password|passwd|pass|pwd|token|api-key|apikey|api-token|secret|client-secret|access-token|auth-token|private-key)(?:=|[ \t]+)(?:"(?<dq>[^"\n]*)"|'(?<sq>[^'\n]*)'|(?<bare>[^\s"'`;&|<>]+))/i,
    {
      groups: VALUE_GROUPS,
      accept: (s, m, strict) =>
        !s.startsWith("-") && acceptAssigned(`${assignedName(m)}_TOKEN`, s, strict, m.groups?.["bare"] !== undefined),
    },
  ),
  // NAME=value (env files, shell, properties, query strings, libpq "password=…"). Not ==, =>, =~.
  rule(
    "secret-assignment",
    "secret",
    /(?<![\w$.-])(?<name>[A-Za-z_][\w.-]{0,80})[ \t]*=(?![=>~])[ \t]*(?:"(?<dq>(?:[^"\\\n]|\\.)*)"|'(?<sq>[^'\n]*)'|(?<bare>[^\s"'`;&|<>]+))/,
    {
      groups: VALUE_GROUPS,
      accept: (s, m, strict) => acceptAssigned(assignedName(m), s, strict, m.groups?.["bare"] !== undefined),
      kindOf: assignmentKind,
    },
  ),
  // "name": "value" (JSON) and 'name': 'value'.
  rule(
    "secret-assignment",
    "secret",
    /(?<q>["'])(?<name>[^"'\n]{1,80})\k<q>\s*:\s*(?:"(?<dq>(?:[^"\\\n]|\\.)*)"|'(?<sq>[^'\n]*)')/,
    {
      groups: ["dq", "sq"],
      accept: (s, m, strict) => acceptAssigned(assignedName(m), s, strict, false),
      kindOf: assignmentKind,
    },
  ),
  // name: "value" (JavaScript objects, YAML with quotes).
  rule(
    "secret-assignment",
    "secret",
    /(?<![\w$."'-])(?<name>[A-Za-z_$][\w$-]{0,80})[ \t]*:[ \t]*(?:"(?<dq>(?:[^"\\\n]|\\.)*)"|'(?<sq>[^'\n]*)')/,
    {
      groups: ["dq", "sq"],
      accept: (s, m, strict) => acceptAssigned(assignedName(m), s, strict, false),
      kindOf: assignmentKind,
    },
  ),
  // name: value at the start of a line (YAML, HTTP headers such as "Cookie: …" or "X-Api-Key: …").
  rule(
    "secret-assignment",
    "secret",
    /^[ \t]*(?:-[ \t]+)?(?<name>[A-Za-z_][\w.-]{0,80})[ \t]*:[ \t]+(?<bare>[^\s"'#](?:\S|[ \t]+(?![ \t#]|\r?$))*)/m,
    {
      groups: ["bare"],
      accept: (s, m, strict) => acceptAssigned(assignedName(m), s, strict, true),
      kindOf: assignmentKind,
    },
  ),

  // ─── Personal data ───
  rule(
    "email",
    "pii",
    /(?<![A-Za-z0-9._%+-])(?<local>[A-Za-z0-9._%+-]{1,64})@(?<domain>(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,8}(?<tld>[A-Za-z]{2,24}))(?![A-Za-z0-9-])/,
    {
      // git@github.com:… is an SSH remote, and "icon@2x.png" is a file name.
      accept: (_s, m) =>
        (m.groups?.["local"] ?? "").toLowerCase() !== "git" &&
        !/^(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|cjs|ts|tsx|jsx|json|md|txt|html|map|pdf|woff2?)$/i.test(
          m.groups?.["tld"] ?? "",
        ),
    },
  ),
  // YYMMDD-XXXX, YYMMDD+XXXX, YYYYMMDDXXXX, YYYYMMDD-XXXX (ten digits without a separator are left alone: they are
  // too often other numbers).
  rule("personnummer", "pii", /(?<![\w+-])(?:(?:18|19|20)\d{6}[-+]?|\d{6}[-+])\d{4}(?![\w-])/, {
    accept: (s) => isPersonnummer(s),
  }),
  rule("organisationsnummer", "pii", /(?<![\w+-])(?:16)?\d{6}-\d{4}(?![\w-])/, {
    accept: (s) => isOrganisationsnummer(s),
  }),
  rule("iban", "pii", /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?(?![A-Za-z0-9])/, {
    accept: (s) => isValidIban(s),
    shrinkAt: / /g,
  }),
  // Card numbers before phone numbers: a grouped card number must not be half-eaten as a phone number.
  rule("card-number", "pii", /(?<![\w.+-])[2-6](?:[ -]?\d){12,18}(?![\w-])/, {
    accept: (s) => isCardNumber(s),
  }),
  // International (E.164 style, spaces or hyphens allowed, "+46 (0)70 …"): 8 to 15 digits after the "+".
  rule("phone", "pii", /(?<![\w+])\+[1-9](?:[ \t-]?(?:\d|\(0\))){6,17}(?!\d)/, {
    accept: (s) => {
      const digits = s.replace(/\(0\)/g, "").replace(/\D/g, "");
      return digits.length >= 8 && digits.length <= 15;
    },
    shrinkAt: /[ \t-]/g,
  }),
  // Swedish mobile numbers: 07x-xxx xx xx, 07x xxx xx xx, 07xxxxxxxx.
  rule("phone", "pii", /(?<![\w+.,:/-])07\d(?:[ \t-]?\d){7}(?![\w-])/),
];

// ─── Engine ─────────────────────────────────────────────────────────────────────────────────────────────────

function lastSeparator(secret: string, separators: RegExp): number {
  let last = -1;
  separators.lastIndex = 0;
  for (let m = separators.exec(secret); m !== null; m = separators.exec(secret)) last = m.index;
  separators.lastIndex = 0;
  return last;
}

/** Cuts a rejected match at its last separator until it is accepted or nothing is left. */
function shrink(r: Rule, secret: string, m: RegExpExecArray, strict: boolean): string | null {
  if (!r.shrinkAt || !r.accept) return null;
  let candidate = secret;
  for (;;) {
    const cut = lastSeparator(candidate, r.shrinkAt);
    if (cut <= 0) return null;
    candidate = candidate.slice(0, cut).replace(/[ \t-]+$/, "");
    if (candidate !== "" && r.accept(candidate, m, strict)) return candidate;
  }
}

function findSpans(text: string, r: Rule, strict: boolean): Span[] {
  const spans: Span[] = [];
  if (r.hint && !r.hint.test(text)) return spans;
  const re = r.regex;
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    let start = m.index;
    let secret = m[0];
    if (r.groups) {
      const groupName = r.groups.find((g) => m.groups?.[g] !== undefined);
      const indices = groupName ? m.indices?.groups?.[groupName] : undefined;
      if (!groupName || !indices) continue;
      start = indices[0];
      secret = m.groups?.[groupName] ?? "";
    }
    if (secret === "" || secret.includes(REPLACEMENT_PREFIX)) continue;
    if (r.accept && !r.accept(secret, m, strict)) {
      const shorter = shrink(r, secret, m, strict);
      if (shorter === null) continue;
      secret = shorter;
      re.lastIndex = start + shorter.length;
    }
    spans.push({ start, end: start + secret.length, kind: r.kindOf ? r.kindOf(m) : r.kind, secret });
  }
  re.lastIndex = 0;
  return spans;
}

function replaceSpans(text: string, spans: Span[]): string {
  if (spans.length === 0) return text;
  let out = "";
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) continue;
    out += `${text.slice(pos, s.start)}${REPLACEMENT_PREFIX}${s.kind}]`;
    pos = s.end;
  }
  return out + text.slice(pos);
}

function asText(text: unknown): string {
  if (typeof text === "string") return text;
  return text === null || text === undefined ? "" : String(text);
}

function redactWith(category: Rule["category"]): Redactor {
  return (input: string): string => {
    try {
      let out = asText(input);
      if (out === "") return out;
      for (const r of RULES) {
        if (r.category === category) out = replaceSpans(out, findSpans(out, r, false));
      }
      return out;
    } catch {
      return UNREDACTABLE;
    }
  };
}

/** Replaces API keys, tokens, private keys, passwords and other secrets with "[REDACTED:<kind>]". */
export const secretsRedactor: Redactor = redactWith("secret");

/** Replaces e-mail addresses, phone numbers, Swedish personal and organisation numbers, IBANs and card numbers. */
export const piiRedactor: Redactor = redactWith("pii");

/** Applies redactors in order. Never throws: a failing redactor replaces the whole text. */
export function composeRedactors(...redactors: Redactor[]): Redactor {
  const list = redactors.filter((r): r is Redactor => typeof r === "function");
  return (input: string): string => {
    let out = asText(input);
    for (const r of list) {
      try {
        out = asText(r(out));
      } catch {
        return UNREDACTABLE;
      }
    }
    return out;
  };
}

/** Public, fixed prefixes of well-known token formats; showing them reveals nothing secret. */
const KNOWN_PREFIX =
  /^(?:sk-ant-|sk-proj-|sk-|gh[pousr]_|github_pat_|glpat-|AKIA|ASIA|xox[abprs]-|xapp-|sk_live_|rk_live_|sk_test_|rk_test_|whsec_|AIza|GOCSPX-|ya29\.|npm_|sbp_|sb_secret_|eyJ|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function maskSecret(secret: string): string {
  const prefix = KNOWN_PREFIX.exec(secret)?.[0] ?? "";
  return `${prefix}… (${secret.length} chars)`;
}

function position(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, column: index - lineStart + 1 };
}

/**
 * Finds secrets for validators (memory, skills, proposals) without changing the text. Uses the same rules as
 * secretsRedactor with stricter checks on assigned values, so ordinary prose does not fail validation. Personal data
 * is not reported. Findings are sorted and never overlap. Never throws.
 */
export function findSecrets(input: string): SecretFinding[] {
  const text = asText(input);
  if (text === "") return [];
  const all: Span[] = [];
  try {
    for (const r of RULES) {
      if (r.category !== "secret") continue;
      for (const span of findSpans(text, r, true)) {
        if (all.some((a) => span.start < a.end && a.start < span.end)) continue;
        all.push(span);
      }
    }
  } catch {
    return [{ kind: "unredactable", index: 0, length: text.length, line: 1, column: 1, excerpt: maskSecret(text) }];
  }
  all.sort((a, b) => a.start - b.start);
  return all.map((s) => ({
    kind: s.kind,
    index: s.start,
    length: s.end - s.start,
    ...position(text, s.start),
    excerpt: maskSecret(s.secret),
  }));
}

/** The kinds the redactors can produce, for documentation and tests. */
export const REDACTION_KINDS: readonly string[] = Object.freeze(
  [...new Set([...RULES.map((r) => r.kind), "connection-string", "vapid-private-key", "basic-auth"])].sort(),
);
