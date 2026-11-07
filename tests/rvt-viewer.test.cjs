// View-only Revit support: pure logic with a FAKE decoder, plus wiring checks.
// NOT tested with the real rvt-rs wasm or a real .rvt file (neither can be built/obtained in this environment).
const { execSync } = require("child_process"); const fs=require("fs"); const os=require("os"); const path=require("path");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"rvt-"));
execSync(`npx tsc src/modules/rvt/rvt-core.ts --outDir ${out} --module commonjs --target es2022 --lib es2022,dom --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const files=[];(function w(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);fs.statSync(p).isDirectory()?w(p):files.push(p)}})(out);
const m=require(files.find(f=>f.endsWith("rvt-core.js")));
let pass=0,fail=0;const t=(n,fn)=>{try{fn();pass++;console.log("  PASS",n)}catch(e){fail++;console.log("  FAIL",n+": "+e.message)}};
const ok=(c,msg)=>{if(!c)throw new Error(msg||"assert")};
const OLE=[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1];
const file=(n=64)=>{const b=new Uint8Array(n);b.set(OLE);return b};
const read=p=>fs.readFileSync(p,"utf8");

t("extension check covers rvt/rfa/rte/rft, case-insensitive",()=>{for(const n of["a.rvt","A.RVT","x.rfa","t.rte","t.rft"])ok(m.isRevitName(n),n);for(const n of["a.ifc","rvt","a.rvt.txt"])ok(!m.isRevitName(n),n);});
t("container header: OLE2 accepted, HTML/zip/short rejected",()=>{ok(m.hasRevitContainerHeader(file()));ok(!m.hasRevitContainerHeader(new TextEncoder().encode("<!doctype html>")));ok(!m.hasRevitContainerHeader(new Uint8Array([0x50,0x4b,3,4,0,0,0,0])));ok(!m.hasRevitContainerHeader(new Uint8Array(3)));});
t("wasm bytes check tells real wasm from an SPA HTML fallback",()=>{ok(m.isWasmBytes(new Uint8Array([0,0x61,0x73,0x6d,1,0,0,0])));ok(!m.isWasmBytes(new TextEncoder().encode("<!doctype html>")));ok(!m.isWasmBytes(new Uint8Array(2)));});
t("preflight: ok, wrong name, empty, bad header, too large, large warning",()=>{ok(m.preflight("a.rvt",file()).ok);ok(!m.preflight("a.txt",file()).ok);ok(!m.preflight("a.rvt",new Uint8Array(0)).ok);const bad=m.preflight("a.rvt",new Uint8Array(100));ok(!bad.ok&&/header|damaged/.test(bad.reason));const big={length:m.RVT_MAX_BYTES+1};
  // size checks must not need to allocate: emulate with a fake Uint8Array-like
  const fake=Object.assign(file(16),{});Object.defineProperty(fake,"length",{value:m.RVT_MAX_BYTES+1});const r=m.preflight("a.rvt",fake);ok(!r.ok&&/IFC/.test(r.reason),JSON.stringify(r));const w=Object.assign(file(16),{});Object.defineProperty(w,"length",{value:m.RVT_WARN_BYTES+1});const rw=m.preflight("a.rvt",w);ok(rw.ok&&rw.warn,"warn");});

const glb=new Uint8Array(40);
const fakeApi=(over={})=>({calls:[],openRvtBytesWithDiagnosticsModeAndOpenLimits(bytes,mode,limits,onStage){this.calls.push({mode,limits});onStage("element-decode",1,2);return{model:{m:1},diagnostics:{confidence:{level:"geometry",score:0.8},exported:{building_elements:10,building_elements_with_geometry:7}},phases:[{id:1}]}},modelToGlb(){return glb},buildSceneGraph:x=>x,distinctIfcTypes:()=>["IfcWall","IfcDoor"],...over});
t("decodeRevit: scaffold mode, stage + step hooks, glb and types returned",()=>{const api=fakeApi();const steps=[],stages=[];const r=m.decodeRevit(api,file(),{step:s=>steps.push(s),stage:(s,d,t)=>stages.push([s,d,t])});ok(api.calls[0].mode==="scaffold"&&api.calls[0].limits===null);ok(r.glb===glb&&r.types.join()==="IfcWall,IfcDoor"&&r.phases.length===1);ok(steps.length===2&&stages[0][0]==="element-decode");});
t("decodeRevit: largeModel flag passes the limits object",()=>{const api=fakeApi();m.decodeRevit(api,file(),{},{largeModel:true});ok(api.calls[0].limits.largeModel===true);});
t("decodeRevit: decoder errors propagate; empty glb and missing model are errors",()=>{let e;try{m.decodeRevit(fakeApi({openRvtBytesWithDiagnosticsModeAndOpenLimits(){throw new Error("boom")}}),file())}catch(x){e=x}ok(e&&/boom/.test(e.message));e=null;try{m.decodeRevit(fakeApi({modelToGlb:()=>new Uint8Array(3)}),file())}catch(x){e=x}ok(e&&/no 3D/.test(e.message));e=null;try{m.decodeRevit(fakeApi({openRvtBytesWithDiagnosticsModeAndOpenLimits:()=>({})}),file())}catch(x){e=x}ok(e&&/no model/.test(e.message));});
t("decodeRevit: a failing type list does not fail the decode",()=>{const r=m.decodeRevit(fakeApi({distinctIfcTypes(){throw new Error("x")}}),file());ok(r.types.length===0&&r.glb===glb);});

t("summary: drawable model states confidence and that it is a reconstruction",()=>{const s=m.summarizeDiagnostics({confidence:{level:"geometry",score:0.83},exported:{building_elements:10,building_elements_with_geometry:7},input:{revit_version:2024,release_support:{status:"partial",capability:null}}},1234);ok(s.drawable&&s.confidencePct===83&&s.withGeometry===7);ok(/83%/.test(s.headline)&&/not Revit's own display/.test(s.headline)&&/2024/.test(s.headline)&&/partial/.test(s.headline));});
t("summary: scaffold decode with no geometry is NOT presented as success",()=>{const s=m.summarizeDiagnostics({confidence:{level:"scaffold",score:0.25},exported:{building_elements:0,building_elements_with_geometry:0}});ok(!s.drawable&&/Nothing to draw/.test(s.headline)&&/project structure only/.test(s.headline)&&/IFC/.test(s.headline));});
t("summary: geometry reported but zero triangles drawn => not drawable",()=>{const s=m.summarizeDiagnostics({exported:{building_elements:3,building_elements_with_geometry:3}},0);ok(!s.drawable);});
t("summary: unread streams are mentioned; missing diagnostics do not throw",()=>{const s=m.summarizeDiagnostics({exported:{building_elements_with_geometry:0},skipped:[{count:2}]});ok(/could not be read/.test(s.headline));ok(m.summarizeDiagnostics(null).drawable===false);ok(m.summarizeDiagnostics(undefined).warnings.length===0);});
t("summary: warnings capped and truncated",()=>{const s=m.summarizeDiagnostics({warnings:Array.from({length:9},()=>"w".repeat(500))});ok(s.warnings.length===5&&s.warnings[0].length===200);});
t("view file name keeps it recognisable and filesystem-safe",()=>{ok(m.viewFileName("Tower A.rvt")==="Tower A (Revit view).glb");ok(!/[\\/:*?"<>|]/.test(m.viewFileName("a/b:c.RVT")));ok(m.viewFileName(".rvt")==="Revit model (Revit view).glb"||m.viewFileName(".rvt").endsWith("(Revit view).glb"));});

/* ── wiring ── */
t("importFiles routes Revit files to the viewer and keeps the guidance fallback",()=>{const s=read("src/features/file-interop.ts");ok(/e === "rvt" \|\| e === "rfa" \|\| e === "rte" \|\| e === "rft"/.test(s)&&/rvt-viewer/.test(s));ok(/DESKTOP_ONLY\[e\]/.test(s)&&/rvt:/.test(s),"fallback guidance removed");});
t("entry points: ribbon, command palette",()=>{ok(/View Revit File/.test(read("src/shell/ribbon.ts")));ok(/file\.view-rvt/.test(read("src/features/command-palette.ts")));});
t("viewer is view-only and probes real wasm bytes, not just HTTP 200",()=>{const s=read("src/features/rvt-viewer.ts");ok(/isWasmBytes/.test(s)&&/View-only/.test(s)&&/nothing is uploaded/i.test(s));});
t("worker loads only same-origin /rvt/ files",()=>{const s=read("src/workers/rvt.worker.ts");ok(/\/rvt\/rvt\.js/.test(s)&&/\/rvt\/rvt_bg\.wasm/.test(s)&&!/https?:\/\//.test(s.replace(/\/\/ .*|\/\*[\s\S]*?\*\//g,"")));});
t("CSP already allows same-origin wasm + workers (no new origins needed)",()=>{const h=read("index.html");ok(/script-src 'self' 'wasm-unsafe-eval'/.test(h)&&/worker-src 'self' blob:/.test(h));});
t("build script pins a full commit SHA, verifies it, never fails a plain build",()=>{const s=read("scripts/build-rvt-wasm.mjs");const sha=(s.match(/RVT_RS_COMMIT = "([0-9a-f]+)"/)||[])[1];ok(sha&&sha.length===40,"pin");ok(/head !== RVT_RS_COMMIT/.test(s)&&/strict \? 1 : 0/.test(s));});
t("decoder is built by a manual workflow that smoke-tests it and pushes it to a branch; licence + notice tracked",()=>{const w=read(".github/workflows/rvt-build.yml");ok(/workflow_dispatch/.test(w)&&/rvt-smoke\.mjs/.test(w)&&/--expect-glb/.test(w)&&/git add -f public\/rvt\/rvt\.js public\/rvt\/rvt_bg\.wasm/.test(w)&&/--strict/.test(w));ok(!/public\/rvt\/rvt_bg\.wasm/.test(read(".gitignore")),"wasm must not be ignored");ok(/Apache License/.test(read("public/rvt/LICENSE-rvt-rs.txt"))&&/Autodesk/.test(read("public/rvt/NOTICE-rvt-rs.txt")));});
t("unavailable message names the concrete reason",()=>{const s=read("src/features/rvt-viewer.ts");ok(/answered \$\{w\.status\}/.test(s)&&/Detail:/.test(s));});

// Real WebAssembly decoder, when present (committed under public/rvt/). Synthetic fixture: proves the pipeline runs, not geometry quality.
(async()=>{
  if(!fs.existsSync("public/rvt/rvt_bg.wasm")){console.log("  SKIP real decoder tests (public/rvt/rvt_bg.wasm not built)");return;}
  const api=await import(require("url").pathToFileURL(path.resolve("public/rvt/rvt.js")).href);
  await api.default({module_or_path:fs.readFileSync("public/rvt/rvt_bg.wasm")});
  const bytes=new Uint8Array(fs.readFileSync("tests/fixtures/rvt/architectural-2024.rvt"));
  t("REAL wasm: decodeRevit runs on a real Revit-format file and returns a glTF binary",()=>{const stages=[];const r=m.decodeRevit(api,bytes,{stage:s=>stages.push(s)});ok(Buffer.from(r.glb.slice(0,4)).toString("latin1")==="glTF","glb magic");ok(stages.includes("schema-parse"),"stage hook");ok(r.diagnostics.input.revit_version===2024,"version");});
  t("REAL wasm: synthetic scaffold file is reported as NOT drawable (honest summary)",()=>{const r=m.decodeRevit(api,bytes);const s=m.summarizeDiagnostics(r.diagnostics);ok(!s.drawable&&s.confidencePct===25&&/Nothing to draw/.test(s.headline),s.headline);});
  t("REAL wasm: garbage input throws instead of hanging or crashing the page",()=>{let e;try{m.decodeRevit(api,new Uint8Array(4096).fill(7))}catch(x){e=x}ok(e,"expected an error");});
})().then(()=>{console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0)});
