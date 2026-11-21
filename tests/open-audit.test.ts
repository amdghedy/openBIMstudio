/**
 * Open-standards audit — node suite (differentiation item 5).
 *
 * Runs the REAL audit code in Node:
 *   - the real IDS parser (src/features/ids.ts, compiled with tsc) over a
 *     real IDS document, with a minimal DOMParser shim covering exactly
 *     the DOM subset parseIdsXml uses (no external dependency added);
 *   - the real pure audit core (idsCheckToViolation, findings, summaries);
 *   - the real clash core + grouping (via tests/helpers/clash-harness.cjs)
 *     on synthetic boxes.
 * The browser-only orchestration (runIdsValidation over fragments,
 * runClashOffThread, buildBcf21, the panel) is proven by
 * tests/e2e/open-audit.spec.ts instead — it cannot run in Node without
 * faking the fragments API, which would prove nothing.
 *
 * Run: npx tsx tests/open-audit.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ── Minimal DOM shim (the subset parseIdsXml relies on) ─────────────── */

interface ShimNode {
  tagName: string;
  localName: string;
  attrs: Record<string, string>;
  childNodes: ShimNode[];
  text: string;
  parent: ShimNode | null;
  children: ShimNode[];
  textContent: string;
  getAttribute(name: string): string | null;
  getElementsByTagName(name: string): ShimNode[];
}

function makeNode(tagName: string, attrs: Record<string, string>, parent: ShimNode | null): ShimNode {
  const node = {
    tagName,
    localName: tagName.includes(":") ? tagName.split(":").pop()! : tagName,
    attrs,
    childNodes: [] as ShimNode[],
    text: "",
    parent,
  } as ShimNode;
  Object.defineProperty(node, "children", {
    get() { return node.childNodes.filter((c) => c.tagName !== "#text"); },
  });
  Object.defineProperty(node, "textContent", {
    get(): string {
      if (node.tagName === "#text") return node.text;
      return node.childNodes.map((c) => c.textContent).join("");
    },
  });
  node.getAttribute = (name: string) => node.attrs[name] ?? null;
  node.getElementsByTagName = (name: string): ShimNode[] => {
    const out: ShimNode[] = [];
    const walk = (n: ShimNode) => {
      for (const c of n.childNodes) {
        if (c.tagName !== "#text" && (name === "*" || c.tagName === name || c.localName === name)) out.push(c);
        walk(c);
      }
    };
    walk(node);
    return out;
  };
  return node;
}

function parseXmlShim(xml: string): ShimNode {
  const doc = makeNode("#document", {}, null);
  const stack: ShimNode[] = [doc];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const n = xml.length;
  const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (_m, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    if (e[1] === "x" || e[1] === "X") return String.fromCodePoint(parseInt(e.slice(2), 16));
    return String.fromCodePoint(parseInt(e.slice(1), 10));
  });
  while (i < n) {
    if (xml[i] === "<") {
      if (xml.startsWith("<!--", i)) { i = xml.indexOf("-->", i) + 3; continue; }
      if (xml.startsWith("<?", i)) { i = xml.indexOf("?>", i) + 2; continue; }
      if (xml.startsWith("</", i)) {
        const end = xml.indexOf(">", i);
        const name = xml.slice(i + 2, end).trim();
        if (top().tagName !== name && top().localName !== name) throw new Error(`mismatched close ${name}`);
        stack.pop();
        i = end + 1;
        continue;
      }
      const end = xml.indexOf(">", i);
      let inner = xml.slice(i + 1, end);
      const selfClose = inner.endsWith("/");
      if (selfClose) inner = inner.slice(0, -1);
      const m = /^([^\s/]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*$/.exec(inner);
      if (!m) throw new Error(`bad tag at ${i}: ${inner}`);
      const attrs: Record<string, string> = {};
      const attrRe = /([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g;
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(m[2]))) attrs[am[1]] = decode(am[2].slice(1, -1));
      const el = makeNode(m[1], attrs, top());
      top().childNodes.push(el);
      if (!selfClose) stack.push(el);
      i = end + 1;
    } else {
      const next = xml.indexOf("<", i);
      const text = decode(xml.slice(i, next === -1 ? n : next));
      if (text.trim()) {
        const t = makeNode("#text", {}, top());
        t.text = text;
        top().childNodes.push(t);
      }
      i = next === -1 ? n : next;
    }
  }
  if (stack.length !== 1) throw new Error("unclosed tags");
  return doc;
}

class ShimDOMParser {
  parseFromString(xml: string, _type: string) {
    const doc = parseXmlShim(xml);
    const root = doc.childNodes.find((c) => c.tagName !== "#text")!;
    return {
      documentElement: root,
      getElementsByTagName: (name: string) => doc.getElementsByTagName(name),
    };
  }
}
(globalThis as any).DOMParser = ShimDOMParser;

/* ── Load the real modules (transpile-only, as the repo's own suites do) ──
 * ids.ts imports ../core/context (the whole app context) — typechecking
 * it standalone pulls in the entire app graph and its pre-existing
 * errors, so, like tests/ai-native-modeling.test.cjs, we transpile
 * (no typecheck) and stub the context import. The repo's own
 * `tsc --noEmit` is the typecheck gate, run separately. */
import ts from "typescript";

const loadTs = (file: string) => {
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const m = new Module(file);
  m.filename = file;
  m.paths = (Module as any)._nodeModulePaths(path.dirname(file));
  (m as any)._compile(js, file);
  return m.exports;
};
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request === "../core/context") return { ctx: { fragments: { list: new Map() }, features: {} } };
  return originalLoad.call(this, request, parent, isMain);
};
const ids = loadTs(path.join(ROOT, "src/features/ids.ts"));
const core = loadTs(path.join(ROOT, "src/modules/audit/open-audit-core.ts"));
const harness = require("./helpers/clash-harness.cjs");

/* ── Fixture: the IDS the e2e uses (buildingSMART IDS 1.0 shape:
 * facet names live in <name><simpleValue>…</simpleValue></name> and
 * cardinality is an attribute — that is what ids.ts parses) ──────── */

const AUDIT_IDS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Audit demo rules</title><version>1</version><author>openBIMstudio audit</author></info>
  <specifications>
    <specification name="Walls are named" identifier="wall-named" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IfcWall</simpleValue></name></entity></applicability>
      <requirements><attribute cardinality="required"><name><simpleValue>Name</simpleValue></name></attribute></requirements>
    </specification>
    <specification name="Walls carry a description" identifier="wall-desc" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IfcWall</simpleValue></name></entity></applicability>
      <requirements><attribute cardinality="required"><name><simpleValue>Description</simpleValue></name></attribute></requirements>
    </specification>
    <specification name="Walls carry a fire rating" identifier="wall-fire" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IfcWall</simpleValue></name></entity></applicability>
      <requirements><property cardinality="required"><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><name><simpleValue>FireRating</simpleValue></name></property></requirements>
    </specification>
  </specifications>
</ids>`;

/* ── Tests ────────────────────────────────────────────────────────────── */

let pass = 0, fail = 0;
const results: string[] = [];
const t = async (n: string, f: () => void | Promise<void>) => {
  try { await f(); pass++; results.push("  PASS " + n); }
  catch (e: any) { fail++; results.push("  FAIL " + n + ": " + e.message); }
};

async function main() {
  const doc = ids.parseIdsXml(AUDIT_IDS_XML);

  await t("parseIdsXml reads the real audit IDS (title, version, 3 specs)", () => {
    assert.strictEqual(doc.title, "Audit demo rules");
    assert.strictEqual(doc.version, "1");
    assert.strictEqual(doc.specifications.length, 3);
    assert.deepStrictEqual(doc.specifications.map((s: any) => s.id), ["wall-named", "wall-desc", "wall-fire"]);
    assert.strictEqual(doc.specifications[0].applicability[0].type, "entity");
    assert.strictEqual(doc.specifications[0].requirements[0].type, "attribute");
    assert.strictEqual(doc.specifications[0].requirements[0].name, "Name");
    assert.strictEqual(doc.specifications[2].requirements[0].type, "property");
    assert.strictEqual(doc.specifications[2].requirements[0].propertySet, "Pset_WallCommon");
  });

  await t("parseIdsXml rejects malformed XML", () => {
    assert.throws(() => ids.parseIdsXml("<ids><specifications>"), /mismatched|unclosed/);
  });

  const failCheck = {
    specificationId: "wall-desc", specificationName: "Walls carry a description",
    modelId: "wall.ifc", localId: 50, elementName: "Wall 1",
    facet: "attribute Description", severity: "fail",
    message: "Expected attribute Description", actual: undefined,
  };
  const warnCheck = { ...failCheck, severity: "warning", message: "Suspicious value" };
  const passCheck = { ...failCheck, severity: "pass", message: "Attribute present" };
  const unsupportedCheck = { ...failCheck, severity: "unsupported", message: "Cannot verify" };

  await t("idsCheckToViolation: fail becomes an error BCF violation with the rule identity", () => {
    const v = core.idsCheckToViolation(failCheck, doc);
    assert.ok(v);
    assert.strictEqual(v.ruleId, "wall-desc");
    assert.strictEqual(v.ruleName, "Walls carry a description");
    assert.strictEqual(v.standard, "IDS");
    assert.strictEqual(v.jurisdiction, "Audit demo rules v1");
    assert.strictEqual(v.severity, "error");
    assert.strictEqual(v.elementId, 50);
    assert.strictEqual(v.elementName, "Wall 1");
    assert.strictEqual(v.category, "attribute Description");
    assert.strictEqual(v.modelId, "wall.ifc");
  });

  await t("idsCheckToViolation: warning/pass/unsupported become no topic (unevaluated checks are not findings)", () => {
    // The engine's only warning is "cannot read properties — check
    // skipped": a BCF topic for it would claim a violation that was
    // never established.
    assert.strictEqual(core.idsCheckToViolation(warnCheck, doc), null);
    assert.strictEqual(core.idsCheckToViolation(passCheck, doc), null);
    assert.strictEqual(core.idsCheckToViolation(unsupportedCheck, doc), null);
  });

  await t("idsReportToViolations keeps only failed checks", () => {
    const report = { document: doc, results: [failCheck, warnCheck, passCheck, unsupportedCheck] };
    const vs = core.idsReportToViolations(report);
    assert.strictEqual(vs.length, 1);
    assert.strictEqual(vs[0].severity, "error");
  });

  const clashA = {
    kind: "intersect", method: "hard-triangle", precision: "exact",
    a: { modelId: "m", localId: 1, name: "Wall A", cat: "IfcWall" },
    b: { modelId: "m", localId: 2, name: "Wall B", cat: "IfcWall" },
  };
  const clashB = {
    kind: "touching", method: "hard-triangle", precision: "exact",
    a: { modelId: "m", localId: 1, name: "Wall A", cat: "IfcWall" },
    b: { modelId: "m", localId: 3, name: "Slab", cat: "IfcSlab" },
  };

  await t("buildAuditFindings: IDS errors first, then one finding per clash group", () => {
    const report = { document: doc, results: [failCheck, warnCheck] };
    const findings = core.buildAuditFindings(report, [clashA, clashB], [{ members: [clashA, clashB] }]);
    assert.strictEqual(findings.length, 3);
    assert.strictEqual(findings[0].source, "ids");
    assert.strictEqual(findings[0].severity, "error");
    assert.strictEqual(findings[1].severity, "warning");
    assert.strictEqual(findings[2].source, "clash");
    assert.match(findings[2].title, /INTERSECT/);
    assert.match(findings[2].detail, /2 clashes/);
  });

  await t("buildAuditFindings never drops an ungrouped clash", () => {
    const findings = core.buildAuditFindings(null, [clashA], []);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].source, "clash");
  });

  await t("summaries count passed/failed/unverifiable and clash kinds honestly", () => {
    const idsSummary = core.summarizeIdsSection({
      document: doc, elementsChecked: 4,
      summary: [
        { specificationId: "a", specificationName: "a", total: 2, passed: 2, failed: 0, unsupported: 0 },
        { specificationId: "b", specificationName: "b", total: 2, passed: 0, failed: 1, unsupported: 1 },
      ],
    });
    assert.strictEqual(idsSummary.passed, 2);
    assert.strictEqual(idsSummary.failed, 1);
    assert.strictEqual(idsSummary.unsupported, 1);
    const clashSummary = core.summarizeClashSection([clashA, clashB], [{ clashes: [clashA, clashB] }], 2);
    assert.strictEqual(clashSummary.found, 2);
    assert.strictEqual(clashSummary.groups, 1);
    assert.deepStrictEqual(clashSummary.byKind, { intersect: 1, touching: 1 });
    assert.strictEqual(clashSummary.modelsChecked, 2);
  });

  await t("real clash core: two overlapping boxes clash, separated boxes do not", async () => {
    const { core: clashCore, THREE } = harness;
    const core = clashCore();
    // 12 triangles of an axis-aligned box (same winding as clash-engine.test.cjs).
    const boxTris = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
      const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
      const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
      return f.map(([a, b, c]) => Float32Array.from([...v[a], ...v[b], ...v[c]]));
    };
    const item = (localId: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => ({
      modelId: "m", localId, name: "Wall " + localId, category: "IfcWall",
      box: new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)),
      tris: boxTris(x0, y0, z0, x1, y1, z1),
    });
    const run = (items: any[]) => core.runClashCore(items, {
      rules: { ...core.DEFAULT_CLASH_RULES, tolerance: 0, clearance: 0 },
      method: "hard-triangle",
      groups: [items.map((_, i) => i)],
      selfPairs: true,
    });
    const overlapping = await run([item(1, 0, 0, 0, 4, 0.2, 3), item(2, 2, 0, 0, 6, 0.2, 3)]);
    assert.strictEqual(overlapping.length, 1);
    assert.strictEqual(overlapping[0].kind, "intersect");
    const separated = await run([item(1, 0, 0, 0, 4, 0.2, 3), item(2, 10, 0, 0, 14, 0.2, 3)]);
    assert.strictEqual(separated.length, 0);
  });

  await t("real grouping: clashes sharing an element form one group", () => {
    const { grouping } = harness;
    const groups = grouping().groupClashes([clashA, clashB]);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].members.length, 2);
  });

  for (const r of results) console.log(r);
  console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
