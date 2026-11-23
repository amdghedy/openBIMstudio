/**
 * BIM Family Generator — first delivery slice.
 *
 * Provides local catalogue intake (XLSX/CSV/TSV/JSON/PDF), optional local Ollama
 * vision OCR for scanned PDF pages, review, and family creation through the
 * existing project-scoped family service. CAD extraction remains unavailable.
 */
import { ctx } from "../core/context";
import { buildCatalogueFamilyDefinition, mapCatalogueHeader, parseCatalogueMappingProfile, parseDelimitedCatalogue, suggestCatalogueMappings, validateCatalogueRows, normalizeCatalogueRowsWithUnits, type CatalogueColumnUnitOverrides, type CatalogueField, type CatalogueMappingOverrides, type CatalogueMappingProfile, type CatalogueRow } from "../modules/families/catalogue-intake";
import { extractPdfCatalogue } from "../modules/families/pdf-catalogue-extractor";
import { extractXlsxCatalogue, listXlsxWorksheets } from "../modules/families/xlsx-catalogue-extractor";
import { z } from "zod";
import { safeLoad } from "../core/safeLoad";

const CatalogueJsonSchema = z.union([
  z.array(z.record(z.string(), z.unknown())).max(10_000),
  z.object({ products: z.array(z.record(z.string(), z.unknown())).max(10_000) }).passthrough(),
]);

type Any = Record<string, any>;
let panel: HTMLElement | null = null;
let launch: HTMLButtonElement | null = null;
let rows: CatalogueRow[] = [];
let sourceName = "";
let pendingXlsxFile: File | null = null;
let pendingPdfFile: File | null = null;
let delimitedSourceText = "";
let delimitedSourceDelimiter: string | undefined;
let delimitedHeaders: string[] = [];
let mappingOverrides: CatalogueMappingOverrides = {};
const MAPPING_PROFILE_KEY = "obs.catalogue-mapping-profiles.v1";
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
#obs-catalogue-family .cfg-map-grid { display:grid;grid-template-columns:minmax(150px,1fr) minmax(170px,1fr) minmax(160px,1.2fr);gap:8px;align-items:center;margin:7px 0; }
#obs-catalogue-family .cfg-map-grid select { padding:7px; }
#obs-catalogue-family .cfg-map-grid small { color:#91a0b3;font-size:10px; }
#obs-catalogue-family .cfg-profile-actions { display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-top:10px; }
#obs-catalogue-family .cfg-profile-actions label { flex:1;min-width:150px; }
#obs-catalogue-family [data-status] { padding:10px 12px; border-radius:8px; background:#202a37; color:#cbd5e1; }
#obs-catalogue-family [data-status][data-kind="warn"] { background:#3a2b19; color:#fbbf24; }
#obs-catalogue-family [data-status][data-kind="success"] { background:#12372f; color:#6ee7b7; }
@media(max-width:650px){#obs-catalogue-family{inset:2vh 2vw;width:96vw}#obs-catalogue-family .cfg-grid{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}
const MAPPING_FIELDS: Array<[CatalogueField, string]> = [
  ["model", "Model / Type identifier"], ["manufacturer", "Manufacturer / Brand"],
  ["productCode", "Product code / SKU"], ["width", "Width"], ["depth", "Depth / Length"],
  ["height", "Height"], ["airflow", "Airflow"], ["staticPressure", "Static pressure"],
  ["power", "Power"], ["voltage", "Voltage"],
];

function readMappingProfiles(): CatalogueMappingProfile[] {
  try {
    const raw = localStorage.getItem(MAPPING_PROFILE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 100).flatMap((item) => {
      try { return [parseCatalogueMappingProfile(item)]; }
      catch (error) { console.warn("[catalogue-family] skipping invalid mapping profile:", error); return []; }
    });
  } catch (error) {
    console.warn("[catalogue-family] mapping profiles could not be loaded:", error);
    return [];
  }
}
function writeMappingProfiles(profiles: CatalogueMappingProfile[]): void {
  try {
    localStorage.setItem(MAPPING_PROFILE_KEY, JSON.stringify(profiles.slice(0, 100)));
  } catch {
    throw new Error("Could not save mapping profiles. Browser storage may be unavailable or full; export a profile to keep a portable copy.");
  }
}
function renderMappingProfiles(): void {
  const select = panel?.querySelector<HTMLSelectElement>("[data-profile-select]");
  if (!select) return;
  const selected = select.value;
  const profiles = readMappingProfiles();
  select.innerHTML = '<option value="">Choose saved profile…</option>' + profiles
    .map((profile, index) => `<option value="${index}">${escapeHtml(profile.name)}${profile.manufacturer ? " · " + escapeHtml(profile.manufacturer) : ""}</option>`)
    .join("");
  if (selected && profiles[Number(selected)]) select.value = selected;
}
function saveMappingProfile(): void {
  if (!delimitedHeaders.length) { status("Import a catalogue with identifiable source columns before saving a mapping profile.", "warn"); return; }
  const name = panel?.querySelector<HTMLInputElement>("[data-profile-name]")?.value.trim() ?? "";
  if (!name) { status("Enter a name for this mapping profile.", "warn"); return; }
  const manufacturer = panel?.querySelector<HTMLInputElement>("[data-manufacturer]")?.value.trim() ?? "";
  const mappings: CatalogueMappingOverrides = Object.create(null) as CatalogueMappingOverrides;
  for (const header of delimitedHeaders) {
    mappings[header] = Object.prototype.hasOwnProperty.call(mappingOverrides, header)
      ? mappingOverrides[header] ?? null
      : mapCatalogueHeader(header) ?? null;
  }
  const profile = parseCatalogueMappingProfile({
    schemaVersion: 1, name, manufacturer, mappings, updatedAt: new Date().toISOString(),
  });
  const profiles = readMappingProfiles();
  const existing = profiles.findIndex((item) => item.name.toLowerCase() === name.toLowerCase()
    && (item.manufacturer ?? "").toLowerCase() === manufacturer.toLowerCase());
  if (existing >= 0) profiles[existing] = profile;
  else profiles.unshift(profile);
  writeMappingProfiles(profiles);
  renderMappingProfiles();
  status(`Saved mapping profile "${profile.name}" for reuse.`, "success");
}
function applyMappingProfile(): void {
  const select = panel?.querySelector<HTMLSelectElement>("[data-profile-select]");
  const index = Number(select?.value);
  const profile = readMappingProfiles()[index];
  if (!profile || !delimitedHeaders.length) { status("Select a saved profile and import a catalogue with source columns first.", "warn"); return; }
  mappingOverrides = { ...profile.mappings };
  for (const header of Object.keys(mappingOverrides)) {
    if (!delimitedHeaders.includes(header)) delete mappingOverrides[header];
  }
  const manufacturerInput = panel?.querySelector<HTMLInputElement>("[data-manufacturer]");
  if (manufacturerInput && profile.manufacturer) manufacturerInput.value = profile.manufacturer;
  renderMappingReview();
  if (pendingXlsxFile) {
    const sheetName = panel?.querySelector<HTMLSelectElement>("[data-sheet]")?.value;
    if (sheetName) void readCatalogue(pendingXlsxFile, sheetName);
  } else if (pendingPdfFile) void readCatalogue(pendingPdfFile);
  else if (delimitedSourceText) reparseDelimitedSource();
  status(`Applied mapping profile "${profile.name}". Review all unmatched headings and QA warnings.`, "success");
}
function exportMappingProfile(): void {
  const select = panel?.querySelector<HTMLSelectElement>("[data-profile-select]");
  const profile = readMappingProfiles()[Number(select?.value)];
  if (!profile) { status("Select a saved profile to export.", "warn"); return; }
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = profile.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".catalogue-mapping.json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  status("Mapping profile export prepared.", "success");
}
async function importMappingProfile(file?: File): Promise<void> {
  if (!file) return;
  if (file.size > 256 * 1024) { status("Mapping profile exceeds the 256 KB import limit.", "warn"); return; }
  try {
    const profile = parseCatalogueMappingProfile(JSON.parse(await file.text()));
    const profiles = readMappingProfiles();
    const existing = profiles.findIndex((item) => item.name.toLowerCase() === profile.name.toLowerCase()
      && (item.manufacturer ?? "").toLowerCase() === (profile.manufacturer ?? "").toLowerCase());
    if (existing >= 0) profiles[existing] = profile;
    else profiles.unshift(profile);
    writeMappingProfiles(profiles);
    renderMappingProfiles();
    status(`Imported mapping profile "${profile.name}". Apply it to a catalogue after import.`, "success");
  } catch (error) {
    status(error instanceof Error ? error.message : "Could not import mapping profile.", "warn");
  }
}
function renderMappingReview(): void {
  const card = panel?.querySelector<HTMLElement>("[data-mapping]");
  const host = panel?.querySelector<HTMLElement>("[data-mapping-rows]");
  if (!card || !host) return;
  if (!delimitedHeaders.length) { card.hidden = true; host.innerHTML = ""; return; }
  card.hidden = false;
  const suggestions = suggestCatalogueMappings(delimitedHeaders);
  host.innerHTML = suggestions.map((suggestion) => {
    const hasOverride = Object.prototype.hasOwnProperty.call(mappingOverrides, suggestion.sourceHeader);
    const current = hasOverride ? (mappingOverrides[suggestion.sourceHeader] ?? "__ignore__") : "__auto__";
    const suggestionText = suggestion.suggestedField
      ? suggestion.suggestedField + " · " + suggestion.confidence + " confidence"
      : "No reliable match";
    return `<div class="cfg-map-grid"><span title="${escapeHtml(suggestion.sourceHeader)}">${escapeHtml(suggestion.sourceHeader)}</span><label><select data-mapping-header="${escapeHtml(suggestion.sourceHeader)}"><option value="__auto__" ${current === "__auto__" ? "selected" : ""}>Automatic mapping</option><option value="__ignore__" ${current === "__ignore__" ? "selected" : ""}>Keep as source field</option>${MAPPING_FIELDS.map(([field,label]) => `<option value="${field}" ${current === field ? "selected" : ""}>${label}</option>`).join("")}</select></label><small>${escapeHtml(suggestion.reason)} · ${escapeHtml(suggestionText)}</small></div>`;
  }).join("");
}
function reparseDelimitedSource(): void {
  if (!delimitedSourceText) return;
  const parsed = parseDelimitedCatalogue(delimitedSourceText, delimitedSourceDelimiter, mappingOverrides);
  rows = parsed.rows;
  renderRows();
  const issues = [...parsed.errors, ...validateCatalogueRows(rows)];
  const qa = panel?.querySelector<HTMLElement>("[data-qa]");
  if (qa) qa.textContent = issues.length ? issues.join(" ") : `Mapped and loaded ${rows.length} product type(s). Verify all source values and units before family creation.`;
  status(`Catalogue remapped: ${rows.length} product type(s); ${parsed.errors.length} import warning(s).`, parsed.errors.length ? "warn" : "success");
}
function renderQualityDashboard(importWarnings: string[] = []): void {
  const host = panel?.querySelector<HTMLElement>("[data-qa]");
  if (!host) return;
  const required = ["width", "depth", "height"] as const;
  const duplicateModels = new Set<string>();
  const seen = new Set<string>();
  const rowIssues: Array<{ row: CatalogueRow; index: number; message: string; severity: "blocking" | "advisory" }> = [];
  let complete = 0;
  rows.forEach((row, index) => {
    const model = String(row.model ?? "").trim().toLowerCase();
    if (!model) rowIssues.push({ row, index, message: "Missing model identifier", severity: "blocking" });
    else if (seen.has(model)) { duplicateModels.add(model); rowIssues.push({ row, index, message: "Duplicate model identifier", severity: "blocking" }); }
    seen.add(model);
    const missing = required.filter((key) => row[key] === undefined || !Number.isFinite(row[key]) || Number(row[key]) <= 0);
    if (missing.length) for (const key of missing) rowIssues.push({ row, index, message: "Invalid or missing " + key, severity: "blocking" });
    if (!missing.length && model) complete++;
    if (!row.sourceRow && !row.sourcePage) rowIssues.push({ row, index, message: "No source row/page provenance recorded", severity: "advisory" });
  });
  const blocking = rowIssues.filter((issue) => issue.severity === "blocking").length;
  const completeness = rows.length ? Math.round(complete / rows.length * 100) : 0;
  const warningHtml = importWarnings.map((warning) => '<li>' + escapeHtml(warning) + '</li>').join("");
  const issueHtml = rowIssues.slice(0, 100).map((issue) => {
    const source = issue.row.sourcePage ? "PDF page " + issue.row.sourcePage : issue.row.sourceSheet ? issue.row.sourceSheet + " row " + (issue.row.sourceRow ?? "?") : "row " + (issue.row.sourceRow ?? issue.index + 2);
    return '<tr><td>' + (issue.severity === "blocking" ? "BLOCK" : "REVIEW") + '</td><td>' + escapeHtml(issue.row.model || "—") + '</td><td>' + escapeHtml(issue.message) + '</td><td>' + escapeHtml(source) + '</td></tr>';
  }).join("");
  host.innerHTML = '<div class="cfg-grid"><div><strong>' + rows.length + '</strong><div class="cfg-muted">Product types</div></div><div><strong>' + completeness + '%</strong><div class="cfg-muted">Geometry complete</div></div><div><strong>' + blocking + '</strong><div class="cfg-muted">Blocking issues</div></div><div><strong>' + importWarnings.length + '</strong><div class="cfg-muted">Import warnings</div></div></div>' +
    (warningHtml ? '<details open><summary>Import warnings (' + importWarnings.length + ')</summary><ul>' + warningHtml + '</ul></details>' : '') +
    (issueHtml ? '<div class="cfg-table-wrap"><table><thead><tr><th>Severity</th><th>Model</th><th>Issue</th><th>Source</th></tr></thead><tbody>' + issueHtml + '</tbody></table></div>' : '<p class="cfg-muted">No row-level QA issues found. Engineering review of source values and units is still required.</p>') +
    (blocking ? '<p class="cfg-muted">Family creation is blocked until all blocking issues are corrected.</p>' : '<p class="cfg-muted">Automated checks passed; verify engineering values against the manufacturer source.</p>');
}
function renderRows(): void {
  const host = panel?.querySelector<HTMLElement>("[data-rows]");
  if (!host) return;
  if (!rows.length) { host.innerHTML = '<p class="cfg-muted">No product rows loaded yet. Import a manufacturer catalogue to begin.</p>'; return; }
  const fixedKeys: (keyof CatalogueRow)[] = ["model","manufacturer","productCode","width","depth","height","airflow","staticPressure","power","voltage","sourceSheet","sourceRow","sourcePage"];
  const extraKeys = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).filter((key) => !fixedKeys.includes(key));
  const keys = [...fixedKeys, ...extraKeys];
  host.innerHTML = `<div class="cfg-table-wrap"><table><thead><tr>${keys.map((k) => `<th>${escapeHtml(k)}</th>`).join("")}</tr></thead><tbody>${rows.map((r,i) => `<tr>${keys.map((k) => `<td>${escapeHtml(r[k] ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div><p class="cfg-muted">${rows.length} product type(s) loaded from ${escapeHtml(sourceName)}. Review the source values before creating a family.</p>`;
}
function buildPanel(): void {
  if (panel) return;
  installStyle();
  const root = document.createElement("section");
  root.id = "obs-catalogue-family";
  root.setAttribute("aria-label", "BIM Family Generator");
  root.innerHTML = `
    <header class="cfg-head"><span aria-hidden="true">▦</span><strong>BIM Family Generator</strong><span class="cfg-muted">Catalogue → Parametric BIM</span><button type="button" data-close aria-label="Close">✕</button></header>
    <div class="cfg-body">
      <div class="cfg-card"><strong>01 · Import catalogue</strong><p class="cfg-muted">Local XLSX, CSV, TSV, TXT, JSON and PDF text extraction. Scanned PDF pages can use your configured local Ollama vision model; no cloud OCR is used.</p><label>Catalogue file<input data-file type="file" accept=".xlsx,.csv,.tsv,.txt,.json,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/tab-separated-values,application/json,text/plain,application/pdf"></label><label style="display:flex;grid-template-columns:auto 1fr;align-items:center;gap:8px"><input data-ocr type="checkbox" style="width:auto"> Run local vision OCR on scanned PDF pages (requires a vision-capable Ollama model)</label></div>
      <div class="cfg-card" data-mapping hidden><strong>02 · Review column mappings</strong><p class="cfg-muted">Auto-recognized headings are mapped automatically. Suggested matches are advisory only; confirm them manually. Ambiguous mappings block affected fields until resolved.</p><div data-mapping-rows></div><div class="cfg-profile-actions"><label>Profile name<input data-profile-name placeholder="e.g. Manufacturer AHU catalogue"></label><label>Saved profiles<select data-profile-select><option value="">Choose saved profile…</option></select></label><button type="button" data-save-profile>Save profile</button><button type="button" data-apply-profile>Apply</button><button type="button" data-export-profile>Export JSON</button><label>Import profile JSON<input data-import-profile type="file" accept=".json,application/json"></label></div></div>
      <div class="cfg-card" data-xlsx-selection hidden><strong>Choose worksheet</strong><div class="cfg-grid"><label>Worksheet<select data-sheet></select></label><div style="display:flex;align-items:end"><button type="button" data-import-sheet class="primary">Import selected worksheet</button></div></div><p class="cfg-muted">Choose the worksheet containing the manufacturer product schedule.</p></div>
      <div class="cfg-card"><strong>03 · Family definition</strong><div class="cfg-grid">
        <label>Family name<input data-name value="Manufacturer Equipment"></label>
        <label>Manufacturer<input data-manufacturer placeholder="Manufacturer name"></label>
        <label>Revit / IFC category<select data-category><option value="equipment">Mechanical Equipment</option><option value="generic">Generic Model</option><option value="fitting">Fitting</option></select></label>
        <label>Dimension unit<select data-unit><option value="mm">Millimetres (mm)</option><option value="cm">Centimetres (cm)</option><option value="m">Metres (m)</option></select></label>
      </div><label>Engineering source units per mapped column (optional JSON object; target dimensions use the selected family unit; performance targets are m³/h, Pa, kW and V)<textarea data-column-units rows="3" placeholder='{"width":"in","airflow":"L/s","staticPressure":"kPa","power":"W","voltage":"kV"}'></textarea><p class="cfg-muted">Supported: dimensions mm/cm/m/in/ft; airflow m³/h, m³/s, L/s, L/min; pressure Pa/kPa/bar; power W/kW; voltage V/kV. Only set a unit when it differs from the importer's detected/default unit.</p><label>Parameter scope overrides (optional JSON object; default is type scope)<textarea data-parameter-scopes rows="2" placeholder='{"Manufacturer":"instance"}'></textarea><label>Shared parameter GUIDs (optional JSON object: parameter name → existing UUID)<textarea data-parameter-guids rows="3" placeholder='{"Width":"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"}'></textarea><p class="cfg-muted">Only enter GUIDs issued by your approved shared-parameter standard. Blank values remain platform-local parameters; GUIDs are validated and duplicates are blocked.</p></div>
      <div class="cfg-card"><strong>04 · Extracted product types</strong><div data-rows><p class="cfg-muted">No product rows loaded yet.</p></div></div>
      <div class="cfg-card"><strong>05 · Quality review</strong><div data-qa class="cfg-muted">Import a catalogue to run completeness checks.</div></div>
      <div data-status role="status" aria-live="polite">Ready. Files are processed locally in this browser.</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button type="button" data-clear>Clear</button><button type="button" class="primary" data-create>Create parametric family</button></div>
    </div>`;
  document.body.appendChild(root);
  panel = root;
  root.querySelector("[data-close]")?.addEventListener("click", closeCatalogueFamilyGenerator);
  root.querySelector("[data-clear]")?.addEventListener("click", () => { rows = []; sourceName = ""; pendingXlsxFile = null; pendingPdfFile = null; delimitedSourceText = ""; delimitedHeaders = []; mappingOverrides = {}; renderMappingReview(); const chooser = root.querySelector<HTMLElement>("[data-xlsx-selection]"); if (chooser) chooser.hidden = true; renderRows(); const qa = root.querySelector<HTMLElement>("[data-qa]"); if (qa) qa.textContent = "Import a catalogue to run completeness checks."; status("Catalogue cleared."); });
  root.querySelector("[data-file]")?.addEventListener("change", (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file?.name.toLowerCase().endsWith(".xlsx")) void prepareXlsxWorkbook(file);
    else { pendingXlsxFile = null; pendingPdfFile = file?.name.toLowerCase().endsWith(".pdf") ? file : null; const chooser = root.querySelector<HTMLElement>("[data-xlsx-selection]"); if (chooser) chooser.hidden = true; void readCatalogue(file); }
  });
  root.querySelector("[data-import-sheet]")?.addEventListener("click", () => {
    const sheetName = root.querySelector<HTMLSelectElement>("[data-sheet]")?.value;
    if (pendingXlsxFile && sheetName) void readCatalogue(pendingXlsxFile, sheetName);
  });
  root.querySelector("[data-mapping-rows]")?.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    const header = target.dataset.mappingHeader;
    if (!header) return;
    if (target.value === "__auto__") delete mappingOverrides[header];
    else if (target.value === "__ignore__") mappingOverrides[header] = null;
    else mappingOverrides[header] = target.value as CatalogueField;
    if (pendingXlsxFile) {
      const sheetName = root.querySelector<HTMLSelectElement>("[data-sheet]")?.value;
      if (sheetName) void readCatalogue(pendingXlsxFile, sheetName);
    } else if (pendingPdfFile) void readCatalogue(pendingPdfFile);
    else reparseDelimitedSource();
  });
  root.querySelector("[data-save-profile]")?.addEventListener("click", () => {
    try { saveMappingProfile(); } catch (error) { status(error instanceof Error ? error.message : "Could not save mapping profile.", "warn"); }
  });
  root.querySelector("[data-apply-profile]")?.addEventListener("click", applyMappingProfile);
  root.querySelector("[data-export-profile]")?.addEventListener("click", exportMappingProfile);
  root.querySelector("[data-import-profile]")?.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    void importMappingProfile(input.files?.[0]);
    input.value = "";
  });
  renderMappingProfiles();
  root.querySelector("[data-create]")?.addEventListener("click", createFamily);
}
async function prepareXlsxWorkbook(file: File): Promise<void> {
  if (file.size > 40 * 1024 * 1024) { status("File exceeds the 40 MB intake limit.", "warn"); return; }
  try {
    pendingXlsxFile = file;
    status("Reading workbook worksheet list…");
    const names = await listXlsxWorksheets(file);
    const chooser = panel?.querySelector<HTMLElement>("[data-xlsx-selection]");
    const select = panel?.querySelector<HTMLSelectElement>("[data-sheet]");
    if (!chooser || !select) return;
    select.innerHTML = names.map((name) => "<option value=\"" + escapeHtml(name) + "\">" + escapeHtml(name) + "</option>").join("");
    chooser.hidden = false;
    status("Workbook ready: " + names.length + " worksheet(s) found. Select the product schedule to import.", "success");
  } catch (error) {
    pendingXlsxFile = null;
    status(error instanceof Error ? error.message : "Could not inspect XLSX workbook.", "warn");
  }
}
async function readCatalogue(file?: File, selectedSheet?: string): Promise<void> {
  if (!file) return;
  if (file.size > 40 * 1024 * 1024) { status("File exceeds the 40 MB intake limit.", "warn"); return; }
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!["csv","tsv","txt","json","pdf","xlsx"].includes(ext ?? "")) { status("Supported catalogue formats are XLSX, PDF, CSV, TSV, TXT and JSON. CAD/STEP extraction is not yet enabled.", "warn"); return; }
  try {
    let parsed: { rows: CatalogueRow[]; errors: string[] };
    if (ext === "xlsx") {
      const result = await extractXlsxCatalogue(file, selectedSheet, mappingOverrides);
      parsed = { rows: result.rows, errors: result.warnings };
      delimitedHeaders = result.headers;
      renderMappingReview();
      sourceName = file.name + " · " + result.sheetName;
      rows = parsed.rows;
      renderRows();
      const issues = [...parsed.errors, ...validateCatalogueRows(rows)];
      const qa = panel?.querySelector<HTMLElement>("[data-qa]");
      renderQualityDashboard(parsed.errors);
      status("XLSX processed: " + rows.length + " product type(s) imported from " + result.sheetName + ".", rows.length ? "success" : "warn");
      return;
    }
    if (ext === "pdf") {
      const useLocalVisionOcr = panel?.querySelector<HTMLInputElement>("[data-ocr]")?.checked ?? false;
      pendingPdfFile = file;
      const result = await extractPdfCatalogue(file, {
        useLocalVisionOcr,
        mappingOverrides,
        onProgress: (current, total, phase) => status(`${phase === "ocr" ? "Local OCR" : "Reading PDF"}: page ${current} of ${total}…`),
      });
      parsed = { rows: result.rows, errors: result.warnings };
      delimitedHeaders = result.headers;
      renderMappingReview();
      if (result.scannedPages.length && !useLocalVisionOcr && !parsed.errors.some((issue) => issue.includes("Scanned/image-only pages"))) parsed.errors.push(`Scanned pages detected: ${result.scannedPages.join(", ")}. Enable local vision OCR to extract them.`);
      if (result.pageCount > result.processedPages) parsed.errors.push(`Only the first ${result.processedPages} of ${result.pageCount} pages were processed.`);
      sourceName = file.name;
      rows = parsed.rows;
      renderRows();
      const issues = [...parsed.errors, ...validateCatalogueRows(rows)];
      const qa = panel?.querySelector<HTMLElement>("[data-qa]");
      renderQualityDashboard(parsed.errors);
      status(`PDF processed: ${result.processedPages}/${result.pageCount} pages; ${rows.length} product type(s) extracted; ${result.scannedPages.length} scanned page(s).`, rows.length ? "success" : "warn");
      return;
    }
    const raw = await file.text();
    pendingPdfFile = null;
    delimitedSourceText = "";
    delimitedHeaders = [];
    mappingOverrides = {};
    renderMappingReview();
    if (ext === "json") {
      const loaded = safeLoad("catalogue JSON", raw, CatalogueJsonSchema, 40 * 1024 * 1024,
        { maxDepth: 32, maxNodes: 250_000 });
      if (!loaded.ok) throw new Error(`Invalid catalogue JSON (${loaded.error.stage}): ${loaded.error.issues.join("; ")}`);
      const items = Array.isArray(loaded.value) ? loaded.value : loaded.value.products;
      parsed = { rows: items.map((item: Any) => ({ ...item, model: String(item.model ?? item.modelNumber ?? item.type ?? "") })), errors: [] };
      if (parsed.rows.some((r) => !r.model.trim())) throw new Error("Every JSON product must have a model, modelNumber or type field.");
    } else {
      delimitedSourceText = raw;
      delimitedSourceDelimiter = ext === "tsv" ? "\t" : undefined;
      const result = parseDelimitedCatalogue(raw, delimitedSourceDelimiter, mappingOverrides);
      delimitedHeaders = result.headers;
      parsed = { rows: result.rows, errors: result.errors };
      renderMappingReview();
    }
    rows = parsed.rows;
    sourceName = file.name;
    renderRows();
    const issues = [...parsed.errors, ...validateCatalogueRows(rows)];
    const qa = panel?.querySelector<HTMLElement>("[data-qa]");
    renderQualityDashboard(parsed.errors);
    status(`Loaded ${rows.length} product type(s) from ${file.name}.`, rows.length ? "success" : "warn");
  } catch (error) {
    rows = [];
    renderRows();
    status(error instanceof Error ? error.message : "Could not read catalogue.", "warn");
  }
}
function createFamily(): void {
  if (!rows.length) { status("Import at least one catalogue product before creating a family.", "warn"); return; }
  // Do not silently create misleading 1 m fallback geometry from incomplete
  // catalogue data. Require explicit, positive dimensions for every type.
  const blockingIssues = validateCatalogueRows(rows);
  if (blockingIssues.length) {
    const qa = panel?.querySelector<HTMLElement>("[data-qa]");
    if (qa) qa.textContent = "Family creation blocked: " + blockingIssues.join(" ");
    status("Family creation blocked. Correct every missing or non-positive width, depth and height before creating geometry.", "warn");
    return;
  }
  const svc = familyService();
  if (typeof svc.create !== "function") { status("The existing family service is not ready. Retry after the BIM authoring engine finishes booting.", "warn"); return; }
  const name = panel?.querySelector<HTMLInputElement>("[data-name]")?.value ?? "";
  const manufacturer = panel?.querySelector<HTMLInputElement>("[data-manufacturer]")?.value.trim() ?? "";
  const category = (panel?.querySelector<HTMLSelectElement>("[data-category]")?.value ?? "equipment") as "equipment" | "generic" | "fitting";
  const unit = (panel?.querySelector<HTMLSelectElement>("[data-unit]")?.value ?? "mm") as "mm" | "cm" | "m";
  const reviewedRows = rows.map((r) => ({ ...r, manufacturer: r.manufacturer || manufacturer || undefined }));
  try {
    const guidText = panel?.querySelector<HTMLTextAreaElement>("[data-parameter-guids]")?.value.trim() ?? "";
    let parameterGuids: Record<string, string> = {};
    if (guidText) {
      const parsedGuids: unknown = JSON.parse(guidText);
      if (!parsedGuids || typeof parsedGuids !== "object" || Array.isArray(parsedGuids)) throw new Error("Shared parameter GUID input must be a JSON object keyed by parameter name.");
      parameterGuids = Object.fromEntries(Object.entries(parsedGuids as Record<string, unknown>).map(([key, value]) => {
        if (typeof value !== "string") throw new Error(`GUID for "${key}" must be a string.`);
        return [key, value];
      }));
    }
    const scopeText = panel?.querySelector<HTMLTextAreaElement>("[data-parameter-scopes]")?.value.trim() ?? "";
    let parameterScopes: Record<string, "type" | "instance"> = {};
    if (scopeText) {
      const parsedScopes: unknown = JSON.parse(scopeText);
      if (!parsedScopes || typeof parsedScopes !== "object" || Array.isArray(parsedScopes)) throw new Error("Parameter scope input must be a JSON object keyed by parameter name.");
      parameterScopes = Object.fromEntries(Object.entries(parsedScopes as Record<string, unknown>).map(([key, value]) => {
        if (value !== "type" && value !== "instance") throw new Error(`Scope for "${key}" must be type or instance.`);
        return [key, value];
      }));
    }
    const unitText = panel?.querySelector<HTMLTextAreaElement>("[data-column-units]")?.value.trim() ?? "";
    let columnUnits: CatalogueColumnUnitOverrides = {};
    if (unitText) {
      const parsedUnits: unknown = JSON.parse(unitText);
      if (!parsedUnits || typeof parsedUnits !== "object" || Array.isArray(parsedUnits)) throw new Error("Engineering unit overrides must be a JSON object keyed by canonical mapped column.");
      const allowed = new Set(["width", "depth", "height", "airflow", "staticPressure", "power", "voltage"]);
      for (const [key, value] of Object.entries(parsedUnits as Record<string, unknown>)) {
        if (!allowed.has(key) || typeof value !== "string") throw new Error("Invalid engineering unit override for " + key + ".");
        columnUnits[key as keyof CatalogueColumnUnitOverrides] = value;
      }
    }
    const normalizedRows = normalizeCatalogueRowsWithUnits(reviewedRows, columnUnits, unit);
    const definition = buildCatalogueFamilyDefinition(normalizedRows, { name, category, dimensionUnit: unit, parameterScopes, parameterGuids });
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
