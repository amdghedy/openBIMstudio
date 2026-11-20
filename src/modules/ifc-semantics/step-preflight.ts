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
 *   - no control bytes or raw non-ASCII bytes outside strings and comments.
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
const HEADER_MAGIC = "ISO-10303-21;";
const TAIL_MAGIC = "END-ISO-10303-21;";

const isWs = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

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

    if (!inRecord) {
      inRecord = true;
      stmtStart = i;
      if (section === "data" && c === 0x23 /* # */) {
        let j = i + 1;
        if (j >= n || !isDigit(bytes[j])) return fail("DATA record does not start with #<id>");
        while (j < n && isDigit(bytes[j])) j++;
        while (j < n && isWs(bytes[j])) { if (bytes[j] === 0x0a) line++; j++; }
        if (j >= n || bytes[j] !== 0x3d /* = */) return fail("DATA record is missing '=' after its #<id>");
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
