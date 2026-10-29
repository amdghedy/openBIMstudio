/**
 * MEP Flow Balance & Equipment Sizing Panel.
 *
 * Interactive dockable UI for running flow balancing, inspecting duct/pipe pressure drops,
 * and checking cable tray fills.
 */

import { balanceSystem, exportBalanceReport, type SystemGraph, type BalanceResult } from "../modules/mep/flow-balance";
import { registerCommand } from "./command-palette";

export function openMepBalancePanel(): void {
  const existing = document.getElementById("obs-mep-balance-modal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "obs-mep-balance-modal";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(15, 23, 42, 0.65); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #1e293b; color: #f8fafc; border-radius: 12px;
    width: 760px; max-width: 95vw; max-height: 85vh;
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid #334155; font-family: system-ui, sans-serif;
  `;

  // Sample default network for demonstration / loaded system
  const sampleGraph: SystemGraph = {
    system: "AHU-01 Supply Air",
    nodes: [
      { id: "AHU-01", type: "source" },
      { id: "J-01", type: "junction" },
      { id: "VAV-101", type: "terminal", flowRequired: 850 },
      { id: "VAV-102", type: "terminal", flowRequired: 650 },
    ],
    branches: [
      { id: "B1", fromId: "AHU-01", toId: "J-01", sizeMm: 500, lengthM: 14.5, flowRate: 1500, velocityMs: 5.2, pressureDropPa: 0 },
      { id: "B2", fromId: "J-01", toId: "VAV-101", sizeMm: 350, lengthM: 8.2, flowRate: 850, velocityMs: 4.8, pressureDropPa: 0 },
      { id: "B3", fromId: "J-01", toId: "VAV-102", sizeMm: 300, lengthM: 12.0, flowRate: 650, velocityMs: 4.5, pressureDropPa: 0 },
    ],
  };

  const balanceResult: BalanceResult = balanceSystem(sampleGraph, 220);

  card.innerHTML = `
    <div style="padding: 16px 20px; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between;">
      <div>
        <h2 style="margin: 0; font-size: 18px; font-weight: 600; color: #38bdf8;">MEP Duct &amp; Pipe Flow Balancing</h2>
        <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">
          System: <strong>${sampleGraph.system}</strong> | Total Loss: <strong style="color: ${balanceResult.balanced ? "#10b981" : "#ef4444"};">${balanceResult.totalPressureLossPa} Pa</strong>
        </div>
      </div>
      <button id="obs-mep-close-btn" style="background: transparent; border: none; color: #94a3b8; font-size: 20px; cursor: pointer;">&times;</button>
    </div>

    <div style="padding: 12px 20px; background: #0f172a; border-bottom: 1px solid #334155; display: flex; gap: 12px;">
      <button id="obs-mep-export-btn" style="background: #334155; color: #f8fafc; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;">Export Report (Markdown)</button>
    </div>

    <div style="flex: 1; overflow-y: auto; padding: 16px 20px;">
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="border-bottom: 1px solid #475569; text-align: left; color: #94a3b8;">
            <th style="padding: 8px;">Branch</th>
            <th style="padding: 8px;">From &rarr; To</th>
            <th style="padding: 8px;">Size</th>
            <th style="padding: 8px;">Length</th>
            <th style="padding: 8px;">Flow</th>
            <th style="padding: 8px;">Velocity</th>
            <th style="padding: 8px;">&Delta;P</th>
            <th style="padding: 8px;">Damper Trim</th>
          </tr>
        </thead>
        <tbody>
          ${balanceResult.branches
            .map(
              (b) => `
            <tr style="border-bottom: 1px solid #334155;">
              <td style="padding: 8px; font-weight: 600; color: #38bdf8;">${b.id}</td>
              <td style="padding: 8px;">${b.fromId} &rarr; ${b.toId}</td>
              <td style="padding: 8px;">${b.sizeMm} mm</td>
              <td style="padding: 8px;">${b.lengthM} m</td>
              <td style="padding: 8px;">${b.flowRate} m³/h</td>
              <td style="padding: 8px;">${b.velocityMs} m/s</td>
              <td style="padding: 8px; font-weight: 600;">${b.pressureDropPa} Pa</td>
              <td style="padding: 8px; color: ${b.dampingRequiredPa > 0 ? "#f59e0b" : "#94a3b8"};">
                ${b.dampingRequiredPa > 0 ? `+${b.dampingRequiredPa} Pa` : "0 Pa (Index)"}
              </td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>

      <div style="margin-top: 16px; padding: 12px; background: #0f172a; border-radius: 8px; font-size: 12px; color: #cbd5e1;">
        <strong>Notes:</strong> ${balanceResult.notes.join("; ")}
      </div>
    </div>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  card.querySelector("#obs-mep-close-btn")?.addEventListener("click", () => overlay.remove());
  card.querySelector("#obs-mep-export-btn")?.addEventListener("click", () => {
    const md = exportBalanceReport(balanceResult);
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flow-balance-${sampleGraph.system.replace(/\s+/g, "_")}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
}

try {
  registerCommand({
    id: "mep.flowBalance",
    label: "MEP — System Flow Balance & Pressure Drop",
    category: "MEP",
    run: () => openMepBalancePanel(),
  });
} catch {
  /* command palette deferred */
}
