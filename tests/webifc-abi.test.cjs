#!/usr/bin/env node
/**
 * web-ifc ABI smoke test — executes the VENDORED files, not the npm package.
 *
 * The browser loads two halves of web-ifc from different places:
 *   • the JS glue (IfcAPI …) is bundled at build time from node_modules/web-ifc
 *     into the ifc-vendor chunk;
 *   • the WASM binaries are fetched at runtime from /web-ifc/<version>/ (public).
 * If those halves drift, every IFC import dies with an embind error like
 * "BindingError: function StreamMeshes called with 4 arguments, expected 3" —
 * and the dependency-safety suite can't see it, because both halves still match
 * *some* web-ifc release, just not the same one.
 *
 * This suite closes that gap by EXECUTING the exact bytes that are served:
 * it starts a local HTTP server rooted at public/web-ifc (and, when present,
 * the versioned mirror public/web-ifc/<installed-version>/), imports the
 * vendored web-ifc-api.js glue, points SetWasmPath at that server, and runs
 * the same call path @thatopen/fragments' IfcImporter uses:
 *   Init → OpenModel → GetLineIDsWithType → StreamMeshes → CloseModel
 *
 * A passing run proves the served glue + WASM pair is ABI-coherent; a failing
 * run fails CI before a broken pair can ever reach a user's browser.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

// The vendored glue is the BROWSER build (esm module: ./web-ifc-api.js).
// Two things stop it from running under Node:
//   1. emscripten aborts with "not compiled for this environment" when neither
//      window nor importScripts exists;
//   2. even in the web branch it refuses to run when it can DETECT node
//      (`typeof process !== "undefined"` → throw).
// Shim a minimal web runtime AND hide the node process object so the glue takes
// its web path — wasm loading still goes through real fetch() and WebAssembly
// APIs, which Node provides.
const __nodeProcess = globalThis.process;
if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.location = new URL("http://127.0.0.1/");
  globalThis.document = { currentScript: null, baseURI: "http://127.0.0.1/" };
}
if (globalThis.process !== undefined) globalThis.process = undefined;

const root = path.join(__dirname, "..");
let pass = 0;
let fail = 0;

function t(name, fn) {
  return fn().then(
    () => { pass++; console.log(`  ok  ${name}`); },
    (e) => { fail++; console.error(`FAIL  ${name}\n      ${e && e.message ? e.message : e}`); }
  );
}

/** Minimal IFC4 file with one IFCWALL carrying an extruded-solid body. */
const MINIMAL_IFC = [
  "ISO-10303-21;",
  "HEADER;",
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('abi-smoke.ifc','2026-11-03T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  "ENDSEC;",
  "DATA;",
  "#1=IFCPROJECT('0xScRe4drE$QuCcyMkXutA',$,'ABI-Smoke',$,$,$,$,$,#8);",
  "#2=IFCCARTESIANPOINT((0.,0.,0.));",
  "#3=IFCDIRECTION((0.,0.,1.));",
  "#4=IFCDIRECTION((1.,0.,0.));",
  "#5=IFCAXIS2PLACEMENT3D(#2,#3,#4);",
  "#8=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#5,$);",
  "#9=IFCSITE('0xScRe4drE$QuCcyMkXutB',$,'Site',$,$,#5,$,$,.ELEMENT.,$,$,0.,$,$);",
  "#10=IFCBUILDING('0xScRe4drE$QuCcyMkXutC',$,'Building',$,$,#5,$,$,.ELEMENT.,$,$,$);",
  "#11=IFCBUILDINGSTOREY('0xScRe4drE$QuCcyMkXutD',$,'Storey',$,$,#5,$,$,.ELEMENT.,0.);",
  "#12=IFCRELAGGREGATES('0xScRe4drE$QuCcyMkXutE',$,$,$,#1,(#9));",
  "#13=IFCRELAGGREGATES('0xScRe4drE$QuCcyMkXutF',$,$,$,#9,(#10));",
  "#14=IFCRELAGGREGATES('0xScRe4drE$QuCcyMkXutG',$,$,$,#10,(#11));",
  "#15=IFCWALL('0xScRe4drE$QuCcyMkXutH',$,'Wall',$,$,#20,#30,$);",
  "#16=IFCCARTESIANPOINT((0.,0.,0.));",
  "#17=IFCAXIS2PLACEMENT3D(#16,$,$);",
  "#18=IFCRECTANGLEPROFILEDEF(.AREA.,$,#17,5.,0.3);",
  "#19=IFCEXTRUDEDAREASOLID(#18,#21,#3,3.);",
  "#20=IFCLOCALPLACEMENT($,#5);",
  "#21=IFCAXIS2PLACEMENT3D(#16,#3,#4);",
  "#22=IFCSHAPEREPRESENTATION(#8,'Body','SweptSolid',(#19));",
  "#30=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));",
  "ENDSEC;",
  "END-ISO-10303-21;",
  "",
].join("\n");

/** Serve `dir` on 127.0.0.1 with application/wasm MIME so instantiateStreaming works. */
function serveDir(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const file = path.join(dir, decodeURIComponent(url.pathname));
      if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); res.end("not found"); return;
      }
      const ext = path.extname(file).toLowerCase();
      const mime = ext === ".wasm" ? "application/wasm" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

/** Run the fragments-style import path against one vendored web-ifc folder. */
async function exercise(dir, label) {
  const glue = path.join(dir, "web-ifc-api.js");
  if (!fs.existsSync(glue)) throw new Error(`${label}: vendored glue missing at ${glue}`);
  const { srv, port } = await serveDir(dir);
  try {
    const mod = await import(pathToFileURL(glue).href);
    if (typeof mod.IfcAPI !== "function") throw new Error(`${label}: vendored glue exports no IfcAPI`);
    if (typeof mod.IFCWALL !== "number") throw new Error(`${label}: vendored glue exports no IFCWALL constant`);

    const api = new mod.IfcAPI();
    api.SetWasmPath(`http://127.0.0.1:${port}/`, true);
    await api.Init(); // fetches + instantiates the SERVED web-ifc.wasm

    const bytes = new Uint8Array(Buffer.from(MINIMAL_IFC, "utf8"));
    const modelID = api.OpenModel(bytes);

    const vec = api.GetLineIDsWithType(modelID, mod.IFCWALL);
    const ids = [];
    for (let i = 0; i < vec.size(); i++) ids.push(vec.get(i));
    if (ids.length !== 1) throw new Error(`${label}: expected 1 IFCWALL, got ${ids.length}`);

    let streamed = 0;
    let geometries = 0;
    // exact same call as IfcImporter's geometry reader (3-arg JS form)
    api.StreamMeshes(modelID, ids, (mesh) => {
      streamed++;
      // geometries is an embind Vector (has .size()), not a plain Array
      const g = mesh?.geometries;
      geometries += g && typeof g.size === "function" ? g.size() : Array.isArray(g) ? g.length : 0;
    });
    if (streamed < 1) throw new Error(`${label}: StreamMeshes delivered 0 meshes for the wall`);
    if (geometries < 1) throw new Error(`${label}: streamed mesh carries no geometries`);

    if (typeof api.StreamAllMeshes === "function") {
      let all = 0;
      api.StreamAllMeshes(modelID, () => { all++; });
      if (all < 1) throw new Error(`${label}: StreamAllMeshes delivered 0 meshes`);
    }

    api.CloseModel(modelID);
    console.log(`      ${label}: glue+wasm coherent — StreamMeshes streamed ${streamed} mesh(es), ${geometries} geometry group(s)`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

(async () => {
  console.log("web-ifc ABI smoke test (executes the vendored glue + WASM bytes)");

  await t("root mirror  /web-ifc/            is ABI-coherent",
    () => exercise(path.join(root, "public", "web-ifc"), "root mirror"));

  // the versioned mirror is generated at build time; test it whenever it exists
  const versioned = path.join(root, "public", "web-ifc",
    JSON.parse(fs.readFileSync(path.join(root, "node_modules", "web-ifc", "package.json"), "utf8")).version);
  if (fs.existsSync(path.join(versioned, "web-ifc-api.js"))) {
    await t(`versioned    /web-ifc/${path.basename(versioned)}/ is ABI-coherent`,
      () => exercise(versioned, `versioned ${path.basename(versioned)}`));
  } else {
    console.log("  skip versioned mirror (not generated — run scripts/sync-web-ifc-assets.mjs)");
  }

  console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
  __nodeProcess.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); __nodeProcess.exit(1); });
