/**
 * Central binding integration tests — two REAL bindings (fake in-memory
 * authoring models) against a REAL spawned server.
 *
 * The only simulated part is the authoring model itself (a Map of elements
 * implementing the CentralModelAdapter interface): the server, the journal,
 * the CentralClient, the merge, the borrows and the offline queue are all
 * the shipped code. The fake adapter mirrors the real authoring adapter's
 * contract (validated apply, level skip, materialisation under a fresh
 * local id) so the binding logic — id mapping, diff/push, pinning, guard,
 * revert-on-409 — is exercised exactly as the browser runs it. The browser
 * half (real authoring model + real DOM) is covered by
 * tests/e2e/central-worksharing.spec.ts.
 *
 * Run: node tests/central-binding.test.cjs
 */
const assert = require("assert");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const root = path.resolve(__dirname, "..");
// Keep all scratch inside the work tree: /tmp is a shared 512 MB tmpfs.
const workDir = fs.mkdtempSync(path.join(__dirname, "..", ".central-binding-test-"));
const dataDir = path.join(workDir, "data");
const compileDir = path.join(workDir, "compiled");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(compileDir, { recursive: true });
fs.writeFileSync(path.join(compileDir, "package.json"), '{"type":"commonjs"}');

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  return (async () => {
    try {
      await fn();
      pass++;
      console.log("  PASS " + name);
    } catch (e) {
      fail++;
      failures.push(name + ": " + (e && e.message));
      console.log("  FAIL " + name + ": " + (e && e.message));
    }
  })();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal EventSource-compatible reader over Node http (same as central-sync). */
class NodeSseReader {
  constructor(url) {
    this.url = url;
    this.onopen = null;
    this.onerror = null;
    this.listeners = {};
    this.closed = false;
    this.buf = "";
    const u = new URL(url);
    this.req = http.get(
      { host: u.hostname, port: Number(u.port), path: u.pathname + u.search,
        headers: { Accept: "text/event-stream" } },
      (res) => {
        if (res.statusCode !== 200) {
          if (this.onerror) this.onerror(new Error("SSE status " + res.statusCode));
          return;
        }
        if (this.onopen) this.onopen({});
        res.setEncoding("utf8");
        res.on("data", (chunk) => this.feed(chunk));
        res.on("end", () => { if (!this.closed && this.onerror) this.onerror(new Error("SSE closed")); });
        res.on("error", (e) => { if (!this.closed && this.onerror) this.onerror(e); });
      },
    );
    this.req.on("error", (e) => { if (!this.closed && this.onerror) this.onerror(e); });
  }
  feed(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const frame = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      let event = "message";
      const data = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      const payload = data.join("\n");
      for (const fn of this.listeners[event] || []) {
        try { fn({ data: payload }); } catch { /* ignore */ }
      }
    }
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  close() {
    this.closed = true;
    try { this.req.destroy(); } catch { /* ignore */ }
  }
}

function spawnServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "server", "index.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        OBS_DATA_DIR: dataDir,
        OBS_RATE_MAX: "10000",
        OBS_RATE_MAX_MUTATION: "10000",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error("server did not print PORT in 15s; out=" + out)), 15000);
    child.stdout.on("data", (d) => {
      out += d.toString();
      const m = out.match(/PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]), base: `http://127.0.0.1:${m[1]}/api` });
      }
    });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.on("error", reject);
  });
}

async function killServer(s) {
  if (!s || !s.child) return;
  const p = new Promise((res) => s.child.once("exit", res));
  try { s.child.kill("SIGKILL"); } catch { /* ignore */ }
  await Promise.race([p, new Promise((r) => setTimeout(r, 5000))]);
}

async function waitFor(fn, timeoutMs = 15000, label = "condition") {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for " + label);
    await sleep(100);
  }
}

/**
 * Fake authoring model implementing CentralModelAdapter. Mirrors the real
 * authoring adapter's contract: ids are test-controlled (so the test can
 * pre-seed collisions), materialisation mints a fresh local id, level
 * constraints for unknown levels are skipped, and every mutation notifies
 * local-change listeners synchronously (like onAuthoringChange).
 */
class FakeModel {
  constructor() {
    this.elements = new Map();
    this.listeners = new Set();
    this.notices = [];
    this.levels = [];
    this.seq = 0;
  }
  listElements() {
    return [...this.elements.values()].map((e) => JSON.parse(JSON.stringify(e)));
  }
  getElement(id) {
    const e = this.elements.get(id);
    return e ? JSON.parse(JSON.stringify(e)) : null;
  }
  getLevels() {
    return this.levels.map((id) => ({ id }));
  }
  getActiveWorksetId() {
    return "ws-arch";
  }
  applyRemoteFields(id, fields) {
    const el = this.elements.get(id);
    if (!el) return { ok: false, reason: "element_not_found" };
    const skipped = [];
    for (const [k, v] of Object.entries(fields)) {
      if (k === "type") continue;
      if (k === "name") { el.name = String(v); continue; }
      if (k === "hostId") { el.hostId = String(v); continue; }
      if ((k === "baseLevelId" || k === "topLevelId") && v && !this.levels.includes(String(v))) {
        skipped.push(k);
        continue;
      }
      el.params[k] = JSON.parse(JSON.stringify(v));
    }
    this.emit();
    return { ok: true, skippedFields: skipped };
  }
  async createElementFromCentral(fields) {
    const type = String(fields.type || "");
    if (!["wall", "column", "beam", "slab", "door", "window"].includes(type)) return null;
    const id = `local-${++this.seq}-${type}`;
    const params = {};
    for (const k of ["start", "end", "point", "polygon", "height", "thickness", "elevation", "width", "depth", "rotation"]) {
      if (fields[k] !== undefined) params[k] = JSON.parse(JSON.stringify(fields[k]));
    }
    this.elements.set(id, {
      id, type, name: String(fields.name || type),
      hostId: typeof fields.hostId === "string" ? fields.hostId : undefined,
      params,
    });
    this.emit();
    return id;
  }
  removeElementLocal(id) {
    const ok = this.elements.delete(id);
    if (ok) this.emit();
    return ok;
  }
  subscribeLocalChanges(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  isLocallyLocked() {
    return null;
  }
  onNotice(kind, message) {
    this.notices.push({ kind, message });
  }
  emit() {
    for (const cb of [...this.listeners]) {
      try { cb(); } catch { /* ignore */ }
    }
  }
  // Test helpers: direct local authoring (what the user does in the app).
  createLocal(id, type, params, name) {
    this.elements.set(id, { id, type, name: name || type, params: { ...params } });
    this.emit();
    return id;
  }
  editLocal(id, patch) {
    const el = this.elements.get(id);
    if (!el) throw new Error("no such local element " + id);
    Object.assign(el.params, patch);
    this.emit();
  }
  deleteLocal(id) {
    this.elements.delete(id);
    this.emit();
  }
  findByType(type) {
    return [...this.elements.values()].find((e) => e.type === type) || null;
  }
}

(async () => {
  console.log("\n=== Central binding integration tests (two real bindings, real server) ===\n");

  // Compile the shipped binding + client to CJS for the Node test bindings.
  execSync(
    "npx tsc --rootDir src --outDir " + JSON.stringify(compileDir) +
    " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck" +
    " src/modules/collaboration/central-binding.ts src/modules/collaboration/central-client.ts",
    { cwd: root, stdio: "pipe", shell: true },
  );
  const { CentralBinding, elementToCentralFields, diffFields } = require(path.join(compileDir, "modules/collaboration/central-binding.js"));
  const { CentralClient } = require(path.join(compileDir, "modules/collaboration/central-client.js"));

  let server = await spawnServer();
  console.log("  server on port " + server.port + ", data dir " + dataDir);
  const room = "binding-room-1";
  const api = async (p, { method = "GET", body } = {}) => {
    const r = await fetch(`${server.base}/central/${room}${p}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, ...data };
  };

  const mkBinding = (name) => {
    const model = new FakeModel();
    const client = new CentralClient((url) => new NodeSseReader(url));
    globalThis.__OPENBIM_COLLAB_API__ = server.base;
    const binding = new CentralBinding(client, model);
    const conflicts = [];
    binding.subscribeConflicts((c) => conflicts.push(...c));
    return { binding, model, client, conflicts, name };
  };

  let alice, bob;
  try {
    await t("field mapping: only sync keys travel, type/name/hostId included", async () => {
      const fields = elementToCentralFields({
        id: "w1", type: "wall", name: "Wall 1", hostId: undefined,
        params: { height: 3, thickness: 0.2, start: [0, 0], end: [4, 0], sweeps: [{ a: 1 }], length: 4 },
      });
      assert.strictEqual(fields.type, "wall");
      assert.strictEqual(fields.name, "Wall 1");
      assert.strictEqual(fields.height, 3);
      assert.deepStrictEqual(fields.start, [0, 0]);
      assert.strictEqual(fields.sweeps, undefined, "unsynced params must not travel");
      assert.strictEqual(fields.length, undefined, "derived length must not travel");
      const d = diffFields({ height: 3, thickness: 0.2, name: "Wall 1" }, { height: 3.3, thickness: 0.2, name: "Wall 1" });
      assert.deepStrictEqual(d, { height: 3.3 });
    });

    await t("two bindings join the same room; first is owner, second editor", async () => {
      alice = mkBinding("Alice");
      bob = mkBinding("Bob");
      assert.strictEqual(await alice.binding.join(room, "Alice"), true);
      assert.strictEqual(await bob.binding.join(room, "Bob"), true);
      assert.strictEqual(alice.binding.getStatus().members.find((m) => m.name === "Alice").role, "owner");
      assert.strictEqual(bob.binding.getStatus().members.find((m) => m.name === "Bob").role, "editor");
    });

    await t("local create on A materialises on B under a fresh local id", async () => {
      alice.model.createLocal("wall-a1", "wall", { height: 3, thickness: 0.2, elevation: 0, start: [0, 0], end: [4, 0] }, "Wall A1");
      const created = await waitFor(() => {
        const w = bob.model.findByType("wall");
        return w && w.params.height === 3 ? w : null;
      }, 15000, "B to materialise A's wall");
      assert.notStrictEqual(created.id, "wall-a1", "B's local id differs from the central id");
      assert.strictEqual(bob.binding.toCentralId(created.id), "wall-a1");
      assert.strictEqual(alice.binding.toCentralId("wall-a1"), "wall-a1");
      const s = await api("/state");
      assert.strictEqual(s.elements["wall-a1"].fields.height, 3);
    });

    await t("local edit on A propagates to B's model", async () => {
      alice.model.editLocal("wall-a1", { height: 3.3 });
      await waitFor(() => {
        const w = bob.model.findByType("wall");
        return w && w.params.height === 3.3 ? w : null;
      }, 15000, "B to see height 3.3");
      const s = await api("/state");
      assert.strictEqual(s.elements["wall-a1"].fields.height, 3.3);
    });

    await t("same element, different fields, merges through the bindings", async () => {
      const bobWall = bob.model.findByType("wall");
      alice.model.editLocal("wall-a1", { height: 3.6 });
      bob.model.editLocal(bobWall.id, { thickness: 0.3 });
      await waitFor(async () => {
        const s = await api("/state");
        const f = s.elements["wall-a1"] && s.elements["wall-a1"].fields;
        return f && f.height === 3.6 && f.thickness === 0.3 ? f : null;
      }, 15000, "merged fields on the server");
      await waitFor(() => {
        const w = bob.model.findByType("wall");
        return w && w.params.height === 3.6 && w.params.thickness === 0.3 ? w : null;
      }, 15000, "B to see the merged fields");
      assert.strictEqual(bob.conflicts.length, 0, "no conflict for different fields");
    });

    await t("borrow by B: A's guard refuses with B's name; a bypassed push 409s and reverts", async () => {
      const bobWall = bob.model.findByType("wall");
      const r = await bob.binding.borrow(bobWall.id);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      await waitFor(() => alice.binding.getStatus().borrows["wall-a1"], 5000, "A to see the borrow");
      const g = alice.binding.checkEditAllowed("wall-a1");
      assert.strictEqual(g.allowed, false);
      assert.match(g.reason, /Bob/, "reason names the borrower: " + g.reason);
      // An edit that bypasses the guard (e.g. a stale UI) still hits the
      // server-side 409 and is reverted locally.
      alice.model.editLocal("wall-a1", { height: 9.9 });
      await waitFor(() => {
        const w = alice.model.getElement("wall-a1");
        return w && w.params.height === 3.6 ? w : null;
      }, 15000, "A's bypassed edit to be reverted to 3.6");
      const s = await api("/state");
      assert.strictEqual(s.elements["wall-a1"].fields.height, 3.6);
      const rel = await bob.binding.relinquish(bobWall.id);
      assert.strictEqual(rel.ok, true, JSON.stringify(rel));
      await waitFor(() => !alice.binding.getStatus().borrows["wall-a1"], 5000, "borrow to clear");
      assert.strictEqual(alice.binding.checkEditAllowed("wall-a1").allowed, true);
    });

    await t("workset owned by A: B's guard refuses with the workset reason", async () => {
      const s0 = await api("/state");
      const owner = Object.values(s0.members).find((m) => m.name === "Alice").clientId;
      const r = await api("/workset-owner", { method: "POST", body: { clientId: owner, worksetId: "ws-arch", owner } });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      await bob.binding.client.fetchState();
      await alice.binding.client.fetchState();
      const g = bob.binding.checkEditAllowed(bob.model.findByType("wall").id);
      assert.strictEqual(g.allowed, false);
      assert.match(g.reason, /workset/i, "reason names the workset: " + g.reason);
      const r2 = await api("/workset-owner", { method: "POST", body: { clientId: owner, worksetId: "ws-arch", owner: null } });
      assert.strictEqual(r2.ok, true, JSON.stringify(r2));
      await bob.binding.client.fetchState();
      assert.strictEqual(bob.binding.checkEditAllowed(bob.model.findByType("wall").id).allowed, true);
    });

    await t("genuine conflict via offline replay: server value wins, both converge, conflict surfaced", async () => {
      const bobWall = bob.model.findByType("wall");
      // Bob goes offline: his push fails and queues with a stale baseRevision.
      globalThis.__OPENBIM_COLLAB_API__ = "http://127.0.0.1:1/api";
      bob.model.editLocal(bobWall.id, { height: 3.9 });
      await sleep(1500); // debounce (400ms) + failed push + queue
      globalThis.__OPENBIM_COLLAB_API__ = server.base;
      // Alice lands first.
      alice.model.editLocal("wall-a1", { height: 3.3 });
      await waitFor(async () => {
        const s = await api("/state");
        return s.elements["wall-a1"].fields.height === 3.3;
      }, 15000, "Alice's 3.3 to land");
      // Bob reconnects and replays: stale base -> conflict, server keeps 3.3.
      await bob.binding.syncNow();
      await waitFor(() => bob.conflicts.length >= 1, 15000, "conflict to surface on Bob");
      const c = bob.conflicts[bob.conflicts.length - 1];
      assert.strictEqual(c.field, "height");
      assert.strictEqual(c.attemptedValue, 3.9);
      assert.strictEqual(c.winningValue, 3.3);
      await waitFor(() => {
        const w = bob.model.findByType("wall");
        return w && w.params.height === 3.3 ? w : null;
      }, 15000, "Bob to converge to 3.3");
      assert.strictEqual(alice.model.getElement("wall-a1").params.height, 3.3);
      const s = await api("/state");
      assert.strictEqual(s.openConflictCount, 1);
      // Resolve with 'mine' (Bob's 3.9) through the binding: both converge.
      const rr = await bob.binding.resolveConflict(c.id, "mine");
      assert.strictEqual(rr.ok, true, JSON.stringify(rr));
      await waitFor(async () => {
        const s2 = await api("/state");
        return s2.elements["wall-a1"].fields.height === 3.9;
      }, 15000, "resolution to land");
      await waitFor(() => {
        const w = alice.model.getElement("wall-a1");
        return w && w.params.height === 3.9 ? w : null;
      }, 15000, "Alice to see the resolved 3.9");
    });

    await t("offline queue replays exactly once (one journal entry per opId)", async () => {
      const before = await api("/history?limit=200");
      const bobWall = bob.model.findByType("wall");
      globalThis.__OPENBIM_COLLAB_API__ = "http://127.0.0.1:1/api";
      bob.model.editLocal(bobWall.id, { thickness: 0.25 });
      await sleep(1500);
      globalThis.__OPENBIM_COLLAB_API__ = server.base;
      await bob.binding.syncNow();
      await bob.binding.syncNow(); // second flush must not double-apply
      await waitFor(async () => {
        const s = await api("/state");
        return s.elements["wall-a1"].fields.thickness === 0.25;
      }, 15000, "replayed thickness to land");
      const after = await api("/history?limit=200");
      const ups = after.entries.filter((e) => e.kind === "upsert-element" && e.payload && e.payload.fields && e.payload.fields.thickness === 0.25);
      assert.strictEqual(ups.length, 1, "exactly one journal entry for the replayed op, got " + ups.length);
      assert.strictEqual(before.entries.length + 1 <= after.entries.length, true);
    });

    await t("remote delete on A removes the element on B", async () => {
      alice.model.createLocal("wall-a2", "wall", { height: 2.6, thickness: 0.2, elevation: 0, start: [0, 0], end: [2, 0] }, "Wall A2");
      await waitFor(() => bob.model.listElements().some((e) => e.type === "wall" && e.params.height === 2.6), 15000, "B to materialise wall-a2");
      alice.model.deleteLocal("wall-a2");
      await waitFor(() => !bob.model.listElements().some((e) => e.params.height === 2.6), 15000, "B to drop wall-a2");
      const s = await api("/state");
      assert.strictEqual(s.elements["wall-a2"], undefined);
    });

    await t("join divergence: central wins and a notice is emitted", async () => {
      // Carol joins with a stale local copy of wall-a1 (height 2.0).
      const carol = mkBinding("Carol");
      carol.model.createLocal("wall-a1", "wall", { height: 2.0, thickness: 0.2, elevation: 0, start: [0, 0], end: [4, 0] }, "Wall A1");
      assert.strictEqual(await carol.binding.join(room, "Carol"), true);
      await waitFor(() => {
        const w = carol.model.getElement("wall-a1");
        return w && w.params.height === 3.9 ? w : null;
      }, 15000, "Carol's stale wall to be overwritten by central 3.9");
      assert.ok(carol.model.notices.some((n) => /central/i.test(n.message)), "a central-wins notice was emitted: " + JSON.stringify(carol.model.notices));
      assert.strictEqual(carol.binding.toCentralId("wall-a1"), "wall-a1");
      carol.binding.stop();
    });

    await t("unappliable level constraint is pinned, never echoed back", async () => {
      // Alice's wall gains a baseLevelId for a level Bob's project lacks.
      const s0 = await api("/state");
      const aliceId = Object.values(s0.members).find((m) => m.name === "Alice").clientId;
      const r = await api("/op", {
        method: "POST",
        body: { clientId: aliceId, opId: "op-level-1", type: "upsert", elementId: "wall-a1", fields: { baseLevelId: "level-99" }, baseRevision: s0.revision },
      });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      await waitFor(() => {
        const w = bob.model.findByType("wall");
        return w && w.params.baseLevelId === undefined;
      }, 5000, "Bob keeps no baseLevelId");
      // Bob's next push (an unrelated edit) must NOT carry baseLevelId back.
      const bobWall = bob.model.findByType("wall");
      bob.model.editLocal(bobWall.id, { height: 4.0 });
      await waitFor(async () => {
        const s = await api("/state");
        return s.elements["wall-a1"].fields.height === 4.0;
      }, 15000, "Bob's height edit to land");
      const s = await api("/state");
      assert.strictEqual(s.elements["wall-a1"].fields.baseLevelId, "level-99", "the pinned field was not echoed back over central");
      assert.strictEqual(s.elements["wall-a1"].fields.height, 4.0);
    });

    await t("unrelated remote op does not revert an unpushed local edit (regression)", async () => {
      // Bob edits height; before his 400 ms push debounce fires, Alice
      // lands an unrelated thickness op. The remote apply must leave
      // Bob's pending height edit alone — it used to overwrite it with
      // the stale central value (local-vs-central diff), silently
      // discarding the edit so the push then had nothing to send.
      const bobWall = bob.model.findByType("wall");
      const s0 = await api("/state");
      const aliceId = Object.values(s0.members).find((m) => m.name === "Alice").clientId;
      bob.model.editLocal(bobWall.id, { height: 4.4 });
      const r = await api("/op", {
        method: "POST",
        body: { clientId: aliceId, opId: "op-remote-thickness-1", type: "upsert", elementId: "wall-a1", fields: { thickness: 0.3 }, baseRevision: s0.revision },
      });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      // The remote apply has run once Bob's model shows the new thickness.
      await waitFor(() => {
        const w = bob.model.findByType("wall");
        return w && w.params.thickness === 0.3 ? w : null;
      }, 5000, "Bob to apply the remote thickness");
      assert.strictEqual(bob.model.findByType("wall").params.height, 4.4, "pending local edit survives the unrelated remote op");
      await waitFor(async () => {
        const s = await api("/state");
        return s.elements["wall-a1"].fields.height === 4.4;
      }, 15000, "Bob's preserved edit to push");
      const s = await api("/state");
      assert.strictEqual(s.elements["wall-a1"].fields.thickness, 0.3, "the remote field was not reverted by Bob's push");
    });
  } finally {
    try { alice && alice.binding.stop(); } catch { /* ignore */ }
    try { bob && bob.binding.stop(); } catch { /* ignore */ }
    await killServer(server);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\ncentral-binding: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("FAILED:\n  " + failures.join("\n  "));
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
