/**
 * Detail Component Library & Drafting Symbols.
 *
 * Implements construction-level 2D architectural & structural drafting symbols:
 * - Breaklines (horizontal / vertical)
 * - Section Callout Heads & Cut Arrows
 * - Grid Bubbles
 * - North Arrows
 * - Elevation Targets
 */

export type DetailComponentType =
  | "break-line"
  | "section-callout"
  | "grid-bubble"
  | "north-arrow"
  | "elevation-target";

export interface DetailComponentDef {
  id: string;
  viewId: string;
  type: DetailComponentType;
  x: number;
  y: number;
  rotationDeg: number;
  label?: string;
  scale?: number;
}

const components: DetailComponentDef[] = [];

export function addDetailComponent(comp: Omit<DetailComponentDef, "id">): DetailComponentDef {
  const item: DetailComponentDef = {
    ...comp,
    id: `det-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
  };
  components.push(item);
  return item;
}

export function listDetailComponents(viewId: string): DetailComponentDef[] {
  return components.filter((c) => c.viewId === viewId);
}

export function renderDetailComponentSvg(comp: DetailComponentDef): string {
  const s = comp.scale || 1.0;
  const rot = comp.rotationDeg || 0;

  switch (comp.type) {
    case "break-line":
      return `
        <g transform="translate(${comp.x}, ${comp.y}) rotate(${rot}) scale(${s})">
          <line x1="-30" y1="0" x2="-8" y2="0" stroke="#0f172a" stroke-width="1.2" />
          <polyline points="-8,0 -4,10 4,-10 8,0" fill="none" stroke="#0f172a" stroke-width="1.2" />
          <line x1="8" y1="0" x2="30" y2="0" stroke="#0f172a" stroke-width="1.2" />
        </g>
      `;

    case "grid-bubble":
      return `
        <g transform="translate(${comp.x}, ${comp.y}) scale(${s})">
          <circle cx="0" cy="0" r="10" fill="#ffffff" stroke="#0f172a" stroke-width="1.5" />
          <text x="0" y="4" font-family="sans-serif" font-size="9" font-weight="700" text-anchor="middle" fill="#0f172a">${comp.label || "A"}</text>
        </g>
      `;

    case "section-callout":
      return `
        <g transform="translate(${comp.x}, ${comp.y}) rotate(${rot}) scale(${s})">
          <circle cx="0" cy="0" r="11" fill="#ffffff" stroke="#0f172a" stroke-width="1.5" />
          <line x1="-11" y1="0" x2="11" y2="0" stroke="#0f172a" stroke-width="1.0" />
          <polygon points="0,-11 8,-20 -8,-20" fill="#0f172a" />
          <text x="0" y="-3" font-family="sans-serif" font-size="7" font-weight="700" text-anchor="middle" fill="#0f172a">${comp.label || "1"}</text>
          <text x="0" y="8" font-family="sans-serif" font-size="6" text-anchor="middle" fill="#475569">A-101</text>
        </g>
      `;

    case "north-arrow":
      return `
        <g transform="translate(${comp.x}, ${comp.y}) rotate(${rot}) scale(${s})">
          <circle cx="0" cy="0" r="14" fill="#ffffff" stroke="#0f172a" stroke-width="1.2" />
          <polygon points="0,-12 4,10 0,6" fill="#0f172a" />
          <polygon points="0,-12 -4,10 0,6" fill="#ffffff" stroke="#0f172a" stroke-width="0.8" />
          <text x="0" y="-15" font-family="sans-serif" font-size="9" font-weight="800" text-anchor="middle" fill="#0f172a">N</text>
        </g>
      `;

    case "elevation-target":
      return `
        <g transform="translate(${comp.x}, ${comp.y}) rotate(${rot}) scale(${s})">
          <circle cx="0" cy="0" r="8" fill="none" stroke="#0f172a" stroke-width="1.2" />
          <path d="M 0,-8 A 8 8 0 0 1 8,0 L 0,0 Z" fill="#0f172a" />
          <path d="M 0,8 A 8 8 0 0 1 -8,0 L 0,0 Z" fill="#0f172a" />
        </g>
      `;

    default:
      return "";
  }
}

export function renderAllDetailComponentsSvg(viewId: string): string {
  return listDetailComponents(viewId).map(renderDetailComponentSvg).join("\n");
}
