const { execSync } = require("node:child_process");
const fs=require("node:fs"), os=require("node:os"), path=require("node:path"), assert=require("node:assert/strict");
const root=path.resolve(__dirname,".."), out=fs.mkdtempSync(path.join(os.tmpdir(),"obs-catalogue-ports-"));
try {
 const source=path.join(root,"src/modules/families/catalogue-connector-mapping.ts");
 execSync("npx tsc \""+source+"\" --outDir \""+out+"\" --module commonjs --target es2020 --strict --skipLibCheck",{cwd:root,stdio:"pipe"});
 const find=(d,n)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory()){const f=find(p,n);if(f)return f;}else if(e.name===n)return p;}return null;};
 const compiled=find(out,"catalogue-connector-mapping.js"); assert.ok(compiled);
 const {buildCatalogueConnectorDefinitions}=require(compiled);
 const row={model:"AHU-1","Connector Name":"Supply","Connector X":500,"Connector Y":0,"Connector Z":1200,
  "Direction X":1,"Direction Y":0,"Direction Z":0,"Connector Domain":"duct","Connector Shape":"rectangular",
  "Connector Width":400,"Connector Height":250,"Flow Direction":"out","System Classification":"supply-air"};
 const ports=buildCatalogueConnectorDefinitions([row],"mm");
 assert.equal(ports.length,1); assert.deepEqual(ports[0].origin,[0.5,0,1.2]);
 assert.deepEqual(ports[0].direction,[1,0,0]); assert.deepEqual(ports[0].size,[0.4,0.25]);
 assert.deepEqual(buildCatalogueConnectorDefinitions([{model:"plain"}]),[]);
 assert.throws(()=>buildCatalogueConnectorDefinitions([{...row,"Direction X":0,"Direction Y":0,"Direction Z":0}]),/non-zero/);
 assert.throws(()=>buildCatalogueConnectorDefinitions([{...row,"Connector X":undefined}]),/X\/Y\/Z origin/);
 assert.throws(()=>buildCatalogueConnectorDefinitions([row,{...row,model:"AHU-2","Connector X":600}]),/identical connector definitions/);
 console.log("Catalogue connector mapping: 5 assertions passed");
} finally {fs.rmSync(out,{recursive:true,force:true});}
