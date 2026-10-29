import { ctx } from "../core/context";
import { registerCommand } from "./command-palette";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" } as Record<string,string>)[c]);

export function openMepLifecyclePanel(): void {
  document.getElementById("obs-mep-lifecycle-panel")?.remove();
  const lifecycle = (ctx.features as any).mep?.lifecycle ?? (window as any).__obsMep?.lifecycle;
  if (!lifecycle) { alert("MEP lifecycle service is not available yet."); return; }
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
    '<section style="padding:14px 0"><h3>Electrical panel schedule</h3><label for="obs-mep-life-panel-select">Panel: </label><select id="obs-mep-life-panel-select">' + (options || '<option value="">No panels in project</option>') + '</select><div id="obs-mep-life-schedule" style="overflow:auto;margin-top:12px"></div></section>' +
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
  select?.addEventListener("change", render); render();
}
try { registerCommand({ id:"mep.nativeDiagnostics", label:"MEP — Connection Diagnostics & Panel Schedules", category:"MEP", hint:"Inspect connector relationships, topology diagnostics and electrical schedules", run:() => openMepLifecyclePanel() }); } catch { /* command palette may boot later */ }
try { (window as any).__obsOpenMepLifecyclePanel = openMepLifecyclePanel; } catch { /* non-browser test */ }
