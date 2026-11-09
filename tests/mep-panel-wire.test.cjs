const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"mpw-"));
execSync(`npx tsc src/modules/mep/electrical.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const m=require(find(out,"electrical.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};

const circuit=(over={})=>({id:"c1",panelId:"P1",circuitNumber:1,loadIds:["l1"],breakerRatingA:16,poles:1,voltageV:230,phase:1,...over});
const load=(over={})=>({id:"l1",name:"Lighting",apparentPowerVA:1800,voltageV:230,phase:1,poles:1,...over});

t("wireCircuit selects the smallest ampacity-covered conductor",()=>{
  const r=m.wireCircuit(circuit(),10,"P1"); // 10 A → 1.5 mm² (17.5 A ref)
  assert.strictEqual(r.wireSizeMm2,1.5);
  assert.strictEqual(r.ampacityA,17.5);
  assert.strictEqual(r.dropPercent,null); // no length given
});
t("voltage drop scales with length and is flagged beyond 3% / 5%",()=>{
  const short=m.wireCircuit(circuit({wireLengthM:10}),15,"P1");
  const long=m.wireCircuit(circuit({wireLengthM:200}),15,"P1");
  assert.ok(short.dropPercent !== null && short.dropPercent < 3, `${short.dropPercent}`);
  assert.ok(long.diagnostics.some(d=>d.code==="VOLTAGE_DROP_EXCEEDED"),JSON.stringify(long.diagnostics));
  const mid=m.wireCircuit(circuit({wireLengthM:120}),15,"P1");
  if (mid.dropPercent > 3 && mid.dropPercent <= 5) {
    assert.ok(mid.diagnostics.some(d=>d.code==="VOLTAGE_DROP_HIGH"));
  }
});
t("drop grows monotonically with length (same conductor)",()=>{
  const a=m.wireCircuit(circuit({wireLengthM:20}),15,"P1").dropPercent;
  const b=m.wireCircuit(circuit({wireLengthM:80}),15,"P1").dropPercent;
  assert.ok(b>a, `${b} vs ${a}`);
});
t("design current beyond the largest conductor is an error, not a guess",()=>{
  const r=m.wireCircuit(circuit({breakerRatingA:500}),500,"P1");
  assert.strictEqual(r.wireSizeMm2,null);
  assert.ok(r.diagnostics.some(d=>d.code==="WIRE_SIZE_UNAVAILABLE"));
});
t("buildPanelSchedule rows carry wire size and drop",()=>{
  const panel={id:"P1",name:"LP-1",voltageV:230,phase:1,busRatingA:100,circuitSpaces:12,circuits:[
    circuit({id:"c1",circuitNumber:1,wireLengthM:15}),
    circuit({id:"c2",circuitNumber:2,loadIds:["l2"],breakerRatingA:20,wireLengthM:150}),
  ]};
  const loads=[load(),load({id:"l2",name:"Sockets",apparentPowerVA:3200,powerFactor:0.9})];
  const s=m.buildPanelSchedule(panel,loads);
  const r1=s.rows.find(r=>r.circuitId==="c1"), r2=s.rows.find(r=>r.circuitId==="c2");
  assert.strictEqual(r1.wireSizeMm2,1.5);
  assert.ok(r1.voltageDropPercent !== null && r1.voltageDropPercent < 3);
  assert.ok(r2.wireSizeMm2 !== null);
  // 3200 VA @ 230 V pf 0.9 → 15.45 A on 150 m of 2.5 mm² → well beyond 5%.
  assert.ok(r2.status==="error", `${r2.status} ${JSON.stringify(s.diagnostics)}`);
  assert.ok(s.diagnostics.some(d=>d.code==="VOLTAGE_DROP_EXCEEDED"));
});
t("clean panel keeps status ok with no wire diagnostics",()=>{
  const panel={id:"P1",name:"LP-1",voltageV:230,phase:1,busRatingA:100,circuitSpaces:12,circuits:[
    circuit({id:"c1",circuitNumber:1,wireLengthM:10}),
  ]};
  const s=m.buildPanelSchedule(panel,[load({apparentPowerVA:1200})]);
  const r1=s.rows[0];
  assert.strictEqual(r1.status,"ok");
  assert.ok(!s.diagnostics.some(d=>d.severity!=="ok"&&d.severity!==undefined&&d.code.startsWith("VOLTAGE")||d.code==="WIRE_SIZE_UNAVAILABLE"));
});
t("three-phase circuit drop uses the √3 path factor",()=>{
  const c3=circuit({phase:3,poles:3,voltageV:400,wireLengthM:50});
  const r=m.wireCircuit(c3,20,"P1");
  const vd=(require("assert").ok(true), r.dropPercent);
  assert.ok(vd !== null && vd > 0);
  // Single-phase equivalent must drop more (path factor 2 vs √3).
  const c1=circuit({phase:1,poles:1,voltageV:400,wireLengthM:50});
  const r1=m.wireCircuit(c1,20,"P1");
  assert.ok(r1.dropPercent > r.dropPercent);
});

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
