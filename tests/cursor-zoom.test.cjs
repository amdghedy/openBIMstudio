const {execSync}=require("child_process");const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"cz-"));
execSync(`npx tsc src/core/cursor-zoom.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`,{stdio:"inherit"});
const m=require(path.join(out,"cursor-zoom.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const near=(a,b,e=1e-9)=>assert.ok(Math.abs(a-b)<e,`${a}!=${b}`);
const sub=(a,b)=>a.map((v,i)=>v-b[i]),dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],norm=a=>{const l=Math.hypot(...a);return a.map(v=>v/l)};
/* independent oracle: camera basis from pos/target/up, project to NDC */
function basis(pos,target,up=[0,1,0]){const f=norm(sub(target,pos));const r=norm(cross(f,up));const u=cross(r,f);return{f,r,u}}
function ndcPersp(pos,target,p,fovDeg=50,aspect=1.6){const b=basis(pos,target);const v=sub(p,pos);const z=dot(v,b.f);const th=Math.tan(fovDeg*Math.PI/360);return[dot(v,b.r)/(z*th*aspect),dot(v,b.u)/(z*th)]}
function ndcOrtho(pos,target,zoom,p,halfH=5,aspect=1.6){const b=basis(pos,target);const v=sub(p,pos);return[dot(v,b.r)*zoom/(halfH*aspect),dot(v,b.u)*zoom/halfH]}
/* anchor under a given ndc at a given depth along the view */
function pointAt(pos,target,nx,ny,depth,fovDeg=50,aspect=1.6){const b=basis(pos,target);const th=Math.tan(fovDeg*Math.PI/360);return pos.map((v,i)=>v+b.f[i]*depth+b.r[i]*nx*aspect*th*depth+b.u[i]*ny*th*depth)}

const pos=[30,20,40],target=[2,3,1];
const NDCS=[[0,0],[.9,.9],[-.9,.9],[.9,-.9],[-.9,-.9],[0,.95],[0,-.95],[.95,0],[-.95,0],[.3,-.6]];
for(const depth of [3,12,50,400]) for(const [nx,ny] of NDCS)for(const f of [0.6,1.0 /*no-op*/,1.7]){
  t(`perspective: anchor at ndc(${nx},${ny}), depth ${depth}, factor ${f} stays under the pointer; orientation unchanged`,()=>{
    const a=pointAt(pos,target,nx,ny,depth);const r=m.perspectiveZoomAbout({pos,target,anchor:a,factor:f});
    const [x0,y0]=ndcPersp(pos,target,a),[x1,y1]=ndcPersp(r.pos,r.target,a);near(x0,nx,1e-9);near(x1,nx,1e-9);near(y1,ny,1e-9);
    const d0=norm(sub(target,pos)),d1=norm(sub(r.target,r.pos));for(let k=0;k<3;k++)near(d0[k],d1[k],1e-12);
    near(Math.hypot(...sub(r.target,r.pos)),Math.hypot(...sub(target,pos))*r.factor,1e-9)})}
t("zoom out then in by the same wheel notch returns to the start (no drift over 200 cycles)",()=>{
  let p=pos,tg=target;const a=pointAt(pos,target,.7,-.4,30);
  for(let i=0;i<200;i++){const fi=m.wheelDistanceFactor(-100,0),fo=m.wheelDistanceFactor(100,0);
    let r=m.perspectiveZoomAbout({pos:p,target:tg,anchor:a,factor:fi});p=r.pos;tg=r.target;r=m.perspectiveZoomAbout({pos:p,target:tg,anchor:a,factor:fo});p=r.pos;tg=r.target}
  for(let k=0;k<3;k++){near(p[k],pos[k],1e-6);near(tg[k],target[k],1e-6)}});
t("many ticks in keep the anchor pinned and never pass through it",()=>{
  let p=pos,tg=target;const a=pointAt(pos,target,-.8,.5,25);
  for(let i=0;i<60;i++){const r=m.perspectiveZoomAbout({pos:p,target:tg,anchor:a,factor:m.wheelDistanceFactor(-100,0)});if(!r)break;p=r.pos;tg=r.target;
    const [x,y]=ndcPersp(p,tg,a);near(x,-.8,1e-6);near(y,.5,1e-6)}
  assert.ok(Math.hypot(...sub(a,p))>0,"camera did not reach the anchor")});
t("anchor behind the camera or non-finite -> null (caller uses the plane fallback), never a jump",()=>{
  assert.strictEqual(m.perspectiveZoomAbout({pos,target,anchor:[60,40,80],factor:.8}),null);
  assert.strictEqual(m.perspectiveZoomAbout({pos,target,anchor:[NaN,0,0],factor:.8}),null);
  assert.strictEqual(m.perspectiveZoomAbout({pos,target:pos,anchor:target,factor:.8}),null);
  assert.strictEqual(m.perspectiveZoomAbout({pos,target,anchor:target,factor:0}),null)});
t("minimum camera distance is respected",()=>{const r=m.perspectiveZoomAbout({pos:[0,0,1],target:[0,0,0],anchor:[0,0,0],factor:.15,minDist:.5});assert.ok(Math.hypot(...sub(r.target,r.pos))>=.5-1e-9)});
t("wheel factor: symmetric, monotonic, clamped, trackpad-proportional, line/page modes",()=>{
  near(m.wheelDistanceFactor(100,0)*m.wheelDistanceFactor(-100,0),1,1e-12);
  assert.ok(m.wheelDistanceFactor(-100,0)<1&&m.wheelDistanceFactor(100,0)>1);
  assert.strictEqual(m.wheelDistanceFactor(0,0),1);assert.strictEqual(m.wheelDistanceFactor(NaN,0),1);
  near(m.wheelDistanceFactor(100000,0),m.wheelDistanceFactor(100,0));
  assert.ok(Math.abs(Math.log(m.wheelDistanceFactor(4,0))*25-Math.log(m.wheelDistanceFactor(100,0)))<1e-9,"small trackpad deltas scale linearly");
  near(m.wheelDistanceFactor(3,1),m.wheelDistanceFactor(48,0));
  assert.ok(m.wheelDistanceFactor(-50,0,10,true)<m.wheelDistanceFactor(-50,0,10,false))});
t("pointerNdc uses the real viewport rect (not the window) and rejects outside / invalid",()=>{
  const rect={left:300,top:80,width:800,height:600};
  const c=m.pointerNdc(700,380,rect);near(c.x,0);near(c.y,0);
  const tl=m.pointerNdc(300,80,rect);near(tl.x,-1);near(tl.y,1);
  assert.strictEqual(m.pointerNdc(100,380,rect),null);assert.strictEqual(m.pointerNdc(700,380,{...rect,width:0}),null);assert.strictEqual(m.pointerNdc(NaN,1,rect),null)});
t("planeAnchor: pointer ray meets the camera-facing plane through the target; parallel/diverging -> null",()=>{
  const f=norm(sub(target,pos));const a=pointAt(pos,target,.5,.5,Math.hypot(...sub(target,pos)));
  const ray=norm(sub(a,pos));const h=m.planeAnchor(pos,ray,target,f);for(let k=0;k<3;k++)near(h[k],a[k],1e-9);
  assert.strictEqual(m.planeAnchor(pos,cross(f,[0,1,0]),target,f),null);assert.strictEqual(m.planeAnchor(pos,f.map(v=>-v),target,f),null)});
for(const [nx,ny] of NDCS)for(const f of [0.6,1.7]) t(`orthographic: anchor at ndc(${nx},${ny}) stays under the pointer, zoom ${f<1?"in":"out"}, orientation unchanged`,()=>{
  const opos=[10,10,10],otg=[0,0,0],zoom=1.3;const a=pointAt(opos,otg,0,0,1).map((v,i)=>v+basis(opos,otg).r[i]*nx*4+basis(opos,otg).u[i]*ny*2.5);
  const [x0,y0]=ndcOrtho(opos,otg,zoom,a);const r=m.orthoZoomAbout({pos:opos,target:otg,anchor:a,zoom,factor:f});
  const [x1,y1]=ndcOrtho(r.pos,r.target,r.zoom,a);near(x1,x0,1e-9);near(y1,y0,1e-9);
  assert.ok(f<1?r.zoom>zoom:r.zoom<zoom);const d0=norm(sub(otg,opos)),d1=norm(sub(r.target,r.pos));for(let k=0;k<3;k++)near(d0[k],d1[k],1e-12);
  near(Math.hypot(...sub(r.target,r.pos)),Math.hypot(...sub(otg,opos)),1e-9)});
t("orthographic zoom clamps keep the anchor pinned",()=>{
  const opos=[0,0,10],otg=[0,0,0],a=[3,2,-4];let z=4900,p=opos,tg=otg;
  for(let i=0;i<5;i++){const [x0,y0]=ndcOrtho(p,tg,z,a);const r=m.orthoZoomAbout({pos:p,target:tg,anchor:a,zoom:z,factor:.5});const [x1,y1]=ndcOrtho(r.pos,r.target,r.zoom,a);near(x1,x0,1e-9);near(y1,y0,1e-9);p=r.pos;tg=r.target;z=r.zoom}
  assert.ok(z<=5000)});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
