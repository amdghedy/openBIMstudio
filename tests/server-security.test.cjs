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
t("client ids reject prototype keys and unsafe characters",()=>{for(const id of ["client-1","a:b_2"])assert.ok(m.validClientId(id),id);for(const id of ["__proto__","constructor","../x","a/b","","-lead","a".repeat(97),null,5])assert.ok(!m.validClientId(id),String(id))});
t("display names are bounded and control characters are removed",()=>{assert.strictEqual(m.safeDisplayName("  A\nB\t "),"AB");assert.strictEqual(m.safeDisplayName(""),"Guest");assert.ok(m.safeDisplayName("x".repeat(200)).length<=120)});
t("change payloads are bounded and JSON serializable",()=>{assert.ok(m.boundedJsonValue({a:1}).ok);assert.ok(!m.boundedJsonValue("x".repeat(100),50).ok);const circular={};circular.self=circular;assert.ok(!m.boundedJsonValue(circular).ok)});
t("project bodies: object required; name bounded; data size-bounded",()=>{
  assert.ok(m.validateProjectBody({name:"A",data:{x:1}}).ok);
  assert.ok(m.validateProjectBody({name:"A"}).ok, "data defaults to the body itself");
  for(const bad of [[1,2],"nope",null,undefined,42]) assert.ok(!m.validateProjectBody(bad).ok, String(bad));
  assert.ok(!m.validateProjectBody({name:42}).ok);
  assert.ok(!m.validateProjectBody({name:"x".repeat(201)}).ok);
  assert.ok(!m.validateProjectBody({data:{blob:"x".repeat(100)}},50).ok);
  const v=m.validateProjectBody({name:"Tower",data:{a:1}});
  assert.strictEqual(v.name,"Tower"); assert.deepStrictEqual(v.data,{a:1});
  const unnamed=m.validateProjectBody({data:{a:1}});
  assert.strictEqual(unnamed.name, undefined, "no name → caller falls back to the id");
});
t("room action bodies: object required; cursor bounded on join/heartbeat",()=>{
  assert.ok(m.validateRoomActionBody({clientId:"c1"}, "join").ok);
  assert.ok(m.validateRoomActionBody({clientId:"c1", cursor:{x:1,y:2}}, "join").ok);
  assert.ok(!m.validateRoomActionBody([1], "join").ok);
  assert.ok(!m.validateRoomActionBody(null, "join").ok);
  assert.ok(!m.validateRoomActionBody({clientId:"c1", cursor:{blob:"x".repeat(100 * 1024)}}, "join").ok);
  assert.ok(m.validateRoomActionBody({clientId:"c1", cursor:{blob:"x".repeat(100 * 1024)}}, "change").ok, "change payload has its own bound, checked by the caller");
});
t("token disabled when unset",()=>assert.ok(m.tokenOk("",undefined,"")));
t("bearer token accepted, wrong/missing rejected",()=>{assert.ok(m.tokenOk("Bearer s3cret",undefined,"s3cret"));assert.ok(!m.tokenOk("Bearer nope",undefined,"s3cret"));assert.ok(!m.tokenOk("",undefined,"s3cret"))});
t("tokenOk still accepts a query token when the caller passes one (agent SSE only)",()=>assert.ok(m.tokenOk("", "s3cret","s3cret")));
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
