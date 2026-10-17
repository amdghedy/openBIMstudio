// Revit-style revisions + revision clouds.
import { ctx } from "../core/context";
import { registerCommand } from "./command-palette";

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

const STORAGE_REV = "obs.revisions.v1";
const STORAGE_CLOUD = "obs.revisionClouds.v1";

let revisions: RevisionEntry[] = [];
let clouds: RevCloud[] = [];
const listeners = new Set<() => void>();

function load(): void {
  try {
    revisions = JSON.parse(localStorage.getItem(STORAGE_REV) || "[]") || [];
    clouds = JSON.parse(localStorage.getItem(STORAGE_CLOUD) || "[]") || [];
  } catch (e) {
    revisions = [];
    clouds = [];
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_REV, JSON.stringify(revisions));
    localStorage.setItem(STORAGE_CLOUD, JSON.stringify(clouds));
  } catch (e) { /* ignore */ }
  listeners.forEach(function (cb) {
    try { cb(); } catch (e) { /* ignore */ }
  });
}

export function listRevisions(): RevisionEntry[] { return revisions.slice(); }
export function listClouds(): RevCloud[] { return clouds.slice(); }

export function onRevisionsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function addRevision(partial?: Partial<RevisionEntry>): RevisionEntry {
  const lastSeq = revisions.length ? revisions[revisions.length - 1].sequence : 0;
  const seq = (partial && partial.sequence) ? partial.sequence : lastSeq + 1;
  const rev: RevisionEntry = {
    id: "rev-" + Date.now() + "-" + Math.random().toString(16).slice(2, 6),
    sequence: seq,
    description: (partial && partial.description) || "",
    date: (partial && partial.date) || new Date().toISOString().slice(0, 10),
    issuedTo: (partial && partial.issuedTo) || "",
    issuedBy: (partial && partial.issuedBy) || "",
    visible: partial && partial.visible !== undefined ? partial.visible : true,
  };
  revisions.push(rev);
  save();
  return rev;
}

export function updateRevision(id: string, patch: Partial<RevisionEntry>): void {
  const r = revisions.filter(function (x) { return x.id === id; })[0];
  if (!r) return;
  Object.keys(patch).forEach(function (k) {
    (r as any)[k] = (patch as any)[k];
  });
  save();
}

export function removeRevision(id: string): void {
  revisions = revisions.filter(function (r) { return r.id !== id; });
  clouds = clouds.filter(function (c) { return c.revisionId !== id; });
  save();
}

export function placeCloud(revisionId: string, points: [number, number][]): RevCloud | null {
  if (!points || points.length < 3) return null;
  const cl: RevCloud = {
    id: "cloud-" + Date.now() + "-" + Math.random().toString(16).slice(2, 6),
    revisionId: revisionId,
    points: points,
    viewId: null,
  };
  clouds.push(cl);
  save();
  return cl;
}

export function removeCloud(id: string): void {
  clouds = clouds.filter(function (c) { return c.id !== id; });
  save();
}

export function beginCloudPlacement(): void {
  const visible = revisions.filter(function (r) { return r.visible; });
  if (!visible.length) {
    const ok = confirm("No revisions defined. Create Revision 1 now?");
    if (!ok) return;
    addRevision({ description: "Initial revision" });
  }
  const active = revisions[revisions.length - 1];

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
  load();
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