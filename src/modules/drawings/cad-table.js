const DEG = Math.PI / 180;
export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLS = 50;
const MAX_TABLE_CELLS = 2500;
/** A point that keeps `z` only when the source had one — an explicit
 * `z: undefined` key breaks deep equality against plain {x, y} points. */
const pt = (x, y, z) => (z === undefined ? { x, y } : { x, y, z });
const norm180 = (a) => {
    const n = (((a + 180) % 360) + 360) % 360 - 180;
    return Math.abs(n) < 1e-9 ? 0 : n;
};
export function tableWidth(t) {
    return t.colWidths.reduce((a, b) => a + b, 0);
}
export function tableHeight(t) {
    return t.rowHeights.reduce((a, b) => a + b, 0);
}
/** Cell text height: the stored value, else half the smallest row height. */
export function tableTextHeight(t) {
    if (t.textHeight != null && Number.isFinite(t.textHeight) && t.textHeight > 0)
        return t.textHeight;
    const minRow = Math.min(...t.rowHeights);
    return Number.isFinite(minRow) && minRow > 0 ? minRow * 0.5 : 2.5;
}
/** Unit vectors of the table frame: u along the columns, d down the rows. */
export function tableFrame(t) {
    const a = (t.rotation ?? 0) * DEG;
    const ux = Math.cos(a), uy = Math.sin(a);
    return { ux, uy, dx: uy, dy: -ux };
}
/** World point of local (lx, ly) — lx right, ly down from the top-left corner. */
export function tablePoint(t, lx, ly) {
    const f = tableFrame(t);
    return pt(t.position.x + f.ux * lx + f.dx * ly, t.position.y + f.uy * lx + f.dy * ly, t.position.z);
}
/** The four corners, clockwise from the top-left. */
export function tableCorners(t) {
    const w = tableWidth(t), h = tableHeight(t);
    return [tablePoint(t, 0, 0), tablePoint(t, w, 0), tablePoint(t, w, h), tablePoint(t, 0, h)];
}
const colStarts = (t) => {
    const out = [0];
    for (const w of t.colWidths)
        out.push(out[out.length - 1] + w);
    return out;
};
const rowStarts = (t) => {
    const out = [0];
    for (const h of t.rowHeights)
        out.push(out[out.length - 1] + h);
    return out;
};
/** Local rectangle of one cell: lx/ly of its top-left corner plus its size. */
export function cellRect(t, row, col) {
    const xs = colStarts(t), ys = rowStarts(t);
    return { lx: xs[col], ly: ys[row], w: t.colWidths[col], h: t.rowHeights[row] };
}
/**
 * World point for a cell's text: left-aligned with a small inset, vertically
 * centred on the row (the painter draws it middle-anchored at this point).
 */
export function cellTextPoint(t, row, col) {
    const r = cellRect(t, row, col);
    const h = tableTextHeight(t);
    const inset = Math.min(r.w * 0.05, h * 0.5);
    return tablePoint(t, r.lx + inset, r.ly + r.h / 2);
}
/** Which cell (row, col) a world point falls in, or null outside the table. */
export function cellAt(t, x, y) {
    const f = tableFrame(t);
    const px = x - t.position.x, py = y - t.position.y;
    // Inverse of world = position + u·lx + d·ly (u and d are orthonormal).
    const lx = px * f.ux + py * f.uy;
    const ly = px * f.dx + py * f.dy;
    const eps = 1e-9;
    if (lx < -eps || ly < -eps || lx > tableWidth(t) + eps || ly > tableHeight(t) + eps)
        return null;
    const xs = colStarts(t), ys = rowStarts(t);
    let col = xs.length - 2;
    for (let i = 0; i + 1 < xs.length; i++)
        if (lx < xs[i + 1] || i === xs.length - 2) {
            col = i;
            break;
        }
    let row = ys.length - 2;
    for (let j = 0; j + 1 < ys.length; j++)
        if (ly < ys[j + 1] || j === ys.length - 2) {
            row = j;
            break;
        }
    return { row, col };
}
function checkSizes(widths, heights) {
    if (!widths.length || !heights.length)
        throw new RangeError("A table needs at least one row and one column.");
    if (widths.length > MAX_TABLE_COLS || heights.length > MAX_TABLE_ROWS) {
        throw new RangeError(`A table has at most ${MAX_TABLE_COLS} columns and ${MAX_TABLE_ROWS} rows.`);
    }
    if (!widths.every((w) => Number.isFinite(w) && w > 0) || !heights.every((h) => Number.isFinite(h) && h > 0)) {
        throw new RangeError("Column widths and row heights must be finite and positive.");
    }
}
function padCells(cells, rows, cols, fill) {
    const out = [];
    for (let r = 0; r < rows; r++) {
        const row = [];
        for (let c = 0; c < cols; c++) {
            const v = cells?.[r]?.[c];
            row.push(typeof v === "string" ? v : fill(r, c));
        }
        out.push(row);
    }
    return out;
}
/**
 * Build a TABLE entity. Two-pick authoring (`size` + rows/cols) normalises
 * the picks to the top-left corner and labels the cells "row,col" like the
 * old loose grid did; explicit widths/heights take the position as the
 * top-left corner as given.
 */
export function createTable(o) {
    let position = o.position;
    let colWidths;
    let rowHeights;
    let cells;
    if (o.size) {
        const rows = o.rows ?? 3, cols = o.cols ?? 4;
        const w = Math.abs(o.size.x), h = Math.abs(o.size.y);
        if (!(w > 1e-9 && h > 1e-9))
            throw new RangeError("A table needs a non-zero width and height.");
        if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > MAX_TABLE_ROWS || cols > MAX_TABLE_COLS) {
            throw new RangeError(`Table rows and columns must be integers from 1 to ${MAX_TABLE_ROWS}.`);
        }
        position = pt(Math.min(o.position.x, o.position.x + o.size.x), Math.max(o.position.y, o.position.y + o.size.y), o.position.z);
        colWidths = Array.from({ length: cols }, () => w / cols);
        rowHeights = Array.from({ length: rows }, () => h / rows);
        cells = padCells(o.cells, rows, cols, (r, c) => `${r + 1},${c + 1}`);
    }
    else {
        colWidths = [...(o.colWidths ?? [])];
        rowHeights = [...(o.rowHeights ?? [])];
        cells = padCells(o.cells, rowHeights.length, colWidths.length, () => "");
    }
    checkSizes(colWidths, rowHeights);
    if (colWidths.length * rowHeights.length > MAX_TABLE_CELLS)
        throw new RangeError("A table has at most 2500 cells.");
    const rot = o.rotation != null ? norm180(o.rotation) : 0;
    return {
        type: "TABLE",
        layer: o.layer,
        position,
        colWidths,
        rowHeights,
        cells,
        ...(o.textHeight != null ? { textHeight: o.textHeight } : {}),
        ...(rot ? { rotation: rot } : {}),
        ...(o.headerRow ? { headerRow: true } : {}),
    };
}
/** Normalise a table read from a file: pad cells, drop bad sizes, clamp counts. */
export function normalizeTable(t) {
    const colWidths = t.colWidths.filter((w) => Number.isFinite(w) && w > 0).slice(0, MAX_TABLE_COLS);
    const rowHeights = t.rowHeights.filter((h) => Number.isFinite(h) && h > 0).slice(0, MAX_TABLE_ROWS);
    if (!colWidths.length || !rowHeights.length)
        return null;
    if (!Number.isFinite(t.position.x + t.position.y))
        return null;
    const cells = padCells(t.cells, rowHeights.length, colWidths.length, () => "");
    const rot = t.rotation != null ? norm180(t.rotation) : 0;
    const out = {
        ...t,
        position: t.position,
        colWidths,
        rowHeights,
        cells,
        ...(t.headerRow ? { headerRow: true } : {}),
    };
    if (t.textHeight != null && Number.isFinite(t.textHeight) && t.textHeight > 0)
        out.textHeight = t.textHeight;
    else
        delete out.textHeight;
    if (rot)
        out.rotation = rot;
    else
        delete out.rotation;
    return out;
}
function cloneCells(cells) {
    return cells.map((r) => [...r]);
}
function checkCell(t, row, col) {
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= t.rowHeights.length || col >= t.colWidths.length) {
        throw new RangeError(`Cell ${row + 1},${col + 1} is out of range for a ${t.rowHeights.length}x${t.colWidths.length} table.`);
    }
}
/** Replace one cell's text (immutable — the input is untouched). */
export function setCellText(t, row, col, text) {
    checkCell(t, row, col);
    const cells = cloneCells(t.cells);
    cells[row][col] = text;
    return { ...t, cells };
}
/** Insert an empty row; `index` defaults to the end. The new row copies the
 * height of the row above it (the first row when inserting at the top) — the
 * size a user expects from AutoCAD's row insert. */
export function insertTableRow(t, index) {
    const at = index ?? t.rowHeights.length;
    if (!Number.isInteger(at) || at < 0 || at > t.rowHeights.length)
        throw new RangeError(`Row ${at + 1} is out of range.`);
    if (t.rowHeights.length >= MAX_TABLE_ROWS)
        throw new RangeError(`A table has at most ${MAX_TABLE_ROWS} rows.`);
    const h = at > 0 ? t.rowHeights[at - 1] : t.rowHeights[0];
    const rowHeights = [...t.rowHeights];
    rowHeights.splice(at, 0, h);
    const cells = cloneCells(t.cells);
    cells.splice(at, 0, Array.from({ length: t.colWidths.length }, () => ""));
    return { ...t, rowHeights, cells };
}
/** Delete a row; null when it is the last one. */
export function deleteTableRow(t, index) {
    if (t.rowHeights.length <= 1)
        return null;
    if (!Number.isInteger(index) || index < 0 || index >= t.rowHeights.length)
        throw new RangeError(`Row ${index + 1} is out of range.`);
    const rowHeights = [...t.rowHeights];
    rowHeights.splice(index, 1);
    const cells = cloneCells(t.cells);
    cells.splice(index, 1);
    return { ...t, rowHeights, cells };
}
/** Insert an empty column; `index` defaults to the end. The new column
 * copies the width of the column to its left (the first column when
 * inserting at the left edge). */
export function insertTableColumn(t, index) {
    const at = index ?? t.colWidths.length;
    if (!Number.isInteger(at) || at < 0 || at > t.colWidths.length)
        throw new RangeError(`Column ${at + 1} is out of range.`);
    if (t.colWidths.length >= MAX_TABLE_COLS)
        throw new RangeError(`A table has at most ${MAX_TABLE_COLS} columns.`);
    const w = at > 0 ? t.colWidths[at - 1] : t.colWidths[0];
    const colWidths = [...t.colWidths];
    colWidths.splice(at, 0, w);
    const cells = cloneCells(t.cells).map((r) => {
        const row = [...r];
        row.splice(at, 0, "");
        return row;
    });
    return { ...t, colWidths, cells };
}
/** Delete a column; null when it is the last one. */
export function deleteTableColumn(t, index) {
    if (t.colWidths.length <= 1)
        return null;
    if (!Number.isInteger(index) || index < 0 || index >= t.colWidths.length)
        throw new RangeError(`Column ${index + 1} is out of range.`);
    const colWidths = [...t.colWidths];
    colWidths.splice(index, 1);
    const cells = cloneCells(t.cells).map((r) => {
        const row = [...r];
        row.splice(index, 1);
        return row;
    });
    return { ...t, colWidths, cells };
}
/** Move the whole table by (dx, dy). */
export function translateTable(t, dx, dy) {
    return { ...t, position: pt(t.position.x + dx, t.position.y + dy, t.position.z) };
}
/** Rotate the table counter-clockwise by `deg` around (cx, cy). */
export function rotateTable(t, cx, cy, deg) {
    const rad = deg * DEG;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const dx = t.position.x - cx, dy = t.position.y - cy;
    const rot = norm180((t.rotation ?? 0) + deg);
    const out = {
        ...t,
        position: pt(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos, t.position.z),
    };
    if (rot)
        out.rotation = rot;
    else
        delete out.rotation;
    return out;
}
/** Uniformly scale the table about (cx, cy) by k. */
export function scaleTable(t, cx, cy, k) {
    if (!Number.isFinite(k) || k <= 0)
        return t;
    return {
        ...t,
        position: pt(cx + (t.position.x - cx) * k, cy + (t.position.y - cy) * k, t.position.z),
        colWidths: t.colWidths.map((w) => w * k),
        rowHeights: t.rowHeights.map((h) => h * k),
        ...(t.textHeight != null ? { textHeight: t.textHeight * k } : {}),
    };
}
/**
 * Mirror the table across the line through a→b. The frame reflects like any
 * rotated frame (rotation 2α − θ), and the rows reverse: the mirrored
 * rectangle's top edge is the original bottom edge, so row 0 of the result
 * is the original last row and every cell keeps its world position.
 */
export function mirrorTable(t, a, b) {
    const alpha = Math.atan2(b.y - a.y, b.x - a.x);
    const rot = norm180(2 * (alpha / DEG) - (t.rotation ?? 0));
    // Mirror the top-left corner, then shift it down the new frame by the
    // table height: the mirrored rect extends from the mirrored top edge.
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const mx = (p) => {
        if (len2 < 1e-12)
            return { ...p };
        const tt = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
        return pt(2 * (a.x + tt * dx) - p.x, 2 * (a.y + tt * dy) - p.y, p.z);
    };
    const m = mx(t.position);
    const ra = rot * DEG;
    // New down-vector d' = (sin θ', −cos θ').
    const ddx = Math.sin(ra), ddy = -Math.cos(ra);
    const h = tableHeight(t);
    const rowHeights = [...t.rowHeights].reverse();
    const cells = [...t.cells].reverse().map((r) => [...r]);
    const out = {
        ...t,
        position: pt(m.x - ddx * h, m.y - ddy * h, t.position.z),
        rowHeights,
        cells,
    };
    if (rot)
        out.rotation = rot;
    else
        delete out.rotation;
    return out;
}
/**
 * EXPLODE: the table's drawn geometry — the grid as LINEs plus one TEXT per
 * non-empty cell, exactly the loose form the old TABLE tool emitted. The
 * text sits left-aligned, vertically centred, like the painter draws it.
 */
export function explodeTable(t) {
    const out = [];
    const w = tableWidth(t), h = tableHeight(t);
    const xs = colStarts(t), ys = rowStarts(t);
    const base = { layer: t.layer, color: t.color, rgb: t.rgb, lineType: t.lineType, lineweight: t.lineweight, ltScale: t.ltScale, transparency: t.transparency };
    for (let j = 0; j <= t.rowHeights.length; j++) {
        out.push({ ...base, type: "LINE", start: tablePoint(t, 0, ys[j]), end: tablePoint(t, w, ys[j]) });
    }
    for (let i = 0; i <= t.colWidths.length; i++) {
        out.push({ ...base, type: "LINE", start: tablePoint(t, xs[i], 0), end: tablePoint(t, xs[i], h) });
    }
    const th = tableTextHeight(t);
    for (let r = 0; r < t.rowHeights.length; r++) {
        for (let c = 0; c < t.colWidths.length; c++) {
            const v = t.cells[r]?.[c] ?? "";
            if (!v.trim())
                continue;
            out.push({
                ...base,
                type: "TEXT",
                position: cellTextPoint(t, r, c),
                height: Math.min(th, t.rowHeights[r] * 0.8) || th,
                value: v,
                rotation: t.rotation ?? 0,
                valign: "middle",
            });
        }
    }
    return out;
}
