/**
 * Sheets & Drawing Production — professional documentation engine.
 *
 * Places plan views, 3D views and schedules onto titleblocked sheets.
 * Designed to compete with BIM sheets / Bentley drawing production.
 */
import type { SheetDef, SheetViewport, TitleblockDef } from "../projects/types";
export type { SheetDef, SheetViewport, TitleblockDef };

const uid = () =>
  (crypto as any).randomUUID?.() ?? `sh-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const SHEET_SIZES_MM: Record<SheetDef["size"], { w: number; h: number }> = {
  A0: { w: 1189, h: 841 },
  A1: { w: 841, h: 594 },
  A2: { w: 594, h: 420 },
  A3: { w: 420, h: 297 },
  A4: { w: 297, h: 210 },
  "ANSI-D": { w: 864, h: 559 },
  "ANSI-E": { w: 1118, h: 864 },
  "Arch-D": { w: 914, h: 610 },
  "Arch-E": { w: 1219, h: 914 },
};

let sheets: SheetDef[] = [];
let titleblocks: TitleblockDef[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
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
    size: opts?.size ?? "A1",
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
  const base = SHEET_SIZES_MM[size] ?? SHEET_SIZES_MM.A1;
  if (orientation === "portrait") return { w: Math.min(base.w, base.h), h: Math.max(base.w, base.h) };
  return { w: Math.max(base.w, base.h), h: Math.min(base.w, base.h) };
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
