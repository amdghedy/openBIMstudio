/**
 * Element-level IFC inspection over a SemanticModel.
 *
 * The "reliable property and relationship inspection" surface: given an
 * express id (or a GlobalId) it returns identity, property sets with
 * unit-aware values, quantity sets, classifications, the full relationship
 * picture (containment, aggregation, voids, fills, materials, properties)
 * and the world placement chain. Missing data yields null / empty fields —
 * never fabricated values.
 */

import { unquote, type StepEntity } from "./step-reader";
import type { SemanticModel, ParsedProperty, ParsedQuantity } from "./semantic-model";

export interface ElementInspection {
  expressId: number;
  cls: string;
  globalId: string | null;
  name: string | null;
  objectType: string | null;
  tag: string | null;
  psets: { name: string; props: ParsedProperty[] }[];
  quantities: { name: string; quantities: ParsedQuantity[] }[];
  classifications: { id: number; name: string | null; identification: string | null }[];
  containedIn: { id: number; cls: string; name: string | null } | null;
  aggregatedBy: number | null;
  openings: number[];
  fills: number[];
  materials: number[];
  placement: { id: number; depth: number; translation: [number, number, number] } | null;
  warnings: string[];
}

export function inspectElement(m: SemanticModel, expressId: number): ElementInspection | null {
  const e: StepEntity | undefined = m.entities.get(expressId);
  if (!e) return null;
  const warnings: string[] = [];

  const psets: ElementInspection["psets"] = [];
  const quantities: ElementInspection["quantities"] = [];
  const classifications: ElementInspection["classifications"] = [];
  let containedIn: ElementInspection["containedIn"] = null;
  let aggregatedBy: number | null = null;
  const openings: number[] = [];
  const fills: number[] = [];
  const materials: number[] = [];

  for (const r of m.relationships) {
    const isRelated = r.related.includes(expressId);
    const isRelating = r.relating === expressId;
    if (!isRelated && !isRelating) continue;
    switch (r.kind) {
      case "properties": {
        if (!isRelated) break;
        const ps = m.psets.get(r.relating ?? -1);
        if (ps) psets.push({ name: ps.name, props: ps.props });
        const q = m.qtos.get(r.relating ?? -1);
        if (q) quantities.push({ name: q.name, quantities: q.quantities });
        break;
      }
      case "containment": {
        if (!isRelated) break;
        const struct = m.entities.get(r.relating ?? -1);
        containedIn = struct
          ? { id: struct.id, cls: struct.name, name: unquote(struct.args[2]) }
          : null;
        if (!struct) warnings.push(`contained-in relationship target missing`);
        break;
      }
      case "aggregates": {
        if (isRelated) aggregatedBy = r.relating;
        else if (isRelating) openings.push(...r.related); // children (rare use)
        break;
      }
      case "voids": {
        if (isRelating) openings.push(...r.related);
        break;
      }
      case "fills": {
        if (isRelated) fills.push(r.relating ?? -1);
        break;
      }
      case "material": {
        if (isRelated && r.relating != null) materials.push(r.relating);
        break;
      }
      case "classification": {
        if (!isRelated) break;
        const c = m.classifications.get(r.relating ?? -1);
        if (c) classifications.push({ id: c.id, name: c.name, identification: c.identification });
        break;
      }
      default:
        break;
    }
  }

  // Placement: IfcElement attribute 5 is ObjectPlacement.
  let placement: ElementInspection["placement"] = null;
  const placeRef = m.entities.get(expressId);
  if (placeRef) {
    const argIdx = ELEMENT_PLACEMENT_ARG[placeRef.name] ?? 5;
    const raw = placeRef.args[argIdx];
    const refMatch = raw != null ? /^#(\d+)$/.exec(raw.trim()) : null;
    if (refMatch) {
      const pid = Number(refMatch[1]);
      const t = m.placements.get(pid);
      if (t) {
        placement = {
          id: pid,
          depth: t.depth,
          translation: [t.matrix[12], t.matrix[13], t.matrix[14]],
        };
      } else {
        warnings.push(`placement #${pid} present but not resolvable`);
      }
    }
  }

  return {
    expressId,
    cls: e.name,
    globalId: m.globalIds.get(expressId) ?? null,
    name: unquote(e.args[2]),
    objectType: unquote(e.args[4]),
    tag: unquote(e.args[7]),
    psets,
    quantities,
    classifications,
    containedIn,
    aggregatedBy,
    openings,
    fills,
    materials,
    placement,
    warnings,
  };
}

/** IfcElement places ObjectPlacement at index 5; openings differ. */
const ELEMENT_PLACEMENT_ARG: Record<string, number> = {
  IFCOPENINGELEMENT: 5,
  IFCSPACE: 5,
};

export function findByGlobalId(m: SemanticModel, guid: string): ElementInspection | null {
  for (const [id, g] of m.globalIds) {
    if (g === guid) return inspectElement(m, id);
  }
  return null;
}

/** Elements carrying a physical presence (used by validation + reports). */
export function physicalElementIds(m: SemanticModel): number[] {
  const out: number[] = [];
  for (const [cls, ids] of m.byClass) {
    if (/^IFC(WALL|SLAB|BEAM|COLUMN|MEMBER|PLATE|FOOTING|PILE|STAIR|RAILING|RAMP|ROOF|CEILING|CURTAINWALL|DOOR|WINDOW|FURNISHINGELEMENT|BUILDINGELEMENTPROXY|COVERING|OPENINGELEMENT|FLOW|DISTRIBUTIONELEMENT|SPACE)/.test(cls)) {
      out.push(...ids);
    }
  }
  return out;
}
