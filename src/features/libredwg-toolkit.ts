/**
 * LibreDWG toolkit — the LibreDWG utility belt, wired into the platform UI.
 *
 * Every button/command here maps to a real LibreDWG capability, implemented
 * against the parsed DxfDocument by modules/drawings/dwg-exporters.ts (pure)
 * or the reader worker (thumbnail):
 *
 *   LibreDWG tool            Platform action
 *   ─────────────────────    ─────────────────────────────────────────────
 *   dwgread -O JSON      →   "JSON" — full database dump (.json)
 *   dwg2SVG              →   "SVG" — flattened 2D vector export
 *   dwg2geojson          →   "GeoJSON" — points/lines/polygons FeatureCollection
 *   dwg2ps               →   "PostScript" — EPS (moveto/lineto/arc)
 *   dwg_audit            →   "Audit…" — severity-ranked integrity report
 *   dwg_bmp              →   "Thumbnail…" — embedded preview bitmap extractor
 *   table dumps          →   "Tables…", "Census…" — LAYER/LTYPE/STYLE/…
 *   dwgrewrite           →   "Save DXF…" — re-save through the DXF writer
 *   (JSON round trip)    →   "JSON dump…" — re-import a dump into the editor
 *
 * UI surfaces — everything lives INSIDE the native 2D CAD engine, never as a
 * tab of the 3D platform:
 *   Insert tab → "Open Drawing" group (DWG… / DXF… / JSON dump…)
 *   Output tab → "DWG Data" group (Save DXF · dwg2json · dwg2SVG · dwg2geojson · dwg2ps · Thumbnail)
 *   Manage tab → "DWG Inspect" group (Audit… / Tables… / Census…)
 *   engine command line → DWGOPEN · DWGJSONIMP · DWGREWRITE · DWG2JSON ·
 *   DWG2SVG · DWG2GEOJSON · DWG2PS · DWGAUDIT · DWGTABLES · DWGCENSUS · DWGTHUMB
 *   plus command-palette entries (dwg.*) and dialogs. No window.__obs* globals —
 *   state flows through imports and ctx.features (ui-honesty budget).
 */
import { ctx } from "../core/context";
import { registerCommand } from "./command-palette";
import {
  getActiveDrawing,
  cadToDxfDocument,
  importDxfText,
} from "../modules/drawings/dwg-engine";
import { writeDxf } from "../modules/drawings/dxf-writer";
import {
  documentToJsonDump,
  documentToSvg,
  documentToGeoJson,
  documentToPostScript,
  auditDrawing,
  type DwgAuditReport,
  type DwgExportMeta,
} from "../modules/drawings/dwg-exporters";
import type { DxfDocument } from "../modules/drawings/dxf-types";
import { readDwgThumbnail } from "../modules/cad-link";
import { showTableDialog, pickFromList } from "./form-modal";
import { fmtDateTime } from "../core/region";

type Any = Record<string, any>;

const STYLE = `
#obs-ldwg-overlay{position:fixed;inset:0;z-index:9700;display:flex;align-items:center;justify-content:center;background:rgba(4,6,10,.62);backdrop-filter:blur(3px);padding:16px}
#obs-ldwg-overlay .card{width:min(760px,94vw);max-height:88vh;overflow:auto;border-radius:14px;border:1px solid rgba(148,163,184,.25);background:#0d1219;color:#e2e8f0;box-shadow:0 24px 80px rgba(0,0,0,.6);font:13px/1.45 system-ui,sans-serif}
#obs-ldwg-overlay .head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px 10px;border-bottom:1px solid rgba(148,163,184,.14);position:sticky;top:0;background:#0d1219;z-index:1}
#obs-ldwg-overlay .title{font:600 15px/1.2 system-ui,sans-serif;color:#f1f5f9}
#obs-ldwg-overlay .sub{font:11px/1.4 ui-monospace,monospace;color:#64748b;margin-top:3px}
#obs-ldwg-overlay .x{border:0;background:transparent;color:#94a3b8;font:16px/1 system-ui;cursor:pointer;padding:4px}
#obs-ldwg-overlay .x:hover{color:#e2e8f0}
#obs-ldwg-overlay .body{padding:12px 18px 18px}
#obs-ldwg-overlay .kpis{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
#obs-ldwg-overlay .kpi{border:1px solid rgba(148,163,184,.2);border-radius:9px;padding:8px 12px;background:rgba(15,20,28,.55);min-width:92px}
#obs-ldwg-overlay .kpi b{display:block;font:700 16px/1.2 ui-monospace,monospace;color:#38bdf8}
#obs-ldwg-overlay .kpi span{font:10px/1 ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:#64748b}
#obs-ldwg-overlay .verdict{border-radius:9px;padding:9px 12px;margin-bottom:12px;font:600 12.5px/1.45 system-ui,sans-serif}
#obs-ldwg-overlay .verdict.ok{border:1px solid rgba(34,197,94,.4);background:rgba(34,197,94,.08);color:#86efac}
#obs-ldwg-overlay .verdict.warn{border:1px solid rgba(251,191,36,.4);background:rgba(251,191,36,.08);color:#fcd34d}
#obs-ldwg-overlay .verdict.err{border:1px solid rgba(248,113,113,.45);background:rgba(248,113,113,.08);color:#fca5a5}
#obs-ldwg-overlay h4{margin:14px 0 6px;font:600 10.5px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#64748b}
#obs-ldwg-overlay table{width:100%;border-collapse:collapse;font:12px/1.4 system-ui,sans-serif}
#obs-ldwg-overlay th{text-align:left;padding:6px 9px;background:#0a0e14;border-bottom:1px solid rgba(148,163,184,.2);color:#94a3b8;font:600 10px/1 ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;position:sticky;top:0}
#obs-ldwg-overlay td{padding:5px 9px;border-bottom:1px solid rgba(148,163,184,.09)}
#obs-ldwg-overlay .sev-error{color:#fca5a5;font-weight:600}
#obs-ldwg-overlay .sev-warning{color:#fcd34d}
#obs-ldwg-overlay .sev-info{color:#7dd3fc}
#obs-ldwg-overlay .actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
#obs-ldwg-overlay .actions button{height:32px;padding:0 14px;border-radius:8px;border:1px solid rgba(148,163,184,.3);background:transparent;color:#cbd5e1;font:600 12px system-ui;cursor:pointer}
#obs-ldwg-overlay .actions button:hover{border-color:#38bdf8;color:#e2e8f0}
#obs-ldwg-overlay .actions button.primary{background:#0ea5e9;border-color:#0ea5e9;color:#04121d}
#obs-ldwg-overlay .actions button.primary:hover{background:#38bdf8}
#obs-ldwg-overlay img.thumb{max-width:100%;max-height:52vh;border-radius:10px;border:1px solid rgba(148,163,184,.25);background:#fff;display:block;margin:0 auto}
#obs-ldwg-overlay .note{color:#64748b;font:11.5px/1.5 system-ui;margin-top:10px}
`;

function toast(kind: string, msg: string): void {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { kind, message: msg, timeout: 2600 } }));
  } catch {
    console.log(`[libredwg] ${msg}`);
  }
}

function ensureStyle(): void {
  if (document.getElementById("obs-ldwg-style")) return;
  const s = document.createElement("style");
  s.id = "obs-ldwg-style";
  s.textContent = STYLE;
  document.head.appendChild(s);
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function downloadText(name: string, text: string, mime: string): void {
  download(name, new Blob([text], { type: mime }));
}

function baseName(name: string): string {
  return name.replace(/\.(dwg|dxf|json|obsproj)$/i, "") || "drawing";
}

/** The active drawing document — the loaded CAD/DWG drawing, else the CAD model. */
function currentDoc(): { doc: DxfDocument; name: string; source: string; meta: DwgExportMeta } {
  const drawing = getActiveDrawing();
  if (drawing) {
    return { doc: drawing.doc, name: baseName(drawing.name), source: `${drawing.format.toUpperCase()} drawing`, meta: { fileName: drawing.name } };
  }
  return { doc: cadToDxfDocument(), name: "cad-model", source: "the CAD model", meta: { fileName: "cad-model.dxf" } };
}

/* ── exporters (ribbon + palette entry points) ──────────────────────────── */

export function exportDwgJson(): void {
  const { doc, name, source, meta } = currentDoc();
  downloadText(`${name}.dwg-json.json`, documentToJsonDump(doc, meta), "application/json");
  toast("success", `dwg2json — ${source} dumped to ${name}.dwg-json.json`);
}

export function exportDwgSvg(): void {
  const { doc, name, source } = currentDoc();
  const { svg } = documentToSvg(doc);
  downloadText(`${name}.svg`, svg, "image/svg+xml");
  toast("success", `dwg2SVG — ${source} exported to ${name}.svg`);
}

export function exportDwgGeoJson(): void {
  const { doc, name, source, meta } = currentDoc();
  downloadText(`${name}.geojson`, documentToGeoJson(doc, meta), "application/geo+json");
  toast("success", `dwg2geojson — ${source} exported to ${name}.geojson`);
}

export function exportDwgPs(): void {
  const { doc, name, source } = currentDoc();
  downloadText(`${name}.eps`, documentToPostScript(doc, name), "application/postscript");
  toast("success", `dwg2ps — ${source} exported to ${name}.eps`);
}

/* ── JSON dump re-import (round trip) ───────────────────────────────────── */

export async function importJsonDumpFile(file: File): Promise<void> {
  let parsed: Any;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    toast("error", `${file.name} is not valid JSON.`);
    return;
  }
  const doc = parsed?.entities && Array.isArray(parsed.entities)
    ? {
        layers: Array.isArray(parsed.layers) ? parsed.layers : [{ name: "0", color: 7 }],
        entities: parsed.entities,
        units: parsed.units,
        extents: parsed.extents,
        linetypes: parsed.linetypes,
        ltscale: parsed.ltscale,
        textStyles: parsed.textStyles,
        dimStyles: parsed.dimStyles,
        dimStyleTable: parsed.dimStyleTable,
        layouts: parsed.layouts,
        skipped: parsed.skipped,
        sourceFormat: "unknown",
      } as DxfDocument
    : null;
  if (!doc) {
    toast("error", "Not a LibreDWG JSON dump (no entities array). Export one with dwg2json first.");
    return;
  }
  // Route through the standard DXF import: one writer, one loader, zero
  // duplicated merge logic (the dump becomes a real DXF drawing).
  const text = writeDxf(doc);
  const drawing = await importDxfText(text, file.name.replace(/\.json$/i, ".dxf"), { intoCad: true, intoScene: true });
  toast("success", `Imported ${drawing.doc.entities.length} entities from the JSON dump.`);
}

/* ── dialogs ────────────────────────────────────────────────────────────── */

function shell(title: string, subtitle: string): { overlay: HTMLElement; body: HTMLElement; close: () => void } {
  ensureStyle();
  const overlay = document.createElement("div");
  overlay.id = "obs-ldwg-overlay";
  const card = document.createElement("div");
  card.className = "card";
  const head = document.createElement("div");
  head.className = "head";
  const h = document.createElement("div");
  h.innerHTML = `<div class="title">${title}</div><div class="sub">${subtitle}</div>`;
  const x = document.createElement("button");
  x.className = "x";
  x.textContent = "✕";
  x.onclick = () => overlay.remove();
  head.append(h, x);
  const body = document.createElement("div");
  body.className = "body";
  card.append(head, body);
  overlay.appendChild(card);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  return { overlay, body, close: () => overlay.remove() };
}

function table(headers: string[], rows: Array<Array<string | number>>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.maxHeight = "240px";
  wrap.style.overflow = "auto";
  wrap.style.border = "1px solid rgba(148,163,184,.14)";
  wrap.style.borderRadius = "9px";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:10px;color:#64748b;font-size:12px";
    empty.textContent = "Nothing to show.";
    wrap.appendChild(empty);
    return wrap;
  }
  const th = headers.map((c) => `<th>${c}</th>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((v) => `<td>${String(v)}</td>`).join("")}</tr>`).join("");
  wrap.innerHTML = `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
  return wrap;
}

function auditReportText(r: DwgAuditReport): string {
  const lines: string[] = [];
  lines.push("LibreDWG toolkit — drawing audit (dwg_audit parity)");
  lines.push("=".repeat(56));
  lines.push(`File: ${r.meta.fileName ?? "(active CAD model)"}  Version: ${r.meta.version ?? "(not recorded)"}`);
  lines.push(`Units: ${r.meta.units ?? "unitless"}  Extents: ${r.meta.extents ? `${r.meta.extents.min.x},${r.meta.extents.min.y} → ${r.meta.extents.max.x},${r.meta.extents.max.y}` : "(none)"}`);
  lines.push(`Entities: ${r.totals.entities}  Layers: ${r.totals.layerCount} (empty: ${r.totals.emptyLayers})  Layouts: ${r.totals.layoutCount} (${r.totals.entitiesInLayouts} entities)`);
  lines.push(`Issues: ${r.issueCounts.error} error(s), ${r.issueCounts.warning} warning(s), ${r.issueCounts.info} info`);
  lines.push(`Verdict: ${r.verdict}`);
  lines.push("");
  lines.push("Entity census:");
  for (const t of r.byType) lines.push(`  ${t.type.padEnd(14)} ${t.count}`);
  if (r.skipped.length) {
    lines.push("Read but not drawable (skipped):");
    for (const s of r.skipped) lines.push(`  ${s.type.padEnd(14)} ${s.count}`);
  }
  lines.push("Layers:");
  for (const l of r.layers) {
    const flags = [l.frozen && "frozen", l.off && "off", l.locked && "locked"].filter(Boolean).join(",");
    lines.push(`  ${(flags ? `${l.name} [${flags}]` : l.name).padEnd(28)} ${l.entities}`);
  }
  lines.push("");
  lines.push("Issues:");
  for (const i of r.issues) lines.push(`  [${i.severity.toUpperCase()}] ${i.code}${i.layer ? ` (${i.layer})` : ""}: ${i.message}`);
  return lines.join("\n") + "\n";
}

export function auditDialog(): void {
  const { doc, name, source, meta } = currentDoc();
  const r = auditDrawing(doc, meta);
  const { body, close } = shell(
    "LibreDWG — Drawing audit",
    `${source} · dwg_audit parity · ${fmtDateTime()}`,
  );

  const verdict = document.createElement("div");
  verdict.className = `verdict ${r.issueCounts.error ? "err" : r.issueCounts.warning ? "warn" : "ok"}`;
  verdict.textContent = r.verdict;
  body.appendChild(verdict);

  const kpis = document.createElement("div");
  kpis.className = "kpis";
  const kpi = (v: string | number, label: string) => {
    const el = document.createElement("div");
    el.className = "kpi";
    el.innerHTML = `<b>${v}</b><span>${label}</span>`;
    return el;
  };
  kpis.append(
    kpi(r.totals.entities, "entities"),
    kpi(r.totals.layerCount, "layers"),
    kpi(r.totals.emptyLayers, "empty layers"),
    kpi(r.totals.layoutCount, "layouts"),
    kpi(`${r.issueCounts.error}/${r.issueCounts.warning}/${r.issueCounts.info}`, "issues E/W/I"),
  );
  body.appendChild(kpis);

  const issues = document.createElement("h4");
  issues.textContent = `Issues (${r.issues.length}${r.issues.length >= 500 ? "+, capped" : ""})`;
  body.appendChild(issues);
  body.appendChild(table(
    ["Severity", "Code", "Message", "Layer"],
    r.issues.map((i) => [`<span class="sev-${i.severity}">${i.severity}</span>`, i.code, i.message, i.layer ?? ""]),
  ));

  const census = document.createElement("h4");
  census.textContent = "Entity census (model space)";
  body.appendChild(census);
  body.appendChild(table(["Type", "Count"], r.byType.map((t) => [t.type, t.count])));

  if (r.skipped.length) {
    const sk = document.createElement("h4");
    sk.textContent = "Read but not drawable (skipped)";
    body.appendChild(sk);
    body.appendChild(table(["Type", "Count"], r.skipped.map((s) => [s.type, s.count])));
  }

  const layers = document.createElement("h4");
  layers.textContent = `Layers (${r.totals.layerCount})`;
  body.appendChild(layers);
  body.appendChild(table(
    ["Name", "Color", "Flags", "Entities"],
    r.layers.slice(0, 100).map((l) => [l.name, l.color, [l.frozen && "frozen", l.off && "off", l.locked && "locked"].filter(Boolean).join(",") || "", l.entities]),
  ));

  const actions = document.createElement("div");
  actions.className = "actions";
  const saveTxt = document.createElement("button");
  saveTxt.textContent = "Save report (.txt)";
  saveTxt.onclick = () => downloadText(`${name}.audit.txt`, auditReportText(r), "text/plain");
  const saveJson = document.createElement("button");
  saveJson.textContent = "Save report (.json)";
  saveJson.onclick = () => downloadText(`${name}.audit.json`, JSON.stringify(r, null, 1), "application/json");
  const done = document.createElement("button");
  done.className = "primary";
  done.textContent = "Close";
  done.onclick = close;
  actions.append(saveTxt, saveJson, done);
  body.appendChild(actions);
}

export async function tablesDialog(): Promise<void> {
  const { doc, source } = currentDoc();
  const choices = [
    { value: "layers", label: `Layers (${doc.layers?.length ?? 0})` },
    { value: "linetypes", label: `Linetypes (${Object.keys(doc.linetypes ?? {}).length})` },
    { value: "styles", label: `Text styles (${Object.keys(doc.textStyles ?? {}).length})` },
    { value: "dimstyles", label: `Dimension styles (${doc.dimStyleTable ? Object.keys(doc.dimStyleTable).length : doc.dimStyles?.length ?? 0})` },
    { value: "layouts", label: `Layouts (paper space) (${doc.layouts?.length ?? 0})` },
  ];
  const pick = await pickFromList("LibreDWG — Tables", "Table", choices, "layers");
  if (!pick) return;
  if (pick === "layers") {
    await showTableDialog(
      "LibreDWG — LAYER table",
      ["Name", "Color (ACI)", "Linetype", "Frozen", "Off", "Locked", "Lineweight"],
      (doc.layers ?? []).map((l) => [l.name, l.color, l.lineType ?? "Continuous", l.frozen ? "yes" : "", l.off ? "yes" : "", l.locked ? "yes" : "", l.lineweight ?? ""]),
      `${source} — each row is one LAYER table record`,
    );
  } else if (pick === "linetypes") {
    await showTableDialog(
      "LibreDWG — LTYPE table",
      ["Name", "Dashes (+dash / -gap)"],
      Object.entries(doc.linetypes ?? {}).map(([name, pattern]) => [name, pattern.join(", ")]),
      `${source} — dash patterns in drawing units`,
    );
  } else if (pick === "styles") {
    await showTableDialog(
      "LibreDWG — STYLE table (text styles)",
      ["Name", "Font", "Big font", "Height", "Width", "Bold", "Italic"],
      Object.entries(doc.textStyles ?? {}).map(([name, s]) => [name, s.font ?? "", s.bigFont ?? "", s.height ?? 0, s.width ?? 1, s.bold ? "yes" : "", s.italic ? "yes" : ""]),
      `${source} — each row is one STYLE table record`,
    );
  } else if (pick === "dimstyles") {
    await showTableDialog(
      "LibreDWG — DIMSTYLE table",
      ["Name", "Scale", "Text height", "Arrow size", "Decimals", "Suffix"],
      Object.entries(doc.dimStyleTable ?? {}).map(([name, d]) => [name, d.scale ?? 1, d.textHeight ?? "", d.arrowSize ?? "", d.decimals ?? "", d.postFix ?? ""]),
      `${source} — dimension style records`,
    );
  } else if (pick === "layouts") {
    await showTableDialog(
      "LibreDWG — Layouts (paper space)",
      ["Name", "Entities", "Viewports"],
      (doc.layouts ?? []).map((l) => [l.name, l.entities?.length ?? 0, l.viewports?.length ?? 0]),
      `${source} — sheets defined in the drawing`,
    );
  }
}

export function censusDialog(): void {
  const { doc, source } = currentDoc();
  const counts: Record<string, number> = {};
  for (const e of doc.entities) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  void showTableDialog(
    "LibreDWG — Entity census",
    ["Entity type", "Count"],
    rows,
    `${source} — model space, ${doc.entities.length} entities total` + (doc.skipped ? ` · skipped: ${Object.entries(doc.skipped).map(([t, c]) => `${c}×${t}`).join(", ")}` : ""),
  );
}

/* ── thumbnail (dwg_bmp parity, via the reader worker) ──────────────────── */

export async function thumbnailDialog(): Promise<void> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".dwg";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    toast("info", `Extracting the embedded preview of ${file.name}…`);
    try {
      const thumb = await readDwgThumbnail(file);
      const { body, close } = shell("LibreDWG — DWG thumbnail", `${file.name} · dwg_bmp parity · ${thumb.mime}`);
      if (thumb.mime !== "image/x-wmf") {
        const img = document.createElement("img");
        img.className = "thumb";
        img.src = `data:${thumb.mime};base64,${thumb.dataB64}`;
        img.alt = `Preview of ${file.name}`;
        body.appendChild(img);
      } else {
        const note = document.createElement("div");
        note.className = "note";
        note.textContent = "This DWG embeds a WMF preview, which browsers cannot display — use the save button to download it.";
        body.appendChild(note);
      }
      const actions = document.createElement("div");
      actions.className = "actions";
      const save = document.createElement("button");
      save.className = "primary";
      save.textContent = "Save image…";
      save.onclick = () => {
        const ext = thumb.mime === "image/png" ? "png" : thumb.mime === "image/x-wmf" ? "wmf" : "bmp";
        const bytes = Uint8Array.from(atob(thumb.dataB64), (c) => c.charCodeAt(0));
        download(`${baseName(file.name)}.thumb.${ext}`, new Blob([bytes], { type: thumb.mime }));
      };
      const done = document.createElement("button");
      done.textContent = "Close";
      done.onclick = close;
      actions.append(save, done);
      body.appendChild(actions);
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = "The thumbnail is the bitmap AutoCAD bakes into the file on save — it shows the model exactly as it looked at save time, without parsing any geometry.";
      body.appendChild(note);
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Thumbnail extraction failed.");
    }
  };
  input.click();
}

/* ── open helpers (shared with the ribbon tab) ──────────────────────────── */

export async function openDrawingFiles(files: FileList): Promise<void> {
  const m = await import("../modules/drawings/dwg-engine");
  let n = 0;
  for (const f of Array.from(files)) {
    const res = await m.importDrawingFile(f);
    if (res) n++;
  }
  if (n) {
    const { openDrawingsPanel } = await import("./drawings-panel");
    openDrawingsPanel();
  }
}

/* ── setup: commands + feature registry ─────────────────────────────────── */

let installed = false;

export function setupLibreDwgToolkit(): void {
  if (installed) return;
  installed = true;
  try {
    (ctx.features as Any).libreDwg = {
      exportDwgJson,
      exportDwgSvg,
      exportDwgGeoJson,
      exportDwgPs,
      auditDialog,
      tablesDialog,
      censusDialog,
      thumbnailDialog,
      importJsonDumpFile,
    };
  } catch { /* features registry unavailable during early boot */ }
  try {
    const cat = "LibreDWG";
    registerCommand({ id: "dwg.json", label: "LibreDWG — Export JSON database dump (dwg2json)", category: cat, run: exportDwgJson });
    registerCommand({ id: "dwg.svg", label: "LibreDWG — Export SVG (dwg2SVG)", category: cat, run: exportDwgSvg });
    registerCommand({ id: "dwg.geojson", label: "LibreDWG — Export GeoJSON (dwg2geojson)", category: cat, run: exportDwgGeoJson });
    registerCommand({ id: "dwg.ps", label: "LibreDWG — Export PostScript/EPS (dwg2ps)", category: cat, run: exportDwgPs });
    registerCommand({ id: "dwg.audit", label: "LibreDWG — Drawing audit report (dwg_audit)", category: cat, run: auditDialog });
    registerCommand({ id: "dwg.tables", label: "LibreDWG — Browse tables (layers/linetypes/styles)", category: cat, run: () => void tablesDialog() });
    registerCommand({ id: "dwg.census", label: "LibreDWG — Entity census", category: cat, run: censusDialog });
    registerCommand({ id: "dwg.thumbnail", label: "LibreDWG — Extract DWG thumbnail (dwg_bmp)", category: cat, run: () => void thumbnailDialog() });
    registerCommand({ id: "dwg.importjson", label: "LibreDWG — Import a JSON database dump", category: cat, run: () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.onchange = () => { const f = input.files?.[0]; if (f) void importJsonDumpFile(f); };
      input.click();
    } });
  } catch { /* command palette deferred */ }
  console.log("[libredwg] toolkit ready — dwg2json/dwg2SVG/dwg2geojson/dwg2ps/dwg_audit/dwg_bmp wired");
}
