/**
 * Model Alignment panel.
 *
 * Shows every loaded model with its current offset and visible bbox center,
 * and gives one-click access to:
 *   • Apply a positioning mode to all models
 *   • Snap any model to a chosen reference model
 *   • Nudge any model in X/Y/Z with a configurable step
 *   • Reset any model to (0,0,0)
 *
 * Everything is live — changes reflect immediately in the viewport and can
 * be saved with Ctrl+S.
 */
import { escapeHtml } from "../core/html-escape";
import * as THREE from "three";
import { ctx } from "../core/context";
import {
  POSITIONING_MODES,
  applyPositioningMode,
  getPositioningMode,
  setPositioningMode,
  setModelOffset,
  getModelOffset,
  getModelBBoxCenter,
  onOffsetsChanged,
  type PositioningMode,
} from "./importer";

const PANEL_ID = "obs-model-align";

let panel: HTMLDivElement | null = null;
let currentMode: PositioningMode = getPositioningMode();
let referenceId: string | null = null;
let nudgeStep = 1.0;
let refreshTimer: number | null = null;

function fmt(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return "—";
  const s = n.toFixed(digits);
  return s === "-0.000" ? "0.000" : s;
}

function fmtVec(v: [number, number, number] | null): string {
  if (!v) return "—";
  return `(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])})`;
}

function ensurePanel(): HTMLDivElement {
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.cssText =
    "position:fixed;left:40px;top:120px;width:520px;max-height:80vh;" +
    "display:none;flex-direction:column;" +
    "background:var(--bg-floating,#1c1e28);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:12px;" +
    "box-shadow:0 24px 60px rgba(0,0,0,.65);" +
    "font:12px system-ui,sans-serif;color:var(--text-primary,#e8eaf0);" +
    "overflow:hidden;z-index:8000";
  panel.onmousedown = (e) => e.stopPropagation();

  panel.innerHTML = `
    <div id="oma-header" style="
      display:flex;align-items:center;gap:10px;padding:10px 12px;
      border-bottom:1px solid var(--border-subtle,#1e2029);
      background:var(--bg-elevated,#181a23);cursor:move;user-select:none">
      <span style="display:flex;color:var(--accent,#38bdf8);font-size:14px">⛓</span>
      <div style="flex:1;font-weight:700;font-size:13px">Model Alignment</div>
      <button id="oma-close" title="Close" style="
        padding:4px 8px;background:transparent;color:var(--text-secondary,#a0a6b5);
        border:1px solid var(--border-default,#2a2e3a);border-radius:5px;
        cursor:pointer;font-size:11px">✕</button>
    </div>

    <div style="padding:12px;border-bottom:1px solid var(--border-subtle,#1e2029)">
      <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;
        color:#6b7280;margin-bottom:6px">Positioning mode</div>
      <select id="oma-mode" style="
        width:100%;box-sizing:border-box;padding:6px 8px;
        background:var(--bg-inset,#0e1017);border:1px solid var(--border-default,#2a2e3a);
        border-radius:5px;color:var(--text-primary,#e8eaf0);font:12px system-ui;cursor:pointer">
      </select>
      <div id="oma-mode-desc" style="font-size:10.5px;color:#94a3b8;
        margin-top:6px;line-height:1.5;padding:6px 8px;
        background:#0e1017;border:1px solid #1e2029;border-radius:4px"></div>
      <button id="oma-apply" style="margin-top:8px;width:100%;padding:8px;
        background:var(--accent,#38bdf8);color:#0b0d12;border:none;
        border-radius:6px;cursor:pointer;font:600 11.5px system-ui">
        Apply mode to all models</button>
    </div>

    <div style="padding:12px;border-bottom:1px solid var(--border-subtle,#1e2029)">
      <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;
        color:#6b7280;margin-bottom:6px">Nudge step</div>
      <div id="oma-steps" style="display:flex;gap:4px"></div>
    </div>

    <div id="oma-body" style="flex:1;overflow-y:auto;padding:8px"></div>

    <div style="padding:10px 12px;border-top:1px solid var(--border-subtle,#1e2029);
      background:var(--bg-elevated,#181a23);display:flex;gap:8px">
      <button id="oma-save" style="flex:1;padding:8px;
        background:var(--accent,#38bdf8);color:#0b0d12;border:none;
        border-radius:6px;cursor:pointer;font:600 11.5px system-ui">
        💾 Save project</button>
      <button id="oma-fit" style="padding:8px 14px;background:var(--bg-hover,#232633);
        color:var(--text-primary,#e8eaf0);border:1px solid var(--border-default,#2a2e3a);
        border-radius:6px;cursor:pointer;font:600 11.5px system-ui">⛶ Fit all</button>
    </div>
  `;

  document.body.appendChild(panel);

  // Populate the mode dropdown.
  const modeSelect = panel.querySelector("#oma-mode") as HTMLSelectElement;
  modeSelect.innerHTML = POSITIONING_MODES
    .map((m) => `<option value="${m.id}">${m.label}</option>`)
    .join("");
  modeSelect.value = currentMode;
  modeSelect.onchange = () => {
    currentMode = modeSelect.value as PositioningMode;
    updateModeDescription();
  };

  // Steps buttons
  const stepsBar = panel.querySelector("#oma-steps") as HTMLElement;
  for (const s of [0.001, 0.01, 0.1, 1, 10, 100]) {
    const b = document.createElement("button");
    b.textContent = s >= 1 ? `${s} m` : `${s * 1000} mm`;
    b.style.cssText =
      "flex:1;padding:5px 4px;font:500 10.5px system-ui;" +
      "background:var(--bg-hover,#232633);color:var(--text-secondary,#a0a6b5);" +
      "border:1px solid var(--border-default,#2a2e3a);border-radius:4px;cursor:pointer";
    b.dataset.step = String(s);
    if (s === nudgeStep) {
      b.style.background = "var(--accent-dim,rgba(56,189,248,.14))";
      b.style.color = "var(--accent,#38bdf8)";
      b.style.borderColor = "var(--accent,#38bdf8)";
    }
    b.onclick = () => {
      nudgeStep = s;
      stepsBar.querySelectorAll("button").forEach((x: any) => {
        x.style.background = "var(--bg-hover,#232633)";
        x.style.color = "var(--text-secondary,#a0a6b5)";
        x.style.borderColor = "var(--border-default,#2a2e3a)";
      });
      b.style.background = "var(--accent-dim,rgba(56,189,248,.14))";
      b.style.color = "var(--accent,#38bdf8)";
      b.style.borderColor = "var(--accent,#38bdf8)";
    };
    stepsBar.appendChild(b);
  }

  (panel.querySelector("#oma-close") as HTMLElement).onclick = () => closeAlign();
  (panel.querySelector("#oma-apply") as HTMLElement).onclick = async () => {
    setPositioningMode(currentMode);
    await applyPositioningMode(currentMode);
    void refreshBody();
  };
  (panel.querySelector("#oma-save") as HTMLElement).onclick = () => {
    const save = (ctx.features as any).projects?.saveProject;
    if (typeof save === "function") void save();
  };
  (panel.querySelector("#oma-fit") as HTMLElement).onclick = () => {
    const fit = (ctx.features as any).cameraTools?.fitAll;
    if (typeof fit === "function") fit();
    else void import("./camera-tools").then((m) => m.fitAll());
  };

  // Draggable header.
  const header = panel.querySelector("#oma-header") as HTMLElement;
  let dragging = false;
  let off = { x: 0, y: 0 };
  header.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).id === "oma-close") return;
    dragging = true;
    const r = panel!.getBoundingClientRect();
    off = { x: e.clientX - r.left, y: e.clientY - r.top };
    (e.target as Element).setPointerCapture(e.pointerId);
  });
  header.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    panel!.style.left = `${Math.max(0, e.clientX - off.x)}px`;
    panel!.style.top = `${Math.max(0, e.clientY - off.y)}px`;
  });
  header.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    (e.target as Element).releasePointerCapture(e.pointerId);
  });

  updateModeDescription();
  return panel;
}

function updateModeDescription(): void {
  const el = panel?.querySelector("#oma-mode-desc") as HTMLElement | null;
  if (!el) return;
  const info = POSITIONING_MODES.find((m) => m.id === currentMode);
  el.textContent = info?.description ?? "";
}

/* ═════════════════════════════════════════════════════════════════════════
   Body rendering
   ═════════════════════════════════════════════════════════════════════════ */
async function refreshBody(): Promise<void> {
  if (!panel) return;
  const body = panel.querySelector("#oma-body") as HTMLElement;
  if (!body) return;

  const ids = Array.from(ctx.fragments.list.keys());
  if (!ids.length) {
    body.innerHTML =
      `<div style="padding:24px 12px;text-align:center;color:#6b7280;font-size:11.5px">
         No models loaded.<br>Load .frag or .ifc files first.
       </div>`;
    return;
  }

  // Pick a sensible default reference (first model).
  if (!referenceId || !ids.includes(referenceId)) referenceId = ids[0];

  const rows: string[] = [];
  for (const id of ids) {
    const offset = getModelOffset(id) ?? [0, 0, 0];
    const center = await getModelBBoxCenter(id);
    const isRef = id === referenceId;

    rows.push(`
      <div data-id="${escapeHtml(id)}" style="
        display:flex;flex-direction:column;gap:6px;padding:10px;
        border:1px solid ${isRef ? "var(--accent,#38bdf8)" : "var(--border-subtle,#1e2029)"};
        border-radius:8px;margin-bottom:8px;
        background:${isRef ? "var(--accent-dim,rgba(56,189,248,.08))" : "var(--bg-inset,#0e1017)"}">

        <div style="display:flex;align-items:center;gap:8px">
          <input type="radio" name="oma-ref" value="${escapeHtml(id)}" ${isRef ? "checked" : ""}
            title="Use as reference model"
            style="cursor:pointer;margin:0" data-act="set-ref" />
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;
              white-space:nowrap" title="${escapeHtml(id)}">
              ${escapeHtml(id)}${isRef ? ` <span style="font-size:9px;opacity:.6;font-weight:400">(reference)</span>` : ""}
            </div>
            <div style="font-size:10px;color:#94a3b8;margin-top:2px;font-family:var(--font-mono,monospace)">
              offset ${fmtVec(offset)}
            </div>
            <div style="font-size:10px;color:#6b7280;margin-top:1px;font-family:var(--font-mono,monospace)">
              bbox center ${fmtVec(center)}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <button data-act="snap" data-id="${escapeHtml(id)}" title="Snap this model to the reference"
              style="padding:4px 8px;background:#2563eb;color:#fff;border:none;
              border-radius:4px;cursor:pointer;font:600 10px system-ui">Snap →</button>
            <button data-act="reset" data-id="${escapeHtml(id)}" title="Set offset to (0,0,0)"
              style="padding:4px 8px;background:transparent;color:#fca5a5;
              border:1px solid rgba(239,68,68,.5);border-radius:4px;
              cursor:pointer;font:600 10px system-ui">Reset</button>
          </div>
        </div>

        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button data-act="nudge" data-id="${escapeHtml(id)}" data-axis="x" data-dir="-1"
            style="flex:1;padding:4px;background:var(--bg-hover,#232633);color:#fca5a5;
            border:1px solid rgba(239,68,68,.4);border-radius:4px;cursor:pointer;font:600 10px system-ui">−X</button>
          <button data-act="nudge" data-id="${escapeHtml(id)}" data-axis="x" data-dir="1"
            style="flex:1;padding:4px;background:var(--bg-hover,#232633);color:#ef4444;
            border:1px solid rgba(239,68,68,.4);border-radius:4px;cursor:pointer;font:600 10px system-ui">+X</button>
          <button data-act="nudge" data-id="${escapeHtml(id)}" data-axis="y" data-dir="-1"
            style="flex:1;padding:4px;background:var(--bg-hover,#232633);color:#a7f3d0;
            border:1px solid rgba(34,197,94,.4);border-radius:4px;cursor:pointer;font:600 10px system-ui">−Y</button>
          <button data-act="nudge" data-id="${escapeHtml(id)}" data-axis="y" data-dir="1"
            style="flex:1;padding:4px;background:var(--bg-hover,#232633);color:#22c55e;
            border:1px solid rgba(34,197,94,.4);border-radius:4px;cursor:pointer;font:600 10px system-ui">+Y</button>
          <button data-act="nudge" data-id="${escapeHtml(id)}" data-axis="z" data-dir="-1"
            style="flex:1;padding:4px;background:var(--bg-hover,#232633);color:#93c5fd;
            border:1px solid rgba(59,130,246,.4);border-radius:4px;cursor:pointer;font:600 10px system-ui">−Z</button>
          <button data-act="nudge" data-id="${escapeHtml(id)}" data-axis="z" data-dir="1"
            style="flex:1;padding:4px;background:var(--bg-hover,#232633);color:#3b82f6;
            border:1px solid rgba(59,130,246,.4);border-radius:4px;cursor:pointer;font:600 10px system-ui">+Z</button>
        </div>
      </div>
    `);
  }

  body.innerHTML = rows.join("");

  // Wire events.
  body.querySelectorAll<HTMLInputElement>('input[name="oma-ref"]').forEach((el) => {
    el.onchange = () => {
      referenceId = el.value;
      void refreshBody();
    };
  });

  body.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((btn) => {
    const act = btn.dataset.act!;
    const id = btn.dataset.id!;
    if (act === "snap") {
      btn.onclick = async () => { await snapToReference(id); };
    } else if (act === "reset") {
      btn.onclick = () => { setModelOffset(id, [0, 0, 0]); void refreshBody(); };
    } else if (act === "nudge") {
      const axis = btn.dataset.axis as "x" | "y" | "z";
      const dir = Number(btn.dataset.dir);
      btn.onclick = () => {
        const cur = getModelOffset(id) ?? [0, 0, 0];
        const next: [number, number, number] = [cur[0], cur[1], cur[2]];
        const i = axis === "x" ? 0 : axis === "y" ? 1 : 2;
        next[i] += dir * nudgeStep;
        setModelOffset(id, next);
        void refreshBody();
      };
    }
  });
}

/**
 * Snap a model to the reference model by matching bbox centers.
 * Sets the model's offset so its visible bbox center coincides with the
 * reference's visible bbox center.
 */
async function snapToReference(modelId: string): Promise<void> {
  if (!referenceId || referenceId === modelId) return;
  const refCenter = await getModelBBoxCenter(referenceId);
  const thisCenter = await getModelBBoxCenter(modelId);
  if (!refCenter || !thisCenter) return;

  const cur = getModelOffset(modelId) ?? [0, 0, 0];
  const delta: [number, number, number] = [
    refCenter[0] - thisCenter[0],
    refCenter[1] - thisCenter[1],
    refCenter[2] - thisCenter[2],
  ];
  setModelOffset(modelId, [
    cur[0] + delta[0],
    cur[1] + delta[1],
    cur[2] + delta[2],
  ]);
  console.log(
    `[align] snapped "${modelId}" to "${referenceId}" by ` +
      `(${delta[0].toFixed(3)}, ${delta[1].toFixed(3)}, ${delta[2].toFixed(3)})`,
  );
  void refreshBody();
}

/* ═════════════════════════════════════════════════════════════════════════
   Public
   ═════════════════════════════════════════════════════════════════════════ */
function isOpen(): boolean {
  return !!panel && panel.style.display === "flex";
}

export function openAlign(): void {
  ensurePanel();
  if (!panel) return;
  panel.style.display = "flex";
  void refreshBody();

  // Subscribe to offset changes so the panel stays in sync.
  if (refreshTimer == null) {
    refreshTimer = window.setInterval(() => {
      if (!isOpen()) return;
      void refreshBody();
    }, 800);
  }
}

export function closeAlign(): void {
  if (panel) panel.style.display = "none";
  if (refreshTimer != null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export function toggleAlign(): void {
  isOpen() ? closeAlign() : openAlign();
}

export function isAlignVisible(): boolean {
  return isOpen();
}

export function setupModelAlign(): void {
  ensurePanel();
  onOffsetsChanged(() => {
    if (isOpen()) void refreshBody();
  });
  console.log("[model-align] ready");
}