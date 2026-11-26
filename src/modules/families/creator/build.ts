// Free family creator, slice 1: ProductSpec -> editable FamilyDefinition.
//
// The result is an ordinary family for the existing parametric engine:
// Width, Depth and Height type parameters, template parameters, one type,
// and geometry made of boxes and cylinders whose sizes are formulas. The
// user edits it in OpenBIMStudio like any other family.

import type { FamilyDefinition, FamilyGeometrySpec, FamilyParameter } from "../types";
import { chooseTemplate, expandTemplate, TEMPLATES, type PartTemplate, type TemplatePart } from "./templates";

export interface ProductSpec {
  name: string;
  manufacturer?: string;
  model?: string;
  /** Overall size in metres (width = X, depth = Z, height = Y up). */
  widthM: number;
  depthM: number;
  heightM: number;
  templateId?: "box" | "cabinet" | "table" | "shelf" | "booster";
  /** Overrides for the template's own parameters, in metres (e.g. PlinthHeight). */
  params?: Record<string, number>;
  /** Where the size came from, kept for the Sources view. */
  sources?: Array<{ label: string; valueM: number; page: number; line: number; sourceText: string; kind?: "count" }>;
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
  for (const [k, v] of Object.entries(spec.params ?? {})) {
    const tp = tpl.params.find((x) => x.name === k && x.formula === undefined);
    if (!tp) { out.push({ field: `params.${k}`, message: "Unknown or derived parameter" }); continue; }
    if (typeof v !== "number" || !Number.isFinite(v)) { out.push({ field: `params.${k}`, message: "Not a number" }); continue; }
    if (tp.integer && !Number.isInteger(v)) { out.push({ field: `params.${k}`, message: "Must be a whole number" }); continue; }
    if ((tp.min !== undefined && v < tp.min) || (tp.max !== undefined && v > tp.max)) {
      out.push({ field: `params.${k}`, message: `Outside ${tp.min} to ${tp.max}${tp.integer ? "" : " m"}` });
    }
  }
  if (tpl.id === "cabinet" && typeof spec.heightM === "number") {
    const plinth = spec.params?.PlinthHeight ?? tpl.params.find((x) => x.name === "PlinthHeight")!.default;
    if (spec.heightM <= plinth + 0.05) out.push({ field: "heightM", message: "Too short for the plinth and door" });
    else {
      const dv = (n: string) => spec.params?.[n] ?? tpl.params.find((x) => x.name === n)!.default;
      const zone = spec.heightM - plinth - dv("Drawers") * dv("DrawerHeight");
      if (dv("Drawers") > 0 && zone < -1e-9) out.push({ field: "params.Drawers", message: "The drawers do not fit in this height" });
      else if (dv("Drawers") > 0 && dv("Doors") > 0 && zone < 0.1) out.push({ field: "params.Drawers", message: "No room left for the doors under the drawers" });
    }
  }
  if (tpl.id === "table" && typeof spec.heightM === "number") {
    const top = spec.params?.TopThickness ?? tpl.params.find((x) => x.name === "TopThickness")!.default;
    if (spec.heightM <= top + 0.05) out.push({ field: "heightM", message: "Too short for the top and legs" });
  }
  if (tpl.id === "shelf") {
    const t = spec.params?.PanelThickness ?? tpl.params.find((x) => x.name === "PanelThickness")!.default;
    if (spec.heightM <= 3 * t) out.push({ field: "heightM", message: "Too short for the panels" });
    if (spec.widthM <= 3 * t) out.push({ field: "widthM", message: "Too narrow for the panels" });
  }
  return out;
}

export function templateFor(spec: ProductSpec): PartTemplate {
  const base = spec.templateId && TEMPLATES[spec.templateId] ? TEMPLATES[spec.templateId] : chooseTemplate(`${spec.name} ${spec.model ?? ""}`);
  return expandTemplate(base, spec.params);
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
    const rotate = p.axis === "x" ? [{ const: 0 }, { const: 0 }, { const: Math.PI / 2 }] : p.axis === "z" ? [{ const: Math.PI / 2 }, { const: 0 }, { const: 0 }] : undefined;
    return { kind: "cylinder", r: ex(p.r as string), h: ex(p.h as string), segments: 32, transform: rotate ? { ...transform, rotate: rotate as [any, any, any] } : transform };
  }
  return { kind: "box", w: ex(p.w as string), d: ex(p.d as string), h: ex(p.h as string), transform };
}

export function buildFamilyFromSpec(spec: ProductSpec): FamilyDefinition {
  const problems = validateSpec(spec);
  if (problems.length) throw new Error(`Invalid product spec: ${problems.map((p) => `${p.field}: ${p.message}`).join("; ")}`);
  const tpl = templateFor(spec);
  const id = `creator-${slug(spec.name)}-${hash(JSON.stringify([spec.name, spec.model, spec.widthM, spec.depthM, spec.heightM, tpl.id, spec.params ?? null]))}`;

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
    const value = !derived && spec.params && tp.name in spec.params ? spec.params[tp.name] : tp.default;
    parameters.push({
      name: tp.name, label: tp.label, type: tp.integer ? "integer" : "length", scope: "type",
      default: value, editable: !derived, min: tp.min, max: tp.max, step: tp.integer ? 1 : 0.005, ...(tp.integer ? {} : { unit: "m" }),
      group: derived ? "Derived" : "Parts", ...(derived ? { formula: tp.formula } : {}),
    });
    if (!derived) typeValues[tp.name] = value;
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
