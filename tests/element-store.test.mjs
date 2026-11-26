/**
 * Canonical element store (src/core/element-store.ts) — Phase 1 step 1.
 *
 * Behavioral part imports the store directly (it is dependency-free by
 * design) and proves the contract from the decision note: one id maps to
 * one record, parameter changes route to the owning kind, unknown ids
 * fail loudly, and duplicate ownership is surfaced, not silent.
 * Wiring part asserts authoring registers the "authored" kind adapter.
 */
import { readFileSync } from "node:fs";
import {
  registerKind, registeredKinds, kindOf, listAllIds, elementCount,
  applyParamChange, resetElementStoreForTest,
} from "../src/core/element-store.ts";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " — " + detail : "")); }
};

/* ── behavioral: the store routes to the owning kind ─────────────────── */
resetElementStoreForTest();

const authored = [
  { id: "wall-1", params: { start: [0, 0], end: [4, 0] } },
  { id: "wall-2", params: { start: [0, 1], end: [4, 1] } },
];
const changes = [];
registerKind({
  kind: "authored",
  listIds: () => authored.map((e) => e.id),
  owns: (id) => authored.some((e) => e.id === id),
  applyParamChange: (id, param, value) => { changes.push({ id, param, value }); return { ok: true }; },
});
registerKind({
  kind: "cad",
  listIds: () => ["line-1"],
  owns: (id) => id === "line-1",
  applyParamChange: () => ({ ok: false, reason: "readonly_in_test" }),
});

ok("registered kinds are listed", registeredKinds().join(",") === "authored,cad", registeredKinds().join(","));
ok("one id maps to one record (authored)", kindOf("wall-1") === "authored", String(kindOf("wall-1")));
ok("one id maps to one record (cad)", kindOf("line-1") === "cad", String(kindOf("line-1")));
ok("unknown id has no owner", kindOf("nope") === null, String(kindOf("nope")));
ok("listAllIds unions the kinds", listAllIds().join(",") === "wall-1,wall-2,line-1", listAllIds().join(","));
ok("elementCount unions the kinds", elementCount() === 3, String(elementCount()));

const r1 = applyParamChange("wall-1", "length", 6);
ok("param change routes to the owning kind", r1.ok === true && changes.length === 1 && changes[0].id === "wall-1" && changes[0].param === "length", JSON.stringify({ r1, changes }));
const r2 = applyParamChange("nope", "length", 6);
ok("unknown element fails loudly", r2.ok === false && r2.reason === "unknown_element", JSON.stringify(r2));
const r3 = applyParamChange("line-1", "x", 1);
ok("kind's own refusal comes back unchanged", r3.ok === false && r3.reason === "readonly_in_test", JSON.stringify(r3));

/* ── duplicate ownership is surfaced ─────────────────────────────────── */
resetElementStoreForTest();
registerKind({ kind: "a", listIds: () => ["x"], owns: (id) => id === "x", applyParamChange: () => ({ ok: true }) });
registerKind({ kind: "b", listIds: () => ["x"], owns: (id) => id === "x", applyParamChange: () => ({ ok: true }) });
const warns = [];
const origWarn = console.warn;
console.warn = (m) => warns.push(String(m));
const owner = kindOf("x");
console.warn = origWarn;
ok("duplicate ownership keeps the first owner and warns", owner === "a" && warns.some((w) => w.includes('"x"') && w.includes('"b"')), `${owner} | ${warns.join(" | ")}`);

/* ── wiring: authoring registers the "authored" kind ─────────────────── */
const authoring = readFileSync("src/features/authoring.ts", "utf8");
ok(
  "authoring registers the authored kind adapter",
  /registerKind\(\{\s*kind: "authored"/.test(authoring),
);
ok(
  "the adapter delegates param changes to applyElementParamChange",
  /applyParamChange: \(id, param, value\) => applyElementParamChange\(id, param, value\)/.test(authoring),
);

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
