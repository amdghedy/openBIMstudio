// MS Project XML + CSV schedule readers and the format dispatcher (pure, no DOM).
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "sched-imp-"));
execSync(`npx tsc src/modules/schedule-4d/p6-parser.ts src/modules/schedule-4d/msproject-parser.ts src/modules/schedule-4d/csv-schedule.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict`, { stdio: "pipe" });
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const P = require(find("p6-parser.js")), M = require(find("msproject-parser.js")), C = require(find("csv-schedule.js"));
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const near = (a, b, e = 1e-6) => ok(Math.abs(a - b) < e, `${a} != ${b}`);
const D = (s) => Date.UTC(...s.split("-").map((x, i) => (i === 1 ? +x - 1 : +x)));

// ---- MSPDI
const msp = `<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project"><Name>Tower &amp; Podium</Name><Tasks>
<Task><UID>0</UID><ID>0</ID><Name>Tower &amp; Podium</Name><Summary>1</Summary><Start>2026-01-05T08:00:00</Start><Finish>2026-02-10T17:00:00</Finish></Task>
<Task><UID>1</UID><ID>1</ID><Name>Structure</Name><WBS>1</WBS><Summary>1</Summary><Start>2026-01-05T08:00:00</Start><Finish>2026-01-27T17:00:00</Finish></Task>
<Task><UID>2</UID><ID>2</ID><Name>Columns</Name><WBS>1.1</WBS><Start>2026-01-05T08:00:00</Start><Finish>2026-01-12T17:00:00</Finish><PercentComplete>100</PercentComplete><Cost>5000000</Cost></Task>
<Task><UID>3</UID><ID>3</ID><Name>Slab</Name><WBS>1.2</WBS><Start>2026-01-13T08:00:00</Start><Finish>2026-01-27T17:00:00</Finish><PercentComplete>40</PercentComplete>
 <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type><LinkLag>28800</LinkLag></PredecessorLink>
 <PredecessorLink><PredecessorUID>99</PredecessorUID><Type>3</Type></PredecessorLink></Task>
<Task><UID>4</UID><ID>4</ID><Name>Topping out</Name><WBS>1.3</WBS><Milestone>1</Milestone><Start>2026-02-10T17:00:00</Start><Finish>2026-02-10T17:00:00</Finish>
 <PredecessorLink><PredecessorUID>3</PredecessorUID><Type>3</Type></PredecessorLink></Task>
<Task><UID>5</UID><ID>5</ID><Name>No dates</Name></Task>
</Tasks></Project>`;
ok(M.isMspdi(msp), "detects MSPDI");
let s = M.parseMspdi(msp);
ok(s.source === "mspdi", "source");
ok(s.projectName === "Tower & Podium", "project name unescaped: " + s.projectName);
ok(s.tasks.length === 3, "summary rows + undated skipped: " + s.tasks.length);
const slab = s.tasks.find((t) => t.name === "Slab");
ok(slab.percent === 40 && slab.wbs === "1.2", "fields");
ok(slab.predecessors.length === 1 && slab.predecessors[0].key === "2" && slab.predecessors[0].type === "FS", "link kept, dangling dropped");
near(slab.predecessors[0].lagDays, 28800 / 10 / 60 / 24); // 2.0 days (calendar approximation)
ok(s.tasks.find((t) => t.name === "Topping out").isMilestone, "milestone");
ok(s.tasks.find((t) => t.name === "Topping out").predecessors[0].type === "SS", "type 3 = SS");
near(s.tasks.find((t) => t.name === "Columns").plannedCost, 50000);
ok(s.warnings.some((w) => /summary/.test(w)) && s.warnings.some((w) => /no start/.test(w)) && s.warnings.some((w) => /dropped/.test(w)), "warnings");
near(M.parseIsoDurationHours("PT8H0M0S"), 8); near(M.parseIsoDurationHours("P2DT4H"), 52); near(M.parseIsoDurationHours("junk"), 0);
ok(M.parseMspdi("<Project></Project>").tasks.length === 0, "empty ok");

// ---- CSV
const csv = [
  "ID,Task Name,WBS,Start,Finish,% Complete,Cost,Predecessors",
  'A1,"Columns, L1",1.1,2026-01-05,2026-01-12,100,"50,000",',
  "A2,Slab,1.2,2026-01-13,2026-01-27,40,10000,A1",
  "A3,Walls,1.3,2026-01-28,2026-02-10,0,,A2FS+2d;A1SS-1d;ZZ",
  "A4,Broken,1.4,not-a-date,2026-02-10,0,,",
].join("\r\n");
s = C.parseCsvSchedule(csv);
ok(s.source === "csv" && s.tasks.length === 3, "3 good rows: " + s.tasks.length);
ok(s.tasks[0].name === "Columns, L1", "quoted comma");
near(s.tasks[0].plannedCost, 50000);
near(s.tasks[0].start, D("2026-1-5")); near(s.tasks[0].durationDays, 7);
const w = s.tasks[2];
ok(w.predecessors.length === 2, "ZZ ignored");
ok(w.predecessors[0].type === "FS" && w.predecessors[0].lagDays === 2, "FS+2d");
ok(w.predecessors[1].type === "SS" && w.predecessors[1].lagDays === -1, "SS-1d");
ok(s.warnings.some((x) => /skipped/.test(x)) && s.warnings.some((x) => /matched no task/.test(x)), "csv warnings");
// semicolon + duration column + day-first dates
s = C.parseCsvSchedule("Activity;Start;Duration\nPour;15/03/2026;3\nCure;03/04/2026;2");
ok(s.tasks.length === 2 && s.tasks[0].durationDays === 3, "duration col");
near(s.tasks[0].start, D("2026-3-15"));
ok(s.warnings.some((x) => /day-first/.test(x)), "ambiguous flagged");
ok(C.parseCsvSchedule("Foo,Bar\n1,2").tasks.length === 0 && /name/.test(C.parseCsvSchedule("Foo,Bar\n1,2").warnings[0]), "no name column explained");
ok(C.parseCsvSchedule("").tasks.length === 0, "empty");
// formula-looking / injection text is just data here
ok(C.parseCsvSchedule("Name,Start,Finish\n=1+1,2026-01-01,2026-01-02").tasks[0].name === "=1+1", "kept verbatim");

// ---- dispatcher
ok(P.parseSchedule(msp).source === "mspdi", "dispatch mspdi");
ok(P.parseSchedule(csv, "x.csv").source === "csv", "dispatch csv");
ok(P.parseSchedule("Task Name,Start,Finish\nA,2026-01-01,2026-01-02").source === "csv", "sniff csv");
ok(P.parseSchedule("ERMHDR\t20.12\t2026-01-01\tProject\n%T\tPROJECT\n%F\tproj_id\n%R\t1\n%E").source === "xer", "dispatch xer");
ok(P.parseSchedule('<APIBusinessObjects><Project><Name>X</Name></Project></APIBusinessObjects>').source === "pmxml", "dispatch pmxml");
console.log(`schedule-import: ${n} assertions passed`);
