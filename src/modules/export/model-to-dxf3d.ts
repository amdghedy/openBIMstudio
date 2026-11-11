/**
 * Model → 3D DXF. Writes triangle meshes as 3DFACE entities on per-category layers.
 *
 * Format: DXF R12 (AC1009): no handles or subclass markers, which every CAD package accepts, with a LTYPE and LAYER table.
 * Axes: the app is X east, Y up, Z north; CAD is Z up, so (x, y, z) → (X = x, Y = z, Z = y).
 * Units: metres (×1) or millimetres (×1000); the INSUNITS header is set to match.
 */

export interface MeshInput {
  layer: string;
  /** xyz triples, local to the mesh. */
  positions: ArrayLike<number>;
  /** Triangle indices; when absent every three vertices form a triangle. */
  index?: ArrayLike<number> | null;
  /** Column-major 4x4 local → world matrix (three.js `matrixWorld.elements`). */
  matrix?: ArrayLike<number> | null;
}

export interface Dxf3dOptions { units?: "m" | "mm"; layerPrefix?: string }
export interface Dxf3dResult { dxf: string; faces: number; byLayer: Record<string, number>; skippedDegenerate: number; bounds: { min: [number, number, number]; max: [number, number, number] } | null }

const LAYER_FOR_TYPE: Record<string, string> = {
  wall: "A-WALL", slab: "A-FLOR", floor: "A-FLOR", roof: "A-ROOF", door: "A-DOOR", window: "A-GLAZ", stair: "A-STRS", ceiling: "A-CLNG",
  column: "S-COLS", beam: "S-BEAM", footing: "S-FNDN", foundation: "S-FNDN", duct: "M-DUCT", pipe: "P-PIPE", cabletray: "E-CABLE-TRAY", conduit: "E-CONDUIT",
};
export function layerForElementType(type: string | undefined): string {
  const t = (type ?? "").toLowerCase();
  if (LAYER_FOR_TYPE[t]) return LAYER_FOR_TYPE[t];
  const clean = t.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toUpperCase().slice(0, 24);
  return clean ? "A-" + clean : "A-MODEL";
}

const fmt = (v: number) => (Math.abs(v) < 1e-9 ? "0" : String(Math.round(v * 1e5) / 1e5));
const layerName = (s: string) => s.replace(/[<>/\\":;?*|=`,\r\n]/g, "_").slice(0, 60) || "0";

export function meshesToDxf3d(meshes: MeshInput[], opts: Dxf3dOptions = {}): Dxf3dResult {
  const k = (opts.units ?? "mm") === "mm" ? 1000 : 1;
  const prefix = opts.layerPrefix ?? "";
  const out: string[] = [];
  const byLayer: Record<string, number> = {};
  let faces = 0, degenerate = 0;
  let min: [number, number, number] | null = null, max: [number, number, number] | null = null;
  const w = (code: number, v: string | number) => out.push(String(code), String(v));

  const faceRecords: string[] = [];
  for (const m of meshes) {
    const layer = layerName(prefix + m.layer);
    const P = m.positions, I = m.index;
    const mat = m.matrix && m.matrix.length >= 16 ? m.matrix : null;
    const nVerts = Math.floor(P.length / 3);
    const nTris = I ? Math.floor(I.length / 3) : Math.floor(nVerts / 3);
    // transform each vertex once
    const T = new Float64Array(nVerts * 3);
    for (let i = 0; i < nVerts; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      let X = x, Y = y, Z = z;
      if (mat) {
        X = mat[0] * x + mat[4] * y + mat[8] * z + mat[12];
        Y = mat[1] * x + mat[5] * y + mat[9] * z + mat[13];
        Z = mat[2] * x + mat[6] * y + mat[10] * z + mat[14];
      }
      // app (x east, y up, z north) → CAD (X, Y = north, Z = up)
      T[i * 3] = X * k; T[i * 3 + 1] = Z * k; T[i * 3 + 2] = Y * k;
    }
    for (let t = 0; t < nTris; t++) {
      const a = I ? I[t * 3] : t * 3, b = I ? I[t * 3 + 1] : t * 3 + 1, c = I ? I[t * 3 + 2] : t * 3 + 2;
      if (!(a >= 0 && b >= 0 && c >= 0 && a < nVerts && b < nVerts && c < nVerts)) { degenerate++; continue; }
      const A = [T[a * 3], T[a * 3 + 1], T[a * 3 + 2]], B = [T[b * 3], T[b * 3 + 1], T[b * 3 + 2]], C = [T[c * 3], T[c * 3 + 1], T[c * 3 + 2]];
      if (![...A, ...B, ...C].every(Number.isFinite)) { degenerate++; continue; }
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * cx + cy * cy + cz * cz < 1e-12 * k * k) { degenerate++; continue; }
      const r = ["0", "3DFACE", "8", layer];
      [A, B, C, C].forEach((p, i) => { r.push(String(10 + i), fmt(p[0]), String(20 + i), fmt(p[1]), String(30 + i), fmt(p[2])); });
      faceRecords.push(r.join("\n"));
      faces++; byLayer[layer] = (byLayer[layer] ?? 0) + 1;
      for (const p of [A, B, C]) {
        if (!min || !max) { min = [p[0], p[1], p[2]]; max = [p[0], p[1], p[2]]; continue; }
        for (let d = 0; d < 3; d++) { if (p[d] < min[d]) min[d] = p[d]; if (p[d] > max[d]) max[d] = p[d]; }
      }
    }
  }

  // HEADER
  w(0, "SECTION"); w(2, "HEADER");
  w(9, "$ACADVER"); w(1, "AC1009");
  w(9, "$INSUNITS"); w(70, (opts.units ?? "mm") === "mm" ? 4 : 6);
  if (min && max) { w(9, "$EXTMIN"); w(10, fmt(min[0])); w(20, fmt(min[1])); w(30, fmt(min[2])); w(9, "$EXTMAX"); w(10, fmt(max[0])); w(20, fmt(max[1])); w(30, fmt(max[2])); }
  w(0, "ENDSEC");
  // TABLES
  w(0, "SECTION"); w(2, "TABLES");
  w(0, "TABLE"); w(2, "LTYPE"); w(70, 1);
  w(0, "LTYPE"); w(2, "CONTINUOUS"); w(70, 0); w(3, "Solid line"); w(72, 65); w(73, 0); w(40, 0);
  w(0, "ENDTAB");
  const layers = Object.keys(byLayer).sort();
  w(0, "TABLE"); w(2, "LAYER"); w(70, layers.length + 1);
  const row = (name: string, color: number) => { w(0, "LAYER"); w(2, name); w(70, 0); w(62, color); w(6, "CONTINUOUS"); };
  row("0", 7);
  layers.forEach((l, i) => row(l, (i % 9) + 1));
  w(0, "ENDTAB");
  w(0, "ENDSEC");
  // ENTITIES
  w(0, "SECTION"); w(2, "ENTITIES");
  const head = out.join("\n");
  const tail = ["0", "ENDSEC", "0", "EOF", ""].join("\n");
  const dxf = head + "\n" + (faceRecords.length ? faceRecords.join("\n") + "\n" : "") + tail;
  return { dxf, faces, byLayer, skippedDegenerate: degenerate, bounds: min && max ? { min, max } : null };
}

/** Layer for an IFC entity name (e.g. "IFCWALLSTANDARDCASE" → A-WALL). Unknown entities get A-<NAME>. */
export function layerForIfcCategory(category: string | undefined): string {
  const c = (category ?? "").toUpperCase().replace(/^IFC/, "");
  const rules: Array<[RegExp, string]> = [
    [/^WALL/, "A-WALL"], [/^CURTAINWALL/, "A-GLAZ-CWMG"], [/^SLAB/, "A-FLOR"], [/^ROOF/, "A-ROOF"], [/^COVERING/, "A-CLNG"],
    [/^DOOR/, "A-DOOR"], [/^WINDOW/, "A-GLAZ"], [/^STAIR/, "A-STRS"], [/^RAMP/, "A-RAMP"], [/^RAILING/, "A-RAIL"],
    [/^COLUMN/, "S-COLS"], [/^BEAM/, "S-BEAM"], [/^MEMBER/, "S-MEMB"], [/^PLATE/, "S-PLAT"], [/^FOOTING|^PILE/, "S-FNDN"], [/^REINFORCING/, "S-REBR"],
    [/^FURNISHING|^FURNITURE/, "I-FURN"], [/^SPACE/, "A-AREA"],
    [/^DUCT|^AIRTERMINAL|^FAN|^DAMPER/, "M-DUCT"], [/^PIPE|^VALVE|^PUMP|^TANK|^SANITARY/, "P-PIPE"],
    [/^CABLE|^ELECTRIC|^LIGHT|^OUTLET|^SWITCH/, "E-POWR"],
    [/^BUILDINGELEMENTPROXY|^PROXY/, "A-PROXY"],
  ];
  for (const [re, layer] of rules) if (re.test(c)) return layer;
  const clean = c.replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return clean ? "A-" + clean : "A-MODEL";
}
