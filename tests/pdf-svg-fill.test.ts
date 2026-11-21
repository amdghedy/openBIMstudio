/**
 * Regression test — sheet-PDF SVG-path fills must land on the page.
 *
 * pdf-lib's `drawSvgPath` applies `scale(1, -1)` (SVG y-down vs PDF y-up),
 * so a path point (px, py) in `d` renders at (px, -py). The PDF exporter
 * builds `d` from `worldToPdf()` points, which are PDF y-up page coords —
 * feeding them straight into `drawSvgPath` rendered every fill at y = -py,
 * i.e. below the page and invisible, while the `drawLine` outlines of the
 * same entities landed correctly (hardening-plan item 13, leg 6).
 *
 * This test drives the real `drawScene2DToPdf` with real pdf-lib, saves the
 * PDF, decodes its content streams, and asserts the *rendered* fill geometry
 * (path coords composed with the `1 0 0 -1 0 0 cm` matrix) coincides with
 * the outline geometry and lies inside the page. No mocks: the numbers
 * below are the actual PDF operators the exporter emits.
 *
 * Run: npx tsx tests/pdf-svg-fill.test.ts   (or: npm run test:pdf-svg-fill)
 */
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { createPdfDocument, drawScene2DToPdf } from "../src/modules/export/pdf";
import type { Scene2D } from "../src/modules/views/scene";

// A4-ish page, deliberately not square so a Y flip cannot hide in symmetry.
const PAGE_W = 595;
const PAGE_H = 842;
// worldToPt = 2 pt per world unit; origin places the scene mid-page.
const WORLD_TO_PT = 2;
const ORIGIN_X = 100;
const ORIGIN_Y = 200;

const STROKE = { color: "#000000", widthPt: 0.5, dash: null };

function buildScene(): Scene2D {
  return {
    bounds: { minX: 0, minZ: 0, maxX: 30, maxZ: 10 },
    generatedAt: 0,
    layers: {
      below: [],
      grid: [],
      // Filled closed polyline: square (0,0)-(10,0)-(10,10)-(0,10) in world
      // XZ. worldToPdf(x, -z): PDF x = 100 + 2x, PDF y = 200 - 2z, so the
      // square must render at x 100..120, y 180..200.
      project: [
        {
          kind: "polyline",
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
          ],
          closed: true,
          stroke: STROKE,
          fill: { color: "#808080", opacity: 1 },
        },
      ],
      overhead: [],
      // Wall poche: polygon (20,0)-(30,0)-(30,10)-(20,10) must render at
      // x 140..160, y 180..200. Poche has no outline, so only the fill
      // proves it.
      cut: [
        {
          kind: "hatch",
          polygon: [
            [20, 0],
            [30, 0],
            [30, 10],
            [20, 10],
          ],
          pattern: "poche",
          color: "#000000",
          scale: 1,
        },
      ],
      symbols: [],
      annotation: [],
    },
  };
}

/** Decode every content stream in the saved PDF bytes to operator text. */
function contentStreamsText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const chunks: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const data = Buffer.from(m[1], "latin1");
    try {
      chunks.push(inflateSync(data).toString("latin1"));
    } catch {
      chunks.push(data.toString("latin1"));
    }
  }
  assert.ok(chunks.length > 0, "no content streams found in the saved PDF");
  return chunks.join("\n");
}

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function bboxOf(points: Array<[number, number]>): BBox {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function closeTo(a: number, b: number, tol = 0.01): boolean {
  return Math.abs(a - b) <= tol;
}

function assertBBox(actual: BBox, expected: BBox, label: string): void {
  for (const k of ["minX", "minY", "maxX", "maxY"] as const) {
    assert.ok(
      closeTo(actual[k], expected[k]),
      `${label}: ${k} rendered ${actual[k]}, expected ${expected[k]}`,
    );
  }
}

async function main(): Promise<void> {
  const { doc, regular, bold } = await createPdfDocument();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  drawScene2DToPdf(page, regular, bold, buildScene(), WORLD_TO_PT, ORIGIN_X, ORIGIN_Y);
  const bytes = await doc.save({ useObjectStreams: false });
  const text = contentStreamsText(bytes);

  // ── Fills: each drawSvgPath emits `1 0 0 -1 0 0 cm` then the path ops
  //    then `f`. Compose the path coords with that matrix: a `d` point
  //    (px, py) renders at (px, -py).
  const fillBlocks = [...text.matchAll(/1 0 0 -1 0 0 cm([\s\S]*?)\n?f\b/g)];
  assert.equal(fillBlocks.length, 2, `expected 2 SVG-path fills, found ${fillBlocks.length}`);
  const renderedFills: BBox[] = fillBlocks.map((b) => {
    const pts: Array<[number, number]> = [];
    for (const m of b[1].matchAll(/(-?[\d.]+) (-?[\d.]+) [ml]/g)) {
      pts.push([parseFloat(m[1]), -parseFloat(m[2])]);
    }
    assert.ok(pts.length >= 3, "fill path must have at least 3 points");
    return bboxOf(pts);
  });

  // ── Outlines: drawLine emits `x y m x y m x y l ... S` (pdf-lib repeats
  //    the moveTo). Strip the fill blocks first so fill path ops are not
  //    mistaken for outlines, then collect every m/l point.
  const withoutFills = text.replace(/1 0 0 -1 0 0 cm[\s\S]*?\n?f\b/g, "");
  const outlinePts: Array<[number, number]> = [];
  for (const m of withoutFills.matchAll(/(-?[\d.]+) (-?[\d.]+) [ml]/g)) {
    outlinePts.push([parseFloat(m[1]), parseFloat(m[2])]);
  }
  assert.ok(outlinePts.length > 0, "no drawLine outline segments found");
  const outlineBox = bboxOf(outlinePts);

  // 1. Every rendered fill lies inside the page (the bug put them at y < 0).
  for (const [i, b] of renderedFills.entries()) {
    assert.ok(
      b.minX >= 0 && b.minY >= 0 && b.maxX <= PAGE_W && b.maxY <= PAGE_H,
      `fill ${i} rendered off-page: ${JSON.stringify(b)} (page ${PAGE_W}x${PAGE_H})`,
    );
  }

  // 2. The filled polyline renders exactly where its outline is.
  const square: BBox = { minX: 100, minY: 180, maxX: 120, maxY: 200 };
  assertBBox(outlineBox, square, "polyline outline");
  const polyFill = renderedFills.find(
    (b) => closeTo(b.minX, 100) && closeTo(b.maxX, 120),
  );
  assert.ok(polyFill, `no fill matches the polyline square, fills: ${JSON.stringify(renderedFills)}`);
  assertBBox(polyFill, square, "polyline fill");

  // 3. The poche fill renders at its polygon's page position.
  const poche: BBox = { minX: 140, minY: 180, maxX: 160, maxY: 200 };
  const pocheFill = renderedFills.find(
    (b) => closeTo(b.minX, 140) && closeTo(b.maxX, 160),
  );
  assert.ok(pocheFill, `no fill matches the poche polygon, fills: ${JSON.stringify(renderedFills)}`);
  assertBBox(pocheFill, poche, "poche fill");

  console.log("pdf-svg-fill: PASS — 2 fills rendered on-page, coincident with outlines");
  console.log("  polyline fill:", JSON.stringify(polyFill));
  console.log("  poche fill:   ", JSON.stringify(pocheFill));
  console.log("  outline:      ", JSON.stringify(outlineBox));
}

main().catch((err) => {
  console.error("pdf-svg-fill: FAIL");
  console.error(err);
  process.exit(1);
});
