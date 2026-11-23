const fs = require("fs"), path = require("path"), assert = require("assert");
for (const pack of ["13", "14"]) {
  const src = fs.readFileSync(path.join(__dirname, `../src/modules/bim-gaps/critical-workflow-pack-${pack}.ts`), "utf8");
  assert.match(src, new RegExp(`setupCriticalWorkflowPack${pack}`));
  assert.match(fs.readFileSync(path.join(__dirname, "../src/main.ts"), "utf8"), new RegExp(`critical-workflow-pack-${pack}`));
}
console.log("PASS workflow-pack-13+14 contracts");
