/* Cross-drawing clipboard tests (COPYCLIP / PASTECLIP / PASTEORIG) for the CAD Editor.
 *
 * Pins the multi-file interaction contract:
 *   1. makeClip deep-copies (source mutations never leak into the clip)
 *   2. clipInstances translates the base point onto the drop point
 *   3. verbatim instantiation for PASTEORIG (no translation)
 *   4. per-kind geometry translation (LINE, CIRCLE, ARC, LWPOLYLINE, TEXT, POINT)
 *   5. fresh object identities — no aliasing between clip, source, and paste
 * Super Copy additions:
 *   6. hatch fill loops translate with the boundary (pasted fills stay aligned)
 *   7. collectClipDeps snapshots exactly the referenced layer/linetype/style tables
 *   8. missingClipDeps carries only definitions the target drawing lacks
 *   9. serializeClip / parseClip round-trip survives reloads and rejects garbage
 */
const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"cadclip-"));
execSync(`npx tsc src/modules/cad-viewer/clipboard.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"pipe"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const {makeClip,clipInstances,translateEntity,collectClipDeps,missingClipDeps,serializeClip,parseClip}=require(find(out,"clipboard.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const near=(a,b,e=1e-9)=>assert.ok(Math.abs(a-b)<e,`${a}!=${b}`);

const L=(x1,y1,x2,y2,layer="WALLS")=>({type:"LINE",layer,start:{x:x1,y:y1},end:{x:x2,y:y2}});
const C=(x,y,r)=>({type:"CIRCLE",layer:"0",center:{x,y},radius:r});
const A=(x,y,r,s,e)=>({type:"ARC",layer:"0",center:{x,y},radius:r,startAngle:s,endAngle:e});
const P=(pts,closed)=>({type:"LWPOLYLINE",layer:"0",points:pts.map(([x,y])=>({x,y})),closed});
const T=(x,y,h,v)=>({type:"TEXT",layer:"0",position:{x,y},height:h,value:v});
const PT=(x,y)=>({type:"POINT",layer:"ANNOT",position:{x,y}});

t("makeClip deep-copies and computes the base as the bbox center",()=>{
  const src=[L(0,0,10,0),C(20,0,3)];
  const clip=makeClip(src,undefined,"room plan");
  assert.ok(clip);
  near(clip.base.x,11.5);near(clip.base.y,0);
  assert.strictEqual(clip.sourceName,"room plan");
  src[0].start.x=999; src[0].layer="HACK";
  assert.strictEqual(clip.entities[0].start.x,0);
  assert.strictEqual(clip.entities[0].layer,"WALLS");
});

t("makeClip returns null for an empty selection",()=>assert.strictEqual(makeClip([]),null));

t("clipInstances maps the base point onto the drop point",()=>{
  const clip=makeClip([L(0,0,10,0),C(20,0,3)]);
  const at={x:100,y:50};
  const [line,circ]=clipInstances(clip,at);
  near(line.start.x,88.5);near(line.start.y,50);near(line.end.x,98.5);
  near(circ.center.x,108.5);near(circ.radius,3);
});

t("PASTEORIG: verbatim copies with no translation",()=>{
  const clip=makeClip([A(5,7,2,0,1),PT(-3,4)]);
  const [arc,pt]=clipInstances(clip);
  near(arc.center.x,5);near(arc.center.y,7);near(arc.endAngle,1);
  near(pt.position.x,-3);near(pt.position.y,4);
});

t("per-kind translation incl. closed polyline and text",()=>{
  const e=P([[0,0],[10,0],[10,10]],true);
  const poly=translateEntity(e,5,-2);
  assert.strictEqual(poly.closed,true);
  assert.deepStrictEqual(poly.points[1],{x:15,y:-2});
  const txt=translateEntity(T(1,2,2.5,"Kitchen"),10,10);
  assert.strictEqual(txt.value,"Kitchen");near(txt.height,2.5);
  assert.deepStrictEqual(txt.position,{x:11,y:12});
});

t("no aliasing: clip, source, and pasted instances are distinct objects",()=>{
  const src=[L(0,0,10,0)];
  const clip=makeClip(src);
  const [a]=clipInstances(clip);
  const [b]=clipInstances(clip,{x:5,y:5});
  assert.notStrictEqual(clip.entities[0],src[0]);
  assert.notStrictEqual(a,clip.entities[0]);
  assert.notStrictEqual(b,a);
  b.start.x=777;
  assert.strictEqual(clip.entities[0].start.x,0);
});

t("translateEntity never mutates its input",()=>{
  const e=C(1,1,4);
  const c=translateEntity(e,3,3);
  near(e.center.x,1);near(c.center.x,4);
});

/* ── Super Copy: hatch fill travels with the boundary ── */

t("hatch loops translate with the polyline boundary",()=>{
  const e={...P([[0,0],[10,0],[10,10]],true),hatch:{solid:false,pattern:"ANSI31",angle:45,scale:1,loops:[[[0,0],[10,0],[10,10],[0,10],[0,0]].map(([x,y])=>({x,y})),[[2,2],[4,2]].map(([x,y])=>({x,y}))]}};
  const c=translateEntity(e,100,50);
  assert.strictEqual(c.hatch.pattern,"ANSI31");
  assert.strictEqual(c.hatch.loops.length,2);
  assert.deepStrictEqual(c.hatch.loops[0][2],{x:110,y:60});
  assert.deepStrictEqual(c.hatch.loops[1][1],{x:104,y:52});
  // The clip round-trip keeps the same alignment (base = bbox center (5,5), drop at (40,20)).
  const clip=makeClip([e]);
  const [inst]=clipInstances(clip,{x:40,y:20});
  assert.deepStrictEqual(inst.hatch.loops[1][0],{x:37,y:17});
  assert.deepStrictEqual(inst.hatch.loops[0][2],{x:45,y:25});
  // Source untouched.
  assert.deepStrictEqual(e.hatch.loops[1][1],{x:4,y:2});
});

/* ── Super Copy: style dependency snapshot ── */

const srcDoc=()=>({
  layers:[
    {name:"0",color:7},
    {name:"WALLS",color:3,lineType:"DASHED",lineweight:0.5},
    {name:"ANNOT",color:2},
    {name:"UNUSED",color:5},
  ],
  linetypes:{"CONTINUOUS":[],"DASHED":[5,-2],"CENTER":[10,-2,2,-2]},
  textStyles:{"STANDARD":{font:"txt.shx"},"TITLES":{font:"romans.shx",height:3.5,bold:true}},
});

t("collectClipDeps snapshots exactly the referenced definitions",()=>{
  const doc=srcDoc();
  const deps=collectClipDeps([L(0,0,10,0),{...T(0,0,2.5,"Note"),style:"Titles"},C(5,5,1)],doc);
  assert.deepStrictEqual(deps.layers.map(l=>l.name).sort(),["0","WALLS"]); // only layers the entities reference
  assert.strictEqual(deps.layers.find(l=>l.name==="WALLS").lineweight,0.5);
  assert.deepStrictEqual(deps.linetypes,{"DASHED":[5,-2]}); // layer WALLS' own dash travels too
  assert.deepStrictEqual(deps.textStyles["TITLES"].font,"romans.shx");
  assert.strictEqual(deps.layers.find(l=>l.name==="UNUSED"),undefined);
  assert.strictEqual(deps.layers.find(l=>l.name==="ANNOT"),undefined);
  // Snapshot isolation: mutating the doc afterwards cannot poison the clip.
  doc.layers[1].color=99; doc.linetypes.DASHED[0]=999;
  assert.strictEqual(deps.layers.find(l=>l.name==="WALLS").color,3);
  assert.strictEqual(deps.linetypes.DASHED[0],5);
});

t("collectClipDeps tolerates a null/empty source document",()=>{
  assert.deepStrictEqual(collectClipDeps([L(0,0,1,1)],null),{});
  assert.deepStrictEqual(collectClipDeps([],srcDoc()),{});
});

t("missingClipDeps carries only what the target drawing lacks",()=>{
  const deps=collectClipDeps([L(0,0,10,0,"WALLS"),{...T(0,0,2.5,"A"),style:"TITLES"}],srcDoc());
  // deps carry: layers WALLS+0, dash DASHED (WALLS'), style TITLES.
  // Target already has 0 and a DASHED pattern; lacks WALLS (case-insensitive match) and TITLES.
  const target={layers:[{name:"0",color:7},{name:"walls",color:1}],linetypes:{DASHED:[1,-1]},textStyles:{}};
  const miss=missingClipDeps(target,deps);
  assert.deepStrictEqual(miss.layers.map(l=>l.name),[]);        // WALLS + 0 both match case-insensitively
  assert.deepStrictEqual(miss.linetypes.map(([n])=>n),[]);      // DASHED present → not carried
  assert.deepStrictEqual(miss.textStyles.map(([n])=>n),["TITLES"]);
  // Target without WALLS: the layer definition (with its colour) is carried.
  const miss2=missingClipDeps({layers:[{name:"0",color:7}],linetypes:{},textStyles:{}},deps);
  assert.deepStrictEqual(miss2.layers.map(l=>l.name),["WALLS"]);
  assert.strictEqual(miss2.layers[0].color,3);
  assert.deepStrictEqual(miss2.linetypes.map(([n])=>n),["DASHED"]);
  // Empty target: everything the clip carries is missing.
  const all=missingClipDeps({layers:[],linetypes:{},textStyles:{}},deps);
  assert.strictEqual(all.layers.length,2);
  assert.strictEqual(all.linetypes.length,1);
  assert.strictEqual(all.textStyles.length,1);
  assert.deepStrictEqual(missingClipDeps(target,null),{layers:[],linetypes:[],textStyles:[]});
});

/* ── Super Copy: persistence (reload + cross-window) ── */

t("serializeClip / parseClip round-trip keeps geometry, base and tables",()=>{
  const deps=collectClipDeps([L(0,0,10,0)],srcDoc());
  const clip=makeClip([L(0,0,10,0),T(1,1,2.5,"hi")],{x:5,y:0},"plan.dwg",deps);
  const json=serializeClip(clip);
  assert.ok(typeof json==="string" && json.length>10);
  const back=parseClip(json);
  assert.ok(back);
  near(back.base.x,5);near(back.base.y,0);
  assert.strictEqual(back.sourceName,"plan.dwg");
  assert.strictEqual(back.entities.length,2);
  assert.deepStrictEqual(back.entities[0].start,{x:0,y:0});
  assert.strictEqual(back.layers.length,1); // WALLS — the only layer the copied entities reference
  assert.deepStrictEqual(back.linetypes.DASHED,[5,-2]);
  // The restored clip pastes identically.
  const [l1,l2]=clipInstances(back,{x:15,y:0});
  near(l1.start.x,10);near(l2.position.x,11);
  // Mutating the restored clip cannot leak back into the stored JSON.
  back.entities[0].start.x=777;
  assert.strictEqual(JSON.parse(json).entities[0].start.x,0);
});

t("parseClip rejects garbage, truncation and foreign payloads",()=>{
  assert.strictEqual(parseClip(null),null);
  assert.strictEqual(parseClip(""),null);
  assert.strictEqual(parseClip("not json {"),null);
  assert.strictEqual(parseClip("42"),null);
  assert.strictEqual(parseClip(JSON.stringify({entities:[],base:{x:0,y:0}})),null);
  assert.strictEqual(parseClip(JSON.stringify({entities:[{type:"LINE",layer:"0",start:{x:0,y:0},end:{x:1,y:1}}]})),null); // no base
  assert.strictEqual(parseClip(JSON.stringify({entities:[{type:"LINE",layer:"0",start:{x:0,y:0},end:{x:1,y:1}}],base:{x:"a",y:0}})),null);
  assert.strictEqual(parseClip(JSON.stringify({entities:[{junk:1}],base:{x:0,y:0}})),null);
  assert.strictEqual(serializeClip(null),null);
  assert.strictEqual(serializeClip({entities:[],base:{x:0,y:0}}),null);
});

console.log(`\ncad-clipboard: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
