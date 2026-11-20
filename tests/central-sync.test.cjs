/**
 * Central sync integration tests — two REAL clients against a REAL server.
 *
 * Spawns server/index.mjs on an ephemeral loopback port with an isolated
 * data dir (under this repo's work dir, not /tmp) and drives it with:
 *  - two compiled CentralClient instances (src/modules/collaboration/
 *    central-client.ts, compiled to CJS here) with an injected Node SSE
 *    reader, and
 *  - raw fetch clients for duplicate-delivery, disconnect/reconnect and
 *    SSE-broadcast scenarios.
 *
 * No mock clients, no mock server: every assertion below observes the
 * spawned server's persisted state (snapshot + journal + audit files).
 *
 * Run: node tests/central-sync.test.cjs
 */
const assert = require("assert");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
// Keep all scratch inside the work tree: /tmp is a shared 512 MB tmpfs.
const workDir = fs.mkdtempSync(path.join(__dirname, "..", ".central-sync-test-"));
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

/** Minimal EventSource-compatible reader over Node http (for the client factory). */
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

async function waitFor(fn, timeoutMs = 10000, label = "condition") {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for " + label);
    await new Promise((r) => setTimeout(r, 100));
  }
}

(async () => {
  console.log("\n=== Central sync integration tests (real server, two real clients) ===\n");

  // Compile the shipped browser client to CJS for the Node test clients.
  execSync(
    "npx tsc --rootDir src --outDir " + JSON.stringify(compileDir) +
    " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck" +
    " src/modules/collaboration/central-client.ts",
    { cwd: root, stdio: "pipe", shell: true },
  );
  const { CentralClient } = require(path.join(compileDir, "modules/collaboration/central-client.js"));

  let server = await spawnServer();
  console.log("  server on port " + server.port + ", data dir " + dataDir);
  const room = "sync-room-1";
  const central = (p) => `${server.base}/central/${room}${p}`;

  const api = async (p, { method = "GET", body } = {}) => {
    const r = await fetch(central(p), {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, ...data };
  };
  const op = (clientId, opId, elementId, fields, baseRevision, type = "upsert") =>
    api("/op", { method: "POST", body: { clientId, opId, type, elementId, fields, baseRevision } });

  const mkClient = (name) => {
    const c = new CentralClient((url) => new NodeSseReader(url));
    globalThis.__OPENBIM_COLLAB_API__ = server.base;
    return c;
  };

  let alice, bob;
  try {
    await t("two compiled clients join the same room; first is owner, second editor", async () => {
      alice = mkClient("Alice");
      bob = mkClient("Bob");
      assert.strictEqual(await alice.join(room, "Alice"), true);
      assert.strictEqual(await bob.join(room, "Bob"), true);
      assert.strictEqual(alice.state.members[alice.clientId].role, "owner");
      assert.strictEqual(bob.state.members[bob.clientId].role, "editor");
      assert.ok(alice.state.worksets["ws-arch"], "default worksets seeded");
    });

    await t("concurrent edits to different elements converge on both clients", async () => {
      const r1 = await alice.upsertElement("wall-1", { height: 3000, name: "W1" });
      assert.strictEqual(r1.ok, true, JSON.stringify(r1));
      const r2 = await bob.upsertElement("wall-2", { height: 2500, name: "W2" });
      assert.strictEqual(r2.ok, true, JSON.stringify(r2));
      await waitFor(async () => {
        const s = await api("/state");
        return s.elements["wall-1"] && s.elements["wall-2"] ? s : null;
      }, 5000, "both elements visible");
      await alice.fetchState();
      await bob.fetchState();
      assert.strictEqual(alice.state.elements["wall-1"].fields.height, 3000);
      assert.strictEqual(alice.state.elements["wall-2"].fields.height, 2500);
      assert.strictEqual(bob.state.elements["wall-1"].fields.height, 3000);
      assert.strictEqual(alice.revision, bob.revision, "revisions agree");
    });

    await t("concurrent edits to the same element, different fields, merge", async () => {
      const base = (await api("/state")).revision;
      const ra = await op(alice.clientId, "op-merge-a", "wall-1", { height: 3200 }, base);
      assert.strictEqual(ra.ok, true, JSON.stringify(ra));
      const rb = await op(bob.clientId, "op-merge-b", "wall-1", { name: "W1-renamed" }, base);
      assert.strictEqual(rb.ok, true, JSON.stringify(rb));
      assert.strictEqual(rb.conflicts.length, 0);
      const s = await api("/state");
      assert.strictEqual(s.elements["wall-1"].fields.height, 3200);
      assert.strictEqual(s.elements["wall-1"].fields.name, "W1-renamed");
    });

    let conflictId;
    await t("concurrent edits to the same element, same field, conflict: server value wins, both values recorded", async () => {
      const base = (await api("/state")).revision;
      const ra = await op(alice.clientId, "op-conf-a", "wall-1", { height: 3300 }, base);
      assert.strictEqual(ra.ok, true, JSON.stringify(ra));
      const rb = await op(bob.clientId, "op-conf-b", "wall-1", { height: 3900 }, base);
      assert.strictEqual(rb.ok, true, JSON.stringify(rb));
      assert.strictEqual(rb.conflicts.length, 1);
      assert.strictEqual(rb.conflicts[0].field, "height");
      assert.strictEqual(rb.conflicts[0].attemptedValue, 3900);
      assert.strictEqual(rb.conflicts[0].winningValue, 3300);
      conflictId = rb.conflicts[0].id;
      const s = await api("/state");
      assert.strictEqual(s.elements["wall-1"].fields.height, 3300);
      assert.strictEqual(s.openConflictCount, 1);
      await alice.fetchState();
      await bob.fetchState();
      assert.strictEqual(alice.state.elements["wall-1"].fields.height, 3300);
      assert.strictEqual(bob.state.elements["wall-1"].fields.height, 3300);
    });

    await t("conflict resolution with 'mine' applies the loser's value as a new revision", async () => {
      const r = await api("/resolve", { method: "POST", body: { clientId: bob.clientId, conflictId, choice: "mine" } });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      const s = await api("/state");
      assert.strictEqual(s.elements["wall-1"].fields.height, 3900);
      assert.strictEqual(s.openConflictCount, 0);
    });

    await t("duplicate transaction delivery applies exactly once", async () => {
      const before = await api("/state");
      const r1 = await op(alice.clientId, "op-dup-1", "wall-3", { height: 2800 }, before.revision);
      assert.strictEqual(r1.ok, true, JSON.stringify(r1));
      const r2 = await op(alice.clientId, "op-dup-1", "wall-3", { height: 9999 }, before.revision);
      assert.strictEqual(r2.ok, true, JSON.stringify(r2));
      assert.strictEqual(r2.duplicate, true);
      const after = await api("/state");
      assert.strictEqual(after.revision, before.revision + 1, "revision advanced exactly once");
      assert.strictEqual(after.elements["wall-3"].fields.height, 2800);
      const hist = await api("/history?limit=500");
      assert.strictEqual(hist.entries.filter((e) => e.opId === "op-dup-1").length, 1);
    });

    await t("borrowing is enforced across clients; request + grant unblocks", async () => {
      const carol = mkClient("Carol");
      assert.strictEqual(await carol.join(room, "Carol"), true);
      const b1 = await api("/borrow", { method: "POST", body: { clientId: bob.clientId, elementId: "wall-2" } });
      assert.strictEqual(b1.ok, true, JSON.stringify(b1));
      const blocked = await op(alice.clientId, "op-borrow-blocked", "wall-2", { height: 2600 }, (await api("/state")).revision);
      assert.strictEqual(blocked.ok, false);
      assert.strictEqual(blocked.status, 409);
      const req = await api("/borrow-request", { method: "POST", body: { clientId: alice.clientId, elementId: "wall-2" } });
      assert.strictEqual(req.ok, true, JSON.stringify(req));
      const reqId = req.entry.applied.requestId;
      const denied = await api("/borrow-respond", { method: "POST", body: { clientId: carol.clientId, requestId: reqId, grant: true } });
      assert.strictEqual(denied.ok, false, "a bystander who is neither current owner nor room owner must not grant");
      assert.strictEqual(denied.status, 403);
      const grant = await api("/borrow-respond", { method: "POST", body: { clientId: bob.clientId, requestId: reqId, grant: true } });
      assert.strictEqual(grant.ok, true, JSON.stringify(grant));
      const ok = await op(alice.clientId, "op-borrow-after-grant", "wall-2", { height: 2600 }, (await api("/state")).revision);
      assert.strictEqual(ok.ok, true, JSON.stringify(ok));
      const rel = await api("/relinquish", { method: "POST", body: { clientId: alice.clientId, elementId: "wall-2" } });
      assert.strictEqual(rel.ok, true, JSON.stringify(rel));
      carol.stop();
    });

    await t("permissions: a viewer cannot edit; the owner restores editor rights", async () => {
      const set = await api("/role", { method: "POST", body: { clientId: alice.clientId, targetClientId: bob.clientId, role: "viewer" } });
      assert.strictEqual(set.ok, true, JSON.stringify(set));
      const denied = await op(bob.clientId, "op-viewer-denied", "wall-1", { height: 1111 }, (await api("/state")).revision);
      assert.strictEqual(denied.ok, false);
      assert.strictEqual(denied.status, 403);
      const back = await api("/role", { method: "POST", body: { clientId: alice.clientId, targetClientId: bob.clientId, role: "editor" } });
      assert.strictEqual(back.ok, true, JSON.stringify(back));
      const ok = await op(bob.clientId, "op-editor-again", "wall-1", { name: "W1-final" }, (await api("/state")).revision);
      assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    });

    await t("workset ownership blocks edits until cleared by the owner", async () => {
      const ws = await api("/workset", { method: "POST", body: { clientId: alice.clientId, name: "Structure North", kind: "user-workset" } });
      assert.strictEqual(ws.ok, true, JSON.stringify(ws));
      const wsId = ws.entry.applied.worksetId;
      const own = await api("/workset-owner", { method: "POST", body: { clientId: alice.clientId, worksetId: wsId, owner: alice.clientId } });
      assert.strictEqual(own.ok, true, JSON.stringify(own));
      // Move wall-3 into the owned workset.
      const mv = await api("/op", { method: "POST", body: { clientId: alice.clientId, opId: "op-move-ws2", type: "upsert", elementId: "wall-3", fields: { height: 2800 }, worksetId: wsId, baseRevision: (await api("/state")).revision } });
      assert.strictEqual(mv.ok, true, JSON.stringify(mv));
      const blocked = await op(bob.clientId, "op-ws-blocked", "wall-3", { height: 2900 }, (await api("/state")).revision);
      assert.strictEqual(blocked.ok, false);
      assert.strictEqual(blocked.status, 409);
      const clear = await api("/workset-owner", { method: "POST", body: { clientId: alice.clientId, worksetId: wsId, owner: null } });
      assert.strictEqual(clear.ok, true, JSON.stringify(clear));
      const ok = await op(bob.clientId, "op-ws-after-clear", "wall-3", { height: 2900 }, (await api("/state")).revision);
      assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    });

    await t("live SSE broadcast: a second client receives the other client's op", async () => {
      const seen = [];
      const reader = new NodeSseReader(`${server.base}/rooms/${room}/events`);
      reader.addEventListener("central-op", (ev) => {
        try { seen.push(JSON.parse(ev.data)); } catch { /* ignore */ }
      });
      await new Promise((r) => setTimeout(r, 500)); // let the stream open
      const before = (await api("/state")).revision;
      const r = await op(alice.clientId, "op-sse-1", "wall-4", { height: 2100 }, before);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      await waitFor(() => seen.some((e) => e.opId === "op-sse-1"), 8000, "central-op event");
      const ev = seen.find((e) => e.opId === "op-sse-1");
      assert.strictEqual(ev.seq, before + 1);
      reader.close();
    });

    await t("disconnect/reconnect: a client that missed ops catches up via /sync", async () => {
      // Bob's raw client records its revision, then "goes dark" (no requests).
      const revBefore = (await api("/state")).revision;
      const r1 = await op(alice.clientId, "op-missed-1", "wall-5", { height: 2000 }, revBefore);
      const r2 = await op(alice.clientId, "op-missed-2", "wall-5", { name: "W5" }, r1.revision);
      assert.strictEqual(r2.ok, true, JSON.stringify(r2));
      const sync = await api(`/sync?since=${revBefore}`);
      assert.strictEqual(sync.ok, true, JSON.stringify(sync));
      assert.strictEqual(sync.truncated, false);
      assert.strictEqual(sync.entries.length, 2);
      assert.deepStrictEqual(sync.entries.map((e) => e.opId), ["op-missed-1", "op-missed-2"]);
      // A client starting from scratch gets the whole retained journal.
      const fromZero = await api("/sync?since=0");
      assert.strictEqual(fromZero.truncated, false, "nothing compacted yet, so seq 0 is still covered");
      assert.strictEqual(fromZero.entries.length, fromZero.revision, "one entry per sequence number");
      assert.ok(fromZero.state === undefined, "no full-state fallback needed while the window covers the request");
    });

    let revBeforeRestart;
    await t("server restart mid-session: state, journal and membership survive", async () => {
      revBeforeRestart = (await api("/state")).revision;
      await killServer(server);
      server = await spawnServer();
      // Same data dir: the respawned server must recover the same revision.
      const s = await api("/state");
      assert.strictEqual(s.revision, revBeforeRestart);
      assert.strictEqual(s.elements["wall-1"].fields.height, 3900);
      assert.strictEqual(s.elements["wall-2"].fields.height, 2600);
      assert.strictEqual(s.members[alice.clientId].role, "owner");
      // The journal file on disk holds the full op history.
      const journal = fs.readFileSync(path.join(dataDir, "central", room, "journal.jsonl"), "utf8")
        .trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(journal.length >= revBeforeRestart, `journal ${journal.length} lines vs revision ${revBeforeRestart}`);
      assert.strictEqual(journal[journal.length - 1].seq, revBeforeRestart);
      // Clients re-join and keep working against the recovered server.
      globalThis.__OPENBIM_COLLAB_API__ = server.base;
      assert.strictEqual(await alice.join(room, "Alice"), true);
      assert.strictEqual(await bob.join(room, "Bob"), true);
      assert.strictEqual(alice.state.members[alice.clientId].role, "owner");
      const r = await alice.upsertElement("wall-6", { height: 2400 });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      const s2 = await api("/state");
      assert.strictEqual(s2.revision, revBeforeRestart + 3, "join x2 + 1 op after restart");
      assert.strictEqual(s2.elements["wall-6"].fields.height, 2400);
    });

    await t("version history lists entries; restore reverts to an earlier revision", async () => {
      const histBefore = await api("/history?limit=500");
      assert.ok(histBefore.entries.length >= 10, "history holds " + histBefore.entries.length);
      const targetRev = (await api("/state")).revision;
      const edit = await op(alice.clientId, "op-restore-edit", "wall-6", { height: 9999 }, targetRev);
      assert.strictEqual(edit.ok, true, JSON.stringify(edit));
      assert.strictEqual((await api("/state")).elements["wall-6"].fields.height, 9999);
      const rst = await api("/restore", { method: "POST", body: { clientId: alice.clientId, revision: targetRev } });
      assert.strictEqual(rst.ok, true, JSON.stringify(rst));
      const s = await api("/state");
      assert.strictEqual(s.elements["wall-6"].fields.height, 2400);
      assert.ok(s.revision > targetRev + 1, "restore is a new revision, history is not rewritten");
      const histAfter = await api("/history?limit=500");
      assert.strictEqual(histAfter.entries[histAfter.entries.length - 1].kind, "restore");
      const sameRev = await api("/restore", { method: "POST", body: { clientId: alice.clientId, revision: (await api("/state")).revision } });
      assert.strictEqual(sameRev.ok, false);
      assert.strictEqual(sameRev.status, 400);
    });

    await t("audit trail records accepted ops, rejections and role changes", async () => {
      const audit = await api("/audit?limit=500");
      assert.strictEqual(audit.ok, true, JSON.stringify(audit));
      const actions = audit.entries.map((e) => e.action);
      assert.ok(actions.includes("upsert_element"), "accepted ops audited");
      assert.ok(actions.includes("rejected"), "rejections audited: " + actions.join(","));
      assert.ok(actions.includes("set_role"), "role changes audited");
      const rejected = audit.entries.filter((e) => e.action === "rejected");
      assert.ok(rejected.length >= 2, "at least 2 rejections recorded, got " + rejected.length);
      // The audit file on disk is append-only and non-empty.
      const auditFile = fs.readFileSync(path.join(dataDir, "central", room, "audit.jsonl"), "utf8");
      assert.ok(auditFile.trim().split("\n").length >= audit.entries.length);
    });

    await t("offline queue: an op submitted while disconnected replays once on reconnect", async () => {
      // Simulate the offline path at the protocol level: the same opId is
      // delivered twice (client retry after a dropped ack). The server
      // dedupes, so the effect lands exactly once.
      const before = await api("/state");
      const body = {
        clientId: alice.clientId, opId: "op-offline-1", type: "upsert",
        elementId: "wall-7", fields: { height: 2300 }, baseRevision: before.revision,
      };
      const r1 = await api("/op", { method: "POST", body });
      assert.strictEqual(r1.ok, true, JSON.stringify(r1));
      const r2 = await api("/op", { method: "POST", body });
      assert.strictEqual(r2.duplicate, true);
      const after = await api("/state");
      assert.strictEqual(after.revision, before.revision + 1);
      assert.strictEqual(after.elements["wall-7"].fields.height, 2300);
      // The shipped client's queue API exists and flushes (unit-level check
      // against the live server with a queued op while disconnected).
      const ghost = new CentralClient((url) => new NodeSseReader(url));
      globalThis.__OPENBIM_COLLAB_API__ = server.base;
      ghost.roomId = room;
      ghost.clientId = alice.clientId;
      ghost.state = await ghost.fetchState();
      ghost.revision = ghost.state.revision;
      const queued = ghost.upsertElement("wall-8", { height: 2200 });
      // Not connected: the promise only resolves when the queue flushes.
      const flushed = await Promise.race([
        queued.then((r) => ({ done: true, r })),
        new Promise((res) => setTimeout(() => res({ done: false }), 500)),
      ]);
      assert.strictEqual(flushed.done, false, "queued op must wait for reconnect");
      ghost.connected = true; // simulate reconnect (stream open path)
      await ghost.flushQueue();
      const done = await Promise.race([
        queued.then((r) => ({ done: true, r })),
        new Promise((res) => setTimeout(() => res({ done: false }), 5000)),
      ]);
      assert.strictEqual(done.done, true, "queued op resolved after flush");
      assert.strictEqual(done.r.ok, true, JSON.stringify(done.r));
      const s = await api("/state");
      assert.strictEqual(s.elements["wall-8"].fields.height, 2200);
    });
    await t("journal compaction: a client behind the retained window gets full state, and old revisions refuse restore", async () => {
      const dataDir2 = path.join(workDir, "data-compact");
      fs.mkdirSync(dataDir2, { recursive: true });
      const s2 = await spawnServer({ OBS_DATA_DIR: dataDir2, OBS_CENTRAL_JOURNAL_MAX: "10" });
      try {
        const room2 = "compact-room";
        const c2 = (p) => `${s2.base}/central/${room2}${p}`;
        const a2 = async (p, { method = "GET", body } = {}) => {
          const r = await fetch(c2(p), {
            method,
            headers: { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          return { status: r.status, ok: r.ok, ...(await r.json().catch(() => ({}))) };
        };
        const j = await a2("/join", { method: "POST", body: { clientId: "u-compact", name: "Compact" } });
        assert.strictEqual(j.ok, true, JSON.stringify(j));
        let rev = j.revision;
        for (let i = 1; i <= 15; i++) {
          const r = await a2("/op", { method: "POST", body: { clientId: "u-compact", opId: `op-c-${i}`, type: "upsert", elementId: `el-${i}`, fields: { n: i }, baseRevision: rev } });
          assert.strictEqual(r.ok, true, JSON.stringify(r));
          rev = r.revision;
        }
        // Journal on disk holds exactly the retained window.
        const lines = fs.readFileSync(path.join(dataDir2, "central", room2, "journal.jsonl"), "utf8").trim().split("\n");
        assert.strictEqual(lines.length, 10, "journal compacted to 10 entries, got " + lines.length);
        const stale = await a2("/sync?since=0");
        assert.strictEqual(stale.truncated, true, "seq 0 is outside the retained window");
        assert.ok(stale.state, "truncated sync carries the full state");
        assert.strictEqual(Object.keys(stale.state.elements).length, 15, "full state still has all 15 elements");
        const fresh = await a2(`/sync?since=${rev}`);
        assert.strictEqual(fresh.truncated, false);
        assert.strictEqual(fresh.entries.length, 0);
        const tooOld = await a2("/restore", { method: "POST", body: { clientId: "u-compact", revision: 2 } });
        assert.strictEqual(tooOld.ok, false, "restore before the retained window must refuse");
        assert.strictEqual(tooOld.status, 400);
      } finally {
        await killServer(s2);
      }
    });
  } finally {
    try { if (alice) alice.stop(); } catch { /* ignore */ }
    try { if (bob) bob.stop(); } catch { /* ignore */ }
    await killServer(server);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\ncentral-sync: ${pass} passed, ${fail} failed`);
  if (fail) {
    for (const f of failures) console.log("  FAILED: " + f);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
