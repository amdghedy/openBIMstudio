/**
 * Plan tags: labels, anchors, automatic placement ("Tag All") and hit boxes.
 * Pure module - no DOM. World coords: x east, z north.
 */
export type TagMode = "category" | "room" | "material" | "size" | "elevation" | "custom";

export interface TagLike {
  x: number; z: number; text: string;
  elementId?: string; leader?: boolean; mode?: TagMode;
}

const NAME: Record<string, string> = {
  wall: "Wall", column: "Column", beam: "Beam", slab: "Slab", door: "Door", window: "Window", duct: "Duct",
  pipe: "Pipe", "cable-tray": "Cable Tray", conduit: "Conduit", equipment: "Equipment", fitting: "Fitting",
  room: "Room", roof: "Roof", ceiling: "Ceiling", stairs: "Stairs", railing: "Railing", footing: "Footing",
};

const mm = (m: number) => `${Math.round(m * 1000)}`;

/** Text a tag shows for an element in a given mode. */
export function tagLabel(el: any, mode: TagMode = "category"): string {
  const pr = el?.properties ?? {}, pa = el?.params ?? {};
  const mark = pr.Mark ?? pr.mark;
  switch (mode) {
    case "material": return String(pr.Material ?? pr.material ?? "Material");
    case "room": return `Room ${el?.name ?? el?.id}`;
    case "elevation": return `${Number(pa.elevation ?? 0) >= 0 ? "+" : ""}${Number(pa.elevation ?? 0).toFixed(2)}`;
    case "size": {
      const w = Number(pa.width ?? pa.thickness), h = Number(pa.height);
      const base = NAME[el?.type] ?? el?.type ?? "Element";
      if (el?.type === "wall") return `${base} ${mm(Number(pa.thickness ?? 0.2))}`;
      if (Number.isFinite(w) && Number.isFinite(h) && (el?.type === "duct" || el?.type === "cable-tray")) return `${base} ${mm(w)}x${mm(h)}`;
      if (el?.type === "pipe" || el?.type === "conduit") return `${base} Ø${mm(w)}`;
      if (Number.isFinite(w) && Number.isFinite(Number(pa.depth))) return `${base} ${mm(w)}x${mm(Number(pa.depth))}`;
      return `${base}${Number.isFinite(w) ? " " + mm(w) : ""}`;
    }
    default: return String(mark ?? el?.name ?? NAME[el?.type] ?? el?.type ?? "");
  }
}

/** Centre-ish point of an element in plan. */
export function elementAnchor(el: any): { x: number; z: number } | null {
  const p = el?.params ?? {};
  if (p.point) return { x: Number(p.point[0]), z: Number(p.point[1]) };
  if (p.start && p.end) return { x: (p.start[0] + p.end[0]) / 2, z: (p.start[1] + p.end[1]) / 2 };
  if (Array.isArray(p.polygon) && p.polygon.length) {
    let x = 0, z = 0;
    for (const v of p.polygon) { x += v[0]; z += v[1]; }
    return { x: x / p.polygon.length, z: z / p.polygon.length };
  }
  return null;
}

export interface TagAllOptions {
  mode?: TagMode;
  categories?: string[];
  /** Restrict to these element ids (e.g. the current selection). */
  only?: string[];
  /** Tag offset from the element, in metres. */
  offset?: number;
  /** Leader line from tag to element. */
  leader?: boolean;
}

const SKIP = new Set(["grid", "level", "fitting"]);

/** Tags for every taggable element that is not already tagged in this mode. */
export function buildTagAll(elements: readonly any[], existing: readonly TagLike[], o: TagAllOptions = {}): TagLike[] {
  const mode = o.mode ?? "category";
  const cats = o.categories?.length ? new Set(o.categories) : null;
  const only = o.only?.length ? new Set(o.only) : null;
  const offset = o.offset ?? 0.55;
  const done = new Set(existing.filter((t) => t.elementId && (t.mode ?? "category") === mode).map((t) => t.elementId!));
  const taken: { x: number; z: number }[] = existing.map((t) => ({ x: t.x, z: t.z }));
  const out: TagLike[] = [];
  for (const el of elements) {
    if (!el?.id || SKIP.has(el.type)) continue;
    if (cats && !cats.has(el.type)) continue;
    if (only && !only.has(String(el.id))) continue;
    if (done.has(String(el.id))) continue;
    const a = elementAnchor(el);
    if (!a) continue;
    const p = el.params ?? {};
    let x = a.x, z = a.z;
    if (p.start && p.end) {
      // beside the run, on its left, clear of the wall / duct body
      const dx = p.end[0] - p.start[0], dz = p.end[1] - p.start[1], L = Math.hypot(dx, dz) || 1;
      const half = Number(p.thickness ?? p.width ?? 0.2) / 2;
      x = a.x - (dz / L) * (half + offset); z = a.z + (dx / L) * (half + offset);
    } else if (p.point) {
      const half = Math.max(Number(p.width ?? p.thickness ?? 0.3), Number(p.depth ?? 0)) / 2;
      z = a.z + half + offset;
    }
    // nudge up while another tag is within 0.45 m
    let guard = 0;
    while (taken.some((q) => Math.hypot(q.x - x, q.z - z) < 0.45) && guard++ < 8) z += 0.45;
    taken.push({ x, z });
    out.push({ x, z, text: tagLabel(el, mode), elementId: String(el.id), leader: o.leader ?? true, mode });
  }
  return out;
}

/** Approximate bounding box of a tag / note text (anchor = baseline-left). */
export function textBox(x: number, z: number, text: string, heightWorld: number): { minX: number; minZ: number; maxX: number; maxZ: number } {
  const lines = String(text).split("\n");
  const w = Math.max(...lines.map((l) => l.length), 1) * heightWorld * 0.58;
  const h = heightWorld * 1.2 * lines.length;
  return { minX: x, maxX: x + w, minZ: z - h * 0.2, maxZ: z + h * 0.8 };
}

export function pointInBox(px: number, pz: number, b: { minX: number; minZ: number; maxX: number; maxZ: number }, pad = 0): boolean {
  return px >= b.minX - pad && px <= b.maxX + pad && pz >= b.minZ - pad && pz <= b.maxZ + pad;
}

/** Nearest point on a box edge to an anchor - where a leader line should end. */
export function leaderEnd(box: { minX: number; minZ: number; maxX: number; maxZ: number }, from: { x: number; z: number }): { x: number; z: number } {
  return { x: Math.max(box.minX, Math.min(box.maxX, from.x)), z: Math.max(box.minZ, Math.min(box.maxZ, from.z)) };
}
