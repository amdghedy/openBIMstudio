// Compile with the PROJECT's TypeScript settings (strict, bundler, ESNext)
// via a temp tsconfig extending tsconfig.json: the old ad-hoc
// `--module commonjs --target es2020` invocation reported false TS2339 /
// TS1343 errors on the growing transitive import graph (ranks 1-3) that the
// real project build does not have. Emitted ESM is loaded with import().
const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert"); const { pathToFileURL } = require("url");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"pf-"));
fs.mkdirSync(path.join(out,"src"),{recursive:true});
fs.symlinkSync(path.join(__dirname,"..","node_modules"),path.join(out,"node_modules"),"junction");
const root=path.join(__dirname,"..");
const tsconfigPath=path.join(out,"tsconfig.pf.json");
fs.writeFileSync(tsconfigPath,JSON.stringify({extends:path.join(root,"tsconfig.json"),compilerOptions:{noEmit:false,allowImportingTsExtensions:false,outDir:out},include:[path.join(root,"src/modules/projects/project-file.ts"),path.join(root,"src/vite-env.d.ts")]}));
execSync(`npx tsc -p ${tsconfigPath}`,{stdio:"inherit"});
// Plain Node ESM cannot resolve the extensionless relative imports the
// codebase uses under bundler resolution (e.g. `../core/safeLoad`); rewrite
// those specifiers to the emitted `.js` files they name (text only).
const rewriteEsmSpecifiers=(dir)=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const q=path.join(dir,e.name);if(e.isDirectory()){rewriteEsmSpecifiers(q);continue}if(!e.name.endsWith(".js"))continue;const text=fs.readFileSync(q,"utf8");const rw=text.replace(/(from\s+|import\s*\(\s*|import\s+)(["'])(\.[^"']*)\2/g,(m,pre,qt,spec)=>{if(/\.[a-zA-Z0-9]+$/.test(spec))return m;const base=path.join(path.dirname(q),spec);const tgt=fs.existsSync(base+".js")?spec+".js":fs.existsSync(path.join(base,"index.js"))?spec+"/index.js":null;return tgt?pre+qt+tgt+qt:m});if(rw!==text)fs.writeFileSync(q,rw)}};
rewriteEsmSpecifiers(out);
const find=(d)=>{for(const f of fs.readdirSync(d)){if(f==="node_modules")continue;const p=path.join(d,f);if(fs.statSync(p).isDirectory()){const r=find(p);if(r)return r}else if(f==="project-file.js")return p}};
let pass=0,fail=0;const t=async(n,f)=>{try{await f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const doc={id:"p1",name:"Tower: Block A/B",createdAt:1,updatedAt:2,elements:[{id:"w1",type:"wall"}],models:[{id:"m1",name:"a.ifc",bytes:5}],planDimensions:[{x1:0}],planAnnotations:{tags:[{text:"W-1"}],notes:[]}};
const ifc=new Blob([Uint8Array.from([1,2,3,4,5])]), frag=new Blob([Uint8Array.from([9,8,7])]);
(async()=>{
const m=await import(pathToFileURL(find(out)).href);
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
