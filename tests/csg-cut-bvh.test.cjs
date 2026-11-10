/** Conservative finite-support BVH tests for Boolean cut candidates. */
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process");
const root=path.resolve(__dirname,".."),out=fs.mkdtempSync(path.join(os.tmpdir(),"obs-csg-cut-bvh-"));
execFileSync("npx",["tsc","--rootDir","src","--outDir",out,"--module","commonjs","--moduleResolution","node","--target","ES2022","--skipLibCheck","--noCheck","src/modules/solid-kernel/index.ts"],{cwd:root,stdio:"pipe"});
fs.writeFileSync(path.join(out,"package.json"),'{"type":"commonjs"}');
const {createAabbIndex,queryAabbIndex}=require(path.join(out,"modules/solid-kernel/csg-cut-index.js"));
const box=(x,y,z,r)=>({minX:x-r,minY:y-r,minZ:z-r,maxX:x+r,maxY:y+r,maxZ:z+r});
const overlaps=(a,b,e=1e-9)=>a.minX<=b.maxX+e&&a.maxX>=b.minX-e&&a.minY<=b.maxY+e&&a.maxY>=b.minY-e&&a.minZ<=b.maxZ+e&&a.maxZ>=b.minZ-e;

// Deterministic randomized parity against a brute-force finite-AABB scan.
let seed=0x51f15e;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x100000000;};
const entries=[];
for(let i=0;i<2500;i++){
  const n=1+(i%4);
  for(let j=0;j<n;j++)entries.push({itemIndex:i,bounds:box(random()*200-100,random()*200-100,random()*200-100,random()*2)});
}
const index=createAabbIndex(entries,2500);
for(let q=0;q<350;q++){
  const query=box(random()*220-110,random()*220-110,random()*220-110,random()*8);
  const expected=new Set(entries.filter(e=>overlaps(e.bounds,query)).map(e=>e.itemIndex));
  const actual=queryAabbIndex(index,query);
  assert.deepEqual(actual,[...expected].sort((a,b)=>a-b),`query ${q} differs from brute-force AABB scan`);
}

// Multiple finite patches for one infinite plane must all be represented.
const multi=createAabbIndex([
  {itemIndex:0,bounds:box(-20,0,0,1)},
  {itemIndex:0,bounds:box(20,0,0,1)},
  {itemIndex:1,bounds:box(0,0,0,1)},
],2);
assert.deepEqual(queryAabbIndex(multi,box(20,0,0,0)),[0]);
assert.deepEqual(queryAabbIndex(multi,box(0,0,0,0)),[1]);

// Invalid supports are conservative overflow; invalid queries fall back to every item.
const overflow=createAabbIndex([{itemIndex:1,bounds:{minX:NaN,minY:0,minZ:0,maxX:1,maxY:1,maxZ:1}}],3);
assert.deepEqual(queryAabbIndex(overflow,box(1000,1000,1000,0)),[1]);
assert.deepEqual(queryAabbIndex(index,{minX:NaN,minY:0,minZ:0,maxX:1,maxY:1,maxZ:1}),Array.from({length:2500},(_,i)=>i));

// The full Boolean fixtures remain the integration/parity gate for both operands.
const sk=require(path.join(out,"modules/solid-kernel/index.js"));
const a=sk.generateVoid({kind:"box",center:{x:0,y:0,z:0},size:{x:4,y:4,z:4}});
const b=sk.generateVoid({kind:"box",center:{x:1,y:0,z:0},size:{x:2,y:2,z:2}});
for(const op of ["union","intersect","subtract"]){
  const result=sk.generalBoolean(op,a,b);
  assert.ok(result.faces.length>0,`${op} must retain a non-empty result`);
  assert.ok(sk.meshVolume(result)>0,`${op} must retain positive volume`);
}
console.log("PASS: finite-support BVH matches brute-force AABB queries and preserves Boolean fixtures");
