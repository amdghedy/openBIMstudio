"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWorkPlane = createWorkPlane;
exports.setActiveWorkPlane = setActiveWorkPlane;
exports.setWorkPlaneRotation = setWorkPlaneRotation;
exports.getActiveWorkPlane = getActiveWorkPlane;
exports.getWorkPlane = getWorkPlane;
exports.listWorkPlanes = listWorkPlanes;
exports.removeWorkPlane = removeWorkPlane;
exports.distanceToWorkPlane = distanceToWorkPlane;
exports.projectWorldPoint = projectWorldPoint;
exports.projectOntoWorkPlane = projectOntoWorkPlane;
exports.serializeWorkPlanes = serializeWorkPlanes;
exports.restoreWorkPlanes = restoreWorkPlanes;
exports.setupWorkPlanes = setupWorkPlanes;
const planes = new Map();
let activeId = null;
let idCounter = 0;
function vectorLength(v) {
    return Math.hypot(v[0], v[1], v[2]);
}
function normalizeVector(v, label) {
    if (!Array.isArray(v) || v.length !== 3 || v.some((n) => !Number.isFinite(n))) {
        throw new Error(label + " must contain three finite values");
    }
    const length = vectorLength(v);
    if (length < 1e-10)
        throw new Error(label + " cannot be a zero vector");
    return [v[0] / length, v[1] / length, v[2] / length];
}
function validateOrigin(origin) {
    if (!Array.isArray(origin) || origin.length !== 3 || origin.some((n) => !Number.isFinite(n))) {
        throw new Error("Work plane origin must contain three finite coordinates");
    }
    return [...origin];
}
function createWorkPlane(name, origin, normal = [0, 1, 0], face) {
    const cleanName = String(name ?? "").trim();
    if (!cleanName)
        throw new Error("Work plane name is required");
    const plane = {
        id: "wp-" + (++idCounter),
        name: cleanName,
        origin: validateOrigin(origin),
        normal: normalizeVector(normal, "Work plane normal"),
        rotation: 0,
        active: false,
        ...(face ? { face: JSON.parse(JSON.stringify(face)) } : {}),
    };
    planes.set(plane.id, plane);
    setActiveWorkPlane(plane.id);
    return plane;
}
function setActiveWorkPlane(id) {
    const plane = planes.get(id);
    if (!plane)
        return false;
    if (activeId) {
        const old = planes.get(activeId);
        if (old)
            old.active = false;
    }
    plane.active = true;
    activeId = id;
    if (Math.abs(plane.normal[1]) > 0.999999) {
        try {
            window.__obsSnapping?.setWorkPlaneY?.(plane.origin[1]);
        }
        catch { /* */ }
    }
    try {
        window.dispatchEvent(new CustomEvent("obs:work-plane-changed", { detail: { id, plane } }));
    }
    catch { /* non-browser test */ }
    return true;
}
function setWorkPlaneRotation(id, rotation) {
    const plane = planes.get(id);
    if (!plane || !Number.isFinite(rotation))
        return false;
    plane.rotation = rotation;
    try {
        window.dispatchEvent(new CustomEvent("obs:work-plane-changed", { detail: { id, plane } }));
    }
    catch { /* */ }
    return true;
}
function getActiveWorkPlane() {
    return activeId ? planes.get(activeId) ?? null : null;
}
function getWorkPlane(id) {
    return planes.get(id) ?? null;
}
function listWorkPlanes() {
    return [...planes.values()].map((plane) => ({ ...plane, origin: [...plane.origin], normal: [...plane.normal] }));
}
function removeWorkPlane(id) {
    if (id === activeId) {
        const plane = planes.get(activeId);
        if (plane)
            plane.active = false;
        activeId = null;
        try {
            window.__obsSnapping?.setWorkPlaneY?.(0);
        }
        catch { /* */ }
    }
    planes.delete(id);
    try {
        window.dispatchEvent(new CustomEvent("obs:work-plane-changed", { detail: { id: activeId, plane: getActiveWorkPlane() } }));
    }
    catch { /* */ }
}
/** Return the signed world-space distance from a point to this plane. */
function distanceToWorkPlane(point, plane = getActiveWorkPlane()) {
    if (!plane)
        return null;
    const dx = point[0] - plane.origin[0];
    const dy = point[1] - plane.origin[1];
    const dz = point[2] - plane.origin[2];
    return dx * plane.normal[0] + dy * plane.normal[1] + dz * plane.normal[2];
}
/** Project a world point onto the active work plane. */
function projectWorldPoint(point, plane = getActiveWorkPlane()) {
    if (!plane)
        return [...point];
    const distance = distanceToWorkPlane(point, plane) ?? 0;
    return [
        point[0] - plane.normal[0] * distance,
        point[1] - plane.normal[1] * distance,
        point[2] - plane.normal[2] * distance,
    ];
}
/** Plane-local 2D coordinates (U,V), useful for planar sketch and dimension tools. */
function projectOntoWorkPlane(worldX, worldY, worldZ) {
    const plane = getActiveWorkPlane();
    if (!plane)
        return [worldX, worldZ];
    const [nx, ny, nz] = plane.normal;
    const reference = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = normalizeVector([
        reference[1] * nz - reference[2] * ny,
        reference[2] * nx - reference[0] * nz,
        reference[0] * ny - reference[1] * nx,
    ], "Work plane U axis");
    let v = [
        ny * u[2] - nz * u[1],
        nz * u[0] - nx * u[2],
        nx * u[1] - ny * u[0],
    ];
    const c = Math.cos(plane.rotation), si = Math.sin(plane.rotation);
    const rotatedU = [
        u[0] * c + v[0] * si,
        u[1] * c + v[1] * si,
        u[2] * c + v[2] * si,
    ];
    v = [
        -u[0] * si + v[0] * c,
        -u[1] * si + v[1] * c,
        -u[2] * si + v[2] * c,
    ];
    const relative = [worldX - plane.origin[0], worldY - plane.origin[1], worldZ - plane.origin[2]];
    return [
        relative[0] * rotatedU[0] + relative[1] * rotatedU[1] + relative[2] * rotatedU[2],
        relative[0] * v[0] + relative[1] * v[1] + relative[2] * v[2],
    ];
}
function serializeWorkPlanes() {
    return {
        schemaVersion: 1,
        activeId,
        planes: listWorkPlanes().map(({ active: _active, ...plane }) => plane),
    };
}
function restoreWorkPlanes(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.planes)) {
        throw new Error("Unsupported work plane snapshot");
    }
    planes.clear();
    activeId = null;
    for (const entry of snapshot.planes) {
        if (!entry?.id || !entry.name)
            throw new Error("Invalid saved work plane");
        const restored = {
            ...entry,
            origin: validateOrigin(entry.origin),
            normal: normalizeVector(entry.normal, "Saved work plane normal"),
            rotation: Number.isFinite(entry.rotation) ? entry.rotation : 0,
            active: false,
        };
        planes.set(restored.id, restored);
        const match = /^wp-(\d+)$/.exec(restored.id);
        if (match)
            idCounter = Math.max(idCounter, Number(match[1]));
    }
    if (snapshot.activeId)
        setActiveWorkPlane(snapshot.activeId);
    else {
        try {
            window.__obsSnapping?.setWorkPlaneY?.(0);
        }
        catch { /* */ }
    }
}
let installed = false;
function setupWorkPlanes() {
    if (installed)
        return;
    installed = true;
    console.log("[work-planes] ready — arbitrary sketch planes and picked-face references available.");
}
