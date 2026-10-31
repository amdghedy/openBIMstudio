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
  phaseDateRange,
  simulationMs,
} from "../modules/timeline/timeline";
import { importScheduleText, relinkSchedule, summaryNow, onScheduleChange, setupSchedule4d, type ScheduleSummary } from "../modules/schedule-4d/controller";
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

const fmtDate = (ms: number | null) => (ms == null ? "—" : new Date(ms).toISOString().slice(0, 10));
const fmtNum = (n: number) => (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + " M" : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + " k" : n.toFixed(0));

function sparkline(pts: Array<{ t: number; value: number }>, nowMs: number | null, color: string): string {
  if (pts.length < 2) return "";
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t, vmax = Math.max(...pts.map((p) => p.value), 1e-9);
  const X = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * 200, Y = (v: number) => 34 - (v / vmax) * 32;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.value).toFixed(1)}`).join("");
  const now = nowMs == null ? "" : `<line x1="${X(nowMs).toFixed(1)}" x2="${X(nowMs).toFixed(1)}" y1="0" y2="36" stroke="#fbbf24" stroke-width="1.5"/>`;
  return `<svg viewBox="0 0 200 36" width="100%" height="36" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.8"/>${now}</svg>`;
}

function scheduleSection(sum: ScheduleSummary | null): string {
  if (!sum) {
    return `<div class="obs-timeline__p6">
      <div class="obs-timeline__hint"><b>Primavera P6:</b> import a schedule (.xer or PMXML .xml). Activities are linked to model elements by id/WBS
      (element properties <code>activityId</code> / <code>wbs</code>) or by name (e.g. "Level 2 Walls"), then drive 4D playback, 5D cost and 6D carbon.</div>
      <div class="obs-timeline__actions"><button type="button" data-act="p6-import">Import P6 schedule…</button></div></div>`;
  }
  return `<div class="obs-timeline__p6">
    <div class="obs-timeline__actions">
      <button type="button" data-act="p6-import">Re-import…</button>
      <button type="button" data-act="p6-relink" title="Re-link activities to the current model">Re-link</button>
    </div>
    <div class="obs-timeline__kpis">
      <div><span>Date</span><b>${fmtDate(sum.dateMs ?? sum.range?.start ?? null)}</b></div>
      <div><span>Activities</span><b>${sum.tasksDone}/${sum.tasksTotal} done · ${sum.tasksActive} active</b></div>
      <div><span>Linked</span><b>${sum.linkedTasks} of ${sum.tasksTotal}${sum.unlinkedTasks ? ` (${sum.unlinkedTasks} unlinked)` : ""}</b></div>
      <div><span>5D cost</span><b>${fmtNum(sum.cost)} / ${fmtNum(sum.costTotal)}</b>
        <small>P6 ${fmtNum(sum.costSource.p6)} · model ${fmtNum(sum.costSource.model)}</small></div>
      <div><span>6D carbon</span><b>${fmtNum(sum.carbonKg)} / ${fmtNum(sum.carbonTotalKg)} kgCO₂e</b>
        <small>indicative generic factors</small></div>
    </div>
    ${sparkline(sum.costCurve, sum.dateMs, "#22c55e")}
    ${sparkline(sum.carbonCurve, sum.dateMs, "#f97316")}
  </div>`;
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

      ${scheduleSection(summaryNow())}

      <div class="obs-timeline__transport">
        <button type="button" data-act="reset" title="Reset">⏮</button>
        <button type="button" data-act="play" title="${st.playing ? "Pause" : "Play"}">
          ${st.playing ? "⏸" : "▶"}
        </button>
        <input type="range" min="0" max="1000" value="${Math.round(st.progress * 1000)}"
               data-act="scrub" class="obs-timeline__scrub" />
        <span class="obs-timeline__pct">${simulationMs() != null ? fmtDate(simulationMs()) : Math.round(st.progress * 100) + "%"}</span>
      </div>

      <div class="obs-timeline__speed">
        <label>Speed</label>
        <input type="range" min="1" max="100" value="${Math.round(st.speed * 50)}" data-act="speed" />
      </div>

      <div class="obs-timeline__gantt" data-act="gantt">
        <div class="obs-timeline__gantt-header">
          <span class="obs-timeline__gantt-label">Gantt</span>
          <span class="obs-timeline__gantt-axis">
            ${phases.length > 0 ? phases.map((p) => `<span style="flex:1;text-align:center">${esc(String(p.order + 1))}</span>`).join("") : ""}
          </span>
        </div>
        <div class="obs-timeline__gantt-body" data-act="gantt-body">
          ${phases.length === 0
            ? `<div class="obs-timeline__empty">No phases yet.</div>`
            : phases.map((p) => {
              const phaseCount = phases.length || 1;
              const dr = phaseDateRange();
              const ps = dr ? Date.parse(p.startDate as string) : NaN, pe = dr ? Date.parse(p.endDate as string) : NaN;
              const dated = !!dr && Number.isFinite(ps) && Number.isFinite(pe);
              const span = dr ? Math.max(1, dr.end - dr.start) : 1;
              const barWidth = dated ? Math.max(0.8, ((pe - ps) / span) * 100) : 100 / phaseCount;
              const barLeft = dated ? ((ps - dr!.start) / span) * 100 : p.order * barWidth;
              const isBefore = dated ? st.progress < (ps - dr!.start) / span : st.progress < p.order / phaseCount;
              const isAfter = dated ? st.progress > (pe - dr!.start) / span : st.progress > (p.order + 1) / phaseCount;
              const isCurrent = !isBefore && !isAfter;
              const opacity = isBefore ? "0.35" : isCurrent ? "1" : "0.65";
              return `
                <div class="obs-timeline__gantt-row" data-id="${esc(p.id)}">
                  <span class="obs-timeline__gantt-name">${esc(p.name)}</span>
                  <div class="obs-timeline__gantt-track">
                    <div class="obs-timeline__gantt-bar"
                         style="left:${barLeft}%;width:${barWidth}%;background:${esc(p.color)};opacity:${opacity}"
                         title="${esc(p.name)} (${p.elementIds.length} elements)">
                    </div>
                  </div>
                </div>
              `;
            }).join("")}
          <div class="obs-timeline__gantt-playhead" style="left:${Math.round(st.progress * 100)}%"></div>
        </div>
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

    if (el.tagName === "DIV" && act === "gantt-body") {
      el.addEventListener("click", ((ev: Event) => {
        const me = ev as MouseEvent;
        const rect = (el as HTMLElement).getBoundingClientRect();
        const x = me.clientX - rect.left;
        const progress = Math.max(0, Math.min(1, x / rect.width));
        setProgress(progress);
      }) as EventListener);
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
      if (act === "p6-import") {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".xer,.xml,.txt";
        input.onchange = async () => {
          const f = input.files?.[0];
          if (!f) return;
          try {
            const r = await importScheduleText(await f.text(), f.name);
            const msg = r.tasks
              ? `Imported ${r.tasks} activities from ${f.name}; ${r.linked} linked to model elements.` + (r.warnings.length ? ` (${r.warnings.length} warnings)` : "")
              : `No activities found in ${f.name}. ${r.warnings[0] ?? ""}`;
            window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: msg, kind: r.tasks ? "success" : "error" } }));
          } catch (e) {
            window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "P6 import failed: " + (e instanceof Error ? e.message : String(e)), kind: "error" } }));
          }
        };
        input.click();
      }
      if (act === "p6-relink") void relinkSchedule();
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
    .obs-timeline__pct { min-width:36px; text-align:right; font-variant-numeric:tabular-nums; }
    .obs-timeline__speed { display:flex; align-items:center; gap:8px; margin-bottom:10px; font-size:12px; }
    .obs-timeline__speed input { flex:1; }
    .obs-timeline__gantt {
      background:#0f172a; border:1px solid #334155; border-radius:8px; padding:8px; margin-bottom:12px;
    }
    .obs-timeline__gantt-header {
      display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:10px; color:#64748b;
    }
    .obs-timeline__gantt-label { flex-shrink:0; font-weight:600; width:60px; }
    .obs-timeline__gantt-axis { flex:1; display:flex; }
    .obs-timeline__gantt-body {
      position:relative; min-height:60px; padding:4px 0;
    }
    .obs-timeline__gantt-row {
      display:flex; align-items:center; gap:6px; height:22px; margin-bottom:2px;
    }
    .obs-timeline__gantt-name {
      width:60px; flex-shrink:0; font-size:10px; color:#94a3b8; overflow:hidden;
      text-overflow:ellipsis; white-space:nowrap;
    }
    .obs-timeline__gantt-track {
      flex:1; position:relative; height:18px; background:#1e293b; border-radius:3px;
    }
    .obs-timeline__gantt-bar {
      position:absolute; top:2px; bottom:2px; border-radius:3px;
      transition:opacity 0.2s; min-width:8px;
    }
    .obs-timeline__gantt-bar:hover { filter:brightness(1.2); }
    .obs-timeline__gantt-playhead {
      position:absolute; top:0; bottom:0; width:2px; background:#fbbf24;
      pointer-events:none; z-index:10; transition:left 0.1s linear;
      box-shadow:0 0 4px rgba(251,191,36,.5);
    }
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
    .obs-timeline__p6 { background:#0f172a; border:1px solid #334155; border-radius:8px; padding:8px; margin-bottom:10px; }
    .obs-timeline__kpis { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin:6px 0; font-size:11px; }
    .obs-timeline__kpis div { display:flex; flex-direction:column; }
    .obs-timeline__kpis span { color:#64748b; }
    .obs-timeline__kpis small { color:#64748b; }
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
  onScheduleChange(render);
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
  setupSchedule4d();
  ensurePanel();
}
