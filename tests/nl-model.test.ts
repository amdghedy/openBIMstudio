/**
 * tests/nl-model.test.ts — natural-language modelling (words to a room).
 *
 * Covers the pure parser + planner (src/modules/nl-model/) and the
 * executor against a fake authoring engine: the sentence grammar, the
 * 4×6 room geometry, opening placement and fit errors, and the property
 * that every planned room is a closed rectangle whose openings fit.
 *
 * Run: `npx tsx tests/nl-model.test.ts`
 */
import assert from "node:assert";
import fc from "fast-check";
import {
  parseRoomCommand,
  planRoom,
  executeRoomPlan,
  wallLength,
  OPENING_MARGIN,
  type RoomRequest,
} from "../src/modules/nl-model/index";

let pass = 0;
let fail = 0;
const pending: Array<Promise<void>> = [];
function t(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).then === "function") {
      pending.push(
        (r as Promise<void>).then(
          () => { console.log(`  PASS ${name}`); pass++; },
          (e: Error) => { console.error(`  FAIL ${name}\n    ${e.message}`); fail++; },
        ),
      );
      return;
    }
    console.log(`  PASS ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}\n    ${(e as Error).message}`);
    fail++;
  }
}

/* ── parser ─────────────────────────────────────────────────────────── */

t("parses the canonical sentence", () => {
  const r = parseRoomCommand("draw a 4×6 room with a door and two windows");
  assert.strictEqual(r.width, 4);
  assert.strictEqual(r.depth, 6);
  assert.strictEqual(r.wallHeight, 3.0);
  assert.strictEqual(r.doors.count, 1);
  assert.strictEqual(r.doors.width, 0.9);
  assert.strictEqual(r.windows.count, 2);
  assert.strictEqual(r.windows.width, 1.2);
  assert.deepStrictEqual(r.origin, [0, 0]);
});

t("parses x / by separators, units and digit counts", () => {
  const a = parseRoomCommand("create a 4m by 6m room with 3 doors and 1 window");
  assert.strictEqual(a.width, 4);
  assert.strictEqual(a.depth, 6);
  assert.strictEqual(a.doors.count, 3);
  assert.strictEqual(a.windows.count, 1);
  const b = parseRoomCommand("model a 4000mm x 6000mm room");
  assert.strictEqual(b.width, 4);
  assert.strictEqual(b.depth, 6);
  assert.strictEqual(b.doors.count, 0);
  assert.strictEqual(b.windows.count, 0);
});

t("parses opening widths, wall height and origin", () => {
  const r = parseRoomCommand(
    "draw a 5 x 4 room, 2.7 m high, with a 1 m door and two windows 1.5 m wide at 10, 5",
  );
  assert.strictEqual(r.wallHeight, 2.7);
  assert.strictEqual(r.doors.width, 1);
  assert.strictEqual(r.windows.width, 1.5);
  assert.deepStrictEqual(r.origin, [10, 5]);
});

t("parses number words one–ten", () => {
  const r = parseRoomCommand("draw a 6x6 room with four windows");
  assert.strictEqual(r.windows.count, 4);
});

t("a bare plural means one opening", () => {
  const r = parseRoomCommand("draw a 4x6 room with windows");
  assert.strictEqual(r.windows.count, 1);
});

t("rejects sentences with no room, no size, or an absurd size", () => {
  assert.throws(() => parseRoomCommand("draw something nice"), /does not describe a room/);
  assert.throws(() => parseRoomCommand("draw a room with a door"), /no room size/);
  assert.throws(() => parseRoomCommand(""), /Describe a room/);
  assert.throws(() => parseRoomCommand("draw a 0.2x0.2 room"), /outside the supported range/);
  assert.throws(() => parseRoomCommand("draw a 4x6 room with 25 windows"), /between 1 and 20/);
});

/* ── planner ────────────────────────────────────────────────────────── */

t("plans the 4×6 room: closed rectangle, door south, windows north", () => {
  const plan = planRoom(parseRoomCommand("draw a 4×6 room with a door and two windows"));
  assert.strictEqual(plan.walls.length, 4);
  assert.deepStrictEqual(plan.walls[0], { start: [0, 0], end: [4, 0], thickness: 0.255, height: 3.0, elevation: 0 });
  assert.deepStrictEqual(plan.walls[1], { start: [4, 0], end: [4, 6], thickness: 0.255, height: 3.0, elevation: 0 });
  assert.deepStrictEqual(plan.walls[2], { start: [4, 6], end: [0, 6], thickness: 0.255, height: 3.0, elevation: 0 });
  assert.deepStrictEqual(plan.walls[3], { start: [0, 6], end: [0, 0], thickness: 0.255, height: 3.0, elevation: 0 });
  // The rectangle closes: each wall starts where the previous one ended.
  for (let i = 0; i < 4; i++) {
    assert.deepStrictEqual(plan.walls[(i + 1) % 4].start, plan.walls[i].end);
  }
  assert.strictEqual(plan.openings.length, 3);
  const [door, ...windows] = plan.openings;
  assert.strictEqual(door.type, "door");
  assert.strictEqual(door.hostIndex, 0);
  assert.strictEqual(door.offsetAlongHost, 2); // centred on the 4 m south wall
  assert.strictEqual(door.width, 0.9);
  assert.strictEqual(door.sillHeight, 0);
  for (const w of windows) {
    assert.strictEqual(w.type, "window");
    assert.strictEqual(w.hostIndex, 2); // north wall
    assert.strictEqual(w.width, 1.2);
    assert.strictEqual(w.sillHeight, 0.9);
  }
  // Windows spread with 0.3 m margins, centred as a group: offsets 1.25 and 2.75 on a 4 m wall.
  assert.deepStrictEqual(windows.map((w) => w.offsetAlongHost), [1.25, 2.75]);
});

t("windows spill to the east wall when the north wall is full", () => {
  const plan = planRoom(parseRoomCommand("draw a 4x6 room with five windows"));
  const hosts = plan.openings.map((o) => o.hostIndex);
  assert.deepStrictEqual(hosts, [2, 2, 1, 1, 1]);
});

t("refuses openings that do not fit, naming the wall and the numbers", () => {
  assert.throws(
    () => planRoom(parseRoomCommand("draw a 2x2 room with a 1.8 m door")),
    /south wall: they need 2\.40 m with margins but the wall is 2\.00 m/,
  );
  assert.throws(
    () => planRoom(parseRoomCommand("draw a 2x2 room with ten windows")),
    /do not fit on the north, east and west walls/,
  );
  assert.throws(
    () => planRoom(parseRoomCommand("draw a 4x6 room, 2 m high, with a door")),
    /needs a 2\.10 m wall/,
  );
});

/* ── executor (fake authoring engine) ───────────────────────────────── */

t("executes the plan through createElementByType, walls then hosted openings", async () => {
  const calls: Array<{ type: string; params: Record<string, unknown>; hostId?: string }> = [];
  const fake = {
    async createElementByType(type: string, params: Record<string, unknown>, hostId?: string) {
      calls.push({ type, params, hostId });
      return `${type}-${calls.length}`;
    },
  };
  const plan = planRoom(parseRoomCommand("draw a 4×6 room with a door and two windows"));
  const built = await executeRoomPlan(fake, plan);
  assert.strictEqual(built.wallIds.length, 4);
  assert.strictEqual(built.openingIds.length, 3);
  assert.strictEqual(calls.filter((c) => c.type === "wall").length, 4);
  assert.strictEqual(calls.filter((c) => c.type === "door").length, 1);
  assert.strictEqual(calls.filter((c) => c.type === "window").length, 2);
  // Every opening is hosted on a wall id created earlier in this same run.
  for (const c of calls.filter((c) => c.type !== "wall")) {
    assert.ok(c.hostId && built.wallIds.includes(c.hostId), `${c.type} hosted on an unknown wall`);
  }
  // Wall creation comes first — openings cannot precede their host.
  const firstOpening = calls.findIndex((c) => c.type !== "wall");
  assert.ok(calls.slice(0, firstOpening).every((c) => c.type === "wall"));
});

t("executor fails honestly when the engine refuses an element", async () => {
  const fake = { async createElementByType() { return null; } };
  const plan = planRoom(parseRoomCommand("draw a 4x6 room"));
  await assert.rejects(() => executeRoomPlan(fake, plan), /refused wall 1/);
});

/* ── property: every planned room is closed and its openings fit ────── */

t("property: planned rooms are closed rectangles with fitting openings", () => {
  fc.assert(
    fc.property(
      fc.double({ min: 1, max: 20, noNaN: true }),
      fc.double({ min: 1, max: 20, noNaN: true }),
      fc.integer({ min: 0, max: 3 }),
      fc.integer({ min: 0, max: 6 }),
      (w, d, doors, windows) => {
        const width = Math.round(w * 10) / 10;
        const depth = Math.round(d * 10) / 10;
        const req: RoomRequest = {
          width,
          depth,
          wallHeight: 3,
          wallThickness: 0.255,
          origin: [0, 0],
          doors: { count: doors, width: 0.9, height: 2.1, sillHeight: 0 },
          windows: { count: windows, width: 1.2, height: 1.4, sillHeight: 0.9 },
          source: "property",
        };
        let plan;
        try {
          plan = planRoom(req);
        } catch {
          return true; // fit refusal is a valid outcome for tiny rooms
        }
        // Closed rectangle.
        for (let i = 0; i < 4; i++) {
          assert.deepStrictEqual(plan.walls[(i + 1) % 4].start, plan.walls[i].end);
        }
        assert.strictEqual(Math.round(wallLength(plan.walls[0]) * 1000) / 1000, width);
        assert.strictEqual(Math.round(wallLength(plan.walls[1]) * 1000) / 1000, depth);
        // Every opening sits on its wall with margins on both sides.
        for (const o of plan.openings) {
          const length = wallLength(plan.walls[o.hostIndex]);
          assert.ok(o.offsetAlongHost - o.width / 2 >= OPENING_MARGIN - 1e-9);
          assert.ok(o.offsetAlongHost + o.width / 2 <= length - OPENING_MARGIN + 1e-9);
          assert.ok(o.sillHeight + o.height <= req.wallHeight + 1e-9);
        }
        assert.strictEqual(plan.openings.length, doors + windows);
        return true;
      },
    ),
    { numRuns: 100 },
  );
});

await Promise.all(pending);
console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
if (fail) process.exitCode = 1;
