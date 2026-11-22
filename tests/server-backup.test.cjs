/* Server backup-on-load tests — issue #91.
 *
 * Unit coverage for `server/backup.mjs`: rotation, timestamped
 * collision-safe names, duplicate timestamps, read-back verification,
 * corrupt backups, interrupted writes, restore/rollback, and the
 * fail-closed rule (a failed pre-write backup blocks the write).
 * The spawned-server integration tests (corrupt load serves the last
 * verified backup; simulated failed write leaves the last known-good
 * recoverable) live in `tests/server-backup-on-load.test.cjs`.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  PASS ${name}`);
}

(async () => {
  const {
    BACKUP_KEEP,
    backupBeforeWrite,
    findLastVerifiedBackup,
    listBackups,
    quarantineFile,
    restoreBackup,
    snapshotOnLoad,
    verifyBackup,
    writeJsonWithBackup,
  } = await import(
    pathToFileURL(path.join(__dirname, "..", "server", "backup.mjs"))
  );

  /* ── Original coverage: first save, rotation to exactly 5, no temp files ── */
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
  console.log("=== server backup: original rotation assertions passed ===");

  /* ── Rotation + timestamped, collision-safe names ─────────────────────── */
  check("backup names are timestamped with a random suffix and unique across rapid snapshots", () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-names-"));
    const f2 = path.join(d2, "rooms.json");
    fs.writeFileSync(f2, JSON.stringify({ version: 0 }), "utf8");
    const targets = new Set();
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(f2, JSON.stringify({ version: i }), "utf8");
      const r = backupBeforeWrite(f2);
      assert.strictEqual(r.error, null, `snapshot ${i} must succeed`);
      assert.ok(r.created, `snapshot ${i} must be created`);
      assert.match(path.basename(r.target), /^rooms\.json\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.\d{6}\.[0-9a-f]{8}\.bak$/);
      targets.add(r.target);
    }
    assert.strictEqual(targets.size, 20, "20 rapid snapshots must all have distinct names (same-millisecond safe)");
    assert.strictEqual(listBackups(f2).length, BACKUP_KEEP, "retention stays bounded at five after rapid snapshots");
  });

  check("duplicate timestamps: backups sharing one mtime are both listed, in deterministic order", () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-dup-"));
    const f2 = path.join(d2, "projects.json");
    fs.writeFileSync(f2, JSON.stringify({ version: 0 }), "utf8");
    const a = backupBeforeWrite(f2).target;
    fs.writeFileSync(f2, JSON.stringify({ version: 1 }), "utf8");
    const b = backupBeforeWrite(f2).target;
    assert.notStrictEqual(a, b);
    const stamp = new Date("2026-11-20T12:00:00.000Z");
    fs.utimesSync(a, stamp, stamp);
    fs.utimesSync(b, stamp, stamp);
    const first = listBackups(f2);
    const second = listBackups(f2);
    assert.deepStrictEqual(first, second, "same-mtime listing must be deterministic");
    assert.deepStrictEqual(first, [a, b].sort((x, y) => x.localeCompare(y)), "same-mtime ties break by name");
    assert.ok(verifyBackup(a).ok && verifyBackup(b).ok, "both same-mtime backups verify");
  });

  /* ── Read-back verification + corrupt backups ─────────────────────────── */
  check("verifyBackup accepts good backups and rejects truncated, empty and non-object backups", () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-verify-"));
    const f2 = path.join(d2, "projects.json");
    writeJsonWithBackup(f2, { version: 1 });
    writeJsonWithBackup(f2, { version: 2 });
    const [good] = listBackups(f2);
    assert.deepStrictEqual(verifyBackup(good), { ok: true, value: { version: 1 } });
    const truncated = path.join(d2, "projects.json.2099-01-01T00-00-00-000Z.aaaaaaaa.bak");
    fs.writeFileSync(truncated, '{"version": 2,', "utf8");
    assert.strictEqual(verifyBackup(truncated).ok, false, "truncated backup must not verify");
    const empty = path.join(d2, "projects.json.2099-01-01T00-00-01-000Z.bbbbbbbb.bak");
    fs.writeFileSync(empty, "", "utf8");
    assert.strictEqual(verifyBackup(empty).ok, false, "empty backup must not verify");
    const notObject = path.join(d2, "projects.json.2099-01-01T00-00-02-000Z.cccccccc.bak");
    fs.writeFileSync(notObject, "[1, 2]", "utf8");
    assert.strictEqual(verifyBackup(notObject).ok, false, "non-object backup must not verify");
    assert.strictEqual(verifyBackup(path.join(d2, "missing.bak")).ok, false, "missing backup must not verify");
  });

  check("findLastVerifiedBackup skips corrupt newest backups and returns the last good one", () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-find-"));
    const f2 = path.join(d2, "projects.json");
    writeJsonWithBackup(f2, { version: 1 });
    writeJsonWithBackup(f2, { version: 2 });
    writeJsonWithBackup(f2, { version: 3 });
    const ordered = listBackups(f2);
    assert.strictEqual(ordered.length, 2, "two backups after three writes");
    // Corrupt the newest backup in place (simulates backup rot).
    fs.writeFileSync(ordered[1], "garbage{", "utf8");
    const found = findLastVerifiedBackup(f2);
    assert.ok(found, "an older good backup must still be found");
    assert.strictEqual(found.path, ordered[0]);
    assert.deepStrictEqual(found.value, { version: 1 });
    // Corrupt every backup: nothing recoverable.
    fs.writeFileSync(ordered[0], "", "utf8");
    assert.strictEqual(findLastVerifiedBackup(f2), null);
  });

  /* ── Interrupted writes ───────────────────────────────────────────────── */
  check("a stale temp file from a crashed write is inert: live file intact, next write succeeds", () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-tmp-"));
    const f2 = path.join(d2, "projects.json");
    writeJsonWithBackup(f2, { version: 1 });
    writeJsonWithBackup(f2, { version: 2 });
    // Simulate a crash between temp write and rename.
    const staleTmp = `${f2}.${process.pid}.deadbeef.tmp`;
    fs.writeFileSync(staleTmp, '{"version": 3,', "utf8");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f2, "utf8")), { version: 2 }, "live file untouched by the crash");
    writeJsonWithBackup(f2, { version: 3 });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f2, "utf8")), { version: 3 });
    assert.ok(fs.existsSync(staleTmp), "stale temp is left alone (unique temp names; never deleted blindly)");
    assert.strictEqual(
      fs.readdirSync(d2).filter((n) => n.endsWith(".tmp")).length, 1,
      "the successful write leaves no new temp file",
    );
  });

  check("a corrupt live file blocks the write (fail closed) and the corrupt bytes are untouched", () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-block-"));
    const f2 = path.join(d2, "projects.json");
    writeJsonWithBackup(f2, { version: 1 });
    writeJsonWithBackup(f2, { version: 2 });
    const before = listBackups(f2);
    const corrupt = '{"version": 3,';
    fs.writeFileSync(f2, corrupt, "utf8");
    assert.throws(
      () => writeJsonWithBackup(f2, { version: 3 }),
      (e) => e.code === "backup_failed",
      "write over a corrupt live file must throw backup_failed",
    );
    assert.strictEqual(fs.readFileSync(f2, "utf8"), corrupt, "live file bytes must be untouched by the refused write");
    assert.deepStrictEqual(listBackups(f2), before, "no corrupt backup may consume a retention slot");
    // The last known-good backup is still recoverable afterwards.
    const found = findLastVerifiedBackup(f2);
    assert.ok(found);
    assert.deepStrictEqual(found.value, { version: 1 });
  });

  check("a backup copy failure blocks the write (fail closed)", () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-copyfail-"));
    // A directory where the store file should be: the copy cannot be made.
    assert.throws(
      () => writeJsonWithBackup(d2, { version: 1 }),
      (e) => e.code === "backup_failed",
      "write must throw backup_failed when the pre-write backup cannot be created",
    );
    assert.deepStrictEqual(fs.readdirSync(d2), [], "a refused write leaves no temp file behind");
  });

  /* ── Snapshot-on-load ─────────────────────────────────────────────────── */
  check("snapshotOnLoad creates a verified snapshot; a corrupt file yields an error and no retention slot", () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-snap-"));
    const f2 = path.join(d2, "projects.json");
    fs.writeFileSync(f2, JSON.stringify({ version: 7 }), "utf8");
    const snap = snapshotOnLoad(f2);
    assert.strictEqual(snap.error, null);
    assert.ok(snap.created);
    assert.deepStrictEqual(verifyBackup(snap.target), { ok: true, value: { version: 7 } });
    assert.strictEqual(listBackups(f2).length, 1);
    fs.writeFileSync(f2, "not json{", "utf8");
    const bad = snapshotOnLoad(f2);
    assert.ok(bad.error, "snapshotting a corrupt file must report an error");
    assert.strictEqual(bad.error.code, "backup_verification_failed");
    assert.strictEqual(listBackups(f2).length, 1, "unverifiable snapshot must not consume retention");
    assert.ok(!fs.existsSync(bad.target), "unverifiable snapshot copy must be deleted");
  });

  check("snapshotOnLoad skips a duplicate when the newest verified backup already holds the live bytes", () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-dedup-"));
    const f2 = path.join(d2, "projects.json");
    // Five distinct states, each snapshot the pre-write state of the next.
    for (let v = 1; v <= 6; v++) writeJsonWithBackup(f2, { version: v });
    const before = listBackups(f2).map((b) => JSON.parse(fs.readFileSync(b, "utf8")).version);
    assert.deepStrictEqual(before, [1, 2, 3, 4, 5], "retention holds five distinct pre-write states");
    // The first boot snapshots the live {version:6} state (the newest
    // backup holds {version:5}, so the bytes genuinely differ) — one
    // legitimate snapshot, evicting only the oldest state.
    const first = snapshotOnLoad(f2);
    assert.strictEqual(first.error, null);
    assert.strictEqual(first.created, true);
    assert.strictEqual(first.deduped, false);
    assert.deepStrictEqual(
      listBackups(f2).map((b) => JSON.parse(fs.readFileSync(b, "utf8")).version),
      [2, 3, 4, 5, 6],
    );
    // Six further boots with no intervening save: without dedup, six
    // identical snapshots of {version:6} would evict every distinct
    // older state from the 5-slot rotation.
    for (let boot = 0; boot < 6; boot++) {
      const snap = snapshotOnLoad(f2);
      assert.strictEqual(snap.error, null);
      assert.strictEqual(snap.created, false, "identical live bytes must not take a new snapshot");
      assert.strictEqual(snap.deduped, true);
    }
    const after = listBackups(f2).map((b) => JSON.parse(fs.readFileSync(b, "utf8")).version);
    assert.deepStrictEqual(after, [2, 3, 4, 5, 6], "repeated boots must not evict distinct history");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f2, "utf8")), { version: 6 });
    // A changed live file snapshots again (dedup is byte-equality, not a latch).
    writeJsonWithBackup(f2, { version: 7 });
    const changed = snapshotOnLoad(f2);
    assert.strictEqual(changed.created, true, "changed bytes must snapshot");
    assert.strictEqual(changed.deduped, false);
    assert.strictEqual(listBackups(f2).length, 5, "retention stays bounded after the new snapshot");
    // A corrupt newest backup does not block the snapshot: the live bytes
    // are still preserved (the corrupt copy is skipped, never served).
    const newest = listBackups(f2).slice(-1)[0];
    fs.writeFileSync(newest, "{broken", "utf8");
    const afterCorrupt = snapshotOnLoad(f2);
    assert.strictEqual(afterCorrupt.error, null);
    assert.strictEqual(afterCorrupt.created, true, "snapshot still taken when newest backup is corrupt");
    assert.deepStrictEqual(verifyBackup(afterCorrupt.target), { ok: true, value: { version: 7 } });
  });

  /* ── Quarantine ───────────────────────────────────────────────────────── */
  check("quarantineFile preserves corrupt bytes aside and is a no-op for a missing file", () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-quar-"));
    const f2 = path.join(d2, "projects.json");
    fs.writeFileSync(f2, "garbage{", "utf8");
    const q = quarantineFile(f2);
    assert.strictEqual(q.quarantined, true);
    assert.ok(q.target.startsWith(`${f2}.corrupt.`));
    assert.strictEqual(fs.readFileSync(q.target, "utf8"), "garbage{", "quarantined bytes are preserved");
    assert.ok(!fs.existsSync(f2), "original path is gone after quarantine");
    assert.deepStrictEqual(
      quarantineFile(path.join(d2, "missing.json")),
      { quarantined: false, target: null, error: null },
    );
  });

  /* ── Restore / rollback ───────────────────────────────────────────────── */
  check("restoreBackup restores the newest verified backup and backs up the live file first", () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-restore-"));
    const f2 = path.join(d2, "projects.json");
    writeJsonWithBackup(f2, { version: 1 });
    writeJsonWithBackup(f2, { version: 2 });
    writeJsonWithBackup(f2, { version: 3 });
    const restored = restoreBackup(f2);
    assert.strictEqual(restored.ok, true, JSON.stringify(restored.error));
    assert.deepStrictEqual(restored.value, { version: 2 }, "newest backup is the pre-v3 state");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f2, "utf8")), { version: 2 });
    assert.deepStrictEqual(verifyBackup(restored.restoredFrom), { ok: true, value: { version: 2 } });
    // The pre-restore live file (v3) was backed up, not destroyed.
    const after = listBackups(f2).map((b) => JSON.parse(fs.readFileSync(b, "utf8")).version);
    assert.ok(after.includes(3), "restore must back up the replaced live file");
    // Explicit older backup restores that version.
    const v1 = listBackups(f2).find((b) => JSON.parse(fs.readFileSync(b, "utf8")).version === 1);
    assert.ok(v1, "v1 backup still retained");
    assert.deepStrictEqual(restoreBackup(f2, v1).value, { version: 1 });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f2, "utf8")), { version: 1 });
  });

  check("restoreBackup recovers a corrupt live file and quarantines the corrupt bytes", () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-restore2-"));
    const f2 = path.join(d2, "projects.json");
    writeJsonWithBackup(f2, { version: 1 });
    writeJsonWithBackup(f2, { version: 2 });
    fs.writeFileSync(f2, "truncated{", "utf8");
    const restored = restoreBackup(f2);
    assert.strictEqual(restored.ok, true, JSON.stringify(restored.error));
    assert.deepStrictEqual(restored.value, { version: 1 });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f2, "utf8")), { version: 1 });
    const quarantined = fs.readdirSync(d2).filter((n) => n.includes(".corrupt."));
    assert.strictEqual(quarantined.length, 1, "corrupt live file is quarantined, not deleted");
    assert.strictEqual(fs.readFileSync(path.join(d2, quarantined[0]), "utf8"), "truncated{");
  });

  check("restoreBackup refuses when nothing verifies and leaves the live file untouched", () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-restore3-"));
    const f2 = path.join(d2, "projects.json");
    fs.writeFileSync(f2, JSON.stringify({ version: 9 }), "utf8");
    const none = restoreBackup(f2);
    assert.strictEqual(none.ok, false);
    assert.strictEqual(none.error.code, "no_verified_backup");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f2, "utf8")), { version: 9 });
    // An explicitly named corrupt backup is never restored.
    const badBak = path.join(d2, "projects.json.2099-01-01T00-00-00-000Z.dddddddd.bak");
    fs.writeFileSync(badBak, "garbage{", "utf8");
    const bad = restoreBackup(f2, badBak);
    assert.strictEqual(bad.ok, false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f2, "utf8")), { version: 9 });
  });

  console.log(`=== server backup: all ${passed + 1} assertion groups passed ===`);

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
  // Corrupt live file must never evict last known-good backups, however many saves are attempted.
  // Fail-closed (#91): a write over a corrupt live file is REFUSED (backup_failed) and the
  // corrupt bytes stay in place. #244 quarantined-and-proceeded here; refusing preserves the
  // same invariant (no corrupt backup ever consumes a retention slot) more strongly, and the
  // refused write surfaces as 503 instead of silently replacing the live file.
  m.writeJsonWithBackup(f, { v: 10 });
  fs.writeFileSync(f, "\u0000\u0000garbage");
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(f, "{bad" + i);
    assert.throws(
      () => m.writeJsonWithBackup(f, { v: 20 + i }),
      (e) => e.code === "backup_failed",
      "write over a corrupt live file must throw backup_failed",
    );
    assert.strictEqual(fs.readFileSync(f, "utf8"), "{bad" + i, "refused write leaves the live file untouched");
  }
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

// ── Same-timestamp ordering (fixed clock) ──
(async () => {
  const m = await import(pathToFileURL(path.join(__dirname, "..", "server", "backup.mjs")));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "obs-backup-clock-"));
  const f = path.join(d, "projects.json");
  const realIso = Date.prototype.toISOString;
  Date.prototype.toISOString = () => "2026-01-01T00:00:00.000Z"; // every backup gets the same timestamp
  try {
    for (let v = 1; v <= 12; v++) m.writeJsonWithBackup(f, { v });
  } finally {
    Date.prototype.toISOString = realIso;
  }
  const backups = m.listBackups(f);
  assert.strictEqual(backups.length, m.BACKUP_KEEP, "retention keeps exactly BACKUP_KEEP with a frozen clock");
  // Each backup holds the state before one write: after 12 writes, backups of v=1..11 exist and the newest BACKUP_KEEP (v=7..11) are kept.
  const versions = backups.map((b) => JSON.parse(fs.readFileSync(b, "utf8")).v);
  const expected = Array.from({ length: m.BACKUP_KEEP }, (_, i) => 12 - m.BACKUP_KEEP + i);
  assert.deepStrictEqual(versions, expected, `same-millisecond backups must stay in write order, got ${versions}`);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, "utf8")), { v: 12 });
  console.log("=== server backup: same-timestamp ordering passed ===");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
