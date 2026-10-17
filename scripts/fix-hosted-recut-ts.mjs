import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || process.cwd();
const rel = "src/features/authoring.ts";
const full = path.join(root, rel);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

let src;

try {
  src = fs.readFileSync(full, "utf8");
} catch (e) {
  console.log("SKIP: cannot read " + rel + " (" + (e.code || e.message) + ")");
  process.exit(0);
}

if (src.includes("(p as any).hostAngle = hostAngle")) {
  console.log("NO CHANGE: hosted re-cut TypeScript fix already present.");
  process.exit(0);
}

const before = src;

// Preferred: replace the whole three-line block in one pass.
const blockRe =
  /if\s*\(\s*"hostAngle"\s+in\s+p\s*\)\s*p\.hostAngle\s*=\s*Math\.round\([\s\S]{0,500}?if\s*\(\s*"angle"\s+in\s+p\s*\)\s*p\.angle\s*=\s*p\.hostAngle\s*;/;

const blockRep = `const hostAngle = Math.round(angle * 10000) / 10000;
      if ("hostAngle" in p) (p as any).hostAngle = hostAngle;
      if ("rotation" in p) (p as any).rotation = hostAngle;
      if ("angle" in p) (p as any).angle = hostAngle;`;

if (blockRe.test(src)) {
  src = src.replace(blockRe, blockRep);
  console.log("PATCHED: replaced full hostAngle block with local hostAngle variable.");
} else {
  // Fallback: replace individual lines if formatting differs.
  src = src.replace(
    /if\s*\(\s*"hostAngle"\s+in\s+p\s*\)\s*p\.hostAngle\s*=\s*Math\.round\(\s*angle\s*\*\s*10000\s*\)\s*\/\s*10000\s*;/g,
    `const hostAngle = Math.round(angle * 10000) / 10000;
      if ("hostAngle" in p) (p as any).hostAngle = hostAngle;`
  );

  src = src.replace(
    /if\s*\(\s*"rotation"\s+in\s+p\s*\)\s*p\.rotation\s*=\s*p\.hostAngle\s*;/g,
    `if ("rotation" in p) (p as any).rotation = hostAngle;`
  );

  src = src.replace(
    /if\s*\(\s*"angle"\s+in\s+p\s*\)\s*p\.angle\s*=\s*p\.hostAngle\s*;/g,
    `if ("angle" in p) (p as any).angle = hostAngle;`
  );

  if (src !== before) {
    console.log("PATCHED: replaced individual hostAngle lines.");
  }
}

// Safety: if somehow rotation/angle now use hostAngle but hostAngle is not declared,
// insert a declaration before the first use inside openingsForWall.
if (
  src.includes("(p as any).rotation = hostAngle") &&
  !src.includes("const hostAngle = Math.round(angle * 10000) / 10000;")
) {
  src = src.replace(
    /if\s*\(\s*"rotation"\s+in\s+p\s*\)\s*\(p as any\)\.rotation\s*=\s*hostAngle\s*;/,
    `const hostAngle = Math.round(angle * 10000) / 10000;
      if ("rotation" in p) (p as any).rotation = hostAngle;`
  );
  console.log("PATCHED: inserted missing local hostAngle declaration.");
}

if (src === before) {
  console.log("SKIP: no matching hostAngle pattern found. The file may already be fixed or formatted differently.");
  process.exit(0);
}

fs.copyFileSync(full, full + ".bak-" + stamp);
fs.writeFileSync(full, src, "utf8");

console.log("WROTE: " + rel);