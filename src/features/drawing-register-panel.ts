/**
 * Drawing Register Panel UI.
 *
 * Provides a formal drawing transmittal and sheet register table with CSV and HTML exports.
 */

import { buildDrawingRegister, registerToCSV, registerToHTML, type DrawingRegisterRow } from "../modules/sheets/sheet-register";
import { listSheets } from "../modules/sheets/sheets";
import { registerCommand } from "./command-palette";

export function openDrawingRegisterPanel(): void {
  const existing = document.getElementById("obs-drawing-register-modal");
  if (existing) existing.remove();

  const sheets = listSheets();
  const rows = buildDrawingRegister(sheets);

  const overlay = document.createElement("div");
  overlay.id = "obs-drawing-register-modal";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(15, 23, 42, 0.65); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #1e293b; color: #f8fafc; border-radius: 12px;
    width: 840px; max-width: 95vw; max-height: 85vh;
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid #334155; font-family: system-ui, sans-serif;
  `;

  card.innerHTML = `
    <div style="padding: 16px 20px; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between;">
      <div>
        <h2 style="margin: 0; font-size: 18px; font-weight: 600; color: #38bdf8;">Drawing Register &amp; Sheet Index</h2>
        <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">
          Total Production Sheets: <strong>${rows.length}</strong>
        </div>
      </div>
      <button id="obs-reg-close-btn" style="background: transparent; border: none; color: #94a3b8; font-size: 20px; cursor: pointer;">&times;</button>
    </div>

    <div style="padding: 12px 20px; background: #0f172a; border-bottom: 1px solid #334155; display: flex; gap: 12px;">
      <button id="obs-reg-csv-btn" style="background: #334155; color: #f8fafc; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;">Export CSV</button>
      <button id="obs-reg-html-btn" style="background: #334155; color: #f8fafc; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;">Export Transmittal HTML</button>
    </div>

    <div style="flex: 1; overflow-y: auto; padding: 16px 20px;">
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="border-bottom: 1px solid #475569; text-align: left; color: #94a3b8;">
            <th style="padding: 8px;">Sheet No.</th>
            <th style="padding: 8px;">Sheet Name</th>
            <th style="padding: 8px;">Discipline</th>
            <th style="padding: 8px;">Scale</th>
            <th style="padding: 8px;">Size</th>
            <th style="padding: 8px;">Rev</th>
            <th style="padding: 8px;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr style="border-bottom: 1px solid #334155;">
              <td style="padding: 8px; font-weight: 700; color: #38bdf8;">${r.sheetNumber}</td>
              <td style="padding: 8px;">${r.sheetName}</td>
              <td style="padding: 8px;">${r.discipline}</td>
              <td style="padding: 8px;">${r.scale}</td>
              <td style="padding: 8px;">${r.paperSize}</td>
              <td style="padding: 8px; font-weight: 600;">${r.currentRevision}</td>
              <td style="padding: 8px;">
                <span style="display:inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; background: #334155; color: #94a3b8;">
                  ${r.status}
                </span>
              </td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  card.querySelector("#obs-reg-close-btn")?.addEventListener("click", () => overlay.remove());

  card.querySelector("#obs-reg-csv-btn")?.addEventListener("click", () => {
    const csv = registerToCSV(rows);
    downloadFile(csv, "drawing-register.csv", "text/csv");
  });

  card.querySelector("#obs-reg-html-btn")?.addEventListener("click", () => {
    const html = registerToHTML(rows);
    downloadFile(html, "drawing-register.html", "text/html");
  });
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

try {
  registerCommand({
    id: "drawings.register",
    label: "Sheets — Drawing Register & Transmittal",
    category: "Drawings",
    run: () => openDrawingRegisterPanel(),
  });
} catch {
  /* command palette deferred */
}
