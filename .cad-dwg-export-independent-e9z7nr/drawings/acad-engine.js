import { arcPoints, ellipsePoints, evalBSpline, expandBulges, insUnitsToUnits, robustExtents, transformEntity, } from "./dxf-geometry";
import { cleanText, mtextFont, mtextWidthFactor } from "./mtext";
const DEG = 180 / Math.PI;
const INF = 1e9;
/** Where the engine artifact is served from (mirrors public/cad-engine/). */
export const CAD_ENGINE_URL = "/cad-engine/obim-cad-engine.wasm";
let instancePromise = null;
/** True when the engine module is available (or fetch already succeeded). */
export async function acadEngineAvailable() {
    return (await loadAcadEngine()) !== null;
}
/** Engine identity string for diagnostics ("acadrust bridge 0.1.0"). */
export async function acadEngineVersion() {
    const inst = await loadAcadEngine();
    if (!inst)
        return null;
    try {
        return readFrame(inst, inst.exports.obim_engine_version());
    }
    catch {
        return null;
    }
}
/**
 * Load and instantiate the engine once. Returns null when the artifact is
 * unavailable (dev server without the wasm, offline), so callers can fall
 * back to the legacy readers instead of failing.
 */
export async function loadAcadEngine() {
    if (!instancePromise) {
        instancePromise = (async () => {
            const bytes = await fetchEngineBytes();
            if (!bytes)
                return null;
            try {
                const { instance } = await WebAssembly.instantiate(bytes, {});
                const ex = instance.exports;
                // Smoke-test the ABI so a truncated artifact falls back cleanly.
                ex.obim_engine_version();
                return { exports: ex };
            }
            catch (e) {
                console.warn("[acad-engine] wasm instantiation failed:", e);
                return null;
            }
        })();
        instancePromise.catch(() => {
            instancePromise = null;
        });
    }
    return instancePromise;
}
/**
 * Test hook: inject an engine instance compiled from bytes the caller
 * already has (Node regression tests read the artifact from disk — the
 * browser path fetches it from /cad-engine/).
 */
export async function setAcadEngineForTests(bytes) {
    try {
        const { instance } = await WebAssembly.instantiate(bytes, {});
        const ex = instance.exports;
        ex.obim_engine_version();
        instancePromise = Promise.resolve({ exports: ex });
        return true;
    }
    catch {
        return false;
    }
}
async function fetchEngineBytes() {
    const urls = [CAD_ENGINE_URL, "./cad-engine/obim-cad-engine.wasm"];
    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                const buf = await res.arrayBuffer();
                if (buf.byteLength > 4)
                    return buf;
            }
        }
        catch {
            // try the next candidate
        }
    }
    return null;
}
function readFrame(inst, ptr) {
    const dv = new DataView(inst.exports.memory.buffer);
    const len = dv.getUint32(ptr, true);
    const bytes = new Uint8Array(inst.exports.memory.buffer, ptr + 4, len);
    return new TextDecoder().decode(bytes);
}
/**
 * Re-read the intermediate DXF before DWG conversion. The CAD editor's DXF
 * serializer intentionally supports a bounded entity set; checking only the
 * final DWG would miss entities already omitted by that serializer.
 */
export async function validateDxfForDwgExport(dxf, expectedEntityCount, expectedLayerNames) {
    if (!dxf.trim())
        throw new Error("DWG export preflight failed: the intermediate DXF is empty.");
    // Best-effort preflight. Do not hard-block on minor mismatches (hatches,
    // styles, or records the round-trip parser classifies as skipped) — those
    // used to show "DWG Export Blocked - unsupported content" on ordinary files.
    const parsed = await parseWithAcadEngine(new TextEncoder().encode(dxf), "DWG export preflight.dxf");
    if (!parsed) {
        // Engine unavailable: still allow exportDxfToDwg to try.
        console.warn("[dwg-export] preflight parse unavailable — continuing");
        return;
    }
    if (parsed.format !== "dxf" && parsed.format !== "dwg") {
        console.warn("[dwg-export] preflight unexpected format", parsed.format);
    }
    if (expectedEntityCount > 0 && parsed.entityCount === 0) {
        throw new Error("DWG export preflight failed: the intermediate DXF has no drawable entities.");
    }
    if (parsed.entityCount !== expectedEntityCount) {
        console.warn(`[dwg-export] preflight entity count ${parsed.entityCount} vs editor ${expectedEntityCount} — continuing`);
    }
    const skipped = Object.values(parsed.doc.skipped ?? {}).reduce((sum, count) => sum + count, 0);
    if (skipped > 0) {
        console.warn(`[dwg-export] preflight noted ${skipped} skipped record(s) — continuing`);
    }
    const actualLayers = new Set(parsed.doc.layers.map((layer) => layer.name.trim().toUpperCase()));
    const missingLayers = expectedLayerNames.filter((name) => name && !actualLayers.has(name.trim().toUpperCase()));
    if (missingLayers.length) {
        console.warn(`[dwg-export] preflight missing layer name(s): ${missingLayers.join(", ")} — continuing`);
    }
}
/** Convert an editor-generated ASCII DXF into native binary DWG. */
export async function exportDxfToDwg(dxf) {
    if (!dxf.trim())
        throw new Error("The drawing is empty.");
    const inst = await loadAcadEngine();
    if (!inst)
        throw new Error("CAD WASM engine unavailable; reload after rebuilding the CAD engine.");
    const write = inst.exports.obim_write_dwg;
    if (typeof write !== "function")
        throw new Error("DWG writer is missing from the loaded CAD WASM. Rebuild cad-engine-rust and reload.");
    const input = new TextEncoder().encode(dxf);
    let ptr = 0, resultPtr = 0;
    try {
        ptr = inst.exports.obim_alloc(input.length);
        if (!ptr)
            throw new Error("Unable to allocate export buffer.");
        new Uint8Array(inst.exports.memory.buffer, ptr, input.length).set(input);
        resultPtr = write(ptr, input.length);
        if (!resultPtr)
            throw new Error("DWG writer returned no result.");
        const view = new DataView(inst.exports.memory.buffer);
        const len = view.getUint32(resultPtr, true);
        if (len < 1)
            throw new Error("DWG writer returned an invalid frame.");
        const payload = new Uint8Array(inst.exports.memory.buffer, resultPtr + 4, len);
        if (payload[0] !== 0)
            throw new Error(new TextDecoder().decode(payload.subarray(1)) || "DWG conversion failed.");
        const bytes = payload.slice(1);
        const signature = new TextDecoder().decode(bytes.subarray(0, 6));
        if (bytes.length < 6 || !/^AC10(?:09|12|14|15|18|21|24|27|32)$/.test(signature)) {
            throw new Error("DWG writer output failed signature validation; no file was saved.");
        }
        return bytes;
    }
    finally {
        try {
            if (resultPtr)
                inst.exports.obim_free(resultPtr, 4 + new DataView(inst.exports.memory.buffer).getUint32(resultPtr, true));
            if (ptr)
                inst.exports.obim_free(ptr, input.length);
        }
        catch { /* best-effort release after wasm memory growth */ }
    }
}
/**
 * Read a drawing buffer (DWG or DXF, ASCII or binary) with the acadrust
 * engine. Returns null when the engine is unavailable; throws nothing —
 * engine failures come back as { ok: false } and are surfaced via the
 * summary, so callers can fall back to the legacy readers.
 */
export async function parseWithAcadEngine(bytes, fileName) {
    const inst = await loadAcadEngine();
    if (!inst)
        return null;
    const ex = inst.exports;
    let ptr = 0;
    let resPtr = 0;
    try {
        ptr = ex.obim_alloc(bytes.length);
        if (!ptr)
            throw new Error("engine scratch alloc failed");
        new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
        resPtr = ex.obim_read(ptr, bytes.length);
        const json = JSON.parse(readFrame(inst, resPtr));
        if (!json || json.ok !== true) {
            const err = String(json?.error ?? "unknown engine failure");
            return {
                doc: { layers: [], entities: [] },
                summary: `${fileName}: the acadrust engine could not read this drawing (${err})`,
                version: "",
                entityCount: 0,
                format: "dwg",
                stats: null,
            };
        }
        const doc = mapDocument(json.document ?? {}, json.format === "dwg" ? "dwg" : "dxf");
        const stats = (json.stats ?? null);
        const entityCount = doc.entities.length;
        const ver = String(stats?.sourceVersion ?? json.document?.version ?? "");
        const extra = stats?.recoveredErrors
            ? `, ${stats.recoveredErrors} recovered error(s)`
            : "";
        return {
            doc,
            summary: `${fileName}: ${entityCount} entit${entityCount === 1 ? "y" : "ies"} read natively by acadrust (${ver})${extra}`,
            version: ver,
            entityCount,
            format: json.format === "dwg" ? "dwg" : "dxf",
            stats,
        };
    }
    catch (e) {
        // A wasm trap (panic=abort) or malformed envelope — degrade, don't crash.
        console.warn("[acad-engine] read failed:", e);
        return {
            doc: { layers: [], entities: [] },
            summary: `${fileName}: the acadrust engine hit an unexpected failure (${e instanceof Error ? e.message : String(e)})`,
            version: "",
            entityCount: 0,
            format: "dwg",
            stats: null,
        };
    }
    finally {
        try {
            if (resPtr)
                ex.obim_free(resPtr, 4 + new DataView(ex.memory.buffer).getUint32(resPtr, true));
            if (ptr)
                ex.obim_free(ptr, bytes.length);
        }
        catch {
            /* memory may have grown; frees are best-effort */
        }
    }
}
function colorOf(c) {
    if (!c)
        return {};
    if (c.t === "rgb")
        return { rgb: ((c.r << 16) | (c.g << 8) | c.b) & 0xffffff };
    if (c.t === "index") {
        const v = c.v ?? 7;
        if (v >= 1 && v <= 255)
            return { color: v };
    }
    return {};
}
function lineWeightMm(v) {
    if (typeof v === "number" && v >= 0)
        return v / 100; // 1/100 mm -> mm
    return undefined;
}
function transparencyPct(v) {
    if (typeof v === "number" && v > 0)
        return Math.round((v / 255) * 90);
    return undefined;
}
function pt(a) {
    const arr = Array.isArray(a) ? a : [];
    return { x: Number(arr[0] ?? 0), y: Number(arr[1] ?? 0), z: Number(arr[2] ?? 0) };
}
function commonOf(e) {
    const { color, rgb } = colorOf(e.color);
    const out = { layer: String(e.layer ?? "0") };
    if (color !== undefined)
        out.color = color;
    if (rgb !== undefined)
        out.rgb = rgb;
    if (typeof e.lineType === "string" && e.lineType && e.lineType !== "ByLayer") {
        out.lineType = e.lineType;
    }
    const lw = lineWeightMm(e.lineWeight);
    if (lw !== undefined)
        out.lineweight = lw;
    if (typeof e.ltScale === "number" && e.ltScale !== 1)
        out.ltScale = e.ltScale;
    const tr = transparencyPct(e.transparency);
    if (tr !== undefined)
        out.transparency = tr;
    return out;
}
function textAlign(h, v, alignPoint) {
    const align = h === 1 || h === 4 ? "center" : h === 2 ? "right" : "left";
    const vertical = h === 4 ? "middle" : v === 1 ? "bottom" : v === 2 ? "middle" : v === 3 ? "top" : "baseline";
    return { align, valign: vertical, useAlignPoint: (h !== 0 || v !== 0) && !!alignPoint };
}
/** Convert one engine entity into platform entities (may expand blocks). */
function convertEntity(e, cx, depth, insertLayer) {
    if (!e || typeof e !== "object")
        return [];
    if (e.invisible)
        return [];
    const c = commonOf(e);
    if (insertLayer && depth > 0 && c.layer === "0")
        c.layer = insertLayer;
    const type = String(e.type ?? "");
    switch (type) {
        case "LINE":
            return [{ ...c, type: "LINE", start: pt(e.start), end: pt(e.end) }];
        case "CIRCLE":
            return [{ ...c, type: "CIRCLE", center: pt(e.center), radius: Number(e.radius ?? 0) }];
        case "ARC":
            return [
                {
                    ...c,
                    type: "ARC",
                    center: pt(e.center),
                    radius: Number(e.radius ?? 0),
                    startAngle: Number(e.startAngle ?? 0) * DEG,
                    endAngle: Number(e.endAngle ?? 0) * DEG,
                },
            ];
        case "POINT":
            return [{ ...c, type: "POINT", position: pt(e.position) }];
        case "LWPOLYLINE":
        case "POLYLINE2D":
        case "POLYLINE3D":
        case "POLYLINE": {
            const verts = (e.vertices ?? []);
            if (verts.length < 2) {
                cx.skip(`${type} (<2 vertices)`);
                return [];
            }
            const points = expandBulges(verts.map((v) => {
                const p = pt(v);
                return { ...p, bulge: Number(Array.isArray(v) ? v[2] : v.bulge) || undefined };
            }), e.closed === true);
            return [{ ...c, type: "LWPOLYLINE", points, closed: e.closed === true }];
        }
        case "SPLINE": {
            const deg = Math.max(1, Math.round(Number(e.degree ?? 3)));
            const ctrl = (e.controlPoints ?? []).map(pt);
            const knots = (e.knots ?? []).map(Number);
            const fit = (e.fitPoints ?? []).map(pt);
            const pts = ctrl.length >= deg + 1
                ? evalBSpline(ctrl, knots, deg)
                : fit.length >= 2
                    ? fit
                    : ctrl;
            if (pts.length < 2) {
                cx.skip("SPLINE (no usable points)");
                return [];
            }
            return [{ ...c, type: "LWPOLYLINE", points: pts, closed: e.closed === true }];
        }
        case "ELLIPSE": {
            const center = pt(e.center);
            const maj = pt(e.majorAxis);
            const ratio = Number(e.axisRatio ?? 1);
            const a0 = Number(e.startParam ?? 0);
            const a1raw = Number(e.endParam ?? Math.PI * 2);
            const closed = Math.abs(a1raw - a0 - Math.PI * 2) < 1e-9;
            const pts = ellipsePoints(center, maj, ratio, a0, closed ? a0 + Math.PI * 2 : a1raw);
            return [{ ...c, type: "LWPOLYLINE", points: pts, closed }];
        }
        case "TEXT":
        case "ATTRIB":
        case "MTEXT": {
            const isMtext = type === "MTEXT";
            const value = isMtext ? cleanText(String(e.value ?? "")) : String(e.value ?? "");
            if (!value.trim())
                return [];
            const position = pt(e.position);
            const alignPoint = e.alignPoint ? pt(e.alignPoint) : undefined;
            const base = {
                ...c,
                type: "TEXT",
                position,
                height: Number(e.height ?? 0) || (isMtext ? 2.5 : 2.5),
                value,
                rotation: Number(e.rotation ?? 0) * DEG,
            };
            if (type === "TEXT") {
                const h = Number(e.halign ?? 0);
                const v = Number(e.valign ?? 0);
                const al = textAlign(h, v, alignPoint);
                if (al.align !== "left")
                    base.align = al.align;
                if (al.valign !== "baseline")
                    base.valign = al.valign;
                if (al.useAlignPoint && alignPoint)
                    base.position = alignPoint;
                const wf = Number(e.widthFactor ?? 0);
                if (wf > 0 && Math.abs(wf - 1) > 1e-6)
                    base.widthFactor = wf;
                const ob = Number(e.oblique ?? 0) * DEG;
                if (Math.abs(ob) > 1e-6)
                    base.oblique = ob;
                const gf = Number(e.genFlags ?? 0);
                if (gf & 0x2)
                    base.backwards = true;
                if (gf & 0x4)
                    base.upsideDown = true;
            }
            if (isMtext) {
                const ap = Number(e.attachment ?? 1);
                const idx = Math.max(0, Math.min(8, ap - 1));
                const mAlign = ["left", "center", "right"][idx % 3];
                const mValign = ["top", "middle", "bottom"][Math.floor(idx / 3)];
                if (mAlign !== "left")
                    base.align = mAlign;
                if (mValign !== "top")
                    base.valign = mValign;
                const f = mtextFont(String(e.value ?? ""));
                if (f.font)
                    base.font = f.font;
                if (f.bold)
                    base.bold = true;
                if (f.italic)
                    base.italic = true;
                const wf = mtextWidthFactor(String(e.value ?? ""));
                if (wf)
                    base.widthFactor = wf;
            }
            if (typeof e.style === "string" && e.style)
                base.style = e.style;
            return [base];
        }
        case "SOLID":
        case "TRACE":
        case "3DFACE": {
            const p1 = pt(e.c1), p2 = pt(e.c2), p3 = pt(e.c3), p4 = pt(e.c4);
            const ring = type === "3DFACE" ? [p1, p2, p3, p4] : [p1, p2, p4, p3];
            return [{ ...c, type: "LWPOLYLINE", points: ring, closed: true }];
        }
        case "HATCH": {
            const hatch = hatchOf(e, cx);
            if (!hatch || !hatch.loops.length) {
                cx.skip("HATCH (no boundary)");
                return [];
            }
            return [
                {
                    ...c,
                    type: "LWPOLYLINE",
                    points: hatch.loops[0],
                    closed: true,
                    hatch: { ...hatch, loops: hatch.loops },
                },
            ];
        }
        case "LEADER": {
            const pts = (e.vertices ?? []).map(pt);
            if (pts.length < 2) {
                cx.skip("LEADER (<2 vertices)");
                return [];
            }
            return [{ ...c, type: "LWPOLYLINE", points: pts, closed: false }];
        }
        case "RAY": {
            const s = pt(e.start);
            const d = pt(e.direction);
            return [
                { ...c, type: "LINE", start: s, end: { x: s.x + d.x * INF, y: s.y + d.y * INF, z: (s.z ?? 0) + (d.z ?? 0) * INF } },
            ];
        }
        case "XLINE": {
            const s = pt(e.start);
            const d = pt(e.direction);
            return [
                {
                    ...c,
                    type: "LINE",
                    start: { x: s.x - d.x * INF, y: s.y - d.y * INF, z: (s.z ?? 0) - (d.z ?? 0) * INF },
                    end: { x: s.x + d.x * INF, y: s.y + d.y * INF, z: (s.z ?? 0) + (d.z ?? 0) * INF },
                },
            ];
        }
        case "INSERT":
            return convertInsert(e, c, cx, depth, insertLayer);
        case "DIMENSION":
            return convertDimension(e, c, cx, depth, insertLayer);
        case "ATTRIB_ATTACHED":
            return [];
        default:
            cx.skip(type === "UNSUPPORTED" ? `${type} (engine)`.trim() : type || "UNKNOWN");
            return [];
    }
}
function convertInsert(e, c, cx, depth, insertLayer) {
    const name = String(e.block ?? "");
    const blk = cx.blocks.get(name);
    if (!blk || depth >= 8) {
        cx.skip(blk ? "INSERT (too deeply nested)" : `INSERT (missing block ${name})`);
        return [];
    }
    const inner = blk.entities.flatMap((ent) => convertEntity(ent, cx, depth + 1, insertLayer ?? (c.layer === "0" ? null : c.layer)));
    let rows = Math.max(1, Math.round(Number(e.rowCount ?? 1)));
    let cols = Math.max(1, Math.round(Number(e.colCount ?? 1)));
    if (rows * cols > 64) {
        cx.skip(`INSERT (MINSERT grid ${rows}×${cols} exceeds 64 cells — placed once)`);
        rows = 1;
        cols = 1;
    }
    const ins = pt(e.position);
    const rotDeg = Number(e.rotation ?? 0) * DEG;
    const a = rotDeg * (Math.PI / 180);
    const dc = Number(e.colSpacing ?? 0);
    const dr = Number(e.rowSpacing ?? 0);
    const out = [];
    for (let rr = 0; rr < rows; rr++) {
        for (let cc = 0; cc < cols; cc++) {
            const ox = cc * dc, oy = rr * dr;
            const xf = {
                sx: Number(e.xScale ?? 1),
                sy: Number(e.yScale ?? 1),
                sz: Number(e.zScale ?? 1),
                rot: rotDeg,
                base: blk.base,
                ins: {
                    x: ins.x + ox * Math.cos(a) - oy * Math.sin(a),
                    y: ins.y + ox * Math.sin(a) + oy * Math.cos(a),
                    z: ins.z,
                },
            };
            for (const ent of inner)
                out.push(...transformEntity(ent, xf));
        }
    }
    // Attribute values attached to this insert render as absolute text.
    for (const att of (e.attributes ?? [])) {
        const value = String(att.value ?? "");
        if (!value.trim())
            continue;
        out.push({
            layer: c.layer,
            color: c.color,
            rgb: c.rgb,
            type: "TEXT",
            position: pt(att.position),
            height: Number(att.height ?? 2.5) || 2.5,
            value,
            rotation: Number(att.rotation ?? 0) * DEG,
        });
    }
    return out;
}
function convertDimension(e, c, cx, depth, insertLayer) {
    const blkName = String(e.block ?? "");
    const blk = blkName ? cx.blocks.get(blkName) : undefined;
    if (blk && depth < 8) {
        const inner = blk.entities.flatMap((ent) => convertEntity(ent, cx, depth + 1, insertLayer ?? (c.layer === "0" ? null : c.layer)));
        if (inner.length)
            return inner;
    }
    cx.skip("DIMENSION (no geometry block)");
    return [];
}
/** HATCH path edges → boundary loops, plus the real pattern definition. */
function hatchOf(e, cx) {
    const loops = [];
    for (const path of (e.paths ?? [])) {
        const pts = [];
        for (const ed of (path.edges ?? [])) {
            const kind = String(ed.e ?? "");
            if (kind === "line") {
                const a = pt(ed.s), b = pt(ed.v);
                if (!pts.length)
                    pts.push(a);
                pts.push(b);
            }
            else if (kind === "arc") {
                const ctr = pt(ed.c);
                const r = Number(ed.r ?? 0);
                const a0 = Number(ed.sa ?? 0);
                const a1raw = Number(ed.ea ?? Math.PI * 2);
                const ccw = ed.ccw !== false;
                const full = Math.PI * 2;
                const arc = ccw
                    ? arcPoints(ctr.x, ctr.y, r, a0, a1raw <= a0 ? a1raw + full : a1raw, 0)
                    : arcPoints(ctr.x, ctr.y, r, a1raw, a0 <= a1raw ? a0 + full : a0, 0).reverse();
                pts.push(...arc);
            }
            else if (kind === "ellipse") {
                const ctr = pt(ed.c);
                const maj = pt(ed.maj);
                const ratio = Number(ed.ratio ?? 1);
                const a0 = Number(ed.sa ?? 0);
                const a1raw = Number(ed.ea ?? Math.PI * 2);
                const ccw = ed.ccw !== false;
                const full = Math.PI * 2;
                const s = ccw ? a0 : a1raw;
                const t = ccw ? (a1raw <= a0 ? a1raw + full : a1raw) : a0 <= a1raw ? a0 + full : a0;
                pts.push(...ellipsePoints(ctr, maj, ratio, s, t));
            }
            else if (kind === "spline") {
                const deg = Math.max(1, Math.round(Number(ed.degree ?? 3)));
                const ctrl = (ed.ctrl ?? []).map(pt);
                const knots = (ed.knots ?? []).map(Number);
                const fit = (ed.fit ?? []).map(pt);
                pts.push(...(ctrl.length >= deg + 1 ? evalBSpline(ctrl, knots, deg) : fit.length ? fit : ctrl));
            }
            else if (kind === "poly") {
                const raw = (ed.pts ?? []).map((p, i) => ({
                    ...pt(p),
                    bulge: Number((ed.bulges ?? [])[i] ?? 0) || undefined,
                }));
                const closed = ed.closed !== false;
                pts.push(...(raw.some((p) => p.bulge) ? expandBulges(raw, closed) : raw));
            }
        }
        const clean = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 1e-12);
        if (clean.length > 2 && Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].y - clean[clean.length - 1].y) < 1e-9)
            clean.pop();
        if (clean.length >= 3)
            loops.push(clean);
    }
    if (!loops.length)
        return null;
    const name = String(e.patternName ?? "").trim();
    const solid = e.isSolid === true || name.toUpperCase() === "SOLID";
    const out = {
        solid,
        pattern: name || undefined,
        angle: Number(e.patternAngle ?? 0) * DEG,
        scale: Number(e.patternScale ?? 1) || 1,
        loops,
    };
    // Real pattern definition lines — lets the renderer draw the actual
    // ANSI/ISO pattern instead of a placeholder. The file stores the definition
    // in pattern space; apply the hatch's pattern angle and scale here so the
    // renderer receives drawing-space families (same transform AutoCAD applies).
    const lines = (e.patternLines ?? []);
    if (!solid && lines.length) {
        const sc = Number(e.patternScale ?? 1) || 1;
        const pa = Number(e.patternAngle ?? 0);
        const cos = Math.cos(pa), sin = Math.sin(pa);
        out.patternLines = lines.map((l) => {
            const angle = Number(l.angle ?? 0) + pa;
            const b0 = Number((l.base ?? [])[0] ?? 0), b1 = Number((l.base ?? [])[1] ?? 0);
            const o0 = Number((l.offset ?? [])[0] ?? 0), o1 = Number((l.offset ?? [])[1] ?? 0);
            return {
                angle,
                base: [(b0 * cos - b1 * sin) * sc, (b0 * sin + b1 * cos) * sc],
                offset: [(o0 * cos - o1 * sin) * sc, (o0 * sin + o1 * cos) * sc],
                dashes: (l.dashes ?? []).map((d) => Number(d) * sc),
            };
        });
    }
    return out;
}
/** Map the whole engine document onto the platform model. */
function mapDocument(raw, format) {
    const cx = {
        byHandle: new Map(),
        blocks: new Map(),
        skip: () => { },
    };
    const skipped = {};
    cx.skip = (t) => {
        skipped[t] = (skipped[t] ?? 0) + 1;
    };
    const all = Array.isArray(raw.entities) ? raw.entities : [];
    for (const e of all) {
        const h = String(e?.handle ?? "");
        if (h)
            cx.byHandle.set(h, e);
    }
    // Block definitions from the block-record table.
    const layoutBlockNames = new Set();
    for (const br of (raw.blockRecords ?? [])) {
        const name = String(br?.name ?? "");
        if (!name)
            continue;
        if (/^\*(model|paper)_space/i.test(name)) {
            layoutBlockNames.add(name);
            continue;
        }
        const entities = (br.entityHandles ?? [])
            .map((h) => cx.byHandle.get(h))
            .filter(Boolean);
        let base = { x: 0, y: 0, z: 0 };
        const blockEntity = cx.byHandle.get(String(br.blockHandle ?? ""));
        if (blockEntity?.type === "BLOCK" && blockEntity.basePoint)
            base = pt(blockEntity.basePoint);
        cx.blocks.set(name, { base, entities });
    }
    // Model space: prefer the *Model_Space block, else unclaimed entities.
    const claimed = new Set();
    for (const [name, blk] of cx.blocks) {
        for (const ent of blk.entities)
            claimed.add(String(ent.handle));
    }
    const modelBlock = cx.blocks.get("*Model_Space") ?? cx.blocks.get("*MODEL_SPACE");
    let model;
    if (modelBlock) {
        model = modelBlock.entities;
        cx.blocks.delete("*Model_Space");
        cx.blocks.delete("*MODEL_SPACE");
    }
    else {
        model = all.filter((e) => !claimed.has(String(e.handle)) && !e.paperSpace);
    }
    // Paper space layouts: flagged entities, or the paper-space blocks.
    const layouts = [];
    const paperFlagged = all.filter((e) => e.paperSpace && !claimed.has(String(e.handle)));
    const paperNames = [...layoutBlockNames]
        .filter((n) => /paper/i.test(n))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const viewportsOf = (list) => list
        .filter((e) => e.type === "VIEWPORT" && Number(e.viewHeight ?? 0) > 0)
        .map((e) => ({
        center: pt(e.center),
        width: Number(e.width ?? 0),
        height: Number(e.height ?? 0),
        viewCenter: pt(e.viewCenter),
        viewHeight: Number(e.viewHeight ?? 0),
        twist: Number(e.twist ?? 0) * DEG || undefined,
    }));
    if (paperFlagged.length) {
        layouts.push({
            name: "Paper Space",
            entities: convertList(paperFlagged.filter((e) => e.type !== "VIEWPORT"), cx),
            viewports: viewportsOf(paperFlagged),
        });
    }
    for (const n of paperNames) {
        const br = (raw.blockRecords ?? []).find((b) => b.name === n);
        const entities = (br?.entityHandles ?? [])
            .map((h) => cx.byHandle.get(h))
            .filter(Boolean);
        if (!entities.length)
            continue;
        layouts.push({
            name: n.replace(/^\*/i, "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()),
            entities: convertList(entities.filter((e) => e.type !== "VIEWPORT"), cx),
            viewports: viewportsOf(entities),
        });
    }
    const entities = convertList(model, cx);
    const doc = {
        layers: mapLayers(raw.layers),
        entities,
        sourceFormat: format === "dwg" ? "dwg" : "dxf",
    };
    const linetypes = {};
    for (const lt of (raw.linetypes ?? [])) {
        const name = String(lt.name ?? "").toUpperCase();
        if (!name || name === "BYBLOCK" || name === "BYLAYER")
            continue;
        const dashes = (lt.elements ?? []).map((el) => Number(el.length ?? 0));
        if (dashes.length)
            linetypes[name] = dashes;
    }
    if (Object.keys(linetypes).length)
        doc.linetypes = linetypes;
    if (typeof raw.header?.ltscale === "number" && raw.header.ltscale !== 1) {
        doc.ltscale = raw.header.ltscale;
    }
    const textStyles = {};
    for (const st of (raw.textStyles ?? [])) {
        const name = String(st.name ?? "").toUpperCase();
        if (!name)
            continue;
        const s = {};
        const font = String(st.fontFile ?? "").trim();
        const ttf = String(st.trueTypeFont ?? "").trim();
        if (font)
            s.font = font;
        else if (ttf)
            s.font = ttf;
        if (typeof st.bigFontFile === "string" && st.bigFontFile)
            s.bigFont = st.bigFontFile;
        if (Number(st.height) > 0)
            s.height = Number(st.height);
        if (Number(st.widthFactor) > 0 && Math.abs(Number(st.widthFactor) - 1) > 1e-6) {
            s.width = Number(st.widthFactor);
        }
        if (Number(st.oblique))
            s.oblique = Number(st.oblique) * DEG;
        if (st.backwards)
            s.backwards = true;
        if (st.upsideDown)
            s.upsideDown = true;
        textStyles[name] = s;
    }
    if (Object.keys(textStyles).length)
        doc.textStyles = textStyles;
    const dimStyles = [];
    const dimStyleTable = {};
    for (const ds of (raw.dimStyles ?? [])) {
        const name = String(ds.name ?? "");
        if (!name)
            continue;
        dimStyles.push(name);
        dimStyleTable[name.toUpperCase()] = {
            scale: Number(ds.dimscale ?? 1) || 1,
            textHeight: Number(ds.dimtxt ?? 0) || undefined,
            arrowSize: Number(ds.dimasz ?? 0) || undefined,
            extOffset: Number(ds.dimexo ?? 0) || undefined,
            extExtend: Number(ds.dimexe ?? 0) || undefined,
            textGap: Number(ds.dimgap ?? 0) || undefined,
        };
    }
    if (dimStyles.length) {
        doc.dimStyles = dimStyles;
        doc.dimStyleTable = dimStyleTable;
    }
    const units = insUnitsToUnits(Number(raw.header?.insunits ?? 0));
    if (units !== "unitless")
        doc.units = units;
    const extmin = raw.header?.extmin ? pt(raw.header.extmin) : null;
    const extmax = raw.header?.extmax ? pt(raw.header.extmax) : null;
    if (extmin && extmax && extmax.x - extmin.x > 0 && extmax.y - extmin.y > 0) {
        doc.extents = { min: extmin, max: extmax };
    }
    else {
        doc.extents = robustExtents(entities);
    }
    if (Object.keys(skipped).length)
        doc.skipped = skipped;
    if (layouts.length)
        doc.layouts = layouts;
    return doc;
}
function mapLayers(rawLayers) {
    const out = [];
    for (const l of (rawLayers ?? [])) {
        const name = String(l.name ?? "");
        if (!name)
            continue;
        const { color, rgb } = colorOf(l.color);
        const layer = {
            name,
            color: color ?? (rgb !== undefined ? 7 : 7),
        };
        if (rgb !== undefined)
            layer.rgb = rgb;
        if (typeof l.lineType === "string" && l.lineType && l.lineType !== "ByLayer") {
            layer.lineType = l.lineType;
        }
        const lw = lineWeightMm(l.lineWeight);
        if (lw !== undefined)
            layer.lineweight = lw;
        const tr = transparencyPct(l.transparency);
        if (tr !== undefined)
            layer.transparency = tr;
        if (l.isPlottable === false)
            layer.plot = false;
        if (l.frozen)
            layer.frozen = true;
        if (l.off)
            layer.off = true;
        if (l.locked)
            layer.locked = true;
        out.push(layer);
    }
    return out;
}
function convertList(list, cx) {
    const out = [];
    for (const e of list) {
        try {
            out.push(...convertEntity(e, cx, 0, null));
        }
        catch (err) {
            cx.skip(`${e?.type ?? "?"} (unreadable)`);
            if (err instanceof RangeError)
                throw err; // stack exhaustion is real
        }
    }
    return out;
}
/** Version stamp helper for tests: sniff DWG/DXF from the first bytes. */
export function looksLikeDrawing(bytes) {
    if (bytes.length < 8)
        return false;
    const head = String.fromCharCode(...bytes.slice(0, 6));
    if (/^A[CD]10\d{2}$/.test(head))
        return true;
    const text = new TextDecoder().decode(bytes.slice(0, 64));
    return /^\s*0\r?\n|AutoCAD Binary DXF/.test(text);
}
