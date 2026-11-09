const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"mdf-"));
execSync(`npx tsc src/modules/mep/demand-factors.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const m=require(find(out,"demand-factors.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};

t("classifyLoad maps names to code load types",()=>{
  assert.equal(m.classifyLoad("L1","Office lighting panel feed", 100), "general-lighting");
  assert.equal(m.classifyLoad("R1","General receptacles", 100), "receptacle");
  assert.equal(m.classifyLoad("E1","EV charger wallbox", 7000), "evse");
  assert.equal(m.classifyLoad("W1","Water heater 4kW", 4000), "water-heater");
  assert.equal(m.classifyLoad("M1","AHU-1 supply fan motor", 5500), "motor-other");
  assert.equal(m.classifyLoad("C1","Chilled water pump", 3000), "motor-other");
  assert.equal(m.classifyLoad("X1","Mystery big load", 20000), "other");
});

t("NEC 220.42 dwelling lighting table",()=>{
  // 3 kVA at 100%.
  assert.ok(Math.abs(m.generalLightingDemandFactor("dwelling", 3000).factor - 1) < 1e-9);
  // 3k + 10k at 35% -> (3000 + 10000*0.35)/13000 ≈ 0.5
  const f13 = m.generalLightingDemandFactor("dwelling", 13000).factor;
  assert.ok(Math.abs(f13 - (3000 + 10000 * 0.35) / 13000) < 1e-9);
  // Above 120 kVA the tail is 25%.
  const fBig = m.generalLightingDemandFactor("dwelling", 200_000).factor;
  assert.ok(fBig < 0.35 && fBig > 0.25);
  // Warehouse flat 50%.
  assert.ok(Math.abs(m.generalLightingDemandFactor("warehouse", 5000).factor - 0.5) < 1e-9);
});

t("NEC 220.44 receptacle demand: first 10 kVA 100%, remainder 50%",()=>{
  assert.ok(Math.abs(m.receptacleDemandVA(8000) - 8000) < 1e-9);
  assert.ok(Math.abs(m.receptacleDemandVA(18000) - 14000) < 1e-9);
});

t("continuous loads take 125% and motors add the largest at 25%",()=>{
  assert.ok(Math.abs(m.continuousLoadFactorVA(1000) - 1250) < 1e-9);
  const mm = m.motorDemandVA([1000, 3000, 2000]);
  assert.equal(mm.connectedVA, 6000);
  assert.equal(mm.largestVA, 3000);
  assert.ok(Math.abs(mm.demandVA - 6750) < 1e-9);
});

t("panelDemandRollup applies 220.44 and engineer override wins",()=>{
  const items = [
    { loadId:"L1", name:"Lighting", connectedVA: 5000 },              // 100% (office)
    { loadId:"R1", name:"Receptacles", connectedVA: 18000 },          // 14,000
    { loadId:"R2", name:"Receptacles-2", connectedVA: 5000, demandFactor: 0.8 }, // override 4,000
  ];
  const r = m.panelDemandRollup(items, "office");
  const cat = Object.fromEntries(r.categories.map(c => [c.type, c]));
  assert.ok(Math.abs(cat["general-lighting"].demandVA - 5000) < 1e-9);
  assert.ok(Math.abs(cat["receptacle"].demandVA - 18000) < 1e-9, "5k@100% + 5k override@80% + 8k remainder@50% = 5+4+9... see grouping");
  assert.ok(r.notes.some(n => n.includes("explicit demand factor")));
  assert.ok(Math.abs(r.connectedTotalVA - 28000) < 1e-9);
});

t("panelDemandRollup groups receptacles before applying 220.44",()=>{
  // Two receptacle loads sum to 18 kVA -> 10 @100% + 8 @50% = 14 kVA total.
  const r = m.panelDemandRollup([
    { loadId:"R1", name:"Receptacles A", connectedVA: 12000 },
    { loadId:"R2", name:"Receptacles B", connectedVA: 6000 },
  ], "office");
  const rec = r.categories.find(c => c.type === "receptacle");
  assert.ok(Math.abs(rec.demandVA - 14000) < 1e-9, `got ${rec.demandVA}`);
});

t("motor group: largest motor boosted once (430.24)",()=>{
  const r = m.panelDemandRollup([
    { loadId:"M1", name:"Fan motor", connectedVA: 3000, isMotor: true },
    { loadId:"M2", name:"Pump motor", connectedVA: 1500, isMotor: true },
  ], "office");
  const mot = r.categories.find(c => c.type === "motor-other");
  assert.ok(Math.abs(mot.demandVA - 5250) < 1e-9, `got ${mot.demandVA}`);
});

t("dwelling optional method (220.82) computes A+B",()=>{
  const r = m.dwellingOptionalMethod({
    areaM2: 3500,                     // 350 m² luxury unit -> 3 VA/m² = 10,500 VA
    smallApplianceCircuits: 2,
    laundryCircuits: 1,
    appliancesVA: [8000, 5500, 1200], // range + dryer + dishwasher
    coolingVA: 5000,
    heatingVA: 2000,
  });
  const gl = 3500 * 3;                // 10,500
  const circ = 3 * 1500;              // 4,500
  const partA = 10000 + (gl + circ - 10000) * 0.4; // pool > 10 kVA -> 12,000
  assert.ok(Math.abs(r.generalLightingVA - gl) < 1e-9);
  assert.ok(Math.abs(r.applianceCircuitsVA - 4500) < 1e-9);
  assert.ok(Math.abs(r.hvacVA - 5000) < 1e-9, "cooling wins (larger)");
  assert.ok(r.hvacRule.includes("cooling"));
  assert.ok(Math.abs(r.demandLoadVA - (partA + 8000 + 5500 + 1200 + 5000)) < 1e-9);
  assert.ok(r.overallFactor < 1, `overall ${r.overallFactor} must be < 1 once the 40% tail applies`);
});

t("dwelling minimums are enforced with notes",()=>{
  const r = m.dwellingOptionalMethod({
    areaM2: 100, smallApplianceCircuits: 0, laundryCircuits: 0,
    appliancesVA: [], coolingVA: 0, heatingVA: 0,
  });
  assert.ok(Math.abs(r.applianceCircuitsVA - 4500) < 1e-9, "2 SA + 1 laundry minimum");
  assert.ok(r.notes.length >= 2);
});

t("multi-family 220.84 abridged table descends with units",()=>{
  assert.equal(m.multiFamilyDemandFactor(2), 1);
  assert.equal(m.multiFamilyDemandFactor(5), 0.44);
  assert.equal(m.multiFamilyDemandFactor(100), 0.23);
  assert.ok(m.multiFamilyDemandFactor(40) < m.multiFamilyDemandFactor(10));
});

t("rollup rejects invalid override factors",()=>{
  assert.throws(()=>m.panelDemandRollup([{ loadId:"R", name:"bad", connectedVA: 100, demandFactor: 1.5 }]), /between 0 and 1/);
});

console.log(`\ndemand-factors: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
