// @ts-check
/**
 * A scanner for prompt-injection patterns in knowledge files (LESSONS.md, SKILL.md) and proposals.
 *
 * - Instruction overrides in English and Swedish ("ignore previous instructions", "ignorera tidigare
 *   instruktioner"), role hijacks ("you are now an unrestricted assistant"), fake system prompts.
 * - Hidden Unicode: zero-width characters, bidirectional controls and tag characters (errors). A BOM at the
 *   very start, a zero-width joiner inside an emoji sequence and the tag sequence of a subdivision flag
 *   are allowed.
 * - Exfiltration: remote scripts piped into a shell, curl/wget sending environment variables or secrets,
 *   reverse shells, base64-decoded shell commands, markdown images that put a variable in the URL.
 *
 * Severity "error" means the text should not be merged as is; "warn" means a person should look.
 * Ordinary prose ("never ignore a failing test", "you are now ready to merge") is not flagged.
 * Phrases are matched after hidden characters are removed and markdown emphasis (* _ ` ~) is read as space.
 */

/**
 * @typedef {object} InjectionFinding
 * @property {string} id rule id, for example "override-instructions"
 * @property {"error" | "warn"} severity
 * @property {string} message plain English
 * @property {number} index offset in the original text
 * @property {number} line 1-based
 * @property {string} excerpt a short, single-line view of the text around the finding (hidden characters
 *   shown as \u{...})
 */

/**
 * @typedef {object} PhraseRule
 * @property {string} id
 * @property {"error" | "warn"} severity
 * @property {string} message
 * @property {RegExp} regex global, applied to the normalised text
 * @property {"phrase" | "command"} on which normalisation to scan
 */

/** Unicode-aware word boundaries (\b only knows ASCII). */
const B = "(?<![\\p{L}\\p{N}_])";
const E = "(?![\\p{L}\\p{N}_])";

/**
 * @param {string} source
 * @param {string} [flags]
 * @returns {RegExp}
 */
const rx = (source, flags = "giu") => new RegExp(source, flags);

const IGNORE = "(?:ignore|disregard|forget)";
const EARLIER = "(?:previous|prior|preceding|above|earlier|former|foregoing)";
const INSTRUCTION_NOUN =
  "(?:instructions?|prompts?|directions?|directives?|rules|guidelines|guidance|commands|orders|context|messages|constraints)";
const SV_IGNORE = "(?:ignorera|strunta\\s+i|bortse\\s+fr(?:å|a)n|gl(?:ö|o)m)";
const SV_EARLIER = "(?:tidigare|f(?:ö|o)reg(?:å|a)ende|ovanst(?:å|a)ende|ursprungliga)";
const SV_NOUN = "(?:instruktioner(?:na)?|anvisningar(?:na)?|regler(?:na)?|direktiv(?:en)?|uppmaningar(?:na)?)";
const ROLE_NOUN =
  "(?:assistant|ai|chatbot|bot|model|llm|dan|jailbroken|jailbreak|unrestricted|unfiltered|uncensored|evil)";
const SV_ROLE = "(?:assistent|ai|bot|modell|dan|obegr(?:ä|a)nsad|ofiltrerad|ocensurerad)";
const SHELL = "(?:sudo\\s+(?:-\\S+\\s+)*)?(?:env\\s+\\S+\\s+)?(?:ba|z|da|k|fi|c|tc)?sh";
const INTERPRETER = `(?:${SHELL}|python[0-9.]*|node|perl|ruby|php|pwsh|powershell)`;
const SECRET_VAR = "\\$\\{?[A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE)[A-Za-z0-9_]*\\}?";
const DATA_FLAG =
  "(?:-d|--data(?:-binary|-raw|-urlencode|-ascii)?|-F|--form(?:-string)?|-T|--upload-file|--json|--post-data|--post-file|--body-data|--body-file)";
const SECRET_FILE = "(?:\\.env\\b|id_rsa|id_ed25519|id_ecdsa|\\.npmrc|\\.netrc|\\.pgpass|\\.aws/credentials|credentials\\.json)";
const LEAK = `(?:${SECRET_VAR}|\\$\\(\\s*(?:env|printenv)\\s*\\)|\`\\s*(?:env|printenv)\\s*\`|\\$\\(\\s*cat\\s+[^)\\n]*${SECRET_FILE}[^)\\n]*\\)|@[^\\s'"]*${SECRET_FILE})`;
const DATA_ARG = `(?:"[^"\\n]*?${LEAK}[^"\\n]*"|[^\\s"']*${LEAK}\\S*)`;

/** @type {ReadonlyArray<PhraseRule>} */
export const INJECTION_RULES = Object.freeze([
  {
    id: "override-instructions",
    severity: "error",
    message: 'tries to override earlier instructions (for example "ignore previous instructions")',
    on: "phrase",
    regex: rx(
      [
        `${B}${IGNORE}\\s+(?:all\\s+(?:of\\s+)?)?(?:(?:the|your|my|these|those|any)\\s+)?${EARLIER}\\s+(?:[\\p{L}-]+\\s+)?${INSTRUCTION_NOUN}${E}`,
        `${B}${IGNORE}\\s+(?:all|any|every)\\s+(?:of\\s+)?(?:(?:the|your|my)\\s+)?(?:instructions?|prompts?|directions?|directives?|guidelines|orders)${E}`,
        `${B}${IGNORE}\\s+(?:your|the\\s+system(?:'s)?)\\s+(?:instructions?|prompts?|system\\s+prompt|guidelines|rules)${E}`,
        `${B}${IGNORE}\\s+everything\\s+(?:above|before|prior|previously|you\\s+were\\s+told)${E}`,
        `${B}(?:ignore|disregard)\\s+(?:all\\s+(?:of\\s+)?)?the\\s+above(?=\\s*(?:[.,;:!]|$|and${E}|instructions?${E}))`,
        `${B}(?:override|bypass)\\s+(?:all\\s+)?(?:(?:the|your|any)\\s+)?(?:(?:previous|prior|system|safety|developer)\\s+)+(?:instructions?|prompts?|guidelines|guardrails|restrictions)${E}`,
      ].join("|"),
    ),
  },
  {
    id: "override-instructions-sv",
    severity: "error",
    message: 'tries to override earlier instructions, in Swedish (for example "ignorera tidigare instruktioner")',
    on: "phrase",
    regex: rx(
      [
        `${B}${SV_IGNORE}\\s+(?:alla\\s+)?(?:(?:de|dina|mina|era)\\s+)?${SV_EARLIER}\\s+(?:\\p{L}+\\s+)?${SV_NOUN}${E}`,
        `${B}${SV_IGNORE}\\s+(?:alla|dina|era)\\s+(?:instruktioner(?:na)?|anvisningar(?:na)?|direktiv(?:en)?)${E}`,
        `${B}${SV_IGNORE}\\s+systemprompt(?:en)?${E}`,
      ].join("|"),
    ),
  },
  {
    id: "role-hijack",
    severity: "error",
    message: 'tries to give the assistant a new role (for example "you are now an unrestricted assistant")',
    on: "phrase",
    regex: rx(
      [
        `${B}you\\s+are\\s+now\\s+(?:(?:a|an|the|my)\\s+)?(?:[\\p{L}-]+\\s+){0,2}?${ROLE_NOUN}${E}`,
        `${B}you\\s+are\\s+now\\s+in\\s+(?:[\\p{L}-]+\\s+)?(?:developer|god|dan|jailbreak|jailbroken|unrestricted|unfiltered)\\s+mode${E}`,
        `${B}du\\s+(?:ä|a)r\\s+nu\\s+(?:(?:en|ett|min)\\s+)?(?:[\\p{L}-]+\\s+){0,2}?${SV_ROLE}${E}`,
      ].join("|"),
    ),
  },
  {
    id: "fake-system-prompt",
    severity: "error",
    message: "introduces a replacement system prompt",
    on: "phrase",
    regex: rx(
      `(?:^|\\n)[ \\t>#*-]*(?:new|updated|revised|real|true|actual)\\s+system\\s+(?:prompt|instructions?|message)\\s*[:—–]|(?:^|\\n)[ \\t>#*-]*nya?\\s+system\\s*(?:prompt(?:en)?|instruktioner)\\s*[:—–]`,
    ),
  },
  {
    id: "new-system-prompt",
    severity: "warn",
    message: 'mentions a "new system prompt"; check that it is not an instruction to the assistant',
    on: "phrase",
    regex: rx(
      `${B}(?:new|updated|revised)\\s+system\\s+(?:prompt|instructions)${E}|${B}nya?\\s+system\\s*(?:prompt(?:en)?|instruktioner)${E}`,
    ),
  },
  {
    id: "act-as-system",
    severity: "error",
    message: "asks the assistant to act as the system (role hijack)",
    on: "phrase",
    regex: rx(`${B}act\\s+as\\s+(?:the\\s+)?system(?:\\s+(?:prompt|message|role))?${E}|${B}agera\\s+som\\s+systemet${E}`),
  },
  {
    id: "act-as-developer",
    severity: "warn",
    message: "asks the assistant to act as the developer; check that it is not a role hijack",
    on: "phrase",
    regex: rx(`${B}act\\s+as\\s+(?:the\\s+)?developer(?:\\s+(?:prompt|message|role|mode))?${E}|${B}agera\\s+som\\s+utvecklaren${E}`),
  },
  {
    id: "conceal-instructions",
    severity: "error",
    message: "asks the assistant to hide its instructions from the user",
    on: "phrase",
    regex: rx(
      [
        `${B}(?:do\\s+not|don['’]t|never)\\s+(?:tell|inform|show|reveal\\s+to|mention\\s+to)\\s+the\\s+user\\s+about\\s+(?:this|these)\\s+(?:instructions?|messages?|prompts?|rules?)${E}`,
        `${B}(?:keep|hide)\\s+(?:this|these)\\s+(?:instructions?|messages?|prompts?|rules?)\\s+(?:secret\\s+)?from\\s+the\\s+user${E}`,
        `${B}keep\\s+(?:this|it)\\s+(?:a\\s+)?secret\\s+from\\s+the\\s+user${E}`,
        `${B}(?:berätta|säg)\\s+(?:inte|inget|ingenting)\\s+(?:för|till)\\s+användaren\\s+om\\s+(?:de\\s+här|dessa)\\s+instruktioner(?:na)?${E}`,
      ].join("|"),
    ),
  },
  {
    id: "conceal-from-user",
    severity: "warn",
    message: 'says "do not tell the user"; check that it does not hide something from the user',
    on: "phrase",
    regex: rx(
      [
        `${B}(?:do\\s+not|don['’]t|never|must\\s+not)\\s+(?:tell|inform|notify|alert)\\s+the\\s+user${E}`,
        `${B}without\\s+the\\s+user\\s+(?:knowing|noticing|seeing)${E}`,
        `${B}(?:berätta|säg)\\s+(?:inte|inget|ingenting)\\s+(?:för|till)\\s+användaren${E}`,
        `${B}utan\\s+att\\s+användaren\\s+(?:märker|vet|ser)${E}`,
      ].join("|"),
    ),
  },
  {
    id: "pipe-to-shell",
    severity: "error",
    message: "downloads a script and runs it in a shell (curl/wget piped into sh)",
    on: "command",
    regex: rx(
      [
        `\\b(?:curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\\b[^\\n;]*\\|\\s*${INTERPRETER}\\b`,
        `\\b${SHELL}\\s+(?:-c\\s+)?["']?\\$\\(\\s*(?:curl|wget)\\b`,
        `<\\(\\s*(?:curl|wget)\\b`,
        `\\beval\\s+["']?\\$\\(\\s*(?:curl|wget)\\b`,
        `\\b(?:iex|invoke-expression)\\b[^\\n]*\\b(?:iwr|invoke-webrequest|irm|invoke-restmethod|downloadstring)\\b`,
      ].join("|"),
      "gi",
    ),
  },
  {
    id: "exfiltrate-env",
    severity: "error",
    message: "sends environment variables or secrets to a web address",
    on: "command",
    regex: rx(
      [
        `\\b(?:env|printenv|export\\s+-p)\\b\\s*(?:\\|[^\\n|]*)?\\|\\s*(?:curl|wget|nc|ncat|netcat)\\b`,
        `\\b(?:curl|wget)\\b[^\\n]*?\\s${DATA_FLAG}(?:\\s+|=)${DATA_ARG}`,
      ].join("|"),
      "gi",
    ),
  },
  {
    id: "reverse-shell",
    severity: "error",
    message: "opens a reverse shell (nc -e, /dev/tcp, socat exec)",
    on: "command",
    regex: rx(
      [
        `\\b(?:nc|ncat|netcat)(?:\\.exe)?\\s+(?:[^\\n|;&]*\\s)?(?:-e|-c|--exec|--sh-exec|--lua-exec)\\s+\\S+`,
        `\\/dev\\/(?:tcp|udp)\\/[^\\s/]+\\/\\d+`,
        `\\bsocat\\b[^\\n]*\\bexec:`,
      ].join("|"),
      "gi",
    ),
  },
  {
    id: "base64-shell",
    severity: "error",
    message: "decodes base64 and runs it (base64 -d piped into a shell)",
    on: "command",
    regex: rx(
      `\\bbase64\\s+(?:-d|--decode|-D)\\b[^\\n]*\\|\\s*${INTERPRETER}\\b|\\bexec\\s*\\(\\s*(?:base64\\.)?b64decode\\s*\\(`,
      "gi",
    ),
  },
  {
    id: "markdown-image-exfil",
    severity: "error",
    message: "has an image whose web address carries a variable (data can leak when the image loads)",
    on: "command",
    regex: rx(
      [
        `!\\[[^\\]\\n]*\\]\\(\\s*<?(?:https?:)?\\/\\/[^)\\s>]*\\?[^)\\s>]*(?:\\$\\{?[A-Za-z_]\\w*\\}?|\\{\\{[^}\\n]*\\}\\}|%24[A-Za-z_{]|\\{[A-Za-z_][\\w.]*\\}|<[A-Za-z_]\\w*>)[^)\\s]*\\)`,
        `<img\\b[^>\\n]*\\bsrc\\s*=\\s*["']?(?:https?:)?\\/\\/[^"'\\s>]*\\?[^"'\\s>]*(?:\\$\\{?[A-Za-z_]|\\{\\{|%24)`,
      ].join("|"),
      "gi",
    ),
  },
]);

/** A warning is dropped when an error of the listed rule covers the same text. */
const SUPERSEDED_BY = Object.freeze({
  "new-system-prompt": "fake-system-prompt",
  "conceal-from-user": "conceal-instructions",
});

/** Zero-width characters, bidi controls and tag characters (as UTF-16). */
const HIDDEN = /[\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]|\uDB40[\uDC00-\uDC7F]/g;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
/**
 * Variation selector 16 and the skin-tone modifiers, which may sit between an emoji and a zero-width joiner.
 * @param {number} cp
 * @returns {boolean}
 */
const isEmojiModifier = (cp) => cp === 0xfe0f || (cp >= 0x1f3fb && cp <= 0x1f3ff);

/**
 * @param {number} cp
 * @returns {"zero-width" | "bidi-control" | "unicode-tags"}
 */
function hiddenKind(cp) {
  if (cp >= 0xe0000) return "unicode-tags";
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return "bidi-control";
  return "zero-width";
}

/** @type {Record<string, string>} */
const HIDDEN_NAMES = {
  0x200b: "zero width space",
  0x200c: "zero width non-joiner",
  0x200d: "zero width joiner",
  0x200e: "left-to-right mark",
  0x200f: "right-to-left mark",
  0x2060: "word joiner",
  0x2061: "function application",
  0x2062: "invisible times",
  0x2063: "invisible separator",
  0x2064: "invisible plus",
  0xfeff: "zero width no-break space",
  0x202a: "left-to-right embedding",
  0x202b: "right-to-left embedding",
  0x202c: "pop directional formatting",
  0x202d: "left-to-right override",
  0x202e: "right-to-left override",
  0x2066: "left-to-right isolate",
  0x2067: "right-to-left isolate",
  0x2068: "first strong isolate",
  0x2069: "pop directional isolate",
};

/**
 * The code point that ends just before index i (skipping emoji modifiers), or null.
 * @param {string} text
 * @param {number} i
 * @returns {string | null}
 */
function pointBefore(text, i) {
  let j = i;
  while (j > 0) {
    const low = text.charCodeAt(j - 1);
    const start = low >= 0xdc00 && low <= 0xdfff && j >= 2 ? j - 2 : j - 1;
    const cp = /** @type {number} */ (text.codePointAt(start));
    if (!isEmojiModifier(cp)) return String.fromCodePoint(cp);
    j = start;
  }
  return null;
}

/**
 * @param {string} text
 * @param {number} i
 * @returns {string | null}
 */
function pointAt(text, i) {
  const cp = text.codePointAt(i);
  return cp === undefined ? null : String.fromCodePoint(cp);
}

/**
 * True for hidden characters that are part of normal text: a BOM at offset 0, a zero-width joiner between
 * two emoji, and the tags of a subdivision flag (black flag + tags + cancel tag).
 * @param {string} text
 * @param {number} index
 * @param {number} cp
 * @returns {boolean}
 */
function isAllowedHidden(text, index, cp) {
  if (cp === 0xfeff && index === 0) return true;
  if (cp === 0x200d) {
    const before = pointBefore(text, index);
    const after = pointAt(text, index + 1);
    return before !== null && after !== null && PICTOGRAPHIC.test(before) && PICTOGRAPHIC.test(after);
  }
  if (cp >= 0xe0020 && cp <= 0xe007f) {
    // Walk back over tag characters to the base; a flag sequence starts with U+1F3F4.
    let j = index;
    while (j >= 2 && text.charCodeAt(j - 2) === 0xdb40 && text.charCodeAt(j - 1) >= 0xdc20 && text.charCodeAt(j - 1) <= 0xdc7f) j -= 2;
    if (text.codePointAt(j - 2) !== 0x1f3f4) return false;
    let k = index;
    while (text.charCodeAt(k) === 0xdb40 && text.charCodeAt(k + 1) >= 0xdc20 && text.charCodeAt(k + 1) < 0xdc7f) k += 2;
    return text.codePointAt(k) === 0xe007f;
  }
  return false;
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHidden(s) {
  // A copy of HIDDEN: replace() resets lastIndex of the regex it gets, and scanHidden is iterating HIDDEN.
  return s.replace(new RegExp(HIDDEN.source, "g"), (ch) => `\\u{${(/** @type {number} */ (ch.codePointAt(0))).toString(16).toUpperCase()}}`);
}

/**
 * @param {string} text
 * @param {number} index
 * @param {number} length
 * @returns {string}
 */
function excerptAt(text, index, length) {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + Math.max(length, 1) + 40);
  let s = text.slice(start, end);
  s = escapeHidden(s).replace(/\s+/g, " ").trim();
  if (s.length > 140) s = `${s.slice(0, 139)}…`;
  return `${start > 0 ? "…" : ""}${s}${end < text.length ? "…" : ""}`;
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
function lineOf(text, index) {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/**
 * Builds a copy of text without hidden characters (and, for phrases, with markdown emphasis read as a
 * space), plus a map from each position in the copy to the position in the original.
 * @param {string} text
 * @param {boolean} emphasisAsSpace
 * @returns {{ text: string, map: number[] }}
 */
function normalise(text, emphasisAsSpace) {
  let out = "";
  /** @type {number[]} */
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0xdb40 && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdc7f) {
        i++;
        continue;
      }
    }
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x2060 && c <= 0x2064) || c === 0xfeff || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) {
      continue;
    }
    const ch = text[i];
    out += emphasisAsSpace && (ch === "*" || ch === "_" || ch === "`" || ch === "~") ? " " : ch;
    map.push(i);
  }
  map.push(text.length);
  return { text: out, map };
}

/**
 * Hidden-character findings, one per run of adjacent hidden characters of the same kind.
 * @param {string} text
 * @returns {InjectionFinding[]}
 */
function scanHidden(text) {
  /** @type {InjectionFinding[]} */
  const findings = [];
  HIDDEN.lastIndex = 0;
  /** @type {{ kind: string, start: number, end: number, points: number[] } | null} */
  let run = null;
  const flush = () => {
    if (!run) return;
    const r = run;
    run = null;
    const unique = [...new Set(r.points)];
    const names = unique
      .slice(0, 3)
      .map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}${HIDDEN_NAMES[cp] ? ` (${HIDDEN_NAMES[cp]})` : ""}`)
      .join(", ");
    const count = r.points.length;
    let message = `contains ${count} hidden ${r.kind === "bidi-control" ? "bidirectional control" : r.kind === "unicode-tags" ? "Unicode tag" : "zero-width"} character${count === 1 ? "" : "s"}: ${names}; they can hide text from a reader, remove them`;
    if (r.kind === "unicode-tags") {
      const decoded = r.points
        .filter((cp) => cp >= 0xe0020 && cp <= 0xe007e)
        .map((cp) => String.fromCharCode(cp - 0xe0000))
        .join("");
      if (decoded.trim() !== "") message += ` (they spell "${decoded.slice(0, 80)}")`;
    }
    findings.push({
      id: r.kind,
      severity: "error",
      message,
      index: r.start,
      line: lineOf(text, r.start),
      excerpt: excerptAt(text, r.start, r.end - r.start),
    });
  };
  for (let m = HIDDEN.exec(text); m !== null; m = HIDDEN.exec(text)) {
    const cp = /** @type {number} */ (m[0].codePointAt(0));
    if (isAllowedHidden(text, m.index, cp)) continue;
    const kind = hiddenKind(cp);
    if (run && run.kind === kind && run.end === m.index) {
      run.end = m.index + m[0].length;
      run.points.push(cp);
    } else {
      flush();
      run = { kind, start: m.index, end: m.index + m[0].length, points: [cp] };
    }
  }
  flush();
  HIDDEN.lastIndex = 0;
  return findings;
}

/**
 * Scans text for prompt-injection patterns. Never throws; non-text input gives [].
 * @param {unknown} text
 * @param {{ maxFindings?: number }} [options] default 50
 * @returns {InjectionFinding[]} sorted by position
 */
export function scanText(text, options = {}) {
  if (typeof text !== "string" || text === "") return [];
  const max = options.maxFindings ?? 50;
  /** @type {InjectionFinding[]} */
  const findings = scanHidden(text);
  const phrase = normalise(text, true);
  const command = normalise(text, false);
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<{ id: string, start: number, end: number }>} */
  const spans = [];
  for (const rule of INJECTION_RULES) {
    const view = rule.on === "phrase" ? phrase : command;
    const re = rule.regex;
    re.lastIndex = 0;
    for (let m = re.exec(view.text); m !== null; m = re.exec(view.text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const lead = m[0].length - m[0].trimStart().length;
      const start = view.map[m.index + lead] ?? 0;
      const end = view.map[m.index + m[0].length] ?? text.length;
      const key = `${rule.id}:${start}`;
      if (seen.has(key)) continue;
      const supersededBy = /** @type {Record<string, string>} */ (SUPERSEDED_BY)[rule.id];
      if (supersededBy && spans.some((s) => s.id === supersededBy && s.start < end && start < s.end)) continue;
      seen.add(key);
      spans.push({ id: rule.id, start, end });
      findings.push({
        id: rule.id,
        severity: rule.severity,
        message: rule.message,
        index: start,
        line: lineOf(text, start),
        excerpt: excerptAt(text, start, end - start),
      });
    }
    re.lastIndex = 0;
  }
  findings.sort((a, b) => a.index - b.index || (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return findings.slice(0, max);
}

/**
 * Only the findings with severity "error".
 * @param {unknown} text
 * @returns {InjectionFinding[]}
 */
export function scanErrors(text) {
  // No cap before filtering: many warnings early in a text must not push its errors out.
  return scanText(text, { maxFindings: Infinity }).filter((f) => f.severity === "error").slice(0, 50);
}
