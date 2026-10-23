const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"adc-"));
execSync(`npx tsc src/modules/views/auto-dim-chains.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreConfig --ignoreDeprecations 6.0`,{stdio:"inherit"});
const m=require(path.join(out,"auto-dim-chains.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a}!=${b}`);
const W=(id,s,e)=>({id,type:"wall",params:{start:s,end:e,thickness:0.2,height:3,elevation:0}});
const C=(id,x,z)=>({id,type:"column",params:{point:[x,z],width:0.4,depth:0.4,height:3,thickness:0.4,elevation:0}});
const els=[W("w1",[0,0],[6,0]),W("w2",[6,0],[6,4]),C("c1",3,2),C("c2",0,4),{id:"s",type:"slab",params:{polygon:[[-9,-9],[9,-9],[9,9]],height:0.2,thickness:0.2,elevation:0}}];
const d=m.buildAutoDimensions(els);
t("only columns and walls (slab ignored)",()=>{for(const x of d){assert.ok(x.x1>-1&&x.x2<7)}});
t("X chain sits 0.5 m below lowest face",()=>{const x=d.filter(a=>a.axis==="x"&&!a.overall);assert.ok(x.length>0);for(const a of x)near(a.linePos,-0.1-0.5)});
t("Z chain sits 0.5 m left of leftmost face",()=>{const z=d.filter(a=>a.axis==="z"&&!a.overall);assert.ok(z.length>0);for(const a of z)near(a.linePos,-0.2-0.5)});
t("overall rows are a further 0.5 m out and span everything",()=>{const o=d.find(a=>a.axis==="x"&&a.overall);near(o.linePos,-1.1);near(o.x1,-0.2);near(o.x2,6.1)});
t("chain segments are contiguous and sum to overall",()=>{const x=d.filter(a=>a.axis==="x"&&!a.overall).sort((a,b)=>a.x1-b.x1);for(let i=0;i+1<x.length;i++)near(x[i].x2,x[i+1].x1);near(x[0].x1,-0.2);near(x[x.length-1].x2,6.1)});
t("refs present for following edits",()=>assert.ok(d.every(a=>a.ref1&&a.ref2&&a.ref1.elementId)));
t("custom offset 0.3",()=>{const e=m.buildAutoDimensions(els,{offset:0.3});near(e.find(a=>a.axis==="x"&&!a.overall).linePos,-0.1-0.3)});
t("no elements -> none",()=>assert.strictEqual(m.buildAutoDimensions([]).length,0));

// ── range dimension (first edge .. last edge) ──
const D=(id,host,off,w)=>({id,type:"door",hostId:host,params:{offsetAlongHost:off,width:w,height:2.1,thickness:0.2,elevation:0}});
const Wn=(id,host,off,w)=>({id,type:"window",hostId:host,params:{offsetAlongHost:off,width:w,height:1.2,thickness:0.2,elevation:0,sillHeight:0.9}});
const room=[W("a",[0,0],[10,0]),W("b",[0,0],[0,5]),W("c",[10,0],[10,5]),C("k",5,0),D("d1","a",2,1),Wn("w1","a",8,1.5),C("far",5,20)];
const R=m.buildRangeDimension(room,{axis:"x",p1:{x:-0.1,z:0},p2:{x:10.1,z:0}});
t("range: first and last edge are chain ends",()=>{const c=R.filter(a=>!a.overall).sort((a,b)=>a.x1-b.x1);near(c[0].x1,-0.1);near(c[c.length-1].x2,10.1)});
t("range: door jambs, window jambs and column faces all present",()=>{const xs=new Set();for(const a of R.filter(a=>!a.overall)){xs.add(+a.x1.toFixed(3));xs.add(+a.x2.toFixed(3))}
  for(const v of [1.5,2.5,7.25,8.75,4.8,5.2])assert.ok(xs.has(v),"missing "+v)});
t("range: element outside the crossed band is ignored",()=>{for(const a of R){assert.ok(a.z1<10&&a.z2<10)}});
t("range: chain contiguous",()=>{const c=R.filter(a=>!a.overall).sort((a,b)=>a.x1-b.x1);for(let i=0;i+1<c.length;i++)near(c[i].x2,c[i+1].x1)});
t("range: explicit line position honoured",()=>{const e=m.buildRangeDimension(room,{axis:"x",p1:{x:-0.1,z:0},p2:{x:10.1,z:0},linePos:-2});assert.ok(e.filter(a=>!a.overall).every(a=>a.linePos===-2))});
t("range: sub-range only dimensions inside the picks",()=>{const e=m.buildRangeDimension(room,{axis:"x",p1:{x:1.5,z:0},p2:{x:5.2,z:0}});const c=e.filter(a=>!a.overall).sort((a,b)=>a.x1-b.x1);near(c[0].x1,1.5);near(c[c.length-1].x2,5.2);assert.ok(c.every(a=>a.x2<=5.2+1e-9))});
t("range: vertical direction",()=>{const e=m.buildRangeDimension(room,{axis:"z",p1:{x:0,z:-0.1},p2:{x:0,z:5}});assert.ok(e.length>0&&e.every(a=>a.axis==="z"))});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
