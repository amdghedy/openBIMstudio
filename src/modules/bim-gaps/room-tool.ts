/**
 * Room tool (BIM "Room" / "Place Rooms Automatically").
 *
 *  - Click inside an enclosed set of walls in the 3D view -> a room is created
 *    whose boundary follows the wall finish faces (see room-detect.ts).
 *  - "Place Rooms Automatically" creates a room in every enclosed loop on the
 *    active level.
 *  - Rooms get an outline and a tag (number, name, area) in the viewport.
 *  - The RM shortcut (which only set an authoring tool nobody handled) now
 *    activates the click tool.
 *  - Every existing "Create Room" button called roomsStore.createRoom() with a
 *    fixed 4x3 m rectangle at the origin. That exact sample call is now routed
 *    to "Place Rooms Automatically"; any other createRoom() call is untouched.
 */
import * as THREE from "three";
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { roomsStore, type Room } from "../rooms/rooms";
import { detectAllRooms, detectRoomAt, interiorPoint, type DetectedRoom, type RoomWall, type Vec2 } from "./room-detect";

type Any = Record<string, any>;
const authoring = (): Any | null => ((ctx.features as Any).authoring ?? (window as Any).__obsAuthoring ?? null);
const CUT_HEIGHT = 1.2; // plan cut plane above the level, like BIM's view range

/* ------------------------------------------------------------------ levels */

interface LevelCtx { id: string | null; elevation: number }
function activeLevel(): LevelCtx {
  const a = authoring();
  try {
    const id: string | null = a?.getActiveLevelId?.() ?? null;
    const lv = (a?.getLevels?.() ?? []).find((l: Any) => l.id === id);
    if (lv) return { id: lv.id, elevation: Number(lv.elevation) || 0 };
  } catch { /* */ }
  return { id: null, elevation: 0 };
}
function levelElevation(levelId: string | null): number {
  if (!levelId) return 0;
  try { return Number((authoring()?.getLevels?.() ?? []).find((l: Any) => l.id === levelId)?.elevation) || 0; } catch { return 0; }
}

/** Walls that the horizontal cut plane (level + 1.2 m) passes through. */
export function wallsAtCut(cutY: number): RoomWall[] {
  const els: Any[] = authoring()?.getElements?.() ?? [];
  const out: RoomWall[] = [];
  for (const e of els) {
    if (e.type !== "wall" || !e.params?.start || !e.params?.end) continue;
    const base = Number(e.params.elevation) || 0;
    const top = base + (Number(e.params.height) || 0);
    if (base <= cutY + 1e-6 && top >= cutY - 1e-6) {
      out.push({ id: e.id, start: [e.params.start[0], e.params.start[1]], end: [e.params.end[0], e.params.end[1]], thickness: Number(e.params.thickness) || 0 });
    }
  }
  return out;
}

/* ------------------------------------------------------------- room creation */

const toXZ = (pts: Vec2[]) => pts.map(([x, z]) => ({ x, z }));
let rawCreate: ((input: Any) => Room) | null = null;

function insertRoom(d: DetectedRoom, level: LevelCtx): Room {
  const create = rawCreate ?? ((i: Any) => roomsStore.createRoom(i as any));
  const room = create({ boundary: toXZ(d.boundary), levelId: level.id });
  const patch: Partial<Room> = { area: d.area, perimeter: d.perimeter, properties: { ...room.properties, holes: d.holes.map(toXZ), wallIds: d.wallIds, labelPoint: d.labelPoint, boundaryExact: d.exact } };
  return roomsStore.updateRoom(room.id, patch) ?? room;
}

export function placeRoomAt(x: number, z: number, level: LevelCtx = activeLevel()): Room | null {
  const walls = wallsAtCut(level.elevation + CUT_HEIGHT);
  if (!walls.length) { notify("warn", "No walls cross this level's cut plane - draw walls first"); return null; }
  const d = detectRoomAt([x, z], walls);
  if (!d) { notify("warn", "That point is not inside a closed wall loop"); return null; }
  const dup = roomsStore.listRooms().find((r) => r.levelId === level.id && pointIn(d.labelPoint, r.boundary.map((p) => [p.x, p.z] as Vec2)));
  if (dup) { notify("info", `Room ${dup.number} already occupies this space`); return dup; }
  const room = insertRoom(d, level);
  notify("success", `Room ${room.number} - ${room.area.toFixed(1)} m2`, { timeout: 2200 });
  return room;
}

export function placeRoomsAutomatically(level: LevelCtx = activeLevel()): Room[] {
  const walls = wallsAtCut(level.elevation + CUT_HEIGHT);
  if (!walls.length) { notify("warn", "No walls on this level - draw closed walls first, or use the Room tool"); return []; }
  const found = detectAllRooms(walls);
  const created: Room[] = [];
  for (const d of found) {
    const dup = roomsStore.listRooms().find((r) => r.levelId === level.id && pointIn(d.labelPoint, r.boundary.map((p) => [p.x, p.z] as Vec2)));
    if (!dup) created.push(insertRoom(d, level));
  }
  notify(created.length ? "success" : "info", created.length ? `Placed ${created.length} room(s)` : found.length ? "All enclosed spaces already have rooms" : "No enclosed wall loops found");
  return created;
}

function pointIn(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* ------------------------------------------------------------ overlay (tags) */

let overlay: THREE.Group | null = null;
const disposeObj = (o: THREE.Object3D) => {
  o.traverse((n: any) => {
    n.geometry?.dispose?.();
    const m = n.material;
    if (m) { m.map?.dispose?.(); m.dispose?.(); }
  });
};

function tagTexture(lines: string[]): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 384; c.height = 192;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(255,255,255,0.88)";
  g.strokeStyle = "#2563eb"; g.lineWidth = 4;
  g.beginPath(); g.roundRect(6, 6, c.width - 12, c.height - 12, 18); g.fill(); g.stroke();
  g.fillStyle = "#111827"; g.textAlign = "center";
  g.font = "bold 46px system-ui, sans-serif"; g.fillText(lines[0], c.width / 2, 70);
  g.font = "40px system-ui, sans-serif"; g.fillText(lines[1], c.width / 2, 118);
  g.font = "34px system-ui, sans-serif"; g.fillStyle = "#374151"; g.fillText(lines[2], c.width / 2, 162);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

export function refreshRoomOverlay(): void {
  const scene: THREE.Scene | undefined = (ctx as Any).world?.scene?.three;
  if (!scene) return;
  if (!overlay) { overlay = new THREE.Group(); overlay.name = "obs-room-overlay"; scene.add(overlay); }
  while (overlay.children.length) { const ch = overlay.children[0]; overlay.remove(ch); disposeObj(ch); }
  for (const r of roomsStore.listRooms()) {
    const y = levelElevation(r.levelId) + 0.03;
    const ring = (pts: Array<{ x: number; z: number }>, color: number) => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, y, p.z)));
      const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
      line.renderOrder = 998;
      overlay!.add(line);
    };
    ring(r.boundary, 0x2563eb);
    const holes = (r.properties?.holes as Array<Array<{ x: number; z: number }>> | undefined) ?? [];
    holes.forEach((h) => ring(h, 0x2563eb));
    const outer = r.boundary.map((p) => [p.x, p.z] as Vec2);
    const lp = (r.properties?.labelPoint as Vec2 | undefined) ?? interiorPoint(outer, holes.map((h) => h.map((p) => [p.x, p.z] as Vec2)));
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tagTexture([r.number, r.name, `${r.area.toFixed(1)} m\u00B2`]), depthTest: false, transparent: true }));
    sprite.position.set(lp[0], y + 0.1, lp[1]);
    sprite.scale.set(1.5, 0.75, 1);
    sprite.renderOrder = 999;
    overlay.add(sprite);
  }
}

/* ------------------------------------------------------------------- tool */

let attached: (() => void) | null = null;
let previewLine: THREE.LineLoop | null = null;

function pointerToPlane(e: MouseEvent, y: number): Vec2 | null {
  const dom: HTMLElement | undefined = (ctx as Any).world?.renderer?.three?.domElement;
  const cam: THREE.Camera | undefined = (ctx as Any).world?.camera?.three;
  if (!dom || !cam) return null;
  const r = dom.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, cam);
  const hit = new THREE.Vector3();
  return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), hit) ? [hit.x, hit.z] : null;
}

function showPreview(d: DetectedRoom | null, y: number): void {
  const scene: THREE.Scene | undefined = (ctx as Any).world?.scene?.three;
  if (!scene) return;
  if (previewLine) { scene.remove(previewLine); disposeObj(previewLine); previewLine = null; }
  if (!d) return;
  const geo = new THREE.BufferGeometry().setFromPoints(d.boundary.map(([x, z]) => new THREE.Vector3(x, y + 0.04, z)));
  previewLine = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: 0x22c55e, depthTest: false }));
  previewLine.renderOrder = 1000;
  scene.add(previewLine);
}

function attachTool(): void {
  if (attached) return;
  const dom: HTMLElement | undefined = (ctx as Any).world?.renderer?.three?.domElement;
  if (!dom) return;
  let down: { x: number; y: number } | null = null;
  let lastMove = 0;
  const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0) return;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // orbit drag
    const lv = activeLevel();
    const p = pointerToPlane(e, lv.elevation + CUT_HEIGHT);
    if (!p) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    placeRoomAt(p[0], p[1], lv);
  };
  const onMove = (e: PointerEvent) => {
    const now = performance.now();
    if (now - lastMove < 80) return;
    lastMove = now;
    const lv = activeLevel();
    const walls = wallsAtCut(lv.elevation + CUT_HEIGHT);
    if (!walls.length || walls.length > 300) { showPreview(null, 0); return; }
    const p = pointerToPlane(e, lv.elevation + CUT_HEIGHT);
    showPreview(p ? detectRoomAt(p, walls) : null, lv.elevation);
  };
  dom.addEventListener("pointerdown", onDown, true);
  dom.addEventListener("click", onClick, true);
  dom.addEventListener("pointermove", onMove);
  dom.style.cursor = "crosshair";
  attached = () => {
    dom.removeEventListener("pointerdown", onDown, true);
    dom.removeEventListener("click", onClick, true);
    dom.removeEventListener("pointermove", onMove);
    dom.style.cursor = "";
    showPreview(null, 0);
  };
  notify("info", "Room: click inside walls to place a room (Esc to finish)", { timeout: 2500 });
}

function detachTool(): void { attached?.(); attached = null; }

export function startRoomTool(): void {
  const a = authoring();
  if (!a?.setAuthoringTool) { notify("warn", "Authoring not ready"); return; }
  a.setAuthoringTool("room");
}

function syncTool(): void {
  const t = authoring()?.getActiveTool?.();
  if (t === "room") attachTool(); else detachTool();
}

/* ------------------------------------------------------------------- setup */

const SAMPLE = [[0, 0], [4, 0], [4, 3], [0, 3]];
function isSampleBoundary(b: Array<{ x: number; z: number }> | undefined): boolean {
  return !!b && b.length === 4 && b.every((p, i) => Math.abs(p.x - SAMPLE[i][0]) < 1e-9 && Math.abs(p.z - SAMPLE[i][1]) < 1e-9);
}

let installed = false;
export function setupRoomTool(): { ok: boolean; detail: string } {
  if (installed) return { ok: true, detail: "already installed" };
  installed = true;

  // 1. route the legacy sample-rectangle call to automatic placement
  const store = roomsStore as unknown as Any;
  rawCreate = store.createRoom.bind(store);
  store.createRoom = (input: Any): Room => {
    if (isSampleBoundary(input?.boundary)) {
      const made = placeRoomsAutomatically();
      // legacy callers read .number / .area from the return value
      return (made[0] ?? { id: "", number: "-", name: "none", area: 0, levelId: null, boundary: [], perimeter: 0, height: 0, upperLimitId: null, properties: {} }) as Room;
    }
    return rawCreate!(input);
  };

  // 2. tags / outlines follow the store
  roomsStore.onChange(refreshRoomOverlay);
  refreshRoomOverlay();

  // 3. RM / startRoomTool activate the click tool
  const a = authoring();
  if (a?.onAuthoringChange) a.onAuthoringChange(syncTool);
  else setTimeout(() => authoring()?.onAuthoringChange?.(syncTool), 2000);
  return { ok: true, detail: "room tool, auto placement, tags" };
}
