const {execSync}=require("child_process");const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"cm-"));
execSync(`npx tsc src/features/context-menu-model.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`,{stdio:"inherit"});
const m=require(path.join(out,"context-menu-model.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const DEFS=[["move","Move","MV","s"],["copy","Copy","CO","s"],["paste","Paste","Ctrl+V",""],["rotate","Rotate","RO","s"],["mirror","Mirror","MI","s"],["array","Array","AR","s"],["offset","Offset","OF","s"],["scale","Scale","SC","s"],["create-similar","Create Similar","","s"],["match-props","Match Properties","","s"],["select-similar","Select Similar","","s"],["align-x","Align X","","m"],["align-z","Align Z","","m"],["pin","Pin","","s"],["unpin","Unpin","","s"],["split-mid","Split at Midpoint","","s"],["join-walls","Join Walls","","s"],["delete","Delete","Del","s"]]
 .map(([id,label,shortcut,k])=>({id,label,shortcut,needsSelection:k==="s",needsMulti:k==="m"}));
const CMDS=["global.cancel","global.repeat","global.selectAll","global.clearSelection","global.undo","global.redo","view.fit","view.home","view.top","view.front","view.ortho","view.perspective","review.isolate","review.hide","review.reveal","review.focus","modify.trimExtend","modify.typeProperties"];
const calls=[];
const deps=(o={})=>({authoredCount:0,linkedCount:0,clipboardCount:0,modifyDefs:DEFS,activeModifyTool:()=>false,runModify:id=>calls.push(["modify",id]),command:id=>calls.push(["cmd",id]),hasCommand:id=>CMDS.includes(id),openDialog:k=>calls.push(["dlg",k]),setTool:x=>calls.push(["tool",x]),copyToClipboard:()=>calls.push(["clip"]),makeNativeTwin:()=>calls.push(["twin"]),openProperties:()=>calls.push(["props"]),...o});
const sub=(items,text)=>items.find(i=>i.type==="sub"&&i.text===text);
const acts=items=>items.filter(i=>i.type==="action");
const flat=items=>items.flatMap(i=>i.type==="sub"?flat(i.items):[i]);

t("main menu offers Modify, Create, View, Visibility and Select flyouts even with nothing selected",()=>{
  const it=m.buildContextMenu(deps());for(const n of ["Modify","Create","View","Visibility","Select"])assert.ok(sub(it,n),n+" missing")});
t("Modify flyout contains every required modify tool",()=>{
  const fl=sub(m.buildContextMenu(deps({authoredCount:2})),"Modify").items;const names=acts(fl).map(a=>a.text);
  for(const n of ["Move","Copy","Rotate","Mirror","Scale","Array","Offset","Trim / Extend to Corner","Split at Midpoint","Join Walls","Align X","Align Z","Create Similar","Match Properties","Select Similar","Copy to Clipboard","Paste","Pin","Unpin","Delete","Move…","Rotate…","Mirror…","Array…"])assert.ok(names.includes(n),n+" missing")});
t("Modify flyout is grouped with headings",()=>{
  const labels=sub(m.buildContextMenu(deps({authoredCount:1})),"Modify").items.filter(i=>i.type==="label").map(i=>i.text);
  assert.deepStrictEqual(labels,["TRANSFORM","EDIT","CREATE & MATCH","CLIPBOARD","CONSTRAINTS","PRECISE (ENTER VALUES)"])});
t("nothing selected: selection-dependent tools are disabled with an explanation, Paste follows the clipboard",()=>{
  const fl=sub(m.buildContextMenu(deps()),"Modify").items;const g=n=>acts(fl).find(a=>a.text===n);
  for(const n of ["Move","Copy","Rotate","Mirror","Delete","Move…"]){assert.ok(g(n).disabled,n);assert.ok(g(n).title,n+" needs a hint")}
  assert.ok(g("Paste").disabled);
  const fl2=sub(m.buildContextMenu(deps({clipboardCount:3})),"Modify").items;assert.ok(!acts(fl2).find(a=>a.text==="Paste").disabled)});
t("one element: Align and Trim need two or more; the single-element tools are enabled",()=>{
  const fl=sub(m.buildContextMenu(deps({authoredCount:1})),"Modify").items;const g=n=>acts(fl).find(a=>a.text===n);
  assert.ok(g("Align X").disabled&&g("Align Z").disabled&&g("Trim / Extend to Corner").disabled);assert.ok(!g("Move").disabled&&!g("Delete").disabled);
  const f2=sub(m.buildContextMenu(deps({authoredCount:2})),"Modify").items;assert.ok(!acts(f2).find(a=>a.text==="Align X").disabled)});
t("every action is wired to its real handler",()=>{
  calls.length=0;const fl=sub(m.buildContextMenu(deps({authoredCount:2})),"Modify").items;const g=n=>acts(fl).find(a=>a.text===n);
  g("Mirror").onclick();g("Trim / Extend to Corner").onclick();g("Move…").onclick();g("Copy to Clipboard").onclick();g("Delete").onclick();
  assert.deepStrictEqual(calls,[["modify","mirror"],["cmd","modify.trimExtend"],["dlg","move"],["clip"],["modify","delete"]])});
t("Create flyout starts the matching authoring tool",()=>{
  calls.length=0;const cr=sub(m.buildContextMenu(deps()),"Create").items;acts(cr).find(a=>a.text==="Wall").onclick();acts(cr).find(a=>a.text==="Duct").onclick();
  assert.deepStrictEqual(calls,[["tool","wall"],["tool","duct"]])});
t("no empty or handler-less actions anywhere; commands that are not registered are omitted, not faked",()=>{
  for(const a of flat(m.buildContextMenu(deps({authoredCount:2})))){if(a.type==="action"){assert.ok(a.text&&typeof a.onclick==="function",a.text)}}
  const it=m.buildContextMenu(deps({hasCommand:()=>false}));assert.ok(!flat(it).some(a=>a.text==="Undo"||a.text==="Zoom to Fit"));assert.ok(sub(it,"Modify"))});
t("Delete is the only danger item and sits last in the Modify flyout",()=>{
  const fl=sub(m.buildContextMenu(deps({authoredCount:1})),"Modify").items;const last=fl[fl.length-1];assert.ok(last.type==="action"&&last.text==="Delete"&&last.danger);assert.strictEqual(fl.filter(i=>i.danger).length,1)});
t("selection label reflects authored vs linked selection; Native Twin / Properties follow selection",()=>{
  assert.strictEqual(m.buildContextMenu(deps({authoredCount:3}))[0].text,"Authored: 3 element(s)");assert.strictEqual(m.buildContextMenu(deps({linkedCount:2}))[0].text,"Selection: 2 item(s)");
  const e=m.buildContextMenu(deps());assert.ok(acts(e).find(a=>a.text==="Make Editable Native Twin").disabled);const s=m.buildContextMenu(deps({linkedCount:1}));assert.ok(!acts(s).find(a=>a.text==="Properties").disabled)});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
