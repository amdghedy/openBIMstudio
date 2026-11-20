/**
 * Bounded structural pre-flight for ISO-10303-21 (STEP / IFC SPF) files.
 *
 * Purpose: untrusted bytes must not reach the WASM parser when they are plainly corrupt. One O(n) pass,
 * no allocation proportional to the file, no recursion. It checks ONLY structure that every conforming
 * exporter produces (and the parser needs), so valid files are never rejected for style:
 *   - starts with `ISO-10303-21;`, has HEADER … ENDSEC; DATA; … ENDSEC; and the `END-ISO-10303-21;` terminator;
 *   - 'strings' (with '' escapes) and block comments are terminated;
 *   - parentheses balance within a record, nesting stays below MAX_DEPTH, `;` never appears inside open parens;
 *   - every DATA record is `#<id> = …;`;
 *   - no control bytes or raw non-ASCII bytes outside strings and comments;
 *   - every `.` is part of a real number or a well-formed `.NAME.` enumeration
 *     (issue #231: web-ifc's tokenizer reads a leading-dot-less enum name as a
 *     LABEL and the following `.` as an ENUM start that swallows everything —
 *     including `;` record terminators — up to the next `.` in the file, so
 *     OpenModel never terminates; a lone `.` after a label that is not an
 *     enumeration close is the same defect).
 * It does NOT validate the schema, entity names or references — that remains the parser's job.
 */

export interface StepPreflightResult {
  ok: boolean;
  /** Human-readable reason when !ok (safe to show to the user). */
  reason?: string;
  /** 1-based line of the problem when known. */
  line?: number;
}

const MAX_DEPTH = 256;
/** Long pure-digit tokens in DATA usually mean adversarial list counts; valid IFC stays well below this. */
const MAX_DIGIT_RUN = 18;
/** Hard cap on DATA entity instances for browser-side parse safety. */
const MAX_DATA_RECORDS = 1_000_000;
const HEADER_MAGIC = "ISO-10303-21;";
const TAIL_MAGIC = "END-ISO-10303-21;";

const isWs = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
/** Letters, digits and `_`: the characters of an enumeration name or label. */
const isEnumName = (c: number): boolean =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || isDigit(c) || c === 0x5f;
const isLetter = (c: number): boolean =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

function startsWithAt(b: Uint8Array, i: number, s: string): boolean {
  if (i + s.length > b.length) return false;
  for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false;
  return true;
}

export function preflightStep(bytes: Uint8Array): StepPreflightResult {
  const n = bytes.length;
  let line = 1;
  const fail = (reason: string): StepPreflightResult => ({ ok: false, reason, line });

  let i = 0;
  if (n >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3; // UTF-8 BOM
  while (i < n && isWs(bytes[i])) { if (bytes[i] === 0x0a) line++; i++; }
  if (!startsWithAt(bytes, i, HEADER_MAGIC)) return fail("Not a STEP/IFC file: missing the ISO-10303-21; header");
  i += HEADER_MAGIC.length;

  type Section = "top" | "header" | "data" | "after";
  let section: Section = "top";
  let depth = 0;
  let inRecord = false;
  let sawData = false;
  let sawTail = false;
  let stmtStart = i;
  let dataRecords = 0;
  let digitRun = 0;

  while (i < n) {
    const c = bytes[i];

    if (c === 0x0a) { line++; i++; continue; }
    if (isWs(c)) { i++; continue; }

    // block comment
    if (c === 0x2f && i + 1 < n && bytes[i + 1] === 0x2a) {
      i += 2;
      let closed = false;
      while (i < n) {
        if (bytes[i] === 0x0a) line++;
        if (bytes[i] === 0x2a && i + 1 < n && bytes[i + 1] === 0x2f) { i += 2; closed = true; break; }
        i++;
      }
      if (!closed) return fail("Unterminated /* comment */");
      continue;
    }

    // string literal: '...' with '' as an escaped quote
    if (c === 0x27) {
      if (!inRecord) { inRecord = true; stmtStart = i; }
      i++;
      let closed = false;
      while (i < n) {
        const d = bytes[i];
        if (d === 0x0a) line++;
        if (d === 0x27) {
          if (i + 1 < n && bytes[i + 1] === 0x27) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) return fail("Unterminated 'string'");
      continue;
    }

    if (c < 0x20 || c >= 0x7f) return fail(`Unexpected byte 0x${c.toString(16)} outside a string`);

    // Extreme integer tokens (e.g. 1e18-wide counts) are a common hang vector for WASM parsers.
    if (isDigit(c)) {
      digitRun++;
      if (digitRun > MAX_DIGIT_RUN) return fail(`Integer token longer than ${MAX_DIGIT_RUN} digits`);
    } else {
      digitRun = 0;
    }

    if (c === 0x2e /* . */) {
      // A '.' is either part of a real number or an enumeration delimiter.
      // A '.' followed by a letter can only open an enumeration, so it must
      // be a well-formed '.NAME.' (name = letters/digits/'_', optional
      // whitespace, closing '.'). Otherwise the parser reads the name as a
      // bare LABEL and the next '.' as an ENUM start that swallows the rest
      // of the file up to the following '.' — including ';' terminators —
      // and OpenModel never terminates (issue #231).
      const next = i + 1 < n ? bytes[i + 1] : -1;
      if (isLetter(next)) {
        let j = i + 1;
        while (j < n && isEnumName(bytes[j])) j++;
        // '1.E-05' is a real number, not an enumeration: a lone 'E'/'e'
        // followed by an optional sign and a digit is an exponent.
        const loneE = j === i + 2 && (next === 0x45 || next === 0x65);
        let e = j;
        if (loneE && e < n && (bytes[e] === 0x2b || bytes[e] === 0x2d)) e++;
        if (loneE && e < n && isDigit(bytes[e])) {
          // Real-number exponent — not an enumeration, nothing to check.
        } else {
          while (j < n && isWs(bytes[j])) j++;
          if (j >= n || bytes[j] !== 0x2e) return fail("Malformed enumeration: '.' must close with '.' after the name");
        }
      } else {
        // A '.' right after a label must be the closing dot of an
        // enumeration opened by a '.' (e.g. '.MODEL_VIEW.'). A '.' after a
        // pure number is a decimal point ('1.', '0.') and anything else is
        // a statement boundary — both fine. The run is scanned back over
        // letters/digits/'_'; only a run containing a letter (a label, not
        // a number) needs the opening '.'.
        let k = i - 1;
        while (k >= 0 && isWs(bytes[k])) k--;
        if (k >= 0 && isEnumName(bytes[k])) {
          let s = k;
          let hasLetter = false;
          while (s >= 0 && isEnumName(bytes[s])) { if (isLetter(bytes[s]) || bytes[s] === 0x5f) hasLetter = true; s--; }
          if (hasLetter && (s < 0 || bytes[s] !== 0x2e)) return fail("'.' after a label that is not an enumeration");
        }
      }
    }

    if (!inRecord) {
      inRecord = true;
      stmtStart = i;
      if (section === "data" && c === 0x23 /* # */) {
        let j = i + 1;
        if (j >= n || !isDigit(bytes[j])) return fail("DATA record does not start with #<id>");
        while (j < n && isDigit(bytes[j])) j++;
        while (j < n && isWs(bytes[j])) { if (bytes[j] === 0x0a) line++; j++; }
        if (j >= n || bytes[j] !== 0x3d /* = */) return fail("DATA record is missing '=' after its #<id>");
        dataRecords++;
        if (dataRecords > MAX_DATA_RECORDS) return fail(`DATA section exceeds ${MAX_DATA_RECORDS} entity records`);
      } else if (section === "data" && c !== 0x45 /* E: ENDSEC */) {
        return fail("DATA section contains a statement that is not an entity instance");
      }
    }

    if (c === 0x28) {
      depth++;
      if (depth > MAX_DEPTH) return fail(`Parentheses nested deeper than ${MAX_DEPTH}`);
    } else if (c === 0x29) {
      depth--;
      if (depth < 0) return fail("Unbalanced ')'");
    } else if (c === 0x3b) {
      if (depth !== 0) return fail("Record terminated with ';' inside open parentheses");
      if (section === "top") {
        if (startsWithAt(bytes, stmtStart, "HEADER")) section = "header";
        else if (startsWithAt(bytes, stmtStart, "DATA")) { section = "data"; sawData = true; }
        else if (startsWithAt(bytes, stmtStart, "END-ISO-10303-21")) { section = "after"; sawTail = true; }
        else return fail("Unexpected statement before HEADER; or DATA;");
      } else if (section === "header" || section === "data") {
        if (startsWithAt(bytes, stmtStart, "ENDSEC")) section = "top";
      } else {
        return fail("Content after END-ISO-10303-21;");
      }
      inRecord = false;
    }
    i++;
  }

  if (depth !== 0) return fail("Unbalanced '(' at end of file");
  if (inRecord) return fail("File ends in the middle of a record (truncated)");
  if (!sawData) return fail("No DATA; section");
  if (!sawTail || section !== "after") return fail(`Missing ${TAIL_MAGIC} terminator (file truncated?)`);
  return { ok: true };
}
