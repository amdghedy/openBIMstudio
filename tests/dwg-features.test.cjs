const {execSync}=require("child_process");const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"dwg-"));
execSync(`npx tsc src/modules/drawings/dwg-convert.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`,{stdio:"inherit"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const {dwgDatabaseToDxfDocument}=require(find(out,"dwg-convert.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,a+"!="+b);
const sq=(a,b)=>[{x:a,y:a},{x:b,y:a},{x:b,y:b},{x:a,y:b}];
const db={tables:{LAYER:{entries:[{name:"A",colorIndex:1,lineType:"DASHED"}]},LTYPE:{entries:[{name:"Dashed",pattern:[{length:12},{length:-6}]}]},BLOCK_RECORD:{entries:[]}},header:{LTSCALE:2},
 entities:[
  {type:"LINE",layer:"A",lineType:"DASHED",startPoint:{x:0,y:0},endPoint:{x:5,y:0}},
  {type:"LINE",layer:"A",lineType:"ByLayer",startPoint:{x:0,y:0},endPoint:{x:5,y:0}},
  {type:"HATCH",layer:"A",patternName:"SOLID",isSolidFill:true,boundaryPaths:[{polylineVertices:sq(0,10),isClosed:true},{polylineVertices:sq(2,4),isClosed:true}]},
  {type:"HATCH",layer:"A",patternName:"ANSI31",patternAngle:0.5,patternScale:2,boundaryPaths:[{edges:[{type:"LINE",start:{x:0,y:0},end:{x:4,y:0}},{type:"LINE",start:{x:4,y:0},end:{x:4,y:4}},{type:"LINE",start:{x:4,y:4},end:{x:0,y:0}}]}]},
  {type:"TEXT",layer:"A",text:"Hi",startPoint:{x:0,y:0},endPoint:{x:50,y:20},textHeight:2,horizontalJustification:1,verticalAlignment:2},
  {type:"MTEXT",layer:"A",text:"Mid",insertionPoint:{x:3,y:3},textHeight:2,attachmentPoint:5},
  {type:"ATTRIB",layer:"A",text:"TAG",startPoint:{x:1,y:1},textHeight:2},
  {type:"ATTRIB",layer:"A",text:"HID",startPoint:{x:1,y:1},textHeight:2,invisible:true},
  {type:"ATTDEF",layer:"A",text:"DEF",startPoint:{x:1,y:1},textHeight:2},
  {type:"LEADER",layer:"A",vertices:[{x:0,y:0},{x:3,y:3}]},
  {type:"LINE",layer:"TB",inPaperSpace:true,startPoint:{x:0,y:0},endPoint:{x:400,y:0}},
  {type:"VIEWPORT",layer:"VP",inPaperSpace:true,viewportCenter:{x:200,y:150},viewportWidth:100,viewportHeight:60,viewCenter:{x:5,y:5},viewHeight:30,viewportId:2},
  {type:"VIEWPORT",layer:"VP",inPaperSpace:true,viewportCenter:{x:200,y:150},viewportWidth:400,viewportHeight:300,viewCenter:{x:0,y:0},viewHeight:300,viewportId:1},
 ]};
const {doc}=dwgDatabaseToDxfDocument(db);
const E=doc.entities;
t("linetypes: names, table, ltscale, layer",()=>{assert.strictEqual(E[0].lineType,"DASHED");assert.strictEqual(E[1].lineType,undefined);assert.deepStrictEqual(doc.linetypes.DASHED,[12,-6]);near(doc.ltscale,2);assert.strictEqual(doc.layers.find(l=>l.name==="A").lineType,"DASHED")});
t("solid hatch with a hole",()=>{const h=E.find(e=>e.hatch&&e.hatch.solid);assert.strictEqual(h.hatch.loops.length,2);assert.strictEqual(h.hatch.loops[0].length,4)});
t("edge-path pattern hatch",()=>{const h=E.find(e=>e.hatch&&!e.hatch.solid);assert.strictEqual(h.hatch.pattern,"ANSI31");near(h.hatch.scale,2);assert.strictEqual(h.hatch.loops[0].length,3)});
t("text justification",()=>{const x=E.find(e=>e.type==="TEXT"&&e.value==="Hi");near(x.position.x,50);assert.strictEqual(x.align,"center");assert.strictEqual(x.valign,"middle");const m=E.find(e=>e.value==="Mid");assert.strictEqual(m.align,"center");assert.strictEqual(m.valign,"middle")});
t("attributes: visible kept, invisible and definitions dropped",()=>{assert.ok(E.some(e=>e.value==="TAG"));assert.ok(!E.some(e=>e.value==="HID"));assert.ok(!E.some(e=>e.value==="DEF"))});
t("leader",()=>assert.ok(E.some(e=>e.type==="LWPOLYLINE"&&!e.closed&&e.points.length===2&&!e.hatch)));
t("paper space: layout with entity and the real viewport only",()=>{assert.strictEqual(doc.layouts.length,1);assert.strictEqual(doc.layouts[0].entities.length,1);assert.strictEqual(doc.layouts[0].viewports.length,1);near(doc.layouts[0].viewports[0].viewHeight,30);assert.ok(!E.some(e=>e.layer==="TB"))});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
