const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cad-layer-"));
execSync(`npx tsc src/modules/cad/cad-engine.ts --outDir "${out}" --module commonjs --target ES2022 --moduleResolution node --lib ES2022,DOM --skipLibCheck --noCheck`, { cwd: root, stdio: "inherit" });
const engineModule = path.join(out, "modules", "cad", "cad-engine.js");
const { CadEngine } = require(engineModule);

const engine = new CadEngine();
const layer0 = engine.getActiveLayer().id;
engine.addPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
engine.addLine({ x: 20, y: 0 }, { x: 20, y: 10 });
const hidden = engine.addLayer("Hidden sections");
engine.setActiveLayer(hidden.id);
engine.addPolyline([{ x: 30, y: 0 }, { x: 30, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 20 }]);
engine.addLine({ x: 50, y: 0 }, { x: 50, y: 10 });

assert.equal(engine.listEntities().length, 4);
engine.setLayerVisible(hidden.id, false);
assert.equal(engine.listEntities().length, 2, "hiding one layer hides the complete multi-section element");
assert.ok(engine.listEntities().every((entity) => entity.layer === layer0));
engine.setLayerVisible(hidden.id, true);
assert.equal(engine.listEntities().length, 4, "showing the layer restores all of its sections");
console.log("PASS 2D CAD whole-layer visibility hides and restores multi-section elements");
