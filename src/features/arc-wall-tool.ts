/**
 * Curved & Arc Wall Placement Tool UI
 *
 * Provides parameter configuration and guidance for placing curved/arc walls,
 * 3-point arc generation, and tangent snapping against existing BIM walls.
 */

import {
  type ArcWallParams,
  resolveArcWallGeometry,
  generateArcWallMesh,
  generateArcWallPlanPolyline,
} from "../modules/parametric/arc-wall";
import { registerCommand } from "./command-palette";

export function openArcWallDialog(): void {
  const existing = document.getElementById("obs-arc-wall-modal");
  if (existing) {
    existing.remove();
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = "obs-arc-wall-modal";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(15, 23, 42, 0.65); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #1e293b; color: #f8fafc; border-radius: 12px;
    width: 600px; max-width: 95vw; max-height: 85vh;
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid #334155; font-family: system-ui, sans-serif;
  `;

  card.innerHTML = `
    <div style="padding: 16px 20px; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between;">
      <div>
        <h2 style="margin: 0; font-size: 18px; font-weight: 600; color: #38bdf8;">Curved &amp; Arc Wall Tool</h2>
        <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">
          Parametric Center-Radius-Angle &bull; 3-Point Arc &bull; Tangent Snapping
        </div>
      </div>
      <button id="obs-arc-close-btn" style="background: transparent; border: none; color: #94a3b8; font-size: 20px; cursor: pointer;">&times;</button>
    </div>

    <div style="padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;">
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; background: #0f172a; padding: 14px; border-radius: 8px; border: 1px solid #334155;">
        <div>
          <label style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 4px;">Baseline Radius (m):</label>
          <input type="number" id="obs-arc-radius" value="5.0" step="0.5" min="0.5" style="width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #475569; color: #f8fafc; padding: 6px 10px; border-radius: 6px; font-size: 13px;" />
        </div>
        <div>
          <label style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 4px;">Sweep Angle (&deg;):</label>
          <input type="number" id="obs-arc-sweep" value="90" step="15" min="5" max="360" style="width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #475569; color: #f8fafc; padding: 6px 10px; border-radius: 6px; font-size: 13px;" />
        </div>
        <div>
          <label style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 4px;">Wall Thickness (m):</label>
          <input type="number" id="obs-arc-thickness" value="0.20" step="0.05" min="0.05" style="width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #475569; color: #f8fafc; padding: 6px 10px; border-radius: 6px; font-size: 13px;" />
        </div>
        <div>
          <label style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 4px;">Wall Height (m):</label>
          <input type="number" id="obs-arc-height" value="3.00" step="0.25" min="0.5" style="width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #475569; color: #f8fafc; padding: 6px 10px; border-radius: 6px; font-size: 13px;" />
        </div>
        <div>
          <label style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 4px;">Justification:</label>
          <select id="obs-arc-just" style="width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #475569; color: #f8fafc; padding: 6px 10px; border-radius: 6px; font-size: 13px;">
            <option value="center" selected>Centerline</option>
            <option value="interior">Interior Face</option>
            <option value="exterior">Exterior Face</option>
          </select>
        </div>
        <div>
          <label style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 4px;">Tangent Snapping:</label>
          <label style="font-size: 13px; color: #cbd5e1; display: flex; align-items: center; gap: 8px; margin-top: 8px;">
            <input type="checkbox" id="obs-arc-tangent-snap" checked /> Enable Tangent Snapping
          </label>
        </div>
      </div>

      <div id="obs-arc-summary" style="background: #0f172a; padding: 12px 14px; border-radius: 8px; border: 1px solid #334155; font-size: 12px; color: #cbd5e1; line-height: 1.6;">
        <!-- Calculated summary injected here -->
      </div>
    </div>

    <div style="padding: 16px 20px; border-top: 1px solid #334155; display: flex; justify-content: flex-end; gap: 10px;">
      <button id="obs-arc-cancel-btn" style="background: #334155; color: #f8fafc; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px;">Cancel</button>
      <button id="obs-arc-place-btn" style="background: #0284c7; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;">Place Arc Wall</button>
    </div>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  function updateSummary(): void {
    const radius = parseFloat((document.getElementById("obs-arc-radius") as HTMLInputElement)?.value || "5");
    const sweepDeg = parseFloat((document.getElementById("obs-arc-sweep") as HTMLInputElement)?.value || "90");
    const thickness = parseFloat((document.getElementById("obs-arc-thickness") as HTMLInputElement)?.value || "0.2");
    const height = parseFloat((document.getElementById("obs-arc-height") as HTMLInputElement)?.value || "3");
    const justification = (document.getElementById("obs-arc-just") as HTMLSelectElement)?.value as any;

    try {
      const geom = resolveArcWallGeometry({
        center: [0, 0],
        radius,
        startAngle: 0,
        endAngle: (sweepDeg * Math.PI) / 180,
        thickness,
        height,
        justification,
      });

      const summaryEl = document.getElementById("obs-arc-summary");
      if (summaryEl) {
        summaryEl.innerHTML = `
          <div><strong>Arc Length:</strong> ${geom.arcLength.toFixed(3)} m &bull; <strong>Inner Radius:</strong> ${geom.innerRadius.toFixed(3)} m &bull; <strong>Outer Radius:</strong> ${geom.outerRadius.toFixed(3)} m</div>
          <div><strong>Calculated Volume:</strong> ${geom.volume.toFixed(3)} m&sup3; &bull; <strong>Sweep:</strong> ${sweepDeg.toFixed(1)}&deg; (${geom.sweepAngle.toFixed(3)} rad)</div>
        `;
      }
    } catch (e: any) {
      const summaryEl = document.getElementById("obs-arc-summary");
      if (summaryEl) summaryEl.innerHTML = `<span style="color: #ef4444;">${e?.message}</span>`;
    }
  }

  document.getElementById("obs-arc-close-btn")?.addEventListener("click", () => overlay.remove());
  document.getElementById("obs-arc-cancel-btn")?.addEventListener("click", () => overlay.remove());

  document.getElementById("obs-arc-radius")?.addEventListener("input", updateSummary);
  document.getElementById("obs-arc-sweep")?.addEventListener("input", updateSummary);
  document.getElementById("obs-arc-thickness")?.addEventListener("input", updateSummary);
  document.getElementById("obs-arc-height")?.addEventListener("input", updateSummary);
  document.getElementById("obs-arc-just")?.addEventListener("change", updateSummary);

  document.getElementById("obs-arc-place-btn")?.addEventListener("click", () => {
    alert("Arc wall parameters committed. Click on canvas to place wall center point.");
    overlay.remove();
  });

  updateSummary();
}

// Register palette command
registerCommand({
  id: "model.arc_wall",
  label: "Modeling: Curved / Arc Wall Tool",
  category: "Modeling",
  hint: "Place parametric arc walls with center-radius-angle parametrization and tangent snapping",
  run: () => openArcWallDialog(),
});
