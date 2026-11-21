/**
 * Enterprise Worksets & Worksharing Panel
 *
 * Provides a model worksharing interface:
 * - Active workset selector
 * - Workset list with ownership & open/closed toggle
 * - Granular element borrow / relinquish controls
 * - One-click "Sync with Central" & "Reload Latest"
 */

import { getWorksharingEngine, type WorksetRecord } from "../modules/collaboration/worksharing-engine";
import { getActiveCentralBinding } from "../modules/collaboration/central-binding";
import { getElementById, getSelectedIds } from "./authoring";
import { registerCommand } from "./command-palette";

export function openWorksharingPanel(): void {
  const existing = document.getElementById("obs-worksharing-modal");
  if (existing) existing.remove();

  const engine = getWorksharingEngine();
  const summary = engine.getSummary();
  const worksets = engine.getAllWorksets();
  const activeWs = engine.getActiveWorkset();

  // ── Central sync (server-authoritative multi-user) ──────────────────
  // The local engine above is in-memory only; this section is the durable
  // path (server/central-model.mjs + CentralBinding). When no binding is
  // set up the section reports that instead of pretending to sync.
  const binding = getActiveCentralBinding();
  const central = binding ? binding.getStatus() : null;
  const selectedIds = getSelectedIds();
  const selectedEl = selectedIds.length === 1 ? getElementById(selectedIds[0]) : null;
  const selectedCentralId = selectedEl && binding ? binding.toCentralId(selectedEl.id) : null;
  const selectedBorrow = selectedCentralId && central ? (central.borrows as any)[selectedCentralId] : null;
  const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const centralSection = !binding
    ? `<div style="font-size: 13px; color: #94a3b8;">Central sync is not available in this session (binding did not start).</div>`
    : !central!.joined
      ? `<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
          <input id="obs-central-room" placeholder="Room ID (e.g. project-123)" style="background: #0f172a; color: #f8fafc; border: 1px solid #475569; padding: 6px 8px; border-radius: 6px; font-size: 13px; width: 180px;" />
          <input id="obs-central-name" placeholder="Your name" style="background: #0f172a; color: #f8fafc; border: 1px solid #475569; padding: 6px 8px; border-radius: 6px; font-size: 13px; width: 140px;" />
          <button id="obs-central-join-btn" style="background: #2563eb; color: #fff; border: none; padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;">Join central room</button>
          <span style="font-size: 12px; color: #94a3b8;">Edits sync to the server central model; borrows are enforced while joined.</span>
        </div>`
      : `<div style="display: flex; flex-direction: column; gap: 10px;">
          <div style="font-size: 13px;">
            Room <strong>${escapeAttr(central!.roomId)}</strong> &bull; Central Rev <strong>#${central!.revision}</strong> &bull; You: <strong>${escapeAttr(central!.name || central!.clientId)}</strong> &bull; Members: <strong>${central!.members.length}</strong>
            &nbsp;<span style="color: #94a3b8;">(${central!.members.map((m) => `${escapeAttr(m.name)} (${m.role})`).join(", ") || "—"})</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <button id="obs-central-sync-btn" style="background: #2563eb; color: #fff; border: none; padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;">Sync now</button>
            <button id="obs-central-leave-btn" style="background: #334155; color: #f8fafc; border: none; padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;">Leave room</button>
            ${selectedEl ? `
              <span style="font-size: 12px; color: #94a3b8;">Selected: <strong style="color: #f1f5f9;">${escapeAttr(selectedEl.name)}</strong></span>
              ${selectedBorrow
                ? selectedBorrow.borrower === central!.clientId
                  ? `<button id="obs-central-relinquish-btn" style="background: #334155; color: #f8fafc; border: none; padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;">Relinquish borrow</button>`
                  : `<span style="font-size: 12px; color: #f59e0b;">Borrowed by ${escapeAttr(selectedBorrow.borrowerName || selectedBorrow.borrower)}</span>`
                : `<button id="obs-central-borrow-btn" style="background: #334155; color: #f8fafc; border: none; padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;">Borrow selected</button>`}
            ` : `<span style="font-size: 12px; color: #94a3b8;">Select an element to borrow it.</span>`}
          </div>
          ${central!.openConflicts.length ? `
            <div style="border: 1px solid #b45309; border-radius: 8px; padding: 10px 12px; background: rgba(180, 83, 9, 0.12);">
              <div style="font-size: 13px; font-weight: 600; color: #fbbf24; margin-bottom: 8px;">Open merge conflicts (${central!.openConflicts.length}) — the server kept its value; pick the winner:</div>
              ${central!.openConflicts.map((c: any) => {
                const localId = binding!.toLocalId(c.elementId);
                const name = localId ? (getElementById(localId)?.name || c.elementId) : c.elementId;
                return `<div style="font-size: 13px; margin-bottom: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                  <span><strong>${escapeAttr(name)}</strong> — ${escapeAttr(String(c.field ?? "delete"))}: you tried <code>${escapeAttr(JSON.stringify(c.attemptedValue))}</code>, server kept <code>${escapeAttr(JSON.stringify(c.winningValue))}</code></span>
                  <button class="obs-central-resolve-btn" data-conflict-id="${escapeAttr(String(c.id))}" data-choice="mine" style="background: #2563eb; color: #fff; border: none; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 12px;">Use mine</button>
                  <button class="obs-central-resolve-btn" data-conflict-id="${escapeAttr(String(c.id))}" data-choice="theirs" style="background: #334155; color: #f8fafc; border: none; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 12px;">Keep server</button>
                </div>`;
              }).join("")}
            </div>
          ` : `<div style="font-size: 12px; color: #94a3b8;">No open merge conflicts.</div>`}
        </div>`;

  const overlay = document.createElement("div");
  overlay.id = "obs-worksharing-modal";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(15, 23, 42, 0.65); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #1e293b; color: #f8fafc; border-radius: 12px;
    width: 820px; max-width: 95vw; max-height: 85vh;
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid #334155; font-family: system-ui, sans-serif;
  `;

  card.innerHTML = `
    <div style="padding: 16px 20px; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between;">
      <div>
        <h2 style="margin: 0; font-size: 18px; font-weight: 600; color: #38bdf8;">Worksharing &amp; Central Model</h2>
        <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">
          Central Rev: <strong style="color: #f1f5f9;">#${summary.centralRevision}</strong> &bull; Total Worksets: <strong>${summary.totalWorksets}</strong> &bull; Borrowed Elements: <strong>${summary.borrowedByMe}</strong>
        </div>
      </div>
      <button id="obs-ws-close-btn" style="background: transparent; border: none; color: #94a3b8; font-size: 20px; cursor: pointer;">&times;</button>
    </div>

    <!-- Central Sync (server-authoritative multi-user) -->
    <div style="padding: 12px 20px; background: #0f172a; border-bottom: 1px solid #334155;">
      <div style="font-size: 13px; font-weight: 600; color: #38bdf8; margin-bottom: 8px;">Central Sync — server model</div>
      ${centralSection}
      <div id="obs-central-status-msg" style="font-size: 12px; color: #38bdf8; margin-top: 8px;"></div>
    </div>

    <!-- Central Action Ribbon (local engine) -->
      <div style="display: flex; gap: 10px;">
        <button id="obs-ws-sync-btn" style="background: #2563eb; color: #fff; border: none; padding: 7px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px;">
          <span>&#8644;</span> Sync with Central
        </button>
        <button id="obs-ws-reload-btn" style="background: #334155; color: #f8fafc; border: none; padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;">
          Reload Latest
        </button>
        <button id="obs-ws-relinquish-btn" style="background: #334155; color: #f8fafc; border: none; padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;">
          Relinquish All Mine
        </button>
      </div>

      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 12px; color: #94a3b8;">Active Workset:</span>
        <select id="obs-ws-active-select" style="background: #1e293b; color: #f8fafc; border: 1px solid #475569; padding: 5px 8px; border-radius: 6px; font-size: 13px;">
          ${worksets.map((w) => `<option value="${w.id}" ${w.id === activeWs.id ? "selected" : ""}>${w.name}</option>`).join("")}
        </select>
      </div>
    </div>

    <!-- Worksets Table -->
    <div style="flex: 1; overflow-y: auto; padding: 16px 20px;">
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="border-bottom: 1px solid #475569; text-align: left; color: #94a3b8;">
            <th style="padding: 8px;">Workset Name</th>
            <th style="padding: 8px;">Discipline / Kind</th>
            <th style="padding: 8px;">Owner</th>
            <th style="padding: 8px;">Elements</th>
            <th style="padding: 8px;">Opened in 3D</th>
            <th style="padding: 8px;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${worksets.map((w) => `
            <tr style="border-bottom: 1px solid #334155; color: #f1f5f9;">
              <td style="padding: 8px; font-weight: 500;">${w.name}</td>
              <td style="padding: 8px; color: #94a3b8;">${w.kind}</td>
              <td style="padding: 8px; color: ${w.owner ? "#f59e0b" : "#10b981"};">${w.owner || "Free to borrow"}</td>
              <td style="padding: 8px;">${w.elementIds.size}</td>
              <td style="padding: 8px;">
                <input type="checkbox" class="obs-ws-open-toggle" data-id="${w.id}" ${w.isOpen ? "checked" : ""} style="cursor: pointer;" />
              </td>
              <td style="padding: 8px;">
                <span style="font-size: 11px; padding: 2px 8px; border-radius: 4px; background: ${w.isOpen ? "rgba(16, 185, 129, 0.2)" : "rgba(100, 116, 139, 0.2)"}; color: ${w.isOpen ? "#34d399" : "#94a3b8"};">
                  ${w.isOpen ? "Loaded" : "Closed"}
                </span>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>

    <div style="padding: 12px 20px; background: #0f172a; border-top: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #94a3b8;">
      <div>Pending Local Transactions: <strong>${summary.pendingTransactions}</strong></div>
      <div id="obs-ws-status-msg" style="color: #38bdf8;"></div>
    </div>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Handlers
  document.getElementById("obs-ws-close-btn")?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const statusMsg = document.getElementById("obs-ws-status-msg");

  document.getElementById("obs-ws-active-select")?.addEventListener("change", (e) => {
    const val = (e.target as HTMLSelectElement).value;
    engine.setActiveWorkset(val);
    if (statusMsg) statusMsg.textContent = `Active workset updated.`;
  });

  document.getElementById("obs-ws-sync-btn")?.addEventListener("click", () => {
    const res = engine.syncWithCentral({ relinquishBorrowed: true });
    if (statusMsg) {
      statusMsg.textContent = `Synced ${res.syncedRevisions} transactions to Central (Rev #${engine.getState().centralRevision}).`;
      setTimeout(() => openWorksharingPanel(), 1000);
    }
  });

  document.getElementById("obs-ws-reload-btn")?.addEventListener("click", () => {
    const res = engine.reloadLatest();
    if (statusMsg) {
      statusMsg.textContent = `Reloaded ${res.newRevisions} new central revisions (${res.updatedElements} elements).`;
    }
  });

  document.getElementById("obs-ws-relinquish-btn")?.addEventListener("click", () => {
    const res = engine.relinquish({ borrowedElements: true, userCreatedWorksets: true });
    if (statusMsg) {
      statusMsg.textContent = `Relinquished ${res.relinquishedElements} elements.`;
      setTimeout(() => openWorksharingPanel(), 1000);
    }
  });

  // ── Central sync handlers (server-authoritative path) ──────────────
  const centralMsg = document.getElementById("obs-central-status-msg");
  const reopen = () => setTimeout(() => openWorksharingPanel(), 800);
  if (binding) {
    document.getElementById("obs-central-join-btn")?.addEventListener("click", async () => {
      const room = (document.getElementById("obs-central-room") as HTMLInputElement)?.value.trim();
      const name = (document.getElementById("obs-central-name") as HTMLInputElement)?.value.trim() || "Guest";
      if (!room) {
        if (centralMsg) centralMsg.textContent = "Enter a room ID first.";
        return;
      }
      if (centralMsg) centralMsg.textContent = `Joining ${room}…`;
      const ok = await binding.join(room, name);
      if (centralMsg) centralMsg.textContent = ok ? `Joined ${room}.` : `Could not join ${room} — is the collaboration server running?`;
      if (ok) reopen();
    });
    document.getElementById("obs-central-sync-btn")?.addEventListener("click", async () => {
      if (centralMsg) centralMsg.textContent = "Syncing…";
      await binding.syncNow();
      if (centralMsg) centralMsg.textContent = `Synced to central rev #${binding.getStatus().revision}.`;
      reopen();
    });
    document.getElementById("obs-central-leave-btn")?.addEventListener("click", async () => {
      await binding.leave();
      if (centralMsg) centralMsg.textContent = "Left the central room.";
      reopen();
    });
    document.getElementById("obs-central-borrow-btn")?.addEventListener("click", async () => {
      if (!selectedEl) return;
      const r = await binding.borrow(selectedEl.id);
      if (centralMsg) centralMsg.textContent = r?.ok ? `Borrowed ${selectedEl.name}.` : `Borrow failed: ${r?.error || "unknown error"}`;
      reopen();
    });
    document.getElementById("obs-central-relinquish-btn")?.addEventListener("click", async () => {
      if (!selectedEl) return;
      const r = await binding.relinquish(selectedEl.id);
      if (centralMsg) centralMsg.textContent = r?.ok ? `Relinquished ${selectedEl.name}.` : `Relinquish failed: ${r?.error || "unknown error"}`;
      reopen();
    });
    overlay.querySelectorAll(".obs-central-resolve-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const conflictId = btn.getAttribute("data-conflict-id");
        const choice = btn.getAttribute("data-choice") as "mine" | "theirs";
        if (!conflictId || !choice) return;
        const r = await binding.resolveConflict(conflictId, choice);
        if (centralMsg) centralMsg.textContent = r?.ok ? `Conflict resolved (${choice === "mine" ? "your value" : "server value"} kept).` : `Resolve failed: ${r?.error || "unknown error"}`;
        reopen();
      });
    });
  }

  overlay.querySelectorAll(".obs-ws-open-toggle").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const el = e.target as HTMLInputElement;
      const wsId = el.getAttribute("data-id");
      if (wsId) {
        engine.setWorksetOpenState(wsId, el.checked);
        if (statusMsg) statusMsg.textContent = `Workset visibility updated.`;
      }
    });
  });
}

// Register palette command
registerCommand({
  id: "collab.worksharing",
  label: "Collaboration: Worksets & Central Model",
  category: "Collaboration",
  hint: "Manage worksets, element borrowing, and Sync with Central",
  run: () => openWorksharingPanel(),
});
