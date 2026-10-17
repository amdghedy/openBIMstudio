/**
 * Automation panel — run and manage production rules.
 */
import {
  listRules,
  addRule,
  removeRule,
  runRule,
  ensureDefaultRules,
  onRulesChange,
} from "../modules/automation/rules";

let panel: HTMLElement | null = null;
let visible = false;

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
}

function render() {
  if (!panel) return;
  const rules = listRules();
  panel.innerHTML = `
    <div class="obs-panel-header">
      <span>Automation</span>
      <button type="button" class="obs-icon-btn" data-act="close">×</button>
    </div>
    <div class="obs-panel-body">
      <div style="font-size:11px;color:#94a3b8;margin-bottom:10px">
        Rule-based automation for colouring, isolation, phasing and production checks.
        Foundation for Dynamo-style workflows inside Open BIM Studio.
      </div>
      <div style="display:flex;gap:6px;margin-bottom:10px">
        <button type="button" data-act="add" class="obs-auto-btn">+ Rule</button>
        <button type="button" data-act="defaults" class="obs-auto-btn">Defaults</button>
      </div>
      ${rules.map((r) => `
        <div class="obs-auto-row">
          <div>
            <div style="font-weight:600">${esc(r.name)}</div>
            <div style="font-size:11px;color:#64748b">${esc(r.trigger)}${r.condition ? " · " + esc(r.condition) : ""}</div>
          </div>
          <div style="display:flex;gap:4px">
            <button type="button" data-act="run" data-id="${esc(r.id)}" class="obs-auto-btn">Run</button>
            <button type="button" data-act="del" data-id="${esc(r.id)}" class="obs-auto-btn">×</button>
          </div>
        </div>`).join("")}
    </div>
  `;
  panel.querySelectorAll("[data-act]").forEach((el) => {
    const act = (el as HTMLElement).dataset.act!;
    const id = (el as HTMLElement).dataset.id;
    el.addEventListener("click", async () => {
      if (act === "close") setVisible(false);
      if (act === "add") { addRule(); render(); }
      if (act === "defaults") { ensureDefaultRules(); render(); }
      if (act === "run" && id) {
        const res = await runRule(id);
        alert(res.message || (res.ok ? "Done" : "Failed"));
      }
      if (act === "del" && id) { removeRule(id); render(); }
    });
  });
}

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.className = "obs-side-panel";
  panel.style.cssText =
    "position:fixed;top:48px;right:12px;width:340px;max-height:calc(100vh - 80px);" +
    "background:#1e2430;color:#e2e8f0;border:1px solid #334155;border-radius:10px;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.45);z-index:8000;display:none;overflow:auto;" +
    "font:13px/1.4 system-ui,sans-serif;";
  document.body.appendChild(panel);
  const style = document.createElement("style");
  style.textContent = `
    .obs-auto-btn { background:#334155;border:1px solid #475569;color:#e2e8f0;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px; }
    .obs-auto-btn:hover { background:#475569; }
    .obs-auto-row { display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px;background:#0f172a;border-radius:6px;margin-bottom:6px;border:1px solid #334155; }
    .obs-panel-header { display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #334155;font-weight:600; }
    .obs-panel-body { padding:12px; }
    .obs-icon-btn { background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer; }
  `;
  document.head.appendChild(style);
  onRulesChange(render);
  ensureDefaultRules();
  return panel;
}

export function setVisible(on: boolean) {
  visible = on;
  ensurePanel().style.display = on ? "block" : "none";
  if (on) render();
}
export function toggleAutomationPanel() { setVisible(!visible); }
export function isAutomationPanelVisible() { return visible; }
export function setupAutomationPanel() { ensurePanel(); }
