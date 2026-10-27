/**
 * Root-cause regression for "mouse wheel rotates the camera":
 * camera-controls v3 has no public `.target`; reading it fell back to the scene centre and the
 * following setLookAt re-aimed the camera. (Library source checked: yomotsu/camera-controls v3.1.2.)
 */
const {execSync}=require("child_process");const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"ct-"));
execSync(`npx tsc src/core/controls-target.ts src/core/cursor-zoom.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`,{stdio:"inherit"});
const T=require(path.join(out,"controls-target.js")),Z=require(path.join(out,"cursor-zoom.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const near=(a,b,e=1e-9)=>assert.ok(Math.abs(a-b)<e,`${a}!=${b}`);
const V=()=>({x:0,y:0,z:0,set(x,y,z){this.x=x;this.y=y;this.z=z;return this}});
const sub=(a,b)=>a.map((v,i)=>v-b[i]),nrm=a=>{const l=Math.hypot(...a);return a.map(v=>v/l)};
/* camera-controls v3.1.2 shape: getTarget(out) only, no `target` */
const v3Controls=(tg)=>({getTarget(o){o.set(...tg);return o}});

t("v3-style controls (getTarget only) -> real target is read",()=>{const o=V();assert.ok(T.readControlsTarget(v3Controls([2,3,1]),o));assert.deepStrictEqual([o.x,o.y,o.z],[2,3,1])});
t("legacy controls with a .target vector are still read",()=>{const o=V();assert.ok(T.readControlsTarget({target:{x:1,y:2,z:3}},o));assert.deepStrictEqual([o.x,o.y,o.z],[1,2,3])});
t("no target anywhere -> false (caller must not guess the scene centre)",()=>{assert.strictEqual(T.readControlsTarget({},V()),false);assert.strictEqual(T.readControlsTarget(null,V()),false);assert.strictEqual(T.readControlsTarget({getTarget(){throw new Error("x")}},V()),false)});
t("axis fallback lies exactly on the view axis",()=>{
  const pos=[30,20,40],dir=nrm([-28,-17,-39]),f=T.axisTargetFallback(pos,dir,[2,3,1]);
  const d=nrm(sub(f,pos));for(let k=0;k<3;k++)near(d[k],dir[k],1e-12)});
t("THE BUG: zoom with a guessed (scene-centre) target re-aims the camera; with the real target it does not",()=>{
  const pos=[30,20,40],realTarget=[2,3,1],sceneCenter=[-20,-5,10],anchor=[18,12,25];
  const dir0=nrm(sub(realTarget,pos));
  const bad=Z.perspectiveZoomAbout({pos,target:sceneCenter,anchor,factor:.7});
  const good=Z.perspectiveZoomAbout({pos,target:realTarget,anchor,factor:.7});
  const dBad=nrm(sub(bad.target,bad.pos)),dGood=nrm(sub(good.target,good.pos));
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  assert.ok(1-dot(dir0,dBad)>1e-3,"guessed target should rotate (control)");
  assert.ok(1-dot(dir0,dGood)<1e-12,"real target must not rotate")});
t("no source file reads the orbit target through `.target?.isVector3` without getTarget first",()=>{
  for(const f of ["src/features/camera-tools.ts","src/features/navigation.ts","src/features/viewcube.ts","src/features/walk-mode.ts","src/features/saved-views.ts","src/features/selection-orbit-pivot.ts","src/modules/issues/issues.ts"]){
    const s=fs.readFileSync(path.join(__dirname,"..",f),"utf8");
    assert.ok(!/controls\??\.target\?\.isVector3\s*\)\s*(return|\{?\s*\w+\.copy)/.test(s)&&!/c\?\.target\?\.isVector3\) return/.test(s),f+" still reads controls.target directly");
    assert.ok(s.includes("readControlsTarget"),f+" does not use readControlsTarget")}});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
