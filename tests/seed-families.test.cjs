// Every family in public/families must be loadable: listed in index.json, valid per library-loader's looksLikeFamily
// (id, name, ifcEntity, parameters[], geometry.kind) and with geometry that only refers to parameters the family defines.
// Regression: Structural/concrete-column-rectangular.json and steel-beam-i.json had no geometry and were skipped at boot.
const fs = require("fs"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "../public/families");
const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
const entries = Array.isArray(index) ? index : index.families ?? index.entries ?? [];
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
ok(entries.length > 50, "catalog has entries: " + entries.length);
const loaderSrc = fs.readFileSync(path.join(__dirname, "../src/modules/families/library-loader.ts"), "utf8");
ok(/o\.geometry && typeof o\.geometry === "object"/.test(loaderSrc), "test mirrors looksLikeFamily (geometry required)");
const names = (spec, out = new Set()) => {
  const walk = (v) => {
    if (v && typeof v === "object") {
      if (typeof v.ref === "string") out.add(v.ref);
      if (typeof v.expr === "string") (v.expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).forEach((x) => out.add(x));
      Object.values(v).forEach(walk);
    }
  };
  walk(spec); return out;
};
const seen = new Set();
for (const e of entries) {
  ok(typeof e.path === "string", "entry has a path");
  const file = path.join(root, e.path);
  ok(fs.existsSync(file), "exists: " + e.path);
  const f = JSON.parse(fs.readFileSync(file, "utf8"));
  ok(typeof f.id === "string" && f.id && typeof f.name === "string" && f.name && typeof f.ifcEntity === "string" && Array.isArray(f.parameters), "base fields: " + e.path);
  ok(f.geometry && typeof f.geometry === "object" && "kind" in f.geometry, "has geometry: " + e.path);
  ok(!seen.has(f.id), "unique id: " + f.id); seen.add(f.id);
  const params = new Set(f.parameters.map((p) => p.name));
  const used = names(f.geometry); used.delete("const");
  for (const u of used) ok(params.has(u) || /^(sin|cos|min|max|abs|sqrt|pi|PI)$/i.test(u) || /^\d/.test(u), `${e.path}: geometry refers to unknown parameter "${u}"`);
  for (const t of f.types ?? []) for (const k of Object.keys(t.parameters ?? {})) ok(params.has(k), `${e.path}: type "${t.name}" sets unknown parameter "${k}"`);
}
// The two structural families specifically
const col = JSON.parse(fs.readFileSync(path.join(root, "Structural/concrete-column-rectangular.json"), "utf8"));
ok(col.geometry.kind === "box", "column is a box");
const beam = JSON.parse(fs.readFileSync(path.join(root, "Structural/steel-beam-i.json"), "utf8"));
ok(beam.geometry.kind === "composed" && beam.geometry.parts.length === 3, "beam is flange + web + flange");
ok(beam.parameters.some((p) => p.name === "length"), "beam has a length parameter");
console.log(`seed-families: ${n} assertions passed`);
