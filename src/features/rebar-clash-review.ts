/**
 * Rebar Clash Review & Standards UI Panel.
 *
 * Provides in-browser interactive inspection of rebar clashes, lap splices,
 * and standards configuration.
 */

import { detectRebarClashes, clashReportToCSV, clashReportToHTML, type ClashReport } from "../modules/rebar/clash-detection";
import { REBAR_STANDARDS, type StandardCode } from "../modules/rebar/standards";
import type { RebarBar } from "../modules/rebar/types";

let currentReport: ClashReport | null = null;
let currentStandard: StandardCode = "EC2";

export function openRebarClashReview(bars?: RebarBar[]): void {
  // If no bars passed, grab from global rebar service if active or sample
  const svc = (window as any).__obsRebar;
  const activeBars: RebarBar[] = bars || (svc?.activeBars ?? []);

  currentReport = detectRebarClashes(activeBars, 0.02, currentStandard);

  const existing = document.getElementById("obs-rebar-clash-modal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "obs-rebar-clash-modal";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(15, 23, 42, 0.65); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #1e293b; color: #f8fafc; border-radius: 12px;
    box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);
    width: 780px; max-width: 95vw; max-height: 85vh;
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid #334155; font-family: system-ui, sans-serif;
  `;

  card.innerHTML = `
    <div style="padding: 16px 20px; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between;">
      <div>
        <h2 style="margin: 0; font-size: 18px; font-weight: 600; color: #38bdf8;">Rebar Clash &amp; Clearance Review</h2>
        <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">
          Standard: <strong>${REBAR_STANDARDS[currentStandard].name}</strong> | Hard clashes: <span style="color:#ef4444;font-weight:600;">${currentReport.summary.hard}</span>, Clearance warnings: <span style="color:#f59e0b;font-weight:600;">${currentReport.summary.clearance}</span>
        </div>
      </div>
      <button id="obs-rebar-close-btn" style="background: transparent; border: none; color: #94a3b8; font-size: 20px; cursor: pointer;">&times;</button>
    </div>

    <div style="padding: 12px 20px; background: #0f172a; border-bottom: 1px solid #334155; display: flex; gap: 12px; align-items: center;">
      <button id="obs-rebar-csv-btn" style="background: #334155; color: #f8fafc; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;">Export CSV</button>
      <button id="obs-rebar-html-btn" style="background: #334155; color: #f8fafc; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;">Export HTML Report</button>
      <div style="flex: 1;"></div>
      <label style="font-size: 13px; color: #94a3b8;">Filter:
        <select id="obs-rebar-filter" style="background: #1e293b; color: white; border: 1px solid #475569; padding: 4px 8px; border-radius: 4px; margin-left: 6px;">
          <option value="all">All (${currentReport.summary.total})</option>
          <option value="critical">Hard Clashes (${currentReport.summary.hard})</option>
          <option value="warning">Clearance Warnings (${currentReport.summary.clearance})</option>
        </select>
      </label>
    </div>

    <div style="flex: 1; overflow-y: auto; padding: 12px 20px;">
      ${
        currentReport.clashes.length === 0
          ? `<div style="padding: 40px; text-align: center; color: #94a3b8;">No rebar clashes detected in the current layout. All bars satisfy minimum standard clearances!</div>`
          : `<table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <thead>
                <tr style="border-bottom: 1px solid #475569; text-align: left; color: #94a3b8;">
                  <th style="padding: 8px;">Severity</th>
                  <th style="padding: 8px;">Bar 1</th>
                  <th style="padding: 8px;">Bar 2</th>
                  <th style="padding: 8px;">Distance</th>
                  <th style="padding: 8px;">Type</th>
                  <th style="padding: 8px;">Action</th>
                </tr>
              </thead>
              <tbody id="obs-rebar-table-body">
                ${currentReport.clashes
                  .map(
                    (c) => `
                  <tr data-severity="${c.severity}" style="border-bottom: 1px solid #334155;">
                    <td style="padding: 8px;">
                      <span style="display:inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; background: ${
                        c.severity === "critical" ? "#ef4444" : "#f59e0b"
                      }; color: white;">
                        ${c.severity}
                      </span>
                    </td>
                    <td style="padding: 8px;">${c.bar1Label}</td>
                    <td style="padding: 8px;">${c.bar2Label}</td>
                    <td style="padding: 8px;">${(c.distance * 1000).toFixed(0)} mm</td>
                    <td style="padding: 8px;">${c.type}</td>
                    <td style="padding: 8px;">
                      <button data-bar1="${c.bar1Id}" data-bar2="${c.bar2Id}" class="obs-rebar-isolate-btn" style="background: #0284c7; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 12px;">Isolate</button>
                    </td>
                  </tr>
                `
                  )
                  .join("")}
              </tbody>
            </table>`
      }
    </div>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Event handlers
  card.querySelector("#obs-rebar-close-btn")?.addEventListener("click", () => overlay.remove());

  card.querySelector("#obs-rebar-csv-btn")?.addEventListener("click", () => {
    if (!currentReport) return;
    const csv = clashReportToCSV(currentReport);
    downloadFile(csv, "rebar-clashes.csv", "text/csv");
  });

  card.querySelector("#obs-rebar-html-btn")?.addEventListener("click", () => {
    if (!currentReport) return;
    const html = clashReportToHTML(currentReport);
    downloadFile(html, "rebar-clash-report.html", "text/html");
  });

  card.querySelectorAll(".obs-rebar-isolate-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const target = e.currentTarget as HTMLElement;
      const b1 = target.getAttribute("data-bar1");
      const b2 = target.getAttribute("data-bar2");
      window.dispatchEvent(
        new CustomEvent("obs-select", {
          detail: { ids: [b1, b2].filter(Boolean) },
        })
      );
      overlay.remove();
    });
  });

  const filterSelect = card.querySelector("#obs-rebar-filter") as HTMLSelectElement | null;
  filterSelect?.addEventListener("change", () => {
    const val = filterSelect.value;
    const rows = card.querySelectorAll("#obs-rebar-table-body tr") as NodeListOf<HTMLTableRowElement>;
    rows.forEach((r) => {
      if (val === "all" || r.getAttribute("data-severity") === val) {
        r.style.display = "";
      } else {
        r.style.display = "none";
      }
    });
  });
}

export function openRebarStandardsDialog(): void {
  const existing = document.getElementById("obs-rebar-standards-modal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "obs-rebar-standards-modal";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(15, 23, 42, 0.65); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #1e293b; color: #f8fafc; border-radius: 12px;
    width: 600px; max-width: 95vw; padding: 20px;
    border: 1px solid #334155; font-family: system-ui, sans-serif;
  `;

  card.innerHTML = `
    <h2 style="margin: 0 0 16px 0; font-size: 18px; color: #38bdf8;">Rebar International Standard Code</h2>
    <div style="display: flex; flex-direction: column; gap: 12px;">
      ${(Object.keys(REBAR_STANDARDS) as StandardCode[])
        .map((code) => {
          const std = REBAR_STANDARDS[code];
          return `
            <label style="display: flex; align-items: flex-start; gap: 10px; padding: 12px; border-radius: 8px; background: ${
              currentStandard === code ? "#0284c722" : "#0f172a"
            }; border: 1px solid ${currentStandard === code ? "#0284c7" : "#334155"}; cursor: pointer;">
              <input type="radio" name="rebar-std" value="${code}" ${currentStandard === code ? "checked" : ""} style="margin-top: 4px;">
              <div>
                <div style="font-weight: 600; color: white;">${std.name}</div>
                <div style="font-size: 12px; color: #94a3b8; margin-top: 2px;">
                  Yield strength: ${std.yieldStrengthMPa} MPa | Bar sizes: ${std.bars.map((b) => b.label).slice(0, 6).join(", ")}...
                </div>
              </div>
            </label>
          `;
        })
        .join("")}
    </div>
    <div style="margin-top: 20px; display: flex; justify-content: flex-end; gap: 10px;">
      <button id="obs-rebar-std-cancel" style="background: transparent; color: #94a3b8; border: 1px solid #475569; padding: 6px 14px; border-radius: 6px; cursor: pointer;">Cancel</button>
      <button id="obs-rebar-std-save" style="background: #0284c7; color: white; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-weight: 600;">Apply Standard</button>
    </div>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  card.querySelector("#obs-rebar-std-cancel")?.addEventListener("click", () => overlay.remove());
  card.querySelector("#obs-rebar-std-save")?.addEventListener("click", () => {
    const selected = (card.querySelector('input[name="rebar-std"]:checked') as HTMLInputElement)?.value as StandardCode;
    if (selected) {
      currentStandard = selected;
      window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: `Rebar standard set to ${REBAR_STANDARDS[selected].name}`, kind: "success" } }));
    }
    overlay.remove();
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
