/**
 * Sheets & Drawing Production — professional documentation engine.
 *
 * Places plan views, 3D views and schedules onto titleblocked sheets.
 * Designed to compete with BIM sheets / Bentley drawing production.
 */
import type { SheetDef, SheetViewport, TitleblockDef } from "../projects/types";
import { paperSizeMm, normalizePaperId } from "../../core/paper-sizes";
import { region } from "../../core/region";
export type { SheetDef, SheetViewport, TitleblockDef };

const uid = () =>
  (crypto as any).randomUUID?.() ?? `sh-${Date.now()}-${Math.random().toString(16).slice(2)}`;


let sheets: SheetDef[] = [];
let titleblocks: TitleblockDef[] = [];
const listeners = new Set<() => void>();

/**
 * Session mirror so sheets survive a reload even before a project file is
 * saved (same pattern as the views store). Opening a project replaces this
 * mirror with the project's authoritative copy via loadSheetsFromProject().
 */
const STORAGE_KEY = "obs.sheets.v1";

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sheets, titleblocks }));
  } catch {
    /* storage full / unavailable — the ProjectDoc save path still covers it */
  }
}

function notify() {
  persist();
  for (const fn of listeners) fn();
}

let booted = false;

/** Boot: hydrate the store from the session mirror (no-op when absent/corrupt). */
export function bootSheetsStore(): void {
  if (booted) return;
  booted = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      ensureDefaultTitleblock();
      return;
    }
    const parsed = JSON.parse(raw) as { sheets?: SheetDef[]; titleblocks?: TitleblockDef[] };
    if (Array.isArray(parsed.sheets)) sheets = parsed.sheets.map((s) => ({ ...s }));
    if (Array.isArray(parsed.titleblocks)) titleblocks = parsed.titleblocks.map((t) => ({ ...t }));
    if (!titleblocks.length) ensureDefaultTitleblock();
  } catch {
    ensureDefaultTitleblock();
  }
}

/** Deep-copy a sheet (undo/redo snapshots). */
export function cloneSheet(s: SheetDef): SheetDef {
  return {
    ...s,
    viewports: s.viewports.map((v) => ({ ...v })),
    annotations: (s.annotations ?? []).map((a) => ({ ...a })),
  };
}

/** Deep-copy a titleblock (undo/redo snapshots). */
export function cloneTitleblock(t: TitleblockDef): TitleblockDef {
  return { ...t, fields: t.fields.map((f) => ({ ...f })) };
}

export function onSheetsChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function listSheets(): SheetDef[] {
  return sheets.slice().sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

export function getSheet(id: string): SheetDef | undefined {
  return sheets.find((s) => s.id === id);
}

export function createSheet(opts?: Partial<Pick<SheetDef, "number" | "name" | "size" | "orientation">>): SheetDef {
  const n = sheets.length + 1;
  const sheet: SheetDef = {
    id: uid(),
    number: opts?.number ?? `A-${String(n).padStart(3, "0")}`,
    name: opts?.name ?? `Sheet ${n}`,
    size: opts?.size ?? defaultSheetSize(),
    orientation: opts?.orientation ?? "landscape",
    viewports: [],
    annotations: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  // Attach default titleblock if available
  const tb = titleblocks[0];
  if (tb) sheet.titleblockId = tb.id;
  sheets.push(sheet);
  notify();
  return sheet;
}

export function updateSheet(id: string, patch: Partial<SheetDef>) {
  const s = sheets.find((x) => x.id === id);
  if (!s) return;
  Object.assign(s, patch, { updatedAt: Date.now() });
  notify();
}

export function deleteSheet(id: string) {
  sheets = sheets.filter((s) => s.id !== id);
  notify();
}

/**
 * Duplicate a sheet (G11 Project Browser menu): the copy keeps the
 * viewports and annotations with fresh ids, a new id of its own, and the
 * next free sheet number — the source number is never reused, so the
 * sorted sheet list stays unambiguous.
 */
export function duplicateSheet(id: string): SheetDef | null {
  const src = sheets.find((s) => s.id === id);
  if (!src) return null;
  const copy = cloneSheet(src);
  copy.id = uid();
  copy.name = `${src.name} (copy)`;
  copy.number = nextSheetNumber();
  copy.viewports = copy.viewports.map((v) => ({ ...v, id: uid() }));
  copy.annotations = (copy.annotations ?? []).map((a) => ({ ...a, id: uid() }));
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  sheets.push(copy);
  notify();
  return copy;
}

function nextSheetNumber(): string {
  let max = 0;
  for (const s of sheets) {
    const m = /(\d+)$/.exec(s.number);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `A-${String(max + 1).padStart(3, "0")}`;
}

export function addViewport(sheetId: string, vp: Omit<SheetViewport, "id">): SheetViewport | null {
  const s = sheets.find((x) => x.id === sheetId);
  if (!s) return null;
  const viewport: SheetViewport = { ...vp, id: uid() };
  s.viewports.push(viewport);
  s.updatedAt = Date.now();
  notify();
  return viewport;
}

export function removeViewport(sheetId: string, viewportId: string) {
  const s = sheets.find((x) => x.id === sheetId);
  if (!s) return;
  s.viewports = s.viewports.filter((v) => v.id !== viewportId);
  s.updatedAt = Date.now();
  notify();
}

export function listTitleblocks(): TitleblockDef[] {
  return titleblocks.slice();
}

export function getTitleblock(id: string | undefined): TitleblockDef | undefined {
  return titleblocks.find((t) => t.id === id);
}

export function updateTitleblock(id: string, patch: Partial<TitleblockDef>): TitleblockDef | null {
  const t = titleblocks.find((x) => x.id === id);
  if (!t) return null;
  Object.assign(t, patch);
  for (const s of sheets) {
    if (s.titleblockId === id) s.updatedAt = Date.now();
  }
  notify();
  return t;
}

// ── Sheet-level annotations (SheetDef.annotations: text placed on the sheet,
//    outside any viewport — general notes, key plan labels, drawing keys) ──

export interface SheetAnnotation {
  id: string;
  kind: string;
  text: string;
  x: number;
  y: number;
}

export interface SheetAnnotationInput {
  kind?: string;
  text: string;
  x: number;
  y: number;
}

export function addSheetAnnotation(sheetId: string, input: SheetAnnotationInput): SheetAnnotation | null {
  const s = sheets.find((x) => x.id === sheetId);
  if (!s) return null;
  const ann: SheetAnnotation = {
    id: uid(),
    kind: input.kind ?? "text",
    text: input.text,
    x: input.x,
    y: input.y,
  };
  s.annotations = [...(s.annotations ?? []), ann];
  s.updatedAt = Date.now();
  notify();
  return ann;
}

export function updateSheetAnnotation(
  sheetId: string,
  annId: string,
  patch: Partial<{ text: string; x: number; y: number }>,
): boolean {
  const s = sheets.find((x) => x.id === sheetId);
  const ann = s?.annotations?.find((a) => a.id === annId);
  if (!s || !ann) return false;
  Object.assign(ann, patch);
  s.updatedAt = Date.now();
  notify();
  return true;
}

export function removeSheetAnnotation(sheetId: string, annId: string): boolean {
  const s = sheets.find((x) => x.id === sheetId);
  if (!s || !s.annotations?.some((a) => a.id === annId)) return false;
  s.annotations = s.annotations.filter((a) => a.id !== annId);
  s.updatedAt = Date.now();
  notify();
  return true;
}

export function ensureDefaultTitleblock(): TitleblockDef {
  if (titleblocks.length) return titleblocks[0];
  const tb: TitleblockDef = {
    id: uid(),
    name: "Standard A1 Titleblock",
    size: "A1",
    fields: [
      { key: "project", label: "Project", value: "" },
      { key: "sheet_name", label: "Sheet Name", value: "" },
      { key: "sheet_no", label: "Sheet No.", value: "" },
      { key: "drawn_by", label: "Drawn", value: "" },
      { key: "checked_by", label: "Checked", value: "" },
      { key: "date", label: "Date", value: new Date().toISOString().slice(0, 10) },
      { key: "scale", label: "Scale", value: "As noted" },
      { key: "rev", label: "Rev", value: "0" },
    ],
  };
  titleblocks.push(tb);
  notify();
  return tb;
}

export function getSheetSizeMm(size: SheetDef["size"], orientation: SheetDef["orientation"]) {
  return paperSizeMm(size, orientation, "A1");
}

/** New sheets follow the region profile's paper (US → Arch D, UK/EU → A1, …); A1 when the profile has none. */
export function defaultSheetSize(): SheetDef["size"] {
  try { return normalizePaperId(region.getResolved().paper, "A1"); } catch { return "A1"; }
}

/** Change a sheet's paper size and/or orientation (undo-friendly: returns the previous values). */
export function setSheetPaper(id: string, size: SheetDef["size"], orientation?: SheetDef["orientation"]): { size: SheetDef["size"]; orientation: SheetDef["orientation"] } | null {
  const sh = sheets.find((x) => x.id === id);
  if (!sh) return null;
  const prev = { size: sh.size, orientation: sh.orientation };
  sh.size = normalizePaperId(size, sh.size);
  if (orientation) sh.orientation = orientation;
  sh.updatedAt = Date.now();
  notify();
  return prev;
}

// Sheet SVG composition & SVG export live in `./sheet-composer` (WYSIWYG:
// real viewport scenes + titleblock fields + furniture). sheets.ts stays the
// pure store — importing the composer here would create a module cycle.

export function loadSheetsFromProject(list: SheetDef[] | undefined, tbs?: TitleblockDef[]) {
  sheets = list ? list.map((s) => ({ ...s })) : [];
  titleblocks = tbs ? tbs.map((t) => ({ ...t })) : [];
  if (!titleblocks.length) ensureDefaultTitleblock();
  notify();
}

/** Replace one sheet in place after an undo/redo snapshot swap. */
export function replaceSheet(id: string, snapshot: SheetDef): boolean {
  const i = sheets.findIndex((s) => s.id === id);
  if (i < 0) return false;
  sheets[i] = cloneSheet(snapshot);
  notify();
  return true;
}

/** Replace a titleblock in place after an undo/redo snapshot swap. */
export function replaceTitleblockSnapshot(id: string, snapshot: TitleblockDef): boolean {
  const i = titleblocks.findIndex((t) => t.id === id);
  if (i < 0) return false;
  titleblocks[i] = cloneTitleblock(snapshot);
  notify();
  return true;
}

/** Insert a previously deleted sheet snapshot (undo of deleteSheet). */
export function insertSheet(snapshot: SheetDef): void {
  sheets.push(cloneSheet(snapshot));
  notify();
}

export function getSheetsForSave(): { sheets: SheetDef[]; titleblocks: TitleblockDef[] } {
  return { sheets: sheets.map((s) => ({ ...s })), titleblocks: titleblocks.map((t) => ({ ...t })) };
}

export function createDefaultSheetSet() {
  ensureDefaultTitleblock();
  if (sheets.length) return;
  createSheet({ number: "A-001", name: "Cover / General Notes", size: "A1" });
  createSheet({ number: "A-101", name: "Floor Plan — Level 1", size: "A1" });
  createSheet({ number: "A-201", name: "Elevations", size: "A1" });
  createSheet({ number: "A-301", name: "Sections", size: "A1" });
  createSheet({ number: "S-101", name: "Structural Plan", size: "A1" });
  createSheet({ number: "M-101", name: "MEP Plan", size: "A1" });
}
