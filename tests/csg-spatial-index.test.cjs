/** Spatial-index regression tests for convex and general CSG helpers. */
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process");
const root=path.resolve(__dirname,".."),out=fs.mkdtempSync(path.join(os.tmpdir(),"obs-csg-index-"));
execFileSync("npx",["tsc","--rootDir","src","--outDir",out,"--module","commonjs","--moduleResolution","node","--target","ES2022","--skipLibCheck","--noCheck","src/modules/solid-kernel/index.ts"],{cwd:root,stdio:"pipe"});
fs.writeFileSync(path.join(out,"package.json"),'{"type":"commonjs"}');
const sk=require(path.join(out,"modules/solid-kernel/index.js"));
const box=(x,y,z,s)=>sk.generateVoid({kind:"box",center:{x,y,z},size:{x:s,y:s,z:s}});
const base=box(0,0,0,2);
assert.equal(sk.planesOfConvex(base).length,6);
assert.equal(sk.allPlanesOf(base).length,6);

// Thousands of coplanar duplicate triangles must still resolve to the same six planes.
const repeated={vertices:base.vertices,faces:Array.from({length:4000},(_,i)=>base.faces[i%base.faces.length])};
assert.equal(sk.planesOfConvex(repeated).length,6);
assert.equal(sk.allPlanesOf(repeated).length,6);

// Extreme plane offsets fall back to exact legacy comparison instead of being lost in the hash.
const far=box(1e8,-1e8,5e7,2);
assert.equal(sk.planesOfConvex(far).length,6);
assert.equal(sk.allPlanesOf(far).length,6);

// Polygon-soup welding preserves component-wise tolerance and earliest canonical vertex.
const points=[{x:0,y:0,z:0},{x:0.5e-7,y:0,z:0},{x:1.5e-7,y:0,z:0}];
const welded=sk.weldMesh({vertices:points,faces:[[0,1,2]]});
assert.equal(welded.vertices.length,2);
assert.deepEqual(welded.faces,[]); // first two vertices collapse; degenerate triangle removed

// Spatially separated points should not trigger a full pairwise scan.
const many=Array.from({length:50000},(_,i)=>({x:i*0.01,y:(i%13)*0.01,z:0}));
assert.equal(sk.weldMesh({vertices:many,faces:[]}).vertices.length,50000);
console.log("PASS: CSG plane indexing, overflow fallback, duplicate-plane and weldMesh scale tests");
