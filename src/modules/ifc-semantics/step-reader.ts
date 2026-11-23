/**
 * Independent ISO-10303-21 (STEP / SPF) reader for IFC semantic intelligence.
 *
 * This is a deliberate re-implementation: it shares NO code with web-ifc or
 * with the platform's writers, so tests can cross-check what the writer
 * serialized against what an independent parser sees (the "independent
 * validation tool" of the IFC compatibility matrix).
 *
 * Scope: header schema detection, DATA-section entity enumeration with
 * depth/string-aware argument splitting, and per-entity raw text. It never
 * throws on malformed content — problems are collected as warnings and the
 * readable remainder of the file is still returned (graceful handling of
 * invalid or incomplete models).
 */

export interface StepEntity {
  id: number;
  /** Uppercase entity class, e.g. "IFCWALL". */
  name: string;
  /** Split top-level arguments (strings kept quoted, `$` kept as "$"). */
  args: string[];
  /** Raw argument text between the outer parentheses. */
  raw: string;
}

export interface StepFile {
  /** FILE_SCHEMA value, e.g. "IFC4" — null when absent/corrupt. */
  schema: string | null;
  entities: Map<number, StepEntity>;
  /** Highest entity id seen (density/diagnostics). */
  maxId: number;
  /** Non-fatal problems: malformed lines, unterminated strings, … */
  warnings: string[];
}

// ISO 10303-21 whitespace is insignificant between tokens, so a record
// may be written `#1= IFCWALL(...)` as well as `#1=IFCWALL(...)`. The
// EXPRESS Data Manager writer (Revit 2020 export, buildingSMART
// "Example project location" / Gymzaal Amersfoort, corpus #96) emits a
// space after every `=` — with no `\s*` here the reader silently read
// ZERO entities from a valid 32,183-record IFC4 file. The project's own
// writer never emits the space, so no corpus fixture exercised this.
const ID_NAME_RE = /^#(\d+)=\s*([A-Z0-9_]+)\s*\(/i;

/** Split STEP arguments at top level, respecting nesting and 'strings'. */
export function splitStepArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === "'") {
        if (s[i + 1] === "'") { cur += "'"; i++; } // escaped quote
        else inStr = false;
      }
      continue;
    }
    if (c === "'") { inStr = true; cur += c; continue; }
    if (c === "(") { depth++; cur += c; continue; }
    if (c === ")") { depth--; cur += c; continue; }
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() !== "" || out.length) out.push(cur.trim());
  return out;
}

/**
 * Read a STEP file body. Tolerates: BOM, CRLF, entities spanning multiple
 * lines, garbage between entities (collected as warnings), truncated files
 * (entities seen so far are still returned).
 */
export function readStep(text: string): StepFile {
  const warnings: string[] = [];
  const entities = new Map<number, StepEntity>();
  let schema: string | null = null;

  // Strip BOM; keep line structure only for header regex.
  const clean = text.replace(/^\uFEFF/, "");
  const schemaMatch = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'\s*\)\s*\)/.exec(clean);
  if (schemaMatch) schema = schemaMatch[1];
  else warnings.push("FILE_SCHEMA not found or malformed");

  // Locate DATA section; if missing, fall back to scanning the whole file so
  // truncated/corrupt files still yield their entities.
  let dataIdx = clean.search(/\bDATA\s*;/);
  if (dataIdx < 0) {
    warnings.push("DATA section marker missing — scanning whole file");
    dataIdx = 0;
  }
  const endIdx = clean.indexOf("ENDSEC;", dataIdx);
  const body = endIdx >= 0 ? clean.slice(dataIdx, endIdx) : clean.slice(dataIdx);
  if (endIdx < 0) warnings.push("ENDSEC terminator missing — file truncated?");

  let i = 0;
  let maxId = 0;
  const n = body.length;
  while (i < n) {
    // Find the next entity start.
    const hash = body.indexOf("#", i);
    if (hash < 0) break;
    const m = ID_NAME_RE.exec(body.slice(hash, hash + 256));
    if (!m) {
      // Not an entity start — advance to the next ';' or give up.
      const semi = body.indexOf(";", hash);
      if (semi < 0) break;
      i = semi + 1;
      continue;
    }
    const id = Number(m[1]);
    const name = m[2].toUpperCase();
    // Walk to the matching close paren of the argument list.
    let depth = 0;
    let inStr = false;
    let j = hash + m[0].length - 1; // at '('
    const start = j + 1;
    let closed = false;
    for (; j < n; j++) {
      const c = body[j];
      if (inStr) {
        if (c === "'") {
          if (body[j + 1] === "'") j++;
          else inStr = false;
        }
        continue;
      }
      if (c === "'") { inStr = true; continue; }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) { closed = true; break; }
      }
    }
    if (!closed) {
      warnings.push(`#${id} ${name}: unterminated entity (truncated file?)`);
      break;
    }
    const raw = body.slice(start, j);
    // Entity should be terminated by ';'
    let k = j + 1;
    while (k < n && /\s/.test(body[k])) k++;
    if (body[k] !== ";") warnings.push(`#${id} ${name}: missing terminating ';'`);
    i = k + 1;
    if (!Number.isFinite(id) || entities.has(id)) {
      warnings.push(`duplicate or invalid entity id ${m[1]} (${name})`);
      continue;
    }
    entities.set(id, { id, name, args: splitStepArgs(raw), raw });
    if (id > maxId) maxId = id;
  }

  if (!entities.size) warnings.push("no entities could be read");
  return { schema, entities, maxId, warnings };
}

/** Parse an entity reference argument like "#123" → 123, else null. */
export function parseRef(arg: string | undefined): number | null {
  if (!arg) return null;
  const m = /^#(\d+)$/.exec(arg.trim());
  return m ? Number(m[1]) : null;
}

/** Parse a list-of-refs argument like "(#1,#2)" → [1, 2]. */
export function parseRefList(arg: string | undefined): number[] {
  if (!arg) return [];
  const inner = arg.trim();
  const body = inner.startsWith("(") && inner.endsWith(")") ? inner.slice(1, -1) : inner;
  if (!body.trim()) return [];
  const out: number[] = [];
  for (const part of splitStepArgs(body)) {
    const r = parseRef(part);
    if (r != null) out.push(r);
  }
  return out;
}

/** Parse a set-of-strings argument like "('A','B')" → ["A","B"]. */
export function parseStringList(arg: string | undefined): string[] {
  if (!arg) return [];
  const inner = arg.trim();
  const body = inner.startsWith("(") && inner.endsWith(")") ? inner.slice(1, -1) : inner;
  if (!body.trim()) return [];
  const out: string[] = [];
  for (const part of splitStepArgs(body)) {
    const s = unquote(part);
    if (s != null) out.push(s);
  }
  return out;
}

/** Strip surrounding quotes from a STEP string literal ('' → '). */
export function unquote(arg: string | undefined): string | null {
  if (!arg) return null;
  const t = arg.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return null;
}

/** Strip enumeration dots: ".ELEMENT." → "ELEMENT". */
export function unenum(arg: string | undefined): string | null {
  if (!arg) return null;
  const t = arg.trim();
  if (t.length >= 2 && t.startsWith(".") && t.endsWith(".")) return t.slice(1, -1);
  return null;
}
