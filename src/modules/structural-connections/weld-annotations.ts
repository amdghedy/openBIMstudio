/**
 * Structural Weld Symbol Annotation Generator (AWS A2.4 / ISO 2553).
 *
 * Generates 2D SVG drafting symbols for weld specification on drawings.
 */

export type WeldType =
  | "fillet"
  | "groove-V"
  | "groove-bevel"
  | "groove-square"
  | "plug"
  | "slot";

export type WeldAroundSymbol = "all-around" | "field-weld" | "both";

export interface WeldSymbol {
  id: string;
  weldType: WeldType;
  size: number; // in mm (leg size)
  length?: number; // in mm
  pitch?: number; // in mm
  aroundFlag: WeldAroundSymbol | null;
  fieldWeld: boolean;
  viewId: string;
  leaderPoint: [number, number]; // Joint touch point (arrow head)
  referencePoint: [number, number]; // Start of horizontal reference line
}

const symbols: WeldSymbol[] = [];

export function addWeldSymbol(viewId: string, params: Omit<WeldSymbol, "id">): WeldSymbol {
  const symbol: WeldSymbol = {
    ...params,
    id: `weld-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
  };
  symbols.push(symbol);
  return symbol;
}

export function listWeldSymbols(viewId: string): WeldSymbol[] {
  return symbols.filter((s) => s.viewId === viewId);
}

export function removeWeldSymbol(id: string): void {
  const idx = symbols.findIndex((s) => s.id === id);
  if (idx !== -1) symbols.splice(idx, 1);
}

export function renderWeldSymbolSVG(symbol: WeldSymbol): string {
  const [ax, ay] = symbol.leaderPoint;
  const [rx, ry] = symbol.referencePoint;
  const refLength = 60; // mm length of horizontal bar
  const dir = rx >= ax ? 1 : -1;
  const endX = rx + dir * refLength;

  // AWS weld glyphs
  let glyph = "";
  if (symbol.weldType === "fillet") {
    // Right triangle on arrow side (below line if pointing down)
    glyph = `<path d="M ${rx + 15 * dir} ${ry} L ${rx + 25 * dir} ${ry} L ${rx + 25 * dir} ${ry + 10} Z" fill="#0f172a" />`;
  } else if (symbol.weldType === "groove-V") {
    glyph = `<path d="M ${rx + 15 * dir} ${ry} L ${rx + 20 * dir} ${ry + 10} L ${rx + 25 * dir} ${ry}" fill="none" stroke="#0f172a" stroke-width="1.5" />`;
  } else if (symbol.weldType === "groove-bevel") {
    glyph = `<path d="M ${rx + 18 * dir} ${ry} L ${rx + 18 * dir} ${ry + 10} M ${rx + 18 * dir} ${ry + 10} L ${rx + 24 * dir} ${ry}" fill="none" stroke="#0f172a" stroke-width="1.5" />`;
  } else {
    glyph = `<rect x="${Math.min(rx + 15 * dir, rx + 25 * dir)}" y="${ry}" width="10" height="8" fill="none" stroke="#0f172a" stroke-width="1.5" />`;
  }

  // All around circle
  const allAroundSvg =
    symbol.aroundFlag === "all-around" || symbol.aroundFlag === "both"
      ? `<circle cx="${rx}" cy="${ry}" r="5" fill="none" stroke="#0f172a" stroke-width="1.5" />`
      : "";

  // Field weld flag
  const flagSvg =
    symbol.fieldWeld || symbol.aroundFlag === "field-weld" || symbol.aroundFlag === "both"
      ? `<path d="M ${rx} ${ry} L ${rx} ${ry - 12} L ${rx + 8 * dir} ${ry - 8} L ${rx} ${ry - 4}" fill="#0f172a" stroke="#0f172a" stroke-width="1" />`
      : "";

  const sizeText = `${symbol.size}`;
  const lengthText = symbol.length ? (symbol.pitch ? `${symbol.length}-${symbol.pitch}` : `${symbol.length}`) : "";

  return `
    <g class="obs-weld-symbol" id="${symbol.id}" font-family="sans-serif" font-size="9" fill="#0f172a">
      <!-- Leader line -->
      <line x1="${ax}" y1="${ay}" x2="${rx}" y2="${ry}" stroke="#0f172a" stroke-width="1.5" />
      <!-- Arrowhead -->
      <circle cx="${ax}" cy="${ay}" r="2.5" fill="#0f172a" />
      <!-- Reference line -->
      <line x1="${rx}" y1="${ry}" x2="${endX}" y2="${ry}" stroke="#0f172a" stroke-width="1.5" />
      <!-- Weld glyph -->
      ${glyph}
      <!-- Size -->
      <text x="${rx + 6 * dir}" y="${ry + 8}" text-anchor="${dir > 0 ? "end" : "start"}">${sizeText}</text>
      <!-- Length / Pitch -->
      ${lengthText ? `<text x="${rx + 30 * dir}" y="${ry + 8}" text-anchor="start">${lengthText}</text>` : ""}
      <!-- Special flags -->
      ${allAroundSvg}
      ${flagSvg}
    </g>
  `;
}

export function renderAllWeldSymbolsSVG(viewId: string): string {
  return listWeldSymbols(viewId).map(renderWeldSymbolSVG).join("\n");
}
