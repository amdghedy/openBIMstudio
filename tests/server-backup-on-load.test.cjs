/* Server backup-on-load integration tests — issue #91.
 *
 * Spawns the real collaboration server (`server/index.mjs`) on an
 * ephemeral loopback port with an isolated data dir, then proves the
 * end-to-end behaviour the unit tests cannot: a snapshot is taken on
 * load, a corrupt store on boot is served from the last verified backup
 * instead of silently emptying, a failed write is refused (503) and the
 * last known-good project stays recoverable across restarts, and a
 * corrupt store with no backup is quarantined rather than deleted.
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
