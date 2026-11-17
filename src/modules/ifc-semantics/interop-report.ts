/** IFC interop report — per-entity inventory parsed from the STEP instance table.
 *
 *  Honest gap closed (ifc-import-export registry, Phase 4): IFC imports were
 *  previously converted to FRAG in one monolithic pass with no visibility
 *  into WHAT entity types the file contains. This module parses the STEP
 *  instance table (`#123 = IFCWALLSTANDARDCASE(...)`) straight from the file
 *  bytes — schema-agnostic (IFC2x3 / IFC4), no extra web-ifc WASM pass, a
 *  single linear scan.
 *
 *  What this IS: an inventory of every entity type + occurrence count in the
 *  file, plus the FILE_SCHEMA from the header.
 *  What this is NOT: a per-type conversion guarantee. The FRAG conversion is
 *  monolithic, so the report cannot claim "type X was loaded / skipped" —
 *  the UI says exactly that.
 */

import { fmtNumber } from "../../core/region";

export interface IfcInteropReport {
  fileName: string;
  /** FILE_SCHEMA from the STEP header ("IFC4", "IFC2X3", …). */
  schema: string;
  totalEntities: number;
  /** Per-type occurrence counts, sorted by count descending. */
  types: Array<{ type: string; count: number }>;
  parsedAt: number;
  /** Scan stopped at the entity cap — counts then cover the scanned prefix only. */
  truncated: boolean;
}

/** Entity-name pattern: `#12 = IFCWALL(...)` (STEP instance statements). */
const ENTITY_RE = /#\d+\s*=\s*([A-Z][A-Z0-9_]*)\s*\(/g;
const SCHEMA_RE = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/;
/** Cap for pathological files — counts then cover the scanned prefix. */
const DEFAULT_MAX_ENTITIES = 400_000;

export interface StepParseResult {
  counts: Map<string, number>;
  total: number;
  truncated: boolean;
}

/** Parse the STEP instance table from decoded text. */
export function parseStepEntities(
  text: string,
  maxEntities: number = DEFAULT_MAX_ENTITIES,
): StepParseResult {
  const counts = new Map<string, number>();
  let total = 0;
  let truncated = false;
  ENTITY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTITY_RE.exec(text)) !== null) {
    const type = m[1];
    counts.set(type, (counts.get(type) ?? 0) + 1);
    total++;
    if (total >= maxEntities) {
      truncated = true;
      break;
    }
  }
  return { counts, total, truncated };
}

/** Decode bytes (STEP is ASCII/ISO-8859-1 — latin1 keeps byte↔char 1:1) and
 *  build the full report. Returns null when the file is not STEP-shaped. */
export function buildInteropReport(
  fileName: string,
  bytes: Uint8Array,
  maxEntities: number = DEFAULT_MAX_ENTITIES,
): IfcInteropReport | null {
  if (!bytes || bytes.length === 0) return null;
  let text: string;
  try {
    text = new TextDecoder("latin1").decode(bytes);
  } catch {
    return null;
  }
  // Cheap STEP-shape gate: header keyword or at least one instance line.
  if (!/ISO-10303-21/i.test(text.slice(0, 4096)) && !ENTITY_RE.test(text.slice(0, 65536))) {
    return null;
  }
  ENTITY_RE.lastIndex = 0;
  const { counts, total, truncated } = parseStepEntities(text, maxEntities);
  if (!total) return null;
  const schemaMatch = SCHEMA_RE.exec(text.slice(0, 65536));
  const types = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  return {
    fileName,
    schema: schemaMatch ? schemaMatch[1].toUpperCase() : "UNKNOWN",
    totalEntities: total,
    types,
    parsedAt: Date.now(),
    truncated,
  };
}

/** Display lines for the queue row / details block (no console pointing). */
export function formatInteropReport(r: IfcInteropReport): string[] {
  const lines: string[] = [];
  lines.push(`${r.fileName} — ${r.schema} · ${fmtNumber(r.totalEntities)} entities · ${r.types.length} type(s)`);
  if (r.truncated) lines.push(`inventory capped — counts cover the scanned prefix only`);
  for (const t of r.types.slice(0, 12)) {
    lines.push(`  ${t.type}: ${fmtNumber(t.count)}`);
  }
  if (r.types.length > 12) {
    const rest = r.types.slice(12);
    const restCount = rest.reduce((s, t) => s + t.count, 0);
    lines.push(`  … ${rest.length} more type(s), ${fmtNumber(restCount)} entities`);
  }
  lines.push(`inventory from the STEP instance table — not a per-type conversion guarantee`);
  return lines;
}
