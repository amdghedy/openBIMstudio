/**
 * Prototype: a two-view elevation drawing (side + end) -> a list of parts with provenance.
 *
 * Nothing here is specific to one drawing. Every number is one of three kinds, and the output
 * says which:
 *  - "extracted": measured from the picture's line work (positions, sizes, part outlines),
 *  - "entered":   stated by the person (the one real dimension that sets the scale, a pipe
 *                 diameter),
 *  - "assumed":   not visible in either view (panel thickness, which end a grille faces, the
 *                 width position of a pipe, whether the far side matches the near side).
 * Dimension text in the picture is not read here; a stated dimension has to be entered.
 */
import { type RGBA } from "./outline";

export type Provenance = "extracted" | "entered" | "assumed";

export interface ViewBox { x0: number; x1: number; y0: number; y1: number }
export interface Region extends ViewBox { kind: "panel" | "grille"; areaPx: number; fill: number; /** Share of the outline's inside covered by line work (handles, locks, windows). */ inkFrac: number }
export type Block = ViewBox;

/** Work resolution: ink is OR-reduced so thin lines survive. */
export interface Ink { mask: Uint8Array; w: number; h: number; factor: number }

/** Dark line work only. Coloured ink (red dimension lines and text) is dropped. */
export function inkFromImage(img: RGBA, maxWidth = 1800): Ink {
  const { width: W, height: H, data } = img;
  const f = Math.max(1, Math.floor(W / maxWidth));
  const w = Math.ceil(W / f), h = Math.ceil(H / f);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, a = (data[i + 3] ?? 255) / 255;
    const r = data[i] * a + 255 * (1 - a), g = data[i + 1] * a + 255 * (1 - a), b = data[i + 2] * a + 255 * (1 - a);
    const dark = Math.max(r, g, b) < 190, coloured = r - Math.max(g, b) > 60;
    if (dark && !coloured) mask[Math.floor(y / f) * w + Math.floor(x / f)] = 1;
  }
  return { mask, w, h, factor: f };
}

/** Views are the groups of ink columns separated by blank space. */
export function splitViews(ink: Ink, minGapFrac = 0.012, minWidthFrac = 0.03): ViewBox[] {
  const { mask, w, h } = ink;
  const col = new Uint8Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) col[x] = 1;
  const gap = Math.max(3, Math.round(w * minGapFrac)), out: ViewBox[] = [];
  let start = -1, blank = 0;
  const close = (end: number) => {
    if (start < 0 || end - start < w * minWidthFrac) return;
    let y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = start; x <= end; x++) if (mask[y * w + x]) { if (y < y0) y0 = y; if (y > y1) y1 = y; break; }
    out.push({ x0: start, x1: end, y0, y1 });
  };
  for (let x = 0; x < w; x++) {
    if (col[x]) { if (start < 0) start = x; blank = 0; } else if (start >= 0 && ++blank >= gap) { close(x - blank); start = -1; }
  }
  if (start >= 0) close(w - 1 - blank);
  return out;
}

function runMax(src: Uint8Array, w: number, h: number, r: number, wantMax: boolean): Uint8Array {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const edge = wantMax ? 0 : 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = wantMax ? 0 : 1;
    for (let k = -r; k <= r; k++) { const xx = x + k; const s = xx < 0 || xx >= w ? edge : src[y * w + xx]; if (wantMax ? s : !s) { v = wantMax ? 1 : 0; break; } }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = wantMax ? 0 : 1;
    for (let k = -r; k <= r; k++) { const yy = y + k; const s = yy < 0 || yy >= h ? edge : tmp[yy * w + x]; if (wantMax ? s : !s) { v = wantMax ? 1 : 0; break; } }
    out[y * w + x] = v;
  }
  return out;
}

function floodBackground(solid: Uint8Array, w: number, h: number): Uint8Array {
  const seen = new Uint8Array(w * h), stack: number[] = [];
  const push = (x: number, y: number) => { const i = y * w + x; if (!solid[i] && !seen[i]) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const i = stack.pop()!, x = i % w, y = (i - x) / w;
    if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
  }
  return seen;
}

export interface View { box: ViewBox; w: number; h: number; ink: Uint8Array; sil: Uint8Array }

/** Crop a view and compute its filled silhouette (outline closed over small gaps, holes filled). */
export function makeView(ink: Ink, box: ViewBox, close = 2): View {
  const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1, pad = close + 2;
  const W = w + 2 * pad, H = h + 2 * pad, m = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[(y + pad) * W + x + pad] = ink.mask[(y + box.y0) * ink.w + x + box.x0];
  const closed = runMax(m, W, H, close, true);
  const bg = floodBackground(closed, W, H);
  const filled = new Uint8Array(W * H);
  for (let i = 0; i < filled.length; i++) filled[i] = bg[i] ? 0 : 1;
  // Opening removes slivers thinner than the radius: dimension lines, leaders and arrows glued to the outline.
  const open = Math.max(close, Math.round(Math.max(w, h) * 0.004));
  const eroded = runMax(runMax(filled, W, H, open, false), W, H, open, true);
  const sil = new Uint8Array(w * h), ink2 = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { sil[y * w + x] = eroded[(y + pad) * W + x + pad]; ink2[y * w + x] = m[(y + pad) * W + x + pad]; }
  return { box, w, h, ink: ink2, sil };
}

/** Rows of the silhouette grouped into rectangular blocks (same column runs over consecutive rows). */
export function blocksFromSilhouette(v: View, tolFrac = 0.012, minRowsFrac = 0.012): Block[] {
  const { w, h, sil } = v, tol = Math.max(2, Math.round(w * tolFrac)), minRows = Math.max(2, Math.round(h * minRowsFrac));
  type Run = [number, number];
  const runsAt = (y: number) => {
    const r: Run[] = []; let s = -1;
    for (let x = 0; x <= w; x++) { const on = x < w && sil[y * w + x]; if (on && s < 0) s = x; else if (!on && s >= 0) { if (x - s >= 2) r.push([s, x - 1]); s = -1; } }
    return r;
  };
  const same = (a: Run[], b: Run[]) => a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i][0]) <= tol && Math.abs(p[1] - b[i][1]) <= tol);
  const bands: Array<{ y0: number; y1: number; runs: Run[] }> = [];
  for (let y = 0; y < h; y++) {
    const r = runsAt(y); if (!r.length) continue;
    const last = bands[bands.length - 1];
    if (last && y - last.y1 <= 1 && same(last.runs, r)) { last.y1 = y; last.runs = last.runs.map((p, i) => [Math.min(p[0], r[i][0]), Math.max(p[1], r[i][1])] as Run); }
    else bands.push({ y0: y, y1: y, runs: r });
  }
  const out: Block[] = [];
  for (const b of bands) if (b.y1 - b.y0 + 1 >= minRows) for (const r of b.runs) out.push({ x0: r[0], x1: r[1], y0: b.y0, y1: b.y1 });
  return out;
}

function components(flag: Uint8Array, w: number, h: number): Array<{ box: ViewBox; area: number }> {
  const seen = new Uint8Array(w * h), res: Array<{ box: ViewBox; area: number }> = [];
  for (let s = 0; s < w * h; s++) {
    if (!flag[s] || seen[s]) continue;
    const st = [s]; seen[s] = 1; let x0 = w, x1 = 0, y0 = h, y1 = 0, area = 0;
    while (st.length) {
      const i = st.pop()!, x = i % w, y = (i - x) / w; area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && flag[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; st.push(i - 1); }
      if (x < w - 1 && flag[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; st.push(i + 1); }
      if (y > 0 && flag[i - w] && !seen[i - w]) { seen[i - w] = 1; st.push(i - w); }
      if (y < h - 1 && flag[i + w] && !seen[i + w]) { seen[i + w] = 1; st.push(i + w); }
    }
    res.push({ box: { x0, x1, y0, y1 }, area });
  }
  return res;
}

export interface RegionOptions { minFrac?: number; minFill?: number; cell?: number; density?: number }

/**
 * Rectangular regions inside a view: panels (areas bounded by line work whose outline is a
 * rectangle: doors, access covers) and grilles (rectangular areas that are mostly ink: louvres).
 */
export function findRegions(v: View, o: RegionOptions = {}): Region[] {
  const { w, h, ink, sil } = v;
  const minW = Math.max(6, Math.round(w * (o.minFrac ?? 0.03))), minH = Math.max(6, Math.round(h * (o.minFrac ?? 0.03)));
  const minFill = o.minFill ?? 0.8, out: Region[] = [];
  const cell = o.cell ?? Math.max(4, Math.round(Math.min(w, h) / 90)), cw = Math.ceil(w / cell), ch = Math.ceil(h / cell);
  const dense = new Uint8Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    let n = 0, t = 0;
    for (let y = cy * cell; y < Math.min(h, (cy + 1) * cell); y++) for (let x = cx * cell; x < Math.min(w, (cx + 1) * cell); x++) { t++; n += ink[y * w + x]; }
    dense[cy * cw + cx] = n / t > (o.density ?? 0.3) ? 1 : 0;
  }
  const gr: Region[] = [];
  for (const c of components(dense, cw, ch)) {
    const b = { x0: c.box.x0 * cell, x1: Math.min(w - 1, (c.box.x1 + 1) * cell - 1), y0: c.box.y0 * cell, y1: Math.min(h - 1, (c.box.y1 + 1) * cell - 1) };
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1, fill = c.area / ((c.box.x1 - c.box.x0 + 1) * (c.box.y1 - c.box.y0 + 1));
    if (bw >= minW && bh >= Math.max(4, minH * 0.5) && fill >= minFill && bw * bh >= 0.004 * w * h) gr.push({ ...b, kind: "grille", areaPx: c.area * cell * cell, fill, inkFrac: 1 });
  }
  const thick = runMax(ink, w, h, 1, true), cells = new Uint8Array(w * h);
  for (let i = 0; i < cells.length; i++) cells[i] = sil[i] && !thick[i] ? 1 : 0;
  const comps = components(cells, w, h);
  const inGrille = (b: ViewBox) => gr.some((g) => b.x0 >= g.x0 - cell && b.x1 <= g.x1 + cell && b.y0 >= g.y0 - cell && b.y1 <= g.y1 + cell);
  for (const c of comps) {
    const b = c.box, bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    if (bw < minW || bh < minH || bw * bh > 0.6 * w * h || inGrille(b)) continue;
    let inner = 0; // holes (window, handle) count as part of the panel
    for (const d of comps) if (d !== c && d.box.x0 >= b.x0 && d.box.x1 <= b.x1 && d.box.y0 >= b.y0 && d.box.y1 <= b.y1) inner += d.area;
    const fill = (c.area + inner) / (bw * bh);
    if (fill >= minFill) {
      let n = 0, tot = 0;
      for (let y = b.y0 + 2; y <= b.y1 - 2; y++) for (let x = b.x0 + 2; x <= b.x1 - 2; x++) { tot++; n += ink[y * w + x]; }
      out.push({ ...b, kind: "panel", areaPx: c.area + inner, fill, inkFrac: tot ? n / tot : 0 });
    }
  }
  return [...out, ...gr];
}

/** Door-like: hardware drawn inside (>= 0.4% of the area) and big enough to be a door (>= 45% of the body height, >= 10% of its length). */
const DOOR_INK = 0.004;

export interface PartOut {
  name: string;
  /** For panels: a guess from hardware drawn inside the outline (handle, lock, window). Not read from any label. */
  role?: "door-like" | "fixed";
  inkFrac?: number;
  kind: "body" | "panel" | "grille" | "pipe" | "detail";
  /** Detail parts only: what the shape looks like. A guess from outline shape alone; nothing in the drawing names it. */
  detailClass?: "handle" | "hinge" | "lifting-eye" | "fitting";
  /** True for parts guessed from shape, never confirmed by the drawing. */
  candidate?: boolean;
  /** mm. x along the side view's length, z up from the ground, y across the width (centred). */
  x0: number; x1: number; z0: number; z1: number; y0: number; y1: number;
  size: Provenance; depth: Provenance; thickness?: Provenance;
  note?: string;
  /** The outline in the picture, in reduced-sheet pixels (see Reconstruction.sheet), for drawing the overlay. */
  sheetPx?: ViewBox;
  /** Where on the model it sits, so the person can confirm the placement. */
  placement?: { face: "+width" | "-width" | "start end" | "far end"; provenance: Provenance };
}

export interface ReconstructOptions {
  /** The one stated dimension that sets the scale: overall length of the side view, mm. */
  lengthMm: number;
  /** Stated overall width, mm. Only a check against the end view. */
  widthMm?: number;
  /** Stated height of the end view, mm. Only a check. */
  heightMm?: number;
  /** Stated pipe diameter, mm. If absent the measured width is used. */
  pipeDiameterMm?: number;
  /** 0-based view indexes, left to right. Default: widest view is the side view, next widest the end view. */
  sideView?: number; endView?: number;
  /** Assumed thickness of panels and grilles, mm. They sit flush inside the overall size, never outside it. */
  skinMm?: number;
  /** Which long face the side-view panels are placed on. The far face is not shown in the drawing; "both" mirrors them and says so. */
  sideFace?: "+" | "-" | "both";
  /** Which end of the side view the end-view grilles are placed on. The drawing does not say. */
  endFace?: "start" | "end";
  /** Scale the end view by its own stated height instead of the side view's scale. Off by default; needs heightMm. */
  calibrateEnd?: boolean;
}

export interface DimensionLine { name: string; state: "entered" | "checked"; mm: number; measuredMm?: number; /** Size of the same thing in the built parts. */ modelMm?: number; note?: string }

export interface Reconstruction {
  parts: PartOut[];
  scaleMmPerPx: number;
  warnings: string[];
  /** Plain-language reasons the built parts do not match what the person entered. Empty means no mismatch was found, not that the result is right. */
  quality: { level: "no-mismatch-found" | "mismatch"; notes: string[] };
  views: ViewBox[];
  /** Size of the reduced picture the pixel boxes refer to. */
  sheet: { w: number; h: number; factor: number };
  checks: { widthMm: number; heightEndMm: number; heightSideMm: number };
  /** Each dimension as entered or as only checked against the picture; none is read from the picture's text. */
  dimensions: DimensionLine[];
  /** What the drawing does not show and the parts do not claim. */
  unknowns: string[];
  /** Scale of each view. The end-view figure is implied by the entered height; it is only used for the end view when calibrateEnd is set. */
  calibration: { sideMmPerPx: number; endMmPerPx: number; endImpliedMmPerPx?: number; endVsSidePct?: number; endScaledByHeight: boolean };
}

/** Views found in a picture, left to right, with the default side and end choice. */
export function detectViews(img: RGBA): { views: ViewBox[]; widthsPx: number[]; side: number; end: number } {
  const views = splitViews(inkFromImage(img));
  const order = views.map((b, i) => ({ i, w: b.x1 - b.x0 })).sort((a, b) => b.w - a.w);
  return { views, widthsPx: views.map((b) => b.x1 - b.x0 + 1), side: order[0]?.i ?? 0, end: order[1]?.i ?? 0 };
}

export function reconstructElevations(img: RGBA, o: ReconstructOptions): Reconstruction {
  const ink = inkFromImage(img), views = splitViews(ink), warnings: string[] = [];
  if (views.length < 2) throw new Error("Need a side view and an end view in the picture.");
  const order = views.map((b, i) => ({ i, w: b.x1 - b.x0 })).sort((a, b) => b.w - a.w);
  const si = o.sideView ?? order[0].i, ei = o.endView ?? order.find((v) => v.i !== si)!.i;
  if (o.sideView === undefined) warnings.push("Side view assumed to be the widest view in the picture.");
  const side = makeView(ink, views[si]), end = makeView(ink, views[ei]);
  const sp = (v: ViewBox, b: ViewBox): ViewBox => ({ x0: v.x0 + b.x0, x1: v.x0 + b.x1, y0: v.y0 + b.y0, y1: v.y0 + b.y1 });
  const extent = (v: View) => { let x0 = v.w, x1 = 0, y0 = v.h, y1 = 0; for (let y = 0; y < v.h; y++) for (let x = 0; x < v.w; x++) if (v.sil[y * v.w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, x1, y0, y1 }; };
  const se = extent(side), ee = extent(end);
  const s = o.lengthMm / (se.x1 - se.x0 + 1);
  const impliedEnd = o.heightMm ? o.heightMm / (ee.y1 - ee.y0 + 1) : undefined;
  const sE = o.calibrateEnd && impliedEnd ? impliedEnd : s;
  const widthMm = (ee.x1 - ee.x0 + 1) * sE, heightEndMm = (ee.y1 - ee.y0 + 1) * sE, heightSideMm = (se.y1 - se.y0 + 1) * s;
  if (o.widthMm && Math.abs(widthMm / o.widthMm - 1) > 0.03) warnings.push(`End view width ${Math.round(widthMm)} mm differs from the stated ${o.widthMm} mm by more than 3%.`);
  if (o.heightMm && Math.abs(heightEndMm / o.heightMm - 1) > 0.03) warnings.push(`End view height ${Math.round(heightEndMm)} mm differs from the stated ${o.heightMm} mm by more than 3%.`);
  const skin = o.skinMm ?? 15, parts: PartOut[] = [];
  const bottomSide = se.y1, bottomEnd = ee.y1, midEnd = (ee.x0 + ee.x1 + 1) / 2;
  const zS = (y: number) => (bottomSide - y) * s, zE = (y: number) => (bottomEnd - y) * s;
  const endExtentAt = (zMid: number): [number, number] | null => {
    const y0 = Math.round(bottomEnd - zMid / sE);
    for (let k = 0; k < 10; k++) for (const y of [y0 - k, y0 + k]) {
      if (y < 0 || y >= end.h) continue;
      let a = -1, b = -1;
      for (let x = 0; x < end.w; x++) if (end.sil[y * end.w + x]) { if (a < 0) a = x; b = x; }
      if (a >= 0) return [(a - midEnd) * sE, (b + 1 - midEnd) * sE];
    }
    return null;
  };
  const blocks = blocksFromSilhouette(side).sort((a, b) => b.y1 - a.y1 || a.x0 - b.x0);
  const sideLen = se.x1 - se.x0 + 1;
  const wide = blocks.filter((b) => b.x1 - b.x0 + 1 > 0.3 * sideLen);
  const bodyTopY = wide.length ? Math.min(...wide.map((b) => b.y0)) : se.y0;
  let n = 0;
  const narrow: Block[] = [];
  for (const b of blocks) {
    const wPx = b.x1 - b.x0 + 1, x0 = (b.x0 - se.x0) * s, x1 = (b.x1 + 1 - se.x0) * s;
    if (wPx < 0.08 * sideLen && b.y1 < bodyTopY + 2) { narrow.push(b); continue; }
    const z0 = zS(b.y1 + 1), z1 = zS(b.y0), e = endExtentAt((z0 + z1) / 2);
    if (!e) { warnings.push(`No end-view extent at height ${Math.round((z0 + z1) / 2)} mm; block skipped.`); continue; }
    parts.push({ name: `Block ${++n}`, kind: "body", x0, x1, z0, z1, y0: e[0], y1: e[1], size: "extracted", depth: "extracted", sheetPx: sp(views[si], b), note: "length from the side view, width from the end view at the same height; assumes both views share the ground line" });
  }
  if (narrow.length) {
    // Stacked narrow blocks above the body (pipe neck, cap) are one pipe; its top is the top of the silhouette.
    const base = narrow.reduce((a, b) => (b.x1 - b.x0 > a.x1 - a.x0 ? b : a));
    const cx = (((base.x0 + base.x1 + 1) / 2) - se.x0) * s, d = o.pipeDiameterMm ?? (base.x1 - base.x0 + 1) * s;
    parts.push({ name: "Pipe above the body", kind: "pipe", x0: cx - d / 2, x1: cx + d / 2, z0: zS(bodyTopY), z1: zS(base.y0), y0: -d / 2, y1: d / 2, sheetPx: sp(views[si], base), size: "extracted", depth: "assumed", note: o.pipeDiameterMm ? "diameter entered; position across the width assumed centred" : "diameter measured from the drawing (may include a cap); position across the width assumed centred" });
    let le = 0;
    for (const b of narrow) if (b !== base) {
      const e = endExtentAt((zS(b.y1 + 1) + zS(b.y0)) / 2);
      parts.push({ name: `Possible lifting eye ${++le}`, kind: "detail", detailClass: "lifting-eye", candidate: true, x0: (b.x0 - se.x0) * s, x1: (b.x1 + 1 - se.x0) * s, z0: zS(b.y1 + 1), z1: zS(b.y0), y0: e ? e[0] / 2 : -50, y1: e ? e[1] / 2 : 50, size: "extracted", depth: "assumed", sheetPx: sp(views[si], b), note: "a narrow shape above the body that is not the pipe, guessed from shape only; nothing in the drawing names it; depth assumed" });
    }
    if (le) warnings.push(`${le} other narrow shape(s) above the body are listed as possible lifting eyes (guess from shape) and stay off until you tick them.`);
  }
  const bodyB = partsBounds(parts.filter((q) => q.kind === "body"));
  const face = o.sideFace ?? "+", endFace = o.endFace ?? "start", faces: Array<"+" | "-"> = face === "both" ? ["+", "-"] : [face];
  const lengthMm = sideLen * s;
  let p = 0, g = 0;
  for (const r of findRegions(side)) {
    const z0 = zS(r.y1 + 1), z1 = zS(r.y0), e = endExtentAt((z0 + z1) / 2);
    if (!e) continue;
    const nm = r.kind === "panel" ? `Side panel ${++p}` : `Side grille ${++g}`;
    for (const f of faces) {
      parts.push({ name: faces.length > 1 ? `${nm} (${f === "+" ? "+" : "-"} width)` : nm, kind: r.kind, inkFrac: r.inkFrac, ...(r.kind === "panel" ? { role: r.inkFrac >= DOOR_INK && (z1 - z0) >= 0.45 * (bodyB.z1 - bodyB.z0) && (r.x1 - r.x0 + 1) * s >= 0.1 * (bodyB.x1 - bodyB.x0) ? "door-like" as const : "fixed" as const } : {}), x0: (r.x0 - se.x0) * s, x1: (r.x1 + 1 - se.x0) * s, z0, z1, y0: f === "+" ? Math.min(e[1], bodyB.y1) - skin : Math.max(e[0], bodyB.y0), y1: f === "+" ? Math.min(e[1], bodyB.y1) : Math.max(e[0], bodyB.y0) + skin, sheetPx: sp(views[si], r), size: "extracted", depth: "assumed", thickness: "assumed",
        placement: { face: f === "+" ? "+width" : "-width", provenance: "assumed" }, note: "outline from the drawing; sits flush inside the overall size; thickness assumed" + (face === "both" ? "; the other face is a mirrored assumption" : "; the other face is unknown") });
    }
  }
  // Small shapes inside door-like panels: possible handles, hinges and fittings. Guessed from outline shape only, never confirmed.
  {
    const f0 = faces[0], doors = parts.filter((q) => q.kind === "panel" && q.role === "door-like" && q.sheetPx && q.placement?.face === (f0 === "+" ? "+width" : "-width"));
    let hn = 0, hg = 0, fn = 0;
    for (const dp of doors) {
      const bx = dp.sheetPx!, ox0 = bx.x0 - views[si].x0, oy0 = bx.y0 - views[si].y0, pw = bx.x1 - bx.x0 + 1, ph = bx.y1 - bx.y0 + 1, inset = 3;
      const cw = pw - 2 * inset, ch = ph - 2 * inset; if (cw < 8 || ch < 8) continue;
      const flag = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) flag[y * cw + x] = side.ink[(oy0 + inset + y) * side.w + ox0 + inset + x];
      for (const c of components(flag, cw, ch)) {
        const w1 = c.box.x1 - c.box.x0 + 1, h1 = c.box.y1 - c.box.y0 + 1;
        if (w1 * h1 < 12 || w1 * h1 > 0.12 * cw * ch || w1 > 0.4 * cw || h1 > 0.4 * ch) continue;
        const nearEdge = c.box.x0 < 0.1 * cw || c.box.x1 > 0.9 * cw, asp = Math.max(w1, h1) / Math.max(1, Math.min(w1, h1));
        const cls: "handle" | "hinge" | "fitting" = nearEdge && h1 >= 1.5 * w1 && asp >= 1.5 ? "hinge" : asp >= 2.5 ? "handle" : "fitting";
        const gx0 = ox0 + inset + c.box.x0, gx1 = ox0 + inset + c.box.x1, gy0 = oy0 + inset + c.box.y0, gy1 = oy0 + inset + c.box.y1;
        parts.push({ name: `Possible ${cls} ${cls === "handle" ? ++hn : cls === "hinge" ? ++hg : ++fn}`, kind: "detail", detailClass: cls, candidate: true,
          x0: (gx0 - se.x0) * s, x1: (gx1 + 1 - se.x0) * s, z0: zS(gy1 + 1), z1: zS(gy0), y0: dp.y0, y1: dp.y1, size: "extracted", depth: "assumed", thickness: "assumed",
          sheetPx: { x0: views[si].x0 + gx0, x1: views[si].x0 + gx1, y0: views[si].y0 + gy0, y1: views[si].y0 + gy1 },
          placement: dp.placement, note: `guessed from the outline shape only (${cls}); nothing in the drawing names it; sits flush in the panel, depth assumed` });
      }
    }
    if (hn + hg + fn) warnings.push(`${hn + hg + fn} small shape(s) inside door-like panels are listed as possible handles, hinges or fittings. They are guesses from shape, not read from labels, and stay off until you tick them.`);
  }
  g = 0; p = 0;
  for (const r of findRegions(end)) {
    const x0 = endFace === "start" ? 0 : lengthMm - skin, x1 = endFace === "start" ? skin : lengthMm;
    parts.push({ name: r.kind === "grille" ? `End grille ${++g}` : `End panel ${++p}`, kind: r.kind, x0, x1, z0: zE(r.y1 + 1), z1: zE(r.y0), y0: (r.x0 - midEnd) * sE, y1: (r.x1 + 1 - midEnd) * sE, sheetPx: sp(views[ei], r), size: "extracted", depth: "assumed", thickness: "assumed",
      placement: { face: endFace === "start" ? "start end" : "far end", provenance: "assumed" }, note: "outline from the drawing; sits flush inside the overall size; which end of the side view it faces is not shown in the drawing; thickness assumed" });
  }
  const dimensions: DimensionLine[] = [
    { name: "length", state: "entered", mm: o.lengthMm, modelMm: bodyB.x1 - bodyB.x0, note: "sets the scale" },
    { name: "width", state: "checked", mm: o.widthMm ?? NaN, measuredMm: widthMm, modelMm: bodyB.y1 - bodyB.y0 },
    { name: "height", state: "checked", mm: o.heightMm ?? NaN, measuredMm: heightEndMm, modelMm: bodyB.z1 - bodyB.z0 },
  ];
  if (o.pipeDiameterMm) dimensions.push({ name: "pipe diameter", state: "entered", mm: o.pipeDiameterMm });
  const unknowns = [
    "The face opposite the one the panels are on is not shown in the drawing.",
    "Which end of the side view the end-view grilles belong to is not shown in the drawing.",
    "Anything inside the body, and any depth not visible in either view, is not shown.",
  ];
  const notes: string[] = [];
  const cmp = (label: string, entered: number | undefined, built: number, tol: number) => {
    if (entered && Number.isFinite(entered) && Math.abs(built - entered) / entered > tol) notes.push(`${label}: the built parts measure ${Math.round(built)} mm but ${Math.round(entered)} mm was entered (${Math.round((Math.abs(built - entered) / entered) * 100)}% apart, more than ${Math.round(tol * 100)}%).`);
  };
  cmp("Length", o.lengthMm, bodyB.x1 - bodyB.x0, 0.02);
  cmp("Width", o.widthMm, bodyB.y1 - bodyB.y0, 0.03);
  cmp("Height", o.heightMm, bodyB.z1 - bodyB.z0, 0.03);
  if (warnings.some((w) => w.includes("block skipped"))) notes.push("Some parts of the side view could not be matched to the end view and were skipped, so the body is incomplete.");
  if (impliedEnd && !o.calibrateEnd && Math.abs(impliedEnd / s - 1) > 0.03) notes.push(`The entered height implies the end view is drawn ${Math.abs(Math.round((impliedEnd / s - 1) * 100))}% ${impliedEnd > s ? "larger" : "smaller"} than the side view's scale. It may be at a different scale; the choice to scale the end view by its own height is yours.`);
  const quality = { level: notes.length ? "mismatch" as const : "no-mismatch-found" as const, notes };
  return { parts, scaleMmPerPx: s, warnings, quality, views, sheet: { w: ink.w, h: ink.h, factor: ink.factor }, checks: { widthMm, heightEndMm, heightSideMm }, dimensions, unknowns,
    calibration: { sideMmPerPx: s, endMmPerPx: sE, endImpliedMmPerPx: impliedEnd, endVsSidePct: impliedEnd ? (impliedEnd / s - 1) * 100 : undefined, endScaledByHeight: sE !== s } };
}

/** Axis-aligned bounds of a list of parts, mm. */
export function partsBounds(parts: PartOut[]) {
  const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const p of parts) { b.x0 = Math.min(b.x0, p.x0); b.x1 = Math.max(b.x1, p.x1); b.y0 = Math.min(b.y0, p.y0); b.y1 = Math.max(b.y1, p.y1); b.z0 = Math.min(b.z0, p.z0); b.z1 = Math.max(b.z1, p.z1); }
  return b;
}

/** Parts in the creator's metre units and engine axes (X length, Y up, Z across), for the IFC writer. */
export function toResolvedParts(parts: PartOut[]): Array<{ id: string; name: string; shape: "box" | "cylinder"; cx: number; cy: number; cz: number; w: number; d: number; h: number; r: number }> {
  const b = partsBounds(parts), xm = (b.x0 + b.x1) / 2, m = (v: number) => v / 1000;
  return parts.map((p, i) => p.kind === "pipe"
    ? { id: `p${i}`, name: p.name, shape: "cylinder" as const, cx: m((p.x0 + p.x1) / 2 - xm), cy: m((p.z0 + p.z1) / 2), cz: m((p.y0 + p.y1) / 2), w: 0, d: 0, h: m(p.z1 - p.z0), r: m((p.x1 - p.x0) / 2) }
    : { id: `p${i}`, name: p.name, shape: "box" as const, cx: m((p.x0 + p.x1) / 2 - xm), cy: m((p.z0 + p.z1) / 2), cz: m((p.y0 + p.y1) / 2), w: m(p.x1 - p.x0), d: m(p.y1 - p.y0), h: m(p.z1 - p.z0), r: 0 });
}
