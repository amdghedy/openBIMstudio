import { ctx } from "../core/context";
import { registerCommand } from "./command-palette";
import { uiAlert } from "../core/notify";
import { openFormModal } from "./form-modal";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" } as Record<string,string>)[c]);

export function openMepLifecyclePanel(): void {
  document.getElementById("obs-mep-lifecycle-panel")?.remove();
  const lifecycle = (ctx.features as any).mep?.lifecycle ?? (window as any).__obsMep?.lifecycle;
  if (!lifecycle) { uiAlert("MEP lifecycle service is not available yet."); return; }
  const snap = lifecycle.snapshot();
  const result = lifecycle.validate();
  const overlay = document.createElement("div");
  overlay.id = "obs-mep-lifecycle-panel";
  overlay.style.cssText = "position:fixed;inset:0;z-index:10020;background:#080c14cc;display:flex;align-items:center;justify-content:center;padding:18px;font:13px/1.5 system-ui;color:#e5e7eb";
  const card = document.createElement("section");
  card.style.cssText = "width:min(1100px,96vw);max-height:88vh;overflow:auto;background:#111827;border:1px solid #374151;border-radius:12px;padding:18px";
  const rows = (items: any[]) => items.length ? items.map(d => '<div style="display:grid;grid-template-columns:75px 220px 1fr;gap:10px;padding:8px;border-bottom:1px solid #293548"><b style="color:' + (d.severity === "error" ? "#f87171" : d.severity === "warning" ? "#fbbf24" : "#34d399") + '">' + esc(d.severity ?? "info") + '</b><code>' + esc(d.code) + '</code><span>' + esc(d.message) + '</span></div>').join("") : '<div style="padding:10px;color:#9ca3af">No diagnostics reported.</div>';
  const options = snap.panels.map((p: any) => '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + esc(p.id) + ')</option>').join("");
  card.innerHTML = '<header style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #374151;padding-bottom:12px"><div><h2 style="margin:0">MEP Systems · Native Model Diagnostics</h2><div style="color:#9ca3af">Revision ' + snap.revision + ' · ' + snap.connectors.length + ' connectors · ' + snap.connections.length + ' relationships · ' + snap.panels.length + ' panels · ' + snap.loads.length + ' loads</div></div><button id="obs-mep-life-close">Close</button></header>' +
    '<section style="padding:14px 0;border-bottom:1px solid #293548"><h3>Connector network diagnostics</h3>' + rows(result.topologyIssues) + '</section>' +
    '<section style="padding:14px 0;border-bottom:1px solid #293548"><h3>Electrical distribution diagnostics</h3>' + rows(result.electricalIssues) + '</section>' +
    '<section style="padding:14px 0"><h3>Electrical panel schedule</h3><label for="obs-mep-life-panel-select">Panel: </label><select id="obs-mep-life-panel-select">' + (options || '<option value="">No panels in project</option>') + '</select> <button id="obs-mep-life-add-panel">Add panel</button> <button id="obs-mep-life-add-load">Add load / circuit</button><div id="obs-mep-life-schedule" style="overflow:auto;margin-top:12px"></div></section>' +
    '<footer style="color:#9ca3af;font-size:11px">Engineering diagnostics support review; they do not replace jurisdiction-specific design checks.</footer>';
  overlay.appendChild(card); document.body.appendChild(overlay);
  card.querySelector("#obs-mep-life-close")?.addEventListener("click", () => overlay.remove());
  const select = card.querySelector<HTMLSelectElement>("#obs-mep-life-panel-select");
  const target = card.querySelector<HTMLDivElement>("#obs-mep-life-schedule");
  const render = () => {
    if (!select?.value || !target) { if (target) target.innerHTML = '<div style="color:#9ca3af">No electrical panel data is stored in this project.</div>'; return; }
    try {
      const s = lifecycle.getPanelSchedule(select.value);
      const trs = s.rows.map((r: any) => '<tr>' + [r.circuitNumber, r.loadNames.join(", ") || "—", r.poles, r.voltageV, r.connectedVA.toFixed(1), r.demandVA.toFixed(1), r.designCurrentA.toFixed(2), r.breakerRatingA, r.status].map(v => '<td style="padding:7px;border-bottom:1px solid #374151;white-space:nowrap">' + esc(v) + '</td>').join("") + '</tr>').join("");
      target.innerHTML = '<div style="display:flex;gap:14px;flex-wrap:wrap;margin:10px 0">' +
        '<span>Connected <b>' + s.totalConnectedVA.toFixed(1) + ' VA</b></span><span>Demand <b>' + s.totalDemandVA.toFixed(1) + ' VA</b></span><span>Demand current <b>' + s.estimatedDemandCurrentA.toFixed(2) + ' A</b></span><span>Spaces <b>' + s.usedSpaces + '/' + (s.usedSpaces + s.availableSpaces) + '</b></span></div>' +
        '<table style="border-collapse:collapse;width:100%;font-size:12px"><thead><tr>' + ["Ckt","Loads","Poles","V","Connected VA","Demand VA","Design A","Breaker A","Status"].map(h => '<th style="text-align:left;padding:7px;background:#1f2937">' + h + '</th>').join("") + '</tr></thead><tbody>' + (trs || '<tr><td colspan="9">No circuits assigned.</td></tr>') + '</tbody></table><h4>Panel diagnostics</h4>' + rows(s.diagnostics);
    } catch (e) { target.textContent = e instanceof Error ? e.message : String(e); }
  };
  select?.addEventListener("change", render);
  card.querySelector("#obs-mep-life-add-panel")?.addEventListener("click", async () => {
    const v = await openFormModal({
      title: "Add electrical panel",
      fields: [
        { kind: "text", key: "name", label: "Panel name", default: "", validate: x => String(x).trim() ? null : "Name is required" },
        { kind: "number", key: "voltageV", label: "Nominal voltage", default: 230, unit: "V", validate: x => Number.isFinite(Number(x)) && Number(x) > 0 ? null : "Must be positive" },
        { kind: "number", key: "phase", label: "Phase (1 or 3)", default: 1, validate: x => [1, 3].includes(Number(x)) ? null : "Must be 1 or 3" },
        { kind: "number", key: "busRatingA", label: "Bus rating", default: 100, unit: "A", validate: x => Number.isFinite(Number(x)) && Number(x) > 0 ? null : "Must be positive" },
        { kind: "number", key: "circuitSpaces", label: "Available circuit spaces", default: 24, validate: x => Number.isInteger(Number(x)) && Number(x) >= 0 ? null : "Must be a non-negative integer" },
      ],
      submitLabel: "Add panel",
    });
    if (!v) return;
    const name = String(v.name);
    const voltageV = Number(v.voltageV), phase = Number(v.phase), busRatingA = Number(v.busRatingA), circuitSpaces = Number(v.circuitSpaces);
    if (!name.trim()) return;
    if (!Number.isFinite(voltageV) || voltageV <= 0 || ![1,3].includes(phase) ||
        !Number.isFinite(busRatingA) || busRatingA <= 0 || !Number.isInteger(circuitSpaces) || circuitSpaces < 0) {
      uiAlert("Invalid panel data. Enter positive voltage and bus rating, phase 1 or 3, and non-negative integer circuit spaces."); return;
    }
    const current = lifecycle.snapshot();
    const id = "P-" + Date.now().toString(36);
    const panels = [...current.panels, { id, name: name.trim(), voltageV, phase, busRatingA, circuitSpaces, circuits: [] }];
    const issues = lifecycle.setElectricalDistribution(panels, current.loads);
    if (issues.some((d: any) => d.severity === "error")) uiAlert("Panel saved with engineering diagnostics. Review the diagnostics panel.");
    overlay.remove(); openMepLifecyclePanel();
  });
  card.querySelector("#obs-mep-life-add-load")?.addEventListener("click", async () => {
    const current = lifecycle.snapshot();
    const panel = current.panels.find((p: any) => p.id === select?.value);
    if (!panel) { uiAlert("Create or select an electrical panel first."); return; }
    const v = await openFormModal({
      title: "Add electrical load",
      fields: [
        { kind: "text", key: "name", label: "Load name", default: "", validate: x => String(x).trim() ? null : "Name is required" },
        { kind: "number", key: "apparentPowerVA", label: "Connected apparent power", default: 500, unit: "VA", validate: x => Number.isFinite(Number(x)) && Number(x) >= 0 ? null : "Must be >= 0" },
        { kind: "number", key: "circuitNumber", label: "Circuit number", default: Math.max(0, ...panel.circuits.map((x: any) => x.circuitNumber)) + 1, validate: x => Number.isInteger(Number(x)) && Number(x) >= 1 ? null : "Must be an integer >= 1" },
        { kind: "number", key: "breakerRatingA", label: "Breaker rating", default: 10, unit: "A", validate: x => Number.isFinite(Number(x)) && Number(x) > 0 ? null : "Must be positive" },
        { kind: "number", key: "poles", label: "Breaker poles (1, 2 or 3)", default: 1, validate: x => [1, 2, 3].includes(Number(x)) ? null : "Must be 1, 2 or 3" },
        { kind: "number", key: "demandFactor", label: "Demand factor (0–1)", default: 1, step: 0.05, validate: x => Number.isFinite(Number(x)) && Number(x) >= 0 && Number(x) <= 1 ? null : "Must be between 0 and 1" },
      ],
      submitLabel: "Add load",
    });
    if (!v) return;
    const name = String(v.name);
    if (!name.trim()) return;
    const apparentPowerVA = Number(v.apparentPowerVA), circuitNumber = Number(v.circuitNumber), breakerRatingA = Number(v.breakerRatingA), poles = Number(v.poles), demandFactor = Number(v.demandFactor);
    if (!Number.isFinite(apparentPowerVA) || apparentPowerVA < 0 || !Number.isInteger(circuitNumber) || circuitNumber < 1 ||
        !Number.isFinite(breakerRatingA) || breakerRatingA <= 0 || ![1,2,3].includes(poles) ||
        !Number.isFinite(demandFactor) || demandFactor < 0 || demandFactor > 1) {
      uiAlert("Invalid load/circuit data. Check VA, circuit number, breaker, poles and demand factor."); return;
    }
    if (panel.circuits.some((x: any) => x.circuitNumber === circuitNumber)) { uiAlert("That circuit number is already used on this panel."); return; }
    const id = "L-" + Date.now().toString(36);
    const circuitId = "C-" + Date.now().toString(36);
    const load = { id, name: name.trim(), apparentPowerVA, voltageV: panel.voltageV, phase: panel.phase, poles, demandFactor, panelId: panel.id, circuitNumber };
    const circuit = { id: circuitId, panelId: panel.id, circuitNumber, loadIds: [id], breakerRatingA, poles, voltageV: panel.voltageV, phase: panel.phase };
    const panels = current.panels.map((p: any) => p.id === panel.id ? { ...p, circuits: [...p.circuits, circuit] } : p);
    const issues = lifecycle.setElectricalDistribution(panels, [...current.loads, load]);
    overlay.remove(); openMepLifecyclePanel();
    if (issues.some((d: any) => d.severity === "error")) uiAlert("Load saved with engineering diagnostics. Review the diagnostics panel.");
  });
  render();
}
try { registerCommand({ id:"mep.nativeDiagnostics", label:"MEP — Connection Diagnostics & Panel Schedules", category:"MEP", hint:"Inspect connector relationships, topology diagnostics and electrical schedules", run:() => openMepLifecyclePanel() }); } catch { /* command palette may boot later */ }
try { (window as any).__obsOpenMepLifecyclePanel = openMepLifecyclePanel; } catch { /* non-browser test */ }
