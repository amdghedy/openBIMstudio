/**
 * Drafting Wipeout / Masking Region Engine.
 *
 * Provides opaque masking polygons that obscure model linework behind
 * annotations, tags, or drafting notes.
 */

export interface WipeoutRegion {
  id: string;
  viewId: string;
  points: [number, number][]; // Polygon in view coordinates (meters or mm)
  fillColor?: string; // default "#ffffff"
}

const wipeouts: WipeoutRegion[] = [];

export function addWipeoutRegion(viewId: string, points: [number, number][]): WipeoutRegion {
  const w: WipeoutRegion = {
    id: `wipeout-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    viewId,
    points,
    fillColor: "#ffffff",
  };
  wipeouts.push(w);
  return w;
}

export function listWipeoutsForView(viewId: string): WipeoutRegion[] {
  return wipeouts.filter((w) => w.viewId === viewId);
}

export function removeWipeoutRegion(id: string): void {
  const idx = wipeouts.findIndex((w) => w.id === id);
  if (idx !== -1) wipeouts.splice(idx, 1);
}

export function renderWipeoutsSvg(regions: WipeoutRegion[]): string {
  return regions
    .map((r) => {
      if (!r.points || r.points.length < 3) return "";
      const pts = r.points.map((p) => `${p[0]},${p[1]}`).join(" ");
      return `<polygon points="${pts}" fill="${r.fillColor || "#ffffff"}" stroke="none" />`;
    })
    .join("\n");
}
