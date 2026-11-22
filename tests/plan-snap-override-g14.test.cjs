const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"g14-"));
// plan-snap.ts imports PlanDimensionRef (type-only) from plan-view-panel,
// so tsc loads the panel's whole type graph — and reports PRE-EXISTING
// errors in files this branch does not touch (projects.ts, pwa.ts, …),
// which the project-wide `npx tsc --noEmit` (project tsconfig) already
// proves clean. tsc still emits the JS, so: fail only on errors in the
// two modules under test, and document the rest as out of scope.
try {
  execSync(`npx tsc src/modules/views/plan-snap.ts src/modules/views/plan-snap-override.ts --outDir ${out} --rootDir src --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"pipe"});
} catch (e) {
  const log=String((e.stdout||"")+(e.stderr||""));
  const mine=log.split("\n").filter((l)=>/plan-snap(-override)?\.ts\(\d/.test(l));
  assert.strictEqual(mine.length,0,"type errors in the modules under test:\n"+mine.join("\n"));
}
const snap=require(path.join(out,"modules/views/plan-snap.js"));
const ov=require(path.join(out,"modules/views/plan-snap-override.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const near=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<eps,`${a}!=${b}`);

// Fixture: wall A (0,0)-(4,0); crossing walls X (0,0)-(4,4) and Y (0,4)-(4,0)
// meet at (2,2); column C centred at (10,10).
const A={id:"wA",type:"wall",params:{start:[0,0],end:[4,0],thickness:0.2,height:3,elevation:0}};
const X={id:"wX",type:"wall",params:{start:[0,0],end:[4,4],thickness:0.2,height:3,elevation:0}};
const Y={id:"wY",type:"wall",params:{start:[0,4],end:[4,0],thickness:0.2,height:3,elevation:0}};
const C={id:"c1",type:"column",params:{point:[10,10],width:0.4,depth:0.6,height:3,thickness:0.4,elevation:0}};
// Short wall D gives a second DISTINCT endpoint near the origin (0.1,0) —
// needed for the Tab-cycle test, since rankElementSnapPoints dedupes exact
// coincident points (A-start and X-start both sit at (0,0)).
const D={id:"wD",type:"wall",params:{start:[0.1,0],end:[0.1,2],thickness:0.2,height:3,elevation:0}};
const els=[A,X,Y,C,D];
const TOL=0.35;

// ---- Pure override module: state machine (one-shot) ----
t("override starts disarmed",()=>{const o=ov.createPlanSnapOverride();assert.strictEqual(o.active,null)});
t("arm replaces, consume clears once",()=>{const o=ov.createPlanSnapOverride();o.arm("endpoint");assert.strictEqual(o.active,"endpoint");o.arm("midpoint");assert.strictEqual(o.active,"midpoint");assert.strictEqual(o.consumeAfterSnap(),true);assert.strictEqual(o.active,null);assert.strictEqual(o.consumeAfterSnap(),false)});
t("clear disarms without consuming",()=>{const o=ov.createPlanSnapOverride();o.arm("center");o.clear();assert.strictEqual(o.active,null);assert.strictEqual(o.consumeAfterSnap(),false)});
t("label lookup",()=>{assert.strictEqual(ov.planSnapOverrideLabel("intersection"),"Intersection");assert.strictEqual(ov.planSnapOverrideLabel("nearest"),"Nearest")});

// ---- Pure override module: key resolution + SC precedence ----
t("SE/SM/SC/SI/SN resolve while a plan tool is active",()=>{assert.strictEqual(ov.resolveOverrideKeys("s","e",true),"endpoint");assert.strictEqual(ov.resolveOverrideKeys("s","m",true),"midpoint");assert.strictEqual(ov.resolveOverrideKeys("s","c",true),"center");assert.strictEqual(ov.resolveOverrideKeys("s","i",true),"intersection");assert.strictEqual(ov.resolveOverrideKeys("s","n",true),"nearest")});
t("SC falls through to gizmo scale when no plan tool is active",()=>{assert.strictEqual(ov.resolveOverrideKeys("s","c",false),null)});
t("no override resolves when no plan tool is active",()=>{assert.strictEqual(ov.resolveOverrideKeys("s","e",false),null);assert.strictEqual(ov.resolveOverrideKeys("s","n",false),null)});
t("keys are case-insensitive",()=>{assert.strictEqual(ov.resolveOverrideKeys("S","E",true),"endpoint");assert.strictEqual(ov.resolveOverrideKeys("s","C",true),"center")});
t("first letter must be s",()=>{assert.strictEqual(ov.resolveOverrideKeys("x","e",true),null);assert.strictEqual(ov.resolveOverrideKeys("","e",true),null)});
t("SP/ST/SQ/SV are not override keys (no producer; ST is Stairs)",()=>{for(const k of ["p","t","q","v"])assert.strictEqual(ov.resolveOverrideKeys("s",k,true),null)});
t("omission table records all four honestly",()=>{const ks=ov.OMITTED_OVERRIDE_KEYS.map((e)=>e.keys).sort();assert.deepStrictEqual(ks,["sp","sq","st","sv"]);for(const e of ov.OMITTED_OVERRIDE_KEYS)assert.ok(e.reason.length>10,e.keys)});
t("override entries: five, unique keys, Revit labels",()=>{assert.strictEqual(ov.PLAN_SNAP_OVERRIDE_ENTRIES.length,5);assert.deepStrictEqual(ov.PLAN_SNAP_OVERRIDE_ENTRIES.map((e)=>e.keys),["se","sm","sc","si","sn"]);assert.deepStrictEqual(ov.PLAN_SNAP_OVERRIDE_ENTRIES.map((e)=>e.label),["Endpoint","Midpoint","Center","Intersection","Nearest"])});
t("isOverrideFirstKey",()=>{assert.strictEqual(ov.isOverrideFirstKey("s"),true);assert.strictEqual(ov.isOverrideFirstKey("S"),true);assert.strictEqual(ov.isOverrideFirstKey("e"),false)});

// ---- No duplicate two-letter keys across registries ----
// Taken set scanned 2026-11-22 against main eff8ab4: default-shortcuts.ts
// (bm br ci cm dr du ft gr lv pp pu re sf sl ts wa wn), bim-input-compatibility.ts
// (al cs gp hh hi hr ma mv ro vn za ze zf zi zo + tools cl cw ra rf rm st),
// revit-g8-keys.ts (ar co di mi of sc tl tr vg). The ONLY overlap with the
// override keys is "sc" — the documented context-dependent exception
// (snap-centre while a plan tool is active, gizmo scale everywhere else).
t("override keys do not collide with any registry key except SC",()=>{
  const taken=new Set("bm br ci cm dr du ft gr lv pp pu re sf sl ts wa wn al cs gp hh hi hr ma mv ro vn za ze zf zi zo cl cw ra rf rm st ar co di mi of sc tl tr vg".split(" "));
  for(const e of ov.PLAN_SNAP_OVERRIDE_ENTRIES){
    if(e.keys==="sc")continue;
    assert.ok(!taken.has(e.keys),e.keys+" collides with a registered shortcut");
  }
  assert.ok(taken.has("sc"),"SC must still be the G8 gizmo-scale binding outside plan tools");
});

// ---- Filtered feature snap (plan-snap.ts onlyKind) ----
t("unfiltered: endpoint wins near a wall end",()=>{const h=snap.findPlanSnap(els,0.02,0.02,TOL);assert.ok(h);assert.strictEqual(h.kind,"endpoint");near(h.x,0);near(h.z,0)});
t("unfiltered: midpoint near a wall middle",()=>{const h=snap.findPlanSnap(els,2.0,0.02,TOL);assert.ok(h);assert.strictEqual(h.kind,"midpoint");near(h.x,2);near(h.z,0)});
t("onlyKind endpoint: hit at the end, null at the middle",()=>{const h=snap.findPlanSnap(els,0.02,0.02,TOL,0,"endpoint");assert.ok(h);assert.strictEqual(h.kind,"endpoint");assert.strictEqual(snap.findPlanSnap(els,2.0,0.02,TOL,0,"endpoint"),null)});
t("onlyKind midpoint: hit at the middle, null at the end",()=>{const h=snap.findPlanSnap(els,2.0,0.02,TOL,0,"midpoint");assert.ok(h);assert.strictEqual(h.kind,"midpoint");assert.strictEqual(snap.findPlanSnap(els,0.02,0.02,TOL,0,"midpoint"),null)});
t("onlyKind center: column centre only",()=>{const h=snap.findPlanSnap(els,10.02,10.02,TOL,0,"center");assert.ok(h);assert.strictEqual(h.kind,"center");near(h.x,10);near(h.z,10);assert.strictEqual(snap.findPlanSnap(els,0.02,0.02,TOL,0,"center"),null)});
t("onlyKind intersection: crossing point only (shared ends count too)",()=>{const h=snap.findPlanSnap(els,2.0,2.0,TOL,0,"intersection");assert.ok(h);assert.strictEqual(h.kind,"intersection");near(h.x,2);near(h.z,2);const shared=snap.findPlanSnap(els,0.02,0.02,TOL,0,"intersection");assert.ok(shared);assert.strictEqual(shared.kind,"intersection");near(shared.x,0);near(shared.z,0);assert.strictEqual(snap.findPlanSnap(els,2.0,0.02,TOL,0,"intersection"),null)});
t("onlyKind nearest: closest point on a wall, never the end",()=>{const h=snap.findPlanSnap(els,2.0,0.3,TOL,0,"nearest");assert.ok(h);assert.strictEqual(h.kind,"nearest");near(h.x,2);near(h.z,0)});
t("onlyKind midpoint never returns an endpoint even when it is closer",()=>{const h=snap.findPlanSnap(els,0.3,0.02,TOL,0,"midpoint");assert.strictEqual(h,null)});
t("onlyKind endpoint cycles only among endpoints (Tab keeps working)",()=>{const h=snap.findPlanSnap(els,0.05,0.02,TOL,0,"endpoint");assert.ok(h);assert.ok(h.alt&&h.alt.count===2,"expected two distinct endpoint candidates, got "+JSON.stringify(h.alt));const h2=snap.findPlanSnap(els,0.05,0.02,TOL,1,"endpoint");assert.ok(h2);assert.strictEqual(h2.kind,"endpoint");assert.ok(h2.x!==h.x||h2.z!==h.z,"Tab must move to the other endpoint")});
t("onlyKind corner: coincident wall ends + face corners surface as corner",()=>{const h=snap.findPlanSnap(els,0.02,0.02,TOL,0,"corner");assert.ok(h);assert.strictEqual(h.kind,"corner")});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
