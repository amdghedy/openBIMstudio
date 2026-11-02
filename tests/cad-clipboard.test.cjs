/* Cross-drawing clipboard tests (COPYCLIP / PASTECLIP / PASTEORIG) for the CAD Editor.
 *
 * Pins the multi-file interaction contract:
 *   1. makeClip deep-copies (source mutations never leak into the clip)
 *   2. clipInstances translates the base point onto the drop point
 *   3. verbatim instantiation for PASTEORIG (no translation)
 *   4. per-kind geometry translation (LINE, CIRCLE, ARC, LWPOLYLINE, TEXT, POINT)
 *   5. fresh object identities — no aliasing between clip, source, and paste
 */
const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"cadclip-"));
execSync(`npx tsc src/modules/cad-viewer/clipboard.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"pipe"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const {makeClip,clipInstances,translateEntity}=require(find(out,"clipboard.js"));
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
console.log(`\ncad-clipboard: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
