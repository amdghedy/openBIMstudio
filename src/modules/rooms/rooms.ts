/**
 * Rooms & Areas - Revit-competitive spatial elements.
 *
 * Rooms are 2.5D volumes bounded by walls (or an explicit polygon) on a level.
 * Areas are 2D regions used for gross/rentable area plans.
 * Both participate in schedules via reporting properties.
 */

import { ctx } from "../../core/context";

export type RoomId = string;
export type AreaId = string;

export interface Room {
  id: RoomId;
  name: string;
  number: string;
  levelId: string | null;
  /** Boundary polygon in world XZ (metres). */
  boundary: Array<{ x: number; z: number }>;
  /** Computed / override area m-. */
  area: number;
  /** Computed / override perimeter m. */
  perimeter: number;
  /** Floor-to-ceiling height m. */
  height: number;
  /** Optional upper limit level. */
  upperLimitId: string | null;
  department?: string;
  occupancy?: string;
  finishes?: { floor?: string; wall?: string; ceiling?: string };
  phaseId?: string | null;
  designOptionId?: string | null;
  properties: Record<string, unknown>;
}

export interface Area {
  id: AreaId;
  name: string;
  number: string;
  levelId: string | null;
  boundary: Array<{ x: number; z: number }>;
  area: number;
  perimeter: number;
  areaType: "gross" | "rentable" | "net" | "custom";
  phaseId?: string | null;
  properties: Record<string, unknown>;
}

type Listener = () => void;

const STORAGE_ROOMS = "obs.rooms.v1";
const STORAGE_AREAS = "obs.areas.v1";

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function polygonArea(pts: Array<{ x: number; z: number }>): number {
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return Math.abs(sum) / 2;
}

function polygonPerimeter(pts: Array<{ x: number; z: number }>): number {
  if (pts.length < 2) return 0;
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    len += Math.hypot(dx, dz);
  }
  return len;
}

class RoomsStore {
  private rooms = new Map<RoomId, Room>();
  private areas = new Map<AreaId, Area>();
  private listeners = new Set<Listener>();
  private booted = false;

  boot(): void {
    if (this.booted) return;
    this.booted = true;
    try {
      const r = localStorage.getItem(STORAGE_ROOMS);
      if (r) {
        for (const room of JSON.parse(r) as Room[]) this.rooms.set(room.id, room);
      }
      const a = localStorage.getItem(STORAGE_AREAS);
      if (a) {
        for (const area of JSON.parse(a) as Area[]) this.areas.set(area.id, area);
      }
    } catch { /* */ }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_ROOMS, JSON.stringify([...this.rooms.values()]));
      localStorage.setItem(STORAGE_AREAS, JSON.stringify([...this.areas.values()]));
    } catch { /* */ }
    for (const cb of this.listeners) {
      try { cb(); } catch { /* */ }
    }
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // -- Rooms ----------------------------------------------------------

  listRooms(): Room[] {
    return [...this.rooms.values()];
  }

  getRoom(id: RoomId): Room | null {
    return this.rooms.get(id) ?? null;
  }

  createRoom(input: {
    name?: string;
    number?: string;
    levelId?: string | null;
    boundary: Array<{ x: number; z: number }>;
    height?: number;
    department?: string;
  }): Room {
    const boundary = input.boundary.slice();
    const room: Room = {
      id: uid("room"),
      name: input.name ?? "Room",
      number: input.number ?? String(this.rooms.size + 1).padStart(3, "0"),
      levelId: input.levelId ?? null,
      boundary,
      area: polygonArea(boundary),
      perimeter: polygonPerimeter(boundary),
      height: input.height ?? 2.7,
      upperLimitId: null,
      department: input.department,
      properties: {},
    };
    this.rooms.set(room.id, room);
    this.persist();
    return room;
  }

  updateRoom(id: RoomId, patch: Partial<Room>): Room | null {
    const r = this.rooms.get(id);
    if (!r) return null;
    Object.assign(r, patch);
    if (patch.boundary) {
      r.area = polygonArea(r.boundary);
      r.perimeter = polygonPerimeter(r.boundary);
    }
    this.persist();
    return r;
  }

  removeRoom(id: RoomId): boolean {
    const ok = this.rooms.delete(id);
    if (ok) this.persist();
    return ok;
  }

  /** Recompute area/perimeter for all rooms (e.g. after wall moves). */
  recomputeAll(): number {
    let n = 0;
    for (const r of this.rooms.values()) {
      const a = polygonArea(r.boundary);
      const p = polygonPerimeter(r.boundary);
      if (Math.abs(a - r.area) > 1e-6 || Math.abs(p - r.perimeter) > 1e-6) {
        r.area = a;
        r.perimeter = p;
        n++;
      }
    }
    if (n) this.persist();
    return n;
  }

  // -- Areas ----------------------------------------------------------

  listAreas(): Area[] {
    return [...this.areas.values()];
  }

  getArea(id: AreaId): Area | null {
    return this.areas.get(id) ?? null;
  }

  createArea(input: {
    name?: string;
    number?: string;
    levelId?: string | null;
    boundary: Array<{ x: number; z: number }>;
    areaType?: Area["areaType"];
  }): Area {
    const boundary = input.boundary.slice();
    const area: Area = {
      id: uid("area"),
      name: input.name ?? "Area",
      number: input.number ?? String(this.areas.size + 1).padStart(3, "0"),
      levelId: input.levelId ?? null,
      boundary,
      area: polygonArea(boundary),
      perimeter: polygonPerimeter(boundary),
      areaType: input.areaType ?? "gross",
      properties: {},
    };
    this.areas.set(area.id, area);
    this.persist();
    return area;
  }

  updateArea(id: AreaId, patch: Partial<Area>): Area | null {
    const a = this.areas.get(id);
    if (!a) return null;
    Object.assign(a, patch);
    if (patch.boundary) {
      a.area = polygonArea(a.boundary);
      a.perimeter = polygonPerimeter(a.boundary);
    }
    this.persist();
    return a;
  }

  removeArea(id: AreaId): boolean {
    const ok = this.areas.delete(id);
    if (ok) this.persist();
    return ok;
  }

  /** Schedule-ready rows for rooms. */
  roomScheduleRows(): Array<Record<string, unknown>> {
    return this.listRooms().map((r) => ({
      Id: r.id,
      Number: r.number,
      Name: r.name,
      Level: r.levelId,
      Area: Math.round(r.area * 100) / 100,
      Perimeter: Math.round(r.perimeter * 100) / 100,
      Height: r.height,
      Volume: Math.round(r.area * r.height * 100) / 100,
      Department: r.department ?? "",
      Occupancy: r.occupancy ?? "",
    }));
  }

  areaScheduleRows(): Array<Record<string, unknown>> {
    return this.listAreas().map((a) => ({
      Id: a.id,
      Number: a.number,
      Name: a.name,
      Level: a.levelId,
      Area: Math.round(a.area * 100) / 100,
      Perimeter: Math.round(a.perimeter * 100) / 100,
      Type: a.areaType,
    }));
  }

  reset(): void {
    this.rooms.clear();
    this.areas.clear();
    this.persist();
  }
}

export const roomsStore = new RoomsStore();

export function setupRooms(): typeof roomsStore {
  roomsStore.boot();
  (ctx.features as any).rooms = roomsStore;
  (window as any).__obsRooms = roomsStore;
  console.log("[rooms] ready -", roomsStore.listRooms().length, "rooms,", roomsStore.listAreas().length, "areas");
  return roomsStore;
}
