/**
 * Fast ISO-10303-21 lexical/structural preflight for untrusted IFC input.
 *
 * This deliberately does not validate IFC semantics (GUIDs, references, units,
 * entity schemas). It verifies the Part 21 envelope and record/token framing
 * before web-ifc/WASM is allowed to parse attacker-controlled bytes.
 */
export function validateIfcStepSyntax(input: string): string[] {
  const errors: string[] = [];
  const fail = (message: string) => {
    if (errors.length < 8 && !errors.includes(message)) errors.push(message);
  };
  const text = String(input ?? "").replace(/^\uFEFF/, "");
  if (!text.trim()) return ["IFC input is empty"];

  // Scan once, respecting STEP strings, BINARY literals and block comments.
  // STEP uses doubled apostrophes inside strings; IFC's \\X2\\ / \\X4\\
  // escape directives are ordinary characters while inside a string.
  let quote: "'" | '"' | null = null;
  let comment = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (comment) {
      if (c === "*" && next === "/") { comment = false; i++; }
      continue;
    }
    if (quote) {
      if (quote === "'" && c === "'" && next === "'") { i++; continue; }
      if (c === quote) quote = null;
      if (c === "\r" || c === "\n" || c === "\t") continue;
      if (c.charCodeAt(0) < 0x20) fail("STEP contains a control character inside a literal");
      continue;
    }
    if (c === "/" && next === "*") { comment = true; i++; continue; }
    if (c === "*" && next === "/") { fail("STEP contains a comment terminator without an opener"); i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    const code = c.charCodeAt(0);
    if (code < 0x20 && c !== "\r" && c !== "\n" && c !== "\t") {
      fail("STEP contains an illegal control character");
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth < 0) { fail("STEP contains an unmatched closing parenthesis"); depth = 0; }
    }
    // ISO 10303-21 unquoted tokens are identifiers, numbers, enums, references
    // and the punctuation in this allow-list. Arbitrary &, %, /, @, etc. must
    // be represented inside a quoted string or are malformed input.
    else if (!/[A-Za-z0-9_#.$*;,=+\\-\\s]/.test(c)) {
      fail(`STEP contains illegal unquoted character "${c}"`);
    }
  }
  if (quote) fail("STEP contains an unterminated quoted literal");
  if (comment) fail("STEP contains an unterminated block comment");
  if (depth !== 0) fail("STEP contains unbalanced parentheses");
  if (errors.length) return errors;

  const headerStart = /^\s*ISO-10303-21\s*;\s*HEADER\s*;/i.exec(text);
  if (!headerStart) return ["Missing ISO-10303-21; HEADER; preamble"];

  const headerEndMatch = /\bENDSEC\s*;/ig;
  headerEndMatch.lastIndex = headerStart[0].length;
  const headerEnd = headerEndMatch.exec(text);
  if (!headerEnd) return ["Missing ENDSEC; after the STEP HEADER section"];
  const header = text.slice(headerStart[0].length, headerEnd.index);

  const dataStartRe = /\bDATA\s*;/ig;
  dataStartRe.lastIndex = headerEndMatch.lastIndex;
  const dataStart = dataStartRe.exec(text);
  if (!dataStart) return ["Missing DATA; section"];
  const dataEndRe = /\bENDSEC\s*;/ig;
  dataEndRe.lastIndex = dataStartRe.lastIndex;
  const dataEnd = dataEndRe.exec(text);
  if (!dataEnd) return ["Missing ENDSEC; after the STEP DATA section"];
  const dataBody = text.slice(dataStartRe.lastIndex, dataEnd.index);
  const terminator = /\bEND-ISO-10303-21\s*;/ig;
  terminator.lastIndex = dataEndRe.lastIndex;
  if (!terminator.exec(text)) return ["Missing END-ISO-10303-21; terminator"];

  function matchingParen(source: string, open: number): number {
    let level = 0;
    let q: "'" | '"' | null = null;
    for (let i = open; i < source.length; i++) {
      const c = source[i], n = source[i + 1];
      if (q) {
        if (q === "'" && c === "'" && n === "'") { i++; continue; }
        if (c === q) q = null;
        continue;
      }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === "(") level++;
      else if (c === ")" && --level === 0) return i;
    }
    return -1;
  }

  function splitArgs(raw: string): string[] {
    const result: string[] = [];
    let start = 0, level = 0;
    let q: "'" | '"' | null = null;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i], n = raw[i + 1];
      if (q) {
        if (q === "'" && c === "'" && n === "'") { i++; continue; }
        if (c === q) q = null;
      } else if (c === "'" || c === '"') q = c;
      else if (c === "(") level++;
      else if (c === ")") level--;
      else if (c === "," && level === 0) { result.push(raw.slice(start, i).trim()); start = i + 1; }
    }
    const tail = raw.slice(start).trim();
    if (tail || result.length) result.push(tail);
    return result;
  }

  function recordArgs(section: string, name: string): string[] | null {
    const re = new RegExp(`\\b${name}\\s*\\(`, "ig");
    const match = re.exec(section);
    if (!match) { fail(`HEADER is missing ${name}(...) ` .trim()); return null; }
    const open = section.indexOf("(", match.index);
    const close = matchingParen(section, open);
    if (close < 0) { fail(`HEADER ${name}(...) is unterminated`); return null; }
    if (re.exec(section)) { fail(`HEADER contains duplicate ${name}(...) records`); }
    return splitArgs(section.slice(open + 1, close));
  }

  const isString = (value: string) =>
    /^'(?:[^']|'')*'$/.test(value);
  const stringList = (value: string, allowEmpty: boolean) => {
    const v = value.trim();
    if (!v.startsWith("(") || !v.endsWith(")")) return false;
    const inside = v.slice(1, -1).trim();
    if (!inside) return allowEmpty;
    return splitArgs(inside).every(isString);
  };

  const description = recordArgs(header, "FILE_DESCRIPTION");
  if (description && (description.length !== 2 || !stringList(description[0], false) || !isString(description[1]))) {
    fail("HEADER FILE_DESCRIPTION must contain a string list and an implementation-level string");
  }
  const fileName = recordArgs(header, "FILE_NAME");
  if (fileName && (
    fileName.length !== 7 ||
    !isString(fileName[0]) || !isString(fileName[1]) ||
    !stringList(fileName[2], true) || !stringList(fileName[3], true) ||
    !isString(fileName[4]) || !isString(fileName[5]) || !isString(fileName[6])
  )) {
    fail("HEADER FILE_NAME must contain its seven ISO 10303-21 fields");
  }
  const schema = recordArgs(header, "FILE_SCHEMA");
  if (schema && (schema.length !== 1 || !stringList(schema[0], false))) {
    fail("HEADER FILE_SCHEMA must contain a non-empty list of quoted schema identifiers");
  }

  // DATA is a sequence of semicolon-terminated entity instances. A complex
  // entity instance starts with '('; both forms are supported.
  const statements = splitArgs(dataBody.replace(/;/g, ","));
  // splitArgs splits top-level commas, not semicolons: use a purpose-built
  // statement scanner so semicolons inside strings or nested values are safe.
  const entityStatements: string[] = [];
  let statementStart = 0, level = 0;
  let q: "'" | '"' | null = null;
  for (let i = 0; i < dataBody.length; i++) {
    const c = dataBody[i], n = dataBody[i + 1];
    if (q) {
      if (q === "'" && c === "'" && n === "'") { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === "(") level++;
    else if (c === ")") level--;
    else if (c === ";" && level === 0) {
      const statement = dataBody.slice(statementStart, i).trim();
      if (statement) entityStatements.push(statement);
      statementStart = i + 1;
    }
  }
  const remainder = dataBody.slice(statementStart).trim();
  if (remainder) fail("DATA contains an instance without a terminating semicolon");
  if (!entityStatements.length) fail("DATA section contains no entity instances");
  for (let i = 0; i < entityStatements.length; i++) {
    const s = entityStatements[i];
    if (!/^#\d+\s*=\s*(?:[A-Z][A-Z0-9_]*\s*\(|\(\s*[A-Z][A-Z0-9_]*\s*\()/i.test(s)) {
      fail(`DATA instance ${i + 1} is not a valid #id=ENTITY(...) record`);
      break;
    }
  }

  return errors;
}
