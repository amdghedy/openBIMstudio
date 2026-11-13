/**
 * SVG -> CAD entities (SVGIMPORT). Pure, no DOM (works in Node tests).
 * Supports line, rect, circle, ellipse, polyline, polygon and path
 * (M L H V C S Q T A Z, absolute and relative), nested <g> and the
 * transform attribute (translate, scale, rotate, matrix, skewX/Y).
 * Curves are flattened to polylines. Text, images, gradients, clip paths,
 * <use> and CSS styling are not imported; they are counted in `skipped`.
 * SVG's y axis points down, so y is flipped (CAD y points up).
 */
import type { DxfEntity, DxfPoint } from "./dxf-types";

type Mat = [number, number, number, number, number, number]; // a b c d e f
const I: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const app = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const nums = (s: string): number[] => (s.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);

export function parseTransform(t: string | undefined): Mat {
  let m: Mat = I;
  if (!t) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(t))) {
    const a = nums(r[2]);
    let n: Mat = I;
    switch (r[1]) {
      case "matrix": if (a.length >= 6) n = [a[0], a[1], a[2], a[3], a[4], a[5]]; break;
      case "translate": n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]; break;
      case "scale": n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case "rotate": {
        const c = Math.cos(((a[0] ?? 0) * Math.PI) / 180), s = Math.sin(((a[0] ?? 0) * Math.PI) / 180);
        n = [c, s, -s, c, 0, 0];
        if (a.length >= 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case "skewX": n = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case "skewY": n = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, n);
  }
  return m;
}

type P = [number, number];

function arcPoints(p0: P, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p1: P, steps = 24): P[] {
  if (rx === 0 || ry === 0 || (p0[0] === p1[0] && p0[1] === p1[1])) return [p1];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx;
  const cx = cp * cxp - sp * cyp + (p0[0] + p1[0]) / 2, cy = sp * cxp + cp * cyp + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dth = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  if (sweep && dth < 0) dth += 2 * Math.PI;
  const out: P[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = th1 + (dth * i) / steps;
    out.push([cp * rx * Math.cos(t) - sp * ry * Math.sin(t) + cx, sp * rx * Math.cos(t) + cp * ry * Math.sin(t) + cy]);
  }
  out[out.length - 1] = p1;
  return out;
}

/** Path data -> subpaths (arrays of points) with a closed flag. */
export function flattenPath(d: string): Array<{ pts: P[]; closed: boolean }> {
  const toks = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const subs: Array<{ pts: P[]; closed: boolean }> = [];
  let cur: P[] = [];
  let pos: P = [0, 0], start: P = [0, 0], lastCtl: P | null = null, lastQ: P | null = null;
  let i = 0, cmd = "";
  const num = () => Number(toks[i++]);
  const hasNum = () => i < toks.length && !/^[a-zA-Z]$/.test(toks[i]);
  const flush = (closed: boolean) => { if (cur.length > 1 || (closed && cur.length)) subs.push({ pts: cur, closed }); cur = []; };
  while (i < toks.length) {
    if (/^[a-zA-Z]$/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === "Z") { if (cur.length) { flush(true); } pos = start; cur = []; lastCtl = lastQ = null; continue; }
    const ox = rel ? pos[0] : 0, oy = rel ? pos[1] : 0;
    do {
      if (!hasNum()) break;
      switch (C) {
        case "M": { const p: P = [num() + ox, num() + oy]; flush(false); pos = start = p; cur = [p]; cmd = rel ? "l" : "L"; break; }
        case "L": { pos = [num() + ox, num() + oy]; if (!cur.length) cur = [pos]; else cur.push(pos); lastCtl = lastQ = null; break; }
        case "H": { pos = [num() + ox, pos[1]]; cur.push(pos); lastCtl = lastQ = null; break; }
        case "V": { pos = [pos[0], num() + oy]; cur.push(pos); lastCtl = lastQ = null; break; }
        case "C": case "S": {
          let c1: P;
          if (C === "C") c1 = [num() + ox, num() + oy];
          else c1 = lastCtl ? [2 * pos[0] - lastCtl[0], 2 * pos[1] - lastCtl[1]] : pos;
          const c2: P = [num() + ox, num() + oy], p: P = [num() + ox, num() + oy];
          const p0 = pos;
          for (let s = 1; s <= 16; s++) {
            const t = s / 16, u = 1 - t;
            cur.push([u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p[0],
                      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p[1]]);
          }
          pos = p; lastCtl = c2; lastQ = null; break;
        }
        case "Q": case "T": {
          let c: P;
          if (C === "Q") c = [num() + ox, num() + oy];
          else c = lastQ ? [2 * pos[0] - lastQ[0], 2 * pos[1] - lastQ[1]] : pos;
          const p: P = [num() + ox, num() + oy], p0 = pos;
          for (let s = 1; s <= 12; s++) {
            const t = s / 12, u = 1 - t;
            cur.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p[1]]);
          }
          pos = p; lastQ = c; lastCtl = null; break;
        }
        case "A": {
          const rx = num(), ry = num(), rot = num(), la = num() !== 0, sw = num() !== 0;
          const p: P = [num() + ox, num() + oy];
          for (const q of arcPoints(pos, rx, ry, rot, la, sw, p)) cur.push(q);
          pos = p; lastCtl = lastQ = null; break;
        }
        default: i = toks.length; break;
      }
    } while (hasNum() && C !== "Z");
  }
  flush(false);
  return subs;
}

function attrs(tag: string): Record<string, string> {
  const o: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) o[m[1]] = m[3] ?? m[4] ?? "";
  return o;
}

export interface SvgImportResult { entities: DxfEntity[]; skipped: Record<string, number>; }
export interface SvgImportOptions { layer?: string; /** drawing units per SVG user unit (default 1) */ scale?: number; }

const SKIP = new Set(["text", "image", "use", "foreignObject", "clipPath", "mask", "pattern", "linearGradient", "radialGradient"]);

export function importSvg(svg: string, opts: SvgImportOptions = {}): SvgImportResult {
  const layer = opts.layer ?? "0";
  const k = opts.scale && opts.scale > 0 ? opts.scale : 1;
  const entities: DxfEntity[] = [];
  const skipped: Record<string, number> = {};
  // Flip y and scale once, at the end of the transform chain.
  const base: Mat = [k, 0, 0, -k, 0, 0];
  const pt = (m: Mat, x: number, y: number): DxfPoint => { const [a, b] = app(mul(base, m), x, y); return { x: a, y: b }; };
  const poly = (m: Mat, pts: P[], closed: boolean) => {
    if (pts.length < 2) return;
    entities.push({ type: "LWPOLYLINE", layer, points: pts.map(([x, y]) => pt(m, x, y)), ...(closed ? { closed: true } : {}) } as DxfEntity);
  };
  // Linear single-pass scanner: drop <!-- --> comments and <![CDATA[ ]]>
  // blocks completely, in document order. A regex pre-strip is incomplete
  // against adversarial nesting and can unhide markup between the two
  // replaces; the state machine cannot be fooled by tag-like text inside
  // either region and treats unterminated regions as dropped to EOF.
  let stripped = "";
  let scan = 0;
  const len = svg.length;
  while (scan < len) {
    if (svg.startsWith("<!--", scan)) {
      const end = svg.indexOf("-->", scan + 4);
      scan = end === -1 ? len : end + 3;
    } else if (svg.startsWith("<![CDATA[", scan)) {
      const end = svg.indexOf("]]>", scan + 9);
      scan = end === -1 ? len : end + 3;
    } else {
      stripped += svg[scan];
      scan++;
    }
  }
  const noComments = stripped;
  const stack: Mat[] = [I];
  const skipDepth: string[] = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g;
  let t: RegExpExecArray | null;
  while ((t = re.exec(noComments))) {
    const [, close, name, rest, self] = t;
    if (close) {
      if (skipDepth.length && skipDepth[skipDepth.length - 1] === name) skipDepth.pop();
      else if (name === "g" || name === "svg" || name === "a" || name === "switch") { if (stack.length > 1) stack.pop(); }
      continue;
    }
    if (skipDepth.length) { if (!self) skipDepth.push(name); continue; }
    if (SKIP.has(name)) { skipped[name] = (skipped[name] ?? 0) + 1; if (!self) skipDepth.push(name); continue; }
    const a = attrs(rest);
    const parent = stack[stack.length - 1];
    const m = mul(parent, parseTransform(a.transform));
    const f = (v: string | undefined, d = 0) => { const n = parseFloat(v ?? ""); return Number.isFinite(n) ? n : d; };
    switch (name) {
      case "svg": case "g": case "a": case "switch": if (!self) stack.push(m); break;
      case "line": poly(m, [[f(a.x1), f(a.y1)], [f(a.x2), f(a.y2)]], false); break;
      case "rect": {
        const x = f(a.x), y = f(a.y), w = f(a.width), h = f(a.height);
        if (w > 0 && h > 0) poly(m, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
        break;
      }
      case "circle": case "ellipse": {
        const cx = f(a.cx), cy = f(a.cy);
        const rx = name === "circle" ? f(a.r) : f(a.rx), ry = name === "circle" ? f(a.r) : f(a.ry);
        if (!(rx > 0 && ry > 0)) break;
        const full = mul(base, m);
        const sx = Math.hypot(full[0], full[1]), sy = Math.hypot(full[2], full[3]);
        const ortho = Math.abs(full[0] * full[2] + full[1] * full[3]) < 1e-9 * sx * sy;
        if (rx === ry && ortho && Math.abs(sx - sy) < 1e-9 * Math.max(sx, sy)) {
          entities.push({ type: "CIRCLE", layer, center: pt(m, cx, cy), radius: rx * sx } as DxfEntity);
        } else {
          const pts: P[] = [];
          for (let s = 0; s < 64; s++) { const th = (s / 64) * 2 * Math.PI; pts.push([cx + rx * Math.cos(th), cy + ry * Math.sin(th)]); }
          poly(m, pts, true);
        }
        break;
      }
      case "polyline": case "polygon": {
        const n = nums(a.points ?? "");
        const pts: P[] = [];
        for (let j = 0; j + 1 < n.length; j += 2) pts.push([n[j], n[j + 1]]);
        poly(m, pts, name === "polygon");
        break;
      }
      case "path": for (const s of flattenPath(a.d ?? "")) poly(m, s.pts, s.closed); break;
      default: break;
    }
  }
  return { entities, skipped };
}
