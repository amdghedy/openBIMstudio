/**
 * tests/nl-query-authored.test.ts — NL query over LIVE authored elements.
 *
 * Regression: runNlQuery used to pass only `properties` to the executor,
 * and authored elements carry geometry in `params`, not `properties` —
 * so "walls taller than 3 m" found no Height property, the criterion was
 * silently skipped, and every wall matched regardless of height.
 * `authoredToQueryElement` (src/modules/nl-query/executor.ts) maps the
 * live params onto the criteria the parser emits (Height, Width, Length).
 *
 * Run: `npx tsx tests/nl-query-authored.test.ts`
 */
import assert from "node:assert";
import { executeNLQuery, authoredToQueryElement } from "../src/modules/nl-query/executor";

let pass = 0;
let fail = 0;
function t(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}\n    ${(e as Error).message}`);
    fail++;
  }
}

const authored = [
  { id: "w-tall", type: "wall", params: { start: [0, 0], end: [4, 0], height: 3.0, thickness: 0.255, elevation: 0 }, properties: {} },
  { id: "w-short", type: "wall", params: { start: [0, 0], end: [6, 0], height: 2.4, thickness: 0.2, elevation: 0 }, properties: {} },
  { id: "w-thick", type: "wall", params: { start: [0, 0], end: [4, 0], height: 3.0, thickness: 0.4, elevation: 0 }, properties: {} },
  { id: "d1", type: "door", params: { height: 2.1, width: 0.9 }, properties: {} },
  { id: "s1", type: "slab", params: { height: 0.3 }, properties: {} },
];
const queryable = authored.map((e) => authoredToQueryElement(e));

t("maps live geometry onto the query properties", () => {
  const tall = queryable[0];
  assert.strictEqual(tall.category, "WALL");
  assert.strictEqual(tall.properties.Height, 3.0);
  assert.strictEqual(tall.properties.Width, 0.255);
  assert.strictEqual(tall.properties.Length, 4);
  assert.strictEqual(tall.properties.Elevation, 0);
  const door = queryable[3];
  assert.strictEqual(door.category, "DOOR");
  assert.strictEqual(door.properties.Height, 2.1);
  assert.strictEqual(door.properties.Width, 0.9);
});

t("walls taller than 3 m matches only the 3 m walls", () => {
  const r = executeNLQuery("select walls taller than 3m", queryable);
  assert.deepStrictEqual(r.matchedIds.sort(), ["w-tall", "w-thick"]);
});

t("walls taller than 2.5 m matches the 3 m walls, not the 2.4 m wall", () => {
  const r = executeNLQuery("select walls taller than 2.5m", queryable);
  assert.deepStrictEqual(r.matchedIds.sort(), ["w-tall", "w-thick"]);
  assert.strictEqual(r.matchedCount, 2);
});

t("walls thicker than 300mm matches only the 0.4 m wall", () => {
  const r = executeNLQuery("select walls thicker than 300mm", queryable);
  assert.deepStrictEqual(r.matchedIds, ["w-thick"]);
});

t("plain category queries still work", () => {
  const walls = executeNLQuery("select all walls", queryable);
  assert.deepStrictEqual(walls.matchedIds.sort(), ["w-short", "w-tall", "w-thick"]);
  const doors = executeNLQuery("select all doors", queryable);
  assert.deepStrictEqual(doors.matchedIds, ["d1"]);
});

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
if (fail) process.exitCode = 1;
