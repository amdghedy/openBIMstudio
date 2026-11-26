/**
 * Family Creator, "Drawing to parts" section (early prototype).
 *
 * A picture of a drawing with a side view and an end view goes in. One real length is entered by
 * the person. The parts come from the picture's line work (see creator/elevation.ts). Each part says
 * whether its size was read from the picture or assumed, and the person confirms which parts go
 * into the IFC. Dimension text in the picture is not read: width and height are entered only to
 * check the picture's scale. Not added to the family library, and not tested in Revit.
 */
import { t } from "../core/i18n";
import * as THREE from "three";
import { createPreview3D, type Preview3D } from "./family-creator-preview";
import { reconstructElevations, detectViews, toResolvedParts, partsBounds, type Reconstruction, type PartOut } from "../modules/families/creator/elevation";
import { writeIfc2x3 } from "../modules/families/creator/ifc2x3";
import { checkIfcStructure } from "../modules/families/creator/pipeline";
import { renderThreeViews } from "../modules/families/creator/preview-svg";

interface State {
  fileName: string; imgUrl: string; rgba: { data: Uint8ClampedArray; width: number; height: number } | null;
  name: string; length: string; width: string; height: string; pipe: string;
  sideFace: "+" | "-" | "both"; endFace: "start" | "end"; calEnd: "side" | "height"; mode: "crop" | "side" | "end"; vb: { side: Fb | null; end: Fb | null };
  crop: { l: string; r: string; t: string; b: string }; cropUrl: string; confirmed: boolean; views: { widthsPx: number[]; side: number; end: number } | null; sideView: string; endView: string;
  busy: boolean; stale: boolean; error: string; notice: string; result: Reconstruction | null; off: Set<number>;
}
interface Fb { x0: number; y0: number; x1: number; y1: number }
const S: State = { fileName: "", imgUrl: "", rgba: null, name: "", length: "", width: "", height: "", pipe: "", sideFace: "+", endFace: "start", calEnd: "side", mode: "crop", vb: { side: null, end: null }, crop: { l: "", r: "", t: "", b: "" }, cropUrl: "", confirmed: false, views: null, sideView: "auto", endView: "auto", busy: false, stale: false, error: "", notice: "", result: null, off: new Set() };

const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
const num = (v: string): number | null => { const n = Number(v.trim().replace(",", ".")); return v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null; };
let preview: Preview3D | null = null, previewTried = false;
const COLOR: Record<string, string> = { body: "#60a5fa", panel: "#3b82f6", grille: "#f59e0b", pipe: "#a3a3a3", detail: "#e879f9" };

async function decode(file: File) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 5000 / bmp.width), w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true })!; g.drawImage(bmp, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h);
  if (S.imgUrl) URL.revokeObjectURL(S.imgUrl);
  S.imgUrl = URL.createObjectURL(file); S.fileName = file.name;
  S.rgba = { data: d.data, width: w, height: h };
}

const pct = (v: string) => { const n = Number(v.trim().replace(",", ".")); return v.trim() !== "" && Number.isFinite(n) ? Math.min(90, Math.max(0, n)) : 0; };
/** The part of the picture the person chose to use. No crop returns the whole picture. */
function effective(): { rgba: NonNullable<State["rgba"]>; url: string } | null {
  const full = S.rgba; if (!full) return null;
  const l = pct(S.crop.l), r = pct(S.crop.r), tp = pct(S.crop.t), b = pct(S.crop.b);
  if (!l && !r && !tp && !b) return { rgba: full, url: S.imgUrl };
  const x0 = Math.round(full.width * l / 100), x1 = Math.round(full.width * (1 - r / 100)), y0 = Math.round(full.height * tp / 100), y1 = Math.round(full.height * (1 - b / 100));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0), out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(full.data.subarray(((y + y0) * full.width + x0) * 4, ((y + y0) * full.width + x0 + w) * 4), y * w * 4);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d")!.putImageData(new ImageData(out, w, h), 0, 0);
  return { rgba: { data: out, width: w, height: h }, url: c.toDataURL("image/png") };
}
/** The drawn view boxes, converted from fractions of the whole picture to fractions of the cropped picture. Both or none. */
function viewBoxOpts(): { sideBox?: Fb; endBox?: Fb } {
  if (!S.vb.side || !S.vb.end) return {};
  const l = pct(S.crop.l) / 100, r = pct(S.crop.r) / 100, tp = pct(S.crop.t) / 100, b = pct(S.crop.b) / 100, w = 1 - l - r, h = 1 - tp - b;
  const cv = (q: Fb): Fb => ({ x0: Math.min(1, Math.max(0, (q.x0 - l) / w)), x1: Math.min(1, Math.max(0, (q.x1 - l) / w)), y0: Math.min(1, Math.max(0, (q.y0 - tp) / h)), y1: Math.min(1, Math.max(0, (q.y1 - tp) / h)) });
  return { sideBox: cv(S.vb.side), endBox: cv(S.vb.end) };
}
function refreshViews() { const e = effective(); S.views = null; if (e) { try { const dv = detectViews(e.rgba); S.views = { widthsPx: dv.widthsPx, side: dv.side, end: dv.end }; } catch { S.views = null; } } S.sideView = "auto"; S.endView = "auto"; }

function sizeOf(p: PartOut): string {
  const a = Math.round(p.x1 - p.x0), b = Math.round(p.y1 - p.y0), c = Math.round(p.z1 - p.z0);
  return `${a} \u00d7 ${b} \u00d7 ${c}`;
}

function tags(p: PartOut): string {
  const parts: string[] = [];
  parts.push(`${t("familyCreator.drawing.tagSize")}: ${t(p.size === "extracted" ? "familyCreator.drawing.fromPicture" : p.size === "entered" ? "familyCreator.drawing.entered" : "familyCreator.drawing.assumed")}`);
  if (p.thickness) parts.push(`${t("familyCreator.drawing.tagThickness")}: ${t("familyCreator.drawing.assumed")}`);
  if (p.placement) parts.push(`${t("familyCreator.drawing.tagPlacement")}: ${t("familyCreator.drawing.face." + ({ "+width": "plus", "-width": "minus", "start end": "start", "far end": "end" } as Record<string, string>)[p.placement.face])} (${t("familyCreator.drawing.assumed")})`);
  else if (p.depth === "assumed") parts.push(`${t("familyCreator.drawing.tagDepth")}: ${t("familyCreator.drawing.assumed")}`);
  return parts.join("; ");
}

function resultHtml(r: Reconstruction): string {
  const kept = r.parts.filter((_, i) => !S.off.has(i));
  const dimRows = r.dimensions.map((d) => {
    const label = t("familyCreator.drawing.dim." + (d.name === "pipe diameter" ? "pipe" : d.name));
    const built = d.modelMm !== undefined && d.modelMm > 0 ? t("familyCreator.drawing.built", { mm: Math.round(d.modelMm) }) : "";
    if (d.state === "entered") return `<tr><td>${esc(label)}</td><td><bdi>${Math.round(d.mm)} mm</bdi></td><td>${esc(t("familyCreator.drawing.entered"))}${built ? "; " + esc(built) : ""}</td></tr>`;
    const stated = Number.isFinite(d.mm) ? `<bdi>${Math.round(d.mm)} mm</bdi>` : esc(t("familyCreator.drawing.notEntered"));
    return `<tr><td>${esc(label)}</td><td>${stated}</td><td>${esc(t("familyCreator.drawing.checked", { measured: Math.round(d.measuredMm ?? 0) }))}${built ? "; " + esc(built) : ""}</td></tr>`;
  }).join("");
  const boxes = r.parts.map((p, i) => p.sheetPx ? `<rect data-dpart="${i}" x="${p.sheetPx.x0}" y="${p.sheetPx.y0}" width="${p.sheetPx.x1 - p.sheetPx.x0 + 1}" height="${p.sheetPx.y1 - p.sheetPx.y0 + 1}" fill="${COLOR[p.kind]}" fill-opacity="${S.off.has(i) ? 0 : 0.18}" stroke="${COLOR[p.kind]}" stroke-width="${Math.max(1, r.sheet.w / 600)}"${S.off.has(i) ? ' stroke-dasharray="4 3" stroke-opacity="0.5"' : ""} style="cursor:pointer"><title>${esc(p.name)}</title></rect>` : "").join("");
  const list = r.parts.map((p, i) => `<label class="obs-fc-part" data-fc-drow="${i}" style="display:flex;align-items:flex-start;gap:4px;margin:2px 0"><input type="checkbox" data-dpart-use="${i}"${S.off.has(i) ? "" : " checked"}><span><b><bdi>${esc(p.name)}</bdi></b> <span class="obs-fc-detail"><bdi>${esc(sizeOf(p))}</bdi> mm \u00b7 ${esc(tags(p))}${p.role === "door-like" ? " \u00b7 " + esc(t("familyCreator.drawing.doorLike")) : ""}${p.candidate ? " \u00b7 " + esc(t("familyCreator.drawing.candidate")) : ""}</span></span></label>`).join("");
  const rp = toResolvedParts(kept), b = partsBounds(kept);
  const views = kept.length ? renderThreeViews(rp, { w: (b.x1 - b.x0) / 1000, d: (b.y1 - b.y0) / 1000, h: (b.z1 - b.z0) / 1000 }, { front: t("familyCreator.drawing.viewLength"), side: t("familyCreator.drawing.viewEnd"), top: t("familyCreator.drawing.viewTop") }) : "";
  return `
    <div class="obs-fc-sec" data-fc="drawing-dims"><div class="obs-fc-h">${esc(t("familyCreator.drawing.dimsTitle"))}</div><table class="obs-fc-tbl">${dimRows}</table>
      <div class="obs-fc-detail">${esc(t("familyCreator.drawing.dimsNote"))}</div>
      <div class="obs-fc-detail" data-fc="drawing-dims-why">${esc(t("familyCreator.drawing.dimsWhy"))}</div></div>
    ${r.quality.notes.length ? `<div class="obs-fc-sec" data-fc="drawing-quality" role="alert" style="color:#f87171"><b>${esc(t("familyCreator.drawing.qualityTitle"))}</b>${r.quality.notes.map((w) => `<div>${esc(w)}</div>`).join("")}<div>${esc(t("familyCreator.drawing.qualityHelp"))}</div></div>` : ""}
    ${r.warnings.length ? `<div class="obs-fc-sec" data-fc="drawing-warnings" style="color:#f59e0b">${r.warnings.map((w) => `<div>${esc(w)}</div>`).join("")}</div>` : ""}
    <div class="obs-fc-sec" data-fc="drawing-overlay"><div class="obs-fc-h">${esc(t("familyCreator.drawing.overlayTitle"))}</div>
      <div style="position:relative;background:#fff;border-radius:4px"><img src="${esc(S.cropUrl || S.imgUrl)}" alt="" style="display:block;width:100%;height:auto"><svg viewBox="0 0 ${r.sheet.w} ${r.sheet.h}" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%">${boxes}</svg></div>
      <div class="obs-fc-detail">${esc(t("familyCreator.drawing.overlayHelp"))}</div></div>
    <div class="obs-fc-sec" data-fc="drawing-parts"><div class="obs-fc-h">${esc(t(S.confirmed ? "familyCreator.drawing.partsConfirmed" : "familyCreator.drawing.partsSelected", { kept: kept.length, n: r.parts.length }))}</div>
      <div class="obs-fc-detail" data-fc="drawing-selected-note">${esc(t(S.confirmed ? "familyCreator.drawing.confirmedNote" : "familyCreator.drawing.selectedNote"))}</div>
      <button type="button" class="obs-fc-btn" data-dact="doors">${esc(t("familyCreator.drawing.onlyDoors"))}</button> <button type="button" class="obs-fc-btn" data-dact="all">${esc(t("familyCreator.drawing.selectAll"))}</button>${list}</div>
    <div class="obs-fc-sec" data-fc="drawing-3d"><div class="obs-fc-h">${esc(t("familyCreator.drawing.preview3d"))}</div>${preview ? '<div data-fc-slot="drawing-preview3d"></div>' : `<div class="obs-fc-detail" data-fc="drawing-no3d">${esc(t("familyCreator.preview3dUnavailable"))}</div>`}<div class="obs-fc-detail">${esc(t("familyCreator.drawing.preview3dHelp"))}</div></div>
    <div class="obs-fc-sec" data-fc="drawing-views"><div class="obs-fc-h">${esc(t(S.confirmed ? "familyCreator.drawing.viewsConfirmed" : "familyCreator.drawing.viewsSelected"))}</div>${views}</div>
    <div class="obs-fc-sec" data-fc="drawing-unknown"><div class="obs-fc-h">${esc(t("familyCreator.drawing.unknownTitle"))}</div>${r.unknowns.map((u) => `<div class="obs-fc-detail">\u2022 ${esc(u)}</div>`).join("")}</div>
    <div class="obs-fc-sec"><button type="button" class="obs-fc-btn" data-dact="confirm"${kept.length && !S.confirmed ? "" : " disabled"}>${esc(t(S.confirmed ? "familyCreator.drawing.confirmedBtn" : "familyCreator.drawing.confirmBtn"))}</button> <button type="button" class="obs-fc-btn" data-dact="ifc"${kept.length && S.confirmed ? "" : " disabled"}>${esc(t("familyCreator.drawing.export"))}</button>
      <div class="obs-fc-detail" data-fc="drawing-export-note">${esc(t("familyCreator.drawing.exportNote"))}</div></div>`;
}

function cropFields(): string {
  const c = (k: "l" | "r" | "t" | "b", key: string) => `<label class="obs-fc-detail" style="display:inline-block;margin-inline-end:6px">${esc(t("familyCreator.drawing." + key))}<input class="obs-fc-in" style="width:4.5em" data-dcrop="${k}" inputmode="decimal" dir="ltr" value="${esc(S.crop[k])}"></label>`;
  const L = pct(S.crop.l), R = pct(S.crop.r), T = pct(S.crop.t), B = pct(S.crop.b);
  const picker = `<div data-fc="drawing-crop-pick" dir="ltr" style="position:relative;margin:4px 0;touch-action:none;cursor:crosshair;user-select:none;background:#fff;border-radius:4px"><img src="${esc(S.imgUrl)}" alt="" draggable="false" style="display:block;width:100%;height:auto;pointer-events:none"><div data-fc="drawing-crop-box" style="position:absolute;left:${L}%;right:${R}%;top:${T}%;bottom:${B}%;border:2px solid #22d3ee;background:rgba(34,211,238,.12);pointer-events:none"></div>${S.vb.side ? `<div data-fc="drawing-vbox-side" style="position:absolute;left:${S.vb.side.x0 * 100}%;right:${(1 - S.vb.side.x1) * 100}%;top:${S.vb.side.y0 * 100}%;bottom:${(1 - S.vb.side.y1) * 100}%;border:2px dashed #f59e0b;pointer-events:none"></div>` : ""}${S.vb.end ? `<div data-fc="drawing-vbox-end" style="position:absolute;left:${S.vb.end.x0 * 100}%;right:${(1 - S.vb.end.x1) * 100}%;top:${S.vb.end.y0 * 100}%;bottom:${(1 - S.vb.end.y1) * 100}%;border:2px dashed #34d399;pointer-events:none"></div>` : ""}</div><div class="obs-fc-detail">${esc(t("familyCreator.drawing.cropDrag"))}</div><label class="obs-fc-detail" style="display:block">${esc(t("familyCreator.drawing.dragMode"))}<select class="obs-fc-in" data-dfield="mode"><option value="crop"${S.mode === "crop" ? " selected" : ""}>${esc(t("familyCreator.drawing.modeCrop"))}</option><option value="side"${S.mode === "side" ? " selected" : ""}>${esc(t("familyCreator.drawing.modeSide"))}</option><option value="end"${S.mode === "end" ? " selected" : ""}>${esc(t("familyCreator.drawing.modeEnd"))}</option></select></label><div class="obs-fc-detail" data-fc="drawing-vb-state">${esc(t(S.vb.side && S.vb.end ? "familyCreator.drawing.vbBoth" : S.vb.side || S.vb.end ? "familyCreator.drawing.vbOne" : "familyCreator.drawing.vbNone"))} <button type="button" class="obs-fc-btn" data-dcrop-reset>${esc(t("familyCreator.drawing.cropReset"))}</button> <button type="button" class="obs-fc-btn" data-dvb-reset>${esc(t("familyCreator.drawing.vbReset"))}</button></div>`;
  return `<div data-fc="drawing-crop"><div class="obs-fc-detail">${esc(t("familyCreator.drawing.cropHelp"))}</div>${picker}${c("l", "cropL")}${c("r", "cropR")}${c("t", "cropT")}${c("b", "cropB")}</div>`;
}

function viewPickers(): string {
  const v = S.views!;
  const opts = (cur: string, def: number) => `<option value="auto"${cur === "auto" ? " selected" : ""}>${esc(t("familyCreator.drawing.viewAuto", { n: def + 1 }))}</option>` + v.widthsPx.map((w, i) => `<option value="${i}"${cur === String(i) ? " selected" : ""}>${esc(t("familyCreator.drawing.viewOpt", { n: i + 1, w }))}</option>`).join("");
  return `<div data-fc="drawing-views-pick"><div class="obs-fc-detail">${esc(t("familyCreator.drawing.viewsFound", { n: v.widthsPx.length }))}</div>
    <label class="obs-fc-detail" style="display:block">${esc(t("familyCreator.drawing.sideViewLabel"))}<select class="obs-fc-in" data-dfield="sideView">${opts(S.sideView, v.side)}</select></label>
    <label class="obs-fc-detail" style="display:block">${esc(t("familyCreator.drawing.endViewLabel"))}<select class="obs-fc-in" data-dfield="endView">${opts(S.endView, v.end)}</select></label></div>`;
}

function buildGroup(parts: PartOut[]): THREE.Group {
  // Picture mm: x length, y width, z height. Preview: X length, Y up, Z across, metres.
  const g = new THREE.Group();
  const col: Record<string, number> = { body: 0x60a5fa, panel: 0x3b82f6, grille: 0xf59e0b, pipe: 0xa3a3a3, detail: 0xe879f9 };
  for (const p of parts) {
    const dx = (p.x1 - p.x0) / 1000, dy = (p.z1 - p.z0) / 1000, dz = (p.y1 - p.y0) / 1000;
    const geo = p.kind === "pipe" ? new THREE.CylinderGeometry(Math.min(dx, dz) / 2, Math.min(dx, dz) / 2, dy, 24) : new THREE.BoxGeometry(dx, dy, dz);
    const m = new THREE.Mesh(geo);
    m.position.set((p.x0 + p.x1) / 2000, (p.z0 + p.z1) / 2000, (p.y0 + p.y1) / 2000);
    m.userData.fcColor = col[p.kind] ?? 0x94a3b8; m.name = p.name;
    g.add(m);
  }
  return g;
}

function updatePreview(root: HTMLElement) {
  if (!S.result) return;
  if (!previewTried) { previewTried = true; preview = createPreview3D(340, 250); if (preview) redraw(root); return; }
  if (!preview) return;
  const kept = S.result.parts.filter((_, i) => !S.off.has(i));
  preview.setObject(kept.length ? buildGroup(kept) : null, true);
  root.querySelector<HTMLElement>('[data-fc-slot="drawing-preview3d"]')?.appendChild(preview.el);
}

export function drawingHtml(): string {
  const f = (key: string, field: "length" | "width" | "height" | "pipe") => `<label class="obs-fc-detail" style="display:block">${esc(t("familyCreator.drawing." + key))}<input class="obs-fc-in" data-dfield="${field}" inputmode="decimal" dir="ltr" value="${esc(S[field])}"></label>`;
  const sel = (field: "sideFace" | "endFace", opts: Array<[string, string]>) => `<select class="obs-fc-in" data-dfield="${field}">${opts.map(([v, k]) => `<option value="${v}"${S[field] === v ? " selected" : ""}>${esc(t(k))}</option>`).join("")}</select>`;
  return `<div class="obs-fc-sec" data-fc="drawing"><div class="obs-fc-h">${esc(t("familyCreator.drawing.title"))}</div>
    <div class="obs-fc-detail">${esc(t("familyCreator.drawing.intro"))}</div>
    <div style="display:flex;gap:6px;align-items:center;margin:4px 0"><label class="obs-fc-btn" style="cursor:pointer">${esc(t("familyCreator.drawing.choose"))}<input type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" data-dfile style="display:none"></label><span class="obs-fc-detail" data-fc="drawing-file"><bdi>${esc(S.fileName)}</bdi></span></div>
    ${f("lengthLabel", "length")}${f("widthLabel", "width")}${f("heightLabel", "height")}${f("pipeLabel", "pipe")}
    ${S.rgba ? cropFields() : ""}${S.views ? viewPickers() : ""}
    <label class="obs-fc-detail" style="display:block">${esc(t("familyCreator.drawing.sideFace"))}${sel("sideFace", [["+", "familyCreator.drawing.faceOpt.plus"], ["-", "familyCreator.drawing.faceOpt.minus"], ["both", "familyCreator.drawing.faceOpt.both"]])}</label>
    <label class="obs-fc-detail" style="display:block">${esc(t("familyCreator.drawing.endFace"))}${sel("endFace", [["start", "familyCreator.drawing.endOpt.start"], ["end", "familyCreator.drawing.endOpt.end"]])}</label>
    <label class="obs-fc-detail" style="display:block">${esc(t("familyCreator.drawing.calEnd"))}<select class="obs-fc-in" data-dfield="calEnd"><option value="side"${S.calEnd === "side" ? " selected" : ""}>${esc(t("familyCreator.drawing.calOpt.side"))}</option><option value="height"${S.calEnd === "height" ? " selected" : ""}>${esc(t("familyCreator.drawing.calOpt.height"))}</option></select></label>
    <button type="button" class="obs-fc-btn" data-dact="read" style="margin-top:6px"${S.busy ? " disabled" : ""}>${esc(t("familyCreator.drawing.read"))}</button>
    ${S.busy ? `<div class="obs-fc-detail" data-fc="drawing-busy">${esc(t("familyCreator.drawing.reading"))}</div>` : ""}
    ${S.error ? `<div class="obs-fc-detail" data-fc="drawing-error" style="color:#f87171">${esc(S.error)}</div>` : ""}
    ${S.notice ? `<div class="obs-fc-detail" data-fc="drawing-notice" style="color:#22c55e">${esc(S.notice)}</div>` : ""}
    <div class="obs-fc-detail" data-fc="drawing-stale" style="color:#f59e0b"${S.stale ? "" : " hidden"}>${esc(t("familyCreator.drawing.stale"))}</div>
    ${S.result ? resultHtml(S.result) : ""}</div>`;
}

function redraw(root: HTMLElement) {
  const host = root.querySelector<HTMLElement>('[data-fc="drawing"]'); if (!host) return;
  const tmp = document.createElement("div"); tmp.innerHTML = drawingHtml();
  host.replaceWith(tmp.firstElementChild!);
  bindDrawing(root);
  updatePreview(root);
}

function read(root: HTMLElement) {
  S.error = ""; S.notice = ""; S.stale = false;
  const len = num(S.length);
  if (!S.rgba) { S.error = t("familyCreator.drawing.errNoFile"); return redraw(root); }
  if (!len) { S.error = t("familyCreator.drawing.errNoLength"); return redraw(root); }
  S.busy = true; S.result = null; const eff = effective()!; S.cropUrl = eff.url === S.imgUrl ? "" : eff.url; S.off = new Set(); S.confirmed = false; redraw(root);
  // The work is synchronous; yield once so the "reading" state is painted before it starts.
  setTimeout(() => {
    try {
      S.result = reconstructElevations(eff.rgba, { lengthMm: len, widthMm: num(S.width) ?? undefined, heightMm: num(S.height) ?? undefined, pipeDiameterMm: num(S.pipe) ?? undefined, sideFace: S.sideFace, endFace: S.endFace, calibrateEnd: S.calEnd === "height", ...viewBoxOpts(), ...(S.sideView !== "auto" ? { sideView: Number(S.sideView) } : {}), ...(S.endView !== "auto" ? { endView: Number(S.endView) } : {}) });
      S.off = new Set(); S.result.parts.forEach((q, k) => { if (q.candidate) S.off.add(k); });
    } catch (e) { S.error = t("familyCreator.drawing.errFailed", { message: (e as Error).message }); }
    S.busy = false; redraw(root);
  }, 30);
}

function exportIfc(root: HTMLElement) {
  const r = S.result; if (!r) return;
  const kept = r.parts.filter((_, i) => !S.off.has(i));
  if (!kept.length || !S.confirmed) return;
  const name = (S.name.trim() || S.fileName.replace(/\.[^.]+$/, "") || "Drawing").replace(/[^A-Za-z0-9._ -]+/g, "_");
  const out = writeIfc2x3({ name, entity: "IfcBuildingElementProxy", parts: toResolvedParts(kept), lengthParams: {} });
  const bad = checkIfcStructure(out.text, kept.length);
  if (bad.length) { S.error = t("familyCreator.drawing.errExport", { message: bad.join("; ") }); S.notice = ""; return redraw(root); }
  const url = URL.createObjectURL(new Blob([out.text], { type: "application/octet-stream" }));
  const link = document.createElement("a"); link.href = url; link.download = `${name.replace(/ /g, "_")}.ifc`;
  document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  S.error = ""; S.notice = t("familyCreator.drawing.saved", { file: link.download, n: kept.length });
  redraw(root);
}

export function bindDrawing(root: HTMLElement) {
  const slot = root.querySelector<HTMLElement>('[data-fc-slot="drawing-preview3d"]');
  if (slot && preview) slot.appendChild(preview.el);
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-dfield]").forEach((el) => {
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      (S as unknown as Record<string, string>)[el.dataset.dfield as string] = el.value;
      // Placement and size changes make the shown parts stale; the person reads again.
      if (S.result) { S.stale = true; const n = root.querySelector<HTMLElement>('[data-fc="drawing-stale"]'); if (n) n.hidden = false; }
    });
  });
  root.querySelectorAll<HTMLInputElement>("[data-dcrop]").forEach((el) => el.addEventListener("change", () => {
    S.crop[el.dataset.dcrop as "l" | "r" | "t" | "b"] = el.value; S.vb = { side: null, end: null }; S.result = null; S.confirmed = false; S.off = new Set(); S.notice = ""; refreshViews(); redraw(root);
  }));
  const pick = root.querySelector<HTMLElement>('[data-fc="drawing-crop-pick"]');
  if (pick) {
    let a: { x: number; y: number } | null = null;
    const at = (ev: PointerEvent) => { const r = pick.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) }; };
    const show = (b: { x: number; y: number }) => {
      const box = pick.querySelector<HTMLElement>('[data-fc="drawing-crop-box"]'); if (!a || !box) return;
      box.style.left = Math.min(a.x, b.x) * 100 + "%"; box.style.right = (1 - Math.max(a.x, b.x)) * 100 + "%";
      box.style.top = Math.min(a.y, b.y) * 100 + "%"; box.style.bottom = (1 - Math.max(a.y, b.y)) * 100 + "%";
    };
    pick.addEventListener("pointerdown", (ev) => { a = at(ev); pick.setPointerCapture(ev.pointerId); show(a); });
    pick.addEventListener("pointermove", (ev) => { if (a) show(at(ev)); });
    pick.addEventListener("pointerup", (ev) => {
      if (!a) return; const b = at(ev), x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y); a = null;
      // A click or a sliver is not a crop: keep the previous one. The side fields cap at 90%, so keep >= 10% of each axis.
      if (x1 - x0 < 0.1 || y1 - y0 < 0.1) return redraw(root);
      if (S.mode !== "crop") { S.vb[S.mode] = { x0, y0, x1, y1 }; S.result = null; S.confirmed = false; S.off = new Set(); S.notice = ""; redraw(root); return; }
      const f = (v: number) => String(Math.round(v * 1000) / 10);
      S.crop = { l: f(x0), r: f(1 - x1), t: f(y0), b: f(1 - y1) }; S.vb = { side: null, end: null };
      S.result = null; S.confirmed = false; S.off = new Set(); S.notice = ""; refreshViews(); redraw(root);
    });
    pick.addEventListener("pointercancel", () => { a = null; redraw(root); });
  }
  root.querySelector<HTMLElement>("[data-dcrop-reset]")?.addEventListener("click", () => {
    S.crop = { l: "", r: "", t: "", b: "" }; S.vb = { side: null, end: null }; S.result = null; S.confirmed = false; S.off = new Set(); S.notice = ""; refreshViews(); redraw(root);
  });
  root.querySelector<HTMLElement>("[data-dvb-reset]")?.addEventListener("click", () => { S.vb = { side: null, end: null }; S.result = null; S.confirmed = false; S.off = new Set(); S.notice = ""; redraw(root); });
  root.querySelector<HTMLInputElement>("[data-dfile]")?.addEventListener("change", async (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0]; if (!f) return;
    try { await decode(f); S.result = null; S.error = ""; S.notice = ""; S.confirmed = false; S.length = ""; S.width = ""; S.height = ""; S.pipe = ""; S.crop = { l: "", r: "", t: "", b: "" }; S.vb = { side: null, end: null }; S.cropUrl = ""; S.off = new Set(); refreshViews(); } catch (e) { S.error = t("familyCreator.drawing.errFailed", { message: (e as Error).message }); }
    redraw(root);
  });
  root.querySelectorAll<HTMLElement>("[data-dact]").forEach((el) => el.addEventListener("click", () => {
    const a = el.dataset.dact;
    if (a === "read") read(root); else if (a === "ifc") exportIfc(root);
    else if (a === "confirm") { S.confirmed = true; S.notice = ""; redraw(root); }
    else if (a === "doors" && S.result) { S.result.parts.forEach((p, i) => { if (p.kind === "panel" && p.role !== "door-like") S.off.add(i); }); S.confirmed = false; S.notice = ""; redraw(root); }
    else if (a === "all") { S.off = new Set(); S.confirmed = false; S.notice = ""; redraw(root); }
  }));
  const toggle = (i: number) => { if (S.off.has(i)) S.off.delete(i); else S.off.add(i); S.notice = ""; S.confirmed = false; redraw(root); };
  root.querySelectorAll<HTMLInputElement>("[data-dpart-use]").forEach((el) => el.addEventListener("change", () => toggle(Number(el.dataset.dpartUse))));
  root.querySelectorAll<SVGElement>("[data-dpart]").forEach((el) => el.addEventListener("click", () => toggle(Number(el.dataset.dpart))));
}
