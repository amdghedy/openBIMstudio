/**
 * Filled polygons for the sheet PDF exporter.
 *
 * modules/export/pdf.ts fills polylines with pdf-lib's drawSvgPath(d, { x: 0, y: 0 }) while
 * passing page coordinates that are already y-up. drawSvgPath treats its path as y-DOWN
 * (it flips the y axis around the given origin), so those fills land below the page and
 * never show: poche, tag bubbles and translucent glazing would be missing from printed
 * sheets. This helper fills the polygon with raw PDF path operators in page coordinates,
 * which is unambiguous. It returns false when pdf-lib's operator API is not available so
 * the caller can fall back to the old path.
 */
import * as PDFLIB from "pdf-lib";

type Any = Record<string, any>;

export function fillPolygonPdf(page: Any, pts: Array<[number, number]>, color: { r: number; g: number; b: number }, opacity: number): boolean {
  const L = PDFLIB as unknown as Any;
  if (pts.length < 3 || typeof page?.pushOperators !== "function") return false;
  for (const name of ["pushGraphicsState", "popGraphicsState", "setFillingRgbColor", "moveTo", "lineTo", "closePath", "fill"]) {
    if (typeof L[name] !== "function") return false;
  }
  const op = Math.max(0, Math.min(1, opacity));
  const mix = (c: number) => 1 - (1 - c) * op; // translucent fills are blended with the white paper
  const ops: unknown[] = [L.pushGraphicsState(), L.setFillingRgbColor(mix(color.r), mix(color.g), mix(color.b)), L.moveTo(pts[0][0], pts[0][1])];
  for (let i = 1; i < pts.length; i++) ops.push(L.lineTo(pts[i][0], pts[i][1]));
  ops.push(L.closePath(), L.fill(), L.popGraphicsState());
  page.pushOperators(...ops);
  return true;
}
