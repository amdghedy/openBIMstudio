const { execSync } = require("child_process"); const fs=require("fs"); const os=require("os"); const path=require("path");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"ps-"));
execSync(`npx tsc src/features/property-schema.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,{stdio:"inherit"});
const files=[];(function w(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);fs.statSync(p).isDirectory()?w(p):files.push(p)}})(out);
const m=require(files.find(f=>f.endsWith("property-schema.js")));
let pass=0,fail=0;const ok=(n,c)=>{c?pass++:(fail++,console.log("FAIL",n));if(c)console.log("  PASS",n)};
const f=m.SCHEMAS.fitting;const by=k=>f.fields.find(x=>x.key===k);
const el={id:"f1",type:"fitting",params:{thickness:0.4,angleIn:0,angleOut:Math.PI/2}};
ok("angle 90",Math.abs(by("bendAngle").compute(el)-90)<1e-6);
ok("default radius 1.5W",Math.abs(by("bendRadius").compute(el)-0.6)<1e-6);
ok("tangent = r",Math.abs(by("tangentLength").compute(el)-0.6)<1e-6);
ok("arc length",Math.abs(by("arcLength").compute(el)-0.6*Math.PI/2)<1e-3);
ok("bend radius editable",!by("bendRadius").readOnly);
for(const k of Object.keys(m.SCHEMAS)){if(k==="grid"||k==="level")continue;ok(k+" has Mark+IFC+ElementId",["mark","exportToIfc","elementId"].every(x=>m.SCHEMAS[k].fields.some(y=>y.key===x)))}
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
