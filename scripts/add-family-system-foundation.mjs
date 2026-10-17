// Open BIM Studio - Step 1: Family system foundation.
// Adds src/modules/families/*, registers a service, adds one boot step,
// and extends the regression guard. Idempotent.
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const MARK = "openbim-step1:family-foundation";

const stats = { created: 0, patched: 0, noop: 0, skipped: 0, warned: 0 };

function full(rel) { return path.join(root, rel); }
function exists(rel) { try { fs.accessSync(full(rel)); return true; } catch { return false; } }
function read(rel) { try { return fs.readFileSync(full(rel), "utf8"); } catch { return null; } }
function ensureDir(rel) {
  const dir = path.dirname(full(rel));
  fs.mkdirSync(dir, { recursive: true });
}
function backup(rel) {
  if (!exists(rel)) return;
  fs.copyFileSync(full(rel), full(rel) + ".bak-step1-" + stamp);
}
function write(rel, s) { ensureDir(rel); fs.writeFileSync(full(rel), s, "utf8"); }
function log(kind, name, note) {
  let tag;
  if (kind === "CREATE") { tag = "CREATE"; stats.created++; }
  else if (kind === "PATCH") { tag = "PATCH "; stats.patched++; }
  else if (kind === "NOOP") { tag = "NOOP  "; stats.noop++; }
  else if (kind === "WARN") { tag = "WARN  "; stats.warned++; }
  else { tag = "SKIP  "; stats.skipped++; }
  console.log("  [" + tag + "] " + name + (note ? "  -- " + note : ""));
}
function readNorm(rel) {
  const raw = fs.readFileSync(full(rel), "utf8");
  const crlf = raw.indexOf("\r\n") >= 0;
  return { text: crlf ? raw.split("\r\n").join("\n") : raw, crlf };
}
function writeNorm(rel, text, crlf) {
  fs.writeFileSync(full(rel), crlf ? text.split("\n").join("\r\n") : text, "utf8");
}
function dumpContext(text, needle, radius) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf(needle) >= 0) {
      const a = Math.max(0, i - radius), b = Math.min(lines.length - 1, i + radius);
      console.log("    (diag) around line " + (i + 1) + ":");
      for (let j = a; j <= b; j++) console.log("    " + String(j + 1).padStart(5, " ") + " | " + lines[j]);
      return;
    }
  }
  console.log("    (diag) no line contains: " + JSON.stringify(needle));
}

// =============================================================================
// 1. src/modules/families/types.ts
// =============================================================================
const TS_TYPES = `// ${MARK}
// Family system foundation - type definitions.
//
// A FamilyDefinition is a data-driven, user-extensible description of a
// parametric BIM family: named parameters, a geometry recipe, and one or
// more named types. Nothing in this file imports runtime code, so it is
// safe to use as a type-only dependency from services.ts.

import type * as THREE from "three";

export type FamilyCategory =
  | "wall" | "slab" | "column" | "beam" | "brace" | "truss" | "footing"
  | "strip" | "mline" | "door" | "window" | "duct" | "pipe"
  | "cable-tray" | "conduit" | "equipment" | "fitting"
  | "curtain-wall" | "stairs" | "railing" | "ramp" | "roof" | "ceiling"
  | "generic";

export type ParameterType =
  | "length" | "angle" | "number" | "integer" | "text"
  | "boolean" | "material" | "colour" | "family-type";

export type ParameterScope = "instance" | "type";

export interface FamilyParameter {
  name: string;
  type: ParameterType;
  scope: ParameterScope;
  default: any;
  editable: boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  group?: string;
  description?: string;
  /** Formula referencing other parameter names, evaluated in declaration order. */
  formula?: string;
}

export interface FamilyType {
  id: string;
  name: string;
  /** Type-scope parameter overrides. */
  values: Record<string, any>;
}

export type NumberRef = { ref: string } | { const: number };

export type ProfileSpec =
  | { kind: "rect"; w: NumberRef; h: NumberRef }
  | { kind: "circle"; r: NumberRef; segments?: number }
  | { kind: "polygon"; points: [number, number][] };

export interface TransformSpec {
  /** Translation in metres, [x, y, z]. */
  translate?: [NumberRef, NumberRef, NumberRef];
  /** Rotation in radians, [x, y, z]. */
  rotate?: [NumberRef, NumberRef, NumberRef];
  /** Scale, [x, y, z]. */
  scale?: [NumberRef, NumberRef, NumberRef];
}

export type FamilyGeometrySpec =
  | { kind: "box"; w: NumberRef; d: NumberRef; h: NumberRef; transform?: TransformSpec }
  | { kind: "cylinder"; r: NumberRef; h: NumberRef; segments?: number; transform?: TransformSpec }
  | { kind: "extrusion"; profile: ProfileSpec; depth: NumberRef; holes?: ProfileSpec[]; transform?: TransformSpec }
  | { kind: "composed"; parts: FamilyGeometrySpec[] }
  | { kind: "custom"; builder: string };

export interface FamilyDefinition {
  id: string;
  name: string;
  category: FamilyCategory;
  /** IFC entity this family maps to on export. E.g. "IfcWall". */
  ifcEntity: string;
  /** Schema version for future migration. */
  schemaVersion: number;
  /** The element type in the current hardcoded system this family mirrors. */
  sourceElementType?: string;
  parameters: FamilyParameter[];
  geometry: FamilyGeometrySpec;
  types: FamilyType[];
  /** Optional grouping in the browser. */
  group?: string;
  /** Whether this family was shipped with the app. */
  builtIn: boolean;
}

export type CustomGeometryBuilder = (
  params: Record<string, any>,
  resolveNumber: (ref: NumberRef) => number,
  resolveTransform: (t: TransformSpec | undefined) => THREE.Object3D,
) => THREE.Object3D | null;

/** Public family service contract. */
export interface FamilyService {
  list(): FamilyDefinition[];
  get(id: string): FamilyDefinition | null;
  getByElementType(elementType: string): FamilyDefinition | null;

  create(def: Omit<FamilyDefinition, "id" | "schemaVersion" | "builtIn">): FamilyDefinition;
  update(id: string, patch: Partial<FamilyDefinition>): FamilyDefinition | null;
  remove(id: string): boolean;
  duplicate(id: string, newName: string): FamilyDefinition | null;

  createType(familyId: string, name: string, values?: Record<string, any>): FamilyType | null;
  updateType(familyId: string, typeId: string, patch: Partial<FamilyType>): FamilyType | null;
  removeType(familyId: string, typeId: string): boolean;

  resolveParams(
    familyId: string,
    typeId: string | null,
    overrides?: Record<string, any>,
  ): Record<string, any> | null;

  buildGeometry(
    familyId: string,
    typeId: string | null,
    overrides?: Record<string, any>,
  ): THREE.Object3D | null;

  registerCustomBuilder(name: string, fn: CustomGeometryBuilder): void;

  onChange(cb: () => void): () => void;
  reset(): void;
}
`;

// =============================================================================
// 2. src/modules/families/store.ts
// =============================================================================
const TS_STORE = `// ${MARK}
// Family system foundation - in-memory store with localStorage persistence.
//
// Mirrors the pattern used by core/options-registry.ts. Every mutation
// notifies subscribers so the UI (or verify scripts) can react.

import type { FamilyDefinition, FamilyType } from "./types";

const STORAGE_KEY = "obs.families.v1";

function uid(): string {
  return (crypto as any).randomUUID?.()
    ?? ("fam-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8));
}

class FamilyStore {
  private byId = new Map<string, FamilyDefinition>();
  private listeners = new Set<() => void>();
  private booted = false;

  boot(seedBuiltIns: FamilyDefinition[]): void {
    if (this.booted) return;
    this.booted = true;

    let restored: FamilyDefinition[] | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) restored = parsed;
      }
    } catch { /* */ }

    if (restored && restored.length) {
      for (const d of restored) this.byId.set(d.id, d);
    } else {
      for (const d of seedBuiltIns) this.byId.set(d.id, d);
      this.persist();
    }
  }

  list(): FamilyDefinition[] {
    return [...this.byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): FamilyDefinition | null {
    return this.byId.get(id) ?? null;
  }

  getByElementType(elementType: string): FamilyDefinition | null {
    for (const d of this.byId.values()) {
      if (d.sourceElementType === elementType) return d;
    }
    return null;
  }

  create(def: Omit<FamilyDefinition, "id" | "schemaVersion" | "builtIn">): FamilyDefinition {
    const family: FamilyDefinition = {
      ...def,
      id: uid(),
      schemaVersion: 1,
      builtIn: false,
    };
    this.byId.set(family.id, family);
    this.persist();
    this.emit();
    return family;
  }

  update(id: string, patch: Partial<FamilyDefinition>): FamilyDefinition | null {
    const cur = this.byId.get(id);
    if (!cur) return null;
    const next: FamilyDefinition = { ...cur, ...patch, id: cur.id };
    this.byId.set(id, next);
    this.persist();
    this.emit();
    return next;
  }

  remove(id: string): boolean {
    const cur = this.byId.get(id);
    if (!cur) return false;
    if (cur.builtIn) return false;
    const ok = this.byId.delete(id);
    if (ok) { this.persist(); this.emit(); }
    return ok;
  }

  duplicate(id: string, newName: string): FamilyDefinition | null {
    const cur = this.byId.get(id);
    if (!cur) return null;
    const clone: FamilyDefinition = {
      ...JSON.parse(JSON.stringify(cur)),
      id: uid(),
      name: newName,
      builtIn: false,
    };
    this.byId.set(clone.id, clone);
    this.persist();
    this.emit();
    return clone;
  }

  createType(familyId: string, name: string, values: Record<string, any> = {}): FamilyType | null {
    const fam = this.byId.get(familyId);
    if (!fam) return null;
    const t: FamilyType = { id: uid(), name, values };
    fam.types.push(t);
    this.persist();
    this.emit();
    return t;
  }

  updateType(familyId: string, typeId: string, patch: Partial<FamilyType>): FamilyType | null {
    const fam = this.byId.get(familyId);
    if (!fam) return null;
    const idx = fam.types.findIndex((t) => t.id === typeId);
    if (idx < 0) return null;
    fam.types[idx] = { ...fam.types[idx], ...patch, id: typeId };
    this.persist();
    this.emit();
    return fam.types[idx];
  }

  removeType(familyId: string, typeId: string): boolean {
    const fam = this.byId.get(familyId);
    if (!fam) return false;
    const before = fam.types.length;
    fam.types = fam.types.filter((t) => t.id !== typeId);
    if (fam.types.length === before) return false;
    this.persist();
    this.emit();
    return true;
  }

  reset(): void {
    this.byId.clear();
    this.booted = false;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) { try { cb(); } catch { /* */ } }
  }

  private persist(): void {
    try {
      const arr = [...this.byId.values()];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
    } catch (err) {
      console.warn("[families] persist failed", err);
    }
  }
}

export const familyStore = new FamilyStore();
`;

// =============================================================================
// 3. src/modules/families/parametric-geometry.ts
// =============================================================================
const TS_GEOM = `// ${MARK}
// Family system foundation - parametric geometry resolver.
//
// Walks a FamilyGeometrySpec together with a resolved parameter map and
// returns a THREE.Object3D. All primitives are built from scratch with
// THREE geometry classes; this module has no dependency on authoring.ts.

import * as THREE from "three";
import type {
  CustomGeometryBuilder,
  FamilyGeometrySpec,
  NumberRef,
  ProfileSpec,
  TransformSpec,
} from "./types";

const CUSTOM_BUILDERS = new Map<string, CustomGeometryBuilder>();

export function registerCustomBuilder(name: string, fn: CustomGeometryBuilder): void {
  CUSTOM_BUILDERS.set(name, fn);
}

export function getCustomBuilder(name: string): CustomGeometryBuilder | null {
  return CUSTOM_BUILDERS.get(name) ?? null;
}

/** Resolve a NumberRef to a concrete number given the parameter map. */
export function resolveNumber(ref: NumberRef, params: Record<string, any>): number {
  if ("const" in ref) return ref.const;
  const v = params[ref.ref];
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) {
    console.warn("[families] NumberRef '" + ref.ref + "' resolved to non-number; using 0");
    return 0;
  }
  return n;
}

/** Build a Transform matrix from a TransformSpec. */
export function resolveTransform(
  spec: TransformSpec | undefined,
  params: Record<string, any>,
): THREE.Object3D {
  const wrapper = new THREE.Group();
  if (!spec) return wrapper;
  if (spec.translate) {
    wrapper.position.set(
      resolveNumber(spec.translate[0], params),
      resolveNumber(spec.translate[1], params),
      resolveNumber(spec.translate[2], params),
    );
  }
  if (spec.rotate) {
    wrapper.rotation.set(
      resolveNumber(spec.rotate[0], params),
      resolveNumber(spec.rotate[1], params),
      resolveNumber(spec.rotate[2], params),
    );
  }
  if (spec.scale) {
    wrapper.scale.set(
      resolveNumber(spec.scale[0], params),
      resolveNumber(spec.scale[1], params),
      resolveNumber(spec.scale[2], params),
    );
  }
  return wrapper;
}

function profileToShape(profile: ProfileSpec, params: Record<string, any>): THREE.Shape {
  const shape = new THREE.Shape();
  if (profile.kind === "rect") {
    const w = resolveNumber(profile.w, params);
    const h = resolveNumber(profile.h, params);
    shape.moveTo(-w / 2, -h / 2);
    shape.lineTo( w / 2, -h / 2);
    shape.lineTo( w / 2,  h / 2);
    shape.lineTo(-w / 2,  h / 2);
    shape.closePath();
  } else if (profile.kind === "circle") {
    const r = resolveNumber(profile.r, params);
    shape.absarc(0, 0, r, 0, Math.PI * 2, false);
  } else if (profile.kind === "polygon") {
    const pts = profile.points;
    if (pts.length < 3) return shape;
    shape.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
    shape.closePath();
  }
  return shape;
}

function profileToHole(profile: ProfileSpec, params: Record<string, any>): THREE.Path {
  const shape = profileToShape(profile, params);
  const path = new THREE.Path();
  const pts = shape.getPoints(64);
  if (pts.length < 3) return path;
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  path.closePath();
  return path;
}

/**
 * Build a THREE.Object3D from a FamilyGeometrySpec + resolved parameters.
 * Returns null on unsupported spec or empty geometry.
 */
export function buildParametricGeometry(
  spec: FamilyGeometrySpec,
  params: Record<string, any>,
): THREE.Object3D | null {
  switch (spec.kind) {
    case "box": {
      const w = resolveNumber(spec.w, params);
      const d = resolveNumber(spec.d, params);
      const h = resolveNumber(spec.h, params);
      if (w <= 0 || d <= 0 || h <= 0) return null;
      const geo = new THREE.BoxGeometry(w, h, d);
      const mesh = new THREE.Mesh(geo);
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(mesh);
      return wrap;
    }

    case "cylinder": {
      const r = resolveNumber(spec.r, params);
      const h = resolveNumber(spec.h, params);
      const seg = spec.segments ?? 24;
      if (r <= 0 || h <= 0) return null;
      const geo = new THREE.CylinderGeometry(r, r, h, seg);
      const mesh = new THREE.Mesh(geo);
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(mesh);
      return wrap;
    }

    case "extrusion": {
      const shape = profileToShape(spec.profile, params);
      if (spec.holes && spec.holes.length) {
        for (const h of spec.holes) shape.holes.push(profileToHole(h, params));
      }
      const depth = resolveNumber(spec.depth, params);
      if (depth <= 0) return null;
      const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
      // Extrusion runs along +Z; centre it on Z so the transform origin is
      // the mid-depth of the solid. Caller can override with transform.
      geo.translate(0, 0, -depth / 2);
      const mesh = new THREE.Mesh(geo);
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(mesh);
      return wrap;
    }

    case "composed": {
      const group = new THREE.Group();
      for (const part of spec.parts) {
        const child = buildParametricGeometry(part, params);
        if (child) group.add(child);
      }
      return group.children.length ? group : null;
    }

    case "custom": {
      const builder = CUSTOM_BUILDERS.get(spec.builder);
      if (!builder) {
        console.warn("[families] custom builder '" + spec.builder + "' is not registered");
        return null;
      }
      return builder(params, (ref) => resolveNumber(ref, params), (t) => resolveTransform(t, params));
    }
  }

  return null;
}

/** Colour every mesh in the tree with the given THREE colour. */
export function tintObject(root: THREE.Object3D, colour: THREE.Color | string): void {
  const c = colour instanceof THREE.Color ? colour : new THREE.Color(colour);
  root.traverse((obj: any) => {
    if (!obj.isMesh) return;
    if (!obj.material) obj.material = new THREE.MeshLambertMaterial({ color: c });
    else if (obj.material.color) obj.material.color.copy(c);
  });
}
`;

// =============================================================================
// 4. src/modules/families/registry.ts
// =============================================================================
const TS_REGISTRY = `// ${MARK}
// Family system foundation - registry that ties store + geometry + params.

import * as THREE from "three";
import { familyStore } from "./store";
import { buildParametricGeometry, registerCustomBuilder } from "./parametric-geometry";
import type {
  CustomGeometryBuilder,
  FamilyDefinition,
  FamilyParameter,
  FamilyService,
  FamilyType,
} from "./types";

/** Resolve parameters for a family/type, applying instance overrides last. */
function resolveParameters(
  family: FamilyDefinition,
  type: FamilyType | null,
  overrides: Record<string, any> | undefined,
): Record<string, any> {
  const params: Record<string, any> = {};

  // 1. Family defaults.
  for (const p of family.parameters) {
    params[p.name] = p.default;
  }

  // 2. Type-scope overrides.
  if (type) {
    for (const [k, v] of Object.entries(type.values)) {
      params[k] = v;
    }
  }

  // 3. Instance overrides.
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      params[k] = v;
    }
  }

  // 4. Formulas in declaration order (they may reference earlier params).
  for (const p of family.parameters) {
    if (!p.formula) continue;
    try {
      const fn = new Function(...Object.keys(params), "return (" + p.formula + ";");
      const v = fn(...Object.values(params));
      if (v !== undefined && v !== null && Number.isFinite(Number(v))) {
        params[p.name] = Number(v);
      }
    } catch (err) {
      console.warn("[families] formula for '" + p.name + "' failed:", err);
    }
  }

  return params;
}

export function createFamilyService(): FamilyService {
  const svc: FamilyService = {
    list: () => familyStore.list(),
    get: (id) => familyStore.get(id),
    getByElementType: (et) => familyStore.getByElementType(et),

    create: (def) => familyStore.create(def),
    update: (id, patch) => familyStore.update(id, patch),
    remove: (id) => familyStore.remove(id),
    duplicate: (id, name) => familyStore.duplicate(id, name),

    createType: (fid, name, values) => familyStore.createType(fid, name, values),
    updateType: (fid, tid, patch) => familyStore.updateType(fid, tid, patch),
    removeType: (fid, tid) => familyStore.removeType(fid, tid),

    resolveParams: (fid, tid, overrides) => {
      const fam = familyStore.get(fid);
      if (!fam) return null;
      const type = tid ? fam.types.find((t) => t.id === tid) ?? null : null;
      return resolveParameters(fam, type, overrides);
    },

    buildGeometry: (fid, tid, overrides) => {
      const fam = familyStore.get(fid);
      if (!fam) return null;
      const type = tid ? fam.types.find((t) => t.id === tid) ?? null : null;
      const params = resolveParameters(fam, type, overrides);
      const obj = buildParametricGeometry(fam.geometry, params);
      if (!obj) return null;
      obj.userData.familyId = fam.id;
      obj.userData.familyTypeId = tid;
      obj.userData.familyParams = params;
      return obj;
    },

    registerCustomBuilder: (name, fn) => registerCustomBuilder(name, fn),

    onChange: (cb) => familyStore.onChange(cb),
    reset: () => familyStore.reset(),
  };
  return svc;
}

/** Type-guard helper used by built-in family definitions. */
export function isFamilyParameter(v: any): v is FamilyParameter {
  return v && typeof v === "object" && typeof v.name === "string" && typeof v.type === "string";
}

/** Expose the raw geometry builder for tests / editor previews. */
export { buildParametricGeometry, resolveParameters };

/** Convenience: build a bare THREE.Group from a family + type. */
export function buildFamilyPreview(
  svc: FamilyService,
  familyId: string,
  typeId: string | null,
): THREE.Object3D | null {
  return svc.buildGeometry(familyId, typeId, undefined);
}

// Re-export the register hook so modules can install custom builders without
// importing parametric-geometry directly.
export type { CustomGeometryBuilder };
`;

// =============================================================================
// 5. src/modules/families/builtin-families.ts
// =============================================================================
const TS_BUILTIN = `// ${MARK}
// Built-in families mirroring the current hardcoded element types in
// authoring.ts. When authoring is later refactored to consult this
// registry, the behaviour must stay identical for these ten families.

import type { FamilyDefinition } from "./types";

const REF = (name: string) => ({ ref: name });
const CONST = (n: number) => ({ const: n });

export function createBuiltInFamilies(): FamilyDefinition[] {
  const families: FamilyDefinition[] = [];
  let seq = 0;
  const id = (name: string) => "builtin-" + name + "-" + (++seq);

  // ---- wall ---------------------------------------------------------------
  families.push({
    id: id("wall"),
    name: "Basic Wall",
    category: "wall",
    ifcEntity: "IfcWall",
    schemaVersion: 1,
    sourceElementType: "wall",
    builtIn: true,
    parameters: [
      { name: "height",    type: "length", scope: "instance", default: 3.0, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "thickness", type: "length", scope: "instance", default: 0.2, editable: true, step: 0.01, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: CONST(1),
      d: REF("thickness"),
      h: REF("height"),
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("wall-100"), name: "Generic 100 mm", values: { thickness: 0.1 } },
      { id: id("wall-200"), name: "Generic 200 mm", values: { thickness: 0.2 } },
      { id: id("wall-300"), name: "Generic 300 mm", values: { thickness: 0.3 } },
    ],
  });

  // ---- slab ---------------------------------------------------------------
  families.push({
    id: id("slab"),
    name: "Basic Floor",
    category: "slab",
    ifcEntity: "IfcSlab",
    schemaVersion: 1,
    sourceElementType: "slab",
    builtIn: true,
    parameters: [
      { name: "thickness", type: "length", scope: "instance", default: 0.2, editable: true, step: 0.01, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: CONST(1),
      d: CONST(1),
      h: REF("thickness"),
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("slab-150"), name: "Concrete 150 mm", values: { thickness: 0.15 } },
      { id: id("slab-200"), name: "Concrete 200 mm", values: { thickness: 0.2 } },
      { id: id("slab-250"), name: "Concrete 250 mm", values: { thickness: 0.25 } },
    ],
  });

  // ---- column -------------------------------------------------------------
  families.push({
    id: id("column"),
    name: "Basic Column",
    category: "column",
    ifcEntity: "IfcColumn",
    schemaVersion: 1,
    sourceElementType: "column",
    builtIn: true,
    parameters: [
      { name: "height",    type: "length", scope: "instance", default: 3.0, editable: true, step: 0.1, unit: "m", group: "Dimensions" },
      { name: "thickness", type: "length", scope: "instance", default: 0.3, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "depth",     type: "length", scope: "instance", default: 0.3, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: REF("thickness"),
      d: REF("depth"),
      h: REF("height"),
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("col-300"), name: "300 x 300", values: { thickness: 0.3, depth: 0.3 } },
      { id: id("col-400"), name: "400 x 400", values: { thickness: 0.4, depth: 0.4 } },
    ],
  });

  // ---- beam ---------------------------------------------------------------
  families.push({
    id: id("beam"),
    name: "Basic Beam",
    category: "beam",
    ifcEntity: "IfcBeam",
    schemaVersion: 1,
    sourceElementType: "beam",
    builtIn: true,
    parameters: [
      { name: "height",    type: "length", scope: "instance", default: 0.5, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "thickness", type: "length", scope: "instance", default: 0.25, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: CONST(1),
      d: REF("thickness"),
      h: REF("height"),
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("beam-300x500"), name: "300 x 500", values: { thickness: 0.3, height: 0.5 } },
      { id: id("beam-250x500"), name: "250 x 500", values: { thickness: 0.25, height: 0.5 } },
    ],
  });

  // ---- door ---------------------------------------------------------------
  families.push({
    id: id("door"),
    name: "Basic Door",
    category: "door",
    ifcEntity: "IfcDoor",
    schemaVersion: 1,
    sourceElementType: "door",
    builtIn: true,
    parameters: [
      { name: "width",           type: "length",  scope: "type",     default: 0.9,  editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "height",          type: "length",  scope: "type",     default: 2.1,  editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "frameThickness",  type: "length",  scope: "type",     default: 0.06, editable: true, step: 0.005, unit: "m", group: "Construction" },
      { name: "sillHeight",      type: "length",  scope: "instance", default: 0.0,  editable: true, step: 0.05, unit: "m", group: "Constraints" },
      { name: "offsetAlongHost", type: "length",  scope: "instance", default: 0.0,  editable: true, step: 0.05, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: REF("width"),
      d: CONST(0.04),
      h: REF("height"),
      transform: {
        translate: [CONST(0), { ref: "sillHeight" }, CONST(0)],
      },
    },
    types: [
      { id: id("door-900"), name: "Single 900 x 2100", values: { width: 0.9, height: 2.1 } },
      { id: id("door-1000"), name: "Single 1000 x 2100", values: { width: 1.0, height: 2.1 } },
      { id: id("door-double"), name: "Double 1800 x 2100", values: { width: 1.8, height: 2.1 } },
    ],
  });

  // ---- window -------------------------------------------------------------
  families.push({
    id: id("window"),
    name: "Basic Window",
    category: "window",
    ifcEntity: "IfcWindow",
    schemaVersion: 1,
    sourceElementType: "window",
    builtIn: true,
    parameters: [
      { name: "width",           type: "length", scope: "type",     default: 1.2,  editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "height",          type: "length", scope: "type",     default: 1.4,  editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "frameThickness",  type: "length", scope: "type",     default: 0.05, editable: true, step: 0.005, unit: "m", group: "Construction" },
      { name: "sillHeight",      type: "length", scope: "instance", default: 0.9,  editable: true, step: 0.05, unit: "m", group: "Constraints" },
      { name: "offsetAlongHost", type: "length", scope: "instance", default: 0.0,  editable: true, step: 0.05, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: REF("width"),
      d: CONST(0.03),
      h: REF("height"),
      transform: { translate: [CONST(0), { ref: "sillHeight" }, CONST(0)] },
    },
    types: [
      { id: id("win-1200x1400"), name: "1200 x 1400", values: { width: 1.2, height: 1.4 } },
      { id: id("win-1500x1500"), name: "1500 x 1500", values: { width: 1.5, height: 1.5 } },
    ],
  });

  // ---- duct ---------------------------------------------------------------
  families.push({
    id: id("duct"),
    name: "Rectangular Duct",
    category: "duct",
    ifcEntity: "IfcDuctSegment",
    schemaVersion: 1,
    sourceElementType: "duct",
    builtIn: true,
    parameters: [
      { name: "width",     type: "length", scope: "type",     default: 0.6, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "height",    type: "length", scope: "type",     default: 0.4, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: CONST(1),
      d: REF("width"),
      h: REF("height"),
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("duct-600x400"), name: "600 x 400", values: { width: 0.6, height: 0.4 } },
      { id: id("duct-400x300"), name: "400 x 300", values: { width: 0.4, height: 0.3 } },
    ],
  });

  // ---- pipe ---------------------------------------------------------------
  families.push({
    id: id("pipe"),
    name: "Round Pipe",
    category: "pipe",
    ifcEntity: "IfcPipeSegment",
    schemaVersion: 1,
    sourceElementType: "pipe",
    builtIn: true,
    parameters: [
      { name: "diameter",  type: "length", scope: "type",     default: 0.1, editable: true, step: 0.005, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "cylinder",
      r: { const: 0.05 },
      h: CONST(1),
      segments: 16,
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("pipe-dn50"),  name: "DN 50",  values: { diameter: 0.05 } },
      { id: id("pipe-dn100"), name: "DN 100", values: { diameter: 0.1 } },
      { id: id("pipe-dn150"), name: "DN 150", values: { diameter: 0.15 } },
    ],
  });

  // ---- cable tray ---------------------------------------------------------
  families.push({
    id: id("cable-tray"),
    name: "Cable Tray",
    category: "cable-tray",
    ifcEntity: "IfcCableCarrierSegment",
    schemaVersion: 1,
    sourceElementType: "cable-tray",
    builtIn: true,
    parameters: [
      { name: "width",     type: "length", scope: "type",     default: 0.3, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "depth",     type: "length", scope: "type",     default: 0.1, editable: true, step: 0.01, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: CONST(1),
      d: REF("width"),
      h: REF("depth"),
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("tray-300"), name: "300 mm", values: { width: 0.3, depth: 0.1 } },
      { id: id("tray-450"), name: "450 mm", values: { width: 0.45, depth: 0.1 } },
    ],
  });

  // ---- conduit ------------------------------------------------------------
  families.push({
    id: id("conduit"),
    name: "Conduit",
    category: "conduit",
    ifcEntity: "IfcCableCarrierSegment",
    schemaVersion: 1,
    sourceElementType: "conduit",
    builtIn: true,
    parameters: [
      { name: "diameter",  type: "length", scope: "type",     default: 0.025, editable: true, step: 0.005, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "cylinder",
      r: { const: 0.0125 },
      h: CONST(1),
      segments: 12,
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("conduit-20"), name: "20 mm", values: { diameter: 0.02 } },
      { id: id("conduit-25"), name: "25 mm", values: { diameter: 0.025 } },
    ],
  });

  // ---- equipment (generic placeholder family) ----------------------------
  families.push({
    id: id("equipment"),
    name: "Generic Equipment",
    category: "equipment",
    ifcEntity: "IfcBuildingElementProxy",
    schemaVersion: 1,
    sourceElementType: "equipment",
    builtIn: true,
    parameters: [
      { name: "width",     type: "length", scope: "type",     default: 0.8, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "depth",     type: "length", scope: "type",     default: 0.8, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "height",    type: "length", scope: "type",     default: 1.2, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: REF("width"),
      d: REF("depth"),
      h: REF("height"),
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("equip-generic"), name: "Generic 800 x 800 x 1200", values: { width: 0.8, depth: 0.8, height: 1.2 } },
    ],
  });

  return families;
}
`;

// =============================================================================
// 6. src/modules/families/index.ts
// =============================================================================
const TS_INDEX = `// ${MARK}
// Family system foundation - public entry point.
//
// Importing this module installs the family service in the typed service
// registry and mounts it on ctx.features.family. Call setupFamilies()
// once during boot; it is idempotent.

import { ctx } from "../../core/context";
import { register } from "../../core/services";
import { familyStore } from "./store";
import { createFamilyService } from "./registry";
import { createBuiltInFamilies } from "./builtin-families";
import type { FamilyService } from "./types";

export * from "./types";
export { familyStore } from "./store";
export {
  buildParametricGeometry,
  registerCustomBuilder,
  resolveNumber,
  resolveTransform,
} from "./parametric-geometry";
export {
  createFamilyService,
  buildFamilyPreview,
} from "./registry";
export { createBuiltInFamilies } from "./builtin-families";

let installed = false;

export function setupFamilies(): FamilyService {
  if (installed) {
    return (ctx.features as any).family as FamilyService;
  }
  installed = true;

  // Seed built-ins on first boot, then load any persisted user families.
  const builtins = createBuiltInFamilies();
  familyStore.boot(builtins);

  const svc = createFamilyService();

  register("family", svc);
  (ctx.features as any).family = svc;
  try { (window as any).__obsFamily = svc; } catch { /* */ }

  // Diagnostics.
  const list = svc.list();
  console.log(
    "[families] ready. " + list.length + " family definition(s), " +
    list.reduce((n, f) => n + f.types.length, 0) + " type(s)."
  );

  return svc;
}

/** True after setupFamilies() has run. */
export function isFamilySystemReady(): boolean {
  return installed;
}
`;

// =============================================================================
// CREATE: write the six modules (skip if already present)
// =============================================================================
const FILES = [
  ["src/modules/families/types.ts", TS_TYPES],
  ["src/modules/families/store.ts", TS_STORE],
  ["src/modules/families/parametric-geometry.ts", TS_GEOM],
  ["src/modules/families/registry.ts", TS_REGISTRY],
  ["src/modules/families/builtin-families.ts", TS_BUILTIN],
  ["src/modules/families/index.ts", TS_INDEX],
];

for (const [rel, content] of FILES) {
  if (exists(rel)) {
    const cur = read(rel);
    if (cur && cur.indexOf(MARK) >= 0) { log("NOOP", rel + " (already present)"); continue; }
    log("WARN", rel + " (exists but no marker; leaving untouched)");
    continue;
  }
  write(rel, content);
  log("CREATE", rel);
}

// =============================================================================
// PATCH: src/core/services.ts -- register the FamilyService in the map
// =============================================================================
function patchServices() {
  const rel = "src/core/services.ts";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }
  const { text: s0, crlf } = readNorm(rel);
  let s = s0;
  let changed = false;

  // Import FamilyService.
  if (s.indexOf('import type { FamilyService }') < 0) {
    const importAnchor = 'import type { FragEdit } from "../features/frag-edit";';
    if (s.indexOf(importAnchor) >= 0) {
      s = s.replace(
        importAnchor,
        importAnchor + '\nimport type { FamilyService } from "../modules/families/types";'
      );
      changed = true;
    } else {
      log("WARN", rel + " (import anchor missing)");
    }
  }

  // Add to ServiceMap interface after `authoring: AuthoringService;`.
  if (s.indexOf("family: FamilyService;") < 0) {
    const mapAnchor = "  authoring: AuthoringService;";
    if (s.indexOf(mapAnchor) >= 0) {
      s = s.replace(mapAnchor, mapAnchor + "\n  family: FamilyService;");
      changed = true;
    } else {
      log("WARN", rel + " (ServiceMap anchor missing)");
    }
  }

  // Add the getter after `get authoring()`.
  if (s.indexOf('get family(): FamilyService') < 0) {
    const getAnchor = '  get authoring(): AuthoringService { return use("authoring"); },';
    if (s.indexOf(getAnchor) >= 0) {
      s = s.replace(
        getAnchor,
        getAnchor + '\n  get family(): FamilyService { return use("family"); },'
      );
      changed = true;
    } else {
      log("WARN", rel + " (getter anchor missing)");
    }
  }

  if (changed) {
    backup(rel);
    writeNorm(rel, s, crlf);
    log("PATCH", rel + " (registered FamilyService)");
  } else {
    log("NOOP", rel + " (nothing to do)");
  }
}
patchServices();

// =============================================================================
// PATCH: src/main.ts -- add the boot step after setupAuthoring
// =============================================================================
function patchMain() {
  const rel = "src/main.ts";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }
  const { text: s0, crlf } = readNorm(rel);
  let s = s0;
  let changed = false;

  // Import.
  if (s.indexOf('setupFamilies') < 0) {
    const importAnchor = 'import { setupAuthoring } from "./features/authoring";';
    if (s.indexOf(importAnchor) >= 0) {
      s = s.replace(
        importAnchor,
        importAnchor + '\nimport { setupFamilies } from "./modules/families";'
      );
      changed = true;
    } else {
      log("WARN", rel + " (import anchor missing)");
    }
  }

  // Boot step.
  if (s.indexOf('setupFamilies()') < 0) {
    const stepAnchor = 'await step("authoring", () => setupAuthoring());';
    if (s.indexOf(stepAnchor) >= 0) {
      s = s.replace(
        stepAnchor,
        stepAnchor + '\nawait step("families", () => setupFamilies());'
      );
      changed = true;
    } else {
      log("WARN", rel + " (boot step anchor missing)");
    }
  }

  if (changed) {
    backup(rel);
    writeNorm(rel, s, crlf);
    log("PATCH", rel + " (wired families boot step)");
  } else {
    log("NOOP", rel + " (nothing to do)");
  }
}
patchMain();

// =============================================================================
// PATCH: scripts/verify-input-focus.mjs -- add [family-foundation] group
// =============================================================================
function patchVerify() {
  const rel = "scripts/verify-input-focus.mjs";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }
  const { text: s0, crlf } = readNorm(rel);
  if (s0.indexOf(MARK) >= 0) { log("NOOP", rel + " (already extended)"); return; }

  const anchor = "const byGroup = {};";
  const idx = s0.indexOf(anchor);
  if (idx < 0) { log("WARN", rel + " (report anchor missing)"); return; }

  const block = [
    "// ---- " + MARK + " ----",
    'const famTypes = read("src/modules/families/types.ts") || "";',
    'check("family-foundation", "types.ts defines FamilyDefinition", /export interface FamilyDefinition/.test(famTypes));',
    'check("family-foundation", "types.ts defines FamilyService", /export interface FamilyService/.test(famTypes));',
    'const famStore = read("src/modules/families/store.ts") || "";',
    'check("family-foundation", "store.ts boots from localStorage", /obs\\.families\\.v1/.test(famStore));',
    'check("family-foundation", "store.ts dedupes via Map", /new Map<string, FamilyDefinition>/.test(famStore));',
    'const famGeom = read("src/modules/families/parametric-geometry.ts") || "";',
    'check("family-foundation", "geometry resolver handles box", /case "box":/.test(famGeom));',
    'check("family-foundation", "geometry resolver handles cylinder", /case "cylinder":/.test(famGeom));',
    'check("family-foundation", "geometry resolver handles extrusion", /case "extrusion":/.test(famGeom));',
    'check("family-foundation", "geometry resolver handles composed", /case "composed":/.test(famGeom));',
    'const famRegistry = read("src/modules/families/registry.ts") || "";',
    'check("family-foundation", "registry resolves params with formulas", /function resolveParameters/.test(famRegistry));',
    'check("family-foundation", "registry exposes buildGeometry", /buildGeometry:/.test(famRegistry));',
    'const famBuiltin = read("src/modules/families/builtin-families.ts") || "";',
    'check("family-foundation", "builtin has wall", /sourceElementType: "wall"/.test(famBuiltin));',
    'check("family-foundation", "builtin has door", /sourceElementType: "door"/.test(famBuiltin));',
    'check("family-foundation", "builtin has duct", /sourceElementType: "duct"/.test(famBuiltin));',
    'check("family-foundation", "builtin has pipe", /sourceElementType: "pipe"/.test(famBuiltin));',
    'const famIndex = read("src/modules/families/index.ts") || "";',
    'check("family-foundation", "index exports setupFamilies", /export function setupFamilies/.test(famIndex));',
    'const svcSrc = read("src/core/services.ts") || "";',
    'check("family-foundation", "services.ts imports FamilyService", /import type \\{ FamilyService \\}/.test(svcSrc));',
    'check("family-foundation", "services.ts has family in ServiceMap", /family:\\s*FamilyService;/.test(svcSrc));',
    'check("family-foundation", "services.ts exposes services.family", /get family\\(\\): FamilyService/.test(svcSrc));',
    'const mainSrc = read("src/main.ts") || "";',
    'check("family-foundation", "main.ts imports setupFamilies", /from "\\.\\/modules\\/families"/.test(mainSrc));',
    'check("family-foundation", "main.ts boots families", /step\\("families"/.test(mainSrc));',
    "",
  ].join("\n");

  const s = s0.slice(0, idx) + block + s0.slice(idx);
  backup(rel);
  writeNorm(rel, s, crlf);
  log("PATCH", rel + " (added [family-foundation] group)");
}
patchVerify();

// =============================================================================
// Run summary
// =============================================================================
console.log("");
console.log("Summary: " + stats.created + " created, " + stats.patched + " patched, " +
            stats.noop + " no-op, " + stats.skipped + " skipped, " + stats.warned + " warned.");
console.log("");
if (stats.warned > 0) {
  console.log("Some anchors did not match. Copy the (diag) block above for a targeted repair.");
  console.log("");
}