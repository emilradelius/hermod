// @ts-check
/**
 * Frontmatter parser for SKILL.md files: the block between a "---" first line and the next "---" line,
 * read as a subset of YAML. It never throws; anything it does not support is reported as an error with a
 * line number, so a malformed skill fails validation instead of crashing a hook.
 *
 * Supported: "key: value" maps nested by indentation; "- item" lists (also directly under a key, and
 * items that are maps); flow lists on one line ("[a, "b, c"]"); plain, 'single' and "double" quoted
 * scalars; "|" and ">" block scalars with chomping ("-" / "+") and an indentation digit; plain scalars
 * continued on more-indented lines; true/false, null/~, integers and floats (YAML 1.2 core schema);
 * comments; CRLF line endings; a leading BOM.
 * Not supported (reported as errors): flow maps ({a: b}), anchors, aliases and tags (&a, *a, !tag),
 * complex keys ("? "), multi-line quoted scalars, tabs used for indentation, duplicate keys, and plain
 * values that contain ": " (YAML parsers reject them; wrap such values in quotes).
 */

/**
 * @typedef {object} FrontmatterResult
 * @property {boolean} found the text starts with a "---" line
 * @property {Record<string, unknown> | null} data the parsed map (null when missing or not a map); with
 *   errors it holds what could be read
 * @property {string} body the text after the closing "---" (line endings normalised to "\n")
 * @property {number} bodyStartLine 1-based line number in the original text where body starts
 * @property {string[]} errors "line N: ..." messages
 */

/**
 * @typedef {object} Line
 * @property {number} n 1-based line number in the original text
 * @property {string} raw
 * @property {number} indent leading spaces
 * @property {boolean} tab indentation contains a tab
 * @property {string} content the text after the indentation
 * @property {boolean} skip blank or comment-only
 */

const MAX_DEPTH = 32;

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {unknown} value
 */
function setKey(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Resolves a plain scalar per the YAML 1.2 core schema.
 * @param {string} s
 * @returns {unknown}
 */
export function resolvePlainScalar(s) {
  if (s === "" || s === "~" || /^(?:null|Null|NULL)$/.test(s)) return null;
  if (/^(?:true|True|TRUE)$/.test(s)) return true;
  if (/^(?:false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?[0-9]+$/.test(s)) return Number(s);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

/** @type {Record<string, string>} */
const ESCAPES = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: String.fromCharCode(0x85),
  _: String.fromCharCode(0xa0),
  L: String.fromCharCode(0x2028),
  P: String.fromCharCode(0x2029),
};

/**
 * Reads a quoted scalar that starts at s[start].
 * @param {string} s
 * @param {number} start
 * @returns {{ value: string, end: number } | { error: string }}
 */
function readQuoted(s, start) {
  const q = s[start];
  let out = "";
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return { value: out, end: i + 1 };
      }
      out += c;
      continue;
    }
    if (c === '"') return { value: out, end: i + 1 };
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = s[i + 1];
    if (e === undefined) break;
    const hex = e === "x" ? 2 : e === "u" ? 4 : e === "U" ? 8 : 0;
    if (hex > 0) {
      const digits = s.slice(i + 2, i + 2 + hex);
      if (!new RegExp(`^[0-9a-fA-F]{${hex}}$`).test(digits)) return { error: `bad escape "\\${e}${digits}"` };
      const cp = parseInt(digits, 16);
      if (cp > 0x10ffff) return { error: `bad escape "\\${e}${digits}"` };
      out += String.fromCodePoint(cp);
      i += 1 + hex;
      continue;
    }
    if (!(e in ESCAPES)) return { error: `unknown escape "\\${e}" in a double-quoted value` };
    out += ESCAPES[e];
    i++;
  }
  return { error: "the quoted value is not closed on the same line (multi-line quoted values are not supported)" };
}

/**
 * Splits "key: rest". Returns null when the line is not a key/value pair.
 * @param {string} content
 * @returns {{ key: string, rest: string, quoted: boolean } | { error: string } | null}
 */
function splitKey(content) {
  if (content[0] === '"' || content[0] === "'") {
    const q = readQuoted(content, 0);
    if ("error" in q) return null;
    const m = /^[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/.exec(content.slice(q.end));
    return m ? { key: q.value, rest: (m[1] ?? "").trim(), quoted: true } : null;
  }
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === "#" && i > 0 && /[ \t]/.test(content[i - 1])) return null;
    if (c === ":" && (i + 1 === content.length || content[i + 1] === " " || content[i + 1] === "\t")) {
      const key = content.slice(0, i).trimEnd();
      if (key === "") return null;
      return { key, rest: content.slice(i + 1).trim(), quoted: false };
    }
  }
  return null;
}

/**
 * @param {string} content
 * @returns {boolean}
 */
function isSeqItem(content) {
  return content === "-" || content.startsWith("- ") || content.startsWith("-\t");
}

/**
 * Removes a trailing " # comment" from a plain scalar.
 * @param {string} s
 * @returns {string}
 */
function stripComment(s) {
  const m = /(^|[ \t])#/.exec(s);
  return (m ? s.slice(0, m.index) : s).trim();
}

/**
 * Parses YAML-subset lines.
 * @param {string[]} rawLines
 * @param {number} firstLine line number of rawLines[0] in the original text
 * @returns {{ value: unknown, errors: string[] }}
 */
export function parseYamlLines(rawLines, firstLine = 1) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Line[]} */
  const lines = rawLines.map((raw, i) => {
    const m = /^([ \t]*)(.*)$/.exec(raw);
    const lead = m ? m[1] : "";
    const content = m ? m[2] : raw;
    const spaces = /^ */.exec(lead)?.[0].length ?? 0;
    return {
      n: firstLine + i,
      raw,
      indent: spaces,
      tab: lead.includes("\t"),
      content: content.trimEnd(),
      skip: content.trim() === "" || content.trimStart().startsWith("#"),
    };
  });
  let pos = 0;
  /**
   * @param {Line | { n: number }} line
   * @param {string} message
   */
  const error = (line, message) => {
    if (errors.length < 50) errors.push(`line ${line.n}: ${message}`);
  };
  const skipBlank = () => {
    while (pos < lines.length && lines[pos].skip) pos++;
  };
  /** @param {number} indent */
  const skipDeeper = (indent) => {
    while (pos < lines.length && (lines[pos].skip || lines[pos].indent > indent)) pos++;
  };

  /**
   * @param {number} indent
   * @param {number} depth
   * @returns {unknown}
   */
  function parseNode(indent, depth) {
    if (depth > MAX_DEPTH) {
      error(lines[pos], "the frontmatter is nested too deeply");
      skipDeeper(indent - 1);
      return null;
    }
    skipBlank();
    const line = lines[pos];
    if (!line) return null;
    if (line.tab) error(line, "indentation uses a tab; use spaces");
    return isSeqItem(line.content) ? parseSeq(indent, depth) : parseMap(indent, depth);
  }

  /**
   * @param {number} indent
   * @param {number} depth
   * @returns {Record<string, unknown>}
   */
  function parseMap(indent, depth) {
    /** @type {Record<string, unknown>} */
    const obj = {};
    for (;;) {
      skipBlank();
      const line = lines[pos];
      if (!line || line.indent < indent) break;
      if (line.indent > indent) {
        error(line, "unexpected indentation");
        skipDeeper(indent);
        continue;
      }
      if (isSeqItem(line.content)) {
        error(line, 'a "- item" cannot appear between "key: value" lines at the same indentation');
        skipDeeper(indent);
        if (lines[pos] && lines[pos].indent === indent && isSeqItem(lines[pos].content)) pos++;
        continue;
      }
      if (line.tab) error(line, "indentation uses a tab; use spaces");
      const kv = splitKey(line.content);
      if (kv === null || "error" in kv) {
        error(line, `expected "key: value" (got ${JSON.stringify(line.content.slice(0, 40))})`);
        pos++;
        skipDeeper(indent);
        continue;
      }
      if (!kv.quoted && /^[[\]{},&*!|>%@`?'"#-]/.test(kv.key) && !/^-[^\s-]/.test(kv.key)) {
        error(line, `key ${JSON.stringify(kv.key)} starts with a special character; wrap it in quotes`);
      }
      if (Object.prototype.hasOwnProperty.call(obj, kv.key)) error(line, `duplicate key "${kv.key}"`);
      pos++;
      setKey(obj, kv.key, parseValue(kv.rest, line, indent, depth, kv.key));
    }
    return obj;
  }

  /**
   * @param {number} indent
   * @param {number} depth
   * @returns {unknown[]}
   */
  function parseSeq(indent, depth) {
    /** @type {unknown[]} */
    const arr = [];
    for (;;) {
      skipBlank();
      const line = lines[pos];
      if (!line || line.indent < indent) break;
      if (line.indent > indent) {
        error(line, "unexpected indentation");
        skipDeeper(indent);
        continue;
      }
      if (!isSeqItem(line.content)) break;
      if (line.tab) error(line, "indentation uses a tab; use spaces");
      const after = line.content.slice(1);
      const item = after.trimStart();
      const offset = 1 + (after.length - item.length);
      if (item === "" || item.startsWith("#")) {
        pos++;
        skipBlank();
        const next = lines[pos];
        arr.push(next && next.indent > indent ? parseNode(next.indent, depth + 1) : null);
        continue;
      }
      const kv = isSeqItem(item) ? null : splitKey(item);
      if (isSeqItem(item) || (kv !== null && !("error" in kv))) {
        lines[pos] = { ...line, indent: indent + offset, content: item, tab: false };
        arr.push(parseNode(indent + offset, depth + 1));
        continue;
      }
      pos++;
      arr.push(parseValue(item, line, indent, depth, null));
    }
    return arr;
  }

  /**
   * @param {string} rest the text after "key:" or "- "
   * @param {Line} line
   * @param {number} indent indentation of the key or of the "-"
   * @param {number} depth
   * @param {string | null} key for messages
   * @returns {unknown}
   */
  function parseValue(rest, line, indent, depth, key) {
    const what = key === null ? "this list item" : `the value of "${key}"`;
    if (rest === "" || rest.startsWith("#")) {
      skipBlank();
      const next = lines[pos];
      if (next && next.indent > indent) return parseNode(next.indent, depth + 1);
      if (next && key !== null && next.indent === indent && isSeqItem(next.content)) return parseSeq(indent, depth + 1);
      return null;
    }
    const c = rest[0];
    if (c === "|" || c === ">") return parseBlockScalar(rest, line, indent);
    if (c === "[") return parseFlowSeq(rest, line);
    if (c === "{") {
      error(line, `${what} is a flow map ({...}), which is not supported; put one "key: value" per line`);
      return null;
    }
    if (c === '"' || c === "'") {
      const q = readQuoted(rest, 0);
      if ("error" in q) {
        error(line, `${what}: ${q.error}`);
        return null;
      }
      const tail = rest.slice(q.end);
      if (tail.trim() !== "" && !/^[ \t]+#/.test(tail)) {
        error(line, `${what} has text after the closing quote; quote the whole value`);
      }
      return q.value;
    }
    if (c === "&" || c === "*" || c === "!") {
      error(line, `${what} uses a YAML anchor, alias or tag (${c}), which is not supported`);
      return null;
    }
    if (c === "%" || c === "@" || c === "`") {
      error(line, `${what} cannot start with "${c}" unquoted; wrap it in quotes`);
      return null;
    }
    if ((c === "-" || c === "?" || c === ":") && (rest.length === 1 || /[ \t]/.test(rest[1]))) {
      error(line, `${what} starts with "${c} "; put a list on the next lines or wrap the value in quotes`);
      return null;
    }
    return parsePlain(rest, line, indent, what);
  }

  /**
   * @param {string} rest
   * @param {Line} line
   * @param {number} indent
   * @param {string} what
   * @returns {unknown}
   */
  function parsePlain(rest, line, indent, what) {
    const first = stripComment(rest);
    /** @param {string} s @param {Line} l */
    const checkColon = (s, l) => {
      if (/:[ \t]/.test(s) || s.endsWith(":")) {
        error(l, `${what} contains ": ", which YAML does not allow in an unquoted value; wrap the whole value in quotes`);
      }
    };
    checkColon(first, line);
    // Continuation lines (indented deeper than the key) fold into one value: a line break becomes a
    // space, each blank line between them a "\n".
    let value = first;
    let continued = false;
    let blankRun = 0;
    for (let k = pos; k < lines.length; k++) {
      const l = lines[k];
      if (l.content.trim() === "") {
        blankRun++;
        continue;
      }
      if (l.indent <= indent || l.content.trimStart().startsWith("#")) break;
      const text = stripComment(l.content);
      checkColon(text, l);
      value += (blankRun > 0 ? "\n".repeat(blankRun) : " ") + text;
      blankRun = 0;
      continued = true;
      pos = k + 1;
    }
    return continued ? value : resolvePlainScalar(first);
  }

  /**
   * @param {string} header "|", ">-", "|2+", ...
   * @param {Line} line
   * @param {number} indent indentation of the key
   * @returns {string}
   */
  function parseBlockScalar(header, line, indent) {
    const m = /^([|>])(?:([+-])([1-9])?|([1-9])([+-])?)?[ \t]*(?:#.*)?$/.exec(header);
    if (!m) {
      error(line, `block value header ${JSON.stringify(header)} is not valid (use |, |-, |+, >, >- or >+)`);
      skipDeeper(indent);
      return "";
    }
    const folded = m[1] === ">";
    const chomp = m[2] ?? m[5] ?? "";
    const explicit = Number(m[3] ?? m[4] ?? 0);
    let blockIndent = explicit > 0 ? indent + explicit : 0;
    /** @type {string[]} */
    const collected = [];
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.raw.trim() === "") {
        collected.push("");
        pos++;
        continue;
      }
      const ind = /^ */.exec(l.raw)?.[0].length ?? 0;
      if (ind <= indent) break;
      if (blockIndent === 0) blockIndent = ind;
      if (ind < blockIndent) {
        error(l, "a line in this block value is indented less than the first line");
        pos++;
        continue;
      }
      collected.push(l.raw.slice(blockIndent));
      pos++;
    }
    let result = "";
    let empty = 0;
    let moreIndented = false;
    let hasContent = false;
    for (const s of collected) {
      if (s === "") {
        empty++;
        continue;
      }
      const isMore = s[0] === " " || s[0] === "\t";
      if (folded) {
        if (isMore) {
          moreIndented = true;
          result += "\n".repeat(hasContent ? 1 + empty : empty);
        } else if (moreIndented) {
          moreIndented = false;
          result += "\n".repeat(empty + 1);
        } else if (empty === 0) {
          if (hasContent) result += " ";
        } else {
          result += "\n".repeat(empty);
        }
      } else {
        result += "\n".repeat(hasContent ? 1 + empty : empty);
      }
      result += s;
      hasContent = true;
      empty = 0;
    }
    if (chomp === "+") result += "\n".repeat(hasContent ? 1 + empty : empty);
    else if (chomp === "" && hasContent) result += "\n";
    return result;
  }

  /**
   * @param {string} rest starts with "["
   * @param {Line} line
   * @returns {unknown[] | null}
   */
  function parseFlowSeq(rest, line) {
    /** @type {unknown[]} */
    const out = [];
    let i = 1;
    let expectItem = true;
    for (;;) {
      while (i < rest.length && /[ \t]/.test(rest[i])) i++;
      if (i >= rest.length) {
        error(line, "the [list] is not closed on the same line (multi-line flow lists are not supported)");
        return null;
      }
      const c = rest[i];
      if (c === "]") {
        i++;
        break;
      }
      if (c === ",") {
        if (expectItem) {
          error(line, "the [list] has an empty item");
          return null;
        }
        expectItem = true;
        i++;
        continue;
      }
      if (!expectItem) {
        error(line, "items in a [list] must be separated by commas");
        return null;
      }
      if (c === "[" || c === "{") {
        error(line, "nested lists or maps inside [ ] are not supported");
        return null;
      }
      if (c === '"' || c === "'") {
        const q = readQuoted(rest, i);
        if ("error" in q) {
          error(line, q.error);
          return null;
        }
        out.push(q.value);
        i = q.end;
      } else {
        let j = i;
        while (j < rest.length && !/[,\]]/.test(rest[j])) j++;
        const token = rest.slice(i, j).trim();
        if (/[[{}]|:[ \t]|^[&*!]|[ \t]#/.test(token)) {
          error(line, `the [list] item ${JSON.stringify(token)} needs quotes`);
          return null;
        }
        out.push(resolvePlainScalar(token));
        i = j;
      }
      expectItem = false;
    }
    const tail = rest.slice(i);
    if (tail.trim() !== "" && !/^[ \t]+#/.test(tail)) error(line, "there is text after the closing ] of the list");
    return out;
  }

  skipBlank();
  if (pos >= lines.length) return { value: null, errors };
  const top = lines[pos];
  const value = parseNode(top.indent, 0);
  skipBlank();
  if (pos < lines.length) error(lines[pos], "unexpected text (check the indentation)");
  return { value, errors };
}

/**
 * Splits a markdown file into frontmatter and body and parses the frontmatter. Never throws.
 * @param {unknown} text
 * @returns {FrontmatterResult}
 */
export function parseFrontmatter(text) {
  let src = String(text ?? "");
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const lines = src.split(/\r?\n/);
  if (!/^---[ \t]*$/.test(lines[0] ?? "")) {
    return { found: false, data: null, body: lines.join("\n"), bodyStartLine: 1, errors: [] };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return {
      found: true,
      data: null,
      body: "",
      bodyStartLine: lines.length + 1,
      errors: ["line 1: the frontmatter is not closed; add a line with --- after the last key"],
    };
  }
  /** @type {{ value: unknown, errors: string[] }} */
  let parsed;
  try {
    parsed = parseYamlLines(lines.slice(1, close), 2);
  } catch (error) {
    parsed = { value: null, errors: [`line 2: the frontmatter could not be read (${error instanceof Error ? error.message : error})`] };
  }
  /** @type {Record<string, unknown> | null} */
  let data = null;
  const v = parsed.value;
  if (v === null || v === undefined) {
    data = parsed.errors.length === 0 ? {} : null;
  } else if (typeof v === "object" && !Array.isArray(v)) {
    data = /** @type {Record<string, unknown>} */ (v);
  } else {
    parsed.errors.push('line 2: the frontmatter must be "key: value" lines');
  }
  return { found: true, data, body: lines.slice(close + 1).join("\n"), bodyStartLine: close + 2, errors: parsed.errors };
}
