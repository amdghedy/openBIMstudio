const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"sc-"));
execSync(`npx tsc src/core/secret-crypto.ts --outDir ${out} --module commonjs --target es2020 --lib es2020,dom --skipLibCheck --ignoreConfig --ignoreDeprecations 6.0`,{stdio:"inherit"});
const find=(d,n)=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory()){const r=find(p,n);if(r)return r}else if(f.name===n)return p}};
const m=require(find(out,"secret-crypto.js"));
let pass=0,fail=0;const t=async(n,f)=>{try{await f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
(async()=>{
const key=await m.generateStorageKey();
await t("round trip incl. unicode",async()=>{for(const s of ["sk-test-123","", "مفتاح-سري-🔑"]) assert.strictEqual(await m.decryptString(key,await m.encryptString(key,s,"n"),"n"),s)});
await t("ciphertext hides the secret and differs every time",async()=>{const a=await m.encryptString(key,"sk-secret","n"),b=await m.encryptString(key,"sk-secret","n");assert.notStrictEqual(a,b);assert.ok(!Buffer.from(a,"base64").toString("latin1").includes("sk-secret"))});
await t("tampering is detected",async()=>{const c=Buffer.from(await m.encryptString(key,"sk-secret","n"),"base64");c[c.length-1]^=1;await assert.rejects(()=>m.decryptString(key,c.toString("base64"),"n"))});
await t("a different key cannot decrypt",async()=>{const k2=await m.generateStorageKey();await assert.rejects(async()=>m.decryptString(k2,await m.encryptString(key,"x","n"),"n"))});
await t("item name is bound: swapping ciphertexts between entries fails",async()=>{await assert.rejects(async()=>m.decryptString(key,await m.encryptString(key,"x","openai.key"),"cde.token"))});
await t("key is not extractable",async()=>{await assert.rejects(()=>crypto.subtle.exportKey("raw",key))});
await t("truncated payload rejected",async()=>{await assert.rejects(()=>m.decryptString(key,"AAAA","n"))});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
})();
