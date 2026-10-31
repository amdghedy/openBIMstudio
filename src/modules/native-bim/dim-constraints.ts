/** Pure dimensional-constraint model (length/height/offset/EQ). */
export type DimKind =
  | "length" | "height" | "thickness" | "offset" | "width" | "angle" | "elevation";

export interface DimConstraint {
  id: string;
  elementId: string;
  kind: DimKind;
  param: string;
  value: number;
  locked: boolean;
}

export interface ConstraintUpdate { elementId: string; param: string; value: number; }
export interface ConstraintResult {
  updates: ConstraintUpdate[];
  failures: Array<{ elementId: string; reason: string }>;
}

export function applyDimConstraints(
  elements: Array<{ id: string; params: Record<string, any> }>,
  constraints: DimConstraint[],
): ConstraintResult {
  const updates: ConstraintUpdate[] = [];
  const failures: Array<{ elementId: string; reason: string }> = [];
  for (const c of constraints) {
    if (!c.locked) continue;
    const el = elements.find((e) => e.id === c.elementId);
    if (!el) { failures.push({ elementId: c.elementId, reason: "element not found" }); continue; }
    const p = el.params;
    if (c.param === "length" && p.start && p.end) {
      const [sx, sz] = p.start as [number, number];
      const [ex, ez] = p.end as [number, number];
      const len = Math.hypot(ex - sx, ez - sz);
      if (len < 1e-9) { failures.push({ elementId: c.elementId, reason: "zero-length element" }); continue; }
      const k = c.value / len;
      p.end = [sx + (ex - sx) * k, sz + (ez - sz) * k];
      updates.push({ elementId: c.elementId, param: "end", value: c.value });
    } else if (c.param === "height") {
      p.height = Math.max(0.01, c.value);
      updates.push({ elementId: c.elementId, param: "height", value: p.height });
    } else if (c.param === "thickness") {
      p.thickness = Math.max(0.01, c.value);
      updates.push({ elementId: c.elementId, param: "thickness", value: p.thickness });
    } else if (c.param === "width") {
      p.width = Math.max(0.05, c.value);
      updates.push({ elementId: c.elementId, param: "width", value: p.width });
    } else if (c.param === "offsetAlongHost") {
      p.offsetAlongHost = c.value;
      updates.push({ elementId: c.elementId, param: "offsetAlongHost", value: c.value });
    } else if (c.param === "sillHeight") {
      p.sillHeight = c.value;
      updates.push({ elementId: c.elementId, param: "sillHeight", value: c.value });
    } else {
      failures.push({ elementId: c.elementId, reason: `unsupported param ${c.param}` });
    }
  }
  return { updates, failures };
}

export interface EqConstraint {
  id: string;
  elementIds: string[];
  axis: "x" | "z";
}

/** Equal spacing between consecutive element centres along one axis. */
export function solveEqSpacing(
  elements: Array<{ id: string; params: Record<string, any> }>,
  eq: EqConstraint,
): Array<{ elementId: string; value: number }> {
  const pts: Array<{ id: string; v: number }> = [];
  for (const id of eq.elementIds) {
    const el = elements.find((e) => e.id === id);
    if (!el) continue;
    const p = el.params;
    if (p.point) pts.push({ id, v: eq.axis === "x" ? p.point[0] : p.point[1] });
    else if (p.start && p.end) {
      const a = p.start as [number, number], b = p.end as [number, number];
      pts.push({ id, v: eq.axis === "x" ? (a[0] + b[0]) / 2 : (a[1] + b[1]) / 2 });
    }
  }
  if (pts.length < 2) return [];
  pts.sort((a, b) => a.v - b.v);
  const first = pts[0].v, last = pts[pts.length - 1].v;
  const step = (last - first) / (pts.length - 1);
  return pts.map((p, i) => ({ elementId: p.id, value: first + step * i }));
}