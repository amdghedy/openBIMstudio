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
import { runCreator, type CreatorResult, type CreatorStatus } from "../modules/families/creator/pipeline";
import { templateFor, type ProductSpec } from "../modules/families/creator/build";
import { resolveParts } from "../modules/families/creator/layout";
import { extractPdfPages } from "../modules/families/creator/pdf-text";
import { createPreview3D, type Preview3D } from "./family-creator-preview";
import { renderThreeViews } from "../modules/families/creator/preview-svg";
import type { FamilyDefinition } from "../modules/families/types";

let panel: HTMLElement | null = null;
let visible = false;

interface FormState { name: string; manufacturer: string; model: string; text: string; pages: string[]; fileName: string; fileNote: string; wMm: string; dMm: string; hMm: string }
const form: FormState = { name: "", manufacturer: "", model: "", text: "", pages: [], fileName: "", fileNote: "", wMm: "", dMm: "", hMm: "" };
let result: CreatorResult | null = null;
let liveStatus: CreatorStatus | null = null;
let notice = "";
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

function run(spec?: ProductSpec) {
  notice = "";
  const useSpec = spec ?? (() => {
    const w = mm(form.wMm), d = mm(form.dMm), h = mm(form.hMm);
    return w !== null && d !== null && h !== null
      ? { name: form.name.trim() || "New family", manufacturer: form.manufacturer || undefined, model: form.model || undefined, widthM: w, depthM: d, heightM: h } as ProductSpec
      : undefined;
  })();
  result = runCreator(
    { name: form.name.trim() || "New family", manufacturer: form.manufacturer || undefined, model: form.model || undefined,
      pages: form.pages.length ? form.pages : form.text ? [form.text] : [], spec: useSpec },
    deps,
    (s) => { liveStatus = s; },
  );
  liveStatus = result.status;
  updatePreview(!spec);
  render();
}

function updatePreview(fit: boolean) {
  if (!previewTried) { previewTried = true; preview = createPreview3D(); }
  if (!preview) return;
  let obj: THREE.Object3D | null = null;
  if (result?.family && result.status.platformReady) {
    try { obj = deps.buildInEngine(result.family, result.family.types[0]).object ?? null; } catch { obj = null; }
  }
  preview.setObject(obj, fit || previewFit);
  previewFit = !obj;
}

async function loadFile(file: File) {
  form.fileName = file.name;
  form.pages = [];
  form.fileNote = "";
  try {
    if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
      const r = await extractPdfPages(new Uint8Array(await file.arrayBuffer()));
      if (r.noText) form.fileNote = t("familyCreator.file.noText", { file: file.name });
      else {
        form.pages = r.pages;
        form.fileNote = t(r.truncated ? "familyCreator.file.loadedTruncated" : "familyCreator.file.loaded", { file: file.name, n: r.pages.length, total: r.pageCount });
      }
    } else {
      form.pages = [await file.text()];
      form.fileNote = t("familyCreator.file.loaded", { file: file.name, n: 1, total: 1 });
    }
  } catch (e) {
    form.fileNote = t("familyCreator.file.failed", { file: file.name, message: (e as Error).message });
  }
  render();
}

function chips(s: CreatorStatus): string {
  const icon: Record<string, string> = { pending: "\u25CB", running: "\u2026", done: "\u2713", failed: "\u2717" };
  const color: Record<string, string> = { pending: "#64748b", running: "#f59e0b", done: "#22c55e", failed: "#ef4444" };
  return s.stages.map((st) => {
    const detail = st.detailKey ? t(st.detailKey, st.detailVars) : (st.detail ?? "");
    return `<div class="obs-fc-stage" data-stage="${st.id}" data-state="${st.state}" style="color:${color[st.state]}">` +
      `<b>${icon[st.state]}</b> ${esc(t(st.labelKey))}${detail ? `<div class="obs-fc-detail">${esc(detail)}</div>` : ""}</div>`;
  }).join("");
}

function resultHtml(r: CreatorResult): string {
  const s = r.status;
  let html = `<div class="obs-fc-sec"><div class="obs-fc-h">${esc(t("familyCreator.status"))}</div>${chips(s)}` +
    `<div class="obs-fc-detail" data-fc="progress">${esc(t("familyCreator.progress", { done: s.completed, total: s.total }))}</div></div>`;
  html += `<div class="obs-fc-sec" data-fc="targets"><div class="obs-fc-h">${esc(t("familyCreator.dest.title"))}</div>` +
    `<div>${esc(t("familyCreator.dest.family"))}: <b>${esc(t(s.platformReady ? "familyCreator.dest.familyReady" : "familyCreator.dest.familyNot"))}</b></div>` +
    `<div>${esc(t("familyCreator.dest.ifc"))}: <b>${esc(t(s.exports.ifc2x3.state === "structure-checked" ? "familyCreator.dest.ifcOk" : s.exports.ifc2x3.state === "failed" ? "familyCreator.dest.ifcFailed" : "familyCreator.dest.ifcNot"))}</b></div>` +
    `<div>${esc(t("familyCreator.dest.revit"))}: <b>${esc(t("familyCreator.dest.revitNot"))}</b> <span class="obs-fc-detail">${esc(t("familyCreator.dest.revitNote"))}</span></div></div>`;
  if (r.family && r.spec && s.platformReady) {
    const tpl = templateFor(r.spec);
    let resolved: Record<string, number> = {};
    try { resolved = deps.buildInEngine(r.family, r.family.types[0]).params as Record<string, number>; } catch { /* shown as the type value */ }
    const values = { ...(r.family.types[0].values as Record<string, number>), ...resolved };
    const rows = r.family.parameters.map((p) => {
      const val = (values[p.name] ?? p.default) as number;
      const mmv = Math.round(val * 1000 * 10) / 10;
      return `<tr><td>${esc(p.label ?? p.name)}</td><td>` +
        (p.editable
          ? `<input type="number" step="1" min="1" data-param="${esc(p.name)}" value="${mmv}" class="obs-fc-in" style="width:84px"> mm`
          : `${mmv} mm <span class="obs-fc-detail">${esc(t("familyCreator.formula"))}</span>`) + `</td></tr>`;
    }).join("");
    html += `<div class="obs-fc-sec"><div class="obs-fc-h">${esc(t("familyCreator.params", { template: tpl.label }))}</div><table class="obs-fc-tbl">${rows}</table></div>`;
    html += `<div class="obs-fc-sec"><div class="obs-fc-h">${esc(t("familyCreator.preview3d"))} <button type="button" class="obs-fc-btn" data-act="fit" style="float:right">${esc(t("familyCreator.fit"))}</button></div>` +
      (preview ? `<div data-fc-slot="preview3d"></div><div class="obs-fc-detail">${esc(t("familyCreator.preview3dHelp"))}</div>` : `<div class="obs-fc-detail" data-fc="no3d">${esc(t("familyCreator.preview3dUnavailable"))}</div>`) + `</div>`;
    // Views from the engine-resolved parts.
    try {
      const built = deps.buildInEngine(r.family, r.family.types[0]);
      const parts = resolveParts(tpl, built.params);
      html += `<div class="obs-fc-sec"><div class="obs-fc-h">${esc(t("familyCreator.views"))}</div><div data-fc="views">${renderThreeViews(parts, { w: r.spec.widthM, d: r.spec.depthM, h: r.spec.heightM }, { front: t("familyCreator.front"), side: t("familyCreator.side"), top: t("familyCreator.top") })}</div>` +
        `<div class="obs-fc-detail">${esc(t("familyCreator.partsLine", { n: parts.length, names: parts.map((p) => p.name).join(", ") }))}</div></div>`;
    } catch (e) { html += `<div class="obs-fc-detail">${esc(t("familyCreator.viewsUnavailable", { message: (e as Error).message }))}</div>`; }
  }
  if (r.spec?.sources?.length) {
    html += `<div class="obs-fc-sec" data-fc="sources"><div class="obs-fc-h">${esc(t("familyCreator.sources"))}</div>` +
      r.spec.sources.map((c) => `<div class="obs-fc-src"><b>${esc(c.label)}</b> ${Math.round(c.valueM * 1000)} mm` +
        `<div class="obs-fc-detail">${esc(t("familyCreator.sourceLine", { page: c.page, line: c.line, text: c.sourceText }))}</div></div>`).join("") +
      `<div class="obs-fc-detail">${esc(t("familyCreator.sourceCheck"))}</div></div>`;
  }
  if (s.platformReady) {
    html += `<div class="obs-fc-sec"><button type="button" class="obs-fc-btn" data-act="add">${esc(t("familyCreator.add"))}</button> ` +
      (r.ifcText ? `<button type="button" class="obs-fc-btn" data-act="ifc">${esc(t("familyCreator.ifcDownload"))}</button>` : "") + `</div>`;
  }
  return html;
}

function render() {
  if (!panel) return;
  panel.innerHTML = `
    <div class="obs-panel-header"><span>${esc(t("familyCreator.title"))}</span><button type="button" class="obs-icon-btn" data-act="close" aria-label="${esc(t("familyCreator.close"))}">\u00d7</button></div>
    <div class="obs-panel-body">
      <div class="obs-fc-detail" style="margin-bottom:8px">${esc(t("familyCreator.intro"))}</div>
      <input class="obs-fc-in" data-f="name" placeholder="${esc(t("familyCreator.name"))}" value="${esc(form.name)}">
      <div style="display:flex;gap:6px"><input class="obs-fc-in" data-f="manufacturer" placeholder="${esc(t("familyCreator.manufacturer"))}" value="${esc(form.manufacturer)}"><input class="obs-fc-in" data-f="model" placeholder="${esc(t("familyCreator.model"))}" value="${esc(form.model)}"></div>
      <div style="display:flex;gap:6px;align-items:center;margin:3px 0"><label class="obs-fc-btn" style="cursor:pointer">${esc(t("familyCreator.file.choose"))}<input type="file" accept=".pdf,.txt,application/pdf,text/plain" data-fc="file" style="display:none"></label><span class="obs-fc-detail" data-fc="file-note">${esc(form.fileNote)}</span></div>
      <textarea class="obs-fc-in" data-f="text" rows="4" placeholder="${esc(t("familyCreator.textPlaceholder"))}">${esc(form.text)}</textarea>
      <div class="obs-fc-detail">${esc(t("familyCreator.sizeHint"))}</div>
      <div style="display:flex;gap:6px"><input class="obs-fc-in" data-f="wMm" placeholder="${esc(t("familyCreator.w"))}" value="${esc(form.wMm)}"><input class="obs-fc-in" data-f="dMm" placeholder="${esc(t("familyCreator.d"))}" value="${esc(form.dMm)}"><input class="obs-fc-in" data-f="hMm" placeholder="${esc(t("familyCreator.h"))}" value="${esc(form.hMm)}"></div>
      <button type="button" class="obs-fc-btn" data-act="create" style="margin-top:8px">${esc(t("familyCreator.create"))}</button>
      ${notice ? `<div class="obs-fc-detail" data-fc="notice" style="color:#22c55e">${esc(notice)}</div>` : ""}
      ${result ? resultHtml(result) : ""}
    </div>`;
  panel.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-f]").forEach((el) => {
    el.addEventListener("input", () => {
      (form as unknown as Record<string, string>)[el.dataset.f as string] = el.value;
      // Typing replaces the loaded file text, so the run never mixes the two.
      if (el.dataset.f === "text" && form.pages.length) { form.pages = []; form.fileNote = ""; const n = panel?.querySelector('[data-fc="file-note"]'); if (n) n.textContent = ""; }
    });
  });
  panel.querySelectorAll<HTMLElement>("[data-act]").forEach((el) => {
    el.addEventListener("click", () => act(el.dataset.act as string));
  });
  panel.querySelector<HTMLInputElement>('[data-fc="file"]')?.addEventListener("change", (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) void loadFile(f);
  });
  const slot = panel.querySelector<HTMLElement>('[data-fc-slot="preview3d"]');
  if (slot && preview) slot.appendChild(preview.el);
  panel.querySelector('[data-act="fit"]')?.addEventListener("click", () => preview?.fit());
  panel.querySelectorAll<HTMLInputElement>("[data-param]").forEach((el) => {
    el.addEventListener("change", () => editParam(el.dataset.param as string, Number(el.value) / 1000));
  });
}

function editParam(name: string, valueM: number) {
  if (!result?.spec || !Number.isFinite(valueM)) return;
  const spec: ProductSpec = { ...result.spec, params: { ...(result.spec.params ?? {}) } };
  if (name === "Width") spec.widthM = valueM;
  else if (name === "Depth") spec.depthM = valueM;
  else if (name === "Height") spec.heightM = valueM;
  else spec.params![name] = valueM;
  run(spec);
}

function act(a: string) {
  if (a === "close") setVisible(false);
  else if (a === "create") run();
  else if (a === "fit") preview?.fit();
  else if (a === "add" && result?.family) {
    const f = result.family;
    familyStore.create({
      name: f.name, category: f.category, ifcEntity: f.ifcEntity, sourceElementType: f.sourceElementType,
      group: f.group, parameters: f.parameters, geometry: f.geometry, types: f.types,
    } as Parameters<typeof familyStore.create>[0]);
    notice = t("familyCreator.added", { name: f.name });
    render();
  } else if (a === "ifc" && result?.ifcText && result.spec) {
    const blob = new Blob([result.ifcText], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    lastIfcName = `${result.spec.name.replace(/[^A-Za-z0-9._-]+/g, "_")}.ifc`;
    link.href = url; link.download = lastIfcName;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    notice = t("familyCreator.saved", { file: lastIfcName });
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
  if (on) render();
}
export function toggleFamilyCreatorPanel() { setVisible(!visible); }
export function isFamilyCreatorPanelVisible() { return visible; }
export function setupFamilyCreatorPanel() { ensurePanel(); }
