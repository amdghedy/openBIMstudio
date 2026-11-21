/* Authored IFC export emits IfcXxxType + IfcRelDefinesByType (Revit maps occurrences to family types through these). */
const fs = require("fs"), path = require("path"), assert = require("assert");
const DIR = path.join(__dirname, "fixtures", "ifc-corpus", "extended");
let n = 0; const t = (name, fn) => { fn(); n++; };
const recs = (text) => [...text.matchAll(/^#(\d+)=([A-Z0-9_]+)\((.*)\);$/gm)].map((m) => ({ id: +m[1], type: m[2], body: m[3] }));
const split = (body) => { const o = []; let d = 0, s = false, c = ""; for (const ch of body) { if (ch === "'") s = !s; if (!s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { o.push(c); c = ""; continue; } } c += ch; } o.push(c); return o; };
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".ifc"));
for (const f of files) t(`types: ${f}`, () => {
  const r = recs(fs.readFileSync(path.join(DIR, f), "utf8")), byId = new Map(r.map((x) => [x.id, x]));
  const types = r.filter((x) => /TYPE$/.test(x.type) && x.type.startsWith("IFC") && !x.type.startsWith("IFCREL"));
  const rels = r.filter((x) => x.type === "IFCRELDEFINESBYTYPE");
  assert.strictEqual(rels.length, types.length, "one IfcRelDefinesByType per type");
  const typed = new Set();
  for (const rel of rels) {
    const a = split(rel.body), tgt = byId.get(+a[5].slice(1)); assert.ok(tgt && /TYPE$/.test(tgt.type) && !tgt.type.startsWith("IFCREL"), "relating type exists");
    assert.strictEqual(split(tgt.body).length, 10, `${tgt.type} attribute count (IfcTypeProduct 9 + PredefinedType)`);
    for (const o of a[4].match(/#\d+/g)) { const id = +o.slice(1); assert.ok(byId.has(id), "occurrence exists"); assert.ok(!typed.has(id), "occurrence typed once"); typed.add(id); }
    assert.ok(a[4].match(/#\d+/g).every((o) => byId.get(+o.slice(1)).type.startsWith(tgt.type.slice(0, -4))), "occurrence class matches the type class");
  }
  const occ = r.filter((x) => /^IFC(WALL|SLAB|BEAM|COLUMN|FOOTING|DUCTSEGMENT|PIPESEGMENT|CABLECARRIERSEGMENT|CURTAINWALL|COVERING|STAIR|RAMP|RAILING|BUILDINGELEMENTPROXY|MEMBER)/.test(x.type) && !/TYPE$/.test(x.type));
  assert.ok(occ.every((o) => typed.has(o.id)), `every typed-class occurrence has a type (${occ.filter((o) => !typed.has(o.id)).map((o) => o.type).join(",")})`);
  if (occ.length > 4) assert.ok(types.length < occ.length, "occurrences share types");
});
t("4-storey model shares one wall type across 8 walls", () => {
  const r = recs(fs.readFileSync(path.join(DIR, "ifc4-multi-storey.ifc"), "utf8"));
  const wt = r.filter((x) => x.type === "IFCWALLTYPE"); assert.strictEqual(wt.length, 1);
  const rel = r.find((x) => x.type === "IFCRELDEFINESBYTYPE" && x.body.endsWith("#" + wt[0].id)); assert.strictEqual(rel.body.match(/#\d+/g).length - 1 - 1 /*owner*/, 8);
});
console.log(`=== IFC type objects: ${n} checks over ${files.length} files ===`);
