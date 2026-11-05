/**
 * A scanner for prompt-injection signs in text that is about to become memory, a skill, a proposal or context.
 *
 * Text patterns run on a folded copy of the text (NFKC, lower case, invisible characters and combining marks removed,
 * HTML entities decoded), so full-width letters or a zero-width space inside a word do not hide a phrase. Hidden
 * Unicode itself is checked on the original text. Offsets in findings always refer to the original text.
 *
 * Severity: "error" means the text should not be stored or acted on without a person looking at it; "warn" means it
 * is worth a look. False positives matter: ordinary engineering prose ("ignore the noise and focus on the test",
 * "never ignore a failing test", "you are now ready to deploy") must not be errors. That is why the override rules
 * need both a qualifier ("previous", "all", "your" …) and an instruction noun, and the role rules need a hijack term.
 */
import type { InjectionFinding } from "../types.js";
import { normalizeForMatching, originalRange, visibleExcerpt } from "./normalize.js";

interface TextRule {
  id: string;
  severity: InjectionFinding["severity"];
  message: string;
  /** Global regex over the folded (lower-case) text. */
  regex: RegExp;
}

const W = String.raw`[\s\-_.,:;*"'()]+`; // word gap, tolerant of punctuation and markup between words
/** Start of a word, also before å, ä, ö (\b only knows ASCII letters). */
const SV = String.raw`(?<![a-z0-9_åäö])`;
const NOUN_EN = String.raw`(?:instructions?|prompts?|directions?|rules|guidelines|guidance|commands?|orders|directives?|system\s*prompt|system\s*messages?|context)`;
const QUAL_EN = String.raw`(?:previous|prior|above|earlier|preceding|former|original|initial|existing|old|all|any|every|your|these|those|other|developer|system)`;
const VERB_EN = String.raw`(?:ignore|disregard|forget|override|overrule|bypass|skip|drop|discard|abandon|neglect)`;
const NOUN_SV = String.raw`(?:instruktion(?:er|erna|en)?|regler(?:na)?|regeln|direktiv(?:en)?|anvisningar(?:na)?|order|systemprompt(?:en)?|uppmaningar(?:na)?)`;
const QUAL_SV = String.raw`(?:alla|tidigare|f[öo]reg[åa]ende|ovanst[åa]ende|dina|era|de|din|ursprungliga|gamla|givna|f[öo]rsta)`;
const VERB_SV = String.raw`(?:ignorera|strunta\s+i|bortse\s+fr[åa]n|gl[öo]m|hoppa\s+[öo]ver|[åa]sidos[äa]tt|skippa)`;

const SECRET_REF = String.raw`\$\{?[a-z_]*(?:key|token|secret|password|passwd|credential)[a-z_]*\}?`;
const HIJACK_TERMS = String.raw`(?:dan\b|jailbroken|jailbreak|unrestricted|unfiltered|uncensored|unbound|no\s+longer\s+(?:bound|restricted|an?\s+(?:ai|assistant))|free\s+(?:of|from)\s+(?:all\s+)?(?:rules|restrictions|guidelines)|in\s+(?:developer|god|admin|debug)\s+mode|(?:a|an|the)\s+(?:new|different|evil|unrestricted|uncensored)\s+(?:ai|assistant|model|persona|character|bot)|(?:the\s+)?(?:system|developer|administrator|admin|root)\b)`;

const TEXT_RULES: readonly TextRule[] = [
  {
    id: "instruction-override",
    severity: "error",
    message: "Tries to override earlier instructions.",
    regex: new RegExp(String.raw`\b${VERB_EN}${W}(?:(?:all|any|of|the|my|your|these|those)${W}){0,3}${QUAL_EN}${W}(?:(?:the|of|your|my)${W})?${NOUN_EN}\b`, "g"),
  },
  {
    id: "instruction-override",
    severity: "error",
    message: "Tries to override earlier instructions.",
    regex: new RegExp(String.raw`\b${VERB_EN}${W}(?:(?:all|everything|anything)${W}(?:(?:that${W})?(?:(?:was|is|were)${W})?(?:written|said|stated|mentioned|given|you${W}were${W}told|i${W}said)${W})?(?:above|before|previously|so${W}far|until${W}now|earlier)|the${W}above)\b`, "g"),
  },
  {
    id: "instruction-override",
    severity: "error",
    message: "Tries to override earlier instructions (Swedish).",
    regex: new RegExp(String.raw`${SV}${VERB_SV}${W}(?:(?:alla|av|de|dina|mina)${W}){0,2}${QUAL_SV}${W}(?:(?:dina|mina)${W})?${NOUN_SV}`, "g"),
  },
  {
    id: "instruction-override",
    severity: "error",
    message: "Tries to override earlier instructions (Swedish).",
    regex: new RegExp(String.raw`${SV}(?:gl[öo]m|ignorera|strunta\s+i|bortse\s+fr[åa]n)${W}(?:allt|allting|det)${W}(?:ovan|ovanf[öo]r|tidigare|innan|du\s+(?:har\s+)?f[åa]tt\s+veta)\b`, "g"),
  },
  {
    id: "instruction-override",
    severity: "warn",
    message: "Mentions ignoring instructions; check that it is not an attempt to override them.",
    regex: new RegExp(String.raw`\b${VERB_EN}${W}(?:the|my|this|that)${W}${NOUN_EN}\b`, "g"),
  },
  {
    id: "new-instructions",
    severity: "error",
    message: "Claims to give the model a new system prompt or new instructions.",
    regex: new RegExp(String.raw`\b(?:new|updated|real|actual|true|revised|override|overriding)${W}(?:system${W}prompt|system${W}message|system${W}instructions?|developer${W}(?:message|instructions?))\b|\byour${W}(?:new|real|actual|true)${W}(?:instructions?|orders|rules|directives?)${W}(?:are|is)\b|\bsystem${W}override\b|\bnya${W}(?:instruktioner|systemprompt)\b`, "g"),
  },
  {
    id: "role-hijack",
    severity: "error",
    message: "Tries to change the model's role or remove its rules.",
    regex: new RegExp(String.raw`\byou${W}are${W}now${W}(?:(?:a|an|the|my|in)${W})?${HIJACK_TERMS}|${SV}du${W}[äa]r${W}nu${W}(?:(?:en|ett)${W})?(?:dan\b|obegr[äa]nsad|ofiltrerad|systemet|utvecklaren|admin)`, "g"),
  },
  {
    id: "role-hijack",
    severity: "error",
    message: "Asks the model to act as the system, the developer or an unrestricted model.",
    regex: new RegExp(String.raw`\b(?:act|behave|respond|answer|speak)${W}as${W}(?:(?:if${W}you${W}(?:are|were)${W})?(?:the|a|an|my)${W})?(?:system|developer|administrator|admin|root|operator|jailbroken|unrestricted|unfiltered|dan\b)|\bpretend${W}(?:to${W}be|you${W}are|you're)${W}(?:(?:the|a|an)${W})?(?:system|developer|administrator|unrestricted|jailbroken|dan\b)|\b(?:enable|activate|enter|switch${W}to)${W}(?:developer|dan|god|jailbreak)${W}mode\b`, "g"),
  },
  {
    id: "role-hijack",
    severity: "warn",
    message: "Assigns the model a new role; check that it is not an attempt to change it.",
    regex: new RegExp(String.raw`\byou${W}are${W}now${W}(?:a|an)${W}[a-z]+|\bfrom${W}now${W}on${W}you${W}(?:are|will|must|should)\b|${SV}du${W}[äa]r${W}nu${W}(?:en|ett)${W}[a-zåäö]+`, "g"),
  },
  {
    id: "fake-role-marker",
    severity: "error",
    message: "Contains a chat-format marker that imitates a system or assistant turn.",
    regex: /<\|(?:im_start|im_end|system|assistant|user|endoftext)\|>|\[\/?inst\]|<<\/?sys>>|<\/?(?:system|system_prompt|developer|assistant)>/g,
  },
  {
    id: "fake-role-marker",
    severity: "warn",
    message: "A line starts like a chat turn (system:, assistant:, human:); check that it is not a forged turn.",
    regex: /(?:^|\n)[ \t#*>[]*(?:system|assistant|developer|human)\]?[ \t]*:/g,
  },
  {
    id: "system-prompt-leak",
    severity: "error",
    message: "Asks the model to reveal its system prompt or instructions.",
    regex: new RegExp(String.raw`\b(?:reveal|print|show|output|repeat|display|leak|dump|disclose|expose|recite|echo|write${W}out|tell${W}me|give${W}me|share|copy)${W}(?:me${W})?(?:(?:all|the|your|of|back)${W}){0,3}(?:(?:full|entire|complete|original|initial|hidden|secret|exact|verbatim|raw)${W})?(?:system${W}prompt|system${W}message|initial${W}prompt|hidden${W}prompt|developer${W}message|pre-?prompt)|\b(?:reveal|print|show|output|repeat|dump|leak|disclose|recite)${W}(?:me${W})?your${W}(?:(?:full|entire|complete|original|initial|hidden|secret|exact)${W})?(?:instructions|rules|prompt|guidelines)\b|${SV}(?:visa|avsl[öo]ja|skriv${W}ut|upprepa|ber[äa]tta)${W}(?:(?:hela|din|dina|den|de|mig)${W}){0,2}(?:systemprompt(?:en)?|dolda${W}instruktioner)|${SV}(?:visa|avsl[öo]ja|skriv${W}ut|upprepa)${W}(?:(?:mig|hela)${W})?(?:din|dina|era)${W}(?:instruktioner|regler|systemprompt)`, "g"),
  },
  {
    id: "exfiltration-pipe-to-shell",
    severity: "error",
    message: "Downloads something and runs it in a shell.",
    regex: /\b(?:curl|wget|fetch|iwr|invoke-webrequest)\b[^\n|;]{0,400}\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b|\b(?:ba|z)?sh\s+(?:-c\s+)?["']?(?:<\(|\$\()\s*(?:curl|wget)\b|\biex\s*\(?\s*(?:iwr|invoke-webrequest|\(?new-object\s+net\.webclient)/g,
  },
  {
    id: "exfiltration-base64-shell",
    severity: "error",
    message: "Decodes base64 and runs the result in a shell.",
    regex: /\bbase64\s+(?:-d|--decode|-D)\b[^\n]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:exec|eval)\s*\(\s*(?:base64\.b64decode|atob|buffer\.from)\s*\(/g,
  },
  {
    id: "exfiltration-reverse-shell",
    severity: "error",
    message: "Opens a reverse shell or hands a shell to a network connection.",
    regex: /\b(?:nc|ncat|netcat)\b[^\n|;]{0,200}\s-[a-z]*e[a-z]*(?:\s|$)|\/dev\/(?:tcp|udp)\/[\w.-]+\/\d+|\bsocat\b[^\n]{0,200}\bexec:/g,
  },
  {
    id: "exfiltration-secrets",
    severity: "error",
    message: "Sends environment variables, keys or credential files somewhere.",
    regex: new RegExp(
      [
        String.raw`\b(?:env|printenv|set|export\s+-p)\s*\|\s*(?:curl|wget|nc|ncat|netcat|socat|telnet)\b`,
        // Posting a secret variable as data (using one in an Authorization header is normal and not reported).
        String.raw`\b(?:curl|wget|http|httpie)\b[^\n]{0,300}\s(?:-d|--data(?:-binary|-raw|-urlencode)?|--form|--upload-file|--post-data|--post-file|--body-data|--body-file)\b[^\n]{0,300}${SECRET_REF}`,
        // A secret variable inside a URL.
        String.raw`(?:https?:)?\/\/[^\s"'\x60]{0,300}${SECRET_REF}`,
        // Credential files or the whole environment on a network command line.
        String.raw`\b(?:curl|wget|nc|ncat|netcat|socat|scp|rsync|httpie|http)\b[^\n]{0,300}(?:\$\(\s*(?:env|printenv)\b|\x60\s*(?:env|printenv)\b|@\s*\S*\.env\b|id_rsa|id_ed25519|\.aws\/credentials|\/etc\/shadow|\/proc\/self\/environ|\.netrc|\.pgpass)`,
        String.raw`\bjson\.stringify\(\s*process\.env\s*\)`,
        String.raw`\bcat\s+[^\n|]{0,200}(?:\.env\b|id_rsa|id_ed25519|\.aws\/credentials|\.npmrc|\.netrc|\.pgpass)[^\n|]{0,100}\|\s*(?:curl|wget|nc|ncat|netcat|base64)\b`,
        String.raw`\b(?:send|post|upload|forward|e-?mail|leak|exfiltrate|transmit)${W}(?:(?:me|us|all|the|your|any|of)${W}){0,3}(?:api${W}keys?|tokens|secrets|credentials|passwords|env(?:ironment)?${W}variables|\.env${W}file|private${W}keys?|ssh${W}keys?)${W}(?:(?:to|at|via)${W})`,
        String.raw`\b(?:skicka|posta|ladda${W}upp)${W}(?:(?:alla|dina|era)${W})?(?:api-?nycklar|nycklar|tokens|l[öo]senord|hemligheter|milj[öo]variabler)${W}till\b`,
      ].join("|"),
      "g",
    ),
  },
  {
    id: "exfiltration-markdown-image",
    severity: "error",
    message: "A markdown image whose URL carries a query string can leak data when it is rendered.",
    regex: /!\[[^\]\n]{0,300}\]\(\s*<?(?:https?:)?\/\/[^)\s>]*\?[^)\s>]*>?(?:\s+["'][^"'\n]*["'])?\s*\)/g,
  },
  {
    id: "exfiltration-html-image",
    severity: "error",
    message: "An HTML image whose URL carries a query string can leak data when it is rendered.",
    regex: /<img\b[^>]{0,500}\bsrc\s*=\s*["']?(?:https?:)?\/\/[^"'\s>]*\?[^"'\s>]*/g,
  },
];

// ─── Hidden Unicode ─────────────────────────────────────────────────────────────────────────────────────────

type HiddenClass = "zero-width" | "bidi" | "tag";

function hiddenClass(code: number): HiddenClass | null {
  if ((code >= 0x200b && code <= 0x200f) || (code >= 0x2060 && code <= 0x2064) || code === 0xfeff) return "zero-width";
  if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return "bidi";
  if (code >= 0xe0000 && code <= 0xe007f) return "tag";
  return null;
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const BLACK_FLAG = 0x1f3f4;

interface CodePoint {
  code: number;
  index: number;
  length: number;
}

function codePoints(text: string): CodePoint[] {
  const out: CodePoint[] = [];
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i) ?? 0;
    const length = code > 0xffff ? 2 : 1;
    out.push({ code, index: i, length });
    i += length;
  }
  return out;
}

/**
 * Legitimate uses that are not reported: a zero-width joiner inside an emoji sequence (👨\u200D👩\u200D👧) and the tag sequence of
 * a subdivision flag (🏴 + 2 to 6 lower-case tag letters or digits + cancel tag, like the flag of Scotland). A
 * subdivision flag can carry at most six hidden letters, too few for an instruction.
 */
function isAllowedRun(points: CodePoint[], from: number, to: number): boolean {
  const first = points[from];
  const before = points[from - 1];
  const after = points[to + 1];
  if (!first) return false;
  if (from === to && first.code === 0x200d && before && after) {
    return PICTOGRAPHIC.test(String.fromCodePoint(before.code)) && PICTOGRAPHIC.test(String.fromCodePoint(after.code));
  }
  if (before?.code === BLACK_FLAG) {
    const run = points.slice(from, to + 1).map((p) => p.code);
    const last = run[run.length - 1];
    const letters = run.slice(0, -1);
    return (
      last === 0xe007f &&
      letters.length >= 2 &&
      letters.length <= 6 &&
      letters.every((c) => (c >= 0xe0061 && c <= 0xe007a) || (c >= 0xe0030 && c <= 0xe0039))
    );
  }
  return false;
}

function hiddenMessage(kind: HiddenClass, run: CodePoint[]): string {
  if (kind === "bidi") return "Contains bidirectional control characters that can make text display differently from what it says.";
  if (kind === "zero-width") return "Contains invisible zero-width characters that can hide or split words.";
  const hidden = run
    .map((p) => p.code - 0xe0000)
    .filter((c) => c >= 0x20 && c < 0x7f)
    .map((c) => String.fromCharCode(c))
    .join("");
  const preview = hidden.length > 80 ? `${hidden.slice(0, 80)}…` : hidden;
  return `Contains invisible Unicode tag characters (hidden text${preview ? `: "${preview}"` : ""}).`;
}

function scanHidden(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  const points = codePoints(text);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    const kind = hiddenClass(p.code);
    if (!kind) continue;
    let j = i;
    while (j + 1 < points.length && hiddenClass(points[j + 1]?.code ?? 0) === kind) j++;
    const run = points.slice(i, j + 1);
    const last = run[run.length - 1] ?? p;
    const end = last.index + last.length;
    if (!isAllowedRun(points, i, j)) {
      // A byte-order mark at the very start of a file is normal; elsewhere U+FEFF is a zero-width no-break space.
      const bom = i === 0 && j === 0 && p.code === 0xfeff;
      findings.push({
        id: `hidden-${kind === "tag" ? "tag-characters" : kind}`,
        severity: bom ? "warn" : "error",
        message: bom ? "Starts with a byte-order mark (U+FEFF)." : hiddenMessage(kind, run),
        index: p.index,
        excerpt: visibleExcerpt(text, p.index, end),
      });
    }
    i = j;
  }
  return findings;
}

/** Reference-style images (![alt][id] with "[id]: https://…?q=…") leak data the same way as inline ones. */
function scanImageReferences(text: string, norm: ReturnType<typeof normalizeForMatching>): InjectionFinding[] {
  const labels = new Set<string>();
  for (const m of norm.text.matchAll(/!\[[^\]\n]{0,300}\]\[([^\]\n]{1,100})\]/g)) labels.add((m[1] ?? "").trim());
  if (labels.size === 0) return [];
  const findings: InjectionFinding[] = [];
  for (const m of norm.text.matchAll(/^[ \t]{0,3}\[([^\]\n]{1,100})\]:[ \t]*<?(?:https?:)?\/\/\S*\?\S*/gm)) {
    if (!labels.has((m[1] ?? "").trim())) continue;
    const range = originalRange(norm, m.index, m.index + m[0].length);
    findings.push({
      id: "exfiltration-markdown-image",
      severity: "error",
      message: "A markdown image whose URL carries a query string can leak data when it is rendered.",
      index: range.start,
      excerpt: visibleExcerpt(text, range.start, range.end),
    });
  }
  return findings;
}

// ─── Scanner ────────────────────────────────────────────────────────────────────────────────────────────────

function scanText(text: string): InjectionFinding[] {
  const norm = normalizeForMatching(text);
  const findings: InjectionFinding[] = [];
  for (const r of TEXT_RULES) {
    r.regex.lastIndex = 0;
    for (let m = r.regex.exec(norm.text); m !== null; m = r.regex.exec(norm.text)) {
      if (m[0].length === 0) {
        r.regex.lastIndex++;
        continue;
      }
      // Skip a leading newline captured by line-anchored rules.
      const lead = /^\n/.test(m[0]) ? 1 : 0;
      const range = originalRange(norm, m.index + lead, m.index + m[0].length);
      findings.push({
        id: r.id,
        severity: r.severity,
        message: r.message,
        index: range.start,
        excerpt: visibleExcerpt(text, range.start, range.end),
      });
    }
    r.regex.lastIndex = 0;
  }
  findings.push(...scanImageReferences(text, norm));
  return findings;
}

/** Drops a warning that sits on the same spot as an error of the same rule family, and exact duplicates. */
function dedupe(findings: InjectionFinding[]): InjectionFinding[] {
  const errors = findings.filter((f) => f.severity === "error");
  const seen = new Set<string>();
  const out: InjectionFinding[] = [];
  for (const f of findings) {
    const key = `${f.id}:${f.severity}:${f.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (f.severity === "warn" && errors.some((e) => e.id === f.id && Math.abs(e.index - f.index) <= 40)) continue;
    out.push(f);
  }
  return out.sort((a, b) => a.index - b.index || (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}

/**
 * Scans text for prompt-injection signs: instruction overrides (English and Swedish), role hijacks, requests to
 * reveal the system prompt, forged chat markers, hidden Unicode, and exfiltration patterns. Never throws; findings
 * are sorted by position.
 */
export function scanForInjection(input: string): InjectionFinding[] {
  const text = typeof input === "string" ? input : input === null || input === undefined ? "" : String(input);
  if (text === "") return [];
  try {
    return dedupe([...scanHidden(text), ...scanText(text)]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [{ id: "scan-failed", severity: "error", message: `The text could not be scanned (${reason}).`, index: 0, excerpt: "" }];
  }
}

/** True when any finding is an error. */
export function hasInjectionErrors(findings: readonly InjectionFinding[]): boolean {
  return findings.some((f) => f.severity === "error");
}
