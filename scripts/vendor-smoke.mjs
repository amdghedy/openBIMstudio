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
  if (!r.success || !tris) { console.error("no geometry decoded"); process.exit(1); }
} else if (kind === "rhino") {
  const { dir, mod: factory } = loadUmd("rhino3dm", "rhino3dm.js");
  const rhino = await factory({ locateFile: (n) => path.join(dir, n) });
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
