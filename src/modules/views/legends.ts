/**
 * Drawing Legend & Keynote System.
 *
 * Automatically compiles finish legends, room legends, and symbol keys.
 */

export interface LegendItem {
  id: string;
  symbolCode?: string;
  colorSwatch?: string;
  patternName?: string;
  tag: string;
  description: string;
}

export interface LegendDef {
  id: string;
  title: string;
  category: "finishes" | "symbols" | "mep-services" | "partitions";
  items: LegendItem[];
}

export function renderLegendSvg(legend: LegendDef, x: number, y: number, width: number = 90): string {
  const rowHeight = 7;
  let itemsSvg = "";

  legend.items.forEach((item, idx) => {
    const rowY = y + 12 + idx * rowHeight;
    const swatchSvg = item.colorSwatch
      ? `<rect x="${x + 4}" y="${rowY - 4}" width="8" height="5" fill="${item.colorSwatch}" stroke="#0f172a" stroke-width="0.5" />`
      : `<circle cx="${x + 8}" cy="${rowY - 1.5}" r="3" fill="#0f172a" />`;

    itemsSvg += `
      ${swatchSvg}
      <text x="${x + 16}" y="${rowY}" font-family="sans-serif" font-size="3.5" font-weight="600" fill="#0f172a">${item.tag}</text>
      <text x="${x + 32}" y="${rowY}" font-family="sans-serif" font-size="3.2" fill="#475569">${item.description}</text>
    `;
  });

  const totalHeight = 16 + legend.items.length * rowHeight;

  return `
    <g class="obs-drawing-legend">
      <rect x="${x}" y="${y}" width="${width}" height="${totalHeight}" fill="#ffffff" stroke="#0f172a" stroke-width="0.8" rx="2" />
      <rect x="${x}" y="${y}" width="${width}" height="8" fill="#f1f5f9" stroke="#0f172a" stroke-width="0.5" />
      <text x="${x + 4}" y="${y + 5.5}" font-family="sans-serif" font-size="4" font-weight="700" fill="#0f172a">${legend.title}</text>
      ${itemsSvg}
    </g>
  `;
}
