/**
 * Drawing Register & Sheet Index Generator.
 *
 * Automatically compiles all project sheets, scales, current revisions,
 * dates, and statuses into a formal transmittal / sheet list.
 */

import type { SheetDef } from "../projects/types";
import { getSheetRevisions, type RevisionRecord } from "../revisions/model";

export interface DrawingRegisterRow {
  sheetNumber: string;
  sheetName: string;
  discipline: string;
  scale: string;
  paperSize: string;
  currentRevision: string;
  revisionDate: string;
  status: string;
}

export function buildDrawingRegister(sheets: SheetDef[]): DrawingRegisterRow[] {
  return sheets.map((s) => {
    const revs = getSheetRevisions(s.id);
    const latestRev: RevisionRecord | undefined = revs[revs.length - 1];

    let discipline = "Architectural";
    if (s.number.startsWith("S-") || s.number.startsWith("ST-")) discipline = "Structural";
    if (s.number.startsWith("M-") || s.number.startsWith("H-")) discipline = "Mechanical";
    if (s.number.startsWith("E-")) discipline = "Electrical";
    if (s.number.startsWith("P-")) discipline = "Plumbing";
    if (s.number.startsWith("C-")) discipline = "Civil";

    return {
      sheetNumber: s.number,
      sheetName: s.name,
      discipline,
      scale: s.viewports[0]?.scale || "As noted",
      paperSize: s.size,
      currentRevision: latestRev?.sequenceLabel || "-",
      revisionDate: latestRev?.date || "-",
      status: latestRev?.status || "draft",
    };
  });
}

export function registerToCSV(rows: DrawingRegisterRow[]): string {
  const headers = ["Sheet Number", "Sheet Name", "Discipline", "Scale", "Size", "Current Rev", "Date", "Status"];
  const lines = rows.map((r) => [
    `"${r.sheetNumber}"`,
    `"${r.sheetName}"`,
    `"${r.discipline}"`,
    `"${r.scale}"`,
    `"${r.paperSize}"`,
    `"${r.currentRevision}"`,
    `"${r.revisionDate}"`,
    `"${r.status}"`,
  ]);
  return [headers.join(","), ...lines.map((l) => l.join(","))].join("\n");
}

export function registerToHTML(rows: DrawingRegisterRow[], projectName: string = "OpenBIM Studio Project"): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Drawing Register — ${projectName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 30px; color: #0f172a; }
    h1 { font-size: 20px; border-bottom: 2px solid #0284c7; padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }
    th, td { padding: 8px 12px; border: 1px solid #cbd5e1; text-align: left; }
    th { background: #f1f5f9; font-weight: 600; }
    tr:nth-child(even) { background: #f8fafc; }
    .status { text-transform: uppercase; font-size: 11px; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Drawing Register &amp; Transmittal Index</h1>
  <p>Project: <strong>${projectName}</strong> | Date: <strong>${new Date().toISOString().slice(0, 10)}</strong></p>
  <table>
    <thead>
      <tr><th>Sheet No.</th><th>Sheet Title</th><th>Discipline</th><th>Scale</th><th>Size</th><th>Rev</th><th>Rev Date</th><th>Status</th></tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (r) => `
        <tr>
          <td><strong>${r.sheetNumber}</strong></td>
          <td>${r.sheetName}</td>
          <td>${r.discipline}</td>
          <td>${r.scale}</td>
          <td>${r.paperSize}</td>
          <td>${r.currentRevision}</td>
          <td>${r.revisionDate}</td>
          <td><span class="status">${r.status}</span></td>
        </tr>
      `
        )
        .join("")}
    </tbody>
  </table>
</body>
</html>`;
}
