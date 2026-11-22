"use strict";
/**
 * Production Revision Tracking Data Model & Store.
 *
 * Tracks project and sheet revision sequences, issued dates, approval status,
 * delta element changes, and cloud associations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadRevisionStore = loadRevisionStore;
exports.saveRevisionStore = saveRevisionStore;
exports.onRevisionStoreChange = onRevisionStoreChange;
exports.listAllRevisions = listAllRevisions;
exports.listAllClouds = listAllClouds;
exports.getSheetRevisions = getSheetRevisions;
exports.addRevisionRecord = addRevisionRecord;
exports.updateRevisionRecord = updateRevisionRecord;
exports.removeRevisionRecord = removeRevisionRecord;
exports.addRevisionCloudDef = addRevisionCloudDef;
exports.listCloudsForView = listCloudsForView;
exports.listCloudsVisibleInView = listCloudsVisibleInView;
exports.removeCloudDef = removeCloudDef;
exports.serializeRevisions = serializeRevisions;
exports.replaceAllRevisions = replaceAllRevisions;
const STORAGE_KEY_REVS = "obs.revisions.records.v2";
const STORAGE_KEY_CLOUDS = "obs.revisions.clouds.v2";
let currentRevisions = [];
let currentClouds = [];
/**
 * True once the store has been read (from localStorage or a project file).
 * The old `if (!currentRevisions.length) load()` check re-read localStorage
 * after every intentional emptying — including a project restore with zero
 * revisions — resurrecting stale data. The flag makes "empty" a real state.
 */
let loaded = false;
const changeListeners = new Set();
function loadRevisionStore() {
    try {
        const rawR = localStorage.getItem(STORAGE_KEY_REVS);
        const rawC = localStorage.getItem(STORAGE_KEY_CLOUDS);
        currentRevisions = rawR ? JSON.parse(rawR) : [];
        currentClouds = rawC ? JSON.parse(rawC) : [];
    }
    catch {
        currentRevisions = [];
        currentClouds = [];
    }
    loaded = true;
}
function saveRevisionStore() {
    try {
        localStorage.setItem(STORAGE_KEY_REVS, JSON.stringify(currentRevisions));
        localStorage.setItem(STORAGE_KEY_CLOUDS, JSON.stringify(currentClouds));
    }
    catch {
        /* storage quota fallback */
    }
    changeListeners.forEach((fn) => {
        try {
            fn();
        }
        catch { /* ignore */ }
    });
}
function onRevisionStoreChange(cb) {
    changeListeners.add(cb);
    return () => changeListeners.delete(cb);
}
function listAllRevisions() {
    if (!loaded)
        loadRevisionStore();
    return currentRevisions.slice();
}
function listAllClouds() {
    if (!loaded)
        loadRevisionStore();
    return currentClouds.slice();
}
function getSheetRevisions(sheetId) {
    return listAllRevisions().filter((r) => r.visible !== false && (!r.sheetIds.length || r.sheetIds.includes(sheetId)));
}
function addRevisionRecord(data) {
    const existing = listAllRevisions();
    const nextSeq = existing.length > 0 ? Math.max(...existing.map((e) => e.sequence)) + 1 : 1;
    const rec = {
        id: `rev-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        sequence: data.sequence ?? nextSeq,
        sequenceLabel: data.sequenceLabel ?? `Rev ${String(data.sequence ?? nextSeq).padStart(2, "0")}`,
        description: data.description || "General revisions",
        date: data.date || new Date().toISOString().slice(0, 10),
        issuedTo: data.issuedTo || "",
        issuedBy: data.issuedBy || "Author",
        checkedBy: data.checkedBy || "",
        approvedBy: data.approvedBy || "",
        status: data.status || "draft",
        sheetIds: data.sheetIds || [],
        elementIds: data.elementIds || [],
        visible: data.visible ?? true,
    };
    currentRevisions.push(rec);
    saveRevisionStore();
    return rec;
}
function updateRevisionRecord(id, patch) {
    const target = currentRevisions.find((r) => r.id === id);
    if (!target)
        return;
    Object.assign(target, patch);
    saveRevisionStore();
}
function removeRevisionRecord(id) {
    currentRevisions = currentRevisions.filter((r) => r.id !== id);
    currentClouds = currentClouds.filter((c) => c.revisionId !== id);
    saveRevisionStore();
}
function addRevisionCloudDef(cloud) {
    const c = {
        ...cloud,
        id: `cloud-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    };
    currentClouds.push(c);
    saveRevisionStore();
    return c;
}
function listCloudsForView(viewId) {
    if (!loaded)
        loadRevisionStore();
    return currentClouds.filter((c) => c.viewId === viewId);
}
/**
 * Clouds that draw in a view: clouds bound to that view, plus unassigned
 * clouds (viewId null — placed before any view was active, e.g. from the
 * plan-view polygon capture). A cloud bound to a *different* view stays
 * hidden here.
 */
function listCloudsVisibleInView(viewId) {
    if (!loaded)
        loadRevisionStore();
    return currentClouds.filter((c) => c.viewId === viewId || c.viewId === null);
}
function removeCloudDef(id) {
    currentClouds = currentClouds.filter((c) => c.id !== id);
    saveRevisionStore();
}
// ---------- Project persistence ----------
//
// Revisions and clouds travel with the project file (ProjectDoc.
// documentation) so a project moved to another machine keeps its revision
// history. The caller (documentation-persistence) validates the snapshot;
// replaceAll trusts already-normalized data but still drops non-objects.
/** Plain-data snapshot for the project file. */
function serializeRevisions() {
    if (!loaded)
        loadRevisionStore();
    return {
        revisions: JSON.parse(JSON.stringify(currentRevisions)),
        clouds: JSON.parse(JSON.stringify(currentClouds)),
    };
}
/** Replace store contents from a project-file snapshot. Never throws. */
function replaceAllRevisions(revisions, clouds) {
    const revs = Array.isArray(revisions) ? revisions.filter((r) => r && typeof r === "object") : [];
    const cls = Array.isArray(clouds) ? clouds.filter((c) => c && typeof c === "object") : [];
    currentRevisions = JSON.parse(JSON.stringify(revs));
    currentClouds = JSON.parse(JSON.stringify(cls));
    loaded = true;
    saveRevisionStore();
    return { revisions: currentRevisions.length, clouds: currentClouds.length };
}
