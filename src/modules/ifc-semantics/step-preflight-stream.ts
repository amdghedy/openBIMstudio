/**
 * Streaming / windowed twin of preflightStep (step-preflight.ts). GENERATED from
 * that scanner by replacing whole-buffer indexing with a two-block cached reader,
 * so the logic and results are identical while peak memory is <= 2 blocks.
 * tests/step-preflight-stream.test.mjs checks equivalence on every malformed
 * fixture and with block sizes that cut strings, comments and tokens.
 */
import type { StepPreflightResult } from "./step-preflight";

const MAX_DEPTH = 256;
/** Long pure-digit INTEGER tokens in DATA usually mean adversarial list counts; valid IFC stays well below this.
 *  Only the integer part counts: Revit writes coordinates with 19–22
 *  FRACTIONAL digits (e.g. -0.0009000000000002357 in Duplex_A_20110907.ifc),
 *  and a fraction is not an integer token. */
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


export function preflightStepStreaming(
  size: number,
  read: (offset: number, length: number) => Uint8Array,
  blockSize: number = 32 * 1024 * 1024,
): StepPreflightResult {
  const n = size;
  // Two-block cache: memory stays <= 2 * blockSize regardless of file size.
  // Random access outside the cached blocks (e.g. a lookbehind across a block
  // edge) re-reads the block, so results are identical to the whole-buffer scan.
  let c0 = -1, c1 = -1;
  let b0: Uint8Array = new Uint8Array(0), b1: Uint8Array = new Uint8Array(0);
  const g = (p: number): number => {
    if (p < 0 || p >= n) return undefined as unknown as number;
    const blk = Math.floor(p / blockSize);
    if (blk === c0) return b0[p - blk * blockSize];
    if (blk === c1) return b1[p - blk * blockSize];
    const off = blk * blockSize;
    const data = read(off, Math.min(blockSize, n - off));
    c1 = c0; b1 = b0; c0 = blk; b0 = data;
    return data[p - off];
  };
  const startsWithAt = (_b: unknown, i: number, s: string): boolean => {
    if (i + s.length > n) return false;
    for (let k = 0; k < s.length; k++) if (g(i + k) !== s.charCodeAt(k)) return false;
    return true;
  };
  let line = 1;
  const fail = (reason: string): StepPreflightResult => ({ ok: false, reason, line });

  let i = 0;
  if (n >= 3 && g(0) === 0xef && g(1) === 0xbb && g(2) === 0xbf) i = 3; // UTF-8 BOM
  while (i < n && isWs(g(i))) { if (g(i) === 0x0a) line++; i++; }
  if (!startsWithAt(null, i, HEADER_MAGIC)) return fail("Not a STEP/IFC file: missing the ISO-10303-21; header");
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
  let inFraction = false;

  while (i < n) {
    const c = g(i);

    if (c === 0x0a) { line++; i++; continue; }
    if (isWs(c)) { i++; continue; }

    // block comment
    if (c === 0x2f && i + 1 < n && g(i + 1) === 0x2a) {
      i += 2;
      let closed = false;
      while (i < n) {
        if (g(i) === 0x0a) line++;
        if (g(i) === 0x2a && i + 1 < n && g(i + 1) === 0x2f) { i += 2; closed = true; break; }
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
        const d = g(i);
        if (d === 0x0a) line++;
        if (d === 0x27) {
          if (i + 1 < n && g(i + 1) === 0x27) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) return fail("Unterminated 'string'");
      continue;
    }

    if (c < 0x20 || c >= 0x7f) return fail(`Unexpected byte 0x${c.toString(16)} outside a string`);

    // Extreme integer tokens (e.g. 1e18-wide counts) are a common hang vector for WASM parsers.
    // Digits after a decimal point are a fraction, not an integer token.
    if (isDigit(c)) {
      if (!inFraction) {
        digitRun++;
        if (digitRun > MAX_DIGIT_RUN) return fail(`Integer token longer than ${MAX_DIGIT_RUN} digits`);
      }
    } else {
      digitRun = 0;
      inFraction = false;
    }

    if (c === 0x2e /* . */) {
      // A '.' is either part of a real number or an enumeration delimiter.
      // A '.' followed by a letter can only open an enumeration, so it must
      // be a well-formed '.NAME.' (name = letters/digits/'_', optional
      // whitespace, closing '.'). Otherwise the parser reads the name as a
      // bare LABEL and the next '.' as an ENUM start that swallows the rest
      // of the file up to the following '.' — including ';' terminators —
      // and OpenModel never terminates (issue #231).
      const next = i + 1 < n ? g(i + 1) : -1;
      // A '.' followed by a digit is a decimal point: the digits after it
      // are fractional and must not count toward the integer cap.
      if (isDigit(next)) inFraction = true;
      if (isLetter(next)) {
        let j = i + 1;
        while (j < n && isEnumName(g(j))) j++;
        // '1.E-05' is a real number, not an enumeration: a lone 'E'/'e'
        // followed by an optional sign and a digit is an exponent.
        const loneE = j === i + 2 && (next === 0x45 || next === 0x65);
        let e = j;
        if (loneE && e < n && (g(e) === 0x2b || g(e) === 0x2d)) e++;
        if (loneE && e < n && isDigit(g(e))) {
          // Real-number exponent — not an enumeration, nothing to check.
        } else {
          while (j < n && isWs(g(j))) j++;
          if (j >= n || g(j) !== 0x2e) return fail("Malformed enumeration: '.' must close with '.' after the name");
        }
      } else {
        // A '.' right after a label must be the closing dot of an
        // enumeration opened by a '.' (e.g. '.MODEL_VIEW.'). A '.' after a
        // pure number is a decimal point ('1.', '0.') and anything else is
        // a statement boundary — both fine. The run is scanned back over
        // letters/digits/'_'; only a run containing a letter (a label, not
        // a number) needs the opening '.'.
        let k = i - 1;
        while (k >= 0 && isWs(g(k))) k--;
        if (k >= 0 && isEnumName(g(k))) {
          let s = k;
          let hasLetter = false;
          while (s >= 0 && isEnumName(g(s))) { if (isLetter(g(s)) || g(s) === 0x5f) hasLetter = true; s--; }
          if (hasLetter && (s < 0 || g(s) !== 0x2e)) return fail("'.' after a label that is not an enumeration");
        }
      }
    }

    if (!inRecord) {
      inRecord = true;
      stmtStart = i;
      if (section === "data" && c === 0x23 /* # */) {
        let j = i + 1;
        if (j >= n || !isDigit(g(j))) return fail("DATA record does not start with #<id>");
        while (j < n && isDigit(g(j))) j++;
        while (j < n && isWs(g(j))) { if (g(j) === 0x0a) line++; j++; }
        if (j >= n || g(j) !== 0x3d /* = */) return fail("DATA record is missing '=' after its #<id>");
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
        if (startsWithAt(null, stmtStart, "HEADER")) section = "header";
        else if (startsWithAt(null, stmtStart, "DATA")) { section = "data"; sawData = true; }
        else if (startsWithAt(null, stmtStart, "END-ISO-10303-21")) { section = "after"; sawTail = true; }
        else return fail("Unexpected statement before HEADER; or DATA;");
      } else if (section === "header" || section === "data") {
        if (startsWithAt(null, stmtStart, "ENDSEC")) section = "top";
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
