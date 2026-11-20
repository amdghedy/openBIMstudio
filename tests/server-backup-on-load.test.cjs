/* Server backup-on-load integration tests — issue #91.
 *
 * Spawns the real collaboration server (`server/index.mjs`) on an
 * ephemeral loopback port with an isolated data dir, then proves the
 * end-to-end behaviour the unit tests cannot: a snapshot is taken on
 * load (and repeated boots do not evict distinct history), a corrupt
 * store on boot is served from the last verified backup instead of
 * silently emptying, corrupt newest / multiple corrupt / all-corrupt
 * backups are skipped in newest-first order, a failed write is refused
 * (503) and the last known-good project stays recoverable across
 * restarts, a SIGKILL mid-write burst never leaves a partial store,
 * stale temp files are inert at boot, rooms.json recovers the same way
 * as projects.json, and a corrupt store with no backup is quarantined
 * rather than deleted.
 */
const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const serverPath = path.join(__dirname, "..", "server", "index.mjs");
const TOKEN = "test-backup-token-32-chars-secret!!";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

let pass = 0;
let fail = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "obs-data-bol-"));
}

function seed(dataDir, projects, rooms = {}) {
  fs.writeFileSync(path.join(dataDir, "projects.json"), JSON.stringify(projects), "utf8");
  fs.writeFileSync(path.join(dataDir, "rooms.json"), JSON.stringify(rooms), "utf8");
}

function backupsOf(dataDir, base) {
  return fs.readdirSync(dataDir).filter((n) => n.startsWith(`${base}.`) && n.endsWith(".bak"));
}

function distinctBackupContents(dataDir, base) {
  return new Set(backupsOf(dataDir, base).map((n) => fs.readFileSync(path.join(dataDir, n), "utf8")));
}

function quarantinedOf(dataDir, base) {
  return fs.readdirSync(dataDir).filter((n) => n.includes(`${base}.corrupt.`));
}

function startServer(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: "0", OBS_DATA_DIR: dataDir, OBS_SERVER_TOKEN: TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error("server start timeout: " + out)), 10_000);
    const onData = (d) => {
      out += d.toString();
      const match = /\[collab\] PORT=(\d+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]), log: () => out });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ exited: true, code, log: () => out });
    });
  });
}

async function stopServer(s) {
  if (!s.child || s.exited) return;
  const exited = new Promise((resolve) => s.child.once("exit", resolve));
  s.child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
}

/** Hard kill (SIGKILL) — the closest a Node harness gets to a server
 * terminated mid-write: no cleanup handlers run, no flush is attempted. */
async function killServer(s) {
  if (!s.child || s.exited) return;
  const exited = new Promise((resolve) => s.child.once("exit", resolve));
  s.child.kill("SIGKILL");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
}

async function postRoom(base, room, action, body) {
  return fetch(`${base}/api/rooms/${encodeURIComponent(room)}/${action}`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getRoom(base, room) {
  return fetch(`${base}/api/rooms/${encodeURIComponent(room)}`, { headers: AUTH });
}

async function putProject(base, id, body) {
  return fetch(`${base}/api/projects/${id}`, {
    method: "PUT",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getProject(base, id) {
  return fetch(`${base}/api/projects/${id}`, { headers: AUTH });
}

t("snapshot on load: booting with a good store takes a verified snapshot", async () => {
  const dataDir = makeDataDir();
  seed(dataDir, { p1: { id: "p1", name: "v1", data: { v: 1 } } });
  assert.strictEqual(backupsOf(dataDir, "projects.json").length, 0);
  const s = await startServer(dataDir);
  try {
    const res = await getProject(`http://127.0.0.1:${s.port}`, "p1");
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual((await res.json()).data, { v: 1 });
    assert.ok(!s.log().includes("CORRUPT"), "good load must not log corruption");
  } finally {
    await stopServer(s);
  }
  const snaps = backupsOf(dataDir, "projects.json");
  assert.strictEqual(snaps.length, 1, "one load snapshot for projects.json");
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(dataDir, snaps[0]), "utf8")),
    { p1: { id: "p1", name: "v1", data: { v: 1 } } },
    "the load snapshot verifies by read-back",
  );
  assert.strictEqual(backupsOf(dataDir, "rooms.json").length, 1, "rooms.json is snapshotted too");
});

t("corrupt store on boot is served from the last verified backup, never silently emptied", async () => {
  const dataDir = makeDataDir();
  seed(dataDir, { p1: { id: "p1", name: "v1", data: { v: 1 } } });
  // First boot + one write, so verified backups exist.
  let s = await startServer(dataDir);
  let base = `http://127.0.0.1:${s.port}`;
  let res = await putProject(base, "p2", { name: "v2", data: { v: 2 } });
  assert.strictEqual(res.status, 200, "setup PUT must succeed");
  await stopServer(s);
  assert.ok(backupsOf(dataDir, "projects.json").length >= 1, "setup must leave backups");

  // Corrupt the live file the way a killed write / disk error / bad edit would.
  const corruptBytes = '{"p1": {"id": "p1", "name": "v1", "data": {"v": 1';
  fs.writeFileSync(path.join(dataDir, "projects.json"), corruptBytes, "utf8");

  s = await startServer(dataDir);
  try {
    base = `http://127.0.0.1:${s.port}`;
    res = await getProject(base, "p1");
    assert.strictEqual(res.status, 200, "p1 must still be served after a corrupt boot");
    assert.deepStrictEqual((await res.json()).data, { v: 1 });
    // p2 only ever existed in the (now corrupt) live file: the last
    // verified backup is the pre-write state, so p2 is honestly gone.
    res = await getProject(base, "p2");
    assert.strictEqual(res.status, 404, "state that was never backed up cannot be invented back");
    assert.match(s.log(), /CORRUPT projects\.json/, "corrupt load must be logged loudly");
    assert.match(s.log(), /RESTORED projects\.json from verified backup/, "restore must be logged");
  } finally {
    await stopServer(s);
  }
  // The live file is good again, and the corrupt bytes were quarantined, not deleted.
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(dataDir, "projects.json"), "utf8")).p1.data,
    { v: 1 },
    "live file restored to the last verified backup",
  );
  const q = quarantinedOf(dataDir, "projects.json");
  assert.strictEqual(q.length, 1, "corrupt bytes are quarantined");
  assert.strictEqual(fs.readFileSync(path.join(dataDir, q[0]), "utf8"), corruptBytes);
});

t("simulated failed write: refused with 503, last known-good stays recoverable across restarts", async () => {
  const dataDir = makeDataDir();
  seed(dataDir, { p1: { id: "p1", name: "v1", data: { v: 1 } } });
  let s = await startServer(dataDir);
  let base = `http://127.0.0.1:${s.port}`;
  let res = await putProject(base, "p2", { name: "v2", data: { v: 2 } });
  assert.strictEqual(res.status, 200, "setup PUT must succeed");

  // Simulate the failed write: the live file is corrupted out from under
  // the running server (killed write, disk error, bad hand-edit).
  const corruptBytes = '{"p1":';
  fs.writeFileSync(path.join(dataDir, "projects.json"), corruptBytes, "utf8");
  const backupsBefore = backupsOf(dataDir, "projects.json");

  // The next save must be REFUSED, not allowed to overwrite the good copy.
  res = await putProject(base, "p3", { name: "v3", data: { v: 3 } });
  assert.strictEqual(res.status, 503, "write with a failed backup must be refused with 503");
  assert.match((await res.json()).error, /backup failed/i, "503 must say the backup failed");
  assert.match(s.log(), /WRITE BLOCKED for projects\.json/, "refused write must be logged loudly");
  // The refused write changed nothing on disk.
  assert.strictEqual(fs.readFileSync(path.join(dataDir, "projects.json"), "utf8"), corruptBytes);
  assert.deepStrictEqual(backupsOf(dataDir, "projects.json"), backupsBefore, "no corrupt backup may be taken");
  // In-memory state is untouched by the refusal.
  res = await getProject(base, "p1");
  assert.strictEqual(res.status, 200);
  res = await getProject(base, "p2");
  assert.strictEqual(res.status, 200, "in-memory p2 still served");
  res = await getProject(base, "p3");
  assert.strictEqual(res.status, 200, "in-memory p3 still served (kept in memory only)");
  await stopServer(s);

  // Restart: the last known-good project (p1, the last verified backup)
  // is recoverable; p2/p3 were never persisted past the corruption.
  s = await startServer(dataDir);
  try {
    base = `http://127.0.0.1:${s.port}`;
    res = await getProject(base, "p1");
    assert.strictEqual(res.status, 200, "last known-good p1 must survive the failed write + restart");
    assert.deepStrictEqual((await res.json()).data, { v: 1 });
    assert.strictEqual((await getProject(base, "p2")).status, 404);
    assert.strictEqual((await getProject(base, "p3")).status, 404);
    // The store is healthy again: a new write succeeds and persists.
    res = await putProject(base, "p3", { name: "v3-retry", data: { v: 3 } });
    assert.strictEqual(res.status, 200, "writes must work again after recovery");
  } finally {
    await stopServer(s);
  }
  // And the recovery persists across a further restart.
  s = await startServer(dataDir);
  try {
    base = `http://127.0.0.1:${s.port}`;
    assert.strictEqual((await getProject(base, "p1")).status, 200);
    res = await getProject(base, "p3");
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).name, "v3-retry");
  } finally {
    await stopServer(s);
  }
});

t("boot churn: repeated boots without a save do not evict distinct backup history", async () => {
  const dataDir = makeDataDir();
  seed(dataDir, { p1: { id: "p1", name: "v1", data: { v: 1 } } });
  let s = await startServer(dataDir);
  let base = `http://127.0.0.1:${s.port}`;
  let res = await putProject(base, "p2", { name: "v2", data: { v: 2 } });
  assert.strictEqual(res.status, 200);
  res = await putProject(base, "p3", { name: "v3", data: { v: 3 } });
  assert.strictEqual(res.status, 200);
  await stopServer(s);
  // One more boot takes the one legitimate snapshot of the live
  // {p1,p2,p3} state; record the rotation as it stands after that.
  s = await startServer(dataDir);
  await stopServer(s);
  const countAfterFirstReboot = backupsOf(dataDir, "projects.json").length;
  const contentsAfterFirstReboot = distinctBackupContents(dataDir, "projects.json");
  assert.ok(countAfterFirstReboot >= 3, "setup must leave several distinct backups");
  assert.ok(contentsAfterFirstReboot.size >= 3, "backups must hold distinct states, not duplicates");
  // Five further boots with no intervening save.
  for (let i = 0; i < 5; i++) {
    s = await startServer(dataDir);
    await stopServer(s);
  }
  assert.strictEqual(
    backupsOf(dataDir, "projects.json").length,
    countAfterFirstReboot,
    "boots with unchanged bytes must not take new snapshots",
  );
  assert.deepStrictEqual(
    distinctBackupContents(dataDir, "projects.json"),
    contentsAfterFirstReboot,
    "repeated boots must not evict distinct older states",
  );
  // The history is still usable: corrupt the live file and the newest
  // backup must still be the {p1,p2,p3} snapshot.
  fs.writeFileSync(path.join(dataDir, "projects.json"), '{"p1":', "utf8");
  s = await startServer(dataDir);
  try {
    base = `http://127.0.0.1:${s.port}`;
    assert.strictEqual((await getProject(base, "p3")).status, 200, "newest state still recoverable after boot churn");
  } finally {
    await stopServer(s);
  }
});

t("corrupt newest backup on boot is skipped; the older verified backup is served", async () => {
  const dataDir = makeDataDir();
  seed(dataDir, { p1: { id: "p1", name: "v1", data: { v: 1 } } });
  let s = await startServer(dataDir);
  let base = `http://127.0.0.1:${s.port}`;
  for (const [id, v] of [["p2", 2], ["p3", 3], ["p4", 4]]) {
    assert.strictEqual((await putProject(base, id, { name: `v${v}`, data: { v } })).status, 200);
  }
  await stopServer(s);
  // Backups now hold {p1}, {p1}, {p1,p2}, {p1,p2,p3}. The newest state
  // is the {p1,p2,p3} pre-write backup (most keys); corrupt it AND the
  // live file: recovery must fall through to {p1,p2}.
  const byKeys = backupsOf(dataDir, "projects.json")
    .map((n) => ({ name: n, keys: Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, n), "utf8"))).length }))
    .sort((a, b) => b.keys - a.keys);
  assert.ok(byKeys.length >= 3, "setup must leave several backups");
  assert.strictEqual(byKeys[0].keys, 3, "newest backup must be the pre-p4 state");
  const newestPath = path.join(dataDir, byKeys[0].name);
  fs.writeFileSync(newestPath, '{"p1": {"id": "p1",', "utf8");
  fs.writeFileSync(path.join(dataDir, "projects.json"), '{"p1":', "utf8");
  s = await startServer(dataDir);
  try {
    base = `http://127.0.0.1:${s.port}`;
    assert.strictEqual((await getProject(base, "p1")).status, 200);
    assert.strictEqual((await getProject(base, "p2")).status, 200, "older verified backup must serve p2");
    assert.strictEqual((await getProject(base, "p3")).status, 404, "state only in the corrupt backup is honestly gone");
    assert.strictEqual((await getProject(base, "p4")).status, 404);
    assert.match(s.log(), /RESTORED projects\.json from verified backup/);
  } finally {
    await stopServer(s);
  }
  // The corrupt backup is still on disk (never deleted), the live file is good again.
  assert.strictEqual(fs.readFileSync(newestPath, "utf8"), '{"p1": {"id": "p1",');
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, "projects.json"), "utf8"))).sort(), ["p1", "p2"]);
});

t("multiple corrupt backups: only the oldest verified backup survives, and a new save works after it", async () => {
  const dataDir = makeDataDir();
  seed(dataDir, { p1: { id: "p1", name: "v1", data: { v: 1 } } });
  let s = await startServer(dataDir);
  let base = `http://127.0.0.1:${s.port}`;
  for (const [id, v] of [["p2", 2], ["p3", 3], ["p4", 4]]) {
    assert.strictEqual((await putProject(base, id, { name: `v${v}`, data: { v } })).status, 200);
  }
  await stopServer(s);
  // Corrupt the two newest backups ({p1,p2,p3} and {p1,p2}) and the live
  // file: only the {p1} snapshots remain verifiable.
  const byKeys = backupsOf(dataDir, "projects.json")
    .map((n) => ({ name: n, keys: Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, n), "utf8"))).length }))
    .sort((a, b) => b.keys - a.keys);
  assert.ok(byKeys.length >= 3);
  assert.deepStrictEqual(byKeys.slice(0, 2).map((b) => b.keys), [3, 2], "two newest backups hold the p3/p2 states");
  for (const b of byKeys.slice(0, 2)) fs.writeFileSync(path.join(dataDir, b.name), "{broken", "utf8");
  fs.writeFileSync(path.join(dataDir, "projects.json"), "garbage{", "utf8");
  s = await startServer(dataDir);
  try {
    base = `http://127.0.0.1:${s.port}`;
    assert.strictEqual((await getProject(base, "p1")).status, 200, "oldest verified backup must still serve p1");
    assert.strictEqual((await getProject(base, "p2")).status, 404);
    assert.match(s.log(), /RESTORED projects\.json from verified backup/);
    // Recovery followed by another save: the store is healthy again.
    assert.strictEqual((await putProject(base, "p5", { name: "v5-after-recovery", data: { v: 5 } })).status, 200);
  } finally {
    await stopServer(s);
  }
  s = await startServer(dataDir);
  try {
    base = `http://127.0.0.1:${s.port}`;
    assert.strictEqual((await getProject(base, "p1")).status, 200);
    const res = await getProject(base, "p5");
    assert.strictEqual(res.status, 200, "post-recovery save must persist across a further restart");
    assert.strictEqual((await res.json()).name, "v5-after-recovery");
  } finally {
    await stopServer(s);
  }
});

t("all backups corrupt: server starts empty, corrupt bytes quarantined, never deleted", async () => {
  const dataDir = makeDataDir();
  seed(dataDir, { p1: { id: "p1", name: "v1", data: { v: 1 } } });
  let s = await startServer(dataDir);
  const base0 = `http://127.0.0.1:${s.port}`;
  assert.strictEqual((await putProject(base0, "p2", { name: "v2", data: { v: 2 } })).status, 200);
  await stopServer(s);
  for (const name of backupsOf(dataDir, "projects.json")) fs.writeFileSync(path.join(dataDir, name), "{broken", "utf8");
  fs.writeFileSync(path.join(dataDir, "projects.json"), "garbage{", "utf8");
  s = await startServer(dataDir);
  try {
    assert.ok(!s.exited, "server must not crash when every backup is corrupt");
    assert.strictEqual((await getProject(`http://127.0.0.1:${s.port}`, "p1")).status, 404);
    assert.match(s.log(), /CORRUPT projects\.json/);
    assert.match(s.log(), /NO VERIFIED BACKUP for projects\.json/);
  } finally {
    await stopServer(s);
  }
  const q = quarantinedOf(dataDir, "projects.json");
  assert.strictEqual(q.length, 1, "corrupt live bytes are quarantined");
  assert.strictEqual(fs.readFileSync(path.join(dataDir, q[0]), "utf8"), "garbage{");
  // The corrupt backups are still on disk for forensics, never deleted.
  assert.ok(backupsOf(dataDir, "projects.json").length >= 1);
});

t("stale temp files from an interrupted write are inert at boot", async () => {
  const dataDir = makeDataDir();
  seed(dataDir, { p1: { id: "p1", name: "v1", data: { v: 1 } } });
  // Litter as a killed write would leave it: temp files beside the store,
  // one holding a half-written payload, one empty.
  fs.writeFileSync(path.join(dataDir, "projects.json.1234.deadbeef.tmp"), '{"p1": {"id": "p1", "name": "v1", "data": ', "utf8");
  fs.writeFileSync(path.join(dataDir, "projects.json.5678.01234567.tmp"), "", "utf8");
  const s = await startServer(dataDir);
  try {
    assert.ok(!s.exited, "stale temp files must not stop the boot");
    const base = `http://127.0.0.1:${s.port}`;
    const res = await getProject(base, "p1");
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual((await res.json()).data, { v: 1 });
    assert.ok(!s.log().includes("CORRUPT"), "a stale temp file is not corruption");
    assert.strictEqual((await putProject(base, "p2", { name: "v2", data: { v: 2 } })).status, 200, "writes work with stale temps present");
  } finally {
    await stopServer(s);
  }
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(dataDir, "projects.json"), "utf8")).p2.data,
    { v: 2 },
  );
});

t("server killed mid-write (SIGKILL): restart serves a complete state, never a partial file", async () => {
  const dataDir = makeDataDir();
  seed(dataDir, { p1: { id: "p1", name: "v1", data: { v: 1 } } });
  let s = await startServer(dataDir);
  const base = `http://127.0.0.1:${s.port}`;
  // A burst of large concurrent writes, killed mid-flight: each PUT is a
  // full-file rewrite, so the store on disk must be exactly one complete
  // state (some prefix of the burst) — never a torn half-write.
  const big = "x".repeat(512 * 1024);
  const attempts = Array.from({ length: 12 }, (_, i) =>
    putProject(base, `burst${i}`, { name: `burst${i}`, data: { v: i, big } })
      .then((r) => r.status)
      .catch(() => 0),
  );
  await new Promise((r) => setTimeout(r, 25));
  await killServer(s);
  const statuses = await Promise.allSettled(attempts);
  const confirmed = statuses.filter((r) => r.status === "fulfilled" && r.value === 200).length;
  // Restart: whatever survived must be a complete, well-formed store.
  s = await startServer(dataDir);
  try {
    const base2 = `http://127.0.0.1:${s.port}`;
    assert.ok(!s.exited, "server must boot after a mid-write kill");
    assert.strictEqual((await getProject(base2, "p1")).status, 200, "seed project survives the kill");
    const raw = fs.readFileSync(path.join(dataDir, "projects.json"), "utf8");
    const parsed = JSON.parse(raw);
    for (const [id, project] of Object.entries(parsed)) {
      assert.strictEqual(typeof project, "object");
      assert.strictEqual(project.id, id, "every surviving record must be complete");
      assert.strictEqual(typeof project.name, "string");
      assert.ok(project.data && typeof project.data === "object");
    }
    const burstCount = Object.keys(parsed).filter((id) => id.startsWith("burst")).length;
    assert.ok(burstCount >= confirmed, "every 200-acknowledged write must have survived");
    assert.ok(burstCount <= 12, "no more projects than were attempted");
    assert.ok(!s.log().includes("CORRUPT"), "a killed write must not read as corruption");
    // The store stays writable after the kill + restart.
    assert.strictEqual((await putProject(base2, "afterkill", { name: "after-kill", data: { v: 99 } })).status, 200);
  } finally {
    await stopServer(s);
  }
  s = await startServer(dataDir);
  try {
    assert.strictEqual((await getProject(`http://127.0.0.1:${s.port}`, "afterkill")).status, 200, "post-kill save persists");
  } finally {
    await stopServer(s);
  }
});

t("corrupt rooms.json on boot is recovered from the newest verified backup, like projects.json", async () => {
  const dataDir = makeDataDir();
  seed(dataDir, { p1: { id: "p1", name: "v1", data: { v: 1 } } });
  let s = await startServer(dataDir);
  let base = `http://127.0.0.1:${s.port}`;
  let res = await postRoom(base, "site", "join", { clientId: "u-alice", name: "Alice" });
  assert.strictEqual(res.status, 200, "room join must succeed");
  res = await postRoom(base, "site", "change", { clientId: "u-alice", type: "note", payload: { text: "hello" } });
  assert.strictEqual(res.status, 200, "room change must succeed");
  // A second change: its pre-write backup is what preserves the first
  // change — backups are pre-write snapshots, so state that only ever
  // existed in the (about to be corrupted) live file cannot be invented
  // back (same honest semantic as the projects p2 case above).
  res = await postRoom(base, "site", "change", { clientId: "u-alice", type: "note", payload: { text: "second" } });
  assert.strictEqual(res.status, 200, "second room change must succeed");
  res = await getRoom(base, "site");
  assert.strictEqual(res.status, 200);
  const before = await res.json();
  assert.deepStrictEqual(before.presence.map((p) => p.clientId), ["u-alice"]);
  assert.strictEqual(before.changes.length, 2);
  await stopServer(s);
  assert.ok(backupsOf(dataDir, "rooms.json").length >= 1, "room writes must leave backups");
  // Corrupt the live rooms file; the next boot must restore it from backup.
  fs.writeFileSync(path.join(dataDir, "rooms.json"), '{"site":', "utf8");
  s = await startServer(dataDir);
  try {
    base = `http://127.0.0.1:${s.port}`;
    res = await getRoom(base, "site");
    assert.strictEqual(res.status, 200);
    const after = await res.json();
    assert.deepStrictEqual(after.presence.map((p) => p.clientId), ["u-alice"], "presence must survive a corrupt rooms boot");
    assert.strictEqual(after.changes.length, 1, "room changes must survive a corrupt rooms boot");
    assert.strictEqual(after.changes[0].payload.text, "hello");
    assert.match(s.log(), /CORRUPT rooms\.json/);
    assert.match(s.log(), /RESTORED rooms\.json from verified backup/);
  } finally {
    await stopServer(s);
  }
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(dataDir, "rooms.json"), "utf8")).site.clients["u-alice"].name,
    "Alice",
  );
});

t("corrupt store with no backup: server starts empty, corrupt bytes quarantined, never deleted", async () => {
  const dataDir = makeDataDir();
  const corruptBytes = '{"p1": {"id": "p1",';
  fs.writeFileSync(path.join(dataDir, "projects.json"), corruptBytes, "utf8");
  fs.writeFileSync(path.join(dataDir, "rooms.json"), "{}", "utf8");
  const s = await startServer(dataDir);
  try {
    assert.ok(!s.exited, "server must not crash on a corrupt store with no backup");
    const res = await getProject(`http://127.0.0.1:${s.port}`, "p1");
    assert.strictEqual(res.status, 404, "empty store serves 404, not a crash");
    assert.match(s.log(), /CORRUPT projects\.json/);
    assert.match(s.log(), /NO VERIFIED BACKUP for projects\.json/);
  } finally {
    await stopServer(s);
  }
  const q = quarantinedOf(dataDir, "projects.json");
  assert.strictEqual(q.length, 1, "corrupt bytes are quarantined");
  assert.strictEqual(fs.readFileSync(path.join(dataDir, q[0]), "utf8"), corruptBytes);
  assert.ok(!fs.existsSync(path.join(dataDir, "projects.json")), "no live file until the next successful save");
  // A fresh write after quarantine succeeds and persists.
  const s2 = await startServer(dataDir);
  try {
    const base = `http://127.0.0.1:${s2.port}`;
    const res = await putProject(base, "p1", { name: "fresh", data: { v: 1 } });
    assert.strictEqual(res.status, 200, "fresh write after quarantine must succeed");
    assert.strictEqual((await getProject(base, "p1")).status, 200);
  } finally {
    await stopServer(s2);
  }
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(dataDir, "projects.json"), "utf8")).p1.data,
    { v: 1 },
  );
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      pass++;
      console.log(`  PASS ${name}`);
    } catch (error) {
      fail++;
      console.log(`  FAIL ${name}: ${error.message}`);
    }
  }
  console.log(`=== server backup-on-load: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();
