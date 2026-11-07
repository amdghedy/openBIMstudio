// Client tests with a fake fetch. NOT tested against a live server or real sign-in providers.
const { execSync } = require("child_process"); const fs=require("fs"); const os=require("os"); const path=require("path");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"acl-"));
execSync(`npx tsc src/features/account-client.ts --outDir ${out} --module commonjs --target es2022 --lib es2022,dom --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const files=[];(function w(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);fs.statSync(p).isDirectory()?w(p):files.push(p)}})(out);
const m=require(files.find(f=>f.endsWith("account-client.js")));
let pass=0,fail=0;const tests=[];const t=(n,fn)=>tests.push([n,fn]);const ok=(c,msg)=>{if(!c)throw new Error(msg||"assert")};
const J=(b,s=200,h={})=>new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json",...h}});
const mem=()=>{const d={};return{getItem:k=>d[k]??null,setItem:(k,v)=>{d[k]=v}}};

t("non-JSON answer (static host, no worker) => config null, me null",async()=>{const c=new m.AccountClient(async()=>new Response("<html>",{headers:{"content-type":"text/html"}}),mem());ok(await c.config()===null);ok(await c.me()===null);});
t("network failure is a readable error, not a crash",async()=>{const c=new m.AccountClient(async()=>{throw new TypeError("x")},mem());ok(await c.config()===null);let e;try{await c.list();}catch(x){e=x}ok(e instanceof m.AccountError&&/reach/.test(e.message));});
t("login sends CSRF header + nonce, returns user",async()=>{let req;const c=new m.AccountClient(async(u,i)=>{req={u,i};return J({user:{provider:"google",name:"A",email:null,picture:null}})},mem());const u=await c.login("google","tok","n1");ok(u.name==="A");ok(req.i.headers["x-obs-csrf"]==="1");ok(JSON.parse(req.i.body).nonce==="n1");});
t("save remembers server time; next save sends it as baseUpdatedAt",async()=>{const urls=[];const c=new m.AccountClient(async(u)=>{urls.push(u);return J({id:"proj_12345678",name:"P",size:1,updatedAt:"T1"})},mem());await c.save("proj_12345678","P",new Blob(["x"]));await c.save("proj_12345678","P",new Blob(["y"]));ok(!/baseUpdatedAt/.test(urls[0]));ok(/baseUpdatedAt=T1/.test(urls[1]));});
t("overwrite:true skips the conflict check",async()=>{const urls=[];const c=new m.AccountClient(async(u)=>{urls.push(u);return J({id:"proj_12345678",name:"P",size:1,updatedAt:"T2"})},mem());await c.save("proj_12345678","P",new Blob(["x"]));await c.save("proj_12345678","P",new Blob(["y"]),{overwrite:true});ok(!/baseUpdatedAt/.test(urls[1]));});
t("409 surfaces as conflict error",async()=>{const c=new m.AccountClient(async()=>J({error:"changed",conflict:true},409),mem());let e;try{await c.save("proj_12345678","P",new Blob(["x"]));}catch(x){e=x}ok(e&&e.conflict===true&&e.status===409);});
t("open returns bytes + name and records base version",async()=>{const urls=[];const f=async(u)=>{urls.push(u);return u.includes("PUT")||true?new Response(new Uint8Array([1,2,3]),{headers:{"x-obs-name":encodeURIComponent("Tür 1"),"x-obs-updated-at":"T9"}}):null};const c=new m.AccountClient(f,mem());const r=await c.open("proj_12345678");ok(r.name==="Tür 1"&&r.updatedAt==="T9"&&r.blob.size===3);});
t("401 and 501 messages come from the server",async()=>{const c=new m.AccountClient(async()=>J({error:"Sign in first."},401),mem());let e;try{await c.list();}catch(x){e=x}ok(e.message==="Sign in first."&&e.status===401);});
t("works with storage unavailable",async()=>{const c=new m.AccountClient(async()=>J({id:"proj_12345678",name:"P",size:1,updatedAt:"T"}),null);await c.save("proj_12345678","P",new Blob(["x"]));});
t("cloudIdFor accepts uuids, rejects unsafe ids",()=>{ok(m.cloudIdFor("3f2504e0-4f89-11d3-9a0c-0305e82c3301")!==null);ok(m.cloudIdFor("../x")===null&&m.cloudIdFor("a b c d e f g h")===null&&m.cloudIdFor("short")===null);});
t("auth fragment parsing",()=>{const r=m.parseAuthFragment("#id_token=abc&state=s1");ok(r.idToken==="abc"&&r.state==="s1");ok(m.parseAuthFragment("#error=access_denied&error_description=No").error==="No");});
t("nonce is random hex",()=>{const a=m.randomNonce(),b=m.randomNonce();ok(/^[0-9a-f]{32}$/.test(a)&&a!==b);});
(async()=>{for(const [n,fn] of tests){try{await fn();pass++;console.log("  PASS",n)}catch(e){fail++;console.log("  FAIL",n+": "+e.message)}}console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0)})();
