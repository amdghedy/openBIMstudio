/* IFC MEP connectivity reconstruction — port-graph clusters from STEP text.
 *
 * Synthetic IFC fixtures (duct/pipe segments + IfcDistributionPort +
 * IfcRelNests + IfcRelConnectsPorts) exercise reconstructFromStepText:
 * realistic chains round-trip to one cluster, dangling/ownerless ports
 * become diagnostics, and system suggestions stay per-domain defaults.
 *
 * Run: `node tests/mep-ifc-reconstruction.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "mifr-"));
execSync(`npx tsc src/modules/mep/ifc-reconstruction.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict --ignoreDeprecations 5.0`, { stdio: "inherit" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const m = require(find(out, "ifc-reconstruction.js"));
const sem = require(find(out, "semantic-model.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

let guidN = 0;
const guid = () => {
  guidN++;
  // 22-char GlobalId candidate from the IFC base64 alphabet.
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  let s = "";
  let v = guidN;
  for (let i = 0; i < 22; i++) { s += alphabet[v % 64]; v = Math.floor(v / 64) + 1; }
  return "'" + s + "'";
};

function ifc(entities) {
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('mep-fixture.ifc','2026-11-20T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
    ...entities,
    "ENDSEC;",
    "END-ISO-10303-21;",
  ].join("\n");
}

// Element: #id=IFCDUCTSEGMENT('guid',$,'Name',$,$,$,$,$);
const el = (id, cls, name) => `#${id}=${cls}(${guid()},$,'${name}',$,$,$,$,$);`;
const port = (id, name) => `#${id}=IFCDISTRIBUTIONPORT(${guid()},$,'${name}',$,$,$,$,$,$);`;
// Nest ports under their owner: #id=IFCRELNESTS('guid',$,$,$,#owner,(#p1,#p2));
const nest = (id, owner, ports) => `#${id}=IFCRELNESTS(${guid()},$,$,$,#${owner},(${ports.map((p) => "#" + p).join(",")}));`;
// Connect two ports: #id=IFCRELCONNECTSPORTS('guid',$,$,$,#a,#b);
const conn = (id, a, b) => `#${id}=IFCRELCONNECTSPORTS(${guid()},$,$,$,#${a},#${b});`;

/** Two duct segments joined port-to-port (each segment owns 2 ports). */
function twoDucts() {
  return ifc([
    el(10, "IFCDUCTSEGMENT", "Duct A"), el(20, "IFCDUCTSEGMENT", "Duct B"),
    port(11, "A-in"), port(12, "A-out"), port(21, "B-in"), port(22, "B-out"),
    nest(30, 10, [11, 12]), nest(31, 20, [21, 22]),
    conn(40, 12, 21),
  ]);
}

t("semantic model records connects-ports and nests as typed relationships", () => {
  const model = sem.buildSemanticModel(twoDucts());
  const kinds = model.relationships.map((r) => r.kind);
  assert.ok(kinds.includes("connects-ports"), "connects-ports recorded: " + kinds.join(","));
  assert.ok(kinds.includes("nests"), "nests recorded");
  const cp = model.relationships.find((r) => r.kind === "connects-ports");
  assert.strictEqual(cp.relating, 12);
  assert.deepStrictEqual(cp.related, [21]);
});

t("two duct segments joined via ports reconstruct as ONE air cluster", () => {
  const r = m.reconstructFromStepText(twoDucts());
  assert.strictEqual(r.clusters.length, 1);
  const c = r.clusters[0];
  assert.strictEqual(c.id, "ifc-mep-1");
  assert.deepStrictEqual(c.members.map((x) => x.expressId), [10, 20]);
  assert.deepStrictEqual(c.members.map((x) => x.cls), ["IFCDUCTSEGMENT", "IFCDUCTSEGMENT"]);
  assert.strictEqual(c.domain, "air");
  assert.strictEqual(c.suggestedSystem, "supply-air");
  assert.ok(c.suggestedSystemBasis && c.suggestedSystemBasis.includes("default-for-domain"));
  assert.strictEqual(r.unconnected.length, 0);
  assert.strictEqual(r.counts.mepElements, 2);
  assert.strictEqual(r.counts.ports, 4);
  assert.strictEqual(r.counts.portConnections, 1);
  assert.strictEqual(r.counts.reconstructedEdges, 1);
  assert.deepStrictEqual(r.diagnostics, []);
});

t("realistic chain (duct — fitting — duct — terminal) round-trips to one cluster", () => {
  const text = ifc([
    el(10, "IFCDUCTSEGMENT", "Duct A"), el(20, "IFCDUCTFITTING", "Elbow"),
    el(30, "IFCDUCTSEGMENT", "Duct B"), el(40, "IFCAIRTERMINAL", "Diffuser"),
    port(11, "A-in"), port(12, "A-out"),
    port(21, "E-in"), port(22, "E-out"),
    port(31, "B-in"), port(32, "B-out"),
    port(41, "T-in"),
    nest(50, 10, [11, 12]), nest(51, 20, [21, 22]), nest(52, 30, [31, 32]), nest(53, 40, [41]),
    conn(60, 12, 21), conn(61, 22, 31), conn(62, 32, 41),
  ]);
  const r = m.reconstructFromStepText(text);
  assert.strictEqual(r.clusters.length, 1);
  assert.deepStrictEqual(r.clusters[0].members.map((x) => x.expressId), [10, 20, 30, 40]);
  assert.strictEqual(r.clusters[0].domain, "air");
  assert.strictEqual(r.counts.reconstructedEdges, 3);
  assert.deepStrictEqual(r.diagnostics, []);
});

t("two disconnected runs stay two clusters; a port-less duct is unconnected", () => {
  const text = ifc([
    el(10, "IFCDUCTSEGMENT", "Duct A"), el(20, "IFCDUCTSEGMENT", "Duct B"),
    el(30, "IFCDUCTSEGMENT", "Lonely"),
    port(11, "A-in"), port(12, "A-out"), port(21, "B-in"), port(22, "B-out"),
    nest(31, 10, [11, 12]), nest(32, 20, [21, 22]),
    conn(40, 12, 21),
  ]);
  const r = m.reconstructFromStepText(text);
  assert.strictEqual(r.clusters.length, 1);
  assert.strictEqual(r.unconnected.length, 1);
  assert.strictEqual(r.unconnected[0].expressId, 30);
  assert.strictEqual(r.unconnected[0].hasPorts, false);
  assert.ok(r.diagnostics.some((d) => d.includes("no IfcDistributionPort")));
});

t("a connected port with no owning element is a diagnostic, not an edge", () => {
  const text = ifc([
    el(10, "IFCDUCTSEGMENT", "Duct A"),
    port(11, "A-in"), port(12, "A-out"), port(99, "Orphan"),
    nest(30, 10, [11, 12]),
    conn(40, 12, 99),
  ]);
  const r = m.reconstructFromStepText(text);
  assert.strictEqual(r.clusters.length, 0);
  assert.strictEqual(r.counts.reconstructedEdges, 0);
  assert.ok(r.diagnostics.some((d) => d.includes("#99") && d.includes("no owning element")));
});

t("a connection to a missing port is a diagnostic, not a crash", () => {
  const text = ifc([
    el(10, "IFCDUCTSEGMENT", "Duct A"),
    port(11, "A-in"), port(12, "A-out"),
    nest(30, 10, [11, 12]),
    conn(40, 12, 999),
  ]);
  const r = m.reconstructFromStepText(text);
  assert.strictEqual(r.clusters.length, 0);
  assert.ok(r.diagnostics.some((d) => d.includes("#999")));
});

t("pipe run reconstructs as a water cluster with the domestic-cold default", () => {
  const text = ifc([
    el(10, "IFCPIPESEGMENT", "Pipe A"), el(20, "IFCPIPESEGMENT", "Pipe B"),
    port(11, "A-in"), port(12, "A-out"), port(21, "B-in"), port(22, "B-out"),
    nest(30, 10, [11, 12]), nest(31, 20, [21, 22]),
    conn(40, 12, 21),
  ]);
  const r = m.reconstructFromStepText(text);
  assert.strictEqual(r.clusters.length, 1);
  assert.strictEqual(r.clusters[0].domain, "water");
  assert.strictEqual(r.clusters[0].suggestedSystem, "domestic-cold");
});

t("a duct joined to a pipe is a mixed-domain cluster with no system suggestion", () => {
  const text = ifc([
    el(10, "IFCDUCTSEGMENT", "Duct A"), el(20, "IFCPIPESEGMENT", "Pipe B"),
    port(11, "A-in"), port(12, "A-out"), port(21, "B-in"), port(22, "B-out"),
    nest(30, 10, [11, 12]), nest(31, 20, [21, 22]),
    conn(40, 12, 21),
  ]);
  const r = m.reconstructFromStepText(text);
  assert.strictEqual(r.clusters.length, 1);
  assert.strictEqual(r.clusters[0].domain, "mixed");
  assert.strictEqual(r.clusters[0].suggestedSystem, null);
  assert.strictEqual(r.clusters[0].suggestedSystemBasis, null);
  assert.ok(r.clusters[0].diagnostics.some((d) => d.includes("mixes domains")));
});

t("self-connection through two ports of one element is ignored with a diagnostic", () => {
  const text = ifc([
    el(10, "IFCDUCTSEGMENT", "Duct A"),
    port(11, "A-in"), port(12, "A-out"),
    nest(30, 10, [11, 12]),
    conn(40, 11, 12),
  ]);
  const r = m.reconstructFromStepText(text);
  assert.strictEqual(r.clusters.length, 0);
  assert.strictEqual(r.counts.reconstructedEdges, 0);
  assert.ok(r.diagnostics.some((d) => d.includes("itself")));
});

t("a file with no ports at all reconstructs nothing and says so", () => {
  const text = ifc([el(10, "IFCDUCTSEGMENT", "Duct A"), el(20, "IFCDUCTSEGMENT", "Duct B")]);
  const r = m.reconstructFromStepText(text);
  assert.strictEqual(r.clusters.length, 0);
  assert.strictEqual(r.unconnected.length, 2);
  assert.strictEqual(r.counts.ports, 0);
  assert.ok(r.diagnostics.some((d) => d.includes("no IfcDistributionPort")));
});

console.log(`\nmep-ifc-reconstruction: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
