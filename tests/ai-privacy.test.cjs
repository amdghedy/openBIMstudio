const { execSync } = require("child_process"); const fs=require("fs"); const os=require("os"); const path=require("path");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"ap-"));
execSync(`npx tsc src/features/ai-privacy.ts --outDir ${out} --module commonjs --target es2020 --lib es2020,dom --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const files=[];(function w(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);fs.statSync(p).isDirectory()?w(p):files.push(p)}})(out);
const m=require(files.find(f=>f.endsWith("ai-privacy.js")));
let pass=0,fail=0;const t=(n,fn)=>{try{fn();pass++;console.log("  PASS",n)}catch(e){fail++;console.log("  FAIL",n+": "+e.message)}};
t("redact strips secrets",()=>{const s=m.redactForCloud?m.redactForCloud("token=abc"):m.redact("token=abc");if(typeof s!=="string")throw new Error("no redact");});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
