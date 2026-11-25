// Free family creator, slice 1: read dimension candidates out of text.
//
// Input is plain text, one string per page (pdf.js text extraction, or a
// pasted spec). Each candidate keeps its page, line and exact source text,
// so the user can check it (the reference's "Sources" idea). Nothing here
// guesses: a number that is not clearly a length with a unit is skipped.

import { parseLength } from "./units";

export interface DimensionCandidate {
  /** Short label, e.g. "Width" or "Overall size". */
  label: string;
  /** Value in metres. */
  valueM: number;
  page: number;
  line: number;
  /** The exact source line the value came from. */
  sourceText: string;
  /** "count" when valueM holds a whole number (a count), not metres. */
  kind?: "count";
}

export interface OverallSize {
  widthM: number;
  depthM: number;
  heightM: number;
  /** "triplet" = one "A x B x C unit" line; "labelled" = separate lines. */
  how: "triplet" | "labelled";
  sources: DimensionCandidate[];
}

const NUM = String.raw`\d+(?:\.\d+)?`;
const UNIT = String.raw`(?:mm|cm|m|ft|in)\b`;

const LABELS: Array<{ key: "width" | "depth" | "height"; re: RegExp }> = [
  { key: "width", re: /\b(width|w)\b/i },
  { key: "depth", re: /\b(depth|length|d|l)\b/i },
  { key: "height", re: /\b(height|h)\b/i },
];

/**
 * "A x B x C mm" lines. The order is W x D x H by convention; the caller
 * must show this to the user because manufacturers differ.
 */
export function findTriplets(pages: string[]): DimensionCandidate[][] {
  const out: DimensionCandidate[][] = [];
  const re = new RegExp(`(${NUM})\\s*[x\u00d7*]\\s*(${NUM})\\s*[x\u00d7*]\\s*(${NUM})\\s*(${UNIT})`, "i");
  pages.forEach((text, p) => {
    String(text).split(/\r?\n/).forEach((line, i) => {
      const m = re.exec(line);
      if (!m) return;
      const unit = m[4];
      const vals = [m[1], m[2], m[3]].map((n) => parseLength(`${n} ${unit}`));
      if (vals.some((v) => v === null || v <= 0)) return;
      const names = ["Width", "Depth", "Height"];
      out.push(vals.map((v, k) => ({
        label: names[k], valueM: v as number, page: p + 1, line: i + 1, sourceText: line.trim(),
      })));
    });
  });
  return out;
}

/** "Width: 1150 mm" style lines. */
export function findLabelled(pages: string[]): DimensionCandidate[] {
  const out: DimensionCandidate[] = [];
  const re = new RegExp(`^\\s*([A-Za-z][A-Za-z ()/]{0,30}?)\\s*[:=\\-]?\\s*(${NUM})\\s*(${UNIT})`, "i");
  pages.forEach((text, p) => {
    String(text).split(/\r?\n/).forEach((line, i) => {
      const m = re.exec(line);
      if (!m) return;
      const v = parseLength(`${m[2]} ${m[3]}`);
      if (v === null || v <= 0) return;
      out.push({ label: m[1].trim(), valueM: v, page: p + 1, line: i + 1, sourceText: line.trim() });
    });
  });
  return out;
}

/**
 * Pick an overall size. Returns null when nothing is clear. When several
 * triplets disagree it returns null too, so the caller asks the user rather
 * than choosing one silently.
 */
export function pickOverallSize(pages: string[]): OverallSize | null {
  const triplets = findTriplets(pages);
  if (triplets.length) {
    const first = triplets[0];
    const same = triplets.every((t) => t.every((c, k) => Math.abs(c.valueM - first[k].valueM) < 1e-6));
    if (!same) return null;
    return { widthM: first[0].valueM, depthM: first[1].valueM, heightM: first[2].valueM, how: "triplet", sources: first };
  }
  const labelled = findLabelled(pages);
  const pick = (key: "width" | "depth" | "height") => {
    const lab = LABELS.find((l) => l.key === key)!;
    const hits = labelled.filter((c) => lab.re.test(c.label));
    if (!hits.length) return null;
    const v = hits[0].valueM;
    return hits.every((h) => Math.abs(h.valueM - v) < 1e-6) ? hits[0] : null;
  };
  const w = pick("width"), d = pick("depth"), h = pick("height");
  if (!w || !d || !h) return null;
  return { widthM: w.valueM, depthM: d.valueM, heightM: h.valueM, how: "labelled", sources: [w, d, h] };
}

/** Extra, optional values a sheet can carry, mapped to template parameter names. */
export interface ExtraParam { name: string; value: number; candidate: DimensionCandidate }

const EXTRA_LENGTHS: Array<{ name: string; label: string; re: RegExp }> = [
  { name: "PlinthHeight", label: "Plinth height", re: /^(plinth|kick plate|kickplate)( height)?$/i },
  { name: "DoorThickness", label: "Door thickness", re: /^door thickness$/i },
  { name: "LegSize", label: "Leg size", re: /^leg (size|width|thickness)$/i },
  { name: "TopThickness", label: "Top thickness", re: /^(table ?top|top|worktop) thickness$/i },
  { name: "DrawerHeight", label: "Drawer front height", re: /^drawer( front)? height$/i },
  { name: "PanelThickness", label: "Panel thickness", re: /^(panel|board|shelf|side) thickness$/i },
];

/**
 * Labelled extras like "Plinth height: 100 mm" or "Middle shelves: 3".
 * A name that appears with two different values is dropped, not guessed.
 * A plain "Shelves: 4" is ignored on purpose: sheets differ on whether the
 * top and bottom count. The caller decides which names the template has.
 */
export interface ExtrasReading {
  found: ExtraParam[];
  /** Same name, different values: none of them is used. */
  conflicts: Array<{ name: string; label: string; candidates: DimensionCandidate[] }>;
  /** Lines like "Shelves: 4" that could mean two things. Not used. */
  ambiguous: DimensionCandidate[];
}

export function readExtras(pages: string[]): ExtrasReading {
  const found = new Map<string, ExtraParam[]>();
  const add = (e: ExtraParam) => found.set(e.name, [...(found.get(e.name) ?? []), e]);
  for (const c of findLabelled(pages)) {
    for (const x of EXTRA_LENGTHS) {
      if (x.re.test(c.label)) add({ name: x.name, value: c.valueM, candidate: { ...c, label: x.label } });
    }
  }
  const cnt = /^\s*(middle|intermediate|adjustable|inner) shelves\s*[:=\-]?\s*(\d{1,2})\s*$/i;
  const doorsDrawers = /^\s*(number of )?(doors|drawers)\s*[:=\-]?\s*(\d{1,2})\s*$/i;
  const plain = /^\s*(number of )?shelves\s*[:=\-]?\s*(\d{1,2})\s*$/i;
  const ambiguous: DimensionCandidate[] = [];
  pages.forEach((text, p) => String(text).split(/\r?\n/).forEach((line, i) => {
    const dd = doorsDrawers.exec(line);
    if (dd) {
      const label = dd[2][0].toUpperCase() + dd[2].slice(1).toLowerCase();
      add({ name: label, value: Number(dd[3]), candidate: { label, valueM: Number(dd[3]), page: p + 1, line: i + 1, sourceText: line.trim(), kind: "count" } });
      return;
    }
    const m = cnt.exec(line);
    if (m) add({ name: "MidShelves", value: Number(m[2]), candidate: { label: "Middle shelves", valueM: Number(m[2]), page: p + 1, line: i + 1, sourceText: line.trim(), kind: "count" } });
    else if (plain.test(line)) ambiguous.push({ label: "Shelves", valueM: Number(plain.exec(line)![2]), page: p + 1, line: i + 1, sourceText: line.trim(), kind: "count" });
  }));
  const out: ExtraParam[] = [];
  const conflicts: ExtrasReading["conflicts"] = [];
  for (const [name, list] of found) {
    if (list.every((e) => Math.abs(e.value - list[0].value) < 1e-9)) out.push(list[0]);
    else conflicts.push({ name, label: list[0].candidate.label, candidates: list.map((e) => e.candidate) });
  }
  return { found: out, conflicts, ambiguous };
}

export function pickExtras(pages: string[]): ExtraParam[] {
  return readExtras(pages).found;
}
