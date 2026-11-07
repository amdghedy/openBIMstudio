// Tests sign-in verification, sessions and the cloud-project API with generated RSA keys,
// a fake JWKS fetcher and an in-memory R2. NOT tested against live Google/Microsoft/Cloudflare.
const { execSync } = require("child_process"); const fs=require("fs"); const os=require("os"); const path=require("path");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"acct-"));
execSync(`npx tsc worker/cloud.ts --outDir ${out} --module commonjs --target es2022 --lib es2022,dom --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const files=[];(function w(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);fs.statSync(p).isDirectory()?w(p):files.push(p)}})(out);
const auth=require(files.find(f=>f.endsWith("auth.js"))); const cloud=require(files.find(f=>f.endsWith("cloud.js")));
const { webcrypto } = require("crypto"); const subtle = webcrypto.subtle;
let pass=0,fail=0; const tests=[]; const t=(n,fn)=>tests.push([n,fn]);
const assert=(c,m)=>{if(!c)throw new Error(m||"assertion failed");};
const b64u=(o)=>auth.b64urlEncode(typeof o==="string"?new TextEncoder().encode(o):o instanceof Uint8Array?o:new TextEncoder().encode(JSON.stringify(o)));
const NOW=1_800_000_000; const SECRET="s".repeat(40); const CID="client-123.apps.googleusercontent.com";

async function mkKey(kid){ const kp=await subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]); const jwk=await subtle.exportKey("jwk",kp.publicKey); return {kp,jwk:{...jwk,kid,alg:"RS256",use:"sig"}}; }
async function mkToken(key,kid,claims,alg="RS256"){ const h=b64u({alg,kid,typ:"JWT"}); const p=b64u(claims); const sig=new Uint8Array(await subtle.sign("RSASSA-PKCS1-v1_5",key.kp.privateKey,new TextEncoder().encode(`${h}.${p}`))); return `${h}.${p}.${b64u(sig)}`; }
const good=(o={})=>({iss:"https://accounts.google.com",aud:CID,sub:"1234567890",exp:NOW+3600,iat:NOW-10,email:"a@b.co",email_verified:true,name:"Ann",picture:"https://lh3.googleusercontent.com/x",...o});

function fakeR2(){ const m=new Map(); return { m,
  async put(k,v,o){ m.set(k,{buf:v instanceof ArrayBuffer?v.slice(0):v,meta:o?.customMetadata??{},up:new Date(NOW*1000)}); },
  async get(k){ const e=m.get(k); if(!e)return null; return {key:k,size:e.buf.byteLength,uploaded:e.up,customMetadata:e.meta,body:new Response(e.buf).body}; },
  async head(k){ const e=m.get(k); return e?{key:k,size:e.buf.byteLength,uploaded:e.up,customMetadata:e.meta}:null; },
  async delete(k){ m.delete(k); },
  async list({prefix}){ return {objects:[...m].filter(([k])=>k.startsWith(prefix)).map(([k,e])=>({key:k,size:e.buf.byteLength,uploaded:e.up,customMetadata:e.meta})),truncated:false}; } }; }

(async()=>{
const key=await mkKey("k1"); const other=await mkKey("k1");
const jwks=async()=>({keys:[key.jwk]});
const gp=auth.providerConfig("google",CID);
const v=(tok,o)=>auth.verifyIdToken(tok,gp,jwks,{nowSeconds:NOW,...o});

t("valid Google token verifies",async()=>{const r=await v(await mkToken(key,"k1",good()));assert(r.ok,r.reason);assert(r.identity.subject==="1234567890"&&r.identity.email==="a@b.co");});
t("unverified Google email is not trusted",async()=>{const r=await v(await mkToken(key,"k1",good({email_verified:false})));assert(r.ok&&!r.identity.email);});
t("wrong audience rejected",async()=>{const r=await v(await mkToken(key,"k1",good({aud:"other"})));assert(!r.ok&&/different app/.test(r.reason));});
t("wrong issuer rejected",async()=>{const r=await v(await mkToken(key,"k1",good({iss:"https://evil.example"})));assert(!r.ok&&/issuer/.test(r.reason));});
t("expired token rejected",async()=>{const r=await v(await mkToken(key,"k1",good({exp:NOW-3600})));assert(!r.ok&&/expired/.test(r.reason));});
t("signature from a different key rejected",async()=>{const r=await v(await mkToken(other,"k1",good()));assert(!r.ok&&/signature/.test(r.reason));});
t("tampered payload rejected",async()=>{const tok=await mkToken(key,"k1",good());const [h,,s]=tok.split(".");const r=await v(`${h}.${b64u(good({sub:"attacker"}))}.${s}`);assert(!r.ok);});
t("alg none / HS256 rejected",async()=>{const h=b64u({alg:"none",kid:"k1"});const r=await v(`${h}.${b64u(good())}.x`);assert(!r.ok&&/algorithm/.test(r.reason));const r2=await v(await mkToken(key,"k1",good(),"HS256"));assert(!r2.ok);});
t("unknown kid rejected; garbage rejected",async()=>{assert(!(await v(await mkToken(key,"zzz",good()))).ok);assert(!(await v("a.b")).ok);assert(!(await v("x".repeat(9000))).ok);});
t("nonce enforced when supplied",async()=>{const tok=await mkToken(key,"k1",good({nonce:"n1"}));assert((await v(tok,{nonce:"n1"})).ok);assert(!(await v(tok,{nonce:"n2"})).ok);});
t("JWKS fetch failure fails closed",async()=>{const r=await auth.verifyIdToken(await mkToken(key,"k1",good()),gp,async()=>{throw new Error("net");},{nowSeconds:NOW});assert(!r.ok);});
t("Microsoft: issuer must match tenant claim; subject scoped to tenant",async()=>{const mp=auth.providerConfig("microsoft",CID);const c={iss:"https://login.microsoftonline.com/T1/v2.0",tid:"T1",aud:CID,sub:"s",oid:"O1",exp:NOW+100,iat:NOW,preferred_username:"u@c.com"};const r=await auth.verifyIdToken(await mkToken(key,"k1",c),mp,jwks,{nowSeconds:NOW});assert(r.ok,r.reason);assert(r.identity.subject==="T1:O1");const bad=await auth.verifyIdToken(await mkToken(key,"k1",{...c,tid:"T2"}),mp,jwks,{nowSeconds:NOW});assert(!bad.ok);});
t("userKey is stable, provider-scoped and not the email",async()=>{const a=await auth.userKey("google","1");assert(a===await auth.userKey("google","1")&&a!==await auth.userKey("microsoft","1")&&a.length===40&&!/@/.test(a));});
t("session round trip, tamper, expiry, wrong secret",async()=>{const s=await auth.signSession({uid:"u",provider:"google",exp:NOW+10},SECRET);assert((await auth.verifySession(s,SECRET,NOW)).uid==="u");assert(!(await auth.verifySession(s,SECRET,NOW+11)));assert(!(await auth.verifySession(s,"x".repeat(40),NOW)));const [b,g]=s.split(".");assert(!(await auth.verifySession(b2(b)+"."+g,SECRET,NOW)));assert(!(await auth.verifySession("",SECRET)));let threw=false;try{await auth.signSession({uid:"u",provider:"google",exp:1},"short");}catch{threw=true;}assert(threw);});
function b2(b){ const o=JSON.parse(Buffer.from(b,"base64url").toString()); o.uid="admin"; return Buffer.from(JSON.stringify(o)).toString("base64url"); }

/* ── API ── */
const env=()=>({PROJECTS:fakeR2(),SESSION_SECRET:SECRET,GOOGLE_CLIENT_ID:CID});
const deps={fetchJwks:jwks,now:()=>NOW*1000};
const H="https://studio.example";
const call=(e,method,p,{body,cookie,csrf=true,origin=H,headers={}}={})=>cloud.handleCloud(new Request(H+p,{method,body,headers:{...(cookie?{cookie}:{}),...(csrf?{"x-obs-csrf":"1"}:{}),...(origin?{origin}:{}),...headers}}),e,deps);
async function login(e,sub="1234567890"){ const tok=await mkToken(key,"k1",good({sub})); const r=await call(e,"POST","/api/auth/login",{body:JSON.stringify({provider:"google",credential:tok})}); assert(r.status===200,"login "+r.status); return r.headers.get("set-cookie").split(";")[0]; }

t("non-account paths are not handled",async()=>{assert(await call(env(),"GET","/index.html")===null);});
t("config reports providers and storage, hides secrets",async()=>{const r=await call(env(),"GET","/api/auth/config");const j=await r.json();assert(j.google.clientId===CID&&j.microsoft===null&&j.storage===true);assert(!JSON.stringify(j).includes(SECRET));const e=env();delete e.SESSION_SECRET;assert((await (await call(e,"GET","/api/auth/config")).json()).google===null);});
t("login sets HttpOnly SameSite cookie; me returns the user",async()=>{const e=env();const tok=await mkToken(key,"k1",good());const r=await call(e,"POST","/api/auth/login",{body:JSON.stringify({provider:"google",credential:tok})});const sc=r.headers.get("set-cookie");assert(/HttpOnly/.test(sc)&&/SameSite=Lax/.test(sc)&&/Secure/.test(sc));const me=await (await call(e,"GET","/api/auth/me",{cookie:sc.split(";")[0]})).json();assert(me.user.name==="Ann"&&me.user.email==="a@b.co");assert(!("uid" in me.user));assert((await (await call(e,"GET","/api/auth/me")).json()).user===null);});
t("login rejects bad token, missing CSRF header, foreign origin, unconfigured provider",async()=>{const e=env();assert((await call(e,"POST","/api/auth/login",{body:JSON.stringify({provider:"google",credential:"x.y.z"})})).status===401);const tok=await mkToken(key,"k1",good());const body=JSON.stringify({provider:"google",credential:tok});assert((await call(e,"POST","/api/auth/login",{body,csrf:false})).status===403);assert((await call(e,"POST","/api/auth/login",{body,origin:"https://evil.example"})).status===403);assert((await call(e,"POST","/api/auth/login",{body:JSON.stringify({provider:"microsoft",credential:tok})})).status===400);});
t("login without SESSION_SECRET answers 501",async()=>{const e=env();delete e.SESSION_SECRET;assert((await call(e,"POST","/api/auth/login",{body:"{}"})).status===501);});
t("logout clears the cookie",async()=>{const r=await call(env(),"POST","/api/auth/logout");assert(/Max-Age=0/.test(r.headers.get("set-cookie")));});
t("project routes need a session",async()=>{assert((await call(env(),"GET","/api/cloud/projects")).status===401);});
t("501 when no bucket is bound",async()=>{const e=env();const c=await login(e);delete e.PROJECTS;assert((await call(e,"GET","/api/cloud/projects",{cookie:c})).status===501);});
t("save, list, open, delete round trip keeps bytes exactly",async()=>{const e=env();const c=await login(e);const bytes=new Uint8Array([0,1,2,250,251,252]);const id="proj_abc12345";const put=await call(e,"PUT",`/api/cloud/projects/${id}?name=${encodeURIComponent("Tower A")}`,{cookie:c,body:bytes});assert(put.status===200,"put "+put.status);const list=(await (await call(e,"GET","/api/cloud/projects",{cookie:c})).json()).projects;assert(list.length===1&&list[0].name==="Tower A"&&list[0].id===id&&list[0].size===6);const got=await call(e,"GET",`/api/cloud/projects/${id}`,{cookie:c});assert(decodeURIComponent(got.headers.get("x-obs-name"))==="Tower A");assert(Buffer.from(await got.arrayBuffer()).equals(Buffer.from(bytes)));assert((await call(e,"DELETE",`/api/cloud/projects/${id}`,{cookie:c})).status===200);assert((await call(e,"GET",`/api/cloud/projects/${id}`,{cookie:c})).status===404);});
t("users cannot read, overwrite or list each other's projects",async()=>{const e=env();const a=await login(e,"A-sub");const b=await login(e,"B-sub");const id="proj_shared1";await call(e,"PUT",`/api/cloud/projects/${id}?name=A`,{cookie:a,body:new Uint8Array([1])});assert((await call(e,"GET",`/api/cloud/projects/${id}`,{cookie:b})).status===404);assert((await (await call(e,"GET","/api/cloud/projects",{cookie:b})).json()).projects.length===0);await call(e,"PUT",`/api/cloud/projects/${id}?name=B`,{cookie:b,body:new Uint8Array([2])});const ga=await call(e,"GET",`/api/cloud/projects/${id}`,{cookie:a});assert(Buffer.from(await ga.arrayBuffer())[0]===1,"A's data was overwritten");});
t("path traversal / bad ids rejected",async()=>{const e=env();const c=await login(e);for(const id of ["..","a b","x","..%2F..%2Fu%2Fother%2Fabcdefgh","a".repeat(65)]){const r=await call(e,"GET",`/api/cloud/projects/${id}`,{cookie:c});assert(r.status===400||r.status===404,id+" -> "+r.status);}assert((await call(e,"GET","/api/cloud/projects/..%2F..%2Fx12345678",{cookie:c})).status===400);});
t("PUT/DELETE need CSRF header and same origin",async()=>{const e=env();const c=await login(e);const p="/api/cloud/projects/proj_csrf0001";assert((await call(e,"PUT",p,{cookie:c,body:new Uint8Array([1]),csrf:false})).status===403);assert((await call(e,"PUT",p,{cookie:c,body:new Uint8Array([1]),origin:"https://evil.example"})).status===403);assert((await call(e,"DELETE",p,{cookie:c,csrf:false})).status===403);});
t("size cap and empty body",async()=>{const e=env();const c=await login(e);const p="/api/cloud/projects/proj_size0001";assert((await call(e,"PUT",p,{cookie:c,body:new Uint8Array(0)})).status===400);assert((await call(e,"PUT",p,{cookie:c,body:new Uint8Array([1]),headers:{"content-length":String(cloud.MAX_PROJECT_BYTES+1)}})).status===413);});
t("stale baseUpdatedAt returns 409 conflict; matching one succeeds",async()=>{const e=env();const c=await login(e);const p="/api/cloud/projects/proj_conf0001";const first=await (await call(e,"PUT",p+"?name=X",{cookie:c,body:new Uint8Array([1])})).json();assert((await call(e,"PUT",p+"?name=X&baseUpdatedAt=1999-01-01T00:00:00.000Z",{cookie:c,body:new Uint8Array([2])})).status===409);assert((await call(e,"PUT",p+"?name=X&baseUpdatedAt="+encodeURIComponent(first.updatedAt),{cookie:c,body:new Uint8Array([3])})).status===200);});
t("per-user project limit",async()=>{const e=env();const c=await login(e);for(let i=0;i<cloud.MAX_PROJECTS_PER_USER;i++)e.PROJECTS.m.set(`u/${(await auth.userKey("google","1234567890"))}/p${String(i).padStart(9,"0")}`,{buf:new ArrayBuffer(1),meta:{},up:new Date()});assert((await call(e,"PUT","/api/cloud/projects/proj_over0001?name=z",{cookie:c,body:new Uint8Array([1])})).status===409);});
t("expired session cookie is refused",async()=>{const e=env();const c=await login(e);const late=await cloud.handleCloud(new Request(H+"/api/cloud/projects",{headers:{cookie:c}}),e,{...deps,now:()=>(NOW+31*86400)*1000});assert(late.status===401);});

for(const [n,fn] of tests){ try{await fn();pass++;console.log("  PASS",n);}catch(err){fail++;console.log("  FAIL",n+": "+err.message);} }
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
})();
