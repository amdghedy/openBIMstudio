/* CAD Editor save tests — QSAVE writes a real DXF that parses back losslessly.
 *
 * The editor's save path serializes the LIVE edited entity list (modelEnts)
 * because doc.entities goes stale after erase/undo rebinds. These tests pin:
 *   1. full round-trip fidelity for every DxfEntity kind the editor creates
 *   2. the save-from-live-list contract ({...doc, entities: live})
 *   3. writer header sanity (AC1024, units, extents, EOF)
 */
const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"cadsave-"));
execSync(`npx tsc src/modules/drawings/dxf-writer.ts src/modules/drawings/dxf-reader.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"pipe"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const {writeDxf}=require(find(out,"dxf-writer.js"));
const {parseDxf}=require(find(out,"dxf-reader.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const near=(a,b,e=1e-6)=>assert.ok(Math.abs(a-b)<e,`${a}!=${b}`);

const L=(x1,y1,x2,y2,layer="0",color)=>({type:"LINE",layer,start:{x:x1,y:y1},end:{x:x2,y:y2},...(color!==undefined?{color}:{})});
const C=(x,y,r,layer="0")=>({type:"CIRCLE",layer,center:{x,y},radius:r});
const A=(x,y,r,s,e)=>({type:"ARC",layer:"0",center:{x,y},radius:r,startAngle:s,endAngle:e});
const P=(pts,closed)=>({type:"LWPOLYLINE",layer:"0",points:pts.map(([x,y])=>({x,y})),closed});
const T=(x,y,h,v)=>({type:"TEXT",layer:"0",position:{x,y},height:h,value:v});
const PT=(x,y)=>({type:"POINT",layer:"0",position:{x,y}});

const doc={
  units:"mm",
  layers:[{name:"0",color:7},{name:"WALLS",color:1},{name:"ANNOT",color:3}],
  entities:[
    L(0,0,10,0,"WALLS",1),
    C(20,0,3),
    A(40,0,5,0,Math.PI/2),
    P([[0,10],[10,10],[10,20],[0,20]],true),
    T(2,30,2.5,"Living Room"),
    PT(50,50,"ANNOT"),
  ],
};

t("header sanity: AC1024, $INSUNITS, extents, EOF",()=>{
  const s=writeDxf(doc);
  assert.ok(s.includes("$ACADVER"));
  assert.ok(s.includes("AC1024"));
  assert.ok(s.includes("$INSUNITS"));
  assert.ok(s.includes("$EXTMIN"));
  assert.ok(s.includes("$EXTMAX"));
  assert.ok(s.trimEnd().endsWith("EOF"));
});

t("round trip preserves entity counts and types",()=>{
  const back=parseDxf(writeDxf(doc));
  assert.strictEqual(back.entities.length,doc.entities.length);
  assert.deepStrictEqual(back.entities.map(e=>e.type),doc.entities.map(e=>e.type));
});

t("round trip preserves layer table",()=>{
  const back=parseDxf(writeDxf(doc));
  const names=back.layers.map(l=>l.name);
  for(const l of doc.layers) assert.ok(names.includes(l.name),`missing layer ${l.name}`);
});

t("round trip preserves units",()=>{
  const back=parseDxf(writeDxf(doc));
  assert.strictEqual(back.units,"mm");
});

t("round trip preserves geometry within epsilon",()=>{
  const back=parseDxf(writeDxf(doc));
  const line=back.entities[0],circ=back.entities[1],arc=back.entities[2],poly=back.entities[3],txt=back.entities[4],pt=back.entities[5];
  near(line.start.x,0);near(line.end.y,0);assert.strictEqual(line.layer,"WALLS");
  near(circ.center.x,20);near(circ.radius,3);
  near(arc.center.y,0);near(arc.radius,5);near(arc.endAngle,Math.PI/2,1e-3);
  assert.strictEqual(poly.points.length,4);assert.strictEqual(poly.closed,true);near(poly.points[2].y,20);
  assert.strictEqual(txt.value,"Living Room");near(txt.height,2.5);
  near(pt.position.x,50);
});

t("save uses the live edited list, not stale doc.entities",()=>{
  // Editor contract: after erase, modelEnts is rebound and doc.entities goes stale.
  const staleDoc={...doc,entities:[...doc.entities]};
  const live=[staleDoc.entities[0],staleDoc.entities[1],staleDoc.entities[3]]; // ARC/TEXT/POINT erased
  const back=parseDxf(writeDxf({...staleDoc,entities:live}));
  assert.strictEqual(back.entities.length,3);
  assert.deepStrictEqual(back.entities.map(e=>e.type),["LINE","CIRCLE","LWPOLYLINE"]);
});

t("round trip preserves entity color override",()=>{
  const back=parseDxf(writeDxf(doc));
  assert.strictEqual(back.entities[0].color,1);
});

t("empty document still writes a valid DXF",()=>{
  const back=parseDxf(writeDxf({units:"m",layers:[],entities:[]}));
  assert.strictEqual(back.entities.length,0);
});

t("multi-line TEXT saves as one TEXT per line — never a broken group stream",()=>{
  // MTEXT \P paragraphs read back as one TEXT whose value holds "\n"; a raw
  // newline inside a TEXT record would corrupt the code/value pairs on re-import.
  const doc2={
    units:"mm",
    layers:[{name:"0",color:7}],
    entities:[
      {type:"TEXT",layer:"0",position:{x:0,y:0},height:2.5,value:"Line one\nLine two\nLine three"},
      {type:"TEXT",layer:"0",position:{x:10,y:0},height:2.5,value:"rotated\nlines",rotation:30,valign:"top",align:"center"},
    ],
  };
  const s=writeDxf(doc2);
  const back=parseDxf(s); // a corrupted stream would throw or drop entities here
  assert.strictEqual(back.entities.length,5);
  assert.deepStrictEqual(back.entities.map(e=>e.value),["Line one","Line two","Line three","rotated","lines"]);
  // Vertical pitch mirrors the on-screen baselines: 2.5 × 5/3 between lines.
  const first=back.entities[0],second=back.entities[1];
  const pitch=2.5*5/3;
  assert.ok(Math.abs((first.position.y-second.position.y)-pitch)<1e-9);
  // Rotation carries the offset along the text's own baseline direction:
  // local +Y' (line 0 minus line 1) = (-sin r, cos r) × pitch.
  const r4=back.entities[3],r5=back.entities[4];
  const a=30*Math.PI/180;
  assert.ok(Math.abs((r4.position.x-r5.position.x)+Math.sin(a)*pitch)<1e-9);
  assert.ok(Math.abs((r4.position.y-r5.position.y)-Math.cos(a)*pitch)<1e-9);
  // Horizontal alignment survives per line; no vertical flag is written.
  assert.strictEqual(back.entities[3].align,"center");
  assert.ok(!back.entities[3].valign||back.entities[3].valign==="baseline");
});

console.log(`\ncad-save: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
