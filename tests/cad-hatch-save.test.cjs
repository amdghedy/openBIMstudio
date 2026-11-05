/* Hatch fills survive a DXF save: solid and patterned hatches are written as HATCH
 * entities and read back with the same boundaries, pattern, angle and scale. */
const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"cadhatch-"));
execSync(`npx tsc src/modules/drawings/dxf-writer.ts src/modules/drawings/dxf-reader.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"pipe"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const {writeDxf}=require(find(out,"dxf-writer.js"));
const {parseDxf}=require(find(out,"dxf-reader.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const sq=(x,y,s)=>[[x,y],[x+s,y],[x+s,y+s],[x,y+s]].map(([a,b])=>({x:a,y:b,z:0}));
const hatchPoly=(loops,hatch)=>({type:"LWPOLYLINE",layer:"0",points:loops[0],closed:true,hatch:{loops,...hatch}});
const rt=(ents)=>parseDxf(writeDxf({units:"mm",layers:[{name:"0",color:7}],entities:ents}));
const hatches=(d)=>d.entities.filter((e)=>e.type==="LWPOLYLINE"&&e.hatch);

t("a solid hatch is written as HATCH and read back as a solid fill", () => {
  const text=writeDxf({units:"mm",layers:[{name:"0",color:7}],entities:[hatchPoly([sq(0,0,10)],{solid:true})]});
  assert.ok(/\n0\nHATCH\n/.test(text),"HATCH entity present");
  const h=hatches(parseDxf(text));
  assert.strictEqual(h.length,1); assert.strictEqual(h[0].hatch.solid,true); assert.strictEqual(h[0].hatch.loops.length,1);
  assert.strictEqual(h[0].hatch.loops[0].length,4);
});
t("a hatch with a hole keeps both loops", () => {
  const h=hatches(rt([hatchPoly([sq(0,0,10),sq(3,3,4)],{solid:true})]));
  assert.strictEqual(h.length,1); assert.strictEqual(h[0].hatch.loops.length,2);
  assert.strictEqual(h[0].hatch.loops[1].length,4);
});
t("pattern name, angle and scale survive", () => {
  const h=hatches(rt([hatchPoly([sq(0,0,10)],{solid:false,pattern:"ANSI31",angle:45,scale:2.5})]));
  assert.strictEqual(h[0].hatch.solid,false); assert.strictEqual(h[0].hatch.pattern,"ANSI31");
  assert.ok(Math.abs(h[0].hatch.angle-45)<1e-9); assert.ok(Math.abs(h[0].hatch.scale-2.5)<1e-9);
});
t("real pattern lines are written in degrees", () => {
  const text=writeDxf({units:"mm",layers:[{name:"0",color:7}],entities:[hatchPoly([sq(0,0,10)],{solid:false,pattern:"ANSI31",patternLines:[{angle:Math.PI/4,base:[0,0],offset:[-2,2],dashes:[]}]})]});
  assert.ok(/\n53\n45(\.0+)?\n/.test(text),"angle written as 45 degrees"); assert.ok(/\n78\n1\n/.test(text));
});
t("layer, colour and the fill together", () => {
  const e=hatchPoly([sq(0,0,10)],{solid:true}); e.layer="WALLS"; e.color=1;
  const d=parseDxf(writeDxf({units:"mm",layers:[{name:"0",color:7},{name:"WALLS",color:1}],entities:[e]}));
  const h=hatches(d)[0]; assert.strictEqual(h.layer,"WALLS"); assert.strictEqual(h.color,1);
});
t("a wipeout is not turned into a normal hatch", () => {
  const text=writeDxf({units:"mm",layers:[{name:"0",color:7}],entities:[hatchPoly([sq(0,0,10)],{solid:true,wipeout:true})]});
  assert.ok(!/\nHATCH\n/.test(text));
});
t("a plain closed polyline is still a polyline", () => {
  const text=writeDxf({units:"mm",layers:[{name:"0",color:7}],entities:[{type:"LWPOLYLINE",layer:"0",points:sq(0,0,5),closed:true}]});
  assert.ok(/\nLWPOLYLINE\n/.test(text)&&!/\nHATCH\n/.test(text));
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`); process.exit(fail?1:0);
