/**
 * Milestone 2 registration: makes stairs, railings, ramps, curtain walls, roofs
 * and ceilings first-class authored elements.
 *
 *  - mesh builders: authoring.createMesh() asks window.__obsMeshBuilders[type]
 *    (one anchored line added by the installer) before giving up on a type;
 *  - Properties palette: schemas for the six types (SCHEMAS is a mutable table);
 *  - quantities: window.__obsM2Quantities(el) feeds the cost takeoff (installer patch).
 */
import * as THREE from "three";
import { ctx } from "../../core/context";
import { SCHEMAS, type ElementSchema, type PropertyField } from "../../features/property-schema";
import { buildElementGeo, m2Quantities, M2_TYPES, buildCompoundWall, parseWallLayers } from "./m2-geometry";

type Any = Record<string, any>;
const warned = new Set<string>();

export function buildM2Mesh(el: Any): THREE.Object3D | null {
  let geo;
  try { geo = buildElementGeo(el as never); }
  catch (e) {
    if (!warned.has(el.id)) { warned.add(el.id); console.warn(`[bim-gaps] ${el.type} ${el.id}: ${e instanceof Error ? e.message : e}`); }
    return null;
  }
  if (!geo) return null;
  const group = new THREE.Group();
  group.name = `${el.type}:${el.id}`;
  for (const part of geo.parts) {
    if (part.positions.length < 9) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(part.positions, 3));
    g.computeVertexNormals();
    const glass = part.role === "glass";
    const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(part.color), transparent: glass, opacity: glass ? 0.35 : 1, depthWrite: !glass });
    if (el.type === "roof" || el.type === "ceiling") mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(g, mat);
    mesh.userData.elementId = el.id;
    mesh.userData.baseColor = part.color;
    mesh.userData.m2Part = part.name;
    group.add(mesh);
  }
  return group.children.length ? group : null;
}

/* ---------------------------------------------------------- palette schemas */

const D = "Dimensions", C = "Constraints", I = "Identity Data", M = "Materials", K = "Construction";
const num = (key: string, label: string, group: string, step = 0.05, min?: number, max?: number, unit = "m"): PropertyField =>
  ({ key, label, group, type: "number", unit, step, min, max, target: "params" });
const prop = (key: string, label: string, group: string, step = 0.05, min?: number, max?: number, unit = "m", def?: number): PropertyField =>
  ({ key, label, group, type: "number", unit, step, min, max, target: "properties", default: def });
const sel = (key: string, label: string, group: string, options: Array<[string, string]>, def: string): PropertyField =>
  ({ key, label, group, type: "select", target: "properties", options: options.map(([value, l]) => ({ value, label: l })), default: def });
const common = (): PropertyField[] => [
  { key: "name", label: "Name", group: I, type: "text", target: "root" },
  { key: "typeMark", label: "Type mark", group: I, type: "text", target: "properties" },
  { key: "comments", label: "Comments", group: I, type: "text", target: "properties" },
  { key: "color", label: "Color", group: M, type: "color", target: "root" },
];
const elev = (label = "Base elevation") => num("elevation", label, C, 0.1);
const schema = (type: ElementSchema["type"], label: string, icon: string, fields: PropertyField[]): ElementSchema =>
  ({ type, label, icon, groups: [D, C, K, I, M], fields: [...fields, ...common()] });

export function registerM2Schemas(): void {
  const S = SCHEMAS as Any;
  S.stairs = schema("stairs" as never, "Stair", "stairs", [
    num("height", "Total rise", D, 0.05, 0.3), num("width", "Run width", D, 0.05, 0.5), elev(),
    sel("stairShape", "Shape", K, [["straight", "Straight run"], ["L", "L-shape (quarter turn)"], ["U", "U-shape (half turn)"]], "straight"),
    sel("stairTurn", "Turn direction", K, [["left", "Left"], ["right", "Right"]], "left"),
    prop("maxRiser", "Max riser height", K, 0.005, 0.1, 0.25, "m", 0.175), prop("waist", "Waist thickness", K, 0.01, 0, 0.5, "m", 0.12),
    prop("run2", "Second flight length", K, 0.1, 0.5, undefined, "m"), prop("gap", "Gap between flights (U)", K, 0.05, 0, 1, "m", 0.1),
    prop("landingThickness", "Landing thickness", K, 0.01, 0.05, 0.5, "m", 0.15),
  ]);
  S.railing = schema("railing" as never, "Railing", "railing", [
    num("height", "Rail height", D, 0.05, 0.3), num("thickness", "Rail size", D, 0.01, 0.02), elev(),
    prop("rise", "Rise along path", C, 0.05, 0, undefined, "m", 0), prop("postSpacing", "Max post spacing", K, 0.1, 0.3, 4, "m", 1.2),
    prop("balusterSpacing", "Baluster spacing", K, 0.01, 0.04, 0.5, "m", 0.12),
    { key: "balusters", label: "Balusters", group: K, type: "boolean", target: "properties", default: true },
  ]);
  S.ramp = schema("ramp" as never, "Ramp", "ramp", [
    num("height", "Rise", D, 0.05, 0.05), num("width", "Width", D, 0.05, 0.5), num("thickness", "Slab thickness", D, 0.01, 0.05), elev(),
  ]);
  S["curtain-wall"] = schema("curtain-wall" as never, "Curtain wall", "curtain-wall", [
    num("height", "Height", D, 0.1, 0.5), num("thickness", "Mullion depth", D, 0.01, 0.03), elev(),
    prop("uSpacing", "Horizontal grid spacing", K, 0.1, 0.3, 6, "m", 1.5), prop("vSpacing", "Vertical grid spacing", K, 0.1, 0.3, 6, "m", 1.2),
    prop("mullionWidth", "Mullion width", K, 0.005, 0.02, 0.3, "m", 0.05),
  ]);
  S.roof = schema("roof" as never, "Roof", "roof", [
    num("thickness", "Thickness", D, 0.01, 0.03), elev("Eaves elevation"),
    sel("roofType", "Roof type", K, [["gable", "Gable"], ["shed", "Shed (single slope)"]], "gable"),
    prop("slope", "Slope", K, 1, 1, 75, "deg", 30), prop("slopeDirection", "Slope direction (0 = +X)", K, 5, -360, 360, "deg", 0),
  ]);
  S.ceiling = schema("ceiling" as never, "Ceiling", "ceiling", [num("thickness", "Thickness", D, 0.005, 0.005), elev("Ceiling elevation")]);
}

/* ------------------------------------------------------------------- setup */

let installed = false;
export function setupM2Register(): { ok: boolean; detail: string } {
  if (installed) return { ok: true, detail: "already installed" };
  installed = true;
  const w = window as Any;
    w.__obsMeshBuilders = w.__obsMeshBuilders ?? {};
  for (const t of M2_TYPES) w.__obsMeshBuilders[t] = buildM2Mesh;

  // Register Compound Wall builder
  w.__obsMeshBuilders["wall"] = (el: Any) => {
    const p = el.params || {};
    const layerStr = el.properties?.layers;
    if (layerStr) {
      const layers = parseWallLayers(layerStr, Number(p.thickness) || 0.2);
      const geo = buildCompoundWall(p, layers, el.color || "#d9d4c7");
      if (!geo) return null;

      const group = new THREE.Group();
      group.name = `wall:${el.id}`;
      for (const part of geo.parts) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(part.positions, 3));
        g.computeVertexNormals();
        const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(part.color) });
        const mesh = new THREE.Mesh(g, mat);
        mesh.userData.elementId = el.id;
        mesh.userData.baseColor = part.color;
        group.add(mesh);
      }
      return group;
    }
    return null;
  };
  w.__obsM2Quantities = (el: Any) => m2Quantities(el as never);
  registerM2Schemas();
  // authored data may already contain these types: rebuild once so they appear
  try { (ctx.features as Any).authoring?.rebuildAuthored?.(); } catch { /* */ }
  return { ok: true, detail: `${M2_TYPES.length} element types: mesh builders, palette schemas, quantities` };
}
