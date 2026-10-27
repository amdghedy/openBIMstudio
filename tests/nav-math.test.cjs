const {execSync}=require("child_process");const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"nav-"));
execSync(`npx tsc src/modules/navigation/nav-math.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`,{stdio:"inherit"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const m=require(find(out,"nav-math.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const near=(a,b,e=1e-6)=>assert.ok(Math.abs(a-b)<e,`${a}!=${b}`);
const nv=(a,b,e=1e-6)=>{for(let i=0;i<a.length;i++)near(a[i],b[i],e)};
const D=m.DEFAULT_ORIENTATION;

t("default faces match the existing gotoExactView table",()=>{
  nv(m.viewForCell(D,[0,0,1]).dir,[0,0,1]);nv(m.viewForCell(D,[0,0,1]).up,[0,1,0]);
  nv(m.viewForCell(D,[0,0,-1]).dir,[0,0,-1]);nv(m.viewForCell(D,[1,0,0]).dir,[1,0,0]);nv(m.viewForCell(D,[-1,0,0]).dir,[-1,0,0]);
  nv(m.viewForCell(D,[0,1,0]).dir,[0,1,0]);nv(m.viewForCell(D,[0,1,0]).up,[0,0,-1]);
  nv(m.viewForCell(D,[0,-1,0]).dir,[0,-1,0]);nv(m.viewForCell(D,[0,-1,0]).up,[0,0,1])});
t("26 cells: 6 faces, 12 edges, 8 corners, each unit direction, up perpendicular and never zero",()=>{
  assert.strictEqual(m.ALL_CELLS.length,26);const k={face:0,edge:0,corner:0};
  for(const c of m.ALL_CELLS){k[m.cellKind(c)]++;const v=m.viewForCell(D,c);near(m.len(v.dir),1);near(m.len(v.up),1);near(m.dot(v.dir,v.up),0,1e-9)}
  assert.deepStrictEqual(k,{face:6,edge:12,corner:8})});
t("all 26 directions are distinct",()=>{const s=new Set(m.ALL_CELLS.map(c=>m.viewForCell(D,c).dir.map(x=>x.toFixed(5)).join()));assert.strictEqual(s.size,26)});
t("edge and corner directions are the normalised sums",()=>{nv(m.viewForCell(D,[1,1,0]).dir,[Math.SQRT1_2,Math.SQRT1_2,0]);const k=1/Math.sqrt(3);nv(m.viewForCell(D,[1,1,1]).dir,[k,k,k]);nv(m.viewForCell(D,[-1,1,-1]).dir,[-k,k,-k])});
t("edges and corners keep Top up (no roll); the top-front edge tilts up away from Front",()=>{const v=m.viewForCell(D,[0,1,1]);assert.ok(m.dot(v.up,[0,1,0])>0.5);const c=m.viewForCell(D,[1,1,1]);assert.ok(m.dot(c.up,[0,1,0])>0.5);const b=m.viewForCell(D,[0,-1,1]);assert.ok(m.dot(b.up,[0,1,0])>0.5)});
t("opposite faces never flip the up vector (side faces)",()=>{for(const c of [[0,0,1],[0,0,-1],[1,0,0],[-1,0,0]])nv(m.viewForCell(D,c).up,[0,1,0])});
t("Right = Top x Front",()=>nv(m.basisOf(D).right,[1,0,0]));
t("setFrontFromView: new front, top stays perpendicular and close to the old top",()=>{
  const o=m.setFrontFromView(D,[1,0,0]);nv(o.front,[1,0,0]);near(m.dot(o.front,o.top),0);nv(o.top,[0,1,0]);
  const tilted=m.setFrontFromView(D,m.norm([1,1,0]));near(m.dot(tilted.front,tilted.top),0);assert.ok(m.dot(tilted.top,[0,1,0])>0.7)});
t("setFrontFromView with the view along Top keeps a valid map",()=>{const o=m.setFrontFromView(D,[0,1,0]);near(m.len(o.front),1);near(m.len(o.top),1);near(m.dot(o.front,o.top),0)});
t("setTopFromView: new top, front perpendicular",()=>{const o=m.setTopFromView(D,[1,0,0]);nv(o.top,[1,0,0]);near(m.dot(o.front,o.top),0);nv(o.front,[0,0,1]);
  const same=m.setTopFromView(D,[0,0,1]);near(m.dot(same.front,same.top),0);near(m.len(same.front),1)});
t("custom Front changes where the Front face looks from; Right follows",()=>{const o=m.setFrontFromView(D,[1,0,0]);nv(m.viewForCell(o,[0,0,1]).dir,[1,0,0]);nv(m.viewForCell(o,[1,0,0]).dir,m.basisOf(o).right);nv(m.basisOf(o).right,[0,0,-1])});
t("reset orientation = the default map",()=>{const o=m.setTopFromView(m.setFrontFromView(D,[1,0,0]),[1,0,1]);assert.ok(!m.isDefaultOrientation(o));assert.ok(m.isDefaultOrientation(m.cloneOrientation(D)))});
t("normalizeOrientation repairs bad maps",()=>{assert.ok(m.isDefaultOrientation(m.normalizeOrientation(null)));assert.ok(m.isDefaultOrientation(m.normalizeOrientation({front:[NaN,0,0],top:[0,1,0]})));assert.ok(m.isDefaultOrientation(m.normalizeOrientation({front:[0,0,0],top:[0,1,0]})));
  const o=m.normalizeOrientation({front:[0,1,0],top:[0,1,0]});near(m.dot(o.front,o.top),0);near(m.len(o.top),1);const p=m.normalizeOrientation({front:[0,0,5],top:[0,3,3]});near(m.len(p.front),1);near(m.dot(p.front,p.top),0)});
t("nearestFaceCell and alignedFaceCell",()=>{assert.deepStrictEqual(m.nearestFaceCell(D,[0.2,0.1,1]),[0,0,1]);assert.deepStrictEqual(m.nearestFaceCell(D,[0,-1,0.1]),[0,-1,0]);
  assert.deepStrictEqual(m.alignedFaceCell(D,[0,0,1]),[0,0,1]);assert.strictEqual(m.alignedFaceCell(D,m.norm([0.1,0,1])),null);assert.deepStrictEqual(m.alignedFaceCell(D,m.norm([0.005,0,1])),[0,0,1])});
t("orbitStep: azimuth keeps radius and height; elevation moves up and is clamped at the pole",()=>{
  const p=m.orbitStep([10,0,0],[0,0,0],[0,1,0],Math.PI/2,0);nv(p,[0,0,-10],1e-9);
  const q=m.orbitStep([10,0,0],[0,0,0],[0,1,0],0,10*Math.PI/180);near(m.len(q),10);assert.ok(q[1]>0);near(Math.atan2(q[1],q[0])*180/Math.PI,10,1e-6);
  const top=m.orbitStep([10,0,0],[0,0,0],[0,1,0],0,Math.PI);assert.ok(top[1]>9.99&&Math.abs(top[0])<0.3);const bot=m.orbitStep([10,0,0],[0,0,0],[0,1,0],0,-Math.PI);assert.ok(bot[1]<-9.99);
  const off=m.orbitStep([1010,5,2000],[1000,5,2000],[0,1,0],Math.PI,0);nv(off,[990,5,2000],1e-9)});
t("orbitStep orbits the target, not the world origin",()=>{const p=m.orbitStep([1005,0,5000],[1000,0,5000],[0,1,0],Math.PI/2,0);near(m.len(m.sub(p,[1000,0,5000])),5)});
t("rollStep rotates up about the viewing axis, keeps it perpendicular",()=>{const u=m.rollStep([0,1,0],[0,0,1],Math.PI/2);nv(u,[-1,0,0],1e-9);near(m.dot(u,[0,0,1]),0)});
t("perspective and ortho framing",()=>{const d=m.perspectiveFitDistance(10,60,1.5,1);near(d,10/Math.sin(Math.PI/6));assert.ok(m.perspectiveFitDistance(10,60,0.5,1)>d);near(m.orthoFitHeight(10,1.5,1),20);near(m.orthoFitHeight(10,0.5,1),40);assert.ok(Number.isFinite(m.perspectiveFitDistance(0,60,NaN)))});
t("ortho <-> perspective equivalence round-trips",()=>{const h=m.visibleHeightAt(25,50);near(m.distanceForHeight(h,50),25,1e-9)});
t("boxSphere and validBox",()=>{const b={min:[0,0,0],max:[2,2,2]};assert.ok(m.validBox(b));near(m.boxSphere(b).radius,Math.sqrt(3));nv(m.boxSphere(b).center,[1,1,1]);assert.ok(!m.validBox({min:[0,0,0],max:[-1,2,2]}));assert.ok(!m.validBox({min:[NaN,0,0],max:[1,1,1]}));assert.ok(!m.validBox(null));
  const far={min:[1e6,0,1e6],max:[1e6+10,5,1e6+10]};nv(m.boxSphere(far).center,[1e6+5,2.5,1e6+5])});
const home={pos:[10,5,10],target:[0,0,0],up:[0,1,0],projection:"orthographic",fov:50,zoom:2,height:30};
t("validateHome accepts good data and rejects bad data",()=>{const h=m.validateHome(home);assert.strictEqual(h.projection,"orthographic");nv(h.pos,[10,5,10]);assert.strictEqual(m.validateHome(null),null);assert.strictEqual(m.validateHome({...home,pos:[NaN,0,0]}),null);assert.strictEqual(m.validateHome({...home,pos:[0,0,0]}),null);assert.strictEqual(m.validateHome({...home,up:[0,0,0]}),null);assert.strictEqual(m.validateHome("x"),null);
  const odd=m.validateHome({...home,fov:999,zoom:-3,height:NaN,projection:"weird"});assert.strictEqual(odd.projection,"perspective");assert.strictEqual(odd.fov,undefined);assert.strictEqual(odd.zoom,undefined);assert.strictEqual(odd.height,undefined)});
t("persistence round trip and corruption handling",()=>{const p={home:m.validateHome(home),orientation:m.setFrontFromView(D,[1,0,0]),mode:"perspective-ortho-faces"};const r=m.parsePersist(m.serializePersist(p));nv(r.home.pos,[10,5,10]);nv(r.orientation.front,[1,0,0]);assert.strictEqual(r.mode,"perspective-ortho-faces");
  for(const bad of [null,"","{","[]",'{"home":5,"orientation":7,"mode":"x"}']){const d=m.parsePersist(bad);assert.strictEqual(d.home,null);assert.ok(m.isDefaultOrientation(d.orientation));assert.strictEqual(d.mode,"perspective")}});
t("viewQuaternion + cubeMatrix3d: front view is the identity matrix",()=>{const q=m.viewQuaternion([0,0,1],[0,1,0]);const mat=m.cubeMatrix3d(q,D);const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];mat.forEach((v,i)=>near(v,I[i],1e-9))});
t("cube matrix: viewing from the right shows the Right face towards the viewer",()=>{const q=m.viewQuaternion([1,0,0],[0,1,0]);const mat=m.cubeMatrix3d(q,D);near(mat[8],-1,1e-9);near(mat[0],0,1e-9);near(mat[2],1,1e-9)}); // local +x (Right) now points at the viewer (+z css)
t("cube matrix: top view puts Top towards the viewer and Front at the bottom of the screen",()=>{const v=m.viewForCell(D,[0,1,0]);const mat=m.cubeMatrix3d(m.viewQuaternion(v.dir,v.up),D);near(mat[6],-1,1e-9);near(mat[9],1,1e-9);near(mat[10],0,1e-9)});
t("cube matrix is a pure rotation (det +1 in css space with the handedness flip)",()=>{for(const c of m.ALL_CELLS){const v=m.viewForCell(D,c);const a=m.cubeMatrix3d(m.viewQuaternion(v.dir,v.up),D);const col=(i)=>[a[i*4],a[i*4+1],a[i*4+2]];for(let i=0;i<3;i++)near(m.len(col(i)),1,1e-9);near(m.dot(col(0),col(1)),0,1e-9);near(m.dot(col(0),col(2)),0,1e-9)}});
t("every cell's own direction faces the viewer when the camera goes to it",()=>{for(const c of m.ALL_CELLS){const v=m.viewForCell(D,c);const q=m.viewQuaternion(v.dir,v.up);const inv=m.quatConj(q);const cam=m.quatRotate(inv,v.dir);near(cam[2],1,1e-9);near(cam[0],0,1e-9);near(cam[1],0,1e-9);const upc=m.quatRotate(inv,v.up);near(upc[1],1,1e-9)}});
t("north vectors and compass placement",()=>{nv(m.northVectors(0).north,[0,0,1]);nv(m.northVectors(0).east,[1,0,0]);nv(m.northVectors(90).north,[1,0,0],1e-9);nv(m.northVectors(90).east,[0,0,-1],1e-9);
  const n=m.compassLocal(D,[0,0,1]);near(n.x,0);near(n.z,1);const e=m.compassLocal(D,[1,0,0]);near(e.x,1);near(e.z,0);const z=m.compassLocal(D,[0,1,0]);near(z.x,0);near(z.z,0);
  const o=m.setFrontFromView(D,[1,0,0]);const n2=m.compassLocal(o,[0,0,1]);near(Math.abs(n2.x)+Math.abs(n2.z),1)});
t("cellName",()=>{assert.strictEqual(m.cellName([0,1,0]),"Top");assert.strictEqual(m.cellName([1,1,1]),"Top Front Right");assert.strictEqual(m.cellName([-1,0,-1]),"Back Left")});
t("slerp: endpoints, unit length, shortest arc between opposite faces, up stays valid",()=>{
  const a=m.viewQuaternion([0,0,1],[0,1,0]),b=m.viewQuaternion([0,0,-1],[0,1,0]);
  for(const k of [0,0.25,0.5,0.75,1]){const q=m.quatSlerp(a,b,k);near(Math.hypot(...q),1,1e-9);const v=m.quatRotate(q,[0,0,1]);assert.ok(Number.isFinite(v[0]+v[1]+v[2]));const u=m.quatRotate(q,[0,1,0]);near(m.len(u),1,1e-9);near(m.dot(u,v),0,1e-9)}
  nv(m.quatRotate(m.quatSlerp(a,b,0),[0,0,1]),[0,0,1],1e-9);nv(m.quatRotate(m.quatSlerp(a,b,1),[0,0,1]),[0,0,-1],1e-9);
  const mid=m.quatRotate(m.quatSlerp(a,b,0.5),[0,0,1]);near(Math.abs(mid[0])+Math.abs(mid[2])>0.99?1:0,1)});
t("slerp takes the short way (q and -q are the same rotation)",()=>{const a=m.viewQuaternion([0,0,1],[0,1,0]);const b=m.viewQuaternion([1,0,0],[0,1,0]);const nb=b.map(x=>-x);const m1=m.quatSlerp(a,b,0.5),m2=m.quatSlerp(a,nb,0.5);nv(m.quatRotate(m1,[0,0,1]),m.quatRotate(m2,[0,0,1]),1e-9)});
t("poseAt interpolates target, distance (log) and zoom",()=>{const a=m.poseFromView([0,0,0],[0,0,1],[0,1,0],10,1),b=m.poseFromView([10,0,0],[1,0,0],[0,1,0],40,4);const p=m.poseAt(a,b,0.5);nv(p.target,[5,0,0]);near(p.dist,20,1e-9);near(p.zoom,2,1e-9);nv(m.poseCameraPosition(m.poseAt(a,b,0)),[0,0,10],1e-9);nv(m.poseCameraPosition(m.poseAt(a,b,1)),[50,0,0],1e-9);near(m.poseAt(a,b,-5).dist,10);near(m.poseAt(a,b,9).dist,40)});
t("poseDirUp recovers dir and up",()=>{const v=m.viewForCell(D,[1,1,1]);const p=m.poseFromView([1,2,3],v.dir,v.up,7);const r=m.poseDirUp(p);nv(r.dir,v.dir,1e-9);nv(r.up,v.up,1e-9)});
t("easing is monotone 0..1",()=>{near(m.easeInOutCubic(0),0);near(m.easeInOutCubic(1),1);near(m.easeInOutCubic(0.5),0.5);let prev=-1;for(let i=0;i<=20;i++){const e=m.easeInOutCubic(i/20);assert.ok(e>=prev);prev=e}});
t("dirUpFromCamera handles a top view whose up is degenerate",()=>{const r=m.dirUpFromCamera([0,10,0],[0,0,0],[0,1,0]);near(m.len(r.up),1);near(m.dot(r.up,r.dir),0,1e-9);const q=m.dirUpFromCamera([3,4,5],[3,4,5],[0,1,0]);near(m.len(q.dir),1)});
t("sceneSimilar",()=>{const a={center:[0,0,0],radius:50};assert.ok(m.sceneSimilar(a,{center:[5,0,5],radius:55}));assert.ok(!m.sceneSimilar(a,{center:[500,0,0],radius:50}));assert.ok(!m.sceneSimilar(a,{center:[0,0,0],radius:5000}));assert.ok(!m.sceneSimilar({center:[0,0,0],radius:0},a))});
t("defaultHomePose frames the scene far from the origin and in both projections",()=>{const s={center:[2e6,10,3e6],radius:80};const p=m.defaultHomePose(s,"perspective",50,1.6);nv(p.target,[2e6,10,3e6]);assert.ok(m.len(m.sub(p.pos,p.target))>80);assert.ok(m.validateHome(p));const o=m.defaultHomePose(s,"orthographic",50,1.6);assert.ok(o.height>160&&m.validateHome(o));const tiny=m.defaultHomePose({center:[0,0,0],radius:0},"perspective",50,1);assert.ok(m.validateHome(tiny))});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
