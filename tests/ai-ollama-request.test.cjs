// Ollama request behaviour against a stub local server (no real Ollama needed):
// context window for documents, tool-less retry, reasoning blocks removed, plain request unchanged.
const { execSync } = require("child_process"); const fs=require("fs"); const os=require("os"); const path=require("path"); const http=require("http");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"aor-"));
execSync(`npx tsc src/features/ai-providers.ts --outDir ${out} --module commonjs --target es2020 --lib es2020,dom --skipLibCheck --ignoreDeprecations 5.0 --moduleResolution node --noCheck 2>/dev/null || true`,{stdio:"ignore",shell:"/bin/bash"});
const files=[];(function w(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);fs.statSync(p).isDirectory()?w(p):files.push(p)}})(out);
const prov=require(files.find(f=>f.endsWith("ai-providers.js")));
let pass=0,fail=0;const results=[];const t=(n,fn)=>results.push([n,fn]);
let seen=[]; let mode="ok";
const server=http.createServer((req,res)=>{
  let b="";req.on("data",c=>b+=c);req.on("end",()=>{
    if(req.url==="/api/chat"){
      const body=JSON.parse(b); seen.push(body);
      if(mode==="notools"&&body.tools){res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:`registry.ollama.ai/library/${body.model} does not support tools`}));return;}
      if(mode==="other"){res.writeHead(404,{"Content-Type":"application/json"});res.end(JSON.stringify({error:`model "${body.model}" not found`}));return;}
      const content=mode==="think"?"<think>hmm</think>Final answer":"hello";
      res.writeHead(200,{"Content-Type":"application/x-ndjson"});
      res.write(JSON.stringify({message:{role:"assistant",content}})+"\n");res.end(JSON.stringify({done:true})+"\n");
    } else {res.writeHead(404);res.end();}
  });
});
const TOOLS=[{name:"t",description:"d",parameters:{type:"object",properties:{}}}];
const run=async(req,extra)=>{seen=[];const toks=[];const r=await prov.callChatStream({kind:"ollama",endpoint:"http://127.0.0.1:"+server.address().port,model:"qwen3:8b"},req,x=>toks.push(x));return {r,toks};};
t("plain request has no options and keeps tools",async()=>{mode="ok";const {r}=await run({messages:[{role:"user",content:"hi"}],tools:TOOLS});
  if(seen.length!==1||seen[0].options||!seen[0].tools||r.message.content!=="hello")throw new Error(JSON.stringify(seen[0]));});
t("numCtx is sent as options.num_ctx",async()=>{mode="ok";await run({messages:[{role:"user",content:"hi"}],tools:TOOLS,numCtx:16384});
  if(!seen[0].options||seen[0].options.num_ctx!==16384)throw new Error(JSON.stringify(seen[0].options));});
t("a model without tool support is retried once without tools",async()=>{mode="notools";const {r}=await run({messages:[{role:"user",content:"hi"}],tools:TOOLS});
  if(seen.length!==2||!seen[0].tools||seen[1].tools||r.message.content!=="hello")throw new Error("calls "+seen.length);});
t("other errors are not retried and surface",async()=>{mode="other";let err=null;try{await run({messages:[{role:"user",content:"hi"}],tools:TOOLS});}catch(e){err=e;}
  if(!err||seen.length!==1)throw new Error("calls "+seen.length+" err "+err);});
t("reasoning block is removed from the stored reply",async()=>{mode="think";const {r}=await run({messages:[{role:"user",content:"hi"}],tools:[]});
  if(r.message.content!=="Final answer")throw new Error(r.message.content);});
server.listen(0,"127.0.0.1",async()=>{
  for(const [n,fn] of results){try{await fn();pass++;console.log("  PASS",n)}catch(e){fail++;console.log("  FAIL",n+": "+e.message)}}
  console.log(`=== Result: ${pass} passed, ${fail} failed ===`);server.close();process.exit(fail?1:0);
});
