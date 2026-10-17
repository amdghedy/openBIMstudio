/**
 * COBie 2.4 worksheet emitter.
 *
 * Two output modes:
 *   • "xls"  — one HTML workbook, one <table> per worksheet. Excel/Numbers
 *              open it natively and preserve the sheet names via the
 *              mso:ExcelWorkbook hints. No dependencies.
 *   • "zip"  — one .csv per worksheet inside a ZIP. Ideal for data pipelines.
 *
 * Worksheets emitted: Facility, Floor, Space, Zone, Type, Component,
 * System, Assembly, Contact, Coordinate, Attribute, Issue.
 */
import JSZip from "jszip";
import { ctx } from "../../core/context";
import { getElements as getAuthoredElements } from "../../features/authoring";
import { getIssues } from "../issues/issues";

const COBIE_VERSION = "2.4";

/* ── Types ─────────────────────────────────────────────────────────────── */

export interface CobieContact {
  Email: string;
  GivenName: string;
  FamilyName: string;
  Company: string;
  Phone: string;
}

export interface CobieFacility {
  Name: string;
  Category: string;
  ProjectName: string;
  SiteName: string;
  LinearUnits: string;
  AreaUnits: string;
  VolumeUnits: string;
  CurrencyUnit: string;
  AreaMeasurement: string;
  LinearMeasurement: string;
  VolumeMeasurement: string;
  Description: string;
  ProjectDescription: string;
  SiteDescription: string;
  Phase: string;
}

export interface CobieFloor {
  Name: string;
  Category: string;
  Description: string;
  Elevation: string;
  Height: string;
}

export interface CobieSpace {
  Name: string;
  FloorName: string;
  Description: string;
  RoomTag: string;
  UsableHeight: string;
  GrossArea: string;
  NetArea: string;
  Category: string;
}

export interface CobieZone {
  Name: string;
  Category: string;
  SpaceNames: string;
  Description: string;
}

export interface CobieType {
  Name: string;
  Category: string;
  Description: string;
  AssetType: string;
  Manufacturer: string;
  ModelNumber: string;
  WarrantyGuarantorParts: string;
  WarrantyDurationParts: string;
  WarrantyGuarantorLabor: string;
  WarrantyDurationLabor: string;
  WarrantyDurationUnit: string;
  ReplacementCost: string;
  ExpectedLife: string;
  DurationUnit: string;
  NominalLength: string;
  NominalWidth: string;
  NominalHeight: string;
  Shape: string;
  Size: string;
  Color: string;
  Finish: string;
  Grade: string;
  Material: string;
  Constituents: string;
  Features: string;
  AccessibilityPerformance: string;
  CodePerformance: string;
  SustainabilityPerformance: string;
}

export interface CobieComponent {
  Name: string;
  TypeName: string;
  Space: string;
  Description: string;
  InstallationDate: string;
  WarrantyStartDate: string;
  TagNumber: string;
  BarCode: string;
  AssetIdentifier: string;
  SerialNumber: string;
}

export interface CobieSystem {
  Name: string;
  ComponentNames: string;
  Description: string;
  Category: string;
}

export interface CobieAssembly {
  Name: string;
  AssemblyType: string;
  SheetName: string;
  ParentName: string;
  ComponentNames: string;
  ExtSystem: string;
  ExtObject: string;
  ExtIdentifier: string;
  Description: string;
}

export interface CobieAttribute {
  Name: string;
  SheetName: string;
  RowName: string;
  Value: string;
  Unit: string;
  ExtSystem: string;
  ExtObject: string;
  ExtIdentifier: string;
  Description: string;
}

export interface CobieCoordinate {
  Name: string;
  Category: string;
  SheetName: string;
  RowName: string;
  CoordinateXAxis: string;
  CoordinateYAxis: string;
  CoordinateZAxis: string;
  ExtSystem: string;
  ExtObject: string;
  ExtIdentifier: string;
}

export interface CobieIssue {
  Name: string;
  CreatedBy: string;
  CreatedOn: string;
  Type: string;
  Risk: string;
  Chance: string;
  Impact: string;
  Status: string;
  Description: string;
  Owner: string;
  Mitigation: string;
  ExtSystem: string;
  ExtObject: string;
  ExtIdentifier: string;
}

export interface CobieDataset {
  Facility: CobieFacility[];
  Floor: CobieFloor[];
  Space: CobieSpace[];
  Zone: CobieZone[];
  Type: CobieType[];
  Component: CobieComponent[];
  System: CobieSystem[];
  Assembly: CobieAssembly[];
  Contact: CobieContact[];
  Coordinate: CobieCoordinate[];
  Attribute: CobieAttribute[];
  Issue: CobieIssue[];
}

export interface CobieBuildOptions {
  projectName?: string;
  siteName?: string;
  description?: string;
  authorName?: string;
  authorEmail?: string;
  phase?: string;
  /** Include a Contact row for the current author. Default true. */
  includeAuthor?: boolean;
}

/* ── Empty dataset ─────────────────────────────────────────────────────── */

export function emptyCobieDataset(): CobieDataset {
  return {
    Facility: [],
    Floor: [],
    Space: [],
    Zone: [],
    Type: [],
    Component: [],
    System: [],
    Assembly: [],
    Contact: [],
    Coordinate: [],
    Attribute: [],
    Issue: [],
  };
}

/* ── Gather from the running scene ─────────────────────────────────────── */

function attrToString(v: any): string {
  if (v == null) return "";
  if (typeof v === "object") {
    if ("value" in v) return String(v.value ?? "");
    return "";
  }
  return String(v);
}

function guessUnits(): { linear: string; area: string; volume: string } {
  // The current unit config from units service; fall back to SI.
  try {
    const u: any = (ctx.features as any).units;
    const cfg = u?.getConfig?.();
    if (cfg) {
      return {
        linear: `${{ mm: "millimeters", cm: "centimeters", m: "meters", ft: "feet", in: "inches", "ft-in": "feet and inches" }[cfg.length as string] ?? "meters"}`,
        area: `${{ mm2: "square millimeters", cm2: "square centimeters", m2: "square meters", ft2: "square feet", in2: "square inches" }[cfg.area as string] ?? "square meters"}`,
        volume: `${{ mm3: "cubic millimeters", cm3: "cubic centimeters", m3: "cubic meters", ft3: "cubic feet", in3: "cubic inches", l: "liters" }[cfg.volume as string] ?? "cubic meters"}`,
      };
    }
  } catch { /* */ }
  return { linear: "meters", area: "square meters", volume: "cubic meters" };
}

async function gatherFromFragments(ds: CobieDataset): Promise<void> {
  const typeCache = new Map<string, CobieType>();

  for (const [modelId, model] of ctx.fragments.list) {
    let categories: Record<string, number[]> = {};
    try {
      categories = await (model as any).getItemsOfCategories([/.+/]);
    } catch (err) {
      console.warn("[cobie] categories failed", modelId, err);
      continue;
    }

    for (const [cat, ids] of Object.entries(categories)) {
      const ifcCat = String(cat);
      const shortCat = ifcCat.replace(/^IFC/i, "");

      let data: any[] = [];
      try {
        data = await (model as any).getItemsData(ids, {
          attributesDefault: true,
          psetsDefault: false,
        });
      } catch (err) {
        console.warn("[cobie] getItemsData failed", modelId, shortCat, err);
        continue;
      }

      if (ifcCat === "IFCBUILDINGSTOREY") {
        for (let i = 0; i < ids.length; i++) {
          const d = data[i] ?? {};
          ds.Floor.push({
            Name: attrToString(d.Name) || `${modelId}-Level-${ids[i]}`,
            Category: shortCat,
            Description: attrToString(d.Description),
            Elevation: attrToString(d.Elevation),
            Height: "",
          });
        }
        continue;
      }

      if (ifcCat === "IFCSPACE") {
        for (let i = 0; i < ids.length; i++) {
          const d = data[i] ?? {};
          ds.Space.push({
            Name: attrToString(d.Name) || `Space-${ids[i]}`,
            FloorName: "",
            Description: attrToString(d.Description),
            RoomTag: attrToString(d.LongName),
            UsableHeight: "",
            GrossArea: "",
            NetArea: "",
            Category: shortCat,
          });
        }
        continue;
      }

      if (ifcCat === "IFCZONE") {
        for (let i = 0; i < ids.length; i++) {
          const d = data[i] ?? {};
          ds.Zone.push({
            Name: attrToString(d.Name) || `Zone-${ids[i]}`,
            Category: shortCat,
            SpaceNames: "",
            Description: attrToString(d.Description),
          });
        }
        continue;
      }

      // IfcTypeObject subclasses → COBie Type
      if (/TYPE$/.test(ifcCat) || ifcCat === "IFCFURNITURETYPE") {
        for (let i = 0; i < ids.length; i++) {
          const d = data[i] ?? {};
          const name = attrToString(d.Name) || `${shortCat}-${ids[i]}`;
          if (typeCache.has(name)) continue;
          const t: CobieType = {
            Name: name, Category: shortCat,
            Description: attrToString(d.Description),
            AssetType: "Fixed", Manufacturer: "", ModelNumber: "",
            WarrantyGuarantorParts: "", WarrantyDurationParts: "",
            WarrantyGuarantorLabor: "", WarrantyDurationLabor: "",
            WarrantyDurationUnit: "years",
            ReplacementCost: "", ExpectedLife: "", DurationUnit: "years",
            NominalLength: "", NominalWidth: "", NominalHeight: "",
            Shape: "", Size: "", Color: "", Finish: "", Grade: "",
            Material: "", Constituents: "", Features: "",
            AccessibilityPerformance: "", CodePerformance: "",
            SustainabilityPerformance: "",
          };
          typeCache.set(name, t);
          ds.Type.push(t);
        }
        continue;
      }

      // Physical products → COBie Component
      if (/^(IFC(WALL|SLAB|DOOR|WINDOW|COLUMN|BEAM|MEMBER|FOOTING|PILE|RAMP|RAILING|STAIR|ROOF|COVERING|CURTAINWALL|PLATE|PIPE|DUCT|CABLECARRIER|CABLESEGMENT|CONDUIT|AIRTERMINAL|SANITARYTERMINAL|ELECTRIC|LIGHTING|FURNITURE|FURNISHING|FLOW|VALVE|PUMP|FAN|COIL|CHILLER|BOILER|TANK|SPACEHEATER|OUTLET|SWITCH|SENSOR|ALARM|CONTROLLER|ACTUATOR|PROTECTIVEDEVICE|TRANSFORMER|MOTOR|GENERATOR|CONVEYOR|VEHICLE|ELEMENTASSEMBLY|BUILDINGELEMENTPROXY|ELEMENTCOMPONENT))/i.test(ifcCat)) {
        for (let i = 0; i < ids.length; i++) {
          const d = data[i] ?? {};
          const name = attrToString(d.Name) || `${shortCat}-${ids[i]}`;
          ds.Component.push({
            Name: name,
            TypeName: "",
            Space: "",
            Description: attrToString(d.Description),
            InstallationDate: "",
            WarrantyStartDate: "",
            TagNumber: attrToString(d.Tag),
            BarCode: "",
            AssetIdentifier: attrToString(d.GlobalId),
            SerialNumber: "",
          });
        }
      }
    }
  }
}

function gatherFromAuthored(ds: CobieDataset): void {
  for (const el of getAuthoredElements()) {
    const cat = (el.type ?? "generic").replace(/^./, (c: string) => c.toUpperCase());
    if (el.nativeGeometry && el.ifc) {
      // Native twin — emit as a Component with a link to its source.
      ds.Component.push({
        Name: el.name,
        TypeName: "",
        Space: "",
        Description: `Native twin of ${el.ifc.entity} ${el.ifc.sourceGlobalId ?? el.ifc.globalId ?? ""}`.trim(),
        InstallationDate: "",
        WarrantyStartDate: "",
        TagNumber: String(el.ifc.tag ?? ""),
        BarCode: "",
        AssetIdentifier: String(el.ifc.globalId ?? ""),
        SerialNumber: "",
      });
    } else {
      ds.Component.push({
        Name: el.name,
        TypeName: cat,
        Space: "",
        Description: "",
        InstallationDate: "",
        WarrantyStartDate: "",
        TagNumber: "",
        BarCode: "",
        AssetIdentifier: el.id,
        SerialNumber: "",
      });
    }
  }
}

function gatherIssues(ds: CobieDataset): void {
  try {
    const issues = getIssues();
    for (const it of issues) {
      ds.Issue.push({
        Name: it.title,
        CreatedBy: it.author ?? "",
        CreatedOn: it.createdAt ? new Date(it.createdAt).toISOString() : "",
        Type: "Coordination",
        Risk: it.priority ?? "",
        Chance: "",
        Impact: "",
        Status: it.status ?? "Open",
        Description: it.description ?? "",
        Owner: it.assignee ?? "",
        Mitigation: "",
        ExtSystem: "Open BIM Studio",
        ExtObject: "Issue",
        ExtIdentifier: it.id,
      });
    }
  } catch { /* issues module optional */ }
}

export async function gatherCobieDataset(
  opts: CobieBuildOptions = {},
): Promise<CobieDataset> {
  const ds = emptyCobieDataset();
  const units = guessUnits();
  const facilityName = opts.projectName ?? "Open BIM Studio Project";
  const author = opts.authorName ?? "";

  ds.Facility.push({
    Name: facilityName,
    Category: "Facility",
    ProjectName: facilityName,
    SiteName: opts.siteName ?? "",
    LinearUnits: units.linear,
    AreaUnits: units.area,
    VolumeUnits: units.volume,
    CurrencyUnit: getCurrencyCode(),
    AreaMeasurement: "NRM",
    LinearMeasurement: "NRM",
    VolumeMeasurement: "NRM",
    Description: opts.description ?? "",
    ProjectDescription: "",
    SiteDescription: "",
    Phase: opts.phase ?? "Design",
  });

  if (opts.includeAuthor !== false && (author || opts.authorEmail)) {
    ds.Contact.push({
      Email: opts.authorEmail ?? "",
      GivenName: author.split(" ")[0] ?? "",
      FamilyName: author.split(" ").slice(1).join(" ") ?? "",
      Company: "Open BIM Studio",
      Phone: "",
    });
  }

  await gatherFromFragments(ds);
  gatherFromAuthored(ds);
  gatherIssues(ds);

  // Coordinates: one row per model root.
  let i = 0;
  for (const [modelId] of ctx.fragments.list) {
    ds.Coordinate.push({
      Name: `Origin-${i++}`,
      Category: "Model",
      SheetName: "Facility",
      RowName: facilityName,
      CoordinateXAxis: "0",
      CoordinateYAxis: "0",
      CoordinateZAxis: "0",
      ExtSystem: "Open BIM Studio",
      ExtObject: "Model",
      ExtIdentifier: modelId,
    });
  }

  return ds;
}

function getCurrencyCode(): string {
  try { return localStorage.getItem("obs.currency") ?? "USD"; }
  catch { return "USD"; }
}

/* ── Sheet writers ─────────────────────────────────────────────────────── */

const SHEETS: Array<{ name: keyof CobieDataset; columns: string[] }> = [
  { name: "Facility",   columns: ["Name","Category","ProjectName","SiteName","LinearUnits","AreaUnits","VolumeUnits","CurrencyUnit","AreaMeasurement","LinearMeasurement","VolumeMeasurement","Description","ProjectDescription","SiteDescription","Phase"] },
  { name: "Floor",      columns: ["Name","Category","Description","Elevation","Height"] },
  { name: "Space",      columns: ["Name","FloorName","Description","RoomTag","UsableHeight","GrossArea","NetArea","Category"] },
  { name: "Zone",       columns: ["Name","Category","SpaceNames","Description"] },
  { name: "Type",       columns: ["Name","Category","Description","AssetType","Manufacturer","ModelNumber","WarrantyGuarantorParts","WarrantyDurationParts","WarrantyGuarantorLabor","WarrantyDurationLabor","WarrantyDurationUnit","ReplacementCost","ExpectedLife","DurationUnit","NominalLength","NominalWidth","NominalHeight","Shape","Size","Color","Finish","Grade","Material","Constituents","Features","AccessibilityPerformance","CodePerformance","SustainabilityPerformance"] },
  { name: "Component",  columns: ["Name","TypeName","Space","Description","InstallationDate","WarrantyStartDate","TagNumber","BarCode","AssetIdentifier","SerialNumber"] },
  { name: "System",     columns: ["Name","ComponentNames","Description","Category"] },
  { name: "Assembly",   columns: ["Name","AssemblyType","SheetName","ParentName","ComponentNames","ExtSystem","ExtObject","ExtIdentifier","Description"] },
  { name: "Contact",    columns: ["Email","GivenName","FamilyName","Company","Phone"] },
  { name: "Coordinate", columns: ["Name","Category","SheetName","RowName","CoordinateXAxis","CoordinateYAxis","CoordinateZAxis","ExtSystem","ExtObject","ExtIdentifier"] },
  { name: "Attribute",  columns: ["Name","SheetName","RowName","Value","Unit","ExtSystem","ExtObject","ExtIdentifier","Description"] },
  { name: "Issue",      columns: ["Name","CreatedBy","CreatedOn","Type","Risk","Chance","Impact","Status","Description","Owner","Mitigation","ExtSystem","ExtObject","ExtIdentifier"] },
];

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: Record<string, string>[], columns: string[]): string {
  const header = columns.map(csvEscape).join(",");
  const lines = rows.map((r) => columns.map((c) => csvEscape(r[c] ?? "")).join(","));
  return "\ufeff" + [header, ...lines].join("\n");
}

function xmlSheetName(name: string): string {
  return name.replace(/[^\w]/g, "_");
}

/* ── Exporters ─────────────────────────────────────────────────────────── */

export function cobieToWorkbookHtml(ds: CobieDataset, projectName: string): string {
  let html = `<!doctype html>
<html xmlns:x="urn:schemas-microsoft-com:office:excel">
<head>
<meta charset="utf-8">
<title>${projectName} — COBie ${COBIE_VERSION}</title>
<!--[if gte mso 9]><xml>
<x:ExcelWorkbook>
  <x:ExcelWorksheets>
    ${SHEETS.map((s) => `<x:ExcelWorksheet><x:Name>${xmlSheetName(s.name)}</x:Name></x:ExcelWorksheet>`).join("")}
  </x:ExcelWorksheets>
</x:ExcelWorkbook>
</xml><![endif]-->
<style>
  body { font-family: system-ui, Arial, sans-serif; margin: 16px; }
  h1 { font-size: 16px; }
  h2 { font-size: 13px; margin-top: 22px; }
  table { border-collapse: collapse; font-size: 11px; margin: 6px 0 20px; }
  th { background: #f0f2f5; text-align: left; padding: 4px 8px;
       border: 1px solid #cbd5e1; font-weight: 700; white-space: nowrap; }
  td { padding: 3px 8px; border: 1px solid #e3e6ea; }
  .meta { color: #6b7280; font-size: 11px; margin-bottom: 12px; }
  .count { color: #94a3b8; font-weight: 400; font-size: 11px; }
</style>
</head>
<body>
<h1>${projectName} — COBie ${COBIE_VERSION}</h1>
<div class="meta">Generated ${new Date().toLocaleString()}</div>
`;

  for (const sheet of SHEETS) {
    const rows = ds[sheet.name] as Record<string, any>[];
    html += `<h2>${sheet.name} <span class="count">(${rows.length})</span></h2>`;
    if (!rows.length) {
      html += `<div class="meta">No ${sheet.name} rows.</div>`;
      continue;
    }
    html += `<table><thead><tr>${sheet.columns.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
    for (const row of rows) {
      html += `<tr>${sheet.columns.map((c) => `<td>${String(row[c] ?? "").replace(/[&<>]/g, (x) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[x])}</td>`).join("")}</tr>`;
    }
    html += `</tbody></table>`;
  }

  html += `</body></html>`;
  return html;
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

export function exportCobieXls(ds: CobieDataset, projectName: string): void {
  const html = cobieToWorkbookHtml(ds, projectName);
  const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const stamp = new Date().toISOString().slice(0, 10);
  download(blob, `cobie-${projectName.replace(/[^\w-]+/g, "_")}-${stamp}.xls`);
}

export async function exportCobieZip(ds: CobieDataset, projectName: string): Promise<void> {
  const zip = new JSZip();
  for (const sheet of SHEETS) {
    const rows = ds[sheet.name] as Record<string, any>[];
    zip.file(`${sheet.name}.csv`, toCsv(rows, sheet.columns));
  }
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    mimeType: "application/zip",
  });
  const stamp = new Date().toISOString().slice(0, 10);
  download(blob, `cobie-${projectName.replace(/[^\w-]+/g, "_")}-${stamp}.zip`);
}

/* ── One-shot convenience ──────────────────────────────────────────────── */

export async function exportCobie(
  opts: CobieBuildOptions & { format?: "xls" | "zip" } = {},
): Promise<void> {
  const ds = await gatherCobieDataset(opts);
  const name = opts.projectName ?? "Open BIM Studio Project";
  if (opts.format === "zip") await exportCobieZip(ds, name);
  else exportCobieXls(ds, name);
}