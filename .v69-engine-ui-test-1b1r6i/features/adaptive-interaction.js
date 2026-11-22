"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshAdaptiveGrips = refreshAdaptiveGrips;
exports.setupAdaptiveInteraction = setupAdaptiveInteraction;
/**
 * Native 3D placement and point-grip interaction for adaptive components.
 *
 * This feature deliberately uses the shared viewport gesture router and
 * snapping service. It does not install competing pointer listeners.
 */
const THREE = require("three");
const context_1 = require("../core/context");
const input_router_1 = require("../core/input-router");
const snapping_1 = require("./snapping");
const notify_1 = require("../core/notify");
const types_1 = require("../modules/work-planes/types");
const HANDLE_COLOR = 0xf59e0b;
const HANDLE_HOVER = 0x22c55e;
let installed = false;
let api = null;
let placement = null;
let gripDrag = null;
let hoverSequence = 0;
let lastSnap = null;
let workPlanePickArmed = false;
let previewRoot = null;
let gripRoot = null;
let hud = null;
let planeEditor = null;
let unsubGesture = null;
let unsubHover = null;
let unsubCancel = null;
let unsubAuthoring = null;
function ndcOf(event) {
    const host = context_1.ctx.rightHost;
    if (!host)
        return null;
    const rect = host.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1)
        return null;
    return new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
}
function rayFor(event) {
    const ndc = ndcOf(event);
    const camera = context_1.ctx.world?.camera?.three;
    if (!ndc || !camera)
        return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    return ray;
}
function isUnder(object, root) {
    if (!root)
        return false;
    let node = object;
    while (node) {
        if (node === root)
            return true;
        node = node.parent;
    }
    return false;
}
function surfacePoint(event, excludeElementId) {
    const ray = rayFor(event);
    const scene = context_1.ctx.world?.scene?.three;
    if (!ray || !scene)
        return null;
    const hits = ray.intersectObjects(scene.children, true);
    for (const hit of hits) {
        const object = hit.object;
        if (isUnder(object, previewRoot) || isUnder(object, gripRoot))
            continue;
        if (object === context_1.ctx.groundPlane || object.name === "groundPlane")
            continue;
        if (!object.visible)
            continue;
        if (excludeElementId && String(object.userData?.elementId ?? "") === excludeElementId)
            continue;
        if (object.isMesh || object.isInstancedMesh)
            return hit.point.clone();
    }
    return null;
}
function activeWorkPlaneIntersection(event) {
    const ray = rayFor(event);
    if (!ray)
        return null;
    const active = (0, types_1.getActiveWorkPlane)();
    const plane = active
        ? new THREE.Plane(new THREE.Vector3(active.normal[0], active.normal[1], active.normal[2]).normalize(), -new THREE.Vector3(active.normal[0], active.normal[1], active.normal[2]).normalize().dot(new THREE.Vector3(active.origin[0], active.origin[1], active.origin[2])))
        : new THREE.Plane(new THREE.Vector3(0, 1, 0), -snapping_1.snapping.getWorkPlaneY());
    const point = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, point) ? point : null;
}
function placementPoint(event) {
    const active = (0, types_1.getActiveWorkPlane)();
    if (active)
        return activeWorkPlaneIntersection(event);
    return surfacePoint(event) ?? activeWorkPlaneIntersection(event);
}
function firstFaceHit(event) {
    const ray = rayFor(event);
    const scene = context_1.ctx.world?.scene?.three;
    if (!ray || !scene)
        return null;
    return ray.intersectObjects(scene.children, true).find((hit) => {
        const object = hit.object;
        return !!hit.face && object.visible && !isUnder(object, previewRoot) && !isUnder(object, gripRoot) &&
            object !== context_1.ctx.groundPlane && object.name !== "groundPlane";
    }) ?? null;
}
function armWorkPlaneFromFace(event) {
    const hit = firstFaceHit(event);
    if (!hit?.face) {
        (0, notify_1.notify)("warn", "Pick a visible model face to define the adaptive work plane.");
        return false;
    }
    const object = hit.object;
    object.updateWorldMatrix(true, false);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
    const worldNormal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
    const worldOrigin = hit.point.clone();
    let root = object;
    while (root.parent && !root.userData?.elementId)
        root = root.parent;
    const elementId = String(root.userData?.elementId ?? object.userData?.elementId ?? "");
    const sceneRoot = elementId ? root : object;
    let meshIndex = -1;
    let meshCursor = 0;
    sceneRoot.traverse((node) => {
        if (!node.isMesh)
            return;
        if (node === object)
            meshIndex = meshCursor;
        meshCursor++;
    });
    const localOrigin = object.worldToLocal(worldOrigin.clone());
    const localNormal = hit.face.normal.clone().normalize();
    const face = {
        ...(elementId ? { elementId } : {}),
        ...(meshIndex >= 0 ? { meshIndex } : {}),
        ...(typeof hit.faceIndex === "number" && Number.isInteger(hit.faceIndex) ? { faceIndex: hit.faceIndex } : {}),
        localOrigin: [localOrigin.x, localOrigin.y, localOrigin.z],
        localNormal: [localNormal.x, localNormal.y, localNormal.z],
    };
    const plane = (0, types_1.createWorkPlane)("Adaptive face · " + (root.name || object.name || elementId || "Picked surface"), [worldOrigin.x, worldOrigin.y, worldOrigin.z], [worldNormal.x, worldNormal.y, worldNormal.z], face);
    workPlanePickArmed = false;
    if (hud) {
        const button = hud.querySelector("[data-work-plane]");
        if (button)
            button.textContent = "Pick Work Plane";
        hud.querySelector("[data-step]").textContent = "Active plane: " + plane.name;
    }
    snapping_1.snapping.hideIndicator();
    lastSnap = null;
    (0, notify_1.notify)("success", "Adaptive work plane set from picked face.");
    return true;
}
function cursorMatchesSnap(event) {
    if (!lastSnap)
        return null;
    if (Math.hypot(event.clientX - lastSnap.x, event.clientY - lastSnap.y) > 14)
        return null;
    return lastSnap.point.clone();
}
function removeObject(root) {
    if (!root)
        return;
    root.parent?.remove(root);
    root.traverse((obj) => {
        const mesh = obj;
        if (mesh.geometry)
            mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const material of materials)
            material.dispose();
    });
}
function ensureGroups() {
    const scene = context_1.ctx.world?.scene?.three;
    if (!scene)
        throw new Error("The 3D viewport is not ready");
    if (!previewRoot) {
        previewRoot = new THREE.Group();
        previewRoot.name = "adaptive-placement-preview";
        previewRoot.userData.adaptiveInteractionOverlay = true;
        scene.add(previewRoot);
    }
    if (!gripRoot) {
        gripRoot = new THREE.Group();
        gripRoot.name = "adaptive-placement-grips";
        gripRoot.userData.adaptiveInteractionOverlay = true;
        scene.add(gripRoot);
    }
}
function pointCountLabel() {
    if (!placement)
        return "";
    return "Point " + Math.min(placement.points.length + 1, placement.pointCount) +
        " of " + placement.pointCount;
}
function updateHud() {
    if (!hud || !placement)
        return;
    const family = placement.input.familyName || "Adaptive component";
    const count = placement.points.length;
    const next = Math.min(count + 1, placement.pointCount);
    hud.querySelector("[data-status]").textContent =
        family + " · " + count + "/" + placement.pointCount + " points placed";
    hud.querySelector("[data-step]").textContent =
        count < placement.pointCount ? "Click to place " + pointCountLabel() : "Finalizing component…";
    const undo = hud.querySelector("[data-undo]");
    if (undo)
        undo.disabled = count === 0;
    void next;
}
function closePlaneEditor() {
    if (planeEditor?.parentElement)
        planeEditor.parentElement.removeChild(planeEditor);
    planeEditor = null;
}
function parsePlaneVector(raw, label) {
    const values = String(raw).trim().split(/[,;\s]+/).map(Number);
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
        throw new Error(label + " must contain exactly three finite coordinates");
    }
    return [values[0], values[1], values[2]];
}
function openCustomPlaneEditor(step, button) {
    if (planeEditor) {
        closePlaneEditor();
        return;
    }
    const current = (0, types_1.getActiveWorkPlane)();
    planeEditor = document.createElement("div");
    planeEditor.dataset.adaptiveWorkPlaneEditor = "true";
    planeEditor.style.cssText =
        "position:absolute;z-index:78;top:66px;left:50%;transform:translateX(-50%);" +
            "display:flex;flex-direction:column;gap:8px;width:340px;padding:12px;" +
            "background:rgba(15,17,23,.98);border:1px solid #475569;border-radius:9px;" +
            "box-shadow:0 12px 30px rgba(0,0,0,.42);color:#e5e7eb;font:11px system-ui,sans-serif";
    const heading = document.createElement("strong");
    heading.textContent = "Define Arbitrary Work Plane";
    const makeField = (labelText, value) => {
        const wrap = document.createElement("label");
        wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;color:#cbd5e1";
        wrap.textContent = labelText;
        const input = document.createElement("input");
        input.type = "text";
        input.value = value;
        input.style.cssText =
            "box-sizing:border-box;width:100%;padding:7px 8px;border:1px solid #475569;border-radius:5px;" +
                "background:#0b1220;color:#f8fafc;font:12px ui-monospace,monospace";
        wrap.appendChild(input);
        return { wrap, input };
    };
    const origin = makeField("Origin X, Y, Z (metres)", current ? current.origin.join(", ") : "0, 0, 0");
    const normal = makeField("Normal NX, NY, NZ", current ? current.normal.join(", ") : "0, 1, 0");
    const rotation = makeField("Local sketch rotation (radians)", String(current?.rotation ?? 0));
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:7px";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = "Set Work Plane";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    for (const action of [apply, close])
        action.style.cssText =
            "border:1px solid #475569;border-radius:5px;padding:6px 9px;background:#1e293b;color:#e2e8f0;cursor:pointer";
    close.addEventListener("click", (event) => {
        event.stopPropagation();
        closePlaneEditor();
    });
    apply.addEventListener("click", (event) => {
        event.stopPropagation();
        try {
            const point = parsePlaneVector(origin.input.value, "Work plane origin");
            const direction = parsePlaneVector(normal.input.value, "Work plane normal");
            const angle = Number(rotation.input.value);
            if (!Number.isFinite(angle))
                throw new Error("Work plane rotation must be a finite number");
            const plane = (0, types_1.createWorkPlane)("Adaptive custom work plane", point, direction);
            (0, types_1.setWorkPlaneRotation)(plane.id, angle);
            workPlanePickArmed = false;
            button.textContent = "Pick Work Plane";
            step.textContent = "Active plane: " + plane.name;
            closePlaneEditor();
            snapping_1.snapping.hideIndicator();
            lastSnap = null;
            (0, notify_1.notify)("success", "Arbitrary adaptive work plane activated.");
        }
        catch (error) {
            (0, notify_1.notify)("error", error.message);
        }
    });
    actions.append(apply, close);
    planeEditor.append(heading, origin.wrap, normal.wrap, rotation.wrap, actions);
    context_1.ctx.rightHost?.appendChild(planeEditor);
}
function ensureHud() {
    if (hud || !context_1.ctx.rightHost)
        return;
    hud = document.createElement("div");
    hud.dataset.adaptivePlacementHud = "true";
    hud.style.cssText =
        "position:absolute;z-index:75;top:14px;left:50%;transform:translateX(-50%);" +
            "display:flex;align-items:center;gap:12px;min-width:360px;padding:10px 12px;" +
            "background:rgba(15,17,23,.96);border:1px solid #475569;border-radius:9px;" +
            "box-shadow:0 10px 28px rgba(0,0,0,.35);color:#e5e7eb;font:12px system-ui,sans-serif";
    const info = document.createElement("div");
    info.style.cssText = "display:flex;flex-direction:column;gap:3px;flex:1;min-width:0";
    const status = document.createElement("strong");
    status.dataset.status = "true";
    status.style.cssText = "font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    const step = document.createElement("span");
    step.dataset.step = "true";
    step.style.cssText = "font-size:11px;color:#94a3b8";
    info.append(status, step);
    const undo = document.createElement("button");
    undo.dataset.undo = "true";
    undo.textContent = "Undo point";
    undo.title = "Remove the last placed point (Backspace)";
    const pickPlane = document.createElement("button");
    pickPlane.dataset.workPlane = "true";
    pickPlane.type = "button";
    pickPlane.textContent = "Pick Work Plane";
    pickPlane.title = "Use a model face as the active adaptive work plane";
    const definePlane = document.createElement("button");
    definePlane.type = "button";
    definePlane.textContent = "Define Plane";
    definePlane.title = "Define any 3D work plane by origin, normal and sketch rotation";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    for (const button of [undo, pickPlane, definePlane, cancel]) {
        button.type = "button";
        button.style.cssText =
            "border:1px solid #475569;border-radius:6px;padding:6px 9px;background:#1e293b;" +
                "color:#e2e8f0;font:11px system-ui;cursor:pointer";
    }
    undo.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!placement || placement.points.length === 0)
            return;
        placement.points.pop();
        drawPlacementPreview(null);
        updateHud();
    });
    pickPlane.addEventListener("click", (event) => {
        event.stopPropagation();
        workPlanePickArmed = !workPlanePickArmed;
        pickPlane.textContent = workPlanePickArmed ? "Click a Face…" : "Pick Work Plane";
        step.textContent = workPlanePickArmed
            ? "Click a visible model face. Escape cancels plane picking."
            : "Continue placing points on the active plane.";
        (0, notify_1.notify)("info", workPlanePickArmed ? "Click a visible 3D face to set the adaptive work plane." : "Face picking cancelled.");
    });
    definePlane.addEventListener("click", (event) => {
        event.stopPropagation();
        workPlanePickArmed = false;
        pickPlane.textContent = "Pick Work Plane";
        openCustomPlaneEditor(step, pickPlane);
    });
    cancel.addEventListener("click", (event) => {
        event.stopPropagation();
        finishPlacement(null);
    });
    hud.append(info, undo, pickPlane, definePlane, cancel);
    context_1.ctx.rightHost.appendChild(hud);
}
function disposePreview() {
    if (!previewRoot)
        return;
    while (previewRoot.children.length) {
        const child = previewRoot.children[0];
        previewRoot.remove(child);
        child.traverse((obj) => {
            const mesh = obj;
            if (mesh.geometry)
                mesh.geometry.dispose();
            const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
            for (const material of materials)
                material.dispose();
        });
    }
}
function drawPlacementPreview(cursor) {
    if (!placement || !api || !previewRoot)
        return;
    disposePreview();
    const points = placement.points.map((p) => ({ ...p }));
    if (cursor)
        points.push({ x: cursor.x, y: cursor.y, z: cursor.z });
    if (points.length) {
        try {
            const definition = {
                schemaVersion: 1,
                familyId: String(placement.input.familyId),
                familyName: String(placement.input.familyName),
                pointCount: points.length,
                points,
                profile: placement.input.profile,
                ...(placement.input.pointLength === undefined ? {} : { pointLength: placement.input.pointLength }),
            };
            const mesh = api.buildMesh({
                id: "adaptive-placement-preview",
                type: "adaptive-component",
                color: "#f59e0b",
                properties: { adaptiveDefinition: definition },
            });
            if (mesh) {
                mesh.traverse((obj) => {
                    const child = obj;
                    if (!child.isMesh)
                        return;
                    const materials = Array.isArray(child.material) ? child.material : [child.material];
                    child.material = materials.map((material) => {
                        const clone = material.clone();
                        clone.transparent = true;
                        clone.opacity = 0.38;
                        clone.depthWrite = false;
                        if (clone.color)
                            clone.color.set("#f59e0b");
                        return clone;
                    });
                    child.renderOrder = 900;
                });
                previewRoot.add(mesh);
            }
        }
        catch { /* partial placement may not yet define a valid sweep */ }
    }
    if (points.length > 0) {
        const geometry = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
        const material = new THREE.LineBasicMaterial({ color: 0xfbbf24, depthTest: false });
        const line = new THREE.Line(geometry, material);
        line.renderOrder = 901;
        previewRoot.add(line);
        points.forEach((point, index) => {
            const marker = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), new THREE.MeshBasicMaterial({ color: index === points.length - 1 ? 0x22c55e : 0xf59e0b, depthTest: false }));
            marker.position.set(point.x, point.y, point.z);
            marker.renderOrder = 902;
            previewRoot.add(marker);
        });
    }
}
function finishPlacement(element) {
    if (!placement)
        return;
    const current = placement;
    placement = null;
    workPlanePickArmed = false;
    hoverSequence++;
    lastSnap = null;
    snapping_1.snapping.hideIndicator();
    removeObject(previewRoot);
    previewRoot = null;
    if (hud?.parentElement)
        hud.parentElement.removeChild(hud);
    hud = null;
    closePlaneEditor();
    current.resolve(element);
    try {
        window.obsRefreshRibbon?.();
    }
    catch { /* */ }
}
async function placeCurrentPoint(event) {
    if (!placement || !api)
        return;
    const world = cursorMatchesSnap(event) ?? placementPoint(event);
    if (!world) {
        (0, notify_1.notify)("warn", "No 3D surface or active work plane was found under the cursor.");
        return;
    }
    placement.points.push({ x: world.x, y: world.y, z: world.z });
    if (placement.points.length < placement.pointCount) {
        drawPlacementPreview(null);
        updateHud();
        return;
    }
    const current = placement;
    try {
        const activePlane = (0, types_1.getActiveWorkPlane)();
        const faceReference = activePlane?.face ? {
            ...(activePlane.face.elementId ? { elementId: activePlane.face.elementId } : {}),
            ...(activePlane.face.meshIndex !== undefined ? { meshIndex: activePlane.face.meshIndex } : {}),
            ...(activePlane.face.faceIndex !== undefined ? { faceIndex: activePlane.face.faceIndex } : {}),
            ...(activePlane.face.localOrigin ? { localOrigin: { x: activePlane.face.localOrigin[0], y: activePlane.face.localOrigin[1], z: activePlane.face.localOrigin[2] } } : {}),
            ...(activePlane.face.localNormal ? { localNormal: { x: activePlane.face.localNormal[0], y: activePlane.face.localNormal[1], z: activePlane.face.localNormal[2] } } : {}),
        } : undefined;
        const planeConstraints = activePlane
            ? current.points.map((_, pointIndex) => ({
                kind: (faceReference ? "face-lock" : "plane"),
                pointIndex,
                origin: { x: activePlane.origin[0], y: activePlane.origin[1], z: activePlane.origin[2] },
                normal: { x: activePlane.normal[0], y: activePlane.normal[1], z: activePlane.normal[2] },
                ...(faceReference ? { face: faceReference } : {}),
            }))
            : [];
        const workPlane = activePlane ? {
            id: activePlane.id,
            name: activePlane.name,
            origin: { x: activePlane.origin[0], y: activePlane.origin[1], z: activePlane.origin[2] },
            normal: { x: activePlane.normal[0], y: activePlane.normal[1], z: activePlane.normal[2] },
            rotation: activePlane.rotation,
            ...(faceReference ? { face: faceReference } : {}),
        } : undefined;
        const element = api.create({
            ...current.input,
            points: current.points,
            constraints: [...(current.input.constraints ?? []), ...planeConstraints],
            ...(workPlane ? { workPlane } : {}),
        });
        finishPlacement(element);
        (0, notify_1.notify)("success", "Placed native adaptive component: " + String(element?.name ?? current.input.familyName));
        refreshAdaptiveGrips();
    }
    catch (error) {
        current.points.pop();
        drawPlacementPreview(null);
        updateHud();
        (0, notify_1.notify)("error", "Adaptive placement failed: " + error.message);
    }
}
function handlePlacementHover(event) {
    if (!placement)
        return;
    const cursor = placementPoint(event);
    const sequence = ++hoverSequence;
    if (!cursor) {
        lastSnap = null;
        snapping_1.snapping.hideIndicator();
        drawPlacementPreview(null);
        return;
    }
    drawPlacementPreview(cursor);
    void snapping_1.snapping.query(event, cursor).then((result) => {
        if (!placement || sequence !== hoverSequence)
            return;
        if (result) {
            const active = (0, types_1.getActiveWorkPlane)();
            const snapped = result.point.clone();
            if (active) {
                const normal = new THREE.Vector3(active.normal[0], active.normal[1], active.normal[2]).normalize();
                const origin = new THREE.Vector3(active.origin[0], active.origin[1], active.origin[2]);
                const distance = result.point.clone().sub(origin).dot(normal);
                snapped.copy(result.point).addScaledVector(normal, -distance);
            }
            const snapResult = { ...result, point: snapped };
            lastSnap = { point: snapped.clone(), x: event.clientX, y: event.clientY };
            snapping_1.snapping.showIndicator(snapResult);
            drawPlacementPreview(snapped);
        }
        else {
            lastSnap = null;
            snapping_1.snapping.hideIndicator();
        }
    }).catch(() => { });
}
function gripSize(point) {
    const camera = context_1.ctx.world?.camera?.three;
    const host = context_1.ctx.rightHost;
    if (!camera || !host)
        return 0.07;
    const pixels = 8;
    if (camera.isOrthographicCamera) {
        // Screen-constant: the world size of `pixels` on screen. There is no
        // upper clamp on purpose — the formula already yields exactly 8 px at
        // any zoom, and clamping it (as the old 0.12 m cap did) shrank the
        // grip to ~1 px when zoomed out, making it unclickable. The lower
        // bound only stops it vanishing when the camera is very close.
        return Math.max(0.025, Math.abs((camera.top - camera.bottom) / (camera.zoom || 1)) / Math.max(1, host.clientHeight) * pixels);
    }
    const distance = Math.max(0.1, camera.position.distanceTo(point));
    const fov = THREE.MathUtils.degToRad(camera.fov ?? 50);
    return Math.max(0.025, 2 * distance * Math.tan(fov / 2) * pixels / Math.max(1, host.clientHeight));
}
function addConstraintLine(points, kind, color, elementId) {
    if (!gripRoot || points.length < 2)
        return;
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
    line.renderOrder = 1090;
    line.userData.adaptiveConstraintGlyph = kind;
    line.userData.elementId = elementId;
    gripRoot.add(line);
}
function addConstraintGlyph(constraint, points, elementId) {
    if (!gripRoot)
        return;
    const at = (index) => {
        const p = points[index];
        return p && Number.isInteger(index) ? new THREE.Vector3(p.x, p.y, p.z) : null;
    };
    const addMarker = (position, kind, color, size = 0.045) => {
        const marker = new THREE.Mesh(new THREE.SphereGeometry(size, 10, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
        marker.position.copy(position);
        marker.renderOrder = 1105;
        marker.userData.adaptiveConstraintGlyph = kind;
        marker.userData.elementId = elementId;
        gripRoot.add(marker);
    };
    const kind = String(constraint?.kind ?? "");
    const colors = {
        fixed: 0x60a5fa, axis: 0x22d3ee, plane: 0x38bdf8, "face-lock": 0x38bdf8,
        coincident: 0x34d399, distance: 0xfbbf24, horizontal: 0x4ade80,
        vertical: 0x4ade80, parallel: 0xa78bfa, perpendicular: 0xfb923c,
        equalLength: 0x2dd4bf, angle: 0xf472b6,
    };
    const color = colors[kind] ?? 0xe5e7eb;
    if (kind === "fixed" || kind === "axis") {
        const p = at(constraint.pointIndex);
        if (!p)
            return;
        if (kind === "fixed") {
            const axis = 0.11;
            addConstraintLine([p.clone().add(new THREE.Vector3(-axis, 0, 0)), p.clone().add(new THREE.Vector3(axis, 0, 0))], kind, color, elementId);
            addConstraintLine([p.clone().add(new THREE.Vector3(0, -axis, 0)), p.clone().add(new THREE.Vector3(0, axis, 0))], kind, color, elementId);
            addConstraintLine([p.clone().add(new THREE.Vector3(0, 0, -axis)), p.clone().add(new THREE.Vector3(0, 0, axis))], kind, color, elementId);
        }
        else {
            const direction = constraint.axis === "x" ? new THREE.Vector3(1, 0, 0)
                : constraint.axis === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
            addConstraintLine([p.clone().addScaledVector(direction, -0.2), p.clone().addScaledVector(direction, 0.2)], kind, color, elementId);
        }
        addMarker(p, kind, color, 0.055);
        return;
    }
    if (kind === "plane" || kind === "face-lock") {
        const origin = constraint.origin;
        const normal = constraint.normal;
        if (!origin || !normal)
            return;
        const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), new THREE.MeshBasicMaterial({
            color, side: THREE.DoubleSide, transparent: true, opacity: 0.12,
            depthTest: false, depthWrite: false,
        }));
        plane.position.set(origin.x, origin.y, origin.z);
        plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
        plane.renderOrder = 1080;
        plane.userData.adaptiveConstraintGlyph = kind;
        plane.userData.elementId = elementId;
        gripRoot.add(plane);
        const end = plane.position.clone().addScaledVector(n, 0.24);
        addConstraintLine([plane.position.clone(), end], kind, color, elementId);
        addMarker(plane.position, kind, color, 0.04);
        return;
    }
    const a = at(constraint.a), b = at(constraint.b);
    if (a && b && ["coincident", "distance", "horizontal", "vertical"].includes(kind)) {
        addConstraintLine([a, b], kind, color, elementId);
        addMarker(a, kind, color, 0.035);
        addMarker(b, kind, color, 0.035);
        if (kind === "distance") {
            addMarker(a.clone().lerp(b, 0.5), kind, color, 0.055);
        }
        else if (kind === "coincident") {
            addMarker(a.clone().lerp(b, 0.5), kind, color, 0.065);
        }
        return;
    }
    const c = at(constraint.c), d = at(constraint.d);
    if (!a || !b || !c || !d)
        return;
    addConstraintLine([a, b], kind, color, elementId);
    addConstraintLine([c, d], kind, color, elementId);
    const midAB = a.clone().lerp(b, 0.5);
    const midCD = c.clone().lerp(d, 0.5);
    addConstraintLine([midAB, midCD], kind, color, elementId);
    addMarker(midAB, kind, color, 0.05);
    addMarker(midCD, kind, color, 0.05);
    if (kind === "perpendicular") {
        const ab = b.clone().sub(a).normalize().multiplyScalar(0.13);
        const cd = d.clone().sub(c).normalize().multiplyScalar(0.13);
        const corner = midAB.clone();
        addConstraintLine([corner, corner.clone().add(ab), corner.clone().add(ab).add(cd), corner.clone().add(cd)], kind, color, elementId);
    }
    else if (kind === "equalLength") {
        addMarker(midAB, "equalLength-tick", color, 0.075);
        addMarker(midCD, "equalLength-tick", color, 0.075);
    }
}
function refreshAdaptiveGrips() {
    if (!gripRoot || !api)
        return;
    while (gripRoot.children.length) {
        const child = gripRoot.children[0];
        gripRoot.remove(child);
        child.traverse((obj) => {
            const mesh = obj;
            if (mesh.geometry)
                mesh.geometry.dispose();
            const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
            for (const material of materials)
                material.dispose();
        });
    }
    const authoring = context_1.ctx.features?.authoring;
    const selected = authoring?.getSelectedIds?.() ?? [];
    for (const id of selected) {
        const element = (authoring?.getElements?.() ?? []).find((item) => item.id === id && item.type === "adaptive-component");
        const definition = element?.properties?.adaptiveDefinition;
        if (!definition || !Array.isArray(definition.points))
            continue;
        definition.points.forEach((point, pointIndex) => {
            const position = new THREE.Vector3(point.x, point.y, point.z);
            const handle = new THREE.Mesh(new THREE.SphereGeometry(gripSize(position), 16, 12), new THREE.MeshBasicMaterial({ color: HANDLE_COLOR, depthTest: false, transparent: true, opacity: 0.98 }));
            handle.position.copy(position);
            handle.renderOrder = 1100;
            handle.userData.adaptivePlacementGrip = true;
            handle.userData.elementId = element.id;
            handle.userData.pointIndex = pointIndex;
            gripRoot.add(handle);
        });
        for (const constraint of definition.constraints ?? []) {
            addConstraintGlyph(constraint, definition.points, element.id);
        }
    }
}
function gripAt(event) {
    if (!gripRoot || !gripRoot.children.length)
        return null;
    const ray = rayFor(event);
    if (!ray)
        return null;
    const hit = ray.intersectObjects(gripRoot.children, true)
        .find((candidate) => candidate.object.userData?.adaptivePlacementGrip === true);
    if (!hit)
        return null;
    const object = hit.object;
    const elementId = String(object.userData.elementId ?? "");
    const pointIndex = Number(object.userData.pointIndex);
    return elementId && Number.isInteger(pointIndex) ? { elementId, pointIndex } : null;
}
function pointOnDragPlane(event, drag) {
    const ray = rayFor(event);
    if (!ray)
        return null;
    const point = new THREE.Vector3();
    return ray.ray.intersectPlane(drag.plane, point) ? point : surfacePoint(event, drag.elementId);
}
function updateGripFromEvent(event, point) {
    if (!gripDrag || !api)
        return;
    const world = point ?? pointOnDragPlane(event, gripDrag);
    if (!world)
        return;
    try {
        const changed = api.previewPointEdit(gripDrag.elementId, gripDrag.pointIndex, {
            x: world.x, y: world.y, z: world.z,
        }, gripDrag.baseline);
        gripDrag.changed = gripDrag.changed || changed;
        refreshAdaptiveGrips();
    }
    catch (error) {
        console.warn("[adaptive] live placement grip update rejected", error);
    }
}
function beginGripDrag(event) {
    if (!api)
        return false;
    const grip = gripAt(event);
    if (!grip)
        return false;
    const baseline = api.beginPointEdit(grip.elementId);
    const camera = context_1.ctx.world?.camera?.three;
    if (!baseline || !camera)
        return false;
    const definition = baseline.definition;
    const point = definition.points?.[grip.pointIndex];
    if (!point)
        return false;
    const anchor = new THREE.Vector3(point.x, point.y, point.z);
    const normal = new THREE.Vector3();
    camera.getWorldDirection(normal);
    gripDrag = {
        elementId: grip.elementId,
        pointIndex: grip.pointIndex,
        baseline,
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, anchor),
        changed: false,
    };
    return true;
}
function cancelActive() {
    if (placement && workPlanePickArmed) {
        workPlanePickArmed = false;
        const button = hud?.querySelector("[data-work-plane]");
        if (button)
            button.textContent = "Pick Work Plane";
        const step = hud?.querySelector("[data-step]");
        if (step)
            step.textContent = "Continue placing points on the active plane.";
        (0, notify_1.notify)("info", "Face work-plane picking cancelled.");
        return true;
    }
    if (placement) {
        finishPlacement(null);
        (0, notify_1.notify)("info", "Adaptive placement cancelled.");
        return true;
    }
    if (gripDrag && api) {
        const drag = gripDrag;
        gripDrag = null;
        try {
            api.cancelPointEdit(drag.elementId, drag.baseline);
        }
        catch (error) {
            (0, notify_1.notify)("error", "Could not restore adaptive point: " + error.message);
        }
        refreshAdaptiveGrips();
        if (context_1.ctx.rightHost)
            context_1.ctx.rightHost.style.cursor = "";
        return true;
    }
    return false;
}
function backspacePlacementPoint() {
    if (!placement)
        return false;
    if (placement.points.length)
        placement.points.pop();
    drawPlacementPreview(null);
    updateHud();
    return true;
}
function disposeAdaptiveInteraction() {
    cancelActive();
    unsubGesture?.();
    unsubHover?.();
    unsubCancel?.();
    unsubAuthoring?.();
    unsubGesture = null;
    unsubHover = null;
    unsubCancel = null;
    unsubAuthoring = null;
    removeObject(previewRoot);
    removeObject(gripRoot);
    previewRoot = null;
    gripRoot = null;
    if (hud?.parentElement)
        hud.parentElement.removeChild(hud);
    hud = null;
    closePlaneEditor();
    installed = false;
    api = null;
}
function setupAdaptiveInteraction(targetApi) {
    if (installed)
        return context_1.ctx.features.adaptiveInteraction;
    api = targetApi;
    if (!context_1.ctx.world?.scene?.three || !context_1.ctx.rightHost) {
        throw new Error("Adaptive viewport interaction requires an initialized 3D viewport");
    }
    ensureGroups();
    unsubGesture = input_router_1.inputRouter.subscribe((gesture) => {
        if (placement) {
            if (gesture.kind === "drag-start" && gesture.button === 0)
                return true;
            if (gesture.kind === "click" && gesture.button === 0) {
                if (workPlanePickArmed) {
                    armWorkPlaneFromFace(gesture.event);
                    return true;
                }
                void placeCurrentPoint(gesture.event);
                return true;
            }
            if (gesture.kind === "rmb-click") {
                if (workPlanePickArmed) {
                    workPlanePickArmed = false;
                    const button = hud?.querySelector("[data-work-plane]");
                    if (button)
                        button.textContent = "Pick Work Plane";
                    const step = hud?.querySelector("[data-step]");
                    if (step)
                        step.textContent = "Continue placing points on the active plane.";
                    return true;
                }
                return backspacePlacementPoint();
            }
            return false;
        }
        if (gripDrag) {
            if (gesture.kind === "drag-move") {
                updateGripFromEvent(gesture.event);
                const drag = gripDrag;
                const raw = pointOnDragPlane(gesture.event, drag);
                if (raw) {
                    const sequence = ++hoverSequence;
                    void snapping_1.snapping.query(gesture.event, raw).then((result) => {
                        if (gripDrag === drag && sequence === hoverSequence && result)
                            updateGripFromEvent(gesture.event, result.point);
                    }).catch(() => { });
                }
                return true;
            }
            if (gesture.kind === "drag-end") {
                const drag = gripDrag;
                gripDrag = null;
                try {
                    if (drag.changed)
                        api?.commitPointEdit(drag.elementId, drag.baseline);
                    else
                        api?.cancelPointEdit(drag.elementId, drag.baseline);
                }
                catch (error) {
                    try {
                        api?.cancelPointEdit(drag.elementId, drag.baseline);
                    }
                    catch { /* keep failure visible */ }
                    (0, notify_1.notify)("error", "Adaptive grip commit failed: " + error.message);
                }
                if (context_1.ctx.rightHost)
                    context_1.ctx.rightHost.style.cursor = "";
                refreshAdaptiveGrips();
                return true;
            }
            return false;
        }
        if (gesture.kind === "drag-start" && gesture.button === 0 && beginGripDrag(gesture.event)) {
            if (context_1.ctx.rightHost)
                context_1.ctx.rightHost.style.cursor = "grabbing";
            return true;
        }
        if (gesture.kind === "click" && gesture.button === 0) {
            refreshAdaptiveGrips();
        }
        return false;
    }, 80);
    unsubHover = input_router_1.inputRouter.subscribeHover((event) => {
        if (placement)
            handlePlacementHover(event);
    });
    unsubCancel = input_router_1.inputRouter.registerCancel(cancelActive);
    window.addEventListener("keydown", (event) => {
        const target = event.target;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT" || target.isContentEditable))
            return;
        if (event.key === "Backspace" && placement) {
            event.preventDefault();
            backspacePlacementPoint();
        }
    });
    const authoring = context_1.ctx.features?.authoring;
    if (typeof authoring?.onAuthoringChange === "function") {
        unsubAuthoring = authoring.onAuthoringChange(() => refreshAdaptiveGrips());
    }
    window.addEventListener("obs:authoring-changed", () => refreshAdaptiveGrips());
    window.addEventListener("resize", () => refreshAdaptiveGrips());
    const beginPlacement = (input) => {
        if (placement)
            finishPlacement(null);
        if (!Number.isInteger(input.pointCount) || input.pointCount < 1 || input.pointCount > 8) {
            throw new Error("Adaptive placement requires between 1 and 8 points");
        }
        const { pointCount, ...createInput } = input;
        return new Promise((resolve) => {
            const resolvePlacement = (element) => {
                if (context_1.ctx.rightHost)
                    context_1.ctx.rightHost.style.cursor = "";
                resolve(element);
            };
            placement = { input: createInput, pointCount, points: [], resolve: resolvePlacement };
            ensureHud();
            updateHud();
            drawPlacementPreview(null);
            context_1.ctx.rightHost.style.cursor = "crosshair";
            (0, notify_1.notify)("info", "Adaptive placement: click the 3D model to place each ordered point. Escape cancels.");
        });
    };
    const interactionApi = { beginPlacement, cancelPlacement: cancelActive, refreshGrips: refreshAdaptiveGrips, dispose: disposeAdaptiveInteraction };
    targetApi.beginPlacement = beginPlacement;
    targetApi.cancelPlacement = cancelActive;
    targetApi.refreshGrips = refreshAdaptiveGrips;
    context_1.ctx.features.adaptiveInteraction = interactionApi;
    if (typeof targetApi.connectFamilyTypePropagation === "function")
        targetApi.connectFamilyTypePropagation();
    installed = true;
    refreshAdaptiveGrips();
    return interactionApi;
}
