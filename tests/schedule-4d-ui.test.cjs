// Source guard: every 4D/5D/6D feature must be reachable from the UI (ribbon, command palette, BIM commands, panel tabs).
const fs = require("fs"), assert = require("assert");
const rd = (p) => fs.readFileSync(p, "utf8");
const ribbon = rd("src/shell/ribbon.ts"), pal = rd("src/features/command-palette.ts"), exp = rd("src/features/bim-experience.ts"), panel = rd("src/features/timeline-panel.ts");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
ok(/pickAndImportP6\(\)/.test(ribbon) && /openTimelineTab\("4d"\)/.test(ribbon) && /openTimelineTab\("5d"\)/.test(ribbon) && /openTimelineTab\("6d"\)/.test(ribbon) && /openTimelineTab\("links"\)/.test(ribbon), "ribbon (Construction tab) buttons");
for (const id of ["schedule.importP6", "schedule.4d", "schedule.5d", "schedule.6d", "schedule.links"]) {
  ok(pal.includes(`"${id}"`), "command palette: " + id);
  ok(exp.includes(`"${id}"`), "BIM command: " + id);
}
for (const t of ['data-tab="${k}"', "p6-import", "p6-csv", "p6-relink", "link-sel", "carbon-factor", "carbon-reset", "open-cost"]) ok(panel.includes(t), "panel control: " + t);
ok(/"4D Timeline"/.test(panel) && /"5D Cost"/.test(panel) && /"6D Carbon"/.test(panel) && /Links/.test(panel), "four tabs");
console.log("schedule-4d-ui OK", n);
