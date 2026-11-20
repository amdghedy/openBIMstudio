const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  const { BACKUP_KEEP, listBackups, writeJsonWithBackup } = await import(
    pathToFileURL(path.join(__dirname, "..", "server", "backup.mjs"))
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-"));
  const file = path.join(dir, "projects.json");

  writeJsonWithBackup(file, { version: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1 });
  assert.strictEqual(listBackups(file).length, 0, "first save has no prior state to back up");

  for (let version = 2; version <= 8; version++) {
    writeJsonWithBackup(file, { version });
  }
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 8 });
  const backups = listBackups(file);
  assert.strictEqual(backups.length, BACKUP_KEEP, "retention must keep exactly five backups");
  for (const backup of backups) {
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(backup, "utf8")), expectVersion(backup, backups, file));
  }

  const tempFiles = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
  assert.deepStrictEqual(tempFiles, [], "atomic writes must not leave temp files");
  console.log("=== server backup: all assertions passed ===");

  function expectVersion(backup, ordered, target) {
    // Each backup is the file state immediately before one of the last five writes.
    const index = ordered.indexOf(backup);
    return { version: index + 3 };
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

// ── Integrity / recovery (#91) ──
(async () => {
  const m = await import(pathToFileURL(path.join(__dirname, "..", "server", "backup.mjs")));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-int-"));
  const f = path.join(d, "projects.json");
  for (let v = 1; v <= 4; v++) m.writeJsonWithBackup(f, { v });
  // Interrupted write: live file truncated mid-JSON
  fs.writeFileSync(f, '{"v": 4, "data": [1,2,');
  let r = m.readJsonWithRecovery(f, {});
  assert.strictEqual(r.source, "backup", "truncated live file → newest valid backup");
  assert.deepStrictEqual(r.value, { v: 3 });
  assert.ok(fs.readdirSync(d).some((n) => n.endsWith(".corrupt")), "corrupt original quarantined, not deleted");
  assert.ok(!fs.existsSync(f), "corrupt live file moved aside");
  // Corrupt live file must never evict last known-good backups, however many saves follow
  m.writeJsonWithBackup(f, { v: 10 });
  fs.writeFileSync(f, "\u0000\u0000garbage");
  for (let i = 0; i < 8; i++) { fs.writeFileSync(f, "{bad" + i); m.writeJsonWithBackup(f, { v: 20 + i }); }
  const valid = m.listBackups(f).filter((b) => m.isValidJsonFile(b));
  assert.strictEqual(valid.length, m.listBackups(f).length, "every .bak is valid JSON");
  assert.ok(valid.length >= 1 && valid.length <= m.BACKUP_KEEP);
  assert.ok(fs.readdirSync(d).filter((n) => n.endsWith(".corrupt")).length <= m.CORRUPT_KEEP, "corrupt quarantine is bounded");
  // Corrupt backups are skipped on recovery
  const bs = m.listBackups(f); fs.writeFileSync(bs[bs.length - 1], "{broken");
  fs.writeFileSync(f, "x");
  r = m.readJsonWithRecovery(f, { empty: true });
  assert.strictEqual(r.source, "backup"); assert.ok(r.value && typeof r.value.v === "number", "falls past the corrupt newest backup");
  // Nothing valid anywhere → fallback, still quarantined
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-none-")); const g = path.join(d2, "p.json");
  fs.writeFileSync(g, "nope");
  r = m.readJsonWithRecovery(g, { empty: true });
  assert.strictEqual(r.source, "fallback"); assert.deepStrictEqual(r.value, { empty: true });
  assert.strictEqual(fs.readdirSync(d2).filter((n) => n.endsWith(".corrupt")).length, 1);
  // Missing file → fallback with no quarantine
  r = m.readJsonWithRecovery(path.join(d2, "absent.json"), 7); assert.strictEqual(r.value, 7);
  console.log("=== server backup integrity: all assertions passed ===");
})().catch((e) => { console.error(e); process.exit(1); });
