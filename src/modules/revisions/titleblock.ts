/**
 * Revision Table Injection for Production Sheets.
 *
 * Generates an SVG revision history table and injects it into sheet titleblocks.
 */

import type { RevisionRecord } from "./model";

export function renderRevisionTableSvg(
  revisions: RevisionRecord[],
  x: number,
  y: number,
  width: number = 140,
  rowHeight: number = 5.5,
  maxRows: number = 6
): string {
  const displayRevs = revisions.slice(-maxRows);

  const colX = {
    rev: x + 4,
    date: x + 24,
    desc: x + 50,
    by: x + width - 14,
  };

  let rowsSvg = "";

  // Table header
  rowsSvg += `
    <rect x="${x}" y="${y}" width="${width}" height="${rowHeight}" fill="#e2e8f0" stroke="#0f172a" stroke-width="0.4" />
    <text x="${colX.rev}" y="${y + 4}" font-family="sans-serif" font-size="3.2" font-weight="700" fill="#0f172a">REV</text>
    <text x="${colX.date}" y="${y + 4}" font-family="sans-serif" font-size="3.2" font-weight="700" fill="#0f172a">DATE</text>
    <text x="${colX.desc}" y="${y + 4}" font-family="sans-serif" font-size="3.2" font-weight="700" fill="#0f172a">DESCRIPTION</text>
    <text x="${colX.by}" y="${y + 4}" font-family="sans-serif" font-size="3.2" font-weight="700" fill="#0f172a">BY</text>
  `;

  // Rows
  for (let i = 0; i < maxRows; i++) {
    const rowY = y + (i + 1) * rowHeight;
    const rev = displayRevs[i];

    rowsSvg += `
      <rect x="${x}" y="${rowY}" width="${width}" height="${rowHeight}" fill="${i % 2 === 0 ? "#ffffff" : "#f8fafc"}" stroke="#cbd5e1" stroke-width="0.3" />
    `;

    if (rev) {
      const shortDesc = rev.description.length > 32 ? rev.description.slice(0, 30) + ".." : rev.description;
      rowsSvg += `
        <text x="${colX.rev}" y="${rowY + 4}" font-family="sans-serif" font-size="3" font-weight="600" fill="#0f172a">${rev.sequenceLabel}</text>
        <text x="${colX.date}" y="${rowY + 4}" font-family="sans-serif" font-size="2.8" fill="#475569">${rev.date}</text>
        <text x="${colX.desc}" y="${rowY + 4}" font-family="sans-serif" font-size="2.8" fill="#0f172a">${shortDesc}</text>
        <text x="${colX.by}" y="${rowY + 4}" font-family="sans-serif" font-size="2.8" fill="#475569">${rev.issuedBy || "AU"}</text>
      `;
    }
  }

  return `<g class="obs-titleblock-revision-table">${rowsSvg}</g>`;
}

export function injectRevisionTableIntoSvg(
  sheetSvg: string,
  revisions: RevisionRecord[],
  sheetWidthMm: number,
  sheetHeightMm: number
): string {
  // Place table above bottom-right titleblock area
  const tableW = 150;
  const tableH = 40;
  const posX = sheetWidthMm - tableW - 12;
  const posY = sheetHeightMm - tableH - 52;

  const tableSvg = renderRevisionTableSvg(revisions, posX, posY, tableW);

  // Inject before closing </svg>
  return sheetSvg.replace("</svg>", `${tableSvg}\n</svg>`);
}
