import { z } from "zod";
import { BCF_GUID_RE } from "../modules/issues/bcf-markup";

/**
 * Shared issue formatter for the boundary validators below: Zod issues
 * rendered as `path: message`, capped so one hostile value cannot flood a
 * dialog or log with thousands of lines.
 */
export function formatSchemaIssues(error: z.ZodError, maxIssues = 20): string[] {
  const issues = error.issues.map(
    (i) => `${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`,
  );
  return issues.length > maxIssues
    ? [...issues.slice(0, maxIssues), `… and ${issues.length - maxIssues} more`]
    : issues;
}

/**
 * Result of a schema check. Deliberately NOT a discriminated union:
 * several Node test harnesses compile this module with non-strict tsc,
 * and TS 5.9 does not narrow boolean discriminants there — a union
 * return would fail those harnesses at compile time. Callers read
 * `issues ?? []` / `value` after checking `ok`.
 */
export interface SchemaCheck<T = unknown> {
  ok: boolean;
  value?: T;
  issues?: string[];
}

/**
 * Validate an unknown value against a schema without throwing.
 * Implemented with `parse` + try/catch (same error object `safeParse`
 * would return) so no discriminated-union narrowing is needed anywhere
 * in this file.
 */
export function validateWithSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
): SchemaCheck<T> {
  try {
    return { ok: true, value: schema.parse(value) };
  } catch (e) {
    if (e instanceof z.ZodError) return { ok: false, issues: formatSchemaIssues(e) };
    throw e;
  }
}

export type LoadResult<T> = { ok: true; value: T } | { ok: false; error: LoadError };
export type LoadError = { stage: "size" | "parse" | "schema" | "complexity"; file: string; issues: string[] };
export const DEFAULT_MAX_JSON_BYTES = 8 * 1024 * 1024;

export interface SafeLoadLimits {
  maxDepth?: number;
  maxNodes?: number;
}

export function safeLoad<T>(file: string, raw: string,
  schema: z.ZodType<T>, maxBytes = DEFAULT_MAX_JSON_BYTES,
  limits: SafeLoadLimits = {}): LoadResult<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return { ok: false, error: { stage: "size", file, issues: ["Invalid JSON byte limit configuration."] } };
  }
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    return { ok: false, error: { stage: "size", file, issues: [`JSON input exceeds the ${maxBytes}-byte limit.`] } };
  }
  let json: unknown;
  try { json = JSON.parse(raw); }
  catch (e) {
    return { ok: false, error: { stage: "parse", file, issues: [e instanceof Error ? e.message : "Invalid JSON."] } };
  }

  // Iterative traversal avoids recursive stack growth on hostile nested JSON.
  const maxDepth = limits.maxDepth ?? 64;
  const maxNodes = limits.maxNodes ?? 250_000;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 ||
      !Number.isSafeInteger(maxNodes) || maxNodes < 1) {
    return { ok: false, error: { stage: "complexity", file, issues: ["Invalid JSON complexity limit configuration."] } };
  }
  const pending: Array<{ value: unknown; depth: number }> = [{ value: json, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++visited > maxNodes) {
      return { ok: false, error: { stage: "complexity", file, issues: [`JSON input exceeds the ${maxNodes}-node complexity limit.`] } };
    }
    if (current.depth > maxDepth) {
      return { ok: false, error: { stage: "complexity", file, issues: [`JSON input exceeds the ${maxDepth}-level nesting limit.`] } };
    }
    if (Array.isArray(current.value)) {
      if (pending.length + visited + current.value.length > maxNodes) {
        return { ok: false, error: { stage: "complexity", file, issues: [`JSON input exceeds the ${maxNodes}-node complexity limit.`] } };
      }
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      const record = current.value as Record<string, unknown>;
      for (const key in record) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        if (pending.length + visited >= maxNodes) {
          return { ok: false, error: { stage: "complexity", file, issues: [`JSON input exceeds the ${maxNodes}-node complexity limit.`] } };
        }
        pending.push({ value: record[key], depth: current.depth + 1 });
      }
    }
  }

  let value: T;
  try {
    // parse + try/catch (same ZodError safeParse would return): no
    // discriminated-union narrowing, so this file also compiles under the
    // non-strict tsc invocations several Node test harnesses use.
    value = schema.parse(json);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return {
        ok: false,
        error: {
          stage: "schema",
          file,
          issues: e.issues.map((i) => `${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`),
        },
      };
    }
    throw e;
  }
  return { ok: true, value: stripProtoKeys(value) };
}

/**
 * Defense in depth against prototype pollution (issue #90): no safeLoad
 * schema declares a `__proto__` field, so a `__proto__` own-key in a file
 * can never be legitimate data — but several schemas are deliberately
 * permissive (`.passthrough()`, `z.record`, `z.unknown()` elements), so one
 * would survive into the returned value. A consumer that later does
 * `Object.assign(target, value)` or a deep merge would then mutate the
 * target's prototype. Strip every `__proto__` own-key at any depth before
 * the value leaves safeLoad. `constructor` / `prototype` keys are left
 * alone: assigning them as own properties is inert, and no consumer in this
 * tree deep-merges untrusted data (verified: the only deep merge,
 * `i18n.deepMerge`, runs over shipped locale catalogues, never file data).
 * Iterative walk; the visited set guards against a cycle if a schema ever
 * returns a cyclic value.
 */
export function stripProtoKeys<T>(value: T): T {
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop()!;
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, "__proto__")) {
      delete record["__proto__"];
    }
    for (const key of Object.keys(record)) pending.push(record[key]);
  }
  return value;
}

/**
 * Project-element contents (PE-20). Mirrors `ElementType` + the known
 * `AuthoredElement.params` fields in `src/modules/projects/types.ts`.
 *
 * Unknown-field policy: PASSTHROUGH (preserved, not validated). Elements
 * legitimately carry forward-compatible data the schema does not know —
 * `properties`, `nativeGeometry`, `sourceArchive`, `ifc`, `transform`,
 * `hostAttachment` and family-driven param keys — and the normalizer
 * (`normalizeProjectDoc`) has the same preserve-unknown-fields policy, so
 * stripping here would silently lose imported geometry on load. Known
 * fields are validated strictly instead: a bad id, an unknown element
 * type, or a non-finite / wrong-typed known param rejects the whole file
 * at the schema stage (fail-closed; the file is not opened at all).
 * `__proto__` keys are still removed by `stripProtoKeys` above.
 */
export const ELEMENT_TYPES = [
  "wall", "slab", "column", "beam", "brace", "truss", "footing", "strip",
  "mline", "duct", "pipe", "cable-tray", "conduit", "equipment", "fitting",
  "door", "window", "vertical-opening", "roof", "stairs", "railing", "ramp",
  "room", "area", "ceiling", "terrain", "curtain-wall",
  "adaptive-component", "grid", "level", "generic",
] as const;

const finiteNumber = z.number().finite();
const vec2 = z.tuple([finiteNumber, finiteNumber]);

export const ProjectElementParamsSchema = z.object({
  start: vec2.optional(),
  end: vec2.optional(),
  polygon: z.array(vec2).max(10_000).optional(),
  point: vec2.optional(),
  width: finiteNumber.optional(),
  depth: finiteNumber.optional(),
  rotation: finiteNumber.optional(),
  height: finiteNumber.optional(),
  thickness: finiteNumber.optional(),
  elevation: finiteNumber.optional(),
  baseLevelId: z.string().max(256).optional(),
  baseOffset: finiteNumber.optional(),
  topLevelId: z.string().max(256).optional(),
  topOffset: finiteNumber.optional(),
  endElevation: finiteNumber.optional(),
  offsetAlongHost: finiteNumber.optional(),
  sillHeight: finiteNumber.optional(),
  frameThickness: finiteNumber.optional(),
  doorPanel: z.enum(["swing", "double", "sliding", "folding", "pocket"]).optional(),
  windowPanel: z.enum(["fixed", "casement", "sliding", "awning", "double"]).optional(),
  mullion: z.boolean().optional(),
  angleIn: finiteNumber.optional(),
  angleOut: finiteNumber.optional(),
  bendRadius: finiteNumber.optional(),
  fittingKind: z.string().max(128).optional(),
  parentType: z.enum(["duct", "pipe", "cable-tray", "conduit"]).optional(),
}).passthrough();

export const ProjectElementSchema = z.object({
  id: z.string().trim().min(1).max(256),
  type: z.enum(ELEMENT_TYPES),
  name: z.string().max(512).optional(),
  color: z.string().max(64).optional(),
  hostId: z.string().min(1).max(256).optional(),
  levelId: z.string().min(1).max(256).optional(),
  familyId: z.string().min(1).max(256).optional(),
  familyTypeId: z.string().min(1).max(256).optional(),
  params: ProjectElementParamsSchema.optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  hostAttachment: z.object({}).passthrough().optional(),
}).passthrough();

export const LegacyProjectJsonSchema = z.object({
  id: z.string().trim().min(1),
  elements: z.array(ProjectElementSchema).max(250_000),
}).passthrough();

/**
 * Clash-scenario contents (PE-20). Mirrors `ScenarioRecord` in
 * `src/modules/clash/scenario-io.ts` — the writer (`serializeScenarios`)
 * and the reader (`parseScenarios`) share that one dialect, so what the
 * app saves is exactly what this schema accepts.
 *
 * Behaviour change, stated: previously a scenario with a bad id was
 * silently dropped by `parseScenarios` and a scenario with an unknown
 * scope had its scope silently dropped, while the rest of the file still
 * imported. The schema gate now rejects the whole file with named issues
 * instead — a bad scenario is rejected, not silently admitted. Field
 * coercion that `parseScenarios` still performs (empty name → "Scenario",
 * out-of-range counts clamped) is unchanged for values the schema
 * accepts; the schema only proves the shape (right types, finite
 * numbers, known scope values).
 */
const scenarioCommentSchema = z.object({
  id: z.string().max(80),
  author: z.string().max(120),
  date: finiteNumber,
  text: z.string().max(2000),
});

const scenarioStateSchema = z.object({
  status: z.string().min(1).max(32),
  comments: z.array(scenarioCommentSchema).max(200),
  assignee: z.string().max(120).optional(),
  updatedAt: finiteNumber,
});

export const ClashScenarioSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().max(120),
  createdAt: finiteNumber.nonnegative(),
  updatedAt: finiteNumber.nonnegative(),
  testName: z.string().max(120),
  tolerance: finiteNumber,
  clearance: finiteNumber,
  cropMargin: finiteNumber,
  scope: z.enum(["all", "viewport", "aOnly", "bOnly", "both"]).optional(),
  method: z.string().max(32).optional(),
  selectionA: z.array(z.string()).max(500),
  selectionB: z.array(z.string()).max(500),
  clashStates: z.record(z.string(), scenarioStateSchema).optional(),
  lastRun: z.object({
    total: finiteNumber.nonnegative(),
    intersect: finiteNumber.nonnegative(),
    touching: finiteNumber.nonnegative(),
    clearance: finiteNumber.nonnegative(),
    duplicate: finiteNumber.nonnegative(),
    at: finiteNumber.nonnegative(),
  }).optional(),
});

export const ClashScenarioImportSchema = z.union([
  z.array(ClashScenarioSchema).max(200),
  z.object({ scenarios: z.array(ClashScenarioSchema).max(200) }).passthrough(),
]);

export const ProjectFileSchema = z.object({
  format: z.literal("obsproj"),
  version: z.number().int().min(1),
  savedAt: z.number().finite().default(0),
  app: z.string().min(1).default("Open BIM Studio"),
  doc: z.record(z.string(), z.unknown()),
  blobs: z.array(z.object({
    modelId: z.string().min(1),
    name: z.string().min(1),
    size: z.number().int().nonnegative(),
    type: z.string(),
  })),
});

export const BcfManifestSchema = z.object({
  bcf_version: z.string().min(1),
  topics: z.array(z.object({ guid: z.string().min(1),
    title: z.string().min(1) })).default([]),
});

export const PluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  sdkVersion: z.number().int().positive(),
  capabilities: z.array(z.string().min(1)),
  integrity: z.string().optional(),
});

export const SavedViewsSchema = z.array(z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  pos: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  target: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  projection: z.enum(["perspective", "orthographic"]),
  orthoZoom: z.number().finite().positive().optional(),
  createdAt: z.number().finite().nonnegative(),
})).max(64);

/**
 * Markups sidecar (`.markups.json`, written by the drawing editor's Save and
 * read back by its Load). Mirrors the `Markup` interface in
 * `src/features/cad-viewer.ts`: `kind` is the closed set the renderer
 * switches on, `pts` are finite drawing-plane coordinates, `text` is the
 * optional annotation. Unknown keys are stripped by zod's default object
 * behaviour, so a file carrying extra fields cannot smuggle state into the
 * editor. `version` is the writer's envelope version (1 today); it is
 * type-checked but not otherwise interpreted, as the legacy loader ignored it.
 */
export const MarkupsFileSchema = z.object({
  version: z.number().int().min(1).optional(),
  markups: z.array(z.object({
    kind: z.enum(["line", "note", "dim", "cloud", "stamp", "leader", "dimang", "dimarc", "dimdia", "dimrad", "dimcenter"]),
    pts: z.array(z.object({
      x: z.number().finite(),
      y: z.number().finite(),
    })).max(10_000),
    text: z.string().max(10_000).optional(),
  })).max(10_000),
});

/* ── DXF document model (PE-20) ────────────────────────────────────────
 * Mirrors `DxfDocument` / `DxfEntity` in `src/modules/drawings/dxf-types.ts`
 * plus `NativeCurve` in `src/modules/drawings/native-curves.ts`.
 *
 * The schemas are a GATE, not a transformer: `validateDxfDocument` returns
 * the issues and the caller keeps its original document (the ASCII reader
 * and the acadrust engine both emit fields the schema need not know —
 * stripping them would lose data). A document that fails the gate never
 * reaches the scene: non-finite coordinates, unknown entity types, or a
 * malformed layer/table entry throw a typed error at the parse boundary
 * (`parseDxf` / `parseDxfFile`) instead of corrupting rendering, picking
 * and snapping downstream.
 * Ranges follow what the readers actually emit: layer colour is any
 * finite non-negative number (`Math.abs(raw)` in the reader), entity
 * colour is a guarded ACI 0–255, transparency is clamped to 0–90.
 */
const dxfPointSchema = z.object({
  x: finiteNumber,
  y: finiteNumber,
  z: finiteNumber.optional(),
});

const dxfLayerSchema = z.object({
  name: z.string().min(1).max(256),
  color: finiteNumber.nonnegative(),
  rgb: z.number().int().min(0).max(0xffffff).optional(),
  lineType: z.string().max(128).optional(),
  frozen: z.boolean().optional(),
  locked: z.boolean().optional(),
  off: z.boolean().optional(),
  lineweight: finiteNumber.nonnegative().optional(),
  transparency: finiteNumber.min(0).max(90).optional(),
  plot: z.boolean().optional(),
});

const dxfEntityBaseSchema = z.object({
  layer: z.string().min(1).max(256),
  color: z.number().int().min(0).max(255).optional(),
  rgb: z.number().int().min(0).max(0xffffff).optional(),
  lineType: z.string().max(128).optional(),
  lineweight: finiteNumber.nonnegative().optional(),
  ltScale: finiteNumber.positive().optional(),
  transparency: finiteNumber.min(0).max(90).optional(),
  invisible: z.boolean().optional(),
  meta: z.object({
    dimId: z.string().max(256),
    role: z.enum(["ext", "dimline", "arrow", "text"]),
  }).optional(),
});

const dxfHatchSchema = z.object({
  solid: z.boolean(),
  pattern: z.string().max(256).optional(),
  angle: finiteNumber.optional(),
  scale: finiteNumber.optional(),
  loops: z.array(z.array(dxfPointSchema).max(1_000_000)).max(10_000),
  gradient: z.object({
    name: z.string().max(128),
    angle: finiteNumber,
    shift: finiteNumber,
    single: z.boolean(),
    tint: finiteNumber,
    stops: z.array(z.object({ pos: finiteNumber, rgb: z.number().int().min(0).max(0xffffff) })).max(100),
  }).optional(),
  patternLines: z.array(z.object({
    angle: finiteNumber,
    base: z.tuple([finiteNumber, finiteNumber]),
    offset: z.tuple([finiteNumber, finiteNumber]),
    dashes: z.array(finiteNumber).max(10_000),
  })).max(10_000).optional(),
  patternSpace: z.boolean().optional(),
  wipeout: z.boolean().optional(),
});

const dxfNativeCurveSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("SPLINE"),
    degree: z.number().int().min(1).max(32),
    closed: z.boolean(),
    controlPoints: z.array(dxfPointSchema).max(1_000_000),
    knots: z.array(finiteNumber).max(1_000_000),
    weights: z.array(finiteNumber).max(1_000_000).optional(),
    fitPoints: z.array(dxfPointSchema).max(1_000_000).optional(),
  }),
  z.object({
    kind: z.literal("ELLIPSE"),
    center: dxfPointSchema,
    majorAxis: dxfPointSchema,
    ratio: finiteNumber,
    startParam: finiteNumber,
    endParam: finiteNumber,
  }),
]);

const dxfTextRunSchema = z.object({
  text: z.string(),
  color: z.number().int().min(0).max(255).optional(),
  rgb: z.number().int().min(0).max(0xffffff).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
});

export const DxfEntitySchema = z.discriminatedUnion("type", [
  dxfEntityBaseSchema.extend({ type: z.literal("LINE"), start: dxfPointSchema, end: dxfPointSchema }),
  dxfEntityBaseSchema.extend({ type: z.literal("RAY"), start: dxfPointSchema, direction: dxfPointSchema }),
  dxfEntityBaseSchema.extend({ type: z.literal("XLINE"), start: dxfPointSchema, direction: dxfPointSchema }),
  dxfEntityBaseSchema.extend({ type: z.literal("CIRCLE"), center: dxfPointSchema, radius: finiteNumber.nonnegative() }),
  dxfEntityBaseSchema.extend({ type: z.literal("ARC"), center: dxfPointSchema, radius: finiteNumber.nonnegative(), startAngle: finiteNumber, endAngle: finiteNumber }),
  dxfEntityBaseSchema.extend({
    type: z.literal("LWPOLYLINE"),
    points: z.array(dxfPointSchema).max(1_000_000),
    closed: z.boolean().optional(),
    hatch: dxfHatchSchema.optional(),
    native: dxfNativeCurveSchema.optional(),
    nativeSig: z.string().max(64).optional(),
  }),
  dxfEntityBaseSchema.extend({
    type: z.literal("TEXT"),
    position: dxfPointSchema,
    height: finiteNumber,
    value: z.string().max(100_000),
    rotation: finiteNumber.optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    valign: z.enum(["top", "middle", "bottom", "baseline"]).optional(),
    style: z.string().max(256).optional(),
    font: z.string().max(512).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    widthFactor: finiteNumber.optional(),
    oblique: finiteNumber.optional(),
    backwards: z.boolean().optional(),
    upsideDown: z.boolean().optional(),
    wrapWidth: finiteNumber.positive().optional(),
    lineSpacing: finiteNumber.positive().optional(),
    mask: z.boolean().optional(),
    runs: z.array(dxfTextRunSchema).max(10_000).optional(),
  }),
  dxfEntityBaseSchema.extend({ type: z.literal("POINT"), position: dxfPointSchema }),
  dxfEntityBaseSchema.extend({
    type: z.literal("TABLE"),
    position: dxfPointSchema,
    colWidths: z.array(finiteNumber.positive()).max(50),
    rowHeights: z.array(finiteNumber.positive()).max(50),
    cells: z.array(z.array(z.string().max(1000)).max(50)).max(50),
    textHeight: finiteNumber.positive().optional(),
    rotation: finiteNumber.optional(),
    headerRow: z.boolean().optional(),
  }),
  // Native block reference (M2a): resolved lazily against `DxfDocument.blocks`.
  dxfEntityBaseSchema.extend({
    type: z.literal("INSERT"),
    // May be empty for a malformed file: the resolver renders nothing for an unknown name.
    name: z.string().max(256),
    position: dxfPointSchema,
    scale: z.object({ x: finiteNumber, y: finiteNumber, z: finiteNumber.optional() }).optional(),
    rotation: finiteNumber.optional(),
    columns: z.number().int().min(1).max(100_000).optional(),
    rows: z.number().int().min(1).max(100_000).optional(),
    columnSpacing: finiteNumber.optional(),
    rowSpacing: finiteNumber.optional(),
    attributes: z.array(z.object({
      tag: z.string().max(256),
      value: z.string().max(100_000),
      position: dxfPointSchema,
      height: finiteNumber,
      rotation: finiteNumber.optional(),
      layer: z.string().max(256).optional(),
      invisible: z.boolean().optional(),
    })).max(10_000).optional(),
  }),
]);

const dxfViewportSchema = z.object({
  center: dxfPointSchema,
  width: finiteNumber,
  height: finiteNumber,
  viewCenter: dxfPointSchema,
  viewHeight: finiteNumber,
  twist: finiteNumber.optional(),
});

export const DxfDocumentSchema = z.object({
  layers: z.array(dxfLayerSchema).max(100_000),
  entities: z.array(DxfEntitySchema).max(3_000_000),
  extents: z.object({ min: dxfPointSchema, max: dxfPointSchema }).optional(),
  units: z.enum(["unitless", "mm", "cm", "m", "in", "ft"]).optional(),
  sourceFormat: z.enum(["dxf", "dwg", "cad-engine", "unknown"]).optional(),
  layouts: z.array(z.object({
    name: z.string().max(256),
    entities: z.array(DxfEntitySchema).max(3_000_000),
    viewports: z.array(dxfViewportSchema).max(10_000),
  })).max(10_000).optional(),
  blocks: z.record(z.string(), z.object({
    name: z.string().max(256),
    base: dxfPointSchema,
    entities: z.array(DxfEntitySchema).max(3_000_000),
  })).optional(),
  xrefs: z.array(z.object({
    name: z.string().max(256),
    path: z.string().max(4096),
    kind: z.enum(["attach", "overlay"]),
  })).max(10_000).optional(),
  constraints: z.array(z.object({
    kind: z.string().max(32),
    refs: z.array(z.number().int().nonnegative()).max(2),
    fp: z.array(z.string().max(256)).max(2),
    value: finiteNumber.optional(),
  })).max(100_000).optional(),
  linetypes: z.record(z.string(), z.array(finiteNumber).max(10_000)).optional(),
  ltscale: finiteNumber.optional(),
  textStyles: z.record(z.string(), z.object({
    font: z.string().max(512).optional(),
    bigFont: z.string().max(512).optional(),
    height: finiteNumber.optional(),
    width: finiteNumber.optional(),
    oblique: finiteNumber.optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    backwards: z.boolean().optional(),
    upsideDown: z.boolean().optional(),
  })).optional(),
  dimStyles: z.array(z.string().max(256)).max(10_000).optional(),
  dimStyleTable: z.record(z.string(), z.object({
    scale: finiteNumber.optional(),
    textHeight: finiteNumber.optional(),
    arrowSize: finiteNumber.optional(),
    extOffset: finiteNumber.optional(),
    extExtend: finiteNumber.optional(),
    textGap: finiteNumber.optional(),
    decimals: finiteNumber.optional(),
    postFix: z.string().max(256).optional(),
    linearFactor: finiteNumber.optional(),
  })).optional(),
  savedView: z.object({
    cx: finiteNumber,
    cy: finiteNumber,
    height: finiteNumber,
    twist: finiteNumber.optional(),
  }).optional(),
  skipped: z.record(z.string(), z.number().int().nonnegative()).optional(),
});

/** Gate a parsed DXF/DWG document: `{ok:true}` or the named issues. */
export function validateDxfDocument(doc: unknown): SchemaCheck {
  const result = validateWithSchema(DxfDocumentSchema, doc);
  if (result.ok) return { ok: true };
  return { ok: false, issues: result.issues ?? [] };
}

/** Throwing form of {@link validateDxfDocument} for the parse boundary. */
export function assertValidDxfDocument(doc: unknown, source = "DXF document"): void {
  const result = validateDxfDocument(doc);
  if (!result.ok) {
    throw new Error(`${source} failed validation: ${(result.issues ?? []).join("; ")}`);
  }
}

/* ── IFC / STEP boundary — as far as Node can reach it (PE-20) ───────────
 * The web-ifc-backed importer (`src/features/importer.ts`) is browser-only
 * (WASM + DOM) and cannot run under Node — no Node test can schema-cover
 * that path, and none here pretends to. What Node CAN cover, and what is
 * covered, is the boundary in front of it:
 *   - `StepPreflightResultSchema`: the shape of the value `preflightStep`
 *     returns. The importer asserts it before trusting `ok`/`reason`/`line`
 *     (a malformed result previously interpolated unchecked into the user
 *     facing error, e.g. a NaN line number).
 *   - `StepFileHeaderSchema` + `parseStepHeader` (in step-preflight.ts):
 *     the FILE_SCHEMA / FILE_NAME / FILE_DESCRIPTION header fields every
 *     conforming ISO-10303-21 file carries. The importer rejects a file
 *     that passes the structural preflight but carries no usable schema
 *     identity, instead of handing an anonymous STEP stream to web-ifc.
 */
export const StepPreflightResultSchema = z.object({
  ok: z.boolean(),
  reason: z.string().max(2000).optional(),
  line: z.number().int().positive().optional(),
});

/** Throwing form: the preflight's own contract, checked before use. */
export function assertValidStepPreflightResult(result: unknown, file: string): void {
  const parsed = validateWithSchema(StepPreflightResultSchema, result);
  if (!parsed.ok) {
    throw new Error(`${file}: STEP preflight returned an invalid result: ${(parsed.issues ?? []).join("; ")}`);
  }
}

/** Throwing form: the parsed STEP header, checked before use (PE-20). */
export function assertValidStepFileHeader(header: unknown, file: string): void {
  const parsed = validateWithSchema(StepFileHeaderSchema, header);
  if (!parsed.ok) {
    throw new Error(`${file}: STEP header failed validation: ${(parsed.issues ?? []).join("; ")}`);
  }
}

export const StepFileHeaderSchema = z.object({
  /** Schema identity, e.g. "IFC4" / "IFC2X3" — any non-empty string, never an enum: future schemas must not break the gate. */
  fileSchema: z.string().trim().min(1).max(128),
  fileName: z.string().max(512),
  fileDescription: z.array(z.string().max(1000)).max(100),
});

/* ── BCF zip entries — beyond the manifest (PE-20) ───────────────────────
 * `BcfManifestSchema` above covers the version manifest; the entries that
 * actually carry issue data — the parsed `markup.bcf` topic and the
 * `viewpoint.bcfv` camera — had no schema. These mirror `BcfParsedTopic`
 * in `src/modules/issues/bcf-markup.ts` and `IssueViewpoint` in
 * `src/modules/issues/types.ts`.
 *
 * Guid policy: empty is accepted (legacy files without a Guid fall back
 * to the topic folder name in `importBCF`); a non-empty Guid must be an
 * RFC 4122 UUID (`BCF_GUID_RE`). Dates must be finite epoch millis —
 * `parseBcfMarkup` already coerces unparseable dates to 0, so a
 * non-finite date here means the parser itself misbehaved.
 */
const bcfGuidSchema = z.string().max(64).refine(
  (s) => s === "" || BCF_GUID_RE.test(s),
  "must be empty or an RFC 4122 UUID",
);

export const BcfParsedTopicSchema = z.object({
  guid: bcfGuidSchema,
  topicType: z.string().max(256),
  topicStatus: z.string().max(256),
  title: z.string().min(1).max(1000),
  priority: z.string().max(64).optional(),
  labels: z.array(z.string().max(256)).max(1000),
  author: z.string().max(256),
  assignee: z.string().max(256).optional(),
  description: z.string().max(100_000),
  createdAt: finiteNumber,
  updatedAt: finiteNumber,
  dueDate: finiteNumber.optional(),
  comments: z.array(z.object({
    guid: bcfGuidSchema,
    author: z.string().max(256),
    date: finiteNumber,
    text: z.string().max(100_000),
  })).max(10_000),
});

const vec3 = z.tuple([finiteNumber, finiteNumber, finiteNumber]);

export const BcfViewpointSchema = z.object({
  cam: vec3,
  target: vec3,
  projection: z.enum(["perspective", "orthographic"]),
  thumbnail: z.string().optional(),
  up: vec3.optional(),
  orthoScale: finiteNumber.positive().optional(),
  selection: z.record(z.string(), z.array(z.number().int().nonnegative()).max(1_000_000)).optional(),
  hidden: z.record(z.string(), z.array(z.number().int().nonnegative()).max(1_000_000)).optional(),
  clippingPlanes: z.array(z.object({
    location: vec3,
    direction: vec3,
  })).max(10_000).optional(),
});

/** Gate a parsed `markup.bcf` topic: `{ok:true}` or the named issues. */
export function validateBcfParsedTopic(value: unknown): SchemaCheck {
  const result = validateWithSchema(BcfParsedTopicSchema, value);
  return result.ok ? { ok: true } : { ok: false, issues: result.issues ?? [] };
}

/** Gate a viewpoint built from a `viewpoint.bcfv` entry. */
export function validateBcfViewpoint(value: unknown): SchemaCheck {
  const result = validateWithSchema(BcfViewpointSchema, value);
  return result.ok ? { ok: true } : { ok: false, issues: result.issues ?? [] };
}

/* ── Formula boundary (PE-20) ────────────────────────────────────────────
 * Parameter names and expression inputs are validated BEFORE evaluation,
 * not by the evaluator's throws alone:
 *   - `FormulaParameterSchema`: a family parameter declaration — name
 *     must lex as a safe-expr identifier (`/^[A-Za-z_][A-Za-z0-9_]*$/`),
 *     type/scope are the closed sets from `src/modules/families/types.ts`,
 *     formula text is bounded (safe-expr refuses > 2000 chars), min/max/
 *     step are finite when present. `default` is `z.unknown()`: any JSON
 *     value is a legal default (number, string, boolean).
 *   - `FormulaExpressionSchema`: the expression text itself — non-empty,
 *     ≤ 2000 chars. Identifier membership (every name must be a declared
 *     parameter, a seed value, or a builtin) is checked by
 *     `validateFormulaExpression` in `safe-expr.ts`, which reuses the
 *     evaluator's own tokenizer, so the check and the evaluator can never
 *     disagree about what an identifier is.
 */
export const FormulaParameterSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128),
  label: z.string().max(256).optional(),
  type: z.enum(["length", "angle", "number", "integer", "text", "area", "volume", "boolean", "material", "colour", "family-type"]),
  scope: z.enum(["instance", "type"]),
  default: z.unknown().optional(),
  editable: z.boolean().optional(),
  min: finiteNumber.optional(),
  max: finiteNumber.optional(),
  step: finiteNumber.optional(),
  unit: z.string().max(64).optional(),
  group: z.string().max(128).optional(),
  description: z.string().max(2000).optional(),
  formula: z.string().max(2000).optional(),
});

export const FormulaExpressionSchema = z.string().trim().min(1).max(2000);

/**
 * GeoJSON envelope: deliberately permissive — the gis-core walker validates
 * geometry types, coerces coordinates to finite numbers and skips the rest.
 * The schema's job is only to prove the root is a GeoJSON-shaped object; the
 * size / depth / node bounds come from the safeLoad call site
 * (20 MB, depth 32, 2,000,000 nodes in parseGeoJson).
 */
export const GeoJsonSchema = z.object({
  type: z.string().min(1),
}).passthrough();
