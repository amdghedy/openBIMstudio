/**
 * Stroke fonts for AutoCAD SHX text.
 *
 * SHX fonts (simplex, romans, txt, isocp…) are single-line stroke fonts; drawing them with a filled system font
 * (what the viewer did before) makes text look heavier and shaped differently from the native viewer. The Hershey
 * fonts are the public ancestors of romans/simplex/romanc/romant/italicc/scriptc, so mapping SHX names to them
 * reproduces the native thin-line look. Glyph data and its licence acknowledgement live in stroke-font-data.ts.
 *
 * Pure parsing / layout (no DOM) so it can be unit-tested in Node; the viewer builds Path2D objects from the polylines.
 */
import { HERSHEY_DATA } from "./stroke-font-data";

export const CAP_UNITS = 21;     // cap height of the Hershey glyph set
const BASE_Y = 9;                // baseline row of the Hershey glyph set
const ORIGIN = 82;               // 'R'

export interface StrokeGlyph {
  /** Advance width in glyph units. */
  adv: number;
  /** Polylines in glyph units, x from the left bound, y downwards with the baseline at 0 (caps reach -21). */
  strokes: Array<Array<[number, number]>>;
}

export interface StrokeFont {
  id: string;
  glyph(ch: string): StrokeGlyph | undefined;
}

/** SHX / TrueType file name -> Hershey data set (undefined = keep the normal font). */
export function strokeSetFor(font: string | undefined): string | undefined {
  const k = String(font ?? "").trim().toLowerCase().replace(/\.(shx|ttf|otf|ttc)$/, "");
  if (!k) return undefined;
  if (/^(simplex|romans|isocp|isocpeur|isocp2|isocp3|iso|txt|standard|simplex2|sansserif)$/.test(k)) return "rowmans";
  if (/^(romanc|romand|complex|greekc)$/.test(k)) return "rowmand";
  if (/^(romant|triplex)$/.test(k)) return "rowmant";
  if (/^(italicc|italict|italic|isocteur|isoct|isoct2|isoct3)$/.test(k)) return "timesi";
  if (/^(scriptc|scripts|script)$/.test(k)) return "scripts";
  return undefined;
}

function parseGlyph(raw: string): StrokeGlyph {
  const left = raw.charCodeAt(0) - ORIGIN, right = raw.charCodeAt(1) - ORIGIN;
  const strokes: StrokeGlyph["strokes"] = [];
  let cur: Array<[number, number]> = [];
  for (let i = 2; i + 1 < raw.length; i += 2) {
    if (raw[i] === " " && raw[i + 1] === "R") { if (cur.length) strokes.push(cur); cur = []; continue; }
    cur.push([raw.charCodeAt(i) - ORIGIN - left, raw.charCodeAt(i + 1) - ORIGIN - BASE_Y]);
  }
  if (cur.length) strokes.push(cur);
  return { adv: right - left, strokes };
}

const fonts = new Map<string, StrokeFont>();
export function strokeFont(set: string): StrokeFont | undefined {
  const data = HERSHEY_DATA[set];
  if (!data) return undefined;
  let f = fonts.get(set);
  if (!f) {
    const cache = new Map<string, StrokeGlyph>();
    f = {
      id: set,
      glyph(ch: string) {
        const code = ch.charCodeAt(0);
        if (ch.length !== 1 || code < 32 || code - 32 >= data.length || code > 126) return undefined;
        let g = cache.get(ch);
        if (!g) { g = parseGlyph(data[code - 32]); cache.set(ch, g); }
        return g;
      },
    };
    fonts.set(set, f);
  }
  return f;
}

export function strokeFontFor(font: string | undefined): StrokeFont | undefined {
  const set = strokeSetFor(font);
  return set ? strokeFont(set) : undefined;
}

/** Width of a line in glyph units, or null when any character has no stroke glyph (caller keeps the normal font). */
export function strokeLineWidth(f: StrokeFont, text: string): number | null {
  let w = 0;
  for (const ch of text) {
    const g = f.glyph(ch);
    if (!g) return null;
    w += g.adv;
  }
  return w;
}

/** All polylines of a line of text, in glyph units, starting at x = 0; null when unsupported characters occur. */
export function strokeLinePolylines(f: StrokeFont, text: string): Array<Array<[number, number]>> | null {
  const out: Array<Array<[number, number]>> = [];
  let x = 0;
  for (const ch of text) {
    const g = f.glyph(ch);
    if (!g) return null;
    for (const s of g.strokes) out.push(s.map(([px, py]) => [px + x, py] as [number, number]));
    x += g.adv;
  }
  return out;
}
