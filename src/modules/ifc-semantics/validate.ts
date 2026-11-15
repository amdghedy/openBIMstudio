/**
 * IFC semantic validation — pure checks over a SemanticModel with stable
 * machine-readable codes, mirroring the repo's native-bim validator style.
 *
 * Checks (each additive, never mutating):
 *   IFC-E-BAD-GUID         GlobalId fails buildingSMART base64 charset/length
 *   IFC-W-DUP-GUID         same GlobalId on multiple entities
 *   IFC-E-DANGLING-REF     entity reference points at a missing #id
 *   IFC-W-UNITS-MISSING    no length unit in IfcUnitAssignment (or none at all)
 *   IFC-W-ORPHAN-ELEMENT   physical element not contained in spatial structure
 *   IFC-W-EMPTY-PSET       property set with zero properties
 *   IFC-W-EMPTY-QTO        quantity set with zero quantities
 *   IFC-W-CLASSIF-DANGLING classification reference without a parent classification
 *   IFC-I-UNKNOWN-CLASS    unknown entity classes preserved (informational)
 *
 * Invalid or incomplete models never throw — they produce findings.
 */

import type { SemanticModel } from "./semantic-model";
import { physicalElementIds } from "./inspect";

export type FindingSeverity = "error" | "warning" | "info";

export interface Finding {
  code: string;
  severity: FindingSeverity;
  /** Express id when the finding is about one entity. */
  entity?: number;
  message: string;
}

export function validateSemanticModel(m: SemanticModel): Finding[] {
  const findings: Finding[] = [];

  // Invalid GlobalIds.
  for (const bad of m.invalidGlobalIds) {
    findings.push({
      code: "IFC-E-BAD-GUID",
      severity: "error",
      entity: bad.id,
      message: `#${bad.id} carries GlobalId "${bad.value}" which is not a valid 22-char base64 buildingSMART GUID`,
    });
  }

  // Duplicate GlobalIds.
  for (const [gid, ids] of m.duplicateGlobalIds) {
    if (ids.length >= 2) {
      findings.push({
        code: "IFC-W-DUP-GUID",
        severity: "warning",
        message: `GlobalId ${gid} used by ${ids.length} entities (#${ids.join(", #")})`,
      });
    }
  }

  // Dangling references (every #ref in every entity must resolve).
  for (const e of m.entities.values()) {
    for (const match of e.raw.matchAll(/#(\d+)/g)) {
      const ref = Number(match[1]);
      if (!m.entities.has(ref)) {
        findings.push({
          code: "IFC-E-DANGLING-REF",
          severity: "error",
          entity: e.id,
          message: `#${e.id} ${e.name} references missing #${ref}`,
        });
      }
    }
  }

  // Units.
  if (!m.units.present) {
    findings.push({
      code: "IFC-W-UNITS-MISSING",
      severity: "warning",
      message: "no IfcUnitAssignment length/area/volume/angle unit found — consumers cannot convert property values",
    });
  } else if (!m.units.length) {
    findings.push({
      code: "IFC-W-UNITS-MISSING",
      severity: "warning",
      message: "unit assignment present but no LENGTHUNIT — geometric values are unitless",
    });
  }

  // Orphan physical elements (not contained, not aggregated anywhere).
  const contained = new Set<number>();
  for (const r of m.relationships) {
    if (r.kind === "containment" || r.kind === "aggregates") {
      for (const id of r.related) contained.add(id);
    }
  }
  for (const id of physicalElementIds(m)) {
    const cls = m.entities.get(id)?.name ?? "";
    // Openings are hosted by IfcRelVoidsElement — spatial containment does
    // not apply to them (IFC-correct topology).
    if (cls === "IFCOPENINGELEMENT") continue;
    if (!contained.has(id)) {
      findings.push({
        code: "IFC-W-ORPHAN-ELEMENT",
        severity: "warning",
        entity: id,
        message: `#${id} ${cls} is not contained in any spatial structure node`,
      });
    }
  }

  // Empty property/quantity sets.
  for (const p of m.psets.values()) {
    if (!p.props.length) {
      findings.push({
        code: "IFC-W-EMPTY-PSET",
        severity: "warning",
        entity: p.id,
        message: `property set "${p.name}" (#${p.id}) has no properties`,
      });
    }
  }
  for (const q of m.qtos.values()) {
    if (!q.quantities.length) {
      findings.push({
        code: "IFC-W-EMPTY-QTO",
        severity: "warning",
        entity: q.id,
        message: `quantity set "${q.name}" (#${q.id}) has no quantities`,
      });
    }
  }

  // Classification references need a parent classification.
  for (const c of m.classifications.values()) {
    if (c.cls === "IFCCLASSIFICATIONREFERENCE" && c.referencedSource == null) {
      findings.push({
        code: "IFC-W-CLASSIF-DANGLING",
        severity: "warning",
        entity: c.id,
        message: `classification reference "${c.identification ?? c.name ?? `#${c.id}`}" has no ReferencedSource classification`,
      });
    }
  }

  // Unknown classes — informational, they are preserved not dropped.
  for (const [cls, count] of m.unknownClasses) {
    findings.push({
      code: "IFC-I-UNKNOWN-CLASS",
      severity: "info",
      message: `${count} entity(ies) of unknown class ${cls} preserved (not dropped)`,
    });
  }

  return findings;
}

/** Compact summary for toasts / reports. */
export function summarizeFindings(findings: Finding[]): { errors: number; warnings: number; infos: number; byCode: Record<string, number> } {
  const byCode: Record<string, number> = {};
  let errors = 0, warnings = 0, infos = 0;
  for (const f of findings) {
    byCode[f.code] = (byCode[f.code] ?? 0) + 1;
    if (f.severity === "error") errors++;
    else if (f.severity === "warning") warnings++;
    else infos++;
  }
  return { errors, warnings, infos, byCode };
}
