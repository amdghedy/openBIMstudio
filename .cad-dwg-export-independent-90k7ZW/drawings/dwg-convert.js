import { arcPoints, computeExtents, ellipsePoints, evalBSpline, expandBulges, insUnitsToUnits, transformEntity, flipEntityX, isMirroredOcs, } from "./dxf-geometry";
import { cleanText } from "./dxf-reader";
const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;
const MAX_DEPTH = 8;
function pick(o, names) {
    if (!o)
        return undefined;
    for (const n of names)
        if (o[n] !== undefined && o[n] !== null)
            return o[n];
    return undefined;
}
function toNum(v, d = 0) {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : d;
}
function toPt(v) {
    if (Array.isArray(v))
        return { x: toNum(v[0]), y: toNum(v[1]), z: toNum(v[2]) };
    return { x: toNum(v?.x), y: toNum(v?.y), z: toNum(v?.z) };
}
function entriesOf(table) {
    if (!table)
        return [];
    const e = table.entries ?? table;
    if (Array.isArray(e))
        return e;
    if (e && typeof e === "object")
        return Object.values(e);
    return [];
}
/** True when any angle in the database is clearly in degrees (> 2*PI). */
function anglesAreDegrees(entities, blocks) {
    const check = (list) => {
        for (const e of list) {
            const t = String(e?.type ?? e?.entityType ?? "").toUpperCase();
            const vals = [];
            if (t === "ARC")
                vals.push(pick(e, ["startAngle", "start_angle"]), pick(e, ["endAngle", "end_angle"]));
            else if (t === "INSERT" || t === "TEXT" || t === "MTEXT")
                vals.push(e?.rotation);
            else if (t === "ELLIPSE")
                vals.push(pick(e, ["startAngle", "startParameter"]), pick(e, ["endAngle", "endParameter"]));
            for (const v of vals)
                if (typeof v === "number" && Math.abs(v) > 2 * TWO_PI + 0.01)
                    return true; // > two full turns in radians can only be degrees
        }
        return false;
    };
    if (check(entities))
        return true;
    for (const b of blocks.values())
        if (check(b.entities ?? []))
            return true;
    return false;
}
/** Push without spreading — huge arrays would overflow the argument limit. */
function pushAll(out, arr) {
    if (!arr)
        return;
    for (let i = 0; i < arr.length; i++)
        out.push(arr[i]);
}
/** Hard cap on emitted entities: protects the reader worker from drawings whose
 *  INSERT / MINSERT references multiply into millions of objects (the worker is
 *  synchronous — an unbounded conversion stalls it past the parse timeout). */
const ENTITY_BUDGET = 1200000;
/** Hard cap on one INSERT's row×column grid (AutoCAD MINSERT). */
const MAX_INSERT_CELLS = 4096;
function colorOf(e) {
    const ci = pick(e, ["colorIndex", "aci", "colorNumber"]);
    if (typeof ci === "number" && Math.abs(ci) >= 1 && Math.abs(ci) <= 255)
        return { color: Math.abs(ci) };
    const c = e?.color;
    if (typeof c === "number") {
        if (c > 255)
            return { rgb: c & 0xffffff };
        if (c >= 1)
            return { color: c };
    }
    const tc = pick(e, ["trueColor", "rgb"]);
    if (typeof tc === "number" && tc > 0)
        return { rgb: tc & 0xffffff };
    return {};
}
const OCS_TYPES = new Set(["CIRCLE", "ARC", "LWPOLYLINE", "POLYLINE", "POLYLINE2D", "TEXT", "ATTRIB", "ATTDEF", "HATCH", "INSERT", "SOLID", "TRACE"]);
function textAlignOf(e, type) {
    if (type === "MTEXT") {
        const ap = toNum(pick(e, ["attachmentPoint", "attachment"]), 1);
        return {
            align: ["left", "center", "right"][Math.max(0, Math.min(2, (ap - 1) % 3))],
            valign: ["top", "middle", "bottom"][Math.max(0, Math.min(2, Math.floor((ap - 1) / 3)))],
            useAlignPoint: false,
        };
    }
    const h = toNum(pick(e, ["horizontalJustification", "horizontalAlignment", "halign", "horizJustification"]));
    const v = toNum(pick(e, ["verticalAlignment", "verticalJustification", "valign", "vertJustification"]));
    const ap = pick(e, ["endPoint", "alignmentPoint", "secondAlignmentPoint"]);
    return {
        align: h === 1 || h === 4 ? "center" : h === 2 ? "right" : "left",
        valign: h === 4 ? "middle" : v === 1 ? "bottom" : v === 2 ? "middle" : v === 3 ? "top" : "baseline",
        useAlignPoint: (h !== 0 || v !== 0) && !!ap,
        point: ap ? toPt(ap) : undefined,
    };
}
/** Best-effort HATCH conversion from a libredwg-style entity (field names vary between builds). */
function hatchOf(e, cx) {
    const paths = pick(e, ["boundaryPaths", "paths", "loops", "boundaries"]) ?? [];
    const loops = [];
    for (const path of paths) {
        const pts = [];
        const verts = pick(path, ["polylineVertices", "vertices", "points", "polyline"]);
        if (Array.isArray(verts) && verts.length) {
            const closed = path.isClosed !== false;
            pushAll(pts, expandBulges(verts.map((v) => ({ ...toPt(v), bulge: toNum(v?.bulge) || undefined })), closed));
        }
        else {
            for (const ed of (pick(path, ["edges", "segments"]) ?? [])) {
                const t = String(pick(ed, ["type", "edgeType"]) ?? "").toUpperCase();
                const tn = toNum(pick(ed, ["type", "edgeType"]), NaN);
                if (t === "LINE" || tn === 1) {
                    const a = toPt(pick(ed, ["start", "startPoint"])), b = toPt(pick(ed, ["end", "endPoint"]));
                    if (!pts.length)
                        pts.push(a);
                    pts.push(b);
                }
                else if (t === "ARC" || t === "CIRCULAR_ARC" || tn === 2) {
                    const ctr = toPt(pick(ed, ["center", "centre"])), r = toNum(ed.radius);
                    const a0 = toNum(pick(ed, ["startAngle"])) * cx.toRad, a1raw = toNum(pick(ed, ["endAngle"]), cx.fullTurn) * cx.toRad;
                    const ccw = ed.isCCW !== false && ed.counterClockwise !== false && ed.isCounterClockwise !== false;
                    const full = TWO_PI;
                    const arc = ccw ? arcPoints(ctr.x, ctr.y, r, a0, a1raw <= a0 ? a1raw + full : a1raw, 0) : arcPoints(ctr.x, ctr.y, r, a1raw, a0 <= a1raw ? a0 + full : a0, 0).reverse();
                    pushAll(pts, arc);
                }
                else if (t === "ELLIPSE" || t === "ELLIPTICAL_ARC" || tn === 3) {
                    const ctr = toPt(pick(ed, ["center", "centre"])), maj = toPt(pick(ed, ["majorAxisEndPoint", "majorAxis", "endPoint"]));
                    const ratio = toNum(pick(ed, ["axisRatio", "ratio", "minorToMajorRatio"]), 1);
                    const a0 = toNum(pick(ed, ["startAngle"])) * cx.toRad, a1 = toNum(pick(ed, ["endAngle"]), cx.fullTurn) * cx.toRad;
                    pushAll(pts, ellipsePoints(ctr, maj, ratio, a0, a1 <= a0 ? a1 + TWO_PI : a1));
                }
                else if (t === "SPLINE" || tn === 4) {
                    const ctrl = (pick(ed, ["controlPoints"]) ?? []).map(toPt);
                    const knots = (pick(ed, ["knots", "knotValues"]) ?? []).map((k) => toNum(k));
                    const deg = toNum(pick(ed, ["degree"]), 3);
                    pushAll(pts, (ctrl.length >= deg + 1 ? evalBSpline(ctrl, knots, deg) : null) ?? ctrl);
                }
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
    const name = String(pick(e, ["patternName", "pattern", "name"]) ?? "").trim();
    const solid = e.isSolidFill === true || e.solidFill === true || toNum(pick(e, ["solidFill", "isSolid"])) === 1 || name.toUpperCase() === "SOLID";
    return { solid, pattern: name || undefined, angle: toNum(pick(e, ["patternAngle", "angle"])) * cx.toDeg, scale: toNum(pick(e, ["patternScale", "patternScaleOrSpacing", "scale"]), 1) || 1, loops };
}
/** LTYPE table -> dash arrays (positive dash, negative gap). */
function linetypesOf(db) {
    const out = {};
    for (const lt of entriesOf(db?.tables?.LTYPE)) {
        const name = String(lt?.name ?? "").trim().toUpperCase();
        const els = pick(lt, ["pattern", "dashes", "elements", "segments", "dashLengths"]) ?? [];
        const arr = els.map((x) => (typeof x === "number" ? x : toNum(pick(x, ["dashLength", "length", "value"])))).filter((n) => Number.isFinite(n));
        if (name && arr.length)
            out[name] = arr;
    }
    return out;
}
function viewportOf(e) {
    const centre = pick(e, ["viewportCenter", "centerPoint", "center", "position"]);
    const width = toNum(pick(e, ["viewportWidth", "width"])), height = toNum(pick(e, ["viewportHeight", "height"]));
    const vh = toNum(pick(e, ["viewHeight", "modelViewHeight"]));
    if (!centre || width <= 0 || height <= 0 || vh <= 0)
        return null;
    if (toNum(pick(e, ["viewportId", "id"]), 2) === 1)
        return null; // overall paper viewport
    return { center: toPt(centre), width, height, viewCenter: toPt(pick(e, ["viewCenter", "viewCenterPoint", "viewTarget"])), viewHeight: vh, twist: toNum(pick(e, ["twistAngle", "viewTwistAngle"])) || undefined };
}
function convertList(list, cx, depth, insertLayer) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (cx.budget <= 0) {
            cx.skip("(entity budget reached — remaining entities not drawn)");
            return out;
        }
        if ((i & 511) === 511 && Date.now() > cx.deadline) {
            cx.skip("(time budget reached — remaining entities not drawn)");
            return out;
        }
        const type = String(e?.type ?? e?.entityType ?? "").toUpperCase();
        if (!type)
            continue;
        if (e.inPaperSpace === true || e.paperSpace === true)
            continue;
        let layer = String(pick(e, ["layer", "layerName"]) ?? "0");
        if (insertLayer && layer === "0")
            layer = insertLayer;
        const ltRaw = pick(e, ["lineType", "lineTypeName", "linetype", "ltype"]);
        const ltName = typeof ltRaw === "string" ? ltRaw.trim() : "";
        const ltUp = ltName.toUpperCase();
        // Per-entity linetype scale + transparency (AutoCAD-fidelity properties).
        const ltScale = toNum(pick(e, ["linetypeScale", "ltScale", "lineTypeScale"]), 0);
        const transRaw = toNum(pick(e, ["transparency", "transparencyValue"]), 0);
        const transparency = transRaw > 0 ? Math.max(0, Math.min(90, transRaw <= 90 ? transRaw : (transRaw >>> 24) & 0xff)) : 0;
        const c = {
            layer, ...colorOf(e),
            ...(ltName && ltUp !== "BYLAYER" && ltUp !== "BYBLOCK" && ltUp !== "CONTINUOUS" ? { lineType: ltName } : {}),
            ...(ltScale > 0 && Math.abs(ltScale - 1) > 1e-9 ? { ltScale } : {}),
            ...(transparency ? { transparency } : {}),
        };
        const outStart = out.length;
        const exRaw = pick(e, ["extrusionDirection", "extrusion", "normal"]);
        const ex = exRaw ? toPt(exRaw) : null;
        const ocsFlip = !!ex && OCS_TYPES.has(type) && isMirroredOcs(ex.x, ex.y, ex.z ?? 1);
        try {
            switch (type) {
                case "LINE":
                    out.push({
                        ...c, type: "LINE",
                        start: toPt(pick(e, ["startPoint", "start", "p1"])),
                        end: toPt(pick(e, ["endPoint", "end", "p2"])),
                    });
                    break;
                case "CIRCLE":
                    out.push({ ...c, type: "CIRCLE", center: toPt(e.center), radius: toNum(e.radius) });
                    break;
                case "ARC":
                    out.push({
                        ...c, type: "ARC", center: toPt(e.center), radius: toNum(e.radius),
                        startAngle: toNum(pick(e, ["startAngle", "start_angle"])) * cx.toDeg,
                        endAngle: toNum(pick(e, ["endAngle", "end_angle"]), cx.fullTurn) * cx.toDeg,
                    });
                    break;
                case "LWPOLYLINE":
                case "POLYLINE":
                case "POLYLINE2D":
                case "POLYLINE3D": {
                    const raw = pick(e, ["vertices", "points"]) ?? [];
                    const flag = toNum(pick(e, ["flag", "flags"]));
                    const closed = e.closed === true || e.isClosed === true || (flag & 1) === 1;
                    const verts = raw
                        .filter((v) => !(toNum(v?.flag ?? v?.flags) & 16)) // spline-frame points
                        .map((v) => ({ ...toPt(v), bulge: toNum(v?.bulge) || undefined }));
                    if (verts.length >= 2)
                        out.push({ ...c, type: "LWPOLYLINE", points: expandBulges(verts, closed), closed });
                    break;
                }
                case "TEXT":
                case "MTEXT":
                case "ATTRIB":
                case "ATTDEF": {
                    const pos = toPt(pick(e, ["startPoint", "insertionPoint", "position", "insertPoint"]));
                    const value = cleanText(String(pick(e, ["text", "textString", "value", "contents"]) ?? ""));
                    if (!value)
                        break;
                    let rot = e.rotation !== undefined ? toNum(e.rotation) * cx.toDeg : undefined;
                    const dir = pick(e, ["directionVector", "xAxisDirection"]);
                    if (rot === undefined && dir)
                        rot = Math.atan2(toNum(dir.y), toNum(dir.x)) / DEG;
                    if (type === "ATTDEF")
                        break; // placeholder; inserted ATTRIBs carry the value
                    if (type === "ATTRIB" && (e.invisible === true || (toNum(pick(e, ["flag", "flags", "attributeFlags"])) & 1) === 1))
                        break;
                    const al = textAlignOf(e, type);
                    out.push({
                        ...c, type: "TEXT", position: al.useAlignPoint ? al.point : pos,
                        height: toNum(pick(e, ["textHeight", "height", "fontSize"]), 2.5),
                        value, rotation: rot, align: al.align, valign: al.valign,
                        ...dwgTextStyle(e, cx),
                    });
                    break;
                }
                case "HATCH": {
                    const h = hatchOf(e, cx);
                    if (!h) {
                        cx.skip("HATCH");
                        break;
                    }
                    out.push({ ...c, type: "LWPOLYLINE", points: h.loops[0], closed: true, hatch: h });
                    break;
                }
                case "LEADER": {
                    const pts = (pick(e, ["vertices", "points"]) ?? []).map(toPt);
                    if (pts.length >= 2)
                        out.push({ ...c, type: "LWPOLYLINE", points: pts, closed: false });
                    else
                        cx.skip("LEADER");
                    break;
                }
                case "MLEADER":
                case "MULTILEADER": {
                    let any = false;
                    const lines = pick(e, ["leaderLines", "leaders", "leaderLineArray"]) ?? [];
                    for (const ln of lines) {
                        const pts = (pick(ln, ["vertices", "points", "lineVertices"]) ?? []).map(toPt);
                        if (pts.length >= 2) {
                            out.push({ ...c, type: "LWPOLYLINE", points: pts, closed: false });
                            any = true;
                        }
                    }
                    const txt = cleanText(String(pick(e, ["text", "contents", "textContent", "mtext"]) ?? ""));
                    const tp = pick(e, ["textLocation", "textPosition", "contentBasePoint", "position"]);
                    if (txt && tp) {
                        out.push({ ...c, type: "TEXT", position: toPt(tp), height: toNum(pick(e, ["textHeight", "height"]), 2.5), value: txt });
                        any = true;
                    }
                    if (!any)
                        cx.skip("MLEADER");
                    break;
                }
                case "POINT":
                    out.push({ ...c, type: "POINT", position: toPt(pick(e, ["position", "point", "location"])) });
                    break;
                case "SPLINE": {
                    const ctrl = (pick(e, ["controlPoints"]) ?? []).map(toPt);
                    const fit = (pick(e, ["fitPoints"]) ?? []).map(toPt);
                    const knots = (pick(e, ["knots", "knotValues"]) ?? []).map((k) => toNum(k));
                    const degree = toNum(pick(e, ["degree", "degreeOfSplineCurve"]), 3);
                    const closed = e.closed === true || (toNum(pick(e, ["flag", "flags"])) & 1) === 1;
                    let pts = ctrl.length >= degree + 1 ? evalBSpline(ctrl, knots, degree) : null;
                    if (!pts)
                        pts = fit.length >= 2 ? fit : ctrl;
                    if (pts.length >= 2)
                        out.push({ ...c, type: "LWPOLYLINE", points: pts, closed });
                    break;
                }
                case "ELLIPSE": {
                    const t0 = toNum(pick(e, ["startAngle", "startParameter"])) * cx.toRad;
                    const t1 = toNum(pick(e, ["endAngle", "endParameter"]), TWO_PI / cx.toRad) * cx.toRad;
                    const pts = ellipsePoints(toPt(e.center), toPt(pick(e, ["majorAxisEndPoint", "majorAxis"])), toNum(pick(e, ["axisRatio", "ratio", "minorToMajorRatio"]), 1), t0, t1);
                    out.push({ ...c, type: "LWPOLYLINE", points: pts, closed: Math.abs(t1 - t0 - TWO_PI) < 1e-6 });
                    break;
                }
                case "SOLID":
                case "TRACE":
                case "3DFACE": {
                    const pts = (pick(e, ["points", "corners"]) ??
                        [e.corner1 ?? e.firstCorner, e.corner2 ?? e.secondCorner, e.corner3 ?? e.thirdCorner, e.corner4 ?? e.fourthCorner]).filter(Boolean).map(toPt);
                    if (pts.length >= 3) {
                        const ring = type === "3DFACE" || pts.length < 4 ? pts : [pts[0], pts[1], pts[3], pts[2]];
                        out.push({ ...c, type: "LWPOLYLINE", points: ring, closed: true });
                    }
                    break;
                }
                case "INSERT": {
                    const name = String(e.name ?? e.blockName ?? "");
                    const blk = cx.blocks.get(name);
                    if (!blk || depth >= MAX_DEPTH) {
                        cx.skip(blk ? "INSERT (too deeply nested)" : "INSERT (missing block)");
                        break;
                    }
                    const inner = convertList(blk.entities ?? [], cx, depth + 1, layer);
                    let cols = Math.max(1, Math.round(toNum(pick(e, ["columnCount", "columns"]), 1)));
                    let rows = Math.max(1, Math.round(toNum(pick(e, ["rowCount", "rows"]), 1)));
                    if (rows * cols > MAX_INSERT_CELLS) {
                        cx.skip(`INSERT (MINSERT grid ${rows}×${cols} exceeds ${MAX_INSERT_CELLS} cells — placed once)`);
                        rows = 1;
                        cols = 1;
                    }
                    const dc = toNum(pick(e, ["columnSpacing"])), dr = toNum(pick(e, ["rowSpacing"]));
                    const ins = toPt(pick(e, ["insertionPoint", "position", "insertPoint"]));
                    const rotDeg = toNum(e.rotation) * cx.toDeg;
                    const a = rotDeg * DEG;
                    for (let rr = 0; rr < rows; rr++) {
                        for (let cc = 0; cc < cols; cc++) {
                            const ox = cc * dc, oy = rr * dr;
                            const xf = {
                                sx: toNum(pick(e, ["xScale", "scaleX"]), 1),
                                sy: toNum(pick(e, ["yScale", "scaleY"]), 1),
                                sz: toNum(pick(e, ["zScale", "scaleZ"]), 1),
                                rot: rotDeg,
                                base: toPt(pick(blk, ["basePoint", "origin", "position"])),
                                ins: {
                                    x: ins.x + ox * Math.cos(a) - oy * Math.sin(a),
                                    y: ins.y + ox * Math.sin(a) + oy * Math.cos(a),
                                    z: ins.z,
                                },
                            };
                            for (const ent of inner)
                                pushAll(out, transformEntity(ent, xf));
                        }
                    }
                    break;
                }
                case "DIMENSION": {
                    const blk = cx.blocks.get(String(e.name ?? e.blockName ?? ""));
                    if (blk && depth < MAX_DEPTH)
                        pushAll(out, convertList(blk.entities ?? [], cx, depth + 1, layer));
                    else
                        cx.skip("DIMENSION");
                    break;
                }
                default:
                    cx.skip(type);
            }
            if (ocsFlip)
                for (let k = outStart; k < out.length; k++)
                    out[k] = flipEntityX(out[k]);
            cx.budget -= out.length - outStart;
        }
        catch {
            cx.skip(`${type} (unreadable)`);
        }
    }
    return out;
}
/** Convert a libredwg-web database into a DxfDocument. */
/** Best-effort text style fields from a libredwg text entity (names vary by build; unknown -> omitted). */
function dwgTextStyle(e, cx) {
    const out = {};
    const st = pick(e, ["styleName", "style"]);
    if (typeof st === "string" && st.trim())
        out.style = st.trim();
    const wf = toNum(pick(e, ["widthFactor", "widthScale", "xScale"]));
    if (wf > 0 && Math.abs(wf - 1) > 1e-6)
        out.widthFactor = wf;
    const ob = toNum(pick(e, ["obliqueAngle", "oblique"])) * cx.toDeg;
    if (Number.isFinite(ob) && Math.abs(ob) > 1e-6)
        out.oblique = ob;
    return out;
}
export function dwgDatabaseToDxfDocument(db, opts) {
    const blocks = new Map();
    for (const b of entriesOf(db?.tables?.BLOCK_RECORD ?? db?.blocks)) {
        const n = String(b?.name ?? "");
        if (n)
            blocks.set(n, b);
    }
    let model = Array.isArray(db?.entities) ? db.entities : [];
    if (!model.length) {
        for (const key of ["*Model_Space", "*MODEL_SPACE", "*model_space"]) {
            const m = blocks.get(key);
            if (m?.entities?.length) {
                model = m.entities;
                break;
            }
        }
    }
    // Paper-space entities (flagged on the entity, or held in *Paper_Space blocks) become layouts.
    const isPaper = (e) => e?.inPaperSpace === true || e?.paperSpace === true;
    const paperLists = [];
    const paperFlagged = model.filter(isPaper);
    if (paperFlagged.length)
        paperLists.push(paperFlagged);
    for (const [n, b] of [...blocks.entries()].sort(([a], [c]) => a.localeCompare(c, undefined, { numeric: true }))) {
        if (!/^\*paper_space\d*$/i.test(n) || !b?.entities?.length)
            continue;
        if (n.toLowerCase() === "*paper_space" && paperFlagged.length)
            continue;
        paperLists.push(b.entities);
    }
    const skipped = {};
    const skip = (t) => { skipped[t] = (skipped[t] ?? 0) + 1; };
    const deg = anglesAreDegrees(model, blocks);
    // Radians -> degrees is * (180 / PI) = * (1 / DEG).
    const cx = {
        blocks, skip,
        toDeg: deg ? 1 : 1 / DEG,
        toRad: deg ? DEG : 1,
        fullTurn: deg ? 360 : TWO_PI,
        budget: opts?.entityBudget ?? ENTITY_BUDGET,
        deadline: opts?.deadlineMs ?? Number.POSITIVE_INFINITY,
    };
    const entities = convertList(model, cx, 0, null);
    const layouts = [];
    for (const list of paperLists) {
        const vps = [];
        const rest = list.filter((e) => {
            if (String(e?.type ?? "").toUpperCase() !== "VIEWPORT")
                return true;
            const vp = viewportOf(e);
            if (vp)
                vps.push(vp);
            return false;
        }).map((e) => (isPaper(e) ? { ...e, inPaperSpace: false, paperSpace: false } : e));
        const ents = convertList(rest, cx, 0, null);
        if (ents.length || vps.length)
            layouts.push({ name: `Layout ${layouts.length + 1}`, entities: ents, viewports: vps });
    }
    const layers = [];
    for (const l of entriesOf(db?.tables?.LAYER)) {
        const flag = toNum(pick(l, ["flag", "flags", "standardFlag"]));
        const ci = toNum(pick(l, ["colorIndex", "color"]), 7);
        // True colour (libredwg exposes color as 0x0C000000RRGGBB-ish or a `colorRgb`/`trueColor` field).
        const rawTc = pick(l, ["trueColor", "colorRgb", "rgb"]);
        const tcN = typeof rawTc === "number" ? rawTc : toNum(rawTc, 0);
        const rgb = tcN > 0xffffff ? (tcN & 0xffffff) : tcN > 0 ? tcN : undefined;
        const transRaw = toNum(pick(l, ["transparency", "transparencyValue"]), 0);
        const transparency = transRaw > 0 ? Math.max(0, Math.min(90, transRaw <= 90 ? transRaw : (transRaw >>> 24) & 0xff)) : 0;
        const plotRaw = pick(l, ["plotFlag", "plots", "plot"]);
        layers.push({
            name: String(l?.name ?? "0"),
            color: Math.abs(ci) >= 1 && Math.abs(ci) <= 255 ? Math.abs(ci) : 7,
            ...(rgb ? { rgb } : {}),
            lineType: typeof pick(l, ["lineType", "lineTypeName"]) === "string" ? String(pick(l, ["lineType", "lineTypeName"])) : undefined,
            frozen: l?.frozen === true || (flag & 1) === 1,
            locked: l?.locked === true || (flag & 4) === 4,
            off: l?.off === true || l?.visible === false || ci < 0,
            ...(transparency ? { transparency } : {}),
            ...(typeof plotRaw === "boolean" ? { plot: plotRaw } : toNum(plotRaw, 1) === 0 ? { plot: false } : {}),
        });
    }
    if (!layers.some((l) => l.name === "0"))
        layers.unshift({ name: "0", color: 7 });
    const known = new Set(layers.map((l) => l.name));
    for (const e of entities) {
        if (!known.has(e.layer)) {
            known.add(e.layer);
            layers.push({ name: e.layer, color: 7 });
        }
    }
    const insUnits = db?.header?.INSUNITS ?? db?.header?.$INSUNITS ?? db?.header?.insUnits;
    const lts = linetypesOf(db);
    const doc = {
        layers,
        entities,
        extents: computeExtents(entities),
        units: insUnitsToUnits(toNum(insUnits)),
        sourceFormat: "dwg",
        layouts: layouts.length ? layouts : undefined,
        linetypes: Object.keys(lts).length ? lts : undefined,
        ltscale: toNum(db?.header?.LTSCALE ?? db?.header?.$LTSCALE, 0) > 0 ? toNum(db?.header?.LTSCALE ?? db?.header?.$LTSCALE) : undefined,
        skipped: Object.keys(skipped).length ? skipped : undefined,
    };
    const skippedText = Object.entries(skipped).map(([k, v]) => `${v}×${k}`).join(", ");
    const summary = `${entities.length} drawable entities on ${layers.length} layers` +
        (skippedText ? `; not drawn: ${skippedText}` : "") +
        (model.length === 0 ? "; model space was empty" : "");
    return { doc, summary };
}
