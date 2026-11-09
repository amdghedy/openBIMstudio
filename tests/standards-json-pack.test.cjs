// JSON standards packs: validation, evaluation, and end-to-end load -> registry -> rule check (issue #144).
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "stdpack-"));
execSync(`npx tsc src/modules/standards/rules/json-pack.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict --moduleResolution node`, { stdio: "pipe" });
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const J = require(find("json-pack.js"));
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

// --- the shipped example loads end to end
const ex = J.loadPackText(read("docs/examples/standards-pack-example.json"));
ok(ex.pack && ex.errors.length === 0, "example pack loads: " + ex.errors.join("; "));
ok(ex.pack.rules.length === 3 && ex.pack.rules[0].id === "example-community-pack:door-clear-width", "rule ids are namespaced by pack id");
const door = ex.pack.rules[0], wall = ex.pack.rules[1], slab = ex.pack.rules[2];
// door: 850 mm threshold; property in metres (IFC default) or with a unit suffix
ok(door.check({ props: { "Pset_DoorCommon.ClearWidth": 0.9 } }).pass === true, "0.9 m passes");
let r = door.check({ props: { "Pset_DoorCommon.ClearWidth": 0.8 } });
ok(r.pass === false && /0\.8/.test(r.message) && /850 mm/.test(r.message), "0.8 m fails with actual + required: " + r.message);
ok(door.check({ props: { OverallWidth: "900mm" } }).pass === true, "'900mm' string normalised to metres");
r = door.check({ props: {}, elementId: 7, elementName: "D1", elementCategory: "IFCDOOR" });
ok(r.pass === false && r.violations.length === 1 && r.violations[0].severity === "info" && r.violations[0].elementId === 7, "missing:info -> one information-level note, not a warning");
// wall: when external -> must have fire rating; missing:fail
ok(wall.check({ props: { "Pset_WallCommon.IsExternal": "false" } }).pass === true, "internal wall not checked");
ok(wall.check({ props: { "Pset_WallCommon.IsExternal": "true", "Pset_WallCommon.FireRating": "REI 60" } }).pass === true, "external + rating passes");
r = wall.check({ props: { "Pset_WallCommon.IsExternal": "true" } });
ok(r.pass === false && /no fire rating/.test(r.message), "external without rating fails");
// slab: when + any
ok(slab.check({ props: { "Pset_SlabCommon.LoadBearing": "true", Material: "Reinforced Concrete C30" } }).pass === true, "any(contains concrete)");
ok(slab.check({ props: { "Pset_SlabCommon.LoadBearing": "true", Material: "Timber" } }).pass === false, "timber load-bearing slab flagged");
ok(slab.check({ props: { "Pset_SlabCommon.LoadBearing": "true" } }).pass === true, "no material recorded -> default missing=pass");

// --- evaluator operators
const E = J.evalCondition;
const P = { A: 5, S: "Hello World", Z: "" };
ok(E({ property: "A", op: "gte", value: 5 }, P) === true && E({ property: "A", op: "gt", value: 5 }, P) === false, "gte/gt");
ok(E({ property: "A", op: "between", value: [4, 6] }, P) === true && E({ property: "A", op: "between", value: [6, 9] }, P) === false, "between");
ok(E({ property: "A", op: "eq", value: 5 }, P) === true && E({ property: "A", op: "ne", value: 5 }, P) === false, "eq/ne");
ok(E({ property: "S", op: "contains", value: "world" }, P) === true && E({ property: "S", op: "matches", value: "^hello" }, P) === true && E({ property: "S", op: "in", value: ["x", "hello world"] }, P) === true, "string ops are case-insensitive");
ok(E({ property: "Q", op: "gte", value: 1 }, P) === undefined, "unknown property -> undefined (not false)");
ok(E({ property: "Z", op: "exists" }, P) === false && E({ property: "Z", op: "notExists" }, P) === true, "empty counts as not recorded");
ok(E({ property: ["Q", "A"], op: "eq", value: 5 }, P) === true, "first recorded property of a list is used");
ok(E({ not: { property: "A", op: "eq", value: 5 } }, P) === false, "not");
ok(E({ all: [{ property: "A", op: "eq", value: 5 }, { property: "Q", op: "exists" }] }, P) === false, "all: a definite false wins");
ok(E({ all: [{ property: "A", op: "eq", value: 5 }, { property: "Q", op: "gte", value: 1 }] }, P) === undefined, "all: unknown stays unknown");
ok(E({ any: [{ property: "Q", op: "gte", value: 1 }, { property: "A", op: "eq", value: 5 }] }, P) === true, "any: a true wins");
ok(E({ property: "A", op: "lte", value: 5000, unit: "mm" }, { A: 4.9 }) === true && E({ property: "A", op: "lte", value: 5000, unit: "mm" }, { A: 5.1 }) === false, "unit converts the threshold to metres");

// --- validation: hostile or sloppy files are rejected with reasons, never thrown
const base = () => JSON.parse(read("docs/examples/standards-pack-example.json"));
const bad = (mut, re, label) => { const p = base(); mut(p); const v = J.validatePackJson(p); ok(!v.ok && v.errors.some((e) => re.test(e)), label + " -> " + v.errors.join("|")); };
bad((p) => { p.format = "x"; }, /format/, "wrong format");
bad((p) => { p.formatVersion = 2; }, /formatVersion/, "future version");
bad((p) => { p.id = "has space"; }, /id/, "bad id");
bad((p) => { p.rules = []; }, /rules/, "no rules");
bad((p) => { p.rules[1].id = p.rules[0].id; }, /duplicate/, "duplicate rule id");
bad((p) => { p.rules[0].severity = "fatal"; }, /severity/, "bad severity");
bad((p) => { p.rules[0].require.op = "execute"; }, /op/, "unknown operator");
bad((p) => { p.rules[0].require.value = "850"; }, /value/, "number expected");
bad((p) => { p.rules[0].require.unit = "parsec"; }, /unit/, "bad unit");
bad((p) => { p.rules[0].require = { property: "A", op: "matches", value: "(" }; }, /regular expression/, "invalid regex");
bad((p) => { p.rules[0].require = { property: "A", op: "matches", value: "a".repeat(300) }; }, /200/, "regex too long");
bad((p) => { delete p.rules[0].require; }, /require/, "missing require");
bad((p) => { let c = { property: "A", op: "exists" }; for (let i = 0; i < 10; i++) c = { not: c }; p.rules[0].require = c; }, /nested/, "too deep");
bad((p) => { p.rules[0].check = "alert(1)"; p.rules[0].require = { property: "A", op: "between", value: [9, 1] }; }, /min <= max/, "between order");
for (const text of ["", "not json", "[]", "null", '{"format":1}']) { const x = J.loadPackText(text); ok(!x.pack && x.errors.length > 0, "rejects " + JSON.stringify(text.slice(0, 12))); }
ok(J.loadPackText("x".repeat(5_000_001)).errors[0].includes("5 MB"), "size cap");
// a pack file cannot smuggle code: compiled rules only call the evaluator
const p2 = base(); p2.rules[0].toString = "evil"; p2.rules[0].check = "evil";
const loaded = J.loadPackText(JSON.stringify(p2));
ok(loaded.pack && typeof loaded.pack.rules[0].check === "function" && loaded.pack.rules[0].check({ props: { OverallWidth: 1 } }).pass === true, "unknown fields are ignored; check() is always ours");
// ReDoS guard: nested quantifiers are rejected at validation time, and the matched text is capped
bad((p) => { p.rules[0].require = { property: "A", op: "matches", value: "^(a+)+$" }; }, /nested quantifiers/, "nested quantifier rejected");
bad((p) => { p.rules[0].require = { property: "A", op: "matches", value: "(x*)*y" }; }, /nested quantifiers/, "nested star rejected");
ok(J.validatePackJson(Object.assign(base(), { rules: [Object.assign(base().rules[0], { require: { property: "A", op: "matches", value: "^(abc|def)\\d+$" } })] })).ok, "ordinary grouped regex is accepted");
// schema file and example agree on the top-level contract
const schema = JSON.parse(read("docs/schemas/standards-pack.schema.json"));
ok(schema.required.every((k) => k in base()), "example has every field the schema requires");
console.log(`standards-json-pack: ${n} assertions passed`);
