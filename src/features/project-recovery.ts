/**
 * Recovery checkpoints UI — makes the project journal (10 retained
 * pre-save snapshots with archived model payloads) reachable from the app.
 *
 * Entry points:
 *   - File → Recovery checkpoints…
 *   - command palette: "project.recovery"
 *   - the boot banner shown when the previous session ended without a
 *     clean save (obs:recovery-available, dispatched by persistence.ts).
 *
 * Restore semantics live in the store: the current document + payloads are
 * snapshotted first ("before-restore"), so a restore is itself reversible.
 */
import {
  listProjectRecoverySnapshots, restoreProjectRecoverySnapshot,
  getCurrentProject, openProject,
} from "../modules/projects/projects";
import type { ProjectRecoverySnapshot } from "../modules/projects/project-journal";
import { confirmDialog } from "./form-modal";
import { notify as toast } from "../core/notify";
import { fmtDateTime } from "../core/region";
import { escapeHtml as esc } from "../core/html-escape";

const REASON_LABEL: Record<string, string> = {
  "project-save": "before an overwrite",
  "model-import": "before a model import",
  "before-restore": "before a restore",
};

let bannerShown = false;

/** Dismissible banner after an unclean shutdown. */
function showRecoveryBanner(): void {
  if (bannerShown) return;
  bannerShown = true;
  const id = "obs-recovery-banner";
  document.getElementById(id)?.remove();
  const banner = document.createElement("div");
  banner.id = id;
  banner.style.cssText =
    "position:fixed;right:16px;bottom:52px;z-index:9000;max-width:420px;" +
    "background:var(--bg-floating,#1c1e28);color:var(--text-primary,#e8eaf0);" +
    "border:1px solid var(--warning,#f59e0b);border-left:3px solid var(--warning,#f59e0b);" +
    "border-radius:6px;padding:12px 14px;font:12px/1.5 system-ui,sans-serif;" +
    "box-shadow:0 12px 32px rgba(0,0,0,.45)";
  banner.innerHTML =
    `<div style="font-weight:700;margin-bottom:6px;color:var(--warning,#f59e0b)">⚠ Previous session ended without a clean save</div>` +
    `<div style="font-size:11px;opacity:.85;margin-bottom:8px">Autosaved checkpoints of your project are available. Open a project first, then restore one.</div>`;
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px";
  const open = document.createElement("button");
  open.textContent = "How to recover";
  open.style.cssText = "padding:4px 12px;background:var(--bg-hover,#232633);color:inherit;border:1px solid var(--border-default,#2a2e3a);border-radius:4px;cursor:pointer;font-size:11px";
  open.onclick = () => {
    banner.remove();
    void confirmDialog("Recovering unsaved work",
      "1. Open the affected project (File → Open Project…).\n" +
      "2. Choose File → Recovery checkpoints… — every checkpoint lists what it contains.\n" +
      "3. Restore: your current state is kept as a checkpoint first, so restoring is reversible.");
  };
  row.appendChild(open);
  const close = document.createElement("button");
  close.textContent = "Dismiss";
  close.style.cssText = "padding:4px 12px;background:var(--bg-hover,#232633);color:inherit;border:1px solid var(--border-default,#2a2e3a);border-radius:4px;cursor:pointer;font-size:11px";
  close.onclick = () => banner.remove();
  row.appendChild(close);
  banner.appendChild(row);
  document.body.appendChild(banner);
  setTimeout(() => { if (banner.isConnected) banner.remove(); }, 30_000);
}

function rowLabel(s: ProjectRecoverySnapshot): string {
  const parts = [
    `${s.elementCount} element${s.elementCount === 1 ? "" : "s"}`,
    `${s.modelCount} model${s.modelCount === 1 ? "" : "s"}`,
  ];
  if (s.missingModelCount > 0) parts.push(`${s.missingModelCount} model payload(s) missing from that checkpoint`);
  return parts.join(" · ");
}

/** Modal listing retained recovery checkpoints for the open project. */
export function showProjectRecovery(): void {
  const cur = getCurrentProject();
  if (!cur) { toast("warn", "Open or create a project first — checkpoints are listed per project."); return; }

  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:9100;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
  const card = document.createElement("div");
  card.style.cssText = "background:#1b1c26;border:1px solid #34353f;border-radius:10px;padding:16px;width:520px;max-width:92vw;max-height:80vh;overflow:auto;color:#e2e8f0;font:12px system-ui,sans-serif";
  card.innerHTML =
    `<div style="font-weight:700;font-size:14px;margin-bottom:2px">🛟 Recovery checkpoints</div>` +
    `<div style="opacity:.6;margin-bottom:10px">Project “${esc(cur.name)}” · the current state is always kept as a checkpoint before any restore.</div>`;
  const list = document.createElement("div");
  list.textContent = "Loading checkpoints…";
  list.style.cssText = "display:flex;flex-direction:column;gap:6px";
  card.appendChild(list);

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  closeBtn.style.cssText = "margin-top:12px;padding:6px 14px;background:#24252f;color:inherit;border:1px solid #34353f;border-radius:6px;cursor:pointer;font-size:12px";
  closeBtn.onclick = () => overlay.remove();
  card.appendChild(closeBtn);
  overlay.appendChild(card);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  void (async () => {
    let snapshots: ProjectRecoverySnapshot[] = [];
    try { snapshots = await listProjectRecoverySnapshots(); }
    catch (e) {
      list.textContent = "Could not read the recovery journal — see the console for details.";
      console.error("[project-recovery] listing failed", e);
      return;
    }
    list.innerHTML = "";
    if (!snapshots.length) {
      list.innerHTML = `<div style="opacity:.6;padding:10px;border:1px dashed #34353f;border-radius:6px">No checkpoints yet. One is written automatically before each save that changes the document, before each model import, and before each restore.</div>`;
      return;
    }
    for (const s of snapshots) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid #2a2e3a;border-radius:8px;background:#20222d";
      const info = document.createElement("div");
      info.style.cssText = "flex:1;min-width:0";
      info.innerHTML =
        `<div style="font-weight:600">${esc(fmtDateTime(s.createdAt))} <span style="opacity:.55;font-weight:400">· ${esc(REASON_LABEL[s.reason] ?? s.reason)}</span></div>` +
        `<div style="opacity:.7;font-size:11px;margin-top:2px">${esc(rowLabel(s))}</div>`;
      row.appendChild(info);
      const btn = document.createElement("button");
      btn.textContent = "Restore";
      btn.style.cssText = "padding:5px 12px;background:#2b3a55;color:#cfe1ff;border:1px solid #3b5578;border-radius:5px;cursor:pointer;font-size:11px;white-space:nowrap";
      btn.onclick = () => {
        void (async () => {
          const ok = await confirmDialog("Restore this checkpoint?",
            `The project will be rolled back to the state from ${fmtDateTime(s.createdAt)} (${rowLabel(s)}).\n\n` +
            `The CURRENT state is saved as a new checkpoint first, so this can be undone.`);
          if (!ok) return;
          btn.disabled = true;
          btn.textContent = "Restoring…";
          try {
            const result = await restoreProjectRecoverySnapshot(s.id);
            if (!result.restored) {
              toast("error", "Checkpoint could not be restored (no longer retained).");
              btn.disabled = false; btn.textContent = "Restore";
              return;
            }
            overlay.remove();
            const missing = result.missingModelIds.length
              ? ` ${result.missingModelIds.length} model payload(s) were not in that checkpoint and show as missing.`
              : "";
            toast("success", `Checkpoint restored.${missing} Reloading the scene…`);
            await openProject(getCurrentProject()!.id);
          } catch (e) {
            console.error("[project-recovery] restore failed", e);
            toast("error", `Restore failed: ${e instanceof Error ? e.message : e}`);
            btn.disabled = false; btn.textContent = "Restore";
          }
        })();
      };
      row.appendChild(btn);
      list.appendChild(row);
    }
  })();
}

export function setupProjectRecovery(): void {
  window.addEventListener("obs:recovery-available", () => showRecoveryBanner());
  void import("./command-palette").then(({ registerCommand }) => {
    registerCommand({
      id: "project.recovery",
      label: "Recovery checkpoints",
      category: "Project",
      hint: "Restore an earlier state of the open project",
      run: () => showProjectRecovery(),
    });
  }).catch((e) => console.warn("[project-recovery] command registration failed", e));
}
