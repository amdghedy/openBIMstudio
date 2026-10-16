import fs from "node:fs"; import path from "node:path";
const root = process.argv[2] || process.cwd();
const rel = "src/features/authoring.ts";
const src = fs.readFileSync(path.join(root, rel), "utf8");
const lines = src.split(/\r?\n/);
function braceEnd(i){ let d=0,ins=false,q="",esc=false; for(;i<src.length;i++){const ch=src[i]; if(ins){if(esc)esc=false;else if(ch==="\\")esc=true;else if(ch===q)ins=false;continue;} if(ch==='"'||ch==="'"||ch==="`"){ins=true;q=ch;continue;} if(ch==="{")d++; else if(ch==="}"){d--; if(d===0)return i;} } return -1; }
function fnBody(name){ const re=new RegExp("function\\s+"+name+"\\s*\\("); const m=re.exec(src); if(!m){console.log("  (no "+name+")");return;} const st=m.index+m[0].indexOf("{"); const en=braceEnd(st); const a=src.slice(0,st).split("\n").length; const b=src.slice(0,en+1).split("\n").length; console.log("\n===== "+name+"  lines "+a+"-"+b+" ====="); console.log(lines.slice(a-1,b).map((l,k)=>String(a+k).padStart(5)+"| "+l).join("\n")); }
function win(re,radius,label,max){ const out=[]; for(let i=0;i<lines.length;i++){ re.lastIndex=0; if(re.test(lines[i])){ const a=Math.max(0,i-radius),b=Math.min(lines.length-1,i+radius); out.push({a:a+1,b:b+1,t:lines.slice(a,b+1).map((l,k)=>String(a+k+1).padStart(5)+"| "+l).join("\n")}); } } console.log("\n===== "+label+"  ("+out.length+" hit(s)) ====="); out.slice(0,max||6).forEach(w=>{console.log("--- lines "+w.a+"-"+w.b+" ---");console.log(w.t);}); if(out.length>(max||6))console.log("  ...+"+(out.length-(max||6))+" more..."); }
console.log("authoring.ts lines:", lines.length);
fnBody("buildDoor"); fnBody("buildWindow");
win(/^export function rebuild\b|^function rebuild\b/, 26, "rebuild() HEAD (ordering / where a pre-pass would go)", 2);
win(/hostId\s*[:=]/, 6, "hostId ASSIGNMENT sites (placement commit)", 8);
win(/offsetAlongHost\s*[:=]/, 5, "offsetAlongHost ASSIGNMENT sites (first write vs my read-time)", 8);
win(/type:\s*["']door["']|type:\s*["']window["']|===\s*["']door["']|===\s*["']window["']|case\s+["']door["']|case\s+["']window["']/, 8, "door/window creation / tool-case", 8);