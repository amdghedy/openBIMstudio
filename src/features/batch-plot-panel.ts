/**
 * Enterprise Multi-Sheet Batch Vector PDF Plotter UI
 *
 * User-facing dialog to configure and trigger multi-sheet batch vector PDF compilation,
 * watermarking, cover sheet drawing registers, and transmittal downloads.
 */

import { listSheets } from "../modules/sheets/sheets";
import { downloadBatchPlotPdf, type BatchPlotOptions, type WatermarkStatus } from "../modules/export/batch-plotter";
import { registerCommand } from "./command-palette";

export function openBatchPlotPanel(): void {
  const existing = document.getElementById("obs-batch-plot-modal");
  if (existing) existing.remove();

  const sheets = listSheets();

  const overlay = document.createElement("div");
  overlay.id = "obs-batch-plot-modal";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(15, 23, 42, 0.65); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #1e293b; color: #f8fafc; border-radius: 12px;
    width: 760px; max-width: 95vw; max-height: 88vh;
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid #334155; font-family: system-ui, sans-serif;
  `;

  card.innerHTML = `
    <div style="padding: 16px 20px; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between;">
      <div>
        <h2 style="margin: 0; font-size: 18px; font-weight: 600; color: #38bdf8;">Enterprise Multi-Sheet Batch Plotter</h2>
        <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">
          Vector PDF Transmittal Package &bull; Dynamic Watermarking &bull; Drawing Register
        </div>
      </div>
      <button id="obs-bp-close-btn" style="background: transparent; border: none; color: #94a3b8; font-size: 20px; cursor: pointer;">&times;</button>
    </div>

    <div style="padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px;">
      <!-- Project Metadata Grid -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; background: #0f172a; padding: 14px; border-radius: 8px; border: 1px solid #334155;">
        <div>
          <label style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 4px;">Project Name:</label>
          <input type="text" id="obs-bp-proj-name" value="OpenBIM Headquarters Project" style="width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #475569; color: #f8fafc; padding: 6px 10px; border-radius: 6px; font-size: 13px;" />
        </div>
        <div>
          <label style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 4px;">Client / Owner:</label>
          <input type="text" id="obs-bp-client-name" value="Ministry of Infrastructure" style="width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #475569; color: #f8fafc; padding: 6px 10px; border-radius: 6px; font-size: 13px;" />
        </div>
        <div>
          <label style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 4px;">Discipline / Package:</label>
          <input type="text" id="obs-bp-discipline" value="Architecture &amp; Structure" style="width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #475569; color: #f8fafc; padding: 6px 10px; border-radius: 6px; font-size: 13px;" />
        </div>
        <div>
          <label style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 4px;">Drawn By / Dept:</label>
          <input type="text" id="obs-bp-drawn-by" value="BIM Engineering Dept" style="width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #475569; color: #f8fafc; padding: 6px 10px; border-radius: 6px; font-size: 13px;" />
        </div>
      </div>

      <!-- Watermark & Cover Sheet Options -->
      <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 12px; background: #0f172a; padding: 14px; border-radius: 8px; border: 1px solid #334155;">
        <div>
          <label style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 4px;">Watermark / Issue Status:</label>
          <select id="obs-bp-watermark" style="width: 100%; background: #1e293b; border: 1px solid #475569; color: #f8fafc; padding: 6px 10px; border-radius: 6px; font-size: 13px;">
            <option value="FOR CONSTRUCTION" selected>FOR CONSTRUCTION</option>
            <option value="ISSUED FOR REVIEW">ISSUED FOR REVIEW</option>
            <option value="PRELIMINARY - NOT FOR CONSTRUCTION">PRELIMINARY - NOT FOR CONSTRUCTION</option>
            <option value="TENDER / BIDDING">TENDER / BIDDING</option>
            <option value="AS-BUILT">AS-BUILT</option>
            <option value="CONFIDENTIAL">CONFIDENTIAL</option>
            <option value="">None (Clean Export)</option>
          </select>
        </div>
        <div>
          <label style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 4px;">Stamp Color:</label>
          <select id="obs-bp-watermark-color" style="width: 100%; background: #1e293b; border: 1px solid #475569; color: #f8fafc; padding: 6px 10px; border-radius: 6px; font-size: 13px;">
            <option value="red" selected>Red (High Visibility)</option>
            <option value="gray">Gray (Subtle)</option>
            <option value="blue">Blue (Formal)</option>
          </select>
        </div>
      </div>

      <div style="display: flex; align-items: center; gap: 8px;">
        <input type="checkbox" id="obs-bp-cover-cb" checked style="cursor: pointer;" />
        <label for="obs-bp-cover-cb" style="font-size: 13px; color: #cbd5e1; cursor: pointer;">
          Include Cover Page with Drawing Register &amp; Table of Contents
        </label>
      </div>

      <!-- Sheet Multi-Select List -->
      <div style="background: #0f172a; border-radius: 8px; border: 1px solid #334155; overflow: hidden;">
        <div style="padding: 10px 14px; background: #1e293b; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 13px; font-weight: 600; color: #cbd5e1;">Select Sheets to Plot</span>
          <div style="display: flex; gap: 10px;">
            <button id="obs-bp-select-all" style="background: transparent; border: none; color: #38bdf8; font-size: 12px; cursor: pointer; text-decoration: underline;">Select All</button>
            <button id="obs-bp-select-none" style="background: transparent; border: none; color: #94a3b8; font-size: 12px; cursor: pointer; text-decoration: underline;">Clear</button>
          </div>
        </div>

        <div style="max-height: 200px; overflow-y: auto; padding: 8px 14px;">
          ${sheets.length === 0 ? '<div style="padding: 12px; color: #94a3b8; font-size: 13px; text-align: center;">No sheets found in current project. Create sheets in the Sheets panel first.</div>' : ''}
          ${sheets.map((s) => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #1e293b;">
              <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #f1f5f9; cursor: pointer;">
                <input type="checkbox" class="obs-bp-sheet-cb" data-id="${s.id}" checked style="cursor: pointer;" />
                <strong>${s.number}</strong> &mdash; ${s.name}
              </label>
              <span style="font-size: 12px; color: #94a3b8;">${s.size} ${s.orientation}</span>
            </div>
          `).join("")}
        </div>
      </div>
    </div>

    <!-- Footer Controls -->
    <div style="padding: 14px 20px; background: #0f172a; border-top: 1px solid #334155; display: flex; justify-content: space-between; align-items: center;">
      <div id="obs-bp-status" style="font-size: 13px; color: #94a3b8;">Ready to compile PDF</div>
      <button id="obs-bp-plot-btn" style="background: #2563eb; color: #fff; border: none; padding: 8px 18px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px;">
        Plot Selected Sheets to Vector PDF
      </button>
    </div>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Handlers
  document.getElementById("obs-bp-close-btn")?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById("obs-bp-select-all")?.addEventListener("click", () => {
    overlay.querySelectorAll<HTMLInputElement>(".obs-bp-sheet-cb").forEach((cb) => (cb.checked = true));
  });

  document.getElementById("obs-bp-select-none")?.addEventListener("click", () => {
    overlay.querySelectorAll<HTMLInputElement>(".obs-bp-sheet-cb").forEach((cb) => (cb.checked = false));
  });

  document.getElementById("obs-bp-plot-btn")?.addEventListener("click", async () => {
    const selectedCbs = overlay.querySelectorAll<HTMLInputElement>(".obs-bp-sheet-cb:checked");
    const selectedIds = Array.from(selectedCbs).map((cb) => cb.getAttribute("data-id") || "").filter(Boolean);

    if (selectedIds.length === 0 && sheets.length > 0) {
      alert("Please select at least one sheet to plot.");
      return;
    }

    const statusEl = document.getElementById("obs-bp-status");
    const plotBtn = document.getElementById("obs-bp-plot-btn") as HTMLButtonElement | null;
    if (statusEl) statusEl.textContent = "Compiling vector PDF transmittal package...";
    if (plotBtn) {
      plotBtn.disabled = true;
      plotBtn.style.opacity = "0.6";
    }

    try {
      const options: BatchPlotOptions = {
        sheetIds: selectedIds.length > 0 ? selectedIds : undefined,
        watermarkText: (document.getElementById("obs-bp-watermark") as HTMLSelectElement)?.value as WatermarkStatus,
        watermarkColor: (document.getElementById("obs-bp-watermark-color") as HTMLSelectElement)?.value as "red" | "gray" | "blue",
        includeCoverSheet: (document.getElementById("obs-bp-cover-cb") as HTMLInputElement)?.checked,
        projectName: (document.getElementById("obs-bp-proj-name") as HTMLInputElement)?.value,
        clientName: (document.getElementById("obs-bp-client-name") as HTMLInputElement)?.value,
        discipline: (document.getElementById("obs-bp-discipline") as HTMLInputElement)?.value,
        drawnBy: (document.getElementById("obs-bp-drawn-by") as HTMLInputElement)?.value,
      };

      await downloadBatchPlotPdf(options);
      if (statusEl) statusEl.textContent = "PDF generation complete!";
      setTimeout(() => overlay.remove(), 1200);
    } catch (err: any) {
      if (statusEl) statusEl.textContent = `Plot error: ${err?.message || err}`;
    } finally {
      if (plotBtn) {
        plotBtn.disabled = false;
        plotBtn.style.opacity = "1";
      }
    }
  });
}

// Register palette command
registerCommand({
  id: "export.batch_plot_pdf",
  label: "Export: Enterprise Multi-Sheet Batch Plot (PDF)",
  category: "Export",
  hint: "Batch plot drawing sets with cover sheet, watermarks, and dynamic titleblock stamping",
  run: () => openBatchPlotPanel(),
});
