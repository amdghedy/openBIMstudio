const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"rv-"));
execSync(`npx tsc src/modules/revisions/model.ts src/modules/revisions/cloud-renderer.ts src/modules/revisions/titleblock.ts src/modules/revisions/filter.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
// In-memory localStorage so the store exercises its real persist/load path.
globalThis.localStorage={_m:new Map(),getItem(k){return this._m.has(k)?this._m.get(k):null},setItem(k,v){this._m.set(k,String(v))},removeItem(k){this._m.delete(k)},clear(){this._m.clear()}};
const model=require(path.join(out,"model.js"));
const clouds=require(path.join(out,"cloud-renderer.js"));
const tb=require(path.join(out,"titleblock.js"));
const filter=require(path.join(out,"filter.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const near=(a,b,e=1e-9)=>assert.ok(Math.abs(a-b)<e,`${a}!=${b}`);

// ── model: records ──────────────────────────────────────────────────────
t("sequence auto-increments with Rev labels",()=>{
  model.replaceAllRevisions([],[]);
  const r1=model.addRevisionRecord({description:"First"});
  const r2=model.addRevisionRecord({description:"Second"});
  assert.strictEqual(r1.sequence,1);assert.strictEqual(r1.sequenceLabel,"Rev 01");
  assert.strictEqual(r2.sequence,2);assert.strictEqual(r2.sequenceLabel,"Rev 02");
  assert.strictEqual(r1.status,"draft");
  assert.strictEqual(r1.visible,true);
});
t("update + remove cascade to clouds",()=>{
  model.replaceAllRevisions([],[]);
  const r=model.addRevisionRecord({description:"To remove"});
  const c=model.addRevisionCloudDef({revisionId:r.id,points:[[0,0],[2,0],[2,1],[0,1]],viewId:null,sheetId:null});
  assert.strictEqual(model.listAllClouds().length,1);
  model.updateRevisionRecord(r.id,{description:"Renamed",status:"issued-for-construction"});
  assert.strictEqual(model.listAllRevisions()[0].description,"Renamed");
  assert.strictEqual(model.listAllRevisions()[0].status,"issued-for-construction");
  model.removeRevisionRecord(r.id);
  assert.strictEqual(model.listAllRevisions().length,0);
  assert.strictEqual(model.listAllClouds().length,0);
  assert.strictEqual(c.revisionId,r.id);
});
t("getSheetRevisions: project-wide + sheet-specific, hidden excluded",()=>{
  model.replaceAllRevisions([],[]);
  const wide=model.addRevisionRecord({description:"Wide",sheetIds:[]});
  const s1=model.addRevisionRecord({description:"S1",sheetIds:["sheet-1"]});
  const s2=model.addRevisionRecord({description:"S2",sheetIds:["sheet-2"]});
  const hidden=model.addRevisionRecord({description:"Hidden",sheetIds:[],visible:false});
  const forS1=model.getSheetRevisions("sheet-1").map((r)=>r.id);
  assert.ok(forS1.includes(wide.id)&&forS1.includes(s1.id));
  assert.ok(!forS1.includes(s2.id)&&!forS1.includes(hidden.id));
  assert.strictEqual(model.getSheetRevisions("sheet-2").length,2);
});
t("cloud visibility: bound clouds stay in their view, unassigned show everywhere",()=>{
  model.replaceAllRevisions([],[]);
  const r=model.addRevisionRecord({description:"R"});
  model.addRevisionCloudDef({revisionId:r.id,points:[[0,0],[2,0],[2,1],[0,1]],viewId:"plan-level-0",sheetId:null});
  model.addRevisionCloudDef({revisionId:r.id,points:[[0,0],[2,0],[2,1],[0,1]],viewId:null,sheetId:null});
  model.addRevisionCloudDef({revisionId:r.id,points:[[0,0],[2,0],[2,1],[0,1]],viewId:"plan-level-1",sheetId:null});
  assert.strictEqual(model.listCloudsForView("plan-level-0").length,1);
  assert.strictEqual(model.listCloudsVisibleInView("plan-level-0").length,2);
  assert.strictEqual(model.listCloudsVisibleInView("plan-level-1").length,2);
  assert.strictEqual(model.listCloudsVisibleInView("section-a").length,1);
});
t("replaceAll + serialize round-trip; empty stays empty",()=>{
  model.replaceAllRevisions([],[]);
  const r=model.addRevisionRecord({description:"RT",sheetIds:["s1"],elementIds:["e1","e2"]});
  const c=model.addRevisionCloudDef({revisionId:r.id,points:[[0,0],[3,0],[3,2],[0,2]],viewId:"plan-level-0",sheetId:"s1",note:"n"});
  const snap=model.serializeRevisions();
  assert.strictEqual(snap.revisions.length,1);
  assert.strictEqual(snap.clouds[0].note,"n");
  const back=model.replaceAllRevisions([],[]);
  assert.deepStrictEqual(back,{revisions:0,clouds:0});
  assert.strictEqual(model.listAllRevisions().length,0);
  assert.strictEqual(model.listAllClouds().length,0);
  const again=model.replaceAllRevisions(snap.revisions,snap.clouds);
  assert.deepStrictEqual(again,{revisions:1,clouds:1});
  assert.strictEqual(model.listAllRevisions()[0].elementIds.length,2);
  model.replaceAllRevisions([],[]);
});

// ── cloud renderer ──────────────────────────────────────────────────────
t("cloud SVG path is a scalloped closed path",()=>{
  const d=clouds.polygonToCloudSvgPath([[0,0],[10,0],[10,10],[0,10]]);
  assert.ok(d.startsWith("M "));
  assert.ok(d.includes("Q "));
  assert.ok(d.endsWith("Z"));
  assert.ok((d.match(/Q /g)||[]).length>=4);
  assert.strictEqual(clouds.polygonToCloudSvgPath([[0,0],[1,0]]),"");
  assert.strictEqual(clouds.polygonToCloudSvgPath([]),"");
});
t("cloud polyline samples the same scallops as points",()=>{
  const pts=clouds.cloudPolygonToPolyline([[0,0],[10,0],[10,10],[0,10]],2,6);
  assert.ok(pts.length>24,"expected many samples, got "+pts.length);
  // sampled points stay within one bulge (0.7*r) of the square boundary
  let maxOut=0;
  for(const [x,y] of pts){
    const outside=Math.max(-x,0,x-10,-y,0,y-10);
    maxOut=Math.max(maxOut,outside);
  }
  assert.ok(maxOut<=2*0.7+1e-9,"scallop bulge exceeded, maxOut="+maxOut);
  // first and last samples are near the start vertex (loop closes)
  assert.ok(Math.hypot(pts[0][0]-pts[pts.length-1][0],pts[0][1]-pts[pts.length-1][1])<2.5);
  assert.strictEqual(clouds.cloudPolygonToPolyline([[0,0],[1,0]],2,6).length,0);
});
t("renderCloudsSvg emits one red path per cloud",()=>{
  const svg=clouds.renderCloudsSvg([
    {id:"c1",revisionId:"r",points:[[0,0],[4,0],[4,4],[0,4]],viewId:null,sheetId:null},
    {id:"c2",revisionId:"r",points:[[0,0],[2,0],[2,2],[0,2]],viewId:null,sheetId:null},
  ]);
  assert.strictEqual((svg.match(/<path /g)||[]).length,2);
  assert.ok(svg.includes('stroke="#ef4444"'));
});

// ── titleblock ──────────────────────────────────────────────────────────
t("revision table SVG carries the revision data",()=>{
  const revs=[
    {id:"r1",sequence:1,sequenceLabel:"Rev 01",description:"Move door D-101",date:"2026-11-21",issuedTo:"Client",issuedBy:"AM",checkedBy:"",approvedBy:"",status:"issued-for-construction",sheetIds:[],elementIds:[],visible:true},
    {id:"r2",sequence:2,sequenceLabel:"Rev 02",description:"Widen corridor",date:"2026-11-20",issuedTo:"",issuedBy:"JK",checkedBy:"",approvedBy:"",status:"draft",sheetIds:[],elementIds:[]},
  ];
  const svg=tb.renderRevisionTableSvg(revs,0,0);
  assert.ok(svg.includes("REV")&&svg.includes("DATE")&&svg.includes("DESCRIPTION")&&svg.includes("BY"));
  assert.ok(svg.includes("Rev 01")&&svg.includes("Move door D-101")&&svg.includes("2026-11-21")&&svg.includes("AM"));
  assert.ok(svg.includes("Rev 02")&&svg.includes("Widen corridor"));
  assert.ok(svg.includes('class="obs-titleblock-revision-table"'));
});
t("injectRevisionTableIntoSvg inserts before </svg> and keeps the sheet",()=>{
  const sheet='<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0"/></svg>';
  const revs=[{id:"r1",sequence:1,sequenceLabel:"Rev 01",description:"D",date:"2026-11-21",issuedTo:"",issuedBy:"A",checkedBy:"",approvedBy:"",status:"draft",sheetIds:[],elementIds:[]}];
  const out=tb.injectRevisionTableIntoSvg(sheet,revs,420,297);
  assert.ok(out.includes('<rect x="0" y="0"/>'));
  assert.ok(out.includes("Rev 01"));
  assert.ok(out.indexOf("obs-titleblock-revision-table")<out.indexOf("</svg>"));
  assert.ok(out.endsWith("</svg>"));
});

// ── filter ──────────────────────────────────────────────────────────────
t("filter: changed elements per revision and between revisions",()=>{
  model.replaceAllRevisions([],[]);
  const r1=model.addRevisionRecord({description:"R1",elementIds:["e1","e2"]});
  const r2=model.addRevisionRecord({description:"R2",elementIds:["e2","e3"]});
  const r3=model.addRevisionRecord({description:"R3",elementIds:["e4"]});
  assert.deepStrictEqual(filter.getElementsChangedInRevision(r2.id).sort(),["e2","e3"]);
  assert.deepStrictEqual(filter.getElementsChangedBetween(r1.id,r3.id).sort(),["e2","e3","e4"]);
  assert.deepStrictEqual(filter.getElementsChangedBetween(r3.id,r1.id).sort(),["e2","e3","e4"]);
  assert.deepStrictEqual(filter.getElementsChangedInRevision("nope"),[]);
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
