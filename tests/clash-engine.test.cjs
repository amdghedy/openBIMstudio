// Clash engine correctness tests: real triangle meshes through the real clash-core (mini three.js in Node).
const h = require("./helpers/clash-harness.cjs");
const { THREE } = h; const core = h.core();
let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log("  PASS", n); } catch (e) { fail++; console.log("  FAIL", n + ": " + e.message); } };
const ok = (c, m) => { if (!c) throw new Error(m || "assertion"); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || "") + " got " + JSON.stringify(a) + " want " + JSON.stringify(b)); };

/** 12 triangles of an axis-aligned box. */
function boxTris(x0, y0, z0, x1, y1, z1) {
  const v = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[2,3,7],[2,7,6],[1,2,6],[1,6,5],[3,0,4],[3,4,7]];
  return f.map(([a,b,c]) => Float32Array.from([...v[a], ...v[b], ...v[c]]));
}
const item = (modelId, localId, cat, x0,y0,z0,x1,y1,z1, tris) => ({
  modelId, localId, name: `${cat}-${localId}`, category: cat,
  box: new THREE.Box3(new THREE.Vector3(x0,y0,z0), new THREE.Vector3(x1,y1,z1)),
  tris: tris === undefined ? boxTris(x0,y0,z0,x1,y1,z1) : tris,
});
const rules = (o = {}) => ({ ...core.DEFAULT_CLASH_RULES, ...o });
async function run(items, o = {}) {
  return core.runClashCore(items, { rules: rules(o.rules), method: o.method || "hard-triangle", groups: o.groups || [items.map((_, i) => i)], selfPairs: o.selfPairs ?? true, sides: o.sides });
}

(async () => {
  await t("crossing boxes clash", async () => { const r = await run([item("m",1,"WALL",0,0,0,4,3,0.3), item("m",2,"PIPE",1,1,-1,1.2,1.2,1)]); eq(r.length,1); eq(r[0].kind,"intersect"); });
  await t("separated boxes do not clash", async () => { eq((await run([item("m",1,"A",0,0,0,1,1,1), item("m",2,"B",3,3,3,4,4,4)])).length,0); });
  await t("face-to-face contact within tolerance is 'touching', not intersect", async () => { const r = await run([item("m",1,"A",0,0,0,1,1,1), item("m",2,"B",1.001,0,0,2,1,1)], { rules: { tolerance: 0.005 } }); eq(r.length,1); eq(r[0].kind,"touching"); });
  await t("bbox overlap but geometry apart is NOT reported (L-shape)", async () => {
    const L = [...boxTris(0,0,0,4,0.5,1), ...boxTris(0,0,0,0.5,4,1)];
    const small = item("m",2,"B",2,2,0.2,3,3,0.8);
    const a = { ...item("m",1,"A",0,0,0,4,4,1), tris: L };
    eq((await run([a, small])).length, 0);
  });
  await t("element fully INSIDE a solid element is reported (no surface crossing)", async () => {
    const wall = item("m",1,"WALL",0,0,0,10,3,2);
    const pipe = item("m",2,"PIPE",4,1,0.5,5,1.3,1.5);       // completely embedded in the wall
    const r = await run([wall, pipe]);
    eq(r.length, 1, "embedded element missed"); eq(r[0].kind, "intersect"); ok(r[0].contained === true, "should be flagged contained");
  });
  await t("containment works in both directions of the pair order", async () => {
    const r = await run([item("m",2,"PIPE",4,1,0.5,5,1.3,1.5), item("m",1,"WALL",0,0,0,10,3,2)]); eq(r.length,1);
  });
  await t("element inside a HOLLOW element's void is not reported", async () => {
    // room made of 6 thin slabs; a box floating inside the cavity must not clash
    const walls = [boxTris(0,0,0,10,0.2,10), boxTris(0,9.8,0,10,10,10), boxTris(0,0,0,0.2,10,10), boxTris(9.8,0,0,10,10,10), boxTris(0,0,0,10,10,0.2), boxTris(0,0,9.8,10,10,10)].flat();
    const room = { ...item("m",1,"ROOM",0,0,0,10,10,10), tris: walls };
    eq((await run([room, item("m",2,"EQUIP",4,4,4,5,5,5)])).length, 0);
  });
  await t("sides: only A-vs-B pairs inside ONE model (category A vs category B)", async () => {
    const items = [item("m",1,"WALL",0,0,0,4,3,0.3), item("m",2,"WALL",0,0,0.2,4,3,0.5), item("m",3,"PIPE",1,1,-1,1.2,1.2,1)];
    const r = await run(items, { sides: [1, 1, 2], selfPairs: false });
    eq(r.length, 2, "wall-wall pair must be ignored; both wall-pipe pairs reported");
    ok(r.every((c) => [c.a.cat, c.b.cat].includes("PIPE")), "pairs should include the pipe");
  });
  await t("sides: an element selected in both A and B pairs with everything", async () => {
    const items = [item("m",1,"X",0,0,0,2,2,2), item("m",2,"Y",1,1,1,3,3,3), item("m",3,"Z",1.5,1.5,1.5,2.5,2.5,2.5)];
    const r = await run(items, { sides: [3, 1, 2], selfPairs: false });
    eq(r.length, 3);
  });
  await t("linked model vs host model (different groups) clash; same-model pairs ignored", async () => {
    const items = [item("host",1,"WALL",0,0,0,4,3,0.3), item("host",2,"WALL",0,0,0.1,4,3,0.4), item("link",1,"DUCT",1,1,-1,1.2,1.2,1)];
    const r = await run(items, { groups: [[0,1],[2]], selfPairs: false });
    eq(r.length, 2); ok(r.every((c) => c.a.modelId !== c.b.modelId), "cross-model only");
  });
  await t("clearance band reports near misses", async () => {
    const r = await run([item("m",1,"A",0,0,0,1,1,1), item("m",2,"B",1.05,0,0,2,1,1)], { method: "clearance", rules: { clearance: 0.1, tolerance: 0 } });
    eq(r.length,1); eq(r[0].kind,"clearance");
  });
  await t("items without triangles fall back to bbox and say so", async () => {
    const r = await run([item("m",1,"A",0,0,0,2,2,2,null), item("m",2,"B",1,1,1,3,3,3,null)]); eq(r.length,1); eq(r[0].precision,"bbox");
  });
  await t("duplicates method finds coincident elements", async () => {
    const r = await run([item("m",1,"A",0,0,0,1,1,1), item("m",2,"B",0,0,0,1,1,1)], { method: "duplicates" }); eq(r.length,1); eq(r[0].kind,"duplicate");
  });
  await t("a wall standing exactly on a slab (shared face) is touching, not a clash", async () => {
    const r = await run([item("m",1,"SLAB",0,0,0,10,0.2,10), item("m",2,"WALL",2,0.2,2,6,3,2.3)], { rules: { tolerance: 0.005 } });
    eq(r.length, 1); eq(r[0].kind, "touching");
  });
  await t("penetration deeper than the tolerance is a clash; shallower is touching", async () => {
    eq((await run([item("m",1,"SLAB",0,0,0,10,0.2,10), item("m",2,"WALL",2,0.19,2,6,3,2.3)], { rules: { tolerance: 0.005 } }))[0].kind, "intersect");
    eq((await run([item("m",1,"SLAB",0,0,0,10,0.2,10), item("m",2,"WALL",2,0.198,2,6,3,2.3)], { rules: { tolerance: 0.005 } }))[0].kind, "touching");
  });
  await t("tolerance 0: exact shared-face contact is not interpenetration, so no hard clash", async () => {
    eq((await run([item("m",1,"SLAB",0,0,0,10,0.2,10), item("m",2,"WALL",2,0.2,2,6,3,2.3)], { rules: { tolerance: 0 } })).length, 0);
  });
  await t("rotated (non-axis) pipe crossing a wall is found", async () => {
    const s = Math.SQRT1_2; const rot = (x, y) => [x * s - y * s, x * s + y * s];
    // a thin box rotated 45deg about Z, crossing the wall plane
    const pts = [[-1,-0.1],[1,-0.1],[1,0.1],[-1,0.1]].map(([x,y]) => rot(x,y));
    const zs = [0.5, 0.7]; const v = []; for (const z of zs) for (const [x,y] of pts) v.push([x + 2, y + 1.5, z]);
    const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
    const tris = f.map(([a,b,c]) => Float32Array.from([...v[a], ...v[b], ...v[c]]));
    const xs = v.map(p=>p[0]), ys = v.map(p=>p[1]), zz = v.map(p=>p[2]);
    const pipe = { modelId:"m", localId:2, name:"P", category:"PIPE", box: new THREE.Box3(new THREE.Vector3(Math.min(...xs),Math.min(...ys),Math.min(...zz)), new THREE.Vector3(Math.max(...xs),Math.max(...ys),Math.max(...zz))), tris };
    const wall = item("m",1,"WALL",0,1.4,0,6,1.6,3);
    eq((await run([wall, pipe])).length, 1);
  });
  await t("many elements: only true clashes among 200 (broadphase + narrowphase)", async () => {
    const items = []; for (let i = 0; i < 200; i++) items.push(item("m", i, "BOX", i * 3, 0, 0, i * 3 + 1, 1, 1));
    items.push(item("m", 999, "HIT", 150.5, 0.5, 0.5, 152.5, 0.7, 0.7)); // crosses boxes 50 (x 150..151) and 51 is at 153.. no
    const r = await run(items); eq(r.length, 1); ok([r[0].a.localId, r[0].b.localId].includes(999));
  });
  const mq = h.load("modules/clash/mesh-queries.js");
  const near = (a, b, m) => { if (Math.abs(a - b) > 1e-6) throw new Error((m || "") + " got " + a + " want " + b); };
  await t("triTriDistance: parallel triangles 2 apart", async () => {
    const A = Float32Array.from([0,0,0, 1,0,0, 0,1,0]), B = Float32Array.from([0,0,2, 1,0,2, 0,1,2]); near(mq.triTriDistance(A, B), 2);
  });
  await t("triTriDistance: edge-to-edge skew segments", async () => {
    const A = Float32Array.from([0,0,0, 2,0,0, 1,0.001,0]), B = Float32Array.from([1,-1,1, 1,1,1, 1,0,1.5]); near(mq.triTriDistance(A, B), 1, "distance");
  });
  await t("triTriDistance: intersecting triangles are 0", async () => {
    const A = Float32Array.from([0,0,0, 2,0,0, 0,2,0]), B = Float32Array.from([0.5,0.5,-1, 0.5,0.5,1, 1,1,0]); near(mq.triTriDistance(A, B), 0);
  });
  await t("pointInMesh: inside, outside, near-edge", async () => {
    const cube = boxTris(0,0,0,2,2,2);
    ok(mq.pointInMesh(cube, [1,1,1]), "centre"); ok(!mq.pointInMesh(cube, [3,1,1]), "outside"); ok(mq.pointInMesh(cube, [0.01,0.01,0.01]), "near corner"); ok(!mq.pointInMesh(cube, [1,1,-0.01]), "just below");
  });
  await t("a long run of 400 pipes through 200 walls finds every crossing (stress)", async () => {
    const items = [];
    for (let i = 0; i < 200; i++) items.push(item("m", i, "WALL", i * 5, 0, 0, i * 5 + 0.3, 3, 4));
    for (let i = 0; i < 200; i++) items.push(item("m", 1000 + i, "PIPE", i * 5 - 1, 1, 1, i * 5 + 1, 1.2, 1.2));
    const r = await run(items); eq(r.length, 200, "each pipe crosses exactly its own wall");
  });
  await t("triangle budget never thins a surface: all-or-nothing", async () => {
    const g = h.load("modules/clash/geometry.js");
    ok(g.triangleBudgetOk(1) && g.triangleBudgetOk(g.MAX_TRIS_PER_ITEM), "within cap kept whole");
    ok(!g.triangleBudgetOk(g.MAX_TRIS_PER_ITEM + 1) && !g.triangleBudgetOk(0), "over cap is dropped, never sampled");
    ok(g.MAX_TRIS_PER_ITEM >= 100000, "cap must be high enough for real MEP / structural elements");
  });
  await t("coverage: bbox-only items are labelled so the UI can warn", async () => {
    const r = await run([item("m",1,"A",0,0,0,2,2,2), item("m",2,"B",1,1,1,3,3,3,null)]);
    eq(r.length, 1); eq(r[0].precision, "bbox");
  });
  console.log(`=== Result: ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
})();
