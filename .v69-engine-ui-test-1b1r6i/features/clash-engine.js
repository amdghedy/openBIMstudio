"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLASH_METHODS = exports.DEFAULT_CLASH_RULES = void 0;
exports.getLastCollectionReport = getLastCollectionReport;
exports.sideFlag = sideFlag;
exports.collectItems = collectItems;
exports.runClashEngine = runClashEngine;
/**
 * Clash engine (main-thread orchestrator).
 *
 * Responsibility split:
 *   • This file  — reads Fragments geometry for the requested model ids,
 *                  prefetches metadata, and delegates pair math to clash-core.
 *   • clash-core — pure math: broadphase (spatial hash) + narrowphase.
 *   • clash.worker — runs clash-core off the main thread.
 */
const THREE = require("three");
const clash_core_1 = require("../modules/clash/clash-core");
Object.defineProperty(exports, "DEFAULT_CLASH_RULES", { enumerable: true, get: function () { return clash_core_1.DEFAULT_CLASH_RULES; } });
Object.defineProperty(exports, "CLASH_METHODS", { enumerable: true, get: function () { return clash_core_1.CLASH_METHODS; } });
const geometry_1 = require("../modules/clash/geometry");
const clash_authored_1 = require("./clash-authored");
const world_box_1 = require("../modules/geometry/world-box");
let lastReport = null;
/** Coverage of the most recent run (null before the first run). */
function getLastCollectionReport() { return lastReport; }
function sideFlag(a, b, id) {
    const inA = a === "ALL" || (a instanceof Set && a.has(id));
    const inB = b === "ALL" || (b instanceof Set && b.has(id));
    return (inA ? 1 : 0) | (inB ? 2 : 0);
}
async function prefetchMeta(model, ids) {
    const out = new Map();
    if (!ids.length)
        return out;
    try {
        const data = await model.getItemsData(ids, {
            attributesDefault: false,
            attributes: ["Name", "ObjectType", "Tag"],
        });
        for (let i = 0; i < ids.length; i++) {
            const d = data?.[i];
            const name = String(d?.Name?.value ?? d?.ObjectType?.value ?? d?.Tag?.value ?? `#${ids[i]}`);
            out.set(ids[i], { name, category: "Unknown" });
        }
    }
    catch (err) {
        console.warn("[clash] getItemsData failed — using placeholder names", err);
        for (const id of ids)
            out.set(id, { name: `#${id}`, category: "Unknown" });
    }
    try {
        const cats = (await model.getItemsOfCategories([/.+/]));
        for (const [cat, list] of Object.entries(cats)) {
            for (const id of list || []) {
                const e = out.get(id);
                if (e)
                    e.category = cat;
            }
        }
    }
    catch { /* */ }
    return out;
}
async function collectItems(inputs, opts = {}) {
    const method = opts.method ?? "hard-triangle";
    const needsTriangles = method === "hard-triangle" ||
        method === "convex-gjk" ||
        method === "clearance";
    const wantGeometry = needsTriangles && (opts.collectGeometry ?? true);
    const allItems = [];
    const groups = [];
    const sides = [];
    const modelReports = [];
    let hasAllTriangles = true;
    const finish = () => {
        const report = {
            models: modelReports,
            totalTested: modelReports.reduce((n, m) => n + m.tested, 0),
            totalBoxOnly: modelReports.reduce((n, m) => n + m.boxOnly, 0),
            totalSkipped: modelReports.reduce((n, m) => n + m.skippedNoBox + m.skippedHuge + m.skippedEmpty, 0),
        };
        lastReport = report;
        return { items: allItems, groups, hasAllTriangles, report, ...(opts.useSides ? { sides } : {}) };
    };
    for (let gi = 0; gi < inputs.length; gi++) {
        const input = inputs[gi];
        const { modelId, model, allowedIds } = input;
        const group = [];
        const rep = {
            modelId, elements: 0, tested: 0, withTriangles: 0, boxOnly: 0, boxOnlyTooComplex: 0,
            skippedNoBox: 0, skippedHuge: 0, skippedEmpty: 0,
        };
        modelReports.push(rep);
        let ids = [];
        try {
            ids = (await model.getItemsIdsWithGeometry());
        }
        catch (err) {
            console.error(`[clash] model "${modelId}": getItemsIdsWithGeometry failed`, err);
            groups.push(group);
            continue;
        }
        if (!ids?.length) {
            groups.push(group);
            continue;
        }
        rep.elements = ids.length;
        if (allowedIds && allowedIds !== "ALL") {
            ids = ids.filter((id) => allowedIds.has(id));
            if (!ids.length) {
                groups.push(group);
                continue;
            }
        }
        const worldBoxes = await (0, world_box_1.getElementWorldBoxes)(model, ids, modelId);
        rep.skippedNoBox = ids.length - worldBoxes.length;
        if (!worldBoxes.length) {
            console.warn(`[clash] model "${modelId}": 0 boxes for ${ids.length} id(s)`);
            groups.push(group);
            continue;
        }
        const metaMap = await prefetchMeta(model, ids);
        for (const wb of worldBoxes) {
            if (opts.signal?.cancelled) {
                groups.push(group);
                return finish();
            }
            const size = new THREE.Vector3();
            wb.box.getSize(size);
            if (size.x * size.y * size.z > 1e9) {
                rep.skippedHuge++;
                continue;
            }
            if (size.x < 1e-6 && size.y < 1e-6 && size.z < 1e-6) {
                rep.skippedEmpty++;
                continue;
            }
            const meta = metaMap.get(wb.id) ?? { name: `#${wb.id}`, category: "Unknown" };
            let tris = null;
            if (wantGeometry) {
                try {
                    const extracted = (0, geometry_1.getElementTriangles)(model.object, wb.id);
                    if (extracted && extracted.length)
                        tris = extracted;
                }
                catch { /* */ }
            }
            if (wantGeometry && (!tris || !tris.length)) {
                hasAllTriangles = false;
                rep.boxOnly++;
                if ((0, geometry_1.getNoTriangleReason)(model.object, wb.id) === "too-many")
                    rep.boxOnlyTooComplex++;
            }
            else if (wantGeometry)
                rep.withTriangles++;
            rep.tested++;
            const idx = allItems.length;
            if (opts.useSides)
                sides[idx] = sideFlag(input.sideA, input.sideB, wb.id);
            group.push(idx);
            allItems.push({
                modelId,
                localId: wb.id,
                name: meta.name,
                category: meta.category,
                box: wb.box.clone(),
                tris,
            });
        }
        groups.push(group);
        console.log(`[clash] model "${modelId}": ${group.length} item(s) collected`);
    }
    // Native authored elements (they live outside the IFC models).
    if (opts.authored) {
        const au = opts.authored;
        const rep = {
            modelId: clash_authored_1.AUTHORED_MODEL_ID, elements: 0, tested: 0, withTriangles: 0, boxOnly: 0, boxOnlyTooComplex: 0,
            skippedNoBox: 0, skippedHuge: 0, skippedEmpty: 0,
        };
        modelReports.push(rep);
        const group = [];
        const has = (set, id) => set === "ALL" || (set instanceof Set && set.has(id));
        for (const src of (0, clash_authored_1.collectAuthoredSources)()) {
            rep.elements++;
            if (!has(au.allowed, src.elementId))
                continue;
            const idx = allItems.length;
            group.push(idx);
            if (opts.useSides)
                sides[idx] = (has(au.sideA, src.elementId) ? 1 : 0) | (has(au.sideB, src.elementId) ? 2 : 0);
            rep.tested++;
            rep.withTriangles++;
            allItems.push({
                modelId: clash_authored_1.AUTHORED_MODEL_ID, localId: src.localId, name: src.name, category: src.category,
                box: src.box, tris: wantGeometry ? src.tris : null,
            });
        }
        groups.push(group);
    }
    return finish();
}
async function runClashEngine(inputs, opts = {}) {
    const rules = { ...clash_core_1.DEFAULT_CLASH_RULES, ...(opts.rules ?? {}) };
    const method = opts.method ?? "hard-triangle";
    const allowSelfPairs = opts.allowSelfPairs ?? true;
    const onProg = opts.onProgress ?? (() => { });
    console.log(`[clash] method="${method}" · allowSelfPairs=${allowSelfPairs} · main-thread`);
    const { items, groups, sides } = await collectItems(inputs, opts);
    if (!items.length) {
        console.error("[clash] ABORT: no items collected");
        onProg({ phase: "done", current: 0, total: 0, found: 0 });
        return [];
    }
    return (0, clash_core_1.runClashCore)(items, {
        rules,
        method,
        groups,
        selfPairs: allowSelfPairs,
        ...(sides ? { sides } : {}),
        onProgress: onProg,
        shouldCancel: () => opts.signal?.cancelled === true,
        yield: () => new Promise((r) => setTimeout(r, 0)),
    });
}
