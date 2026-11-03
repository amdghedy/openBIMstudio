// Keep the architecture inventory synchronized with the real module directories.
// This deliberately checks directory coverage only; it does not claim runtime maturity.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const docPath = path.join(root, "docs/engineering/ARCHITECTURE.md");
const doc = fs.readFileSync(docPath, "utf8");
const start = "<!-- module-map:start -->";
const end = "<!-- module-map:end -->";
const startAt = doc.indexOf(start);
const endAt = doc.indexOf(end);
assert.ok(startAt >= 0 && endAt > startAt, "Architecture document must contain module-map markers");
const block = doc.slice(startAt + start.length, endAt);
const fenceStart = block.indexOf("```json");
assert.ok(fenceStart >= 0, "Module inventory must be a fenced JSON block");
const jsonStart = block.indexOf("\n", fenceStart) + 1;
const fenceEnd = block.indexOf("```", jsonStart);
assert.ok(fenceEnd > jsonStart, "Module inventory JSON fence must close");
const groups = JSON.parse(block.slice(jsonStart, fenceEnd).trim());
assert.ok(Array.isArray(groups) && groups.length > 0, "Module inventory must contain groups");

const listed = groups.flatMap((group) => {
  assert.equal(typeof group.name, "string", "Every module group needs a name");
  assert.equal(typeof group.purpose, "string", group.name + " needs a purpose");
  assert.ok(Array.isArray(group.directories), group.name + " needs a directories array");
  return group.directories;
});
assert.equal(listed.length, new Set(listed).size, "A module directory must appear exactly once");

const moduleRoot = path.join(root, "src/modules");
const actual = fs.readdirSync(moduleRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const expected = [...listed].sort();
assert.deepEqual(expected, actual,
  "Architecture module inventory is stale. Update docs/engineering/ARCHITECTURE.md for added/removed src/modules directories.\n" +
  "Missing from document: " + actual.filter((name) => !listed.includes(name)).join(", ") + "\n" +
  "No longer in source: " + listed.filter((name) => !actual.includes(name)).join(", "));

for (const link of ["../ARCHITECTURE.md", "../../documentation/DEVELOPER_GUIDE.md", "../AI_AGENT_WORKFLOWS.md", "../COMPATIBILITY.md"]) {
  const target = path.resolve(path.dirname(docPath), link);
  assert.ok(fs.existsSync(target), "Architecture reference is broken: " + link);
}
console.log("PASS architecture map covers all " + actual.length + " top-level src/modules directories exactly once");
console.log("PASS architecture reference documents exist");
