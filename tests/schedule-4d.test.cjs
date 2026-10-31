const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "s4d-"));
execSync(`npx tsc src/modules/schedule-4d/p6-parser.ts src/modules/schedule-4d/schedule-model.ts src/modules/schedule-4d/task-linking.ts src/modules/schedule-4d/curves.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict`, { stdio: "pipe" });
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const P = require(find("p6-parser.js")), S = require(find("schedule-model.js")), L = require(find("task-linking.js")), C = require(find("curves.js"));
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const near = (a, b, e = 1e-6) => ok(Math.abs(a - b) < e, `${a} != ${b}`);

// ---- XER
const T = (...c) => c.join("\t");
const xer = [
  "ERMHDR\t20.12\t2026-01-01\tProject\tadmin\tdb\tProject Management\tUSD",
  T("%T", "PROJECT"), T("%F", "proj_id", "proj_short_name"), T("%R", "1", "TowerA"), T("%E"),
  T("%T", "PROJWBS"), T("%F", "wbs_id", "parent_wbs_id", "wbs_short_name", "wbs_name"),
  T("%R", "10", "", "TWR", "Tower"), T("%R", "11", "10", "STR", "Structure"), T("%E"),
  T("%T", "TASK"), T("%F", "task_id", "wbs_id", "task_code", "task_name", "task_type", "status_code", "phys_complete_pct", "target_start_date", "target_end_date", "act_start_date", "act_end_date"),
  T("%R", "100", "11", "A1000", "Level 1 Columns", "TT_Task", "TK_Complete", "100", "2026-01-05 08:00", "2026-01-12 17:00", "2026-01-05 08:00", "2026-01-13 17:00"),
  T("%R", "101", "11", "A1010", "Level 1 Slab", "TT_Task", "TK_Active", "40", "2026-01-13 08:00", "2026-01-27 17:00", "", ""),
  T("%R", "102", "11", "A1020", "Level 2 Walls", "TT_Task", "TK_NotStart", "0", "2026-01-28 08:00", "2026-02-10 17:00", "", ""),
  T("%R", "103", "10", "M1", "Topping out", "TT_Mile", "TK_NotStart", "0", "2026-02-10 17:00", "2026-02-10 17:00", "", ""),
  T("%R", "104", "10", "BAD", "No dates", "TT_Task", "TK_NotStart", "0", "", "", "", ""), T("%E"),
  T("%T", "TASKPRED"), T("%F", "task_id", "pred_task_id", "pred_type", "lag_hr_cnt"), T("%R", "101", "100", "PR_FS", "0"), T("%R", "102", "101", "PR_FS", "16"), T("%E"),
  T("%T", "TASKRSRC"), T("%F", "task_id", "target_cost"), T("%R", "101", "50000"), T("%R", "101", "10000"), T("%E"),
].join("\r\n");
let s = P.parseP6(xer);
ok(s.source === "xer" && s.projectName === "TowerA", "xer detect");
ok(s.tasks.length === 4 && s.warnings.some((w) => /BAD/.test(w)), "tasks + warning for dateless");
const a = s.tasks.find((t) => t.id === "A1000");
ok(a.wbs === "TWR.STR" && a.percent === 100 && a.isMilestone === false, "wbs path + complete");
near(a.finish - a.start, 8 * 86400000 + 9 * 3600000, 1); // actual dates win (13 Jan 17:00)
ok(s.tasks.find((t) => t.id === "A1010").plannedCost === 60000, "task cost summed");
ok(s.tasks.find((t) => t.id === "M1").isMilestone, "milestone");
const t102 = s.tasks.find((t) => t.id === "A1020");
ok(t102.predecessors[0].key === "101" && t102.predecessors[0].type === "FS" && t102.predecessors[0].lagDays === 2, "pred + lag");

// ---- PMXML
const xml = `<?xml version="1.0"?><APIBusinessObjects xmlns="http://xmlns.oracle.com/Primavera/P6/V20.12/API/BusinessObjects">
<Project><ObjectId>1</ObjectId><Name>Villa &amp; Pool</Name>
<WBS><ObjectId>5</ObjectId><Code>V</Code><Name>Villa</Name></WBS><WBS><ObjectId>6</ObjectId><Code>STR</Code><Name>Structure</Name><ParentObjectId>5</ParentObjectId></WBS>
<Activity><ObjectId>900</ObjectId><Id>X10</Id><Name>Ground floor columns</Name><WBSObjectId>6</WBSObjectId><PlannedStartDate>2026-03-02T08:00:00</PlannedStartDate><PlannedFinishDate>2026-03-06T17:00:00</PlannedFinishDate><PhysicalPercentComplete>25</PhysicalPercentComplete><Type>Task Dependent</Type></Activity>
<Activity><ObjectId>901</ObjectId><Id>X20</Id><Name><![CDATA[Roof slab]]></Name><WBSObjectId>6</WBSObjectId><StartDate>2026-03-09T08:00:00</StartDate><FinishDate>2026-03-20T17:00:00</FinishDate><Status>Completed</Status></Activity>
<ActivityCode><ObjectId>1</ObjectId></ActivityCode>
<Relationship><PredecessorActivityObjectId>900</PredecessorActivityObjectId><SuccessorActivityObjectId>901</SuccessorActivityObjectId><Type>Finish to Start</Type><Lag>0</Lag></Relationship>
<ResourceAssignment><ActivityObjectId>901</ActivityObjectId><PlannedCost>12000.5</PlannedCost></ResourceAssignment>
</Project></APIBusinessObjects>`;
s = P.parseP6(xml);
ok(s.source === "pmxml" && s.projectName === "Villa & Pool" && s.tasks.length === 2, "pmxml basic");
ok(s.tasks[0].wbs === "V.STR" && s.tasks[0].percent === 25, "pmxml wbs + pct");
ok(s.tasks[1].percent === 100 && s.tasks[1].plannedCost === 12000.5 && s.tasks[1].predecessors[0].type === "FS", "pmxml completed + cost + rel");
ok(P.parseP6("garbage").tasks.length === 0 && P.parseP6("garbage").warnings.length === 1, "garbage tolerated");

// ---- schedule model
s = P.parseP6(xer);
const r = S.scheduleRange(s.tasks);
ok(r.start === Date.UTC(2026, 0, 5, 8) && r.finish === Date.UTC(2026, 1, 10, 17), "range");
const t101 = s.tasks.find((t) => t.id === "A1010");
ok(S.taskStatusAt(t101, t101.start - 1).status === "notStarted" && S.taskStatusAt(t101, t101.finish).status === "complete", "status edges");
near(S.taskStatusAt(t101, (t101.start + t101.finish) / 2).fraction, 0.5);
ok(S.criticalTaskIds(s.tasks).has("A1020") && S.criticalTaskIds(s.tasks).has("A1010"), "critical chain");
ok(Array.isArray(S.logicViolations(s.tasks)), "logic check runs");

// ---- linking
ok(L.levelFromText("Level 2 Walls") === 2 && L.levelFromText("2nd floor slab") === 2 && L.levelFromText("Ground floor columns") === 0 && L.levelFromText("L3 beams") === 3 && L.levelFromText("Roof slab") === null && L.levelFromText("second floor") === 2, "levelFromText");
ok(L.levelNumber("Level 2") === 2 && L.levelNumber("Ground Floor") === 0 && L.levelNumber("") === null, "levelNumber");
const els = [
  { id: "c1", type: "column", level: "Level 1" }, { id: "c2", type: "column", level: "Level 2" },
  { id: "s1", type: "slab", level: "Level 1" }, { id: "s2", type: "slab", level: "Level 2" },
  { id: "w2", type: "wall", level: "Level 2" }, { id: "w1", type: "wall", level: "Level 1" },
  { id: "x", type: "wall", level: "Level 1", activityId: "M1" }, { id: "dx", type: "duct", level: "Level 1" },
  { id: "deep", type: "beam", wbs: "TWR.STR.COL.1" },
];
const lk = L.linkTasksToElements(s.tasks, els);
ok(lk.byTask.get("A1000").includes("c1") && !lk.byTask.get("A1000").includes("c2"), "L1 columns -> c1, not c2");
ok(lk.byTask.get("A1010").join() === "s1" && lk.byTask.get("A1020").join() === "w2", "L1 slab -> s1; L2 walls -> w2");
ok(lk.byTask.get("A1020").join() === "w2", "L2 walls -> w2 only");
ok(lk.byElement.get("x") === "M1" && lk.how.get("x") === "id", "explicit activityId wins over vocabulary");
ok(lk.how.get("deep") === "wbs" && lk.byElement.get("deep") === "A1000", "wbs prefix link (deepest matching WBS, first task)");
ok(lk.unlinkedElements.includes("dx") && lk.unlinkedElements.includes("c2"), "unlinked reported");
ok(lk.unlinkedTasks.includes("BAD") === false, "dateless task not in list");

// ---- 5D / 6D
const ec = new Map([["c1", 1000], ["s1", 9999], ["w2", 2000]]);
const items = C.buildCostItems(s.tasks, lk, ec);
const byId = Object.fromEntries(items.map((i) => [i.id, i]));
ok(byId.A1000.value === 1000 && byId.A1000.source === "model", "model cost");
ok(byId.A1010.value === 60000 && byId.A1010.source === "p6", "p6 cost wins");
near(C.valueAt(items, r.finish), 63000);
near(C.valueAt(items, r.start - 1), 0);
const cv = C.curve(items, r.start, r.finish, 10);
ok(cv.length === 10 && cv.every((p, i) => i === 0 || p.value >= cv[i - 1].value - 1e-9), "monotonic S-curve");
const q = C.authoredQuantity({ type: "wall", params: { start: [0, 0], end: [4, 0], height: 3, thickness: 0.2 } });
near(q.volume, 2.4); near(q.area, 12); near(q.length, 4);
near(C.authoredQuantity({ type: "slab", params: { polygon: [[0, 0], [5, 0], [5, 4], [0, 4]], thickness: 0.2 } }).volume, 4);
near(C.authoredQuantity({ type: "column", params: { point: [0, 0], width: 0.4, depth: 0.4, height: 3 } }).volume, 0.48);
near(C.elementCarbon("wall", q), 600); near(C.elementCarbon("ifcwall", q), 600);
near(C.elementCarbon("wall", q, { wall: { unit: "m2", kgCO2ePerUnit: 10, note: "" } }), 120);
near(C.elementCarbon("unknown", q), 0);
const ci = C.buildCarbonItems(s.tasks, lk, new Map([["c1", 400], ["w2", 600]]));
near(C.total(ci), 1000); ok(ci.length === 2, "carbon items");
console.log("schedule-4d OK", n);
