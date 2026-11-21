const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"vt-"));
execSync(`npx tsc src/modules/view-templates/category-map.ts src/modules/view-templates/vg-apply.ts src/modules/view-templates/view-templates-store.ts src/modules/revisions/model.ts src/modules/documentation/documentation-persistence.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
// In-memory localStorage so the stores exercise their real persist/load
// path in node instead of warning on every write.
globalThis.localStorage={_m:new Map(),getItem(k){return this._m.has(k)?this._m.get(k):null},setItem(k,v){this._m.set(k,String(v))},removeItem(k){this._m.delete(k)},clear(){this._m.clear()}};
const cat=require(path.join(out,"modules/view-templates/category-map.js"));
const vgApply=require(path.join(out,"modules/view-templates/vg-apply.js"));
const storeMod=require(path.join(out,"modules/view-templates/view-templates-store.js"));
const docMod=require(path.join(out,"modules/documentation/documentation-persistence.js"));
const revMod=require(path.join(out,"modules/revisions/model.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const store=storeMod.viewTemplatesStore;
const { createDefaultVg } = require(path.join(out,"modules/view-templates/types.js"));

// ── category map ────────────────────────────────────────────────────────
t("every authored element type maps to a real VG category",()=>{
  const types=["wall","slab","column","beam","brace","truss","footing","strip","mline","duct","pipe","cable-tray","conduit","equipment","fitting","door","window","vertical-opening","roof","stairs","railing","ramp","room","area","ceiling","terrain","curtain-wall","adaptive-component","grid","level","generic"];
  const known=new Set(cat.listVgCategories());
  for(const ty of types){const c=cat.toVgCategory(ty);assert.ok(known.has(c),`${ty} -> ${c} is not a VG category`);}
});
t("normalization: type, canonical id and case variants agree",()=>{
  assert.strictEqual(cat.toVgCategory("wall"),"Walls");
  assert.strictEqual(cat.toVgCategory("Walls"),"Walls");
  assert.strictEqual(cat.toVgCategory("WALLS"),"Walls");
  assert.strictEqual(cat.toVgCategory("  duct "), "Ducts");
  assert.strictEqual(cat.toVgCategory("beam"),"StructuralFraming");
  assert.strictEqual(cat.toVgCategory("cable-tray"),"CableTrays");
});
t("unknown categories pass through unchanged",()=>{
  assert.strictEqual(cat.toVgCategory("IfcWallStandardCase"),"IfcWallStandardCase");
  assert.strictEqual(cat.toVgCategory(""),"");
  assert.strictEqual(cat.toVgCategory(null),"");
});

// ── vg-apply resolver ───────────────────────────────────────────────────
const baseVg=()=>{const v=createDefaultVg();return v;};
t("resolver: hidden category is invisible",()=>{
  const v=baseVg();v.categoryOverrides.Walls={visible:false,halftone:false,transparent:false};
  assert.deepStrictEqual(vgApply.resolveElementVisibility({id:"e1",type:"wall"},v),{visible:false,halftone:false});
});
t("resolver: halftone category stays visible but halftone",()=>{
  const v=baseVg();v.categoryOverrides.Walls={visible:true,halftone:true,transparent:false};
  assert.deepStrictEqual(vgApply.resolveElementVisibility({id:"e1",type:"wall"},v),{visible:true,halftone:true});
  // the raw type and the canonical id resolve identically
  assert.deepStrictEqual(vgApply.resolveElementVisibility({id:"e1",category:"Walls"},v),{visible:true,halftone:true});
});
t("resolver: showModel false hides everything, showAnnotations gates annotations",()=>{
  const v=baseVg();v.showModel=false;assert.strictEqual(vgApply.resolveElementVisibility({id:"e1",type:"wall"},v).visible,false);
  const v2=baseVg();assert.strictEqual(vgApply.annotationsVisible(v2),true);v2.showAnnotations=false;assert.strictEqual(vgApply.annotationsVisible(v2),false);
});
t("resolver: phase predicate hides, design-option predicate hides",()=>{
  const v=baseVg();
  const noPhase=(a)=>a.phaseCreated!=="p2";
  assert.strictEqual(vgApply.resolveElementVisibility({id:"e1",type:"wall",phaseCreated:"p2"},v,{phaseVisible:noPhase}).visible,false);
  assert.strictEqual(vgApply.resolveElementVisibility({id:"e1",type:"wall",phaseCreated:"p1"},v,{phaseVisible:noPhase}).visible,true);
  // phase tags also read from properties (bridge parity)
  assert.strictEqual(vgApply.resolveElementVisibility({id:"e1",type:"wall",properties:{phaseCreated:"p2"}},v,{phaseVisible:noPhase}).visible,false);
  const noOpt=(id)=>id!=="opt-b";
  assert.strictEqual(vgApply.resolveElementVisibility({id:"e1",type:"wall",designOptionId:"opt-b"},v,{designOptionVisible:noOpt}).visible,false);
  assert.strictEqual(vgApply.resolveElementVisibility({id:"e1",type:"wall"},v,{designOptionVisible:noOpt}).visible,true);
});
t("resolver: unknown category and no predicates mean visible",()=>{
  assert.deepStrictEqual(vgApply.resolveElementVisibility({id:"e1",type:"something-new"},baseVg()),{visible:true,halftone:false});
});

// ── store: seeds, CRUD, merge ───────────────────────────────────────────
t("store seeds the four built-in templates",()=>{
  const names=store.listTemplates().map((x)=>x.name);
  for(const n of ["Architectural Plan","Structural Plan","Coordination","Presentation 3D"])assert.ok(names.includes(n),`missing seed ${n}`);
  const structural=store.listTemplates().find((x)=>x.name==="Structural Plan");
  assert.strictEqual(structural.vg.categoryOverrides.Ducts.visible,false);
  assert.strictEqual(structural.vg.categoryOverrides.Walls.halftone,true);
  const arch=store.listTemplates().find((x)=>x.name==="Architectural Plan");
  assert.strictEqual(arch.vg.categoryOverrides.Ducts.visible,false);
});
t("store CRUD + duplicate + delete clears bindings",()=>{
  const tmpl=store.createTemplate({name:"Test Tmpl",appliesTo:["plan"]});
  assert.ok(store.getTemplate(tmpl.id));
  store.updateTemplate(tmpl.id,{description:"d"});
  assert.strictEqual(store.getTemplate(tmpl.id).description,"d");
  const dup=store.duplicateTemplate(tmpl.id,"Test Tmpl Copy");
  assert.ok(dup && dup.id!==tmpl.id && dup.name==="Test Tmpl Copy");
  store.setViewTemplate("test-view-1",tmpl.id);
  assert.strictEqual(store.getViewBinding("test-view-1").templateId,tmpl.id);
  assert.strictEqual(store.deleteTemplate(tmpl.id),true);
  assert.strictEqual(store.getViewBinding("test-view-1").templateId,null);
  store.deleteTemplate(dup.id);
});
t("effective VG merges template + local, lock wins",()=>{
  const tmpl=store.createTemplate({name:"Merge Tmpl",appliesTo:["plan"]});
  store.updateTemplate(tmpl.id,{vg:{...createDefaultVg(),categoryOverrides:{Walls:{visible:false,halftone:false,transparent:false}}}});
  store.setViewTemplate("test-view-2",tmpl.id);
  const eff=store.getEffectiveVg("test-view-2");
  assert.strictEqual(eff.categoryOverrides.Walls.visible,false);
  // local override re-shows the category
  const local=createDefaultVg();local.categoryOverrides.Walls={visible:true,halftone:true,transparent:false};
  store.setViewLocalVg("test-view-2",local);
  const eff2=store.getEffectiveVg("test-view-2");
  assert.strictEqual(eff2.categoryOverrides.Walls.visible,true);
  assert.strictEqual(eff2.categoryOverrides.Walls.halftone,true);
  // locked template ignores local overrides entirely
  store.updateTemplate(tmpl.id,{locked:true});
  assert.strictEqual(store.getEffectiveVg("test-view-2").categoryOverrides.Walls.visible,false);
  store.deleteTemplate(tmpl.id);
});
t("effective VG falls back to the ViewDef template id",()=>{
  const tmpl=store.createTemplate({name:"Fallback Tmpl",appliesTo:["plan"]});
  store.updateTemplate(tmpl.id,{vg:{...createDefaultVg(),categoryOverrides:{Ducts:{visible:false,halftone:false,transparent:false}}}});
  // no store binding for this view — the ViewDef's own templateId applies
  const eff=store.getEffectiveVg("test-view-3",tmpl.id);
  assert.strictEqual(eff.categoryOverrides.Ducts.visible,false);
  store.deleteTemplate(tmpl.id);
});

// ── store: project persistence ──────────────────────────────────────────
t("serialize/restore round-trip preserves templates + bindings",()=>{
  const tmpl=store.createTemplate({name:"Roundtrip Tmpl",appliesTo:["plan"]});
  store.updateTemplate(tmpl.id,{vg:{...createDefaultVg(),categoryOverrides:{Pipes:{visible:false,halftone:false,transparent:false}}}});
  store.setViewTemplate("test-view-4",tmpl.id);
  const snap=store.serialize();
  assert.ok(snap.templates.some((x)=>x.name==="Roundtrip Tmpl"));
  assert.strictEqual(snap.bindings["test-view-4"].templateId,tmpl.id);
  const issues=store.restoreSnapshot(JSON.parse(JSON.stringify(snap)));
  assert.deepStrictEqual(issues,[]);
  assert.ok(store.getTemplate(tmpl.id));
  assert.strictEqual(store.getEffectiveVg("test-view-4").categoryOverrides.Pipes.visible,false);
  store.deleteTemplate(tmpl.id);
});
t("restore drops malformed entries with issues, never throws",()=>{
  const before=store.listTemplates().length;
  const issues=store.restoreSnapshot({templates:[{id:"ok-1",name:"OK",vg:createDefaultVg(),appliesTo:["plan"],locked:false,includes:{},createdAt:"",updatedAt:""},{id:123},{name:"no id"},null,"str"],bindings:{"v1":{templateId:"ok-1",localVg:null},"v2":"nope","v3":{templateId:42,localVg:{categoryOverrides:[]}}}});
  assert.ok(issues.length>=4,"expected several issues, got "+JSON.stringify(issues));
  assert.ok(store.getTemplate("ok-1"));
  assert.strictEqual(store.getViewBinding("v1").templateId,"ok-1");
  assert.strictEqual(store.listTemplates().length,1);
  assert.ok(before>=0);
});
t("restore refuses a __proto__ category key (no prototype pollution)",()=>{
  const snap=JSON.parse('{"templates":[{"id":"pp-1","name":"PP","vg":{"categoryOverrides":{"__proto__":{"visible":false},"Walls":{"visible":false,"halftone":true}},"filters":[],"showAnnotations":true,"showModel":true,"detailLevel":"medium","modelDisplay":"shaded"},"appliesTo":["plan"],"locked":false,"includes":{"modelCategories":true,"annotationCategories":true,"filters":true,"detailLevel":true,"modelDisplay":true},"createdAt":"","updatedAt":""}],"bindings":{}}');
  const issues=store.restoreSnapshot(snap);
  assert.deepStrictEqual(issues,[]);
  assert.strictEqual(store.getTemplate("pp-1").vg.categoryOverrides.Walls.visible,false);
  assert.strictEqual(({}).polluted,undefined);
  assert.strictEqual(Object.prototype.polluted,undefined);
  store.deleteTemplate("pp-1");
});
t("restore of a non-object leaves the store untouched",()=>{
  const before=store.serialize();
  const issues=store.restoreSnapshot("garbage");
  assert.ok(issues.length===1);
  assert.deepStrictEqual(store.serialize(),before);
});

// ── documentation persistence ───────────────────────────────────────────
t("documentation snapshot round-trips templates + revisions + clouds",()=>{
  const tmpl=store.createTemplate({name:"Doc Tmpl",appliesTo:["plan"]});
  store.setViewTemplate("doc-view-1",tmpl.id);
  const rev=revMod.addRevisionRecord({description:"Doc rev",sheetIds:["sheet-1"]});
  const cloud=revMod.addRevisionCloudDef({revisionId:rev.id,points:[[0,0],[4,0],[4,3],[0,3]],viewId:"plan-level-0",sheetId:null});
  const snap=docMod.serializeDocumentation();
  assert.strictEqual(snap.version,1);
  assert.ok(snap.viewTemplates.templates.some((x)=>x.name==="Doc Tmpl"));
  assert.strictEqual(snap.revisions.revisions.length,1);
  assert.strictEqual(snap.revisions.clouds.length,1);
  // wipe and restore
  store.restoreSnapshot({templates:[],bindings:{}});
  revMod.replaceAllRevisions([],[]);
  const res=docMod.restoreDocumentation(JSON.parse(JSON.stringify(snap)));
  assert.strictEqual(res.applied,true);
  assert.deepStrictEqual(res.issues,[]);
  assert.ok(store.getTemplate(tmpl.id));
  assert.strictEqual(store.getViewBinding("doc-view-1").templateId,tmpl.id);
  assert.strictEqual(revMod.listAllRevisions().length,1);
  assert.strictEqual(revMod.listAllClouds().length,1);
  assert.strictEqual(revMod.listAllClouds()[0].id,cloud.id);
  store.deleteTemplate(tmpl.id);
  revMod.replaceAllRevisions([],[]);
});
t("documentation restore drops malformed revisions/clouds with issues",()=>{
  const res=docMod.restoreDocumentation({version:1,viewTemplates:{templates:[],bindings:{}},revisions:{revisions:[{id:"r1",sequence:1},{id:"",sequence:1},{sequence:"x"},null],clouds:[{id:"c1",revisionId:"r1",points:[[0,0],[1,0],[0,1]]},{id:"c2",revisionId:"r1",points:[[0,0],[1,1]]},{id:"c3",revisionId:"r1",points:[[0,0],["a",0],[0,1]]}]}});
  assert.strictEqual(res.applied,true);
  assert.ok(res.issues.length>=4,"issues: "+JSON.stringify(res.issues));
  assert.strictEqual(res.counts.revisions,1);
  assert.strictEqual(res.counts.clouds,1);
  assert.strictEqual(revMod.listAllRevisions()[0].sequenceLabel,"Rev 01");
  revMod.replaceAllRevisions([],[]);
});
t("documentation restore refuses unknown versions and non-objects",()=>{
  const r1=docMod.restoreDocumentation({version:99});
  assert.strictEqual(r1.applied,false);
  assert.ok(r1.issues.length===1);
  const r2=docMod.restoreDocumentation(null);
  assert.strictEqual(r2.applied,false);
  const r3=docMod.restoreDocumentation("nope");
  assert.strictEqual(r3.applied,false);
});
t("normalizeRevisionRecord/Cloud reject hostile shapes",()=>{
  assert.strictEqual(docMod.normalizeRevisionRecord(null),null);
  assert.strictEqual(docMod.normalizeRevisionRecord({id:"x"}),null);
  assert.strictEqual(docMod.normalizeRevisionRecord({id:"x",sequence:NaN}),null);
  assert.strictEqual(docMod.normalizeRevisionRecord({id:"x",sequence:2,status:"bogus"}).status,"draft");
  assert.strictEqual(docMod.normalizeRevisionCloud({id:"c",revisionId:"r",points:[[0,0],[1,0]]}),null);
  assert.strictEqual(docMod.normalizeRevisionCloud({id:"c",revisionId:"r",points:[[0,0],[1,0],[0,Infinity]]}),null);
  assert.strictEqual(docMod.normalizeRevisionCloud({id:"c",revisionId:"r",points:[[0,0],[2,0],[0,2]]}).viewId,null);
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
