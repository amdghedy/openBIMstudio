/**
 * Sheet and drawing-set QA for 2D documentation.
 *
 * Pure validation only: it reports sheet metadata, viewport geometry, view links,
 * scale strings and layout overlaps without mutating the user's document.
 */
export interface SheetQaViewport {
  id: string;
  viewId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: string;
  title?: string;
}
export interface SheetQaSheet {
  id: string;
  number: string;
  name: string;
  size: string;
  orientation: string;
  viewports: readonly SheetQaViewport[];
}
export interface SheetQaView {
  id: string;
  name: string;
  scale?: number;
}
export interface SheetQaDiagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  sheetId?: string;
  viewportId?: string;
  relatedId?: string;
}
export interface SheetQaSnapshot {
  sheets: readonly SheetQaSheet[];
  views: readonly SheetQaView[];
  sheetSizesMm: Readonly<Record<string, { w: number; h: number }>>;
}
const EPS = 0.01;
const validSizes = new Set(["A0","A1","A2","A3","A4","ANSI-D","ANSI-E","Arch-D","Arch-E"]);

export function validateDocumentationSet(snapshot: SheetQaSnapshot): SheetQaDiagnostic[] {
  const out: SheetQaDiagnostic[] = [];
  const add = (code: string, severity: "error" | "warning", message: string, sheetId?: string, viewportId?: string, relatedId?: string) =>
    out.push({ code, severity, message, sheetId, viewportId, relatedId });
  const sheetIds = new Set<string>();
  const sheetNumbers = new Map<string, string>();
  const viewIds = new Set(snapshot.views.map(v => v.id));
  for (const sheet of snapshot.sheets) {
    if (!sheet.id?.trim()) add("SHEET_ID_MISSING","error","Sheet is missing a stable ID.");
    if (sheetIds.has(sheet.id)) add("SHEET_ID_DUPLICATE","error","Sheet ID is duplicated.",sheet.id);
    sheetIds.add(sheet.id);
    if (!sheet.number?.trim()) add("SHEET_NUMBER_MISSING","error","Sheet number is required.",sheet.id);
    const prior = sheetNumbers.get(sheet.number);
    if (prior) add("SHEET_NUMBER_DUPLICATE","error",`Sheet number "${sheet.number}" is also used by sheet "${prior}".`,sheet.id,undefined,prior);
    else if (sheet.number?.trim()) sheetNumbers.set(sheet.number,sheet.id);
    if (!sheet.name?.trim()) add("SHEET_NAME_MISSING","warning","Sheet name is empty.",sheet.id);
    if (!validSizes.has(sheet.size)) add("SHEET_SIZE_INVALID","error",`Unsupported sheet size "${sheet.size}".`,sheet.id);
    const size = snapshot.sheetSizesMm[sheet.id];
    if (!size || !Number.isFinite(size.w) || !Number.isFinite(size.h) || size.w <= 0 || size.h <= 0) {
      add("SHEET_SIZE_GEOMETRY_INVALID","error","Sheet must resolve to positive finite width and height in millimetres.",sheet.id);
      continue;
    }
    const viewportIds = new Set<string>();
    const validViewports: SheetQaViewport[] = [];
    for (const vp of sheet.viewports ?? []) {
      if (!vp.id?.trim()) add("VIEWPORT_ID_MISSING","error","Viewport is missing a stable ID.",sheet.id);
      if (viewportIds.has(vp.id)) add("VIEWPORT_ID_DUPLICATE","error","Viewport ID is duplicated on this sheet.",sheet.id,vp.id);
      viewportIds.add(vp.id);
      if (![vp.x,vp.y,vp.width,vp.height].every(Number.isFinite)) {
        add("VIEWPORT_GEOMETRY_NON_FINITE","error","Viewport position and dimensions must be finite millimetres.",sheet.id,vp.id);
        continue;
      }
      if (vp.width <= 0 || vp.height <= 0) {
        add("VIEWPORT_SIZE_NOT_POSITIVE","error","Viewport width and height must be greater than zero.",sheet.id,vp.id);
        continue;
      }
      if (vp.x < -EPS || vp.y < -EPS || vp.x + vp.width > size.w + EPS || vp.y + vp.height > size.h + EPS) {
        add("VIEWPORT_OUTSIDE_SHEET","warning","Viewport extends beyond the physical sheet bounds.",sheet.id,vp.id);
      }
      if (!vp.viewId?.trim() || !viewIds.has(vp.viewId)) {
        add("VIEWPORT_VIEW_MISSING","error",`Viewport references missing view "${vp.viewId || "(empty)"}".`,sheet.id,vp.id,vp.viewId);
      }
      const match = /^\s*1\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(vp.scale);
      if (!match || Number(match[1]) <= 0) {
        add("VIEWPORT_SCALE_INVALID","error",`Scale "${vp.scale}" must use a positive ratio such as 1:100.`,sheet.id,vp.id);
      }
      validViewports.push(vp);
    }
    for (let i=0;i<validViewports.length;i++) {
      const a=validViewports[i];
      for (let j=i+1;j<validViewports.length;j++) {
        const b=validViewports[j];
        const overlapW=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x);
        const overlapH=Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y);
        if (overlapW > EPS && overlapH > EPS) {
          add("VIEWPORT_OVERLAP","warning",`Viewport overlaps another viewport "${b.id}".`,sheet.id,a.id,b.id);
        }
      }
    }
  }
  return out;
}

export function summarizeDocumentationDiagnostics(diagnostics: readonly SheetQaDiagnostic[]) {
  return {
    total: diagnostics.length,
    errors: diagnostics.filter(d => d.severity === "error").length,
    warnings: diagnostics.filter(d => d.severity === "warning").length,
  };
}
