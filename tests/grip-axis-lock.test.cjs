const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"gal-"));
execSync(`npx tsc src/features/grip-axis-lock.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const m=require(path.join(out,"grip-axis-lock.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const near=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<eps,`${a}!=${b}`);

t("makeAxisLock normalizes +X axis",()=>{
  const l=m.makeAxisLock({x:0,z:0},{x:5,z:0});
  near(l.ox,0);near(l.oz,0);near(l.dx,1);near(l.dz,0);
});
t("makeAxisLock normalizes diagonal axis",()=>{
  const l=m.makeAxisLock({x:1,z:1},{x:4,z:5});
  const vx=3,vz=4,len=5; // 3-4-5 triangle
  near(l.ox,1);near(l.oz,1);near(l.dx,0.6);near(l.dz,0.8);
  near(len,5);
});
t("makeAxisLock null on zero-length element",()=>{
  assert.strictEqual(m.makeAxisLock({x:2,z:3},{x:2,z:3}),null);
});
t("projectOnAxis snaps free point onto axis",()=>{
  const l=m.makeAxisLock({x:0,z:0},{x:5,z:0});
  const p=m.projectOnAxis(l,{x:3,z:2});
  near(p.x,3);near(p.z,0);near(p.t,3);
});
t("projectOnAxis keeps on-axis point unchanged",()=>{
  const l=m.makeAxisLock({x:1,z:1},{x:4,z:5});
  const p=m.projectOnAxis(l,{x:2.2,z:2.6}); // (1,1) + 2*(0.6,0.8)
  near(p.x,2.2);near(p.z,2.6);near(p.t,2);
});
t("axisT is signed (negative before origin)",()=>{
  const l=m.makeAxisLock({x:0,z:0},{x:5,z:0});
  near(m.axisT(l,{x:-2,z:9}),-2);
});
t("axisPerpDist measures off-axis distance",()=>{
  const l=m.makeAxisLock({x:0,z:0},{x:5,z:0});
  near(m.axisPerpDist(l,{x:3,z:2}),2);
  near(m.axisPerpDist(l,{x:3,z:0}),0);
});
t("reduce length: Shift-locked end-drag shortens wall in place",()=>{
  // Wall (0,0)->(5,0), drag "end" grip, cursor drifts to (3, 1.7)
  const l=m.makeAxisLock({x:0,z:0},{x:5,z:0});
  const p=m.projectOnAxis(l,{x:3,z:1.7});
  near(p.x,3);near(p.z,0);
  const len=Math.hypot(p.x-0,p.z-0);
  near(len,3); // 5 -> 3, perpendicular drift removed
});
t("increase length: Shift-locked end-drag stretches wall in place",()=>{
  const l=m.makeAxisLock({x:0,z:0},{x:5,z:0});
  const p=m.projectOnAxis(l,{x:8,z:-2});
  near(p.x,8);near(p.z,0);
  near(Math.hypot(p.x,p.z),8);
});
t("drag start grip: fixed end stays put",()=>{
  // Wall (0,0)->(5,0), drag "start" grip, axis origin is the END point
  const l=m.makeAxisLock({x:5,z:0},{x:0,z:0});
  near(l.ox,5);near(l.oz,0);
  const p=m.projectOnAxis(l,{x:1.5,z:0.9});
  near(p.x,1.5);near(p.z,0);
  near(Math.hypot(p.x-5,p.z-0),3.5); // new length
});
t("snapAlongAxis accepts collinear candidate near cursor t",()=>{
  const l=m.makeAxisLock({x:0,z:0},{x:5,z:0});
  const hit=m.snapAlongAxis(l,3,[{x:3.05,z:0},{x:1,z:5}],0.14);
  assert.ok(hit);near(hit.x,3.05);near(hit.z,0);
});
t("snapAlongAxis projects slightly off-axis candidate back ONTO axis",()=>{
  const l=m.makeAxisLock({x:0,z:0},{x:5,z:0});
  const hit=m.snapAlongAxis(l,3,[{x:3.05,z:0.1}],0.14);
  assert.ok(hit);near(hit.x,3.05);near(hit.z,0); // z forced back to the axis
});
t("snapAlongAxis rejects off-axis candidate",()=>{
  const l=m.makeAxisLock({x:0,z:0},{x:5,z:0});
  assert.strictEqual(m.snapAlongAxis(l,3,[{x:7,z:5}],0.14),null);
});
t("snapAlongAxis rejects collinear-but-too-far candidate",()=>{
  const l=m.makeAxisLock({x:0,z:0},{x:5,z:0});
  assert.strictEqual(m.snapAlongAxis(l,3,[{x:7,z:0}],0.14),null);
});
t("snapAlongAxis picks nearest t among ties",()=>{
  const l=m.makeAxisLock({x:0,z:0},{x:5,z:0});
  const hit=m.snapAlongAxis(l,3,[{x:3.05,z:0},{x:2.9,z:0}],0.2);
  assert.ok(hit);near(hit.x,3.05); // |3.05-3|=0.05 beats |2.9-3|=0.1
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
