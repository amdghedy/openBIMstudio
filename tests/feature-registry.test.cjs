/* Feature maturity registry drift test (remediation program Phase 2). */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const root = path.join(__dirname, "..");
const regSrc = fs.readFileSync(path.join(root, "src/features/feature-maturity.ts"), "utf8");
const STATUSES = ["verified", "limited", "experimental", "unavailable", "planned"];
const arrayStart = regSrc.indexOf("export const FEATURE_MATURITY");
const arrayEnd = regSrc.indexOf("] as const;", arrayStart);
const arraySrc = regSrc.slice(arrayStart, arrayEnd);
const entryBlocks = [...arraySrc.matchAll(/\n  \{([\s\S]*?)(?=\n  \},?\n  \{|\n  \},?\n\])/g)].map((m) => m[1]);
const strList = (s) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const entries = entryBlocks.map((block) => {
  const id = (block.match(/\bid:\s*"([^"]+)"/) || [])[1];
  const area = (block.match(/\barea:\s*"([^"]+)"/) || [])[1];
  const status = (block.match(/\bstatus:\s*"([^"]+)"/) || [])[1];
  const sourceBlock = (block.match(/\bsource:\s*\[([\s\S]*?)\]/) || [])[1] || "";
  const evidenceBlock = (block.match(/\bevidence:\s*\[([\s\S]*?)\]/) || [])[1] || "";
  const limitBlock = (block.match(/\blimitations:\s*\[([\s\S]*?)\]\s*,\s*affirmedIn\b/) || [])[1] || "";
  return { id, area, status, source: strList(sourceBlock), evidence: strList(evidenceBlock), limitations: strList(limitBlock), raw: block };
});

t("registry contains entries and all ids are unique", () => {
  assert.ok(entries.length >= 20, "registry unexpectedly small: " + entries.length);
  const ids = entries.map((e) => e.id); assert.deepStrictEqual(ids, [...new Set(ids)], "duplicate ids");
});
t("every entry uses a status from the allowed vocabulary", () => { for (const e of entries) assert.ok(STATUSES.includes(e.status), e.id + " has invalid status: " + e.status); });
t("every source path exists on disk", () => {
  const missing = []; for (const e of entries) for (const p of e.source) if (!fs.existsSync(path.join(root, p))) missing.push(e.id + " → " + p); assert.deepStrictEqual(missing, []);
});
t("every evidence file path exists (npm scripts and prose refs are skipped)", () => {
  const missing = [];
  for (const e of entries) for (const ref of e.evidence) {
    if (ref.startsWith("npm ") || ref.includes("§") || ref.includes("docs/CSP.md")) {
      if (ref.includes("docs/") && !fs.existsSync(path.join(root, ref.split(" ")[0]))) missing.push(e.id + " → " + ref);
      continue;
    }
    if (ref.endsWith("/") || ref.endsWith(" tests/")) continue;
    if (ref.startsWith("tests/") && !fs.existsSync(path.join(root, ref))) missing.push(e.id + " → " + ref);
  }
  assert.deepStrictEqual(missing, []);
});
t("non-verified entries document at least one limitation (honesty rule)", () => {
  const bad = entries.filter((e) => e.status !== "verified" && e.status !== "planned" && e.limitations.length === 0).map((e) => e.id);
  assert.deepStrictEqual(bad, []);
});
t("unavailable entries must not reference source paths (no hidden stubs)", () => {
  const bad = entries.filter((e) => e.status === "unavailable" && e.source.length > 0).map((e) => e.id); assert.deepStrictEqual(bad, []);
});
t("required feature ids are pinned (no silent removal)", () => {
  const required = ["authoring-tools", "modeling-panel", "modify-engine", "viewcube-navigation", "solid-kernel", "ifc-import-export", "dxf-import-export", "dwg-import", "dwg-export", "aps-conversion", "bcf-21", "ids-audit", "sheets-views-pdf", "schedules-cost", "clash-detection", "collaboration", "ai-assistant", "plugin-system", "encrypted-projects", "web-security", "pwa-offline"];
  const ids = new Set(entries.map((e) => e.id)); assert.deepStrictEqual(required.filter((r) => !ids.has(r)), []);
});
t("dwg-export stays honestly unavailable (no fake success regression)", () => {
  const e = entries.find((x) => x.id === "dwg-export"); assert.strictEqual(e.status, "unavailable"); assert.ok(/stub was removed|not implemented/.test(e.limitations.join(" ")));
});
t("registry affirms the current app version (SSOT)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(regSrc, /import \{ APP_VERSION \} from "\.\.\/version"/);
  assert.ok(!/affirmedIn:\s*"[0-9]/.test(arraySrc));
  assert.strictEqual(pkg.version, fs.readFileSync(path.join(root, "src/version.ts"), "utf8").match(/APP_VERSION = "([^"]+)"/)[1]);
});
t("docs/COMPATIBILITY.md exists and carries the honest format labels", () => {
  const doc = fs.readFileSync(path.join(root, "docs/COMPATIBILITY.md"), "utf8");
  for (const fmt of ["IFC", "DXF", "DWG", "BCF", "IDS", "COBie", "PDF", "RVT", ".frag"]) assert.ok(doc.includes(fmt), "COMPATIBILITY.md missing format: " + fmt);
  assert.ok(/DWG[^\n]*export[^\n]*unavailable|unavailable[^\n]*DWG export/i.test(doc)); assert.ok(/APS|Autodesk Platform Services/.test(doc));
});
t("BASELINE §9 references the registry as the machine-readable mirror", () => {
  const baseline = fs.readFileSync(path.join(root, "docs/engineering/BASELINE.md"), "utf8"); assert.ok(baseline.includes("feature-maturity.ts"));
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
