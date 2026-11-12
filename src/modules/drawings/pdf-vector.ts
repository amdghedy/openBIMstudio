/**
 * PDF Vector Import — convert a vector PDF page into editable drawing
 * entities, entirely on the local device.
 *
 * "Convert PDF to DWG" in the Drawing Editor works like this:
 *
 *   1. PDFIN / ribbon "PDF to Drawing…" / drop a .pdf file
 *   2. This module parses the PDF with the bundled PDF.js — in the browser,
 *      on the user's machine. The PDF is NOT uploaded to the cloud.
 *   3. Vector content (stroked paths, filled boundaries, text) becomes real
 *      LINE / LWPOLYLINE / TEXT entities in a DxfDocument.
 *   4. The shell writes that document through the standard DXF writer and
 *      opens it as a normal drawing tab — from there QSAVE gives a DXF and
 *      DWGSAVE gives a DWG, completing the PDF → DWG conversion.
 *
 * PDF.js operator-list packing handled here (verified against the installed
 * pdfjs-dist):
 *   - pdf.js ≥ 6.5: constructPath args = [paintOp, interleaved, minMax] where
 *     `interleaved` holds DrawOPS codes (0 moveTo · 1 lineTo · 2 curveTo ·
 *     3 quadraticCurveTo · 4 closePath) with their coordinates inline, and the
 *     paint operator (stroke 20, closeStroke 21, fill 22, eoFill 23,
 *     fillStroke 24, eoFillStroke 25, closeFillStroke 26, closeEOFillStroke
 *     27, clip 29, eoClip 30) rides along as args[0].
 *   - pdf.js 4–5: constructPath args = [ops, coords, minMax] with classic OPS
 *     codes (moveTo 13, lineTo 14, curveTo 15, curveTo2 16, curveTo3 17,
 *     closePath 18, rectangle 19) and separate paint operators afterwards.
 *   - Colour operators carry CSS strings ("#0000ff") on new builds and
 *     r/g/b floats on older ones — both are accepted.
 *
 * Scope and honest limits (v1):
 *   - Vector PDFs only. Scanned / raster PDFs have no vector content and are
 *     refused with an explicit message.
 *   - Embedded raster images are counted and skipped (they stay in the PDF;
 *     use PDF underlay in the BIM workspace for those).
 *   - Cubic/quadratic Béziers are flattened to short line segments.
 *   - Clipping paths are discarded (geometry is emitted unclipped).
 *   - Filled areas import as closed boundaries on the "PDF Fill" layer (use
 *     HATCH to refill them); solid fills are not auto-generated.
 *   - Text keeps position, size and rotation; font family is not matched.
 *   - Pattern/CMYK-separation colours fall back to the last plain colour.
 */

import type { DxfDocument, DxfEntity, DxfLayer, DxfPoint } from "./dxf-types";

export interface PdfVectorOptions {
  /** 1-indexed page to convert. Default 1. */
  page?: number;
  /**
   * Drawing units per PDF inch (the page's 72 user-space units = 1 inch).
   * Default 25.4 → true-size millimetres (1 pt = 0.3528 mm), matching the
   * PDF underlay's scale. Pass 1 to keep raw PDF points as units.
   */
  unitsPerInch?: number;
  /** Line segments used to flatten each Bézier. Default 16. */
  curveSegments?: number;
}

export interface PdfVectorResult {
  doc: DxfDocument;
  /** Pages in the PDF. */
  pageCount: number;
  /** Converted page size in PDF points (1/72 inch). */
  pageSize: { width: number; height: number };
  /** 1-indexed page that was converted. */
  page: number;
  unitsPerInch: number;
  counts: { lines: number; polylines: number; fills: number; texts: number; imagesSkipped: number };
}

/** 2D affine matrix, PDF.js order [a, b, c, d, e, f]. */
type Mat = [number, number, number, number, number, number];

const ID: Mat = [1, 0, 0, 1, 0, 0];

function mul(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function apply(m: Mat, x: number, y: number): DxfPoint {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Perceived-luminance ceiling: the strongest channel of an 0xRRGGBB colour. */
function channelMax(rgb: number): number {
  return Math.max((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255) / 255;
}

function rgbToInt(r: number, g: number, b: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

/** Colour operator payload → 0xRRGGBB (CSS string on new pdf.js, floats on old). */
function parseColorArg(args: any[]): number | null {
  const v = args?.[0];
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("#")) {
      const hex = s.slice(1);
      if (hex.length === 3) return parseInt(hex.split("").map((ch) => ch + ch).join(""), 16);
      if (hex.length >= 6) return parseInt(hex.slice(0, 6), 16);
      return null;
    }
    const m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      const parts = m[1].split(",").map((x) => parseFloat(x));
      if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) return rgbToInt(parts[0], parts[1], parts[2]);
    }
    return null;
  }
  if (typeof v === "number" && args.length >= 3 && args.slice(0, 3).every((n: any) => typeof n === "number")) {
    return rgbToInt(args[0], args[1], args[2]);
  }
  return null;
}

function cmykToInt(c: number, m: number, y: number, k: number): number {
  const r = 1 - Math.min(1, c + k);
  const g = 1 - Math.min(1, m + k);
  const b = 1 - Math.min(1, y + k);
  return rgbToInt(r, g, b);
}

/**
 * Load PDF.js: the bundled dependency in the browser (worker resolved from the
 * exact installed version as a same-origin Vite asset — never a CDN), the
 * legacy build under Node (tests).
 */
async function loadPdfjs(): Promise<any> {
  if (typeof document !== "undefined") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    return pdfjs;
  }
  return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;
}

/**
 * Extract the vector content of one PDF page into a DxfDocument.
 * Pure and DOM-free — runs in the browser and under Node (tests).
 */
export async function pdfToDxfDocument(bytes: Uint8Array, opts: PdfVectorOptions = {}): Promise<PdfVectorResult> {
  const pageNo = Math.max(1, Math.floor(opts.page ?? 1));
  const unitsPerInch = opts.unitsPerInch && opts.unitsPerInch > 0 ? opts.unitsPerInch : 25.4;
  const segs = Math.max(4, Math.min(64, Math.floor(opts.curveSegments ?? 16)));
  // PDF.js may transfer the buffer to its worker — hand it a private copy.
  const data = new Uint8Array(bytes);

  const pdfjs = await loadPdfjs();
  const OPS = pdfjs.OPS as Record<string, number>;
  const IGNORE = OPS.ignore ?? -1;
  const task = pdfjs.getDocument({ data, isEvalSupported: false });
  const pdf = await task.promise;
  if (pageNo > pdf.numPages) {
    throw new Error(`page ${pageNo} out of range (PDF has ${pdf.numPages} page(s))`);
  }
  const page = await pdf.getPage(pageNo);
  const viewport = page.getViewport({ scale: 1 });
  const k = unitsPerInch / 72; // PDF points → drawing units

  const entities: DxfEntity[] = [];
  const counts = { lines: 0, polylines: 0, fills: 0, texts: 0, imagesSkipped: 0 };
  let clipCount = 0;

  const push = (e: DxfEntity): void => {
    entities.push(e);
    if (e.type === "LINE") counts.lines++;
    else if (e.type === "LWPOLYLINE") {
      counts.polylines++;
      if (e.layer === "PDF Fill") counts.fills++;
    }
  };

  /* ── path accumulation (PDF user space, y-up) ──────────────────────────── */

  let pending: DxfPoint[][] = []; // completed sub-paths
  let cur: DxfPoint[] | null = null; // sub-path being built
  let start: DxfPoint | null = null;

  const startSub = (p: DxfPoint): void => {
    if (cur && cur.length) pending.push(cur);
    cur = [p];
    start = p;
  };
  const lineTo = (p: DxfPoint): void => {
    cur = cur ?? [];
    cur.push(p);
  };
  const p0 = (): DxfPoint => cur?.[cur.length - 1] ?? { x: 0, y: 0 };
  const cubicTo = (a: DxfPoint, c1: DxfPoint, c2: DxfPoint, p3: DxfPoint): void => {
    cur = cur ?? [a];
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const u = 1 - t;
      cur.push({
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
      });
    }
  };
  const quadTo = (a: DxfPoint, c: DxfPoint, p3: DxfPoint): void => {
    cur = cur ?? [a];
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const u = 1 - t;
      cur.push({
        x: u * u * a.x + 2 * u * t * c.x + t * t * p3.x,
        y: u * u * a.y + 2 * u * t * c.y + t * t * p3.y,
      });
    }
  };
  const closeSub = (): void => {
    if (cur && start) cur.push(start);
  };
  const rectSub = (x: number, y: number, w: number, h: number): void => {
    if (cur && cur.length) pending.push(cur);
    cur = [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)];
    start = cur[0];
  };

  /* ── ctm + colours ─────────────────────────────────────────────────────── */

  let ctm: Mat = ID;
  const saved: Array<{ ctm: Mat; stroke: number | null; fill: number | null }> = [];
  let stroke: number | null = null;
  let fill: number | null = null;

  /* ── emission ──────────────────────────────────────────────────────────── */

  const emitSub = (pts: DxfPoint[], kind: "stroke" | "fill"): void => {
    if (pts.length < 2) return;
    const s = pts.map((p) => ({ x: p.x * k, y: p.y * k }));
    const clean: DxfPoint[] = [];
    for (const p of s) {
      const last = clean[clean.length - 1];
      if (!last || Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) clean.push(p);
    }
    if (clean.length > 2) {
      const first = clean[0];
      const last = clean[clean.length - 1];
      if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) clean.pop();
    }
    if (clean.length < 2) return;
    // Near-black geometry stays BYLAYER so it renders correctly on dark and
    // light backgrounds; anything with a strong channel keeps its true colour.
    const color = kind === "fill" ? fill : stroke;
    const rgb = color !== null && channelMax(color) >= 0.15 ? color : undefined;
    if (clean.length === 2 && kind === "stroke") {
      push({ type: "LINE", layer: "PDF", rgb, start: clean[0], end: clean[1] });
      return;
    }
    push({
      type: "LWPOLYLINE",
      layer: kind === "fill" ? "PDF Fill" : "PDF",
      rgb,
      points: clean,
      closed: kind === "fill",
    });
  };

  const emitPending = (kind: "stroke" | "fill"): void => {
    const subs = pending.map((s) => s.slice());
    if (cur && cur.length) subs.push(cur.slice());
    pending = [];
    cur = null;
    start = null;
    for (const sub of subs) emitSub(sub, kind);
  };

  const dispatchPaint = (op: number): void => {
    if (op === OPS.stroke) emitPending("stroke");
    else if (op === OPS.closeStroke) {
      closeSub();
      emitPending("stroke");
    } else if (op === OPS.fill || op === OPS.eoFill) emitPending("fill");
    else if (op === OPS.fillStroke || op === OPS.eoFillStroke) emitPending("stroke");
    else if (op === OPS.closeFillStroke || op === OPS.closeEOFillStroke) {
      closeSub();
      emitPending("stroke");
    } else if (op === OPS.clip || op === OPS.eoClip) {
      clipCount++;
      pending = [];
      cur = null;
      start = null;
    } else if (op === IGNORE) {
      pending = [];
      cur = null;
      start = null;
    }
    // Unknown paint op → leave the path pending; an explicit paint operator
    // (older builds) flushes it later.
  };

  /* ── operator walk ─────────────────────────────────────────────────────── */

  // pdf.js ≥6.5 DrawOPS codes (verified against the installed build).
  const D_MOVE = 0;
  const D_LINE = 1;
  const D_CURVE = 2;
  const D_QUAD = 3;
  const D_CLOSE = 4;

  const buildPath = (args: any[]): void => {
    if (typeof args[0] === "number") {
      // pdf.js ≥6.5 packed form: [paintOp, [interleaved ops+coords], minMax]
      // (the interleaved DrawOPS run arrives wrapped in a one-element array)
      const raw = args[1];
      const ops: ArrayLike<number> = Array.isArray(raw) ? ((raw[0] ?? []) as ArrayLike<number>) : ((raw ?? []) as ArrayLike<number>);
      let i = 0;
      while (i < ops.length) {
        const op = ops[i++];
        if (op === D_MOVE) startSub(apply(ctm, ops[i++], ops[i++]));
        else if (op === D_LINE) lineTo(apply(ctm, ops[i++], ops[i++]));
        else if (op === D_CURVE) {
          const a = p0();
          const c1 = apply(ctm, ops[i++], ops[i++]);
          const c2 = apply(ctm, ops[i++], ops[i++]);
          const p3 = apply(ctm, ops[i++], ops[i++]);
          cubicTo(a, c1, c2, p3);
        } else if (op === D_QUAD) {
          const a = p0();
          const c = apply(ctm, ops[i++], ops[i++]);
          const p3 = apply(ctm, ops[i++], ops[i++]);
          quadTo(a, c, p3);
        } else if (op === D_CLOSE) closeSub();
        else break; // unknown code — stop to stay in sync
      }
      return;
    }
    const opsArr = args[0];
    if (Array.isArray(opsArr) || opsArr instanceof Int32Array || opsArr instanceof Uint32Array) {
      // pdf.js 4–5 packed form: [ops (classic OPS codes), coords, minMax?]
      const ops: number[] = Array.from(opsArr as ArrayLike<number>);
      const coords: number[] = Array.from((args[1] ?? []) as ArrayLike<number>);
      let ci = 0;
      for (const op of ops) {
        if (op === OPS.moveTo) startSub(apply(ctm, coords[ci++], coords[ci++]));
        else if (op === OPS.lineTo) lineTo(apply(ctm, coords[ci++], coords[ci++]));
        else if (op === OPS.curveTo) {
          const a = p0();
          const c1 = apply(ctm, coords[ci++], coords[ci++]);
          const c2 = apply(ctm, coords[ci++], coords[ci++]);
          const p3 = apply(ctm, coords[ci++], coords[ci++]);
          cubicTo(a, c1, c2, p3);
        } else if (op === OPS.curveTo2) {
          // y: first control point is the current point
          const a = p0();
          const c2 = apply(ctm, coords[ci++], coords[ci++]);
          const p3 = apply(ctm, coords[ci++], coords[ci++]);
          cubicTo(a, a, c2, p3);
        } else if (op === OPS.curveTo3) {
          // v: second control point is the end point
          const a = p0();
          const c1 = apply(ctm, coords[ci++], coords[ci++]);
          const p3 = apply(ctm, coords[ci++], coords[ci++]);
          cubicTo(a, c1, p3, p3);
        } else if (op === OPS.rectangle) {
          rectSub(coords[ci++], coords[ci++], coords[ci++], coords[ci++]);
        } else if (op === OPS.closePath) closeSub();
        else break;
      }
      return;
    }
    // Oldest form: flat [op, x, y, op, x, y, …]
    let i = 0;
    while (i < args.length) {
      const op = args[i++];
      if (op === OPS.moveTo) startSub(apply(ctm, args[i++], args[i++]));
      else if (op === OPS.lineTo) lineTo(apply(ctm, args[i++], args[i++]));
      else if (op === OPS.curveTo) {
        const a = p0();
        const c1 = apply(ctm, args[i++], args[i++]);
        const c2 = apply(ctm, args[i++], args[i++]);
        const p3 = apply(ctm, args[i++], args[i++]);
        cubicTo(a, c1, c2, p3);
      } else if (op === OPS.curveTo2) {
        const a = p0();
        const c2 = apply(ctm, args[i++], args[i++]);
        const p3 = apply(ctm, args[i++], args[i++]);
        cubicTo(a, a, c2, p3);
      } else if (op === OPS.curveTo3) {
        const a = p0();
        const c1 = apply(ctm, args[i++], args[i++]);
        const p3 = apply(ctm, args[i++], args[i++]);
        cubicTo(a, c1, p3, p3);
      } else if (op === OPS.rectangle) {
        rectSub(args[i++], args[i++], args[i++], args[i++]);
      } else if (op === OPS.closePath) closeSub();
      else break;
    }
  };

  const opList = await page.getOperatorList();
  const fns: number[] = opList.fnArray;
  const allArgs: any[] = opList.argsArray;

  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i];
    const args = allArgs[i];
    if (fn === OPS.save) {
      saved.push({ ctm, stroke, fill });
    } else if (fn === OPS.restore) {
      const s = saved.pop();
      if (s) {
        ctm = s.ctm;
        stroke = s.stroke;
        fill = s.fill;
      }
    } else if (fn === OPS.transform) {
      ctm = mul(ctm, args as unknown as Mat);
    } else if (fn === OPS.setStrokeRGBColor) {
      stroke = parseColorArg(args);
    } else if (fn === OPS.setFillRGBColor) {
      fill = parseColorArg(args);
    } else if (fn === OPS.setStrokeCMYKColor) {
      stroke = cmykToInt(args[0], args[1], args[2], args[3]);
    } else if (fn === OPS.setFillCMYKColor) {
      fill = cmykToInt(args[0], args[1], args[2], args[3]);
    } else if (fn === OPS.setStrokeGrayColor || fn === OPS.setFillGrayColor) {
      const v = typeof args[0] === "string" ? parseColorArg(args) : rgbToInt(args[0], args[0], args[0]);
      if (fn === OPS.setStrokeGrayColor) stroke = v;
      else fill = v;
    } else if (fn === OPS.constructPath) {
      buildPath(args);
      if (typeof args[0] === "number") dispatchPaint(args[0]); // pdf.js ≥6.5: paint rides along
    } else if (
      fn === OPS.stroke ||
      fn === OPS.closeStroke ||
      fn === OPS.fill ||
      fn === OPS.eoFill ||
      fn === OPS.fillStroke ||
      fn === OPS.eoFillStroke ||
      fn === OPS.closeFillStroke ||
      fn === OPS.closeEOFillStroke ||
      fn === OPS.clip ||
      fn === OPS.eoClip ||
      fn === IGNORE
    ) {
      // Older builds: paint/clip arrives as its own operator after the path.
      dispatchPaint(fn);
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageMaskXObject ||
      fn === OPS.paintJpegXObject
    ) {
      counts.imagesSkipped++;
    }
  }

  /* ── pass 2: text ──────────────────────────────────────────────────────── */

  const tc = await page.getTextContent();
  for (const it of tc.items as any[]) {
    if (typeof it?.str !== "string") continue;
    const value = it.str.replace(/\s+$/, "");
    if (!value.trim()) continue;
    const t = it.transform as number[] | undefined;
    if (!t) continue;
    const height = Math.max(Math.hypot(t[1] ?? 0, t[3] ?? 0) * k, 1e-4);
    const rotDeg = Math.atan2(t[1] ?? 0, t[0] ?? 1) * (180 / Math.PI);
    entities.push({
      type: "TEXT",
      layer: "PDF Text",
      position: { x: (t[4] ?? 0) * k, y: (t[5] ?? 0) * k },
      height,
      value,
      ...(Math.abs(rotDeg) > 0.01 ? { rotation: Math.round(rotDeg * 1000) / 1000 } : {}),
    });
    counts.texts++;
  }

  /* ── document ──────────────────────────────────────────────────────────── */

  const layers: DxfLayer[] = [
    { name: "0", color: 7 },
    { name: "PDF", color: 7 },
    { name: "PDF Text", color: 4 },
    { name: "PDF Fill", color: 8 },
  ];
  const doc: DxfDocument = {
    layers,
    entities,
    units: unitsPerInch === 25.4 ? "mm" : "unitless",
    ...(clipCount > 0 || counts.imagesSkipped > 0
      ? { skipped: { ...(clipCount > 0 ? { CLIP: clipCount } : {}), ...(counts.imagesSkipped > 0 ? { IMAGE: counts.imagesSkipped } : {}) } }
      : {}),
  };
  if (entities.length) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const e of entities) {
      const pts: DxfPoint[] =
        e.type === "LINE"
          ? [e.start, e.end]
          : e.type === "LWPOLYLINE"
            ? e.points
            : e.type === "TEXT"
              ? [e.position]
              : [];
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (minX !== Infinity) doc.extents = { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
  }

  return {
    doc,
    pageCount: pdf.numPages,
    pageSize: { width: viewport.width, height: viewport.height },
    page: pageNo,
    unitsPerInch,
    counts,
  };
}
