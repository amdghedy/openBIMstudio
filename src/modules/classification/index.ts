/**
 * Classification systems — published industry classification tables plus a
 * per-element assignment store. This is the data backbone for classification
 * that travels with the model: the property palette assigns codes, the IFC
 * writer emits them as IfcClassification / IfcClassificationReference /
 * IfcRelAssociatesClassification (both IFC4 and IFC2X3 attribute orders are
 * handled by authored-ifc.ts), and future schedule/QTO grouping can resolve
 * them.
 *
 * Seed data is a VERIFIED starter subset, never invented:
 *   • UniFormat II — the full Level 1-3 list from NISTIR 6389 (Charette &
 *     Marshall, NIST, October 1999), implementing ASTM E1557, including the
 *     Building Sitework chart (E1557-97). 7 groups, 22 level-2 groups,
 *     79 level-3 elements.
 *   • Uniclass 2015, table EF (Elements/functions) — starter subset of the
 *     current NBS release; titles © NBS, https://uniclass.thenbs.com
 *     (each seed code was checked against the published table).
 *   • OmniClass Table 21 (Elements) — starter subset of the table published
 *     by CSI; codes/titles verified against published Table 21 extracts.
 *
 * Full tables can be imported at runtime through importCodesFromCsv
 * (rows "Code,Title[,kw;kw]"). The module never synthesizes a code or a
 * title: unknown input is rejected with a reason, and assignments pointing
 * at unknown systems or codes are dropped when read back.
 */

export interface ClassificationCode {
  code: string;
  title: string;
  /** Depth within the system: 1 = top-level group. */
  level: number;
  /** Extra lowercase search hints (optional). */
  keywords?: string[];
}

export interface ClassificationSystem {
  /** Stable key used in assignments and IFC export ("uniformat-ii"). */
  id: string;
  name: string;
  edition: string;
  source: string;
  location?: string;
  codes: ClassificationCode[];
}

export interface ClassificationAssignment {
  elementId: string;
  systemId: string;
  code: string;
}

export interface SetAssignmentResult {
  ok: boolean;
  reason?: string;
}

export interface CsvImportResult {
  ok: boolean;
  added: number;
  skipped: number;
  errors: string[];
  reason?: string;
}

/** Same shape as authored-ifc.ts IfcClassificationInput (structural twin). */
export interface ClassificationIfcSystem {
  id: string;
  name: string;
  source?: string;
  edition?: string;
  location?: string;
  description?: string;
  items: Array<{ elementId: string; code: string; name?: string }>;
}

/* ═════════════════════════════════════════════════════════════════════════
   Seed data — "code|title|keywords" rows, keywords optional (comma-sep)
   ═════════════════════════════════════════════════════════════════════════ */

const UNIFORMAT_RAW = `
A|Substructure
A10|Foundations
A1010|Standard Foundations
A1020|Special Foundations
A1030|Slab on Grade|slab,ground
A20|Basement Construction
A2010|Basement Excavation
A2020|Basement Walls
B|Shell
B10|Superstructure
B1010|Floor Construction|slab,structural floor
B1020|Roof Construction|structural roof
B20|Exterior Enclosure
B2010|Exterior Walls|wall,facade
B2020|Exterior Windows|window,glazing
B2030|Exterior Doors|door
B30|Roofing
B3010|Roof Coverings|roof membrane
B3020|Roof Openings|skylight
C|Interiors
C10|Interior Construction
C1010|Partitions|wall,partition
C1020|Interior Doors|door
C1030|Fittings|casework,millwork
C20|Stairs
C2010|Stair Construction|stair
C2020|Stair Finishes|stair
C30|Interior Finishes
C3010|Wall Finishes|paint,render
C3020|Floor Finishes|flooring
C3030|Ceiling Finishes|ceiling
D|Services
D10|Conveying
D1010|Elevators & Lifts|elevator,lift
D1020|Escalators & Moving Walks|escalator
D1090|Other Conveying Systems
D20|Plumbing
D2010|Plumbing Fixtures|fixture
D2020|Domestic Water Distribution
D2030|Sanitary Waste
D2040|Rain Water Drainage
D2090|Other Plumbing Systems
D30|HVAC
D3010|Energy Supply
D3020|Heat Generating Systems|boiler
D3030|Cooling Generating Systems|chiller
D3040|Distribution Systems|duct,pipework
D3050|Terminal & Package Units|ahu
D3060|Controls & Instrumentation|bms
D3070|Systems Testing & Balancing
D3090|Other HVAC Systems & Equipment
D40|Fire Protection
D4010|Sprinklers|sprinkler
D4020|Standpipes
D4030|Fire Protection Specialties
D4090|Other Fire Protection Systems
D50|Electrical
D5010|Electrical Service & Distribution
D5020|Lighting and Branch Wiring|lighting
D5030|Communications & Security
D5090|Other Electrical Systems
E|Equipment & Furnishings
E10|Equipment
E1010|Commercial Equipment
E1020|Institutional Equipment
E1030|Vehicular Equipment
E1090|Other Equipment
E20|Furnishings
E2010|Fixed Furnishings
E2020|Movable Furnishings
F|Special Construction & Demolition
F10|Special Construction
F1010|Special Structures
F1020|Integrated Construction
F1030|Special Construction Systems
F1040|Special Facilities
F1050|Special Controls and Instrumentation
F20|Selective Building Demolition
F2010|Building Elements Demolition
F2020|Hazardous Components Abatement
G|Building Sitework
G10|Site Preparation
G1010|Site Clearing
G1020|Site Demolition and Relocations
G1030|Site Earthwork
G1040|Hazardous Waste Remediation
G20|Site Improvements
G2010|Roadways
G2020|Parking Lots
G2030|Pedestrian Paving|paving
G2040|Site Development
G2050|Landscaping
G30|Site Mechanical Utilities
G3010|Water Supply
G3020|Sanitary Sewer
G3030|Storm Sewer
G3040|Heating Distribution
G3050|Cooling Distribution
G3060|Fuel Distribution
G3090|Other Site Mechanical Utilities
G40|Site Electrical Utilities
G4010|Electrical Distribution
G4020|Site Lighting
G4030|Site Communications & Security
G4090|Other Site Electrical Utilities
G90|Other Site Construction
G9010|Service and Pedestrian Tunnels
G9090|Other Site Systems & Equipment
`;

const UNICLASS_RAW = `
EF_15_10|Groundworks and earthworks|groundworks
EF_20_05|Substructure
EF_20_05_30|Foundations|foundation
EF_20_10|Superstructure
EF_20_10_30|Framed structures|column,beam,frame
EF_20_10_80|Solid structures
EF_25|Wall and barrier elements
EF_25_10|Walls|wall
EF_25_10_25|External walls|wall,exterior,facade
EF_25_10_27|External walls below DPC|wall,exterior
EF_25_10_28|External walls below ground|wall,basement
EF_25_10_30|Free-standing walls|wall,retaining,fence
EF_25_10_40|Internal walls|wall,partition
EF_25_10_60|Parapet walls|wall,parapet
EF_25_30|Doors and windows|door,window
EF_25_30_25|Doors|door
EF_25_30_33|Gates|gate
EF_25_30_36|Hatches|hatch
EF_25_30_45|Louvres|louvre,louver
EF_25_30_95|Vents|vent
EF_25_30_97|Windows|window,glazing
EF_25_55|Barriers|barrier,hoarding
EF_30_10|Roofs|roof
EF_30_20|Floors|floor,slab
EF_30_20_06|Basement floors|floor,slab,basement
EF_30_20_34|Ground floors|floor,slab
EF_30_20_52|Mezzanine floors|floor,mezzanine
EF_30_20_93|Upper floors|floor,slab
EF_30_25|Ceilings and soffits|ceiling,soffit
EF_35_10|Stairs|stair
EF_35_10_30|External stairs|stair
EF_35_10_40|Internal stairs|stair
EF_35_20|Ramps|ramp
EF_35_20_30|External ramps|ramp
EF_35_20_40|Internal ramps|ramp
`;

const OMNICLASS_RAW = `
21-01 10 10 10|Wall Foundations
21-01 10 10 30|Column Foundations
21-01 10 10 90|Standard Foundation Supplementary Components
21-01 10 20|Special Foundations
21-01 20 10 90|Subgrade Enclosure Wall Supplementary Components
21-02 10|Superstructure
21-02 20 10|Exterior Walls
21-02 20 20|Exterior Windows
21-02 20 20 30|Exterior Window Wall
21-02 20 50 20|Exterior Utility Doors
21-02 20 80 50|Exterior Balcony Walls and Railings
`;

function parseRows(raw: string, levelOf: (code: string) => number): ClassificationCode[] {
  const out: ClassificationCode[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const cols = t.split("|").map((s) => s.trim());
    const code = cols[0] ?? "";
    const title = cols[1] ?? "";
    if (!code || !title) continue;
    const kw = (cols[2] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({
      code, title, level: levelOf(code),
      ...(kw.length ? { keywords: kw } : {}),
    });
  }
  return out;
}

function levelOfUniformat(code: string): number {
  if (/^[A-G]$/.test(code)) return 1;
  if (/^[A-G]\d{2}$/.test(code)) return 2;
  if (/^[A-G]\d{4}$/.test(code)) return 3;
  return 4;
}

function levelOfUniclass(code: string): number {
  const segs = code.replace(/^EF_/, "").split("_").filter(Boolean).length;
  return segs >= 1 && segs <= 3 ? segs : 4;
}

function levelOfOmniclass(code: string): number {
  const segs = code.replace(/^21-/, "").trim().split(/\s+/).filter(Boolean).length;
  // Published Table 21 hierarchy: 21-02 = Level 1, 21-02 10 = Level 2,
  // 21-02 20 10 = Level 3, 21-02 20 20 30 = Level 4 — segments = level.
  return Math.min(5, Math.max(1, segs));
}

const BUILT_INS: ClassificationSystem[] = [
  {
    id: "uniformat-ii",
    name: "UniFormat II",
    edition: "ASTM E1557-97 / NISTIR 6389 (1999)",
    source: "NISTIR 6389 (Charette & Marshall, NIST), ASTM E1557 — full Level 1-3 incl. sitework",
    codes: parseRows(UNIFORMAT_RAW, levelOfUniformat),
  },
  {
    id: "uniclass-2015-ef",
    name: "Uniclass 2015 (EF)",
    edition: "current NBS release (verified starter subset)",
    source: "Uniclass 2015 table EF (Elements/functions) — titles © NBS, uniclass.thenbs.com",
    location: "https://identifier.buildingsmart.org/uri/nbs/uniclass2015",
    codes: parseRows(UNICLASS_RAW, levelOfUniclass),
  },
  {
    id: "omniclass-21",
    name: "OmniClass Table 21 (Elements)",
    edition: "Table 21 (verified starter subset)",
    source: "OmniClass Construction Classification System, Table 21 — published by CSI",
    codes: parseRows(OMNICLASS_RAW, levelOfOmniclass),
  },
];

/* ═════════════════════════════════════════════════════════════════════════
   Imported codes (localStorage) — extends a built-in system, never replaces
   ═════════════════════════════════════════════════════════════════════════ */

const IMPORT_PREFIX = "obs.classification.imported.";
export const MAX_IMPORTED_CODES = 2000;

function readJson(key: string): unknown {
  let raw: string | null = null;
  try {
    raw = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch { raw = null; }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function getImportedCodes(systemId: string): ClassificationCode[] {
  const parsed = readJson(IMPORT_PREFIX + systemId);
  if (!Array.isArray(parsed)) return [];
  const out: ClassificationCode[] = [];
  for (const it of parsed) {
    if (!it || typeof it !== "object") continue;
    const c = it as Partial<ClassificationCode>;
    if (typeof c.code !== "string" || !c.code || typeof c.title !== "string" || !c.title) continue;
    out.push({
      code: c.code,
      title: c.title,
      level: typeof c.level === "number" ? c.level : 4,
      ...(Array.isArray(c.keywords)
        ? { keywords: c.keywords.filter((k): k is string => typeof k === "string" && !!k) }
        : {}),
    });
  }
  return out;
}

function persistImported(systemId: string, codes: ClassificationCode[]): void {
  try {
    localStorage.setItem(IMPORT_PREFIX + systemId, JSON.stringify(codes));
  } catch { /* quota — imports are best-effort */ }
}

/* ═════════════════════════════════════════════════════════════════════════
   Public API
   ═════════════════════════════════════════════════════════════════════════ */

export function listSystems(): ClassificationSystem[] {
  return BUILT_INS.map((s) => {
    const imported = getImportedCodes(s.id);
    const seen = new Set(s.codes.map((c) => c.code));
    const extra = imported.filter((c) => !seen.has(c.code));
    return extra.length
      ? { ...s, codes: [...s.codes, ...extra].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })) }
      : s;
  });
}

export function getSystem(systemId: string): ClassificationSystem | null {
  return listSystems().find((s) => s.id === systemId) ?? null;
}

const ASSIGN_KEY = "obs.classification.assignments";

export function getAssignments(): ClassificationAssignment[] {
  const parsed = readJson(ASSIGN_KEY);
  if (!Array.isArray(parsed)) return [];
  const out: ClassificationAssignment[] = [];
  for (const it of parsed) {
    if (!it || typeof it !== "object") continue;
    const a = it as Partial<ClassificationAssignment>;
    if (typeof a.elementId !== "string" || !a.elementId) continue;
    if (typeof a.systemId !== "string" || !a.systemId) continue;
    if (typeof a.code !== "string" || !a.code) continue;
    const sys = getSystem(a.systemId);
    if (!sys || !sys.codes.some((c) => c.code === a.code)) continue;
    out.push({ elementId: a.elementId, systemId: a.systemId, code: a.code });
  }
  return out;
}

export function getElementAssignments(elementId: string): ClassificationAssignment[] {
  return getAssignments().filter((a) => a.elementId === elementId);
}

export function setAssignment(
  elementId: string,
  systemId: string,
  code: string | null,
): SetAssignmentResult {
  const eid = String(elementId ?? "").trim();
  if (!eid) return { ok: false, reason: "elementId is required" };
  const sid = String(systemId ?? "").trim();
  const sys = getSystem(sid);
  if (!sys) return { ok: false, reason: `unknown classification system: ${sid}` };

  const rest = getAssignments().filter((a) => !(a.elementId === eid && a.systemId === sys.id));
  const c = code === null ? "" : String(code).trim();
  if (!c) {
    persistAssignments(rest);
    return { ok: true };
  }
  if (!sys.codes.some((x) => x.code === c)) {
    return { ok: false, reason: `unknown ${sys.name} code: ${c}` };
  }
  rest.push({ elementId: eid, systemId: sys.id, code: c });
  persistAssignments(rest);
  return { ok: true };
}

function persistAssignments(list: ClassificationAssignment[]): void {
  const sorted = [...list].sort(
    (a, b) =>
      a.elementId.localeCompare(b.elementId) ||
      a.systemId.localeCompare(b.systemId) ||
      a.code.localeCompare(b.code),
  );
  try {
    localStorage.setItem(ASSIGN_KEY, JSON.stringify(sorted));
  } catch { /* quota — assignments are best-effort */ }
}

/** Rank-ordered code search: exact/prefix code, then title prefix/substring, then keywords. */
export function searchCodes(systemId: string, query: string, limit = 14): ClassificationCode[] {
  const sys = getSystem(systemId);
  if (!sys) return [];
  const q = String(query ?? "").trim().toLowerCase();
  const scored: Array<{ c: ClassificationCode; rank: number }> = [];
  for (const c of sys.codes) {
    const code = c.code.toLowerCase();
    const title = c.title.toLowerCase();
    let rank: number;
    if (!q) rank = 0;
    else if (code === q || code.startsWith(q)) rank = 0;
    else if (title.startsWith(q)) rank = 1;
    else if (title.includes(q)) rank = 2;
    else if (code.includes(q) || (c.keywords ?? []).some((k) => k.toLowerCase().includes(q))) rank = 3;
    else continue;
    scored.push({ c, rank });
  }
  scored.sort(
    (a, b) => a.rank - b.rank || a.c.code.localeCompare(b.c.code, undefined, { numeric: true }),
  );
  return scored.slice(0, Math.max(1, limit)).map((s) => s.c);
}

/**
 * Import codes into a built-in system from CSV rows "Code,Title[,kw;kw]".
 * Duplicate codes (built-in or already imported) are skipped, malformed rows
 * are reported, and the per-system import cap keeps localStorage sane.
 * Creating new systems is not supported — extend the published ones instead.
 */
export function importCodesFromCsv(
  systemId: string,
  csv: string,
  opts: { maxCodes?: number } = {},
): CsvImportResult {
  const sid = String(systemId ?? "").trim();
  const base = BUILT_INS.find((s) => s.id === sid);
  if (!base) return { ok: false, added: 0, skipped: 0, errors: [], reason: `unknown classification system: ${sid}` };

  const currentImported = getImportedCodes(sid);
  const existing = new Set<string>([...base.codes, ...currentImported].map((c) => c.code));
  const cap = Math.max(0, Math.trunc(opts.maxCodes ?? MAX_IMPORTED_CODES));
  const added: ClassificationCode[] = [];
  const errors: string[] = [];
  let skipped = 0;

  const lines = String(csv ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",").map((s) => s.trim());
    const code = cols[0] ?? "";
    const title = cols[1] ?? "";
    if (i === 0 && /^["']?code["']?,/i.test(line)) continue; // header row
    if (!code || !title) {
      errors.push(`row ${i + 1}: code and title are required`);
      continue;
    }
    if (existing.has(code)) { skipped++; continue; }
    if (currentImported.length + added.length >= cap) {
      errors.push(`import stopped at the ${cap}-code cap for ${base.name}`);
      break;
    }
    const kw = (cols[2] ?? "")
      .split(/[;|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    added.push({
      code,
      title,
      level: baseLevelOf(sid, code),
      ...(kw.length ? { keywords: kw } : {}),
    });
    existing.add(code);
  }

  if (added.length) {
    persistImported(sid, [...getImportedCodes(sid), ...added]);
  }
  return { ok: errors.length === 0, added: added.length, skipped, errors };
}

function baseLevelOf(systemId: string, code: string): number {
  if (systemId === "uniformat-ii") return levelOfUniformat(code);
  if (systemId === "uniclass-2015-ef") return levelOfUniclass(code);
  return levelOfOmniclass(code);
}

/**
 * Build the IFC export payload from current assignments, restricted to the
 * elements that are actually being exported. Groups by system, sorts items
 * for deterministic output, and returns [] when nothing is assigned.
 */
export function buildIfcClassifications(
  elements: ReadonlyArray<{ id: string }>,
): ClassificationIfcSystem[] {
  const present = new Set(elements.map((e) => e.id));
  const bySystem = new Map<string, Array<{ elementId: string; code: string }>>();
  for (const a of getAssignments()) {
    if (!present.has(a.elementId)) continue;
    const arr = bySystem.get(a.systemId) ?? [];
    arr.push({ elementId: a.elementId, code: a.code });
    bySystem.set(a.systemId, arr);
  }
  const out: ClassificationIfcSystem[] = [];
  for (const [systemId, items] of bySystem) {
    const s = BUILT_INS.find((b) => b.id === systemId);
    if (!s || !items.length) continue;
    items.sort(
      (a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }) || a.elementId.localeCompare(b.elementId),
    );
    out.push({
      id: s.id,
      name: s.name,
      source: s.source,
      edition: s.edition,
      ...(s.location ? { location: s.location } : {}),
      items,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
