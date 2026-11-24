/**
 * Bridge between the editor's entities and the pure constraint solver (Phase 4).
 * Pure: no DOM. Entities are addressed by stable string ids chosen by the caller, so a relation survives the
 * object replacement that every undoable edit performs.
 *
 * Supported geometry: LINE, CIRCLE, ARC (an ARC contributes its centre and radius; its angles are kept).
 * Anything else is reported in `messages` and left untouched — never silently moved.
 */
import type { DxfEntity } from "../drawings/dxf-types";
import { solve, type Constraint, type Sketch, type SolveStatus } from "./constraint-solver";

export type RelationKind =
  | "horizontal" | "vertical" | "parallel" | "perpendicular" | "equal" | "concentric" | "tangent"
  | "length" | "radius" | "angle";

export interface Relation {
  kind: RelationKind;
  /** Entity ids: one for horizontal/vertical/length/radius, two for the rest. */
  ids: string[];
  /** length / radius: drawing units; angle: radians between the two line directions. */
  value?: number;
}

export interface BridgeResult {
  status: SolveStatus | "empty";
  /** Entities whose geometry changed, keyed by id (new objects; inputs are not mutated). */
  updated: Map<string, DxfEntity>;
  dof: number;
  /** Indices into the relation list. */
  redundant: number[];
  conflicting: number[];
  messages: string[];
}

type Geo = Extract<DxfEntity, { type: "LINE" | "CIRCLE" | "ARC" }>;
const isGeo = (e: DxfEntity | undefined): e is Geo => !!e && (e.type === "LINE" || e.type === "CIRCLE" || e.type === "ARC");
const isLine = (e: DxfEntity | undefined): e is Extract<DxfEntity, { type: "LINE" }> => !!e && e.type === "LINE";
const isRound = (e: DxfEntity | undefined): e is Extract<DxfEntity, { type: "CIRCLE" | "ARC" }> => !!e && (e.type === "CIRCLE" || e.type === "ARC");

export function relationArity(k: RelationKind): 1 | 2 {
  return k === "horizontal" || k === "vertical" || k === "length" || k === "radius" ? 1 : 2;
}

/** Check a relation against the geometry it names; returns a message when it cannot be expressed. */
export function validateRelation(r: Relation, byId: ReadonlyMap<string, DxfEntity>): string | null {
  if (r.ids.length !== relationArity(r.kind)) return `${r.kind}: needs ${relationArity(r.kind)} object(s)`;
  const [a, b] = r.ids.map((i) => byId.get(i));
  if (!a || (relationArity(r.kind) === 2 && !b)) return `${r.kind}: an object no longer exists`;
  switch (r.kind) {
    case "horizontal": case "vertical": case "length": return isLine(a) ? null : `${r.kind}: needs a LINE`;
    case "radius": return isRound(a) ? null : "radius: needs a CIRCLE or ARC";
    case "parallel": case "perpendicular": case "angle": return isLine(a) && isLine(b) ? null : `${r.kind}: needs two LINEs`;
    case "concentric": return isRound(a) && isRound(b) ? null : "concentric: needs two CIRCLE/ARC";
    case "equal": return (isLine(a) && isLine(b)) || (isRound(a) && isRound(b)) ? null : "equal: needs two LINEs or two CIRCLE/ARC";
    case "tangent": return (isLine(a) && isRound(b)) || (isRound(a) && isLine(b)) ? null : "tangent: needs a LINE and a CIRCLE/ARC";
  }
}

/**
 * Solve every valid relation together. `pinned` ids keep their points fixed (the editor's FIX).
 * The solver starts from the current geometry and damps its steps, so objects move as little as possible.
 */
export function solveRelations(
  byId: ReadonlyMap<string, DxfEntity>,
  relations: readonly Relation[],
  pinned: ReadonlySet<string> = new Set(),
): BridgeResult {
  const messages: string[] = [];
  const valid: { rel: Relation; index: number }[] = [];
  relations.forEach((rel, index) => {
    const bad = validateRelation(rel, byId);
    if (bad) messages.push(`relation ${index + 1} skipped — ${bad}`);
    else valid.push({ rel, index });
  });
  if (!valid.length) return { status: "empty", updated: new Map(), dof: 0, redundant: [], conflicting: [], messages };

  const used = [...new Set(valid.flatMap((v) => v.rel.ids))].sort();
  const sk: Sketch = { points: {}, lines: {}, circles: {}, arcs: {} };
  const constraints: Constraint[] = [];
  const cid = new Map<number, number>(); // constraint list index -> relation index
  for (const id of used) {
    const e = byId.get(id) as Geo;
    if (e.type === "LINE") {
      sk.points[`${id}.a`] = { x: e.start.x, y: e.start.y };
      sk.points[`${id}.b`] = { x: e.end.x, y: e.end.y };
      sk.lines[id] = { p1: `${id}.a`, p2: `${id}.b` };
      if (pinned.has(id)) {
        constraints.push({ id: `pin:${id}.a`, type: "fixed", point: `${id}.a` }, { id: `pin:${id}.b`, type: "fixed", point: `${id}.b` });
      }
    } else {
      sk.points[`${id}.c`] = { x: e.center.x, y: e.center.y };
      sk.circles[id] = { c: `${id}.c`, r: e.radius };
      if (pinned.has(id)) {
        // A pinned round object keeps both its centre and its radius.
        constraints.push({ id: `pin:${id}.c`, type: "fixed", point: `${id}.c` }, { id: `pin:${id}.r`, type: "radius", circle: id, value: e.radius });
      }
    }
  }
  for (const { rel, index } of valid) {
    const [a, b] = rel.ids as [string, string];
    const id = `r${String(index).padStart(5, "0")}`;
    const ea = byId.get(a);
    let c: Constraint | null = null;
    switch (rel.kind) {
      case "horizontal": c = { id, type: "horizontal", line: a }; break;
      case "vertical": c = { id, type: "vertical", line: a }; break;
      case "parallel": c = { id, type: "parallel", a, b }; break;
      case "perpendicular": c = { id, type: "perpendicular", a, b }; break;
      case "equal": c = isLine(ea) ? { id, type: "equalLength", a, b } : { id, type: "equalRadius", a, b }; break;
      case "concentric": c = { id, type: "concentric", a, b }; break;
      case "tangent": c = isLine(ea) ? { id, type: "tangent", line: a, circle: b } : { id, type: "tangent", line: b, circle: a }; break;
      case "length": c = { id, type: "length", line: a, value: rel.value ?? 0 }; break;
      case "radius": c = { id, type: "radius", circle: a, value: rel.value ?? 0 }; break;
      case "angle": c = { id, type: "angle", a, b, value: rel.value ?? 0 }; break;
    }
    if (c) { cid.set(constraints.length, index); constraints.push(c); }
  }

  const res = solve(sk, constraints);
  const rIndex = (ids: string[]): number[] =>
    ids.map((x) => constraints.findIndex((c) => c.id === x)).filter((i) => i >= 0).map((i) => cid.get(i)).filter((i): i is number => i !== undefined);
  const out: BridgeResult = {
    status: res.status, updated: new Map(), dof: res.dof,
    redundant: rIndex(res.redundant), conflicting: rIndex(res.conflicting),
    messages: [...messages, ...res.messages],
  };
  // Only commit a solution that satisfies the constraints; a diverged/conflicting set leaves the drawing as is.
  if (res.status === "diverged" || res.status === "conflict" || res.status === "invalid") return out;

  const EPS = 1e-9;
  for (const id of used) {
    const e = byId.get(id) as Geo;
    if (e.type === "LINE") {
      const p = res.sketch.points[`${id}.a`]!, q = res.sketch.points[`${id}.b`]!;
      if (Math.abs(p.x - e.start.x) + Math.abs(p.y - e.start.y) + Math.abs(q.x - e.end.x) + Math.abs(q.y - e.end.y) > EPS)
        out.updated.set(id, { ...e, start: { ...e.start, x: p.x, y: p.y }, end: { ...e.end, x: q.x, y: q.y } });
    } else {
      const c = res.sketch.points[`${id}.c`]!;
      const r = (e.type === "CIRCLE" ? res.sketch.circles[id]! : res.sketch.circles[id]!).r;
      if (Math.abs(c.x - e.center.x) + Math.abs(c.y - e.center.y) + Math.abs(r - e.radius) > EPS)
        out.updated.set(id, { ...e, center: { ...e.center, x: c.x, y: c.y }, radius: r });
    }
  }
  return out;
}

export function describeBridge(r: BridgeResult, relations: readonly Relation[]): string[] {
  const name = (i: number): string => `#${i + 1} ${relations[i]?.kind ?? "?"}`;
  const lines: string[] = [];
  const head: Record<string, string> = {
    solved: "fully constrained", underconstrained: `solved — ${r.dof} degree(s) of freedom remain`, overconstrained: "solved — some relations are redundant",
    conflict: "NOT applied — relations conflict", diverged: "NOT applied — the solver did not converge", invalid: "NOT applied — invalid input", empty: "no usable relations",
  };
  lines.push(`${head[r.status] ?? r.status}; ${r.updated.size} object(s) moved.`);
  if (r.conflicting.length) lines.push(`Conflicting: ${r.conflicting.map(name).join(", ")}`);
  if (r.redundant.length) lines.push(`Redundant: ${r.redundant.map(name).join(", ")}`);
  for (const m of r.messages.slice(0, 5)) lines.push(m);
  return lines;
}
