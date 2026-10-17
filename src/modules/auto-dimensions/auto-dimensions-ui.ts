/**
 * Auto-Dimensions UI – Fluent light panel + toolbar actions.
 */

import { autoDimensionsEngine } from "./auto-dimensions-engine";
import { defaultAutoDimOptions } from "./types";

type Any = Record<string, any>;

const TOKENS = {
  BgBrush: "#F3F3F3",
  SurfaceBrush: "#FFFFFF",
  AccentBrush: "#0078D4",
  TextBrush: "#201F1E",
  TextMutedBrush: "#605E5C",
  BorderBrush: "#E1DFDD",
  Font: '"Segoe UI", system-ui, -apple-system, sans-serif',
};

let panel: HTMLDivElement | null = null;
let styleOk = false;

function injectCss(): void {
  if (styleOk) return;
  styleOk = true;
  const s = document.createElement("style");
  s.id = "obs-auto-dims-ui-css";
  s.textContent = `
#obs-auto-dims-panel {
  position: fixed; top: 100px; right: 16px; width: 320px;
  max-height: calc(100vh - 140px); overflow: auto; z-index: 8700;
  background: ${TOKENS.SurfaceBrush}; color: ${TOKENS.TextBrush};
  border: 1px solid ${TOKENS.BorderBrush}; border-radius: 12px;
  box-shadow: 0 12px 36px rgba(0,0,0,.12), 0 2px 6px rgba(0,0,0,.06);
  font-family: ${TOKENS.Font}; display: none;
}
#obs-auto-dims-panel.is-open { display: flex; flex-direction: column; }
#obs-auto-dims-panel .ad-hdr {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 14px; border-bottom: 1px solid ${TOKENS.BorderBrush};
  background: ${TOKENS.BgBrush}; border-radius: 12px 12px 0 0; cursor: grab;
}
#obs-auto-dims-panel .ad-hdr b { flex: 1; font-size: 14px; font-weight: 600; }
#obs-auto-dims-panel .ad-close {
  width: 28px; height: 28px; border-radius: 6px; border: 1px solid ${TOKENS.BorderBrush};
  background: ${TOKENS.SurfaceBrush}; color: ${TOKENS.TextMutedBrush}; cursor: pointer;
}
#obs-auto-dims-panel .ad-body { padding: 12px 14px 16px; }
#obs-auto-dims-panel .ad-sec {
  margin-bottom: 12px; padding: 10px 12px;
  border: 1px solid ${TOKENS.BorderBrush}; border-radius: 8px; background: ${TOKENS.BgBrush};
}
#obs-auto-dims-panel .ad-sec-title {
  font: 700 10px ${TOKENS.Font}; letter-spacing: .06em; text-transform: uppercase;
  color: ${TOKENS.TextMutedBrush}; margin-bottom: 8px;
}
#obs-auto-dims-panel .ad-btn {
  height: 32px; padding: 0 12px; border-radius: 6px; border: 1px solid ${TOKENS.BorderBrush};
  background: ${TOKENS.SurfaceBrush}; font: 600 12px ${TOKENS.Font}; color: ${TOKENS.TextBrush};
  cursor: pointer; margin: 0 6px 6px 0;
}
#obs-auto-dims-panel .ad-btn:hover { background: #EDEBE9; }
#obs-auto-dims-panel .ad-btn.primary {
  background: ${TOKENS.AccentBrush}; color: #fff; border-color: ${TOKENS.AccentBrush};
}
#obs-auto-dims-panel .ad-btn.primary:hover { background: #106EBE; }
#obs-auto-dims-panel .ad-list {
  max-height: 180px; overflow: auto; font-size: 12px;
}
#obs-auto-dims-panel .ad-item {
  display: flex; align-items: center; gap: 8px; padding: 6px 0;
  border-bottom: 1px solid ${TOKENS.BorderBrush};
}
#obs-auto-dims-panel .ad-item:last-child { border-bottom: none; }
#obs-auto-dims-panel .ad-item span { flex: 1; }
#obs-auto-dims-panel .ad-item button {
  height: 24px; padding: 0 8px; border-radius: 4px; border: 1px solid ${TOKENS.BorderBrush};
  background: ${TOKENS.SurfaceBrush}; cursor: pointer; font-size: 11px;
}
#obs-auto-dims-panel label.ad-check {
  display: flex; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 6px;
  cursor: pointer;
}
#obs-auto-dims-panel input[type="number"] {
  width: 72px; height: 28px; padding: 0 8px; border-radius: 6px;
  border: 1px solid ${TOKENS.BorderBrush}; font: 400 12px ${TOKENS.Font};
}
`;
  document.head.appendChild(s);
}

function notify(kind: string, message: string): void {
  try {
    const n = (window as Any).__obsNotify ?? (window as Any).notify;
    if (typeof n === "function") {
      n(kind, message, { timeout: 3000 });
      return;
    }
  } catch { /* */ }
  console.log(`[auto-dims] ${kind}: ${message}`);
}

function renderPanel(): void {
  if (!panel) return;
  const dims = autoDimensionsEngine.listDimensions();
  const opts = autoDimensionsEngine.getOptions();

  const listHtml = dims.length
    ? dims
        .map(
          (d) => `<div class="ad-item" data-id="${d.id}">
        <span title="${d.kind}">${d.temporary ? "⏱ " : ""}${escapeHtml(d.label)} <small style="color:${TOKENS.TextMutedBrush}">(${d.source})</small></span>
        <button data-act="del" data-id="${d.id}">✕</button>
      </div>`
        )
        .join("")
    : `<div style="color:${TOKENS.TextMutedBrush};padding:8px 0">No dimensions yet.</div>`;

  panel.innerHTML = `
    <div class="ad-hdr">
      <b>Auto Dimensions</b>
      <button class="ad-close" data-act="close">✕</button>
    </div>
    <div class="ad-body">
      <div class="ad-sec">
        <div class="ad-sec-title">Generate</div>
        <button class="ad-btn primary" data-act="auto-both">Auto Plan (X + Y)</button>
        <button class="ad-btn" data-act="auto-x">Horizontal only</button>
        <button class="ad-btn" data-act="auto-y">Vertical only</button>
        <button class="ad-btn" data-act="promote">Promote temporary</button>
        <button class="ad-btn" data-act="clear-auto">Clear auto</button>
        <button class="ad-btn" data-act="clear-all">Clear all</button>
      </div>
      <div class="ad-sec">
        <div class="ad-sec-title">Options</div>
        <label class="ad-check"><input type="checkbox" data-opt="chainOpenings" ${opts.chainOpenings ? "checked" : ""}/> Chain openings</label>
        <label class="ad-check"><input type="checkbox" data-opt="includeReferences" ${opts.includeReferences ? "checked" : ""}/> Include grids / refs</label>
        <div style="display:flex;gap:10px;align-items:center;margin-top:6px;font-size:12px">
          <span>Min length (m)</span>
          <input type="number" step="0.01" min="0" data-opt-num="minLength" value="${opts.minLength}"/>
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:6px;font-size:12px">
          <span>Base offset (m)</span>
          <input type="number" step="0.1" min="0" data-opt-num="baseOffset" value="${opts.baseOffset}"/>
        </div>
      </div>
      <div class="ad-sec">
        <div class="ad-sec-title">Dimensions (${dims.length})</div>
        <div class="ad-list">${listHtml}</div>
      </div>
    </div>`;

  panel.querySelectorAll("[data-act]").forEach((el) => {
    el.addEventListener("click", () => {
      const act = (el as HTMLElement).dataset.act;
      const id = (el as HTMLElement).dataset.id;
      handle(act || "", id);
    });
  });

  panel.querySelectorAll("[data-opt]").forEach((el) => {
    el.addEventListener("change", () => {
      const key = (el as HTMLElement).dataset.opt!;
      autoDimensionsEngine.setOptions({
        [key]: (el as HTMLInputElement).checked,
      } as any);
    });
  });

  panel.querySelectorAll("[data-opt-num]").forEach((el) => {
    el.addEventListener("change", () => {
      const key = (el as HTMLElement).dataset.optNum!;
      const val = Number((el as HTMLInputElement).value);
      if (!Number.isFinite(val)) return;
      autoDimensionsEngine.setOptions({ [key]: val } as any);
    });
  });
}

function handle(act: string, id?: string): void {
  switch (act) {
    case "close":
      closeAutoDimsPanel();
      break;
    case "auto-both": {
      const created = autoDimensionsEngine.autoDimensionPlan({ axis: "both" });
      notify("success", `Created ${created.length} auto dimension string(s)`);
      renderPanel();
      break;
    }
    case "auto-x": {
      const created = autoDimensionsEngine.autoDimensionPlan({ axis: "x" });
      notify("success", `Created ${created.length} horizontal dimension(s)`);
      renderPanel();
      break;
    }
    case "auto-y": {
      const created = autoDimensionsEngine.autoDimensionPlan({ axis: "y" });
      notify("success", `Created ${created.length} vertical dimension(s)`);
      renderPanel();
      break;
    }
    case "promote": {
      const n = autoDimensionsEngine.promoteTemporary();
      notify("info", n ? `Promoted ${n} temporary dimension(s)` : "No temporary dimensions");
      renderPanel();
      break;
    }
    case "clear-auto": {
      const all = autoDimensionsEngine.listDimensions();
      for (const d of all) {
        if (d.source === "auto") autoDimensionsEngine.removeDimension(d.id);
      }
      notify("info", "Cleared auto-generated dimensions");
      renderPanel();
      break;
    }
    case "clear-all": {
      if (!window.confirm("Remove all dimensions?")) return;
      for (const d of autoDimensionsEngine.listDimensions()) {
        autoDimensionsEngine.removeDimension(d.id);
      }
      notify("info", "All dimensions cleared");
      renderPanel();
      break;
    }
    case "del":
      if (id) {
        autoDimensionsEngine.removeDimension(id);
        renderPanel();
      }
      break;
    default:
      break;
  }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function openAutoDimsPanel(): void {
  injectCss();
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "obs-auto-dims-panel";
    document.body.appendChild(panel);
    // simple drag
    let dragging = false;
    let ox = 0;
    let oy = 0;
    panel.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".ad-hdr")) return;
      dragging = true;
      const r = panel!.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging || !panel) return;
      panel.style.left = `${e.clientX - ox}px`;
      panel.style.top = `${e.clientY - oy}px`;
      panel.style.right = "auto";
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }
  renderPanel();
  panel.classList.add("is-open");
}

export function closeAutoDimsPanel(): void {
  panel?.classList.remove("is-open");
}

export function setupAutoDimensionsUI(): void {
  injectCss();
  autoDimensionsEngine.ensureOverlay();
  autoDimensionsEngine.startRenderLoop();

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
      // avoid conflict if already used; still open panel
      if (!e.altKey) {
        e.preventDefault();
        openAutoDimsPanel();
      }
    }
  });

  (window as Any).__obsOpenAutoDims = openAutoDimsPanel;
  (window as Any).__obsAutoDimPlan = () =>
    autoDimensionsEngine.autoDimensionPlan({ axis: "both" });

  autoDimensionsEngine.onChange(() => {
    if (panel?.classList.contains("is-open")) renderPanel();
  });

  console.log("[auto-dimensions] UI ready — Ctrl+Shift+D or Command Center");
}
