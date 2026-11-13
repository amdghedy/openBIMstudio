/**
 * Native IFC workflow (browser) — openBIMstudio counterpart to “IFC as native model”.
 *
 * That Open’s Nov 2025 Revit product claims desktop RVT↔IFC bidirectional sync.
 * This module delivers the *same user goals* inside openBIMstudio (web):
 *   1. Open linked IFC/FRAG as editable Native Twins (system-like elements)
 *   2. Edit in-app → export updated IFC4 (write-back without a separate “export only” dead-end)
 *   3. Lightweight change history (“git for BIM” session log)
 *   4. One-click commands from the UI
 *
 * Honest scope: this is NOT a Revit plugin and does not control Autodesk Revit.
 * It is native authorship on IFC-derived geometry inside openBIMstudio.
 */

import { ctx } from "../core/context";
import { bulkConvertLinkedToNativeTwin, type BulkConvertResult } from "./bulk-native-twin";
import { downloadNativeTwinIfc, downloadFederatedNativeTwinIfc } from "../modules/export/native-twin-ifc";

type Any = Record<string, any>;

/** Soft warning threshold — conversion continues in streamed batches past this. */
const WARN_CONVERT = 2500;
/** Hard ceiling per single run (memory safety). */
const MAX_AUTO_CONVERT = 12000;
const HISTORY_KEY = "obs.nativeIfc.history.v1";
const RESUME_KEY = "obs.nativeIfc.resume.v1";

export interface IfcChangeRecord {
  id: string;
  at: number;
  action: "make-editable" | "export-ifc" | "edit" | "delete" | "note";
  summary: string;
  modelId?: string;
  count?: number;
}

function toast(msg: string, kind: "success" | "warn" | "error" | "info" = "info"): void {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: msg, kind } }));
  } catch {
    console.log(`[native-ifc] ${kind}: ${msg}`);
  }
}

function fragEdit(): Any | null {
  return ((ctx as Any).features?.fragEdit as Any) ?? null;
}

function listTwinEdits(): Any[] {
  const fe = fragEdit();
  try {
    if (typeof fe?.getTwinsForIfcExport === "function") return fe.getTwinsForIfcExport() ?? [];
    if (typeof fe?.list === "function") return fe.list() ?? [];
    if (typeof fe?.serialize === "function") return fe.serialize() ?? [];
  } catch {
    /* */
  }
  return [];
}

function loadHistory(): IfcChangeRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(-200) : [];
  } catch {
    return [];
  }
}

function saveHistory(rows: IfcChangeRecord[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(rows.slice(-200)));
  } catch {
    /* quota */
  }
}

export function recordIfcChange(
  action: IfcChangeRecord["action"],
  summary: string,
  extra?: Partial<IfcChangeRecord>,
): void {
  const rows = loadHistory();
  rows.push({
    id: `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    action,
    summary,
    ...extra,
  });
  saveHistory(rows);
}

export function getIfcChangeHistory(): IfcChangeRecord[] {
  return loadHistory();
}

export function clearIfcChangeHistory(): void {
  saveHistory([]);
}

/** Linked fragment model ids currently in the scene. */
export function listLinkedModelIds(): string[] {
  try {
    const list = (ctx as Any).fragments?.list;
    if (!list) return [];
    if (typeof list.keys === "function") return Array.from(list.keys()).map(String);
    if (list instanceof Map) return Array.from(list.keys()).map(String);
  } catch {
    /* */
  }
  return [];
}

async function geometryIdsForModel(modelId: string): Promise<number[]> {
  try {
    const model: Any = (ctx as Any).fragments?.list?.get?.(modelId);
    if (!model) return [];
    if (typeof model.getItemsIdsWithGeometry === "function") {
      const ids = await model.getItemsIdsWithGeometry();
      return Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isFinite(n)) : [];
    }
  } catch (err) {
    console.warn("[native-ifc] geometry ids failed", modelId, err);
  }
  return [];
}

/**
 * Convert an entire linked IFC/FRAG model into editable Native Twins.
 * Caps at MAX_AUTO_CONVERT elements to protect the tab.
 */

interface ResumeState {
  modelId: string;
  total: number;
  remaining: number;
  at: number;
}

function saveResumeState(state: ResumeState | null): void {
  try {
    if (!state) localStorage.removeItem(RESUME_KEY);
    else localStorage.setItem(RESUME_KEY, JSON.stringify(state));
  } catch {
    /* */
  }
}

export function getResumeState(): ResumeState | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as ResumeState;
    if (!s?.modelId || !(s.remaining > 0)) return null;
    return s;
  } catch {
    return null;
  }
}

/** LocalIds that do not already have a Native Twin. */
async function pendingGeometryIds(modelId: string): Promise<number[]> {
  const all = await geometryIdsForModel(modelId);
  const fe = fragEdit();
  let existing = new Set<string>();
  try {
    const list = typeof fe?.list === "function" ? fe.list() ?? [] : [];
    existing = new Set(
      list
        .filter((e: Any) => e && String(e.modelId) === String(modelId))
        .map((e: Any) => `${e.modelId}:${Number(e.localId)}`),
    );
  } catch {
    /* */
  }
  return all.filter((id) => !existing.has(`${modelId}:${id}`));
}

export async function makeModelEditable(modelId?: string): Promise<BulkConvertResult | null> {
  const ids = listLinkedModelIds();
  const mid = modelId || ids[0];
  if (!mid) {
    toast("No linked IFC/FRAG model. Insert → Link IFC or Link FRAG first.", "warn");
    return null;
  }

  const pending = await pendingGeometryIds(mid);
  const allCount = (await geometryIdsForModel(mid)).length;
  if (!pending.length) {
    saveResumeState(null);
    toast(
      allCount
        ? `Model “${mid}” is fully editable (${allCount} twin(s) already).`
        : `Model “${mid}” has no drawable elements to convert.`,
      allCount ? "success" : "warn",
    );
    return null;
  }

  let useIds = pending;
  if (pending.length > MAX_AUTO_CONVERT) {
    useIds = pending.slice(0, MAX_AUTO_CONVERT);
    toast(
      `${pending.length} elements left — converting ${MAX_AUTO_CONVERT} this run. Use Resume for the rest.`,
      "warn",
    );
  } else if (pending.length < allCount) {
    toast(
      `Resuming: ${pending.length} of ${allCount} elements still need Native Twins.`,
      "info",
    );
  } else if (pending.length > WARN_CONVERT) {
    toast(
      `Large model (${pending.length} elements) — streamed conversion with live progress.`,
      "info",
    );
  }

  const ac = new AbortController();
  const progress = openProgressDialog(useIds.length, mid, () => ac.abort());
  const selection = { [mid]: useIds };
  let lastUi = 0;
  try {
    const result = await bulkConvertLinkedToNativeTwin({
      selection,
      quietPerItem: true,
      openPanelOnSuccess: true,
      signal: ac.signal,
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastUi < 80 && p.index < p.total) return;
        lastUi = now;
        progress.update(p.index, p.total, p.createdSoFar, p.failedSoFar);
      },
    });
    progress.close(result);
    // Remaining work for Resume
    const still = await pendingGeometryIds(mid);
    if (still.length) {
      saveResumeState({
        modelId: mid,
        total: allCount,
        remaining: still.length,
        at: Date.now(),
      });
    } else {
      saveResumeState(null);
    }
    recordIfcChange(
      "make-editable",
      result.aborted
        ? `Native twins from ${mid}: ${result.created} created (cancelled, ${still.length} left)`
        : `Native twins from ${mid}: ${result.created} created` +
          (still.length ? ` (${still.length} left — Resume)` : ""),
      { modelId: mid, count: result.created },
    );
    if (result.aborted) {
      toast(
        `Cancelled — kept ${result.created} twin(s). ${still.length} remaining — use Resume to continue.`,
        result.created || still.length ? "warn" : "info",
      );
    } else if (still.length) {
      toast(
        `Native IFC: ${result.created} created, ${still.length} left. Open workflow panel → Resume.`,
        "warn",
      );
    } else if (result.created > 0) {
      toast(
        `Native IFC: ${result.created} editable element(s)` +
          (result.failed ? `, ${result.failed} failed` : "") +
          `. Export federated IFC when ready.`,
        result.failed ? "warn" : "success",
      );
    } else if (result.failed) {
      toast(`Native IFC: no twins created (${result.failed} failed).`, "error");
    }
    return result;
  } catch (err) {
    progress.close(null);
    throw err;
  }
}

function openProgressDialog(
  total: number,
  modelId: string,
  onCancel?: () => void,
): {
  update: (i: number, t: number, created: number, failed: number) => void;
  close: (result: BulkConvertResult | null) => void;
} {
  const existing = document.getElementById("obs-native-ifc-progress");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.id = "obs-native-ifc-progress";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:100050;background:rgba(0,0,0,.5);display:flex;" +
    "align-items:center;justify-content:center;font:13px system-ui,sans-serif";
  const card = document.createElement("div");
  card.style.cssText =
    "width:min(400px,92vw);background:#161922;border:1px solid #2a2e3a;border-radius:12px;" +
    "padding:14px 16px;color:#e8eaf0;box-shadow:0 16px 50px rgba(0,0,0,.5)";
  card.innerHTML =
    `<div style="font-weight:700;margin-bottom:6px">Making model editable</div>` +
    `<div style="font-size:11px;color:#94a3b8;margin-bottom:10px">${modelId} · ${total} elements</div>` +
    `<div style="height:8px;background:#1e2230;border-radius:4px;overflow:hidden;margin-bottom:8px">` +
    `<div data-bar style="height:100%;width:0%;background:#0ea5e9;transition:width .15s"></div></div>` +
    `<div data-txt style="font-size:11px;color:#cbd5e1;margin-bottom:10px">Starting…</div>` +
    `<div style="display:flex;justify-content:flex-end">` +
    `<button type="button" data-cancel style="padding:6px 12px;border-radius:6px;border:1px solid #3a3f4d;` +
    `background:#2a2e3a;color:#e8eaf0;cursor:pointer;font-weight:600">Cancel</button></div>`;
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  const bar = card.querySelector("[data-bar]") as HTMLDivElement;
  const txt = card.querySelector("[data-txt]") as HTMLDivElement;
  const cancelBtn = card.querySelector("[data-cancel]") as HTMLButtonElement | null;
  let cancelled = false;
  cancelBtn?.addEventListener("click", () => {
    if (cancelled) return;
    cancelled = true;
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Cancelling…";
    }
    if (txt) txt.textContent = "Cancelling after current element…";
    try {
      onCancel?.();
    } catch {
      /* */
    }
  });
  return {
    update(i, t, created, failed) {
      const pct = t > 0 ? Math.min(100, Math.round((i / t) * 100)) : 0;
      if (bar) bar.style.width = `${pct}%`;
      if (txt && !cancelled) {
        txt.textContent = `${i} / ${t} · ${created} created · ${failed} failed · ${pct}%`;
      }
    },
    close(result) {
      if (cancelBtn) cancelBtn.disabled = true;
      if (result && txt && bar) {
        bar.style.width = "100%";
        const label = result.aborted ? "Cancelled" : "Done";
        txt.textContent =
          `${label} · ${result.created} created · ${result.failed} failed · ${result.skipped} skipped`;
      }
      setTimeout(() => overlay.remove(), result ? 900 : 0);
    },
  };
}

/** Continue Make editable for the last partial/cancelled model. */
export async function resumeModelEditable(): Promise<BulkConvertResult | null> {
  const s = getResumeState();
  if (!s) {
    toast("Nothing to resume — run Make model editable first.", "info");
    return null;
  }
  return makeModelEditable(s.modelId);
}

/** Convert current selection only (linked elements → Native Twins). */

export async function makeSelectionEditable(): Promise<BulkConvertResult> {
  const result = await bulkConvertLinkedToNativeTwin({ quietPerItem: true, openPanelOnSuccess: true });
  if (result.created > 0) {
    recordIfcChange("make-editable", `Selection → ${result.created} native twin(s)`, {
      count: result.created,
    });
  }
  return result;
}

/**
 * Export all Native Twin edits as one federated IFC4 (preferred write-back).
 * Pass `{ perTwin: true }` for legacy one-file-per-twin downloads.
 */
export function exportUpdatedIfc(opts?: { maxFiles?: number; perTwin?: boolean }): number {
  const edits = listTwinEdits();
  if (!edits.length) {
    toast("No Native Twin edits to export. Make model editable first.", "warn");
    return 0;
  }
  if (!opts?.perTwin) {
    try {
      downloadFederatedNativeTwinIfc(edits as any, "openbimstudio-native.ifc");
      toast(`Exported 1 federated IFC4 with ${edits.length} element(s).`, "success");
      recordIfcChange("export-ifc", `Federated IFC4 · ${edits.length} element(s)`, {
        count: edits.length,
      });
      return edits.length;
    } catch (err) {
      console.warn("[native-ifc] federated export failed, falling back to per-twin", err);
    }
  }
  const max = Math.max(1, opts?.maxFiles ?? 40);
  let n = 0;
  for (const e of edits.slice(0, max)) {
    try {
      downloadNativeTwinIfc(e as any);
      n++;
    } catch (err) {
      console.warn("[native-ifc] export twin failed", e?.id, err);
    }
  }
  toast(`Exported ${n} IFC4 file(s) from Native Twins.`, n ? "success" : "warn");
  recordIfcChange("export-ifc", `Exported ${n} IFC4 twin file(s)`, { count: n });
  return n;
}

/** Session status for panels / AI. */
export function nativeIfcStatus(): {
  linkedModels: number;
  twinCount: number;
  historyCount: number;
} {
  return {
    linkedModels: listLinkedModelIds().length,
    twinCount: listTwinEdits().length,
    historyCount: getIfcChangeHistory().length,
  };
}

/* ── Minimal UI panel ─────────────────────────────────────────────────── */

let panel: HTMLDivElement | null = null;

function ensurePanel(): HTMLDivElement {
  if (panel) return panel;
  const root = document.createElement("div");
  root.id = "obs-native-ifc-workflow";
  root.style.cssText =
    "position:fixed;top:96px;right:18px;width:min(380px,calc(100vw - 28px));max-height:min(70vh,520px);" +
    "display:none;flex-direction:column;z-index:9400;background:#161922;border:1px solid #2a2e3a;" +
    "border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.45);color:#e8eaf0;font:12.5px system-ui,sans-serif;overflow:hidden";
  root.innerHTML =
    `<div style="padding:10px 12px;border-bottom:1px solid #2a2e3a;display:flex;align-items:center;gap:8px">` +
    `<b style="flex:1">Native IFC workflow</b>` +
    `<button type="button" data-x style="background:transparent;border:0;color:#94a3b8;cursor:pointer;font-size:16px">×</button></div>` +
    `<div style="padding:10px 12px;font-size:11px;color:#94a3b8;line-height:1.4">` +
    `Browser-native IFC authorship: link IFC → make editable → change geometry/properties → export updated IFC4. ` +
    `Not a Revit plugin — same goals inside openBIMstudio.` +
    `</div>` +
    `<div data-body style="padding:8px 12px 12px;display:flex;flex-direction:column;gap:8px;overflow:auto"></div>`;
  root.querySelector("[data-x]")?.addEventListener("click", () => hideNativeIfcPanel());
  document.body.appendChild(root);
  panel = root;
  return root;
}

function btn(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText = primary
    ? "padding:8px 10px;border-radius:6px;border:1px solid #0284c7;background:#0369a1;color:#fff;font-weight:600;cursor:pointer;text-align:left"
    : "padding:8px 10px;border-radius:6px;border:1px solid #3a3f4d;background:#2a2e3a;color:#e8eaf0;cursor:pointer;text-align:left";
  b.onclick = () => {
    try {
      onClick();
    } catch (err) {
      console.warn("[native-ifc] action failed", err);
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  };
  return b;
}

function renderPanel(): void {
  const root = ensurePanel();
  const body = root.querySelector("[data-body]") as HTMLDivElement;
  if (!body) return;
  body.innerHTML = "";
  const st = nativeIfcStatus();
  const stats = document.createElement("div");
  stats.style.cssText = "font-size:11px;color:#cbd5e1";
  const resume = getResumeState();
  stats.textContent =
    `Linked models: ${st.linkedModels} · Native twins: ${st.twinCount} · History: ${st.historyCount}` +
    (resume ? ` · Resume: ${resume.remaining} left on ${resume.modelId}` : "");
  body.appendChild(stats);

  body.append(
    btn("1. Make linked model editable", true, () => {
      void makeModelEditable();
    }),
    btn("Resume last convert", false, () => {
      void resumeModelEditable();
    }),
    btn("Make selection editable", false, () => {
      void makeSelectionEditable();
    }),
    btn("2. Export federated IFC4", true, () => {
      exportUpdatedIfc();
    }),
    btn("Export per-twin IFC files", false, () => {
      exportUpdatedIfc({ perTwin: true });
    }),
  );

  const histTitle = document.createElement("div");
  histTitle.style.cssText = "margin-top:6px;font-weight:600;font-size:11px;color:#94a3b8";
  histTitle.textContent = "Change history (session)";
  body.appendChild(histTitle);

  const hist = getIfcChangeHistory().slice().reverse().slice(0, 12);
  if (!hist.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:11px;color:#64748b";
    empty.textContent = "No changes recorded yet.";
    body.appendChild(empty);
  } else {
    for (const h of hist) {
      const row = document.createElement("div");
      row.style.cssText = "font-size:10.5px;color:#94a3b8;padding:4px 0;border-bottom:1px solid #1e2230";
      const when = new Date(h.at).toLocaleString();
      row.textContent = `${when} · ${h.summary}`;
      body.appendChild(row);
    }
  }

  body.appendChild(
    btn("Clear history", false, () => {
      clearIfcChangeHistory();
      renderPanel();
    }),
  );
}

export function showNativeIfcPanel(): void {
  const p = ensurePanel();
  p.style.display = "flex";
  renderPanel();
}

export function hideNativeIfcPanel(): void {
  if (panel) panel.style.display = "none";
}

export function toggleNativeIfcPanel(): void {
  const p = ensurePanel();
  if (p.style.display === "none" || !p.style.display) showNativeIfcPanel();
  else hideNativeIfcPanel();
}

export function setupNativeIfcWorkflow(): void {
  const api = {
    makeModelEditable,
    resumeModelEditable,
    getResumeState,
    makeSelectionEditable,
    exportUpdatedIfc,
    getIfcChangeHistory,
    clearIfcChangeHistory,
    recordIfcChange,
    listLinkedModelIds,
    nativeIfcStatus,
    open: showNativeIfcPanel,
    toggle: toggleNativeIfcPanel,
    version: 1,
  };
  try {
    (ctx as Any).features = (ctx as Any).features || {};
    (ctx as Any).features.nativeIfc = api;
  } catch {
    /* */
  }
  try {
    (window as Any).__obsNativeIfc = api;
  } catch {
    /* */
  }
  console.log(
    "[native-ifc] workflow ready — Make model editable · Export updated IFC · Change history (browser-native, not Revit)",
  );
}
