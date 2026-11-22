const fs = require("fs"), path = require("path"), assert = require("assert");
const src = fs.readFileSync(path.join(__dirname, "../src/modules/bim-gaps/critical-workflow-pack-12.ts"), "utf8");
for (const name of [
  "isolateSelection", "showAllElements", "hideSelectedCategories", "selectSimilarType",
  "selectByActiveLevel", "levelReport", "unitsReport", "quickRecoverySnapshot",
  "linkedModelsSummary", "clearTempHiddenFlags", "setupCriticalWorkflowPack12",
]) assert.match(src, new RegExp("export (async )?function " + name));
assert.match(fs.readFileSync(path.join(__dirname, "../src/main.ts"), "utf8"), /critical-workflow-pack-12/);
console.log("PASS workflow-pack-12 contracts");
