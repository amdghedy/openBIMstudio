const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/modules/pdf-underlay/pdf-underlay.ts"), "utf8");
const csp = fs.readFileSync(path.join(root, "index.html"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
function assert(value, message) { if (!value) throw new Error(message); }
assert(pkg.dependencies["pdfjs-dist"], "pdfjs-dist must be a production dependency");
assert(source.includes('import("pdfjs-dist")'), "PDF.js must be dynamically imported from the bundled dependency");
assert(source.includes('pdfjs-dist/build/pdf.worker.min.mjs'), "PDF.js worker must resolve from the same installed package");
assert(source.includes("pdfJsPromise = null"), "failed PDF.js imports must be retryable");
assert(!source.includes("cdn.jsdelivr.net"), "PDF underlay must not depend on a runtime CDN");
assert(!source.includes("pdfjsLib"), "PDF underlay must not depend on a global UMD script");
assert(!csp.includes("cdn.jsdelivr.net"), "main document CSP must not allow the obsolete PDF.js CDN");
console.log("PDF underlay loader checks passed.");
