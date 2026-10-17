/**
 * SVG renderer for Scene2D.
 */

import type { Scene2D, SceneEntity, StrokeStyle } from "../scene";
import { paperToWorld } from "../scene";

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