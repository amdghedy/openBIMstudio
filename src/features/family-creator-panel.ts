/**
 * Family Creator panel: text and PDF-text intake, parameters, views, interactive 3D, IFC2X3.
 * Not done yet: OCR for scanned sheets, image/URL intake, AI reading.
 *
 * Product size in, editable family out, IFC2X3 downloadable. Everything
 * runs in the browser with no network call. Status chips show the real
 * pipeline stages (see modules/families/creator/pipeline.ts); there is no
 * "Ready for Revit" state, because only a run in Revit can establish that.
 */
import * as THREE from "three";
import { t } from "../core/i18n";
import { buildParametricFamily } from "../modules/families/parametric-engine";
import { familyStore } from "../modules/families/store";
import { runCreator, writeCreatorIfc, checkIfcStructure, type CreatorResult, type CreatorStatus } from "../modules/families/creator/pipeline";
import { templateFor, type ProductSpec } from "../modules/families/creator/build";
import { TEMPLATES } from "../modules/families/creator/templates";
import { resolveParts } from "../modules/families/creator/layout";
import { checkPartMap } from "../modules/families/creator/part-map";
import { extractPdfPages, renderPdfPages, MAX_OCR_PAGES } from "../modules/families/creator/pdf-text";
import { fetchSheetFromUrl } from "../modules/families/creator/url-intake";
import { recognizeImage, tidyOcrText } from "../modules/families/creator/ocr";
import { createPreview3D, type Preview3D } from "./family-creator-preview";
import { renderThreeViews } from "../modules/families/creator/preview-svg";
import type { FamilyDefinition } from "../modules/families/types";

let panel: HTMLElement | null = null;
let visible = false;
/** Link import is only offered when the Worker has it switched on: GET answers 405 when on, 404 when off. */
let urlAvail: "unknown" | "on" | "off" = "unknown";
let probing = false;
/** The size name survives a re-render (a parameter edit commits on blur and redraws the panel). */
let sizeName = "";
/** A button press that started just before a blur-triggered redraw would otherwise be lost. */
let pendingPress: { act: string; at: number } | null = null;
let handledPress: { act: string; at: number } | null = null;

interface FormState { name: string; manufacturer: string; model: string; text: string; pages: string[]; fromOcr: boolean; templateId: string; fileName: string; fileNote: string; url: string; urlConsent: boolean; urlNote: string; wMm: string; dMm: string; hMm: string }
const form: FormState = { name: "", manufacturer: "", model: "", text: "", pages: [], fromOcr: false, templateId: "", fileName: "", fileNote: "", url: "", urlConsent: false, urlNote: "", wMm: "", dMm: "", hMm: "" };
let result: CreatorResult | null = null;
let liveStatus: CreatorStatus | null = null;
let notice = "";
/** Parts the user has switched off in the preview and views, by name. Whether exports leave them out is a separate, visible choice. */
const hiddenParts = new Set<string>();
let exportShownOnly = false;
/** The library family the current result was added to or reopened from, and its type. */
let libId: string | null = null;
let libTypeId: string | null = null;
let reopened = false;
let lastIfcName = "";
let preview: Preview3D | null = null;
let previewTried = false;
let previewFit = true;

const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);

const deps = {
  buildInEngine(family: FamilyDefinition, type: FamilyDefinition["types"][number]) {
    const r = buildParametricFamily(family, type, {});
    let bbox: [number, number, number, number, number, number] | null = null;
    if (r.object) {
      const b = new THREE.Box3().setFromObject(r.object);
      bbox = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
    }
    return { object: r.object, params: r.params, errors: r.errors, bbox };
  },
};

function mm(v: string): number | null {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) && n > 0 ? n / 1000 : null;
}

const TPL_IDS = ["box", "cabinet", "table", "shelf"] as const;
function tplId(): ProductSpec["templateId"] {
  return (TPL_IDS as readonly string[]).includes(form.templateId) ? (form.templateId as ProductSpec["templateId"]) : undefined;
}

function run(spec?: ProductSpec) {
  notice = "";
  const useSpec = spec ?? (() => {
    const w = mm(form.wMm), d = mm(form.dMm), h = mm(form.hMm);
    return w !== null && d !== null && h !== null
      ? { name: form.name.trim() || "New family", manufacturer: form.manufacturer || undefined, model: form.model || undefined, widthM: w, depthM: d, heightM: h, templateId: tplId() } as ProductSpec
      : undefined;
  })();
  const prevWarnings = result?.warnings;
  result = runCreator(
    { name: form.name.trim() || "New family", manufacturer: form.manufacturer || undefined, model: form.model || undefined,
      pages: form.pages.length ? form.pages : form.text ? [form.text] : [], spec: useSpec, templateId: tplId() },
    deps,
    (s) => { liveStatus = s; },
  );
  liveStatus = result.status;
  if (spec && result.warnings === undefined) result.warnings = prevWarnings;
  updatePreview(!spec);
  render();
}


interface PartView { parts: ReturnType<typeof resolveParts>; params: Record<string, number> | null }
function currentParts(): PartView | null {
  if (!result?.family || !result.spec) return null;
  try {
    const built = deps.buildInEngine(result.family, result.family.types[0]);
    const params = built.params as Record<string, number>;
    return { parts: resolveParts(templateFor(result.spec), params), params };
  } catch { return null; }
}
/** The preview nodes in part order, only when each node sits at its part's centre; otherwise null and the parts cannot be switched. */
function partNodes(obj: THREE.Object3D, parts: ReturnType<typeof resolveParts>): THREE.Object3D[] | null {
  return checkPartMap(obj.children, parts).ok ? [...obj.children] : null;
}
/** Whether the parts of the current result can be switched on and off safely. */
function partsSwitchable(): boolean {
  const pv = currentParts();
  if (!pv || !result?.family) return false;
  try {
    const obj = deps.buildInEngine(result.family, result.family.types[0]).object;
    return !!obj && checkPartMap(obj.children, pv.parts).ok;
  } catch { return false; }
}
function pruneHidden(parts: ReturnType<typeof resolveParts>) {
  const names = new Set(parts.map((q) => q.name));
  for (const n of [...hiddenParts]) if (!names.has(n)) hiddenParts.delete(n);
}

function updatePreview(fit: boolean) {
  if (!previewTried) { previewTried = true; preview = createPreview3D(); }
  if (!preview) return;
  let obj: THREE.Object3D | null = null;
  if (result?.family && result.status.platformReady) {
    try { obj = deps.buildInEngine(result.family, result.family.types[0]).object ?? null; } catch { obj = null; }
  }
  if (obj && result?.spec) {
    const pv = currentParts();
    const nodes = pv ? partNodes(obj, pv.parts) : null;
    if (pv && !nodes) hiddenParts.clear();
    if (pv && nodes) { pruneHidden(pv.parts); nodes.forEach((k, i) => { k.visible = !hiddenParts.has(pv.parts[i].name); }); }
  }
  preview.setObject(obj, fit || previewFit);
  previewFit = !obj;
}

const setNote = (msg: string) => {
  form.fileNote = msg;
  const n = panel?.querySelector('[data-fc="file-note"]');
  if (n) n.textContent = msg;
};

const IMAGE_RE = /\.(png|jpe?g|webp|bmp)$/i;

/** Read pictures with the on-device OCR. Returns the tidied text and the lowest confidence. */
async function ocrSources(items: Array<HTMLCanvasElement | Blob>, label: string): Promise<{ pages: string[]; confidence: number }> {
  const pages: string[] = [];
  let low = 100;
  for (let i = 0; i < items.length; i++) {
    setNote(t("familyCreator.file.ocrReading", { file: label, n: i + 1, total: items.length }));
    const r = await recognizeImage(items[i], {
      onProgress: (f) => setNote(t("familyCreator.file.ocrReadingPct", { file: label, n: i + 1, total: items.length, pct: Math.round(f * 100) })),
    });
    pages.push(tidyOcrText(r.text));
    low = Math.min(low, r.confidence);
  }
  return { pages, confidence: Math.round(low) };
}

async function loadFile(file: File) {
  form.fileName = file.name;
  form.pages = [];
  form.fromOcr = false;
  setNote("");
  try {
    if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = await extractPdfPages(bytes);
      if (!r.noText) {
        form.pages = r.pages;
        setNote(t(r.truncated ? "familyCreator.file.loadedTruncated" : "familyCreator.file.loaded", { file: file.name, n: r.pages.length, total: r.pageCount }));
      } else {
        // No text layer: a scan. Read the page pictures on this device.
        const shown = await renderPdfPages(bytes);
        const o = await ocrSources(shown.canvases, file.name);
        if (o.pages.every((x) => x === "")) setNote(t("familyCreator.file.ocrNothing", { file: file.name }));
        else {
          form.pages = o.pages; form.fromOcr = true;
          setNote(t(shown.pageCount > MAX_OCR_PAGES ? "familyCreator.file.ocrDoneTruncated" : "familyCreator.file.ocrDone", { file: file.name, n: o.pages.length, total: shown.pageCount, conf: o.confidence }));
        }
      }
    } else if (IMAGE_RE.test(file.name) || file.type.startsWith("image/")) {
      const o = await ocrSources([file], file.name);
      if (o.pages[0] === "") setNote(t("familyCreator.file.ocrNothing", { file: file.name }));
      else { form.pages = o.pages; form.fromOcr = true; setNote(t("familyCreator.file.ocrDone", { file: file.name, n: 1, total: 1, conf: o.confidence })); }
    } else {
      form.pages = [await file.text()];
      setNote(t("familyCreator.file.loaded", { file: file.name, n: 1, total: 1 }));
    }
  } catch (e) {
    setNote(t("familyCreator.file.failed", { file: file.name, message: (e as Error).message }));
  }
  render();
}

async function loadFromUrl() {
  const consent = form.urlConsent;
  form.urlConsent = false; // consent is per use
  const r = await fetchSheetFromUrl(form.url, consent);
  if (r.ok === false) { form.urlNote = t("familyCreator.url.err." + r.key); render(); return; }
  form.urlNote = t("familyCreator.url.done", { host: r.host });
  await loadFile(r.file);
}

function chips(s: CreatorStatus): string {
  const icon: Record<string, string> = { pending: "\u25CB", running: "\u2026", done: "\u2713", failed: "\u2717" };
  const color: Record<string, string> = { pending: "#64748b", running: "#f59e0b", done: "#22c55e", failed: "#ef4444" };
  return s.stages.map((st) => {
    const detail = st.detailKey ? t(st.detailKey, st.detailVars) : (st.detail ?? "");
    return `<div class="obs-fc-stage" data-stage="${st.id}" data-state="${st.state}" style="color:${color[st.state]}">` +
      `<b>${icon[st.state]}</b> ${esc(t(st.labelKey))}${detail ? `<div class="obs-fc-detail"><bdi>${esc(detail)}</bdi></div>` : ""}</div>`;
  }).join("");
}

function resultHtml(r: CreatorResult): string {
  const s = r.status;
  let html = `<div class="obs-fc-sec"><div class="obs-fc-h">${esc(t("familyCreator.status"))}</div>${chips(s)}` +
    `<div class="obs-fc-detail" data-fc="progress"><bdi>${esc(t("familyCreator.progress", { done: s.completed, total: s.total }))}</bdi></div></div>`;
  html += `<div class="obs-fc-sec" data-fc="targets"><div class="obs-fc-h">${esc(t("familyCreator.dest.title"))}</div>` +
    `<div>${esc(t("familyCreator.dest.family"))}: <b>${esc(t(s.platformReady ? "familyCreator.dest.familyReady" : "familyCreator.dest.familyNot"))}</b></div>` +
    `<div>${esc(t("familyCreator.dest.ifc"))}: <b>${esc(t(s.exports.ifc2x3.state === "structure-checked" ? "familyCreator.dest.ifcOk" : s.exports.ifc2x3.state === "failed" ? "familyCreator.dest.ifcFailed" : "familyCreator.dest.ifcNot"))}</b></div>` +
    `<div>${esc(t("familyCreator.dest.revit"))}: <b>${esc(t("familyCreator.dest.revitNot"))}</b> <span class="obs-fc-detail">${esc(t("familyCreator.dest.revitNote"))}</span></div></div>`;
  if (r.family && r.spec && s.platformReady) {
    const tpl = templateFor(r.spec);
    let resolved: Record<string, number> = {};
    try { resolved = deps.buildInEngine(r.family, r.family.types[0]).params as Record<string, number>; } catch { /* shown as the type value */ }
    const values = { ...(r.family.types[0].values as Record<string, number>), ...resolved };
    const srcs = r.spec.sources ?? [];
    const tagOf = (p: { name: string; label?: string; editable?: boolean }): string => {
      if (p.editable === false) return "";
      const sized = p.name === "Width" || p.name === "Depth" || p.name === "Height";
      const edited = !sized && r.spec!.params?.[p.name] !== undefined && !srcs.some((x) => x.label === p.label);
      const key = sized ? (srcs.some((x) => x.label === p.name) ? "sheet" : (form.wMm && form.dMm && form.hMm) || !(srcs.length || reopened) ? "typed" : "edited")
        : srcs.some((x) => x.label === p.label) ? "sheet" : edited ? "edited" : "default";
      return ` <span class="obs-fc-detail" data-tag="${key}">(${esc(t("familyCreator.tag." + key))})</span>`;
    };
    const rows = r.family.parameters.map((p) => {
      const val = (values[p.name] ?? p.default) as number;
      const isInt = p.type === "integer";
      const mmv = isInt ? Math.round(val) : Math.round(val * 1000 * 10) / 10;
      return `<tr><td>${esc(p.label ?? p.name)}</td><td>` +
        (p.editable
          ? `<input type="number" step="1" min="${isInt ? 0 : 1}" data-param="${esc(p.name)}" data-int="${isInt ? 1 : 0}" value="${mmv}" class="obs-fc-in" style="width:84px">${isInt ? "" : " mm"}${tagOf(p)}`
          : `${mmv} mm <span class="obs-fc-detail">${esc(t("familyCreator.formula"))}</span>`) + `</td></tr>`;
    }).join("");
    html += `<div class="obs-fc-sec"><div class="obs-fc-h">${esc(t("familyCreator.params", { template: tpl.label }))}</div><table class="obs-fc-tbl">${rows}</table></div>`;
    html += `<div class="obs-fc-sec"><div class="obs-fc-h" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span>${esc(t("familyCreator.preview3d"))}</span> <button type="button" class="obs-fc-btn" data-act="fit">${esc(t("familyCreator.fit"))}</button></div>` +
      (preview ? `<div data-fc-slot="preview3d"></div><div class="obs-fc-detail">${esc(t("familyCreator.preview3dHelp"))}</div>` : `<div class="obs-fc-detail" data-fc="no3d">${esc(t("familyCreator.preview3dUnavailable"))}</div>`) + `</div>`;
    // Views from the engine-resolved parts.
    try {
      const built = deps.buildInEngine(r.family, r.family.types[0]);
      const parts = resolveParts(tpl, built.params);
      pruneHidden(parts);
      const shownParts = parts.filter((q) => !hiddenParts.has(q.name));
      html += `<div class="obs-fc-sec"><div class="obs-fc-h">${esc(t("familyCreator.views"))}</div><div data-fc="views">${renderThreeViews(shownParts, { w: r.spec.widthM, d: r.spec.depthM, h: r.spec.heightM }, { front: t("familyCreator.front"), side: t("familyCreator.side"), top: t("familyCreator.top") })}</div>` +
        `<div class="obs-fc-detail"><bdi>${esc(t("familyCreator.partsLine", { n: parts.length, names: parts.map((p) => p.name).join(", ") }))}</bdi></div></div>`;
      html += partsHtml(parts);
    } catch (e) { html += `<div class="obs-fc-detail">${esc(t("familyCreator.viewsUnavailable", { message: (e as Error).message }))}</div>`; }
  }
  if (r.warnings?.length) {
    html += `<div class="obs-fc-sec" data-fc="warnings" style="color:#f59e0b"><div class="obs-fc-h">${esc(t("familyCreator.warn.title"))}</div>` +
      r.warnings.map((w) => `<div class="obs-fc-detail" style="color:#f59e0b"><bdi>${esc(t(w.key, w.vars))}</bdi></div>`).join("") + `</div>`;
  }
  if (r.spec?.sources?.length) {
    html += `<div class="obs-fc-sec" data-fc="sources"><div class="obs-fc-h">${esc(t("familyCreator.sources"))}</div>` +
      r.spec.sources.map((c) => `<div class="obs-fc-src"><b>${esc(c.label)}</b> ${c.kind === "count" ? c.valueM : `${Math.round(c.valueM * 1000)} mm`}` +
        `<div class="obs-fc-detail"><bdi>${esc(t("familyCreator.sourceLine", { page: c.page, line: c.line, text: c.sourceText }))}</bdi></div></div>`).join("") +
      `<div class="obs-fc-detail">${esc(t("familyCreator.sourceCheck"))}</div>` +
      (form.fromOcr && form.pages.length ? `<div class="obs-fc-detail" data-fc="ocr-warning" style="color:#f59e0b">${esc(t("familyCreator.ocrCheck"))}</div>` : "") + `</div>`;
  }
  if (s.platformReady) {
    html += `<div class="obs-fc-sec"><button type="button" class="obs-fc-btn" data-act="add">${esc(t("familyCreator.add"))}</button> ` +
      (r.ifcText ? `<button type="button" class="obs-fc-btn" data-act="ifc">${esc(t("familyCreator.ifcDownload"))}</button>` : "") +
      (r.ifcText && preview ? `<button type="button" class="obs-fc-btn" data-act="glb">${esc(t("familyCreator.glbDownload"))}</button>` : "") + `</div>` +
      (r.ifcText && preview ? `<div class="obs-fc-detail" data-fc="glb-note">${esc(t("familyCreator.glbNote"))}</div>` : "");
    html += libraryHtml();
  }
  return html;
}


function partsHtml(parts: ReturnType<typeof resolveParts>): string {
  if (!partsSwitchable()) { hiddenParts.clear(); exportShownOnly = false; return `<div class="obs-fc-sec" data-fc="parts"><div class="obs-fc-h">${esc(t("familyCreator.parts.title"))}</div><div class="obs-fc-detail" data-fc="parts-unavailable" style="color:#f59e0b">${esc(t("familyCreator.parts.unavailable"))}</div></div>`; }
  const nHidden = parts.filter((q) => hiddenParts.has(q.name)).length;
  const boxes = parts.map((q) => `<label class="obs-fc-part" style="display:inline-flex;align-items:center;gap:4px"><input type="checkbox" data-part="${esc(q.name)}"${hiddenParts.has(q.name) ? "" : " checked"}> <bdi>${esc(q.name)}</bdi></label>`).join("");
  const scope = nHidden === 0 ? t("familyCreator.parts.scopeAll", { n: parts.length })
    : exportShownOnly ? t("familyCreator.parts.scopeShown", { shown: parts.length - nHidden, n: parts.length })
      : t("familyCreator.parts.scopePreviewOnly", { n: parts.length });
  return `<div class="obs-fc-sec" data-fc="parts"><div class="obs-fc-h">${esc(t("familyCreator.parts.title"))}</div>` +
    `<div class="obs-fc-parts" style="display:flex;flex-wrap:wrap;gap:4px 12px">${boxes}</div>` +
    `<div style="margin-top:4px"><button type="button" class="obs-fc-btn" data-act="show-all-parts"${nHidden ? "" : " disabled"}>${esc(t("familyCreator.parts.showAll"))}</button></div>` +
    `<div class="obs-fc-detail" style="margin-top:6px">${esc(t("familyCreator.parts.exportTitle"))}</div>` +
    `<label class="obs-fc-part" style="display:flex;align-items:center;gap:4px"><input type="radio" name="fc-export-scope" data-scope="all"${exportShownOnly ? "" : " checked"}> ${esc(t("familyCreator.parts.exportAll"))}</label>` +
    `<label class="obs-fc-part" style="display:flex;align-items:center;gap:4px"><input type="radio" name="fc-export-scope" data-scope="shown"${exportShownOnly ? " checked" : ""}> ${esc(t("familyCreator.parts.exportShown"))}</label>` +
    `<div class="obs-fc-detail" data-fc="export-scope">${esc(scope)}${nHidden && exportShownOnly ? " " + esc(t("familyCreator.parts.countsNote")) : ""}</div></div>`;
}

function urlBoxHtml(): string {
  if (urlAvail !== "on") return `<div data-fc="url-box" data-state="unavailable" class="obs-fc-detail" style="margin:6px 0">${esc(t("familyCreator.url.unavailable"))}</div>`;
  return `<div data-fc="url-box" style="margin:6px 0"><div style="display:flex;gap:6px"><input class="obs-fc-in" data-f="url" type="url" dir="ltr" placeholder="${esc(t("familyCreator.url.placeholder"))}" value="${esc(form.url)}"><button type="button" class="obs-fc-btn" data-act="fetch-url"${form.urlConsent && form.url.trim() ? "" : " disabled"}>${esc(t("familyCreator.url.fetch"))}</button></div>
        <label class="obs-fc-detail" style="display:flex;gap:6px;align-items:flex-start;margin-top:3px"><input type="checkbox" data-fc="url-consent"${form.urlConsent ? " checked" : ""}><span>${esc(t("familyCreator.url.consent"))}</span></label>
        <div class="obs-fc-detail" data-fc="url-note">${esc(form.urlNote)}</div></div>`;
}

async function probeUrlIntake() {
  if (probing || urlAvail === "on") return;
  probing = true;
  let next: "on" | "off" = "off";
  try {
    const r = await fetch("/api/fetch-sheet", { method: "GET", cache: "no-store", credentials: "same-origin" });
    next = r.status === 405 ? "on" : "off";
  } catch { next = "off"; }
  probing = false;
  const changed = next !== urlAvail;
  urlAvail = next;
  if (changed && visible) render();
}

function render() {
  if (!panel) return;
  panel.innerHTML = `
    <div class="obs-panel-header"><span>${esc(t("familyCreator.title"))}</span><button type="button" class="obs-icon-btn" data-act="close" aria-label="${esc(t("familyCreator.close"))}">\u00d7</button></div>
    <div class="obs-panel-body">
      <div class="obs-fc-detail" style="margin-bottom:8px">${esc(t("familyCreator.intro"))}</div>
      ${reopenHtml()}
      <input class="obs-fc-in" data-f="name" placeholder="${esc(t("familyCreator.name"))}" value="${esc(form.name)}">
      <div style="display:flex;gap:6px"><input class="obs-fc-in" data-f="manufacturer" placeholder="${esc(t("familyCreator.manufacturer"))}" value="${esc(form.manufacturer)}"><input class="obs-fc-in" data-f="model" placeholder="${esc(t("familyCreator.model"))}" value="${esc(form.model)}"></div>
      <div style="display:flex;gap:6px;align-items:center;margin:3px 0"><label class="obs-fc-btn" style="cursor:pointer">${esc(t("familyCreator.file.choose"))}<input type="file" accept=".pdf,.txt,.png,.jpg,.jpeg,.webp,.bmp,application/pdf,text/plain,image/png,image/jpeg,image/webp,image/bmp" data-fc="file" style="display:none"></label><span class="obs-fc-detail" data-fc="file-note">${esc(form.fileNote)}</span></div>
      ${urlBoxHtml()}
      <textarea class="obs-fc-in" data-f="text" rows="4" placeholder="${esc(t("familyCreator.textPlaceholder"))}">${esc(form.text)}</textarea>
      <label class="obs-fc-detail" style="display:block;margin-top:4px">${esc(t("familyCreator.shape"))}
        <select class="obs-fc-in" data-f="templateId"><option value="">${esc(t("familyCreator.shapeAuto"))}</option>${TPL_IDS.map((id) => `<option value="${id}"${form.templateId === id ? " selected" : ""}>${esc(TEMPLATES[id].label)}</option>`).join("")}</select></label>
      <div class="obs-fc-detail">${esc(t("familyCreator.sizeHint"))}</div>
      <div style="display:flex;gap:6px"><input class="obs-fc-in" data-f="wMm" placeholder="${esc(t("familyCreator.w"))}" value="${esc(form.wMm)}"><input class="obs-fc-in" data-f="dMm" placeholder="${esc(t("familyCreator.d"))}" value="${esc(form.dMm)}"><input class="obs-fc-in" data-f="hMm" placeholder="${esc(t("familyCreator.h"))}" value="${esc(form.hMm)}"></div>
      <button type="button" class="obs-fc-btn" data-act="create" style="margin-top:8px">${esc(t("familyCreator.create"))}</button>
      ${notice ? `<div class="obs-fc-detail" data-fc="notice" style="color:#22c55e">${esc(notice)}</div>` : ""}
      ${result ? resultHtml(result) : ""}
    </div>`;
  panel.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-f]").forEach((el) => {
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      (form as unknown as Record<string, string>)[el.dataset.f as string] = el.value;
      // Typing replaces the loaded file text, so the run never mixes the two.
      if (el.dataset.f === "text" && form.pages.length) { form.pages = []; form.fromOcr = false; form.fileNote = ""; const n = panel?.querySelector('[data-fc="file-note"]'); if (n) n.textContent = ""; }
    });
  });
  panel.querySelectorAll<HTMLElement>("[data-act]").forEach((el) => {
    el.addEventListener("click", () => {
      const a = el.dataset.act as string;
      if (handledPress && handledPress.act === a && Date.now() - handledPress.at < 1500) { handledPress = null; return; }
      act(a);
    });
  });
  if (!panel.dataset.pressGuard) {
    panel.dataset.pressGuard = "1";
    panel.addEventListener("mousedown", (ev) => {
      const b = (ev.target as Element | null)?.closest?.("[data-act]") as HTMLElement | null;
      pendingPress = b && !(b as HTMLButtonElement).disabled ? { act: b.dataset.act as string, at: Date.now() } : null;
    }, true);
  }
  panel.querySelector<HTMLInputElement>('[data-fc="file"]')?.addEventListener("change", (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) void loadFile(f);
  });
  panel.querySelector<HTMLInputElement>('[data-fc="url-consent"]')?.addEventListener("change", (ev) => {
    form.urlConsent = (ev.target as HTMLInputElement).checked;
    const b = panel?.querySelector<HTMLButtonElement>('[data-act="fetch-url"]');
    if (b) b.disabled = !(form.urlConsent && form.url.trim());
  });
  panel.querySelector<HTMLInputElement>('[data-f="url"]')?.addEventListener("input", () => {
    const b = panel?.querySelector<HTMLButtonElement>('[data-act="fetch-url"]');
    if (b) b.disabled = !(form.urlConsent && form.url.trim());
  });
  panel.querySelector<HTMLSelectElement>('[data-fc="reopen-family"]')?.addEventListener("change", (ev) => {
    const fam = familyStore.get((ev.target as HTMLSelectElement).value);
    const ts = panel?.querySelector<HTMLSelectElement>('[data-fc="reopen-type"]');
    if (ts && fam) ts.innerHTML = fam.types.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");
  });
  panel.querySelector<HTMLInputElement>('[data-fc="size-name"]')?.addEventListener("input", (ev) => { sizeName = (ev.target as HTMLInputElement).value; });
  panel.querySelectorAll<HTMLElement>("[data-rm-size]").forEach((el) => el.addEventListener("click", () => {
    if (libId && familyStore.removeType(libId, el.dataset.rmSize as string)) { notice = t("familyCreator.lib.sizeRemoved"); render(); }
  }));
  const slot = panel.querySelector<HTMLElement>('[data-fc-slot="preview3d"]');
  if (slot && preview) slot.appendChild(preview.el);
  panel.querySelector('[data-act="fit"]')?.addEventListener("click", () => preview?.fit());
  panel.querySelectorAll<HTMLInputElement>("input[data-part]").forEach((el) => el.addEventListener("change", () => {
    const n = el.dataset.part as string;
    if (el.checked) hiddenParts.delete(n); else hiddenParts.add(n);
    updatePreview(false); render();
  }));
  panel.querySelectorAll<HTMLInputElement>("input[data-scope]").forEach((el) => el.addEventListener("change", () => {
    exportShownOnly = el.dataset.scope === "shown"; render();
  }));
  panel.querySelectorAll<HTMLInputElement>("[data-param]").forEach((el) => {
    el.addEventListener("change", () => {
      const press = pendingPress && Date.now() - pendingPress.at < 1500 ? pendingPress : null;
      pendingPress = null;
      editParam(el.dataset.param as string, el.dataset.int === "1" ? Number(el.value) : Number(el.value) / 1000);
      // The edit redraws the panel, which drops the button the user was pressing. Run that press once, on the new state.
      if (press) { handledPress = press; act(press.act); }
    });
  });
}

function editParam(name: string, valueM: number) {
  if (!result?.spec || !Number.isFinite(valueM)) return;
  const spec: ProductSpec = { ...result.spec, params: { ...(result.spec.params ?? {}) } };
  if (name === "Width") spec.widthM = valueM;
  else if (name === "Depth") spec.depthM = valueM;
  else if (name === "Height") spec.heightM = valueM;
  else spec.params![name] = valueM;
  // A value the user changed is no longer "from the sheet": drop its source line so the tag and the list stay true.
  const tp = templateFor(spec).params;
  const label = tp.find((x) => x.name === name)?.label ?? name;
  if (spec.sources) spec.sources = spec.sources.filter((x) => x.label !== label);
  run(spec);
}

/** GLB of the same engine geometry as the preview. Metres, Y up, one named node per part. A viewer format only. */
async function downloadGlb() {
  if (!result?.family || !result.spec) return;
  try {
    const built = deps.buildInEngine(result.family, result.family.types[0]);
    const obj = built.object;
    if (!obj) throw new Error(t("familyCreator.glbNoGeometry"));
    // Name each part node, but only where the node sits exactly at the part's centre. Otherwise leave it unnamed.
    const parts = resolveParts(templateFor(result.spec), built.params as Record<string, number>);
    if (parts.length === obj.children.length) {
      obj.children.forEach((k, i) => {
        const q = parts[i];
        if (Math.hypot(k.position.x - q.cx, k.position.y - q.cy, k.position.z - q.cz) < 1e-6) k.name = q.name;
      });
    }
    let omitted = 0;
    if (exportShownOnly && hiddenParts.size && !checkPartMap(obj.children, parts).ok) throw new Error(t("familyCreator.parts.unavailable"));
    if (exportShownOnly && hiddenParts.size) {
      const drop = obj.children.filter((_k, i) => hiddenParts.has(parts[i].name));
      if (drop.length === parts.length) throw new Error(t("familyCreator.parts.allHidden"));
      drop.forEach((k) => obj.remove(k));
      omitted = drop.length;
    }
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const buf = await new GLTFExporter().parseAsync(obj, { binary: true });
    const blob = new Blob([buf as ArrayBuffer], { type: "model/gltf-binary" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const file = `${result.spec.name.replace(/[^A-Za-z0-9._-]+/g, "_")}.glb`;
    link.href = url; link.download = file;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    notice = t("familyCreator.glbSaved", { file }) + (omitted ? " " + t("familyCreator.parts.omitted", { omitted, n: parts.length }) : "");
  } catch (e) {
    notice = t("familyCreator.glbFailed", { message: (e as Error).message });
  }
  render();
}

const EPS = 1e-9;
const creatorFamilies = () => familyStore.list().filter((f) => f.creatorSpec && typeof f.creatorSpec === "object");

/** Open a family made here, at one of its types. A value that differs from the stored spec was edited, so it loses its sheet source line. */
function reopenSelected() {
  const fid = (panel?.querySelector<HTMLSelectElement>('[data-fc="reopen-family"]'))?.value;
  const tid = (panel?.querySelector<HTMLSelectElement>('[data-fc="reopen-type"]'))?.value;
  const fam = fid ? familyStore.get(fid) : null;
  if (!fam?.creatorSpec) return;
  const type = fam.types.find((x) => x.id === tid) ?? fam.types[0];
  const spec = JSON.parse(JSON.stringify(fam.creatorSpec)) as ProductSpec;
  spec.params = { ...(spec.params ?? {}) };
  const tp = templateFor(spec).params;
  const dropSource = (label: string) => { if (spec.sources) spec.sources = spec.sources.filter((x) => x.label !== label); };
  const vals = (type?.values ?? {}) as Record<string, number>;
  const dims: Array<["widthM" | "depthM" | "heightM", string]> = [["widthM", "Width"], ["depthM", "Depth"], ["heightM", "Height"]];
  for (const [k, n] of dims) if (typeof vals[n] === "number" && Math.abs(vals[n] - spec[k]) > EPS) { spec[k] = vals[n]; dropSource(n); }
  for (const q of tp) {
    if (q.formula !== undefined || typeof vals[q.name] !== "number") continue;
    const cur = spec.params[q.name] ?? q.default;
    if (Math.abs(vals[q.name] - cur) > EPS) { spec.params[q.name] = vals[q.name]; dropSource(q.label); }
  }
  form.name = spec.name; form.manufacturer = spec.manufacturer ?? ""; form.model = spec.model ?? "";
  form.text = ""; form.pages = []; form.fromOcr = false; form.fileName = ""; form.fileNote = "";
  form.wMm = ""; form.dMm = ""; form.hMm = ""; form.templateId = spec.templateId ?? "";
  libId = fam.id; libTypeId = type?.id ?? null; reopened = true;
  run(spec);
  notice = t("familyCreator.lib.reopened", { name: fam.name, type: type?.name ?? "" });
  render();
}

/** Write the current result back to the family it was reopened from: its shape, parameters and the one type that was opened. Other types keep their own sizes. */
function saveToLibrary() {
  if (!result?.family || !result.spec || !libId || !reopened) return;
  const f = result.family;
  const fam = familyStore.update(libId, { name: f.name, parameters: f.parameters, geometry: f.geometry, creatorSpec: JSON.parse(JSON.stringify(result.spec)) as Record<string, unknown> });
  if (fam && libTypeId) familyStore.updateType(libId, libTypeId, { values: { ...(f.types[0].values as Record<string, unknown>) } });
  notice = fam ? t("familyCreator.lib.saved", { name: f.name }) : t("familyCreator.lib.missing");
  render();
}

function addSize() {
  const inp = panel?.querySelector<HTMLInputElement>('[data-fc="size-name"]');
  const name = (inp ? inp.value : sizeName).trim();
  sizeName = name;
  const fam = libId ? familyStore.get(libId) : null;
  if (!fam?.creatorSpec || !result?.family || !result.spec) return;
  if (!name) { notice = t("familyCreator.lib.sizeNeedsName"); render(); return; }
  if (fam.types.some((x) => x.name.toLowerCase() === name.toLowerCase())) { notice = t("familyCreator.lib.sizeTaken", { name }); render(); return; }
  const base = (fam.creatorSpec.params ?? {}) as Record<string, number>;
  const countChanged = templateFor(result.spec).params.some((q) => q.integer && q.formula === undefined && (result!.spec!.params?.[q.name] ?? q.default) !== (base[q.name] ?? q.default));
  if (countChanged) { notice = t("familyCreator.lib.sizeCountDiffers"); render(); return; }
  familyStore.createType(fam.id, name, { ...(result.family.types[0].values as Record<string, unknown>) });
  notice = t("familyCreator.lib.sizeAdded", { name });
  sizeName = "";
  render();
}

const mmStr = (v: unknown) => (typeof v === "number" ? String(Math.round(v * 1000)) : "?");

function libraryHtml(): string {
  const fam = libId ? familyStore.get(libId) : null;
  if (!fam || !result?.spec) return "";
  const rows = fam.types.map((ty) => {
    const v = ty.values as Record<string, unknown>;
    return `<div class="obs-fc-src" data-fc="size-row"><b>${esc(ty.name)}</b> <bdi dir="ltr">${mmStr(v.Width)} x ${mmStr(v.Depth)} x ${mmStr(v.Height)} mm</bdi>` +
      (fam.types.length > 1 ? ` <button type="button" class="obs-fc-btn" data-rm-size="${esc(ty.id)}">${esc(t("familyCreator.lib.removeSize"))}</button>` : "") + `</div>`;
  }).join("");
  return `<div class="obs-fc-sec" data-fc="library"><div class="obs-fc-h">${esc(t("familyCreator.lib.sizesTitle", { name: fam.name }))}</div>${rows}` +
    `<div style="display:flex;gap:6px;margin-top:4px"><input class="obs-fc-in" data-fc="size-name" placeholder="${esc(t("familyCreator.lib.sizeName"))}" value="${esc(sizeName)}"><button type="button" class="obs-fc-btn" data-act="add-size">${esc(t("familyCreator.lib.addSize"))}</button></div>` +
    `<div class="obs-fc-detail">${esc(t("familyCreator.lib.sizeHelp"))}</div>` +
    (reopened ? `<div style="margin-top:6px"><button type="button" class="obs-fc-btn" data-act="save-lib">${esc(t("familyCreator.lib.save"))}</button> <span class="obs-fc-detail">${esc(t("familyCreator.lib.saveHelp"))}</span></div>` : "") + `</div>`;
}

function reopenHtml(): string {
  const fams = creatorFamilies();
  if (!fams.length) return "";
  const first = fams[0];
  return `<div class="obs-fc-sec" data-fc="reopen"><div class="obs-fc-h">${esc(t("familyCreator.lib.reopenTitle"))}</div>` +
    `<div style="display:flex;gap:6px"><select class="obs-fc-in" data-fc="reopen-family">${fams.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")}</select>` +
    `<select class="obs-fc-in" data-fc="reopen-type">${first.types.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select>` +
    `<button type="button" class="obs-fc-btn" data-act="reopen">${esc(t("familyCreator.lib.open"))}</button></div></div>`;
}

function act(a: string) {
  if (a === "close") setVisible(false);
  else if (a === "create") run();
  else if (a === "fetch-url") { if (form.urlConsent && form.url.trim()) void loadFromUrl(); }
  else if (a === "fit") preview?.fit();
  else if (a === "add" && result?.family) {
    const f = result.family;
    const made = familyStore.create({
      name: f.name, category: f.category, ifcEntity: f.ifcEntity, sourceElementType: f.sourceElementType,
      group: f.group, parameters: f.parameters, geometry: f.geometry, types: f.types,
      ...(result.spec ? { creatorSpec: JSON.parse(JSON.stringify(result.spec)) as Record<string, unknown> } : {}),
    } as Parameters<typeof familyStore.create>[0]);
    libId = made.id; libTypeId = made.types[0]?.id ?? null; reopened = false;
    notice = t("familyCreator.added", { name: f.name });
    render();
  } else if (a === "reopen") reopenSelected();
  else if (a === "save-lib") saveToLibrary();
  else if (a === "add-size") addSize();
  else if (a === "show-all-parts") { hiddenParts.clear(); updatePreview(false); render(); }
  else if (a === "glb" && result?.family && result.spec) void downloadGlb();
  else if (a === "ifc" && result?.ifcText && result.spec) {
    let text = result.ifcText, omittedNote = "";
    const pv = exportShownOnly && hiddenParts.size ? currentParts() : null;
    if (exportShownOnly && hiddenParts.size && !partsSwitchable()) { notice = t("familyCreator.parts.unavailable"); render(); return; }
    if (pv && result.family) {
      const keep = pv.parts.filter((q) => !hiddenParts.has(q.name));
      if (!keep.length) { notice = t("familyCreator.parts.allHidden"); render(); return; }
      const out = writeCreatorIfc(result.family, result.spec, pv.params ?? {}, keep);
      const bad = checkIfcStructure(out.text, keep.length);
      if (bad.length) { notice = t("familyCreator.glbFailed", { message: bad.join("; ") }); render(); return; }
      text = out.text;
      omittedNote = " " + t("familyCreator.parts.omitted", { omitted: pv.parts.length - keep.length, n: pv.parts.length });
    }
    const blob = new Blob([text], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    lastIfcName = `${result.spec.name.replace(/[^A-Za-z0-9._-]+/g, "_")}.ifc`;
    link.href = url; link.download = lastIfcName;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    notice = t("familyCreator.saved", { file: lastIfcName }) + omittedNote;
    render();
  }
}

function ensurePanel(): HTMLElement {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.className = "obs-side-panel obs-fc-panel";
  panel.setAttribute("data-testid", "family-creator-panel");
  panel.style.cssText =
    "position:fixed;top:48px;right:12px;width:min(380px,calc(100vw - 24px));box-sizing:border-box;max-height:calc(100vh - 80px);" +
    "background:#1e2430;color:#e2e8f0;border:1px solid #334155;border-radius:10px;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.45);z-index:8000;display:none;overflow:auto;" +
    "font:13px/1.4 system-ui,sans-serif;";
  document.body.appendChild(panel);
  const style = document.createElement("style");
  style.textContent = `
    .obs-fc-btn { background:#334155;border:1px solid #475569;color:#e2e8f0;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px; }
    .obs-fc-btn:hover { background:#475569; }
    .obs-fc-in { box-sizing:border-box;width:100%;margin:3px 0;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:6px;padding:5px 7px;font:12px system-ui,sans-serif; }
    .obs-fc-sec { margin-top:10px;padding-top:8px;border-top:1px solid #334155; }
    .obs-fc-h { font-weight:600;margin-bottom:4px; }
    .obs-fc-detail { font-size:11px;color:#94a3b8; }
    .obs-fc-stage { padding:2px 0; }
    .obs-fc-tbl { width:100%;border-collapse:collapse; } .obs-fc-tbl td { padding:2px 4px;border-bottom:1px solid #263041; }
    .obs-fc-src { margin:3px 0; }
  `;
  document.head.appendChild(style);
  return panel;
}

export function setVisible(on: boolean) {
  visible = on;
  ensurePanel().style.display = on ? "block" : "none";
  if (on) { render(); void probeUrlIntake(); }
}
export function toggleFamilyCreatorPanel() { setVisible(!visible); }
export function isFamilyCreatorPanelVisible() { return visible; }
export function setupFamilyCreatorPanel() { ensurePanel(); }
