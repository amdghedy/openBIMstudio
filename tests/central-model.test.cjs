/**
 * Central model unit tests — server-authoritative worksharing state machine.
 *
 * Pure module tests (no server, no I/O): the merge, borrowing, permission,
 * conflict and restore rules in server/central-model.mjs.
 * Run: node tests/central-model.test.cjs
 */
const assert = require("assert");

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log("  PASS " + name);
  } catch (e) {
    fail++;
    failures.push(name + ": " + e.message);
    console.log("  FAIL " + name + ": " + e.message);
  }
}

function apply(state, r) {
  if (r.error) throw new Error("unexpected error: " + JSON.stringify(r.error));
  if (r.duplicate) throw new Error("unexpected duplicate");
  const m = global.__model;
  m.applyEffects(state, r.effects);
  state.revision = r.entry.seq;
  return r.entry;
}

(async () => {
  const m = await import("../server/central-model.mjs");
  global.__model = m;
  console.log("\n=== Central model tests ===\n");

  function freshRoom() {
    const s = m.emptyState("room-1");
    apply(s, m.joinRoom(s, { clientId: "alice", name: "Alice" }));
    apply(s, m.joinRoom(s, { clientId: "bob", name: "Bob" }));
    return s;
  }

  function upsert(s, actor, elementId, fields, baseRevision, opId) {
    return m.submitUpsert(s, {
      opId: opId || `op-${Math.random().toString(16).slice(2)}`,
      actor, elementId, fields, baseRevision,
    });
  }

  t("first member is owner, second is editor", () => {
    const s = m.emptyState("r");
    apply(s, m.joinRoom(s, { clientId: "alice", name: "Alice" }));
    assert.strictEqual(s.members.alice.role, "owner");
    apply(s, m.joinRoom(s, { clientId: "bob", name: "Bob" }));
    assert.strictEqual(s.members.bob.role, "editor");
  });

  t("upsert creates an element at version 1 and advances the revision", () => {
    const s = freshRoom();
    const rev0 = s.revision;
    const e = apply(s, upsert(s, "alice", "wall-1", { height: 3000, name: "W1" }, rev0));
    assert.strictEqual(e.seq, rev0 + 1);
    assert.strictEqual(s.elements["wall-1"].version, 1);
    assert.strictEqual(s.elements["wall-1"].fields.height, 3000);
    assert.strictEqual(s.elements["wall-1"].createdBy, "alice");
  });

  t("duplicate opId is a replay: no state change, no new revision", () => {
    const s = freshRoom();
    const r1 = upsert(s, "alice", "wall-1", { height: 3000 }, s.revision, "op-dup-1");
    apply(s, r1);
    const rev = s.revision;
    const r2 = m.submitUpsert(s, {
      opId: "op-dup-1", actor: "alice", elementId: "wall-1",
      fields: { height: 9999 }, baseRevision: 0,
    });
    assert.strictEqual(r2.duplicate, true);
    assert.strictEqual(s.revision, rev);
    assert.strictEqual(s.elements["wall-1"].fields.height, 3000);
  });

  t("different fields of the same element merge; same field conflicts and keeps the server value", () => {
    const s = freshRoom();
    apply(s, upsert(s, "alice", "wall-1", { height: 3000, name: "W1" }, s.revision, "op-a1"));
    const base = s.revision; // both clients saw this revision
    const ra = upsert(s, "alice", "wall-1", { height: 3200 }, base, "op-a2");
    apply(s, ra);
    assert.strictEqual(ra.entry.conflicts.length, 0);
    // Bob's base is stale (before Alice's height edit). His name edit merges;
    // his height edit conflicts with Alice's.
    const rb = upsert(s, "bob", "wall-1", { name: "W1-renamed", height: 3500 }, base, "op-b1");
    apply(s, rb);
    assert.strictEqual(rb.entry.applied.name, "W1-renamed");
    assert.strictEqual(rb.entry.conflicts.length, 1);
    assert.strictEqual(rb.entry.conflicts[0].field, "height");
    assert.strictEqual(rb.entry.conflicts[0].attemptedValue, 3500);
    assert.strictEqual(rb.entry.conflicts[0].winningValue, 3200);
    assert.strictEqual(s.elements["wall-1"].fields.height, 3200);
    assert.strictEqual(s.elements["wall-1"].fields.name, "W1-renamed");
    assert.strictEqual(s.conflicts.length, 1);
    assert.strictEqual(s.conflicts[0].status, "open");
  });

  t("identical re-write is a no-op (no conflict, no field change)", () => {
    const s = freshRoom();
    apply(s, upsert(s, "alice", "wall-1", { height: 3000 }, s.revision, "op-a1"));
    const r = upsert(s, "bob", "wall-1", { height: 3000 }, 0, "op-b1");
    apply(s, r);
    assert.strictEqual(r.entry.conflicts.length, 0);
    assert.deepStrictEqual(r.entry.applied, {});
  });

  t("borrow blocks other editors; borrow-request + grant unblocks", () => {
    const s = freshRoom();
    apply(s, upsert(s, "alice", "door-1", { width: 900 }, s.revision, "op-a1"));
    apply(s, m.borrowElement(s, { actor: "bob", elementId: "door-1" }));
    const blocked = upsert(s, "alice", "door-1", { width: 1000 }, s.revision, "op-a2");
    assert.ok(blocked.error, "expected a borrow rejection");
    assert.strictEqual(blocked.error.status, 409);
    assert.strictEqual(blocked.error.code, "borrowed-by-other");
    const reborrow = m.borrowElement(s, { actor: "alice", elementId: "door-1" });
    assert.strictEqual(reborrow.error.status, 409);
    const req = m.submitBorrowRequest(s, { actor: "alice", elementId: "door-1" });
    apply(s, req);
    assert.strictEqual(req.entry.applied.requestId.startsWith("req-"), true);
    const reqId = req.entry.applied.requestId;
    // The borrower (bob) grants.
    apply(s, m.respondBorrowRequest(s, { actor: "bob", requestId: reqId, grant: true }));
    const ok = upsert(s, "alice", "door-1", { width: 1000 }, s.revision, "op-a3");
    apply(s, ok);
    assert.strictEqual(s.elements["door-1"].fields.width, 1000);
    // Relinquish frees the element again.
    apply(s, m.relinquishBorrow(s, { actor: "alice", elementId: "door-1" }));
    assert.strictEqual(s.borrows["door-1"], undefined);
  });

  t("workset ownership blocks edits until the element is borrowed via a granted request", () => {
    const s = freshRoom();
    apply(s, upsert(s, "alice", "beam-1", { length: 5000 }, s.revision, "op-a1"));
    apply(s, m.setWorksetOwner(s, { actor: "alice", worksetId: "ws-arch", owner: "alice" }));
    const blocked = upsert(s, "bob", "beam-1", { length: 6000 }, s.revision, "op-b1");
    assert.ok(blocked.error);
    assert.strictEqual(blocked.error.code, "workset-owned-by-other");
    const borrow = m.borrowElement(s, { actor: "bob", elementId: "beam-1" });
    assert.strictEqual(borrow.error.code, "workset-owned-by-other");
    const req = m.submitBorrowRequest(s, { actor: "bob", elementId: "beam-1" });
    apply(s, req);
    apply(s, m.respondBorrowRequest(s, { actor: "alice", requestId: req.entry.applied.requestId, grant: true }));
    const ok = upsert(s, "bob", "beam-1", { length: 6000 }, s.revision, "op-b2");
    apply(s, ok);
    assert.strictEqual(s.elements["beam-1"].fields.length, 6000);
    // Only the room owner may set workset owners.
    const notOwner = m.setWorksetOwner(s, { actor: "bob", worksetId: "ws-arch", owner: null });
    assert.strictEqual(notOwner.error.status, 403);
  });

  t("delete after a concurrent edit is a recorded conflict, not a silent delete", () => {
    const s = freshRoom();
    apply(s, upsert(s, "alice", "wall-9", { height: 3000 }, s.revision, "op-a1"));
    const base = s.revision;
    apply(s, upsert(s, "alice", "wall-9", { height: 3100 }, base, "op-a2"));
    const del = m.submitDelete(s, { opId: "op-b-del", actor: "bob", elementId: "wall-9", baseRevision: base });
    apply(s, del);
    assert.strictEqual(del.entry.conflicts.length, 1);
    assert.strictEqual(del.entry.applied.deleted, undefined);
    assert.strictEqual(s.elements["wall-9"].deleted, false);
    // A delete with a current base succeeds.
    const del2 = m.submitDelete(s, { opId: "op-b-del2", actor: "bob", elementId: "wall-9", baseRevision: s.revision });
    apply(s, del2);
    assert.strictEqual(s.elements["wall-9"].deleted, true);
    assert.strictEqual(m.publicState(s).elements["wall-9"], undefined);
  });

  t("conflict resolution: 'mine' re-applies the attempted value, 'theirs' keeps the server value", () => {
    const s = freshRoom();
    apply(s, upsert(s, "alice", "wall-1", { height: 3000 }, s.revision, "op-a1"));
    const base = s.revision;
    apply(s, upsert(s, "alice", "wall-1", { height: 3200 }, base, "op-a2"));
    const rb = upsert(s, "bob", "wall-1", { height: 3500 }, base, "op-b1");
    apply(s, rb);
    const cfId = rb.entry.conflicts[0].id;
    apply(s, m.resolveConflict(s, { actor: "bob", conflictId: cfId, choice: "mine" }));
    assert.strictEqual(s.elements["wall-1"].fields.height, 3500);
    assert.strictEqual(s.conflicts[0].status, "resolved");
    assert.strictEqual(s.conflicts[0].resolution.choice, "mine");
    // A second conflict resolved with 'theirs'.
    const base2 = s.revision;
    apply(s, upsert(s, "alice", "wall-1", { height: 3600 }, base2, "op-a3"));
    const rb2 = upsert(s, "bob", "wall-1", { height: 3700 }, base2, "op-b2");
    apply(s, rb2);
    apply(s, m.resolveConflict(s, { actor: "alice", conflictId: rb2.entry.conflicts[0].id, choice: "theirs" }));
    assert.strictEqual(s.elements["wall-1"].fields.height, 3600);
  });

  t("viewer may not submit ops; owner may not demote themselves", () => {
    const s = freshRoom();
    apply(s, m.setRole(s, { actor: "alice", clientId: "bob", role: "viewer" }));
    const r = upsert(s, "bob", "wall-1", { height: 3000 }, s.revision, "op-b1");
    assert.ok(r.error);
    assert.strictEqual(r.error.status, 403);
    const demote = m.setRole(s, { actor: "alice", clientId: "alice", role: "editor" });
    assert.strictEqual(demote.error.status, 400);
    const stranger = upsert(s, "mallory", "wall-1", { height: 1 }, s.revision, "op-m1");
    assert.strictEqual(stranger.error.status, 403);
  });

  t("restore reverts element fields to an earlier revision and journals the restore", () => {
    const s = freshRoom();
    const journal = [];
    const commit = (r) => { const e = apply(s, r); journal.push(e); return e; };
    commit(upsert(s, "alice", "wall-1", { height: 3000, name: "W1" }, s.revision, "op-1"));
    const revAfterCreate = s.revision;
    commit(upsert(s, "alice", "wall-1", { height: 3200 }, s.revision, "op-2"));
    commit(upsert(s, "alice", "wall-1", { name: "W1-new" }, s.revision, "op-3"));
    assert.strictEqual(s.elements["wall-1"].fields.height, 3200);
    const r = m.restoreToRevision(s, journal, { actor: "alice", revision: revAfterCreate });
    assert.ok(!r.error, JSON.stringify(r.error));
    commit(r);
    assert.strictEqual(s.elements["wall-1"].fields.height, 3000);
    assert.strictEqual(s.elements["wall-1"].fields.name, "W1");
    assert.strictEqual(s.revision, revAfterCreate + 3);
    // History is not rewritten: the journal still holds the reverted edits.
    assert.strictEqual(journal.length, 4);
    assert.strictEqual(journal[3].kind, "restore");
    // Restoring to a revision outside the retained window is rejected.
    const tooOld = m.restoreToRevision(s, journal, { actor: "alice", revision: 0 });
    assert.ok(tooOld.error);
    assert.strictEqual(tooOld.error.status, 400);
  });

  t("restore removes elements created after the target revision", () => {
    const s = freshRoom();
    const journal = [];
    const commit = (r) => { const e = apply(s, r); journal.push(e); return e; };
    commit(upsert(s, "alice", "wall-1", { height: 3000 }, s.revision, "op-1"));
    const rev = s.revision;
    commit(upsert(s, "alice", "wall-2", { height: 2500 }, s.revision, "op-2"));
    const r = m.restoreToRevision(s, journal, { actor: "alice", revision: rev });
    apply(s, r);
    assert.strictEqual(s.elements["wall-2"], undefined);
    assert.strictEqual(s.elements["wall-1"].fields.height, 3000);
  });

  t("leave relinquishes the leaver's borrows", () => {
    const s = freshRoom();
    apply(s, upsert(s, "alice", "door-1", { width: 900 }, s.revision, "op-a1"));
    apply(s, m.borrowElement(s, { actor: "bob", elementId: "door-1" }));
    apply(s, m.leaveRoom(s, { clientId: "bob" }));
    assert.strictEqual(s.borrows["door-1"], undefined);
    assert.strictEqual(s.members.bob, undefined);
  });

  t("validation rejects empty fields, unknown worksets and oversized values", () => {
    const s = freshRoom();
    const empty = upsert(s, "alice", "wall-1", {}, s.revision, "op-v1");
    assert.strictEqual(empty.error.status, 400);
    const badWs = m.submitUpsert(s, {
      opId: "op-v2", actor: "alice", elementId: "wall-1",
      fields: { height: 1 }, baseRevision: s.revision, worksetId: "ws-nope",
    });
    assert.strictEqual(badWs.error.status, 400);
    const big = upsert(s, "alice", "wall-1", { note: "x".repeat(70000) }, s.revision, "op-v3");
    assert.strictEqual(big.error.status, 400);
    const noOpId = m.submitUpsert(s, { actor: "alice", elementId: "wall-1", fields: { height: 1 }, baseRevision: 0 });
    assert.strictEqual(noOpId.error.status, 400);
  });

  t("expired borrows are swept", () => {
    const s = freshRoom();
    apply(s, upsert(s, "alice", "door-1", { width: 900 }, s.revision, "op-a1"));
    apply(s, m.borrowElement(s, { actor: "bob", elementId: "door-1" }));
    const effects = m.sweepExpiredBorrows(s, Date.now() + 16 * 60_000);
    assert.strictEqual(effects.length, 1);
    m.applyEffects(s, effects);
    assert.strictEqual(s.borrows["door-1"], undefined);
    assert.strictEqual(m.sweepExpiredBorrows(s).length, 0);
  });

  t("workset creation is journalled and visible in public state", () => {
    const s = freshRoom();
    const r = m.createWorkset(s, { actor: "alice", name: "Landscape" });
    apply(s, r);
    assert.strictEqual(r.entry.applied.worksetId.startsWith("ws-"), true);
    assert.ok(m.publicState(s).worksets[r.entry.applied.worksetId]);
    const bad = m.createWorkset(s, { actor: "alice", name: "   " });
    assert.strictEqual(bad.error.status, 400);
  });

  console.log(`\ncentral-model: ${pass} passed, ${fail} failed`);
  if (fail) {
    for (const f of failures) console.log("  FAILED: " + f);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
