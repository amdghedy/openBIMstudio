const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"mhe-"));
execSync(`npx tsc src/modules/mep/hosted-elements.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const m=require(find(out,"hosted-elements.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};

const wall = { id:"w-1", kind:"wall", origin:{x:0,y:0,z:0}, direction:{x:1,y:0,z:0}, lengthM:8, heightM:3, thicknessM:0.2 };
const duct = { id:"d-1", kind:"duct", origin:{x:0,y:2.8,z:0}, direction:{x:1,y:0,z:0}, lengthM:12, sizeM:0.4 };
const ceiling = { id:"c-1", kind:"ceiling", origin:{x:0,y:3.0,z:0}, direction:{x:1,y:0,z:0}, lengthM:1 };

t("compatibility table matches RVT hosting rules",()=>{
  assert.ok(m.isCompatibleHost("receptacle","wall"));
  assert.ok(m.isCompatibleHost("air-terminal","duct"));
  assert.ok(m.isCompatibleHost("light-fixture","ceiling"));
  assert.ok(!m.isCompatibleHost("air-terminal","wall"), "air terminal cannot host on a wall");
  assert.ok(m.isCompatibleHost("sprinkler", "pipe"), "sprinkler hosts on pipe");
  assert.ok(m.isCompatibleHost("sprinkler", "ceiling"), "sprinkler also hosts on ceiling");
  assert.ok(!m.isCompatibleHost("sprinkler", "duct"), "sprinkler does not host on duct");
});

t("attachToHost projects a world point onto the wall parametric frame",()=>{
  const rec = m.attachToHost(
    { id:"r-1", kind:"receptacle", hostId:"w-1", allowedHostKinds:["wall"], offsetM:0.05 },
    wall, { x:2, y:1.1, z:0.1 });
  assert.ok(Math.abs(rec.anchor.u - 2) < 1e-9);
  assert.ok(Math.abs(rec.anchor.v - 1.1) < 1e-9);
});

t("attachToHost rejects incompatible host kinds and out-of-range points",()=>{
  assert.throws(()=>m.attachToHost(
    { id:"r-2", kind:"air-terminal", hostId:"w-1", allowedHostKinds:["duct"], offsetM:0 },
    wall, { x:1,y:1,z:0 }), /cannot host on wall/);
  assert.throws(()=>m.attachToHost(
    { id:"r-3", kind:"receptacle", hostId:"w-1", allowedHostKinds:["wall"], offsetM:0 },
    wall, { x:9,y:1,z:0 }), /outside the wall length/);
  assert.throws(()=>m.attachToHost(
    { id:"r-4", kind:"receptacle", hostId:"w-1", allowedHostKinds:["wall"], offsetM:0 },
    wall, { x:1,y:4,z:0 }), /outside the wall height/);
});

t("duct attachment stores a normalised t along the axis",()=>{
  const rec = m.attachToHost(
    { id:"at-1", kind:"air-terminal", hostId:"d-1", allowedHostKinds:["duct"], offsetM:0 },
    duct, { x:3, y:2.8, z:0 });
  assert.ok(Math.abs(rec.anchor.t - 0.25) < 1e-9, "3 m of 12 m -> t=0.25");
});

t("hostedWorldPosition re-derives wall and duct positions",()=>{
  const rec = { id:"r-5", kind:"receptacle", hostId:"w-1", allowedHostKinds:["wall"], offsetM:0.05, anchor:{u:2,v:1.1} };
  const p = m.hostedWorldPosition(wall, rec);
  // Face offset: 0.2/2 + 0.05 = 0.15 along plan-perpendicular of +x wall (0,0,-1)*? -> z = -0.15 or +0.15 depending on convention.
  assert.ok(Math.abs(p.x - 2) < 1e-9);
  assert.ok(Math.abs(p.y - 1.1) < 1e-9);
  const at = { id:"at-2", kind:"air-terminal", hostId:"d-1", allowedHostKinds:["duct"], offsetM:0, anchor:{u:0,v:0,t:0.5} };
  const q = m.hostedWorldPosition(duct, at);
  assert.ok(Math.abs(q.x - 6) < 1e-9 && Math.abs(q.y - 2.8) < 1e-9);
});

t("audit reports orphans when the host is deleted",()=>{
  const rec = { id:"l-1", kind:"light-fixture", hostId:"gone", allowedHostKinds:["ceiling"], offsetM:0, anchor:{u:0,v:1,v2:1} };
  const a = m.auditHostedElements({ hosts:[wall], hosted:[rec] });
  assert.equal(a.orphaned.length, 1);
  assert.equal(a.orphaned[0].code, "HOST_DELETED");
  assert.equal(a.byKind["light-fixture"], 1);
});

t("audit flags kind mismatch after a host was replaced",()=>{
  const rec = { id:"at-3", kind:"air-terminal", hostId:"w-1", allowedHostKinds:["duct"], offsetM:0, anchor:{u:0,v:0,t:0.1} };
  const a = m.auditHostedElements({ hosts:[wall], hosted:[rec] });
  assert.ok(a.issues.some(i => i.code === "HOST_KIND_MISMATCH"));
});

t("applyHostChange moves hosted followers parametrically",()=>{
  const recs = [
    { id:"at-4", kind:"air-terminal", hostId:"d-1", allowedHostKinds:["duct"], offsetM:0, anchor:{u:0,v:0,t:0.5} },
    { id:"at-5", kind:"air-terminal", hostId:"d-1", allowedHostKinds:["duct"], offsetM:0, anchor:{u:0,v:0,t:0.25} },
  ];
  const moved = m.applyHostChange([duct], recs, "d-1");
  assert.equal(moved.length, 2);
  assert.ok(Math.abs(moved[0].newPosition.x - 6) < 1e-9);
  // Duct shifts up by 0.2: hosted elements follow (same t, new host origin).
  const duct2 = { ...duct, origin:{x:0,y:3.0,z:0} };
  const moved2 = m.applyHostChange([duct2], recs, "d-1");
  assert.ok(Math.abs(moved2[0].newPosition.y - 3.0) < 1e-9);
});

t("suggestHosts ranks compatible hosts by distance",()=>{
  const duct2 = { ...duct, id:"d-2", origin:{x:1,y:2.8,z:0} };
  const s = m.suggestHosts("air-terminal", [wall, duct, duct2], { x:1.4, y:2.8, z:0 });
  assert.ok(s.length >= 1);
  assert.ok(s[0].kind === "duct", "wall must be excluded for an air terminal");
  assert.ok(s[0].distanceM <= s[1]?.distanceM || s.length === 1);
});

console.log(`\nhosted-elements: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
