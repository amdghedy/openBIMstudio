/**
 * A family made from a traced picture outline: one extruded polygon (holes kept) whose
 * Width, Height and Thickness are editable parameters. The outline's proportions are the
 * picture's; the sizes are the ones the user stated. This is a flat extrusion, not a
 * reconstruction of anything the picture does not show.
 */
import type { FamilyDefinition, FamilyParameter } from "../types";
import type { ScaledOutline, Pt } from "./outline";
import { writeIfc2x3 } from "./ifc2x3";

export interface OutlineSpec {
  kind: "outline";
  name: string;
  /** Unit shape: x in [-0.5, 0.5] (centred), y in [0, 1] (bottom to top). */
  outer: Pt[]; holes: Pt[][];
  widthM: number; heightM: number; thicknessM: number;
  /** Where the numbers came from, shown to the user. */
  source: { fileName: string; statedWidthM?: number; statedHeightM?: number; scaleMPerPx: number; pointCount: number };
}

const MIN_M = 0.005, MAX_M = 30;

const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };

export function specFromOutline(name: string, o: ScaledOutline, thicknessM: number, source: { fileName: string; statedWidthM?: number; statedHeightM?: number }): OutlineSpec {
  if (!(thicknessM > 0)) throw new Error("Give the thickness: a picture of a flat shape cannot show how thick it is.");
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  const unit = (p: Pt): Pt => [r(p[0] / o.widthM - 0.5), r(p[1] / o.heightM)];
  return {
    kind: "outline", name: name.trim() || "Outline shape",
    outer: o.outer.map(unit), holes: o.holes.map((h) => h.map(unit)),
    widthM: o.widthM, heightM: o.heightM, thicknessM,
    source: { ...source, scaleMPerPx: o.scaleMPerPx, pointCount: o.outer.length + o.holes.reduce((a, h) => a + h.length, 0) },
  };
}

export function validateOutlineSpec(s: OutlineSpec): string[] {
  const out: string[] = [];
  for (const [k, v] of [["Width", s.widthM], ["Height", s.heightM], ["Thickness", s.thicknessM]] as const) {
    if (!(v >= MIN_M && v <= MAX_M)) out.push(`${k} must be between ${MIN_M * 1000} mm and ${MAX_M} m`);
  }
  if (s.outer.length < 3) out.push("The outline has fewer than 3 points");
  return out;
}

export function buildOutlineFamily(spec: OutlineSpec): FamilyDefinition {
  const problems = validateOutlineSpec(spec);
  if (problems.length) throw new Error(problems.join("; "));
  const id = `outline-${spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "shape"}-${hash(JSON.stringify([spec.outer, spec.holes, spec.widthM, spec.heightM, spec.thicknessM]))}`;
  const dim = (name: string, value: number): FamilyParameter => ({
    name, label: name, type: "length", scope: "type", default: value, editable: true,
    min: MIN_M, max: MAX_M, step: 0.005, unit: "m", group: "Dimensions",
  });
  return {
    id, name: spec.name, category: "generic", ifcEntity: "IfcBuildingElementProxy",
    schemaVersion: 2, builtIn: false, group: "Created",
    parameters: [dim("Width", spec.widthM), dim("Height", spec.heightM), dim("Thickness", spec.thicknessM)],
    geometry: {
      kind: "extrusion",
      profile: { kind: "polygon", points: spec.outer },
      holes: spec.holes.map((h) => ({ kind: "polygon" as const, points: h })),
      depth: { ref: "Thickness" },
      // Extrusion is centred on Z by the engine. The unit shape is scaled to Width x Height; depth is not scaled.
      transform: { scale: [{ ref: "Width" }, { ref: "Height" }, { const: 1 }] },
    },
    types: [{ id: `${id}-type-default`, name: "Default", values: { Width: spec.widthM, Height: spec.heightM, Thickness: spec.thicknessM } }],
    creatorSpec: JSON.parse(JSON.stringify(spec)) as unknown as Record<string, unknown>,
  };
}

/** IFC2X3 at given sizes (metres): the unit outline scaled to Width x Height, extruded by Thickness. */
export function writeOutlineIfc(spec: OutlineSpec, sizes: { widthM: number; heightM: number; thicknessM: number }) {
  const sc = (p: Pt): [number, number] => [p[0] * sizes.widthM, p[1] * sizes.heightM];
  return writeIfc2x3({
    name: spec.name, entity: "IfcBuildingElementProxy", parts: [],
    lengthParams: { Width: sizes.widthM, Height: sizes.heightM, Thickness: sizes.thicknessM },
    outline: { outer: spec.outer.map(sc), holes: spec.holes.map((h) => h.map(sc)), thicknessM: sizes.thicknessM },
  });
}
