"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AUTHORED_MODEL_ID = void 0;
exports.authoredLocalId = authoredLocalId;
exports.authoredElementId = authoredElementId;
exports.meshWorldTriangles = meshWorldTriangles;
exports.boxOfTriangles = boxOfTriangles;
exports.collectAuthoredSources = collectAuthoredSources;
/**
 * Native (authored) elements as clash items. The authoring tools keep their
 * elements as Three.js meshes in one group, outside the IFC fragment models,
 * so the engine needs this adapter to see them.
 */
const THREE = require("three");
const context_1 = require("../core/context");
/** Pseudo model id used in clash results for authored elements. */
exports.AUTHORED_MODEL_ID = "__authored__";
const idToLocal = new Map();
const localToId = new Map();
/** Stable numeric id for an authored element id (clash refs use numbers). */
function authoredLocalId(elementId) {
    let n = idToLocal.get(elementId);
    if (n == null) {
        n = idToLocal.size + 1;
        idToLocal.set(elementId, n);
        localToId.set(n, elementId);
    }
    return n;
}
function authoredElementId(localId) { return localToId.get(localId); }
/** Triangles of one mesh in world space. Skips lines/points and degenerate meshes. */
function meshWorldTriangles(mesh) {
    const geo = mesh.geometry;
    const pos = geo?.attributes?.position;
    if (!pos)
        return [];
    const idx = geo.index;
    const m = mesh.matrixWorld;
    const v = new THREE.Vector3();
    const out = [];
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < count; i += 3) {
        const t = new Float32Array(9);
        for (let k = 0; k < 3; k++) {
            const vi = idx ? idx.getX(i + k) : i + k;
            v.fromBufferAttribute(pos, vi).applyMatrix4(m);
            t[k * 3] = v.x;
            t[k * 3 + 1] = v.y;
            t[k * 3 + 2] = v.z;
        }
        out.push(t);
    }
    return out;
}
function boxOfTriangles(tris) {
    const b = new THREE.Box3();
    for (const t of tris)
        for (let k = 0; k < 3; k++)
            b.expandByPoint(new THREE.Vector3(t[k * 3], t[k * 3 + 1], t[k * 3 + 2]));
    return b;
}
/** Every authored element that currently has solid geometry in the scene. */
function collectAuthoredSources() {
    const auth = context_1.ctx.features?.authoring;
    if (!auth?.getElements || !auth?.getAuthoredGroup)
        return [];
    const group = auth.getAuthoredGroup();
    const elements = auth.getElements() ?? [];
    const byId = new Map(elements.map((e) => [e.id, e]));
    try {
        group.updateMatrixWorld(true);
    }
    catch { /* */ }
    const perElement = new Map();
    group.traverse((o) => {
        if (!o?.isMesh)
            return;
        let id = null;
        for (let p = o; p && !id; p = p.parent)
            if (p.userData?.elementId)
                id = String(p.userData.elementId);
        if (!id || !byId.has(id))
            return;
        const tris = meshWorldTriangles(o);
        if (!tris.length)
            return;
        const list = perElement.get(id) ?? [];
        for (const t of tris)
            list.push(t);
        perElement.set(id, list);
    });
    const out = [];
    for (const [id, tris] of perElement) {
        const el = byId.get(id);
        const box = boxOfTriangles(tris);
        if (box.isEmpty())
            continue;
        out.push({ elementId: id, localId: authoredLocalId(id), name: el.name || `${el.type} ${id}`, category: `NATIVE_${String(el.type).toLowerCase()}`, box, tris });
    }
    return out;
}
