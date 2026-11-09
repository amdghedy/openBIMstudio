const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"mas-"));
execSync(`npx tsc src/modules/parametric-constraints/auto-solve.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const m=require(find(out,"auto-solve.js"));
let pass=0,fail=0;const t=(n,f)=>async()=>{try{await f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

(async () => {
await t("debounced schedule fires once for a burst of commits", async () => {
  let fires = 0;
  const eng = m.createAutoSolveEngine(() => { fires++; }, { debounceMs: 30 });
  eng.schedule(); eng.schedule(); eng.schedule(); eng.schedule();
  assert.ok(eng.stats().pending, "pending during the debounce window");
  await sleep(80);
  assert.equal(fires, 1, `four schedules in a burst must solve once, got ${fires}`);
  assert.ok(!eng.stats().pending);
})();

await t("flush solves immediately and cancels the debounce", async () => {
  let fires = 0;
  const eng = m.createAutoSolveEngine(() => { fires++; }, { debounceMs: 500 });
  eng.schedule();
  eng.flush();
  await sleep(20);
  assert.equal(fires, 1);
  assert.ok(!eng.stats().pending, "flush clears the pending timer");
})();

await t("re-entrant fire defers instead of stacking", async () => {
  let fires = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  const eng = m.createAutoSolveEngine(async () => { fires++; await gate; }, { debounceMs: 10 });
  eng.schedule();
  await sleep(30);          // first solve begins, blocked on the gate
  assert.ok(eng.stats().skipped === 0);
  eng.schedule(); eng.schedule(); // arrive while busy -> deferred, not lost
  release();
  await sleep(60);          // deferred rerun executes
  assert.equal(fires, 2, `busy-period schedules must rerun once, got ${fires}`);
})();

await t("disabled engine ignores schedule and flush", async () => {
  let fires = 0;
  const eng = m.createAutoSolveEngine(() => { fires++; }, { debounceMs: 10 });
  eng.setEnabled(false);
  eng.schedule(); eng.flush();
  await sleep(40);
  assert.equal(fires, 0);
  assert.ok(!eng.isEnabled());
  eng.setEnabled(true);
  assert.ok(eng.isEnabled());
  eng.flush();
  await sleep(20);
  assert.equal(fires, 1);
})();

await t("cancel drops the pending debounce", async () => {
  let fires = 0;
  const eng = m.createAutoSolveEngine(() => { fires++; }, { debounceMs: 30 });
  eng.schedule();
  eng.cancel();
  await sleep(60);
  assert.equal(fires, 0);
  assert.ok(!eng.stats().pending);
})();

await t("stats count schedules and flushes", async () => {
  const eng = m.createAutoSolveEngine(() => {}, { debounceMs: 5 });
  eng.schedule(); eng.schedule(); eng.flush();
  await sleep(40);
  const s = eng.stats();
  assert.equal(s.scheduled, 3);
  assert.equal(s.flushed, 1);
})();

console.log(`\nauto-solve: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
