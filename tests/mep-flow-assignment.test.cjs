const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"mfa-"));
execSync(`npx tsc src/modules/mep/flow-assignment.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const m=require(find(out,"flow-assignment.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};

const run=(id,type,s,e,extra={},props={})=>({id,type,params:{start:s,end:e,elevation:3,height:0.3,thickness:0.3,...extra},properties:props});
const fit=(id,pt,kind,aIn,aOut,extra={})=>({id,type:"fitting",params:{point:pt,elevation:3,height:0.3,thickness:0.3,fittingKind:kind,angleIn:aIn,angleOut:aOut,parentType:"duct",bendRadius:0.45,...extra},properties:{}});
const eq=(id,pt,extra={},props={})=>({id,type:"equipment",params:{point:pt,elevation:2.8,height:0.6,thickness:0.6,depth:0.6,...extra},properties:props});

// Topology (proven geometry from mep-connectivity tests):
// AHU(0,0) - m1 (0,0)->(3.8,0) - tee T(5,0) in=0,out=pi/2 - m2 (6.2,0)->(10,0) - D2(10,0)
//                                            \- br (5,0.9)->(5,6) - D1(5,6)
const AHU=eq("AHU",[0,0],{},{isSource:true});
const m1=run("m1","duct",[0,0],[3.8,0],{},{system:"supply-air"});
const T=fit("T",[5,0],"tee",0,Math.PI/2);
const m2=run("m2","duct",[6.2,0],[10,0],{},{system:"supply-air"});
const br=run("br","duct",[5,0.9],[5,6],{},{system:"supply-air"});
const D1=eq("D1",[5,6],{},{flowRate:850,flowUnit:"cfm"});   // 850 CFM → ~0.401 m³/s
const D2=eq("D2",[10,0],{},{flowRate:0.4,flowUnit:"m3s"});  // native m³/s
const MODEL=[AHU,m1,T,m2,br,D1,D2];

t("builds segments with upstream→downstream orientation",()=>{
  const b=m.buildNetworkFromElements(MODEL);
  assert.strictEqual(b.segments.length,3);
  for (const s of b.segments) {
    if (s.id==="m1") { assert.strictEqual(s.from, "AHU"); assert.ok(s.to !== "AHU"); }
    if (s.id==="m2") { assert.notStrictEqual(s.from, s.to); }
  }
  // m1 must carry both terminal flows toward the tee.
});
t("terminal flows accumulate upstream (m1 = D1 + D2)",()=>{
  const b=m.buildNetworkFromElements(MODEL);
  const flowOf=(id)=>b.terminals[id];
  const d1=flowOf("D1"), d2=flowOf("D2");
  assert.ok(Math.abs(d1-850/2118.88)<1e-9, `D1 ${d1}`);
  assert.ok(Math.abs(d2-0.4)<1e-9);
});
t("auditFromModel returns source flow ≈ sum of terminals",()=>{
  const r=m.auditFromModel(MODEL,{method:"velocity"});
  const total=850/2118.88+0.4;
  assert.ok(Math.abs(r.sourceFlowNative-total)<1e-6, `${r.sourceFlowNative} vs ${total}`);
  assert.strictEqual(r.modelWarnings.length,0, JSON.stringify(r.modelWarnings));
});
t("per-segment audit rows reflect the accumulation",()=>{
  const r=m.auditFromModel(MODEL,{});
  const row=(id)=>r.rows.find((x)=>x.id===id);
  const total=850/2118.88+0.4;
  assert.ok(Math.abs(row("m1").flowNative-total)<1e-6, `${row("m1").flowNative}`);
  assert.ok(Math.abs(row("br").flowNative-850/2118.88)<1e-6);
  assert.ok(Math.abs(row("m2").flowNative-0.4)<1e-6);
});
t("CFM unit tag converts to native m³/s",()=>{
  assert.ok(Math.abs(m.normalizeFlow(2118.88,"cfm",true)-1)<1e-9);
  assert.ok(Math.abs(m.normalizeFlow(2118.88,"cfm",true)-m.normalizeFlow(1,"m3s",true))<1e-9);
});
t("equipment without design flow is reported, not silently dropped",()=>{
  const silent=eq("silent",[5,6],{},{});
  const b=m.buildNetworkFromElements([AHU,m1,T,m2,br,silent,D2]);
  assert.ok(b.warnings.some(w=>w.includes("silent")), JSON.stringify(b.warnings));
});
t("mixed systems are rejected with a clear error",()=>{
  const m1p=run("m1","pipe",[0,0],[3.8,0],{},{system:"domestic-cold"});
  assert.throws(()=>m.buildNetworkFromElements([AHU,m1p,T,m2,br,D1,D2]),/Mixed systems/);
});
t("missing source is rejected with guidance",()=>{
  const noSource=eq("AHU",[0,0],{},{});
  assert.throws(()=>m.buildNetworkFromElements([noSource,m1,T,m2,br,D1,D2]),/isSource/);
});
t("explicit sourceElementId overrides the marker",()=>{
  const b=m.buildNetworkFromElements([AHU,m1,T,m2,br,D1,D2],{sourceElementId:"AHU"});
  assert.strictEqual(b.sourceNodeId,"AHU");
});
t("unconnected runs are excluded with a warning, not guessed",()=>{
  const far=run("far","duct",[30,30],[35,30],{},{system:"supply-air"});
  const r=m.auditFromModel([...MODEL,far],{});
  assert.ok(r.modelWarnings.some(w=>w.includes("far")), JSON.stringify(r.modelWarnings));
  assert.ok(!r.rows.some(x=>x.id==="far"));
});

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
