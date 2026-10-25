const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"pf-"));
fs.mkdirSync(path.join(out,"src"),{recursive:true});
execSync(`npx tsc src/modules/projects/project-file.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const find=(d)=>{for(const f of fs.readdirSync(d)){const p=path.join(d,f);if(fs.statSync(p).isDirectory()){const r=find(p);if(r)return r}else if(f==="project-file.js")return p}};const m=require(find(out));
let pass=0,fail=0;const t=async(n,f)=>{try{await f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const doc={id:"p1",name:"Tower: Block A/B",createdAt:1,updatedAt:2,elements:[{id:"w1",type:"wall"}],models:[{id:"m1",name:"a.ifc",bytes:5}],planDimensions:[{x1:0}],planAnnotations:{tags:[{text:"W-1"}],notes:[]}};
const ifc=new Blob([Uint8Array.from([1,2,3,4,5])]), frag=new Blob([Uint8Array.from([9,8,7])]);
(async()=>{
await t("round trip keeps doc, dimensions, tags and model bytes",async()=>{
  const f=m.buildProjectFile(doc,[{modelId:"m1",name:"a.ifc",blob:ifc},{modelId:"m2",name:"b.frag",blob:frag}]);
  const r=await m.parseProjectFile(f);
  assert.deepStrictEqual(r.doc,doc);
  assert.strictEqual(r.blobs.length,2);
  assert.deepStrictEqual([...new Uint8Array(await r.blobs[0].blob.arrayBuffer())],[1,2,3,4,5]);
  assert.deepStrictEqual([...new Uint8Array(await r.blobs[1].blob.arrayBuffer())],[9,8,7]);
  assert.strictEqual(r.blobs[1].name,"b.frag");});
await t("project with no models",async()=>{const r=await m.parseProjectFile(m.buildProjectFile(doc,[]));assert.strictEqual(r.blobs.length,0);assert.strictEqual(r.doc.name,doc.name)});
await t("rejects non project file",async()=>{await assert.rejects(()=>m.parseProjectFile(new Blob(["hello world this is not it"])),/not an Open BIM Studio/)});
await t("rejects tiny file",async()=>{await assert.rejects(()=>m.parseProjectFile(new Blob(["x"])),/too small/)});
await t("rejects truncated file",async()=>{const f=m.buildProjectFile(doc,[{modelId:"m1",name:"a.ifc",blob:ifc}]);await assert.rejects(()=>m.parseProjectFile(f.slice(0,f.size-2)),/truncated/)});
await t("rejects corrupt header",async()=>{const bad=new Blob(["OBSPROJ1",Uint8Array.from([5,0,0,0]),"{nope"]);await assert.rejects(()=>m.parseProjectFile(bad),/unreadable header|damaged/)});
await t("rejects newer version",async()=>{const h=JSON.stringify({format:"obsproj",version:99,doc,blobs:[]});const j=new TextEncoder().encode(h);const l=new Uint8Array(4);new DataView(l.buffer).setUint32(0,j.length,true);await assert.rejects(()=>m.parseProjectFile(new Blob(["OBSPROJ1",l,j])),/newer version/)});
await t("file name is sanitised",()=>{assert.strictEqual(m.suggestedFileName(doc),"Tower_ Block A_B.obsproj");assert.strictEqual(m.suggestedFileName({name:""}),"project.obsproj")});
await t("large blob is sliced, not copied",async()=>{const big=new Blob([new Uint8Array(5_000_000)]);const r=await m.parseProjectFile(m.buildProjectFile(doc,[{modelId:"m1",name:"big.ifc",blob:big}]));assert.strictEqual(r.blobs[0].blob.size,5_000_000)});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
})();
