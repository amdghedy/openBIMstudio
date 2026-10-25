const assert=require("assert");
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
(async()=>{
const m=await import("../server/security.mjs");
const allowed=m.parseAllowedOrigins("");
t("defaults allow local dev origins only",()=>{assert.strictEqual(m.originAllowed("http://localhost:3000",allowed),true);assert.strictEqual(m.originAllowed("https://evil.example",allowed),false)});
t("no Origin header (non-browser) is not blocked",()=>assert.strictEqual(m.originAllowed(undefined,allowed),null));
t("env list replaces defaults",()=>{const a=m.parseAllowedOrigins("https://studio.example/ , https://b.example");assert.ok(a.has("https://studio.example"));assert.ok(!a.has("http://localhost:3000"))});
t("CORS echoes only an allowed origin, never *",()=>{const h=m.corsHeaders("http://localhost:3000",allowed);assert.strictEqual(h["Access-Control-Allow-Origin"],"http://localhost:3000");assert.deepStrictEqual(m.corsHeaders("https://evil.example",allowed),{})});
t("ids: plain names pass",()=>{for(const id of ["proj1","a-b_c.d","Room-42"])assert.ok(m.validId(id),id)});
t("ids: traversal / prototype keys / junk rejected",()=>{for(const id of ["__proto__","constructor","../x","a/b","","-lead"," a","a".repeat(65),"a;b","a%2fb",null,5])assert.ok(!m.validId(id),String(id))});
t("token disabled when unset",()=>assert.ok(m.tokenOk("",undefined,"")));
t("bearer token accepted, wrong/missing rejected",()=>{assert.ok(m.tokenOk("Bearer s3cret",undefined,"s3cret"));assert.ok(!m.tokenOk("Bearer nope",undefined,"s3cret"));assert.ok(!m.tokenOk("",undefined,"s3cret"))});
t("query token works for SSE",()=>assert.ok(m.tokenOk("", "s3cret","s3cret")));
t("upload names: traversal and header injection are neutralised",()=>{
  assert.strictEqual(m.safeUploadName("../../etc/passwd.rvt"),"passwd.rvt");
  assert.strictEqual(m.safeUploadName("..\\..\\win.ini.ifc"),"win.ini.ifc");
  const inj=m.safeUploadName('a"\r\nSet-Cookie: x=1.rvt'); assert.ok(inj && /^[A-Za-z0-9._ -]+$/.test(inj),String(inj));
  assert.strictEqual(m.safeUploadName("Tower A.RVT"),"Tower A.RVT");
});
t("upload names: only model/CAD types, never hidden or empty",()=>{
  for(const bad of ["shell.sh","x.html","x.js",".rvt","","a.exe",undefined,"noext"]) assert.strictEqual(m.safeUploadName(bad),null,String(bad));
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
})();
