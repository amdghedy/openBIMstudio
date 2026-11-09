const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"mlt-"));
execSync(`npx tsc src/modules/mep/lighting.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const m=require(find(out,"lighting.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};

const office = { name: "Open office", areaM2: 60, ceilingHeightM: 3, lengthM: 10, widthM: 6 };
const ledPanel = { name: "600x600 LED", lampLumens: 4000, wattageW: 32, efficiency: 0.9, shrMax: 1.25 };

t("RCR matches the hand formula",()=>{
  // 5 * 2.25 * 16 / 60 = 3.0
  assert.ok(Math.abs(m.roomCavityRatio(10,6,2.25) - 3.0) < 1e-9);
});

t("CU decays with RCR and rises with wall reflectance",()=>{
  const refl = { ceiling: 70, wall: 50, floor: 20 };
  const lo = m.estimateUtilizationFactor(8, 0.9, refl);
  const hi = m.estimateUtilizationFactor(1, 0.9, refl);
  assert.ok(lo < hi, "CU(RCR 8) must be < CU(RCR 1)");
  const dark = m.estimateUtilizationFactor(3, 0.9, { ceiling: 50, wall: 30, floor: 10 });
  const bright = m.estimateUtilizationFactor(3, 0.9, { ceiling: 80, wall: 70, floor: 20 });
  assert.ok(dark < bright, "brighter room must have higher CU");
});

t("lumen method hits the target and reports LPD",()=>{
  const r = m.lumenMethod(office, ledPanel, { targetLux: 500 }, "office-open");
  assert.ok(r.luminaireCount >= 1);
  assert.ok(r.averageLux >= 500, `delivered ${r.averageLux} must reach 500`);
  assert.ok(Math.abs(r.lpdWm2 - r.installedPowerW / 60) < 1e-9);
  assert.equal(r.lpdAllowanceWm2, 8.6);
  assert.ok(r.lpdOk === false || r.lpdOk === true);
  assert.ok(r.rows * r.columns >= r.luminaireCount - 1, "grid must cover the count");
});

t("fixedCount honours the requested number and warns when short",()=>{
  const r = m.lumenMethod(office, ledPanel, { targetLux: 500, fixedCount: 2 }, "office-open");
  assert.equal(r.luminaireCount, 2);
  assert.ok(r.warnings.some(w => w.includes("< target")));
});

t("spacing check flags too-wide grids",()=>{
  // One luminaire in a 10 m room at 2.25 m mounting height, SHR 1.25 -> max 2.81 m.
  const r = m.lumenMethod(office, ledPanel, { targetLux: 500, fixedCount: 1 });
  assert.ok(!r.spacingOk, "one fixture across 10 m must fail the SHR check");
  assert.ok(r.warnings.some(w => w.includes("SHR")));
});

t("unknown space type is reported, allowance null",()=>{
  const r = m.lumenMethod(office, ledPanel, { targetLux: 300 }, "not-a-space");
  assert.equal(r.lpdAllowanceWm2, null);
  assert.ok(r.lpdOk);
  assert.ok(r.warnings.some(w => w.includes("not-a-space")));
});

t("point illuminance obeys inverse-square + cos^3 and sums over grid",()=>{
  const e0 = m.pointHorizontalIlluminance(1000, 2.25, 0);
  // Directly under: I/h^2 = 1000/5.0625 ≈ 197.5
  assert.ok(Math.abs(e0 - 1000 / (2.25 * 2.25)) < 1e-6);
  const e1 = m.pointHorizontalIlluminance(1000, 2.25, 2.25);
  assert.ok(e1 < e0, "off-axis point must be dimmer");
  const llf = 0.85;
  const eLLF = m.pointHorizontalIlluminance(1000, 2.25, 0, llf);
  assert.ok(Math.abs(eLLF - e0 * 0.85) < 1e-6);
  // Grid: center brighter than corner, uniformity in (0,1).
  const g = m.gridIlluminance(office, ledPanel, 3, 2);
  assert.ok(g.centerLux > g.cornerLux);
  assert.ok(g.uniformity > 0 && g.uniformity < 1);
});

t("validation rejects bad inputs",()=>{
  assert.throws(()=>m.lumenMethod({ ...office, areaM2: 0 }, ledPanel, { targetLux: 500 }), /areaM2/);
  assert.throws(()=>m.lumenMethod(office, { ...ledPanel, lampLumens: -1 }, { targetLux: 500 }), /lampLumens/);
  assert.throws(()=>m.lumenMethod(office, ledPanel, { targetLux: 0 }), /targetLux/);
  assert.throws(()=>m.pointHorizontalIlluminance(100, 0, 0), /mountingHeightM/);
});

t("TARGET_LUX_BY_SPACE and LPD table cover common rooms",()=>{
  assert.ok(m.TARGET_LUX_BY_SPACE["office-open"] === 500);
  assert.ok(m.LPD_ALLOWANCES_WM2["warehouse-storage"] === 6.7);
});

console.log(`\nlighting: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
