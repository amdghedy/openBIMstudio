// Every AI preset must be reachable: cloud hosts must be in the CSP connect-src, ids unique, local ones stay local.
const { execSync } = require("child_process"); const fs=require("fs"); const os=require("os"); const path=require("path");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"apr-"));
execSync(`npx tsc src/features/ai-presets.ts --outDir ${out} --module commonjs --target es2020 --lib es2020 --skipLibCheck --ignoreDeprecations 5.0 --noResolve --noCheck 2>/dev/null || true`,{stdio:"ignore",shell:"/bin/bash"});
const files=[];(function w(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);fs.statSync(p).isDirectory()?w(p):files.push(p)}})(out);
const m=require(files.find(f=>f.endsWith("ai-presets.js")));
const html=fs.readFileSync("index.html","utf8"); const csp=(html.match(/connect-src([^;]*);/)||[])[1]||"";
let pass=0,fail=0;const t=(n,fn)=>{try{fn();pass++;console.log("  PASS",n)}catch(e){fail++;console.log("  FAIL",n+": "+e.message)}};
const isLocal=u=>/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(u);
t("has at least 20 presets",()=>{if(m.PRESETS.length<20)throw new Error(String(m.PRESETS.length));});
t("every cloud preset origin is allowed by the CSP",()=>{for(const p of m.PRESETS){const e=p.cfg.endpoint;if(isLocal(e))continue;const o=new URL(e).origin;if(!csp.includes(o))throw new Error(p.label+" -> "+o+" missing from connect-src");}});
t("cloud presets need a key, local ones do not",()=>{for(const p of m.PRESETS){if(isLocal(p.cfg.endpoint)===p.needsKey)throw new Error(p.label);}});
t("labels are unique",()=>{const s=new Set();for(const p of m.PRESETS){if(s.has(p.label))throw new Error("dup "+p.label);s.add(p.label);}});
t("kinds valid; Claude uses native kind",()=>{for(const p of m.PRESETS){if(!["ollama","openai","anthropic"].includes(p.cfg.kind))throw new Error(p.label);if(/api\.anthropic\.com/.test(p.cfg.endpoint)&&p.cfg.kind!=="anthropic")throw new Error(p.label);}});
t("no preset embeds a key",()=>{for(const p of m.PRESETS)if(p.cfg.apiKey)throw new Error(p.label);});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
