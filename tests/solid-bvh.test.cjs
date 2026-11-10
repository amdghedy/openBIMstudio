/** Triangle BVH correctness and reuse tests. */
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process");
const root=path.resolve(__dirname,".."),out=fs.mkdtempSync(path.join(os.tmpdir(),"obs-solid-bvh-"));
execFileSync("npx",["tsc","--rootDir","src","--outDir",out,"--module","commonjs","--moduleResolution","node","--target","ES2022","--skipLibCheck","--noCheck","src/modules/solid-kernel/index.ts"],{cwd:root,stdio:"pipe"});
fs.writeFileSync(path.join(out,"package.json"),'{"type":"commonjs"}');
const sk=require(path.join(out,"modules/solid-kernel/index.js"));
const box=(x,y,z,s)=>sk.generateVoid({kind:"box",center:{x,y,z},size:{x:s,y:s,z:s}});
function bruteRay(mesh,origin,dir){
 let crossings=0,eps=1e-9;
 for(const [ia,ib,ic] of mesh.faces){
  const v0=mesh.vertices[ia],v1=mesh.vertices[ib],v2=mesh.vertices[ic];
  const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
  const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
  const cross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
  const e1=sub(v1,v0),e2=sub(v2,v0),pv=cross(dir,e2),det=dot(e1,pv);
  if(Math.abs(det)<eps)continue;
  const inv=1/det,tv=sub(origin,v0),u=dot(tv,pv)*inv;
  if(u < -eps || u > 1+eps)continue;
  const qv=cross(tv,e1),v=dot(dir,qv)*inv;
  if(v < -eps || u+v > 1+eps)continue;
  if(dot(e2,qv)*inv>eps)crossings++;
 }
 return crossings%2===1;
}
function bruteRobust(mesh,p){
 const dirs=[[2,3,5],[-3,5,2],[5,-2,3]];
 return dirs.filter(d=>{const l=Math.hypot(...d);return bruteRay(mesh,p,{x:d[0]/l,y:d[1]/l,z:d[2]/l});}).length>=2;
}
const simple=box(0,0,0,2);
const bvh=sk.createTriangleBvh(simple);
assert.equal(bvh.triangleCount,simple.faces.length);
assert.equal(sk.pointInsideMeshWithBvh(bvh,{x:0,y:0,z:0},{x:1,y:0.2,z:0.1}),true);
assert.equal(sk.pointInsideMeshWithBvh(bvh,{x:3,y:0,z:0},{x:1,y:0.2,z:0.1}),false);
assert.equal(sk.isInsideRobust(simple,{x:0,y:0,z:0}),true);
assert.equal(sk.isInsideRobust(simple,{x:3,y:0,z:0}),false);
assert.equal(sk.createTriangleBvh({vertices:[],faces:[]}).root,null);

// A large disconnected shell fixture checks BVH traversal against the original full scan.
const vertices=[],faces=[];
for(let i=0;i<350;i++){
 const m=box(i*5,Math.sin(i)*7,Math.cos(i)*7,1),offset=vertices.length;
 vertices.push(...m.vertices);
 for(const f of m.faces)faces.push(f.map(v=>v+offset));
}
const large={vertices,faces},largeBvh=sk.createTriangleBvh(large);
assert.equal(largeBvh.triangleCount,large.faces.length);
const queries=[
 {x:0,y:0,z:0},{x:0.6,y:0,z:0},{x:-2,y:0,z:0},
 {x:250,y:Math.sin(50)*7,z:Math.cos(50)*7},
 {x:5000,y:200,z:-300}
];
for(const p of queries){
 const d={x:2/Math.sqrt(38),y:3/Math.sqrt(38),z:5/Math.sqrt(38)};
 assert.equal(sk.pointInsideMeshWithBvh(largeBvh,p,d),bruteRay(large,p,d),`ray mismatch at ${JSON.stringify(p)}`);
 assert.equal(sk.createRobustInsideTester(large)(p),bruteRobust(large,p),`robust mismatch at ${JSON.stringify(p)}`);
}
const reusable=sk.createRobustInsideTester(large);
assert.equal(reusable({x:0,y:0,z:7}),true);
assert.equal(reusable({x:3,y:0,z:7}),false);
console.log(`PASS: triangle BVH matches brute-force ray tests across ${large.faces.length} triangles`);
