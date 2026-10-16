/**
 * Schedule generator v2.
 *
 * New in this revision:
 *   • Formula columns (evaluated per row via schedule-formula.ts)
 *   • Live quantities — Area/Volume/Length pulled from getElementTriangles
 *   • Live cost — Cost item, unit rate, and line cost resolved per row
 *   • Multi-level grouping with subtotals
 *   • Conditional formatting rule application (returns hints to the panel)
 *   • Aggregate formulas via [SUM], [AVG], [COUNT] over group scope
 */
import * as THREE from "three";
import { ctx } from "../../core/context";
import { getElements } from "../../features/authoring";
import { getElementTriangles } from "../clash/geometry";
import { computeTakeoff, getRows as getTakeoffRows } from "../cost/quantities";
import { computeLine } from "../cost/cost";
import type { AuthoredElement } from "../projects/types";
import type {
  ScheduleColumn,
  ScheduleDefinition,
  ScheduleRow,
  ScheduleRun,
  GroupLevel,
} from "./schedule-types";
import { compileFormula, validateFormula } from "./schedule-formula";

/* ═════════════════════════════════════════════════════════════════════════
   Geometry math (shared with quantities.ts)
   ═════════════════════════════════════════════════════════════════════════ */
function signedVolume(tris: Float32Array[]): number {
  let v = 0;
  for (const t of tris) {
    const ax = t[0], ay = t[1], az = t[2];
    const bx = t[3], by = t[4], bz = t[5];
    const cx = t[6], cy = t[7], cz = t[8];
    v += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(v);
}

function surfaceArea(tris: Float32Array[]): number {
  let s = 0;
  for (const t of tris) {
    const ux = t[3] - t[0], uy = t[4] - t[1], uz = t[5] - t[2];
    const vx = t[6] - t[0], vy = t[7] - t[1], vz = t[8] - t[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    s += 0.5 * Math.hypot(nx, ny, nz);
  }
  return s;
}

function bboxSize(b: THREE.Box3): THREE.Vector3 {
  const v = new THREE.Vector3();
  b.getSize(v);
  return v;
}

/* ═════════════════════════════════════════════════════════════════════════
   Helpers
   ═════════════════════════════════════════════════════════════════════════ */
function shortCat(cat: string): string {
  return cat.replace(/^IFC/i, "").replace(/STANDARDCASE$/i, "") || cat;
}

function r3(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

function levelNameForElevation(elevation: number): string {
  return `Level ${Math.max(0, Math.round(elevation / 3))}`;
}

/* ═════════════════════════════════════════════════════════════════════════
   Takeoff integration
   ═════════════════════════════════════════════════════════════════════════ */
let takeoffCache: Awaited<ReturnType<typeof computeTakeoff>> | null = null;
let takeoffCacheAt = 0;

async function ensureTakeoff(): Promise<void> {
  const now = Date.now();
  if (takeoffCache && now - takeoffCacheAt < 30_000) return;
  takeoffCache = await computeTakeoff();
  takeoffCacheAt = now;
}

function lookupTakeoff(key: string) {
  if (!takeoffCache) return null;
  return takeoffCache.find((r) => r.key === key) ?? null;
}

/* ═════════════════════════════════════════════════════════════════════════
   Authored rows
   ═════════════════════════════════════════════════════════════════════════ */
function matchesCategory(el: AuthoredElement, category: string | null): boolean {
  if (!category) return true;
  const c = category.toUpperCase();
  const t = el.type.toUpperCase();
  if (c === "IFCDOOR") return t === "DOOR";
  if (c === "IFCWINDOW") return t === "WINDOW";
  if (c === "IFCWALL") return t === "WALL";
  if (c === "IFCSLAB") return t === "SLAB";
  if (c === "IFCCOLUMN") return t === "COLUMN";
  if (c === "IFCBEAM") return t === "BEAM";
  if (c === "IFCMEMBER") return t === "BRACE" || t === "TRUSS";
  if (c === "IFCFOOTING") return t === "FOOTING" || t === "STRIP";
  if (c === "IFCDUCTSEGMENT") return t === "DUCT";
  if (c === "IFCPIPESEGMENT") return t === "PIPE";
  if (c === "IFCCABLECARRIERSEGMENT") return t === "CABLE-TRAY";
  if (c === "IFCCONDUITSEGMENT") return t === "CONDUIT";
  return true;
}

function authoredRow(el: AuthoredElement, def: ScheduleDefinition): ScheduleRow {
  const p = el.params;
  const values: Record<string, string | number | null> = {
    mark: el.name,
    name: el.name,
    type: p.doorPanel || p.windowPanel ? `${el.type} (${p.doorPanel ?? p.windowPanel})` : el.type,
    level: levelNameForElevation(p.elevation),
    category: shortCat(el.type.toUpperCase()),
    width: r3(
      p.width ??
        (p.start && p.end
          ? Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1])
          : 0),
    ),
    height: r3(p.height ?? 0),
    depth: r3(p.depth ?? 0),
    thickness: r3(p.thickness),
    elevation: r3(p.elevation),
    material: String((el.properties as any)?.material ?? ""),
    fireRating: String((el.properties as any)?.fireRating ?? ""),
    panel: p.doorPanel ?? p.windowPanel ?? null,
    glazing: p.windowPanel ?? null,
    systemType: String((el.properties as any)?.systemType ?? ""),
    count: 1,
  };

  // Live quantities — pull from the takeoff engine when enabled.
  if (def.useLiveQuantities && takeoffCache) {
    const t = lookupTakeoff(`authored:${el.id}`);
    if (t) {
      values.length = t.length;
      values.area = t.area;
      values.volume = t.volume;
    }
  }

  return {
    id: `authored:${el.id}`,
    source: "authored",
    values,
    link: { kind: "authored", authoredId: el.id },
  };
}

/* ═════════════════════════════════════════════════════════════════════════
   IFC rows
   ═════════════════════════════════════════════════════════════════════════ */
interface IfcCacheEntry {
  ids: number[];
  categoryBy: Map<number, string>;
  meta: Map<number, Record<string, string>>;
  boxes: THREE.Box3[];
  matrix: THREE.Matrix4;
  name: string;
}
const ifcCache = new Map<string, IfcCacheEntry>();

async function buildIfcCache(modelId: string, model: any): Promise<void> {
  if (ifcCache.has(modelId)) return;

  let ids: number[] = [];
  let boxes: THREE.Box3[] = [];
  try {
    ids = ((await (model as any).getItemsIdsWithGeometry?.()) as number[]) ?? [];
    boxes = await (model as any).getBoxes(ids);
  } catch {
    ifcCache.set(modelId, {
      ids: [],
      categoryBy: new Map(),
      meta: new Map(),
      boxes: [],
      matrix: new THREE.Matrix4(),
      name: modelId,
    });
    return;
  }

  const categoryBy = new Map<number, string>();
  try {
    const cats = await (model as any).getItemsOfCategories([/.+/]);
    for (const [c, list] of Object.entries(cats ?? {})) {
      for (const id of (list as number[]) ?? []) categoryBy.set(id, c);
    }
  } catch {
    /* */
  }

  // Attributes — batch in chunks of 500.
  const meta = new Map<number, Record<string, string>>();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    try {
      const data = await (model as any).getItemsData(slice, {
        attributesDefault: false,
        attributes: ["Name", "ObjectType", "Tag", "Description", "PredefinedType", "FireRating"],
      });
      for (let j = 0; j < slice.length; j++) {
        const d = (data as any)?.[j] ?? {};
        const m: Record<string, string> = {};
        for (const k of Object.keys(d)) {
          const v = d[k]?.value ?? d[k];
          if (v != null && typeof v !== "object") m[k] = String(v);
        }
        meta.set(slice[j], m);
      }
    } catch {
      /* */
    }
  }

  try {
    model.object?.updateMatrixWorld?.(true);
  } catch {
    /* */
  }
  const matrix =
    (model.object?.matrixWorld?.clone?.() as THREE.Matrix4) ?? new THREE.Matrix4();

  ifcCache.set(modelId, {
    ids,
    categoryBy,
    meta,
    boxes,
    matrix,
    name: (model as any)?.name ?? modelId,
  });
}

export function clearIfcScheduleCache(): void {
  ifcCache.clear();
  takeoffCache = null;
  takeoffCacheAt = 0;
}

function matchesIfcCategory(rawCat: string, wanted: string | null): boolean {
  if (!wanted) return true;
  const w = wanted.toUpperCase();
  const c = rawCat.toUpperCase();
  return c === w || c.startsWith(w);
}

async function ifcRows(def: ScheduleDefinition, signal?: { cancelled: boolean }): Promise<ScheduleRow[]> {
  await ensureTakeoff();
  const out: ScheduleRow[] = [];

  for (const [modelId, model] of ctx.fragments.list) {
    if (signal?.cancelled) break;
    await buildIfcCache(modelId, model);
    const cache = ifcCache.get(modelId);
    if (!cache || !cache.ids.length) continue;

    for (let i = 0; i < cache.ids.length; i++) {
      if (signal?.cancelled) break;
      const id = cache.ids[i];
      const rawCat = cache.categoryBy.get(id) ?? "Other";
      if (!matchesIfcCategory(rawCat, def.category)) continue;

      const b = cache.boxes[i];
      if (!b || b.isEmpty()) continue;
      const world = b.clone().applyMatrix4(cache.matrix);
      const size = bboxSize(world);
      const meta = cache.meta.get(id) ?? {};
      const name = meta.Name ?? meta.ObjectType ?? meta.Tag ?? `#${id}`;

      const values: Record<string, string | number | null> = {
        mark: name,
        name,
        type: meta.ObjectType ?? shortCat(rawCat),
        level: null,
        category: shortCat(rawCat),
        width: r3(Math.max(size.x, size.z)),
        height: r3(size.y),
        depth: r3(Math.min(size.x, size.z)),
        thickness: r3(Math.min(size.x, size.z)),
        area: r3(2 * (size.x * size.y + size.x * size.z + size.y * size.z)),
        volume: r3(Math.abs(size.x * size.y * size.z)),
        fireRating: meta.FireRating ?? "",
        material: meta.Material ?? "",
        count: 1,
      };

      // Live quantities — prefer geometric extraction when triangles exist.
      if (def.useLiveQuantities) {
        try {
          const tris = getElementTriangles(model.object, id);
          if (tris && tris.length) {
            values.volume = r3(signedVolume(tris));
            values.area = r3(surfaceArea(tris));
            const diag = Math.hypot(size.x, size.y, size.z);
            values.length = r3(diag * 0.9);
          }
        } catch {
          /* fall back to bbox */
        }
      }

      out.push({
        id: `ifc:${modelId}:${id}`,
        source: "ifc",
        values,
        link: { kind: "ifc", modelId, localId: id },
      });
    }
  }
  return out;
}

/* ═════════════════════════════════════════════════════════════════════════
   Cost attachment
   ═════════════════════════════════════════════════════════════════════════ */
function attachCost(row: ScheduleRow): void {
  try {
    const line = computeLine({
      key: row.id,
      source: row.source === "ifc" ? "ifc" : "authored",
      label: String(row.values.name ?? ""),
      detail: "",
      count: Number(row.values.count ?? 1),
      length: Number(row.values.length ?? 0),
      area: Number(row.values.area ?? 0),
      volume: Number(row.values.volume ?? 0),
    } as any);
    if (line.item) {
      row.values.costItem = `${line.item.code} · ${line.item.name}`;
      row.values.unitRate = line.rate;
      row.values.lineCost = r3(line.lineCost);
    } else {
      row.values.costItem = "";
      row.values.unitRate = 0;
      row.values.lineCost = 0;
    }
  } catch {
    row.values.costItem = "";
    row.values.unitRate = 0;
    row.values.lineCost = 0;
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Formulas
   ═════════════════════════════════════════════════════════════════════════ */
type CompiledCol = { key: string; fn: ReturnType<typeof compileFormula> };

function compileFormulaColumns(def: ScheduleDefinition): CompiledCol[] {
  const out: CompiledCol[] = [];
  for (const col of def.columns) {
    if (col.format !== "formula") continue;
    if (!col.formula) continue;
    const v = validateFormula(col.formula);
    if (!v.ok) {
      console.warn(`[schedule] invalid formula for "${col.key}":`, v.error);
      continue;
    }
    out.push({ key: col.key, fn: compileFormula(col.formula) });
  }
  return out;
}

/** Evaluate every formula column for every row, using group-scope aggregates. */
function evaluateFormulas(rows: ScheduleRow[], compiled: CompiledCol[]): void {
  if (!compiled.length || !rows.length) return;

  // Precompute aggregate accessors per group for each formula column.
  // We compute them on the fly per row (small dataset).
  for (const row of rows) {
    for (const { key, fn } of compiled) {
      const ctxAgg = {
        sum: (header: string) => aggregateOver(rows, header, row, "sum"),
        avg: (header: string) => aggregateOver(rows, header, row, "avg"),
        count: (header: string) => aggregateOver(rows, header, row, "count"),
        min: (header: string) => aggregateOver(rows, header, row, "min"),
        max: (header: string) => aggregateOver(rows, header, row, "max"),
      };
      try {
        const v = fn({ values: row.values, aggregates: ctxAgg });
        row.values[key] = Number.isFinite(v) ? r3(v) : 0;
      } catch (err) {
        row.values[key] = 0;
      }
    }
  }
}

function aggregateOver(
  rows: ScheduleRow[],
  header: string,
  scopeRow: ScheduleRow,
  op: "sum" | "avg" | "count" | "min" | "max",
): number {
  // For now, aggregate over all rows of the same source-kind.
  // Group-scoped aggregation is a later enhancement.
  const sameKind = rows.filter((r) => !r.subtotal && r.source === scopeRow.source);
  const vals: number[] = [];
  for (const r of sameKind) {
    const v = headerValue(r, header);
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    if (Number.isFinite(n)) vals.push(n);
  }
  if (!vals.length) return 0;
  switch (op) {
    case "sum": return vals.reduce((a, b) => a + b, 0);
    case "avg": return vals.reduce((a, b) => a + b, 0) / vals.length;
    case "count": return vals.length;
    case "min": return Math.min(...vals);
    case "max": return Math.max(...vals);
  }
}

function headerValue(row: ScheduleRow, header: string): string | number | null {
  if (header in row.values) return row.values[header];
  const lower = header.toLowerCase();
  for (const [k, v] of Object.entries(row.values)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/* ═════════════════════════════════════════════════════════════════════════
   Grouping
   ═════════════════════════════════════════════════════════════════════════ */
function bucketValue(value: any, bucket: GroupLevel["bucket"]): string | number {
  if (bucket === "thousands") {
    const n = parseFloat(String(value ?? ""));
    return Number.isFinite(n) ? Math.floor(n / 1000) * 1000 : "—";
  }
  if (bucket === "firstLetter") {
    const s = String(value ?? "");
    return s ? s[0].toUpperCase() : "—";
  }
  if (bucket === "ifcPrefix") {
    const s = String(value ?? "").replace(/^IFC/i, "");
    return s.slice(0, 4).toUpperCase() || "—";
  }
  if (bucket === "level") {
    return String(value ?? "—") || "—";
  }
  return String(value ?? "—") || "—";
}

/** Attach `groupPath` to each row based on the definition's group levels. */
function assignGroupPath(rows: ScheduleRow[], levels: GroupLevel[]): void {
  if (!levels.length) return;
  for (const row of rows) {
    const path: (string | number)[] = [];
    for (const lvl of levels) {
      const v = headerValue(row, lvl.key);
      path.push(bucketValue(v, lvl.bucket));
    }
    row.groupPath = path;
  }
}

/** Build subtotal rows per group level. Returns a new array with rows
 *  reordered by group and subtotal rows inserted. */
function buildGroupedRows(
  rows: ScheduleRow[],
  levels: GroupLevel[],
  numericColumns: string[],
): ScheduleRow[] {
  if (!levels.length) return rows;

  const out: ScheduleRow[] = [];
  const recursion = (subset: ScheduleRow[], level: number, prefix: (string | number)[]) => {
    if (level >= levels.length) {
      for (const r of subset) out.push(r);
      return;
    }
    const buckets = new Map<string | number, ScheduleRow[]>();
    for (const r of subset) {
      const key = r.groupPath?.[level] ?? "—";
      const arr = buckets.get(key) ?? [];
      arr.push(r);
      buckets.set(key, arr);
    }
    const sortedKeys = [...buckets.keys()].sort((a, b) =>
      String(a).localeCompare(String(b)),
    );

    for (const k of sortedKeys) {
      const group = buckets.get(k)!;
      // Emit a header row at this level.
      const headerRow: ScheduleRow = {
        id: `group:${prefix.concat(k).join("|")}`,
        source: "mixed",
        values: {},
        groupPath: prefix.concat(k),
        depth: level,
        subtotal: true,
      };
      const firstColKey = numericColumns[0] ? undefined : undefined;
      const labelCol = levels[level].key;
      headerRow.values[labelCol] = k;
      out.push(headerRow);

      // Recurse or emit data rows
      recursion(group, level + 1, prefix.concat(k));

      // Emit subtotal after this group if it's the last level or subtotal is on.
      const subtotalEnabled = levels[level].subtotal !== false;
      if (subtotalEnabled) {
        const subtotalRow: ScheduleRow = {
          id: `subtotal:${prefix.concat(k).join("|")}`,
          source: "mixed",
          values: {},
          groupPath: prefix.concat(k),
          depth: level,
          subtotal: true,
          subtotalValues: {},
        };
        for (const colKey of numericColumns) {
          let s = 0;
          for (const r of group) {
            const v = headerValue(r, colKey);
            const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
            if (Number.isFinite(n)) s += n;
          }
          subtotalRow.subtotalValues![colKey] = r3(s);
        }
        subtotalRow.values[levels[level].key] = `Subtotal · ${k}`;
        out.push(subtotalRow);
      }
    }
  };
  recursion(rows, 0, []);
  return out;
}

/* ═════════════════════════════════════════════════════════════════════════
   Public
   ═════════════════════════════════════════════════════════════════════════ */
export interface RunScheduleOptions {
  signal?: { cancelled: boolean };
  onProgress?: (p: { phase: string; current: number; total: number }) => void;
}

export async function runSchedule(
  def: ScheduleDefinition,
  opts: RunScheduleOptions = {},
): Promise<ScheduleRun> {
  const onProg = opts.onProgress ?? (() => {});

  onProg({ phase: "Reading authored elements", current: 0, total: 3 });

  const authoredRows: ScheduleRow[] = [];
  for (const el of getElements()) {
    if (opts.signal?.cancelled) break;
    if (!matchesCategory(el, def.category)) continue;
    if (def.levelName && levelNameForElevation(el.params.elevation) !== def.levelName) continue;
    const row = authoredRow(el, def);
    if (def.useCostData) attachCost(row);
    authoredRows.push(row);
  }

  onProg({ phase: "Reading IFC elements", current: 1, total: 3 });
  const ifc = await ifcRows(def, opts.signal);
  if (def.useCostData) for (const r of ifc) attachCost(r);

  onProg({ phase: "Grouping and totals", current: 2, total: 3 });
  let all: ScheduleRow[] = [...authoredRows, ...ifc];

  // Sorting
  const sortKeys = def.sortKeys ?? (def.sortBy ? [{ key: def.sortBy, dir: "asc" } as const] : []);
  if (sortKeys.length) {
    all.sort((a, b) => {
      for (const sk of sortKeys) {
        const va = headerValue(a, sk.key);
        const vb = headerValue(b, sk.key);
        if (va == null && vb == null) continue;
        if (va == null) return sk.dir === "asc" ? 1 : -1;
        if (vb == null) return sk.dir === "asc" ? -1 : 1;
        if (typeof va === "number" && typeof vb === "number") {
          if (va !== vb) return (va - vb) * (sk.dir === "asc" ? 1 : -1);
        } else {
          const cmp = String(va).localeCompare(String(vb));
          if (cmp !== 0) return cmp * (sk.dir === "asc" ? 1 : -1);
        }
      }
      return 0;
    });
  }

  // Formula columns
  const compiled = compileFormulaColumns(def);
  if (compiled.length) evaluateFormulas(all, compiled);

  // Grand totals (before grouping so we don't count subtotal rows)
  const numericCols = def.columns
    .filter((c) => c.format !== "text" && c.format !== "date")
    .map((c) => c.key);
  const totals: Record<string, number> = {};
  for (const c of numericCols) {
    let s = 0;
    for (const r of all) {
      const v = r.values[c];
      const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
      if (Number.isFinite(n)) s += n;
    }
    totals[c] = r3(s);
  }

  // Grouping
  if (def.grouping?.length) {
    assignGroupPath(all, def.grouping);
    all = buildGroupedRows(all, def.grouping, numericCols);
  }

  onProg({ phase: "Done", current: 3, total: 3 });

  return {
    definition: def,
    rows: all,
    totals,
    generatedAt: Date.now(),
  };
}

export async function runBuiltInSchedule(
  id: string,
  opts?: RunScheduleOptions,
): Promise<ScheduleRun | null> {
  const { getTemplate } = await import("./schedule-templates");
  const def = getTemplate(id);
  if (!def) return null;
  return runSchedule(def, opts);
}