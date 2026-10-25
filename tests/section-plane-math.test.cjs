const { execSync } = require("child_process"); const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"spm-"));
execSync(`npx tsc src/features/section-plane-math.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const m=require(path.join(out,"section-plane-math.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
t("module loads",()=>assert.ok(m));
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
