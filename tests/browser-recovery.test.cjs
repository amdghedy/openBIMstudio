/* Browser recovery retention helper (issue #101 surface). */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "br-"));
const tsc = path.join(__dirname, "../node_modules/typescript/bin/tsc");
const tscCmd = fs.existsSync(tsc)
  ? `"${tsc}" src/modules/projects/browser-recovery.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop`
  : `npx tsc src/modules/projects/browser-recovery.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop`;
execSync(tscCmd, { stdio: "pipe" });
const find = (d, n) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) { const r = find(p, n); if (r) return r; }
    else if (f.name === n) return p;
  }
};
const mod = require(find(out, "browser-recovery.js"));
assert.equal(mod.BROWSER_RECOVERY_KEEP, 5);
assert.deepEqual(mod.selectBrowserRecoveryDeletes([], 5), []);
assert.deepEqual(
  mod.selectBrowserRecoveryDeletes(
    [{ id: 1, createdAt: 10 }, { id: 2, createdAt: 20 }, { id: 3, createdAt: 30 }, { id: 4, createdAt: 40 }, { id: 5, createdAt: 50 }],
    5,
  ),
  [1],
);
assert.deepEqual(
  mod.selectBrowserRecoveryDeletes(
    [{ id: 1, createdAt: 10 }, { id: 2, createdAt: 20 }, { id: 3, createdAt: 30 }],
    5,
  ),
  [],
);
assert.deepEqual(
  mod.selectBrowserRecoveryDeletes(
    [{ id: 9, createdAt: 100 }, { id: 8, createdAt: 90 }, { id: 7, createdAt: 80 }, { id: 6, createdAt: 70 }, { id: 5, createdAt: 60 }, { id: 4, createdAt: 50 }],
    5,
  ),
  [5, 4],
);
// UI + lifecycle wiring still present
const ui = fs.readFileSync(path.join(__dirname, "../src/features/project-recovery.ts"), "utf8");
assert.match(ui, /listBrowserRecoveryCopies/);
assert.match(ui, /File backups in this browser/);
const persist = fs.readFileSync(path.join(__dirname, "../src/modules/projects/persistence.ts"), "utf8");
assert.match(persist, /setupProjectPersistence/);
assert.match(persist, /CRASH_MARKER_KEY/);
console.log("PASS browser-recovery retention + recovery UI wiring");

// Integrity gate: corrupt existing files must never become the newest "good" copy
const u = (str) => new Uint8Array(Buffer.from(str));
assert.equal(mod.backupBytesLookIntact(u('{"a":1}'), u('{"a":1}')), true);
assert.equal(mod.backupBytesLookIntact(u('{"a":[1,2,'), u('{"a":[1,2,')), false, "truncated JSON rejected");
assert.equal(mod.backupBytesLookIntact(new Uint8Array(64), new Uint8Array(64)), false, "zeroed file rejected");
assert.equal(mod.backupBytesLookIntact(new Uint8Array(), new Uint8Array()), false, "empty rejected");
assert.equal(mod.backupBytesLookIntact(u("PK\x03\x04abc"), u("xyz")), true, "zip/other formats pass");
assert.equal(mod.backupBytesLookIntact(u('\ufeff  {"a":1}\n'), u('{"a":1}\n')), true, "BOM + whitespace tolerated");
console.log("browser-recovery integrity checks passed");
