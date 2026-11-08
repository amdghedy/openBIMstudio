/**
 * Solid-model import core: STEP / IGES / BREP (occt-import-js) and Rhino .3dm (rhino3dm). Pure, no DOM, no THREE.
 * The WebAssembly readers return tessellated meshes; nothing here is parametric or editable CAD data.
 *
 * Axes: CAD files are Z-up. The app is X = east, Y = up, Z = north (same as src/modules/cad-link/core.ts), so a
 * CAD point (x, y, z) becomes (x, z, y). That swap mirrors the shape, so the triangle winding is flipped back to
 * keep faces pointing outwards.
 */
export const SOLID_EXTENSIONS = ["step", "stp", "iges", "igs", "brep", "brp", "3dm"] as const;
export type SolidKind = "step" | "iges" | "brep" | "3dm";

export function solidKind(fileName: string): SolidKind | null {
  const e = (fileName.split(".").pop() ?? "").toLowerCase();
  if (!fileName.includes(".")) return null;
  if (e === "step" || e === "stp") return "step";
  if (e === "iges" || e === "igs") return "iges";
  if (e === "brep" || e === "brp") return "brep";
  if (e === "3dm") return "3dm";
  return null;
}

/** First bytes of a 3dm file: "3D Geometry File Format" padded. */
export function has3dmHeader(b: Uint8Array): boolean {
  const sig = "3D Geometry File Format";
  if (b.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[i] !== sig.charCodeAt(i)) return false;
  return true;
}

/** Cheap content checks so a wrong extension gives a clear message instead of a parser crash. */
export function looksLikeStep(b: Uint8Array): boolean {
  return new TextDecoder().decode(b.subarray(0, 200)).includes("ISO-10303-21");
}
export function looksLikeIges(b: Uint8Array): boolean {
  // IGES is fixed-width 80-column records; the 73rd character of the first line is the section letter "S".
  const head = new TextDecoder().decode(b.subarray(0, 82));
  return head.length >= 73 && head[72] === "S";
}

export interface SolidPart {
  name: string;
  /** 0..1 RGB, or null when the file gave no colour. */
  color: [number, number, number] | null;
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint32Array;
}

/** Shape of the occt-import-js result that we rely on (verified against v0.0.23 by the "Vendor CAD readers" workflow). */
export interface OcctResult {
  success: boolean;
  meshes?: Array<{
    name?: string;
    color?: number[];
    attributes: { position: { array: ArrayLike<number> }; normal?: { array: ArrayLike<number> } };
    index: { array: ArrayLike<number> };
  }>;
}

/** Re-express positions/normals in app axes and flip winding. Mutates and returns the part. */
export function toAppAxes(part: SolidPart): SolidPart {
  const swap = (a: Float32Array) => { for (let i = 0; i + 2 < a.length; i += 3) { const y = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = y; } };
  swap(part.positions);
  if (part.normals) swap(part.normals);
  const ix = part.indices;
  for (let i = 0; i + 2 < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
  return part;
}

export function occtToParts(res: OcctResult, scale = 1): { parts: SolidPart[]; warnings: string[]; triangles: number } {
  const warnings: string[] = [];
  const parts: SolidPart[] = [];
  let triangles = 0, skipped = 0;
  for (const m of res.meshes ?? []) {
    const pos = m.attributes?.position?.array, idx = m.index?.array;
    if (!pos || !idx || pos.length < 9 || idx.length < 3) { skipped++; continue; }
    const positions = Float32Array.from(pos as ArrayLike<number>, (v) => v * scale);
    const nrm = m.attributes.normal?.array;
    const indices = Uint32Array.from(idx as ArrayLike<number>);
    const maxIdx = positions.length / 3;
    let bad = false;
    for (let i = 0; i < indices.length; i++) if (indices[i] >= maxIdx) { bad = true; break; }
    if (bad) { skipped++; continue; }
    const c = m.color && m.color.length >= 3 ? ([m.color[0], m.color[1], m.color[2]] as [number, number, number]) : null;
    parts.push(toAppAxes({ name: m.name || `Shape ${parts.length + 1}`, color: c, positions, normals: nrm && nrm.length === pos.length ? Float32Array.from(nrm as ArrayLike<number>) : null, indices }));
    triangles += Math.floor(indices.length / 3);
  }
  if (skipped) warnings.push(`${skipped} shape(s) had no usable triangles and were skipped.`);
  return { parts, warnings, triangles };
}

/** Rhino UnitSystem enum value → metres per unit. */
const RHINO_UNITS: Record<number, [string, number]> = {
  1: ["micrometres", 1e-6], 2: ["millimetres", 1e-3], 3: ["centimetres", 1e-2], 4: ["metres", 1],
  5: ["kilometres", 1e3], 8: ["inches", 0.0254], 9: ["feet", 0.3048], 10: ["miles", 1609.344],
};
export function rhinoUnitScale(unit: number | undefined | null): { scale: number; label: string; known: boolean } {
  const u = unit == null ? undefined : RHINO_UNITS[unit];
  return u ? { scale: u[1], label: u[0], known: true } : { scale: 1, label: "metres (assumed)", known: false };
}

/** Honest one-paragraph summary shown after opening a solid-model file. */
export function summarizeSolids(opts: { fileName: string; kind: SolidKind; parts: number; triangles: number; unitsNote: string; warnings: string[]; skippedTypes?: Record<string, number> }): string {
  const what = { step: "STEP", iges: "IGES", brep: "BREP", "3dm": "Rhino 3dm" }[opts.kind];
  const lines = [`Opened ${opts.fileName} (${what}): ${opts.parts} shape(s), ${opts.triangles.toLocaleString()} triangles. ${opts.unitsNote}`.trim()];
  lines.push("This is a tessellated view-only copy for coordination: no CAD features, no parametric edit, and it is not part of clash tests.");
  const sk = Object.entries(opts.skippedTypes ?? {}).filter(([, n]) => n > 0);
  if (sk.length) lines.push("Not drawn: " + sk.map(([t, n]) => `${n} ${t}`).join(", ") + ".");
  lines.push(...opts.warnings);
  return lines.join("\n");
}
