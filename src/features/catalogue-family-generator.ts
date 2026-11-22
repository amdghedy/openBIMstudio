/**
 * BIM Family Generator — first delivery slice.
 *
 * Provides local catalogue intake (CSV/TSV/JSON), review, family creation
 * through the existing project-scoped family service, and a persistent UI
 * entry point. PDF OCR and CAD extraction are intentionally not advertised
 * as available until their adapters are implemented and tested.
 */
import { ctx } from "../core/context";
import { buildCatalogueFamilyDefinition, parseDelimitedCatalogue, validateCatalogueRows, type CatalogueRow } from "../modules/families/catalogue-intake";

type Any = Record<string, any>;
let panel: HTMLDivElement | null = null;
let launch: HTMLButtonElement | null = null;
let rows: CatalogueRow[] = [];
let sourceName = "";
let styleInstalled = false;

function familyService(): Any {
  return (window as Any).__obsFamilyParametric ?? (window as Any).__obsFamily ?? (ctx.features as Any)?.family ?? {};
}
function escapeHtml(value: unknown): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (c) => entities[c]);
}
function status(message: string, kind = "info"): void {
  const el = panel?.querySelector<HTMLElement>("[data-status]");
  if (el) { el.textContent = message; el.dataset.kind = kind; }
  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { kind, message, timeout: 3500 } }));
}
function installStyle(): void {
  if (styleInstalled) return;
  styleInstalled = true;
  const style = document.createElement("style");
  style.textContent = `
#obs-catalogue-family { position:fixed; inset:5vh 4vw 5vh auto; width:min(900px,92vw); z-index:12000; display:none; flex-direction:column; overflow:hidden; color:#e5e7eb; background:#141821; border:1px solid #303746; border-radius:14px; box-shadow:0 24px 80px #0009; font:13px/1.45 Inter,system-ui,sans-serif; }
#obs-catalogue-family.open { display:flex; }
#obs-catalogue-family .cfg-head { display:flex; align-items:center; gap:12px; padding:16px 18px; border-bottom:1px solid #303746; background:#1a202b; }
#obs-catalogue-family .cfg-head strong { font-size:16px; flex:1; }
#obs-catalogue-family button,#obs-catalogue-family input,#obs-catalogue-family select { font:inherit; }
#obs-catalogue-family button { cursor:pointer; border:1px solid #3a4556; border-radius:7px; padding:8px 11px; color:#e5e7eb; background:#232c39; }
#obs-catalogue-family button.primary { background:#155e50; border-color:#16856d; }
#obs-catalogue-family .cfg-body { padding:18px; overflow:auto; display:grid; gap:14px; }
#obs-catalogue-family .cfg-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
#obs-catalogue-family label { display:grid; gap:5px; color:#aeb9c8; font-size:12px; }
#obs-catalogue-family input,#obs-catalogue-family select { min-width:0; width:100%; box-sizing:border-box; padding:9px; color:#f8fafc; background:#0d1118; border:1px solid #364152; border-radius:7px; }
#obs-catalogue-family .cfg-card { padding:13px; border:1px solid #303746; border-radius:10px; background:#191f29; }
#obs-catalogue-family .cfg-table-wrap { overflow:auto; max-height:260px; }
#obs-catalogue-family table { border-collapse:collapse; width:100%; font-size:12px; }
#obs-catalogue-family th,#obs-catalogue-family td { text-align:left; padding:7px 9px; border-bottom:1px solid #303746; white-space:nowrap; }
#obs-catalogue-family th { color:#9caec2; position:sticky; top:0; background:#191f29; }
#obs-catalogue-family .cfg-muted { color:#91a0b3; font-size:12px; }
#obs-catalogue-family [data-status] { padding:10px 12px; border-radius:8px; background:#202a37; color:#cbd5e1; }
#obs-catalogue-family [data-status][data-kind="warn"] { background:#3a2b19; color:#fbbf24; }
#obs-catalogue-family [data-status][data-kind="success"] { background:#12372f; color:#6ee7b7; }
@media(max-width:650px){#obs-catalogue-family{inset:2vh 2vw;width:96vw}#obs-catalogue-family .cfg-grid{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}
function renderRows(): void {
  const host = panel?.querySelector<HTMLElement>("[data-rows]");
  if (!host) return;
  if (!rows.length) { host.innerHTML = '<p class="cfg-muted">No product rows loaded yet. Import a CSV/TSV catalogue to begin.</p>'; return; }
  const keys: (keyof CatalogueRow)[] = ["model","manufacturer","productCode","width","depth","height","airflow","staticPressure","power","voltage"];
  host.innerHTML = `<div class="cfg-table-wrap"><table><thead><tr>${keys.map((k) => `<th>${escapeHtml(k)}</th>`).join("")}</tr></thead><tbody>${rows.map((r,i) => `<tr>${keys.map((k) => `<td>${escapeHtml(r[k] ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div><p class="cfg-muted">${rows.length} product type(s) loaded from ${escapeHtml(sourceName)}. Review the source values before creating a family.</p>`;
}
function buildPanel(): void {
  if (panel) return;
  installStyle();
  panel = document.createElement("section");
  panel.id = "obs-catalogue-family";
  panel.setAttribute("aria-label", "BIM Family Generator");
  panel.innerHTML = `
    <header class="cfg-head"><span aria-hidden="true">▦</span><strong>BIM Family Generator</strong><span class="cfg-muted">Catalogue → Parametric BIM</span><button type="button" data-close aria-label="Close">✕</button></header>
    <div class="cfg-body">
      <div class="cfg-card"><strong>01 · Import catalogue</strong><p class="cfg-muted">Local CSV, TSV or JSON intake. PDF OCR and DWG/STEP extraction are not yet enabled in this first delivery.</p><label>Catalogue file<input data-file type="file" accept=".csv,.tsv,.txt,.json,text/csv,text/tab-separated-values,application/json,text/plain"></label></div>
      <div class="cfg-card"><strong>02 · Family definition</strong><div class="cfg-grid">
        <label>Family name<input data-name value="Manufacturer Equipment"></label>
        <label>Manufacturer<input data-manufacturer placeholder="Manufacturer name"></label>
        <label>Revit / IFC category<select data-category><option value="equipment">Mechanical Equipment</option><option value="generic">Generic Model</option><option value="fitting">Fitting</option></select></label>
        <label>Dimension unit<select data-unit><option value="mm">Millimetres (mm)</option><option value="cm">Centimetres (cm)</option><option value="m">Metres (m)</option></select></label>
      </div></div>
      <div class="cfg-card"><strong>03 · Extracted product types</strong><div data-rows><p class="cfg-muted">No product rows loaded yet.</p></div></div>
      <div class="cfg-card"><strong>04 · Quality review</strong><div data-qa class="cfg-muted">Import a catalogue to run completeness checks.</div></div>
      <div data-status role="status" aria-live="polite">Ready. Files are processed locally in this browser.</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button type="button" data-clear>Clear</button><button type="button" class="primary" data-create>Create parametric family</button></div>
    </div>`;
  document.body.appendChild(panel);
  panel.querySelector("[data-close]")?.addEventListener("click", closeCatalogueFamilyGenerator);
  panel.querySelector("[data-clear]")?.addEventListener("click", () => { rows = []; sourceName = ""; renderRows(); const qa = panel?.querySelector<HTMLElement>("[data-qa]"); if (qa) qa.textContent = "Import a catalogue to run completeness checks."; status("Catalogue cleared."); });
  panel.querySelector("[data-file]")?.addEventListener("change", (event) => { void readCatalogue((event.target as HTMLInputElement).files?.[0]); });
  panel.querySelector("[data-create]")?.addEventListener("click", createFamily);
}
async function readCatalogue(file?: File): Promise<void> {
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) { status("File exceeds the 15 MB intake limit.", "warn"); return; }
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!["csv","tsv","txt","json"].includes(ext ?? "")) { status("This first delivery supports CSV, TSV, TXT and JSON. PDF/DWG/STEP import adapters are planned, not silently simulated.", "warn"); return; }
  try {
    const raw = await file.text();
    let parsed: { rows: CatalogueRow[]; errors: string[] };
    if (ext === "json") {
      const value = JSON.parse(raw);
      const items = Array.isArray(value) ? value : value.products;
      if (!Array.isArray(items)) throw new Error("JSON must contain an array of product objects or a products array.");
      parsed = { rows: items.map((item: Any) => ({ ...item, model: String(item.model ?? item.modelNumber ?? item.type ?? "") })), errors: [] };
      if (parsed.rows.some((r) => !r.model.trim())) throw new Error("Every JSON product must have a model, modelNumber or type field.");
    } else {
      const result = parseDelimitedCatalogue(raw, ext === "tsv" ? "\t" : undefined);
      parsed = { rows: result.rows, errors: result.errors };
    }
    rows = parsed.rows;
    sourceName = file.name;
    renderRows();
    const issues = [...parsed.errors, ...validateCatalogueRows(rows)];
    const qa = panel?.querySelector<HTMLElement>("[data-qa]");
    if (qa) qa.textContent = issues.length ? issues.join(" ") : "Required dimensions are present in every product row. Source values still require engineering verification.";
    status(`Loaded ${rows.length} product type(s) from ${file.name}.`, rows.length ? "success" : "warn");
  } catch (error) {
    rows = [];
    renderRows();
    status(error instanceof Error ? error.message : "Could not read catalogue.", "warn");
  }
}
function createFamily(): void {
  if (!rows.length) { status("Import at least one catalogue product before creating a family.", "warn"); return; }
  const svc = familyService();
  if (typeof svc.create !== "function") { status("The existing family service is not ready. Retry after the BIM authoring engine finishes booting.", "warn"); return; }
  const name = panel?.querySelector<HTMLInputElement>("[data-name]")?.value ?? "";
  const manufacturer = panel?.querySelector<HTMLInputElement>("[data-manufacturer]")?.value.trim() ?? "";
  const category = (panel?.querySelector<HTMLSelectElement>("[data-category]")?.value ?? "equipment") as "equipment" | "generic" | "fitting";
  const unit = (panel?.querySelector<HTMLSelectElement>("[data-unit]")?.value ?? "mm") as "mm" | "cm" | "m";
  const reviewedRows = rows.map((r) => ({ ...r, manufacturer: r.manufacturer || manufacturer || undefined }));
  try {
    const definition = buildCatalogueFamilyDefinition(reviewedRows, { name, category, dimensionUnit: unit });
    const family = svc.create(definition);
    if (!family?.id) throw new Error("Family service did not return a saved family ID.");
    status(`Created "${family.name}" with ${family.types.length} type(s) in the existing project family library. Geometry is currently a dimension-driven bounding-box template; detailed product geometry and native RFA export are later phases.`, "success");
    window.dispatchEvent(new CustomEvent("obs:catalogue-family-created", { detail: { familyId: family.id, sourceName, typeCount: family.types.length } }));
  } catch (error) {
    status(error instanceof Error ? error.message : "Family creation failed.", "warn");
  }
}
export function openCatalogueFamilyGenerator(): void { buildPanel(); panel?.classList.add("open"); }
export function closeCatalogueFamilyGenerator(): void { panel?.classList.remove("open"); }
export function setupCatalogueFamilyGenerator(): void {
  if (launch) return;
  launch = document.createElement("button");
  launch.id = "obs-catalogue-family-launch";
  launch.type = "button";
  launch.textContent = "BFG";
  launch.title = "BIM Family Generator — catalogue to parametric family";
  launch.setAttribute("aria-label", launch.title);
  launch.style.cssText = "position:fixed;left:218px;bottom:52px;z-index:10002;height:40px;min-width:48px;padding:0 10px;border-radius:10px;border:1px solid #8b5cf6;background:rgba(139,92,246,.16);color:#c4b5fd;font:700 11px Inter,system-ui;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35);";
  launch.addEventListener("click", openCatalogueFamilyGenerator);
  document.body.appendChild(launch);
  (window as Any).__obsCatalogueFamilyGenerator = { open: openCatalogueFamilyGenerator, close: closeCatalogueFamilyGenerator };
  void import("./command-palette").then((m) => m.registerCommand?.({
    id: "family.catalogueGenerator", label: "BIM Family Generator", category: "Architecture",
    run: openCatalogueFamilyGenerator,
  })).catch(() => undefined);
}
