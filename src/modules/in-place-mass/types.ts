/** In-place mass / freeform — conceptual massing tool. */
export interface MassElement {
  id: string;
  name: string;
  /** Base polygon [x, z] in world metres. */
  basePolygon: Array<[number, number]>;
  /** Height (m). */
  height: number;
  /** Floors (array of floor heights for mass floor extraction). */
  floorHeights?: number[];
  /** Color. */
  color: string;
  /** Whether it's a solid (extrude) or void (subtract). */
  isVoid: boolean;
}

const masses: MassElement[] = [];
let idCounter = 0;

export function createMass(
  basePolygon: Array<[number, number]>,
  height: number,
  name?: string,
  isVoid: boolean = false,
  floorHeights?: number[],
): MassElement {
  const m: MassElement = {
    id: `mass-${++idCounter}`,
    name: name ?? `Mass ${idCounter}`,
    basePolygon,
    height,
    floorHeights,
    color: isVoid ? "#ef4444" : "#a855f7",
    isVoid,
  };
  masses.push(m);
  return m;
}

export function listMasses(): MassElement[] { return masses; }
export function removeMass(id: string): void {
  const i = masses.findIndex(m => m.id === id);
  if (i >= 0) masses.splice(i, 1);
}
export function getMassFloors(id: string): Array<{ name: string; area: number; elevation: number }> {
  const m = masses.find(m => m.id === id);
  if (!m || !m.floorHeights) return [];
  const polyArea = computePolygonArea(m.basePolygon);
  return m.floorHeights.map((h, i) => ({ name: `Floor ${i + 1}`, area: polyArea, elevation: h }));
}

function computePolygonArea(poly: Array<[number, number]>): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

let installed = false;
export function setupInPlaceMass() {
  if (installed) return; installed = true;
  (window as any).__obsMass = { create: createMass, list: listMasses, remove: removeMass, getFloors: getMassFloors };
  console.log("[in-place-mass] ready. Create conceptual masses via __obsMass.create(polygon, height).");
}
