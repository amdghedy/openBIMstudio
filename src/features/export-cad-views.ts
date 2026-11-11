/**
 * Export > CAD Formats — turns the project's plan / section / elevation views into DXF or DWG drawings
 * (the Revit "Export > CAD Formats > DWG/DXF" workflow). One view → one file; several → a ZIP of files.
 */
import { listViews, getView, createView, updateView } from "../modules/views/store";
import type { ViewDef } from "../modules/views/types";
import { sceneToDxfDocument, cadFileName, SCENE_LAYER_NAMES, type CadUnits } from "../modules/export/view-to-cad";
import { zipStore, type ZipFile } from "../modules/export/zip-store";
import { writeDxf, DWG_VERSIONS, DEFAULT_DWG_VERSION, type DwgVersionCode } from "../modules/drawings/dxf-writer";
import { getLevels, getElements, getSelectedIds } from "./authoring";
import { meshesToDxf3d, layerForElementType, type MeshInput } from "../modules/export/model-to-dxf3d";
import { registerCommand } from "./command-palette";
import { uiAlert } from "../core/notify";

const EXPORTABLE = new Set(["plan", "rcp", "section", "elevation"]);

export interface CadExportRequest {
  viewIds: string[];
  format: "dxf" | "dwg";
  units: CadUnits;
  layerPrefix: string;
  dwgVersion: DwgVersionCode;
  include: Record<string, boolean>;
  title: boolean;
}

export interface CadExportResult { files: ZipFile[]; notes: string[] }

/** Build the files for a request (no download). */
export async function buildCadExport(req: CadExportRequest): Promise<CadExportResult> {
  const { sceneForView } = await import("../modules/export/batch-plotter");
  const files: ZipFile[] = [];
  const notes: string[] = [];
  const used = new Set<string>();
  for (const id of req.viewIds) {
    const view = getView(id);
    if (!view || !EXPORTABLE.has(view.kind)) { notes.push(`Skipped ${view?.name ?? id}: this view type cannot be exported.`); continue; }
    const scene = await sceneForView(id);
    const { doc, stats } = sceneToDxfDocument(scene, { units: req.units, layerPrefix: req.layerPrefix, scale: view.scale, include: req.include as any, title: req.title ? view.name : null });
    if (!stats.entities) { notes.push(`${view.name}: the view is empty (no geometry), so no file was written.`); continue; }
    const skipped = Object.entries(stats.skipped).map(([k, n]) => `${n} ${k}`).join(", ");
    if (skipped) notes.push(`${view.name}: skipped ${skipped}.`);
    const dxf = writeDxf(doc, { version: req.dwgVersion });
    if (req.format === "dxf") {
      files.push({ name: cadFileName(view.name, "dxf", used), data: new TextEncoder().encode(dxf) });
    } else {
      const { exportDxfToDwg } = await import("../modules/drawings/acad-engine");
      files.push({ name: cadFileName(view.name, "dwg", used), data: await exportDxfToDwg(dxf) });
    }
  }
  return { files, notes };
}

/** Collect the authored elements' visible meshes from the 3D scene, grouped on layers by element type. */
export function collectModelMeshes(opts: { selectedOnly: boolean; visibleOnly: boolean }): { meshes: MeshInput[]; elements: number } {
  const ctx: any = (window as any).__OBS_CTX__;
  const scene = ctx?.world?.scene?.three;
  if (!scene) return { meshes: [], elements: 0 };
  const types = new Map<string, string>(getElements().map((e: any) => [e.id, e.type]));
  const selected = new Set<string>(getSelectedIds());
  const meshes: MeshInput[] = [];
  const seen = new Set<string>();
  scene.updateMatrixWorld(true);
  scene.traverse((o: any) => {
    if (!o.isMesh || !o.geometry || o.isInstancedMesh) return;
    let id: string | undefined; let visible = true;
    for (let p = o; p; p = p.parent) { if (id === undefined && p.userData?.elementId) id = p.userData.elementId; if (p.visible === false) visible = false; }
    if (!id || !types.has(id)) return;
    if (opts.visibleOnly && !visible) return;
    if (opts.selectedOnly && !selected.has(id)) return;
    const pos = o.geometry.getAttribute("position");
    if (!pos) return;
    seen.add(id);
    meshes.push({ layer: layerForElementType(types.get(id)), positions: pos.array as ArrayLike<number>, index: o.geometry.index ? (o.geometry.index.array as ArrayLike<number>) : null, matrix: o.matrixWorld.elements });
  });
  return { meshes, elements: seen.size };
}

function download(name: string, bytes: Uint8Array, type: string): void {
  const buf = new ArrayBuffer(bytes.byteLength); new Uint8Array(buf).set(bytes);
  const url = URL.createObjectURL(new Blob([buf], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Create a plan per level and the four elevations when the project has no exportable views yet. */
export function createStandardViews(): number {
  let n = 0;
  const levels = getLevels();
  const list = levels.length ? levels : [{ id: "level-0", name: "Level 0", elevation: 0 }];
  for (const lv of list) {
    const v = createView("plan", `Plan - ${lv.name}`, "ARC");
    updateView(v.id, { plan: { ...v.plan!, levelId: lv.id, levelElevation: lv.elevation } }); n++;
  }
  for (const d of ["north", "south", "east", "west"] as const) {
    const v = createView("elevation", `Elevation - ${d[0].toUpperCase()}${d.slice(1)}`, "ARC");
    updateView(v.id, { elevation: { ...v.elevation!, direction: d } }); n++;
  }
  return n;
}

export function openExportCadDialog(): void {
  document.getElementById("obs-export-cad")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "obs-export-cad";
  overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.65);display:flex;align-items:center;justify-content:center";
  const card = document.createElement("div");
  card.setAttribute("role", "dialog"); card.setAttribute("aria-label", "Export CAD formats");
  card.style.cssText = "background:#1e293b;color:#f8fafc;border-radius:12px;width:640px;max-width:95vw;max-height:88vh;overflow:auto;padding:18px 20px;font:13px system-ui;box-shadow:0 20px 50px rgba(0,0,0,.5)";
  overlay.appendChild(card);
  const inp = "background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:6px;padding:5px 8px;font:12px system-ui";

  const render = () => {
    const views = listViews().filter((v) => EXPORTABLE.has(v.kind));
    const layerChecks = (Object.keys(SCENE_LAYER_NAMES) as Array<keyof typeof SCENE_LAYER_NAMES>)
      .map((k) => `<label style="display:inline-flex;gap:4px;margin-right:10px"><input type="checkbox" data-layer="${k}" checked> ${SCENE_LAYER_NAMES[k].name}</label>`).join("");
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0;font-size:16px">Export › CAD Formats</h2><button data-close style="${inp};cursor:pointer">✕</button></div>
      <p style="opacity:.75;margin:6px 0 12px">Export plan, section and elevation views as DXF or DWG drawings, one file per view.</p>
      <div style="font-weight:600;margin-bottom:4px">Views to export</div>
      ${views.length ? `<div style="max-height:190px;overflow:auto;border:1px solid #334155;border-radius:6px;padding:6px">${views.map((v: ViewDef) =>
        `<label style="display:flex;gap:8px;padding:3px 2px"><input type="checkbox" data-view="${v.id}" checked> <span>${esc(v.name)}</span><span style="opacity:.55;margin-left:auto">${v.kind} · 1:${v.scale}</span></label>`).join("")}</div>` :
        `<div style="padding:12px;border:1px dashed #475569;border-radius:6px;text-align:center">This project has no plan, section or elevation views yet.<br><button data-make style="${inp};margin-top:8px;cursor:pointer">Create a plan per level + 4 elevations</button></div>`}
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;margin-top:14px">
        <label>Format</label><select data-format style="${inp}"><option value="dwg">DWG (AutoCAD drawing)</option><option value="dxf">DXF (exchange format)</option></select>
        <label>DWG / DXF version</label><select data-version style="${inp}">${DWG_VERSIONS.map((v) => `<option value="${v.code}" ${v.code === DEFAULT_DWG_VERSION ? "selected" : ""}>${v.label}</option>`).join("")}</select>
        <label>Units</label><select data-units style="${inp}"><option value="mm">Millimetres</option><option value="m">Metres</option></select>
        <label>Layer prefix</label><input data-prefix style="${inp}" placeholder="optional, e.g. ARC-" maxlength="20">
        <label>Layers</label><div>${layerChecks}</div>
        <label>View title</label><label><input type="checkbox" data-title checked> Add the view name and scale under the drawing</label>
      </div>
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid #334155">
        <div style="font-weight:600;margin-bottom:4px">3D model → DXF (3D faces)</div>
        <div style="opacity:.75;margin-bottom:6px">The authored 3D model as 3DFACE triangles on layers by element type (wall, slab, column…), Z up. Uses the units above. DXF only.</div>
        <label style="margin-right:12px"><input type="checkbox" data-3d-sel> Selected elements only</label>
        <label style="margin-right:12px"><input type="checkbox" data-3d-vis checked> Visible only</label>
        <button data-go3d style="${inp};cursor:pointer">Export 3D model DXF</button>
      </div>
      <div data-msg style="min-height:18px;margin-top:12px;font-size:12px;white-space:pre-wrap"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
        <button data-close style="${inp};cursor:pointer">Cancel</button>
        <button data-go style="background:#2563eb;color:#fff;border:0;border-radius:6px;padding:7px 16px;font:600 12px system-ui;cursor:pointer" ${views.length ? "" : "disabled"}>Export</button>
      </div>`;
    const q = <T extends Element>(s: string) => card.querySelector(s) as T;
    card.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => overlay.remove()));
    q<HTMLButtonElement>("[data-go3d]").addEventListener("click", () => {
      const msg = q<HTMLElement>("[data-msg]");
      try {
        const { meshes, elements } = collectModelMeshes({ selectedOnly: q<HTMLInputElement>("[data-3d-sel]").checked, visibleOnly: q<HTMLInputElement>("[data-3d-vis]").checked });
        const r = meshesToDxf3d(meshes, { units: q<HTMLSelectElement>("[data-units]").value as CadUnits, layerPrefix: q<HTMLInputElement>("[data-prefix]").value.replace(/[^A-Za-z0-9_\-$]/g, "").slice(0, 20) });
        if (!r.faces) { msg.style.color = "#fbbf24"; msg.textContent = "No authored 3D elements to export" + (q<HTMLInputElement>("[data-3d-sel]").checked ? " (nothing selected?)." : ". Imported IFC/Revit models are not included."); return; }
        download("openbimstudio-model-3d.dxf", new TextEncoder().encode(r.dxf), "application/dxf");
        msg.style.color = "#86efac";
        msg.textContent = `Exported ${r.faces} 3D faces from ${elements} element(s) on ${Object.keys(r.byLayer).length} layer(s).` + (r.skippedDegenerate ? `\n${r.skippedDegenerate} degenerate triangle(s) skipped.` : "");
      } catch (e) { msg.style.color = "#fca5a5"; msg.textContent = "3D export failed: " + (e instanceof Error ? e.message : String(e)); }
    });
    q<HTMLButtonElement>("[data-make]")?.addEventListener("click", () => { createStandardViews(); render(); });
    q<HTMLButtonElement>("[data-go]").addEventListener("click", async () => {
      const msg = q<HTMLElement>("[data-msg]"), go = q<HTMLButtonElement>("[data-go]");
      const ids = Array.from(card.querySelectorAll<HTMLInputElement>("[data-view]:checked")).map((c) => c.dataset.view!);
      if (!ids.length) { msg.style.color = "#fbbf24"; msg.textContent = "Select at least one view."; return; }
      const include: Record<string, boolean> = {};
      card.querySelectorAll<HTMLInputElement>("[data-layer]").forEach((c) => { include[c.dataset.layer!] = c.checked; });
      const req: CadExportRequest = {
        viewIds: ids, format: q<HTMLSelectElement>("[data-format]").value as "dxf" | "dwg", units: q<HTMLSelectElement>("[data-units]").value as CadUnits,
        layerPrefix: q<HTMLInputElement>("[data-prefix]").value.replace(/[^A-Za-z0-9_\-$]/g, "").slice(0, 20),
        dwgVersion: q<HTMLSelectElement>("[data-version]").value as DwgVersionCode, include, title: q<HTMLInputElement>("[data-title]").checked,
      };
      go.disabled = true; msg.style.color = "#cbd5e1"; msg.textContent = "Exporting…";
      try {
        const r = await buildCadExport(req);
        if (!r.files.length) { msg.style.color = "#fbbf24"; msg.textContent = r.notes.join("\n") || "Nothing to export."; return; }
        if (r.files.length === 1) download(r.files[0].name, r.files[0].data, req.format === "dwg" ? "application/acad" : "application/dxf");
        else download("openbimstudio-cad-export.zip", zipStore(r.files), "application/zip");
        msg.style.color = "#86efac";
        msg.textContent = `Exported ${r.files.length} ${req.format.toUpperCase()} file(s)${r.files.length > 1 ? " in a ZIP" : ""}.` + (r.notes.length ? "\n" + r.notes.join("\n") : "");
      } catch (e) {
        msg.style.color = "#fca5a5"; msg.textContent = "Export failed: " + (e instanceof Error ? e.message : String(e));
      } finally { go.disabled = false; }
    });
  };
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") overlay.remove(); });
  render();
  document.body.appendChild(overlay);
}

export function setupExportCadViews(): void {
  registerCommand({ id: "export.cad_views", label: "Export: Views to CAD (DWG / DXF)", category: "Export", hint: "Export plan, section and elevation views as DWG or DXF, like Revit's Export > CAD Formats", run: () => { try { openExportCadDialog(); } catch (e) { uiAlert("Export CAD failed: " + (e instanceof Error ? e.message : String(e))); } } });
}
