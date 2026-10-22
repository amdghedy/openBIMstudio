/** Pure drawing helpers for plan-view placement (Revit-style constraints and typed entry). */
export interface P2 { x: number; z: number }

/** Shift constraint: lock the segment to the dominant axis (horizontal or vertical). */
export function constrainOrtho(start: P2, pt: P2): P2 {
  const dx = pt.x - start.x, dz = pt.z - start.z;
  return Math.abs(dx) >= Math.abs(dz) ? { x: pt.x, z: start.z } : { x: start.x, z: pt.z };
}

/** Point `len` metres from `start` in the direction of `towards` (defaults to +X when degenerate). */
export function pointAtLength(start: P2, towards: P2, len: number): P2 {
  const dx = towards.x - start.x, dz = towards.z - start.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-9) return { x: start.x + len, z: start.z };
  return { x: start.x + (dx / l) * len, z: start.z + (dz / l) * len };
}

/** Counter-clockwise angle from east in degrees (north up), 0..360. */
export function angleDeg(start: P2, pt: P2): number {
  const a = (Math.atan2(pt.z - start.z, pt.x - start.x) * 180) / Math.PI;
  return (a + 360) % 360;
}

/**
 * Parse typed length input into metres. Plain numbers are metres; suffixes mm / cm / m are honoured.
 * Accepts a decimal comma. Returns null for empty, non-numeric or non-positive input.
 */
export function parseLength(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(",", ".").replace(/\s+/g, "");
  const m = /^(\d+(?:\.\d+)?|\.\d+)(mm|cm|m)?$/.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const f = m[2] === "mm" ? 0.001 : m[2] === "cm" ? 0.01 : 1;
  const r = v * f;
  return r > 0 ? r : null;
}

/** True for keys that can be part of a typed length ("12.5", "3500mm"). */
export function isLengthChar(key: string): boolean {
  return /^[0-9.,mc]$/i.test(key);
}
