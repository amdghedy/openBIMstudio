// Smoke-tests the vendored WebAssembly readers in Node (used by the "Vendor CAD readers" workflow).
//   node scripts/vendor-smoke.mjs occt <file.step|.igs|.brep>
//   node scripts/vendor-smoke.mjs rhino
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const [kind, file] = process.argv.slice(2);
import os from "node:os";
// The repo's package.json is "type": "module", which would make Node parse these UMD files as ES modules.
// Copy the vendored folder next to a CommonJS package.json to load it the way a classic <script> would.
function loadUmd(sub, entry) {
  const src = path.join(root, "public/vendor", sub);
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-"));
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  fs.writeFileSync(path.join(dst, "package.json"), '{"type":"commonjs"}');
  return { dir: dst, mod: require(path.join(dst, entry)) };
}

if (kind === "occt") {
  const { dir, mod: factory } = loadUmd("occt", "occt-import-js.js");
  const occt = await factory({ locateFile: (n) => path.join(dir, n) });
  const bytes = new Uint8Array(fs.readFileSync(file));
  const ext = path.extname(file).toLowerCase();
  const fn = ext === ".brep" || ext === ".brp" ? "ReadBrepFile" : ext === ".igs" || ext === ".iges" ? "ReadIgesFile" : "ReadStepFile";
  const r = occt[fn](bytes, null);
  const tris = (r.meshes ?? []).reduce((s, m) => s + (m.index?.array?.length ?? 0) / 3, 0);
  console.log(JSON.stringify({ file: path.basename(file), fn, success: r.success, meshes: (r.meshes ?? []).length, triangles: tris, hasRoot: !!r.root, keys: Object.keys(r.meshes?.[0] ?? {}), attrKeys: Object.keys(r.meshes?.[0]?.attributes ?? {}) }));
  const bbox = (res) => { let mn = [1e300, 1e300, 1e300], mx = [-1e300, -1e300, -1e300]; for (const m of res.meshes ?? []) { const a = m.attributes.position.array; for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], a[i + k]); mx[k] = Math.max(mx[k], a[i + k]); } } return mx.map((v, k) => +(v - mn[k]).toFixed(4)); };
  const units = {};
  for (const u of ["millimeter", "meter"]) { try { const rr = occt[fn](bytes, { linearUnit: u }); units[u] = rr.success ? bbox(rr) : "failed"; } catch (e) { units[u] = "threw: " + e; } }
  console.log(JSON.stringify({ file: path.basename(file), bboxDefault: bbox(r), bboxByLinearUnit: units }));
  if (!r.success || !tris) { console.error("no geometry decoded"); process.exit(1); }
} else if (kind === "rhino") {
  const { dir, mod: factory } = loadUmd("rhino3dm", "rhino3dm.js");
  const rhino = await factory({ locateFile: (n) => path.join(dir, n) });
  if (file) {
    const real = rhino.File3dm.fromByteArray(new Uint8Array(fs.readFileSync(file)));
    const objs = real.objects(); const types = {}; let meshVerts = 0, brepFaceMeshes = 0, brepFaces = 0;
    for (let i = 0; i < objs.count; i++) {
      const g = objs.get(i).geometry(); const t = String(g.objectType?.constructor?.name ?? "") + ":" + (g.objectType?.value ?? g.objectType); types[t] = (types[t] ?? 0) + 1;
      if (g.objectType?.value === 1073741824) { let em = null; try { em = g.getMesh(rhino.MeshType.Any); } catch (e) { em = "threw " + e; } console.log(JSON.stringify({ extrusionGetMesh: em && typeof em === "object" ? "mesh with " + em.vertices().count + " vertices" : String(em) })); }
      if (g.vertices) meshVerts += g.vertices().count;
      if (g.faces && g.objectType?.value === 16) for (let f = 0; f < g.faces().count; f++) { brepFaces++; const m = g.faces().get(f).getMesh(rhino.MeshType.Any); if (m) { brepFaceMeshes++; meshVerts += m.vertices().count; if (brepFaceMeshes === 1) { const raw = m.toThreejsJSON(); const j = typeof raw === "string" ? JSON.parse(raw) : raw; const pa = j.data?.attributes?.position; console.log(JSON.stringify({ threejsJson: { type: j.metadata?.type ?? j.type, keys: Object.keys(j), dataKeys: Object.keys(j.data ?? {}), posItemSize: pa?.itemSize, posLen: pa?.array?.length, hasIndex: !!j.data?.index, indexLen: j.data?.index?.array?.length } })); } } }
    }
    console.log(JSON.stringify({ real: path.basename(file), objects: objs.count, types, brepFaces, brepFaceMeshes, meshVerts, units: real.settings?.().modelUnitSystem, layers: real.layers().count }));
    process.exit(0);
  }
  const doc = new rhino.File3dm();
  const info = { version: rhino.version?.() ?? null, geometry: [] };
  // Add a mesh through whichever constructor this build offers, write the file, read it back.
  const mesh = new rhino.Mesh();
  mesh.vertices().add(0, 0, 0); mesh.vertices().add(1, 0, 0); mesh.vertices().add(0, 1, 0);
  mesh.faces().addTriFace(0, 1, 2);
  doc.objects().add(mesh, null);
  const bytes = doc.toByteArray();
  const back = rhino.File3dm.fromByteArray(new Uint8Array(bytes));
  const objs = back.objects();
  for (let i = 0; i < objs.count; i++) { const g = objs.get(i).geometry(); info.geometry.push({ type: g.objectType, vertices: g.vertices?.().count ?? null }); }
  console.log(JSON.stringify({ bytes: bytes.length, objects: objs.count, ...info }));
  if (objs.count !== 1) { console.error("round trip lost the object"); process.exit(1); }
} else { console.error("usage: vendor-smoke.mjs occt <file> | rhino"); process.exit(2); }
