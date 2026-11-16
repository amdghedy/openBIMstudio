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
