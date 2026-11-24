// Free family creator, slice 1: ProductSpec -> editable FamilyDefinition.
//
// The result is an ordinary family for the existing parametric engine:
// Width, Depth and Height type parameters, template parameters, one type,
// and geometry made of boxes and cylinders whose sizes are formulas. The
// user edits it in OpenBIMStudio like any other family.

import type { FamilyDefinition, FamilyGeometrySpec, FamilyParameter } from "../types";
import { chooseTemplate, TEMPLATES, type PartTemplate, type TemplatePart } from "./templates";

export interface ProductSpec {
  name: string;
  manufacturer?: string;
  model?: string;
  /** Overall size in metres (width = X, depth = Z, height = Y up). */
  widthM: number;
  depthM: number;
  heightM: number;
  templateId?: "box" | "cabinet";
  /** Where the size came from, kept for the Sources view. */
  sources?: Array<{ label: string; valueM: number; page: number; line: number; sourceText: string }>;
}

export interface SpecProblem { field: string; message: string }

const MIN_M = 0.02;
const MAX_M = 30;

export function validateSpec(spec: ProductSpec): SpecProblem[] {
  const out: SpecProblem[] = [];
  if (!String(spec.name ?? "").trim()) out.push({ field: "name", message: "Name is empty" });
  for (const k of ["widthM", "depthM", "heightM"] as const) {
    const v = spec[k];
    if (typeof v !== "number" || !Number.isFinite(v)) out.push({ field: k, message: "Not a number" });
    else if (v < MIN_M || v > MAX_M) out.push({ field: k, message: `Outside ${MIN_M} to ${MAX_M} m` });
  }
  const tpl = templateFor(spec);
  if (tpl.id === "cabinet" && spec.heightM <= 0.1 + 0.05) {
    out.push({ field: "heightM", message: "Too short for a cabinet plinth and door" });
  }
  return out;
}

export function templateFor(spec: ProductSpec): PartTemplate {
  if (spec.templateId && TEMPLATES[spec.templateId]) return TEMPLATES[spec.templateId];
  return chooseTemplate(`${spec.name} ${spec.model ?? ""}`);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "family";
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

const ex = (expr: string) => ({ expr });

function partSpec(p: TemplatePart): FamilyGeometrySpec {
  const transform = { translate: [ex(p.x), ex(p.y), ex(p.z)] as [any, any, any] };
  if (p.shape === "cylinder") {
    return { kind: "cylinder", r: ex(p.r as string), h: ex(p.h as string), segments: 32, transform };
  }
  return { kind: "box", w: ex(p.w as string), d: ex(p.d as string), h: ex(p.h as string), transform };
}

export function buildFamilyFromSpec(spec: ProductSpec): FamilyDefinition {
  const problems = validateSpec(spec);
  if (problems.length) throw new Error(`Invalid product spec: ${problems.map((p) => `${p.field}: ${p.message}`).join("; ")}`);
  const tpl = templateFor(spec);
  const id = `creator-${slug(spec.name)}-${hash(JSON.stringify([spec.name, spec.model, spec.widthM, spec.depthM, spec.heightM, tpl.id]))}`;

  const dim = (name: string, label: string, value: number): FamilyParameter => ({
    name, label, type: "length", scope: "type", default: value, editable: true,
    min: MIN_M, max: MAX_M, step: 0.01, unit: "m", group: "Dimensions",
  });
  const parameters: FamilyParameter[] = [
    dim("Width", "Width", spec.widthM),
    dim("Depth", "Depth", spec.depthM),
    dim("Height", "Height", spec.heightM),
  ];
  const typeValues: Record<string, number> = { Width: spec.widthM, Depth: spec.depthM, Height: spec.heightM };
  for (const tp of tpl.params) {
    const derived = tp.formula !== undefined;
    parameters.push({
      name: tp.name, label: tp.label, type: "length", scope: "type",
      default: tp.default, editable: !derived, min: tp.min, max: tp.max, step: 0.005, unit: "m",
      group: derived ? "Derived" : "Parts", ...(derived ? { formula: tp.formula } : {}),
    });
    if (!derived) typeValues[tp.name] = tp.default;
  }

  const geometry: FamilyGeometrySpec = { kind: "composed", parts: tpl.parts.map(partSpec) };
  return {
    id,
    name: spec.name,
    category: tpl.category,
    ifcEntity: tpl.ifcEntity === "IfcFurnishingElement" ? "IfcFurnishingElement" : "IfcBuildingElementProxy",
    schemaVersion: 2,
    builtIn: false,
    group: "Created",
    parameters,
    geometry,
    types: [{ id: `${id}-type-default`, name: "Default", values: typeValues }],
  };
}
