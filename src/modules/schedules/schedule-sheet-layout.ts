/**
 * Schedule sheet layout — pure table layout + Scene2D assembly for
 * kind:"schedule" sheet views.
 *
 * A schedule is data, not a projection: the scene is emitted at true paper
 * size (1 scene unit = 1 mm of paper / 1000 world metres) and the sheet
 * viewport is placed at scale 1:1, so the table prints exactly as laid out.
 *
 * Layout mirrors the Schedules panel: hidden columns dropped, group indents,
 * subtotal rows from subtotalValues, grand-total row from run.totals,
 * "name (unit)" headers. Cell formatting intentionally mirrors the panel's
 * formatCell — kept pure here so the module stays DOM-free (house test
 * pattern compiles this file standalone).
 */

import type { Scene2D, SceneEntity, StrokeStyle } from "../views/scene";
import { emptyScene } from "../views/scene";
import type {
  ScheduleColumn,
  ScheduleDefinition,
  ScheduleRow,
  ScheduleRun,
} from "./schedule-types";

/* ── Paper metrics (mm) ──────────────────────────────────────────────── */

export const SCHEDULE_TITLE_H_MM = 7;
export const SCHEDULE_HEADER_H_MM = 6;
export const SCHEDULE_ROW_H_MM = 5;
export const SCHEDULE_CELL_PAD_MM = 1.5;
export const SCHEDULE_MIN_COL_MM = 18;
export const SCHEDULE_MAX_COL_MM = 60;
export const SCHEDULE_CELL_CHAR_MM = 1.35;

const COL_GRID: StrokeStyle = { color: "#9ca3af", widthPt: 0.18, dash: null };
const TABLE_BORDER: StrokeStyle = { color: "#111827", widthPt: 0.35, dash: null };
const HEADER_FILL = "#e5e7eb";
const SUBTOTAL_FILL = "#f3f4f6";
const HEADER_TEXT = "#374151";
const CELL_TEXT = "#111827";
const SUBTOTAL_TEXT = "#1e3a8a";

const TEXT_LAYER: keyof Scene2D["layers"] = "symbols";

/* ── Cell formatting (mirrors the Schedules panel) ───────────────────── */

export function formatScheduleCell(col: ScheduleColumn, value: string | number | null): string {
  if (value == null || value === "") return "";
  if (col.format === "text" || col.format === "date") return String(value);
  const n = typeof value === "number" ? value : parseFloat(String(value));
  if (!Number.isFinite(n)) return String(value);
  if (col.format === "count") return String(Math.round(n));
  if (col.format === "currency") return n.toFixed(2);
  if (col.format === "percent") return `${n.toFixed(1)}%`;
  return n.toFixed(3);
}

/**
 * Keep text WinAnsi-safe: pdf-lib StandardFonts throw on code points
 * outside WinAnsi (e.g. CJK, ㎡). Latin-1 plus the common typographic
 * extras are kept; everything else becomes "?".
 */
const WINANSI_EXTRA = new Set<string>(
  ["€", "‚", "ƒ", "„", "…", "†", "‡", "ˆ", "‰", "Š", "‹", "Œ", "Ž", "‘", "’", "“",
   "”", "•", "–", "—", "˜", "™", "š", "›", "œ", "ž", "Ÿ"].map((c) => c),
);

export function sanitizeScheduleText(s: string): string {
  let out = "";
  for (const ch of String(s)) {
    const code = ch.codePointAt(0) ?? 0;
    out += code <= 0xff || WINANSI_EXTRA.has(ch) ? ch : "?";
  }
  return out;
}

/* ── Column widths ───────────────────────────────────────────────────── */

export interface ScheduleTableColumn {
  key: string;
  header: string;
  widthMM: number;
  numeric: boolean;
  format: ScheduleColumn["format"];
}

export function visibleScheduleColumns(defn: ScheduleDefinition): ScheduleColumn[] {
  return defn.columns.filter((c) => !c.hidden);
}

export function columnWidthsMM(
  defn: ScheduleDefinition,
  run: Pick<ScheduleRun, "rows">,
): ScheduleTableColumn[] {
  const cols = visibleScheduleColumns(defn);
  return cols.map((col) => {
    const header = col.header + (col.unit ? ` (${col.unit})` : "");
    let maxChars = header.length;
    for (const row of run.rows) {
      const cell = cellValueFor(col, row);
      maxChars = Math.max(maxChars, formatScheduleCell(col, cell).length);
    }
    maxChars = Math.min(maxChars, 40);
    const contentW = Math.ceil(maxChars * SCHEDULE_CELL_CHAR_MM) + 2 * SCHEDULE_CELL_PAD_MM + 1;
    const hintW = (col.width ?? 0) * 0.12; // px → mm hint, default 120px ⇒ no floor effect
    const widthMM = Math.min(
      SCHEDULE_MAX_COL_MM,
      Math.max(SCHEDULE_MIN_COL_MM, contentW, hintW),
    );
    return {
      key: col.key,
      header,
      widthMM: Math.round(widthMM * 10) / 10,
      numeric: col.format !== "text" && col.format !== "date",
      format: col.format,
    };
  });
}

function cellValueFor(pick: Pick<ScheduleColumn, "key">, row: ScheduleRow): string | number | null {
  if (row.subtotal) {
    if (row.subtotalValues && pick.key in row.subtotalValues) return row.subtotalValues[pick.key];
    if (pick.key in row.values) return row.values[pick.key];
    return null;
  }
  return row.values[pick.key] ?? null;
}

/* ── Table layout ────────────────────────────────────────────────────── */

export interface ScheduleTableRow {
  kind: "data" | "subtotal" | "placeholder";
  depth: number;
  cells: string[];
}

export interface ScheduleTableLayout {
  title: string;
  cols: ScheduleTableColumn[];
  rows: ScheduleTableRow[];
  hasTotals: boolean;
  totalsCells: string[];
  tableW: number;
  tableH: number;
}

export function layoutScheduleTable(
  defn: ScheduleDefinition,
  run: Pick<ScheduleRun, "rows" | "totals">,
): ScheduleTableLayout {
  const cols = columnWidthsMM(defn, run);
  const rows: ScheduleTableRow[] = [];

  if (!cols.length) {
    rows.push({ kind: "placeholder", depth: 0, cells: ["All columns hidden."] });
    return {
      title: defn.name,
      cols,
      rows,
      hasTotals: false,
      totalsCells: [],
      tableW: SCHEDULE_MIN_COL_MM,
      tableH: SCHEDULE_HEADER_H_MM + SCHEDULE_ROW_H_MM,
    };
  }

  let dataRows = 0;
  if (!run.rows.length) {
    rows.push({ kind: "placeholder", depth: 0, cells: ["No elements in this category."] });
  } else {
    for (const r of run.rows) {
      if (r.subtotal) {
        rows.push({
          kind: "subtotal",
          depth: Math.max(0, r.depth ?? 0),
          cells: cols.map((c) => formatScheduleCell(
            { format: c.format } as ScheduleColumn,
            cellValueFor({ key: c.key } as ScheduleColumn, r),
          )),
        });
      } else {
        dataRows++;
        rows.push({
          kind: "data",
          depth: Math.max(-1, r.depth ?? -1),
          cells: cols.map((c) => {
            const raw = c.key in r.values ? r.values[c.key] : null;
            const text = formatScheduleCell({ format: c.format } as ScheduleColumn, raw);
            // Group indent: text columns only — leading spaces would break numeric alignment.
            return c.numeric ? text : " ".repeat(Math.max(0, r.depth ?? 0) * 2) + text;
          }),
        });
      }
    }
  }

  const hasTotals = defn.showTotals !== false;
  const totalsCells = cols.map((c, i) => {
    if (i === 0) return `Grand total (${dataRows} rows)`;
    const t = run.totals?.[c.key];
    return t != null ? formatScheduleCell({ format: c.format } as ScheduleColumn, t) : "";
  });

  const tableH =
    SCHEDULE_HEADER_H_MM +
    rows.length * SCHEDULE_ROW_H_MM +
    (hasTotals ? SCHEDULE_ROW_H_MM + 1 : 0);
  const tableW = cols.reduce((sum, c) => sum + c.widthMM, 0);

  return {
    title: defn.name,
    cols,
    rows,
    hasTotals,
    totalsCells,
    tableW: Math.round(tableW * 10) / 10,
    tableH,
  };
}

/* ── Scene assembly ──────────────────────────────────────────────────── */

const mm = (v: number): number => v / 1000;

function text(
  x: number, z: number, value: string, sizePt: number, color: string,
  anchor: "start" | "middle" | "end" = "start",
): SceneEntity {
  return {
    kind: "text", x: mm(x), z: mm(z), text: sanitizeScheduleText(value),
    anchor, sizePt, rotation: 0, color,
  };
}

function line(x1: number, z1: number, x2: number, z2: number, stroke: StrokeStyle): SceneEntity {
  return { kind: "line", x1: mm(x1), z1: mm(z1), x2: mm(x2), z2: mm(z2), stroke };
}

function filledRect(
  x0: number, z0: number, x1: number, z1: number, color: string,
): SceneEntity {
  return {
    kind: "polyline", closed: true,
    points: [[mm(x0), mm(z0)], [mm(x1), mm(z0)], [mm(x1), mm(z1)], [mm(x0), mm(z1)]],
    stroke: COL_GRID, fill: { color, opacity: 1 },
  };
}

export function buildScheduleSceneFromRun(defn: ScheduleDefinition, run: Pick<ScheduleRun, "rows" | "totals">): Scene2D {
  const layout = layoutScheduleTable(defn, run);
  const scene = emptyScene();
  const W = layout.tableW;
  const H = layout.tableH;

  // Title above the table (true paper size, bold-ish by darkness).
  scene.layers[TEXT_LAYER].push(text(0, SCHEDULE_TITLE_H_MM - 3, layout.title, 3.5, "#111827"));

  const colX: number[] = [];
  let acc = 0;
  for (const c of layout.cols) { colX.push(acc); acc += c.widthMM; }
  const colEdges = [...colX, W];

  const headerTop = 0;
  const headerBottom = headerTop - SCHEDULE_HEADER_H_MM;
  let y = headerBottom;

  // Header band + header labels
  scene.layers.project.push(filledRect(0, headerTop, W, headerBottom, HEADER_FILL));
  layout.cols.forEach((c, i) => {
    const x = c.numeric ? colEdges[i + 1] - SCHEDULE_CELL_PAD_MM : colX[i] + SCHEDULE_CELL_PAD_MM;
    scene.layers[TEXT_LAYER].push(
      text(x, headerTop - (SCHEDULE_HEADER_H_MM + 2.1) / 2, c.header, 2.1, HEADER_TEXT, c.numeric ? "end" : "start"),
    );
  });

  // Data / subtotal / placeholder rows
  for (const r of layout.rows) {
    const top = y;
    const bottom = y - SCHEDULE_ROW_H_MM;
    if (r.kind === "subtotal") scene.layers.project.push(filledRect(0, top, W, bottom, SUBTOTAL_FILL));
    if (r.kind === "placeholder" && layout.cols.length) {
      scene.layers[TEXT_LAYER].push(
        text(colX[0] + SCHEDULE_CELL_PAD_MM, top - (SCHEDULE_ROW_H_MM + 2.2) / 2, r.cells[0] ?? "", 2.2, "#6b7280"),
      );
    } else {
      r.cells.forEach((cell, i) => {
        const c = layout.cols[i];
        if (!c || cell === "") return;
        const x = c.numeric
          ? colEdges[i + 1] - SCHEDULE_CELL_PAD_MM
          : colX[i] + SCHEDULE_CELL_PAD_MM;
        const z = top - (SCHEDULE_ROW_H_MM + 2.2) / 2;
        const color = r.kind === "subtotal" ? SUBTOTAL_TEXT : CELL_TEXT;
        scene.layers[TEXT_LAYER].push(text(x, z, cell, 2.2, color, c.numeric ? "end" : "start"));
      });
    }
    y = bottom;
  }

  // Grand-total row
  if (layout.hasTotals) {
    const top = y;
    const bottom = y - (SCHEDULE_ROW_H_MM + 1);
    scene.layers.project.push(line(0, top, W, top, TABLE_BORDER));
    layout.totalsCells.forEach((cell, i) => {
      const c = layout.cols[i];
      if (!c || cell === "") return;
      const x = c.numeric
        ? colEdges[i + 1] - SCHEDULE_CELL_PAD_MM
        : colX[i] + SCHEDULE_CELL_PAD_MM;
      scene.layers[TEXT_LAYER].push(
        text(x, top - ((SCHEDULE_ROW_H_MM + 1) + 2.2) / 2, cell, 2.2, "#111827", c.numeric ? "end" : "start"),
      );
    });
    y = bottom;
  }

  const tableBottom = y;

  // Grid: horizontal row rules + vertical column rules + outer border.
  for (let i = 0; i <= layout.rows.length; i++) {
    const z = headerBottom - i * SCHEDULE_ROW_H_MM;
    scene.layers.project.push(line(0, z, W, z, COL_GRID));
  }
  for (const x of colEdges) {
    scene.layers.project.push(line(x, headerTop, x, tableBottom, COL_GRID));
  }
  scene.layers.project.push({
    kind: "polyline", closed: true,
    points: [[mm(0), mm(headerTop)], [mm(W), mm(headerTop)], [mm(W), mm(tableBottom)], [mm(0), mm(tableBottom)]],
    stroke: TABLE_BORDER,
  });

  scene.bounds = { minX: 0, minZ: mm(tableBottom), maxX: mm(W), maxZ: mm(SCHEDULE_TITLE_H_MM) };
  scene.generatedAt = Date.now();
  return scene;
}

/** Placeholder scene for a misconfigured schedule view. */
export function emptyScheduleScene(message: string): Scene2D {
  const scene = emptyScene();
  scene.layers[TEXT_LAYER].push(text(0, 0, message, 3, "#6b7280"));
  scene.bounds = { minX: 0, minZ: mm(-6), maxX: mm(90), maxZ: mm(3) };
  scene.generatedAt = Date.now();
  return scene;
}

