const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"msw-"));
execSync(`npx tsc src/modules/wall-join/stacked-wall.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const m=require(find(out,"stacked-wall.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};

const def = {
  start: [0, 0], end: [8, 0], baseElevation: 0, thickness: 0.3,
  members: [
    { wallType: "compound-exterior", height: 2.4 },
    { wallType: "basic-generic-200", height: 1.8, thickness: 0.2 },
  ],
};

t("validation computes contiguous spans and totals",()=>{
  const v = m.validateStackedWall(def);
  assert.ok(v.ok);
  assert.ok(Math.abs(v.totalHeight - 4.2) < 1e-9);
  assert.ok(Math.abs(v.lengthM - 8) < 1e-9);
  assert.equal(v.spans.length, 2);
  assert.ok(Math.abs(v.spans[0].baseElevation - 0) < 1e-9 && Math.abs(v.spans[0].topElevation - 2.4) < 1e-9);
  assert.ok(Math.abs(v.spans[1].baseElevation - 2.4) < 1e-9 && Math.abs(v.spans[1].topElevation - 4.2) < 1e-9, "member 2 base = member 1 top");
});

t("mixed thickness warns without rejecting",()=>{
  const v = m.validateStackedWall(def);
  assert.ok(v.ok, "mixed thickness is a warning, not an error");
  assert.ok(v.issues.some(i => i.code === "thickness"), "mixed thickness flagged");
  // Same thickness everywhere -> no warning.
  const same = { ...def, members: [{ wallType: "a", height: 2 }, { wallType: "b", height: 2 }] };
  const v2 = m.validateStackedWall(same);
  assert.ok(!v2.issues.some(i => i.code === "thickness"));
});

t("invalid definitions report every problem",()=>{
  const v = m.validateStackedWall({
    start: [0,0], end: [0.01,0], baseElevation: NaN,
    members: [{ wallType: "", height: -1 }],
  });
  assert.ok(!v.ok);
  const codes = new Set(v.issues.map(i => i.code));
  assert.ok(codes.has("members"), "needs >= 2 members");
  assert.ok(codes.has("height"), "negative height rejected");
  assert.ok(codes.has("type"), "empty wallType rejected");
  assert.ok(codes.has("length"), "degenerate length rejected");
  assert.ok(codes.has("elevation"), "NaN elevation rejected");
});

t("expandStackedWall produces placeable members on the shared line",()=>{
  const list = m.expandStackedWall(def);
  assert.equal(list.length, 2);
  for (const p of list) {
    assert.equal(p.x1, 0); assert.equal(p.z1, 0);
    assert.equal(p.x2, 8); assert.equal(p.z2, 0);
  }
  assert.ok(Math.abs(list[0].elev - 0) < 1e-9 && Math.abs(list[0].height - 2.4) < 1e-9);
  assert.ok(Math.abs(list[1].elev - 2.4) < 1e-9 && Math.abs(list[1].height - 1.8) < 1e-9);
  assert.ok(Math.abs(list[0].thickness - 0.3) < 1e-9, "member without override takes the stack thickness");
  assert.ok(Math.abs(list[1].thickness - 0.2) < 1e-9, "member override honoured");
  // Contiguity: no gap, no overlap between consecutive members.
  for (let i = 1; i < list.length; i++) {
    const prevTop = list[i-1].elev + list[i-1].height;
    assert.ok(Math.abs(prevTop - list[i].elev) < 1e-9, "contiguous stack");
  }
});

t("expandStackedWall throws on invalid input",()=>{
  assert.throws(()=>m.expandStackedWall({ start:[0,0], end:[8,0], baseElevation:0, members: [] }), /Invalid stacked wall/);
});

t("summary reports members/height/length and issues",()=>{
  const s = m.stackedWallSummary(def);
  assert.equal(s.members, 2);
  assert.ok(Math.abs(s.totalHeight - 4.2) < 1e-9);
  assert.ok(s.issues.length === 1 && s.issues[0].includes("mixed thickness"));
  assert.ok(s.ok);
});

t("three-member stacks expand contiguously",()=>{
  const v = m.validateStackedWall({
    start: [0,0], end: [6,0], baseElevation: 3.0, thickness: 0.25,
    members: [{ wallType:"a", height:1 }, { wallType:"b", height:2 }, { wallType:"c", height:0.5 }],
  });
  assert.ok(v.ok && v.spans.length === 3);
  assert.ok(Math.abs(v.spans[2].topElevation - 6.5) < 1e-9);
  const list = m.expandStackedWall({
    start: [0,0], end: [6,0], baseElevation: 3.0, thickness: 0.25,
    members: [{ wallType:"a", height:1 }, { wallType:"b", height:2 }, { wallType:"c", height:0.5 }],
  });
  assert.ok(Math.abs(list[2].elev - 6.0) < 1e-9);
});

console.log(`\nstacked-wall: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
