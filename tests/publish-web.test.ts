/**
 * Publish-as-web-page — node suite (differentiation item 6).
 *
 * Runs the REAL pure publish core in Node (transpile-only, as the repo's
 * own suites do) and proves the published bundle shape with a real JSZip
 * round-trip: rewritten index.html + model.obsproj bytes + viewer assets.
 * The browser orchestration (fetching the viewer files from the live app,
 * the download, the boot hook opening the model) is proven by
 * tests/e2e/publish-web.spec.ts instead — it cannot run in Node without
 * faking the store and the app server, which would prove nothing.
 *
 * Run: npx tsx tests/publish-web.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JSZip = require("jszip");

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
const core = loadTs(path.join(ROOT, "src/modules/publish/publish-web-core.ts"));

/* A realistic built dist/index.html (same shapes vite emits). */
const BUILT_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <link rel="icon" type="image/png" href="/icons/favicon-32.png">
    <link rel="manifest" href="/app.webmanifest">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' https://api.anthropic.com https://ipapi.co http://localhost:*">
    <meta property="og:title" content="OpenBIMStudio — open, local-first BIM workspace in your browser">
    <title>OpenBIMStudio — open, local-first BIM workspace in your browser</title>
    <link rel="stylesheet" href="/assets/index-abc123.css">
    <link rel="stylesheet" href="/css/obs-ribbon-arch.css">
    <script defer src="/js/obs-family-editor.js"></script>
  </head>
  <body>
    <div id="app"></div>
    <script src="/webgpu-compat.js"></script>
    <script type="module" src="/assets/index-abc123.js"></script>
  </body>
</html>`;

let pass = 0, fail = 0;
const results: string[] = [];
const t = async (n: string, f: () => void | Promise<void>) => {
  try { await f(); pass++; results.push("  PASS " + n); }
  catch (e: any) { fail++; results.push("  FAIL " + n + ": " + e.message); }
};

async function main() {
  await t("rewrite: root-absolute asset refs become relative", () => {
    const out = core.rewritePublishedIndexHtml(BUILT_HTML, { model: "model.obsproj", name: "Demo House" });
    assert.ok(out.includes('href="./icons/favicon-32.png"'), "icon not relativised");
    assert.ok(out.includes('href="./app.webmanifest"'), "manifest not relativised");
    assert.ok(out.includes('href="./assets/index-abc123.css"'), "css not relativised");
    assert.ok(out.includes('src="./assets/index-abc123.js"'), "entry js not relativised");
    assert.ok(out.includes('src="./webgpu-compat.js"'), "compat script not relativised");
    assert.ok(!out.includes('href="/'), "an absolute href survived");
    assert.ok(!out.includes('src="/'), "an absolute src survived");
  });

  await t("rewrite: external URLs and the CSP are untouched", () => {
    const out = core.rewritePublishedIndexHtml(BUILT_HTML, { model: "model.obsproj", name: "Demo House" });
    assert.ok(out.includes("https://api.anthropic.com"), "CSP external URL rewritten");
    assert.ok(out.includes("https://ipapi.co"), "CSP ipapi URL rewritten");
    assert.ok(out.includes("connect-src 'self'"), "CSP damaged");
  });

  await t("rewrite: title becomes the project name and the marker lands before the module script", () => {
    const out = core.rewritePublishedIndexHtml(BUILT_HTML, { model: "model.obsproj", name: "Demo House" });
    assert.ok(out.includes("<title>Demo House — OpenBIMStudio</title>"), "title not set");
    const markerAt = out.indexOf("window.__OBS_PUBLISHED__");
    const moduleAt = out.indexOf('type="module"');
    assert.ok(markerAt !== -1 && markerAt < moduleAt, "marker is not before the module script");
    assert.deepStrictEqual(core.readPublishedMarker(out), { model: "model.obsproj", name: "Demo House" });
  });

  await t("rewrite: a project name containing markup cannot break out of the marker script", () => {
    const evil = 'x</script><script>alert(1)</script>';
    const out = core.rewritePublishedIndexHtml(BUILT_HTML, { model: "model.obsproj", name: evil });
    assert.ok(!out.includes("</script><script>alert"), "marker script breakout");
    assert.ok(out.includes("&lt;/script&gt;"), "title not HTML-escaped");
    assert.strictEqual(core.readPublishedMarker(out)?.name, evil);
  });

  await t("rewrite: no module script is a clear error, not a silently unmarked page", () => {
    assert.throws(
      () => core.rewritePublishedIndexHtml("<html><head><title>t</title></head></html>", { model: "model.obsproj", name: "x" }),
      /no module script/,
    );
  });

  await t("filterPublishableFiles: sw.js, asset-list.json and maps are excluded, the rest sorted", () => {
    const files = [
      { path: "assets/index-abc.js", bytes: 10 },
      { path: "sw.js", bytes: 10 },
      { path: "asset-list.json", bytes: 10 },
      { path: "assets/index-abc.js.map", bytes: 10 },
      { path: "web-ifc/0.0.77/web-ifc.wasm", bytes: 10 },
      { path: "index.html", bytes: 10 },
    ];
    assert.deepStrictEqual(
      core.filterPublishableFiles(files).map((f: any) => f.path),
      ["assets/index-abc.js", "index.html", "web-ifc/0.0.77/web-ifc.wasm"],
    );
  });

  await t("slugs: names become safe zip names", () => {
    assert.strictEqual(core.slugifyName("Demo House!"), "demo-house");
    assert.strictEqual(core.slugifyName("  "), "model");
    assert.strictEqual(core.publishedZipName("My Model v2"), "my-model-v2-web.zip");
  });

  await t("bundle shape: a real JSZip round-trip holds the rewritten page, the model and the assets", async () => {
    const model = Buffer.from(JSON.stringify({ version: 1, name: "Demo House" }));
    const rewritten = core.rewritePublishedIndexHtml(BUILT_HTML, { model: "model.obsproj", name: "Demo House" });
    const zip = new JSZip();
    zip.file("index.html", rewritten);
    zip.file("model.obsproj", model);
    zip.file("assets/index-abc123.js", "console.log('viewer');");
    zip.file("web-ifc/0.0.77/web-ifc.wasm", Buffer.from([0, 1, 2, 3]));
    const blob = await zip.generateAsync({ type: "nodebuffer" });
    const read = await JSZip.loadAsync(blob);
    assert.deepStrictEqual(
      Object.values(read.files).filter((f: any) => !f.dir).map((f: any) => f.name).sort(),
      [
        "assets/index-abc123.js",
        "index.html",
        "model.obsproj",
        "web-ifc/0.0.77/web-ifc.wasm",
      ],
    );
    assert.strictEqual(await read.file("index.html")!.async("string"), rewritten);
    assert.deepStrictEqual(await read.file("model.obsproj")!.async("nodebuffer"), model);
    assert.deepStrictEqual(core.readPublishedMarker(await read.file("index.html")!.async("string")), { model: "model.obsproj", name: "Demo House" });
  });

  for (const r of results) console.log(r);
  console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
