const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"mc-"));
execSync(`npx tsc src/modules/mep/connectivity.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const m=require(find(out,"connectivity.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const run=(id,type,s,e,extra={})=>({id,type,params:{start:s,end:e,elevation:3,height:0.3,thickness:0.3,...extra}});
const fit=(id,pt,kind,aIn,aOut,extra={})=>({id,type:"fitting",params:{point:pt,elevation:3,height:0.3,thickness:0.3,fittingKind:kind,angleIn:aIn,angleOut:aOut,parentType:"duct",bendRadius:0.45,...extra}});
// A (0,0)->(4,0), elbow at (5,0) turning north, B (5,0)->(5,4) trimmed ends at tangent 0.45
const A=run("A","duct",[0,0],[4.55,0]);
const E=fit("E",[5,0],"elbow",0,Math.PI/2);
const B=run("B","duct",[5,0.45],[5,8]);
const far=run("far","duct",[20,20],[25,20]);
const other=run("other","pipe",[0,10],[5,10]);
t("end-to-end linears connect",()=>assert.ok(m.areConnected(run("x","duct",[0,0],[1,0]),run("y","duct",[1,0],[2,0]))));
t("trimmed run reaches elbow arm",()=>{assert.ok(m.areConnected(A,E));assert.ok(m.areConnected(B,E))});
t("unrelated runs are not connected",()=>{assert.ok(!m.areConnected(A,far));assert.ok(!m.areConnected(A,B))});
t("different elevation does not connect",()=>assert.ok(!m.areConnected(run("p","duct",[0,0],[1,0]),run("q","duct",[1,0],[2,0],{elevation:5}))));
t("moving duct A pulls elbow and the next run",()=>{
  const ids=m.expandConnected(["A"],[A,E,B,far,other]).sort();
  assert.deepStrictEqual(ids,["A","B","E"]);
});
t("selecting the elbow pulls both runs",()=>assert.deepStrictEqual(m.expandConnected(["E"],[A,E,B,far]).sort(),["A","B","E"]));
t("tee branch: branch run and main runs all follow",()=>{
  const main1=run("m1","duct",[0,0],[3.8,0]),main2=run("m2","duct",[6.2,0],[10,0]);
  const tee=fit("T",[5,0],"tee",0,Math.PI/2);
  const br=run("br","duct",[5,0.9],[5,6]);
  const ids=m.expandConnected(["br"],[main1,main2,tee,br,far]).sort();
  assert.deepStrictEqual(ids,["T","br","m1","m2"]);
});
t("pinned element blocks spreading",()=>{
  const Bp={...B,properties:{pinned:true}};
  assert.deepStrictEqual(m.expandConnected(["A"],[A,E,Bp]).sort(),["A","E"]);
});
t("equipment follows its duct but does not spread",()=>{
  const eq={id:"Q",type:"equipment",params:{point:[-0.3,0],elevation:2.8,height:0.6,thickness:0.6,depth:0.6}};
  const eqDuct=run("ed","duct",[-0.3,0.2],[-0.3,-6]);
  const ids=m.expandConnected(["A"],[A,E,B,eq,eqDuct]).sort();
  assert.ok(ids.includes("Q")); assert.ok(!ids.includes("ed"));
});
t("sloped run connects at its elevated end",()=>{
  const s=run("s","pipe",[0,0],[10,0],{endElevation:3.5});
  const n=run("n","pipe",[10,0],[15,0],{elevation:3.5});
  assert.ok(m.areConnected(s,n));
});
t("non-MEP start id is ignored for spreading",()=>assert.deepStrictEqual(m.expandConnected(["wall"],[{id:"wall",type:"wall",params:{start:[0,0],end:[1,0],elevation:0,height:3,thickness:0.2}},A]),["wall"]));
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
