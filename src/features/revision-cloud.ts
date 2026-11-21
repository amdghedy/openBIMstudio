// BIM-style revisions + revision clouds.
//
// The UI in this file (Revision Settings panel, Annotate > Revision Cloud
// placement) used to keep its own localStorage copy (`obs.revisions.v1`)
// while the titleblock, the sheet register and the sheet PDF read the
// production store in modules/revisions/model.ts (`obs.revisions.records.v2`).
// A revision created in the panel therefore never reached a sheet, and a
// cloud placed here never rendered anywhere. This file now delegates all
// storage to the production store; the v1 keys are migrated once on setup
// when the v2 store is empty, then removed.

import { ctx } from "../core/context";
import { registerCommand } from "./command-palette";
import { confirmDialog } from "./form-modal";
import {
  listAllRevisions,
  listAllClouds,
  addRevisionRecord,
  updateRevisionRecord,
  removeRevisionRecord,
  addRevisionCloudDef,
  removeCloudDef,
  replaceAllRevisions,
  onRevisionStoreChange,
  type RevisionRecord,
  type RevisionCloudDef,
} from "../modules/revisions/model";

export interface RevisionEntry {
  id: string;
  sequence: number;
  description: string;
  date: string;
  issuedTo: string;
  issuedBy: string;
  visible: boolean;
}

export interface RevCloud {
  id: string;
  revisionId: string;
  points: [number, number][];
  viewId: string | null;
}

const STORAGE_REV_LEGACY = "obs.revisions.v1";
const STORAGE_CLOUD_LEGACY = "obs.revisionClouds.v1";

function toEntry(r: RevisionRecord): RevisionEntry {
  return {
    id: r.id,
    sequence: r.sequence,
    description: r.description,
    date: r.date,
    issuedTo: r.issuedTo,
    issuedBy: r.issuedBy,
    visible: r.visible !== false,
  };
}

function toCloud(c: RevisionCloudDef): RevCloud {
  return { id: c.id, revisionId: c.revisionId, points: c.points, viewId: c.viewId };
}

export function listRevisions(): RevisionEntry[] {
  return listAllRevisions().map(toEntry);
}

export function listClouds(): RevCloud[] {
  return listAllClouds().map(toCloud);
}

export function onRevisionsChange(cb: () => void): () => void {
  return onRevisionStoreChange(cb);
}

export function addRevision(partial?: Partial<RevisionEntry>): RevisionEntry {
  const rec = addRevisionRecord({
    sequence: partial?.sequence,
    description: partial?.description,
    date: partial?.date,
    issuedTo: partial?.issuedTo,
    issuedBy: partial?.issuedBy,
    visible: partial?.visible,
  });
  return toEntry(rec);
}

export function updateRevision(id: string, patch: Partial<RevisionEntry>): void {
  updateRevisionRecord(id, patch);
}

export function removeRevision(id: string): void {
  removeRevisionRecord(id);
}

export function placeCloud(revisionId: string, points: [number, number][]): RevCloud | null {
  if (!points || points.length < 3) return null;
  const c = addRevisionCloudDef({ revisionId, points, viewId: null, sheetId: null });
  return toCloud(c);
}

export function removeCloud(id: string): void {
  removeCloudDef(id);
}

/**
 * One-time migration of the legacy v1 store (used by this panel before the
 * unification) into the production v2 store. Runs only when the v2 store
 * is empty and v1 data exists; the v1 keys are removed after a successful
 * import so the migration never runs twice and never resurrects old data.
 */
export function migrateLegacyRevisionStore(): { revisions: number; clouds: number } {
  if (listAllRevisions().length > 0 || listAllClouds().length > 0) {
    return { revisions: 0, clouds: 0 };
  }
  let legacyRevs: unknown = null;
  let legacyClouds: unknown = null;
  try {
    legacyRevs = JSON.parse(localStorage.getItem(STORAGE_REV_LEGACY) || "null");
    legacyClouds = JSON.parse(localStorage.getItem(STORAGE_CLOUD_LEGACY) || "null");
  } catch {
    return { revisions: 0, clouds: 0 };
  }
  if (!Array.isArray(legacyRevs) && !Array.isArray(legacyClouds)) {
    return { revisions: 0, clouds: 0 };
  }
  const revs: RevisionRecord[] = [];
  if (Array.isArray(legacyRevs)) {
    for (const raw of legacyRevs) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== "string" || typeof r.sequence !== "number") continue;
      revs.push({
        id: r.id,
        sequence: r.sequence,
        sequenceLabel: `Rev ${String(r.sequence).padStart(2, "0")}`,
        description: typeof r.description === "string" ? r.description : "",
        date: typeof r.date === "string" ? r.date : new Date().toISOString().slice(0, 10),
        issuedTo: typeof r.issuedTo === "string" ? r.issuedTo : "",
        issuedBy: typeof r.issuedBy === "string" ? r.issuedBy : "",
        checkedBy: "",
        approvedBy: "",
        status: "draft",
        sheetIds: [],
        elementIds: [],
        visible: r.visible !== false,
      });
    }
  }
  const clouds: RevisionCloudDef[] = [];
  if (Array.isArray(legacyClouds)) {
    for (const raw of legacyClouds) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Record<string, unknown>;
      if (typeof c.id !== "string" || typeof c.revisionId !== "string") continue;
      if (!Array.isArray(c.points) || c.points.length < 3) continue;
      clouds.push({
        id: c.id,
        revisionId: c.revisionId,
        points: c.points as [number, number][],
        viewId: typeof c.viewId === "string" ? c.viewId : null,
        sheetId: null,
      });
    }
  }
  if (!revs.length && !clouds.length) return { revisions: 0, clouds: 0 };
  replaceAllRevisions(revs, clouds);
  try {
    localStorage.removeItem(STORAGE_REV_LEGACY);
    localStorage.removeItem(STORAGE_CLOUD_LEGACY);
  } catch { /* ignore */ }
  return { revisions: revs.length, clouds: clouds.length };
}

export async function beginCloudPlacement(): Promise<void> {
  const visible = listRevisions().filter(function (r) { return r.visible; });
  if (!visible.length) {
    const ok = await confirmDialog("Revision cloud", "No revisions defined. Create Revision 1 now?");
    if (!ok) return;
    addRevision({ description: "Initial revision" });
  }
  const all = listRevisions();
  const active = all[all.length - 1];

  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: {
      message: "Revision " + active.sequence + " - click 3+ points, then double-click to close.",
      kind: "info",
    },
  }));

  const pv: any = (ctx.features as any).planView;
  if (pv && typeof pv.beginPolygonCapture === "function") {
    pv.beginPolygonCapture("revision-cloud", function (pts: [number, number][]) {
      placeCloud(active.id, pts);
      window.dispatchEvent(new CustomEvent("obs-toast", {
        detail: { message: "Revision cloud placed.", kind: "success" },
      }));
    });
  } else {
    const w = 5;
    const h = 3;
    placeCloud(active.id, [[-w/2, -h/2], [w/2, -h/2], [w/2, h/2], [-w/2, h/2]]);
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: "Revision cloud placed at origin (no plan-view polygon capture).", kind: "info" },
    }));
  }
}

export function openRevisionPanel(): void {
  const ov = document.createElement("div");
  ov.style.cssText = "position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
  const card = document.createElement("div");
  card.style.cssText = "background:#1b1c26;border:1px solid #34353f;border-radius:10px;padding:16px;width:600px;max-height:80vh;overflow:auto;color:#e2e8f0;font:12px system-ui";
  const closeFn = function () { ov.remove(); };
  ov.onmousedown = function (e) { if (e.target === ov) closeFn(); };

  const render = function () {
    const revisions = listRevisions();
    const clouds = listClouds();
    card.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
        '<b style="font-size:14px">Revision Settings</b>' +
        '<button data-act="close" style="padding:4px 10px;background:transparent;color:#94a3b8;border:1px solid #34353f;border-radius:5px;cursor:pointer">x</button>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:40px 1fr 90px 120px 40px;gap:6px;font-size:10px;color:#6b7280;text-transform:uppercase;margin-bottom:4px">' +
        '<span>Seq</span><span>Description</span><span>Date</span><span>Issued to</span><span></span>' +
      '</div>';

    revisions.forEach(function (r) {
      const row = document.createElement("div");
      row.style.cssText = "display:grid;grid-template-columns:40px 1fr 90px 120px 40px;gap:6px;margin:4px 0;align-items:center";
      const desc = (r.description || "").replace(/"/g, "&quot;");
      const to = (r.issuedTo || "").replace(/"/g, "&quot;");
      row.innerHTML =
        '<b style="color:#38bdf8">' + r.sequence + '</b>' +
        '<input data-id="' + r.id + '" data-k="description" value="' + desc + '" style="padding:3px 6px;background:#0e1017;border:1px solid #34353f;border-radius:4px;color:#e2e8f0;font-size:11px"/>' +
        '<input data-id="' + r.id + '" data-k="date" value="' + r.date + '" style="padding:3px 6px;background:#0e1017;border:1px solid #34353f;border-radius:4px;color:#e2e8f0;font-size:11px"/>' +
        '<input data-id="' + r.id + '" data-k="issuedTo" value="' + to + '" style="padding:3px 6px;background:#0e1017;border:1px solid #34353f;border-radius:4px;color:#e2e8f0;font-size:11px"/>' +
        '<button data-del="' + r.id + '" style="padding:3px 6px;background:transparent;color:#fca5a5;border:1px solid rgba(239,68,68,.4);border-radius:4px;cursor:pointer">x</button>';
      card.appendChild(row);
    });

    const add = document.createElement("button");
    add.textContent = "+ Add Revision";
    add.style.cssText = "margin-top:10px;padding:7px 14px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600";
    add.onclick = function () { addRevision(); render(); };
    card.appendChild(add);

    const hint = document.createElement("div");
    hint.style.cssText = "margin-top:12px;font-size:10.5px;color:#6b7280;line-height:1.5";
    hint.textContent = "Clouds placed: " + clouds.length + ". Use Annotate > Revision Cloud to place.";
    card.appendChild(hint);

    const btns = card.querySelectorAll('[data-act="close"]');
    for (let i = 0; i < btns.length; i++) (btns[i] as any).onclick = closeFn;

    const delBtns = card.querySelectorAll("[data-del]");
    for (let i = 0; i < delBtns.length; i++) {
      (delBtns[i] as any).onclick = function (this: any) {
        removeRevision(this.dataset.del);
        render();
      };
    }

    const inputs = card.querySelectorAll("input[data-k]");
    for (let i = 0; i < inputs.length; i++) {
      (inputs[i] as any).onchange = function (this: any) {
        const patch: any = {};
        patch[this.dataset.k] = this.value;
        updateRevision(this.dataset.id, patch);
      };
    }
  };
  render();
  ov.appendChild(card);
  document.body.appendChild(ov);
}

export function setupRevisionCloud(): void {
  try {
    const migrated = migrateLegacyRevisionStore();
    if (migrated.revisions || migrated.clouds) {
      console.log(`[revision-cloud] migrated ${migrated.revisions} revision(s), ${migrated.clouds} cloud(s) from the legacy store`);
    }
  } catch (e) {
    console.warn("[revision-cloud] legacy migration failed", e);
  }
  try {
    registerCommand({
      id: "annotate.revisionCloud",
      label: "Annotate: Revision Cloud",
      category: "Annotation",
      run: () => beginCloudPlacement(),
    });
    registerCommand({
      id: "annotate.revisions.panel",
      label: "Annotate: Revision Settings...",
      category: "Annotation",
      run: () => openRevisionPanel(),
    });
  } catch (err) {
    console.warn("[revision-cloud] command registration failed", err);
  }

  (ctx.features as any).revisions = {
    list: listRevisions,
    clouds: listClouds,
    add: addRevision,
    update: updateRevision,
    remove: removeRevision,
    placeCloud: placeCloud,
    removeCloud: removeCloud,
    begin: beginCloudPlacement,
    panel: openRevisionPanel,
  };

  console.log("[revision-cloud] ready");
}
