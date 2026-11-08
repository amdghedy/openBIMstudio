// Solid-model core (STEP/IGES/BREP/3dm): pure logic, plus the REAL occt-import-js wasm on small fixtures.
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "solids-"));
execSync(`npx tsc src/modules/solids/solid-core.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict`, { stdio: "pipe" });
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const S = require(find("solid-core.js"));
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const near = (a, b, e = 1e-9) => ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);
const fx = (f) => new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures/solids", f)));

ok(S.solidKind("a.STEP") === "step" && S.solidKind("a.stp") === "step" && S.solidKind("b.igs") === "iges" && S.solidKind("b.IGES") === "iges" && S.solidKind("c.brep") === "brep" && S.solidKind("d.3dm") === "3dm", "kinds");
ok(S.solidKind("step") === null && S.solidKind("a.txt") === null, "bare word / other ext is not a solid file");
ok(S.looksLikeStep(fx("cube-10mm.stp")) && !S.looksLikeStep(fx("cube-10mm.igs")), "step sniff");
ok(S.looksLikeIges(fx("cube-10mm.igs")) && !S.looksLikeIges(fx("cube-10mm.stp")), "iges sniff");
ok(S.has3dmHeader(new TextEncoder().encode("3D Geometry File Format        ")) && !S.has3dmHeader(new Uint8Array(4)), "3dm header");
near(S.rhinoUnitScale(2).scale, 1e-3); near(S.rhinoUnitScale(9).scale, 0.3048); ok(!S.rhinoUnitScale(0).known && !S.rhinoUnitScale(undefined).known && S.rhinoUnitScale(0).scale === 1, "unit scale / unknown");

// axis swap + winding: a right-handed CAD tetra with outward faces stays outward (positive volume) after toAppAxes
const vol = (p) => { let v = 0; for (let i = 0; i < p.indices.length; i += 3) { const a = [...p.positions.slice(p.indices[i] * 3, p.indices[i] * 3 + 3)], b = [...p.positions.slice(p.indices[i + 1] * 3, p.indices[i + 1] * 3 + 3)], c = [...p.positions.slice(p.indices[i + 2] * 3, p.indices[i + 2] * 3 + 3)]; v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; } return v; };
const tet = { success: true, meshes: [{ name: "t", attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] } }, index: { array: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] } }] };
const rawVol = vol({ positions: Float32Array.from(tet.meshes[0].attributes.position.array), indices: Uint32Array.from(tet.meshes[0].index.array) });
let r = S.occtToParts(tet, 1);
near(vol(r.parts[0]), rawVol, 1e-6); ok(rawVol > 0, "fixture tetra is outward in CAD axes");
ok(r.parts[0].positions[7] === 0 && r.parts[0].positions[8] === 1, "y/z swapped (CAD y=1 -> app z=1)");
// bad meshes are skipped and reported, never thrown
r = S.occtToParts({ success: true, meshes: [{ attributes: { position: { array: [0, 0, 0] } }, index: { array: [0, 1, 2] } }, { attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }, index: { array: [0, 1, 9] } }] });
ok(r.parts.length === 0 && /2 shape/.test(r.warnings[0]), "malformed skipped");
ok(S.occtToParts({ success: false }).parts.length === 0, "failure -> empty");
ok(/not part of clash/.test(S.summarizeSolids({ fileName: "x.stp", kind: "step", parts: 1, triangles: 12, unitsNote: "", warnings: [], skippedTypes: { curves: 2 } })) && /2 curves/.test(S.summarizeSolids({ fileName: "x.stp", kind: "step", parts: 1, triangles: 12, unitsNote: "", warnings: [], skippedTypes: { curves: 2 } })), "honest summary");

// ---- REAL wasm (vendored build); skipped only if the vendored files are absent
const vend = path.join(__dirname, "../public/vendor/occt");
if (fs.existsSync(path.join(vend, "occt-import-js.wasm"))) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "occt-"));
  for (const f of fs.readdirSync(vend)) fs.copyFileSync(path.join(vend, f), path.join(dst, f));
  fs.writeFileSync(path.join(dst, "package.json"), '{"type":"commonjs"}');
  const factory = require(path.join(dst, "occt-import-js.js"));
  (async () => {
    const occt = await factory({ locateFile: (f) => path.join(dst, f) });
    const bbox = (parts) => { const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p.positions[i + k]); mx[k] = Math.max(mx[k], p.positions[i + k]); } return mx.map((v, k) => v - mn[k]); };
    for (const [file, fn] of [["cube-10mm.stp", "ReadStepFile"], ["cube-10mm.igs", "ReadIgesFile"], ["cube-mm.step", "ReadStepFile"], ["cube-m.step", "ReadStepFile"]]) {
      const res = occt[fn](fx(file), { linearUnit: "meter" });
      ok(res.success, file + " decodes");
      const q = S.occtToParts(res, 1);
      ok(q.triangles === 12, `${file}: cube has 12 triangles (${q.triangles})`);
      ok(vol(q.parts[0]) > 0, `${file}: faces point outwards after axis swap (volume ${vol(q.parts[0])})`);
      if (file === "cube-10mm.stp") { const b = bbox(q.parts); near(b[0], 0.01, 1e-6); near(b[1], 0.01, 1e-6); near(b[2], 0.01, 1e-6); near(vol(q.parts[0]), 1e-6, 1e-9); }
    }
    // garbage must not hang or crash the page
    const bad = occt.ReadStepFile(new Uint8Array([1, 2, 3, 4]), null);
    ok(bad.success === false || (bad.meshes ?? []).length === 0, "garbage input yields no geometry");
    console.log(`solids: ${n} assertions passed (real occt wasm included)`);
  })().catch((e) => { console.error(e); process.exit(1); });
} else console.log(`solids: ${n} assertions passed (vendored wasm absent: real-wasm tests skipped)`);
