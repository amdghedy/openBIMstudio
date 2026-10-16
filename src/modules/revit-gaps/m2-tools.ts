/**
 * Milestone 2 placement tools (3D view): stairs (straight / L / U), railing,
 * ramp, curtain wall, roof, ceiling, plus "ceilings from rooms".
 *
 * Created elements are ordinary authored elements: they sit on the active level,
 * are saved with the project, selectable, editable through grips and the
 * Properties palette, move / copy / rotate like any other element, appear in the
 * cost takeoff, export to IFC, and every placement is one undo step.
 *
 * Interaction: click points on the level plane. Snaps to existing element
 * end points / vertices (0.25 m) and a 0.05 m grid; hold Shift for orthogonal.
 *   two-point tools (stairs, ramp, curtain wall): click start, click end
 *   polyline tools  (railing, roof, ceiling):     click points, double-click or Enter to finish
 *   Esc cancels.
 */
import * as THREE from "three";
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { history } from "../../features/history";
import { roomsStore } from "../rooms/rooms";
import type { Vec2 } from "./m2-geometry";

type Any = Record<string, any>;
export type M2Kind = "stairs" | "railing" | "ramp" | "curtain-wall" | "roof" | "ceiling";
export type StairShape = "straight" | "L" | "U";

const authoring = (): Any | null => ((ctx.features as Any).authoring ?? null);
const LABEL: Record<M2Kind, string> = { stairs: "Stair", railing: "Railing", ramp: "Ramp", "curtain-wall": "Curtain wall", roof: "Roof", ceiling: "Ceiling" };
const POLY: Record<M2Kind, boolean> = { stairs: false, railing: true, ramp: false, "curtain-wall": false, roof: true, ceiling: true };

/* ------------------------------------------------------------------ levels */

interface Lv { id: string | null; elevation: number; above: number | null }
function levelContext(): Lv {
  const a = authoring();
  const levels: Any[] = (a?.getLevels?.() ?? []).slice().sort((x: Any, y: Any) => x.elevation - y.elevation);
  const id: string | null = a?.getActiveLevelId?.() ?? null;
  const cur = levels.find((l) => l.id === id);
  const elevation = cur ? Number(cur.elevation) || 0 : 0;
  const up = levels.find((l) => Number(l.elevation) > elevation + 0.05);
  return { id: cur?.id ?? null, elevation, above: up ? Number(up.elevation) : null };
}

/* ---------------------------------------------------------- element creation */

const uid = () => "m2-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

export function defaultsFor(kind: M2Kind, pts: Vec2[], lv: Lv, shape: StairShape): { params: Any; properties: Any } {
  const levelH = lv.above != null ? lv.above - lv.elevation : null;
  switch (kind) {
    case "stairs":
      return { params: { start: pts[0], end: pts[1], width: 1.2, height: levelH ?? 3, thickness: 0.15, elevation: lv.elevation }, properties: { stairShape: shape, stairTurn: "left", maxRiser: 0.175 } };
    case "ramp":
      return { params: { start: pts[0], end: pts[1], width: 1.5, height: 0.5, thickness: 0.2, elevation: lv.elevation }, properties: {} };
    case "curtain-wall":
      return { params: { start: pts[0], end: pts[1], height: levelH ?? 3.6, thickness: 0.1, elevation: lv.elevation }, properties: { uSpacing: 1.5, vSpacing: 1.2 } };
    case "railing":
      return { params: { polygon: pts, height: 1.0, thickness: 0.05, elevation: lv.elevation }, properties: { balusterSpacing: 0.12, postSpacing: 1.2 } };
    case "roof": {
      const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
      const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...zs) - Math.min(...zs);
      return { params: { polygon: pts, height: 0.2, thickness: 0.2, elevation: lv.above ?? lv.elevation + 3 }, properties: { roofType: "gable", slope: 30, slopeDirection: alongX ? 90 : 0 } };
    }
    case "ceiling":
      return { params: { polygon: pts, height: 0.02, thickness: 0.02, elevation: lv.elevation + 2.7 }, properties: {} };
  }
}

function nextName(kind: M2Kind): string {
  const n = ((authoring()?.getElements?.() ?? []) as Any[]).filter((e) => e.type === kind).length + 1;
  return `${LABEL[kind]} ${n}`;
}

/** Create one authored element as a single undo step. */
export function createM2Element(kind: M2Kind, pts: Vec2[], opts: { shape?: StairShape; lv?: Lv } = {}): Any | null {
  const a = authoring();
  if (!a?.getElements || !a.rebuildAuthored) { notify("warn", "Authoring not ready"); return null; }
  const lv = opts.lv ?? levelContext();
  const d = defaultsFor(kind, pts, lv, opts.shape ?? "straight");
  const el: Any = { id: uid(), type: kind, name: nextName(kind), params: d.params, properties: d.properties, levelId: lv.id ?? undefined };
  // validate by building once: a bad request is rejected instead of producing an invisible element
  void history.exec({
    label: `Place ${LABEL[kind]}`,
    apply: () => { const els: Any[] = a.getElements(); if (!els.includes(el)) els.push(el); a.rebuildAuthored(); },
    revert: () => { const els: Any[] = a.getElements(); const i = els.indexOf(el); if (i >= 0) els.splice(i, 1); a.rebuildAuthored(); },
  });
  try { a.setSelectedAuthored?.([el.id]); } catch { /* */ }
  return el;
}

/** One ceiling per room of the active level (skips rooms that already have one). */
export function ceilingsFromRooms(): number {
  const a = authoring();
  if (!a) return 0;
  const lv = levelContext();
  const els: Any[] = a.getElements();
  const inside = (pt: Vec2, poly: Vec2[]) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const made: Any[] = [];
  for (const r of roomsStore.listRooms()) {
    if (r.levelId !== lv.id || r.boundary.length < 3) continue;
    const poly: Vec2[] = r.boundary.map((p) => [p.x, p.z]);
    const lp = (r.properties?.labelPoint as Vec2 | undefined) ?? poly[0];
    if (els.some((e) => e.type === "ceiling" && e.params?.polygon && inside(lp, e.params.polygon))) continue;
    const d = defaultsFor("ceiling", poly, lv, "straight");
    d.params.elevation = lv.elevation + (r.height || 2.7);
    made.push({ id: uid(), type: "ceiling", name: `Ceiling ${r.number}`, params: d.params, properties: { ...d.properties, roomId: r.id }, levelId: lv.id ?? undefined });
  }
  if (!made.length) { notify("info", roomsStore.listRooms().length ? "Every room on this level already has a ceiling" : "Place rooms first (Room tool)"); return 0; }
  void history.exec({
    label: `Ceilings from ${made.length} room(s)`,
    apply: () => { for (const m of made) if (!els.includes(m)) els.push(m); a.rebuildAuthored(); },
    revert: () => { for (const m of made) { const i = els.indexOf(m); if (i >= 0) els.splice(i, 1); } a.rebuildAuthored(); },
  });
  notify("success", `Placed ${made.length} ceiling(s)`);
  return made.length;
}

/* ------------------------------------------------------------ interactive tool */

interface Session { kind: M2Kind; shape: StairShape; pts: Vec2[]; cursor: Vec2 | null }
let session: Session | null = null;
let detach: (() => void) | null = null;
let preview: THREE.LineSegments | null = null;

function dom(): HTMLElement | undefined { return (ctx as Any).world?.renderer?.three?.domElement; }

function toPlane(e: MouseEvent, y: number): Vec2 | null {
  const el = dom(); const cam: THREE.Camera | undefined = (ctx as Any).world?.camera?.three;
  if (!el || !cam) return null;
  const r = el.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), cam);
  const hit = new THREE.Vector3();
  return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), hit) ? [hit.x, hit.z] : null;
}

/** Pure snapping: existing end points / vertices within 0.25 m, else a 0.05 m grid; optional ortho from the previous point. */
export function snapPoint(raw: Vec2, anchors: Vec2[], prev: Vec2 | null, ortho: boolean): Vec2 {
  let best: Vec2 | null = null, bd = 0.25;
  for (const a of anchors) { const d = Math.hypot(a[0] - raw[0], a[1] - raw[1]); if (d < bd) { bd = d; best = a; } }
  let p: Vec2 = best ? [best[0], best[1]] : [Math.round(raw[0] / 0.05) * 0.05, Math.round(raw[1] / 0.05) * 0.05];
  if (ortho && prev && !best) {
    if (Math.abs(p[0] - prev[0]) >= Math.abs(p[1] - prev[1])) p = [p[0], prev[1]]; else p = [prev[0], p[1]];
  }
  return p;
}

function anchors(): Vec2[] {
  const out: Vec2[] = [];
  for (const e of (authoring()?.getElements?.() ?? []) as Any[]) {
    const p = e.params ?? {};
    if (p.start) out.push(p.start); if (p.end) out.push(p.end); if (p.point) out.push(p.point);
    if (Array.isArray(p.polygon)) for (const v of p.polygon) out.push(v);
  }
  for (const r of roomsStore.listRooms()) for (const b of r.boundary) out.push([b.x, b.z]);
  return out;
}

function drawPreview(): void {
  const scene: THREE.Scene | undefined = (ctx as Any).world?.scene?.three;
  if (!scene) return;
  if (preview) { scene.remove(preview); (preview.geometry as THREE.BufferGeometry).dispose(); (preview.material as THREE.Material).dispose(); preview = null; }
  if (!session || !session.pts.length) return;
  const lv = levelContext();
  const y = lv.elevation + 0.05;
  const pts = session.cursor ? [...session.pts, session.cursor] : session.pts.slice();
  const seg: number[] = [];
  const add = (a: Vec2, b: Vec2) => seg.push(a[0], y, a[1], b[0], y, b[1]);
  if (POLY[session.kind]) {
    for (let i = 0; i + 1 < pts.length; i++) add(pts[i], pts[i + 1]);
    if (session.kind !== "railing" && pts.length > 2) add(pts[pts.length - 1], pts[0]);
  } else if (pts.length === 2) {
    const [a, b] = pts;
    add(a, b);
    if (session.kind !== "curtain-wall") {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L > 1e-6) {
        const w = (session.kind === "ramp" ? 1.5 : 1.2) / 2, nx = ((b[1] - a[1]) / L) * w, nz = (-(b[0] - a[0]) / L) * w;
        const c: Vec2[] = [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]];
        for (let i = 0; i < 4; i++) add(c[i], c[(i + 1) % 4]);
      }
    }
  }
  if (!seg.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
  preview = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x22c55e, depthTest: false }));
  preview.renderOrder = 1000;
  scene.add(preview);
}

function finish(): void {
  if (!session) return;
  const s = session;
  const min = POLY[s.kind] ? (s.kind === "railing" ? 2 : 3) : 2;
  if (s.pts.length < min) { notify("info", `${LABEL[s.kind]}: need at least ${min} points`); return; }
  const el = createM2Element(s.kind, s.pts, { shape: s.shape });
  if (el) notify("success", `${el.name} placed on ${levelContext().id ? "the active level" : "level 0"}`, { timeout: 2000 });
  cancel();
}

export function cancelM2Tool(): void { cancel(); }
function cancel(): void { detach?.(); detach = null; session = null; drawPreview(); }

export function startM2Tool(kind: M2Kind, shape: StairShape = "straight"): void {
  const el = dom();
  if (!el) { notify("warn", "3D view not ready"); return; }
  cancel();
  try { authoring()?.setAuthoringTool?.("select"); } catch { /* */ }
  session = { kind, shape, pts: [], cursor: null };
  const ps = POLY[kind];
  let down: { x: number; y: number } | null = null;
  let lastMove = 0;
  let cachedAnchors: Vec2[] = anchors();

  const point = (e: MouseEvent): Vec2 | null => {
    const lv = levelContext();
    const raw = toPlane(e, lv.elevation);
    if (!raw || !session) return null;
    return snapPoint(raw, cachedAnchors, session.pts.length ? session.pts[session.pts.length - 1] : null, e.shiftKey);
  };
  const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || !session) return;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // camera drag
    e.stopImmediatePropagation(); e.preventDefault();
    const p = point(e);
    if (!p) return;
    const last = session.pts[session.pts.length - 1];
    if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 1e-6) return; // duplicate (double-click)
    session.pts.push(p);
    session.cursor = null;
    if (!ps && session.pts.length === 2) finish(); else drawPreview();
  };
  const onDbl = (e: MouseEvent) => { if (session && ps) { e.stopImmediatePropagation(); e.preventDefault(); finish(); } };
  const onMove = (e: PointerEvent) => {
    const now = performance.now();
    if (!session || now - lastMove < 40) return;
    lastMove = now;
    session.cursor = session.pts.length ? point(e) : null;
    drawPreview();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!session) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "Escape") { e.preventDefault(); cancel(); notify("info", `${LABEL[kind]} cancelled`, { timeout: 1200 }); }
    else if (e.key === "Enter" && ps) { e.preventDefault(); finish(); }
  };
  const onTool = () => { const t = authoring()?.getActiveTool?.(); if (session && t && t !== "select") cancel(); };
  const unTool = authoring()?.onAuthoringChange?.(onTool);

  el.addEventListener("pointerdown", onDown, true);
  el.addEventListener("click", onClick, true);
  el.addEventListener("dblclick", onDbl, true);
  el.addEventListener("pointermove", onMove);
  window.addEventListener("keydown", onKey, true);
  el.style.cursor = "crosshair";
  detach = () => {
    el.removeEventListener("pointerdown", onDown, true); el.removeEventListener("click", onClick, true);
    el.removeEventListener("dblclick", onDbl, true); el.removeEventListener("pointermove", onMove);
    window.removeEventListener("keydown", onKey, true); el.style.cursor = "";
    if (typeof unTool === "function") unTool();
  };
  const hint = ps ? "click points, double-click or Enter to finish, Esc to cancel" : "click start, then end (Shift = orthogonal, Esc = cancel)";
  notify("info", `${LABEL[kind]}${kind === "stairs" && shape !== "straight" ? ` (${shape})` : ""}: ${hint}`, { timeout: 3500 });
}

/* ----------------------------------------------------------------- redirects */

let wrapped = false;
/** Route the legacy tool names (ST / RA / CW / RF / CL, ramp) and the origin-dropping parity buttons to these tools. */
export function installM2Redirects(): void {
  const w = window as Any;
  w.__obsM2 = { start: startM2Tool, cancel: cancelM2Tool, create: createM2Element, ceilingsFromRooms };
  const a = authoring();
  if (!a || wrapped || typeof a.setAuthoringTool !== "function") return;
  wrapped = true;
  const orig = a.setAuthoringTool.bind(a);
  const map: Record<string, M2Kind> = { stairs: "stairs", railing: "railing", ramp: "ramp", "curtain-wall": "curtain-wall", roof: "roof", ceiling: "ceiling" };
  a.setAuthoringTool = (tool: unknown, ...rest: unknown[]) => {
    if (typeof tool === "string" && map[tool]) { startM2Tool(map[tool]); return; }
    cancel();
    return orig(tool, ...rest);
  };
}
