/**
 * Fast ISO-10303-21 syntax preflight for untrusted IFC input.
 *
 * Lexical scanning accepts strings or bytes, so large IFC files are checked
 * without allocating a second full-size decoded string. This validates STEP
 * framing only; IFC schema semantics (GUIDs, units, references) remain the
 * responsibility of the normal IFC validation/conversion pipeline.
 */
export function validateIfcStepSyntax(input: string | Uint8Array): string[] {
  const errors: string[] = [];
  const fail = (message: string) => {
    if (errors.length < 8 && !errors.includes(message)) errors.push(message);
  };
  const length = input.length;
  const bom = (typeof input === "string" ? input.charCodeAt(0) : input[0]) === 0xfeff;
  const offset = bom ? 1 : 0;
  const codeAt = (i: number) => typeof input === "string" ? input.charCodeAt(i) : input[i];
  const charAt = (i: number) => String.fromCharCode(codeAt(i) || 0);
  const white = (c: number) => c === 9 || c === 10 || c === 13 || c === 32;
  if (!length) return ["IFC input is empty"];

  // Lexical pass: strings use doubled apostrophes, comments use /* ... */.
  let quote = 0, comment = false, depth = 0;
  for (let i = offset; i < length; i++) {
    const n = codeAt(i + 1), c = codeAt(i);
    if (comment) {
      if (c === 42 && n === 47) { comment = false; i++; }
      continue;
    }
    if (quote) {
      if (quote === 39 && c === 39 && n === 39) { i++; continue; }
      if (c === quote) quote = 0;
      if (c < 32 && !white(c)) fail("STEP contains a control character inside a literal");
      continue;
    }
    if (c === 47 && n === 42) { comment = true; i++; continue; }
    if (c === 42 && n === 47) { fail("STEP contains a comment terminator without an opener"); i++; continue; }
    if (c === 39 || c === 34) { quote = c; continue; }
    if (c < 32 && !white(c)) { fail("STEP contains an illegal control character"); continue; }
    if (c > 126) { fail("STEP contains a non-ASCII byte outside a quoted literal"); continue; }
    if (c === 40) depth++;
    else if (c === 41) {
      depth--;
      if (depth < 0) { fail("STEP contains an unmatched closing parenthesis"); depth = 0; }
    } else if (!/[A-Za-z0-9_#.$*;,=+\-\s]/.test(charAt(i))) {
      fail(`STEP contains illegal unquoted character "${charAt(i)}"`);
    }
  }
  if (quote) fail("STEP contains an unterminated quoted literal");
  if (comment) fail("STEP contains an unterminated block comment");
  if (depth !== 0) fail("STEP contains unbalanced parentheses");
  if (errors.length) return errors;

  // Find section markers only outside strings/comments. This prevents a value
  // such as 'ENDSEC;' from being mistaken for a real Part 21 delimiter.
  const findMarker = (token: string, from: number): { start: number; end: number } | null => {
    let q = 0, inComment = false;
    const upper = token.toUpperCase();
    for (let i = from; i < length; i++) {
      const c = codeAt(i), n = codeAt(i + 1);
      if (inComment) {
        if (c === 42 && n === 47) { inComment = false; i++; }
        continue;
      }
      if (q) {
        if (q === 39 && c === 39 && n === 39) { i++; continue; }
        if (c === q) q = 0;
        continue;
      }
      if (c === 47 && n === 42) { inComment = true; i++; continue; }
      if (c === 39 || c === 34) { q = c; continue; }
      if (i > 0 && /[A-Za-z0-9_]/.test(charAt(i - 1))) continue;
      let matches = true;
      for (let k = 0; k < upper.length; k++) {
        const v = codeAt(i + k);
        if (v == null || String.fromCharCode(v).toUpperCase() !== upper[k]) { matches = false; break; }
      }
      if (!matches) continue;
      const after = i + upper.length;
      if (/[A-Za-z0-9_]/.test(charAt(after))) continue;
      let end = after;
      while (end < length && white(codeAt(end))) end++;
      if (codeAt(end) !== 59) continue;
      return { start: i, end: end + 1 };
    }
    return null;
  };

  const preamble = findMarker("ISO-10303-21", offset);
  if (!preamble || !/^\s*ISO-10303-21\s*;$/i.test(sliceText(offset, preamble.end))) {
    return ["Missing ISO-10303-21; preamble"];
  }
  const headerStart = findMarker("HEADER", preamble.end);
  if (!headerStart) return ["Missing HEADER; section"];
  const headerEnd = findMarker("ENDSEC", headerStart.end);
  if (!headerEnd) return ["Missing ENDSEC; after STEP HEADER"];
  if (headerEnd.start - headerStart.end > 65536) return ["STEP HEADER exceeds 64 KiB syntax limit"];
  const header = sliceText(headerStart.end, headerEnd.start);
  const dataStart = findMarker("DATA", headerEnd.end);
  if (!dataStart) return ["Missing DATA; section"];
  const dataEnd = findMarker("ENDSEC", dataStart.end);
  if (!dataEnd) return ["Missing ENDSEC; after STEP DATA"];
  const terminator = findMarker("END-ISO-10303-21", dataEnd.end);
  if (!terminator) return ["Missing END-ISO-10303-21; terminator"];

  function sliceText(start: number, end: number): string {
    if (typeof input === "string") return input.slice(start, end);
    // Header is bounded above; this helper is only used for the small preamble/header.
    let out = "";
    for (let i = start; i < end; i++) out += String.fromCharCode(input[i]);
    return out;
  }

  function matchingParen(source: string, open: number): number {
    let level = 0, q = 0;
    for (let i = open; i < source.length; i++) {
      const c = source.charCodeAt(i), n = source.charCodeAt(i + 1);
      if (q) {
        if (q === 39 && c === 39 && n === 39) { i++; continue; }
        if (c === q) q = 0;
        continue;
      }
      if (c === 39 || c === 34) q = c;
      else if (c === 40) level++;
      else if (c === 41 && --level === 0) return i;
    }
    return -1;
  }
  function splitArgs(raw: string): string[] {
    const result: string[] = [];
    let start = 0, level = 0, q = 0;
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i), n = raw.charCodeAt(i + 1);
      if (q) {
        if (q === 39 && c === 39 && n === 39) { i++; continue; }
        if (c === q) q = 0;
      } else if (c === 39 || c === 34) q = c;
      else if (c === 40) level++;
      else if (c === 41) level--;
      else if (c === 44 && level === 0) { result.push(raw.slice(start, i).trim()); start = i + 1; }
    }
    const tail = raw.slice(start).trim();
    if (tail || result.length) result.push(tail);
    return result;
  }
  function recordArgs(name: string): string[] | null {
    const re = new RegExp(`\\b${name}\\s*\\(`, "ig");
    const match = re.exec(header);
    if (!match) { fail(`HEADER is missing ${name}(...) record`); return null; }
    const open = header.indexOf("(", match.index);
    const close = matchingParen(header, open);
    if (close < 0) { fail(`HEADER ${name}(...) is unterminated`); return null; }
    if (re.exec(header)) fail(`HEADER contains duplicate ${name}(...) records`);
    return splitArgs(header.slice(open + 1, close));
  }
  const isString = (v: string) => /^'(?:[^']|'')*'$/.test(v);
  const stringList = (v: string, allowEmpty: boolean) => {
    const s = v.trim();
    if (!s.startsWith("(") || !s.endsWith(")")) return false;
    const inner = s.slice(1, -1).trim();
    return inner ? splitArgs(inner).every(isString) : allowEmpty;
  };

  const description = recordArgs("FILE_DESCRIPTION");
  if (description && (description.length !== 2 || !stringList(description[0], false) || !isString(description[1]))) {
    fail("HEADER FILE_DESCRIPTION must contain a string list and implementation-level string");
  }
  const fileName = recordArgs("FILE_NAME");
  if (fileName && (
    fileName.length !== 7 || !isString(fileName[0]) || !isString(fileName[1]) ||
    !stringList(fileName[2], true) || !stringList(fileName[3], true) ||
    !isString(fileName[4]) || !isString(fileName[5]) || !isString(fileName[6])
  )) fail("HEADER FILE_NAME must contain seven ISO 10303-21 fields");
  const schema = recordArgs("FILE_SCHEMA");
  if (schema && (schema.length !== 1 || !stringList(schema[0], false))) {
    fail("HEADER FILE_SCHEMA must contain a non-empty list of quoted schema identifiers");
  }

  // Validate record boundaries without decoding/allocating the full DATA body.
  let statementStart = dataStart.end, statementCount = 0, q = 0, inComment = false, nested = 0;
  const validStart = (start: number, end: number): boolean => {
    let i = start, prefix = "";
    while (i < end) {
      const c = codeAt(i), n = codeAt(i + 1);
      if (white(c)) { i++; continue; }
      if (c === 47 && n === 42) {
        i += 2;
        while (i + 1 < end && !(codeAt(i) === 42 && codeAt(i + 1) === 47)) i++;
        i += 2;
        continue;
      }
      break;
    }
    for (let j = i; j < end && prefix.length < 128; j++) prefix += charAt(j);
    return /^#\d+\s*=\s*(?:[A-Z][A-Z0-9_]*\s*\(|\(\s*[A-Z][A-Z0-9_]*\s*\()/i.test(prefix);
  };
  for (let i = dataStart.end; i < dataEnd.start; i++) {
    const c = codeAt(i), n = codeAt(i + 1);
    if (inComment) {
      if (c === 42 && n === 47) { inComment = false; i++; }
      continue;
    }
    if (q) {
      if (q === 39 && c === 39 && n === 39) { i++; continue; }
      if (c === q) q = 0;
      continue;
    }
    if (c === 47 && n === 42) { inComment = true; i++; continue; }
    if (c === 39 || c === 34) { q = c; continue; }
    if (c === 40) nested++;
    else if (c === 41) nested--;
    else if (c === 59 && nested === 0) {
      if (!validStart(statementStart, i)) fail(`DATA statement ${statementCount + 1} is not a #id=ENTITY(...) record`);
      statementCount++;
      statementStart = i + 1;
      if (errors.length) break;
    }
  }
  if (!errors.length) {
    let i = statementStart;
    while (i < dataEnd.start) {
      if (white(codeAt(i))) { i++; continue; }
      if (codeAt(i) === 47 && codeAt(i + 1) === 42) {
        i += 2;
        while (i + 1 < dataEnd.start && !(codeAt(i) === 42 && codeAt(i + 1) === 47)) i++;
        i += 2;
        continue;
      }
      fail("DATA contains a record without its terminating semicolon");
      break;
    }
  }
  if (statementCount === 0) fail("DATA section contains no entity instances");

  // Nothing but whitespace/comments may follow the final ISO terminator.
  for (let i = terminator.end; i < length; i++) {
    if (!white(codeAt(i))) { fail("Unexpected content after END-ISO-10303-21"); break; }
  }
  return errors;
}
