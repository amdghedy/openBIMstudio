/* The first paper-space layout (entities + viewports) survives a DXF save; extra layouts are reported. */
const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"cadlayout-"));
execSync(`npx tsc src/modules/drawings/dxf-writer.ts src/modules/drawings/dxf-reader.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"pipe"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const W=require(find(out,"dxf-writer.js")), {parseDxf}=require(find(out,"dxf-reader.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const P=(x,y)=>({x,y,z:0});
const line=(a,b)=>({type:"LINE",layer:"0",start:a,end:b});
const vp=(cx,cy,w,h,vh)=>({center:P(cx,cy),width:w,height:h,viewCenter:P(5000,3000),viewHeight:vh,twist:15});
const doc=(layouts)=>({units:"mm",layers:[{name:"0",color:7}],entities:[line(P(0,0),P(10,0))],layouts});
const rt=(d)=>parseDxf(W.writeDxf(d));

t("sheet entities and viewports are read back", () => {
  const d=rt(doc([{name:"A1",entities:[line(P(0,0),P(420,0)),line(P(420,0),P(420,297))],viewports:[vp(210,148,400,280,2000)]}]));
  assert.strictEqual(d.layouts.length,1);
  assert.strictEqual(d.layouts[0].entities.length,2);
  assert.strictEqual(d.layouts[0].viewports.length,1);
  const v=d.layouts[0].viewports[0];
  assert.deepStrictEqual([v.width,v.height,v.viewHeight,v.twist],[400,280,2000,15]);
  assert.deepStrictEqual([v.center.x,v.center.y,v.viewCenter.x,v.viewCenter.y],[210,148,5000,3000]);
});
t("model space is unchanged by the sheet", () => {
  const d=rt(doc([{name:"A1",entities:[line(P(0,0),P(1,1))],viewports:[]}]));
  assert.strictEqual(d.entities.length,1);
});
t("paper-space records carry group 67", () => {
  const text=W.writeDxf(doc([{name:"A1",entities:[line(P(0,0),P(1,1))],viewports:[vp(0,0,10,10,100)]}]));
  assert.strictEqual((text.match(/\n67\n1\n/g)||[]).length,2); // the line and the viewport
});
t("a drawing without layouts writes no paper space", () => {
  assert.ok(!/\n67\n1\n/.test(W.writeDxf(doc(undefined))));
});
t("extra layouts are counted as not saved", () => {
  assert.strictEqual(W.layoutsNotSaved({layouts:undefined}),0);
  assert.strictEqual(W.layoutsNotSaved({layouts:[{name:"a",entities:[],viewports:[]}]}),0);
  assert.strictEqual(W.layoutsNotSaved({layouts:[1,2,3].map((n)=>({name:"L"+n,entities:[],viewports:[]}))}),2);
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`); process.exit(fail?1:0);
