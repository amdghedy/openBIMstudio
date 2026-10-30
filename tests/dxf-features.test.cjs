const {execSync}=require("child_process");const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"dxf-"));
execSync(`npx tsc src/modules/drawings/dxf-reader.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`,{stdio:"inherit"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const {parseDxf}=require(find(out,"dxf-reader.js"));
const D=(...a)=>a.flat().map(String).filter(x=>x!=="").join("\n");
const sec=(name,body)=>D("0","SECTION","2",name,body,"0","ENDSEC");
const file=(o={})=>D(o.header?sec("HEADER",o.header):"",o.tables?sec("TABLES",o.tables):"",o.blocks?sec("BLOCKS",o.blocks):"",sec("ENTITIES",o.ents||""),o.objects?sec("OBJECTS",o.objects):"","0","EOF");
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const near=(a,b,e=1e-6)=>assert.ok(Math.abs(a-b)<e,a+"!="+b);

t("polyline-path solid HATCH",()=>{
  const h=D("0","HATCH","8","A","2","SOLID","70","1","91","1","92","3","72","0","73","1","93","4","10","0","20","0","10","10","20","0","10","10","20","5","10","0","20","5","97","0","75","0","76","1","98","0");
  const d=parseDxf(file({ents:h}));const e=d.entities[0];assert.ok(e.hatch&&e.hatch.solid);assert.strictEqual(e.hatch.loops[0].length,4);near(e.hatch.loops[0][2].y,5)});
t("edge-path HATCH (lines) with pattern angle and scale",()=>{
  const lines=[[0,0,10,0],[10,0,10,10],[10,10,0,10],[0,10,0,0]].map(([a,b,c,d])=>D("72","1","10",a,"20",b,"11",c,"21",d));
  const h=D("0","HATCH","8","A","2","ANSI31","70","0","91","1","92","1","93","4",lines,"97","0","75","0","76","1","52","45","41","2","77","0","78","0","98","0");
  const d=parseDxf(file({ents:h}));const e=d.entities[0];assert.strictEqual(e.hatch.solid,false);assert.strictEqual(e.hatch.pattern,"ANSI31");near(e.hatch.angle,45);near(e.hatch.scale,2);assert.strictEqual(e.hatch.loops[0].length,4)});
t("hatch with a hole keeps both loops",()=>{
  const sq=(x0,y0,x1,y1,fl)=>D("92",fl,"72","0","73","1","93","4","10",x0,"20",y0,"10",x1,"20",y0,"10",x1,"20",y1,"10",x0,"20",y1,"97","0");
  const h=D("0","HATCH","8","A","2","SOLID","70","1","91","2",sq(0,0,10,10,3),sq(3,3,6,6,2),"75","0","76","1","98","0");
  const e=parseDxf(file({ents:h})).entities[0];assert.strictEqual(e.hatch.loops.length,2)});
t("hatch inside a block is transformed with the insert",()=>{
  const h=D("0","HATCH","8","A","2","SOLID","70","1","91","1","92","3","72","0","73","1","93","3","10","0","20","0","10","1","20","0","10","0","20","1","97","0","75","0","76","1","98","0");
  const blk=D("0","BLOCK","8","0","2","B","70","0","10","0","20","0","30","0",h,"0","ENDBLK");
  const d=parseDxf(file({blocks:blk,ents:D("0","INSERT","8","A","2","B","10","100","20","50","30","0","41","2","42","2","43","2")}));
  const l=d.entities[0].hatch.loops[0];near(l[1].x,102);near(l[2].y,52)});
t("ATTRIB becomes visible text, invisible one is dropped",()=>{
  const e=D("0","ATTRIB","8","A","10","5","20","6","30","0","40","2","1","TAG-1","70","0","0","ATTRIB","8","A","10","1","20","1","30","0","40","2","1","hidden","70","1");
  const d=parseDxf(file({ents:e}));assert.strictEqual(d.entities.length,1);assert.strictEqual(d.entities[0].value,"TAG-1")});
t("TEXT alignment uses the second point",()=>{
  const e=D("0","TEXT","8","A","10","0","20","0","30","0","11","50","21","20","31","0","40","2","1","Hi","72","1","73","2");
  const x=parseDxf(file({ents:e})).entities[0];near(x.position.x,50);assert.strictEqual(x.align,"center");assert.strictEqual(x.valign,"middle")});
t("MTEXT attachment point",()=>{
  const x=parseDxf(file({ents:D("0","MTEXT","8","A","10","0","20","0","30","0","40","2","71","5","1","Mid")})).entities[0];assert.strictEqual(x.align,"center");assert.strictEqual(x.valign,"middle");
  const y=parseDxf(file({ents:D("0","MTEXT","8","A","10","0","20","0","30","0","40","2","71","9","1","BR")})).entities[0];assert.strictEqual(y.align,"right");assert.strictEqual(y.valign,"bottom")});
t("LEADER becomes an open polyline",()=>{
  const e=D("0","LEADER","8","A","76","3","10","0","20","0","30","0","10","5","20","5","30","0","10","9","20","5","30","0");
  const x=parseDxf(file({ents:e})).entities[0];assert.strictEqual(x.type,"LWPOLYLINE");assert.strictEqual(x.points.length,3);assert.ok(!x.closed)});
t("MLEADER yields lines and text",()=>{
  const e=D("0","MLEADER","8","A","40","2","302","LEADER{","304","LEADER_LINE{","10","0","20","0","30","0","10","4","20","4","30","0","305","}","304","Note A","12","10","22","10","22","0");
  const d=parseDxf(file({ents:e}));assert.ok(d.entities.some(x=>x.type==="LWPOLYLINE"&&x.points.length===2));assert.ok(d.entities.some(x=>x.type==="TEXT"&&x.value==="Note A"))});
t("linetype table and entity linetype",()=>{
  const tb=D("0","TABLE","2","LTYPE","0","LTYPE","2","DASHED","73","2","40","18","49","12","49","-6","0","ENDTAB");
  const d=parseDxf(file({header:D("9","$LTSCALE","40","2.5"),tables:tb,ents:D("0","LINE","8","A","6","DASHED","10","0","20","0","30","0","11","5","21","0","31","0","0","LINE","8","A","6","BYLAYER","10","0","20","0","30","0","11","5","21","0","31","0")}));
  assert.deepStrictEqual(d.linetypes.DASHED,[12,-6]);near(d.ltscale,2.5);assert.strictEqual(d.entities[0].lineType,"DASHED");assert.strictEqual(d.entities[1].lineType,undefined)});
t("linetype survives an insert",()=>{
  const blk=D("0","BLOCK","8","0","2","B","70","0","10","0","20","0","30","0","0","LINE","8","0","6","HIDDEN","10","0","20","0","30","0","11","1","21","0","31","0","0","ENDBLK");
  assert.strictEqual(parseDxf(file({blocks:blk,ents:D("0","INSERT","8","A","2","B","10","0","20","0","30","0")})).entities[0].lineType,"HIDDEN")});
t("paper space becomes a layout with its viewport",()=>{
  const ents=D("0","LINE","8","A","10","0","20","0","30","0","11","5","21","0","31","0",
    "0","LINE","8","TB","67","1","10","0","20","0","30","0","11","420","21","0","31","0",
    "0","VIEWPORT","8","VP","67","1","10","210","20","148","30","0","40","200","41","100","12","50","22","25","45","50","68","1","69","2",
    "0","VIEWPORT","8","VP","67","1","10","210","20","148","30","0","40","420","41","297","45","297","68","1","69","1");
  const d=parseDxf(file({ents,objects:D("0","LAYOUT","1","Layout1","71","1")}));
  assert.strictEqual(d.entities.length,1);assert.strictEqual(d.layouts.length,1);assert.strictEqual(d.layouts[0].name,"Layout1");assert.strictEqual(d.layouts[0].entities.length,1);
  assert.strictEqual(d.layouts[0].viewports.length,1);near(d.layouts[0].viewports[0].viewHeight,50);near(d.layouts[0].viewports[0].center.x,210)});
t("*Paper_Space blocks become extra layouts",()=>{
  const blk=D("0","BLOCK","8","0","2","*Paper_Space1","70","0","10","0","20","0","30","0","0","LINE","8","TB","10","0","20","0","30","0","11","9","21","0","31","0","0","ENDBLK");
  const d=parseDxf(file({blocks:blk}));assert.strictEqual(d.layouts.length,1);assert.strictEqual(d.layouts[0].entities.length,1);assert.strictEqual(d.layouts[0].name,"Layout 1")});
t("ATTDEF no longer reported as skipped",()=>{const d=parseDxf(file({ents:D("0","ATTDEF","8","A","10","0","20","0","30","0","40","2","1","x")}));assert.ok(!d.skipped||!d.skipped.ATTDEF)});
t("text direction through mirrored and rotated inserts is exact",()=>{
  const blk=D("0","BLOCK","8","0","2","T","70","0","10","0","20","0","30","0","0","TEXT","8","0","10","0","20","0","30","0","40","2","1","T","50","30","0","ENDBLK");
  const ang=(sx,sy,rot)=>parseDxf(file({blocks:blk,ents:D("0","INSERT","8","A","2","T","10","0","20","0","30","0","41",sx,"42",sy,"43","1","50",rot)})).entities[0].rotation;
  near(ang(1,1,0),30);near(ang(1,1,90),120);near(ang(-1,1,0),150);near(ang(1,-1,0),330);near(ang(-1,-1,0),210);near(ang(-1,1,90),240)});
t("IMAGE: placement frame + diagonals + file label from IMAGEDEF; WIPEOUT: background-fill mask",()=>{
  const img=D("0","IMAGE","8","A","10","10","20","20","30","0","11","0.5","21","0","31","0","12","0","22","0.5","32","0","13","100","23","40","340","1F");
  const wipe=D("0","WIPEOUT","8","A","10","0","20","0","30","0","11","1","21","0","31","0","12","0","22","1","32","0","13","10","23","10","71","2","91","4","14","-0.5","24","-0.5","14","9.5","24","-0.5","14","9.5","24","9.5","14","-0.5","24","9.5");
  const objs=D("0","IMAGEDEF","5","1F","1","C:\\\\scans\\\\plan.png");
  const d=parseDxf(file({ents:img+"\n"+wipe,objects:objs}));
  const fr=d.entities.find(e=>e.type==="LWPOLYLINE"&&e.closed&&!e.hatch);
  near(fr.points[2].x,60);near(fr.points[2].y,40);
  assert.strictEqual(d.entities.filter(e=>e.type==="LWPOLYLINE"&&!e.closed).length,2);
  assert.strictEqual(d.entities.find(e=>e.type==="TEXT").value,"plan.png");
  const w=d.entities.find(e=>e.hatch&&e.hatch.wipeout);assert.ok(w);near(w.hatch.loops[0][0].x,0);near(w.hatch.loops[0][2].x,10);
  assert.ok(d.skipped&&Object.keys(d.skipped).some(k=>/IMAGE/.test(k)))});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
