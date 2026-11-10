/**
 * Drawing Editor — Standalone 2D DWG/DXF Environment.
 *
 * Provides:
 * - Model Space and Layout / Paper Space views
 * - Full-screen crosshairs with central pickbox
 * - Object Snap support (F3) with colored glyphs and snap tooltips
 * - Dynamic Input HUD (F12) with real-time coordinate & polar @dist<ang readouts
 * - Authentic User Coordinate System (UCS) 2D/3D icon with World (WCS) & custom origin markers
 * - Interactive in-canvas ViewCube (Top/Front/Roll) and Navigation Bar (Pan/Zoom Extents/Window)
 * - Multi-line command window with real-time Autocomplete popup, command history & aliases:
 *   L (LINE), PL (PLINE), C (CIRCLE), REC (RECTANG), A (ARC), E (ERASE), DI (DIST), AA (AREA),
 *   ID, LI (LIST), Z (ZOOM [All/Extents/Window/Previous]), P (PAN), LA (LAYER), PR (PROPERTIES),
 *   RE (REGEN), UN (UNITS), UCS, PU (PURGE), U (UNDO), REDO, ORTHO (F8), OSNAP (F3), GRID (F7), DYN (F12)
 * - Native 2D drawing tools: Line, Polyline, Circle, Rectangle, Arc drafting with Undo/Redo stack
 * - Professional drawing modification tools: MOVE (M), COPY (CO), ROTATE (RO), MIRROR (MI), SCALE (SC),
 *   OFFSET (O) — base-point flows, live ghost preview, dynamic-input prompts, Undo/Redo support
 * - Full Layer Properties Manager (LA) with On/Off, Freeze, Lock, ACI Colors, and Linetypes
 * - Standard Window (blue solid) vs Crossing (green dashed) selection modes
 * - Modern dark charcoal canvas (#212830) with adaptive major/minor grid & colored axes
 */

import { readCadFile } from "../modules/cad-link/index";
import { BlockLibrary, makeBlock, instantiateBlock, blockToDocument, blockExtent, validateBlockName, type BlockDef } from "../modules/drawings/cad-blocks";
import { importSvg } from "../modules/drawings/svg-import";
import { FIELD_KINDS, evaluateField, type FieldKind } from "../modules/drawings/cad-fields";
import { aciToRgb, rgbToCss } from "../modules/drawings/aci";
import { downloadDxf, writeDxf, layoutsNotSaved, DWG_VERSIONS, DEFAULT_DWG_VERSION, dwgVersionLabel, type DwgVersionCode } from "../modules/drawings/dxf-writer";
import { recordRecentDrawing, recentFormatOf } from "./cad-recent";
import { uiAlert } from "../core/notify";
import { exportDxfToDwg, validateDxfForDwgExport } from "../modules/drawings/acad-engine";
import {
  makeClip,
  clipInstances,
  collectClipDeps,
  missingClipDeps,
  serializeClip,
  parseClip,
  type CadClip,
} from "../modules/cad-viewer/clipboard";
import type { DxfDocument, DxfEntity } from "../modules/drawings/dxf-types";
import { escapeHtml } from "../core/html-escape";
import { setCadHotkeyOwner } from "../core/cad-hotkey-ownership";
import { resolveDblClick } from "../shell/ribbon-collapse";
import * as M from "../modules/cad-viewer/viewer-math";
import * as X from "../modules/cad-viewer/modify-math";
import { evalExpr, isCalcExpr } from "../modules/cad-viewer/cad-cal";
import { svgIcon, type IconName } from "./icon-set";
import {
  openAiChatInHost, closeAiChat, isAiChatVisible, isAiChatCadHosted, releaseAiChatToDefaultHost, askAiChat,
} from "./ai-chat";
import { promptLine, confirmDialog, pickFromList, openFormModal, showTableDialog } from "./form-modal";
import { loadCadAliases, resolveCadToken, openCadAliasEditor, effectiveAliases, registerCadAliasEditorOpener } from "./command-aliases";
import {
  renderAppearanceEditor, openLinetypeManager, openTextStyleManager, placeText, editLayerProperty,
  matchProperties, newObjectProps, lineweightPx, type CadStyleApi,
} from "./cad-style-ui";
import { lineweightLabel } from "../modules/drawings/cad-styles";
import { readDwgPreview, type DwgPreviewImage } from "../modules/drawings/dwg-preview";
import {
  grayscaleChannel,
  loadPlotStyleFile,
  plotStyleByName,
  plotStyleForAci,
  resolvePlotStyle,
  rgbToChannels,
  type PlotStyleTable,
} from "../modules/drawings/plot-styles";
import { isLandXml, parseLandXmlPoints } from "../modules/drawings/landxml";
import * as P from "./cad-params";
import { buildLinearDimension } from "../modules/cad-viewer/dimension-tools";
import { fmtTime } from "../core/region";

type Tool =
  | "pan"
  | "select"
  | "box"
  | "zoomwin"
  | "dist"
  | "chain"
  | "poly"
  | "area"
  | "angle"
  | "bearing"
  | "offset"
  | "coord"
  | "radius"
  | "id"
  | "dim"
  | "dimlinear"
  | "calibrate"
  | "origin"
  | "stamp"
  | "leader"
  | "cloud"
  | "redline"
  | "note"
  | "text"
  | "match"
  | "line"
  | "circle"
  | "rect"
  | "arc"
  | "erase"
  | "move"
  | "copy"
  | "paste"
  | "rotate"
  | "mirror"
  | "scale"
  // native-engine drafting tools (full 2D drawing ribbon)
  | "polygon"
  | "spline"
  | "ellipse"
  | "donut"
  | "point"
  | "hatch"
  | "wipeout"
  | "xline"
  | "ray"
  | "trim"
  | "extend"
  | "break"
  | "fillet"
  | "chamfer"
  | "join"
  | "explode"
  | "align"
  | "stretch"
  | "matchlayer"
  | "dimang"
  | "dimarc"
  | "dimdia"
  | "dimcenter"
  | "dimcont"
  | "dimbase"
  | "table"
  | "lengthen"
  | "divide"
  | "measure"
  | "ddedit"
  | "layiso"
  | "layoff"
  | "laylck"
  | "layunlck"
  | "mleader"
  // Parametric constraints (one-shot geometric fixes) + Express Tools
  | "con2p"
  | "confix"
  | "txt2mtxt"
  | "explodetext"
  | "textfit"
  | "arctext"
  | "textmask"
  | "breakline"
  | "laymrg"
  | "laydel";

type ColorMode = "layer" | "bw" | "invert" | "style";
interface Markup {
  kind: "line" | "note" | "dim" | "cloud" | "stamp" | "leader" | "dimang" | "dimarc" | "dimdia" | "dimcenter";
  pts: M.Pt[];
  text?: string;
}

interface CadCommandDef {
  name: string;
  aliases: string[];
  description: string;
}

const CAD_COMMANDS: CadCommandDef[] = [
  { name: "LINE", aliases: ["L"], description: "Create straight line segments" },
  { name: "PLINE", aliases: ["PL"], description: "Create a 2D polyline" },
  { name: "CIRCLE", aliases: ["C"], description: "Create a circle from center and radius" },
  { name: "RECTANG", aliases: ["REC", "RECTANGLE"], description: "Create a rectangular polyline" },
  { name: "ARC", aliases: ["A"], description: "Create an arc using 3 points" },
  { name: "ERASE", aliases: ["E", "DEL"], description: "Erase selected objects" },
  { name: "MOVE", aliases: ["M"], description: "Move selected objects a distance and direction" },
  { name: "COPY", aliases: ["CO"], description: "Copy selected objects to multiple placements from one fixed base point" },
  { name: "REVCLOUD", aliases: ["RC", "CLOUD"], description: "Create a revision cloud polyline; click boundary points, then Enter or double-click" },
  { name: "ROTATE", aliases: ["RO"], description: "Rotate selected objects around a base point" },
  { name: "MIRROR", aliases: ["MI"], description: "Mirror selected objects about a two-point axis" },
  { name: "SCALE", aliases: ["SC"], description: "Scale selected objects about a base point" },
  { name: "OFFSET", aliases: ["O"], description: "Create concentric parallel copies at a distance" },
  { name: "DIST", aliases: ["DI", "DISTANCE"], description: "Measure distance and angle between points" },
  { name: "AREA", aliases: ["AA"], description: "Calculate area and perimeter of an object or region" },
  { name: "ID", aliases: ["ID"], description: "Display the coordinate values of a location" },
  { name: "LIST", aliases: ["LI"], description: "Display property data for selected objects" },
  { name: "ZOOM", aliases: ["Z"], description: "Zoom view: [All/Extents/Window/Previous]" },
  { name: "PAN", aliases: ["P"], description: "Move the view without changing magnification" },
  { name: "LAYER", aliases: ["LA", "LAYERS"], description: "Open Layer Properties Manager" },
  { name: "LINETYPE", aliases: ["LT", "LTYPE"], description: "Open the Linetype Manager (load linetypes, set current)" },
  { name: "LTSCALE", aliases: ["LTS"], description: "Set the global linetype scale, e.g. LTSCALE 2" },
  { name: "STYLE", aliases: ["ST"], description: "Open the Text Style Manager (fonts, heights, presets)" },
  { name: "TEXT", aliases: ["T", "DT", "DTEXT", "MT", "MTEXT"], description: "Place text with the current text style" },
  { name: "MATCHPROP", aliases: ["MA"], description: "Copy layer, colour, linetype and lineweight from one object to others" },
  { name: "PROPERTIES", aliases: ["PR", "CH", "PROP"], description: "Show properties inspector" },
  { name: "REGEN", aliases: ["RE", "REA", "REGENALL"], description: "Regenerate view and graphics" },
  { name: "UNITS", aliases: ["UN"], description: "Control coordinate and angle display format" },
  { name: "UCS", aliases: ["UCS"], description: "Manage User Coordinate System" },
  { name: "PURGE", aliases: ["PU"], description: "Remove unused named items and empty layers" },
  { name: "AUDIT", aliases: ["AUDIT"], description: "Audit drawing database integrity" },
  { name: "ORTHO", aliases: ["ORTHOMODE", "F8"], description: "Constrain cursor movement horizontally/vertically" },
  { name: "OSNAP", aliases: ["F3"], description: "Toggle Object Snaps" },
  { name: "GRID", aliases: ["F7"], description: "Toggle coordinate grid display" },
  { name: "DYN", aliases: ["DYNMODE", "F12"], description: "Toggle Dynamic Input HUD at cursor" },
  { name: "SNAP", aliases: ["F9"], description: "Toggle grid snapping" },
  { name: "UNDO", aliases: ["U"], description: "Undo the last drafting or modify operation" },
  { name: "REDO", aliases: ["REDO"], description: "Redo the previously undone operation" },
  { name: "PLOT", aliases: ["PRINT"], description: "Plot drawing to PDF or physical paper" },
  { name: "QSAVE", aliases: ["SAVE"], description: "Save the edited drawing as a DXF file" },
  { name: "SAVEAS", aliases: ["SA"], description: "Choose DXF or DWG for export" },
  { name: "DWGSAVE", aliases: ["EXPORTDWG"], description: "Export the edited drawing as a native DWG file (in the version set by DWGVERSION)" },
  { name: "DWGVERSION", aliases: ["DWGVER"], description: "Choose the target DWG version for export (2000 to 2018)" },
  { name: "DATAEXTRACT", aliases: ["EATTEXT", "DX"], description: "Export all entity data (layer, type, colour, geometry) to a CSV file" },
  { name: "LANDXMLIN", aliases: ["XMLIN"], description: "Import survey points from a LandXML CgPoints file" },
  { name: "SVGSAVE", aliases: ["EXPORTSVG"], description: "Export the current view as an SVG image" },
  { name: "COPYCLIP", aliases: ["CC"], description: "Super Copy: copy selected objects with their layers, linetypes and text styles to the cross-drawing clipboard (Ctrl+C / Ctrl+Shift+C)" },
  { name: "PASTECLIP", aliases: [], description: "Paste clipboard objects into this drawing — click to place, repeat for multiple copies (Ctrl+V / Ctrl+Shift+V)" },
  { name: "PASTEORIG", aliases: [], description: "Paste clipboard at the original coordinates (Ctrl+Alt+V)" },
  { name: "SAVEALL", aliases: ["SALL"], description: "Save every open drawing tab" },
  { name: "CLOSE", aliases: [], description: "Close the current drawing tab" },
  { name: "CLEANSCREEN", aliases: ["CLEAN"], description: "Toggle clean screen mode (Ctrl+0)" },
  // ── Native-engine drafting commands (full 2D drawing ribbon) ──
  { name: "XLINE", aliases: ["XL"], description: "Create an infinite construction line" },
  { name: "RAY", aliases: ["RAY"], description: "Create a one-sided ray from a point" },
  { name: "POLYGON", aliases: ["POL"], description: "Create a regular polygon (3-1024 sides)" },
  { name: "SPLINE", aliases: ["SPL"], description: "Create a smooth spline through picked points" },
  { name: "ELLIPSE", aliases: ["EL"], description: "Create an ellipse from center and two axes" },
  { name: "DONUT", aliases: ["DO"], description: "Create a filled ring (donut) from center and radius" },
  { name: "POINT", aliases: ["PO"], description: "Place a point object" },
  { name: "HATCH", aliases: ["H", "BHATCH"], description: "Fill a closed polyline with a solid hatch" },
  { name: "WIPEOUT", aliases: ["WI", "WIPE"], description: "Mask drawing content behind a polygon frame" },
  { name: "TRIM", aliases: ["TR", "TRIM"], description: "Trim objects at cutting edges" },
  { name: "EXTEND", aliases: ["EX"], description: "Extend objects to boundary edges" },
  { name: "BREAK", aliases: ["BR"], description: "Break an object between two points" },
  { name: "FILLET", aliases: ["F"], description: "Fillet two lines with a tangent arc (FILLET R <radius>)" },
  { name: "CHAMFER", aliases: ["CHA"], description: "Bevel two lines (CHAMFER <d1> <d2>)" },
  { name: "JOIN", aliases: ["J"], description: "Join collinear lines / polylines into one polyline" },
  { name: "EXPLODE", aliases: ["X"], description: "Explode polylines into individual segments" },
  { name: "STRETCH", aliases: ["S"], description: "Stretch objects through a crossing window" },
  { name: "ALIGN", aliases: ["AL"], description: "Move + rotate objects onto a two-point alignment" },
  { name: "MATCHLAYER", aliases: ["ML", "LAYMCH"], description: "Move objects onto the source object's layer" },
  { name: "ARRAY", aliases: ["AR"], description: "Rectangular array: rows, columns, row & column spacing" },
  { name: "LENGTHEN", aliases: ["LEN"], description: "Stretch the end of a line/arc/polyline — click and drag, or LENGTHEN <total> / LENGTHEN D <delta>" },
  { name: "DIVIDE", aliases: ["DIV"], description: "Divide a line/arc/polyline into N equal segments and place point objects" },
  { name: "MEASURE", aliases: ["ME"], description: "Place point objects at fixed intervals along a line/arc/polyline" },
  { name: "DDEDIT", aliases: ["ED", "TEXTEDIT"], description: "Edit the text content of a picked TEXT / MTEXT object" },
  { name: "LAYISO", aliases: ["LAYISOLATE"], description: "Isolate the layer of the picked object — hide every other layer (LAYUNISO restores)" },
  { name: "LAYUNISO", aliases: [], description: "Restore the layers hidden by LAYISO" },
  { name: "LAYOFF", aliases: [], description: "Turn off the layer of the picked object" },
  { name: "LAYLCK", aliases: [], description: "Lock the layer of the picked object" },
  { name: "LAYUNLCK", aliases: ["LAYUNLOCK"], description: "Unlock the layer of the picked object" },
  { name: "MLEADER", aliases: ["MLD", "LE", "LEADER"], description: "Draw a leader line with annotation text: arrow point → landing end → type the text" },
  { name: "QSELECT", aliases: ["QSI"], description: "Quick select by type, layer, ACI/RGB colour, linetype, lineweight, text content or all visible objects" },
  { name: "SELECTSIMILAR", aliases: ["SELSIM"], description: "Select objects matching the selected set by type, layer, colour, linetype or lineweight" },
  { name: "ARRAYPOLAR", aliases: ["ARP"], description: "Create a polar array around a centre point; choose item count, sweep angle and whether items rotate" },
  { name: "PEDIT", aliases: ["PE"], description: "Edit polylines: PEDIT J (join selection) · PEDIT C (close) · PEDIT O (open) · PEDIT R (reverse)" },
  { name: "CAL", aliases: ["QUICKCALC", "QC"], description: "Evaluate an expression: CAL 2*PI*25 · sin/cos/tan (degrees) · sqrt/abs/round/min/max" },
  { name: "FIND", aliases: ["FIND"], description: "Find and replace text in the drawing" },
  { name: "VIEW", aliases: ["V"], description: "Named views: VIEW S <name> saves, VIEW R <name> restores" },
  { name: "LAYERSTATE", aliases: ["LAS", "LAYSTATE"], description: "Layer states: LAYERSTATE S|R <name>" },
  { name: "OVERKILL", aliases: ["OVERKILL"], description: "Remove duplicate / overlapping entities" },
  { name: "DIMALIGNED", aliases: ["DAL"], description: "Place an aligned dimension with two measured points and a line location" },
  { name: "DIMLINEAR", aliases: ["DLI"], description: "Place a horizontal or vertical dimension" },
  { name: "DIMANGULAR", aliases: ["DAN", "DIMANG"], description: "Angular dimension from a vertex and two rays" },
  { name: "DIMARC", aliases: ["DAR"], description: "Arc-length dimension on a picked arc" },
  { name: "DIMDIAMETER", aliases: ["DDI", "DIMDIA"], description: "Diameter dimension on a circle" },
  { name: "DIMCENTER", aliases: ["DCE"], description: "Center mark on a circle or arc" },
  { name: "DIMCONTINUE", aliases: ["DCO", "DIMCONT"], description: "Continue a dimension from the last one" },
  { name: "DIMBASELINE", aliases: ["DBA", "DIMBASE"], description: "Baseline dimension from the last one" },
  { name: "TABLE", aliases: ["TB"], description: "Insert a drawing table (rows × columns grid)" },
  { name: "IMPORT", aliases: ["IMP"], description: "Merge a DWG / DXF file into the current drawing" },
  { name: "BLOCK", aliases: ["B", "BMAKE"], description: "Create a block from the selected objects (base point, name)" },
  { name: "INSERT", aliases: ["I", "DDINSERT"], description: "Insert a block from the library (scale, rotation) or a drawing file as a block" },
  { name: "WBLOCK", aliases: ["W"], description: "Write the selected objects (or a library block) to a DXF file" },
  { name: "BLOCKLIB", aliases: ["BLOCKS", "BLIB"], description: "Block library: list, insert, rename, delete, export" },
  { name: "SVGIMPORT", aliases: ["SVG"], description: "Import an SVG file as polylines and circles" },
  { name: "FIELD", aliases: ["FLD"], description: "Insert text computed from the drawing (date, name, length, area...)" },
  { name: "DWGOPEN", aliases: [], description: "Open DWG / DXF drawings as new tabs in this editor (LibreDWG reader worker)" },
  { name: "DWGJSONIMP", aliases: ["JSONDUMP"], description: "Re-import a dwg2json database dump into the editor (JSON round trip)" },
  { name: "DWGREWRITE", aliases: ["SAVETODXF"], description: "Re-save the drawing through the DXF writer" },
  { name: "DWG2JSON", aliases: [], description: "Dump the full drawing database as JSON" },
  { name: "DWG2SVG", aliases: [], description: "Flattened 2D vector export with per-entity colors" },
  { name: "DWG2GEOJSON", aliases: [], description: "Points / lines / polygons GeoJSON in drawing coordinates" },
  { name: "DWG2PS", aliases: [], description: "EPS export via moveto/lineto/arc — prints anywhere" },
  { name: "DWGAUDIT", aliases: [], description: "Drawing integrity report: zero-length geometry, dangling references and entity counts" },
  { name: "DWGTABLES", aliases: [], description: "Browse the LAYER / LTYPE / STYLE / DIMSTYLE tables" },
  { name: "DWGCENSUS", aliases: [], description: "Count entities by type in model space" },
  { name: "DWGTHUMB", aliases: ["DWGBMP"], description: "Extract the embedded preview bitmap from a DWG file" },
  { name: "SELECTSIMILAR", aliases: ["SELSIM"], description: "Select all objects sharing type and layer with the current selection" },
  { name: "KS", aliases: ["ALIASEDIT", "ALIASES", "SHORTCUTS"], description: "Edit command aliases (abbreviations)" },
  /* ── Parametric tab: one-shot geometric + dimensional constraints ── */
  { name: "AUTOCONSTRAIN", aliases: ["ACON"], description: "Detect and exactify near-horizontal / vertical / concentric relations" },
  { name: "FIX", aliases: ["CONSTRAINTFIX"], description: "Pin objects — edits are refused until UNFIX" },
  { name: "UNFIX", aliases: ["CONSTRAINTUNFIX"], description: "Release the FIX constraint on picked objects" },
  { name: "HORIZONTAL", aliases: [], description: "Force the picked line level" },
  { name: "VERTICAL", aliases: [], description: "Force the picked line plumb" },
  { name: "PERPENDICULAR", aliases: ["PERP"], description: "Make the second line perpendicular to the first" },
  { name: "PARALLEL", aliases: ["PAR"], description: "Make the second line parallel to the first" },
  { name: "TANGENT", aliases: ["TAN"], description: "Translate the line so it touches the circle exactly" },
  { name: "CONCENTRIC", aliases: ["CENC"], description: "Snap the second circle onto the first one's center" },
  { name: "COINCIDENT", aliases: ["COINC"], description: "Snap the second line's nearest endpoint onto the first" },
  { name: "SYMMETRIC", aliases: ["SYM"], description: "Mirror the first pick about the axis line picked second" },
  { name: "EQUAL", aliases: ["EQ"], description: "Equalize lengths / radii of two objects" },
  { name: "DCLINEAR", aliases: ["DCLIN"], description: "Set a line to an exact length" },
  { name: "DCRADIUS", aliases: ["DCRAD"], description: "Set a circle or arc to an exact radius" },
  { name: "DCDIAMETER", aliases: ["DCDIA"], description: "Set a circle or arc to an exact diameter" },
  { name: "DCANGULAR", aliases: ["DCANG"], description: "Set the angle between two lines" },
  { name: "CONSTRAINTBAR", aliases: ["CONBAR"], description: "Show or hide the FIX constraint markers" },
  { name: "DELCONSTRAINT", aliases: ["DELCON"], description: "Release every FIX constraint" },
  /* ── Express Tools tab ── */
  { name: "TXT2MTXT", aliases: ["TXT2MTEXT"], description: "Convert single-line TEXT into a wrapped MTEXT column" },
  { name: "EXPLODETEXT", aliases: ["XTEXT"], description: "Explode MTEXT back to plain TEXT" },
  { name: "TEXTFIT", aliases: ["TFIT"], description: "Squeeze or stretch a text's width factor to span two points" },
  { name: "ARCTEXT", aliases: ["ARCALIGNEDTEXT"], description: "Lay text characters along an arc or circle" },
  { name: "TEXTMASK", aliases: ["TMASK"], description: "Toggle a background mask behind text" },
  { name: "FLATTEN", aliases: ["FLAT"], description: "Set every object to Z = 0" },
  { name: "BREAKLINE", aliases: ["BRKLN"], description: "Draw a break line with the standard zig-zag symbol" },
  { name: "LAYMRG", aliases: ["LAYMERGE"], description: "Merge one layer into another and remove it" },
  { name: "LAYDEL", aliases: ["LAYDELETE"], description: "Delete a layer and everything on it" },
  { name: "LAYWALK", aliases: ["LWALK"], description: "Walk the drawing layer by layer" },
  { name: "LAYFRZ", aliases: ["LFRZ"], description: "Freeze the layers of the selected objects" },
  { name: "LAYTHW", aliases: ["LTHW"], description: "Thaw every frozen layer" },
  /* ── Collaborate tab ── */
  { name: "PUBLISH", aliases: ["PUB"], description: "Batch-write every open drawing to DWG" },
  { name: "SHAREVIEW", aliases: ["SHARE"], description: "Export the current view as a PNG" },
  { name: "DWGHISTORY", aliases: ["HISTORY"], description: "Session command history + undo depth" },
  { name: "CHECKSTANDARDS", aliases: ["CHKSTD"], description: "Audit layers / linetypes / text styles against the standard rules" },
];

const BG: Record<string, string> = {
  drafting: "#212830", // Drawing workspace dark charcoal
  black: "#000000",
  dark: "#1c2128",
  grey: "#808080",
  white: "#ffffff",
};

interface CadEngineApi {
  load(f: File): Promise<void>;
  /** Execute raw command-line text in this drawing (AI copilot bridge). */
  runCommandText(text: string): void;
  /** AI snapshot: active tool and entity count of this drawing. */
  aiSnapshot(): { tool: string; entityCount: number };
  close(): void;
  activate(): void;
  deactivate(): void;
  isDirty(): boolean;
  markSaved(): void;
  copySelection(): boolean;
  pasteClip(at?: M.Pt): number;
  pasteOrig(): number;
  hasClip(): boolean;
  saveDxf(): void;
  saveDwg(): Promise<void>;
  fileName(): string;
  focus(): void;
  /** Run a ribbon action by id (shell A-menu / Quick Access toolbar → active drawing). */
  exec(action: string): void;
  /** Import LandXML CgPoints survey data into the current drawing. */
  importLandXml(f: File): Promise<void>;
}

interface EngineHooks {
  onDirty(d: boolean): void;
  onTitle(n: string): void;
  saveAll(): void;
  requestClose(): void;
}

interface DocTab {
  id: number;
  engine: CadEngineApi;
  page: HTMLDivElement;
  title: string;
  dirty: boolean;
}

let shell: HTMLDivElement | null = null;
let strip: HTMLDivElement | null = null;
let pagesEl: HTMLDivElement | null = null;
let picker: HTMLInputElement | null = null;
/** LandXML CgPoints import picker (LANDXMLIN command + app menu). */
let xmlPicker: HTMLInputElement | null = null;
let tabs: DocTab[] = [];
let active: DocTab | null = null;
let nextTabId = 1;
/** Block library shared by every drawing tab; persisted in this browser. */
const BLOCK_LIB_KEY = "obs.cad.blocks";
const blockLib: BlockLibrary = (() => {
  try {
    const raw = localStorage.getItem(BLOCK_LIB_KEY);
    if (raw) return BlockLibrary.fromJSON(JSON.parse(raw)).lib;
  } catch { /* storage unavailable or corrupt: start empty */ }
  return new BlockLibrary();
})();
/** Returns false when the browser refused to store (quota), so the caller can say so. */
function persistBlockLib(): boolean {
  try { localStorage.setItem(BLOCK_LIB_KEY, JSON.stringify(blockLib.toJSON())); return true; } catch { return false; }
}
/** Shared cross-drawing clipboard (COPYCLIP in one tab, PASTECLIP in another). */
let clip: CadClip | null = null;

/* ═══════════════════════════════════════════════════════════════════════════
   Shell ribbon (multi-document interface). The ribbon lives ONCE at shell level:
   ribbon tabs row → active tab's panels → drawing file tabs → viewport.
   Every drawing contributes its own panel set; only the active drawing's
   panels are visible, and the ribbon tabs filter which panel groups show.
   ═══════════════════════════════════════════════════════════════════════════ */
const RIBBON_TABS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "home", label: "Home" },
  { id: "insert", label: "Insert" },
  { id: "annotate", label: "Annotate" },
  { id: "parametric", label: "Parametric" },
  { id: "view", label: "View" },
  { id: "manage", label: "Manage" },
  { id: "output", label: "Output" },
  { id: "express", label: "Express Tools" },
  { id: "collaborate", label: "Collaborate" },
];
let ribbonTab = "home";
try {
  const saved = localStorage.getItem("obs.cad.ribbon.tab");
  if (saved && RIBBON_TABS.some((t) => t.id === saved)) ribbonTab = saved;
} catch { /* private browsing / storage blocked */ }
let ribbonStrip: HTMLDivElement | null = null;
let ribbonTabsRow: HTMLDivElement | null = null;
let ribbonActive: CadEngineApi | null = null;
const ribbonEngines = new Map<CadEngineApi, HTMLDivElement>();

/** Ribbon minimize (double-click a tab) - the strip hides, the tab row stays, the drawing gets the space. */
let ribbonMinimized = false;
let ribbonLastAutoExpandAt = 0;
try { ribbonMinimized = localStorage.getItem("obs.cad.ribbon.min") === "1"; } catch { /* storage blocked */ }

function applyCadRibbonMinimized(min: boolean): void {
  ribbonMinimized = min;
  shell?.classList.toggle("cad-ribbon--min", min);
  try { localStorage.setItem("obs.cad.ribbon.min", min ? "1" : "0"); } catch { /* */ }
  // the drawing area changed size - let the canvas refit
  window.dispatchEvent(new Event("resize"));
}

/** Full screen: hide the drawing's side panel, command line, layout tabs and status bar. */
let cadFullscreenInstalled = false;
function installCadFullscreen(): void {
  if (cadFullscreenInstalled) return;
  cadFullscreenInstalled = true;
  const onChange = () => {
    document.querySelectorAll(".obs-cad-viewer.obs-cad-fs").forEach((n) => {
      n.classList.remove("obs-cad-fs", "obs-cad-fs--peek");
      n.querySelector(":scope > .obs-cad-fs-chip")?.remove();
    });
    const fe = ((document as any).fullscreenElement ?? (document as any).webkitFullscreenElement) as HTMLElement | null;
    if (fe && fe.classList.contains("obs-cad-viewer")) {
      fe.classList.add("obs-cad-fs");
      const chip = document.createElement("button");
      chip.className = "obs-cad-fs-chip";
      chip.textContent = "Show command bars";
      chip.title = "Show or hide the command line, status bar and side panel (Esc leaves full screen)";
      chip.onclick = () => {
        const peek = fe.classList.toggle("obs-cad-fs--peek");
        chip.textContent = peek ? "Hide command bars" : "Show command bars";
        window.dispatchEvent(new Event("resize"));
      };
      fe.appendChild(chip);
    }
    window.dispatchEvent(new Event("resize"));
  };
  document.addEventListener("fullscreenchange", onChange);
  document.addEventListener("webkitfullscreenchange", onChange as EventListener);
}

function applyRibbonTab(): void {
  ribbonStrip?.setAttribute("data-ribbon-tab", ribbonTab);
  ribbonTabsRow?.querySelectorAll<HTMLElement>("[data-ribtab]").forEach((b) =>
    b.classList.toggle("on", b.dataset.ribtab === ribbonTab),
  );
  try { localStorage.setItem("obs.cad.ribbon.tab", ribbonTab); } catch { /* */ }
}

function registerRibbonEngine(wrap: HTMLDivElement, engine: CadEngineApi): void {
  wrap.className = "cadrb-enginewrap";
  ribbonEngines.set(engine, wrap);
  if (ribbonStrip) ribbonStrip.appendChild(wrap);
}

function showRibbonEngine(wrap: HTMLDivElement, engine: CadEngineApi): void {
  ribbonActive = engine;
  if (!ribbonStrip) return;
  if (wrap.parentElement !== ribbonStrip) ribbonStrip.appendChild(wrap);
  for (const w of Array.from(ribbonStrip.children)) w.classList.toggle("on", w === wrap);
  applyRibbonTab();
}

let unregisterCadAliasEditorOpener: (() => void) | null = null;

function registerCadAliasApi(): void {
  loadCadAliases();
  unregisterCadAliasEditorOpener?.();
  const openEditor = () =>
    openCadAliasEditor(
      CAD_COMMANDS.map((c) => ({
        name: c.name,
        aliases: effectiveAliases(c.name, c.aliases),
        description: c.description,
      })),
    );
  unregisterCadAliasEditorOpener = registerCadAliasEditorOpener(openEditor);
}

export function openCadViewer(file?: File): void {
  registerCadAliasApi();
  ensureShell();
  shell!.style.display = "flex";
  try {
    (window as any).__obsCadOwnsEsc = () => !!shell && shell.style.display !== "none";
    // Keyboard ownership: while a drawing tab is active the BIM global shortcut
    // registry yields the drawing-editor shortcuts to this viewer (see shortcuts.ts).
    (window as any).__obsCadOwnsKeys = () => !!active && !!shell && shell.style.display !== "none";
  } catch {
    /* */
  }
  if (file) openFile(file);
  else if (!tabs.length) openBlank();
  active?.engine.focus();
}

export function closeCadViewer(): void {
  hideShell();
  unregisterCadAliasEditorOpener?.();
  unregisterCadAliasEditorOpener = null;
}

function byId(id: number): DocTab | null {
  return tabs.find((t) => t.id === id) ?? null;
}

function renderStrip(): void {
  if (!strip) return;
  strip.innerHTML =
    tabs
      .map(
        (t) =>
          `<button class="cadtab${t === active ? " on" : ""}" data-tab="${t.id}" title="${escapeHtml(t.title || "Drawing")}"><span class="cadtab__name">${escapeHtml(t.title || "Drawing")}</span><span class="cadtab__dirty"${t.dirty ? "" : ' style="display:none"'}>●</span><span class="cadtab__x" data-x="${t.id}" title="Close drawing">×</span></button>`,
      )
      .join("") + `<button class="cadtab cadtab--plus" data-plus title="Open drawing">+</button>`;
}

function activate(tab: DocTab | null): void {
  if (!tab || tab === active) {
    renderStrip();
    return;
  }
  if (active) active.engine.deactivate();
  active = tab;
  tab.engine.activate();
  renderStrip();
}

async function closeTab(tab: DocTab | null): Promise<void> {
  if (!tab) return;
  if (tab.engine.isDirty() && !(await confirmDialog("Unsaved changes", `"${tab.title}" has unsaved changes. Close without saving?`))) return;
  if (!tabs.includes(tab)) return; // already closed while the dialog was open
  tab.engine.deactivate();
  tab.page.remove();
  const wrap = ribbonEngines.get(tab.engine);
  if (wrap) {
    wrap.remove();
    ribbonEngines.delete(tab.engine);
  }
  tabs = tabs.filter((t) => t !== tab);
  if (active === tab) {
    active = null;
    if (tabs.length) activate(tabs[tabs.length - 1]);
    else hideShell();
  }
  if (ribbonActive === tab.engine) ribbonActive = tabs.find((t) => t.engine !== tab.engine)?.engine ?? null;
  renderStrip();
}

async function closeOthers(keep: DocTab): Promise<void> {
  for (const t of [...tabs]) if (t !== keep) await closeTab(t);
  activate(keep);
}

async function closeAll(): Promise<void> {
  for (const t of [...tabs]) await closeTab(t);
}

function saveAll(): void {
  for (const t of tabs) if (t.engine.fileName()) t.engine.saveDxf();
}

function hideShell(): void {
  if (shell) shell.style.display = "none";
  // If the AI panel was docked inside the CAD shell, send it back to the BIM
  // workspace so it never gets trapped in the hidden shell.
  releaseAiChatToDefaultHost();
}

/* ═══════════════════════════════════════════════════════════════════════════
   AI copilot bridge — the shared AI agent engine (3D workspace) docked in
   the 2D CAD shell. Toggle from the Quick Access toolbar (✦) or the ribbon
   "AI Copilot" group; the panel mounts with its own dock layout id and
   returns to the BIM workspace when the shell closes (hideShell).
   ═══════════════════════════════════════════════════════════════════════════ */
function toggleCadAi(): void {
  if (!shell) return;
  if (isAiChatVisible() && isAiChatCadHosted()) {
    closeAiChat();
    return;
  }
  openAiChatInHost(shell, { storageId: "ai-chat-cad" });
}

/** Open the AI copilot inside the shell and ask a prepared question
    (ribbon "AI: Drawing Info" button). */
function askCadAi(question: string): void {
  if (!shell) return;
  openAiChatInHost(shell, { storageId: "ai-chat-cad" });
  askAiChat(question);
}

/** AI tool bridge (get_cad_state): state of the 2D engine + active drawing. */
export function getCadAiState(): {
  open: boolean;
  drawing: string | null;
  dirty: boolean;
  tool: string | null;
  entityCount: number | null;
  ribbonTab: string;
} {
  if (!shell || shell.style.display === "none" || !ribbonActive) {
    return { open: false, drawing: null, dirty: false, tool: null, entityCount: null, ribbonTab };
  }
  const snap = ribbonActive.aiSnapshot();
  return {
    open: true,
    drawing: ribbonActive.fileName() || null,
    dirty: ribbonActive.isDirty(),
    tool: snap.tool,
    entityCount: snap.entityCount,
    ribbonTab,
  };
}

/** AI tool bridge (run_cad_command): run a command-line string in the active
    drawing exactly as if the user typed it. Returns ok=false with the reason
    when the engine is closed or the drawing rejected the text. */
export function runCadAiCommand(text: string): { ok: boolean; error?: string } {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { ok: false, error: "No command text given." };
  if (!shell || shell.style.display === "none") return { ok: false, error: "The drawing editor is not open." };
  if (!ribbonActive) return { ok: false, error: "No active 2D drawing." };
  try {
    ribbonActive.runCommandText(trimmed);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function openTabMenu(x: number, y: number, tab: DocTab): void {
  document.querySelectorAll(".obs-cad-shell .cadmenu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "cadmenu";
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:10060`;
  const item = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => {
      menu.remove();
      fn();
    };
    menu.appendChild(b);
  };
  item("Save", () => tab.engine.saveDxf());
  item("Save All", () => saveAll());
  item("Close", () => closeTab(tab));
  item("Close Others", () => closeOthers(tab));
  item("Close All", () => closeAll());
  shell!.appendChild(menu);
  const off = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - off.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - off.height - 8)}px`;
  setTimeout(() => {
    const done = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener("mousedown", done);
      }
    };
    document.addEventListener("mousedown", done);
  }, 0);
}

/** Drawing application menu — the red "A" button dropdown. Dispatches to the
 *  active drawing's engine (shell-level actions like New/Save All stay here). */
function openAppMenu(anchor: HTMLElement): void {
  document.querySelectorAll(".obs-cad-shell .cadmenu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "cadmenu";
  menu.style.cssText = "position:fixed;z-index:10060;min-width:210px";
  const item = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => {
      menu.remove();
      fn();
    };
    menu.appendChild(b);
  };
  const sep = () => {
    const s = document.createElement("div");
    s.className = "cadmenu__sep";
    menu.appendChild(s);
  };
  item("New Drawing", () => openBlank());
  item("Open…", () => picker!.click());
  sep();
  item("Save DXF", () => ribbonActive?.exec("save-dxf"));
  item("Save DWG…", () => ribbonActive?.exec("save-dwg"));
  item("Save All", () => saveAll());
  item("Plot…", () => ribbonActive?.exec("plot"));
  sep();
  item("Export SVG", () => ribbonActive?.exec("svg"));
  item("Export Measurements CSV", () => ribbonActive?.exec("csv"));
  item("Export Entity Data (CSV)", () => ribbonActive?.exec("dataextract"));
  item("Import LandXML CgPoints…", () => ribbonActive?.exec("landxmlin"));
  item("Quantity Takeoff (CSV)", () => ribbonActive?.exec("takeoff"));
  item("Drawing Information", () => ribbonActive?.exec("info"));
  sep();
  item("Close Drawing", () => ribbonActive?.exec("close"));
  shell!.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const off = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - off.width - 8)}px`;
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - off.height - 8)}px`;
  setTimeout(() => {
    const done = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener("mousedown", done);
      }
    };
    document.addEventListener("mousedown", done);
  }, 0);
}

function ensureShell(): void {
  if (shell) return;
  shell = document.createElement("div");
  shell.className = "obs-cad-shell";
  shell.id = "obs-cad-shell";
  shell.setAttribute("data-obs-own-wheel", "");
  shell.style.cssText =
    "position:fixed;inset:0;z-index:10050;display:none;flex-direction:column;background:#151a23;color:#e5e7eb;font:12px/1.35 system-ui,sans-serif";
  const tabstripStyle =
    "display:flex;align-items:flex-end;gap:2px;padding:6px 8px 0;background:#0b0d12;border-bottom:1px solid #2a3140;overflow-x:auto;scrollbar-width:thin;flex:none;min-height:34px";
  const qatBtn = (icon: IconName, action: string, title: string, flip = false) =>
    `<button data-qat="${action}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">` +
    (flip ? `<span class="qat-flip">${svgIcon(icon)}</span>` : svgIcon(icon)) +
    `</button>`;
  shell.innerHTML =
    `<style>${CAD_CSS}</style>` +
    // Drawing editor chrome: ribbon tabs row → ribbon panels → drawing file tabs → viewport
    `<div class="cad-chrome">` +
    `<div class="cad-ribbon-tabs" data-r="ribbontabs">` +
    `<button class="cad-appmenu" data-r="appmenu" title="Application menu" aria-label="Application menu">A</button>` +
    RIBBON_TABS.map((t) => `<button class="cad-ribtab" data-ribtab="${t.id}">${t.label}</button>`).join("") +
    `<div class="cad-qat">` +
    qatBtn("folder", "open", "Open a DWG or DXF drawing") +
    qatBtn("save", "save-dxf", "Save DXF (QSAVE)") +
    qatBtn("print", "plot", "Plot to PDF / paper") +
    qatBtn("undo", "undo", "Undo (Ctrl+Z)") +
    qatBtn("undo", "redo", "Redo (Ctrl+Y)", true) +
    qatBtn("fit", "ext", "Zoom extents (Z E)") +
    qatBtn("generative", "ai", "AI Copilot — ask questions or run commands in this drawing") +
    `</div></div>` +
    `<div class="cadrb-strip" data-r="ribbonstrip"></div>` +
    `<div data-r="tabstrip" role="tablist" aria-label="Open drawings" style="${tabstripStyle}"></div>` +
    `</div>` +
    `<div data-r="pages" style="display:flex;flex:1;min-height:0;position:relative;overflow:hidden"></div>`;
  document.body.appendChild(shell);
  strip = shell.querySelector<HTMLDivElement>("[data-r=tabstrip]")!;
  pagesEl = shell.querySelector<HTMLDivElement>("[data-r=pages]")!;
  ribbonStrip = shell.querySelector<HTMLDivElement>("[data-r=ribbonstrip]")!;
  ribbonTabsRow = shell.querySelector<HTMLDivElement>("[data-r=ribbontabs]")!;
  applyRibbonTab();
  shell.classList.toggle("cad-ribbon--min", ribbonMinimized);
  installCadFullscreen();
  ribbonTabsRow.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement;
    const onTab = !!target.closest("[data-ribtab]");
    // only a tab or the empty part of the tab row collapses the ribbon (not the A menu or quick-access buttons)
    if (!onTab && target !== ribbonTabsRow) return;
    const d = resolveDblClick({ minimized: ribbonMinimized, lastAutoExpandAt: ribbonLastAutoExpandAt, now: Date.now(), onTab });
    ribbonLastAutoExpandAt = d.lastAutoExpandAt;
    if (d.minimize !== ribbonMinimized) applyCadRibbonMinimized(d.minimize);
  });
  ribbonTabsRow.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const rib = target.closest<HTMLElement>("[data-ribtab]");
    if (rib) {
      ribbonTab = rib.dataset.ribtab!;
      applyRibbonTab();
      if (ribbonMinimized) {
        // a single click on a tab while collapsed re-opens the ribbon on that tab
        ribbonLastAutoExpandAt = Date.now();
        applyCadRibbonMinimized(false);
      }
      return;
    }
    const q = target.closest<HTMLElement>("[data-qat]");
    if (q) {
      const a = q.dataset.qat!;
      if (a === "open") picker!.click();
      else if (a === "ai") toggleCadAi();
      else ribbonActive?.exec(a);
    }
  });
  shell.querySelector<HTMLButtonElement>("[data-r=appmenu]")!.addEventListener("click", (e) => {
    e.stopPropagation();
    openAppMenu(e.currentTarget as HTMLElement);
  });

  picker = document.createElement("input");
  picker.type = "file";
  // .bak / .sv$ are drawing workspace drawing backups (openable like native CAD); .xml
  // routes to the LandXML CgPoints importer.
  picker.accept = ".dxf,.dwg,.bak,.sv$,.xml";
  picker.multiple = true;
  picker.style.cssText = "display:none";
  picker.onchange = () => {
    for (const f of [...(picker!.files ?? [])]) openFile(f);
    picker!.value = "";
  };
  shell.appendChild(picker);

  xmlPicker = document.createElement("input");
  xmlPicker.type = "file";
  xmlPicker.accept = ".xml";
  xmlPicker.multiple = true;
  xmlPicker.style.cssText = "display:none";
  xmlPicker.onchange = () => {
    for (const f of [...(xmlPicker!.files ?? [])]) openFile(f);
    xmlPicker!.value = "";
  };
  shell.appendChild(xmlPicker);

  // Drag & drop: the empty state promises "Drop DWG or DXF file here", so the
  // shell accepts .dwg/.dxf drops anywhere over the editor (multi-file too).
  // drawing workspace backup extensions (.bak, .sv$) open like native CAD; LandXML .xml
  // files import their CgPoints into the active drawing.
  shell.addEventListener("dragover", (e) => e.preventDefault());
  shell.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
      /\.(dwg|dxf|bak|sv\$|xml)$/i.test(f.name),
    );
    for (const f of files) openFile(f);
  });

  strip.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const x = t.closest<HTMLElement>("[data-x]");
    if (x) {
      closeTab(byId(Number(x.dataset.x)));
      return;
    }
    if (t.closest("[data-plus]")) {
      picker!.click();
      return;
    }
    const tab = t.closest<HTMLElement>("[data-tab]");
    if (tab) activate(byId(Number(tab.dataset.tab)));
  });
  strip.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
    if (tab) closeTab(byId(Number(tab.dataset.tab)));
  });
  strip.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
    if (el) openTabMenu(e.clientX, e.clientY, byId(Number(el.dataset.tab))!);
  });

  shell.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Tab" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (tabs.length < 2 || !active) return;
        const i = tabs.indexOf(active);
        activate(tabs[(i + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length]);
      }
    },
    true,
  );
}

function createTab(title: string): DocTab {
  const page = document.createElement("div");
  pagesEl!.appendChild(page);
  const tab: DocTab = { id: nextTabId++, engine: null as unknown as CadEngineApi, page, title, dirty: false };
  tab.engine = buildEngine(page, {
    onDirty: (d) => {
      tab.dirty = d;
      renderStrip();
    },
    onTitle: (n) => {
      tab.title = n;
      renderStrip();
    },
    saveAll: () => saveAll(),
    requestClose: () => closeTab(tab),
  });
  tabs.push(tab);
  renderStrip();
  return tab;
}

function openFile(file: File): void {
  ensureShell();
  if (/\.xml$/i.test(file.name)) {
    const host = active?.engine;
    if (host) {
      activate(active);
      void host.importLandXml(file);
    } else {
      const tab = createTab(file.name);
      activate(tab);
      void tab.engine.importLandXml(file);
    }
    return;
  }
  const existing = tabs.find((t) => t.title.toLowerCase() === file.name.toLowerCase());
  if (existing) {
    activate(existing);
    return;
  }
  const tab = createTab(file.name);
  activate(tab);
  void tab.engine.load(file);
  // 2D file history (welcome-screen drafting zone): record every real drawing
  // that is opened — picker, drag & drop and the welcome-screen zone all land here.
  void recordRecentDrawing({ name: file.name, format: recentFormatOf(file.name), size: file.size, blob: file });
}

function openBlank(): void {
  activate(createTab(`Drawing${nextTabId}`));
}

const CAD_CSS = `
    .obs-cad-viewer button,.obs-cad-viewer select,.obs-cad-viewer input{font:inherit;color:inherit;background:#1b212c;border:1px solid #2f3846;border-radius:5px;padding:4px 8px}
    .obs-cad-viewer button{cursor:pointer}.obs-cad-viewer button:hover{background:#263041}
    .obs-cad-viewer button.on{background:#0284c7;border-color:#38bdf8;color:#ffffff}
    .obs-cad-viewer .bar{display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:5px 8px;background:#151a23;border-bottom:1px solid #2a3140}
    .obs-cad-viewer .sep{width:1px;height:20px;background:#2f3846;margin:0 4px}
    .obs-cad-viewer .side{width:270px;display:flex;flex-direction:column;background:#151a23;border-left:1px solid #2a3140;min-height:0}
    .obs-cad-viewer .side h4{margin:0;padding:6px 8px;background:#1b212c;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9aa4b2;display:flex;align-items:center;justify-content:space-between}
    .obs-cad-viewer .lyr{display:flex;align-items:center;gap:6px;padding:2px 8px}
    .obs-cad-viewer .lyr:hover{background:#1b212c}
    .obs-cad-viewer .sw{width:12px;height:12px;border-radius:2px;border:1px solid #556}
    .obs-cad-viewer .sc{overflow:auto;min-height:0}
    .obs-cad-viewer table{width:100%;border-collapse:collapse}.obs-cad-viewer td{padding:3px 8px;border-bottom:1px solid #222a37}
    .obs-cad-viewer td:first-child{color:#9aa4b2}

    /* Ribbon-style toolbar: icon over label, grouped, caption underneath (same look as the main app ribbon).
       The strip lives in the SHELL chrome (shared across drawing tabs, drawing workspace MDI style), so every
       ribbon rule is scoped to both the viewer page and the shell. */
    .obs-cad-viewer,.obs-cad-shell{--cadrb-w:56px;--cadrb-h:36px;--cadrb-gap:2px;--cadrb-icon:16px;--cadrb-label:9px}
    .obs-cad-viewer .cadrb-strip,.obs-cad-shell .cadrb-strip{display:flex;align-items:stretch;flex:none;height:104px;padding:7px 8px;overflow-x:auto;overflow-y:hidden;background:linear-gradient(180deg,var(--bg-surface,#12141b) 0%,var(--bg-base,#0b0d12) 100%);border-bottom:1px solid var(--border-default,#2a2e3a);user-select:none;scrollbar-width:thin}
    .obs-cad-viewer .cadrb-host,.obs-cad-shell .cadrb-host{display:flex;align-items:stretch;flex:none}
    .obs-cad-viewer .cadrb-host--end,.obs-cad-shell .cadrb-host--end{flex:1 0 auto}
    .obs-cad-viewer .cadrg,.obs-cad-shell .cadrg{display:flex;flex-direction:column;align-items:center;padding:0 4px;border-right:1px solid var(--border-subtle,#1e2029);min-width:0;flex:none;height:100%}
    .obs-cad-viewer .cadrg--end,.obs-cad-shell .cadrg--end{margin-left:auto;border-right:none}
    .obs-cad-viewer .cadrg__body,.obs-cad-shell .cadrg__body{flex:1;display:grid;grid-auto-flow:column;grid-template-rows:repeat(2,var(--cadrb-h));grid-auto-columns:var(--cadrb-w);gap:var(--cadrb-gap);align-content:center;justify-content:center;min-width:0}
    .obs-cad-viewer .cadrg__body--fields,.obs-cad-shell .cadrg__body--fields{grid-auto-columns:auto;column-gap:6px}
    .obs-cad-viewer .cadrg__label,.obs-cad-shell .cadrg__label{text-align:center;font:500 9px var(--font-sans,system-ui);letter-spacing:.5px;text-transform:uppercase;color:var(--text-tertiary,#6b7280);padding-top:3px;white-space:nowrap;opacity:.65;flex:none}
    .obs-cad-viewer .cadrb,.obs-cad-shell .cadrb{width:var(--cadrb-w);height:var(--cadrb-h);padding:3px 2px 2px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;background:transparent;border:1px solid transparent;border-radius:4px;cursor:pointer;color:var(--text-secondary,#a0a6b5);font-family:var(--font-sans,system-ui);position:relative;overflow:visible;flex:none;transition:background .14s,color .14s,border-color .14s}
    .obs-cad-viewer .cadrb:hover,.obs-cad-shell .cadrb:hover{background:var(--bg-hover,#232633);color:var(--text-primary,#e8eaf0);border-color:var(--border-subtle,#1e2029)}
    .obs-cad-viewer .cadrb:active,.obs-cad-shell .cadrb:active{background:var(--bg-active,#2a2e3d);transform:scale(.96)}
    .obs-cad-viewer .cadrb.on,.obs-cad-shell .cadrb.on{background:var(--accent-dim,rgba(56,189,248,.14));color:var(--accent,#38bdf8);border-color:var(--accent,#38bdf8);box-shadow:inset 0 0 6px rgba(56,189,248,.10)}
    .obs-cad-viewer .cadrb--danger,.obs-cad-shell .cadrb--danger{color:#fca5a5}
    .obs-cad-viewer .cadrb--danger:hover,.obs-cad-shell .cadrb--danger:hover{background:rgba(239,68,68,.15);border-color:#ef4444;color:#fecaca}
    .obs-cad-viewer .cadrb--flip .cadrb__icon,.obs-cad-shell .cadrb--flip .cadrb__icon{transform:scaleX(-1)}
    .obs-cad-viewer .cadrb__icon,.obs-cad-shell .cadrb__icon{display:flex;align-items:center;justify-content:center;width:var(--cadrb-icon);height:var(--cadrb-icon);color:inherit;pointer-events:none;flex:none}
    .obs-cad-viewer .cadrb__icon svg,.obs-cad-shell .cadrb__icon svg{display:block;width:var(--cadrb-icon);height:var(--cadrb-icon);stroke:currentColor;fill:none;stroke-width:1.9}
    .obs-cad-viewer .cadrb__icon svg [fill="currentColor"],.obs-cad-shell .cadrb__icon svg [fill="currentColor"]{fill:currentColor;stroke:none}
    .obs-cad-viewer .cadrb__label,.obs-cad-shell .cadrb__label{display:block;font-size:var(--cadrb-label);line-height:1;font-weight:500;color:inherit;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;padding:0 1px;opacity:.85}
    .obs-cad-viewer .cadrb.on .cadrb__label,.obs-cad-viewer .cadrb:hover .cadrb__label,.obs-cad-shell .cadrb.on .cadrb__label,.obs-cad-shell .cadrb:hover .cadrb__label{opacity:1}
    .obs-cad-viewer .cadrb-field,.obs-cad-shell .cadrb-field{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;height:var(--cadrb-h);padding:0 3px;font:500 9px var(--font-sans,system-ui);color:var(--text-tertiary,#6b7280);text-transform:uppercase;letter-spacing:.5px}
    .obs-cad-viewer .cadrb-field select,.obs-cad-shell .cadrb-field select{background:var(--bg-inset,#0e1017);border:1px solid var(--border-default,#2a2e3a);color:var(--text-primary,#e8eaf0);font:500 10px var(--font-mono,monospace);padding:3px 4px;border-radius:3px;min-width:70px;outline:none;cursor:pointer;text-transform:none;letter-spacing:0}

    /* drawing workspace shell chrome: application menu (red A) + ribbon tabs + Quick Access toolbar,
       then the ribbon strip, then the drawing file tabs — exactly the drawing workspace stacking order. */
    .obs-cad-shell .cad-chrome{flex:none;display:flex;flex-direction:column;min-height:0}
    .obs-cad-shell .cad-ribbon-tabs{display:flex;align-items:stretch;height:32px;padding:0 8px;background:#0b0d12;border-bottom:1px solid #2a3140;user-select:none;flex:none}
    .obs-cad-shell .cad-appmenu{width:32px;min-width:32px;margin:3px 8px 3px 0;padding:0;display:flex;align-items:center;justify-content:center;border-radius:5px;background:linear-gradient(180deg,#e05252,#b91c1c);border:1px solid #7f1d1d;color:#fff;font:700 15px/1 var(--font-sans,system-ui);cursor:pointer}
    .obs-cad-shell .cad-appmenu:hover{background:linear-gradient(180deg,#ef6a6a,#c52222)}
    .obs-cad-shell .cad-ribtab{padding:0 14px;background:transparent;border:none;border-bottom:2px solid transparent;border-radius:0;color:#9aa4b2;font:500 12px var(--font-sans,system-ui);cursor:pointer}
    .obs-cad-shell .cad-ribtab:hover{color:#e8eaf0;background:#1b212c}
    .obs-cad-shell.cad-ribbon--min .cadrb-strip{display:none}
    .obs-cad-shell.cad-ribbon--min .cad-ribtab.on{border-bottom-color:transparent}
    .obs-cad-viewer.obs-cad-fs:not(.obs-cad-fs--peek) .side,
    .obs-cad-viewer.obs-cad-fs:not(.obs-cad-fs--peek) .obs-cad-cmd-container,
    .obs-cad-viewer.obs-cad-fs:not(.obs-cad-fs--peek) [data-r=status],
    .obs-cad-viewer.obs-cad-fs:not(.obs-cad-fs--peek) [data-r=tabs]{display:none!important}
    .obs-cad-fs-chip{position:absolute;top:8px;right:10px;z-index:30;padding:4px 10px;background:rgba(21,26,35,.82);color:#cbd5e1;border:1px solid #334155;border-radius:5px;font:11px system-ui,sans-serif;cursor:pointer;opacity:.35;transition:opacity .15s}
    .obs-cad-fs-chip:hover{opacity:1}
    .obs-cad-shell .cad-ribtab.on{color:#f8fafc;background:#151a23;border-bottom-color:#38bdf8}
    .obs-cad-shell .cad-qat{margin-left:auto;display:flex;align-items:center;gap:1px}
    .obs-cad-shell .cad-qat button{width:26px;height:26px;padding:0;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid transparent;border-radius:4px;color:#9aa4b2;cursor:pointer}
    .obs-cad-shell .cad-qat button:hover{background:#1b212c;color:#e8eaf0;border-color:#2a3140}
    .obs-cad-shell .cad-qat button svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.9}
    .obs-cad-shell .cad-qat .qat-flip{display:flex;transform:scaleX(-1)}
    .obs-cad-shell .cadmenu__sep{height:1px;margin:4px 6px;background:#2a3140}
    /* Per-engine ribbon content: only the active drawing's panels are mounted/visible */
    .obs-cad-shell .cadrb-enginewrap{display:none;flex:1;min-width:0;align-items:stretch}
    .obs-cad-shell .cadrb-enginewrap.on{display:flex}
    /* Ribbon tabs filter the panels of the active drawing (drawing workspace tab → panels) */
    .obs-cad-shell .cadrb-strip .cadrg{display:none}
    .obs-cad-shell .cadrb-strip[data-ribbon-tab="home"] .cadrg[data-cadtab="home"],
    .obs-cad-shell .cadrb-strip[data-ribbon-tab="insert"] .cadrg[data-cadtab="insert"],
    .obs-cad-shell .cadrb-strip[data-ribbon-tab="annotate"] .cadrg[data-cadtab="annotate"],
    .obs-cad-shell .cadrb-strip[data-ribbon-tab="parametric"] .cadrg[data-cadtab="parametric"],
    .obs-cad-shell .cadrb-strip[data-ribbon-tab="view"] .cadrg[data-cadtab="view"],
    .obs-cad-shell .cadrb-strip[data-ribbon-tab="manage"] .cadrg[data-cadtab="manage"],
    .obs-cad-shell .cadrb-strip[data-ribbon-tab="output"] .cadrg[data-cadtab="output"],
    .obs-cad-shell .cadrb-strip[data-ribbon-tab="express"] .cadrg[data-cadtab="express"],
    .obs-cad-shell .cadrb-strip[data-ribbon-tab="collaborate"] .cadrg[data-cadtab="collaborate"]{display:flex}
    /* drawing workspace In-Canvas ViewCube */
    .obs-cad-viewcube {
      position: absolute; top: 16px; right: 28px; width: 68px; height: 68px;
      user-select: none; z-index: 10; pointer-events: auto;
    }
    .obs-cad-viewcube .vc-box {
      width: 100%; height: 100%; background: rgba(30, 41, 59, 0.75); border: 1px solid rgba(148, 163, 184, 0.4);
      border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center;
      cursor: pointer; transition: all 0.15s ease; backdrop-filter: blur(4px); box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .obs-cad-viewcube .vc-box:hover {
      background: rgba(30, 41, 59, 0.95); border-color: #38bdf8;
    }
    .obs-cad-viewcube .vc-label {
      font-weight: 700; font-size: 11px; color: #f8fafc; letter-spacing: 0.05em;
    }
    .obs-cad-viewcube .vc-compass {
      font-size: 9px; color: #94a3b8; margin-top: 1px;
    }
    .obs-cad-viewcube .vc-controls {
      display: flex; gap: 4px; margin-top: 2px;
    }
    .obs-cad-viewcube .vc-btn {
      background: rgba(15, 23, 42, 0.6); border: none; color: #cbd5e1; font-size: 10px;
      border-radius: 3px; padding: 1px 4px; cursor: pointer;
    }
    .obs-cad-viewcube .vc-btn:hover { background: #0284c7; color: white; }

    /* drawing workspace Navigation Bar */
    .obs-cad-navbar {
      position: absolute; right: 28px; top: 96px; z-index: 10;
      background: rgba(30, 41, 59, 0.75); border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 6px; display: flex; flex-direction: column; padding: 3px; gap: 3px;
      backdrop-filter: blur(4px); box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .obs-cad-navbar button {
      width: 26px; height: 26px; padding: 0; display: flex; align-items: center; justify-content: center;
      background: transparent; border: none; border-radius: 4px; color: #cbd5e1; font-size: 13px;
    }
    .obs-cad-navbar button:hover {
      background: rgba(56, 189, 248, 0.2); color: #38bdf8;
    }

    /* drawing workspace Command Line Container */
    .obs-cad-cmd-container {
      position: relative; background: #12151c; border-top: 1px solid #2a3140;
      display: flex; flex-direction: column; font-family: Consolas, "Liberation Mono", Menlo, Courier, monospace;
    }
    .obs-cad-cmd-history {
      padding: 3px 10px; max-height: 48px; overflow-y: auto; font-size: 11px;
      color: #94a3b8; background: #0c0e13; border-bottom: 1px solid #1c222c;
    }
    .obs-cad-cmd-history div { line-height: 1.4; white-space: pre-wrap; }
    .obs-cad-cmd-history .cmd-echo { color: #38bdf8; }
    .obs-cad-cmd-input-row {
      display: flex; align-items: center; gap: 8px; padding: 4px 8px;
    }
    .obs-cad-cmd-auto-popup {
      position: absolute; bottom: 100%; left: 80px; width: 340px; max-height: 220px;
      background: #1e293b; border: 1px solid #38bdf8; border-radius: 6px; overflow-y: auto;
      display: none; flex-direction: column; z-index: 100; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    .obs-cmd-auto-item {
      padding: 6px 10px; font-size: 11px; color: #f8fafc; cursor: pointer;
      display: flex; justify-content: space-between; border-bottom: 1px solid #334155;
    }
    .obs-cmd-auto-item:hover, .obs-cmd-auto-item.active {
      background: #0284c7; color: white;
    }

    /* Drawing status-tray toggles */
    .obs-status-btn {
      padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 600;
      background: transparent; border: 1px solid transparent; color: #94a3b8; cursor: pointer;
    }
    .obs-status-btn:hover { background: #1e293b; color: #f8fafc; }
    .obs-status-btn.active { background: #0284c7; color: #ffffff; border-color: #38bdf8; }

    /* MDI file tabs */
    .obs-cad-shell .cadtab{display:flex;align-items:center;gap:6px;padding:6px 8px 7px;background:#151a23;border:1px solid #2a3140;border-bottom:none;border-radius:6px 6px 0 0;color:#94a3b8;font:500 11px var(--font-sans,system-ui);cursor:pointer;white-space:nowrap;max-width:220px;flex:none}
    .obs-cad-shell .cadtab:hover{color:#e8eaf0;background:#1b212c}
    .obs-cad-shell .cadtab.on{background:#212830;color:#f8fafc;border-color:#38bdf8;box-shadow:inset 0 2px 0 #38bdf8}
    .obs-cad-shell .cadtab__name{overflow:hidden;text-overflow:ellipsis}
    .obs-cad-shell .cadtab__dirty{color:#38bdf8;font-size:9px;line-height:1}
    .obs-cad-shell .cadtab__x{border-radius:3px;padding:0 3px;font-size:13px;line-height:1;color:#64748b}
    .obs-cad-shell .cadtab__x:hover{background:#ef4444;color:#fff}
    .obs-cad-shell .cadtab--plus{padding:6px 10px;font-size:14px}
    .obs-cad-shell .cadmenu{background:#1e293b;border:1px solid #38bdf8;border-radius:6px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.5);min-width:150px}
    .obs-cad-shell .cadmenu button{display:block;width:100%;text-align:left;background:transparent;border:none;color:#f8fafc;padding:6px 10px;border-radius:4px;cursor:pointer;font-size:12px}
    .obs-cad-shell .cadmenu button:hover{background:#0284c7}
  `;

function buildEngine(page: HTMLDivElement, hooks: EngineHooks): CadEngineApi {
  const root = page;
  root.className = "obs-cad-viewer";
  root.setAttribute("data-obs-own-wheel", "");
  root.style.cssText =
    "display:none;flex-direction:column;min-height:0;flex:1;background:#151a23;color:#e5e7eb;font:12px/1.35 system-ui,sans-serif";

  root.innerHTML = `
  <!-- Main CAD Viewport & Sidebars -->
  <div style="display:flex;flex:1;min-height:0">
    <div style="flex:1;position:relative;min-width:0" data-r="stage">
      <canvas data-r="cv" style="position:absolute;inset:0;width:100%;height:100%;touch-action:none;outline:none" tabindex="0"></canvas>

      <!-- In-Canvas ViewCube -->
      <div class="obs-cad-viewcube">
        <div class="vc-box" data-r="vc-home" title="ViewCube — Top View / Extents (Home)">
          <div class="vc-compass">N</div>
          <div class="vc-label">TOP</div>
          <div class="vc-controls">
            <button class="vc-btn" data-r="vc-rot-ccw" title="Rotate 90° CCW">↺</button>
            <button class="vc-btn" data-r="vc-home-btn" title="Zoom Extents">⌂</button>
            <button class="vc-btn" data-r="vc-rot-cw" title="Rotate 90° CW">↻</button>
          </div>
        </div>
      </div>

      <!-- In-Canvas drawing workspace Navigation Bar -->
      <div class="obs-cad-navbar">
        <button data-r="nav-pan" title="Pan (P)">✋</button>
        <button data-r="nav-ext" title="Zoom Extents (Z E)">⛶</button>
        <button data-r="nav-win" title="Zoom Window (Z W)">🔍</button>
        <button data-r="nav-prev" title="Zoom Previous (Backspace)">↩</button>
        <button data-r="nav-full" title="Full Screen (Ctrl+0)">⛶</button>
      </div>

      <div data-r="empty" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#9aa4b2;pointer-events:none">
        <div style="font-size:18px;font-weight:600;color:#cbd5e1">Drawing Engine Ready — Drop a DWG or DXF file here</div>
        <div style="font-size:12px;color:#64748b">or click Open from the Quick Access toolbar</div>
      </div>

      <div data-r="busy" style="display:none;position:absolute;left:50%;top:14px;transform:translateX(-50%);background:#1b212c;padding:6px 14px;border-radius:6px;border:1px solid #334155;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,0.3)"></div>
    </div>

    <!-- drawing workspace Side Panels -->
    <div class="side">
      <h4>
        <span>Layers</span>
        <button data-r="open-layer-mgr" style="padding:1px 6px;font-size:10px;text-transform:none">Manager (LA)</button>
      </h4>
      <div style="padding:6px 8px 0"><input data-r="lf" placeholder="Filter layers…" style="width:100%;box-sizing:border-box"></div>
      <div style="display:flex;gap:4px;padding:6px 8px">
        <button data-r="lon">All on</button>
        <button data-r="loff">All off</button>
        <button data-r="liso" title="Isolate the selected object's layer">Isolate</button>
      </div>
      <div class="sc" data-r="layers" style="flex:1"></div>
      <h4>Properties</h4><div class="sc" data-r="props" style="max-height:34%;padding-bottom:4px"></div>
      <h4>Measurements &amp; History</h4><div class="sc" data-r="meas" style="max-height:24%;padding:4px 8px"></div>
    </div>
  </div>

  <!-- drawing workspace Command Window (Scrollable History + Autocomplete) -->
  <div class="obs-cad-cmd-container">
    <div class="obs-cad-cmd-history" data-r="cmdhist">
      <div>Command: Drawing engine initialized. Type a command or alias (L, C, REC, Z, DI, LA...)</div>
    </div>
    <div class="obs-cad-cmd-input-row">
      <span style="color:#38bdf8;font-weight:700;font-size:12px">Command:</span>
      <input data-r="cmd" placeholder="Type a command or press Enter to repeat" style="flex:1;min-width:0;padding:5px 8px;background:#0c0e13;border:1px solid #2a3140;border-radius:4px;color:#f8fafc;font:12px Consolas,monospace" autocomplete="off" spellcheck="false" />
      <button data-r="cmdrun" style="padding:4px 12px;background:#0284c7;border-color:#38bdf8;font-weight:500">Run</button>
    </div>
    <div class="obs-cad-cmd-auto-popup" data-r="cmdauto"></div>
  </div>

  <!-- drawing workspace Layout Tabs (Model, Layout1, Layout2...) -->
  <div data-r="tabs" style="display:none;gap:2px;padding:3px 8px 0;background:#151a23;border-top:1px solid #2a3140"></div>

  <!-- Drawing status-bar tray -->
  <div data-r="status" style="display:flex;align-items:center;gap:12px;padding:3px 10px;background:#0f1218;border-top:1px solid #2a3140;color:#9aa4b2;font-size:11px;font-variant-numeric:tabular-nums"></div>
  `;

  const $ = <T extends HTMLElement>(k: string) => root!.querySelector(`[data-r="${k}"]`) as T;
  // Ribbon panels are built per drawing but MOUNTED in the shell chrome above the
  // drawing tabs (drawing workspace MDI style) — only the active drawing's panels show.
  const tools = document.createElement("div"),
    tools2 = document.createElement("div");
  tools.className = "cadrb-host";
  tools.dataset.r = "tools";
  tools2.className = "cadrb-host cadrb-host--end";
  tools2.dataset.r = "tools2";
  const ribbonWrap = document.createElement("div");
  ribbonWrap.append(tools, tools2);
  const cv = $<HTMLCanvasElement>("cv"),
    g = cv.getContext("2d")!;
  const tabsEl = $("tabs"),
    layersEl = $("layers"),
    propsEl = $("props"),
    measEl = $("meas"),
    statusEl = $("status"),
    emptyEl = $("empty"),
    busyEl = $("busy"),
    cmdHistEl = $("cmdhist"),
    cmdAutoEl = $("cmdauto");

  let doc: DxfDocument | null = null,
    name = "";
  /** Loaded CTB/STB plot style table (PLOT › Load CTB/STB…), applied while plotting. */
  let plotStyle: { table: PlotStyleTable; fileName: string } | null = null;
  /** Embedded DWG preview of the loaded file (shown while reading + Info dialog). */
  let previewInfo: DwgPreviewImage | null = null;
  let ents: DxfEntity[] = [],
    idx: M.SpatialIndex | null = null,
    bounds: M.BBox | null = null;
  let view: M.View = { cx: 0, cy: 0, scale: 1, w: 800, h: 600 };
  const history: M.View[] = [];
  let tool: Tool = "select";
  let bg = "drafting",
    cmode: ColorMode = "layer",
    lw = 1,
    du: M.DisplayUnit = "drawing";
  const hidden = new Set<string>();
  // Per-entity temporary visibility complements layer visibility for CAD context actions.
  const hiddenEntities = new Set<DxfEntity>();
  const visibilityHistory: Array<{ layers: Set<string>; entities: Set<DxfEntity> }> = [];

  // Drawing status toggles
  let snapOn = true;
  const snapModes = new Set<M.SnapKind>(M.ALL_SNAPS);
  let orthoOn = false;
  let polarOn = false;
  let dynOn = true; // Dynamic Input HUD F12
  let lwtOn = true; // Lineweight display
  let showGrid = true;
  let cleanScreen = false;

  let currentLayer = "0";
  let offsetEntity = -1;
  let origin: M.Pt | null = null;
  let dualUnits = false;
  let typeFilter = new Set<string>();
  let scaleCal = 1;

  let selected = -1,
    hover: M.Snap | null = null,
    cursor: M.Pt | null = null;
  // Last viewport position is used to anchor the in-canvas command prompt.
  let lastPointerScreen: M.Pt = { x: 24, y: 24 };
  let pts: M.Pt[] = [];
  let results: string[] = [];
  let drawn: Array<{ kind: Tool; pts: M.Pt[] }> = [];
  let markups: Markup[] = [];
  let hits: M.TextHit[] = [],
    hitI = -1;
  let dragging: { x: number; y: number } | null = null,
    winStart: { x: number; y: number } | null = null,
    winNow: { x: number; y: number } | null = null;
  let raf = 0;
  let modelEnts: DxfEntity[] = [],
    modelIdx: M.SpatialIndex | null = null,
    modelBounds: M.BBox | null = null;
  let showText = true,
    showHatch = true,
    showLt = true,
    quick = false,
    forceColor: string | null = null;
  let cmp: { removed: Set<DxfEntity>; added: DxfEntity[] } | null = null;
  let tipEl: HTMLDivElement | null = null;
  let layoutI = -1;
  const layoutIdxCache = new Map<number, M.SpatialIndex>();
  let press: { x: number; y: number; moved: boolean; id: number; band?: boolean; add?: boolean } | null = null;
  const sel = new Set<number>();
  /** FIX constraint: entities pinned by the Parametric tab (object identity — survives index shifts). */
  const fixedEnts = new Set<DxfEntity>();
  /** Parametric overlay: constraint badges / FIX markers on canvas (CONSTRAINTBAR). */
  let conBarOn = true;
  let rband: { a: M.Pt; b: M.Pt } | null = null;
  let layerFilter = "";
  const ptrs = new Map<number, M.Pt>();
  let pinch = 0;

  // drawing workspace Drafting Undo / Redo Stacks
  interface UndoAction {
    type: "add" | "delete" | "modify" | "replace";
    entities?: DxfEntity[];
    /** Modify / replace: entity objects before the operation. */
    before?: DxfEntity[];
    /** Modify / replace: entity objects currently in the drawing. */
    after?: DxfEntity[];
  }
  const undoStack: UndoAction[] = [];
  let dirty = false;
  const markDirty = (): void => {
    if (!dirty) {
      dirty = true;
      hooks.onDirty(true);
    }
  };
  const markSaved = (): void => {
    if (dirty) {
      dirty = false;
      hooks.onDirty(false);
    }
  };
  const redoStack: UndoAction[] = [];

  // drawing workspace Command History
  const cmdHistory: string[] = [];
  let cmdHistoryIdx = -1;

  const logCmd = (msg: string, isEcho = false): void => {
    const d = document.createElement("div");
    if (isEcho) d.className = "cmd-echo";
    d.textContent = msg;
    cmdHistEl.appendChild(d);
    cmdHistEl.scrollTop = cmdHistEl.scrollHeight;
  };

  const inv = () => cmode === "invert";
  const fg = () => (bg === "white" || inv() ? 0x000000 : 0xffffff);
  const visible = (e: DxfEntity) => !hidden.has(e.layer) && !hiddenEntities.has(e) && (typeFilter.size === 0 || typeFilter.has(e.type));
  const shown = (e: DxfEntity) =>
    visible(e) && !(e.type === "TEXT" && !showText) && !(e.type === "LWPOLYLINE" && e.hatch && !showHatch);
  const layerOf = (n: string) => doc?.layers.find((l) => l.name === n);

  function colorOf(e: DxfEntity): string {
    if (forceColor) return forceColor;
    if (cmp) return cmp.removed.has(e) ? "#ef4444" : "#6b7280";
    if (cmode === "bw") return bg === "white" ? "#000" : "#fff";
    let rgb: number;
    if (e.rgb != null) rgb = e.rgb;
    else if (e.color != null && e.color > 0 && e.color < 256) rgb = aciToRgb(e.color, fg());
    else {
      const lyr = layerOf(e.layer);
      rgb = lyr?.rgb != null ? lyr.rgb : aciToRgb(lyr?.color ?? 7, fg());
    }
    if (inv()) rgb = 0xffffff ^ rgb;
    // Plot style table active (PLOT with a CTB/STB loaded): map through the pen
    // table — forced colour, grayscale policy — like drawing workspace plot previews.
    if (cmode === "style" && plotStyle) {
      const r = resolvePlotStyle(plotStyle.table, plotEntryOf(e));
      let ch: [number, number, number] = r.color ?? rgbToChannels(rgb);
      if (r.grayscale) {
        const g = grayscaleChannel(ch);
        ch = [g, g, g];
      }
      return rgbToCss((ch[0] << 16) | (ch[1] << 8) | ch[2]);
    }
    return rgbToCss(rgb);
  }

  /** Plot style entry for an entity: CTB → ACI (entity, then layer, then 7). */
  function plotEntryOf(e: DxfEntity) {
    if (!plotStyle) return null;
    const t = plotStyle.table;
    if (t.kind === "ctb") {
      const lyr = layerOf(e.layer);
      const aci =
        e.color != null && e.color > 0 && e.color < 256
          ? e.color
          : lyr && lyr.color > 0 && lyr.color < 256
            ? lyr.color
            : 7;
      return plotStyleForAci(t, aci);
    }
    return plotStyleByName(t, "Normal");
  }

  /** Effective transparency percent for an entity (entity 440 wins over its layer's). */
  function alphaOf(e: DxfEntity): number {
    const t = e.transparency ?? layerOf(e.layer)?.transparency ?? 0;
    let a = t > 0 ? Math.max(0.1, 1 - t / 100) : 1;
    // Plot style screening (ink coverage) combines with entity transparency.
    if (cmode === "style" && plotStyle) {
      const r = resolvePlotStyle(plotStyle.table, plotEntryOf(e));
      a = Math.min(a, r.alpha);
    }
    return a;
  }

  const fmt = (v: number, p = 1) => M.formatQty(v * scaleCal, doc?.units, du, p);
  const dpr = () => window.devicePixelRatio || 1;
  const status = (m: string) => {
    busyEl.textContent = m;
    busyEl.style.display = m ? "block" : "none";
    if (m) logCmd(m);
  };

  function resize() {
    const r = cv.getBoundingClientRect(),
      d = dpr();
    cv.width = Math.max(1, Math.round(r.width * d));
    cv.height = Math.max(1, Math.round(r.height * d));
    view = { ...view, w: r.width, h: r.height };
    draw();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(cv);

  /* ── drawing workspace Rendering Engine ── */

  function drawEntity(c: CanvasRenderingContext2D, e: DxfEntity, v: M.View, flipY = true): void {
    const P = (x: number, y: number) => M.worldToScreen(v, x, y);
    c.beginPath();
    switch (e.type) {
      case "LINE": {
        const a = P(e.start.x, e.start.y),
          b = P(e.end.x, e.end.y);
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
        break;
      }
      // RAY / XLINE: infinite construction lines, drawn edge-to-edge like
      // native CAD by clipping the infinite line against the current view.
      case "RAY":
      case "XLINE": {
        const seg = M.infiniteLineSegment(e, v);
        if (seg) {
          const a = P(seg[0].x, seg[0].y),
            b = P(seg[1].x, seg[1].y);
          c.moveTo(a.x, a.y);
          c.lineTo(b.x, b.y);
          c.stroke();
        }
        break;
      }
      case "CIRCLE": {
        const p = P(e.center.x, e.center.y);
        c.arc(p.x, p.y, e.radius * v.scale, 0, Math.PI * 2);
        c.stroke();
        break;
      }
      case "ARC": {
        const p = P(e.center.x, e.center.y);
        const sw = (M.arcSweepDeg(e.startAngle, e.endAngle) * Math.PI) / 180,
          s = (-e.startAngle * Math.PI) / 180;
        c.arc(p.x, p.y, e.radius * v.scale, s, s - sw, true);
        c.stroke();
        break;
      }
      case "LWPOLYLINE": {
        if (e.hatch) {
          drawHatch(c, e, v);
          break;
        }
        e.points.forEach((q, i) => {
          const p = P(q.x, q.y);
          i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y);
        });
        if (e.closed) c.closePath();
        c.stroke();
        break;
      }
      case "POINT": {
        const p = P(e.position.x, e.position.y);
        c.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
        break;
      }
      case "TEXT": {
        const px = e.height * v.scale;
        const o = M.textOrigin(e);
        // Native CAD keeps drawing real glyphs at any zoom: only go to a
        // placeholder stroke when the text would be sub-pixel on screen.
        if (px < 0.75) {
          const p = P(e.position.x, e.position.y);
          const w = M.textBox(e).w * v.scale;
          const ox = o.dx * v.scale;
          c.moveTo(p.x + ox, p.y);
          c.lineTo(p.x + ox + w, p.y);
          c.stroke();
          break;
        }
        const p = P(e.position.x, e.position.y);
        c.save();
        c.translate(p.x, p.y);
        c.rotate((-(e.rotation ?? 0) * Math.PI) / 180);
        if (e.backwards) c.scale(-1, 1);
        if (e.upsideDown) c.scale(1, -1);
        c.font = M.textFontCss(e, Math.min(px, 600));
        if (e.widthFactor && e.widthFactor > 0 && e.widthFactor !== 1) c.scale(e.widthFactor, 1);
        if (e.oblique) c.transform(1, 0, -Math.tan((e.oblique * Math.PI) / 180), 1, 0, 0);
        c.textAlign = e.align ?? "left";
        c.textBaseline = "alphabetic";
        {
          // Visual lines as runs: explicit breaks + the MTEXT column wrap, the
          // same view drawing, hit-testing and the bbox all share (M.textRuns).
          const lines = M.textRuns(e);
          const bl = M.textLineBaselines(e);
          // Express Tools TEXTMASK: paint a background-coloured box behind the
          // glyphs so the text stays readable over dense linework.
          if (e.mask && bl.length) {
            const wpx = Math.max(1, ...lines.map((ls) => c.measureText(ls.map((r) => r.text).join("")).width));
            const top = -bl[0] * v.scale - px * 0.85;
            const bot = -bl[bl.length - 1] * v.scale + px * 0.25;
            const xoff = (e.align ?? "left") === "center" ? -wpx / 2 : (e.align ?? "left") === "right" ? -wpx : 0;
            c.save();
            c.fillStyle = BG[bg] ?? "#212830";
            c.fillRect(xoff - px * 0.15, top, wpx + px * 0.3, Math.max(px, bot - top));
            c.restore();
          }
          const styled = !!e.runs?.some((r) => r.color != null || r.rgb != null || r.bold || r.italic);
          if (!styled) {
            for (let li = 0; li < lines.length; li++)
              c.fillText(lines[li].map((r) => r.text).join(""), 0, -bl[li] * v.scale);
          } else {
            // Inline \\C / \\f codes: paint run by run with its own colour and
            // weight, aligned by the canvas' own measurements like native CAD.
            // paintEntities already set fillStyle to the entity colour — keep it
            // as the fallback for bare runs and restore it after each line.
            const base = c.fillStyle;
            c.textAlign = "left";
            for (let li = 0; li < lines.length; li++) {
              const line = lines[li];
              if (!line.length) continue;
              const pxs = Math.min(px, 600);
              const widths = line.map((r) => {
                c.font = M.textFontCss(r.bold != null || r.italic != null ? { ...e, bold: r.bold, italic: r.italic } : e, pxs);
                return c.measureText(r.text).width;
              });
              const total = widths.reduce((a, b) => a + b, 0);
              let x = e.align === "center" ? -total / 2 : e.align === "right" ? -total : 0;
              line.forEach((r, ri) => {
                if (r.bold != null || r.italic != null)
                  c.font = M.textFontCss({ ...e, bold: r.bold, italic: r.italic }, pxs);
                c.fillStyle = r.rgb != null ? rgbToCss(r.rgb & 0xffffff) : r.color != null ? rgbToCss(aciToRgb(r.color, fg())) : base as string;
                c.fillText(r.text, x, -bl[li] * v.scale);
                x += widths[ri];
              });
              c.fillStyle = base;
            }
          }
        }
        c.restore();
        break;
      }
    }
  }

  const visibleBox = (v: M.View): M.BBox => {
    const a = M.screenToWorld(v, 0, 0),
      b = M.screenToWorld(v, v.w, v.h);
    return {
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxY: Math.max(a.y, b.y),
    };
  };

  function drawHatch(
    c: CanvasRenderingContext2D,
    e: Extract<DxfEntity, { type: "LWPOLYLINE" }>,
    v: M.View,
  ): void {
    const h = e.hatch!;
    c.save();
    c.beginPath();
    for (const loop of h.loops) {
      loop.forEach((q, i) => {
        const p = M.worldToScreen(v, q.x, q.y);
        i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y);
      });
      c.closePath();
    }
    const fams = h.solid ? [] : M.hatchFamilies(h.pattern, h.angle, h.scale);
    if (h.wipeout) { c.fillStyle = BG[bg] || BG.drafting; c.fill("evenodd"); }
    else if (h.solid) c.fill("evenodd");
    else if (Math.min(...fams.map((f) => f.spacing)) * v.scale < 3) {
      c.globalAlpha = 0.35;
      c.fill("evenodd");
    } else {
      c.clip("evenodd");
      const vb = visibleBox(v),
        eb = M.entityBBox(e);
      const box = {
        minX: Math.max(vb.minX, eb.minX),
        minY: Math.max(vb.minY, eb.minY),
        maxX: Math.min(vb.maxX, eb.maxX),
        maxY: Math.min(vb.maxY, eb.maxY),
      };
      if (box.minX <= box.maxX && box.minY <= box.maxY) {
        c.lineWidth = Math.max(0.6, lw * 0.6);
        c.setLineDash([]);
        c.beginPath();
        if (h.patternLines?.length) {
          // Real pattern definition from the file (acadrust engine): draw the
          // actual ANSI/ISO line families with their native dash motifs
          // instead of a generic spacing fallback.
          const step = Math.min(
            ...h.patternLines.map((f) => Math.hypot(f.offset[0], f.offset[1])),
          );
          if (step * v.scale >= 2) {
            for (const sg of M.hatchPatternLineSegments(box, h.patternLines)) {
              const a = M.worldToScreen(v, sg[0], sg[1]),
                b = M.worldToScreen(v, sg[2], sg[3]);
              c.moveTo(a.x, a.y);
              c.lineTo(b.x, b.y);
            }
          } else {
            c.globalAlpha = 0.35;
            c.fill("evenodd");
          }
        } else {
          for (const f of fams)
            for (const sg of M.hatchLineSegments(box, f.angle, f.spacing)) {
              const a = M.worldToScreen(v, sg[0], sg[1]),
                b = M.worldToScreen(v, sg[2], sg[3]);
              c.moveTo(a.x, a.y);
              c.lineTo(b.x, b.y);
            }
        }
        c.stroke();
      }
    }
    c.restore();
  }

  const dashFor = (e: DxfEntity, v: M.View): number[] =>
    !doc || !showLt || (e.type === "LWPOLYLINE" && e.hatch)
      ? []
      : M.resolveDash(
          e.lineType ?? layerOf(e.layer)?.lineType,
          doc.linetypes,
          (doc.ltscale ?? 1) * (e.ltScale ?? 1),
          v.scale,
        );

  function paintEntities(
    c: CanvasRenderingContext2D,
    v: M.View,
    list: DxfEntity[],
    ix: M.SpatialIndex | null,
    cull: M.BBox,
    skipSel: boolean,
  ): void {
    const paintAt = (i: number): void => {
      const e = list[i];
      if (!e || !shown(e) || (skipSel && sel.has(i))) return;
      // The viewport query has already culled ordinary geometry. Construction
      // lines are deliberately included by queryIndexBox and clipped per view.
      if (ix && e.type !== "RAY" && e.type !== "XLINE") {
        const bb = ix.boxes[i];
        if (!bb) return;
        if (
          e.type !== "POINT" &&
          (bb.maxX - bb.minX) * v.scale < 0.4 &&
          (bb.maxY - bb.minY) * v.scale < 0.4
        ) return;
      }
      const col = colorOf(e);
      c.strokeStyle = col;
      c.fillStyle = col;
      c.setLineDash(dashFor(e, v));
      c.lineWidth = lwtOn && !(e.type === "LWPOLYLINE" && e.hatch) ? lineweightPxFor(e) : lwtOn ? lw : 1;
      c.globalAlpha = alphaOf(e);
      drawEntity(c, e, v);
      c.globalAlpha = 1;
    };
    if (ix) {
      for (const i of M.queryIndexBox(ix, list, cull)) paintAt(i);
    } else {
      for (let i = 0; i < list.length; i++) paintAt(i);
    }
    c.setLineDash([]);
    c.lineWidth = lwtOn ? lw : 1;
    c.globalAlpha = 1;
  }

  /** Paints the drawing workspace major/minor grid and red/green axes through (0,0) */
  function paintGrid(c: CanvasRenderingContext2D, v: M.View): void {
    const st = M.gridStep(v.scale),
      tl = M.screenToWorld(v, 0, 0),
      br = M.screenToWorld(v, v.w, v.h);
    c.save();

    // Minor grid lines
    c.strokeStyle = "rgba(255,255,255,0.06)";
    c.lineWidth = 1;
    c.beginPath();
    for (let x = Math.ceil(tl.x / st) * st; x <= br.x; x += st) {
      const p = M.worldToScreen(v, x, 0).x;
      c.moveTo(p, 0);
      c.lineTo(p, v.h);
    }
    for (let y = Math.ceil(br.y / st) * st; y <= tl.y; y += st) {
      const p = M.worldToScreen(v, 0, y).y;
      c.moveTo(0, p);
      c.lineTo(v.w, p);
    }
    c.stroke();

    // Major grid lines (every 5 steps)
    const majorSt = st * 5;
    c.strokeStyle = "rgba(255,255,255,0.12)";
    c.beginPath();
    for (let x = Math.ceil(tl.x / majorSt) * majorSt; x <= br.x; x += majorSt) {
      const p = M.worldToScreen(v, x, 0).x;
      c.moveTo(p, 0);
      c.lineTo(p, v.h);
    }
    for (let y = Math.ceil(br.y / majorSt) * majorSt; y <= tl.y; y += majorSt) {
      const p = M.worldToScreen(v, 0, y).y;
      c.moveTo(0, p);
      c.lineTo(v.w, p);
    }
    c.stroke();

    // drawing workspace Colored Axes passing through (0,0): X is Red, Y is Green
    const originScreen = M.worldToScreen(v, 0, 0);
    if (originScreen.y >= 0 && originScreen.y <= v.h) {
      c.strokeStyle = "rgba(239, 68, 68, 0.55)"; // Red X-axis
      c.beginPath();
      c.moveTo(0, originScreen.y);
      c.lineTo(v.w, originScreen.y);
      c.stroke();
    }
    if (originScreen.x >= 0 && originScreen.x <= v.w) {
      c.strokeStyle = "rgba(34, 197, 94, 0.55)"; // Green Y-axis
      c.beginPath();
      c.moveTo(originScreen.x, 0);
      c.lineTo(originScreen.x, v.h);
      c.stroke();
    }

    c.restore();
  }

  /** Paints the drawing workspace UCS icon at the bottom-left corner */
  function paintUcsIcon(c: CanvasRenderingContext2D, v: M.View): void {
    const x0 = 42;
    const y0 = v.h - 42;
    const len = 34;

    c.save();
    c.lineWidth = 2;

    // X axis (Red)
    c.strokeStyle = "#ef4444";
    c.fillStyle = "#ef4444";
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x0 + len, y0);
    c.stroke();
    // Arrowhead X
    c.beginPath();
    c.moveTo(x0 + len, y0);
    c.lineTo(x0 + len - 6, y0 - 3);
    c.lineTo(x0 + len - 6, y0 + 3);
    c.closePath();
    c.fill();
    c.font = "bold 11px system-ui, sans-serif";
    c.fillText("X", x0 + len + 4, y0 + 4);

    // Y axis (Green)
    c.strokeStyle = "#22c55e";
    c.fillStyle = "#22c55e";
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x0, y0 - len);
    c.stroke();
    // Arrowhead Y
    c.beginPath();
    c.moveTo(x0, y0 - len);
    c.lineTo(x0 - 3, y0 - len + 6);
    c.lineTo(x0 + 3, y0 - len + 6);
    c.closePath();
    c.fill();
    c.fillText("Y", x0 - 4, y0 - len - 4);

    // Center origin square
    c.strokeStyle = origin ? "#38bdf8" : "#94a3b8";
    c.strokeRect(x0 - 3, y0 - 3, 6, 6);
    c.font = "9px system-ui";
    c.fillStyle = origin ? "#38bdf8" : "#94a3b8";
    c.fillText(origin ? "UCS" : "W", x0 + 5, y0 + 12);

    c.restore();
  }

  /** Paints drawing workspace Infinite Crosshairs with central Pickbox */
  function paintDrawingCrosshairs(c: CanvasRenderingContext2D, v: M.View): void {
    if (!cursor) return;
    const cp = M.worldToScreen(v, cursor.x, cursor.y);
    const boxSize = 8;
    const halfBox = boxSize / 2;

    c.save();
    c.strokeStyle = "rgba(255, 255, 255, 0.65)";
    c.lineWidth = 1;

    // Pickbox
    c.strokeRect(cp.x - halfBox, cp.y - halfBox, boxSize, boxSize);

    // Infinite horizontal line (broken around pickbox)
    c.beginPath();
    c.moveTo(0, cp.y);
    c.lineTo(cp.x - halfBox, cp.y);
    c.moveTo(cp.x + halfBox, cp.y);
    c.lineTo(v.w, cp.y);

    // Infinite vertical line (broken around pickbox)
    c.moveTo(cp.x, 0);
    c.lineTo(cp.x, cp.y - halfBox);
    c.moveTo(cp.x, cp.y + halfBox);
    c.lineTo(cp.x, v.h);
    c.stroke();

    c.restore();
  }

  /** Paints Dynamic Input HUD attached to cursor (F12) */
  function paintDynamicInput(c: CanvasRenderingContext2D, v: M.View): void {
    if (!cursor || !dynOn || !doc) return;
    const cp = M.worldToScreen(v, cursor.x, cursor.y);
    const xOffset = 18;
    const yOffset = 18;

    let text1 = "";
    let text2 = "";

    const ax = M.convertLength(cursor.x * scaleCal, doc.units, du);
    const ay = M.convertLength(cursor.y * scaleCal, doc.units, du);
    const uLabel = M.unitLabel(doc.units, du);

    if (pts.length > 0) {
      const lastP = pts[pts.length - 1];
      const d = M.distance(lastP, cursor);
      const ang = M.norm360Deg(lastP, cursor);
      text1 = `${fmt(d)} < ${ang.toFixed(1)}°`;
      text2 = `Specify next point or [Close/Undo]`;
    } else if (mod) {
      text2 = modPrompt();
      if (mod.stage === "second" && mod.base) {
        const d = M.distance(mod.base, cursor);
        const ang = M.norm360Deg(mod.base, cursor);
        if (mod.kind === "rotate") text1 = `${ang.toFixed(1)}°`;
        else if (mod.kind === "scale") {
          const refD = mod.ref ? Math.max(1e-9, M.distance(mod.ref, mod.base)) : 1;
          text1 = `×${(d / refD).toFixed(4)}`;
        } else text1 = `${fmt(d)} < ${ang.toFixed(1)}°`;
      } else if (mod.stage === "select") {
        text1 = `${sel.size} selected`;
      } else {
        text1 = `${ax.toFixed(4)}, ${ay.toFixed(4)} ${uLabel}`;
      }
    } else if (tool === "offset") {
      text2 = offsetPrompt();
      if (offStage === "dist2" && offPick) {
        text1 = `${fmt(M.distance(offPick, cursor))}`;
      } else {
        text1 = `${ax.toFixed(4)}, ${ay.toFixed(4)} ${uLabel}`;
      }
    } else {
      text1 = `${ax.toFixed(4)}, ${ay.toFixed(4)} ${uLabel}`;
      if (tool === "line") text2 = "Specify first point:";
      else if (tool === "circle") text2 = "Specify center point:";
      else if (tool === "rect") text2 = "Specify first corner:";
      else if (tool === "arc") text2 = "Specify start point:";
    }

    c.save();
    c.font = "11px system-ui, sans-serif";
    const w1 = c.measureText(text1).width;
    const w2 = text2 ? c.measureText(text2).width : 0;
    const totalW = Math.max(w1, w2) + 14;
    const totalH = text2 ? 34 : 20;

    c.fillStyle = "rgba(15, 23, 42, 0.85)";
    c.strokeStyle = "rgba(56, 189, 248, 0.5)";
    c.lineWidth = 1;
    c.beginPath();
    c.roundRect(cp.x + xOffset, cp.y + yOffset, totalW, totalH, 4);
    c.fill();
    c.stroke();

    c.fillStyle = "#38bdf8";
    c.fillText(text1, cp.x + xOffset + 7, cp.y + yOffset + 14);
    if (text2) {
      c.fillStyle = "#cbd5e1";
      c.fillText(text2, cp.x + xOffset + 7, cp.y + yOffset + 28);
    }
    c.restore();
  }

  /** Paints Object Snap glyphs with tooltips */
  function paintSnapGlyph(c: CanvasRenderingContext2D, v: M.View, s: M.Snap): void {
    const p = M.worldToScreen(v, s.x, s.y);
    c.save();
    c.strokeStyle = "#22c55e";
    c.fillStyle = "#22c55e";
    c.lineWidth = 2;

    let snapLabel = "Snap";
    switch (s.kind) {
      case "endpoint":
        c.strokeRect(p.x - 5, p.y - 5, 10, 10);
        snapLabel = "Endpoint";
        break;
      case "midpoint":
        c.beginPath();
        c.moveTo(p.x - 6, p.y + 5);
        c.lineTo(p.x + 6, p.y + 5);
        c.lineTo(p.x, p.y - 6);
        c.closePath();
        c.stroke();
        snapLabel = "Midpoint";
        break;
      case "center":
        c.beginPath();
        c.arc(p.x, p.y, 6, 0, Math.PI * 2);
        c.stroke();
        snapLabel = "Center";
        break;
      case "quadrant":
        c.beginPath();
        c.moveTo(p.x, p.y - 6);
        c.lineTo(p.x + 6, p.y);
        c.lineTo(p.x, p.y + 6);
        c.lineTo(p.x - 6, p.y);
        c.closePath();
        c.stroke();
        snapLabel = "Quadrant";
        break;
      case "intersection":
        c.beginPath();
        c.moveTo(p.x - 5, p.y - 5);
        c.lineTo(p.x + 5, p.y + 5);
        c.moveTo(p.x + 5, p.y - 5);
        c.lineTo(p.x - 5, p.y + 5);
        c.stroke();
        snapLabel = "Intersection";
        break;
      default:
        // Nearest hourglass
        c.beginPath();
        c.moveTo(p.x - 4, p.y - 5);
        c.lineTo(p.x + 4, p.y + 5);
        c.lineTo(p.x - 4, p.y + 5);
        c.lineTo(p.x + 4, p.y - 5);
        c.closePath();
        c.stroke();
        snapLabel = "Nearest";
        break;
    }

    // Snap badge
    c.font = "10px system-ui, sans-serif";
    const bw = c.measureText(snapLabel).width + 8;
    c.fillStyle = "rgba(15, 23, 42, 0.85)";
    c.fillRect(p.x + 10, p.y - 16, bw, 16);
    c.strokeStyle = "#22c55e";
    c.lineWidth = 1;
    c.strokeRect(p.x + 10, p.y - 16, bw, 16);
    c.fillStyle = "#4ade80";
    c.fillText(snapLabel, p.x + 14, p.y - 4);

    c.restore();
  }

  function render(c: CanvasRenderingContext2D, v: M.View, withUi: boolean): void {
    c.save();
    c.fillStyle = BG[bg] || BG.drafting;
    c.fillRect(0, 0, v.w, v.h);
    if (!doc) {
      c.restore();
      return;
    }

    if (withUi && showGrid) paintGrid(c, v);
    c.lineWidth = lwtOn ? lw : 1;
    c.lineJoin = "round";

    paintEntities(c, v, ents, idx, visibleBox(v), true);

    if (cmp && layoutI < 0) {
      forceColor = "#22c55e";
      paintEntities(c, v, cmp.added, null, visibleBox(v), false);
      forceColor = null;
    }

    // Layout / Paper space viewports
    if (layoutI >= 0 && doc?.layouts?.[layoutI]) {
      for (const vp of doc.layouts[layoutI].viewports) {
        const r = M.viewportRect(vp),
          a = M.worldToScreen(v, r.minX, r.maxY),
          b = M.worldToScreen(v, r.maxX, r.minY),
          ctr = M.worldToScreen(v, vp.center.x, vp.center.y),
          sc = M.viewportScale(vp);
        c.save();
        c.beginPath();
        c.rect(a.x, a.y, b.x - a.x, b.y - a.y);
        c.clip();
        c.translate(ctr.x, ctr.y);
        c.rotate(((vp.twist ?? 0) * Math.PI) / 180);
        c.translate(-ctr.x, -ctr.y);
        const vv: M.View = {
          cx: vp.viewCenter.x,
          cy: vp.viewCenter.y,
          scale: v.scale * sc,
          w: ctr.x * 2,
          h: ctr.y * 2,
        };
        const rad = Math.hypot(vp.width, vp.height) / 2 / sc;
        paintEntities(
          c,
          vv,
          modelEnts,
          modelIdx,
          {
            minX: vp.viewCenter.x - rad,
            maxX: vp.viewCenter.x + rad,
            minY: vp.viewCenter.y - rad,
            maxY: vp.viewCenter.y + rad,
          },
          false,
        );
        c.restore();
        c.save();
        c.strokeStyle = bg === "white" ? "rgba(0,0,0,.35)" : "rgba(255,255,255,.35)";
        c.lineWidth = 1;
        c.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        c.restore();
      }
    }

    // Selected entities highlight
    if (sel.size) {
      c.save();
      c.setLineDash([]);
      c.lineWidth = lw + 2;
      c.strokeStyle = "#38bdf8";
      c.fillStyle = "#38bdf8";
      for (const i of sel) if (ents[i] && visible(ents[i])) drawEntity(c, ents[i], v);
      c.restore();
    }

    // drawing workspace grips: blue squares on the selection, green under the cursor, red while dragging.
    if (withUi && (tool === "select" || tool === "box") && !mod && !pick && !gripDrag) {
      const drawGrip = (x: number, y: number, fill: string): void => {
        const s = M.worldToScreen(v, x, y);
        if (s.x < -8 || s.y < -8 || s.x > v.w + 8 || s.y > v.h + 8) return;
        c.fillStyle = fill;
        c.strokeStyle = "rgba(15,23,42,.9)";
        c.lineWidth = 1;
        c.beginPath();
        c.rect(s.x - 3.5, s.y - 3.5, 7, 7);
        c.fill();
        c.stroke();
      };
      if (sel.size <= 128) {
        c.save();
        c.setLineDash([]);
        let budget = 400;
        for (const i of sel) {
          const e = ents[i];
          if (!e || !visible(e)) continue;
          const grips = M.entityGrips(e);
          for (let gi = 0; gi < grips.length && budget > 0; gi++, budget--) {
            const g = grips[gi];
            const hot = gripHover && gripHover.i === i && gripHover.gi === gi;
            drawGrip(g.x, g.y, hot ? "#22c55e" : "#3b82f6");
          }
          if (budget <= 0) break;
        }
        c.restore();
      }
    }

    // LENGTHEN dynamic stretch preview (dashed yellow, same language as the modify ghost)
    if (withUi && pick && pick.kind === "lengthen" && pick.ghost) {
      c.save();
      c.setLineDash([6, 4]);
      c.lineWidth = lw + 1;
      c.strokeStyle = "#facc15";
      drawEntity(c, pick.ghost, v);
      c.restore();
    }

    // MLEADER preview: arrow point → cursor while waiting for the landing end
    if (withUi && pick && pick.kind === "mleader" && pick.stage === "landing" && pick.p1 && cursor) {
      const a = M.worldToScreen(v, pick.p1.x, pick.p1.y);
      const b2 = M.worldToScreen(v, cursor.x, cursor.y);
      c.save();
      c.strokeStyle = "rgba(250,204,21,.8)";
      c.setLineDash([4, 4]);
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b2.x, b2.y);
      c.stroke();
      c.restore();
    }

    // Modify ghost preview (MOVE / COPY / ROTATE / MIRROR / SCALE) — drawing workspace drag style
    if (modGhost && modGhost.length) {
      c.save();
      c.setLineDash([6, 4]);
      c.lineWidth = lw + 1;
      c.strokeStyle = "#facc15";
      c.fillStyle = "#facc15";
      c.globalAlpha = 0.85;
      for (const e of modGhost) drawEntity(c, e, v);
      c.restore();
    }

    // Modify guide lines: displacement (base→cursor) or mirror axis
    if (withUi && mod && mod.base && mod.stage === "second" && cursor) {
      const a = M.worldToScreen(v, mod.base.x, mod.base.y);
      const b2 = M.worldToScreen(v, cursor.x, cursor.y);
      c.save();
      c.strokeStyle = mod.kind === "mirror" ? "#a78bfa" : "rgba(250,204,21,.7)";
      c.setLineDash(mod.kind === "mirror" ? [8, 5] : [4, 4]);
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b2.x, b2.y);
      c.stroke();
      if (mod.kind === "mirror") {
        // Extend the mirror axis across the viewport
        const dx = b2.x - a.x,
          dy = b2.y - a.y;
        const L = Math.hypot(v.w, v.h);
        const len = Math.hypot(dx, dy) || 1;
        c.beginPath();
        c.moveTo(b2.x + (dx / len) * L, b2.y + (dy / len) * L);
        c.lineTo(b2.x - (dx / len) * L, b2.y - (dy / len) * L);
        c.stroke();
      }
      c.restore();
    }

    // Markups (redlines, dimensions, clouds, leaders)
    c.save();
    c.strokeStyle = "#ef4444";
    c.fillStyle = "#ef4444";
    c.lineWidth = 2;
    c.font = "14px sans-serif";
    for (const m of markups) {
      if (m.kind === "line") {
        c.beginPath();
        m.pts.forEach((q, i) => {
          const p = M.worldToScreen(v, q.x, q.y);
          i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y);
        });
        c.stroke();
      } else if (m.kind === "dim" && m.pts.length >= 2) {
        const a = M.worldToScreen(v, m.pts[0].x, m.pts[0].y);
        const b = M.worldToScreen(v, m.pts[1].x, m.pts[1].y);
        c.strokeStyle = "#38bdf8";
        c.fillStyle = "#38bdf8";
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        for (const p of [a, b]) {
          c.beginPath();
          c.moveTo(p.x + Math.cos(ang + Math.PI / 2) * 6, p.y + Math.sin(ang + Math.PI / 2) * 6);
          c.lineTo(p.x + Math.cos(ang - Math.PI / 2) * 6, p.y + Math.sin(ang - Math.PI / 2) * 6);
          c.stroke();
        }
        const mx = (a.x + b.x) / 2,
          my = (a.y + b.y) / 2;
        c.font = "bold 12px system-ui,sans-serif";
        c.fillText(m.text ?? "", mx + 4, my - 4);
        c.strokeStyle = "#ef4444";
        c.fillStyle = "#ef4444";
      } else if (m.kind === "cloud" && m.pts.length >= 2) {
        c.strokeStyle = "#f97316";
        c.lineWidth = 2;
        c.beginPath();
        m.pts.forEach((q, i) => {
          const p = M.worldToScreen(v, q.x, q.y);
          i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y);
        });
        c.stroke();
        c.strokeStyle = "#ef4444";
        c.fillStyle = "#ef4444";
      } else if (m.kind === "leader" && m.pts.length >= 2) {
        const a = M.worldToScreen(v, m.pts[0].x, m.pts[0].y);
        const b = M.worldToScreen(v, m.pts[1].x, m.pts[1].y);
        c.strokeStyle = "#a78bfa";
        c.fillStyle = "#a78bfa";
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
        const ang = Math.atan2(a.y - b.y, a.x - b.x);
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(a.x - 10 * Math.cos(ang - 0.4), a.y - 10 * Math.sin(ang - 0.4));
        c.lineTo(a.x - 10 * Math.cos(ang + 0.4), a.y - 10 * Math.sin(ang + 0.4));
        c.closePath();
        c.fill();
        c.font = "12px system-ui,sans-serif";
        c.fillText(m.text ?? "", b.x + 4, b.y - 4);
        c.strokeStyle = "#ef4444";
        c.fillStyle = "#ef4444";
      } else if (m.kind === "dimang" && m.pts.length >= 3) {
        // Angular dimension: vertex + two ray points (drawing workspace DIMANGULAR 3-point flow)
        const v0 = M.worldToScreen(v, m.pts[0].x, m.pts[0].y);
        const a = M.worldToScreen(v, m.pts[1].x, m.pts[1].y);
        const b = M.worldToScreen(v, m.pts[2].x, m.pts[2].y);
        const a1 = Math.atan2(a.y - v0.y, a.x - v0.x);
        const a2 = Math.atan2(b.y - v0.y, b.x - v0.x);
        const r = Math.min(46, Math.max(22, Math.min(Math.hypot(a.x - v0.x, a.y - v0.y), Math.hypot(b.x - v0.x, b.y - v0.y)) * 0.7));
        c.strokeStyle = "#38bdf8";
        c.fillStyle = "#38bdf8";
        for (const ang of [a1, a2]) {
          c.beginPath();
          c.moveTo(v0.x, v0.y);
          c.lineTo(v0.x + Math.cos(ang) * (r + 10), v0.y + Math.sin(ang) * (r + 10));
          c.stroke();
        }
        let da = a2 - a1;
        while (da <= -Math.PI) da += 2 * Math.PI;
        while (da > Math.PI) da -= 2 * Math.PI;
        c.beginPath();
        c.arc(v0.x, v0.y, r, a1, a1 + da, da < 0);
        c.stroke();
        const mid = a1 + da / 2;
        c.font = "bold 12px system-ui,sans-serif";
        c.fillText(m.text ?? "", v0.x + Math.cos(mid) * (r + 14) - 6, v0.y + Math.sin(mid) * (r + 14) + 4);
        c.strokeStyle = "#ef4444";
        c.fillStyle = "#ef4444";
      } else if (m.kind === "dimarc" && m.pts.length >= 3) {
        // Arc-length dimension: runs along the picked arc, label = arc length
        const c0 = M.worldToScreen(v, m.pts[0].x, m.pts[0].y);
        const s = M.worldToScreen(v, m.pts[1].x, m.pts[1].y);
        const e = M.worldToScreen(v, m.pts[2].x, m.pts[2].y);
        const r = Math.hypot(s.x - c0.x, s.y - c0.y);
        const a1 = Math.atan2(s.y - c0.y, s.x - c0.x);
        const a2 = Math.atan2(e.y - c0.y, e.x - c0.x);
        c.strokeStyle = "#38bdf8";
        c.fillStyle = "#38bdf8";
        c.beginPath();
        c.arc(c0.x, c0.y, r, a1, a2);
        c.stroke();
        const mid = (a1 + a2) / 2;
        c.font = "bold 12px system-ui,sans-serif";
        c.fillText(m.text ?? "", c0.x + Math.cos(mid) * (r + 12) - 6, c0.y + Math.sin(mid) * (r + 12) + 4);
        c.strokeStyle = "#ef4444";
        c.fillStyle = "#ef4444";
      } else if (m.kind === "dimdia" && m.pts.length >= 2) {
        // Diameter dimension: full diameter line through the center + ⌀ label
        const c0 = M.worldToScreen(v, m.pts[0].x, m.pts[0].y);
        const e1 = M.worldToScreen(v, m.pts[1].x, m.pts[1].y);
        const ex = e1.x - c0.x,
          ey = e1.y - c0.y;
        const len = Math.hypot(ex, ey) || 1;
        const e2 = { x: c0.x - ex, y: c0.y - ey };
        c.strokeStyle = "#38bdf8";
        c.fillStyle = "#38bdf8";
        c.beginPath();
        c.moveTo(e2.x, e2.y);
        c.lineTo(e1.x, e1.y);
        c.stroke();
        for (const p of [e1, e2]) {
          c.beginPath();
          c.arc(p.x, p.y, 2.4, 0, 7);
          c.fill();
        }
        c.font = "bold 12px system-ui,sans-serif";
        c.fillText(m.text ?? "", e1.x + 6, e1.y - 4);
        c.strokeStyle = "#ef4444";
        c.fillStyle = "#ef4444";
      } else if (m.kind === "dimcenter" && m.pts.length >= 1) {
        // Center mark: cross at the circle / arc center
        const c0 = M.worldToScreen(v, m.pts[0].x, m.pts[0].y);
        c.strokeStyle = "#38bdf8";
        c.lineWidth = 1.4;
        c.beginPath();
        c.moveTo(c0.x - 9, c0.y);
        c.lineTo(c0.x + 9, c0.y);
        c.moveTo(c0.x, c0.y - 9);
        c.lineTo(c0.x, c0.y + 9);
        c.stroke();
        c.strokeStyle = "#ef4444";
        c.lineWidth = 2;
      } else if (m.kind === "stamp") {
        const p = M.worldToScreen(v, m.pts[0].x, m.pts[0].y);
        c.font = "bold 13px system-ui,sans-serif";
        c.fillStyle = "#fbbf24";
        const tw = c.measureText(m.text ?? "").width;
        c.fillStyle = "rgba(0,0,0,0.55)";
        c.fillRect(p.x - 4, p.y - 14, tw + 8, 18);
        c.fillStyle = "#fbbf24";
        c.fillText(m.text ?? "", p.x, p.y);
        c.strokeStyle = "#ef4444";
        c.fillStyle = "#ef4444";
      } else {
        const p = M.worldToScreen(v, m.pts[0].x, m.pts[0].y);
        c.fillText(m.text ?? "", p.x, p.y);
        c.beginPath();
        c.arc(p.x, p.y, 3, 0, 7);
        c.fill();
      }
    }
    c.restore();

    if (withUi) {
      c.save();
      c.lineWidth = 1.5;
      c.strokeStyle = "#facc15";
      c.fillStyle = "#facc15";
      c.font = "12px sans-serif";
      for (const d of drawn) paintMeasure(c, v, d.kind, d.pts);
      if (pts.length) paintMeasure(c, v, tool, cursor ? [...pts, cursor] : pts);
      c.restore();

      // Text search highlights
      for (const h of hits) {
        const p = M.worldToScreen(v, h.x, h.y);
        c.strokeStyle = "#f97316";
        c.lineWidth = 2;
        c.strokeRect(p.x - 6, p.y - 6, 12, 12);
      }

      // Parametric constraint overlay: FIX padlocks (CONSTRAINTBAR toggles)
      if (conBarOn && fixedEnts.size) {
        c.save();
        c.strokeStyle = "#38bdf8";
        c.fillStyle = "#38bdf8";
        c.lineWidth = 1.5;
        for (const fe of fixedEnts) {
          const anchor = P.anchorPoint(fe);
          if (!anchor) continue;
          const p = M.worldToScreen(v, anchor.x, anchor.y);
          c.beginPath();
          c.arc(p.x, p.y, 4, 0, Math.PI * 2);
          c.stroke();
          c.fillRect(p.x - 1.5, p.y - 9, 3, 5); // padlock shank
        }
        c.restore();
      }

      // Object Snap glyph
      if (hover && snapOn) {
        paintSnapGlyph(c, v, hover);
      }

      // Scale bar
      paintScaleBar(c, v);

      // drawing workspace UCS Icon
      paintUcsIcon(c, v);

      // drawing workspace Infinite Crosshairs & Pickbox
      paintDrawingCrosshairs(c, v);

      // Dynamic Input HUD (F12)
      paintDynamicInput(c, v);

      // drawing workspace Window (Blue solid) vs Crossing (Green dashed) selection rects
      if (rband) {
        const x = rband.a.x,
          y = rband.a.y,
          w = rband.b.x - x,
          h = rband.b.y - y,
          win = w >= 0;
        c.save();
        c.globalAlpha = 0.15;
        c.fillStyle = win ? "#0284c7" : "#16a34a"; // Blue Window vs Green Crossing
        c.fillRect(x, y, w, h);
        c.globalAlpha = 1;
        c.strokeStyle = win ? "#38bdf8" : "#22c55e";
        c.lineWidth = 1;
        c.setLineDash(win ? [] : [5, 4]);
        c.strokeRect(x, y, w, h);
        c.restore();
      }

      if (winStart && winNow) {
        c.strokeStyle = "#38bdf8";
        c.setLineDash([5, 4]);
        c.strokeRect(winStart.x, winStart.y, winNow.x - winStart.x, winNow.y - winStart.y);
      }
    }

    c.restore();
  }

  function paintScaleBar(c: CanvasRenderingContext2D, v: M.View): void {
    if (!doc) return;
    const sb = M.niceScaleBar(v.scale),
      x = 110,
      y = v.h - 18;
    c.save();
    c.strokeStyle = bg === "white" ? "#111" : "#eee";
    c.fillStyle = c.strokeStyle;
    c.lineWidth = 2;
    c.font = "11px sans-serif";
    c.beginPath();
    c.moveTo(x, y - 5);
    c.lineTo(x, y);
    c.lineTo(x + sb.px, y);
    c.lineTo(x + sb.px, y - 5);
    c.stroke();
    c.fillText(
      `${+M.convertLength(sb.length, doc.units, du).toFixed(3)} ${M.unitLabel(doc.units, du)}`,
      x,
      y - 8,
    );
    c.restore();
  }

  function paintMeasure(
    c: CanvasRenderingContext2D,
    v: M.View,
    kind: Tool,
    p: M.Pt[],
  ): void {
    if (!p.length) return;
    const S = p.map((q) => M.worldToScreen(v, q.x, q.y));
    if (kind === "cloud" && S.length >= 2) {
      // Preview the same scalloped boundary that will be committed on finish.
      const preview = M.revisionCloudPoints(p).map((q) => M.worldToScreen(v, q.x, q.y));
      c.beginPath();
      preview.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
      c.stroke();
      for (const q of S) c.fillRect(q.x - 2.5, q.y - 2.5, 5, 5);
      return;
    }
    c.beginPath();
    S.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));

    if (kind === "area" && S.length > 2) {
      c.closePath();
      c.globalAlpha = 0.18;
      c.fill();
      c.globalAlpha = 1;
    } else if (kind === "circle" && S.length >= 2) {
      const rad = Math.hypot(S[1].x - S[0].x, S[1].y - S[0].y);
      c.beginPath();
      c.arc(S[0].x, S[0].y, rad, 0, Math.PI * 2);
    } else if (kind === "rect" && S.length >= 2) {
      const x0 = Math.min(S[0].x, S[1].x);
      const y0 = Math.min(S[0].y, S[1].y);
      const rw = Math.abs(S[1].x - S[0].x);
      const rh = Math.abs(S[1].y - S[0].y);
      c.beginPath();
      c.rect(x0, y0, rw, rh);
    }

    c.stroke();
    for (const q of S) c.fillRect(q.x - 2.5, q.y - 2.5, 5, 5);

    let label = "";
    const last = S[S.length - 1];
    if (kind === "dist" && p.length >= 2) label = fmt(M.distance(p[0], p[1]));
    else if (kind === "poly" && p.length >= 2) label = fmt(M.pathLength(p));
    else if (kind === "area" && p.length >= 3)
      label = fmt(M.polygonArea(p), 2);
    else if (kind === "radius" && p.length >= 2)
      label = fmt(M.distance(p[0], p[1]));
    else if (kind === "angle" && p.length >= 3)
      label = M.angleAt(p[1], p[0], p[2]).toFixed(2) + "°";

    if (label) {
      c.fillStyle = "#facc15";
      c.fillText(label, last.x + 8, last.y - 8);
    }
  }

  function draw() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const d = dpr();
      g.setTransform(d, 0, 0, d, 0, 0);
      render(g, view, true);
    });
  }

  /* ── Viewport Operations ── */
  const pushView = () => {
    history.push({ ...view });
    if (history.length > 50) history.shift();
  };
  function zoomExtents() {
    if (!bounds) return;
    pushView();
    view = M.fitView(bounds, view.w, view.h);
    draw();
    logCmd("Command: _ZOOM _EXTENTS");
  }
  function goTo(x: number, y: number, scale?: number) {
    pushView();
    view = { ...view, cx: x, cy: y, scale: scale ?? view.scale };
    draw();
  }

  /* ── Style tools (linetypes, fonts, text styles, match properties) ── */
  let matchSrc: DxfEntity | null = null;
  /** CIRCLE creation mode — drawing workspace: Center-radius (default), 2P, 3P. */
  let circleMode: "center" | "2p" | "3p" = "center";
  /** Last status prompt shown (for dyn input / status bar). */
  let acadPromptText = "";

  const styleApi: CadStyleApi = {
    doc: () => doc,
    entities: () => ents,
    selection: () => [...sel],
    commitModify: (before, after) => commitModify(before, after),
    addEntity: (e) => addDraftEntity(e),
    redraw: () => draw(),
    log: (m) => logCmd(m),
    refreshLayers: () => buildLayers(),
    currentLayer: () => currentLayer,
  };
  const lineweightPxFor = (e: DxfEntity): number => {
    let mm = e.lineweight ?? layerOf(e.layer)?.lineweight;
    // Plot style pen assignment (CTB/STB lineweight) wins while plotting.
    if (cmode === "style" && plotStyle) {
      const r = resolvePlotStyle(plotStyle.table, plotEntryOf(e));
      if (r.lineweightMm != null) mm = r.lineweightMm;
    }
    return mm != null ? lineweightPx(mm) : lw;
  };

  /* ── OpenCADStudio absorption: embedded preview + LandXML + DATAEXTRACT ── */

  let previewEl: HTMLDivElement | null = null;
  const hidePreviewPlaceholder = (): void => {
    previewEl?.remove();
    previewEl = null;
  };

  /** Paint the DWG's embedded thumbnail over the canvas while the parse runs. */
  function showPreviewPlaceholder(pv: DwgPreviewImage): void {
    hidePreviewPlaceholder();
    const host = cv.parentElement;
    if (!host) return;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    const d = document.createElement("div");
    d.style.cssText =
      "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#212830;z-index:6;pointer-events:none";
    const img = document.createElement("img");
    img.src = pv.url;
    img.alt = "Embedded drawing preview";
    img.style.cssText = "max-width:68%;max-height:68%;border:1px solid #38404d;box-shadow:0 10px 34px rgba(0,0,0,.45);background:#fff";
    const cap = document.createElement("div");
    cap.style.cssText = "font:12px var(--font-sans,system-ui);color:#9aa4b2;text-align:center;padding:0 20px";
    cap.textContent = `Reading ${name || "drawing"}… — showing the native embedded preview (${pv.format.toUpperCase()} ${pv.width}×${pv.height})`;
    d.append(img, cap);
    host.appendChild(d);
    previewEl = d;
  }

  /** LandXML CgPoints → POINT entities + name labels on a "LandXML Points" layer. */
  async function importLandXml(f: File): Promise<void> {
    try {
      const text = await f.text();
      if (!isLandXml(text)) {
        logCmd("LandXML import: not a LandXML file (expected <LandXML> with CgPoints).");
        return;
      }
      const pts = parseLandXmlPoints(text);
      if (!pts.length) {
        logCmd("LandXML import: no CgPoint elements found.");
        return;
      }
      if (!doc) {
        logCmd("LandXML import: open or create a drawing first.");
        return;
      }
      let lyr = doc.layers.find((l) => l.name === "LandXML Points");
      if (!lyr) {
        lyr = { name: "LandXML Points", color: 4, rgb: 0x00b0f0 };
        doc.layers.push(lyr);
      }
      hidden.delete(lyr.name);
      const b = bounds ?? modelBounds;
      const span = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY) : 0;
      const h = span > 0 ? span / 50 : 1;
      const list: DxfEntity[] = [];
      for (const p of pts) {
        list.push({ type: "POINT", layer: lyr.name, position: { x: p.x, y: p.y } });
        const label = p.name || p.desc;
        if (label)
          list.push({
            type: "TEXT",
            layer: lyr.name,
            position: { x: p.x, y: p.y + h * 0.35 },
            height: h,
            value: label,
          });
      }
      addEntities(list);
      draw();
      logCmd(
        `LandXML: imported ${pts.length} survey point(s) onto layer "${lyr.name}" (north → CAD Y, east → CAD X).`,
      );
    } catch (err) {
      logCmd(`LandXML import failed: ${(err as Error).message}`);
    }
  }

  /** DATAEXTRACT — export every entity's data as CSV (layer, type, colour, geometry). */
  function extractEntityCsv(): void {
    if (!doc || !modelEnts.length) {
      logCmd("DATAEXTRACT: nothing to export — open a drawing first.");
      return;
    }
    const esc = (v: string): string => (/[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows: string[] = [
      "handle,type,layer,color,linetype,lineweight_mm,text,x,y",
    ];
    for (const e of modelEnts) {
      const anchor =
        e.type === "LINE"
          ? e.start
          : e.type === "CIRCLE" || e.type === "ARC"
            ? e.center
            : e.type === "LWPOLYLINE"
              ? (e.points[0] ?? null)
              : e.type === "TEXT" || e.type === "POINT"
                ? e.position
                : null;
      rows.push(
        [
          String((e as { handle?: string }).handle ?? ""),
          e.type,
          e.layer,
          e.rgb != null ? `#${e.rgb.toString(16).padStart(6, "0").toUpperCase()}` : e.color != null ? `ACI ${e.color}` : "ByLayer",
          e.lineType ?? "ByLayer",
          e.lineweight != null ? String(e.lineweight) : "default",
          e.type === "TEXT" ? e.value : "",
          anchor ? anchor.x.toFixed(4) : "",
          anchor ? anchor.y.toFixed(4) : "",
        ]
          .map((c) => esc(String(c)))
          .join(","),
      );
    }
    download(new Blob([rows.join("\r\n")], { type: "text/csv" }), `${base()}-entities.csv`);
    logCmd(`DATAEXTRACT: ${modelEnts.length} entities written to ${base()}-entities.csv`);
  }

  /* ── drawing workspace Drafting Engine ── */
  function addDraftEntity(e: DxfEntity): void {
    ents.push(e);
    if (layoutI < 0) modelEnts.push(e);
    const eb = M.entityBBox(e);
    bounds = bounds ? M.unionBBox(bounds, eb) : eb;
    idx = M.buildIndex(ents, bounds);
    undoStack.push({ type: "add", entities: [e] });
    markDirty();
    redoStack.length = 0;
    showProps();
    draw();
  }

  function eraseSelected(): void {
    if (!sel.size) {
      logCmd("Command: ERASE — 0 found");
      return;
    }
    const fixedSel = [...sel].map((i) => ents[i]).filter((e): e is DxfEntity => !!e && fixedEnts.has(e));
    if (fixedSel.length) {
      logCmd("CONSTRAINT: fixed object(s) in the selection — run UNFIX to erase them.");
      return;
    }
    const removed: DxfEntity[] = [];
    const keep: DxfEntity[] = [];
    ents.forEach((e, i) => {
      if (sel.has(i)) removed.push(e);
      else keep.push(e);
    });
    undoStack.push({ type: "delete", entities: removed });
    markDirty();
    redoStack.length = 0;
    ents = keep;
    if (layoutI < 0) modelEnts = keep;
    sel.clear();
    selected = -1;
    let b: M.BBox | null = null;
    for (const e of ents) b = M.unionBBox(b, M.entityBBox(e));
    bounds = b ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    idx = M.buildIndex(ents, bounds);
    showProps();
    draw();
    logCmd(`Command: ERASE — ${removed.length} object(s) deleted`);
  }

  /** Replaces entity `oldE` with `newE` (identity-based) in ents / modelEnts. */
  const replaceEntity = (oldE: DxfEntity, newE: DxfEntity): void => {
    const i = ents.indexOf(oldE);
    if (i >= 0) ents[i] = newE;
    if (modelEnts !== ents) {
      const j = modelEnts.indexOf(oldE);
      if (j >= 0) modelEnts[j] = newE;
    }
  };

  const rebuildIndex = (): void => {
    let b: M.BBox | null = null;
    for (const e of ents) b = M.unionBBox(b, M.entityBBox(e));
    bounds = b ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    idx = M.buildIndex(ents, bounds);
  };

  function undo(): void {
    const act = undoStack.pop();
    if (!act) {
      logCmd("Nothing to undo.");
      return;
    }
    if (act.type === "add") {
      // Remove added entities
      const addSet = new Set(act.entities ?? []);
      ents = ents.filter((e) => !addSet.has(e));
      if (layoutI < 0) modelEnts = ents;
      redoStack.push(act);
    } else if (act.type === "delete") {
      // Restore deleted entities
      ents.push(...(act.entities ?? []));
      if (layoutI < 0) modelEnts.push(...(act.entities ?? []));
      redoStack.push(act);
    } else if (act.type === "modify") {
      const before = act.before ?? [];
      const after = act.after ?? [];
      for (let i = 0; i < after.length; i++) replaceEntity(after[i], before[i]);
      if (layoutI < 0) modelEnts = ents;
      redoStack.push(act);
    } else if (act.type === "replace") {
      // N→M replacement (TRIM / BREAK / EXPLODE / JOIN / FILLET / CHAMFER):
      // drop the after-entities, restore the before-entities.
      const afterSet = new Set(act.after ?? []);
      const restored = act.before ?? [];
      const kept = ents.filter((e) => !afterSet.has(e));
      kept.push(...restored);
      ents = kept;
      if (layoutI < 0) modelEnts = ents;
      redoStack.push(act);
    }
    rebuildIndex();
    showProps();
    draw();
    logCmd("Command: UNDO");
  }

  function redo(): void {
    const act = redoStack.pop();
    if (!act) {
      logCmd("Nothing to redo.");
      return;
    }
    if (act.type === "add") {
      ents.push(...(act.entities ?? []));
      if (layoutI < 0) modelEnts.push(...(act.entities ?? []));
      undoStack.push(act);
      markDirty();
    } else if (act.type === "delete") {
      const delSet = new Set(act.entities ?? []);
      ents = ents.filter((e) => !delSet.has(e));
      if (layoutI < 0) modelEnts = ents;
      undoStack.push(act);
      markDirty();
    } else if (act.type === "modify") {
      const before = act.before ?? [];
      const after = act.after ?? [];
      for (let i = 0; i < before.length; i++) replaceEntity(before[i], after[i]);
      if (layoutI < 0) modelEnts = ents;
      undoStack.push(act);
      markDirty();
    } else if (act.type === "replace") {
      const beforeSet = new Set(act.before ?? []);
      const produced = act.after ?? [];
      const kept = ents.filter((e) => !beforeSet.has(e));
      kept.push(...produced);
      ents = kept;
      if (layoutI < 0) modelEnts = ents;
      undoStack.push(act);
      markDirty();
    }
    rebuildIndex();
    showProps();
    draw();
    logCmd("Command: REDO");
  }

  /* ── drawing workspace Modify Engine (MOVE / COPY / ROTATE / MIRROR / SCALE / OFFSET) ── */
  type ModKind = "move" | "copy" | "paste" | "rotate" | "mirror" | "scale";
  type ModStage = "select" | "base" | "second" | "eraseAsk";
  type OffStage = "dist" | "dist2" | "pickObj" | "pickSide";
  interface ModOp {
    kind: ModKind;
    stage: ModStage;
    ghostOf: number[]; // entity indices captured when the op started
    base: M.Pt | null;
    ref: M.Pt | null; // SCALE: cursor position when the factor prompt became active (factor 1.0)
    /** PASTE: clipboard entities being placed (not yet in `ents`). */
    pasteSrc?: DxfEntity[];
    /** PASTE: style carry-over already applied to the target document? */
    carried?: boolean;
    /** PASTE: total entities placed across all clicks in this session. */
    placedCount?: number;
    /** Command name shown in the log (PASTECLIP, INSERT, SVGIMPORT, FIELD). */
    placeLabel?: string;
  }
  /** Entities queued by INSERT / SVGIMPORT / FIELD for the ghost-placement session. */
  let pendingPlacement: { entities: DxfEntity[]; base: { x: number; y: number }; label: string } | null = null;
  let mod: ModOp | null = null;
  let modGhost: DxfEntity[] | null = null;
  let offStage: OffStage = "dist";
  let offDist: number | null = null;
  let offPick: M.Pt | null = null;
  let offTarget = -1;
  let pendingNumeric: ((v: number) => void) | null = null;
  let pendingYesNo: ((yes: boolean) => void) | null = null;
  /** DDEDIT / MLEADER: the next command-line entry is annotation text, not a command. */
  let pendingText: ((s: string) => void) | null = null;
  /** LAYISO snapshot — the hidden set before isolation (LAYUNISO restores it). */
  let preIsoHidden: string[] | null = null;

  /* ── drawing workspace grip editing: select → drag blue hotspots (endpoints, vertices, centers) ── */
  interface GripDrag {
    i: number; // entity index in ents
    gi: number; // grip index in entityGrips(e)
    orig: DxfEntity; // untouched pre-drag object (undo "before")
    startW: M.Pt; // world point where the drag started (Shift axis lock)
    moved: boolean;
  }
  let gripDrag: GripDrag | null = null;
  let gripHover: { i: number; gi: number } | null = null;

  /** Screen-space hit-test on the grips of the current selection (≤ 400 grips, drawing workspace behaviour). */
  function gripAt(sp: { x: number; y: number }): { i: number; gi: number } | null {
    if (!sel.size || sel.size > 128) return null;
    let budget = 400;
    for (const i of sel) {
      const e = ents[i];
      if (!e || !visible(e)) continue;
      const grips = M.entityGrips(e);
      for (let gi = 0; gi < grips.length && budget > 0; gi++, budget--) {
        const g = grips[gi];
        const s = M.worldToScreen(view, g.x, g.y);
        if (Math.abs(s.x - sp.x) <= 6 && Math.abs(s.y - sp.y) <= 6) return { i, gi };
      }
      if (budget <= 0) return null;
    }
    return null;
  }

  const isModTool = (t: Tool): t is ModKind =>
    t === "move" || t === "copy" || t === "paste" || t === "rotate" || t === "mirror" || t === "scale";

  /** Clears modify/offset interaction state (no tool change, no logging). */
  function clearModState(): void {
    mod = null;
    modGhost = null;
    offStage = "dist";
    offPick = null;
    offTarget = -1;
    pendingNumeric = null;
    pendingYesNo = null;
    pendingText = null;
  }

  const modTargets = (): DxfEntity[] =>
    mod
      ? mod.kind === "paste"
        ? mod.pasteSrc ?? []
        : mod.ghostOf
            .map((i) => ents[i])
            .filter((e): e is DxfEntity => !!e)
      : [];

  function modPrompt(): string {
    if (!mod) return "";
    switch (mod.stage) {
      case "select":
        return "Select objects: (click to add · Enter / right-click to finish)";
      case "base":
        return mod.kind === "mirror" ? "Specify first point of mirror line:" : "Specify base point:";
      case "eraseAsk":
        return "Erase source objects? [Yes/No] <N>:";
      case "second":
        switch (mod.kind) {
          case "move":
            return "Specify second point or <use first point as displacement>:";
          case "copy":
            return "Specify second point or [Exit]:";
          case "paste":
            return "Click to place the pasted objects — click again for another copy, Enter / Esc to finish:";
          case "rotate":
            return "Specify rotation angle:";
          case "mirror":
            return "Specify second point of mirror line:";
          case "scale":
            return "Specify scale factor:";
        }
    }
  }

  /** Batched add: pushes all entities with a single undo action. */
  function addEntities(list: DxfEntity[]): void {
    if (!list.length) return;
    for (const e of list) ents.push(e);
    if (modelEnts !== ents) for (const e of list) modelEnts.push(e);
    let b: M.BBox | null = null;
    for (const e of list) b = b ? M.unionBBox(b, M.entityBBox(e)) : M.entityBBox(e);
    if (b) bounds = M.unionBBox(bounds ?? b, b);
    idx = M.buildIndex(ents, bounds ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    undoStack.push({ type: "add", entities: list });
    markDirty();
    redoStack.length = 0;
    showProps();
  }

  /** In-place transform commit with a single modify undo action. */
  function commitModify(before: DxfEntity[], after: DxfEntity[]): void {
    if (before.some((e) => fixedEnts.has(e))) {
      logCmd("CONSTRAINT: a fixed object is in the selection (FIX). Run UNFIX on it to allow edits.");
      return;
    }
    for (let i = 0; i < before.length; i++) replaceEntity(before[i], after[i]);
    undoStack.push({ type: "modify", before, after });
    markDirty();
    redoStack.length = 0;
    rebuildIndex();
    // Keep the transformed objects selected, like drawing workspace grips.
    sel.clear();
    for (const e of after) {
      const i = ents.indexOf(e);
      if (i >= 0) sel.add(i);
    }
    selected = sel.size ? [...sel][sel.size - 1] : -1;
    showProps();
  }

  /** N→M replacement commit (TRIM / BREAK / EXPLODE / JOIN / FILLET / CHAMFER / AUDIT). */
  function commitReplace(before: DxfEntity[], after: DxfEntity[]): void {
    if (!before.length) return;
    if (before.some((e) => fixedEnts.has(e))) {
      logCmd("CONSTRAINT: a fixed object is in the selection (FIX). Run UNFIX on it to allow edits.");
      return;
    }
    const beforeSet = new Set(before);
    const kept = ents.filter((e) => !beforeSet.has(e));
    kept.push(...after);
    ents = kept;
    if (layoutI < 0) modelEnts = ents;
    undoStack.push({ type: "replace", before, after });
    markDirty();
    redoStack.length = 0;
    rebuildIndex();
    sel.clear();
    for (const e of after) {
      const i = ents.indexOf(e);
      if (i >= 0) sel.add(i);
    }
    selected = sel.size ? [...sel][sel.size - 1] : -1;
    showProps();
  }

  function applyMove(dp: M.Pt): void {
    if (!mod) return;
    const before = modTargets();
    if (!before.length) return;
    commitModify(before, before.map((e) => X.translateEnt(e, dp.x, dp.y)));
    logCmd(`MOVE: ${before.length} object(s) moved by ${fmt(Math.hypot(dp.x, dp.y))}`);
  }

  function placeCopy(dp: M.Pt): void {
    if (!mod) return;
    const src = modTargets();
    if (!src.length) return;
    addEntities(src.map((e) => X.translateEnt(e, dp.x, dp.y)));
    logCmd(`COPY: ${src.length} object(s) copied by ${fmt(Math.hypot(dp.x, dp.y))}`);
  }

  function applyRotate(angleDeg: number): void {
    if (!mod || !mod.base) return;
    const before = modTargets();
    if (!before.length) return;
    commitModify(before, before.map((e) => X.rotateEnt(e, mod!.base!.x, mod!.base!.y, angleDeg)));
    logCmd(`ROTATE: ${before.length} object(s) rotated ${angleDeg.toFixed(2)}°`);
  }

  function applyScale(k: number): void {
    if (!mod || !mod.base) return;
    if (!Number.isFinite(k) || k <= 0) {
      logCmd("Scale factor must be greater than zero.");
      return;
    }
    const before = modTargets();
    if (!before.length) return;
    commitModify(before, before.map((e) => X.scaleEnt(e, mod!.base!.x, mod!.base!.y, k)));
    logCmd(`SCALE: ${before.length} object(s) scaled ×${k.toFixed(4)}`);
  }

  function finishMirrorAxis(p2: M.Pt): void {
    if (!mod || !mod.base) return;
    const src = modTargets();
    if (!src.length) return;
    const copies = src.map((e) => X.mirrorEnt(e, mod!.base!, p2));
    addEntities(copies);
    logCmd(`MIRROR: ${src.length} mirrored object(s) created.`);
    mod.stage = "eraseAsk";
    modGhost = null;
    logCmd("Erase source objects? [Yes/No] <N>: (type Y or N, Enter = No)");
    pendingYesNo = (yes) => {
      pendingYesNo = null;
      if (yes) {
        const doomed = modTargets();
        const keep = ents.filter((e) => !doomed.includes(e));
        undoStack.push({ type: "delete", entities: doomed });
        markDirty();
        redoStack.length = 0;
        ents = keep;
        if (layoutI < 0) modelEnts = keep;
        sel.clear();
        selected = -1;
        rebuildIndex();
        showProps();
        logCmd(`MIRROR: ${doomed.length} source object(s) erased.`);
      }
      const kind = mod?.kind;
      clearModState();
      setTool("select");
      draw();
      if (kind) logCmd("Command: _MIRROR completed");
    };
  }

  /** Live preview ghost for the active modify operation. */
  function updateModGhost(cur: M.Pt): void {
    if (!mod || !mod.base || mod.stage !== "second") {
      if (mod?.stage === "eraseAsk") modGhost = null;
      return;
    }
    const src = modTargets();
    const b = mod.base;
    switch (mod.kind) {
      case "move":
      case "copy":
      case "paste":
        modGhost = src.map((e) => X.translateEnt(e, cur.x - b.x, cur.y - b.y));
        break;
      case "rotate":
        modGhost = src.map((e) => X.rotateEnt(e, b.x, b.y, M.norm360Deg(b, cur)));
        break;
      case "mirror":
        modGhost = src.map((e) => X.mirrorEnt(e, b, cur));
        break;
      case "scale": {
        const refD = mod.ref ? Math.max(1e-9, Math.hypot(mod.ref.x - b.x, mod.ref.y - b.y)) : 1;
        const k = Math.hypot(cur.x - b.x, cur.y - b.y) / refD;
        modGhost = src.map((e) => X.scaleEnt(e, b.x, b.y, k));
        break;
      }
    }
  }

  /** Enter / right-click during a modify op. */
  function confirmModStep(): void {
    if (!mod) return;
    if (mod.stage === "select") {
      if (!sel.size) {
        logCmd("0 found");
        return;
      }
      mod.ghostOf = [...sel];
      mod.stage = "base";
      logCmd(`${sel.size} found`);
      logCmd(modPrompt());
    } else if (mod.stage === "second" && (mod.kind === "copy" || mod.kind === "paste")) {
      const wasPaste = mod.kind === "paste";
      const placedCount = wasPaste ? mod.placedCount ?? 0 : 0;
      const placeLabel = mod.placeLabel ?? "PASTECLIP";
      const kind = mod.kind;
      clearModState();
      setTool("select");
      logCmd(`Command: _${wasPaste ? `${placeLabel} completed (${placedCount} object(s) placed)` : kind === "copy" ? "COPY completed" : kind.toUpperCase() + " completed"}`);
      draw();
    } else if (mod.stage === "eraseAsk") {
      const f = pendingYesNo;
      pendingYesNo = null;
      f?.(false);
    }
  }

  /** Cancels the active modify / offset operation (Esc). */
  function cancelModOp(): void {
    const had = !!mod || isModTool(tool) || tool === "offset";
    clearModState();
    if (had) {
      setTool("select");
      logCmd("*Cancel*");
      draw();
    }
  }

  /* ── Cutting / staged pick tools (TRIM / EXTEND / BREAK / FILLET / CHAMFER /
     JOIN / STRETCH / ALIGN / MATCHLAYER) ── */
  type PickKind = "trim" | "extend" | "break" | "fillet" | "chamfer" | "join" | "stretch" | "align" | "matchlayer" | "lengthen" | "divide" | "measure" | "ddedit" | "layiso" | "layoff" | "laylck" | "layunlck" | "mleader" | "con2p" | "confix" | "txt2mtxt" | "explodetext" | "textfit" | "arctext" | "textmask" | "breakline" | "laymrg" | "laydel";
  interface PickOp {
    kind: PickKind;
    stage: "edges" | "targets" | "obj" | "p1" | "p2" | "win1" | "win2" | "base" | "second" | "src1" | "src2" | "dst1" | "dst2" | "newend" | "landing";
    edges: number[]; // cutting edges / boundary entities / join members
    obj: number; // BREAK: picked entity
    p1: M.Pt | null;
    win: { a: M.Pt; b: M.Pt } | null;
    base: M.Pt | null;
    src: [M.Pt, M.Pt] | null; // ALIGN source axis
    dst: [M.Pt, M.Pt] | null; // ALIGN destination axis
    srcLayer: string; // MATCHLAYER source layer
    /** LENGTHEN: which end the user grabbed (projection of the first pick). */
    nearEnd: "start" | "end";
    /** LENGTHEN: preset mode — "dyn" (default, two clicks) / "total" / "delta". */
    lenMode: "dyn" | "total" | "delta";
    /** LENGTHEN: preset length for total / delta modes. */
    lenVal: number;
    /** LENGTHEN dynamic: live ghost of the lengthened entity. */
    ghost: DxfEntity | null;
    /** MLEADER: landing end point (text goes there). */
    landing: M.Pt | null;
    /** CONSTRAINT: which one-shot constraint is being applied (see startConstraint). */
    con: string;
    /** CONSTRAINT: first picked entity (source of the relation). */
    conSrc: number;
  }
  let pick: PickOp | null = null;
  let filletR = 10;
  let chamferD = [5, 5];
  let polySides = 6;
  let tableDims = { rows: 3, cols: 4 };
  /** Named views: name → view snapshot (VIEW S / VIEW R). */
  const namedViews = new Map<string, M.View>();
  /** Layer state snapshots: name → off/frozen layer names (LAYERSTATE S / R). */
  const layerStates = new Map<string, { off: string[]; frozen: string[] }>();

  const isPickTool = (t: Tool): t is PickKind =>
    t === "trim" || t === "extend" || t === "break" || t === "fillet" || t === "chamfer" ||
    t === "join" || t === "stretch" || t === "align" || t === "matchlayer" ||
    t === "lengthen" || t === "divide" || t === "measure" || t === "ddedit" ||
    t === "layiso" || t === "layoff" || t === "laylck" || t === "layunlck" || t === "mleader" ||
    t === "con2p" || t === "confix" || t === "txt2mtxt" || t === "explodetext" || t === "textfit" ||
    t === "arctext" || t === "textmask" || t === "breakline" || t === "laymrg" || t === "laydel";

  function clearPickState(): void {
    pick = null;
    pendingNumeric = null;
    pendingText = null;
  }

  function pickPrompt(): string {
    if (!pick) return "";
    switch (pick.kind) {
      case "trim":
        return pick.stage === "edges" ? "Select cutting edges: (click · Enter / right-click to cut)" : "Select object to trim:";
      case "extend":
        return pick.stage === "edges" ? "Select boundary edges: (click · Enter / right-click to extend)" : "Select object to extend:";
      case "break":
        return pick.stage === "obj" ? "Select object:" : "Specify second break point:";
      case "fillet":
        return "Select first object:";
      case "chamfer":
        return "Select first line:";
      case "join":
        return "Select objects to join: (click · Enter / right-click to join)";
      case "stretch":
        return pick.stage === "win1" ? "Specify first corner of crossing window:" : pick.stage === "win2" ? "Specify opposite corner:" : pick.stage === "base" ? "Specify base point:" : "Specify second point:";
      case "align":
        return pick.stage === "src1" ? "Specify first source point:" : pick.stage === "src2" ? "Specify second source point:" : pick.stage === "dst1" ? "Specify first destination point:" : "Specify second destination point:";
      case "matchlayer":
        return pick.stage === "edges" ? "Select the source object:" : "Select destination objects: (Esc to finish)";
      case "lengthen":
        return pick.stage === "obj"
          ? pick.lenMode === "dyn"
            ? "Select an object or specify total length: (click near the end to stretch)"
            : "Select an object to lengthen:"
          : "Specify new end point (stretches along the object's direction):";
      case "divide":
        return "Select a line, arc or polyline to divide:";
      case "measure":
        return "Select a line, arc or polyline to measure:";
      case "ddedit":
        return "Select a text object to edit:";
      case "layiso":
      case "layoff":
      case "laylck":
      case "layunlck":
        return "Select an object on the target layer:";
      case "mleader":
        return pick.stage === "obj" ? "Specify leader arrowhead location:" : pick.stage === "landing" ? "Specify leader landing end:" : "Enter leader text: (type in the command line, empty Enter = cancel)";
      case "con2p":
        return pick.stage === "obj"
          ? pick.con === "dcradius" || pick.con === "dcdiameter"
            ? "Select a circle or arc:"
            : pick.con === "dclinear"
              ? "Select a line to dimension:"
              : "Select first object:"
          : "Select second object:";
      case "confix":
        return "Select objects to fix / unfix:";
      case "txt2mtxt":
        return "Select single-line text objects: (click · Enter / right-click to end)";
      case "explodetext":
        return "Select MTEXT objects to explode:";
      case "textmask":
        return "Select text objects to toggle the mask:";
      case "laymrg":
        return pick.stage === "obj" ? "Select the source object (its layer is merged away):" : "Select an object on the destination layer:";
      case "laydel":
        return "Select an object on the layer to delete:";
      case "textfit":
        return pick.stage === "obj" ? "Select a text object to fit:" : "Specify the end point the text should span to:";
      case "arctext":
        return "Select an arc or circle for the text to follow:";
      case "breakline":
        return pick.stage === "p1" ? "Specify first point of the break line:" : "Specify second point:";
    }
  }

  function startPick(kind: PickKind): void {
    clearModState();
    const twoStage = kind === "trim" || kind === "extend" || kind === "matchlayer" || kind === "laymrg";
    const firstStage: PickOp["stage"] =
      twoStage ? "edges"
      : kind === "break" || kind === "textfit" || kind === "arctext" ? "obj"
      : kind === "stretch" ? "win1"
      : kind === "align" ? "src1"
      : kind === "mleader" || kind === "con2p" ? "obj"
      : kind === "breakline" ? "p1"
      : "targets";
    pick = {
      kind,
      stage: firstStage,
      edges: [],
      obj: -1,
      p1: null,
      win: null,
      base: null,
      src: null,
      dst: null,
      srcLayer: "",
      nearEnd: "end",
      lenMode: "dyn",
      lenVal: 0,
      ghost: null,
      landing: null,
      con: "",
      conSrc: -1,
    };
    // laymrg reuses the "edges" stage for the source-layer pick
    if (kind === "laymrg") pick.stage = "obj";
    if (kind === "fillet") logCmd(`Current fillet radius = ${fmt(filletR)} (FILLET R <value> to change)`);
    if (kind === "chamfer") logCmd(`Current chamfer distances = ${fmt(chamferD[0])} and ${fmt(chamferD[1])} (CHAMFER <d1> <d2> to change)`);
    logCmd(pickPrompt());
  }

  /** Arm a one-shot parametric constraint (Parametric tab + command line). */
  function startConstraint(con: string): void {
    setTool("con2p");
    if (pick) {
      pick.con = con;
      logCmd(pickPrompt());
    }
  }

  /* ── Parametric / Express / Collaborate command bodies (shared by the
     ribbon buttons and the command-line dispatcher) ── */
  function runAutoConstrain(): void {
    if (!ents.length) {
      logCmd("AUTOCONSTRAIN: the drawing is empty.");
      return;
    }
    const before = [...ents];
    const res = P.autoConstrain(before, (10 / view.scale) * 2);
    if (!res.fixed) {
      logCmd("AUTOCONSTRAIN: no near-miss relations found within tolerance.");
      return;
    }
    commitReplace(before, res.entities);
    logCmd(`AUTOCONSTRAIN: ${res.fixed} constraint(s) applied within tolerance.`);
    for (const a of res.applied.slice(0, 6)) logCmd(`  · ${a}`);
    if (res.applied.length > 6) logCmd(`  … +${res.applied.length - 6} more`);
    draw();
  }
  function toggleConBar(): void {
    conBarOn = !conBarOn;
    logCmd(`CONSTRAINTBAR: ${conBarOn ? "on — FIX markers shown" : "off"}`);
    draw();
  }
  function unfixAll(): void {
    const n = fixedEnts.size;
    fixedEnts.clear();
    logCmd(`DELCONSTRAINT: removed FIX from ${n} object(s).`);
    draw();
  }
  function runFlatten(): void {
    if (!ents.length) {
      logCmd("FLATTEN: the drawing is empty.");
      return;
    }
    const before = [...ents];
    const after = before.map((e) => P.flattenEnt(e) ?? e);
    const n = after.filter((e, i) => e !== before[i]).length;
    if (!n) {
      logCmd("FLATTEN: everything is already at Z = 0.");
      return;
    }
    commitReplace(before, after);
    logCmd(`FLATTEN: ${n} object(s) moved to Z = 0 (Elevation 0).`);
    draw();
  }
  function runLayFrz(): void {
    if (!doc || !sel.size) {
      logCmd("LAYFRZ: select object(s) first, then run LAYFRZ to freeze their layers.");
      return;
    }
    const names = new Set([...sel].map((i) => ents[i]?.layer).filter((n): n is string => !!n));
    for (const l of doc.layers) if (names.has(l.name)) l.frozen = true;
    for (const n of names) hidden.add(n);
    logCmd(`LAYFRZ: froze ${names.size} layer(s): ${[...names].join(", ")}`);
    draw();
  }
  function runLayThw(): void {
    if (!doc) return;
    let n = 0;
    for (const l of doc.layers) if (l.frozen) { l.frozen = false; n++; }
    if (n) {
      hidden.clear();
      for (const l of doc.layers) if (l.off) hidden.add(l.name);
    }
    logCmd(`LAYTHW: thawed ${n} layer(s).`);
    draw();
  }
  function publishAll(): void {
    const all = [...ribbonEngines.keys()];
    if (!all.length) {
      logCmd("PUBLISH: no open drawings.");
      return;
    }
    let n = 0;
    for (const eng of all) {
      try {
        if (eng.isDirty()) {
          eng.saveDwg();
          n++;
        }
      } catch { /* a drawing that cannot save is skipped */ }
    }
    logCmd(`PUBLISH: ${n} of ${all.length} open drawing(s) written to DWG${n < all.length ? " (clean drawings skipped)" : ""}.`);
  }
  function shareView(): void {
    cv.toBlob((blob) => {
      if (blob) download(blob, `${name || "drawing"}-view.png`);
    }, "image/png");
    logCmd("SHAREVIEW: current view exported as PNG — attach it to your CDE share or email.");
  }

  const pickTargets = (): DxfEntity[] => (pick?.edges ?? []).map((i) => ents[i]).filter((e): e is DxfEntity => !!e);

  /** First/last point of the drawable span of a LINEAR entity (LENGTHEN end detection). */
  function spanEnd(e: DxfEntity, isStart: boolean): M.Pt | null {
    switch (e.type) {
      case "LINE":
        return isStart ? e.start : e.end;
      case "ARC": {
        const a = isStart ? e.startAngle : e.endAngle;
        return { x: e.center.x + e.radius * Math.cos((a * Math.PI) / 180), y: e.center.y + e.radius * Math.sin((a * Math.PI) / 180) };
      }
      case "LWPOLYLINE":
        return e.closed || !e.points.length ? null : isStart ? e.points[0] : e.points[e.points.length - 1];
      default:
        return null;
    }
  }

  /** Commits the staged FILLET / CHAMFER between two picked LINE entities. */
  function commitFilletChamfer(a: DxfEntity, b: DxfEntity): void {
    if (!pick) return;
    if (a.type !== "LINE" || b.type !== "LINE") {
      logCmd("FILLET / CHAMFER supports two LINE entities.");
      pick.stage = "targets";
      pick.edges = [];
      logCmd(pickPrompt());
      return;
    }
    if (pick.kind === "fillet") {
      const r = X.filletTwoLines(a, b, filletR);
      if (!r) {
        logCmd("Fillet radius is too large for those lines.");
        pick.stage = "targets";
        pick.edges = [];
        logCmd(pickPrompt());
        return;
      }
      commitReplace([a, b], [...r.lines, r.arc]);
      logCmd(`FILLET: R = ${fmt(filletR)} — 2 line(s) trimmed, 1 arc added.`);
    } else {
      const c = X.chamferTwoLines(a, b, chamferD[0], chamferD[1]);
      if (!c) {
        logCmd("Chamfer distances are too large for those lines.");
        pick.stage = "targets";
        pick.edges = [];
        logCmd(pickPrompt());
        return;
      }
      commitReplace([a, b], [...c.lines, c.bar]);
      logCmd(`CHAMFER: ${fmt(chamferD[0])} × ${fmt(chamferD[1])} — 2 line(s) trimmed, 1 bevel added.`);
    }
    clearPickState();
    setTool("select");
    draw();
  }

  /** Central staged-pick pointer-down handler. Returns true when consumed. */
  function onPickClick(wp: M.Pt): boolean {
    if (!pick) return false;
    const hit = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, visible) : -1;
    const eps = 10 / view.scale;

    switch (pick.kind) {
      case "trim":
      case "extend": {
        if (pick.stage === "edges") {
          if (hit < 0) {
            logCmd("0 found");
            return true;
          }
          if (!pick.edges.includes(hit)) pick.edges.push(hit);
          setSel([hit], true);
          logCmd(`1 found (${pick.edges.length} total)`);
          return true;
        }
        if (hit < 0) {
          logCmd("0 found");
          return true;
        }
        const e = ents[hit];
        const cutters = pickTargets().filter((c) => c !== e);
        if (pick.kind === "trim") {
          const pieces = X.trimEntity(e, wp, cutters, eps);
          if (!pieces.length) logCmd("Object cannot be trimmed — no cutting edge crosses it.");
          else {
            commitReplace([e], pieces);
            logCmd(`TRIM: ${pieces.length} piece(s) kept.`);
          }
        } else {
          const out = X.extendEntity(e, wp, cutters, eps);
          if (!out) logCmd("Object cannot be extended to those boundaries.");
          else {
            commitReplace([e], [out]);
            logCmd("EXTEND: endpoint stretched to the boundary.");
          }
        }
        return true;
      }
      case "break": {
        if (pick.stage === "obj") {
          if (hit < 0) {
            logCmd("0 found");
            return true;
          }
          pick.obj = hit;
          pick.p1 = { x: wp.x, y: wp.y };
          setSel([hit]);
          pick.stage = "p2";
          logCmd("Specify second break point:");
          return true;
        }
        const e = ents[pick.obj];
        if (!e || !pick.p1) return true;
        const pieces = X.breakEntity(e, pick.p1, wp);
        if (!pieces) logCmd("Nothing to break between those points.");
        else {
          commitReplace([e], pieces);
          logCmd(`BREAK: ${pieces.length} piece(s) kept.`);
        }
        clearPickState();
        setTool("select");
        draw();
        return true;
      }
      case "fillet":
      case "chamfer": {
        if (hit < 0) {
          logCmd("0 found");
          return true;
        }
        pick.edges.push(hit);
        setSel([hit], true);
        if (pick.edges.length === 1) {
          pick.stage = "targets";
          logCmd("Select second line:");
        } else commitFilletChamfer(ents[pick.edges[0]], ents[pick.edges[1]]);
        return true;
      }
      case "join": {
        if (hit < 0) {
          logCmd("0 found");
          return true;
        }
        if (!pick.edges.includes(hit)) {
          pick.edges.push(hit);
          setSel([hit], true);
          logCmd(`1 found (${pick.edges.length} total)`);
        }
        return true;
      }
      case "stretch": {
        switch (pick.stage) {
          case "win1":
            pick.win = { a: { x: wp.x, y: wp.y }, b: wp };
            pick.stage = "win2";
            logCmd(pickPrompt());
            return true;
          case "win2": {
            if (!pick.win) return true;
            const a = pick.win.a;
            const rect = M.rectOf(a, wp);
            if (idx) {
              const crossing = M.selectInRect(idx, ents, rect, "crossing", visible);
              pick.edges = crossing;
              setSel(crossing);
              logCmd(`${crossing.length} object(s) cross the window.`);
            }
            pick.win = { a: rect.minX === a.x && rect.minY === a.y ? a : a, b: wp };
            // remember the window rect corners for the vertex test
            (pick as PickOp & { rect?: { minX: number; minY: number; maxX: number; maxY: number } }).rect = rect;
            pick.base = { x: wp.x, y: wp.y };
            pick.stage = "base";
            logCmd(pickPrompt());
            return true;
          }
          case "base":
            pick.base = { x: wp.x, y: wp.y };
            pick.stage = "second";
            logCmd(pickPrompt());
            return true;
          case "second": {
            if (!pick.base) return true;
            const dp = { x: wp.x - pick.base.x, y: wp.y - pick.base.y };
            const rect = (pick as PickOp & { rect?: { minX: number; minY: number; maxX: number; maxY: number } }).rect;
            const before = pickTargets();
            if (before.length && rect) {
              const after = X.stretchEnts(before, rect, dp);
              commitModify(before, after);
              logCmd(`STRETCH: ${before.length} object(s) stretched by ${fmt(Math.hypot(dp.x, dp.y))}`);
            }
            clearPickState();
            setTool("select");
            draw();
            return true;
          }
          default:
            return true;
        }
      }
      case "align": {
        const pt = { x: wp.x, y: wp.y };
        if (pick.stage === "src1") {
          pick.src = [pt, pt];
          pick.stage = "src2";
        } else if (pick.stage === "src2") {
          pick.src![1] = pt;
          pick.stage = "dst1";
        } else if (pick.stage === "dst1") {
          pick.dst = [pt, pt];
          pick.stage = "dst2";
        } else if (pick.stage === "dst2") {
          pick.dst![1] = pt;
          if (!sel.size) logCmd("ALIGN: select objects first, then run ALIGN.");
          else if (pick.src && pick.dst) {
            const before = [...sel].map((i) => ents[i]).filter((e): e is DxfEntity => !!e);
            const ang = M.norm360Deg(pick.dst[0], pick.dst[1]) - M.norm360Deg(pick.src[0], pick.src[1]);
            const d1 = pick.dst[0],
              s1 = pick.src[0];
            const after = before.map((e) => X.translateEnt(X.rotateEnt(e, s1.x, s1.y, ang), d1.x - s1.x, d1.y - s1.y));
            commitModify(before, after);
            logCmd(`ALIGN: ${before.length} object(s) aligned (move + rotate).`);
          }
          clearPickState();
          setTool("select");
          draw();
        }
        return true;
      }
      case "matchlayer": {
        if (pick.stage === "edges") {
          if (hit < 0) {
            logCmd("0 found");
            return true;
          }
          pick.srcLayer = ents[hit].layer;
          pick.stage = "targets";
          logCmd(`Source layer: ${pick.srcLayer}. ${pickPrompt()}`);
          return true;
        }
        if (hit < 0 || ents[hit].layer === pick.srcLayer) return true;
        const e = ents[hit];
        commitReplace([e], [{ ...e, layer: pick.srcLayer }]);
        logCmd(`MATCHLAYER: moved to ${pick.srcLayer}.`);
        return true;
      }
      case "lengthen": {
        const supported = (e: DxfEntity | undefined): boolean => !!e && (e.type === "LINE" || e.type === "ARC" || (e.type === "LWPOLYLINE" && !e.closed && !e.hatch && e.points.length >= 2));
        if (pick.stage === "obj") {
          if (hit < 0 || !supported(ents[hit])) {
            logCmd(hit < 0 ? "0 found" : "LENGTHEN: pick a LINE, ARC or open polyline.");
            return true;
          }
          pick.obj = hit;
          const e = ents[hit];
          // Which end did the user click near? Compare distance to each span end.
          const a = spanEnd(e, true),
            b = spanEnd(e, false);
          pick.nearEnd = a && b && Math.hypot(wp.x - a.x, wp.y - a.y) < Math.hypot(wp.x - b.x, wp.y - b.y) ? "start" : "end";
          if (pick.lenMode === "dyn") {
            pick.stage = "newend";
            logCmd(pickPrompt());
          } else {
            const after = pick.lenMode === "total"
              ? X.lengthenTotal(e, pick.nearEnd, pick.lenVal)
              : X.lengthenTotal(e, pick.nearEnd, Math.max(1e-9, X.entitySpanLength(e) + pick.lenVal));
            if (!after) logCmd("LENGTHEN: cannot apply that length to this object.");
            else {
              commitModify([e], [after]);
              logCmd(`LENGTHEN ${pick.lenMode === "total" ? "total" : "delta"} = ${fmt(pick.lenVal)}: new length = ${fmt(X.entitySpanLength(after))}.`);
            }
            clearPickState();
            setTool("select");
            draw();
          }
          return true;
        }
        // stage "newend": dynamic stretch — the click point projected onto the end tangent.
        const e = ents[pick.obj];
        if (!e || !supported(e)) return true;
        const s2 = snapped(wp);
        const after = X.lengthenTo(e, pick.nearEnd, s2 ? { x: s2.x, y: s2.y } : wp);
        if (!after) return true;
        commitModify([e], [after]);
        logCmd(`LENGTHEN: new length = ${fmt(X.entitySpanLength(after))}.`);
        clearPickState();
        setTool("select");
        draw();
        return true;
      }
      case "divide":
      case "measure": {
        if (hit < 0) {
          logCmd("0 found");
          return true;
        }
        const e = ents[hit];
        if (e.type !== "LINE" && e.type !== "ARC" && !(e.type === "LWPOLYLINE" && !e.closed && !e.hatch && e.points.length >= 2)) {
          logCmd(`${pick.kind === "divide" ? "DIVIDE" : "MEASURE"}: pick a LINE, ARC or open polyline.`);
          return true;
        }
        pick.obj = hit;
        setSel([hit]);
        const ask = pick.kind === "divide" ? "Enter the number of segments:" : "Specify length of segments:";
        logCmd(ask);
        pendingNumeric = (v) => {
          pendingNumeric = null;
          if (!pick || (pick.kind !== "divide" && pick.kind !== "measure")) return;
          const ent = ents[pick.obj];
          if (!ent) return;
          const pts2 = pick.kind === "divide" ? X.divPoints(ent, Math.round(v)) : X.measPoints(ent, v);
          if (!pts2.length) {
            logCmd(pick.kind === "divide" ? `DIVIDE: ${Math.round(v)} segment(s) do not fit.` : "MEASURE: that spacing does not fit on the object.");
          } else {
            const list: DxfEntity[] = pts2.map((q) => ({ type: "POINT", layer: currentLayer, ...newObjectProps(), position: { x: q.x, y: q.y } }));
            addEntities(list);
            logCmd(`${pick.kind === "divide" ? "DIVIDE" : "MEASURE"}: ${list.length} point(s) placed on ${currentLayer}.`);
          }
          clearPickState();
          setTool("select");
          draw();
        };
        return true;
      }
      case "ddedit": {
        if (hit < 0) {
          logCmd("0 found");
          return true;
        }
        const e = ents[hit];
        if (e.type !== "TEXT") {
          logCmd("DDEDIT: pick a TEXT / MTEXT object.");
          return true;
        }
        pick.obj = hit;
        setSel([hit]);
        logCmd(`Current text: ${e.value}`);
        logCmd("Enter new text: (empty Enter keeps the existing text, Esc cancels)");
        pendingText = (s) => {
          pendingText = null;
          const ent = ents[pick?.obj ?? -1];
          if (!ent || ent.type !== "TEXT" || !s) {
            logCmd("DDEDIT: text unchanged.");
          } else {
            commitModify([ent], [{ ...ent, value: s }]);
            logCmd("DDEDIT: text updated.");
          }
          clearPickState();
          setTool("select");
          draw();
        };
        return true;
      }
      case "layiso": {
        if (hit < 0) {
          logCmd("0 found");
          return true;
        }
        const layerName = ents[hit].layer;
        if (!preIsoHidden) preIsoHidden = [...hidden];
        hidden.clear();
        for (const l of doc?.layers ?? []) if (l.name !== layerName) hidden.add(l.name);
        logCmd(`LAYISO: layer "${layerName}" isolated — ${hidden.size} layer(s) hidden. LAYUNISO to restore.`);
        clearPickState();
        setTool("select");
        draw();
        return true;
      }
      case "layoff": {
        if (hit < 0) {
          logCmd("0 found");
          return true;
        }
        hidden.add(ents[hit].layer);
        logCmd(`LAYOFF: layer "${ents[hit].layer}" is now off.`);
        clearPickState();
        setTool("select");
        draw();
        return true;
      }
      case "laylck":
      case "layunlck": {
        if (hit < 0) {
          logCmd("0 found");
          return true;
        }
        const layerName = ents[hit].layer;
        const lyr = doc?.layers.find((l) => l.name === layerName);
        if (lyr) {
          lyr.locked = pick.kind === "laylck";
          logCmd(`${pick.kind === "laylck" ? "LAYLCK" : "LAYUNLCK"}: layer "${layerName}" is now ${lyr.locked ? "locked" : "unlocked"}.`);
        } else logCmd(`Layer "${layerName}" is not in the layer table.`);
        clearPickState();
        setTool("select");
        draw();
        return true;
      }
      case "mleader": {
        const pt = { x: wp.x, y: wp.y };
        if (pick.stage === "obj") {
          pick.p1 = pt;
          pick.stage = "landing";
          logCmd(pickPrompt());
          return true;
        }
        if (pick.stage === "landing") {
          if (!pick.p1) return true;
          pick.landing = pt;
          logCmd("Enter leader text: (type in the command line, empty Enter = cancel)");
          pendingText = (s) => {
            pendingText = null;
            const a = pick?.p1,
              b = pick?.landing;
            if (!a || !b) return;
            if (!s) {
              logCmd("MLEADER: cancelled (no text).");
            } else {
              const span = bounds ? Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) : 0;
              const h = span > 0 ? span / 100 : 2;
              addEntities([
                { type: "LINE", layer: currentLayer, ...newObjectProps(), start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y } },
                { type: "TEXT", layer: currentLayer, ...newObjectProps(), position: { x: b.x + h * 0.25, y: b.y + h * 0.25 }, height: h, value: s },
              ]);
              logCmd(`MLEADER: leader with text "${s}" added.`);
            }
            clearPickState();
            setTool("select");
            draw();
          };
          pick.stage = "obj";
          return true;
        }
        return true;
      }
      case "con2p": {
        // One-shot geometric constraints (Parametric tab). Single-pick fixes
        // apply immediately and stay armed; two-pick relations take a source
        // ("obj") and a destination ("targets") pick. Every application is a
        // real geometry edit through commitModify (undoable).
        const pk = pick;
        const twoPick =
          pk.con === "perpendicular" || pk.con === "parallel" || pk.con === "tangent" ||
          pk.con === "concentric" || pk.con === "coincident" || pk.con === "symmetric" ||
          pk.con === "equal" || pk.con === "dcangular";
        if (pk.stage === "obj") {
          if (hit < 0) {
            logCmd("0 found");
            return true;
          }
          const src = ents[hit];
          if (!src) return true;
          if (pk.con === "horizontal" || pk.con === "vertical") {
            const after = pk.con === "horizontal" ? P.fixHorizontal(src) : P.fixVertical(src);
            if (!after) {
              logCmd(`${pk.con.toUpperCase()}: pick a LINE.`);
              return true;
            }
            commitModify([src], [after]);
            logCmd(`${pk.con.toUpperCase()} constraint applied.`);
            draw();
            return true;
          }
          if (pk.con === "dcradius" || pk.con === "dcdiameter") {
            if (!P.isCircle(src) && !P.isArc(src)) {
              logCmd(`${pk.con.toUpperCase()}: pick a circle or arc.`);
              return true;
            }
            pk.conSrc = hit;
            logCmd(`Current ${pk.con === "dcradius" ? "radius" : "diameter"} = ${fmt(pk.con === "dcradius" ? src.radius : src.radius * 2)}. Enter value:`);
            pendingNumeric = (v) => {
              pendingNumeric = null;
              const e = ents[pk.conSrc];
              if (!e) return;
              const r = pk.con === "dcdiameter" ? v / 2 : v;
              const after = P.dimRadius(e, r);
              if (!after) {
                logCmd("DC: value must be positive.");
                return;
              }
              commitModify([e], [after]);
              logCmd(`${pk.con === "dcdiameter" ? "DCDIAMETER" : "DCRADIUS"}: ${pk.con === "dcdiameter" ? "diameter" : "radius"} set to ${fmt(v)}.`);
              draw();
            };
            return true;
          }
          if (pk.con === "dclinear") {
            if (!P.isLine(src)) {
              logCmd("DCLINEAR: pick a LINE.");
              return true;
            }
            pk.conSrc = hit;
            logCmd(`Current length = ${fmt(Math.hypot(src.end.x - src.start.x, src.end.y - src.start.y))}. Enter value:`);
            pendingNumeric = (v) => {
              pendingNumeric = null;
              const e = ents[pk.conSrc];
              if (!e) return;
              const after = P.dimLinear(e, v);
              if (!after) {
                logCmd("DCLINEAR: value must be positive.");
                return;
              }
              commitModify([e], [after]);
              logCmd(`DCLINEAR: length set to ${fmt(v)}.`);
              draw();
            };
            return true;
          }
          if (!twoPick) {
            logCmd(`CONSTRAINT: unknown constraint "${pk.con}".`);
            return true;
          }
          // two-pick relations: remember the source, arm the second stage
          pk.conSrc = hit;
          pk.stage = "targets";
          logCmd(pickPrompt());
          return true;
        }
        // stage "targets" — apply the relation between the source and this pick
        if (hit < 0) return true;
        const a = ents[pk.conSrc];
        const b = ents[hit];
        if (!a || !b || a === b) return true;
        if (pk.con === "dcangular") {
          logCmd("Enter angle in degrees:");
          pendingNumeric = (v) => {
            pendingNumeric = null;
            const after = P.dimAngular(a, b, v);
            if (!after) {
              logCmd("DCANGULAR: pick two LINEs.");
              return;
            }
            commitModify([b], [after]);
            logCmd(`DCANGULAR: angle set to ${fmt(v)}°.`);
            draw();
          };
          return true;
        }
        const after =
          pk.con === "parallel" ? P.fixParallel(a, b)
          : pk.con === "perpendicular" ? P.fixPerpendicular(a, b)
          : pk.con === "tangent" ? P.fixTangent(a, b)
          : pk.con === "concentric" ? P.fixConcentric(a, b)
          : pk.con === "coincident" ? P.fixCoincident(a, b)
          : pk.con === "symmetric" ? P.fixSymmetric(a, b)
          : pk.con === "equal" ? P.fixEqual(a, b)
          : null;
        if (!after) {
          logCmd(`${pk.con.toUpperCase()}: those object types cannot be constrained this way.`);
          return true;
        }
        commitModify([b], [after]);
        logCmd(`${pk.con.toUpperCase()} constraint applied to the second object.`);
        draw();
        pk.stage = "obj";
        logCmd(pickPrompt());
        return true;
      }
      case "confix": {
        // FIX / UNFIX — pin or release the picked object
        if (hit < 0) {
          logCmd("0 found");
          return true;
        }
        const src = ents[hit];
        if (!src) return true;
        if (fixedEnts.has(src)) {
          fixedEnts.delete(src);
          logCmd("UNFIX: constraint removed from object.");
        } else {
          fixedEnts.add(src);
          logCmd("FIX: object pinned — edits are refused until UNFIX.");
        }
        draw();
        return true;
      }
      case "txt2mtxt": {
        if (hit < 0) {
          logCmd("0 found");
          return true;
        }
        const src = ents[hit];
        const after = src ? P.textToMText(src) : null;
        if (!src || !after) {
          logCmd("TXT2MTXT: pick a single-line TEXT object (MTEXT is skipped).");
          return true;
        }
        commitModify([src], [after]);
        logCmd("TXT2MTXT: converted to MTEXT (wrapped column).");
        draw();
        return true;
      }
      case "explodetext": {
        if (hit < 0) {
          logCmd("0 found");
          return true;
        }
        const src = ents[hit];
        const after = src ? P.mTextToText(src) : null;
        if (!src || !after) {
          logCmd("EXPLODETEXT: pick an MTEXT (wrapped) object.");
          return true;
        }
        commitModify([src], [after]);
        logCmd("EXPLODETEXT: MTEXT exploded back to plain TEXT.");
        draw();
        return true;
      }
      case "textmask": {
        if (hit < 0) {
          logCmd("0 found");
          return true;
        }
        const src = ents[hit];
        const after = src ? P.textMaskToggle(src) : null;
        if (!src || !after) {
          logCmd("TEXTMASK: pick a TEXT / MTEXT object.");
          return true;
        }
        commitModify([src], [after]);
        logCmd(`TEXTMASK: mask ${after.type === "TEXT" && after.mask ? "ON — background box drawn behind the text" : "OFF"}.`);
        draw();
        return true;
      }
      case "laymrg": {
        if (pick.stage === "obj") {
          if (hit < 0) {
            logCmd("0 found");
            return true;
          }
          const src = ents[hit];
          if (!src) return true;
          pick.srcLayer = src.layer;
          pick.stage = "targets";
          logCmd(`Source layer: ${src.layer}. ${pickPrompt()}`);
          return true;
        }
        if (hit < 0) return true;
        const dst = ents[hit];
        if (!dst) return true;
        const target = dst.layer;
        const srcLayer = pick.srcLayer;
        if (target.toUpperCase() === srcLayer.toUpperCase()) {
          logCmd("LAYMRG: pick an object on a DIFFERENT layer as the destination.");
          return true;
        }
        const doomed = ents.filter((e) => e.layer.toUpperCase() === srcLayer.toUpperCase());
        if (!doomed.length) {
          logCmd("LAYMRG: source layer has no objects.");
        } else {
          const after = doomed.map((e) => ({ ...e, layer: target }));
          commitReplace(doomed, after);
          if (doc) doc.layers = doc.layers.filter((l) => l.name.toUpperCase() !== srcLayer.toUpperCase());
          logCmd(`LAYMRG: merged layer "${srcLayer}" into "${target}" (${doomed.length} object(s) moved).`);
        }
        clearPickState();
        setTool("select");
        draw();
        return true;
      }
      case "laydel": {
        if (hit < 0) {
          logCmd("0 found");
          return true;
        }
        const src = ents[hit];
        if (!src) return true;
        const lyr = src.layer;
        const doomed = ents.filter((e) => e.layer.toUpperCase() === lyr.toUpperCase());
        const keep = ents.filter((e) => e.layer.toUpperCase() !== lyr.toUpperCase());
        if (doc) {
          doc.layers = doc.layers.filter((l) => l.name.toUpperCase() !== lyr.toUpperCase());
          hidden.delete(lyr);
        }
        undoStack.push({ type: "delete", entities: doomed });
        markDirty();
        redoStack.length = 0;
        ents = keep;
        if (layoutI < 0) modelEnts = keep;
        sel.clear();
        selected = -1;
        rebuildIndex();
        logCmd(`LAYDEL: deleted layer "${lyr}" and ${doomed.length} object(s).`);
        clearPickState();
        setTool("select");
        draw();
        return true;
      }
      case "textfit": {
        if (pick.stage === "obj") {
          if (hit < 0 || ents[hit]?.type !== "TEXT") {
            logCmd("TEXTFIT: pick a TEXT / MTEXT object.");
            return true;
          }
          pick.conSrc = hit;
          pick.stage = "newend";
          logCmd(pickPrompt());
          return true;
        }
        const e = ents[pick.conSrc];
        if (!e || e.type !== "TEXT") return true;
        const after = P.textFit(e, e.position, { x: wp.x, y: wp.y });
        if (!after) return true;
        commitModify([e], [after]);
        logCmd(`TEXTFIT: width factor set to ${fmt(after.type === "TEXT" ? (after.widthFactor ?? 1) : 1)}.`);
        clearPickState();
        setTool("select");
        draw();
        return true;
      }
      case "arctext": {
        if (hit < 0 || !(ents[hit]?.type === "ARC" || ents[hit]?.type === "CIRCLE")) {
          logCmd("ARCTEXT: pick an ARC or CIRCLE for the text to follow.");
          return true;
        }
        const arc = ents[hit];
        logCmd("Enter text to lay along the arc: (type in the command line, empty Enter = cancel)");
        pendingText = (s) => {
          pendingText = null;
          if (!s || !arc) {
            logCmd("ARCTEXT: cancelled.");
            return;
          }
          const span = bounds ? Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) : 0;
          const h = span > 0 ? span / 100 : 2;
          const res = P.arcText(arc, s, h);
          if (!res || !res.entities.length) {
            logCmd("ARCTEXT: could not lay text on that curve.");
            return;
          }
          addEntities(res.entities);
          logCmd(`ARCTEXT: ${res.entities.length} glyph(s) laid along the curve.`);
          clearPickState();
          setTool("select");
          draw();
        };
        return true;
      }
      case "breakline": {
        if (pick.stage === "p1") {
          pick.p1 = { x: wp.x, y: wp.y };
          pick.stage = "p2";
          logCmd(pickPrompt());
          return true;
        }
        if (!pick.p1) return true;
        const ent = P.breakline(pick.p1, { x: wp.x, y: wp.y }, currentLayer);
        addEntities([ent]);
        logCmd("BREAKLINE: break symbol added.");
        pick.p1 = null;
        pick.stage = "p1";
        logCmd(pickPrompt());
        draw();
        return true;
      }
    }
  }

  /** JOIN finisher (Enter / right-click during JOIN). */
  function finishJoin(): void {
    if (!pick || pick.kind !== "join") return;
    const members = pickTargets();
    const merged = X.chainPolyline(members);
    if (!merged) {
      logCmd(`JOIN: ${members.length} object(s) do not form a connected chain (LINE / open LWPOLYLINE only).`);
      clearPickState();
      setTool("select");
      draw();
      return;
    }
    commitReplace(members, [merged]);
    const verts = merged.type === "LWPOLYLINE" ? merged.points.length : 2;
    logCmd(`JOIN: ${members.length} object(s) joined into 1 polyline with ${verts} vertices.`);
    clearPickState();
    setTool("select");
    draw();
  }

  /** EXPLODE: break selection into simpler entities (polylines → lines). */
  function explodeSelection(): void {
    if (!sel.size) {
      logCmd("Command: EXPLODE — 0 found");
      return;
    }
    const before = [...sel].map((i) => ents[i]).filter((e): e is DxfEntity => !!e);
    const after: DxfEntity[] = [];
    for (const e of before) {
      if (e.type === "LWPOLYLINE") {
        const n = e.points.length;
        const m = e.closed ? n : n - 1;
        for (let i = 0; i < m; i++) {
          const a = e.points[i],
            b = e.points[(i + 1) % n];
          after.push({ type: "LINE", layer: e.layer, color: e.color, rgb: e.rgb, lineType: e.lineType, lineweight: e.lineweight, start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y } });
        }
      } else after.push(e);
    }
    if (after.length === before.length) {
      logCmd("EXPLODE: nothing to explode in the selection.");
      return;
    }
    commitReplace(before, after);
    logCmd(`EXPLODE: ${before.length} object(s) → ${after.length} entities.`);
  }

  /** OFFSET click flow. Returns true when the click was consumed. */
  function onOffsetClick(wp: M.Pt): boolean {
    switch (offStage) {
      case "dist": {
        offPick = { x: wp.x, y: wp.y };
        offStage = "dist2";
        logCmd("Specify second point:");
        return true;
      }
      case "dist2": {
        const d = Math.hypot(wp.x - offPick!.x, wp.y - offPick!.y);
        offDist = d;
        offPick = null;
        offStage = "pickObj";
        logCmd(`Offset distance = ${fmt(d)}`);
        logCmd("Select object to offset:");
        return true;
      }
      case "pickObj": {
        if (offDist == null) {
          logCmd("Specify the offset distance first (click two points or type a value).");
          offStage = "dist";
          return true;
        }
        const i = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, visible) : -1;
        if (i < 0) {
          logCmd("0 found");
          return true;
        }
        offTarget = i;
        setSel([i]);
        offStage = "pickSide";
        logCmd("Specify point on side to offset:");
        return true;
      }
      case "pickSide": {
        const e = ents[offTarget];
        if (!e || offDist == null) {
          offStage = "pickObj";
          offTarget = -1;
          logCmd("Select object to offset:");
          return true;
        }
        const copy = X.offsetEnt(e, offDist, wp);
        if (!copy) {
          logCmd(`Cannot offset that ${e.type} — the offset would collapse the shape.`);
        } else {
          addEntities([copy]);
          logCmd(`Offset created: ${copy.type} at ${fmt(offDist)}`);
        }
        offTarget = -1;
        sel.clear();
        selected = -1;
        showProps();
        offStage = "pickObj";
        logCmd("Select object to offset:");
        return true;
      }
    }
  }

  /** Offset prompt for the dynamic-input HUD / command log. */
  function offsetPrompt(): string {
    switch (offStage) {
      case "dist":
        return `Specify offset distance or <${offDist != null ? fmt(offDist) : "distance"}>: (click two points or type a value)`;
      case "dist2":
        return "Specify second point:";
      case "pickObj":
        return "Select object to offset:";
      case "pickSide":
        return "Specify point on side to offset:";
    }
  }

  /** Central modify/offset pointer-down handler. Returns true when consumed. */
  function onModPointerDown(wp: M.Pt): boolean {
    if (tool === "offset") return onOffsetClick(wp);
    if (!mod) return false;

    if (mod.stage === "select") {
      const i = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, visible) : -1;
      if (i >= 0) setSel([i], true);
      else logCmd("0 found");
      return true;
    }
    if (mod.stage === "base") {
      mod.base = { x: wp.x, y: wp.y };
      mod.stage = "second";
      if (mod.kind === "scale") mod.ref = cursor ? { x: cursor.x, y: cursor.y } : { x: wp.x + 1, y: wp.y };
      pendingNumeric =
        mod.kind === "scale"
          ? (k) => {
              applyScale(k);
              clearModState();
              setTool("select");
              draw();
            }
          : mod.kind === "rotate"
            ? (a) => {
                applyRotate(a);
                clearModState();
                setTool("select");
                draw();
              }
            : null;
      logCmd(modPrompt());
      return true;
    }
    if (mod.stage === "second" && mod.base) {
      const b = mod.base;
      switch (mod.kind) {
        case "move": {
          applyMove({ x: wp.x - b.x, y: wp.y - b.y });
          clearModState();
          setTool("select");
          draw();
          return true;
        }
        case "copy": {
          // drawing workspace COPY keeps the original base point for every placement.
          // Do not rebase on the previous destination or offsets become cumulative.
          placeCopy({ x: wp.x - b.x, y: wp.y - b.y });
          logCmd("Specify second point or [Exit]:");
          return true;
        }
        case "paste": {
          // Super Copy placement: every click drops one copy anchored on the
          // clipboard base point; the session stays open for repeat placements.
          if (!mod.carried) {
            mod.carried = true;
            applyClipCarryOver();
          }
          const placed = modTargets().map((e) => X.translateEnt(e, wp.x - b.x, wp.y - b.y));
          if (!placed.length) return true;
          addEntities(placed);
          mod.placedCount = (mod.placedCount ?? 0) + placed.length;
          sel.clear();
          for (const e of placed) {
            const i = ents.indexOf(e);
            if (i >= 0) sel.add(i);
          }
          selected = sel.size ? [...sel][sel.size - 1] : -1;
          showProps();
          logCmd(`${mod.placeLabel ?? "PASTECLIP"}: ${placed.length} object(s) placed — click again for another copy, Enter / Esc to finish`);
          return true;
        }
        case "rotate": {
          applyRotate(M.norm360Deg(b, wp));
          clearModState();
          setTool("select");
          draw();
          return true;
        }
        case "mirror": {
          finishMirrorAxis(wp);
          draw();
          return true;
        }
        case "scale": {
          const refD = mod.ref ? Math.max(1e-9, Math.hypot(mod.ref.x - b.x, mod.ref.y - b.y)) : 1;
          applyScale(Math.hypot(wp.x - b.x, wp.y - b.y) / refD);
          clearModState();
          setTool("select");
          draw();
          return true;
        }
      }
    }
    return false;
  }

  /* ── Load Document ── */
  async function load(file: File): Promise<void> {
    status(`Reading ${file.name}…`);
    // OpenCADStudio absorption: paint the DWG's embedded preview instantly so a
    // big drawing opens like native CAD (image first, parse runs underneath).
    previewInfo = await readDwgPreview(file).catch(() => null);
    if (previewInfo) showPreviewPlaceholder(previewInfo);
    // Large DWGs can legitimately take a while: show the elapsed seconds so
    // the editor is visibly alive instead of silently stuck on one line.
    const t0 = Date.now();
    const tick = window.setInterval(
      () => status(`Reading ${file.name}… ${Math.round((Date.now() - t0) / 1000)}s`),
      1000,
    );
    try {
      const r = await readCadFile(file);
      doc = r.doc;
      name = file.name;
      modelEnts = doc.entities;
      let b: M.BBox | null = null;
      for (const e of modelEnts) {
        const eb = M.entityBBox(e);
        if (Number.isFinite(eb.minX + eb.maxX + eb.minY + eb.maxY)) b = M.unionBBox(b, eb);
      }
      if (!b && !doc.layouts?.length) throw new Error("The file has no drawable geometry");
      modelBounds = b ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      modelIdx = M.buildIndex(modelEnts, modelBounds);
      layoutIdxCache.clear();
      hidden.clear();
      fixedEnts.clear();
      for (const l of doc.layers) if (l.off || l.frozen) hidden.add(l.name);
      markups = [];
      results = [];
      layerFilter = "";
      origin = null;
      typeFilter = new Set();
      offsetEntity = -1;
      $<HTMLInputElement>("lf").value = "";
      emptyEl.style.display = "none";
      cmp = null;

      fillMenus();
      buildTabs();
      activate(modelEnts.length ? -1 : 0);
      setTool("select");
      showMeas();

      logCmd(`Loaded: ${file.name} (${doc.entities.length} entities, ${doc.layers.length} layers, ${doc.units || "mm"})`);
      markSaved();
      hooks.onTitle(name);
      status(`${r.summary}`);
      setTimeout(() => status(""), 5000);
    } catch (err) {
      status(`Could not open ${file.name}: ${(err as Error).message}`);
      setTimeout(() => status(""), 7000);
    } finally {
      clearInterval(tick);
      hidePreviewPlaceholder();
    }
  }

  function activate(i: number): void {
    if (!doc) return;
    clearModState();
    layoutI = i;
    sel.clear();
    selected = -1;
    pts = [];
    drawn = [];
    hits = [];
    rband = null;
    history.length = 0;
    if (i < 0 || !doc.layouts?.[i]) {
      layoutI = -1;
      ents = modelEnts;
      idx = modelIdx;
      bounds = modelBounds;
    } else {
      const L = doc.layouts[i];
      ents = L.entities;
      bounds = M.layoutBounds(L) ?? modelBounds;
      let ix = layoutIdxCache.get(i);
      if (!ix) {
        ix = M.buildIndex(ents, bounds!);
        layoutIdxCache.set(i, ix);
      }
      idx = ix;
    }
    view = M.fitView(bounds!, view.w, view.h);
    tabsEl
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => b.classList.toggle("on", Number(b.dataset.li) === layoutI));
    buildLayers();
    showProps();
    updateStatus();
    draw();
  }

  function buildTabs(): void {
    const n = doc?.layouts?.length ?? 0;
    tabsEl.style.display = n ? "flex" : "none";
    tabsEl.innerHTML = n
      ? `<button data-li="-1">Model</button>` +
        doc!.layouts!.map((l, i) => `<button data-li="${i}">${escapeHtml(l.name)}</button>`).join("")
      : "";
    tabsEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.onclick = () => activate(Number(b.dataset.li))));
  }

  function setSel(ids: number[], add = false): void {
    if (!add) sel.clear();
    if (add && ids.length === 1 && sel.has(ids[0])) sel.delete(ids[0]);
    else for (const i of ids) sel.add(i);
    selected = sel.size ? [...sel][sel.size - 1] : -1;
    showProps();
    draw();
    if (sel.size) logCmd(`${sel.size} object(s) selected`);
  }

  function zoomToBox(b: M.BBox | null): void {
    if (!b) return;
    pushView();
    const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1e-6) * 0.08;
    view = M.fitView(
      { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad },
      view.w,
      view.h,
      0.02,
    );
    draw();
  }
  function zoomSelection(): void {
    if (idx && sel.size) zoomToBox(M.bboxOfSet(idx, sel));
    else logCmd("Select one or more objects before Zoom to Selected.");
  }

  function saveVisibilityState(): void {
    visibilityHistory.push({ layers: new Set(hidden), entities: new Set(hiddenEntities) });
    if (visibilityHistory.length > 20) visibilityHistory.shift();
  }

  function hideCadSelection(isolate: boolean): void {
    if (!sel.size) { logCmd("Select one or more objects first."); return; }
    saveVisibilityState();
    const keep = new Set([...sel].map((i) => ents[i]).filter(Boolean));
    if (isolate) {
      hidden.clear();
      hiddenEntities.clear();
      for (const entity of ents) if (!keep.has(entity)) hiddenEntities.add(entity);
      logCmd(`Isolated ${keep.size} object(s).`);
    } else {
      for (const entity of keep) hiddenEntities.add(entity);
      logCmd(`Hid ${keep.size} object(s).`);
    }
    sel.clear(); selected = -1;
    showProps(); draw();
  }

  function restoreCadVisibility(): void {
    const previous = visibilityHistory.pop();
    if (previous) {
      hidden.clear(); previous.layers.forEach((x) => hidden.add(x));
      hiddenEntities.clear(); previous.entities.forEach((x) => hiddenEntities.add(x));
    } else {
      hidden.clear(); hiddenEntities.clear();
    }
    buildLayers(); draw();
    logCmd("Visibility restored.");
  }

  function showAllCadObjects(): void {
    visibilityHistory.length = 0;
    hidden.clear(); hiddenEntities.clear();
    buildLayers(); draw();
    logCmd("All objects and layers are visible.");
  }

  function showCadContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    document.querySelectorAll(".obs-cad-context-menu").forEach((n) => n.remove());
    const menu = document.createElement("div");
    menu.className = "obs-cad-context-menu";
    menu.setAttribute("data-obs-ui", "1");
    menu.style.cssText = "position:fixed;z-index:20000;min-width:245px;max-height:80vh;overflow:auto;padding:5px 0;background:#171d27;color:#e6edf5;border:1px solid #354254;border-radius:7px;box-shadow:0 12px 32px rgba(0,0,0,.48);font:12px 'Segoe UI',system-ui,sans-serif";
    menu.addEventListener("mousedown", (e) => e.stopPropagation());
    const hasSelection = sel.size > 0;
    const addSep = () => { const d=document.createElement("div"); d.style.cssText="height:1px;background:#303b4b;margin:4px 7px"; menu.appendChild(d); };
    const addLabel = (label: string) => { const d=document.createElement("div"); d.textContent=label; d.style.cssText="padding:5px 11px 3px;color:#8fa0b4;font-size:9px;font-weight:700;letter-spacing:.08em"; menu.appendChild(d); };
    const addItem = (label: string, run: () => void, disabled = false, danger = false, shortcut = "") => {
      const b=document.createElement("button"); b.type="button"; b.disabled=disabled; b.textContent=label;
      b.style.cssText="display:flex;align-items:center;width:100%;gap:18px;padding:7px 11px;border:0;border-radius:0;background:transparent;text-align:left;color:"+(danger?"#f87171":"inherit")+";font:inherit;cursor:"+(disabled?"default":"pointer")+";opacity:"+(disabled?".38":"1");
      if(shortcut){const k=document.createElement("span");k.textContent=shortcut;k.style.cssText="margin-left:auto;color:#8291a5;font-size:10px";b.appendChild(k);}
      b.onmouseenter=()=>{if(!disabled)b.style.background="#263447";}; b.onmouseleave=()=>b.style.background="transparent";
      b.onclick=()=>{menu.remove();run();}; menu.appendChild(b);
    };
    const action=(label:string,toolName:Tool)=>addItem(label,()=>setTool(toolName),!hasSelection);
    if (hasSelection) addLabel(`${sel.size} OBJECT(S) SELECTED`);
    else addLabel("DRAWING COMMANDS");
    addItem("Zoom to Selected",zoomSelection,!hasSelection,false,"ZS");
    addItem("Zoom Extents",zoomExtents,!bounds);
    addItem("Zoom Previous",()=>{const previous=history.pop();if(previous){view={...previous};draw();}else logCmd("No previous view.");},history.length===0);
    addItem("Pan",()=>setTool("pan"));
    addSep();
    addLabel("SELECTION");
    addItem("Select All",()=>setSel(ents.map((e,i)=>visible(e)?i:-1).filter(i=>i>=0)) ,ents.length===0,false,"Ctrl+A");
    addItem("Select Similar (Type + Layer)",()=>{const first=ents[[...sel][0]];if(first)setSel(ents.map((e,i)=>e.type===first.type&&e.layer===first.layer&&visible(e)?i:-1).filter(i=>i>=0));},!hasSelection);
    addItem("Invert Selection",()=>setSel(ents.map((e,i)=>visible(e)&&!sel.has(i)?i:-1).filter(i=>i>=0)),ents.length===0);
    addItem("Deselect All",()=>setSel([]),!hasSelection);
    addSep();
    addLabel("VISIBILITY");
    addItem("Hide Selected",()=>hideCadSelection(false),!hasSelection);
    addItem("Isolate Selected",()=>hideCadSelection(true),!hasSelection);
    addItem("Show All",showAllCadObjects,hidden.size===0&&hiddenEntities.size===0);
    addItem("Restore Previous Visibility",restoreCadVisibility,visibilityHistory.length===0);
    addSep();
    addLabel("CLIPBOARD & TRANSFORM");
    addItem("Copy",()=>setTool("copy"),!hasSelection,false,"CO");
    addItem("Copy to Clipboard",()=>copySelection(),!hasSelection,false,"Ctrl+Shift+C");
    addItem("Paste",()=>setTool("paste"),!clip || !clip.entities.length,false,"Ctrl+V");
    addItem("Paste at Original Coordinates",()=>pasteOrig(),!clip || !clip.entities.length);
    addItem("Move",()=>setTool("move"),!hasSelection,false,"M");
    addItem("Rotate",()=>setTool("rotate"),!hasSelection,false,"RO");
    addItem("Mirror",()=>setTool("mirror"),!hasSelection,false,"MI");
    addItem("Scale",()=>setTool("scale"),!hasSelection,false,"SC");
    addItem("Array",()=>executeDrawingCommand("ARRAY"),!hasSelection,false,"AR");
    addItem("Polar Array",()=>executeDrawingCommand("ARRAYPOLAR"),!hasSelection,false,"ARP");
    addItem("Offset",()=>setTool("offset"),!hasSelection,false,"O");
    addItem("Match Properties",()=>setTool("match"),!hasSelection,false,"MA");
    addItem("Erase Selected",()=>setTool("erase"),!hasSelection,true,"E");
    addSep();
    addLabel("EDIT GEOMETRY");
    for (const [label,t] of [["Trim","trim"],["Extend","extend"],["Break","break"],["Fillet","fillet"],["Chamfer","chamfer"],["Join","join"],["Explode","explode"],["Stretch","stretch"],["Align","align"],["Lengthen","lengthen"],["Divide","divide"],["Measure","measure"]] as Array<[string,Tool]>) addItem(label,()=>setTool(t),!hasSelection);
    addSep();
    addLabel("LAYERS");
    for (const [label,t] of [["Isolate Object Layer","layiso"],["Turn Off Object Layer","layoff"],["Lock Object Layer","laylck"],["Unlock Object Layer","layunlck"],["Move to Source Layer","matchlayer"]] as Array<[string,Tool]>) addItem(label,()=>setTool(t),!hasSelection);
    addItem("Layer Properties",openLayerPropertiesManager);
    addSep();
    addLabel("DRAWING & SHAPES");
    for (const [label,t] of [["Line","line"],["Polyline","poly"],["Circle","circle"],["Rectangle","rect"],["Arc","arc"],["Polygon","polygon"],["Spline","spline"],["Ellipse","ellipse"],["Donut","donut"],["Point","point"],["XLine","xline"],["Ray","ray"],["Hatch","hatch"],["Wipeout","wipeout"]] as Array<[string,Tool]>) addItem(label,()=>setTool(t));
    addSep();
    addLabel("ANNOTATION & DIMENSIONS");
    for (const [label,t] of [["Text","text"],["Edit Text","ddedit"],["Leader","leader"],["Multileader","mleader"],["Table","table"],["Dimension","dim"],["Linear Dimension","dimlinear"],["Angular Dimension","dimang"],["Arc Length Dimension","dimarc"],["Diameter Dimension","dimdia"],["Center Mark","dimcenter"],["Continue Dimension","dimcont"],["Baseline Dimension","dimbase"]] as Array<[string,Tool]>) addItem(label,()=>setTool(t));
    addSep();
    addLabel("DRAWING");
    addItem("Layer Properties",openLayerPropertiesManager);
    addItem("Object Properties",()=>{showProps();});
    addItem("Undo",undo,undoStack.length===0,false,"Ctrl+Z");
    addItem("Redo",redo,redoStack.length===0,false,"Ctrl+Y");
    document.body.appendChild(menu);
    const rect=menu.getBoundingClientRect();
    menu.style.left=`${Math.max(6,Math.min(ev.clientX,window.innerWidth-rect.width-6))}px`;
    menu.style.top=`${Math.max(6,Math.min(ev.clientY,window.innerHeight-rect.height-6))}px`;
    const close=(e:PointerEvent)=>{if(!menu.contains(e.target as Node)){menu.remove();document.removeEventListener("pointerdown",close,true);}};
    document.addEventListener("pointerdown",close,true);
    menu.addEventListener("keydown",(e)=>{if(e.key==="Escape"){menu.remove();}});
  }

  function zoomLayer(n: string): void {
    if (!idx) return;
    zoomToBox(M.bboxOfSet(idx, ents.map((e, i) => (e.layer === n ? i : -1)).filter((i) => i >= 0)));
  }

  /* ── Layers ── */
  function buildLayers() {
    if (!doc) {
      layersEl.innerHTML = "";
      return;
    }
    const counts = M.countByLayer(ents);
    const f = layerFilter.toLowerCase();
    const names = [...new Set([...doc.layers.map((l) => l.name), ...counts.keys()])]
      .filter((n) => !f || n.toLowerCase().includes(f))
      .sort((a, b) => a.localeCompare(b));
    layersEl.innerHTML = names
      .map((n) => {
        const col = rgbToCss(aciToRgb(layerOf(n)?.color ?? 7, 0xffffff));
        return `<label class="lyr"><input type="checkbox" data-l="${escapeHtml(n)}" ${
          hidden.has(n) ? "" : "checked"
        }><span class="sw" style="background:${col}"></span><span data-zl="${escapeHtml(
          n,
        )}" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(
          n,
        )} (double-click to zoom to layer)">${escapeHtml(n)}</span><span style="color:#778">${
          counts.get(n) ?? 0
        }</span></label>`;
      })
      .join("");
    layersEl
      .querySelectorAll<HTMLElement>("[data-zl]")
      .forEach((el) => (el.ondblclick = (ev) => {
        ev.preventDefault();
        zoomLayer(el.dataset.zl!);
      }));
    layersEl
      .querySelectorAll<HTMLInputElement>("input[data-l]")
      .forEach((i) => (i.onchange = () => {
        i.checked ? hidden.delete(i.dataset.l!) : hidden.add(i.dataset.l!);
        draw();
      }));
  }

  const allLayers = () => [...new Set([...(doc?.layers.map((l) => l.name) ?? []), ...ents.map((e) => e.layer)])];
  $<HTMLInputElement>("lf").oninput = (e) => {
    layerFilter = (e.target as HTMLInputElement).value;
    buildLayers();
  };
  $("lon").onclick = () => {
    hidden.clear();
    buildLayers();
    draw();
  };
  $("loff").onclick = () => {
    allLayers().forEach((n) => hidden.add(n));
    buildLayers();
    draw();
  };
  $("liso").onclick = () => {
    if (!sel.size) return;
    const keep = new Set([...sel].map((i) => ents[i].layer));
    allLayers().forEach((n) => (keep.has(n) ? hidden.delete(n) : hidden.add(n)));
    buildLayers();
    draw();
  };

  /** Open Full Layer Properties Manager (LA / LAYER) */
  function openLayerPropertiesManager(): void {
    if (!doc) return;
    const counts = M.countByLayer(ents);
    const names = [...new Set([...doc.layers.map((l) => l.name), ...counts.keys()])].sort((a, b) =>
      a.localeCompare(b),
    );

    const rows = names
      .map((n) => {
        const lyr = layerOf(n);
        const col = rgbToCss(lyr?.rgb != null ? lyr.rgb : aciToRgb(lyr?.color ?? 7, 0xffffff));
        const isOff = hidden.has(n);
        const isFrozen = lyr?.frozen ?? false;
        const isLocked = lyr?.locked ?? false;
        const isCurrent = currentLayer === n;
        const transp = lyr?.transparency ?? 0;
        const plots = lyr?.plot !== false;

        return `
        <tr data-row-l="${escapeHtml(n)}">
          <td style="text-align:center">${isCurrent ? "✔" : ""}</td>
          <td style="font-weight:600">${escapeHtml(n)}</td>
          <td style="text-align:center;cursor:pointer" data-act="toggle-on">${isOff ? "💡❌" : "💡"}</td>
          <td style="text-align:center;cursor:pointer" data-act="toggle-freeze">${isFrozen ? "❄️" : "☀️"}</td>
          <td style="text-align:center;cursor:pointer" data-act="toggle-lock">${isLocked ? "🔒" : "🔓"}</td>
          <td style="cursor:pointer" data-act="edit-color" title="Click to change colour${lyr?.rgb != null ? ` (true colour #${lyr.rgb.toString(16).padStart(6, "0").toUpperCase()})` : ""}"><span class="sw" style="display:inline-block;background:${col};vertical-align:middle;margin-right:4px"></span>${lyr?.color ?? 7}${lyr?.rgb != null ? " ᵀ" : ""}</td>
          <td style="cursor:pointer" data-act="edit-lt" title="Click to change linetype">${escapeHtml(lyr?.lineType ?? "Continuous")}</td>
          <td style="cursor:pointer" data-act="edit-lw" title="Click to change lineweight">${lyr?.lineweight != null ? escapeHtml(lineweightLabel(lyr.lineweight)) : "Default"}</td>
          <td style="text-align:center">${transp ? `${transp}%` : "—"}</td>
          <td style="text-align:center">${plots ? "🖨️" : "🚫"}</td>
        </tr>`;
      })
      .join("");

    const el = openOverlay(`
      <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #334155;padding-bottom:10px;margin-bottom:12px">
        <b style="font-size:15px;color:#38bdf8">drawing workspace Layer Properties Manager</b>
        <div style="display:flex;gap:6px">
          <button data-r="lyr-new" style="background:#0284c7;color:white;border:none;padding:4px 10px;border-radius:4px;cursor:pointer">＋ New Layer</button>
          <button data-r="lyr-close" style="padding:4px 10px">Close</button>
        </div>
      </div>
      <div style="max-height:60vh;overflow-y:auto">
        <table style="width:100%;font-size:12px;border-collapse:collapse">
          <thead>
            <tr style="color:#9aa4b2;text-align:left;border-bottom:1px solid #334155">
              <th>Status</th><th>Name</th><th>On</th><th>Freeze</th><th>Lock</th><th>Color</th><th>Linetype</th><th>Lineweight</th><th>Transp.</th><th>Plot</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);

    el.querySelector("[data-r=lyr-close]")?.addEventListener("click", () => closeOverlay());
    el.querySelector("[data-r=lyr-new]")?.addEventListener("click", () => {
      void promptLine("New layer", "Enter new layer name", `Layer${names.length + 1}`).then((raw) => {
        const newName = raw?.trim();
        if (newName) {
          if (!doc!.layers.some((l) => l.name === newName)) {
            doc!.layers.push({ name: newName, color: 7, lineType: "Continuous" });
            currentLayer = newName;
            closeOverlay();
            buildLayers();
            openLayerPropertiesManager();
            logCmd(`Layer created: ${newName}`);
          }
        }
      });
    });

    el.querySelectorAll("tr[data-row-l]").forEach((tr) => {
      const lname = tr.getAttribute("data-row-l")!;
      const editField = (act: string, field: "color" | "lineType" | "lineweight") =>
        tr.querySelector(`[data-act=${act}]`)?.addEventListener("click", () => {
          void editLayerProperty(styleApi, lname, field).then((changed) => {
            if (!changed) return;
            closeOverlay();
            buildLayers();
            openLayerPropertiesManager();
            markDirty();
            draw();
          });
        });
      editField("edit-color", "color");
      editField("edit-lt", "lineType");
      editField("edit-lw", "lineweight");
      tr.querySelector("[data-act=toggle-on]")?.addEventListener("click", () => {
        if (hidden.has(lname)) hidden.delete(lname);
        else hidden.add(lname);
        closeOverlay();
        buildLayers();
        openLayerPropertiesManager();
        draw();
      });
      tr.querySelector("[data-act=toggle-freeze]")?.addEventListener("click", () => {
        const lyr = layerOf(lname);
        if (lyr) lyr.frozen = !lyr.frozen;
        closeOverlay();
        buildLayers();
        openLayerPropertiesManager();
        draw();
      });
      tr.querySelector("[data-act=toggle-lock]")?.addEventListener("click", () => {
        const lyr = layerOf(lname);
        if (lyr) lyr.locked = !lyr.locked;
        closeOverlay();
        buildLayers();
        openLayerPropertiesManager();
      });
    });
  }

  /* ── Properties & Measurements ── */
  function showProps() {
    if (sel.size > 1) {
      let len = 0,
        area = 0;
      const types = new Map<string, number>(),
        lay = new Set<string>();
      for (const i of sel) {
        const e = ents[i],
          m = M.entityMetrics(e);
        len += m.length ?? 0;
        area += m.area ?? 0;
        types.set(e.type, (types.get(e.type) ?? 0) + 1);
        lay.add(e.layer);
      }
      propsEl.innerHTML = `<table>${row("Selected", `${sel.size} objects`)}${[...types]
        .map(([k, n]) => row(k, String(n)))
        .join("")}${row("Layers", String(lay.size))}${row("Total length", fmt(len))}${
        area ? row("Total area", fmt(area, 2)) : ""
      }</table>`;
      const hostMulti = document.createElement("div");
      propsEl.append(hostMulti);
      renderAppearanceEditor(hostMulti, styleApi);
      return;
    }
    const e = ents[selected];
    if (!e) {
      propsEl.innerHTML = doc
        ? `<table>${row("File", name)}${row("Units", doc.units ?? "unitless")}${row(
            "Objects",
            String(ents.length),
          )}${row("Layers", String(doc.layers.length))}${[...M.countByType(ents)]
            .map(([k, n]) => row(k, String(n)))
            .join("")}</table>`
        : "";
      return;
    }
    const m = M.entityMetrics(e),
      rows: string[] = [
        row("Type", e.type),
        row("Layer", e.layer),
        row(
          "Colour",
          e.rgb != null
            ? `${rgbToCss(e.rgb)}  (#${e.rgb.toString(16).padStart(6, "0").toUpperCase()}, true colour)`
            : e.color
              ? `ACI ${e.color}`
              : "ByLayer",
        ),
      ];
    rows.push(row("Linetype", e.lineType ?? layerOf(e.layer)?.lineType ?? "ByLayer"));
    if (e.ltScale != null && e.ltScale !== 1) rows.push(row("Linetype scale", String(+e.ltScale.toFixed(4))));
    if (e.transparency) rows.push(row("Transparency", `${e.transparency}%`));
    if (e.type === "LWPOLYLINE" && e.hatch)
      rows.push(
        row("Hatch", e.hatch.solid ? "Solid" : e.hatch.pattern ?? "Pattern"),
        row("Loops", String(e.hatch.loops.length)),
        ...(e.hatch.solid
          ? []
          : [
              row("Angle", (e.hatch.angle ?? 0).toFixed(2) + "°"),
              row("Pattern scale", String(+(e.hatch.scale ?? 1).toFixed(4))),
            ]),
      );
    if (e.type === "LINE") rows.push(row("Start", pt(e.start)), row("End", pt(e.end)));
    if (e.type === "CIRCLE" || e.type === "ARC") rows.push(row("Center", pt(e.center)));
    if (e.type === "ARC")
      rows.push(
        row("Start angle", e.startAngle.toFixed(2) + "°"),
        row("End angle", e.endAngle.toFixed(2) + "°"),
        row("Sweep", m.sweep!.toFixed(2) + "°"),
      );
    if (e.type === "LWPOLYLINE" && !e.hatch)
      rows.push(row("Vertices", String(e.points.length)), row("Closed", e.closed ? "Yes" : "No"));
    if (e.type === "TEXT") {
      const styleName = e.style ?? "Standard";
      const fileStyle = doc?.textStyles?.[styleName.toUpperCase()];
      const fontName = e.font ?? fileStyle?.font;
      rows.push(
        row("Text", e.value),
        row("Text style", styleName),
        row("Font", fontName ? String(fontName) : "—"),
        row("Height", fmt(e.height)),
        row("Rotation", (e.rotation ?? 0).toFixed(2) + "°"),
        row("Position", pt(e.position)),
      );
    }
    if (e.type === "POINT") rows.push(row("Position", pt(e.position)));
    if (m.radius != null) rows.push(row("Radius", fmt(m.radius)), row("Diameter", fmt(m.diameter!)));
    if (m.length != null) rows.push(row("Length", fmt(m.length)));
    if (m.angle != null) rows.push(row("Angle", m.angle.toFixed(2) + "°"));
    if (m.area != null) rows.push(row("Area", fmt(m.area, 2)));
    rows.push(row("Lineweight", lineweightLabel(e.lineweight ?? layerOf(e.layer)?.lineweight)));
    propsEl.innerHTML = `<table>${rows.join("")}</table>`;
    const hostOne = document.createElement("div");
    propsEl.append(hostOne);
    renderAppearanceEditor(hostOne, styleApi);
  }

  const row = (k: string, v: string) =>
    `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`;
  const pt = (p: { x: number; y: number }) =>
    `${M.convertLength(p.x, doc?.units, du).toFixed(3)}, ${M.convertLength(p.y, doc?.units, du).toFixed(
      3,
    )}`;

  function showMeas() {
    measEl.innerHTML = results.length
      ? results.map((r) => `<div>${escapeHtml(r)}</div>`).join("") +
        `<div style="display:flex;gap:4px;margin-top:6px"><button data-r="mclr">Clear</button><button data-r="mcopy">Copy</button><button data-r="mcsv">CSV</button></div>`
      : `<span style="color:#778">Drawing controls ready. Wheel zooms, drag pans, click selects. Type commands or pick tools.</span>`;
    const b = measEl.querySelector<HTMLButtonElement>("[data-r=mclr]");
    if (b)
      b.onclick = () => {
        results = [];
        drawn = [];
        showMeas();
        draw();
      };
    const cp = measEl.querySelector<HTMLButtonElement>("[data-r=mcopy]");
    if (cp)
      cp.onclick = () => {
        void navigator.clipboard
          ?.writeText(results.join("\n"))
          .then(() => {
            status("Measurements copied");
            setTimeout(() => status(""), 1800);
          })
          .catch(() => status("Copy not allowed"));
      };
    const cs = measEl.querySelector<HTMLButtonElement>("[data-r=mcsv]");
    if (cs)
      cs.onclick = () =>
        download(new Blob([M.resultsToCsv(results)], { type: "text/csv" }), `${base()}-measurements.csv`);
  }

  /* ── Tools Definition ── */
  const T: Array<[Tool, string, string]> = [
    ["pan", "Pan", "P"],
    ["select", "Select", "S"],
    ["line", "Line", "L"],
    ["poly", "Pline", "PL"],
    ["circle", "Circle", "C"],
    ["rect", "Rectang", "REC"],
    ["arc", "Arc", "A"],
    ["dist", "Distance", "D"],
    ["area", "Area", "AA"],
    ["dim", "Dimension", "Q"],
    ["dimlinear", "Linear Dimension", "DLI"],
    ["erase", "Erase", "E"],
    ["box", "Box", "B"],
    ["zoomwin", "Zoom Window", "W"],
    ["coord", "Coordinates", "ID"],
    ["radius", "Radius", "R"],
    ["leader", "Leader", "Y"],
    ["cloud", "RevCloud", "U"],
    ["move", "Move", "M"],
    ["copy", "Copy", "CO"],
    ["rotate", "Rotate", "RO"],
    ["mirror", "Mirror", "MI"],
    ["scale", "Scale", "SC"],
    ["offset", "Offset", "O"],
    ["redline", "Redline", "M"],
    ["note", "Text Note", "N"],
    ["text", "Text", "T"],
    ["match", "Match Properties", "MA"],
    ["calibrate", "Calibrate", "K"],
    ["lengthen", "Lengthen", "LEN"],
    ["divide", "Divide", "DIV"],
    ["measure", "Measure", "ME"],
    ["mleader", "MLeader", "MLD"],
    ["txt2mtxt", "TXT2MTXT", "TXT2MTXT"],
    ["explodetext", "ExplodeText", "EXPLODETEXT"],
    ["textfit", "TextFit", "TEXTFIT"],
    ["arctext", "ArcText", "ARCTEXT"],
    ["textmask", "TextMask", "TEXTMASK"],
    ["breakline", "Break-line", "BREAKLINE"],
    ["laymrg", "Layer Merge", "LAYMRG"],
    ["laydel", "Layer Delete", "LAYDEL"],
  ];

  /* Ribbon-style button / group builders (shared by buildBar + buildBar2) */
  function rb(icon: IconName, label: string, attrs: string, title: string, cls = ""): string {
    return (
      `<button class="cadrb${cls ? " " + cls : ""}" ${attrs} title="${escapeHtml(title)}" aria-label="${escapeHtml(label)}">` +
      `<span class="cadrb__icon">${svgIcon(icon)}</span><span class="cadrb__label">${escapeHtml(label)}</span></button>`
    );
  }
  function rg(label: string, body: string, bodyCls = "", groupCls = "", cadTab = "home"): string {
    return (
      `<div class="cadrg${groupCls ? " " + groupCls : ""}" data-cadtab="${cadTab}"><div class="cadrg__body${bodyCls ? " " + bodyCls : ""}">${body}</div>` +
      `<div class="cadrg__label">${escapeHtml(label)}</div></div>`
    );
  }
  /* Ribbon actions (buildBar) and right-side actions (buildBar2), both reachable
     from the shell-level A-menu / Quick Access toolbar via exec(). */
  const act: Record<string, () => void> = {};
  const act2: Record<string, () => void> = {};

  function buildBar() {
    const tip = (k: Tool): string => {
      const d = T.find((x) => x[0] === k);
      return d ? `${d[1]} (${d[2]})` : String(k);
    };
    const tb = (k: Tool, icon: IconName, label: string): string => rb(icon, label, `data-t="${k}"`, tip(k));
    const bgOpts = Object.keys(BG)
      .map((k) => `<option value="${k}" ${k === "drafting" ? "selected" : ""}>${k}</option>`)
      .join("");
    const unitOpts = ["drawing", "mm", "cm", "m", "in", "ft"].map((u) => `<option>${u}</option>`).join("");

    tools.innerHTML =
      rg(
        "Clipboard",
        rb("copy", "Copy", `data-a="clipcopy"`, "Copy selection to the cross-drawing clipboard (Ctrl+C / Ctrl+Shift+C / COPYCLIP)") +
          rb("cut", "Cut", `data-a="clipcut"`, "Cut selection to the clipboard (Ctrl+X)") +
          rb("paste", "Paste", `data-a="clippaste"`, "Paste clipboard at the cursor — click to place, click again for another copy (Ctrl+V / Ctrl+Shift+V / PASTECLIP)") +
          rb("ref-plane", "Paste to Origin", `data-a="pasteorig"`, "Paste clipboard at original coordinates (Ctrl+Alt+V / PASTEORIG)"),
        "",
        "",
        "home",
      ) +
      rg(
        "AI Copilot",
        rb("generative", "AI Copilot", `data-a="aicopilot"`, "Open the AI copilot docked in this drawing — ask questions, inspect the drawing, or run commands with approval") +
          rb("find", "AI: Drawing Info", `data-a="aicopilot-info"`, "Ask the AI copilot about this drawing (opens the copilot and pre-fills a drawing question)"),
        "",
        "",
        "home",
      ) +
      rg(
        "Select",
        tb("select", "select-all", "Select") +
          tb("box", "isolate", "Box") +
          tb("erase", "delete", "Erase") +
          rb("clear", "Erase Sel", `data-a="erase"`, "Erase selected (DEL / E)"),
        "",
        "",
        "home",
      ) +
      rg(
        "Draw",
        tb("line", "mline", "Line") +
          tb("poly", "model-curve", "Pline") +
          tb("polygon", "polygon", "Polygon") +
          tb("rect", "plate", "Rectang") +
          tb("arc", "arc-length", "Arc") +
          tb("circle", "circle", "Circle") +
          tb("spline", "spline", "Spline") +
          tb("ellipse", "ellipse", "Ellipse") +
          tb("donut", "donut", "Donut") +
          tb("point", "point", "Point"),
        "",
        "",
        "home",
      ) +
      rg(
        "Draw II",
        tb("hatch", "hatch", "Hatch") +
          tb("wipeout", "wipeout", "Wipeout") +
          tb("xline", "xline", "XLine") +
          tb("ray", "ray", "Ray"),
        "",
        "",
        "home",
      ) +
      rg(
        "Modify",
        tb("move", "move", "Move") +
          tb("copy", "copy", "Copy") +
          tb("rotate", "rotate", "Rotate") +
          tb("scale", "scale", "Scale") +
          tb("stretch", "stretch", "Stretch") +
          tb("mirror", "mirror", "Mirror") +
          tb("offset", "offset", "Offset") +
          tb("trim", "trim", "Trim") +
          tb("extend", "extend", "Extend") +
          tb("break", "break", "Break"),
        "",
        "",
        "home",
      ) +
      rg(
        "Modify II",
        tb("join", "join", "Join") +
          tb("fillet", "fillet", "Fillet") +
          tb("chamfer", "chamfer", "Chamfer") +
          tb("lengthen", "stretch", "Lengthen") +
          tb("explode", "explode", "Explode") +
          tb("align", "align", "Align") +
          tb("erase", "delete", "Erase") +
          rb("array", "Array Rect", `data-a="array-rect"`, "Create a rectangular array with row/column spacing and a rotated grid") +
          rb("array", "Array Polar", `data-a="array-polar"`, "Create a polar array with centre, item count, sweep and rotation options"),
        "",
        "",
        "home",
      ) +
      rg(
        "Annotation",
        tb("text", "text", "Text") +
          rb("model-text", "MText", `data-a="mtext"`, "Place multiline text (MTEXT)") +
          tb("table", "table", "Table") +
          tb("leader", "tag", "Leader") +
          tb("mleader", "tag-all", "MLeader") +
          rb("text", "Edit Text", `data-a="ddedit"`, "Edit the text content of a picked TEXT / MTEXT object (ED / DDEDIT)"),
        "",
        "",
        "home",
      ) +
      rg(
        "Properties",
        `<label class="cadrb-field"><span>Color</span><select data-a="ecol"><option value="">ByLayer</option><option value="1">Red</option><option value="2">Yellow</option><option value="3">Green</option><option value="4">Cyan</option><option value="5">Blue</option><option value="6">Magenta</option><option value="7">White</option></select></label>` +
          `<label class="cadrb-field"><span>Linetype</span><select data-a="elt"><option value="">ByLayer</option><option>CONTINUOUS</option><option>DASHED</option><option>HIDDEN</option><option>CENTER</option><option>DOT</option></select></label>` +
          tb("match", "matchprop", "MatchProp") +
          tb("matchlayer", "modify", "Match Layer"),
        "cadrg__body--fields",
        "",
        "home",
      ) +
      rg(
        "Utilities",
        tb("dist", "measure", "Distance") +
          tb("area", "area", "Area") +
          tb("radius", "dim-radial", "Radius") +
          tb("coord", "spot-coord", "ID Point") +
          tb("angle", "dim-angular", "Angle") +
          tb("divide", "point", "Divide") +
          tb("measure", "measure", "Measure") +
          rb("report", "List", `data-a="list"`, "List properties of the selection (LI / LIST)"),
        "",
        "",
        "home",
      ) +
      rg(
        "History",
        rb("undo", "Undo", `data-a="undo"`, "Undo (Ctrl+Z / U)") +
          rb("undo", "Redo", `data-a="redo"`, "Redo (Ctrl+Y)", "cadrb--flip"),
        "",
        "",
        "home",
      ) +
      rg(
        "Layers",
        rb("schedules", "Manager", `data-a="lyr-mgr"`, "drawing workspace Layer Properties Manager (LA)") +
          rb("isolate", "LayIso", `data-a="layiso"`, "Isolate the layer of a picked object — hide every other layer (LAYISO)") +
          rb("show-all", "LayUniso", `data-a="layuniso"`, "Restore the layers hidden by LAYISO (LAYUNISO)") +
          rb("masking-region", "LayOff", `data-a="layoff"`, "Turn off the layer of a picked object (LAYOFF)"),
        "",
        "",
        "home",
      ) +
      rg(
        "Styles",
        rb("insulation", "Linetypes", `data-a="lt-mgr"`, "Linetype Manager: load linetypes, set current, global scale (LT)") +
          rb("text", "Text Styles", `data-a="ts-mgr"`, "Text Style Manager: fonts, heights, presets (ST)"),
        "",
        "",
        "home",
      ) +
      rg(
        "Block",
        rb("component", "Insert", `data-a="blk-insert"`, "Insert a block from the library with scale and rotation (INSERT, I)") +
          rb("symbol", "Create", `data-a="blk-make"`, "Create a block from the selected objects (BLOCK, B)") +
          rb("file-frag", "Write Block", `data-a="blk-write"`, "Save the selected objects as a DXF file (WBLOCK, W)") +
          rb("new-family", "Library", `data-a="blk-lib"`, "List, insert, rename, delete or export blocks (BLOCKLIB)") +
          rb("delete", "Explode", `data-a="blk-explode"`, "Explode the selected polylines (EXPLODE)") +
          `<input type="file" data-r="blockfile" accept=".dwg,.dxf" style="display:none">`,
        "",
        "",
        "insert",
      ) +
      rg(
        "Open Drawing",
        rb("file", "DWG…", `data-a="dwg-open"`, "Open DWG drawings as new tabs — parsed locally in the reader worker (LibreDWG WASM)") +
          rb("folder", "DXF…", `data-a="dwg-open-dxf"`, "Open DXF drawings as new tabs") +
          rb("import", "JSON dump…", `data-a="dwg-jsonimp"`, "Re-import a dwg2json database dump into the editor (JSON round trip)"),
        "",
        "",
        "insert",
      ) +
      rg(
        "Import",
        rb("import", "DWG / DXF…", `data-a="import"`, "Merge a DWG or DXF file into the current drawing (IMPORT)") +
          rb("file", "File as Block", `data-a="blk-file"`, "Read a DWG / DXF as a block and place it (INSERT from file)") +
          rb("model-curve", "SVG…", `data-a="svg-import"`, "Import an SVG as polylines and circles (SVGIMPORT)") +
          `<input type="file" data-r="importfile" accept=".dwg,.dxf" style="display:none">` +
          `<input type="file" data-r="svgfile" accept=".svg,image/svg+xml" style="display:none">`,
        "",
        "",
        "insert",
      ) +
      rg(
        "Fields",
        rb("text", "Field", `data-a="ins-field"`, "Insert text computed from the drawing: date, name, length, area (FIELD)") +
          rb("table", "Table", `data-a="ins-table"`, "Draw a rows × columns table (TABLE)") +
          rb("model-text", "MText", `data-a="mtext"`, "Place multiline text (MTEXT)"),
        "",
        "",
        "insert",
      ) +
      rg(
        "Data",
        rb("quantification", "Takeoff", `data-a="takeoff2"`, "Quantity takeoff by layer and type (CSV)") +
          rb("report", "Info", `data-a="info2"`, "Drawing information"),
        "",
        "",
        "insert",
      ) +
      rg(
        "Text",
        tb("text", "text", "Text") +
          rb("model-text", "MText", `data-a="mtext"`, "Place multiline text (MTEXT)") +
          rb("find", "Find Text", `data-a="find"`, "Find and replace text in the drawing (FIND)"),
        "",
        "",
        "annotate",
      ) +
      rg(
        "Dimensions",
        tb("dim", "dim-aligned", "Aligned") +
          tb("dimlinear", "dim-linear", "Linear") +
          tb("dimang", "dim-angular", "Angular") +
          tb("dimarc", "dim-arclen", "Arc Len") +
          tb("dimdia", "dim-diameter", "Diameter") +
          tb("radius", "dim-radial", "Radius") +
          tb("dimcenter", "center-mark", "Center") +
          tb("dimcont", "dim-continue", "Continue") +
          tb("dimbase", "dim-baseline", "Baseline"),
        "",
        "",
        "annotate",
      ) +
      rg(
        "Markup",
        tb("redline", "detail-line", "Redline") +
          tb("cloud", "revision-cloud", "RevCloud") +
          tb("note", "text", "Note") +
          tb("calibrate", "ref-plane", "Calibrate"),
        "",
        "",
        "annotate",
      ) +
      rg(
        "Tables",
        tb("table", "table", "Table") +
          rb("schedule", "Edit Size", `data-a="tablesize"`, "Set the next table's rows × columns"),
        "",
        "",
        "annotate",
      ) +
      rg(
        "Navigate",
        tb("pan", "move", "Pan") +
          tb("zoomwin", "inspect", "Zoom Win") +
          rb("fit", "Extents", `data-a="ext"`, "Zoom extents (Z E)") +
          rb("recenter", "Selection", `data-a="zsel"`, "Zoom to selection") +
          rb("bounds", "Zoom Scale", `data-a="zscale"`, "Zoom by a scale factor (Z <factor>)") +
          rb("back", "Zoom Previous", `data-a="zprev"`, "Restore the previous view (Z P)"),
        "",
        "",
        "view",
      ) +
      rg(
        "Saved Views",
        rb("camera", "Save View", `data-a="vsave"`, "Save the current view under a name (VIEW S <name>)") +
          rb("view", "Restore", `data-a="vrestore"`, "Restore a saved view (VIEW R <name>)"),
        "",
        "",
        "view",
      ) +
      rg(
        "Visual Styles",
        `<label class="cadrb-field"><span>Background</span><select data-a="bg">${bgOpts}</select></label>` +
          rb("plan", "Layer color", `data-a="cmlayer"`, "Color mode: by layer (default)") +
          rb("circle", "B & W", `data-a="cmbw"`, "Color mode: black & white plot style") +
          rb("filled-region", "Invert", `data-a="cminv"`, "Color mode: inverted"),
        "cadrg__body--fields",
        "",
        "view",
      ) +
      rg(
        "Modes",
        rb("grid", "Grid", `data-a="grid"`, "Grid (F7)", "on") +
          rb("origin", "Snap", `data-a="snap"`, "Object snap (F3)", "on") +
          rb("orthographic", "Ortho", `data-a="ortho"`, "Ortho (F8)") +
          rb("dim-linear", "DYN", `data-a="dyn"`, "Dynamic Input HUD (F12)", "on") +
          rb("strip", "LWT", `data-a="lwt"`, "Lineweight display", "on"),
        "",
        "",
        "view",
      ) +
      rg(
        "UCS",
        tb("origin", "origin", "Origin") +
          rb("recenter", "World", `data-a="ucsworld"`, "Return the UCS to the world origin"),
        "",
        "",
        "view",
      ) +
      rg(
        "Units",
        `<label class="cadrb-field"><span>Units</span><select data-a="du">${unitOpts}</select></label>`,
        "cadrg__body--fields",
        "",
        "manage",
      ) +
      rg(
        "Drawing",
        rb("purge", "Purge", `data-a="purge"`, "Remove unused layers from the drawing (PURGE)") +
          rb("audit", "Audit", `data-a="audit"`, "Check and repair the drawing database (AUDIT / OVERKILL)") +
          rb("refresh", "Regen", `data-a="regen"`, "Regenerate the drawing (REGEN)"),
        "",
        "",
        "manage",
      ) +
      rg(
        "Layer States",
        rb("layer-state", "Save State", `data-a="lssave"`, "Snapshot which layers are off / frozen (LAYERSTATE S)") +
          rb("show-all", "Restore State", `data-a="lsrestore"`, "Restore a saved layer state (LAYERSTATE R)"),
        "",
        "",
        "manage",
      ) +
      rg(
        "DWG Inspect",
        rb("audit", "DWG Audit…", `data-a="dwg-audit"`, "Integrity report — zero-length geometry, dangling layer/style refs, empty layers (dwg_audit conformance)") +
          rb("table", "Tables…", `data-a="dwg-tables"`, "LAYER / LTYPE / STYLE / DIMSTYLE / layouts table browser") +
          rb("find", "Census…", `data-a="dwg-census"`, "Entity counts by type in model space"),
        "",
        "",
        "manage",
      ) +
      rg(
        "Plot",
        rb("print", "Plot…", `data-a="plot"`, "Plot to PDF / paper (PLOT)"),
        "",
        "",
        "output",
      ) +
      rg(
        "DWG Data",
        rb("save", "Save DXF…", `data-a="dwg-rewrite"`, "Re-save the drawing through the DXF writer") +
          rb("csv", "dwg2json", `data-a="dwg-2json"`, "Full database dump as JSON — entities, layers, tables, skipped census (dwgread -O JSON conformance)") +
          rb("spline", "dwg2SVG", `data-a="dwg-2svg"`, "Flattened 2D vector export with per-entity colors") +
          rb("topo", "dwg2geojson", `data-a="dwg-2geojson"`, "Points / lines / polygons FeatureCollection in drawing coordinates (dwg2geojson conformance)") +
          rb("print", "dwg2ps", `data-a="dwg-2ps"`, "EPS via moveto/lineto/arc — prints anywhere (dwg2ps conformance)") +
          rb("camera", "Thumbnail…", `data-a="dwg-thumb"`, "Extract the embedded preview bitmap from a DWG file — no geometry parsing (dwg_bmp conformance)"),
        "",
        "",
        "output",
      ) +
      /* ── Parametric tab — geometric + dimensional constraints ── */
      rg(
        "Geometric",
        rb("generative", "Auto Constrain", `data-a="con-auto"`, "Detect and exactify near-horizontal / near-vertical / concentric relations (AUTOCONSTRAIN)") +
          rb("anchor", "Fix", `data-a="con-fix"`, "Pin objects — edits are refused until UNFIX (FIX)") +
          rb("grid", "Horizontal", `data-a="con-hor"`, "Force the picked line level (HORIZONTAL)") +
          rb("top", "Vertical", `data-a="con-ver"`, "Force the picked line plumb (VERTICAL)") +
          rb("orthographic", "Perpendicular", `data-a="con-perp"`, "Make the second line perpendicular to the first (PERPENDICULAR)") +
          rb("ramp", "Parallel", `data-a="con-par"`, "Make the second line parallel to the first (PARALLEL)") +
          rb("circle", "Tangent", `data-a="con-tan"`, "Translate the line so it touches the circle exactly (TANGENT)") +
          rb("donut", "Concentric", `data-a="con-conc"`, "Snap the second circle onto the first one's center (CONCENTRIC)") +
          rb("conn", "Coincident", `data-a="con-coin"`, "Snap the second line's nearest endpoint onto the first (COINCIDENT)") +
          rb("mirror", "Symmetric", `data-a="con-sym"`, "Mirror the first pick about the axis line picked second (SYMMETRIC)") +
          rb("matchprop", "Equal", `data-a="con-eq"`, "Equalize lengths / radii of two objects (EQUAL)"),
        "",
        "",
        "parametric",
      ) +
      rg(
        "Dimensional",
        rb("dim-linear", "DC Linear", `data-a="dc-linear"`, "Set a line to an exact length (DCLINEAR)") +
          rb("circle", "DC Radius", `data-a="dc-radius"`, "Set a circle / arc to an exact radius (DCRADIUS)") +
          rb("donut", "DC Diameter", `data-a="dc-dia"`, "Set a circle / arc to an exact diameter (DCDIAMETER)") +
          rb("fillet", "DC Angular", `data-a="dc-ang"`, "Set the angle between two lines (DCANGULAR)"),
        "",
        "",
        "parametric",
      ) +
      rg(
        "Manage",
        rb("tag", "Constraint Bar", `data-a="con-bar"`, "Show or hide the FIX constraint markers (CONSTRAINTBAR)", "on") +
          rb("purge", "Unfix All", `data-a="con-unfixall"`, "Release every FIX constraint (DELCONSTRAINT)"),
        "",
        "",
        "parametric",
      ) +
      /* ── Express Tools tab ── */
      rg(
        "Text",
        tb("txt2mtxt", "text", "TXT2MTXT") +
          tb("explodetext", "explode", "ExplodeText") +
          tb("textfit", "bounds", "TextFit") +
          tb("arctext", "ramp", "ArcText") +
          tb("textmask", "wipeout", "TextMask"),
        "",
        "",
        "express",
      ) +
      rg(
        "Modify",
        rb("slab", "Flatten", `data-a="flatten"`, "Set every object to Z = 0 (FLATTEN)") +
          rb("purge", "Overkill", `data-a="overkill"`, "Delete duplicate / overlapping objects (OVERKILL)") +
          tb("breakline", "break", "Break-line"),
        "",
        "",
        "express",
      ) +
      rg(
        "Layers",
        tb("laymrg", "workset", "LayMrg") +
          tb("laydel", "delete", "LayDel") +
          rb("walk", "LayWalk", `data-a="laywalk"`, "Walk the drawing layer by layer (LAYWALK)") +
          rb("clear", "LayFrz", `data-a="layfrz"`, "Freeze the layers of the selected objects (LAYFRZ)") +
          rb("refresh", "LayThw", `data-a="laythw"`, "Thaw every frozen layer (LAYTHW)") +
          tb("matchlayer", "matchprop", "Layer Match"),
        "",
        "",
        "express",
      ) +
      rg(
        "Tools",
        rb("settings", "Command Aliases", `data-a="aliases"`, "Edit the command alias list (ALIASEDIT / KS)") +
          rb("insulation", "Linetypes", `data-a="lt-mgr"`, "Linetype Manager (LT)"),
        "",
        "",
        "express",
      ) +
      /* ── Collaborate tab ── */
      rg(
        "Publish",
        rb("save", "Publish All", `data-a="publish"`, "Batch-write every open drawing to DWG (PUBLISH)") +
          rb("print", "Plot…", `data-a="plot"`, "Plot this drawing to PDF / paper (PLOT)"),
        "",
        "",
        "collaborate",
      ) +
      rg(
        "Share",
        rb("camera", "Share View", `data-a="shareview"`, "Export the current view as a PNG for CDE / email (SHAREVIEW)") +
          rb("report", "DWG Version", `data-a="dwgversion"`, "Which DWG version is this file (DWGVERSION)"),
        "",
        "",
        "collaborate",
      ) +
      rg(
        "History",
        rb("timeline", "Drawing History", `data-a="dwghistory"`, "Session command history + undo depth (DWGHISTORY)"),
        "",
        "",
        "collaborate",
      ) +
      rg(
        "Standards",
        rb("check", "Check Standards", `data-a="checkstd"`, "Audit layers / linetypes / text styles (CHECKSTANDARDS)"),
        "",
        "",
        "collaborate",
      ) +
      /* ── Manage tab additions — customization + standards ── */
      rg(
        "Customization",
        rb("settings", "Aliases", `data-a="aliases"`, "Command alias editor (ALIASEDIT / KS)") +
          rb("menu", "Ribbon", `data-a="ribbon-min"`, "Minimize or restore the ribbon (double-click a tab works too)") +
          rb("crop", "Clean Screen", `data-a="cleanscreen"`, "Hide every chrome element (CLEANSCREEN)"),
        "",
        "",
        "manage",
      ) +
      rg(
        "CAD Standards",
        rb("check", "Check Standards", `data-a="checkstd"`, "Audit layers / linetypes / text styles (CHECKSTANDARDS)"),
        "",
        "",
        "manage",
      ) +
      /* ── View tab additions — palettes ── */
      rg(
        "Palettes",
        rb("property", "Properties", `data-a="props"`, "Properties inspector (PROPERTIES / PR)") +
          rb("schedules", "Layers", `data-a="lyr-mgr"`, "Layer Properties Manager (LA)") +
          rb("insulation", "Linetypes", `data-a="lt-mgr"`, "Linetype Manager (LT)") +
          rb("find", "Quick Select", `data-a="qselect"`, "Filter a selection by type / property (QSELECT)") +
          rb("text", "Find Text", `data-a="find"`, "Find and replace text (FIND)") +
          rb("bench", "QuickCalc", `data-a="cal"`, "Open the calculator (CAL / QUICKCALC)"),
        "",
        "",
        "view",
      );
    tools.querySelectorAll<HTMLButtonElement>("[data-t]").forEach((b) => (b.onclick = () => setTool(b.dataset.t as Tool)));

    Object.assign(act, {
      ext: zoomExtents,
      zsel: zoomSelection,
      help: () => toggleHelp(),
      grid: () => {
        showGrid = !showGrid;
        tools.querySelector("[data-a=grid]")!.classList.toggle("on", showGrid);
        updateStatus();
        draw();
      },
      close: () => hooks.requestClose(),
      snap: () => {
        snapOn = !snapOn;
        tools.querySelector("[data-a=snap]")!.classList.toggle("on", snapOn);
        updateStatus();
        draw();
      },
      ortho: () => {
        orthoOn = !orthoOn;
        tools.querySelector("[data-a=ortho]")!.classList.toggle("on", orthoOn);
        updateStatus();
        draw();
      },
      dyn: () => {
        dynOn = !dynOn;
        tools.querySelector("[data-a=dyn]")!.classList.toggle("on", dynOn);
        updateStatus();
        draw();
      },
      lwt: () => {
        lwtOn = !lwtOn;
        tools.querySelector("[data-a=lwt]")!.classList.toggle("on", lwtOn);
        draw();
      },
      undo,
      redo,
      "array-rect": () => executeDrawingCommand("ARRAY"),
      "array-polar": () => executeDrawingCommand("ARRAYPOLAR"),
      erase: eraseSelected,
      plot: openPlot,
      "save-dxf": saveDxf,
      "save-dwg": () => void saveDwg(),
      // Clipboard (Home › Clipboard)
      clipcopy: () => copySelection(),
      clipcut: () => {
        if (copySelection()) eraseSelected();
      },
      clippaste: () => pasteClip(),
      pasteorig: () => pasteOrig(),
      // Annotation / find
      mtext: () => {
        setTool("text");
        logCmd("MTEXT: click to place multiline text.");
      },
      find: () => void findReplace(),
      list: () => showSelectionList(),
      // Insert tab
      import: () => tools.querySelector<HTMLInputElement>("[data-r=importfile]")?.click(),
      "blk-make": () => void createBlockCmd([]),
      "blk-insert": () => void insertBlockCmd(),
      "blk-file": () => tools.querySelector<HTMLInputElement>("[data-r=blockfile]")?.click(),
      "blk-write": () => void wblockCmd(),
      "blk-lib": () => void blockLibraryCmd(),
      "blk-explode": () => explodeSelection(),
      "svg-import": () => tools.querySelector<HTMLInputElement>("[data-r=svgfile]")?.click(),
      "ins-field": () => void fieldCmd(),
      "ins-table": () => setTool("table"),
      takeoff2: () => doTakeoff(),
      info2: () => doInfo(),
      // OpenCADStudio absorption: entity CSV export + LandXML survey import
      dataextract: () => extractEntityCsv(),
      landxmlin: () => xmlPicker?.click(),
      // View tab
      zscale: () => {
        void promptLine("Zoom Scale", "Enter a scale factor (2 = 2×, 0.5 = half)", "2").then((s) => {
          const f = parseFloat(s ?? "");
          if (Number.isFinite(f) && f > 0) {
            pushView();
            view = M.zoomAt(view, view.w / 2, view.h / 2, f);
            draw();
            logCmd(`Zoom scale factor: ${f}`);
          }
        });
      },
      zprev: () => {
        const v = history.pop();
        if (v) {
          view = { ...v, w: view.w, h: view.h };
          draw();
          logCmd("Zoom previous.");
        } else logCmd("No previous view.");
      },
      vsave: () => saveNamedView(),
      vrestore: () => restoreNamedView(),
      ucsworld: () => {
        origin = null;
        draw();
        logCmd("UCS restored to World.");
      },
      // Visual styles
      cmlayer: () => {
        cmode = "layer";
        forceColor = null;
        draw();
      },
      cmbw: () => {
        cmode = "bw";
        forceColor = null;
        draw();
      },
      cminv: () => {
        cmode = "invert";
        forceColor = null;
        draw();
      },
      // Manage tab
      purge: purgeDrawing,
      audit: () => auditDrawing(false),
      regen: () => {
        if (bounds) idx = M.buildIndex(ents, bounds);
        draw();
        logCmd("Regenerating model...");
      },
      lssave: () => saveLayerState(),
      lsrestore: () => restoreLayerState(),
      // Styles panels (Home › Layers / Styles)
      "lyr-mgr": openLayerPropertiesManager,
      "lt-mgr": () => openLinetypeManager(styleApi),
      "ts-mgr": () => openTextStyleManager(styleApi),
      // Annotate › Tables
      tablesize: () => {
        void promptLine("Table Size", "Rows and columns (e.g. 4 5)", `${tableDims.rows} ${tableDims.cols}`).then((s) => {
          const m = (s ?? "").trim().split(/\s+/).map(Number);
          if (m.length === 2 && m.every((n) => Number.isInteger(n) && n > 0 && n <= 50)) {
            tableDims = { rows: m[0], cols: m[1] };
            logCmd(`Next table: ${tableDims.rows} rows × ${tableDims.cols} columns.`);
          }
        });
      },
      // drawing workspace expansion pack: layer isolation + quick edit shortcuts
      layiso: () => executeDrawingCommand("LAYISO"),
      layoff: () => executeDrawingCommand("LAYOFF"),
      layuniso: () => executeDrawingCommand("LAYUNISO"),
      ddedit: () => executeDrawingCommand("DDEDIT"),
      qselect: () => executeDrawingCommand("QSELECT"),
      pedit: () => executeDrawingCommand("PEDIT"),
      "dwg-open": () => executeDrawingCommand("DWGOPEN DWG"),
      "dwg-open-dxf": () => executeDrawingCommand("DWGOPEN DXF"),
      "dwg-jsonimp": () => executeDrawingCommand("DWGJSONIMP"),
      "dwg-rewrite": () => executeDrawingCommand("DWGREWRITE"),
      "dwg-2json": () => executeDrawingCommand("DWG2JSON"),
      "dwg-2svg": () => executeDrawingCommand("DWG2SVG"),
      "dwg-2geojson": () => executeDrawingCommand("DWG2GEOJSON"),
      "dwg-2ps": () => executeDrawingCommand("DWG2PS"),
      "dwg-audit": () => executeDrawingCommand("DWGAUDIT"),
      "dwg-tables": () => executeDrawingCommand("DWGTABLES"),
      "dwg-census": () => executeDrawingCommand("DWGCENSUS"),
      "dwg-thumb": () => executeDrawingCommand("DWGTHUMB"),
    });

    /* ── Parametric / Express Tools / Collaborate actions ── */
    Object.assign(act, {
      // Parametric — one-shot geometric constraints
      "con-auto": () => runAutoConstrain(),
      "con-bar": () => toggleConBar(),
      "con-unfixall": () => unfixAll(),
      "con-hor": () => startConstraint("horizontal"),
      "con-ver": () => startConstraint("vertical"),
      "con-perp": () => startConstraint("perpendicular"),
      "con-par": () => startConstraint("parallel"),
      "con-tan": () => startConstraint("tangent"),
      "con-conc": () => startConstraint("concentric"),
      "con-coin": () => startConstraint("coincident"),
      "con-sym": () => startConstraint("symmetric"),
      "con-eq": () => startConstraint("equal"),
      "con-fix": () => startConstraint("confix"),
      "dc-linear": () => startConstraint("dclinear"),
      "dc-radius": () => startConstraint("dcradius"),
      "dc-dia": () => startConstraint("dcdiameter"),
      "dc-ang": () => startConstraint("dcangular"),
      // Express Tools — modify / layers
      flatten: () => runFlatten(),
      layfrz: () => runLayFrz(),
      laythw: () => runLayThw(),
      laywalk: () => openLayWalk(),
      // Collaborate — publish / share / history / standards
      publish: () => publishAll(),
      shareview: () => shareView(),
      dwghistory: () => openDwgHistory(),
      checkstd: () => openCheckStandards(),
      // Manage — customization
      aliases: () => executeDrawingCommand("KS"),
      "ribbon-min": () => applyCadRibbonMinimized(!ribbonMinimized),
      cleanscreen: () => executeDrawingCommand("CLEANSCREEN"),
      // panel buttons that forward to existing commands
      overkill: () => executeDrawingCommand("OVERKILL"),
      props: () => executeDrawingCommand("PROPERTIES"),
      cal: () => executeDrawingCommand("CAL"),
      dwgversion: () => executeDrawingCommand("DWGVERSION"),
      // AI copilot — opens the shared AI panel docked inside this shell
      aicopilot: () => toggleCadAi(),
      "aicopilot-info": () =>
        askCadAi(
          "Summarize this 2D drawing: name, units, layers, entity counts by type, and anything that looks unfinished or inconsistent.",
        ),
    });

    tools.querySelectorAll<HTMLElement>("button[data-a]").forEach((b) => {
      const f = act[b.dataset.a!];
      if (f) b.onclick = f;
    });

    const importIn = tools.querySelector<HTMLInputElement>("[data-r=importfile]")!;
    importIn.onchange = () => {
      const files = [...(importIn.files ?? [])];
      void (async () => {
        for (const f of files) await mergeCadFile(f);
      })();
      importIn.value = "";
    };

    const blockIn = tools.querySelector<HTMLInputElement>("[data-r=blockfile]");
    if (blockIn) blockIn.onchange = () => {
      const f = blockIn.files?.[0];
      blockIn.value = "";
      if (f) void blockFromFile(f).then((n) => { if (n) void insertBlockCmd(n); });
    };
    const svgIn = tools.querySelector<HTMLInputElement>("[data-r=svgfile]");
    if (svgIn) svgIn.onchange = () => {
      const f = svgIn.files?.[0];
      svgIn.value = "";
      if (f) void importSvgFile(f);
    };

    const sel = (a: string) => tools.querySelector<HTMLSelectElement>(`[data-a=${a}]`)!;
    sel("bg").onchange = (e) => {
      bg = (e.target as HTMLSelectElement).value;
      draw();
    };
    sel("du").onchange = (e) => {
      du = (e.target as HTMLSelectElement).value as M.DisplayUnit;
      showProps();
      draw();
    };
    sel("ecol").onchange = (e) => {
      const v = (e.target as HTMLSelectElement).value;
      applyEntityProps((en) => {
        const { rgb: _rgb, color: _c, ...rest } = en;
        return v === "" ? (rest as DxfEntity) : ({ ...rest, color: Number(v) } as DxfEntity);
      });
      logCmd(v === "" ? "Color: ByLayer" : `Color: ACI ${v}`);
      draw();
    };
    sel("elt").onchange = (e) => {
      const v = (e.target as HTMLSelectElement).value;
      applyEntityProps((en) => {
        const { lineType: _lt, ...rest } = en;
        return v === "" ? (rest as DxfEntity) : ({ ...rest, lineType: v } as DxfEntity);
      });
      logCmd(v === "" ? "Linetype: ByLayer" : `Linetype: ${v}`);
      draw();
    };
  }

  /** Applies a property mutation to the whole selection as one undoable replace. */
  function applyEntityProps(mut: (e: DxfEntity) => DxfEntity): void {
    if (!sel.size) {
      logCmd("Select objects first, then set the property.");
      return;
    }
    const before = [...sel].map((i) => ents[i]).filter((e): e is DxfEntity => !!e);
    if (!before.length) return;
    commitReplace(before, before.map(mut));
  }


  /** drawing workspace-style command prompt for the active tool and stage. */
  function toolPrompt(): string {
    const n = pts.length;
    switch (tool) {
      case "line":
        return n === 0 ? "Specify first point:" : "Specify next point or [Undo]:";
      case "circle":
        if (circleMode === "2p") {
          return n === 0 ? "Specify first end point of diameter:" : "Specify second end point of diameter:";
        }
        if (circleMode === "3p") {
          return n === 0 ? "Specify first point on circle:" : n === 1 ? "Specify second point on circle:" : "Specify third point on circle:";
        }
        return n === 0 ? "Specify center point for circle or [2P/3P]:" : "Specify radius of circle:";
      case "arc":
        return n === 0 ? "Specify start point of arc:" : n === 1 ? "Specify second point of arc:" : "Specify end point of arc:";
      case "rect":
        return n === 0 ? "Specify first corner point:" : "Specify other corner point:";
      case "poly":
      case "cloud":
        return n === 0 ? "Specify start point:" : "Specify next point or [Close/Undo]:";
      case "dist":
        return n === 0 ? "Specify first point:" : "Specify second point:";
      case "area":
      case "chain":
        return n === 0 ? "Specify first point:" : "Specify next point or [Undo]:";
      case "select":
        return "Select objects:";
      case "pan":
        return "Press Esc or Enter to exit, or pan with the mouse:";
      case "erase":
        return "Select objects to erase:";
      case "text":
        return "Specify start point of text:";
      default:
        if (mod) return modPrompt() || "";
        if (pick) return pickPrompt() || "";
        if (tool === "offset") return offsetPrompt() || "";
        return "";
    }
  }

  function showAcadPrompt(msg?: string): void {
    const text = (msg ?? toolPrompt()).trim();
    acadPromptText = text;
    if (text) {
      try {
        logCmd(text);
      } catch {
        /* */
      }
    }
    try {
      updateStatus(cursor ?? undefined);
    } catch {
      /* */
    }
  }

  /**
   * drawing workspace direct distance / radius entry while a tool is waiting for a point.
   * Returns true if the numeric value was consumed.
   */
  function applyDirectDistance(value: number): boolean {
    if (!Number.isFinite(value) || value === 0) return false;
    const abs = Math.abs(value);
    if (tool === "circle" && circleMode === "center" && pts.length === 1) {
      const c = pts[0];
      addDraftEntity({
        type: "CIRCLE",
        layer: currentLayer,
        ...newObjectProps(),
        center: { x: c.x, y: c.y },
        radius: abs,
      });
      logCmd(`Circle added: radius = ${fmt(abs)}`);
      pts = [];
      showAcadPrompt();
      draw();
      return true;
    }
    if (tool === "line" && pts.length >= 1) {
      const a = pts[pts.length - 1];
      const dir = cursor ? { x: cursor.x - a.x, y: cursor.y - a.y } : { x: abs, y: 0 };
      const len = Math.hypot(dir.x, dir.y) || 1;
      const b = { x: a.x + (dir.x / len) * abs, y: a.y + (dir.y / len) * abs };
      addDraftEntity({
        type: "LINE",
        layer: currentLayer,
        ...newObjectProps(),
        start: { x: a.x, y: a.y },
        end: { x: b.x, y: b.y },
      });
      logCmd(`Line added: length = ${fmt(abs)}`);
      pts = [b];
      showAcadPrompt();
      draw();
      return true;
    }
    if (tool === "offset" && offStage === "dist") {
      offDist = abs;
      offStage = "pickObj";
      logCmd(`Offset distance = ${fmt(abs)}`);
      showAcadPrompt();
      return true;
    }
    if (tool === "lengthen" && pick) {
      pick.lenMode = "total";
      pick.lenVal = abs;
      logCmd(`LENGTHEN: total length = ${fmt(abs)}. Select an object:`);
      showAcadPrompt();
      return true;
    }
    if (pendingNumeric) {
      const f = pendingNumeric;
      pendingNumeric = null;
      f(value);
      return true;
    }
    return false;
  }

  /** End the current drawing command (Enter / space when no distance applies). */
  function endCurrentCommand(): void {
    if (tool === "line" || tool === "poly" || tool === "cloud" || tool === "spline" || tool === "wipeout" || tool === "area" || tool === "chain") {
      if (pts.length >= 2 && (tool === "poly" || tool === "cloud" || tool === "area" || tool === "chain" || tool === "spline" || tool === "wipeout")) {
        try {
          finishMeasure();
        } catch {
          /* */
        }
      }
      pts = [];
      setTool("select");
      logCmd("Command: *Cancel*");
      return;
    }
    if (tool === "circle" || tool === "arc" || tool === "rect" || tool === "ellipse" || tool === "donut" || tool === "polygon") {
      pts = [];
      setTool("select");
      logCmd("Command: *Cancel*");
      return;
    }
    if (tool !== "select") {
      setTool("select");
    }
  }

  function setTool(t: Tool) {
    clearModState();
    clearPickState();
    matchSrc = null;
    tool = t;
    if (t !== "circle") circleMode = "center";
    cv.focus({ preventScroll: true });
    pts = [];
    offsetEntity = -1;
    winStart = winNow = null;
    hover = null;
    tools.querySelectorAll<HTMLButtonElement>("[data-t]").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
    cv.style.cursor = t === "pan" ? "grab" : "crosshair";
    if (isModTool(t)) {
      if (t === "paste") {
        // Super Copy placement: the clipboard ghosts onto the cursor immediately
        // (drawing workspace PASTECLIP). The style carry-over is applied once per session,
        // before the first placement, so even the ghost renders true.
        const place = pendingPlacement;
        pendingPlacement = null;
        if (place) {
          mod = { kind: "paste", stage: "second", ghostOf: [], base: place.base, ref: null, pasteSrc: place.entities, carried: true, placedCount: 0, placeLabel: place.label };
          logCmd(`Command: _${place.label} — click to place, click again for more, Enter / Esc to finish.`);
          draw();
          return;
        }
        if (!clip || !clip.entities.length) {
          logCmd("PASTECLIP: clipboard is empty — COPYCLIP objects in any drawing tab first (Ctrl+C / Ctrl+Shift+C).");
          tool = "select";
          tools.querySelectorAll<HTMLButtonElement>("[data-t]").forEach((b) => b.classList.toggle("on", b.dataset.t === "select"));
          draw();
          return;
        }
        const anchor = cursor ?? M.screenToWorld(view, view.w / 2, view.h / 2);
        mod = { kind: "paste", stage: "second", ghostOf: [], base: { x: anchor.x, y: anchor.y }, ref: null, pasteSrc: clip.entities, carried: false, placedCount: 0 };
        logCmd(`Command: _PASTECLIP — ${clip.entities.length} object(s)${clip.sourceName ? ` from ${clip.sourceName}` : ""}. ${modPrompt()}`);
      } else {
        // Noun–verb: an existing selection skips the Select objects stage.
        mod = { kind: t, stage: sel.size ? "base" : "select", ghostOf: [...sel], base: null, ref: null };
        logCmd(`Command: _${t.toUpperCase()} ${modPrompt()}`);
      }
    } else if (t === "offset") {
      offStage = offDist == null ? "dist" : "pickObj";
      pendingNumeric = (d) => {
        offDist = Math.abs(d);
        offStage = "pickObj";
        pendingNumeric = null;
        logCmd(`Offset distance = ${fmt(offDist)}`);
        logCmd("Select object to offset:");
      };
      logCmd(`Command: _OFFSET ${offsetPrompt()}`);
    } else if (isPickTool(t)) {
      startPick(t);
      logCmd(`Command: _${t.toUpperCase()}`);
    } else if (t === "spline" || t === "wipeout" || t === "cloud") {
      logCmd(`Command: _${t.toUpperCase()} — click points, Enter / double-click to finish`);
    } else if (t === "polygon") {
      logCmd(`Command: _POLYGON — ${polySides} sides (type POLYGON <n> to change)`);
    } else {
      logCmd(`Command: _${t.toUpperCase()}`);
    }
    draw();
    showAcadPrompt();
  }

  function finishMeasure() {
    if (tool === "poly" && pts.length >= 2) {
      results.push(`Polyline: ${fmt(M.pathLength(pts))}`);
      // Also add drafted polyline entity
      addDraftEntity({
        type: "LWPOLYLINE",
        layer: currentLayer, ...newObjectProps(),
        points: pts.map((p) => ({ x: p.x, y: p.y })),
        closed: false,
      });
      drawn.push({ kind: "poly", pts: [...pts] });
    } else if (tool === "area" && pts.length >= 3) {
      results.push(`Area: ${fmt(M.polygonArea(pts), 2)}  Perimeter: ${fmt(M.pathLength(pts, true))}`);
      drawn.push({ kind: "area", pts: [...pts] });
    } else if (tool === "chain" && pts.length >= 2) {
      results.push(`Chain: ${fmt(M.pathLength(pts))}  (${pts.length - 1} segments)`);
      drawn.push({ kind: "poly", pts: [...pts] });
    } else if (tool === "cloud" && pts.length >= 2) {
      // Store revision clouds as native closed polylines, not transient markup,
      // so they participate in selection, COPY/MOVE, undo/redo, DXF and DWG export.
      const boundary = [...pts, pts[0]];
      const cloudPoints = M.revisionCloudPoints(boundary);
      if (cloudPoints.length >= 3) {
        addDraftEntity({
          type: "LWPOLYLINE",
          layer: currentLayer,
          ...newObjectProps(),
          points: cloudPoints.map((p) => ({ x: p.x, y: p.y })),
          closed: true,
        });
        results.push(`Revision cloud · ${pts.length} boundary points`);
        logCmd("Revision cloud created as a native closed polyline.");
      } else {
        logCmd("Revision cloud needs at least two distinct boundary points.");
      }
    } else if (tool === "spline" && pts.length >= 2) {
      addDraftEntity({
        type: "LWPOLYLINE",
        layer: currentLayer, ...newObjectProps(),
        points: X.catmullRom(pts),
        closed: false,
      });
      results.push(`Spline · ${pts.length} fit points, ${X.catmullRom(pts).length} segment vertices`);
      logCmd(`Spline added through ${pts.length} points.`);
    } else if (tool === "wipeout" && pts.length >= 3) {
      addDraftEntity({
        type: "LWPOLYLINE",
        layer: currentLayer, ...newObjectProps(),
        points: [...pts],
        closed: true,
        hatch: { solid: true, loops: [[...pts]], wipeout: true },
      });
      results.push(`Wipeout · ${pts.length}-sided mask`);
      logCmd("Wipeout frame added — masks everything behind it.");
    }
    pts = [];
    showMeas();
    draw();
  }

  /* ── Canvas Input Handlers ── */
  const rawPoint = (ev: PointerEvent | MouseEvent): { sp: M.Pt; wp: M.Pt } => {
    const r = cv.getBoundingClientRect();
    const sp = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    return { sp, wp: M.screenToWorld(view, sp.x, sp.y) };
  };

  const snapped = (wp: M.Pt): M.Snap | null => {
    if (!idx || !snapOn) return null;
    // drawing workspace: when a point is already picked, enable PERP against that base
    const from = pts.length ? pts[pts.length - 1] : mod?.base ? mod.base : null;
    return M.findSnap(idx, ents, wp.x, wp.y, 14 / view.scale, [...snapModes], visible, from);
  };

  cv.addEventListener("pointerdown", (ev) => {
    if (!doc) return;
    cv.focus();
    const { sp, wp } = rawPoint(ev);
    lastPointerScreen = sp;
    ptrs.set(ev.pointerId, sp);

    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
      dragging = null;
      press = null;
      return;
    }

    const capture = (id: number): void => {
      try {
        cv.setPointerCapture(id);
      } catch {
        /* synthetic / already-released pointers */
      }
    };

    if (ev.button === 1 || (ev.button === 2 && tool === "pan")) {
      ev.preventDefault();
      dragging = { x: sp.x, y: sp.y };
      capture(ev.pointerId);
      cv.style.cursor = "grabbing";
      pushView();
      return;
    }

    if (ev.button !== 0) return;

    // drawing workspace SELECT: left-click drag always starts a selection rectangle.
    // Left → right  = WINDOW (solid blue) — only entities fully inside
    // Right → left  = CROSSING (dotted green) — any entity that touches the box
    // Shift/Ctrl adds to the current selection. Pan is middle-button or PAN tool only.
    if (tool === "box" || tool === "select") {
      // Grip editing: a click on a hotspot of the selection starts a grip drag
      // (drawing workspace blue-grip behaviour) instead of a rubber band.
      if (!mod && !pick) {
        const g = gripAt(sp);
        if (g && ents[g.i]) {
          const w0 = M.screenToWorld(view, sp.x, sp.y);
          gripDrag = { i: g.i, gi: g.gi, orig: ents[g.i], startW: { x: w0.x, y: w0.y }, moved: false };
          gripHover = null;
          capture(ev.pointerId);
          cv.style.cursor = "grabbing";
          return;
        }
      }
      press = {
        x: sp.x,
        y: sp.y,
        moved: false,
        id: ev.pointerId,
        band: true,
        add: ev.shiftKey || ev.ctrlKey,
      };
      capture(ev.pointerId);
      return;
    }
    if (tool === "pan") {
      press = { x: sp.x, y: sp.y, moved: false, id: ev.pointerId };
      capture(ev.pointerId);
      return;
    }
    if (tool === "zoomwin") {
      winStart = winNow = sp;
      capture(ev.pointerId);
      return;
    }

    // drawing workspace Modify tools (MOVE / COPY / ROTATE / MIRROR / SCALE / OFFSET)
    if (isModTool(tool) || tool === "offset") {
      const s2 = snapped(wp) ?? { ...wp, kind: "nearest" as M.SnapKind };
      let mp: M.Pt = { x: s2.x, y: s2.y };
      if (orthoOn && mod?.base && mod.stage === "second") mp = M.orthoConstrain(mod.base, mp);
      if (onModPointerDown(mp)) {
        draw();
        return;
      }
    }

    // Staged cutting tools (TRIM / EXTEND / BREAK / FILLET / CHAMFER / JOIN /
    // STRETCH / ALIGN / MATCHLAYER)
    if (isPickTool(tool) && pick && onPickClick(wp)) {
      draw();
      return;
    }

    const s = snapped(wp) ?? { ...wp, kind: "nearest" as M.SnapKind };
    let p = { x: s.x, y: s.y };
    if (orthoOn && pts.length >= 1) p = M.orthoConstrain(pts[pts.length - 1], p);

    switch (tool) {
      case "line": {
        pts.push(p);
        if (pts.length === 2) {
          addDraftEntity({
            type: "LINE",
            layer: currentLayer, ...newObjectProps(),
            start: { x: pts[0].x, y: pts[0].y },
            end: { x: pts[1].x, y: pts[1].y },
          });
          logCmd(`Line added: length = ${fmt(M.distance(pts[0], pts[1]))}`);
          pts = [p]; // Chain next line like drawing workspace
        }
        showAcadPrompt();
        break;
      }
      case "circle": {
        pts.push(p);
        if (circleMode === "2p" && pts.length === 2) {
          const [a, b] = pts;
          const cx = (a.x + b.x) / 2,
            cy = (a.y + b.y) / 2;
          const r = M.distance(a, b) / 2;
          if (r > 1e-12) {
            addDraftEntity({
              type: "CIRCLE",
              layer: currentLayer,
              ...newObjectProps(),
              center: { x: cx, y: cy },
              radius: r,
            });
            logCmd(`Circle added (2P): diameter = ${fmt(2 * r)}`);
          }
          pts = [];
          showAcadPrompt();
        } else if (circleMode === "3p" && pts.length === 3) {
          const [a, b, c] = pts;
          // Circumcircle of triangle abc
          const D = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
          if (Math.abs(D) > 1e-12) {
            const a2 = a.x * a.x + a.y * a.y,
              b2 = b.x * b.x + b.y * b.y,
              c2 = c.x * c.x + c.y * c.y;
            const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / D;
            const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / D;
            const r = Math.hypot(ux - a.x, uy - a.y);
            addDraftEntity({
              type: "CIRCLE",
              layer: currentLayer,
              ...newObjectProps(),
              center: { x: ux, y: uy },
              radius: r,
            });
            logCmd(`Circle added (3P): radius = ${fmt(r)}`);
          } else logCmd("CIRCLE 3P: points are collinear.");
          pts = [];
          showAcadPrompt();
        } else if (circleMode === "center" && pts.length === 2) {
          const r = M.distance(pts[0], pts[1]);
          addDraftEntity({
            type: "CIRCLE",
            layer: currentLayer,
            ...newObjectProps(),
            center: { x: pts[0].x, y: pts[0].y },
            radius: r,
          });
          logCmd(`Circle added: radius = ${fmt(r)}`);
          pts = [];
          showAcadPrompt();
        } else {
          showAcadPrompt();
        }
        break;
      }
      case "rect": {
        pts.push(p);
        if (pts.length === 2) {
          const p1 = pts[0],
            p2 = pts[1];
          addDraftEntity({
            type: "LWPOLYLINE",
            layer: currentLayer, ...newObjectProps(),
            points: [
              { x: p1.x, y: p1.y },
              { x: p2.x, y: p1.y },
              { x: p2.x, y: p2.y },
              { x: p1.x, y: p2.y },
            ],
            closed: true,
          });
          logCmd(`Rectangle added: ${fmt(Math.abs(p2.x - p1.x))} × ${fmt(Math.abs(p2.y - p1.y))}`);
          pts = [];
        }
        break;
      }
      case "dist": {
        pts.push(p);
        if (pts.length === 2) {
          const d = M.distance(pts[0], pts[1]);
          const ang = M.norm360Deg(pts[0], pts[1]);
          const msg = `Distance = ${fmt(d)}, Angle in XY Plane = ${ang.toFixed(2)}°, Delta X = ${fmt(
            Math.abs(pts[1].x - pts[0].x),
          )}, Delta Y = ${fmt(Math.abs(pts[1].y - pts[0].y))}`;
          results.push(msg);
          drawn.push({ kind: "dist", pts: [...pts] });
          pts = [];
          showMeas();
          logCmd(msg);
        }
        break;
      }
      case "dim":
      case "dimlinear": {
        pts.push(p);
        if (pts.length === 2) {
          const dx = Math.abs(pts[1].x - pts[0].x), dy = Math.abs(pts[1].y - pts[0].y);
          const measured = tool === "dimlinear" ? Math.max(dx, dy) : M.distance(pts[0], pts[1]);
          if (measured < 1e-9) { logCmd("Dimension: points must be different."); pts = []; break; }
          logCmd("Specify dimension line location (third point):");
          showAcadPrompt();
        } else if (pts.length === 3) {
          const first = pts[0], second = pts[1], placement = pts[2];
          const dx = Math.abs(second.x - first.x), dy = Math.abs(second.y - first.y);
          const measured = tool === "dimlinear" ? Math.max(dx, dy) : M.distance(first, second);
          const value = M.convertLength(measured * scaleCal, doc.units, du);
          const label = fmt(value), unit = M.unitLabel(doc.units, du);
          const entities = buildLinearDimension({
            first, second, placement, mode: tool === "dimlinear" ? "linear" : "aligned",
            layer: currentLayer, text: unit === "units" ? label : label + " " + unit,
            textHeight: Math.max(1e-6, M.convertLength(2.5, "mm", doc.units === "unitless" ? "drawing" : (doc.units ?? "mm"))),
          });
          if (entities.length) {
            addEntities(entities);
            results.push("Dimension: " + label + " " + unit);
            drawn.push({ kind: "dist", pts: [first, second] });
            logCmd((tool === "dimlinear" ? "DIMLINEAR" : "DIMALIGNED") + ": " + label + " " + unit + ". Dimension placed.");
          } else logCmd("Dimension could not be created — check the picked points.");
          pts = [];
          showMeas();
        }
        break;
      }
      case "coord": {
        const u = M.unitLabel(doc.units, du);
        const msg = `Point: X = ${M.convertLength(p.x * scaleCal, doc.units, du).toFixed(4)} ${u}, Y = ${M.convertLength(
          p.y * scaleCal,
          doc.units,
          du,
        ).toFixed(4)} ${u}, Z = 0.0000`;
        results.push(msg);
        drawn.push({ kind: "coord", pts: [p] });
        showMeas();
        logCmd(msg);
        break;
      }
      case "poly":
      case "area":
      case "chain":
      case "cloud":
        pts.push(p);
        break;
      case "angle":
        pts.push(p);
        if (pts.length === 3) {
          const a = M.angleAt(pts[1], pts[0], pts[2]);
          results.push(`Angle: ${a.toFixed(2)}°`);
          drawn.push({ kind: "angle", pts: [...pts] });
          pts = [];
          showMeas();
        }
        break;
      case "radius": {
        pts.push(p);
        if (pts.length === 2) {
          const r = M.distance(pts[0], pts[1]);
          results.push(`Radius = ${fmt(r)}`);
          drawn.push({ kind: "dist", pts: [...pts] });
          pts = [];
          showMeas();
          logCmd(`Radius = ${fmt(r)}`);
        }
        break;
      }
      case "arc": {
        pts.push(p);
        if (pts.length === 3) {
          const p1 = pts[0], p2 = pts[1], p3 = pts[2];
          const ax = p1.x, ay = p1.y, bx = p2.x, by = p2.y, cx = p3.x, cy = p3.y;
          const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
          if (Math.abs(d) > 1e-9) {
            const ux = ((ax*ax+ay*ay)*(by-cy) + (bx*bx+by*by)*(cy-ay) + (cx*cx+cy*cy)*(ay-by)) / d;
            const uy = ((ax*ax+ay*ay)*(cx-bx) + (bx*bx+by*by)*(ax-cx) + (cx*cx+cy*cy)*(bx-ax)) / d;
            const radius = Math.hypot(ax-ux, ay-uy);
            const aStart = (Math.atan2(ay-uy, ax-ux) * 180) / Math.PI;
            const aEnd = (Math.atan2(cy-uy, cx-ux) * 180) / Math.PI;
            addDraftEntity({ type: "ARC", layer: currentLayer, ...newObjectProps(), center: { x: ux, y: uy }, radius, startAngle: aStart, endAngle: aEnd });
            logCmd(`Arc added: R=${fmt(radius)}`);
          }
          pts = [];
        }
        break;
      }
      case "note": {
        const notePt = p;
        void promptLine("Text note", "Enter text note", "Note").then((t) => {
          if (t) {
            markups.push({ kind: "note", pts: [notePt], text: t });
            results.push(`Note: ${t}`);
            showMeas();
          }
          draw();
        });
        break;
      }
      case "leader": {
        pts.push(p);
        if (pts.length === 2) {
          const leaderPts = [...pts];
          pts = [];
          void promptLine("Leader", "Enter leader text", "").then((t) => {
            if (t) {
              markups.push({ kind: "leader", pts: leaderPts, text: t });
              results.push(`Leader: ${t}`);
              showMeas();
            }
            draw();
          });
        }
        break;
      }
      case "calibrate": {
        pts.push(p);
        if (pts.length === 2) {
          const cur = M.distance(pts[0], pts[1]);
          pts = [];
          void promptLine("Calibrate", "Enter known real distance for calibration", cur.toFixed(3)).then((knownStr) => {
            if (knownStr) {
              const known = parseFloat(knownStr);
              if (!isNaN(known) && known > 0 && cur > 0) {
                scaleCal = scaleCal * (known / cur);
                results.push(`Calibrated: 1 drawing unit = ${scaleCal.toFixed(4)} real units`);
                showMeas();
                logCmd(`Calibrated: scale factor = ${scaleCal.toFixed(4)}`);
              }
            }
            draw();
          });
        }
        break;
      }
      case "text": {
        void placeText(styleApi, p);
        break;
      }
      case "match": {
        const mi = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, visible) : -1;
        if (mi < 0) break;
        if (!matchSrc) {
          matchSrc = ents[mi];
          logCmd("MATCHPROP: source selected. Click destination objects (Esc to finish).");
        } else if (ents[mi] !== matchSrc) {
          matchProperties(styleApi, matchSrc, [mi]);
        }
        break;
      }
      case "erase": {
        const i = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, visible) : -1;
        if (i >= 0) {
          setSel([i]);
          eraseSelected();
        }
        break;
      }
      case "polygon": {
        pts.push(p);
        if (pts.length === 2) {
          const r = M.distance(pts[0], pts[1]);
          addDraftEntity({
            type: "LWPOLYLINE",
            layer: currentLayer, ...newObjectProps(),
            points: X.polygonLoop(pts[0].x, pts[0].y, r, polySides),
            closed: true,
          });
          logCmd(`Polygon added: ${polySides} sides, R = ${fmt(r)}`);
          pts = [];
        }
        break;
      }
      case "spline":
      case "wipeout":
        pts.push(p);
        break;
      case "ellipse": {
        pts.push(p);
        if (pts.length === 3) {
          const [c, a1, a2] = pts;
          const rx = M.distance(c, a1);
          // second axis: perpendicular distance from a2 to the line c→a1
          const ang = Math.atan2(a1.y - c.y, a1.x - c.x);
          const dx = a2.x - c.x,
            dy = a2.y - c.y;
          const perp = -dx * Math.sin(ang) + dy * Math.cos(ang);
          const ry = Math.abs(perp);
          if (rx > 1e-9 && ry > 1e-9) {
            addDraftEntity({
              type: "LWPOLYLINE",
              layer: currentLayer, ...newObjectProps(),
              points: X.ellipseLoop(c.x, c.y, rx, ry),
              closed: true,
            });
            logCmd(`Ellipse added: ${fmt(2 * rx)} × ${fmt(2 * ry)}`);
          }
          pts = [];
        }
        break;
      }
      case "donut": {
        pts.push(p);
        if (pts.length === 2) {
          const rOut = M.distance(pts[0], pts[1]);
          const rIn = rOut * 0.5;
          const [outer, inner] = X.donutLoops(pts[0].x, pts[0].y, rOut, rIn);
          addDraftEntity({
            type: "LWPOLYLINE",
            layer: currentLayer, ...newObjectProps(),
            points: outer,
            closed: true,
            hatch: { solid: true, pattern: "SOLID", loops: [outer, inner], wipeout: false },
          });
          logCmd(`Donut added: outer ${fmt(2 * rOut)}, inner ${fmt(2 * rIn)}`);
          pts = [];
        }
        break;
      }
      case "point": {
        addDraftEntity({ type: "POINT", layer: currentLayer, ...newObjectProps(), position: { x: p.x, y: p.y } });
        logCmd(`Point at ${fmt(p.x)}, ${fmt(p.y)}`);
        break;
      }
      case "hatch": {
        const hi = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, visible) : -1;
        if (hi < 0) {
          logCmd("0 found — pick a closed polyline to hatch.");
          break;
        }
        const e = ents[hi];
        if (e.type !== "LWPOLYLINE" || !e.closed) {
          logCmd("HATCH: that object is not a closed polyline.");
          break;
        }
        const after: DxfEntity = e.hatch
          ? { ...e, hatch: undefined }
          : { ...e, hatch: { solid: true, pattern: "SOLID", loops: [e.points] } };
        commitReplace([e], [after]);
        logCmd(e.hatch ? "HATCH: hatch removed (toggle)." : "HATCH: solid hatch applied.");
        break;
      }
      case "xline": {
        pts.push(p);
        if (pts.length === 2) {
          const [a, b] = pts;
          const dx = b.x - a.x,
            dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const R = 1e6;
          addDraftEntity({
            type: "LINE",
            layer: currentLayer, ...newObjectProps(),
            start: { x: a.x - (dx / len) * R, y: a.y - (dy / len) * R },
            end: { x: a.x + (dx / len) * R, y: a.y + (dy / len) * R },
          });
          logCmd("XLine added: infinite construction line.");
          pts = [];
        }
        break;
      }
      case "ray": {
        pts.push(p);
        if (pts.length === 2) {
          const [a, b] = pts;
          const dx = b.x - a.x,
            dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const R = 1e6;
          addDraftEntity({
            type: "LINE",
            layer: currentLayer, ...newObjectProps(),
            start: { x: a.x, y: a.y },
            end: { x: a.x + (dx / len) * R, y: a.y + (dy / len) * R },
          });
          logCmd("Ray added: one-sided construction ray.");
          pts = [];
        }
        break;
      }
      case "dimang": {
        pts.push(p);
        if (pts.length === 3) {
          const [v, a, b] = pts;
          const ang = M.angleAt(v, a, b);
          markups.push({ kind: "dimang", pts: [v, a, b], text: `${ang.toFixed(2)}°` });
          results.push(`Angular dimension: ${ang.toFixed(2)}°`);
          pts = [];
          showMeas();
        }
        break;
      }
      case "dimarc": {
        const ai = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, visible) : -1;
        if (ai >= 0) {
          const e = ents[ai];
          if (e.type === "ARC") {
            const sweep = ((e.endAngle - e.startAngle) % 360 + 360) % 360 || 360;
            const len = (sweep * Math.PI * e.radius) / 180;
            const mid = e.startAngle + sweep / 2;
            const sm = { x: e.center.x + e.radius * Math.cos((e.startAngle * Math.PI) / 180), y: e.center.y + e.radius * Math.sin((e.startAngle * Math.PI) / 180) };
            const em = { x: e.center.x + e.radius * Math.cos((e.endAngle * Math.PI) / 180), y: e.center.y + e.radius * Math.sin((e.endAngle * Math.PI) / 180) };
            markups.push({ kind: "dimarc", pts: [e.center, sm, em], text: `${fmt(len)}` });
            results.push(`Arc length: ${fmt(len)}`);
            showMeas();
          } else logCmd("DIMARC: pick an arc.");
        }
        break;
      }
      case "dimdia": {
        const di = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, visible) : -1;
        if (di >= 0) {
          const e = ents[di];
          if (e.type === "CIRCLE" || e.type === "ARC") {
            const len = Math.hypot(wp.x - e.center.x, wp.y - e.center.y) || 1;
            const edge = { x: e.center.x + (e.radius * (wp.x - e.center.x)) / len, y: e.center.y + (e.radius * (wp.y - e.center.y)) / len };
            markups.push({ kind: "dimdia", pts: [e.center, edge], text: `⌀${fmt(2 * e.radius)}` });
            results.push(`Diameter: ${fmt(2 * e.radius)}`);
            showMeas();
          } else logCmd("DIMDIAMETER: pick a circle or arc.");
        }
        break;
      }
      case "dimcenter": {
        const ci = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, visible) : -1;
        if (ci >= 0) {
          const e = ents[ci];
          if (e.type === "CIRCLE" || e.type === "ARC") {
            markups.push({ kind: "dimcenter", pts: [e.center], text: "" });
            logCmd("DIMCENTER: center mark placed.");
          } else logCmd("DIMCENTER: pick a circle or arc.");
        }
        break;
      }
      case "dimcont": {
        pts.push(p);
        if (pts.length === 2) {
          markups.push({ kind: "dim", pts: [...pts], text: fmt(M.distance(pts[0], pts[1])) });
          results.push(`Continued dimension: ${fmt(M.distance(pts[0], pts[1]))}`);
          pts = [p]; // chain from the last point like DIMCONTINUE
          showMeas();
        }
        break;
      }
      case "dimbase": {
        pts.push(p);
        if (pts.length === 2) {
          markups.push({ kind: "dim", pts: [...pts], text: fmt(M.distance(pts[0], pts[1])) });
          results.push(`Baseline dimension: ${fmt(M.distance(pts[0], pts[1]))}`);
          pts = [pts[0]]; // measure from the same baseline origin
          showMeas();
        }
        break;
      }
      case "explode": {
        explodeSelection();
        setTool("select");
        break;
      }
      case "table": {
        pts.push(p);
        if (pts.length === 2) {
          const [t1, t2] = pts;
          const cols = tableDims.cols,
            rows = tableDims.rows;
          const w = (t2.x - t1.x) / cols,
            h = (t2.y - t1.y) / rows;
          const list: DxfEntity[] = [];
          for (let c = 0; c <= cols; c++)
            list.push({ type: "LINE", layer: currentLayer, start: { x: t1.x + c * w, y: t1.y }, end: { x: t1.x + c * w, y: t2.y } });
          for (let r = 0; r <= rows; r++)
            list.push({ type: "LINE", layer: currentLayer, start: { x: t1.x, y: t1.y + r * h }, end: { x: t2.x, y: t1.y + r * h } });
          const hh = Math.min(Math.abs(h) * 0.6, Math.max(1e-6, Math.abs(w) * 0.5));
          for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++)
              list.push({
                type: "TEXT",
                layer: currentLayer,
                position: { x: t1.x + (c + 0.08) * w, y: t1.y + (r + 0.5) * h },
                height: hh,
                value: `${r + 1},${c + 1}`,
              });
          addEntities(list);
          logCmd(`Table added: ${rows} rows × ${cols} columns (TABLE <rows> <cols> to change).`);
          pts = [];
        }
        break;
      }
      default:
        break;
    }
    draw();
  });

  cv.addEventListener("pointermove", (ev) => {
    const { sp, wp } = rawPoint(ev);
    lastPointerScreen = sp;
    if (ptrs.has(ev.pointerId)) ptrs.set(ev.pointerId, sp);

    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0 && d > 0) {
        view = M.zoomAt(view, (a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch);
        draw();
      }
      pinch = d;
      return;
    }

    if (press && press.id === ev.pointerId) {
      if (press.band) {
        if (Math.hypot(sp.x - press.x, sp.y - press.y) > 4) {
          press.moved = true;
          rband = { a: { x: press.x, y: press.y }, b: sp };
          draw();
        }
        return;
      }
      if (!press.moved && Math.hypot(sp.x - press.x, sp.y - press.y) > 4) {
        press.moved = true;
        pushView();
        cv.style.cursor = "grabbing";
        dragging = { x: press.x, y: press.y };
      }
    }

    if (dragging) {
      view = M.panBy(view, sp.x - dragging.x, sp.y - dragging.y);
      dragging = { x: sp.x, y: sp.y };
      draw();
      updateStatus(wp);
      return;
    }

    if (winStart) {
      winNow = sp;
      draw();
      return;
    }

    hover = snapped(wp);
    let cur = hover ? { x: hover.x, y: hover.y } : wp;
    if (orthoOn && pts.length >= 1) cur = M.orthoConstrain(pts[pts.length - 1], cur);
    cursor = cur;
    if (mod) updateModGhost(cur);
    // Grip drag: live update of the dragged object (committed with undo on release).
    if (gripDrag) {
      const e = ents[gripDrag.i];
      if (e) {
        let to: M.Pt = { x: cur.x, y: cur.y };
        if (ev.shiftKey) to = M.orthoConstrain(gripDrag.startW, to);
        const moved = M.applyGripDrag(e, gripDrag.gi, to);
        if (moved) ents[gripDrag.i] = moved;
        gripDrag.moved = true;
      }
      draw();
      return;
    }
    // LENGTHEN dynamic: stretch preview follows the cursor.
    if (pick && pick.kind === "lengthen" && pick.stage === "newend") {
      const e = ents[pick.obj];
      pick.ghost = e ? X.lengthenTo(e, pick.nearEnd, cur) : null;
    }
    // Grip hover highlight (unselected tool state only — cheap cap keeps it that way).
    gripHover = !mod && !pick && (tool === "select" || tool === "box") ? gripAt(sp) : null;
    updateStatus(cursor);
    draw();
  });

  /** Enter / right-click during a staged pick op: confirm stages, finish JOIN. */
  function confirmPickStep(): void {
    if (!pick) return;
    if ((pick.kind === "trim" || pick.kind === "extend") && pick.stage === "edges") {
      pick.stage = "targets";
      sel.clear();
      selected = -1;
      showProps();
      logCmd(pickPrompt());
      draw();
      return;
    }
    if (pick.kind === "join") {
      finishJoin();
      return;
    }
  }

  // Right-click = Enter (drawing workspace: confirm selection / accept defaults)
  cv.addEventListener("contextmenu", (ev) => {
    if (pick) { ev.preventDefault(); confirmPickStep(); return; }
    if (mod) { ev.preventDefault(); confirmModStep(); return; }
    if (tool === "offset" && offStage === "pickSide") {
      ev.preventDefault();
      offStage = "pickObj";
      offTarget = -1;
      sel.clear();
      selected = -1;
      showProps();
      logCmd("Select object to offset:");
      draw();
      return;
    }
    // In idle selection mode, right-click opens the complete CAD context menu.
    if (tool === "select") { showCadContextMenu(ev); return; }
    ev.preventDefault();
  });

  const endDrag = (ev: PointerEvent) => {
    ptrs.delete(ev.pointerId);
    if (ptrs.size < 2) pinch = 0;
    // Grip drag release: commit as a single modify undo action (drawing workspace grip edit).
    if (gripDrag) {
      const after = ents[gripDrag.i];
      if (gripDrag.moved && after && after !== gripDrag.orig) {
        undoStack.push({ type: "modify", before: [gripDrag.orig], after: [after] });
        markDirty();
        redoStack.length = 0;
        const nb = M.entityBBox(after);
        if (nb) bounds = bounds ? M.unionBBox(bounds, nb) : nb;
        rebuildIndex();
        showProps();
        logCmd("Grip edit: object updated (Ctrl+Z to undo).");
      } else {
        ents[gripDrag.i] = gripDrag.orig; // click without drag — nothing changed
      }
      gripDrag = null;
      cv.style.cursor = tool === "pan" ? "grab" : "crosshair";
      draw();
      return;
    }
    if (press && press.id === ev.pointerId) {
      if (press.band && press.moved && rband && idx && ev.type === "pointerup") {
        // Screen X direction decides mode (drawing workspace): L→R window, R→L crossing
        const isWindow = rband.b.x >= rband.a.x;
        const mode: "window" | "crossing" = isWindow ? "window" : "crossing";
        const a = M.screenToWorld(view, rband.a.x, rband.a.y);
        const b = M.screenToWorld(view, rband.b.x, rband.b.y);
        const rect = M.rectOf(a, b);
        // Ignore tiny accidental drags (treat as click)
        const screenW = Math.abs(rband.b.x - rband.a.x);
        const screenH = Math.abs(rband.b.y - rband.a.y);
        if (screenW >= 4 || screenH >= 4) {
          const ids = M.selectInRect(idx, ents, rect, mode, visible);
          setSel(ids, !!press.add);
          logCmd(
            isWindow
              ? `Window selected ${ids.length} object(s) (fully inside)`
              : `Crossing selected ${ids.length} object(s) (any touch)`,
          );
        } else {
          const { wp } = rawPoint(ev);
          const i = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 8 / view.scale, visible) : -1;
          if (i >= 0) setSel([i], !!press.add);
          else if (!press.add) setSel([]);
        }
      } else if (!press.moved && doc && ev.type === "pointerup") {
        const { wp } = rawPoint(ev);
        const i = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 8 / view.scale, visible) : -1;
        if (i >= 0) setSel([i], !!press.add);
        else if (!press.add) setSel([]);
      }
      rband = null;
      draw();
      press = null;
      cv.style.cursor = tool === "pan" ? "grab" : "crosshair";
    }
    if (dragging) {
      dragging = null;
      cv.style.cursor = tool === "pan" ? "grab" : "crosshair";
    }
    if (winStart && winNow) {
      const a = winStart,
        b = winNow;
      winStart = winNow = null;
      if (Math.abs(a.x - b.x) > 6 && Math.abs(a.y - b.y) > 6) {
        pushView();
        view = M.zoomWindow(view, a, b);
      }
      draw();
    }
    try {
      cv.releasePointerCapture(ev.pointerId);
    } catch {
      /* noop */
    }
  };

  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);

  cv.addEventListener("dblclick", () => {
    if (tool === "poly" || tool === "area" || tool === "chain" || tool === "cloud" || tool === "spline" || tool === "wipeout") {
      pts.pop();
      finishMeasure();
    }
  });

  cv.addEventListener("wheel", (ev) => {
    if (!doc) return;
    ev.preventDefault();
    const { sp } = rawPoint(ev);
    view = M.zoomAt(
      view,
      sp.x,
      sp.y,
      Math.exp(-Math.max(-300, Math.min(300, ev.deltaY * (ev.deltaMode === 1 ? 16 : 1))) * 0.0018),
    );
    draw();
    updateStatus();
  }, { passive: false });

  /**
   * Full session cancel (Esc): exit every tool/command, drop in-progress points,
   * clear selection and prompts — back to idle SELECT. One Esc is enough.
   */
  function resetDrawingSession(reason = "Esc"): void {
    try {
      closeDynamicCommand();
    } catch {
      /* */
    }
    try {
      closeOverlay();
    } catch {
      /* */
    }
    try {
      clearPickState();
    } catch {
      /* */
    }
    try {
      clearModState();
    } catch {
      /* */
    }
    matchSrc = null;
    circleMode = "center";
    acadPromptText = "";
    pendingNumeric = null;
    pendingYesNo = null;
    offStage = "dist";
    offTarget = -1;
    offPick = null;
    offsetEntity = -1;
    offDist = null;
    pts = [];
    winStart = winNow = null;
    rband = null;
    press = null;
    dragging = null;
    hover = null;
    cursor = null;
    modGhost = null;
    // Grip drag in progress: revert the in-place grip move.
    if (gripDrag) {
      ents[gripDrag.i] = gripDrag.orig;
      gripDrag = null;
    }
    gripHover = null;
    try {
      cmdAutoEl.style.display = "none";
    } catch {
      /* */
    }
    try {
      cmdInput.value = "";
    } catch {
      /* */
    }
    // Force SELECT via setTool so ribbon/tool buttons stay in sync
    try {
      setTool("select");
    } catch {
      tool = "select";
      try {
        tools.querySelectorAll<HTMLButtonElement>("[data-t]").forEach((b) =>
          b.classList.toggle("on", b.dataset.t === "select"),
        );
      } catch {
        /* */
      }
      cv.style.cursor = "crosshair";
    }
    // setTool may preserve selection for noun-verb; force clear
    setSel([]);
    selected = -1;
    logCmd(`*Cancel* — all tools and selection cleared (${reason})`);
    try {
      showProps();
    } catch {
      /* */
    }
    try {
      updateStatus();
    } catch {
      /* */
    }
    draw();
    try {
      cv.focus({ preventScroll: true });
    } catch {
      /* */
    }
  }

  function onEscape(): void {
    // One Esc cancels everything (circle, line, modify, selection, prompts…)
    resetDrawingSession("Esc");
  }

    // Keyboard Shortcuts (drawing workspace Standard: F3, F7, F8, F12, Ctrl+Z, Ctrl+Y, Space/Enter)
  // Printable keys open the in-canvas command prompt from ANYWHERE on screen while this
  // drawing is the active CAD tab (drawing workspace behaviour — not limited to the command line).
  let screenTypeActive = false;

  function isUiTextField(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    if (dynCommandInput && el === dynCommandInput) return true;
    const tag = el.tagName?.toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") {
      const type = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (type === "button" || type === "checkbox" || type === "radio" || type === "range" || type === "file") return false;
      return true;
    }
    if (el.isContentEditable) return true;
    if (el.closest?.("#obs-cad-alias-editor, #obs-shortcut-editor, .obs-form-modal-overlay")) return true;
    return false;
  }

  const onAnywhereCommandType = (ev: KeyboardEvent): void => {
    if (!screenTypeActive) return;
    if (!page.isConnected || page.style.display === "none") return;
    if (!shell || shell.style.display === "none") return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.repeat) return;
    if (ev.key.length !== 1) return;
    // Letters, digits, and common drawing workspace punctuation for command entry
    if (!/^[a-zA-Z0-9._+-]$/.test(ev.key)) return;
    if (isUiTextField(ev.target)) return;
    if (dynCommandEl && dynCommandInput && document.activeElement === dynCommandInput) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    openDynamicCommand(ev.key);
  };
  window.addEventListener("keydown", onAnywhereCommandType, true);
  const stageEl = root.querySelector<HTMLElement>("[data-r=stage]");
  stageEl?.addEventListener("pointerdown", () => {
    try { cv.focus({ preventScroll: true }); } catch { /* */ }
  });


  cv.addEventListener("keydown", (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.key.length !== 1) return;
    if (!/^[a-zA-Z0-9._+-]$/.test(ev.key)) return;
    if (dynCommandEl && document.activeElement === dynCommandInput) return;
    if (isUiTextField(ev.target) && ev.target !== cv) return;
    ev.preventDefault();
    openDynamicCommand(ev.key);
  });

  function repeatLastCommand(): void {
    const last = cmdHistory.length ? cmdHistory[cmdHistory.length - 1] : "";
    if (!last || !String(last).trim()) {
      logCmd("Nothing to repeat.");
      return;
    }
    logCmd(`Repeat: ${last}`);
    executeDrawingCommand(last);
  }

  /** Undo / Redo / Esc / Delete / Ctrl+C·Shift+C copy / Ctrl+X cut / Ctrl+V·Shift+V paste / Ctrl+Alt+V paste-orig / Space·Enter repeat — work anywhere while this drawing is active. */
  const onCadEditorHotkeys = (ev: KeyboardEvent): void => {
    if (!screenTypeActive) return;
    if (!page.isConnected || page.style.display === "none") return;
    if (!shell || shell.style.display === "none") return;
    if (isUiTextField(ev.target) && ev.target !== cv) {
      // Allow Esc to still cancel CAD tools even from non-command inputs in the shell
      if (ev.key !== "Escape") return;
    }
    // Let the dynamic command prompt handle its own Enter/Esc
    if (dynCommandEl && dynCommandInput && document.activeElement === dynCommandInput) {
      return;
    }

    const modKey = ev.ctrlKey || ev.metaKey;
    const key = ev.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    // Layout-proof shortcut key: with non-Latin OS keyboard layouts (Arabic,
    // Cyrillic, …) Ctrl+Shift+C reports a non-Latin ev.key, so every letter
    // shortcut would silently die. Fall back to the physical key position
    // (ev.code, QWERTY reference) — matching native CAD on every layout.
    const physKey = typeof ev.code === "string" && ev.code.startsWith("Key") ? ev.code.slice(3).toLowerCase() : "";
    const hotKey = lower >= "a" && lower <= "z" ? lower : physKey;

    // Escape is handled by onCadEscCapture (drawing view + stage + window)

    if (key === "F3") {
      ev.preventDefault();
      snapOn = !snapOn;
      tools.querySelector("[data-a=snap]")?.classList.toggle("on", snapOn);
      updateStatus();
      draw();
      logCmd(`OSNAP: <${snapOn ? "ON" : "OFF"}>`);
      return;
    }
    if (key === "F7") {
      ev.preventDefault();
      showGrid = !showGrid;
      tools.querySelector("[data-a=grid]")?.classList.toggle("on", showGrid);
      updateStatus();
      draw();
      logCmd(`GRID: <${showGrid ? "ON" : "OFF"}>`);
      return;
    }
    if (key === "F8") {
      ev.preventDefault();
      orthoOn = !orthoOn;
      tools.querySelector("[data-a=ortho]")?.classList.toggle("on", orthoOn);
      updateStatus();
      draw();
      logCmd(`ORTHOMODE: <${orthoOn ? "ON" : "OFF"}>`);
      return;
    }
    if (key === "F12") {
      ev.preventDefault();
      dynOn = !dynOn;
      tools.querySelector("[data-a=dyn]")?.classList.toggle("on", dynOn);
      updateStatus();
      draw();
      logCmd(`DYNMODE: <${dynOn ? "ON" : "OFF"}>`);
      return;
    }

    if (key === "Delete" || key === "Backspace") {
      // Backspace only deletes selection when not typing a command (drawing workspace: Delete)
      if (key === "Backspace" && (pts.length || pick || mod)) return;
      if (!mod) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        eraseSelected();
      }
      return;
    }

    if (mod?.stage === "eraseAsk" && (lower === "y" || lower === "n")) {
      ev.preventDefault();
      const f = pendingYesNo;
      pendingYesNo = null;
      f?.(lower === "y");
      return;
    }

    // Ctrl/Cmd shortcuts
    if (modKey && hotKey === "z" && !ev.shiftKey) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      undo();
      return;
    }
    if (modKey && (hotKey === "y" || (hotKey === "z" && ev.shiftKey))) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      redo();
      return;
    }
    if (modKey && hotKey === "c") {
      // Ctrl+C / Ctrl+Shift+C — Super Copy (COPYCLIP): snapshot selection + style deps
      ev.preventDefault();
      ev.stopImmediatePropagation();
      copySelection();
      return;
    }
    if (modKey && hotKey === "x") {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (copySelection()) eraseSelected();
      return;
    }
    if (modKey && hotKey === "v") {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      // Ctrl+V / Ctrl+Shift+V — PASTECLIP: clipboard ghosts on the cursor, click to place
      // Ctrl+Alt+V — PASTEORIG: verbatim paste at the source coordinates
      if (ev.altKey) pasteOrig();
      else pasteClip();
      return;
    }
    if (modKey && (key === "0" || ev.code === "Digit0")) {
      ev.preventDefault();
      toggleCleanScreen();
      return;
    }

    // Enter / Space: finish current op, end drawing command, or repeat last (drawing workspace)
    if (key === "Enter" || key === " ") {
      if (pick) {
        ev.preventDefault();
        confirmPickStep();
        return;
      }
      if (mod) {
        ev.preventDefault();
        confirmModStep();
        return;
      }
      if (tool === "offset") {
        ev.preventDefault();
        return;
      }
      // LINE / PLINE: Enter ends the command (drawing workspace)
      if (tool === "line" || tool === "poly" || tool === "cloud" || tool === "spline" || tool === "wipeout") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if ((tool === "poly" || tool === "cloud" || tool === "spline" || tool === "wipeout") && pts.length >= 2) {
          try { finishMeasure(); } catch { /* */ }
        }
        pts = [];
        setTool("select");
        logCmd("Command: *Complete*");
        return;
      }
      if (pts.length > 0 && (tool === "area" || tool === "chain")) {
        ev.preventDefault();
        finishMeasure();
        return;
      }
      // CIRCLE/ARC incomplete: Enter cancels like drawing workspace
      if (tool !== "select" && tool !== "pan") {
        ev.preventDefault();
        endCurrentCommand();
        return;
      }
      // Idle: Space / Enter repeats last command
      if (tool === "select" && !dynCommandEl) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        repeatLastCommand();
      }
    }
  };
  window.addEventListener("keydown", onCadEditorHotkeys, true);

  // Keep canvas-local hotkeys as a fallback when the canvas has focus
  cv.addEventListener("keydown", (ev) => {
    // Handled by window capture when active; this covers focus-only edge cases
    if (screenTypeActive) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      onEscape();
      return;
    }
    if (ev.key === "Delete") {
      if (!mod) eraseSelected();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z" && !ev.shiftKey) {
      ev.preventDefault();
      undo();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === "y" || (ev.key.toLowerCase() === "z" && ev.shiftKey))) {
      ev.preventDefault();
      redo();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === "c" || ev.code === "KeyC")) {
      ev.preventDefault();
      copySelection();
      return;
    }
  });

  function toggleCleanScreen(): void {
    cleanScreen = !cleanScreen;
    tools.style.display = cleanScreen ? "none" : "flex";
    tools2.style.display = cleanScreen ? "none" : "flex";
    root!.querySelector<HTMLElement>(".side")!.style.display = cleanScreen ? "none" : "flex";
    logCmd(`CleanScreen: <${cleanScreen ? "ON" : "OFF"}>`);
  }

  /* ── Status Bar Update ── */
  function updateStatus(p?: M.Pt) {
    const c = p ?? cursor;
    const zoomPct = doc && bounds ? Math.round((view.scale / M.fitView(bounds, view.w, view.h).scale) * 100) : 100;
    const unit = doc ? M.unitLabel(doc.units, du) : "-";
    let xy = "0.0000, 0.0000, 0.0000";

    if (c && doc) {
      const ax = M.convertLength(c.x * scaleCal, doc.units, du);
      const ay = M.convertLength(c.y * scaleCal, doc.units, du);
      xy = `${ax.toFixed(4)}, ${ay.toFixed(4)}, 0.0000`;
    }

    // Pointer movement can fire hundreds of times per second. Update only the
    // coordinate text instead of rebuilding the complete status bar and
    // reattaching every button handler on each cursor sample.
    if (p) {
      const coords = statusEl.querySelector<HTMLElement>("[data-s=coords]");
      if (coords) {
        coords.textContent = xy;
        return;
      }
    }

    const promptBit = acadPromptText
      ? `<span style="color:#fbbf24;font-weight:600;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${acadPromptText.replace(/"/g, "&quot;")}">${acadPromptText}</span><span class="sep"></span>`
      : "";
    statusEl.innerHTML = `
      ${promptBit}
      <span style="color:#f8fafc;font-weight:600" data-s="coords">${xy}</span>
      <span class="sep"></span>
      <button class="obs-status-btn active" data-s="space">${layoutI >= 0 ? "PAPER" : "MODEL"}</button>
      <button class="obs-status-btn ${showGrid ? "active" : ""}" data-s="grid" title="Grid (F7)">GRID</button>
      <button class="obs-status-btn ${snapOn ? "active" : ""}" data-s="snap" title="Object Snap (F3)">OSNAP</button>
      <button class="obs-status-btn ${orthoOn ? "active" : ""}" data-s="ortho" title="Ortho (F8)">ORTHO</button>
      <button class="obs-status-btn ${polarOn ? "active" : ""}" data-s="polar" title="Polar Tracking (F10)">POLAR</button>
      <button class="obs-status-btn ${dynOn ? "active" : ""}" data-s="dyn" title="Dynamic Input (F12)">DYN</button>
      <button class="obs-status-btn ${lwtOn ? "active" : ""}" data-s="lwt" title="Lineweight">LWT</button>
      <button class="obs-status-btn ${quick ? "active" : ""}" data-s="quick" title="Quick Measure">QUICK</button>
      <span class="sep"></span>
      <span>${escapeHtml(unit)} · ${zoomPct}%</span>
      <span style="flex:1"></span>
      <span>${sel.size ? sel.size + " selected" : ""}</span>
    `;

    // Status tray button click listeners
    statusEl.querySelector("[data-s=grid]")?.addEventListener("click", () => {
      showGrid = !showGrid;
      updateStatus();
      draw();
    });
    statusEl.querySelector("[data-s=snap]")?.addEventListener("click", () => {
      snapOn = !snapOn;
      updateStatus();
      draw();
    });
    statusEl.querySelector("[data-s=ortho]")?.addEventListener("click", () => {
      orthoOn = !orthoOn;
      updateStatus();
      draw();
    });
    statusEl.querySelector("[data-s=dyn]")?.addEventListener("click", () => {
      dynOn = !dynOn;
      updateStatus();
      draw();
    });
    statusEl.querySelector("[data-s=lwt]")?.addEventListener("click", () => {
      lwtOn = !lwtOn;
      updateStatus();
      draw();
    });
  }

  /* ── In-Canvas Navigation Bar & ViewCube Listeners ── */
  root.querySelector("[data-r=vc-home]")?.addEventListener("click", zoomExtents);
  root.querySelector("[data-r=vc-home-btn]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    zoomExtents();
  });
  root.querySelector("[data-r=vc-rot-ccw]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    pushView();
    // Rotate view 90 degrees CCW
    logCmd("ViewCube: Rotate 90° CCW");
  });
  root.querySelector("[data-r=vc-rot-cw]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    pushView();
    // Rotate view 90 degrees CW
    logCmd("ViewCube: Rotate 90° CW");
  });

  root.querySelector("[data-r=nav-pan]")?.addEventListener("click", () => setTool("pan"));
  root.querySelector("[data-r=nav-ext]")?.addEventListener("click", zoomExtents);
  root.querySelector("[data-r=nav-win]")?.addEventListener("click", () => setTool("zoomwin"));
  root.querySelector("[data-r=nav-prev]")?.addEventListener("click", () => {
    const v = history.pop();
    if (v) {
      view = { ...v, w: view.w, h: view.h };
      draw();
    }
  });
  root.querySelector("[data-r=nav-full]")?.addEventListener("click", () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root!.requestFullscreen?.();
  });

  root.querySelector("[data-r=open-layer-mgr]")?.addEventListener("click", openLayerPropertiesManager);

  /* ── drawing workspace Command Line Execution & In-Canvas Dynamic Command Entry ── */
  const cmdInput = root.querySelector<HTMLInputElement>("[data-r=cmd]")!;
  let dynCommandEl: HTMLDivElement | null = null;
  let dynCommandInput: HTMLInputElement | null = null;
  let dynCommandHint: HTMLDivElement | null = null;

  function closeDynamicCommand(): void {
    dynCommandEl?.remove();
    dynCommandEl = null;
    dynCommandInput = null;
    dynCommandHint = null;
    cv.focus({ preventScroll: true });
  }

  function openDynamicCommand(initialText = ""): void {
    if (!dynCommandEl) {
      const stage = root.querySelector<HTMLElement>("[data-r=stage]");
      if (!stage) return;
      dynCommandEl = document.createElement("div");
      dynCommandEl.style.cssText = "position:absolute;z-index:15;display:flex;align-items:center;gap:7px;min-width:220px;max-width:min(420px,calc(100% - 24px));padding:7px 9px;background:rgba(15,23,42,.96);border:1px solid #38bdf8;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.45);font:12px/1.35 system-ui,sans-serif;color:#e2e8f0;pointer-events:auto";
      const prompt = document.createElement("span");
      prompt.textContent = "›";
      prompt.style.cssText = "color:#38bdf8;font-weight:700;font-size:16px";
      dynCommandInput = document.createElement("input");
      dynCommandInput.type = "text";
      dynCommandInput.autocomplete = "off";
      dynCommandInput.spellcheck = false;
      dynCommandInput.setAttribute("aria-label", "Drawing command or numeric input");
      dynCommandInput.placeholder = "Enter command…";
      dynCommandInput.style.cssText = "flex:1;min-width:0;background:transparent;border:0;outline:0;color:#f8fafc;font:12px Consolas,monospace";
      dynCommandHint = document.createElement("div");
      dynCommandHint.style.cssText = "position:absolute;left:28px;top:calc(100% + 4px);display:none;max-width:360px;padding:5px 8px;background:#111827;border:1px solid #334155;border-radius:4px;color:#94a3b8;font:11px/1.4 system-ui,sans-serif;white-space:normal;pointer-events:none";
      dynCommandEl.append(prompt, dynCommandInput, dynCommandHint);
      stage.appendChild(dynCommandEl);
      dynCommandInput.addEventListener("input", () => {
        const query = dynCommandInput?.value.trim().toUpperCase() ?? "";
        if (!dynCommandHint) return;
        if (!query) { dynCommandHint.style.display = "none"; return; }
        const matches = CAD_COMMANDS.filter((item) => cadCommandMatches(item, query)).slice(0, 4);
        dynCommandHint.textContent = matches.map((item) => `${item.name} (${cadAliasesOf(item).join(", ")})`).join("  ·  ");
        dynCommandHint.style.display = matches.length ? "block" : "none";
      });
      dynCommandInput.addEventListener("keydown", (event) => {
        if (!dynCommandInput) return;
        if (event.key === "Escape") {
          event.preventDefault();
          closeDynamicCommand();
          resetDrawingSession("Esc");
          return;
        }
        if (event.key === " " || event.code === "Space") {
          if (isExactCadCommandToken(dynCommandInput.value)) {
            event.preventDefault();
            const value = dynCommandInput.value;
            closeDynamicCommand();
            executeDrawingCommand(value);
          }
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const value = dynCommandInput.value;
          closeDynamicCommand();
          executeDrawingCommand(value);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          if (cmdHistoryIdx < 0) cmdHistoryIdx = cmdHistory.length;
          if (cmdHistoryIdx > 0) {
            cmdHistoryIdx--;
            dynCommandInput.value = cmdHistory[cmdHistoryIdx];
            dynCommandInput.dispatchEvent(new Event("input"));
            dynCommandInput.setSelectionRange(dynCommandInput.value.length, dynCommandInput.value.length);
          }
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          if (cmdHistoryIdx < cmdHistory.length - 1) {
            cmdHistoryIdx++;
            dynCommandInput.value = cmdHistory[cmdHistoryIdx];
          } else {
            cmdHistoryIdx = cmdHistory.length;
            dynCommandInput.value = "";
          }
          dynCommandInput.dispatchEvent(new Event("input"));
          dynCommandInput.setSelectionRange(dynCommandInput.value.length, dynCommandInput.value.length);
          return;
        }
        if (event.key === "Tab") {
          const query = dynCommandInput.value.trim().toUpperCase();
          const match = CAD_COMMANDS.find((item) => cadCommandMatches(item, query));
          if (match) { event.preventDefault(); dynCommandInput.value = match.name; dynCommandInput.dispatchEvent(new Event("input")); }
          return;
        }
        if (event.key === "F3" || event.key === "F7" || event.key === "F8" || event.key === "F12") {
          event.preventDefault();
          const key = event.key;
          closeDynamicCommand();
          cv.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        }
      });
    }
    const stage = root.querySelector<HTMLElement>("[data-r=stage]");
    if (stage && dynCommandEl) {
      const x = Math.max(8, Math.min(lastPointerScreen.x + 14, stage.clientWidth - Math.min(430, stage.clientWidth - 16)));
      const y = Math.max(8, Math.min(lastPointerScreen.y + 16, stage.clientHeight - 54));
      dynCommandEl.style.left = `${x}px`;
      dynCommandEl.style.top = `${y}px`;
    }
    if (dynCommandInput) {
      dynCommandInput.value = initialText;
      dynCommandInput.focus({ preventScroll: true });
      dynCommandInput.setSelectionRange(initialText.length, initialText.length);
      dynCommandInput.dispatchEvent(new Event("input"));
    }
  }


  function cadAliasesOf(c: CadCommandDef): string[] {
    return effectiveAliases(c.name, c.aliases);
  }
  function cadCommandMatches(c: CadCommandDef, query: string): boolean {
    const q = query.toUpperCase();
    if (c.name.startsWith(q)) return true;
    return cadAliasesOf(c).some((a) => a === q || a.startsWith(q));
  }

  /** Space executes only a complete command/alias, never a partial match or argument. */
  function isExactCadCommandToken(rawInput: string): boolean {
    const token = rawInput.trim();
    if (!token || token.includes(" ")) return false;
    const resolved = resolveCadToken(token, CAD_COMMANDS);
    return CAD_COMMANDS.some((command) => command.name === resolved);
  }

  function executeDrawingCommand(rawInput: string): void {
    const trimmed = rawInput.trim();
    if (!trimmed) return;
    // DDEDIT / MLEADER: the typed line is annotation text, not a command.
    if (pendingText) {
      const f = pendingText;
      pendingText = null;
      cmdInput.value = "";
      cmdAutoEl.style.display = "none";
      logCmd(trimmed);
      f(trimmed);
      return;
    }
    cmdHistory.push(trimmed);
    cmdHistoryIdx = cmdHistory.length;
    cmdInput.value = "";
    cmdAutoEl.style.display = "none";

    logCmd(`Command: ${trimmed}`, true);

    const parts = trimmed.split(/\s+/);
    const cmd = resolveCadToken(parts[0], CAD_COMMANDS);
    const arg = parts.slice(1).join(" ");

    // Direct numeric entry: tool radius/length, or pending ROTATE/SCALE/OFFSET
    if (/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(trimmed)) {
      const num = parseFloat(trimmed);
      if (applyDirectDistance(num)) {
        draw();
        return;
      }
      if (pendingNumeric) {
        const f = pendingNumeric;
        pendingNumeric = null;
        f(num);
        draw();
        return;
      }
    }
    // CIRCLE option keywords while CIRCLE is active
    if (tool === "circle" && pts.length === 0) {
      const k = cmd;
      if (k === "2P" || k === "2") {
        circleMode = "2p";
        showAcadPrompt();
        return;
      }
      if (k === "3P" || k === "3") {
        circleMode = "3p";
        showAcadPrompt();
        return;
      }
    }
    // Yes/No answer to the MIRROR "Erase source objects?" prompt
    if (pendingYesNo && /^(y|yes|n|no)$/i.test(trimmed)) {
      const f = pendingYesNo;
      pendingYesNo = null;
      f(/^y/i.test(trimmed));
      draw();
      return;
    }

    // KS / ALIASEDIT — command alias editor (drawing workspace-style abbreviations)
    if (cmd === "KS" || cmd === "ALIASEDIT" || cmd === "ALIASES" || cmd === "SHORTCUTS") {
      openCadAliasEditor(
        CAD_COMMANDS.map((c) => ({
          name: c.name,
          aliases: effectiveAliases(c.name, c.aliases),
          description: c.description,
        })),
        () => {
          /* aliases reloaded on next resolveCadToken */
        },
      );
      logCmd("KS — Command Aliases editor");
      return;
    }

    // Standard drawing workspace command matching
    if (cmd === "L" || cmd === "LINE") {
      setTool("line");
      return;
    }
    if (cmd === "PL" || cmd === "PLINE" || cmd === "POLYLINE") {
      setTool("poly");
      return;
    }
    if (cmd === "C" || cmd === "CIRCLE") {
      const opt = (arg || "").trim().toUpperCase();
      if (opt === "2P" || opt === "2") circleMode = "2p";
      else if (opt === "3P" || opt === "3") circleMode = "3p";
      else circleMode = "center";
      // Also allow: CIRCLE 2P as separate token flow via dynamic input
      setTool("circle");
      return;
    }
    if (cmd === "REC" || cmd === "RECTANG" || cmd === "RECTANGLE") {
      setTool("rect");
      return;
    }
    if (cmd === "A" || cmd === "ARC") {
      setTool("arc");
      return;
    }
    if (cmd === "E" || cmd === "ERASE" || cmd === "DEL" || cmd === "DELETE") {
      eraseSelected();
      return;
    }
    if (cmd === "M" || cmd === "MOVE") {
      setTool("move");
      return;
    }
    if (cmd === "CO" || cmd === "COPY") {
      setTool("copy");
      return;
    }
    if (cmd === "RC" || cmd === "CLOUD" || cmd === "REVCLOUD" || cmd === "REVISIONCLOUD") {
      setTool("cloud");
      return;
    }
    if (cmd === "RO" || cmd === "ROTATE") {
      setTool("rotate");
      return;
    }
    if (cmd === "MI" || cmd === "MIRROR") {
      setTool("mirror");
      return;
    }
    if (cmd === "SC" || cmd === "SCALE") {
      setTool("scale");
      return;
    }
    if (cmd === "O" || cmd === "OFFSET") {
      setTool("offset");
      return;
    }
    if (cmd === "DI" || cmd === "DIST" || cmd === "DISTANCE") {
      setTool("dist");
      return;
    }
    if (cmd === "AA" || cmd === "AREA") {
      setTool("area");
      return;
    }
    if (cmd === "ID") {
      setTool("coord");
      return;
    }
    if (cmd === "LI" || cmd === "LIST") {
      showSelectionList();
      return;
    }
    if (cmd === "P" || cmd === "PAN") {
      setTool("pan");
      return;
    }
    if (cmd === "Z" || cmd === "ZOOM") {
      const sub = (arg || "").toUpperCase();
      if (sub === "E" || sub === "EXTENTS") {
        zoomExtents();
        return;
      }
      if (sub === "W" || sub === "WINDOW") {
        setTool("zoomwin");
        return;
      }
      if (sub === "P" || sub === "PREVIOUS") {
        const v = history.pop();
        if (v) {
          view = { ...v, w: view.w, h: view.h };
          draw();
        }
        return;
      }
      if (sub === "A" || sub === "ALL") {
        zoomExtents();
        return;
      }
      setTool("zoomwin");
      logCmd("Specify corner of window, enter a scale factor, or [All/Extents/Previous/Window] <real time>:");
      return;
    }
    if (cmd === "LT" || cmd === "LTYPE" || cmd === "LINETYPE") {
      openLinetypeManager(styleApi);
      return;
    }
    if (cmd === "LTS" || cmd === "LTSCALE") {
      const v = Number(arg);
      if (doc && Number.isFinite(v) && v > 0) {
        doc.ltscale = v;
        logCmd(`LTSCALE = ${v}`);
        draw();
      } else logCmd(`LTSCALE = ${doc?.ltscale ?? 1}. Enter a positive number, e.g. LTSCALE 2`);
      return;
    }
    if (cmd === "ST" || cmd === "STYLE") {
      openTextStyleManager(styleApi);
      return;
    }
    if (cmd === "T" || cmd === "DT" || cmd === "DTEXT" || cmd === "MT" || cmd === "MTEXT" || cmd === "TEXT") {
      setTool("text");
      logCmd("Click to place text.");
      return;
    }
    if (cmd === "MA" || cmd === "MATCHPROP") {
      setTool("match");
      logCmd("MATCHPROP: select the source object.");
      return;
    }
    if (cmd === "LA" || cmd === "LAYER" || cmd === "LAYERS") {
      openLayerPropertiesManager();
      return;
    }
    if (cmd === "PR" || cmd === "PROPERTIES" || cmd === "CH") {
      propsEl.scrollIntoView({ behavior: "smooth" });
      logCmd("Properties palette focused.");
      return;
    }
    if (cmd === "RE" || cmd === "REGEN" || cmd === "REA" || cmd === "REGENALL") {
      if (bounds) idx = M.buildIndex(ents, bounds);
      draw();
      logCmd("Regenerating model...");
      return;
    }
    if (cmd === "UN" || cmd === "UNITS") {
      openUnitsDialog();
      return;
    }
    if (cmd === "UCS") {
      setTool("origin");
      logCmd("Specify origin of UCS <0,0,0>:");
      return;
    }
    if (cmd === "U" || cmd === "UNDO") {
      undo();
      return;
    }
    if (cmd === "REDO") {
      redo();
      return;
    }
    if (cmd === "PU" || cmd === "PURGE") {
      purgeDrawing();
      return;
    }
    if (cmd === "DATAEXTRACT" || cmd === "EATTEXT" || cmd === "DX") {
      extractEntityCsv();
      return;
    }
    if (cmd === "LANDXMLIN" || cmd === "XMLIN") {
      xmlPicker?.click();
      return;
    }
    if (cmd === "PRINT" || cmd === "PLOT") {
      openPlot();
      return;
    }
    if (cmd === "QSAVE" || cmd === "SAVE") {
      saveDxf();
      return;
    }
    if (cmd === "SAVEAS" || cmd === "SA") {
      void promptLine("Save As", "Choose output format: DXF or DWG", "DXF").then((format) => {
        const choice = (format ?? "").trim().toUpperCase().replace(/^\./, "");
        if (choice === "DXF") saveDxf();
        else if (choice === "DWG") void saveDwg();
        else if (choice) logCmd("SAVEAS cancelled: enter DXF or DWG.");
      });
      return;
    }
    if (cmd === "DWGSAVE" || cmd === "EXPORTDWG") {
      void saveDwg();
      return;
    }
    if (cmd === "DWGVERSION" || cmd === "DWGVER") {
      void chooseDwgVersion();
      return;
    }
    if (cmd === "COPYCLIP") {
      copySelection();
      return;
    }
    if (cmd === "PASTECLIP") {
      pasteClip();
      return;
    }
    if (cmd === "PASTEORIG") {
      pasteOrig();
      return;
    }
    if (cmd === "SAVEALL") {
      hooks.saveAll();
      return;
    }
    if (cmd === "CLOSE") {
      hooks.requestClose();
      return;
    }
    if (cmd === "SVGSAVE" || cmd === "EXPORTSVG") {
      exportSvg();
      logCmd("Drawing exported as SVG.");
      return;
    }
    if (cmd === "ORTHO" || cmd === "ORTHOMODE") {
      orthoOn = !orthoOn;
      updateStatus();
      draw();
      logCmd(`ORTHOMODE: <${orthoOn ? "ON" : "OFF"}>`);
      return;
    }
    if (cmd === "OSNAP") {
      snapOn = !snapOn;
      updateStatus();
      draw();
      logCmd(`OSNAP: <${snapOn ? "ON" : "OFF"}>`);
      return;
    }
    if (cmd === "GRID") {
      showGrid = !showGrid;
      updateStatus();
      draw();
      logCmd(`GRID: <${showGrid ? "ON" : "OFF"}>`);
      return;
    }
    if (cmd === "DYN" || cmd === "DYNMODE") {
      dynOn = !dynOn;
      tools.querySelector("[data-a=dyn]")?.classList.toggle("on", dynOn);
      updateStatus();
      draw();
      logCmd(`DYNMODE: <${dynOn ? "ON" : "OFF"}>`);
      return;
    }
    if (cmd === "SNAP" || cmd === "SNAPMODE") {
      snapOn = !snapOn;
      updateStatus();
      draw();
      logCmd(`SNAPMODE: <${snapOn ? "ON" : "OFF"}>`);
      return;
    }
    if (cmd === "CLEANSCREEN" || cmd === "CLEAN") {
      toggleCleanScreen();
      return;
    }
    if (cmd === "OVERKILL") {
      auditDrawing(true);
      return;
    }
    if (cmd === "AUDIT") {
      auditDrawing(false);
      return;
    }
    if (cmd === "FIND") {
      void findReplace();
      return;
    }
    if (cmd === "ARRAY" || cmd === "AR") {
      arrayRect();
      return;
    }
    if (cmd === "ARRAYPOLAR" || cmd === "ARP") {
      void arrayPolar();
      return;
    }
    if (cmd === "VIEW" || cmd === "V") {
      viewCommand(parts.slice(1));
      return;
    }
    if (cmd === "LAYERSTATE" || cmd === "LAS" || cmd === "LAYSTATE") {
      layerStateCommand(parts.slice(1));
      return;
    }
    if (cmd === "BLOCK" || cmd === "B" || cmd === "BMAKE") { void createBlockCmd(parts.slice(1)); return; }
    if (cmd === "INSERT" || cmd === "I" || cmd === "DDINSERT" || cmd === "-INSERT") { void insertBlockCmd(parts[1]); return; }
    if (cmd === "WBLOCK" || cmd === "W") { void wblockCmd(); return; }
    if (cmd === "BLOCKLIB" || cmd === "BLOCKS" || cmd === "BLIB") { void blockLibraryCmd(); return; }
    if (cmd === "SVGIMPORT" || cmd === "SVG") { tools.querySelector<HTMLInputElement>("[data-r=svgfile]")?.click(); return; }
    if (cmd === "FIELD" || cmd === "FLD") { void fieldCmd(); return; }
    if (cmd === "IMPORT" || cmd === "IMP") {
      tools.querySelector<HTMLInputElement>("[data-r=importfile]")?.click();
      return;
    }

    // ── Native-engine drafting commands ──
    if (cmd === "XLINE" || cmd === "XL") {
      setTool("xline");
      return;
    }
    if (cmd === "RAY") {
      setTool("ray");
      return;
    }
    if (cmd === "POLYGON" || cmd === "POL") {
      const n = parseInt(parts[1] ?? "", 10);
      if (Number.isInteger(n) && n >= 3 && n <= 1024) {
        polySides = n;
        logCmd(`Polygon sides: ${n}`);
      }
      setTool("polygon");
      return;
    }
    if (cmd === "SPLINE" || cmd === "SPL") {
      setTool("spline");
      return;
    }
    if (cmd === "ELLIPSE" || cmd === "EL") {
      setTool("ellipse");
      return;
    }
    if (cmd === "DONUT" || cmd === "DO") {
      setTool("donut");
      return;
    }
    if (cmd === "POINT" || cmd === "PO") {
      setTool("point");
      return;
    }
    if (cmd === "HATCH" || cmd === "H" || cmd === "BHATCH") {
      setTool("hatch");
      return;
    }
    if (cmd === "WIPEOUT" || cmd === "WI" || cmd === "WIPE") {
      setTool("wipeout");
      return;
    }
    if (cmd === "TRIM" || cmd === "TR") {
      setTool("trim");
      return;
    }
    if (cmd === "EXTEND" || cmd === "EX") {
      setTool("extend");
      return;
    }
    if (cmd === "BREAK" || cmd === "BR") {
      setTool("break");
      return;
    }
    if (cmd === "FILLET" || cmd === "F") {
      const ri = parts.indexOf("R") >= 0 ? parts.indexOf("R") : parts.indexOf("RADIUS");
      const rv = ri >= 0 ? parseFloat(parts[ri + 1] ?? "") : NaN;
      if (Number.isFinite(rv) && rv > 0) filletR = rv;
      else if (parts.length === 2 && Number.isFinite(parseFloat(parts[1]))) filletR = Math.abs(parseFloat(parts[1]));
      setTool("fillet");
      return;
    }
    if (cmd === "CHAMFER" || cmd === "CHA") {
      const nums = parts.slice(1).map(parseFloat).filter((v) => Number.isFinite(v) && v > 0);
      if (nums.length >= 2) chamferD = [nums[0], nums[1]];
      else if (nums.length === 1) chamferD = [nums[0], nums[0]];
      setTool("chamfer");
      return;
    }
    if (cmd === "JOIN" || cmd === "J") {
      setTool("join");
      return;
    }
    if (cmd === "EXPLODE" || cmd === "X") {
      explodeSelection();
      return;
    }
    if (cmd === "STRETCH" || cmd === "S") {
      setTool("stretch");
      return;
    }
    if (cmd === "ALIGN" || cmd === "AL") {
      setTool("align");
      return;
    }
    if (cmd === "MATCHLAYER" || cmd === "ML") {
      setTool("matchlayer");
      return;
    }
    if (cmd === "DIMALIGNED" || cmd === "DAL") { setTool("dim"); return; }
    if (cmd === "DIMLINEAR" || cmd === "DLI") { setTool("dimlinear"); return; }
    if (cmd === "DIMANGULAR" || cmd === "DAN" || cmd === "DIMANG") {
      setTool("dimang");
      return;
    }
    if (cmd === "DIMARC" || cmd === "DAR") {
      setTool("dimarc");
      return;
    }
    if (cmd === "DIMDIAMETER" || cmd === "DDI" || cmd === "DIMDIA") {
      setTool("dimdia");
      return;
    }
    if (cmd === "DIMCENTER" || cmd === "DCE") {
      setTool("dimcenter");
      return;
    }
    if (cmd === "DIMCONTINUE" || cmd === "DCO" || cmd === "DIMCONT") {
      setTool("dimcont");
      return;
    }
    if (cmd === "DIMBASELINE" || cmd === "DBA" || cmd === "DIMBASE") {
      setTool("dimbase");
      return;
    }
    if (cmd === "TABLE" || cmd === "TB") {
      const r0 = parseInt(parts[1] ?? "", 10),
        c0 = parseInt(parts[2] ?? "", 10);
      if (Number.isInteger(r0) && Number.isInteger(c0) && r0 > 0 && c0 > 0 && r0 <= 50 && c0 <= 50) {
        tableDims = { rows: r0, cols: c0 };
        logCmd(`Next table: ${r0} rows × ${c0} columns.`);
      }
      setTool("table");
      return;
    }

    /* ── drawing workspace expansion pack: LENGTHEN / DIVIDE / MEASURE / DDEDIT / LAYER tools /
          MLEADER / QSELECT / PEDIT / CAL ── */
    if (cmd === "LEN" || cmd === "LENGTHEN") {
      setTool("lengthen");
      const lower = parts.slice(1).map((s) => s.toUpperCase());
      const nums = parts.slice(1).map(parseFloat).filter((v) => Number.isFinite(v));
      if (lower.includes("D") || lower.includes("DELTA")) {
        if (pick && nums.length) {
          pick.lenMode = "delta";
          pick.lenVal = nums[0];
          logCmd(`LENGTHEN: delta = ${fmt(nums[0])}. Select an object:`);
        } else logCmd("LENGTHEN: specify a delta, e.g. LENGTHEN D 5.");
      } else if (nums.length && pick) {
        pick.lenMode = "total";
        pick.lenVal = Math.abs(nums[0]);
        logCmd(`LENGTHEN: total length = ${fmt(pick.lenVal)}. Select an object:`);
      }
      return;
    }
    if (cmd === "DIV" || cmd === "DIVIDE") {
      setTool("divide");
      return;
    }
    if (cmd === "ME" || cmd === "MEASURE") {
      setTool("measure");
      return;
    }
    if (cmd === "ED" || cmd === "DDEDIT" || cmd === "TEXTEDIT") {
      setTool("ddedit");
      return;
    }
    if (cmd === "LAYUNISO") {
      if (preIsoHidden) {
        hidden.clear();
        for (const l of preIsoHidden) hidden.add(l);
        preIsoHidden = null;
        logCmd("LAYUNISO: layer visibility restored.");
        draw();
      } else logCmd("LAYUNISO: no LAYISO snapshot to restore.");
      return;
    }
    if (cmd === "LAYISO" || cmd === "LAYISOLATE" || cmd === "LAYOFF" || cmd === "LAYLCK" || cmd === "LAYUNLCK" || cmd === "LAYUNLOCK") {
      setTool(cmd === "LAYISO" || cmd === "LAYISOLATE" ? "layiso" : cmd === "LAYOFF" ? "layoff" : cmd === "LAYLCK" ? "laylck" : "layunlck");
      return;
    }
    if (cmd === "MLD" || cmd === "MLEADER" || cmd === "LE" || cmd === "LEADER") {
      setTool("mleader");
      return;
    }
    if (cmd === "QSELECT" || cmd === "QSI") {
      const what = (parts[1] ?? "").toUpperCase();
      const val = parts.slice(2).join(" ").trim();
      const all = ents.map((_, i) => i).filter((i) => visible(ents[i]));
      const colorKey = (e: DxfEntity): string => e.rgb != null
        ? `rgb:${(e.rgb & 0xffffff).toString(16).padStart(6, "0")}`
        : e.color != null ? `aci:${e.color}` : "bylayer";
      let ids: number[] = [];
      if (what === "ALL") ids = all;
      else if (what === "TYPE" && val) ids = all.filter((i) => ents[i].type === val.toUpperCase());
      else if (what === "LAYER" && val) ids = all.filter((i) => ents[i].layer.toLowerCase() === val.toLowerCase());
      else if (what === "COLOR" && val) {
        const key = /^#?[0-9a-f]{6}$/i.test(val) ? `rgb:${val.replace(/^#/, "").toLowerCase()}`
          : /^(bylayer|default)$/i.test(val) ? "bylayer" : `aci:${Number(val)}`;
        ids = all.filter((i) => colorKey(ents[i]) === key);
      } else if (what === "LINETYPE" && val) {
        const key = val.toUpperCase();
        ids = all.filter((i) => (ents[i].lineType ?? "BYLAYER").toUpperCase() === key);
      } else if (what === "LINEWEIGHT" && val) {
        if (/^(bylayer|default)$/i.test(val)) ids = all.filter((i) => ents[i].lineweight == null);
        else {
          const weight = Number(val);
          if (Number.isFinite(weight) && weight >= 0) ids = all.filter((i) => ents[i].lineweight != null && Math.abs(ents[i].lineweight - weight) < 0.001);
        }
      } else if (what === "TEXT" && val) {
        const q = val.toLowerCase();
        ids = all.filter((i) => ents[i].type === "TEXT" && ents[i].value.toLowerCase().includes(q));
      }
      if (["ALL", "TYPE", "LAYER", "COLOR", "LINETYPE", "LINEWEIGHT", "TEXT"].includes(what) && (what === "ALL" || !!val)) {
        setSel(ids);
        logCmd(`QSELECT ${what}${val ? " " + val : ""}: ${ids.length} object(s) selected.`);
      } else logCmd("QSELECT: use ALL · TYPE <entity> · LAYER <name> · COLOR <ACI|#RRGGBB|BYLAYER> · LINETYPE <name|BYLAYER> · LINEWEIGHT <mm|BYLAYER> · TEXT <contains>.");
      return;
    }
    if (cmd === "SELECTSIMILAR" || cmd === "SELSIM") {
      const src = [...sel].map((i) => ents[i]).filter((e): e is DxfEntity => !!e);
      if (!src.length) {
        logCmd("SELECTSIMILAR: select one or more source objects first.");
        return;
      }
      const mode = (parts[1] ?? "").toUpperCase();
      if (mode && !["TYPE", "LAYER", "COLOR", "LINETYPE", "LINEWEIGHT"].includes(mode)) {
        logCmd("SELECTSIMILAR: use TYPE · LAYER · COLOR · LINETYPE · LINEWEIGHT (or omit the option for type + layer).");
        return;
      }
      const colorKey = (e: DxfEntity): string => e.rgb != null
        ? `rgb:${(e.rgb & 0xffffff).toString(16).padStart(6, "0")}`
        : e.color != null ? `aci:${e.color}` : "bylayer";
      const matches = (e: DxfEntity, candidate: DxfEntity): boolean => {
        if (mode === "TYPE") return e.type === candidate.type;
        if (mode === "LAYER") return e.layer === candidate.layer;
        if (mode === "COLOR") return colorKey(e) === colorKey(candidate);
        if (mode === "LINETYPE") return (e.lineType ?? "BYLAYER").toUpperCase() === (candidate.lineType ?? "BYLAYER").toUpperCase();
        if (mode === "LINEWEIGHT") return (e.lineweight ?? null) === (candidate.lineweight ?? null);
        return e.type === candidate.type && e.layer === candidate.layer;
      };
      const ids = ents.map((e, i) => ({ e, i })).filter(({ e }) => visible(e) && src.some((candidate) => matches(e, candidate))).map(({ i }) => i);
      setSel(ids);
      logCmd(`SELECTSIMILAR${mode ? " " + mode : ""}: ${ids.length} object(s) selected.`);
      return;
    }
    /* ── LibreDWG utility belt on the command line (same paths as the ribbon groups) ── */
    if (cmd === "DWGOPEN") {
      const kind = (parts[1] ?? "").toUpperCase() === "DXF" ? ".dxf" : (parts[1] ?? "").toUpperCase() === "DWG" ? ".dwg" : ".dwg,.dxf";
      void import("./libredwg-toolkit").then((m) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.accept = kind;
        input.onchange = () => { if (input.files?.length) void m.openDrawingFiles(input.files); };
        input.click();
      });
      return;
    }
    if (cmd === "DWGJSONIMP" || cmd === "JSONDUMP") {
      void import("./libredwg-toolkit").then((m) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = () => { const f = input.files?.[0]; if (f) void m.importJsonDumpFile(f); };
        input.click();
      });
      return;
    }
    if (cmd === "DWGREWRITE" || cmd === "SAVETODXF") { void import("../modules/drawings/dwg-engine").then((m) => m.exportActiveDxf()); return; }
    if (cmd === "DWG2JSON") { void import("./libredwg-toolkit").then((m) => m.exportDwgJson()); return; }
    if (cmd === "DWG2SVG") { void import("./libredwg-toolkit").then((m) => m.exportDwgSvg()); return; }
    if (cmd === "DWG2GEOJSON") { void import("./libredwg-toolkit").then((m) => m.exportDwgGeoJson()); return; }
    if (cmd === "DWG2PS") { void import("./libredwg-toolkit").then((m) => m.exportDwgPs()); return; }
    if (cmd === "DWGAUDIT") { void import("./libredwg-toolkit").then((m) => m.auditDialog()); return; }
    if (cmd === "DWGTABLES") { void import("./libredwg-toolkit").then((m) => void m.tablesDialog()); return; }
    if (cmd === "DWGCENSUS") { void import("./libredwg-toolkit").then((m) => m.censusDialog()); return; }
    if (cmd === "DWGTHUMB" || cmd === "DWGBMP") { void import("./libredwg-toolkit").then((m) => void m.thumbnailDialog()); return; }
    if (cmd === "PE" || cmd === "PEDIT") {
      const sub = (parts[1] ?? "").toUpperCase();
      const targets = [...sel].map((i) => ents[i]).filter((e): e is DxfEntity => !!e);
      const polys = targets.filter((e): e is Extract<DxfEntity, { type: "LWPOLYLINE" }> => e.type === "LWPOLYLINE");
      if (!targets.length) {
        logCmd("PEDIT: select polyline(s) first, then PEDIT J (join) | C (close) | O (open) | R (reverse).");
        return;
      }
      if (sub === "J" || sub === "JOIN") {
        const merged = X.chainPolyline(targets);
        if (!merged) logCmd(`PEDIT: ${targets.length} object(s) do not form a connected chain (LINE / open LWPOLYLINE only).`);
        else {
          commitReplace(targets, [merged]);
          logCmd(`PEDIT: ${targets.length} object(s) joined into 1 polyline.`);
          draw();
        }
      } else if (sub === "C" || sub === "CLOSE") {
        const open = polys.filter((e) => !e.closed);
        if (!open.length) logCmd("PEDIT: no open polyline in the selection.");
        else {
          commitModify(open, open.map((e) => ({ ...e, closed: true })));
          logCmd(`PEDIT: ${open.length} polyline(s) closed.`);
          draw();
        }
      } else if (sub === "O" || sub === "OPEN") {
        const closed = polys.filter((e) => !!e.closed);
        if (!closed.length) logCmd("PEDIT: no closed polyline in the selection.");
        else {
          commitModify(closed, closed.map((e) => ({ ...e, closed: false })));
          logCmd(`PEDIT: ${closed.length} polyline(s) opened.`);
          draw();
        }
      } else if (sub === "R" || sub === "REVERSE") {
        if (!polys.length) logCmd("PEDIT: no polyline in the selection.");
        else {
          commitModify(polys, polys.map((e) => ({ ...e, points: e.points.slice().reverse() })));
          logCmd(`PEDIT: ${polys.length} polyline(s) reversed.`);
          draw();
        }
      } else logCmd("PEDIT options: J (join selection) · C (close) · O (open) · R (reverse).");
      return;
    }
    /* ── Parametric tab — one-shot geometric + dimensional constraints ── */
    if (cmd === "AUTOCONSTRAIN" || cmd === "ACON") { runAutoConstrain(); return; }
    if (cmd === "CONSTRAINTBAR" || cmd === "CONBAR") { toggleConBar(); return; }
    if (cmd === "DELCONSTRAINT" || cmd === "DELCON") { unfixAll(); return; }
    if (cmd === "FIX" || cmd === "CONSTRAINTFIX") { setTool("confix"); return; }
    if (cmd === "UNFIX" || cmd === "CONSTRAINTUNFIX") { setTool("confix"); return; }
    if (cmd === "HORIZONTAL") { startConstraint("horizontal"); return; }
    if (cmd === "VERTICAL") { startConstraint("vertical"); return; }
    if (cmd === "PERPENDICULAR" || cmd === "PERP") { startConstraint("perpendicular"); return; }
    if (cmd === "PARALLEL" || cmd === "PAR") { startConstraint("parallel"); return; }
    if (cmd === "TANGENT" || cmd === "TAN") { startConstraint("tangent"); return; }
    if (cmd === "CONCENTRIC" || cmd === "CENC") { startConstraint("concentric"); return; }
    if (cmd === "COINCIDENT" || cmd === "COINC") { startConstraint("coincident"); return; }
    if (cmd === "SYMMETRIC" || cmd === "SYM") { startConstraint("symmetric"); return; }
    if (cmd === "EQUAL" || cmd === "EQ") { startConstraint("equal"); return; }
    if (cmd === "DCLINEAR" || cmd === "DCLIN") { startConstraint("dclinear"); return; }
    if (cmd === "DCRADIUS" || cmd === "DCRAD") { startConstraint("dcradius"); return; }
    if (cmd === "DCDIAMETER" || cmd === "DCDIA") { startConstraint("dcdiameter"); return; }
    if (cmd === "DCANGULAR" || cmd === "DCANG") { startConstraint("dcangular"); return; }
    /* ── Express Tools tab ── */
    if (cmd === "TXT2MTXT" || cmd === "TXT2MTEXT") { setTool("txt2mtxt"); return; }
    if (cmd === "EXPLODETEXT" || cmd === "XTEXT") { setTool("explodetext"); return; }
    if (cmd === "TEXTFIT" || cmd === "TFIT") { setTool("textfit"); return; }
    if (cmd === "ARCTEXT" || cmd === "ARCALIGNEDTEXT") { setTool("arctext"); return; }
    if (cmd === "TEXTMASK" || cmd === "TMASK") { setTool("textmask"); return; }
    if (cmd === "FLATTEN" || cmd === "FLAT") { runFlatten(); return; }
    if (cmd === "BREAKLINE" || cmd === "BRKLN") { setTool("breakline"); return; }
    if (cmd === "LAYMRG" || cmd === "LAYMERGE") { setTool("laymrg"); return; }
    if (cmd === "LAYDEL" || cmd === "LAYDELETE") { setTool("laydel"); return; }
    if (cmd === "LAYWALK" || cmd === "LWALK") { openLayWalk(); return; }
    if (cmd === "LAYFRZ" || cmd === "LFRZ") { runLayFrz(); return; }
    if (cmd === "LAYTHW" || cmd === "LTHW") { runLayThw(); return; }
    /* ── Collaborate tab ── */
    if (cmd === "PUBLISH" || cmd === "PUB") { publishAll(); return; }
    if (cmd === "SHAREVIEW" || cmd === "SHARE") { shareView(); return; }
    if (cmd === "DWGHISTORY" || cmd === "HISTORY") { openDwgHistory(); return; }
    if (cmd === "CHECKSTANDARDS" || cmd === "CHKSTD") { openCheckStandards(); return; }
    if (cmd === "CAL" || cmd === "QUICKCALC" || cmd === "QC") {
      const expr = trimmed.slice(parts[0].length).trim();
      if (!expr) logCmd("CAL: enter an expression — e.g. CAL 2*PI*25 · sin/cos/tan (degrees) · sqrt/abs/round/min/max.");
      else {
        const v = evalExpr(expr);
        logCmd(v == null ? `CAL: cannot evaluate "${expr}".` : `CAL = ${v}`);
      }
      return;
    }
    // Bare arithmetic expression while a tool waits for a number (drawing workspace CAL on the fly)
    if (isCalcExpr(trimmed)) {
      const v = evalExpr(trimmed);
      if (v != null && Number.isFinite(v)) {
        if (applyDirectDistance(v)) {
          draw();
          return;
        }
        if (pendingNumeric) {
          const f = pendingNumeric;
          pendingNumeric = null;
          f(v);
          draw();
          return;
        }
        logCmd(`CAL = ${v}`);
        return;
      }
    }

    logCmd(`Unknown command "${trimmed}". Press ? for drawing workspace command list.`);
  }

  cmdInput.addEventListener("input", () => {
    const q = cmdInput.value.trim().toUpperCase();
    if (!q) {
      cmdAutoEl.style.display = "none";
      return;
    }
    const matches = CAD_COMMANDS.filter(
      (c) => cadCommandMatches(c, q),
    ).slice(0, 7);

    if (matches.length === 0) {
      cmdAutoEl.style.display = "none";
      return;
    }

    cmdAutoEl.innerHTML = matches
      .map(
        (m, idx) => `
        <div class="obs-cmd-auto-item ${idx === 0 ? "active" : ""}" data-cmd="${m.name}">
          <div><strong>${m.name}</strong> <span style="color:#94a3b8">(${cadAliasesOf(m).join(", ")})</span></div>
          <div style="font-size:10px;color:#94a3b8">${m.description}</div>
        </div>
      `,
      )
      .join("");

    cmdAutoEl.style.display = "flex";

    cmdAutoEl.querySelectorAll(".obs-cmd-auto-item").forEach((item) => {
      item.addEventListener("click", () => {
        executeDrawingCommand(item.getAttribute("data-cmd") || "");
      });
    });
  });

  cmdInput.addEventListener("keydown", (e) => {
    if (e.key === " " || e.code === "Space") {
      if (isExactCadCommandToken(cmdInput.value)) {
        e.preventDefault();
        executeDrawingCommand(cmdInput.value);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const v = cmdInput.value.trim();
      if (!v) {
        // DDEDIT / MLEADER: empty Enter = keep existing text / cancel, not repeat.
        if (pendingText) {
          const f = pendingText;
          pendingText = null;
          f("");
        } else repeatLastCommand();
        return;
      }
      executeDrawingCommand(cmdInput.value);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (cmdHistoryIdx > 0) {
        cmdHistoryIdx--;
        cmdInput.value = cmdHistory[cmdHistoryIdx];
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (cmdHistoryIdx < cmdHistory.length - 1) {
        cmdHistoryIdx++;
        cmdInput.value = cmdHistory[cmdHistoryIdx];
      } else {
        cmdHistoryIdx = cmdHistory.length;
        cmdInput.value = "";
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      const first = cmdAutoEl.querySelector<HTMLElement>(".obs-cmd-auto-item");
      if (first) {
        executeDrawingCommand(first.getAttribute("data-cmd") || "");
      }
    }
  });

  root.querySelector("[data-r=cmdrun]")?.addEventListener("click", () => {
    executeDrawingCommand(cmdInput.value);
  });

  /* ── Overlays: Help, Units, Plot ── */
  let helpEl: HTMLDivElement | null = null;
  function closeOverlay(): void {
    helpEl?.remove();
    helpEl = null;
    cv.focus({ preventScroll: true });
  }

  /* ── Express Tools / Collaborate dialogs ── */

  /** LAYWALK — walk the drawing layer by layer; close restores the previous visibility. */
  function openLayWalk(): void {
    if (!doc) return;
    const prev = new Set(hidden);
    const panel = openOverlay(
      `<b style="font-size:15px;color:#38bdf8">LAYWALK — walk the drawing layer by layer</b>` +
      `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;max-height:280px;overflow:auto">` +
      doc.layers.map((l) => `<button data-lw="${escapeHtml(l.name)}" style="padding:5px 10px">${escapeHtml(l.name)}</button>`).join("") +
      `</div>` +
      `<div style="margin-top:12px;font-size:11px;color:#9aa4b2">Click layers to show only that layer (toggle = add / remove). Close restores what was visible before.</div>` +
      `<div style="margin-top:12px;text-align:right"><button data-r="lw-close" style="padding:6px 14px">Close — restore all</button></div>`,
    );
    const walking = new Set<string>();
    panel.querySelectorAll<HTMLButtonElement>("[data-lw]").forEach((b) => {
      b.onclick = () => {
        const n = b.dataset.lw!;
        if (walking.has(n)) walking.delete(n);
        else walking.add(n);
        hidden.clear();
        if (walking.size) {
          for (const l of doc!.layers) if (!walking.has(l.name)) hidden.add(l.name);
        } else {
          for (const h of prev) hidden.add(h);
        }
        b.classList.toggle("on", walking.has(n));
        draw();
      };
    });
    panel.querySelector("[data-r=lw-close]")?.addEventListener("click", () => {
      hidden.clear();
      for (const h of prev) hidden.add(h);
      closeOverlay();
      draw();
    });
  }

  /** DWGHISTORY — the session command history of this drawing (audit trail). */
  function openDwgHistory(): void {
    const lines = cmdHistEl ? Array.from(cmdHistEl.children).map((d) => d.textContent ?? "") : [];
    const tail = lines.slice(-300).join("\n") || "(no commands run yet in this session)";
    const panel = openOverlay(
      `<b style="font-size:15px;color:#38bdf8">DWGHISTORY — session command history</b>` +
      `<div style="font-size:11px;color:#9aa4b2;margin-top:4px">${escapeHtml(name || "Drawing")} · last ${Math.min(300, lines.length)} entries · ${undoStack.length} undo step(s) deep</div>` +
      `<pre style="white-space:pre-wrap;font:11px/1.5 ui-monospace,monospace;background:#0b0d12;border:1px solid #2a3140;border-radius:8px;padding:12px;margin-top:12px;max-height:320px;overflow:auto">${escapeHtml(tail)}</pre>` +
      `<div style="margin-top:12px;text-align:right"><button data-r="h-close" style="padding:6px 14px">Close</button></div>`,
    );
    panel.querySelector("[data-r=h-close]")?.addEventListener("click", closeOverlay);
  }

  /** CHECKSTANDARDS — audit layers / linetypes / text styles against the standard rules. */
  function openCheckStandards(): void {
    if (!doc) return;
    const issues = P.checkStandards(doc);
    const body = issues.length
      ? issues
          .map(
            (i) =>
              `<div style="display:flex;gap:10px;align-items:baseline;padding:4px 0;border-bottom:1px solid #222a37">` +
              `<span style="flex:none;font-weight:600;color:${i.severity === "error" ? "#f87171" : "#fbbf24"}">${i.severity === "error" ? "ERROR" : "WARN"}</span>` +
              `<span>${escapeHtml(i.message)}</span></div>`,
          )
          .join("")
      : `<div style="color:#4ade80;padding:8px 0">No standards problems found — layers, linetypes and text styles all resolve.</div>`;
    const panel = openOverlay(
      `<b style="font-size:15px;color:#38bdf8">CHECKSTANDARDS — drawing standards audit</b>` +
      `<div style="font-size:11px;color:#9aa4b2;margin-top:4px">${escapeHtml(name || "Drawing")} · ${doc.layers.length} layers · ${ents.length} objects · ${issues.length} issue(s)</div>` +
      `<div style="margin-top:12px;font-size:12px">${body}</div>` +
      `<div style="margin-top:14px;text-align:right"><button data-r="s-close" style="padding:6px 14px">Close</button></div>`,
    );
    panel.querySelector("[data-r=s-close]")?.addEventListener("click", closeOverlay);
    logCmd(`CHECKSTANDARDS: ${issues.length} issue(s) found — ${issues.filter((i) => i.severity === "error").length} error(s), ${issues.filter((i) => i.severity === "warning").length} warning(s).`);
  }

  function openOverlay(html: string): HTMLDivElement {
    helpEl?.remove();
    const el = document.createElement("div");
    helpEl = el;
    el.style.cssText =
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);z-index:20;backdrop-filter:blur(4px)";
    el.innerHTML = `<div data-r="panel" style="background:#151a23;border:1px solid #334155;border-radius:10px;padding:20px 24px;max-width:680px;max-height:88%;overflow:auto;line-height:1.6;box-shadow:0 8px 32px rgba(0,0,0,0.6)">${html}</div>`;
    el.onclick = (ev) => {
      if (ev.target === el) closeOverlay();
    };
    $("stage").appendChild(el);
    return el;
  }

  function openUnitsDialog(): void {
    const panel = openOverlay(`
      <b style="font-size:15px;color:#38bdf8">drawing workspace Drawing Units (UNITS)</b>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px">
        <div>
          <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Length Type:</label>
          <select style="width:100%"><option>Decimal</option><option>Architectural</option><option>Engineering</option></select>
        </div>
        <div>
          <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Precision:</label>
          <select style="width:100%"><option>0.0000</option><option>0.00</option><option>0.000000</option></select>
        </div>
      </div>
      <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
        <button data-r="un-close" style="padding:5px 14px;background:#0284c7;color:white;border:none;border-radius:4px">OK</button>
      </div>
    `);
    panel.querySelector("[data-r=un-close]")?.addEventListener("click", closeOverlay);
  }

  function showSelectionList(): void {
    if (!sel.size) {
      logCmd("Command: LIST — Select objects first.");
      return;
    }
    let totalLen = 0;
    const rows: string[] = [];
    for (const i of sel) {
      const e = ents[i];
      if (!e) continue;
      const met = M.entityMetrics(e);
      if (met.length != null) totalLen += met.length;
      rows.push(
        `<tr><td>${i}</td><td>${escapeHtml(e.type)}</td><td>${escapeHtml(e.layer)}</td><td style="text-align:right">${
          met.length != null ? escapeHtml(fmt(met.length)) : "—"
        }</td></tr>`,
      );
    }
    const panel = openOverlay(`
      <b style="font-size:14px;color:#38bdf8">drawing workspace Database Entity List (LIST)</b><br>
      <span style="color:#9aa4b2">${sel.size} objects selected · Total length: ${escapeHtml(fmt(totalLen))}</span>
      <table style="width:100%;margin-top:10px;font-size:12px">
        <thead><tr style="color:#9aa4b2;text-align:left"><th>#</th><th>Type</th><th>Layer</th><th style="text-align:right">Length</th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>
      <div style="margin-top:14px"><button data-r="rep-close" style="padding:6px 14px">Close</button></div>
    `);
    panel.querySelector("[data-r=rep-close]")?.addEventListener("click", closeOverlay);
  }

  function toggleHelp(): void {
    if (helpEl) {
      closeOverlay();
      return;
    }
    const panel = openOverlay(`
      <b style="font-size:15px;color:#38bdf8">drawing workspace Command &amp; Shortcut Guide</b>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;font-size:12px">
        <div>
          <b style="color:#f8fafc">Modify Commands:</b><br>
          • <b>M / MOVE</b> — Move selected objects (base point → displacement)<br>
          • <b>CO / COPY</b> — Copy objects, click repeatedly for multiple copies<br>
          • <b>RO / ROTATE</b> — Rotate about a base point (drag or type angle)<br>
          • <b>MI / MIRROR</b> — Mirror about a 2-point axis (Y erases sources)<br>
          • <b>SC / SCALE</b> — Scale about a base point (drag or type factor)<br>
          • <b>O / OFFSET</b> — Parallel copy: distance → object → side<br>
          • <b>E / ERASE</b> — Delete selected entities<br>
          • <b>U / UNDO</b> — Undo (Ctrl+Z) · <b>REDO</b> — Redo (Ctrl+Y)<br>
        </div>
        <div>
          <b style="color:#f8fafc">Modify Tips:</b><br>
          • Select objects first, then run the command (noun–verb)<br>
          • Right-click or Enter finishes the Select objects stage<br>
          • Numeric input (angle / factor / distance) is typed in the command line<br>
          • Yellow dashed ghost previews every transform before you click<br>
          • <b>F3</b> — Object Snap (OSNAP) ON/OFF<br>
          • <b>F8</b> — Ortho mode ON/OFF<br>
          • <b>F12</b> — Dynamic Input HUD ON/OFF<br>
          • <b>LA / LAYER</b> — Layer Properties Manager<br>
        </div>
      </div>
      <div style="margin-top:14px;text-align:right"><button data-r="help-close" style="padding:6px 14px">OK</button></div>
    `);
    panel.querySelector("[data-r=help-close]")?.addEventListener("click", closeOverlay);
  }

  /* ── Plot / PDF Exporter ── */
  function openPlot(): void {
    if (!doc) return;
    const panel = openOverlay(`
      <b style="font-size:15px;color:#38bdf8">drawing workspace Plot — Model / Sheet to PDF</b>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 14px;margin-top:12px;align-items:center;font-size:12px">
        <label>Paper Size:</label>
        <select data-p="paper">${Object.keys(M.PAPER_MM).map((k) => `<option ${k === "A3" ? "selected" : ""}>${k}</option>`).join("")}</select>
        <label>Orientation:</label>
        <select data-p="ori"><option value="l">Landscape</option><option value="p">Portrait</option></select>
        <label>Plot Area:</label>
        <select data-p="area"><option value="display">Display (Screen)</option><option value="extents">Extents</option></select>
        <label>Plot Style:</label>
        <select data-p="mono"><option value="1">Monochrome.ctb (Black &amp; White)</option><option value="0">As Drawn (Color)</option></select>
        <label>Pen Table:</label>
        <span style="display:flex;gap:6px;align-items:center">
          <button data-p="ctbload" style="padding:3px 10px">Load CTB / STB…</button>
          <span data-p="ctbname" style="font-size:11px;color:#9aa4b2">none</span>
        </span>
        <input type="file" data-p="ctbfile" accept=".ctb,.stb" style="display:none">
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button data-p="cancel" style="padding:6px 12px">Cancel</button>
        <button data-p="go" style="background:#0284c7;color:white;border:none;padding:6px 16px;border-radius:4px;font-weight:600">Plot / Print PDF</button>
      </div>
    `);
    const gP = (k: string) => panel.querySelector<HTMLInputElement & HTMLSelectElement>(`[data-p=${k}]`)!;
    gP("cancel").onclick = closeOverlay;
    // Pen table: load a real drawing workspace CTB/STB file and plot through it.
    gP("ctbload").onclick = () => gP("ctbfile").click();
    gP("ctbfile").onchange = async () => {
      const f = gP("ctbfile").files?.[0];
      if (!f) return;
      const res = await loadPlotStyleFile(f);
      if (!res) {
        logCmd(`Could not read plot style table ${f.name} — not a valid CTB/STB file.`);
        return;
      }
      plotStyle = res;
      panel.querySelector("[data-p=ctbname]")!.textContent =
        `${res.fileName} — ${res.table.kind.toUpperCase()}, ${res.table.styles.length} style(s)`;
      logCmd(
        `Pen table loaded: ${res.fileName} (${res.table.kind.toUpperCase()}, ${res.table.styles.length} styles${res.table.description ? `, "${res.table.description}"` : ""}) — plotting will map colours, screening and lineweights through it.`,
      );
      gP("ctbfile").value = "";
    };
    gP("go").onclick = () => {
      const o = {
        paper: gP("paper").value,
        land: gP("ori").value === "l",
        area: gP("area").value,
        mono: gP("mono").value === "1",
      };
      closeOverlay();
      doPlot(o);
    };
  }

  function doPlot(o: { paper: string; land: boolean; area: string; mono: boolean }): void {
    if (!doc) return;
    const pg = M.paperMm(o.paper, o.land),
      px = M.plotPixels(pg.w, pg.h, 8, 150);
    const box = o.area === "extents" ? bounds ?? modelBounds! : visibleBox(view);
    const pv = M.fitView(box, px.w, px.h, 0.02);
    const c = document.createElement("canvas");
    c.width = px.w;
    c.height = px.h;
    const x = c.getContext("2d")!;
    const keep = { bg, cmode, lw };
    bg = "white";
    // Loaded CTB/STB pen table maps every entity through its plot styles.
    cmode = o.mono ? "bw" : plotStyle ? "style" : "layer";
    lw = Math.max(lw, px.w / 1200);
    try {
      render(x, pv, false);
    } finally {
      bg = keep.bg;
      cmode = keep.cmode;
      lw = keep.lw;
    }
    const url = c.toDataURL("image/png");
    const w = window.open("", "_blank");
    if (!w) {
      status("Allow pop-ups to print");
      return;
    }
    w.document.write(
      `<!doctype html><title>${escapeHtml(name || "Plot")}</title><style>@page{size:${o.paper} ${
        o.land ? "landscape" : "portrait"
      };margin:8mm}html,body{margin:0}img{width:100%;display:block}</style><img src="${url}">`,
    );
    w.document.close();
    w.onload = () => w.print();
  }

  function base(): string {
    return (name || "drawing").replace(/\.[^.]+$/, "");
  }

  /** Save the edited drawing back to DXF R2010 (QSAVE / SAVE). */
  function saveDxf(): void {
    if (!doc) {
      logCmd("Nothing to save — open a DWG or DXF drawing first.");
      status("Nothing to save");
      return;
    }
    // doc.entities goes stale after erase/undo (the live list is rebound), so
    // serialize from modelEnts — it is kept in sync by add/erase/undo/redo.
    const entities = layoutI < 0 ? ents : modelEnts;
    const fn = `${base()}.dxf`;
    const text = writeDxf({ ...doc, entities });
    const blob = new Blob([text], { type: "application/dxf" });
    download(blob, fn);
    // Refresh the welcome-screen drawing history with the freshly saved bytes.
    void recordRecentDrawing({ name: fn, format: "DXF", size: blob.size, blob });
    logCmd(`Saved ${fn} — ${entities.length} entities, ${doc.layers.length} layers.`);
    const lost = layoutsNotSaved(doc);
    if (lost) uiAlert(`${fn} was saved with the first sheet only. ${lost} other layout${lost === 1 ? "" : "s"} could not be saved to DXF yet.`);
    status(`Saved ${fn}`);
    markSaved();
    setTimeout(() => status(""), 4000);
  }

    /** DWG version used by DWGSAVE; remembered per browser. */
  const DWG_VERSION_KEY = "obs.cad.dwgVersion";
  function currentDwgVersion(): DwgVersionCode {
    try {
      const v = localStorage.getItem(DWG_VERSION_KEY);
      if (v && DWG_VERSIONS.some((x) => x.code === v)) return v as DwgVersionCode;
    } catch { /* storage unavailable */ }
    return DEFAULT_DWG_VERSION;
  }
  async function chooseDwgVersion(): Promise<void> {
    const cur = currentDwgVersion();
    const picked = await pickFromList(
      "DWG version",
      "Write DWG files that open in:",
      DWG_VERSIONS.map((v) => ({ value: v.code, label: v.label })),
      cur,
    );
    if (!picked) { logCmd(`DWG version unchanged: ${dwgVersionLabel(cur)}.`); return; }
    try { localStorage.setItem(DWG_VERSION_KEY, picked); } catch { /* storage unavailable */ }
    const note = DWG_VERSIONS.find((v) => v.code === picked)?.note;
    logCmd(`DWG export now writes ${dwgVersionLabel(picked)}.${note ? " " + note : ""}`);
    status(`DWG version: ${dwgVersionLabel(picked)}`);
  }

/** Export the live edited model as a real binary DWG using the local acadrust WASM writer. */
  async function saveDwg(): Promise<void> {
    if (!doc) {
      logCmd("Nothing to export — open or create a drawing first.");
      status("Nothing to export");
      return;
    }
    // Model-space geometry is exported; the first paper-space sheet comes along from doc.layouts.
    const entities = layoutI < 0 ? ents : modelEnts;
    const fn = `${base()}.dwg`;
    if (!entities.length) {
      logCmd("Nothing to export — the model has no drawable entities.");
      status("Nothing to export");
      return;
    }
    // Advisory only: layouts / dim styles / text styles / import skips must NOT
    // block DWG save. The writer serializes supported model entities; the rest
    // is reported so the user knows what is approximate.
    const skippedEntities = Object.values(doc.skipped ?? {}).reduce((sum, count) => sum + count, 0);
    const layoutCount = doc.layouts?.length ?? 0; // every sheet goes through the DWG converter
    const dimensionStyleCount = Math.max(doc.dimStyles?.length ?? 0, Object.keys(doc.dimStyleTable ?? {}).length);
    const customTextStyles = Object.keys(doc.textStyles ?? {}).filter((name) => !/^standard$/i.test(name));
    const notes = [
      skippedEntities ? `${skippedEntities} entity type(s) were skipped on import (not in model)` : "",
      layoutCount ? `${layoutCount} paper-space sheet(s) written; sheet names are not kept in DWG` : "",
      dimensionStyleCount ? `${dimensionStyleCount} dim style(s) may be simplified` : "",
      customTextStyles.length ? `${customTextStyles.length} custom text style(s) may map to Standard` : "",
    ].filter(Boolean);
    if (notes.length) {
      logCmd(`DWG export notes: ${notes.join("; ")}.`);
    }
    try {
      status("Exporting DWG…");
      // Real HATCH entities and the first paper-space sheet go through the converter;
      // tests/cad-dwg-roundtrip.test.cjs reads the DWG back with the real engine.
      const dwgVersion = currentDwgVersion();
      const dxf = writeDxf({ ...doc, entities }, { version: dwgVersion, allLayouts: true });
      await validateDxfForDwgExport(dxf, entities.length, doc.layers.map((layer) => layer.name));
      const bytes = await exportDxfToDwg(dxf);
      const blobBuffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(blobBuffer).set(bytes);
      const blob = new Blob([blobBuffer], { type: "application/acad" });
      // Record the exported DWG in the welcome-screen drawing history.
      void recordRecentDrawing({ name: fn, format: "DWG", size: blob.size, blob });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fn;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      logCmd(`Exported ${fn} — ${entities.length} entities, ${doc.layers.length} layers, ${dwgVersionLabel(dwgVersion)} (change with DWGVERSION).`);
      status(`Exported ${fn}`);
      markSaved();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Legacy WASM hard-fails on tiny entity-count drift (e.g. 337780 → 337548).
      // Offer DXF so the user still gets a file; new engine tolerates small drift.
      const m = /input has (\d+) entities but DWG re-opened with (\d+)/i.exec(message);
      if (m) {
        const expected = Number(m[1]);
        const actual = Number(m[2]);
        const lost = Math.max(0, expected - actual);
        const pct = expected > 0 ? (lost * 100) / expected : 100;
        logCmd(
          `DWG writer reported ${lost} entit${lost === 1 ? "y" : "ies"} not re-read (${pct.toFixed(3)}%). ` +
            (pct <= 2
              ? "Saving DXF fallback (same geometry). Update the app to get soft DWG verify."
              : "Saving DXF fallback."),
        );
        try {
          const dxfName = `${base()}.dxf`;
          downloadDxf({ ...doc, entities, layouts: undefined }, dxfName);
          status(`Saved ${dxfName} (DWG verify soft-fail)`);
          markSaved();
        } catch (e2) {
          logCmd(`DXF fallback failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
          status("DWG export failed");
        }
      } else {
        logCmd(`DWG export failed: ${message}`);
        status("DWG export failed");
      }
      console.error("[Drawing] DWG export failed:", error);
    }
    window.setTimeout(() => status(""), 5000);
  }

  /* ── Super Copy — cross-drawing clipboard (COPYCLIP / PASTECLIP / PASTEORIG) ──
     Ctrl+C copies the selection together with its layer / linetype / text-style
     definitions and mirrors the payload to localStorage, so the clipboard works
     across drawing tabs, survives a reload and travels between app windows. */

  const CLIP_STORAGE_KEY = "obs.cad.clipboard.v2";

  /** Paste entry points converge here: fall back to the persisted clipboard. */
  function ensureClip(): CadClip | null {
    if (clip && clip.entities.length) return clip;
    try {
      const restored = parseClip(localStorage.getItem(CLIP_STORAGE_KEY));
      if (restored) {
        clip = restored;
        const age = restored.savedAt ? ` (${fmtTime(restored.savedAt)})` : "";
        logCmd(`Clipboard restored${restored.sourceName ? ` from ${restored.sourceName}` : ""}${age} — ${restored.entities.length} object(s).`);
      }
    } catch {
      /* private browsing / storage blocked */
    }
    return clip && clip.entities.length ? clip : null;
  }

  function persistClip(): void {
    if (!clip) return;
    try {
      const json = serializeClip(clip);
      if (json) localStorage.setItem(CLIP_STORAGE_KEY, json);
    } catch {
      /* quota or private browsing — the in-memory clipboard still works */
    }
  }

  function copySelection(): boolean {
    if (!sel.size) {
      logCmd("COPYCLIP: 0 found — select objects first.");
      return false;
    }
    const list = [...sel].map((i) => ents[i]).filter(Boolean);
    const b = idx ? M.bboxOfSet(idx, sel) : null;
    const deps = collectClipDeps(list, doc);
    clip = makeClip(
      list,
      b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : undefined,
      name || undefined,
      deps,
    );
    if (!clip) return false;
    persistClip();
    const carried = [
      deps.layers?.length ? `${deps.layers.length} layer(s)` : null,
      deps.linetypes ? `${Object.keys(deps.linetypes).length} linetype(s)` : null,
      deps.textStyles ? `${Object.keys(deps.textStyles).length} text style(s)` : null,
    ].filter(Boolean).join(", ");
    logCmd(`COPYCLIP: ${list.length} object(s)${carried ? ` + ${carried}` : ""} — switch file tab and press Ctrl+V (or Ctrl+Shift+V) to paste.`);
    return true;
  }

  /**
   * Super Copy style carry-over: add the clipboard's layer / linetype / text
   * style definitions that are missing from this drawing, so pasted entities
   * keep their source colours, dash patterns and fonts. Existing definitions
   * always win (same rule as the drawing IMPORT merge).
   */
  function applyClipCarryOver(): void {
    if (!doc || !clip) return;
    const miss = missingClipDeps(doc, clip);
    for (const l of miss.layers) doc.layers.push({ ...l });
    if (miss.layers.length) {
      for (const l of miss.layers) if (l.off || l.frozen) hidden.add(l.name);
      buildLayers();
    }
    if (miss.linetypes.length) {
      doc.linetypes = doc.linetypes ?? {};
      for (const [ltName, pat] of miss.linetypes) doc.linetypes[ltName.toUpperCase()] = [...pat];
    }
    if (miss.textStyles.length) {
      doc.textStyles = doc.textStyles ?? {};
      for (const [stName, s] of miss.textStyles) doc.textStyles[stName.toUpperCase()] = { ...s };
    }
    const bits = [
      miss.layers.length ? `${miss.layers.length} layer(s)` : null,
      miss.linetypes.length ? `${miss.linetypes.length} linetype(s)` : null,
      miss.textStyles.length ? `${miss.textStyles.length} text style(s)` : null,
    ].filter(Boolean);
    if (bits.length) logCmd(`PASTECLIP: carried over missing ${bits.join(", ")} from the clipboard.`);
  }

  let pasteN = 0;
  function pasteInstance(atWorld?: M.Pt, toOrigin = false): number {
    if (!doc) {
      logCmd("Nothing to paste — open a drawing first.");
      return 0;
    }
    const c0 = ensureClip();
    if (!c0) {
      logCmd("Clipboard is empty — COPYCLIP objects in any drawing tab first.");
      return 0;
    }
    applyClipCarryOver();
    const c = M.screenToWorld(view, view.w / 2, view.h / 2);
    const span = bounds ? Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) : 0;
    const off = pasteN * Math.max(span * 0.02, 1e-9);
    const at = toOrigin ? undefined : atWorld ?? { x: c.x + off, y: c.y - off };
    const list = clipInstances(c0, at);
    pasteN++;
    if (!list.length) return 0;
    for (const e of list) {
      ents.push(e);
      if (layoutI < 0) modelEnts.push(e);
    }
    const start = ents.length - list.length;
    undoStack.push({ type: "add", entities: list });
    redoStack.length = 0;
    markDirty();
    rebuildIndex();
    setSel(list.map((_, i) => start + i));
    logCmd(`PASTE${toOrigin ? "ORIG" : "CLIP"}: ${list.length} object(s)${c0.sourceName ? ` from ${c0.sourceName}` : ""}`);
    draw();
    return list.length;
  }
  const pasteClip = (_at?: M.Pt): number => {
    // Super Copy default: interactive placement — the clipboard ghosts onto the
    // cursor and every click drops a copy (repeatable), like native PASTECLIP.
    ensureClip();
    setTool("paste");
    return 0;
  };
  const pasteOrig = (): number => pasteInstance(undefined, true);

  function download(blob: Blob, fn: string): void {
    const a = document.createElement("a");
    const u = URL.createObjectURL(blob);
    a.href = u;
    a.download = fn;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  }

  function exportSvg(): void {
    if (!doc) return;
    const v = view,
      o: string[] = [],
      uid = { n: 0 };
    const F = (n: number) => n.toFixed(2);
    const P = (x: number, y: number) => {
      const q = M.worldToScreen(v, x, y);
      return `${F(q.x)},${F(q.y)}`;
    };

    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!shown(e)) continue;
      const col = colorOf(e);
      const st = `stroke="${col}" fill="none" stroke-width="${lw}"`;
      if (e.type === "LINE") {
        const a = M.worldToScreen(v, e.start.x, e.start.y),
          b = M.worldToScreen(v, e.end.x, e.end.y);
        o.push(`<line x1="${F(a.x)}" y1="${F(a.y)}" x2="${F(b.x)}" y2="${F(b.y)}" ${st}/>`);
      } else if (e.type === "CIRCLE") {
        const c = M.worldToScreen(v, e.center.x, e.center.y);
        o.push(`<circle cx="${F(c.x)}" cy="${F(c.y)}" r="${F(e.radius * v.scale)}" ${st}/>`);
      } else if (e.type === "LWPOLYLINE") {
        o.push(
          `<${e.closed ? "polygon" : "polyline"} points="${e.points.map((q) => P(q.x, q.y)).join(" ")}" ${st}/>`,
        );
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${v.w}" height="${v.h}" viewBox="0 0 ${v.w} ${
      v.h
    }"><rect width="100%" height="100%" fill="${BG[bg] || BG.drafting}"/>${o.join("")}</svg>`;
    download(new Blob([svg], { type: "image/svg+xml" }), `${base()}.svg`);
  }

  function fillMenus(): void {
    /* noop for compatibility */
  }

  /* Quantity takeoff + drawing info — shared by Output › Export and Insert › Data. */
  function doTakeoff(): void {
    if (!doc) return;
    const rows = new Map<string, { type: string; layer: string; count: number; totalLength: number }>();
    for (const e of ents) {
      if (!shown(e)) continue;
      const key = e.type + "|" + e.layer;
      let r = rows.get(key);
      if (!r) {
        r = { type: e.type, layer: e.layer, count: 0, totalLength: 0 };
        rows.set(key, r);
      }
      r.count++;
      const m = M.entityMetrics(e);
      if (m.length != null) r.totalLength += m.length;
    }
    const sorted = [...rows.values()].sort((a, b) => a.type.localeCompare(b.type) || a.layer.localeCompare(b.layer));
    const csv = "type,layer,count,totalLength\n" + sorted.map((r) => r.type + "," + r.layer + "," + r.count + "," + (r.totalLength * scaleCal).toFixed(3)).join("\n");
    download(new Blob([csv], { type: "text/csv" }), base() + "-takeoff.csv");
    logCmd("Takeoff: " + sorted.length + " row(s) exported from " + ents.length + " visible entities");
  }

  function doInfo(): void {
    if (!doc) return;
    // Full drawing status report — everything the reader pulled out of
    // the file's tables and entities, so "what did we read" is answerable in UI.
    const ltNames = Object.keys(doc.linetypes ?? {});
    const styleEntries = Object.entries(doc.textStyles ?? {});
    const dimNames = doc.dimStyles ?? [];
    const fontsInFile = [...new Set(styleEntries.map(([, s]) => s.font).filter((f): f is string => !!f))];
    const fontList = (fs: string[]) => (fs.length ? escapeHtml(fs.slice(0, 14).join(", ")) + (fs.length > 14 ? `, … (+${fs.length - 14})` : "") : "—");
    const styleList = styleEntries.length
      ? styleEntries
          .map(([sn, s]) => `${escapeHtml(sn)} → ${escapeHtml(s.font ?? "default")}${s.height ? ` (h=${s.height})` : ""}${s.bigFont ? ` +${escapeHtml(s.bigFont)}` : ""}`)
          .join("<br>")
      : "—";
    const skippedBits = Object.entries(doc.skipped ?? {})
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} (${n})`);
    const panel = openOverlay(`
        <b style="font-size:15px;color:#38bdf8">Drawing Database Status</b>
        <table style="margin-top:10px;font-size:12px;width:100%">
          <tr><td>File Name:</td><td>${escapeHtml(name)}</td></tr>
          <tr><td>Database Format:</td><td>${escapeHtml((doc.sourceFormat ?? "").toUpperCase())}</td></tr>
          <tr><td>Embedded Preview:</td><td>${previewInfo ? `${previewInfo.format.toUpperCase()} ${previewInfo.width}×${previewInfo.height} — native DWG thumbnail shown while reading` : "none"}</td></tr>
          <tr><td>Drawing Units:</td><td>${escapeHtml(doc.units ?? "unitless")}</td></tr>
          <tr><td>Total Entities:</td><td>${modelEnts.length}</td></tr>
          <tr><td>Total Layers:</td><td>${doc.layers.length}</td></tr>
          <tr><td>Active Layouts:</td><td>${doc.layouts?.length ?? 1}</td></tr>
          <tr><td>Linetype Table:</td><td>${ltNames.length} defined${ltNames.length ? ` — ${escapeHtml(ltNames.slice(0, 12).join(", "))}${ltNames.length > 12 ? ", …" : ""}` : ""}</td></tr>
          <tr><td>LTSCALE:</td><td>${escapeHtml(String(doc.ltscale ?? 1))}</td></tr>
          <tr><td>Text Style Table:</td><td>${styleEntries.length} style(s)</td></tr>
        </table>
        ${styleEntries.length ? `<div style="margin-top:6px;font-size:11px;line-height:1.55;color:#c3cad6;background:#12141c;border:1px solid #1f2633;border-radius:6px;padding:8px 10px">${styleList}</div>` : ""}
        <table style="margin-top:8px;font-size:12px;width:100%">
          <tr><td>Fonts in Drawing:</td><td>${fontList(fontsInFile)}</td></tr>
          <tr><td>Dimension Style Table:</td><td>${dimNames.length} style(s)${dimNames.length ? ` — ${escapeHtml(dimNames.slice(0, 12).join(", "))}${dimNames.length > 12 ? ", …" : ""}` : ""}</td></tr>
          <tr><td>Entities Not Drawn:</td><td>${skippedBits.length ? escapeHtml(skippedBits.join(", ")) : "none"}</td></tr>
        </table>
        <div style="margin-top:14px"><button data-r="inf-close" style="padding:6px 14px">Close</button></div>
      `);
    panel.querySelector("[data-r=inf-close]")?.addEventListener("click", closeOverlay);
  }

  /* ── Drawing maintenance: PURGE / AUDIT / OVERKILL ── */

  /** PURGE: delete layers that carry no entities and are not current. */
  function purgeDrawing(): void {
    if (!doc) return;
    const used = new Set<string>(["0", currentLayer]);
    for (const e of modelEnts) used.add(e.layer);
    for (const L of doc.layouts ?? []) for (const e of L.entities) used.add(e.layer);
    const removed: string[] = [];
    doc.layers = doc.layers.filter((l) => {
      if (used.has(l.name)) return true;
      removed.push(l.name);
      return false;
    });
    for (const nm of removed) hidden.delete(nm);
    buildLayers();
    markDirty();
    logCmd(removed.length ? `PURGE: ${removed.length} unused layer(s) removed — ${removed.join(", ")}.` : "PURGE: no unreferenced layers found.");
  }

  /** AUDIT / OVERKILL: repair layer refs, drop zero-length and duplicate entities. */
  function auditDrawing(overkillOnly = false): void {
    if (!doc) return;
    const layerNames = new Set(doc.layers.map((l) => l.name));
    const before: DxfEntity[] = [...ents];
    const repaired: DxfEntity[] = [];
    const seen = new Set<string>();
    let fixedLayer = 0,
      zeroLen = 0,
      dupes = 0;
    const sig = (e: DxfEntity): string => {
      const f = (v: number): string => v.toFixed(6);
      switch (e.type) {
        case "LINE":
          return `L|${e.layer}|${f(e.start.x)},${f(e.start.y)}|${f(e.end.x)},${f(e.end.y)}`;
        case "CIRCLE":
          return `C|${e.layer}|${f(e.center.x)},${f(e.center.y)}|${f(e.radius)}`;
        case "ARC":
          return `A|${e.layer}|${f(e.center.x)},${f(e.center.y)}|${f(e.radius)}|${f(e.startAngle)}|${f(e.endAngle)}`;
        case "LWPOLYLINE":
          return `P|${e.layer}|${e.closed ? 1 : 0}|${e.points.map((q) => `${f(q.x)},${f(q.y)}`).join(";")}`;
        case "TEXT":
          return `T|${e.layer}|${f(e.position.x)},${f(e.position.y)}|${e.value}`;
        case "POINT":
          return `D|${e.layer}|${f(e.position.x)},${f(e.position.y)}`;
        case "RAY":
          return `R|${e.layer}|${f(e.start.x)},${f(e.start.y)}|${f(e.direction.x)},${f(e.direction.y)}`;
        case "XLINE":
          return `X|${e.layer}|${f(e.start.x)},${f(e.start.y)}|${f(e.direction.x)},${f(e.direction.y)}`;
      }
    };
    for (const e of before) {
      let cur = e;
      if (!layerNames.has(cur.layer)) {
        cur = { ...cur, layer: "0" };
        fixedLayer++;
      }
      const dead =
        (cur.type === "LINE" && Math.hypot(cur.end.x - cur.start.x, cur.end.y - cur.start.y) < 1e-9) ||
        (cur.type === "CIRCLE" && cur.radius < 1e-9) ||
        (cur.type === "LWPOLYLINE" && cur.points.length < 2) ||
        (cur.type === "TEXT" && !cur.value.trim());
      if (dead) {
        zeroLen++;
        continue;
      }
      const s = sig(cur);
      if (seen.has(s)) {
        dupes++;
        continue;
      }
      seen.add(s);
      repaired.push(cur);
    }
    if (fixedLayer || zeroLen || dupes) {
      commitReplace(before, repaired);
      logCmd(
        `AUDIT: ${fixedLayer} layer reference(s) repaired, ${zeroLen} degenerate object(s) removed, ${dupes} duplicate(s) removed.`,
      );
    } else logCmd(overkillOnly ? "OVERKILL: no duplicate objects found." : "AUDIT: no errors found in the drawing database.");
  }

  /* ── Named views (VIEW S / VIEW R) ── */
  function saveNamedView(): void {
    void promptLine("Save View", "View name", `View${namedViews.size + 1}`).then((nm) => {
      const k = (nm ?? "").trim();
      if (!k) return;
      namedViews.set(k, { ...view });
      logCmd(`VIEW: saved "${k}".`);
    });
  }

  function restoreNamedView(): void {
    const names = [...namedViews.keys()];
    if (!names.length) {
      logCmd("VIEW: no saved views (VIEW S <name>).");
      return;
    }
    void promptLine("Restore View", `Name — ${names.join(", ")}`, names[0]).then((nm) => {
      const k = (nm ?? "").trim();
      const v = namedViews.get(k);
      if (!v) {
        logCmd(`VIEW: "${k}" not found.`);
        return;
      }
      pushView();
      view = { ...v, w: view.w, h: view.h };
      draw();
      logCmd(`VIEW: restored "${k}".`);
    });
  }

  function viewCommand(rest: string[]): void {
    const sub = (rest[0] ?? "").toUpperCase();
    const k = rest.slice(1).join(" ").trim();
    if (sub === "S" || sub === "SAVE") {
      if (k) {
        namedViews.set(k, { ...view });
        logCmd(`VIEW: saved "${k}".`);
      } else saveNamedView();
      return;
    }
    if (sub === "R" || sub === "RESTORE") {
      if (k) {
        const v = namedViews.get(k);
        if (!v) {
          logCmd(`VIEW: "${k}" not found.`);
          return;
        }
        pushView();
        view = { ...v, w: view.w, h: view.h };
        draw();
        logCmd(`VIEW: restored "${k}".`);
      } else restoreNamedView();
      return;
    }
    const names = [...namedViews.keys()];
    logCmd(names.length ? `VIEW: saved views — ${names.join(", ")}` : "VIEW: no saved views (VIEW S <name>).");
  }

  /* ── Layer states (LAYERSTATE S / R) ── */
  function saveLayerState(): void {
    void promptLine("Layer State", "State name", `State${layerStates.size + 1}`).then((nm) => {
      const k = (nm ?? "").trim();
      if (!k || !doc) return;
      layerStates.set(k, {
        off: doc.layers.filter((l) => l.off).map((l) => l.name),
        frozen: doc.layers.filter((l) => l.frozen).map((l) => l.name),
      });
      const st = layerStates.get(k)!;
      logCmd(`LAYERSTATE: saved "${k}" (${st.off.length} off, ${st.frozen.length} frozen).`);
    });
  }

  function restoreLayerState(): void {
    const names = [...layerStates.keys()];
    if (!names.length) {
      logCmd("LAYERSTATE: no saved states (LAYERSTATE S <name>).");
      return;
    }
    void promptLine("Restore Layer State", `Name — ${names.join(", ")}`, names[0]).then((nm) => {
      const k = (nm ?? "").trim();
      const st = layerStates.get(k);
      if (!st || !doc) {
        logCmd(`LAYERSTATE: "${k}" not found.`);
        return;
      }
      for (const l of doc.layers) {
        l.off = st.off.includes(l.name);
        l.frozen = st.frozen.includes(l.name);
        if (l.off || l.frozen) hidden.add(l.name);
        else hidden.delete(l.name);
      }
      buildLayers();
      draw();
      logCmd(`LAYERSTATE: restored "${k}".`);
    });
  }

  function layerStateCommand(rest: string[]): void {
    const sub = (rest[0] ?? "").toUpperCase();
    const k = rest.slice(1).join(" ").trim();
    if (sub === "S" || sub === "SAVE") {
      if (k && doc) {
        layerStates.set(k, {
          off: doc.layers.filter((l) => l.off).map((l) => l.name),
          frozen: doc.layers.filter((l) => l.frozen).map((l) => l.name),
        });
        logCmd(`LAYERSTATE: saved "${k}".`);
      } else saveLayerState();
      return;
    }
    if (sub === "R" || sub === "RESTORE") {
      if (k && doc) {
        const st = layerStates.get(k);
        if (!st) {
          logCmd(`LAYERSTATE: "${k}" not found.`);
          return;
        }
        for (const l of doc.layers) {
          l.off = st.off.includes(l.name);
          l.frozen = st.frozen.includes(l.name);
          if (l.off || l.frozen) hidden.add(l.name);
          else hidden.delete(l.name);
        }
        buildLayers();
        draw();
        logCmd(`LAYERSTATE: restored "${k}".`);
      } else restoreLayerState();
      return;
    }
    const names = [...layerStates.keys()];
    logCmd(names.length ? `LAYERSTATE: saved states — ${names.join(", ")}` : "LAYERSTATE: no saved states (LAYERSTATE S <name>).");
  }

  /* ── FIND / REPLACE text ── */
  async function findReplace(): Promise<void> {
    const q = await promptLine("Find and Replace", "Text to find", "");
    if (!q) return;
    const rep = await promptLine("Replace With", "Replacement text (empty removes it)", "");
    const before: DxfEntity[] = [];
    const after: DxfEntity[] = [];
    for (const e of ents) {
      if (e.type !== "TEXT" || !e.value.includes(q)) continue;
      before.push(e);
      after.push({ ...e, value: e.value.split(q).join(rep ?? "") });
    }
    if (!before.length) {
      logCmd(`FIND: "${q}" not found in the drawing.`);
      return;
    }
    commitReplace(before, after);
    logCmd(`FIND: ${before.length} text object(s) updated.`);
  }

  /* ── Rectangular ARRAY ── */
  function arrayRect(): void {
    if (!sel.size) {
      logCmd("ARRAY: select objects first.");
      return;
    }
    void promptLine("Rectangular Array", "rows columns rowSpacing colSpacing [gridAngleDeg] (maximum 10,000 new objects)", "2 2 100 100 0").then((s) => {
      const m = (s ?? "").trim().split(/\s+/).map(Number);
      if ((m.length !== 4 && m.length !== 5) || m.some((x) => !Number.isFinite(x))) {
        logCmd("ARRAY: enter rows columns rowSpacing colSpacing and optional grid angle.");
        return;
      }
      const [rows, cols, rs, cs, angle = 0] = m;
      const before = [...sel].map((i) => ents[i]).filter((e): e is DxfEntity => !!e);
      try {
        const copies = X.rectArrayEnts(before, rows, cols, rs, cs, angle);
        if (!copies.length) { logCmd("ARRAY: choose more than one row/column position."); return; }
        addEntities(copies);
        logCmd(`ARRAY: ${copies.length} copies added (${rows} rows × ${cols} columns, grid rotated ${angle.toFixed(2)}°).`);
      } catch (err) {
        logCmd(`ARRAY: ${(err as Error).message}`);
      }
    });
  }

  async function arrayPolar(): Promise<void> {
    if (!sel.size) {
      logCmd("ARRAYPOLAR: select objects first.");
      return;
    }
    const before = [...sel].map((i) => ents[i]).filter((e): e is DxfEntity => !!e);
    if (!before.length) return;
    const box = idx ? M.bboxOfSet(idx, sel) : null;
    const defaultCenter = box ? { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 } : { x: 0, y: 0 };
    const centerText = await promptLine("Polar Array — Centre", "Enter centre X,Y in drawing coordinates (the selected extents centre is the default)", `${defaultCenter.x.toPrecision(8)}, ${defaultCenter.y.toPrecision(8)}`);
    if (centerText == null) return;
    const centerParts = centerText.trim().split(/[,;\s]+/).filter(Boolean).map(Number);
    if (centerParts.length !== 2 || centerParts.some((n) => !Number.isFinite(n))) {
      logCmd("ARRAYPOLAR: centre must be two finite coordinates, for example 0,0.");
      return;
    }
    const countText = await promptLine("Polar Array — Items", "Total positions including the original (2–360)", "6");
    if (countText == null) return;
    const count = Number(countText);
    if (!Number.isInteger(count) || count < 2 || count > 360) {
      logCmd("ARRAYPOLAR: item count must be an integer from 2 to 360.");
      return;
    }
    const angleText = await promptLine("Polar Array — Fill Angle", "Sweep in degrees; 360 makes a full circle, negative values run clockwise", "360");
    if (angleText == null) return;
    const angle = Number(angleText);
    if (!Number.isFinite(angle) || Math.abs(angle) < 1e-9 || Math.abs(angle) > 360) {
      logCmd("ARRAYPOLAR: sweep must be non-zero and no greater than 360 degrees.");
      return;
    }
    const rotateText = await promptLine("Polar Array — Rotate Items", "Rotate each copy with the array? (Yes/No)", "Yes");
    if (rotateText == null) return;
    if (!/^(y|yes|n|no|true|false|1|0)$/i.test(rotateText.trim())) {
      logCmd("ARRAYPOLAR: answer Yes or No for Rotate Items.");
      return;
    }
    const rotateItems = /^(y|yes|true|1)$/i.test(rotateText.trim());
    try {
      const copies = X.polarArrayEnts(before, { x: centerParts[0], y: centerParts[1] }, count, angle, rotateItems);
      addEntities(copies);
      logCmd(`ARRAYPOLAR: ${copies.length} copies added around (${fmt(centerParts[0])}, ${fmt(centerParts[1])}), ${count} positions over ${angle}°.`);
    } catch (err) {
      logCmd(`ARRAYPOLAR: ${(err as Error).message}`);
    }
  }

  /* ── Insert tab: blocks, file-as-block, SVG import, fields ── */
  function ensureDocLayers(defs: Array<{ name: string; color: number }>): void {
    if (!doc) return;
    const have = new Set(doc.layers.map((l) => l.name));
    let added = 0;
    for (const l of defs) if (!have.has(l.name)) { doc.layers.push({ ...(l as any) }); added++; }
    if (added) { for (const l of doc.layers) if ((l as any).off || (l as any).frozen) hidden.add(l.name); buildLayers(); }
  }

  /** Ghost-place `entities` at the cursor; each click drops one copy, Enter / Esc ends. */
  function beginPlacement(entities: DxfEntity[], base: { x: number; y: number }, label: string): void {
    pendingPlacement = { entities, base, label };
    setTool("paste");
    draw();
  }

  function blockBaseChoices(b: M.BBox | null): Array<[string, string]> {
    return [
      ["ll", "Lower-left of the selection"],
      ["center", "Centre of the selection"],
      ["origin", "Drawing origin (0,0)"],
    ];
  }
  function resolveBlockBase(choice: string, b: M.BBox | null): { x: number; y: number } {
    if (choice === "origin" || !b) return { x: 0, y: 0 };
    return choice === "center" ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: b.minX, y: b.minY };
  }

  async function createBlockCmd(args: string[]): Promise<void> {
    if (!doc) { logCmd("BLOCK: open or start a drawing first."); return; }
    if (!sel.size) { logCmd("BLOCK: 0 found — select the objects first, then run BLOCK."); return; }
    const list = [...sel].map((i) => ents[i]).filter(Boolean);
    const b = idx ? M.bboxOfSet(idx, sel) : null;
    const r = await openFormModal({
      title: "Create Block",
      subtitle: `${list.length} object(s) selected`,
      fields: [
        { kind: "text", key: "name", label: "Name", default: args[0] ?? `Block${blockLib.size + 1}`, validate: (v) => validateBlockName(String(v)) },
        { kind: "select", key: "base", label: "Base point", options: blockBaseChoices(b), default: "ll", hint: "The point that lands on your click when the block is inserted." },
        { kind: "text", key: "desc", label: "Description", default: "" },
        { kind: "checkbox", key: "remove", label: "Remove the selected objects from the drawing", default: false },
      ],
      submitLabel: "Create",
    });
    if (!r) { logCmd("BLOCK cancelled."); return; }
    const nm = String(r.name).trim();
    if (blockLib.has(nm) && !(await confirmDialog("Redefine block", `A block named "${nm}" already exists. Replace its definition?`))) { logCmd("BLOCK cancelled."); return; }
    try {
      const def = makeBlock(nm, list, resolveBlockBase(String(r.base), b), doc.layers as any, String(r.desc || "") || undefined);
      blockLib.add(def, true);
      const stored = persistBlockLib();
      logCmd(`BLOCK: "${def.name}" defined from ${list.length} object(s).${stored ? "" : " (Could not store it in this browser; it lasts until you close the page.)"}`);
      if (r.remove) eraseSelected();
    } catch (err) { logCmd(`BLOCK failed: ${(err as Error).message}`); }
  }

  async function blockFromFile(f: File): Promise<string | null> {
    try {
      const r = await readCadFile(f);
      const incoming = r.doc.entities.filter((e) => { const bb = M.entityBBox(e); return Number.isFinite(bb.minX + bb.maxX + bb.minY + bb.maxY); });
      if (!incoming.length) throw new Error("the file has no drawable geometry");
      let nm = f.name.replace(/\.[^.]+$/, "").replace(/[<>/\\":;?*|,=`]/g, "_").trim() || "Imported";
      if (nm.startsWith("*")) nm = "_" + nm.slice(1);
      if (blockLib.has(nm) && !(await confirmDialog("Redefine block", `A block named "${nm}" already exists. Replace it with the contents of ${f.name}?`))) return null;
      blockLib.add(makeBlock(nm, incoming, { x: 0, y: 0 }, r.doc.layers as any, `From ${f.name}`), true);
      persistBlockLib();
      logCmd(`INSERT: ${f.name} read as block "${nm}" (${incoming.length} objects, base point 0,0).`);
      return nm;
    } catch (err) {
      logCmd(`INSERT failed: ${(err as Error).message}`);
      return null;
    }
  }

  async function insertBlockCmd(preselect?: string): Promise<void> {
    if (!doc) { logCmd("INSERT: open or start a drawing first."); return; }
    if (!blockLib.size) {
      logCmd("INSERT: the block library is empty. Use BLOCK on selected objects, or 'Insert file as block' to bring in a DWG / DXF.");
      uiAlert("There are no blocks yet. Create one with BLOCK (select objects first), or use Insert file as block on the Insert tab.");
      return;
    }
    const names = blockLib.names();
    const lastScale = Number(localStorage.getItem("obs.cad.insScale")) || 1;
    const r = await openFormModal({
      title: "Insert Block",
      fields: [
        { kind: "select", key: "name", label: "Block", options: names.map((n) => {
            const d = blockLib.get(n)!; const ex = blockExtent(d);
            return [n, `${n} — ${d.entities.length} obj${ex ? `, ${fmt(ex.w)} × ${fmt(ex.h)}` : ""}`] as [string, string];
          }), default: preselect && blockLib.has(preselect) ? blockLib.get(preselect)!.name : names[0] },
        { kind: "number", key: "scale", label: "Scale", default: lastScale, min: 0.000001, step: 0.1, hint: "Uniform scale about the base point." },
        { kind: "number", key: "rot", label: "Rotation", default: 0, unit: "°" },
        { kind: "select", key: "layer", label: "Layer", options: [["", "Keep the block's own layers"], ...doc.layers.map((l) => [l.name, l.name] as [string, string])], default: "" },
      ],
      submitLabel: "Place",
    });
    if (!r) { logCmd("INSERT cancelled."); return; }
    const def = blockLib.get(String(r.name));
    if (!def) { logCmd("INSERT: block not found."); return; }
    try {
      const scale = Number(r.scale), rot = Number(r.rot) || 0;
      const placed = instantiateBlock(def, def.base, { scale, rotation: rot, layer: String(r.layer) || undefined });
      try { localStorage.setItem("obs.cad.insScale", String(scale)); } catch { /* */ }
      if (!r.layer) ensureDocLayers(def.layers as any);
      beginPlacement(placed, def.base, "INSERT");
    } catch (err) { logCmd(`INSERT failed: ${(err as Error).message}`); }
  }

  async function wblockCmd(): Promise<void> {
    if (!doc) { logCmd("WBLOCK: open or start a drawing first."); return; }
    let def: BlockDef | undefined;
    if (sel.size) {
      const list = [...sel].map((i) => ents[i]).filter(Boolean);
      const b = idx ? M.bboxOfSet(idx, sel) : null;
      const r = await openFormModal({
        title: "Write Block",
        subtitle: `${list.length} object(s) selected`,
        fields: [
          { kind: "text", key: "name", label: "File name", default: `Block${blockLib.size + 1}`, validate: (v) => validateBlockName(String(v)) },
          { kind: "select", key: "base", label: "Base point (becomes 0,0)", options: blockBaseChoices(b), default: "ll" },
        ],
        submitLabel: "Save DXF",
      });
      if (!r) { logCmd("WBLOCK cancelled."); return; }
      try { def = makeBlock(String(r.name), list, resolveBlockBase(String(r.base), b), doc.layers as any); }
      catch (err) { logCmd(`WBLOCK failed: ${(err as Error).message}`); return; }
    } else if (blockLib.size) {
      const picked = await pickFromList("Write Block", "No objects selected. Export which library block?", blockLib.names().map((n) => ({ value: n, label: n })));
      if (!picked) { logCmd("WBLOCK cancelled."); return; }
      def = blockLib.get(picked);
    } else { logCmd("WBLOCK: 0 found — select objects first."); return; }
    if (!def) return;
    const fn = `${def.name}.dxf`;
    downloadDxf(blockToDocument(def, doc.units), fn);
    logCmd(`WBLOCK: wrote ${fn} (${def.entities.length} objects, base point at 0,0).`);
  }

  async function blockLibraryCmd(): Promise<void> {
    if (!blockLib.size) { logCmd("BLOCKLIB: no blocks yet. Select objects and run BLOCK."); uiAlert("The block library is empty. Select objects and run BLOCK to add one."); return; }
    await showTableDialog(
      "Block library",
      ["Name", "Objects", "Size", "Base point", "Description"],
      blockLib.names().map((n) => { const d = blockLib.get(n)!; const ex = blockExtent(d); return [n, d.entities.length, ex ? `${fmt(ex.w)} × ${fmt(ex.h)}` : "-", `${fmt(d.base.x)}, ${fmt(d.base.y)}`, d.description ?? ""]; }),
      `${blockLib.size} block(s) — shared by every drawing in this browser`,
    );
    const pick = await pickFromList("Block library", "Choose a block to work with (Cancel to close)", blockLib.names().map((n) => ({ value: n, label: n })));
    if (!pick) return;
    const act = await pickFromList(`Block "${pick}"`, "Action", [
      { value: "insert", label: "Insert into the drawing" },
      { value: "rename", label: "Rename" },
      { value: "export", label: "Export as DXF file" },
      { value: "delete", label: "Delete from the library" },
    ], "insert");
    if (act === "insert") await insertBlockCmd(pick);
    else if (act === "export") {
      const d = blockLib.get(pick)!;
      downloadDxf(blockToDocument(d, doc?.units), `${d.name}.dxf`);
      logCmd(`BLOCKLIB: exported ${d.name}.dxf`);
    } else if (act === "rename") {
      const nn = await promptLine("Rename block", "New name", pick);
      if (!nn) return;
      try { blockLib.rename(pick, nn); persistBlockLib(); logCmd(`BLOCKLIB: "${pick}" renamed to "${nn.trim()}".`); }
      catch (err) { logCmd(`BLOCKLIB: ${(err as Error).message}`); uiAlert((err as Error).message); }
    } else if (act === "delete") {
      if (await confirmDialog("Delete block", `Delete "${pick}" from the library? Copies already in drawings are not affected.`)) {
        blockLib.remove(pick); persistBlockLib(); logCmd(`BLOCKLIB: "${pick}" deleted.`);
      }
    }
  }

  async function importSvgFile(f: File): Promise<void> {
    if (!doc) { logCmd("SVGIMPORT: open or start a drawing first."); return; }
    try {
      const text = await f.text();
      const sc = await promptLine("SVG import", "Drawing units per SVG unit (SVG pixels: 1 px = this many units)", localStorage.getItem("obs.cad.svgScale") || "1");
      if (sc == null) { logCmd("SVGIMPORT cancelled."); return; }
      const scale = parseFloat(sc);
      if (!(scale > 0)) { logCmd("SVGIMPORT: the scale must be a positive number."); return; }
      try { localStorage.setItem("obs.cad.svgScale", String(scale)); } catch { /* */ }
      const res = importSvg(text, { layer: currentLayer, scale });
      if (!res.entities.length) { logCmd(`SVGIMPORT: ${f.name} has no lines, shapes or paths I can read.`); uiAlert(`${f.name} contains no importable geometry (text, images and styling are not imported).`); return; }
      let bb: M.BBox | null = null;
      for (const e of res.entities) { const eb = M.entityBBox(e); bb = bb ? M.unionBBox(bb, eb) : eb; }
      const skipped = Object.entries(res.skipped).map(([k, v]) => `${v} ${k}`).join(", ");
      logCmd(`SVGIMPORT: ${f.name} — ${res.entities.length} objects${skipped ? `; not imported: ${skipped}` : ""}.`);
      beginPlacement(res.entities, { x: bb!.minX, y: bb!.minY }, "SVGIMPORT");
    } catch (err) { logCmd(`SVGIMPORT failed: ${(err as Error).message}`); }
  }

  async function fieldCmd(): Promise<void> {
    if (!doc) { logCmd("FIELD: open or start a drawing first."); return; }
    const kind = await pickFromList("Insert Field", "Field", FIELD_KINDS.map((k) => ({ value: k.kind, label: k.label })), "date");
    if (!kind) return;
    try {
      const value = evaluateField(kind as FieldKind, {
        now: new Date(), drawingName: name || base(), entityCount: modelEnts.length, layerCount: doc.layers.length,
        selected: [...sel].map((i) => ents[i]).filter(Boolean),
      });
      const span = bounds ? Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) : 100;
      const guess = Number((span / 100).toPrecision(2)) || 2.5;
      const h = await promptLine("Field text height", `Text will read "${value}". Height in drawing units`, String(guess));
      if (h == null) return;
      const height = parseFloat(h);
      if (!(height > 0)) { logCmd("FIELD: the height must be a positive number."); return; }
      logCmd(`FIELD: "${value}" (static text; run FIELD again to refresh).`);
      beginPlacement([{ type: "TEXT", layer: currentLayer, position: { x: 0, y: 0 }, height, value } as DxfEntity], { x: 0, y: 0 }, "FIELD");
    } catch (err) { logCmd(`FIELD: ${(err as Error).message}`); uiAlert((err as Error).message); }
  }

  /* ── INSERT: merge a DWG / DXF file into the current drawing ── */
  async function mergeCadFile(f: File): Promise<void> {
    if (!doc) return;
    status(`Importing ${f.name}…`);
    try {
      const r = await readCadFile(f);
      const incoming = r.doc.entities.filter((e) => {
        const b = M.entityBBox(e);
        return Number.isFinite(b.minX + b.maxX + b.minY + b.maxY);
      });
      if (!incoming.length) throw new Error("the file has no drawable geometry");
      // Merge the layer table — existing definitions win.
      const have = new Set(doc.layers.map((l) => l.name));
      for (const l of r.doc.layers) if (!have.has(l.name)) doc.layers.push({ ...l });
      for (const l of doc.layers) if (l.off || l.frozen) hidden.add(l.name);
      addEntities(incoming);
      buildLayers();
      logCmd(`IMPORT: merged ${f.name} — ${incoming.length} entities, ${r.doc.layers.length} layer definitions.`);
      status(`${f.name} merged: ${incoming.length} entities`);
      setTimeout(() => status(""), 5000);
    } catch (err) {
      logCmd(`IMPORT failed: ${(err as Error).message}`);
      status(`Could not import ${f.name}: ${(err as Error).message}`);
      setTimeout(() => status(""), 7000);
    }
  }

  /* ── New Drawing: an empty, immediately drawable document ── */
  function startBlank(): void {
    if (doc) return;
    doc = { units: "mm", layers: [{ name: "0", color: 7 }], entities: [], linetypes: {}, sourceFormat: "cad-engine" };
    name = "";
    modelEnts = doc.entities;
    modelBounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    modelIdx = M.buildIndex(modelEnts, modelBounds);
    layoutIdxCache.clear();
    hidden.clear();
    markups = [];
    results = [];
    drawn = [];
    origin = null;
    cmp = null;
    emptyEl.style.display = "none";
    $<HTMLInputElement>("lf").value = "";
    fillMenus();
    buildTabs();
    activate(-1);
    setTool("select");
    showMeas();
    markSaved();
    updateStatus();
    draw();
  }

  function buildBar2() {
    tools2.innerHTML =
      rg(
        "Show",
        rb("text", "Text", `data-a="tText"`, "Show or hide text", "on") +
          rb("filled-region", "Hatch", `data-a="tHatch"`, "Show or hide hatches", "on") +
          rb("insulation", "Linetypes", `data-a="tLt"`, "Show or hide linetypes", "on"),
        "",
        "",
        "view",
      ) +
      rg(
        "Markup Files",
        rb("save", "Save", `data-a="save-mk"`, "Save all markups to JSON sidecar") +
          rb("folder-recent", "Load", `data-a="load-mk"`, "Load markups from a JSON sidecar"),
        "",
        "",
        "annotate",
      ) +
      rg(
        "Export",
        rb("file", "SVG", `data-a="svg"`, "Export SVG vector file") +
          rb("csv", "CSV", `data-a="csv"`, "Export measurements as CSV") +
          rb("quantification", "Takeoff", `data-a="takeoff"`, "Quantity takeoff by layer and type (CSV)") +
          rb("report", "Info", `data-a="info"`, "Drawing information"),
        "",
        "",
        "output",
      ) +
      rg(
        "Window",
        rb("issues", "Help", `data-a="help"`, "drawing workspace Shortcuts & Commands (?)") +
          rb("close", "Close", `data-a="close"`, "Close the drawing editor", "cadrb--danger"),
        "",
        "cadrg--end",
        "output",
      );    const q = <T extends HTMLElement>(a: string) => tools2.querySelector<T>(`[data-a=${a}]`)!;
    const flip = (a: string, on: boolean) => q(a).classList.toggle("on", on);
    q("tText").onclick = () => {
      showText = !showText;
      flip("tText", showText);
      draw();
    };
    q("tHatch").onclick = () => {
      showHatch = !showHatch;
      flip("tHatch", showHatch);
      draw();
    };
    q("tLt").onclick = () => {
      showLt = !showLt;
      flip("tLt", showLt);
      draw();
    };
    q("help").onclick = () => toggleHelp();
    q("close").onclick = () => hooks.requestClose();
    q("takeoff").onclick = doTakeoff;    q("save-mk").onclick = () => {
      const json = JSON.stringify({ version: 1, markups: markups }, null, 2);
      download(new Blob([json], { type: "application/json" }), base() + ".markups.json");
      logCmd("Saved " + markups.length + " markup(s) to " + base() + ".markups.json");
    };
    q("load-mk").onclick = () => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".json";
      inp.onchange = () => {
        const f = inp.files?.[0];
        if (!f) return;
        void f.text().then((txt) => {
          try {
            const data = JSON.parse(txt) as { markups?: Markup[] };
            if (Array.isArray(data.markups)) {
              markups = data.markups;
              draw();
              logCmd("Loaded " + markups.length + " markup(s) from " + f.name);
            }
          } catch (e) {
            logCmd("Failed to load markups: " + (e as Error).message);
          }
        });
      };
      inp.click();
    };
    q("info").onclick = doInfo;
    q("svg").onclick = exportSvg;
    q("csv").onclick = () => {
      const lines = ["index,measurement"];
      results.forEach((r, i) => lines.push(`${i + 1},"${String(r).replace(/"/g, '""')}"`));
      download(new Blob([lines.join("\n")], { type: "text/csv" }), `${base()}-measurements.csv`);
    };
    // Shell A-menu / Quick Access dispatch forwards through the built buttons
    // (keeps toggle state in sync — tText etc. read their flags in the handler).
    for (const k of ["tText", "tHatch", "tLt", "help", "close", "takeoff", "save-mk", "load-mk", "info", "svg", "csv"]) {
      act2[k] = () => tools2.querySelector<HTMLElement>(`[data-a=${k}]`)?.click();
    }
  }

  buildBar();
  buildBar2();
  // New Drawing tabs start with a live, empty document — draw immediately.
  startBlank();
  (function markNewCadTools() {
    const mark = (btn: Element | null, tip: string) => {
      if (!btn) return;
      const el = btn as HTMLElement;
      if (el.querySelector(".obs-new-dot")) return;
      el.style.position = "relative";
      const dot = document.createElement("span");
      dot.className = "obs-new-dot";
      dot.title = tip;
      dot.style.cssText = "position:absolute;top:-2px;right:-2px;width:4px;height:4px;background:#22c55e;border-radius:50%;box-shadow:0 0 3px #22c55e;pointer-events:none;";
      el.appendChild(dot);
    };
    ["radius", "arc", "note", "leader", "calibrate"].forEach((t) => mark(tools.querySelector('[data-t="' + t + '"]'), "New tool"));
    ["takeoff", "save-mk", "load-mk"].forEach((a) => mark(tools2.querySelector('[data-a="' + a + '"]'), "New feature"));
  })();
  setTool("select");
  showProps();
  showMeas();
  updateStatus();
  resize();

  // Esc handling: guard checks this page and the whole shell (multi-document).

  // Esc from the 2D drawing view, stage, command bar, or anywhere while this
  // drawing page is the active CAD tab. Capture phase + stopImmediate so global
  // BIM Esc cannot leave CIRCLE/LINE running.
  const onCadEscCapture = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    if (!shell || shell.style.display === "none") return;
    // Only the active drawing page handles Esc
    if (root.style.display === "none" || page.style.display === "none") return;
    if (!screenTypeActive && root.style.display === "none") return;

    const target = e.target as HTMLElement | null;
    // Don't fight modal dialogs outside CAD
    if (target?.closest?.("#obs-shortcut-editor, #obs-cad-alias-editor, .obs-form-modal-overlay, [role=dialog]")) {
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();
    onEscape();
    try {
      cv.focus({ preventScroll: true });
    } catch {
      /* */
    }
  };
  window.addEventListener("keydown", onCadEscCapture, true);
  stageEl?.addEventListener("keydown", onCadEscCapture, true);
  cv.addEventListener("keydown", onCadEscCapture, true);

  const api: CadEngineApi = {
    load,
    close() {
      hooks.requestClose();
    },
    activate() {
      root.style.display = "flex";
      screenTypeActive = true;
      try {
        (window as any).__obsCadOwnsEsc = () =>
          !!shell && shell.style.display !== "none" && root.style.display !== "none";
        (window as any).__obsCadOwnsKeys = () =>
          screenTypeActive && !!shell && shell.style.display !== "none" && root.style.display !== "none";
      } catch {
        /* */
      }
      try {
        // Hotkey ownership: while a drawing tab is active the CAD editor owns
        // Ctrl+Shift+C (COPYCLIP) and Ctrl+Shift+V (PASTECLIP). App-level
        // handlers that bind the same combos (Clash Review, View Tools
        // Manager, Saved Views, Validation, VG dialog) stand down, so
        // cross-drawing Super Copy always reaches the engine.
        setCadHotkeyOwner(true);
      } catch {
        /* */
      }
      showRibbonEngine(ribbonWrap, api);
      resize();
      draw();
      // Super Copy awareness: switching drawing tabs tells you what is waiting
      // on the clipboard, so the Ctrl+C → tab → Ctrl+V flow is discoverable.
      const c = ensureClip();
      if (c && c.entities.length && doc) {
        logCmd(`Clipboard: ${c.entities.length} object(s)${c.sourceName ? ` from ${c.sourceName}` : ""} — Ctrl+V or Ctrl+Shift+V to paste into this drawing, Ctrl+Alt+V for original coordinates.`);
      }
      try { cv.focus({ preventScroll: true }); } catch { /* */ }
    },
    deactivate() {
      screenTypeActive = false;
      try {
        // Hand Ctrl+Shift+C / Ctrl+Shift+V back to the app-level handlers.
        setCadHotkeyOwner(false);
      } catch {
        /* */
      }
      try {
        const still = !!shell && shell.style.display !== "none";
        if ((window as any).__obsCadOwnsEsc && !still) {
          delete (window as any).__obsCadOwnsEsc;
        }
        if ((window as any).__obsCadOwnsKeys && !still) {
          delete (window as any).__obsCadOwnsKeys;
        }
      } catch {
        /* */
      }
      try { closeDynamicCommand(); } catch { /* */ }
      root.style.display = "none";
    },
    isDirty: () => dirty,
    markSaved,
    copySelection,
    pasteClip,
    pasteOrig,
    hasClip: () => !!clip,
    saveDxf,
    saveDwg,
    fileName: () => name,
    focus: () => cv.focus({ preventScroll: true }),
    importLandXml: (f: File) => importLandXml(f),
    runCommandText: (text: string) => {
      executeDrawingCommand(text);
    },
    aiSnapshot: () => ({ tool: String(tool), entityCount: ents.length }),
    exec: (a: string) => {
      const f = act[a] ?? act2[a];
      if (f) f();
    },
  };
  registerRibbonEngine(ribbonWrap, api);
  return api;
}
