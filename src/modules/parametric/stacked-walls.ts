/**
 * Stacked Wall Parametric Engine.
 *
 * Implements vertical composition of multiple wall types into a single
 * coordinated architectural element (e.g. brick veneer on concrete stem wall).
 */

export interface StackedWallSubLayer {
  id: string;
  wallTypeId: string;
  name: string;
  heightM: number;
  offsetM: number; // Vertical offset from wall base
  thicknessM: number;
  justification: "core-center" | "interior-face" | "exterior-face";
}

export interface StackedWallDef {
  id: string;
  name: string;
  totalHeightM: number;
  layers: StackedWallSubLayer[];
  baseElevationM: number;
}

export function createStackedWall(
  name: string,
  layers: Omit<StackedWallSubLayer, "id">[]
): StackedWallDef {
  let accumHeight = 0;
  const subLayers: StackedWallSubLayer[] = [];

  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    subLayers.push({
      ...l,
      id: `layer-${i + 1}`,
      offsetM: accumHeight,
    });
    accumHeight += l.heightM;
  }

  return {
    id: `sw-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    name,
    totalHeightM: Math.round(accumHeight * 1000) / 1000,
    layers: subLayers,
    baseElevationM: 0,
  };
}

export function renderStackedWallSectionSvg(wall: StackedWallDef, heightPx: number = 240): string {
  const scale = (heightPx * 0.85) / Math.max(1, wall.totalHeightM);
  const widthPx = 140;
  const centerX = widthPx / 2;

  let layersSvg = "";
  let currentY = heightPx - 20;

  for (const layer of wall.layers) {
    const layerHPx = layer.heightM * scale;
    const layerWPx = layer.thicknessM * scale * 2.5; // exaggeration for clarity

    currentY -= layerHPx;
    layersSvg += `
      <rect x="${centerX - layerWPx / 2}" y="${currentY}" width="${layerWPx}" height="${layerHPx}" fill="#cbd5e1" stroke="#0f172a" stroke-width="1.2" />
      <text x="${centerX + layerWPx / 2 + 6}" y="${currentY + layerHPx / 2 + 3}" font-family="sans-serif" font-size="9" fill="#0f172a">
        ${layer.name} (${(layer.heightM * 1000).toFixed(0)}mm)
      </text>
    `;
  }

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${widthPx + 160}" height="${heightPx}" viewBox="0 0 ${widthPx + 160} ${heightPx}">
      <line x1="20" y1="${heightPx - 20}" x2="${widthPx + 140}" y2="${heightPx - 20}" stroke="#475569" stroke-width="1.5" stroke-dasharray="4,3" />
      <text x="20" y="${heightPx - 8}" font-family="sans-serif" font-size="8" fill="#475569">BASE ELEVATION (0.00)</text>
      ${layersSvg}
    </svg>
  `;
}
