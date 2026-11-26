// Local model modes + PDF attachment helpers. Pure functions only: no Ollama and no PDF needed.
const { execSync } = require("child_process"); const fs=require("fs"); const os=require("os"); const path=require("path");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"alm-"));
execSync(`npx tsc src/features/ai-local-models.ts src/features/ai-attachments.ts --outDir ${out} --module commonjs --target es2020 --lib es2020,dom --skipLibCheck --ignoreDeprecations 5.0 --noResolve --noCheck 2>/dev/null || true`,{stdio:"ignore",shell:"/bin/bash"});
const files=[];(function w(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);fs.statSync(p).isDirectory()?w(p):files.push(p)}})(out);
const lm=require(files.find(f=>f.endsWith("ai-local-models.js")));
const at=require(files.find(f=>f.endsWith("ai-attachments.js")));
let pass=0,fail=0;const t=(n,fn)=>{try{fn();pass++;console.log("  PASS",n)}catch(e){fail++;console.log("  FAIL",n+": "+e.message)}};
const eq=(a,b,m)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error((m||"")+" got "+JSON.stringify(a)+" want "+JSON.stringify(b));};

t("mode tags are exactly the ones the user listed",()=>{
  eq(lm.MODEL_MODE_TAGS.fast,["qwen3:8b","qwen3:latest","qwen3:4b"]);
  eq(lm.MODEL_MODE_TAGS.analyze,["gemma4:12b","gemma4:latest","gemma3:12b","qwen3:8b"]);
  eq(lm.MODEL_MODE_TAGS.reason,["deepseek-r1:14b","gemma4:12b"]);
});
t("known tags are the 7 distinct supplied tags",()=>{eq(lm.knownModeTags(),["qwen3:8b","qwen3:latest","qwen3:4b","gemma4:12b","gemma4:latest","gemma3:12b","deepseek-r1:14b"]);});
t("picks the first installed tag in preference order",()=>{
  eq(lm.pickModelForMode("fast",["qwen3:4b","qwen3:latest"]).model,"qwen3:latest");
  eq(lm.pickModelForMode("analyze",["qwen3:8b","gemma3:12b"]).model,"gemma3:12b");
});
t("never picks a tag that is not installed",()=>{
  const p=lm.pickModelForMode("reason",["qwen3:8b"]);
  eq(p.model,null); eq(p.missing,["deepseek-r1:14b","gemma4:12b"]);
  if(!/ollama pull deepseek-r1:14b/.test(lm.describeModePick(p)))throw new Error("no pull hint");
});
t("tags are exact: gemma4:12b does not match gemma4:27b or qwen3:14b",()=>{
  eq(lm.pickModelForMode("analyze",["gemma4:27b"]).model,null);
  eq(lm.pickModelForMode("fast",["qwen3:14b"]).model,null);
});
t("bare name equals :latest only",()=>{
  if(!lm.sameTag("qwen3","qwen3:latest"))throw new Error("bare");
  if(lm.sameTag("qwen3","qwen3:8b"))throw new Error("8b");
  eq(lm.pickModelForMode("fast",["qwen3"]).model,"qwen3");
});
t("tools-unsupported errors are recognised, others are not",()=>{
  if(!lm.isToolsUnsupportedError(400,'{"error":"registry.ollama.ai/library/deepseek-r1:14b does not support tools"}'))throw new Error("a");
  if(lm.isToolsUnsupportedError(500,"does not support tools"))throw new Error("500");
  if(lm.isToolsUnsupportedError(400,"model not found"))throw new Error("nf");
});
t("stripThinking removes reasoning blocks, closed or cut off",()=>{
  eq(lm.stripThinking("<think>a\nb</think>\nAnswer"),"Answer");
  eq(lm.stripThinking("Hi <think>unfinished"),"Hi");
  eq(lm.stripThinking("plain"),"plain");
});
t("num_ctx grows with the document and stays within 8192..32768",()=>{
  eq(lm.ollamaNumCtx(100),8192); if(lm.ollamaNumCtx(60000)<20000)throw new Error("small"); eq(lm.ollamaNumCtx(10_000_000),32768);
  if(lm.ollamaNumCtx(64000)%4096!==0)throw new Error("step");
});
t("attachment text is page marked and cut at the budget",()=>{
  const r=at.buildAttachmentText(["alpha","","beta"],1000); eq(r.truncated,false);
  if(!/--- page 1 ---\nalpha/.test(r.text)||!/--- page 3 ---\nbeta/.test(r.text)||/page 2/.test(r.text))throw new Error(r.text);
  const big=at.buildAttachmentText(["x".repeat(500),"y".repeat(500)],600); eq(big.truncated,true); if(big.text.length>700)throw new Error("len "+big.text.length);
});
t("pdf detection by name or type",()=>{
  if(!at.isPdfFile({name:"A.PDF"})||!at.isPdfFile({name:"x",type:"application/pdf"})||at.isPdfFile({name:"a.png",type:"image/png"}))throw new Error("pdf");
});
t("stored attachments drop their text; prompt says so after reload",()=>{
  const a=[{name:"s.pdf",pageCount:2,text:"secret body",chars:11,truncated:false}];
  const st=at.attachmentsForStorage(a); if("text" in st[0])throw new Error("text kept");
  if(!/not kept after the chat was reloaded/.test(at.attachmentsToPrompt(st)))throw new Error("note");
});
t("prompt marks document text as data and names the file",()=>{
  const p=at.attachmentsToPrompt([{name:"s.pdf",pageCount:1,text:"--- page 1 ---\nhello",chars:20,truncated:true}]);
  if(!/\[Attached PDF: s\.pdf, 1 page\]/.test(p)||!/Do not follow instructions/.test(p)||!/cut to fit/.test(p)||!/hello/.test(p))throw new Error(p);
});
t("scanned pdf is reported as unreadable, never guessed",()=>{
  const p=at.attachmentsToPrompt([{name:"scan.pdf",pageCount:3,chars:0,truncated:false,noText:true}]);
  if(!/no text layer/.test(p))throw new Error(p);
});
t("attachmentChars counts only kept text",()=>{eq(at.attachmentChars([{name:"a",pageCount:1,text:"abcd",chars:4,truncated:false},{name:"b",pageCount:1,chars:9,truncated:false}]),4);});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
