/**
 * SVG renderer for Scene2D.
 *
 * Supports the `hatch` SceneEntity kind via SVG `<pattern>` defs. Each
 * unique (pattern, color, scale) tuple produces one `<pattern>` element
 * in the SVG `<defs>` block, referenced by `fill="url(#pattern-id)"`.
 */

import type { Scene2D, SceneEntity, StrokeStyle } from "../scene";
import { paperToWorld } from "../scene";
import { getPattern as getHatchPattern } from "../hatch-patterns";
import { generateHatchLines, generateHatchDots } from "../hatch-patterns";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface SvgRenderOptions {
  scale: number;
  padding: number;
  widthPx: number;
  heightPx: number;
}

export function renderSceneToSvg(scene: Scene2D, opts: SvgRenderOptions): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("width", String(opts.widthPx));
  svg.setAttribute("height", String(opts.heightPx));

  const pad = opts.padding;
  const vbMinX = scene.bounds.minX - pad;
  const vbMinY = -(scene.bounds.maxZ + pad);
  const vbW = (scene.bounds.maxX - scene.bounds.minX) + 2 * pad;
  const vbH = (scene.bounds.maxZ - scene.bounds.minZ) + 2 * pad;
  svg.setAttribute("viewBox", `${vbMinX} ${vbMinY} ${vbW} ${vbH}`);

  // Build <defs> block for any hatch patterns used in the scene.
  const defs = document.createElementNS(SVG_NS, "defs");
  svg.appendChild(defs);

  // Track which patterns we've already defined to avoid duplicates.
  const definedPatterns = new Set<string>();

  // Pre-scan: collect all hatch entities and define their patterns up front.
  const allEntities: SceneEntity[] = [
    ...scene.layers.below,
    ...scene.layers.grid,
    ...scene.layers.project,
    ...scene.layers.overhead,
    ...scene.layers.cut,
    ...scene.layers.symbols,
    ...scene.layers.annotation,
  ];
  for (const e of allEntities) {
    if (e.kind !== "hatch") continue;
    const patternKey = `${e.pattern}-${e.color}-${e.scale}`;
    if (definedPatterns.has(patternKey)) continue;
    definedPatterns.add(patternKey);
    defineHatchPattern(defs, e.pattern, e.color, e.scale, patternKey);
  }

  const order: Array<[string, SceneEntity[]]> = [
    ["below", scene.layers.below],
    ["grid", scene.layers.grid],
    ["project", scene.layers.project],
    ["overhead", scene.layers.overhead],
    ["cut", scene.layers.cut],
    ["symbols", scene.layers.symbols],
    ["annotation", scene.layers.annotation],
  ];

  for (const [name, entities] of order) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-layer", name);
    for (const e of entities) drawEntity(g, e, opts.scale);
    svg.appendChild(g);
  }

  return svg;
}

/**
 * Define an SVG <pattern> element for a hatch pattern + color + scale.
 * The pattern is referenced via `fill="url(#patternKey)"`.
 *
 * Patterns tile across the SVG via patternUnits="userSpaceOnUse" so they
 * stay aligned to the world coordinate system regardless of element position.
 */
function defineHatchPattern(
  defs: SVGDefsElement,
  patternId: string,
  color: string,
  scale: number,
  patternKey: string,
): void {
  // The pattern library expects polygons in world coords; we need to compute
  // the tile size and place line segments inside the tile.
  const pattern = getHatchPattern(patternId);
  if (!pattern) return;

  const tileW = pattern.tile[0] * 0.001 * scale;
  const tileH = pattern.tile[1] * 0.001 * scale;
  if (tileW <= 0 || tileH <= 0) return;

  // Note: SVG Y is flipped relative to world Z. We draw the pattern tile
  // at (0, 0) with size (tileW, tileH) and let SVG flip via the polygon's
  // path commands (which already use -z for Y).
  const pat = document.createElementNS(SVG_NS, "pattern");
  pat.setAttribute("id", patternKey);
  pat.setAttribute("width", String(tileW));
  pat.setAttribute("height", String(tileH));
  pat.setAttribute("patternUnits", "userSpaceOnUse");

  // Add line segments within the tile.
  for (const seg of pattern.segments) {
    const x0 = (seg[0] / pattern.tile[0]) * tileW;
    const y0 = -(seg[1] / pattern.tile[1]) * tileH; // flip Y
    const x1 = (seg[2] / pattern.tile[0]) * tileW;
    const y1 = -(seg[3] / pattern.tile[1]) * tileH;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(x0));
    line.setAttribute("y1", String(y0));
    line.setAttribute("x2", String(x1));
    line.setAttribute("y2", String(y1));
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", String(pattern.strokeWidth));
    pat.appendChild(line);
  }

  // Add dots within the tile.
  if (pattern.dots) {
    for (const dot of pattern.dots) {
      const cx = (dot[0] / pattern.tile[0]) * tileW;
      const cy = -(dot[1] / pattern.tile[1]) * tileH;
      const r = dot[2] * 0.001 * scale;
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(cy));
      circle.setAttribute("r", String(r));
      circle.setAttribute("fill", color);
      pat.appendChild(circle);
    }
  }

  defs.appendChild(pat);
}

function drawEntity(parent: SVGGElement, e: SceneEntity, viewScale: number): void {
  switch (e.kind) {
    case "line": {
      const el = document.createElementNS(SVG_NS, "line");
      el.setAttribute("x1", String(e.x1));
      el.setAttribute("y1", String(-e.z1));
      el.setAttribute("x2", String(e.x2));
      el.setAttribute("y2", String(-e.z2));
      applyStroke(el, e.stroke, viewScale);
      parent.appendChild(el);
      break;
    }
    case "polyline": {
      const d = e.points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]} ${-p[1]}`).join(" ") + (e.closed ? " Z" : "");
      const el = document.createElementNS(SVG_NS, "path");
      el.setAttribute("d", d);
      if (e.fill) {
        el.setAttribute("fill", e.fill.color);
        el.setAttribute("fill-opacity", String(e.fill.opacity));
      } else el.setAttribute("fill", "none");
      applyStroke(el, e.stroke, viewScale);
      parent.appendChild(el);
      break;
    }
    case "arc": {
      const cx = e.cx;
      const cy = -e.cz;
      const r = e.r;
      const x0 = cx + Math.cos(e.a0) * r;
      const y0 = cy - Math.sin(e.a0) * r;
      const x1 = cx + Math.cos(e.a1) * r;
      const y1 = cy - Math.sin(e.a1) * r;
      const large = Math.abs(e.a1 - e.a0) > Math.PI ? 1 : 0;
      const sweep = e.a1 > e.a0 ? 0 : 1;
      const el = document.createElementNS(SVG_NS, "path");
      el.setAttribute("d", `M ${x0} ${y0} A ${r} ${r} 0 ${large} ${sweep} ${x1} ${y1}`);
      el.setAttribute("fill", "none");
      applyStroke(el, e.stroke, viewScale);
      parent.appendChild(el);
      break;
    }
    case "circle": {
      const el = document.createElementNS(SVG_NS, "circle");
      el.setAttribute("cx", String(e.cx));
      el.setAttribute("cy", String(-e.cz));
      el.setAttribute("r", String(e.r));
      el.setAttribute("fill", e.fill ? e.fill.color : "none");
      if (e.fill) el.setAttribute("fill-opacity", String(e.fill.opacity));
      applyStroke(el, e.stroke, viewScale);
      parent.appendChild(el);
      break;
    }
    case "text": {
      const el = document.createElementNS(SVG_NS, "text");
      el.setAttribute("x", String(e.x));
      el.setAttribute("y", String(-e.z));
      el.setAttribute("text-anchor", e.anchor);
      el.setAttribute("dominant-baseline", "middle");
      el.setAttribute("fill", e.color);
      el.setAttribute("font-family", "Arial, system-ui, sans-serif");
      el.setAttribute("font-size", String(paperToWorld(e.sizePt, viewScale)));
      if (e.rotation) el.setAttribute("transform", `rotate(${e.rotation} ${e.x} ${-e.z})`);
      el.textContent = e.text;
      parent.appendChild(el);

      // Render leader line + arrowhead if the text note has a leader.
      if (e.leader && e.leaderTarget) {
        const [tx, tz] = e.leaderTarget;
        const lineEl = document.createElementNS(SVG_NS, "line");
        lineEl.setAttribute("x1", String(e.x));
        lineEl.setAttribute("y1", String(-e.z));
        lineEl.setAttribute("x2", String(tx));
        lineEl.setAttribute("y2", String(-tz));
        lineEl.setAttribute("stroke", e.color);
        lineEl.setAttribute("stroke-width", String(paperToWorld(0.18, viewScale)));
        parent.appendChild(lineEl);

        // Arrowhead at target.
        if (e.arrowhead) {
          const dx = tx - e.x;
          const dz = -tz - (-e.z);
          const len = Math.hypot(dx, dz) || 1;
          const ux = dx / len, uz = dz / len;
          const arrowSize = paperToWorld(1.5, viewScale);
          // Two arrowhead lines at ±30° from the leader direction.
          for (const sign of [-1, 1]) {
            const cos = Math.cos(sign * Math.PI / 6);
            const sin = Math.sin(sign * Math.PI / 6);
            const ax = tx - (ux * cos - uz * sin) * arrowSize;
            const ay = -tz - (uz * cos + ux * sin) * arrowSize;
            const arrow = document.createElementNS(SVG_NS, "line");
            arrow.setAttribute("x1", String(tx));
            arrow.setAttribute("y1", String(-tz));
            arrow.setAttribute("x2", String(ax));
            arrow.setAttribute("y2", String(ay));
            arrow.setAttribute("stroke", e.color);
            arrow.setAttribute("stroke-width", String(paperToWorld(0.18, viewScale)));
            parent.appendChild(arrow);
          }
        }
      }
      break;
    }
    case "hatch": {
      // Render a hatch polygon: draw the polygon outline, then fill it
      // with the previously-defined SVG <pattern> via fill="url(#patternKey)".
      // The pattern key matches what was registered in defineHatchPattern().
      const patternKey = `${e.pattern}-${e.color}-${e.scale}`;
      const d = e.polygon.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]} ${-p[1]}`).join(" ") + " Z";
      const el = document.createElementNS(SVG_NS, "path");
      el.setAttribute("d", d);
      // If the pattern is "poche" (solid fill), use the color directly.
      // Otherwise use the SVG pattern def.
      if (e.pattern === "poche") {
        el.setAttribute("fill", e.color);
        el.setAttribute("fill-opacity", "1");
      } else {
        el.setAttribute("fill", `url(#${patternKey})`);
      }
      el.setAttribute("stroke", e.color);
      el.setAttribute("stroke-width", "0");
      parent.appendChild(el);
      break;
    }
    default:
      break;
  }
}

function applyStroke(el: SVGElement, stroke: StrokeStyle, viewScale: number): void {
  el.setAttribute("stroke", stroke.color);
  el.setAttribute("stroke-width", String(paperToWorld(stroke.widthPt, viewScale)));
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  if (stroke.dash) {
    el.setAttribute("stroke-dasharray", stroke.dash.map((d) => paperToWorld(d, viewScale)).join(" "));
  }
}