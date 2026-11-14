/* Live IFC link: the decision logic (never overwrite an externally changed file, write only when edits changed) and
 * that the IFC writer the link uses produces a readable IFC4 with the edited element. */
const fs = require("fs"), path = require("path"), assert = require("assert");
const { execSync } = require("child_process");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(root, ".live-link-test-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
const cleanup = () => fs.rmSync(out, { recursive: true, force: true });
try {
  execSync(`npx tsc src/modules/export/live-link-core.ts src/modules/export/native-twin-ifc.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --lib es2020,dom`, { cwd: root, stdio: "pipe" });
  const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
  const C = require(find(out, "live-link-core.js")), W = require(find(out, "native-twin-ifc.js"));
  let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
  ok(C.hashString("a") !== C.hashString("b") && C.hashString("abc") === C.hashString("abc"), "hash is stable and sensitive");
  ok(C.detectExternalChange(100, 100) === false && C.detectExternalChange(100, 101) === true, "external change = modified time moved");
  const base = { externalChange: false, sig: "s1", lastWrittenSig: null, hasEdits: true };
  ok(C.nextLinkAction(base) === "write", "first edits are written");
  ok(C.nextLinkAction({ ...base, lastWrittenSig: "s1" }) === "idle", "unchanged edits are not rewritten");
  ok(C.nextLinkAction({ ...base, lastWrittenSig: "s0" }) === "write", "changed edits are written");
  ok(C.nextLinkAction({ ...base, hasEdits: false }) === "idle", "no edits, nothing to write");
  ok(C.nextLinkAction({ ...base, externalChange: true }) === "conflict", "an outside change is a conflict, never a silent overwrite");
  ok(C.nextLinkAction({ ...base, externalChange: true, force: true }) === "conflict", "even a forced write waits until the conflict is resolved");
  ok(C.nextLinkAction({ ...base, lastWrittenSig: "s1", force: true }) === "write", "force writes unchanged edits");
  const ifc = W.writeFederatedNativeTwinIfc([{ name: "Wall A", nativeEntity: "IFCWALL", modelId: "m", position: [1, 2, 3], quaternion: [0, 0, 0, 1], geometry: { positions: [0,0,0, 1,0,0, 0,1,0, 0,0,1, 1,0,1, 0,1,1] } }], "Live");
  ok(ifc.startsWith("ISO-10303-21;") && ifc.includes("END-ISO-10303-21;") && ifc.includes("FILE_SCHEMA(('IFC4'))"), "valid IFC4 envelope");
  ok(/IFCBUILDINGELEMENTPROXY\(/.test(ifc) && ifc.includes("Wall A"), "the edited element is in the file (the writer emits building-element proxies)");
  const faceSet = /IFCTRIANGULATEDFACESET\(#\d+,\$,\.F\.,\(([^;]*)\),\$\);/.exec(ifc);
  ok(faceSet && /^\(\d+,\d+,\d+\)(,\(\d+,\d+,\d+\))*$/.test(faceSet[1]), "CoordIndex is a list of index triples (no extra nesting): " + (faceSet && faceSet[1]));
  console.log(`live-ifc-link: ${n} assertions passed`);
  cleanup();
} catch (e) { cleanup(); console.error(String(e.stdout || e)); process.exit(1); }
