/**
 * Family store bridge — the two family systems, joined.
 *
 * System A (TS service): `familyStore` + the parametric service
 * (`ctx.features.family` / `window.__obsFamily`), seeded with the sample
 * parametric door. Families are `FamilyDefinition` records, persisted
 * per project to `obs.families.v1.<projectId>`.
 *
 * System B (legacy editor): `public/js/obs-family-editor.js`, a plain
 * script whose "Save to library" writes only to localStorage
 * `obs.families.v1` (an object keyed by family name) and whose shared
 * parameters live only in `obs.families.shared.v1`.
 *
 * Before this bridge the two never met: a Creator-built family never
 * appeared in the Parametric Panel or Family Browser, and a service
 * family (including the sample door) was invisible in the editor's
 * library. Neither store is retired — this module syncs them both ways:
 *
 *   editor save  -> `pushEditorFamily`  -> familyStore (panel/browser see it)
 *   store change -> `exportServiceFamilies` -> `obs.families.v1` (editor sees it)
 *   shared params sync both ways between `obs.families.shared.v1` and the
 *   `SharedParameterManager` (`openbimstudio.shared-parameters`).
 *
 * Identity: the TS family id is stamped onto the editor record as
 * `serviceId`; editor records without one match by name on import (the
 * editor's own identity model — its library is keyed by name). Type ids
 * are preserved across updates by matching types by name. A repeated
 * save therefore updates the same family instead of duplicating it.
 *
 * The store is authoritative after bridging: export reconciles the
 * editor library against the store (entries whose `serviceId` left the
 * exportable set are removed), and an editor delete of a bridged family
 * removes it from the store too (`removeBridgedFamily`).
 *
 * Export scope: only non-built-in, non-seed-catalog families are
 * exported — the 54 shipped seed families would otherwise flood the
 * editor's user library. Seed families are stamped `origin:
 * "seed-catalog"` by the library loader.
 *
 * Geometry: Extrusion maps faithfully both ways (Rectangle / Circle /
 * Polygon profiles; depth as a parameter reference or a constant).
 * Other editor kinds (Revolve / Sweep / Blend / Boolean) have no TS
 * geometry equivalent yet: the TS record keeps the kind string (the
 * migrator keeps unknown kinds as-is and the engine returns null for
 * them — migration rule 7) and the verbatim editor recipe rides in
 * `editorSource`, so a round-trip back to the editor restores it
 * exactly. The same applies in reverse: a TS family whose geometry is
 * not an extrusion is shown in the editor with its kind as a badge and
 * its verbatim geometry in `serviceGeometry`; editing its recipe in
 * the editor has no effect until a recipe editor for those kinds
 * exists — parameters and types still round-trip.
 *
 * This module is deliberately dependency-light: its only runtime import
 * is the family migrator, so the node suite can compile it standalone
 * (same pattern as tests/family-migration.test.cjs). All sync functions
 * take their store / manager / storage as arguments; the app wiring
 * (boot hook, `window.__obsFamilyBridge`, live panel refresh) lives in
 * `family-bridge-boot.ts`.
 */

import { migrateFamilyDefinition } from "./migration";
import type {
  FamilyCategory,
  FamilyDefinition,
  FamilyGeometrySpec,
  FamilyParameter,
  FamilyType,
  NumberRef,
  ParameterType,
  ProfileSpec,
} from "./types";
import type { Constraint } from "./constraint-graph";
import type { SharedParameter, SharedParameterType } from "./shared-parameters";

/** Legacy editor library: an object keyed by family name. */
export const EDITOR_LIBRARY_KEY = "obs.families.v1";
/** Legacy editor shared parameters: an array of `{ name, kind }`. */
export const EDITOR_SHARED_KEY = "obs.families.shared.v1";

// ── Editor shapes (structural — the editor is plain JS, no types) ──────────

export interface EditorParameter {
  name: string;
  kind: string;
  isType?: boolean;
  default?: unknown;
  formula?: string;
  group?: string;
  shared?: boolean;
}

export interface EditorFamily {
  name: string;
  category?: string;
  description?: string;
  manufacturer?: string;
  model?: string;
  version?: string;
  placement?: { kind?: string; host?: string; workPlane?: string };
  parameters?: EditorParameter[];
  types?: Array<{ name: string; values?: Record<string, unknown> }>;
  constraints?: Array<{ kind?: string; target?: string[]; params?: Record<string, unknown> }>;
  sharedParamRefs?: string[];
  geometry?: Record<string, any>;
  /** TS family id, stamped by the bridge so repeat saves update. */
  serviceId?: string;
  /** Project the stamped serviceId belongs to (see PushOptions.projectId). */
  serviceProject?: string;
  /** TS ifcEntity, stamped by the bridge so it round-trips. */
  serviceIfcEntity?: string;
  /** Verbatim TS geometry for families whose geometry is not an extrusion. */
  serviceGeometry?: unknown;
  [key: string]: unknown;
}

export interface EditorSharedParameter {
  name: string;
  kind: string;
  /** TS shared-parameter GUID, stamped by the bridge. */
  guid?: string;
}

// ── Adapters (the real store / manager satisfy these) ───────────────────────

export interface BridgeFamilyStore {
  list(): FamilyDefinition[];
  get(id: string): FamilyDefinition | null;
  create(def: Omit<FamilyDefinition, "id" | "schemaVersion" | "builtIn">): FamilyDefinition;
  update(id: string, patch: Partial<FamilyDefinition>): FamilyDefinition | null;
  remove(id: string): boolean;
}

export interface BridgeSharedManager {
  findByName(name: string): SharedParameter | null;
  create(input: Omit<SharedParameter, "guid"> & { guid?: string }): SharedParameter;
  list(): SharedParameter[];
}

export type BridgeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// ── Category / kind maps ────────────────────────────────────────────────────

const EDITOR_CATEGORY_TO_TS: Record<string, FamilyCategory> = {
  Doors: "door",
  Windows: "window",
  Walls: "wall",
  Columns: "column",
  Beams: "beam",
  Slabs: "slab",
  Equipment: "equipment",
  Furniture: "generic",
  Lighting: "generic",
  Plumbing: "generic",
  Electrical: "generic",
  HVAC: "generic",
  Site: "generic",
  Annotation: "generic",
  "Specialty Equipment": "equipment",
  Generic: "generic",
};

const TS_CATEGORY_TO_EDITOR: Record<string, string> = {
  door: "Doors",
  window: "Windows",
  wall: "Walls",
  column: "Columns",
  beam: "Beams",
  slab: "Slabs",
  equipment: "Equipment",
  duct: "HVAC",
  pipe: "Plumbing",
  fitting: "Plumbing",
  "cable-tray": "Electrical",
  conduit: "Electrical",
  "curtain-wall": "Windows",
  footing: "Generic",
  strip: "Generic",
  mline: "Generic",
  brace: "Generic",
  truss: "Generic",
  stairs: "Generic",
  railing: "Generic",
  ramp: "Generic",
  roof: "Generic",
  ceiling: "Generic",
  generic: "Generic",
};

const IFC_ENTITY_BY_CATEGORY: Record<string, string> = {
  door: "IfcDoor",
  window: "IfcWindow",
  wall: "IfcWall",
  column: "IfcColumn",
  beam: "IfcBeam",
  slab: "IfcSlab",
  roof: "IfcRoof",
  stairs: "IfcStair",
  railing: "IfcRailing",
  ramp: "IfcRamp",
  ceiling: "IfcCovering",
  footing: "IfcFooting",
  duct: "IfcDuctSegment",
  pipe: "IfcPipeSegment",
  "cable-tray": "IfcCableCarrierSegment",
  conduit: "IfcCableCarrierSegment",
  equipment: "IfcElectricGenerator",
};

const EDITOR_KIND_TO_TS: Record<string, ParameterType> = {
  Length: "length",
  Number: "number",
  Angle: "angle",
  YesNo: "boolean",
  Text: "text",
  Material: "material",
  Integer: "integer",
};

const TS_TYPE_TO_EDITOR_KIND: Record<string, string> = {
  length: "Length",
  number: "Number",
  angle: "Angle",
  boolean: "YesNo",
  text: "Text",
  material: "Material",
  integer: "Integer",
  // The editor has no Area / Volume / Colour / Family-type kinds:
  // they surface as Number / Text so the parameter stays editable.
  area: "Number",
  volume: "Number",
  colour: "Text",
  "family-type": "Text",
};

/** Shared-parameter kinds use the manager's type names, which differ
 * from family parameter types: the editor "Text" kind is a manager
 * "string", not a family "text". (Do not alias the family map — the
 * two unions only look alike.) */
const EDITOR_KIND_TO_SHARED_TYPE: Record<string, SharedParameterType> = {
  Length: "length",
  Number: "number",
  Angle: "angle",
  YesNo: "boolean",
  Text: "string",
  Material: "material",
  Integer: "integer",
};
const SHARED_TYPE_TO_EDITOR_KIND: Record<string, string> = {
  length: "Length",
  number: "Number",
  angle: "Angle",
  boolean: "YesNo",
  string: "Text",
  material: "Material",
  integer: "Integer",
  area: "Number",
  volume: "Number",
};

// ── Small helpers ───────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function uid(): string {
  return (crypto as any).randomUUID?.()
    ?? ("fam-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8));
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** A numeric value, a numeric string, or a parameter-name string? */
function numberRefFromEditorValue(value: unknown): NumberRef {
  if (typeof value === "number" && Number.isFinite(value)) return { const: value };
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return { const: 0 };
    const n = Number(trimmed);
    if (Number.isFinite(n) && /^-?[\d.]+$/.test(trimmed)) return { const: n };
    return { ref: trimmed };
  }
  return { const: 0 };
}

/**
 * Radius reference for a circle/ellipse profile whose editor width is a
 * parameter name or a number. A width is a diameter; the TS circle takes
 * a radius, so a parameter reference becomes an expression.
 */
function radiusRefFromWidth(width: unknown): NumberRef {
  if (typeof width === "number" && Number.isFinite(width)) return { const: width / 2 };
  if (typeof width === "string" && width.trim() !== "") {
    const n = Number(width);
    if (Number.isFinite(n) && /^-?[\d.]+$/.test(width.trim())) return { const: n / 2 };
    return { expr: `${width.trim()} / 2` };
  }
  return { const: 0 };
}

function editorValueFromNumberRef(ref: NumberRef | undefined): unknown {
  if (!ref) return "";
  if ("ref" in ref) return ref.ref;
  if ("const" in ref) return ref.const;
  if ("expr" in ref) return ref.expr;
  return "";
}

/** Coerce an editor default into the TS representation for its kind. */
function coerceDefault(kind: string, value: unknown): unknown {
  switch (kind) {
    case "Length":
    case "Number":
    case "Angle":
    case "Integer": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case "YesNo":
      return value === true || value === 1 || value === "1" || value === "true";
    case "Text":
    case "Material":
      return value == null ? "" : String(value);
    default:
      return value ?? 0;
  }
}

function editorDefaultFromTs(type: ParameterType, value: unknown): unknown {
  if (type === "boolean") return value ? 1 : 0;
  if (type === "text" || type === "material" || type === "colour" || type === "family-type") {
    return value == null ? "" : String(value);
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ── Geometry conversion ─────────────────────────────────────────────────────

/**
 * Editor geometry recipe -> TS geometry. Extrusion maps faithfully.
 * Any other editor kind (Revolve / Sweep / Blend / Boolean) has no TS
 * geometry equivalent yet: the kind string is kept (the migrator keeps
 * unknown kinds as-is and the engine returns null for them) with the
 * mapped profile/depth carried as forward-compatible data, and the
 * verbatim recipe is preserved in `editorSource` by the caller.
 */
function editorGeometryToTs(geometry: Record<string, any> | undefined): FamilyGeometrySpec {
  const g = geometry ?? {};
  const kind = typeof g.kind === "string" ? g.kind : "Extrusion";
  const profile = isRecord(g.profile) ? g.profile : {};
  const profileKind = typeof profile.kind === "string" ? profile.kind : "Rectangle";

  const profileSpec = ((): ProfileSpec | null => {
    // Only meaningful for extrusions; computed for every kind so a
    // future revolve/sweep builder finds the same recipe data.
    switch (profileKind) {
      case "Circle":
      case "Ellipse":
        return { kind: "circle", r: radiusRefFromWidth(profile.width) };
      case "Polygon":
        // The editor stores no vertices for a polygon profile, so it
        // degrades to its bounding rectangle (documented, not silent:
        // the verbatim recipe rides in `editorSource`).
        return {
          kind: "rect",
          w: numberRefFromEditorValue(profile.width),
          h: numberRefFromEditorValue(profile.height),
        };
      case "Custom":
      case "Rectangle":
      default:
        return {
          kind: "rect",
          w: numberRefFromEditorValue(profile.width),
          h: numberRefFromEditorValue(profile.height),
        };
    }
  })();

  const depth = numberRefFromEditorValue(g.depth);
  const origin = isRecord(g.origin) ? g.origin : {};
  const ox = typeof origin.x === "number" ? origin.x : 0;
  const oy = typeof origin.y === "number" ? origin.y : 0;
  const oz = typeof origin.z === "number" ? origin.z : 0;
  const transform =
    ox !== 0 || oy !== 0 || oz !== 0
      ? { translate: [{ const: ox }, { const: oy }, { const: oz }] as [NumberRef, NumberRef, NumberRef] }
      : undefined;

  if (kind === "Extrusion") {
    return {
      kind: "extrusion",
      profile: profileSpec as ProfileSpec,
      depth,
      ...(transform ? { transform } : {}),
    };
  }

  // Non-extrusion editor kind: keep the kind + recipe data. The cast is
  // deliberate — see the module header (migration rule 7).
  return {
    kind: kind.toLowerCase(),
    profile: profileSpec,
    depth,
    ...(typeof g.angle === "string" || typeof g.angle === "number"
      ? { angle: numberRefFromEditorValue(g.angle) }
      : {}),
    ...(transform ? { transform } : {}),
  } as unknown as FamilyGeometrySpec;
}

/**
 * TS geometry -> editor geometry recipe. Extrusion maps faithfully.
 * Anything else becomes a display placeholder (kind badge + dimension
 * parameters) with the verbatim TS geometry in `serviceGeometry`, so a
 * save back restores it untouched (see `editorFamilyToDefinition`).
 */
function tsGeometryToEditor(
  geometry: FamilyGeometrySpec,
  parameters: FamilyParameter[],
): { recipe: Record<string, any>; serviceGeometry: unknown | null } {
  if (geometry.kind === "extrusion") {
    const profile = geometry.profile;
    let profileKind = "Rectangle";
    let w: unknown = "Width";
    let h: unknown = "Height";
    if (profile.kind === "rect") {
      w = editorValueFromNumberRef(profile.w);
      h = editorValueFromNumberRef(profile.h);
    } else if (profile.kind === "circle") {
      profileKind = "Circle";
      w = editorValueFromNumberRef(profile.r);
      h = w;
    } else if (profile.kind === "polygon") {
      profileKind = "Polygon";
      w = "Width";
      h = "Height";
    } else if (profile.kind === "arc") {
      profileKind = "Circle";
      w = editorValueFromNumberRef(profile.r);
      h = w;
    }
    const t = geometry.transform?.translate;
    return {
      recipe: {
        kind: "Extrusion",
        profile: { kind: profileKind, width: w, height: h },
        depth: editorValueFromNumberRef(geometry.depth),
        angle: "360",
        path: "",
        origin: {
          x: t?.[0] && "const" in t[0] ? t[0].const : 0,
          y: t?.[1] && "const" in t[1] ? t[1].const : 0,
          z: t?.[2] && "const" in t[2] ? t[2].const : 0,
        },
        solid: true,
        voids: [],
      },
      serviceGeometry: null,
    };
  }

  // Non-extrusion: placeholder recipe from the dimension parameters,
  // verbatim geometry preserved for the round-trip.
  const lengths = parameters.filter((p) => p.type === "length").map((p) => p.name);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return {
    recipe: {
      kind: cap(String(geometry.kind)),
      profile: {
        kind: "Rectangle",
        width: lengths[0] ?? "Width",
        height: lengths[1] ?? "Height",
      },
      depth: lengths[2] ?? "Depth",
      angle: "360",
      path: "",
      origin: { x: 0, y: 0, z: 0 },
      solid: true,
      voids: [],
    },
    serviceGeometry: deepClone(geometry),
  };
}

// ── Constraints ─────────────────────────────────────────────────────────────

/**
 * Editor constraints -> TS constraints. Only equality and ratio have a
 * TS equivalent; range / min / max have none and stay in `editorSource`.
 */
export function editorConstraintsToTs(
  constraints: EditorFamily["constraints"] | undefined,
): { constraints: Constraint[]; skipped: number } {
  const out: Constraint[] = [];
  let skipped = 0;
  for (const c of constraints ?? []) {
    const target = Array.isArray(c.target) ? c.target : [];
    if (c.kind === "equal" && target.length >= 2) {
      out.push({ kind: "equality", a: target[0]!, b: target[1]! });
    } else if (c.kind === "ratio" && target.length >= 2) {
      const k = Number((c.params as Record<string, unknown> | undefined)?.ratio);
      out.push({ kind: "ratio", a: target[0]!, b: target[1]!, k: Number.isFinite(k) ? k : 1 });
    } else {
      skipped++;
    }
  }
  return { constraints: out, skipped };
}

// ── Family conversion ───────────────────────────────────────────────────────

/**
 * Legacy editor family -> TS family definition (without id /
 * schemaVersion / builtIn — the store assigns those). The verbatim
 * editor record is kept in `editorSource` so nothing the TS schema has
 * no field for is lost. When the editor record carries
 * `serviceGeometry` (a TS-native non-extrusion family opened in the
 * editor), that geometry is restored verbatim instead of converting
 * the placeholder recipe.
 */
export function editorFamilyToDefinition(
  editor: EditorFamily,
): Omit<FamilyDefinition, "id" | "schemaVersion" | "builtIn"> {
  if (!editor || typeof editor.name !== "string" || !editor.name.trim()) {
    throw new Error("family bridge: editor family has no name");
  }
  const paramsIn = Array.isArray(editor.parameters) ? editor.parameters : [];
  const names = new Set<string>();
  const parameters: FamilyParameter[] = paramsIn.map((p) => {
    if (!p || typeof p.name !== "string" || !p.name.trim()) {
      throw new Error(`family bridge: family "${editor.name}" has a parameter without a name`);
    }
    if (names.has(p.name)) {
      throw new Error(`family bridge: family "${editor.name}" declares parameter "${p.name}" twice`);
    }
    names.add(p.name);
    const kind = EDITOR_KIND_TO_TS[p.kind] ?? "number";
    return {
      name: p.name,
      type: kind,
      scope: p.isType ? "type" : "instance",
      default: coerceDefault(p.kind, p.default),
      editable: true,
      ...(p.formula ? { formula: p.formula } : {}),
      group: typeof p.group === "string" && p.group ? p.group : "Dimensions",
    };
  });

  const typesIn = Array.isArray(editor.types) && editor.types.length
    ? editor.types
    : [{ name: "Default", values: {} }];
  const types: FamilyType[] = typesIn.map((t, i) => ({
    // Fresh ids on convert; the push path reuses the existing type ids
    // by name when updating, so a repeat save never renumbers types.
    id: uid(),
    name: typeof t.name === "string" && t.name ? t.name : `Type ${i + 1}`,
    values: isRecord(t.values) ? deepClone(t.values) : {},
  }));
  // Prune type values naming undeclared parameters (the migrator would
  // do this too, with a warning — do it here so the record is clean).
  for (const t of types) {
    for (const k of Object.keys(t.values)) if (!names.has(k)) delete t.values[k];
  }

  const category = EDITOR_CATEGORY_TO_TS[editor.category ?? "Generic"] ?? "generic";
  const geometry = editor.serviceGeometry && isRecord(editor.serviceGeometry)
    ? (deepClone(editor.serviceGeometry) as FamilyGeometrySpec)
    : editorGeometryToTs(isRecord(editor.geometry) ? editor.geometry : undefined);

  return {
    name: editor.name.trim(),
    category,
    ifcEntity:
      typeof editor.serviceIfcEntity === "string" && editor.serviceIfcEntity
        ? editor.serviceIfcEntity
        : (IFC_ENTITY_BY_CATEGORY[category] ?? "IfcBuildingElementProxy"),
    origin: "editor",
    parameters,
    geometry,
    types,
    editorSource: deepClone(editor as unknown as Record<string, unknown>),
  };
}

/**
 * TS family definition -> legacy editor family. When the definition
 * carries `editorSource` (it originated in the editor), that record is
 * the base and the current TS name / category / parameters / types are
 * overlaid on top, so editor-only data survives. Otherwise the editor
 * record is synthesised from the TS fields.
 */
export function definitionToEditorFamily(def: FamilyDefinition): EditorFamily {
  const source = isRecord(def.editorSource) ? deepClone(def.editorSource) : null;
  const base: EditorFamily =
    source && typeof source.name === "string"
      ? (source as unknown as EditorFamily)
      : {
          name: def.name,
          category: "Generic",
          description: "",
          manufacturer: "",
          model: "",
          version: "1.0",
          placement: { kind: "LevelBased", host: "None", workPlane: "XY" },
          parameters: [],
          types: [{ name: "Default", values: {} }],
          constraints: [],
          sharedParamRefs: [],
          geometry: {
            kind: "Extrusion",
            profile: { kind: "Rectangle", width: "Width", height: "Height" },
            depth: "Depth",
            angle: "360",
            path: "",
            origin: { x: 0, y: 0, z: 0 },
            solid: true,
            voids: [],
          },
        };

  base.name = def.name;
  base.category = TS_CATEGORY_TO_EDITOR[def.category] ?? "Generic";
  if (!source) {
    const desc = (def as FamilyDefinition & { description?: string }).description;
    if (typeof desc === "string") base.description = desc;
  }
  base.parameters = def.parameters.map((p) => ({
    name: p.name,
    kind: TS_TYPE_TO_EDITOR_KIND[p.type] ?? "Number",
    isType: p.scope === "type",
    default: editorDefaultFromTs(p.type, p.default),
    formula: typeof p.formula === "string" ? p.formula : "",
    group: p.group ?? "Dimensions",
  }));
  base.types = def.types.map((t) => ({ name: t.name, values: deepClone(t.values) }));
  if (!base.types.length) base.types = [{ name: "Default", values: {} }];

  // Geometry: the editor's own recipe wins when this family came from
  // the editor (it is the recipe the user authored); otherwise convert
  // the TS geometry, preserving non-extrusion geometry verbatim.
  if (!source) {
    const { recipe, serviceGeometry } = tsGeometryToEditor(def.geometry, def.parameters);
    base.geometry = recipe;
    if (serviceGeometry !== null) base.serviceGeometry = serviceGeometry;
    else delete base.serviceGeometry;
  } else {
    delete base.serviceGeometry;
  }

  base.serviceId = def.id;
  base.serviceIfcEntity = def.ifcEntity;
  return base;
}

// ── Push / remove (editor -> store) ─────────────────────────────────────────

export interface PushOptions {
  /** Called with the mappable subset of the editor constraints (equal/ratio). */
  setConstraints?: (familyId: string, constraints: Constraint[]) => void;
  /**
   * The project the store is currently scoped to (the store key is
   * `obs.families.v1.<projectId>`, or the global key when null). The
   * bridge stamps it onto library entries as `serviceProject` so a
   * family of one project is never imported into — or cleaned up by —
   * another project, and a store delete is never resurrected by a
   * stale library entry.
   */
  projectId?: string | null;
}

export interface PushResult {
  id: string;
  created: boolean;
}

/**
 * Save an editor family into the store (create or update). The editor
 * record is stamped with the resulting `serviceId` so a repeat save
 * updates the same family. Type ids are preserved by matching types by
 * name. Throws on unrecoverable input (no name, duplicate parameters)
 * — the caller keeps the localStorage save as the fallback.
 */
export function pushEditorFamily(
  store: BridgeFamilyStore,
  editor: EditorFamily,
  opts: PushOptions = {},
): PushResult {
  const converted = editorFamilyToDefinition(editor);
  const { constraints } = editorConstraintsToTs(editor.constraints);

  let existing: FamilyDefinition | null = null;
  if (typeof editor.serviceId === "string" && editor.serviceId) {
    existing = store.get(editor.serviceId);
  }
  if (!existing) {
    existing = store.list().find((f) => f.name === converted.name) ?? null;
  }

  let id: string;
  let created: boolean;
  if (existing) {
    // Reuse the existing type ids (match by name); new types get a
    // stable id so a later save does not renumber them.
    const byName = new Map(existing.types.map((t) => [t.name, t.id]));
    const types = converted.types.map((t, i) => ({
      ...t,
      id: byName.get(t.name) ?? `t_${existing!.id}-${existing!.types.length + i}`,
    }));
    const patch: Partial<FamilyDefinition> = {
      ...converted,
      types,
      // The editor never sets these; keep the store's values.
      ifcEntity:
        typeof editor.serviceIfcEntity === "string" && editor.serviceIfcEntity
          ? editor.serviceIfcEntity
          : existing.ifcEntity,
      sourceElementType: existing.sourceElementType,
      connectorDefs: existing.connectorDefs,
      group: existing.group,
    };
    const updated = store.update(existing.id, patch);
    if (!updated) throw new Error(`family bridge: could not update family "${existing.id}"`);
    id = existing.id;
    created = false;
  } else {
    const createdDef = store.create(converted);
    id = createdDef.id;
    created = true;
  }

  editor.serviceId = id;
  // Stamp the project scope so another project's import/export leaves
  // this entry alone (see PushOptions.projectId). No project open means
  // the global store: no stamp.
  if (typeof opts.projectId === "string" && opts.projectId) {
    editor.serviceProject = opts.projectId;
  } else {
    delete editor.serviceProject;
  }
  if (constraints.length && opts.setConstraints) {
    try {
      opts.setConstraints(id, constraints);
    } catch (err) {
      console.warn("[family-bridge] setConstraints failed", err);
    }
  }
  return { id, created };
}

/**
 * Remove a bridged family from the store and drop its editor-library
 * entry. Built-ins cannot be removed from the store (the store refuses)
 * and their library entry is left alone.
 */
export function removeBridgedFamily(
  store: BridgeFamilyStore,
  storage: BridgeStorage,
  serviceId: string,
): boolean {
  const removed = store.remove(serviceId);
  if (!removed) return false;
  try {
    const lib = readEditorLibrary(storage);
    let changed = false;
    for (const [name, entry] of Object.entries(lib)) {
      if (isRecord(entry) && entry.serviceId === serviceId) {
        delete lib[name];
        changed = true;
      }
    }
    if (changed) writeEditorLibrary(storage, lib);
  } catch { /* library cleanup is best-effort */ }
  return true;
}

// ── Library sync ────────────────────────────────────────────────────────────

export function readEditorLibrary(storage: BridgeStorage): Record<string, unknown> {
  try {
    const raw = storage.getItem(EDITOR_LIBRARY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeEditorLibrary(storage: BridgeStorage, lib: Record<string, unknown>): void {
  storage.setItem(EDITOR_LIBRARY_KEY, JSON.stringify(lib));
}

export interface LibraryImportReport {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/**
 * Import every editor-library entry into the store. Entries that fail
 * conversion are skipped and reported, never fatal. Successfully
 * imported entries are stamped with their `serviceId` (and
 * `serviceProject`) in the library, so the next export recognises them
 * as mirrored store families.
 *
 * Two entries are deliberately NOT imported: one whose `serviceId`
 * names a family that is no longer in this store (deleted here, or
 * stamped by another project) — importing it would resurrect a delete
 * or leak a family across projects. Such entries stay in the library
 * (visible in the editor); an explicit save in the editor re-creates
 * them in the current project.
 */
export function importEditorLibrary(
  store: BridgeFamilyStore,
  storage: BridgeStorage,
  opts: PushOptions = {},
): LibraryImportReport {
  const lib = readEditorLibrary(storage);
  const report: LibraryImportReport = { imported: 0, updated: 0, skipped: 0, errors: [] };
  let changed = false;
  for (const [name, entry] of Object.entries(lib)) {
    if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim()) {
      report.skipped++;
      report.errors.push(`library entry "${name}" has no usable family name; skipped`);
      continue;
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec.serviceId === "string" && rec.serviceId) {
      const sameScope =
        typeof rec.serviceProject !== "string" ||
        !opts.projectId ||
        rec.serviceProject === opts.projectId;
      if (!sameScope) {
        report.skipped++;
        continue;
      }
      if (!store.get(rec.serviceId)) {
        report.skipped++;
        report.errors.push(
          `library entry "${name}" refers to a family that is no longer in this project; skipped`,
        );
        continue;
      }
    }
    try {
      const beforeId = rec.serviceId;
      const beforeProject = rec.serviceProject;
      const result = pushEditorFamily(store, entry as unknown as EditorFamily, opts);
      if (result.created) report.imported++;
      else report.updated++;
      // pushEditorFamily stamps serviceId/serviceProject onto the entry
      // object in place; persist the stamp when it changed.
      if (beforeId !== result.id || beforeProject !== rec.serviceProject) changed = true;
    } catch (err) {
      report.skipped++;
      report.errors.push(
        `library entry "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (changed) {
    try {
      writeEditorLibrary(storage, lib);
    } catch { /* stamping is best-effort */ }
  }
  return report;
}

/** A store family is exported when it is a user family, not shipped content. */
export function isExportableFamily(def: FamilyDefinition): boolean {
  return !def.builtIn && def.origin !== "seed-catalog";
}

export interface LibraryExportReport {
  exported: number;
  removed: number;
}

/**
 * Mirror the exportable store families into the editor library.
 * Editor-native entries (no `serviceId`) are left untouched — the
 * import side picks them up. Entries whose `serviceId` left the
 * exportable set (deleted in this project, or newly recognised as seed
 * content) are removed — but only when they belong to this project
 * scope; another project's entries are left alone.
 */
export function exportServiceFamilies(
  store: BridgeFamilyStore,
  storage: BridgeStorage,
  opts: PushOptions = {},
): LibraryExportReport {
  const lib = readEditorLibrary(storage);
  const exportable = store.list().filter(isExportableFamily);
  const exportableIds = new Set(exportable.map((f) => f.id));
  const report: LibraryExportReport = { exported: 0, removed: 0 };

  const before = JSON.stringify(lib);
  for (const def of exportable) {
    const editorFam = definitionToEditorFamily(def);
    if (typeof opts.projectId === "string" && opts.projectId) {
      editorFam.serviceProject = opts.projectId;
    }
    lib[def.name] = editorFam;
    report.exported++;
  }
  for (const [name, entry] of Object.entries(lib)) {
    if (
      isRecord(entry) &&
      typeof entry.serviceId === "string" &&
      entry.serviceId &&
      !exportableIds.has(entry.serviceId)
    ) {
      // Another project's entry: leave it — its own project's export
      // owns it. (No serviceProject stamp = legacy/global scope, which
      // this store owns.)
      if (
        typeof entry.serviceProject === "string" &&
        entry.serviceProject &&
        opts.projectId &&
        entry.serviceProject !== opts.projectId
      ) {
        continue;
      }
      delete lib[name];
      report.removed++;
    }
  }
  if (JSON.stringify(lib) !== before) {
    try {
      writeEditorLibrary(storage, lib);
    } catch (err) {
      console.warn("[family-bridge] export persist failed", err);
    }
  }
  return report;
}

// ── Shared parameters ───────────────────────────────────────────────────────

function readEditorShared(storage: BridgeStorage): EditorSharedParameter[] {
  try {
    const raw = storage.getItem(EDITOR_SHARED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e): e is EditorSharedParameter =>
      isRecord(e) && typeof e.name === "string" && e.name.trim() !== "",
    ) : [];
  } catch {
    return [];
  }
}

function writeEditorShared(storage: BridgeStorage, list: EditorSharedParameter[]): void {
  storage.setItem(EDITOR_SHARED_KEY, JSON.stringify(list));
}

function defaultForSharedType(type: SharedParameterType): unknown {
  switch (type) {
    case "boolean":
      return false;
    case "string":
    case "material":
      return "";
    default:
      return 0;
  }
}

export interface SharedSyncReport {
  imported: number;
  exported: number;
  removed: number;
}

/**
 * Sync shared parameters both ways. Editor entries missing from the
 * manager are created there (group "General", instance scope); manager
 * entries missing from the editor list are appended there (stamped with
 * their GUID so a later manager delete can clean them up). Editor-native
 * entries are never deleted by the export side.
 */
export function syncSharedParameters(
  manager: BridgeSharedManager,
  storage: BridgeStorage,
): SharedSyncReport {
  const report: SharedSyncReport = { imported: 0, exported: 0, removed: 0 };
  const editorList = readEditorShared(storage);

  for (const entry of editorList) {
    // A GUID-stamped entry is a mirror of a manager definition, not a
    // source: importing it would resurrect a manager delete (the entry
    // outlives the definition until the cleanup below removes it).
    if (typeof entry.guid === "string" && entry.guid) continue;
    const kind = EDITOR_KIND_TO_SHARED_TYPE[entry.kind];
    if (!kind) continue;
    if (manager.findByName(entry.name)) continue;
    try {
      const created = manager.create({
        ...(entry.guid ? { guid: entry.guid } : {}),
        name: entry.name,
        group: "General",
        type: kind,
        defaultValue: defaultForSharedType(kind),
        isInstance: true,
      });
      entry.guid = created.guid;
      report.imported++;
    } catch {
      // Duplicate GUID / name race — the manager wins; skip quietly.
    }
  }

  const managed = manager.list();
  const managedByName = new Map(managed.map((p) => [p.name.toLowerCase(), p]));
  const managedGuids = new Set(managed.map((p) => p.guid));
  for (const param of managed) {
    const existing = editorList.find((e) => e.name.toLowerCase() === param.name.toLowerCase());
    if (!existing) {
      editorList.push({
        name: param.name,
        kind: SHARED_TYPE_TO_EDITOR_KIND[param.type] ?? "Text",
        guid: param.guid,
      });
      report.exported++;
    } else if (!existing.guid) {
      existing.guid = param.guid;
    }
  }
  const kept = editorList.filter((e) => {
    if (typeof e.guid === "string" && e.guid && !managedGuids.has(e.guid)) {
      // A bridged entry whose manager definition is gone. Keep it when
      // a same-named manager entry still exists (renamed GUID) — the
      // export loop above re-stamps it on the next sync.
      if (!managedByName.has(e.name.toLowerCase())) {
        report.removed++;
        return false;
      }
    }
    return true;
  });

  try {
    writeEditorShared(storage, kept);
  } catch (err) {
    console.warn("[family-bridge] shared-parameter persist failed", err);
  }
  return report;
}

// ── Whole sync ──────────────────────────────────────────────────────────────

export interface BridgeSyncReport {
  families: { imported: number; updated: number; skipped: number; exported: number; removed: number };
  shared: SharedSyncReport;
  errors: string[];
}

/**
 * Full two-way sync: editor library in, then store out, then shared
 * parameters both ways. Import runs first so an editor save wins for
 * editor-originated families; the export then mirrors the resulting
 * store state (including just-imported families) into the library.
 */
export function syncAll(
  store: BridgeFamilyStore,
  manager: BridgeSharedManager,
  storage: BridgeStorage,
  opts: PushOptions = {},
): BridgeSyncReport {
  const imported = importEditorLibrary(store, storage, opts);
  const exported = exportServiceFamilies(store, storage, opts);
  const shared = syncSharedParameters(manager, storage);
  return {
    families: {
      imported: imported.imported,
      updated: imported.updated,
      skipped: imported.skipped,
      exported: exported.exported,
      removed: exported.removed,
    },
    shared,
    errors: imported.errors,
  };
}
