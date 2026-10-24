const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"fo-"));
execSync(`npx tsc src/modules/mep/fitting-outline.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreConfig --ignoreDeprecations 6.0`,{stdio:"inherit"});
const m=require(path.join(out,"fitting-outline.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const near=(a,b,e=1e-6)=>assert.ok(Math.abs(a-b)<e,`${a}!=${b}`);
const len=(s)=>Math.hypot(s.x2-s.x1,s.z2-s.z1);
const total=(a)=>a.reduce((x,s)=>x+len(s),0);
const W=0.4,L=1,hw=W/2;
t("tee: 90deg, branch north of an east-west run",()=>{
  const arms=m.fittingArmAngles("tee",0,Math.PI/2);
  const segs=m.fittingOutlineSegments(0,0,arms,W,L);
  // expected: run bottom full (2L) + run top (2*(L-hw)) + branch two sides (each L-hw)
  near(total(segs),2*L+2*(L-hw)+2*(L-hw),0.01);
});
t("tee: no outline segment lies inside the body of another arm",()=>{
  const segs=m.fittingOutlineSegments(0,0,m.fittingArmAngles("tee",0,Math.PI/2),W,L);
  for(const s of segs){const mx=(s.x1+s.x2)/2,mz=(s.z1+s.z2)/2;
    const inMain=Math.abs(mx)<=L&&Math.abs(mz)<hw-1e-3, inBranch=Math.abs(mx)<hw-1e-3&&mz>=0&&mz<=L;
    assert.ok(!inMain&&!inBranch,`segment midpoint inside body (${mx},${mz})`)}
});
t("tee: branch opens into the run (no segment across the opening)",()=>{
  const segs=m.fittingOutlineSegments(0,0,m.fittingArmAngles("tee",0,Math.PI/2),W,L);
  assert.ok(!segs.some(s=>Math.abs(s.z1-hw)<1e-6&&Math.abs(s.z2-hw)<1e-6&&Math.min(s.x1,s.x2)<hw-1e-3&&Math.max(s.x1,s.x2)>-hw+1e-3));
});
t("cross: four notch corners, outline = 4 arms x 2 sides trimmed",()=>{
  const segs=m.fittingOutlineSegments(0,0,m.fittingArmAngles("cross",0,Math.PI/2),W,L);
  near(total(segs),8*(L-hw),0.01);
});
t("wye: three outline groups produce segments for 4 arms",()=>{
  const segs=m.fittingOutlineSegments(0,0,m.fittingArmAngles("wye",0,Math.PI/2),W,L);
  assert.ok(segs.length>=6);
});
t("rotated tee has the same outline length",()=>{
  const a=total(m.fittingOutlineSegments(0,0,m.fittingArmAngles("tee",0,Math.PI/2),W,L));
  const b=total(m.fittingOutlineSegments(3,-2,m.fittingArmAngles("tee",0.7,0.7+Math.PI/2),W,L));
  near(a,b,1e-6);
});
t("tee branch to the other side mirrors the length",()=>{
  const a=total(m.fittingOutlineSegments(0,0,m.fittingArmAngles("tee",0,Math.PI/2),W,L));
  const b=total(m.fittingOutlineSegments(0,0,m.fittingArmAngles("tee",0,-Math.PI/2),W,L));
  near(a,b);
});
t("arm length matches the 3D stub",()=>{near(m.fittingArmLength(0.4,0.3,undefined,false),Math.max(Math.max(0.4,0.3)/2*2.4,0.4*1.6));near(m.fittingArmLength(0.1,0.1,0.5,true),Math.max(0.5*2.4,0.1*1.6))});
t("cap closes the run",()=>{const s=m.capOutlineSegments(0,0,0,W,0.2);assert.strictEqual(s.length,3);near(len(s[2]),W)});
t("host run side line is opened at the branch",()=>{
  const side={x1:-2,z1:hw,x2:2,z2:hw};
  const pieces=m.openBranchInSegment(side,0,0,Math.PI/2,L,W);
  assert.strictEqual(pieces.length,2);
  near(pieces[0].x2,-hw,0.01);near(pieces[1].x1,hw,0.01);
  const far={x1:-2,z1:-hw,x2:2,z2:-hw};assert.strictEqual(m.openBranchInSegment(far,0,0,Math.PI/2,L,W).length,1);
});
t("branch angles exclude the main run",()=>{assert.strictEqual(m.fittingBranchAngles("tee",0,1).length,1);assert.strictEqual(m.fittingBranchAngles("cross",0,1).length,2)});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
