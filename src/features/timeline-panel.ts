/**
 * 4D Timeline panel — construction simulation UI.
 * Competitive feature vs Navisworks TimeLiner / Synchro.
 */
import {
  getTimelineState,
  listPhases,
  addPhase,
  updatePhase,
  removePhase,
  assignSelectionToPhase,
  clearPhaseElements,
  setProgress,
  setPlaying,
  setSpeed,
  resetTimeline,
  createDefaultPhases,
  exportTimelineJson,
  importTimelineJson,
  onTimelineChange,
} from "../modules/timeline/timeline";
import { selection } from "./selection";

let panel: HTMLElement | null = null;
let visible = false;

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
}

function download(name: string, text: string) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function render() {
  if (!panel) return;
  const st = getTimelineState();
  const phases = listPhases();

  panel.innerHTML = `
    <div class="obs-panel-header">
      <span>4D Construction Simulation</span>
      <button type="button" class="obs-icon-btn" data-act="close" title="Close">×</button>
    </div>
    <div class="obs-panel-body obs-timeline">
      <div class="obs-timeline__hint">
        Assign selected elements to phases, then play the timeline.
        Competes with Navisworks TimeLiner for open federated models.
      </div>

      <div class="obs-timeline__transport">
        <button type="button" data-act="reset" title="Reset">⏮</button>
        <button type="button" data-act="play" title="${st.playing ? "Pause" : "Play"}">
          ${st.playing ? "⏸" : "▶"}
        </button>
        <input type="range" min="0" max="1000" value="${Math.round(st.progress * 1000)}"
               data-act="scrub" class="obs-timeline__scrub" />
        <span class="obs-timeline__pct">${Math.round(st.progress * 100)}%</span>
      </div>

      <div class="obs-timeline__speed">
        <label>Speed</label>
        <input type="range" min="1" max="100" value="${Math.round(st.speed * 50)}" data-act="speed" />
      </div>

      <div class="obs-timeline__actions">
        <button type="button" data-act="add">+ Phase</button>
        <button type="button" data-act="defaults">Default phases</button>
        <button type="button" data-act="export">Export</button>
        <button type="button" data-act="import">Import</button>
      </div>

      <div class="obs-timeline__list">
        ${phases.length === 0
          ? `<div class="obs-timeline__empty">No phases yet. Add phases or load defaults.</div>`
          : phases.map((p) => `
            <div class="obs-timeline__phase" data-id="${esc(p.id)}">
              <div class="obs-timeline__phase-head">
                <span class="obs-timeline__swatch" style="background:${esc(p.color)}"></span>
                <input class="obs-timeline__name" value="${esc(p.name)}" data-act="rename" data-id="${esc(p.id)}" />
                <span class="obs-timeline__count">${p.elementIds.length}</span>
                <button type="button" data-act="assign" data-id="${esc(p.id)}" title="Assign selection">＋</button>
                <button type="button" data-act="clear" data-id="${esc(p.id)}" title="Clear elements">⌀</button>
                <button type="button" data-act="del" data-id="${esc(p.id)}" title="Delete">×</button>
              </div>
              <div class="obs-timeline__phase-meta">
                <label>Before
                  <select data-act="before" data-id="${esc(p.id)}">
                    <option value="hidden" ${p.beforeMode === "hidden" ? "selected" : ""}>Hidden</option>
                    <option value="ghost" ${p.beforeMode === "ghost" ? "selected" : ""}>Ghost</option>
                    <option value="visible" ${p.beforeMode === "visible" ? "selected" : ""}>Visible</option>
                  </select>
                </label>
                <label>After
                  <select data-act="after" data-id="${esc(p.id)}">
                    <option value="hidden" ${p.afterMode === "hidden" ? "selected" : ""}>Hidden</option>
                    <option value="ghost" ${p.afterMode === "ghost" ? "selected" : ""}>Ghost</option>
                    <option value="visible" ${p.afterMode === "visible" ? "selected" : ""}>Visible</option>
                    <option value="complete" ${p.afterMode === "complete" ? "selected" : ""}>Complete</option>
                  </select>
                </label>
              </div>
            </div>`).join("")}
      </div>
    </div>
  `;

  // Wire events
  panel.querySelectorAll("[data-act]").forEach((el) => {
    const act = (el as HTMLElement).dataset.act!;
    const id = (el as HTMLElement).dataset.id;

    if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "range") {
      el.addEventListener("input", () => {
        if (act === "scrub") setProgress(Number((el as HTMLInputElement).value) / 1000);
        if (act === "speed") setSpeed(Number((el as HTMLInputElement).value) / 50);
      });
      return;
    }

    if (el.tagName === "SELECT") {
      el.addEventListener("change", () => {
        const val = (el as HTMLSelectElement).value as any;
        if (act === "before" && id) updatePhase(id, { beforeMode: val });
        if (act === "after" && id) updatePhase(id, { afterMode: val });
      });
      return;
    }

    if (el.tagName === "INPUT" && act === "rename" && id) {
      el.addEventListener("change", () => {
        updatePhase(id, { name: (el as HTMLInputElement).value.trim() || "Phase" });
      });
      return;
    }

    el.addEventListener("click", () => {
      if (act === "close") { setVisible(false); return; }
      if (act === "play") setPlaying(!getTimelineState().playing);
      if (act === "reset") resetTimeline();
      if (act === "add") addPhase();
      if (act === "defaults") createDefaultPhases();
      if (act === "export") download("timeline-4d.json", exportTimelineJson());
      if (act === "import") {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = async () => {
          const f = input.files?.[0];
          if (!f) return;
          importTimelineJson(await f.text());
        };
        input.click();
      }
      if (act === "assign" && id) {
        const snap = selection.snapshot?.() ?? {};
        const ids: string[] = [];
        for (const [modelId, set] of Object.entries(snap)) {
          for (const localId of set as Set<number>) {
            ids.push(`${modelId}:${localId}`);
          }
        }
        
        const auth = (window as any).__obsAuthoring;
        if (auth?.getSelectedIds) {
          for (const authId of auth.getSelectedIds()) {
            ids.push(authId);
          }
        }

        if (!ids.length) {
          alert("Select elements in the model first, then click Assign.");
          return;
        }
        assignSelectionToPhase(id, ids);
      }
      if (act === "clear" && id) clearPhaseElements(id);
      if (act === "del" && id) removePhase(id);
    });
  });
}

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.className = "obs-side-panel obs-timeline-panel";
  panel.style.cssText =
    "position:fixed;top:48px;right:12px;width:340px;max-height:calc(100vh - 80px);" +
    "background:#1e2430;color:#e2e8f0;border:1px solid #334155;border-radius:10px;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.45);z-index:8000;display:none;overflow:auto;" +
    "font:13px/1.4 system-ui,sans-serif;";
  document.body.appendChild(panel);

  // Minimal styles
  const style = document.createElement("style");
  style.textContent = `
    .obs-timeline__hint { font-size:11px; color:#94a3b8; margin-bottom:10px; }
    .obs-timeline__transport { display:flex; align-items:center; gap:6px; margin-bottom:8px; }
    .obs-timeline__scrub { flex:1; }
    .obs-timeline__pct { width:36px; text-align:right; font-variant-numeric:tabular-nums; }
    .obs-timeline__speed { display:flex; align-items:center; gap:8px; margin-bottom:10px; font-size:12px; }
    .obs-timeline__speed input { flex:1; }
    .obs-timeline__actions { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
    .obs-timeline__actions button, .obs-timeline__transport button {
      background:#334155; border:1px solid #475569; color:#e2e8f0; border-radius:6px;
      padding:4px 8px; cursor:pointer; font-size:12px;
    }
    .obs-timeline__actions button:hover, .obs-timeline__transport button:hover { background:#475569; }
    .obs-timeline__phase {
      background:#0f172a; border:1px solid #334155; border-radius:8px; padding:8px; margin-bottom:8px;
    }
    .obs-timeline__phase-head { display:flex; align-items:center; gap:6px; }
    .obs-timeline__swatch { width:12px; height:12px; border-radius:3px; flex-shrink:0; }
    .obs-timeline__name {
      flex:1; background:transparent; border:none; color:#f1f5f9; font:inherit; min-width:0;
    }
    .obs-timeline__count { font-size:11px; color:#64748b; }
    .obs-timeline__phase-meta { display:flex; gap:10px; margin-top:6px; font-size:11px; color:#94a3b8; }
    .obs-timeline__phase-meta select {
      background:#1e293b; border:1px solid #334155; color:#e2e8f0; border-radius:4px; font-size:11px;
    }
    .obs-timeline__empty { color:#64748b; font-size:12px; padding:12px 0; text-align:center; }
    .obs-panel-header {
      display:flex; justify-content:space-between; align-items:center;
      padding:10px 12px; border-bottom:1px solid #334155; font-weight:600;
    }
    .obs-panel-body { padding:12px; }
    .obs-icon-btn { background:none; border:none; color:#94a3b8; font-size:18px; cursor:pointer; }
  `;
  document.head.appendChild(style);

  onTimelineChange(render);
  return panel;
}

export function setVisible(on: boolean) {
  visible = on;
  const el = ensurePanel();
  el.style.display = on ? "block" : "none";
  if (on) render();
}

export function toggleTimelinePanel() {
  setVisible(!visible);
}

export function isTimelinePanelVisible() {
  return visible;
}

export function setupTimelinePanel() {
  ensurePanel();
}
