"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.snapping = void 0;
exports.toggleSnapSettings = toggleSnapSettings;
exports.isSnapSettingsVisible = isSnapSettingsVisible;
exports.setSnapSettingsVisible = setSnapSettingsVisible;
/**
 * Object snap system (professional drafting / BIM conventions).
 *
 * Each snap type has:
 *   - A priority level. Higher priority wins over a closer low-priority
 *     snap — same as BIM. Endpoint (100) beats Nearest (55) even if
 *     Nearest is a few pixels closer.
 *   - A distinctive SVG marker drawn at the snapped point.
 *   - A short label shown next to the marker.
 *
 * Snaps are gated by the current tool — dims prefer endpoints/corners/faces;
 * wall placement prefers grid/endpoint/midpoint.
 */
const THREE = require("three");
const context_1 = require("../core/context");
const cad_underlay_snap_1 = require("./cad-underlay-snap");
const magnetic_1 = require("../modules/snapping/magnetic");
/** Priority table — higher wins. Matches BIM's hierarchy. */
const SNAP_PRIORITY = {
    endpoint: 100,
    intersection: 95,
    connector: 93,
    corner: 92,
    midpoint: 90,
    center: 85,
    perpendicular: 80,
    tangent: 75,
    quadrant: 70,
    vertex: 65,
    face: 60,
    nearest: 55,
    parallel: 45,
    extension: 40,
    grid: 15,
};
const ALL_TYPES = [
    "endpoint", "intersection", "corner", "midpoint", "center",
    "perpendicular", "tangent", "quadrant", "vertex", "face",
    "nearest", "parallel", "extension", "grid", "connector",
];
/* BIM-style SVG markers — 32×32 viewBox. */
const SVG_MARKER = {
    endpoint: `<rect x="9" y="9" width="14" height="14" fill="#F59E0B" stroke="#0B0D12" stroke-width="2"/>`,
    intersection: `<path d="M6 6 L26 26 M26 6 L6 26" stroke="#EF4444" stroke-width="3" fill="none" stroke-linecap="round"/>`,
    corner: `<path d="M8 8 L8 24 L24 24" stroke="#FBBF24" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<circle cx="8" cy="8" r="2.5" fill="#FBBF24"/>`,
    midpoint: `<polygon points="16,8 26,24 6,24" fill="#22C55E" stroke="#0B0D12" stroke-width="2" stroke-linejoin="round"/>`,
    center: `<circle cx="16" cy="16" r="9" fill="none" stroke="#38BDF8" stroke-width="2.5"/>` +
        `<circle cx="16" cy="16" r="2.4" fill="#38BDF8"/>`,
    perpendicular: `<path d="M8 8 L8 26 L26 26" stroke="#C084FC" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<rect x="8" y="20" width="6" height="6" fill="#C084FC"/>`,
    tangent: `<circle cx="18" cy="18" r="8" fill="none" stroke="#F472B6" stroke-width="2.5"/>` +
        `<line x1="3" y1="10" x2="29" y2="10" stroke="#F472B6" stroke-width="2.5" stroke-linecap="round"/>`,
    quadrant: `<circle cx="16" cy="16" r="9" fill="none" stroke="#34D399" stroke-width="2"/>` +
        `<circle cx="16" cy="7" r="2" fill="#34D399"/>` +
        `<circle cx="25" cy="16" r="2" fill="#34D399"/>` +
        `<circle cx="16" cy="25" r="2" fill="#34D399"/>` +
        `<circle cx="7" cy="16" r="2" fill="#34D399"/>`,
    vertex: `<rect x="11" y="11" width="10" height="10" fill="#38BDF8" stroke="#0B0D12" stroke-width="2" transform="rotate(45 16 16)"/>`,
    face: `<rect x="8" y="8" width="16" height="16" fill="none" stroke="#38BDF8" stroke-width="2"/>` +
        `<circle cx="16" cy="16" r="2.6" fill="#38BDF8"/>`,
    nearest: `<circle cx="16" cy="16" r="4" fill="#F59E0B"/>` +
        `<circle cx="16" cy="16" r="9" fill="none" stroke="#F59E0B" stroke-width="1.5" opacity="0.55"/>`,
    parallel: `<path d="M8 12 H24 M8 20 H24" stroke="#A78BFA" stroke-width="2.5" stroke-linecap="round"/>`,
    extension: `<path d="M4 16 H28 M22 10 L28 16 L22 22" stroke="#F472B6" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    connector: `<circle cx="16" cy="16" r="8" fill="none" stroke="#FB923C" stroke-width="2.5"/>` +
        `<path d="M16 4 V10 M16 22 V28 M4 16 H10 M22 16 H28" stroke="#FB923C" stroke-width="2.5" stroke-linecap="round"/>` +
        `<circle cx="16" cy="16" r="2.4" fill="#FB923C"/>`,
    grid: `<path d="M6 16 H26 M16 6 V26" stroke="#38BDF8" stroke-width="2" stroke-linecap="round"/>` +
        `<circle cx="16" cy="16" r="3" fill="none" stroke="#38BDF8" stroke-width="1.5"/>`,
};
const SVG_LABEL = {
    endpoint: "End",
    intersection: "Int",
    corner: "Corner",
    midpoint: "Mid",
    center: "Cen",
    perpendicular: "Perp",
    tangent: "Tan",
    quadrant: "Quad",
    vertex: "Vtx",
    face: "Face",
    nearest: "Near",
    parallel: "Par",
    extension: "Ext",
    connector: "Conn",
    grid: "Grid",
};
function getAuthoredSafe() {
    try {
        const mod = context_1.ctx.features.authoring;
        if (mod?.getElements)
            return mod.getElements();
    }
    catch { /* */ }
    try {
        const auth = context_1.ctx.features?.authoring;
        if (auth?.getElements)
            return auth.getElements();
    }
    catch { /* */ }
    return [];
}
class SnapManager {
    enabled = true;
    types = new Set(ALL_TYPES);
    priorities = { ...SNAP_PRIORITY };
    gridSize = 0.1;
    pixelTolerance = 20;
    workPlaneY = 0;
    orthoOn = false;
    orthoBase = null;
    orthoAxis = null;
    /** Design spec §4.3 — Alt-hold suspension, Tab-pinned candidate,
     *  hysteresis lock, and the magnetic draw context (chain base). */
    suspended = false;
    pinned = null;
    lastCandidates = [];
    cycleIndex = -1;
    lastPicked = null;
    drawBase = null;
    overlay = null;
    marker = null;
    label = null;
    lastPointer = { x: 0, y: 0 };
    setEnabled(on) {
        this.enabled = on;
        if (!on)
            this.hideIndicator();
    }
    isEnabled() { return this.enabled; }
    /** Hold-Alt temporary suspension (§4.3) — separate from the ON/OFF toggle. */
    setSuspended(on) {
        this.suspended = on;
        if (on) {
            this.hideIndicator();
            this.pinned = null;
            this.cycleIndex = -1;
        }
    }
    isSuspended() { return this.suspended; }
    /** Draw context for magnetic snaps: the active chain base point. */
    setDrawContext(base) {
        this.drawBase = base ? base.clone() : null;
    }
    getPinned() { return this.pinned; }
    getLastCandidates() { return this.lastCandidates; }
    /**
     * Tab cycling (§4.3): step through the previous query's ranked
     * candidates and pin the selection until the pointer moves off it.
     * Returns a short human label, or null when there is nothing to cycle.
     */
    cycleNext(step) {
        const list = this.lastCandidates;
        if (list.length < 2)
            return null;
        this.cycleIndex = ((this.cycleIndex + step) % list.length + list.length) % list.length;
        this.pinned = list[this.cycleIndex];
        this.showIndicator(this.pinned);
        let name = "";
        try {
            const el = this.pinned.elementId
                ? context_1.ctx.features.authoring?.getElementById?.(this.pinned.elementId)
                : null;
            if (el?.name)
                name = el.name;
        }
        catch { /* */ }
        return `${SVG_LABEL[this.pinned.type]}${name ? " · " + name : ""}`;
    }
    setGridSize(m) { this.gridSize = Math.max(0.001, m); }
    getGridSize() { return this.gridSize; }
    setPixelTolerance(px) { this.pixelTolerance = Math.max(4, px); }
    getPixelTolerance() { return this.pixelTolerance; }
    setWorkPlaneY(y) { this.workPlaneY = y; }
    getWorkPlaneY() { return this.workPlaneY; }
    setTypes(types) { this.types = new Set(types.filter((t) => ALL_TYPES.includes(t))); }
    getPriorities() { return { ...this.priorities }; }
    setPriority(type, priority) {
        if (!ALL_TYPES.includes(type) || !Number.isFinite(priority))
            return;
        this.priorities[type] = Math.max(0, Math.min(1000, Math.round(priority)));
    }
    setPriorities(priorities) {
        for (const type of ALL_TYPES) {
            const value = priorities[type];
            if (typeof value === "number" && Number.isFinite(value))
                this.setPriority(type, value);
        }
    }
    getTypes() { return [...this.types]; }
    getAllTypes() { return [...ALL_TYPES]; }
    toggleType(t, on) {
        const enable = on ?? !this.types.has(t);
        if (enable)
            this.types.add(t);
        else
            this.types.delete(t);
    }
    enableAllTypes() { this.types = new Set(ALL_TYPES); }
    disableAllTypes() { this.types.clear(); }
    setOrtho(on, base, axis = null) {
        this.orthoOn = on;
        this.orthoBase = base ? base.clone() : null;
        this.orthoAxis = axis;
    }
    clearOrtho() {
        this.orthoOn = false;
        this.orthoBase = null;
        this.orthoAxis = null;
    }
    isOrtho() { return this.orthoOn; }
    ensureOverlay() {
        if (this.overlay)
            return;
        try {
            const host = context_1.ctx.rightHost;
            if (!host)
                return;
            this.overlay = document.createElement("div");
            this.overlay.style.cssText =
                "position:absolute;inset:0;pointer-events:none;z-index:22;overflow:hidden";
            this.marker = document.createElement("div");
            this.marker.style.cssText =
                "position:absolute;width:32px;height:32px;transform:translate(-50%,-50%);display:none";
            this.label = document.createElement("div");
            this.label.style.cssText =
                "position:absolute;transform:translate(-50%,calc(-100% - 18px));" +
                    "font:700 10px system-ui,sans-serif;color:#0B0D12;background:#FBBF24;" +
                    "padding:2px 7px;border-radius:3px;white-space:nowrap;display:none;" +
                    "box-shadow:0 2px 6px rgba(0,0,0,.35);letter-spacing:.2px";
            this.overlay.append(this.marker, this.label);
            host.appendChild(this.overlay);
        }
        catch (e) {
            console.warn("[snap] overlay init failed", e);
        }
    }
    showIndicator(result) {
        try {
            this.ensureOverlay();
            if (!result || !this.marker || !this.label || !context_1.ctx.world?.camera?.three) {
                if (this.marker)
                    this.marker.style.display = "none";
                if (this.label)
                    this.label.style.display = "none";
                return;
            }
            const cam = context_1.ctx.world.camera.three;
            const p = result.point.clone().project(cam);
            const rect = context_1.ctx.rightHost.getBoundingClientRect();
            const x = (p.x * 0.5 + 0.5) * rect.width;
            const y = (-p.y * 0.5 + 0.5) * rect.height;
            this.marker.innerHTML = `<svg width="32" height="32" viewBox="0 0 32 32">${SVG_MARKER[result.type]}</svg>`;
            this.marker.style.left = `${x}px`;
            this.marker.style.top = `${y}px`;
            this.marker.style.display = "block";
            this.label.textContent = SVG_LABEL[result.type];
            // Match label color to marker color
            const colorByType = {
                endpoint: "#F59E0B",
                intersection: "#EF4444",
                corner: "#FBBF24",
                midpoint: "#22C55E",
                center: "#38BDF8",
                perpendicular: "#C084FC",
                tangent: "#F472B6",
                quadrant: "#34D399",
                vertex: "#38BDF8",
                face: "#38BDF8",
                nearest: "#F59E0B",
                parallel: "#A78BFA",
                extension: "#F472B6",
                connector: "#FB923C",
                grid: "#38BDF8",
            };
            this.label.style.background = colorByType[result.type] ?? "#FBBF24";
            this.label.style.left = `${x}px`;
            this.label.style.top = `${y}px`;
            this.label.style.display = "block";
        }
        catch { /* never crash the modeling loop */ }
    }
    hideIndicator() { this.showIndicator(null); }
    /** Screen-space tolerance → world metres at the cursor's depth (§4.2). */
    worldTolerance(cursorWorld, rect) {
        try {
            const cam = context_1.ctx.world.camera.three;
            if (cam.isOrthographicCamera) {
                const h = (cam.top - cam.bottom) / (cam.zoom || 1);
                return (h / Math.max(1, rect.height)) * this.pixelTolerance;
            }
            const dist = Math.max(0.01, cam.position.distanceTo(cursorWorld));
            const fov = ((cam.fov ?? 50) * Math.PI) / 180;
            return (0, magnetic_1.worldPerPixel)(dist, fov, rect.height) * this.pixelTolerance;
        }
        catch {
            return 0.25;
        }
    }
    sameCandidate(a, b) {
        return a.type === b.type && a.elementId === b.elementId &&
            a.point.distanceToSquared(b.point) < 1e-6;
    }
    /**
     * Best snap for a pointer event. Priority-aware, hysteresis-stabilised
     * and Tab-pinnable. Never throws.
     */
    async query(e, cursorWorld) {
        const all = await this.queryAll(e, cursorWorld);
        if (!all.length) {
            this.lastPicked = null;
            return null;
        }
        // A Tab-pinned candidate keeps winning while it stays valid (§4.3).
        if (this.pinned) {
            const again = all.find((c) => this.sameCandidate(c, this.pinned));
            if (again)
                return again;
            this.pinned = null;
            this.cycleIndex = -1;
        }
        // Hysteresis (spec 2B.2): keep the previous target while it stays
        // within tolerance × 1.15 — prevents endpoint/midpoint flicker.
        let picked = null;
        if (this.lastPicked) {
            const again = all.find((c) => this.sameCandidate(c, this.lastPicked));
            if (again && again.screenDist <= this.pixelTolerance * 1.15)
                picked = again;
        }
        if (!picked)
            picked = all[0];
        this.lastPicked = picked;
        return picked;
    }
    /**
     * All candidates within tolerance, priority-sorted (§4.2–4.3). This is
     * the single producer every snap type flows through.
     */
    async queryAll(e, cursorWorld) {
        try {
            if (!this.enabled || this.suspended)
                return [];
            this.lastPointer = { x: e.clientX, y: e.clientY };
            const host = context_1.ctx.rightHost;
            if (!host || !context_1.ctx.world?.camera?.three)
                return [];
            const rect = host.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1)
                return [];
            const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
            const candidates = [];
            const add = (point, type, elementId, refKind) => {
                const px = this.screenDistToPointer(point, rect, e.clientX, e.clientY);
                if (px <= this.pixelTolerance) {
                    candidates.push({ point: point.clone(), type, screenDist: px, elementId, refKind });
                }
            };
            const authored = getAuthoredSafe();
            // Grid snap
            if (this.types.has("grid") && cursorWorld) {
                const g = this.gridSize;
                const gp = new THREE.Vector3(Math.round(cursorWorld.x / g) * g, this.workPlaneY, Math.round(cursorWorld.z / g) * g);
                add(gp, "grid");
            }
            // Authored element snaps (endpoint, midpoint, center, corner, face,
            // quadrant, vertex) — with element identity for relationship binding.
            const tolWorld = cursorWorld ? this.worldTolerance(cursorWorld, rect) : 0.25;
            for (const el of authored) {
                this.collectAuthoredSnaps(el, add, authored, cursorWorld, tolWorld);
            }
            // Magnetic alignment (Design spec §5): while drawing from a base
            // point, detect perpendicular feet / parallel companions / crossings
            // on nearby linear elements and snap the preview to them.
            if (this.drawBase && cursorWorld) {
                const baseXZ = [this.drawBase.x, this.drawBase.z];
                const curXZ = [cursorWorld.x, cursorWorld.z];
                const y = this.drawBase.y || this.workPlaneY;
                const near = [];
                for (const el of authored) {
                    if (!el.params.start || !el.params.end)
                        continue;
                    const a = el.params.start;
                    const b = el.params.end;
                    if (!(0, magnetic_1.aabbNearCursor)(curXZ, tolWorld, [Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]))
                        continue;
                    near.push({ el, a, b });
                }
                if (this.types.has("perpendicular")) {
                    for (const { el, a, b } of near) {
                        const foot = (0, magnetic_1.perpendicularFoot)(baseXZ, a, b);
                        if (foot && (0, magnetic_1.dist2)(foot, curXZ) <= Math.pow(tolWorld * 2, 2)) {
                            add(new THREE.Vector3(foot[0], y, foot[1]), "perpendicular", el.id, "perpendicular");
                        }
                    }
                }
                if (this.types.has("parallel")) {
                    for (const { el, a, b } of near) {
                        const d = (0, magnetic_1.segDir)(a, b);
                        if (!d)
                            continue;
                        const pp = (0, magnetic_1.parallelPoint)(baseXZ, d, curXZ);
                        if ((0, magnetic_1.dist2)(pp, curXZ) <= Math.pow(tolWorld, 2)) {
                            add(new THREE.Vector3(pp[0], y, pp[1]), "parallel", el.id, "parallel");
                        }
                    }
                }
                if (this.types.has("intersection") && near.length > 1) {
                    const capped = near.slice(0, 32);
                    for (let i = 0; i < capped.length; i++) {
                        for (let j = i + 1; j < capped.length; j++) {
                            const x = (0, magnetic_1.segmentIntersection)(capped[i].a, capped[i].b, capped[j].a, capped[j].b);
                            if (x && (0, magnetic_1.dist2)(x, curXZ) <= Math.pow(tolWorld * 1.5, 2)) {
                                add(new THREE.Vector3(x[0], y, x[1]), "intersection", capped[i].el.id, "intersection");
                            }
                        }
                    }
                }
            }
            // MEP connector snapping (§4.1) — free connector origins of
            // equipment/fittings; the run that commits on them binds a
            // persistent mep-connection relationship.
            if (this.types.has("connector") && cursorWorld) {
                try {
                    const conns = window.__obsMepConnectors?.getMepConnectors?.();
                    if (Array.isArray(conns)) {
                        for (const c of conns) {
                            if (!c || c.engaged || !c.worldOrigin)
                                continue;
                            const [ox, oy, oz] = c.worldOrigin;
                            if (Math.hypot(ox - cursorWorld.x, oz - cursorWorld.z) > tolWorld * 3)
                                continue;
                            if (Math.abs(oy - cursorWorld.y) > 1.0)
                                continue;
                            add(new THREE.Vector3(ox, oy, oz), "connector", c.ownerElementId, "connector");
                        }
                    }
                }
                catch { /* connectors optional */ }
            }
            // CAD underlay snaps — endpoints, centers, midpoints from DXF underlay.
            // This enables the "trace over DWG" workflow: draw walls that snap to
            // the DWG line endpoints instead of eyeballing.
            if (cursorWorld) {
                try {
                    const { getUnderlaySnapPoints } = await Promise.resolve().then(() => require("./cad-underlay-snap"));
                    const underlayPoints = getUnderlaySnapPoints(cursorWorld.x, cursorWorld.z, 0.15);
                    for (const p of underlayPoints) {
                        const pt = new THREE.Vector3(p.x, this.workPlaneY, p.z);
                        add(pt, p.type === "center" ? "center" : p.type === "midpoint" ? "midpoint" : "endpoint");
                    }
                }
                catch { /* underlay snap module not loaded */ }
            }
            // Raycast — nearest on fragment models / ground
            if (this.types.has("nearest") || this.types.has("vertex") || this.types.has("face")) {
                try {
                    const ray = new THREE.Raycaster();
                    ray.setFromCamera(ndc, context_1.ctx.world.camera.three);
                    const targets = [];
                    if (context_1.ctx.groundPlane)
                        targets.push(context_1.ctx.groundPlane);
                    if (context_1.ctx.fragments?.list) {
                        for (const [, model] of context_1.ctx.fragments.list) {
                            if (model?.object)
                                targets.push(model.object);
                        }
                    }
                    if (targets.length) {
                        const hits = ray.intersectObjects(targets, true);
                        if (hits.length && this.types.has("nearest")) {
                            add(hits[0].point, "nearest");
                        }
                    }
                }
                catch { /* raycast can fail on disposed geometry */ }
            }
            // Ortho constraint — project candidates onto the axis
            if (this.orthoOn && this.orthoBase) {
                for (const c of candidates) {
                    const d = c.point.clone().sub(this.orthoBase);
                    if (this.orthoAxis === "x") {
                        c.point.set(this.orthoBase.x + d.x, this.orthoBase.y, this.orthoBase.z);
                    }
                    else if (this.orthoAxis === "y") {
                        c.point.set(this.orthoBase.x, this.orthoBase.y + d.y, this.orthoBase.z);
                    }
                    else if (this.orthoAxis === "z") {
                        c.point.set(this.orthoBase.x, this.orthoBase.y, this.orthoBase.z + d.z);
                    }
                    else {
                        const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
                        if (ax >= ay && ax >= az)
                            c.point.set(this.orthoBase.x + d.x, this.orthoBase.y, this.orthoBase.z);
                        else if (ay >= az)
                            c.point.set(this.orthoBase.x, this.orthoBase.y + d.y, this.orthoBase.z);
                        else
                            c.point.set(this.orthoBase.x, this.orthoBase.y, this.orthoBase.z + d.z);
                    }
                    c.screenDist = this.screenDistToPointer(c.point, rect, e.clientX, e.clientY);
                }
            }
            if (!candidates.length) {
                this.lastCandidates = [];
                return [];
            }
            // Unified priority ranking (modules/snapping/magnetic) — a
            // higher-priority snap wins over a closer lower-priority one.
            const ranked = (0, magnetic_1.rankCandidates)(candidates.map((c) => ({ ...c, kind: c.type })), this.priorities).map(({ kind: _kind, ...rest }) => rest);
            this.lastCandidates = ranked;
            if (this.cycleIndex >= ranked.length)
                this.cycleIndex = -1;
            return ranked;
        }
        catch (err) {
            console.warn("[snap] query failed", err);
            return [];
        }
    }
    collectAuthoredSnaps(el, add, all, cursorWorld, tolWorld) {
        try {
            const y = el.params.elevation ?? this.workPlaneY;
            const p = el.params;
            // Design spec §4.2 — magnetic prefilter: skip elements whose AABB
            // cannot produce a candidate near the cursor at the current zoom.
            const curXZ = cursorWorld
                ? [cursorWorld.x, cursorWorld.z]
                : null;
            const inRange = (a, b) => {
                if (!curXZ)
                    return true;
                return (0, magnetic_1.aabbNearCursor)(curXZ, tolWorld, [Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
            };
            if (p.start && p.end) {
                const a = p.start;
                const b = p.end;
                if (!inRange(a, b))
                    return;
                const va = new THREE.Vector3(a[0], y, a[1]);
                const vb = new THREE.Vector3(b[0], y, b[1]);
                const dx = b[0] - a[0];
                const dz = b[1] - a[1];
                const L = Math.hypot(dx, dz) || 1;
                const nx = -dz / L;
                const nz = dx / L;
                if (this.types.has("endpoint")) {
                    add(va, "endpoint", el.id, "endpoint");
                    add(vb, "endpoint", el.id, "endpoint");
                }
                if (this.types.has("midpoint")) {
                    add(new THREE.Vector3((a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2), "midpoint", el.id, "midpoint");
                }
                // Face — sample points along both faces of a wall-like element
                if (this.types.has("face")) {
                    const half = Math.max(0.02, (p.thickness ?? 0.2) / 2);
                    const faceTypes = new Set(["wall", "duct", "pipe", "cable-tray", "conduit", "beam", "strip"]);
                    if (faceTypes.has(el.type)) {
                        for (const t of [0.25, 0.5, 0.75]) {
                            const cx = a[0] + dx * t;
                            const cz = a[1] + dz * t;
                            add(new THREE.Vector3(cx + nx * half, y, cz + nz * half), "face", el.id, "face");
                            add(new THREE.Vector3(cx - nx * half, y, cz - nz * half), "face", el.id, "face");
                        }
                    }
                }
                // Extension — points slightly beyond each end
                if (this.types.has("extension")) {
                    const ux = dx / L;
                    const uz = dz / L;
                    add(va.clone().addScaledVector(new THREE.Vector3(ux, 0, uz), -0.5), "extension", el.id);
                    add(vb.clone().addScaledVector(new THREE.Vector3(ux, 0, uz), 0.5), "extension", el.id);
                }
            }
            if (p.point) {
                const c = new THREE.Vector3(p.point[0], y, p.point[1]);
                if (this.types.has("center") || this.types.has("endpoint"))
                    add(c, "center", el.id, "center");
                if (this.types.has("quadrant") && (p.width || p.depth)) {
                    const hw = (p.width ?? p.depth ?? 0.3) / 2;
                    const hd = (p.depth ?? p.width ?? 0.3) / 2;
                    add(new THREE.Vector3(c.x + hw, y, c.z), "quadrant", el.id);
                    add(new THREE.Vector3(c.x - hw, y, c.z), "quadrant", el.id);
                    add(new THREE.Vector3(c.x, y, c.z + hd), "quadrant", el.id);
                    add(new THREE.Vector3(c.x, y, c.z - hd), "quadrant", el.id);
                }
            }
            if (p.polygon && p.polygon.length >= 2) {
                for (let i = 0; i < p.polygon.length; i++) {
                    const pt = p.polygon[i];
                    const v = new THREE.Vector3(pt[0], y, pt[1]);
                    if (this.types.has("vertex") || this.types.has("endpoint"))
                        add(v, "vertex", el.id, "vertex");
                    if (this.types.has("midpoint")) {
                        const n = p.polygon[(i + 1) % p.polygon.length];
                        add(new THREE.Vector3((pt[0] + n[0]) / 2, y, (pt[1] + n[1]) / 2), "midpoint", el.id);
                    }
                }
            }
            // Corner — this endpoint coincides with another element's endpoint.
            // O(n) via the shared endpoint index (was O(n²) per element pair).
            if (this.types.has("corner") && p.start && p.end) {
                const tol = 0.2;
                const tolQ = tol * tol;
                for (const endpoint of [p.start, p.end]) {
                    for (const other of all) {
                        if (other.id === el.id || !other.params.start || !other.params.end)
                            continue;
                        if ((0, magnetic_1.dist2)(endpoint, other.params.start) < tolQ || (0, magnetic_1.dist2)(endpoint, other.params.end) < tolQ) {
                            add(new THREE.Vector3(endpoint[0], y, endpoint[1]), "corner", other.id, "endpoint");
                            break;
                        }
                    }
                }
            }
        }
        catch { /* skip broken element */ }
    }
    screenDistToPointer(p, rect, clientX, clientY) {
        try {
            const v = p.clone().project(context_1.ctx.world.camera.three);
            const sx = (v.x * 0.5 + 0.5) * rect.width + rect.left;
            const sy = (-v.y * 0.5 + 0.5) * rect.height + rect.top;
            return Math.hypot(sx - clientX, sy - clientY);
        }
        catch {
            return 9999;
        }
    }
}
exports.snapping = new SnapManager();
/* -- Snap settings panel (unchanged API) ------------------------------ */
let snapPanel = null;
let snapPanelVisible = false;
function toggleSnapSettings() {
    setSnapSettingsVisible(!snapPanelVisible);
}
function isSnapSettingsVisible() { return snapPanelVisible; }
function setSnapSettingsVisible(on) {
    snapPanelVisible = on;
    if (!snapPanel)
        buildSnapPanel();
    if (snapPanel)
        snapPanel.style.display = on ? "block" : "none";
    if (on)
        renderSnapPanel();
}
function buildSnapPanel() {
    snapPanel = document.createElement("div");
    snapPanel.style.cssText =
        "position:fixed;bottom:48px;left:12px;width:300px;z-index:8500;" +
            "background:#1e2430;color:#e2e8f0;border:1px solid #334155;border-radius:10px;" +
            "box-shadow:0 8px 32px rgba(0,0,0,.4);font:12px/1.4 system-ui,sans-serif;display:none";
    document.body.appendChild(snapPanel);
}
function renderSnapPanel() {
    if (!snapPanel)
        return;
    const types = exports.snapping.getAllTypes();
    const active = new Set(exports.snapping.getTypes());
    // Color chips matching the marker colors
    const colorByType = {
        endpoint: "#F59E0B", intersection: "#EF4444", corner: "#FBBF24",
        midpoint: "#22C55E", center: "#38BDF8", perpendicular: "#C084FC",
        tangent: "#F472B6", quadrant: "#34D399", vertex: "#38BDF8",
        face: "#38BDF8", nearest: "#F59E0B", parallel: "#A78BFA",
        extension: "#F472B6", connector: "#FB923C", grid: "#38BDF8",
    };
    const checkboxes = types.map((t) => {
        const on = active.has(t);
        const color = colorByType[t] ?? "#94a3b8";
        return ('<label style="display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:4px;cursor:pointer;' +
            (on ? "background:#0f172a;" : "background:transparent;") + '">' +
            '<input type="checkbox" data-snap="' + t + '" ' + (on ? "checked" : "") +
            ' style="accent-color:' + color + '"/>' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + color + ';flex:none"></span>' +
            '<span style="flex:1">' + SVG_LABEL_FOR_PANEL(t) + '</span>' +
            '</label>');
    }).join("");
    snapPanel.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #334155;font-weight:600">' +
            '<span>Object Snaps</span>' +
            '<button type="button" id="obs-snap-close" style="background:none;border:none;color:#94a3b8;font-size:16px;cursor:pointer">×</button>' +
            '</div>' +
            '<div style="padding:10px 12px">' +
            '<div style="display:flex;gap:6px;margin-bottom:8px">' +
            '<button type="button" id="obs-snap-all" style="flex:1;background:#334155;border:1px solid #475569;color:#e2e8f0;border-radius:6px;padding:4px;cursor:pointer">All</button>' +
            '<button type="button" id="obs-snap-none" style="flex:1;background:#334155;border:1px solid #475569;color:#e2e8f0;border-radius:6px;padding:4px;cursor:pointer">None</button>' +
            '<button type="button" id="obs-snap-toggle" style="flex:1;background:' + (exports.snapping.isEnabled() ? "#1d4ed8" : "#334155") + ';border:1px solid #475569;color:#e2e8f0;border-radius:6px;padding:4px;cursor:pointer">' +
            (exports.snapping.isEnabled() ? "ON" : "OFF") +
            '</button>' +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;margin-bottom:10px">' + checkboxes + '</div>' +
            '<div style="margin:4px 0 10px;padding:8px;border:1px solid #475569;border-radius:6px;background:#0f172a">' +
            '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;color:#e2e8f0;font-size:11px">' +
            '<input type="checkbox" id="obs-snap-cad" ' + ((0, cad_underlay_snap_1.isUnderlaySnapEnabled)() ? "checked" : "") +
            ' style="accent-color:#38bdf8"/>' +
            '<span style="flex:1">Linked CAD (DWG / DXF)</span>' +
            '<span style="font-size:10px;color:#94a3b8">' + ((0, cad_underlay_snap_1.hasUnderlayData)() ? "Loaded" : "No linked drawing") + '</span>' +
            '</label>' +
            '<div style="margin:5px 0 0 24px;font-size:10px;color:#94a3b8;line-height:1.4">' +
            'Snap to visible drawing endpoints and segment midpoints while manually placing or aligning model elements.' +
            '</div>' +
            '</div>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:11px;color:#94a3b8">' +
            'Grid size (m)' +
            '<input type="number" id="obs-snap-grid" value="' + exports.snapping.getGridSize() + '" step="0.05" min="0.001" ' +
            'style="flex:1;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:4px;padding:4px 6px"/>' +
            '</label>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:11px;color:#94a3b8;margin-top:6px">' +
            'Tolerance (px)' +
            '<input type="number" id="obs-snap-tol" value="' + exports.snapping.getPixelTolerance() + '" step="1" min="4" ' +
            'style="flex:1;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:4px;padding:4px 6px"/>' +
            '</label>' +
            '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #334155;font-size:10px;color:#64748b;line-height:1.4">' +
            'Higher priority wins over closer snaps. Endpoint / Intersection / Corner beat Nearest and Grid.' +
            '</div>' +
            '</div>';
    snapPanel.querySelector("#obs-snap-close")?.addEventListener("click", () => setSnapSettingsVisible(false));
    snapPanel.querySelector("#obs-snap-all")?.addEventListener("click", () => { exports.snapping.enableAllTypes(); renderSnapPanel(); });
    snapPanel.querySelector("#obs-snap-none")?.addEventListener("click", () => { exports.snapping.disableAllTypes(); renderSnapPanel(); });
    snapPanel.querySelector("#obs-snap-cad")?.addEventListener("change", (e) => {
        (0, cad_underlay_snap_1.setUnderlaySnapEnabled)(e.target.checked);
    });
    snapPanel.querySelector("#obs-snap-toggle")?.addEventListener("click", () => {
        exports.snapping.setEnabled(!exports.snapping.isEnabled());
        renderSnapPanel();
    });
    snapPanel.querySelectorAll("[data-snap]").forEach((el) => {
        el.addEventListener("change", () => {
            const t = el.dataset.snap;
            exports.snapping.toggleType(t, el.checked);
        });
    });
    snapPanel.querySelector("#obs-snap-grid")?.addEventListener("change", (e) => {
        exports.snapping.setGridSize(Number(e.target.value) || 0.1);
    });
    snapPanel.querySelector("#obs-snap-tol")?.addEventListener("change", (e) => {
        exports.snapping.setPixelTolerance(Number(e.target.value) || 16);
    });
}
function SVG_LABEL_FOR_PANEL(t) {
    const map = {
        endpoint: "Endpoint", intersection: "Intersection", corner: "Corner",
        midpoint: "Midpoint", center: "Center", perpendicular: "Perpendicular",
        tangent: "Tangent", quadrant: "Quadrant", vertex: "Vertex",
        face: "Face", nearest: "Nearest", parallel: "Parallel",
        extension: "Extension", connector: "Connector (MEP)", grid: "Grid",
    };
    return map[t] ?? t;
}
