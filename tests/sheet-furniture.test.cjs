const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"sheetfurn-"));
execSync(`npx tsc src/modules/sheets/sheet-furniture.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
// tsc includes the (type-only) projects/types graph, so emit may be nested — find the js artifact.
function findJs(dir,name){const r=[];for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())r.push(...findJs(p,name));else if(e.name===name)r.push(p);}return r;}
const artifact=findJs(out,"sheet-furniture.js")[0];
assert.ok(artifact,"sheet-furniture.js not produced by tsc");
const m=require(artifact);
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};

// ── normalizeScaleText ──
t("scale text: '100' → '1:100'",()=>assert.strictEqual(m.normalizeScaleText("100"),"1:100"));
t("scale text: 100 → '1:100'",()=>assert.strictEqual(m.normalizeScaleText(100),"1:100"));
t("scale text: '1:100' kept",()=>assert.strictEqual(m.normalizeScaleText("1:100"),"1:100"));
t("scale text: '1 : 100' compacted",()=>assert.strictEqual(m.normalizeScaleText("1 : 100"),"1:100"));
t("scale text: empty → ''",()=>assert.strictEqual(m.normalizeScaleText(""),""));
t("scale text: garbage → ''",()=>assert.strictEqual(m.normalizeScaleText("abc"),""));

// ── view title ──
t("title: name + normalized scale",()=>assert.strictEqual(m.viewTitleText({title:"Level 1",scale:"100"},"Plan"),"Level 1 · 1:100"));
t("title: falls back to view name",()=>assert.strictEqual(m.viewTitleText({title:"",scale:"1:50"},"Section A"),"Section A · 1:50"));
t("title: no scale → name only",()=>assert.strictEqual(m.viewTitleText({title:"Detail",scale:""},"Detail"),"Detail"));

// ── caption layout ──
t("caption sits below the viewport",()=>{
  const c=m.viewportCaptionY(100,290);
  assert.ok(Math.abs(c.titleY-103.2)<1e-9); assert.ok(Math.abs(c.barBaselineY-107.8)<1e-9); assert.strictEqual(c.clamped,false);
});
t("caption clamps inside the drawing area",()=>{
  const c=m.viewportCaptionY(289,290);
  assert.ok(c.titleY<=289,"titleY "+c.titleY); assert.strictEqual(c.clamped,true);
  assert.ok(c.barBaselineY<=290,"barY "+c.barBaselineY);
});

// ── scale bar ──
t("1:100 bar: 0.5 m segments, 2 m total, nice labels",()=>{
  const l=m.scaleBarLayout(100);
  assert.ok(Math.abs(l.segmentMm-5)<1e-9,"seg "+l.segmentMm);
  assert.strictEqual(l.segments,4);
  assert.ok(Math.abs(l.worldPerSegmentM-0.5)<1e-9);
  assert.ok(Math.abs(l.totalWorldM-2)<1e-9);
  assert.deepStrictEqual(l.labels.map(x=>x.text),["0","1 m","2 m"]);
  assert.deepStrictEqual(l.filled,[true,false,true,false]);
});
t("1:500 bar: 2.5 m segments, 10 m total",()=>{
  const l=m.scaleBarLayout(500);
  assert.ok(Math.abs(l.segmentMm-5)<1e-9,"seg "+l.segmentMm);
  assert.ok(Math.abs(l.totalWorldM-10)<1e-9);
  assert.strictEqual(l.labels[2].text,"10 m");
});
t("1:20 bar: sub-metre labels in cm",()=>{
  const l=m.scaleBarLayout(20);
  assert.ok(Math.abs(l.totalWorldM-0.4)<1e-9,"total "+l.totalWorldM);
  assert.strictEqual(l.labels[2].text,"40 cm");
});
t("extreme scale falls back to a ~30 mm bar",()=>{
  const l=m.scaleBarLayout(3);
  assert.ok(Math.abs(l.barLengthMm-30)<1e-9,"bar "+l.barLengthMm);
  assert.ok(l.labels.every(x=>x.text.length>0));
});
t("formatWorldLength picks the right unit",()=>{
  assert.strictEqual(m.formatWorldLength(1.5),"1.5 m");
  assert.strictEqual(m.formatWorldLength(0.4),"40 cm");
  assert.strictEqual(m.formatWorldLength(0.005),"5 mm");
  assert.strictEqual(m.formatWorldLength(2500),"2.5 km");
});
t("scaleBarSvg renders alternating segments + labels",()=>{
  const svg=m.scaleBarSvg(10,100,m.scaleBarLayout(100));
  assert.ok(svg.startsWith('<g class="scale-bar" pointer-events="none">'));
  const rects=(svg.match(/<rect/g)||[]).length;
  assert.strictEqual(rects,4);
  assert.ok(svg.includes(">0</text>")&&svg.includes(">1 m</text>")&&svg.includes(">2 m</text>"));
});

// ── north arrow ──
t("needle geometry points north inside the circle",()=>{
  const g=m.northArrowGeometry(10);
  assert.ok(g.needleTip[1]<0,"tip should be above center");
  for (const p of [g.needleTip,g.needleLeft,g.needleRight,g.southTip]) {
    assert.ok(Math.hypot(p[0],p[1])<=10,"point outside radius: "+p);
  }
  assert.strictEqual(g.needleLeft[0],-g.needleRight[0]);
});
t("northArrowSvg carries circle, needle and N",()=>{
  const svg=m.northArrowSvg(100,50,8);
  assert.ok(svg.includes("<circle")); assert.ok(svg.includes("<polygon"));
  assert.ok(svg.includes(">N</text>")); assert.ok(svg.includes('pointer-events="none"'));
});
t("north arrow placement avoids viewport collisions",()=>{
  const far=m.northArrowPlacement(841,594,10,8,[{x:50,y:200,width:300,height:200}]);
  assert.ok(far.visible); assert.ok(Math.abs(far.cx-(841-10-8-2))<1e-9);
  const hit=m.northArrowPlacement(841,594,10,8,[{x:790,y:10,width:40,height:40}]);
  assert.strictEqual(hit.visible,false);
});

// ── titleblock rows ──
const TB={id:"tb1",name:"Standard",size:"A1",fields:[
  {key:"project",label:"Project",value:"Tower A"},
  {key:"sheet_name",label:"Sheet Name",value:""},
  {key:"sheet_no",label:"Sheet No.",value:""},
  {key:"drawn_by",label:"Drawn",value:"AG"},
  {key:"checked_by",label:"Checked",value:""},
  {key:"date",label:"Date",value:""},
  {key:"scale",label:"Scale",value:"As noted"},
  {key:"rev",label:"Rev",value:"2"},
]};
const SHEET={id:"s1",number:"A-101",name:"Level 1 Plan",size:"A1",orientation:"landscape",viewports:[],createdAt:0,updatedAt:0};
t("rows drop sheet identity fields, keep the rest",()=>{
  const rows=m.titleblockRows(TB,SHEET,"2026-11-11",["1:100"]);
  const labels=rows.map(r=>r.label.toLowerCase());
  assert.ok(!labels.includes("sheet no.")); assert.ok(!labels.includes("sheet name"));
  assert.strictEqual(rows.length,6);
});
t("scale row reflects the placed viewports (deduped)",()=>{
  const rows=m.titleblockRows(TB,SHEET,"2026-11-11",["1:100","100","1:100"]);
  const scale=rows.find(r=>r.label==="Scale");
  assert.strictEqual(scale.value,"1:100");
});
t("empty date falls back to today",()=>{
  const rows=m.titleblockRows(TB,SHEET,"2026-11-11",[]);
  assert.strictEqual(rows.find(r=>r.label==="Date").value,"2026-11-11");
});
t("empty checked falls back to em dash",()=>{
  const rows=m.titleblockRows(TB,SHEET,"2026-11-11",[]);
  assert.strictEqual(rows.find(r=>r.label==="Checked").value,"—");
});
t("no titleblock → sane default rows",()=>{
  const rows=m.titleblockRows(undefined,SHEET,"2026-11-11",[]);
  assert.ok(rows.some(r=>r.label==="Project"&&r.value==="—"));
  assert.ok(rows.some(r=>r.label==="Scale"));
});
t("sheet identity line",()=>assert.strictEqual(m.sheetIdentityText(SHEET),"A-101 — Level 1 Plan"));

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
