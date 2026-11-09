const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"mhv-"));
execSync(`npx tsc src/modules/mep/hvac-loads.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const m=require(find(out,"hvac-loads.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};

const baseZone = (overrides={}) => ({
  id: "Z1", name: "Test zone", areaM2: 50, ceilingHeightM: 3,
  surfaces: [
    { id: "wall-e", kind: "wall", orientationDeg: 90, areaM2: 15, uValueWm2K: 0.45 },
    { id: "wall-n", kind: "wall", orientationDeg: 0, areaM2: 15, uValueWm2K: 0.45 },
  ],
  glazing: [
    { id: "gl-e", orientationDeg: 90, areaM2: 4, uValueWm2K: 1.8, shgc: 0.45 },
    { id: "gl-n", orientationDeg: 0, areaM2: 4, uValueWm2K: 1.8, shgc: 0.45 },
  ],
  gains: { people: 4, lightingWm2: 10, equipmentWm2: 12 },
  ...overrides,
});

t("orientation drives solar gains: east > north glazing",()=>{
  const wallE={ id:"wall-e", kind:"wall", orientationDeg:90, areaM2:15, uValueWm2K:0.45 };
  const wallN={ id:"wall-n", kind:"wall", orientationDeg:0, areaM2:15, uValueWm2K:0.45 };
  const glE={ id:"gl-e", orientationDeg:90, areaM2:4, uValueWm2K:1.8, shgc:0.45 };
  const glN={ id:"gl-n", orientationDeg:0, areaM2:4, uValueWm2K:1.8, shgc:0.45 };
  const e=m.calcZoneLoadDetailed(baseZone({ surfaces:[wallE], glazing:[glE] }));
  const n=m.calcZoneLoadDetailed(baseZone({ surfaces:[wallN], glazing:[glN] }));
  // E-vs-N delta = glazing solar delta + sol-air envelope delta (all else equal).
  const solarDelta=0.45*4*(m.peakSolarFor(90)-m.peakSolarFor(0));
  const elevDelta=15*0.45*(m.solAirElevation(90)-m.solAirElevation(0));
  const got=(e.breakdown.cooling.solarW+e.breakdown.cooling.envelopeW)-(n.breakdown.cooling.solarW+n.breakdown.cooling.envelopeW);
  assert.ok(Math.abs(got-(solarDelta+elevDelta))<0.5, `got ${got}, want ${solarDelta+elevDelta}`);
  assert.ok(e.cooling.totalW>n.cooling.totalW);
});
t("people gains split sensible/latent with documented watts",()=>{
  const r = m.calcZoneLoadDetailed(baseZone({ glazing: [], surfaces: [] }));
  const c = r.breakdown.cooling;
  // 4 people: 75 W sensible + 55 W latent each; lighting+equipment over 50 m².
  const internalExpected = 4*75 + 10*50 + 12*50;
  assert.strictEqual(Math.round(c.internalSensibleW), Math.round(internalExpected));
  assert.strictEqual(Math.round(c.peopleLatentW), 4*55);
});
t("ventilation sensible/latent match the airflow physics",()=>{
  const r = m.calcZoneLoadDetailed(baseZone({ surfaces: [], glazing: [] }));
  const oa = 4*10; // 40 L/s
  const c = r.breakdown.cooling;
  assert.ok(Math.abs(c.ventilationSensibleW - m.airflowSensibleW(oa, 11)) < 0.5, `${c.ventilationSensibleW} vs ${m.airflowSensibleW(oa, 11)}`);
  assert.ok(Math.abs(c.ventilationLatentW - m.airflowLatentW(oa, 0.014-0.0095)) < 0.5);
});
t("infiltration ACH doubles the infiltration load",()=>{
  const a = m.calcZoneLoadDetailed(baseZone({ surfaces: [], glazing: [], infiltrationAch: 0.5 }));
  const b = m.calcZoneLoadDetailed(baseZone({ surfaces: [], glazing: [], infiltrationAch: 1.0 }));
  assert.ok(Math.abs(b.breakdown.cooling.infiltrationSensibleW - 2*a.breakdown.cooling.infiltrationSensibleW) < 0.5);
});
t("supply airflow comes from sensible load and ΔT, not a fixed CFM/ton",()=>{
  const r = m.calcZoneLoadDetailed(baseZone({ surfaces: [], glazing: [] }), { supplyDeltaTC: 8 });
  const expected = Math.ceil(r.cooling.sensibleW / (1.2*1005*8) * 1000);
  assert.strictEqual(r.cooling.airflowLs, expected);
  assert.strictEqual(r.cooling.airflowCfm, Math.round(expected * 2.11888));
});
t("roof conduction exceeds same-size wall (horizontal peak dominates)",()=>{
  const roof = m.calcZoneLoadDetailed(baseZone({ surfaces: [{ id:"r", kind:"roof", areaM2:15, uValueWm2K:0.45 }], glazing: [] }));
  const wall = m.calcZoneLoadDetailed(baseZone({ surfaces: [{ id:"w", kind:"wall", orientationDeg:180, areaM2:15, uValueWm2K:0.45 }], glazing: [] }));
  assert.ok(roof.breakdown.cooling.envelopeW > wall.breakdown.cooling.envelopeW);
});
t("floor uses ground temperature; heat loss reported raw and clamped in the sum",()=>{
  const floor=m.calcZoneLoadDetailed(baseZone({ surfaces:[{ id:"f", kind:"floor", areaM2:15, uValueWm2K:0.3 }], glazing:[] }),{ conditions:{ groundC:18 } });
  const expected=15*0.3*(18-24); // −27 W: ground loses, cooling load does not gain
  assert.ok(Math.abs(floor.breakdown.cooling.envelopeW-expected)<0.2, `${floor.breakdown.cooling.envelopeW}`);
  // The clamped load never goes negative; total excludes the loss.
  const internal=4*75+10*50+12*50;
  const oa=4*10;
  const expectedTotal=Math.round(internal+m.airflowSensibleW(oa,11)+m.airflowSensibleW(0.5*50*3*1000/3600,11))
    +Math.round(4*55+m.airflowLatentW(oa,0.014-0.0095)+m.airflowLatentW(0.5*50*3*1000/3600,0.014-0.0095));
  assert.ok(Math.abs(floor.cooling.totalW-expectedTotal)<=0.5, `${floor.cooling.totalW} vs ${expectedTotal}`);
});
t("heating excludes solar and internal gains",()=>{
  const modest = m.calcZoneLoadDetailed(baseZone({ surfaces: [], glazing: [], gains: { people: 0, lightingWm2: 0, equipmentWm2: 0 } }));
  const huge = m.calcZoneLoadDetailed(baseZone({ surfaces: [], glazing: [], gains: { people: 0, lightingWm2: 200, equipmentWm2: 500 } }));
  assert.strictEqual(modest.heating.totalW, huge.heating.totalW);
  assert.ok(huge.cooling.totalW > modest.cooling.totalW);
});
t("heating safety factor scales the whole heating envelope",()=>{
  const one = m.calcZoneLoadDetailed(baseZone({ surfaces: [], glazing: [] }), { heatingSafetyFactor: 1 });
  const ten = m.calcZoneLoadDetailed(baseZone({ surfaces: [], glazing: [] }), { heatingSafetyFactor: 1.1 });
  assert.ok(Math.abs(ten.heating.totalW - one.heating.totalW*1.1) < 1.0);
});
t("SHR is sensible/total and tonnage converts at 3517 W",()=>{
  const r = m.calcZoneLoadDetailed(baseZone({ surfaces: [], glazing: [] }));
  assert.ok(Math.abs(r.cooling.shr - r.cooling.sensibleW/r.cooling.totalW) < 0.01);
  assert.ok(Math.abs(r.cooling.tons - r.cooling.totalW/3517) < 0.02);
});
t("building totals sum zones",()=>{
  const { zones, totals } = m.calcZoneLoadsDetailed([baseZone({id:"a"}), baseZone({id:"b"})], {});
  assert.strictEqual(zones.length, 2);
  assert.strictEqual(totals.coolingW, Math.round(zones.reduce((s,z)=>s+z.cooling.totalW,0)));
  assert.ok(totals.tons > 0);
});
t("latent is strictly positive for occupied zones (latent never vanishes)",()=>{
  const r = m.calcZoneLoadDetailed(baseZone({ surfaces: [], glazing: [] }));
  assert.ok(r.cooling.latentW > 0);
  assert.ok(r.cooling.sensibleW > 0);
});
t("CSV export carries the engineering columns",()=>{
  const csv = m.exportLoadReport([m.calcZoneLoadDetailed(baseZone(), {})]);
  assert.ok(csv.includes("Cooling Sensible (W)"));
  assert.ok(csv.includes("Tons") && csv.includes("SHR"));
});

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
