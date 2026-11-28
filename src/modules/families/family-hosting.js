/**
 * Generic family hosting — face / wall hosting for ARBITRARY families.
 *
 * Doors and windows already host on walls (their openings are cut by
 * `src/modules/hosting/index.ts`), and MEP elements host via
 * `src/modules/mep/hosted-elements.ts` (fixed kinds, compatibility
 * table). Neither covers a freestanding family: an instance placed
 * through `resolvePlacement` got geometry keys only, no host
 * attachment, so moving the host left it behind.
 *
 * This module generalises the relationship for any family instance:
 * the instance stores its position AS host parameters — curve length
 * `s` along a wall, or `(u, v)` on a face — plus an offset from the
 * host surface and (for walls) an elevation above the host base. Its
 * world placement is always RE-DERIVED from the current host
 * geometry, so host edits propagate deterministically (the same
 * policy as `hosting/index.ts` spec 1.5: the dependent follows the
 * host's parametric position). A placement that no longer fits is
 * reported invalid, never silently dropped; a deleted host orphans
 * the instance and the audit reports it.
 *
 * Coordinate convention follows `hosting/index.ts` and
 * `AuthoredElement`: plan coordinates are (x, y), elevation is z.
 * (The MEP module uses y-up; do not mix the two.)
 *
 * Pure module: no DOM, no ctx — safe to unit-test in Node. The
 * `familyHosting` service object at the bottom is what the app boot
 * registers for the browser (see `families-parametric-boot.ts`).
 */
import { hostFrameWithLayers, hostLength } from "../hosting/index";
const TOL = 1e-9;
function isUnit(v) {
    const len = Math.hypot(v[0], v[1], v[2]);
    return Math.abs(len - 1) < 1e-6;
}
function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}
function deg(rad) {
    return (rad * 180) / Math.PI;
}
/**
 * Project a plan point onto a host curve: the curve parameter s of the
 * closest point and the signed offset from the location line (positive
 * toward the normal, i.e. left of the tangent). Throws when the point
 * does not project onto the curve segment.
 */
export function projectPointToWallCurve(curve, point) {
    const L = hostLength(curve);
    if (curve.kind === "line") {
        const dx = curve.end[0] - curve.start[0];
        const dy = curve.end[1] - curve.start[1];
        const len = Math.hypot(dx, dy);
        if (len < TOL)
            throw new Error("projectPointToWallCurve: host line has zero length");
        const tx = dx / len, ty = dy / len;
        const rx = point[0] - curve.start[0], ry = point[1] - curve.start[1];
        const s = rx * tx + ry * ty;
        if (s < -TOL || s > L + TOL) {
            throw new Error(`projectPointToWallCurve: point projects to s=${s.toFixed(3)}, outside the host [0, ${L.toFixed(3)}]`);
        }
        // Offset is the signed distance toward the normal (-ty, tx).
        const offset = rx * -ty + ry * tx;
        return { s: Math.min(Math.max(s, 0), L), offset };
    }
    const dx = point[0] - curve.center[0], dy = point[1] - curve.center[1];
    const r = Math.hypot(dx, dy);
    const span = curve.endAngle - curve.startAngle;
    // Same sweep convention as evaluateHost: a negative span sweeps clockwise.
    const dir = span < 0 ? -1 : 1;
    let along = (Math.atan2(dy, dx) - curve.startAngle) * dir;
    while (along < 0)
        along += 2 * Math.PI;
    while (along >= 2 * Math.PI)
        along -= 2 * Math.PI;
    const s = along * curve.radius;
    if (s < -TOL || s > L + TOL) {
        throw new Error(`projectPointToWallCurve: point projects to s=${s.toFixed(3)}, outside the host [0, ${L.toFixed(3)}]`);
    }
    return { s: Math.min(Math.max(s, 0), L), offset: r - curve.radius };
}
/**
 * Attach a family instance to a wall host from a world point
 * ([x plan, y plan, z elevation]). The attachment stores the curve
 * parameter, the elevation above the host base and the offset from
 * the host location line — never the world point itself.
 */
export function attachFamilyToWall(host, point) {
    const { s, offset } = projectPointToWallCurve(host.curve, [point[0], point[1]]);
    const elevation = point[2] - host.baseZ;
    if (elevation < -TOL || elevation > host.height + TOL) {
        throw new Error(`attachFamilyToWall: elevation ${elevation.toFixed(3)} is outside the host height [0, ${host.height.toFixed(3)}]`);
    }
    return {
        hostId: host.id,
        hostKind: "wall",
        s,
        elevation: Math.min(Math.max(elevation, 0), host.height),
        offset,
        hostVersion: host.version,
    };
}
function validateFaceHost(host) {
    if (!isUnit(host.normal))
        throw new Error("attachFamilyToFace: host normal must be a unit vector");
    if (!isUnit(host.uAxis))
        throw new Error("attachFamilyToFace: host uAxis must be a unit vector");
    if (Math.abs(dot(host.normal, host.uAxis)) > 1e-6) {
        throw new Error("attachFamilyToFace: host normal and uAxis must be perpendicular");
    }
    // vAxis = uAxis x normal: v increases upward on a vertical face.
    return cross(host.uAxis, host.normal);
}
/**
 * Attach a family instance to a planar face host from a world point.
 * The attachment stores (u, v) on the face plus the offset along its
 * normal. Throws when the point is outside the face bounds.
 */
export function attachFamilyToFace(host, point) {
    const vAxis = validateFaceHost(host);
    const rel = [
        point[0] - host.origin[0],
        point[1] - host.origin[1],
        point[2] - host.origin[2],
    ];
    const u = dot(rel, host.uAxis);
    const v = dot(rel, vAxis);
    const offset = dot(rel, host.normal);
    if (u < host.uMin - TOL || u > host.uMax + TOL) {
        throw new Error(`attachFamilyToFace: u=${u.toFixed(3)} is outside the face [${host.uMin}, ${host.uMax}]`);
    }
    if (v < host.vMin - TOL || v > host.vMax + TOL) {
        throw new Error(`attachFamilyToFace: v=${v.toFixed(3)} is outside the face [${host.vMin}, ${host.vMax}]`);
    }
    return {
        hostId: host.id,
        hostKind: "face",
        u: Math.min(Math.max(u, host.uMin), host.uMax),
        v: Math.min(Math.max(v, host.vMin), host.vMax),
        offset,
        hostVersion: host.version,
    };
}
/**
 * Re-derive a hosted instance's world placement from its attachment
 * and the host's CURRENT geometry. This is the only place a hosted
 * placement comes from: callers must never cache the world point.
 */
export function hostedFamilyPlacement(host, attachment) {
    if (host.id !== attachment.hostId) {
        throw new Error(`hostedFamilyPlacement: attachment belongs to host "${attachment.hostId}", not "${host.id}"`);
    }
    if (host.kind !== attachment.hostKind) {
        throw new Error(`hostedFamilyPlacement: attachment kind "${attachment.hostKind}" does not match host kind "${host.kind}"`);
    }
    if (host.kind === "wall" && attachment.hostKind === "wall") {
        if (!Number.isFinite(attachment.s) || !Number.isFinite(attachment.elevation) || !Number.isFinite(attachment.offset)) {
            throw new Error("hostedFamilyPlacement: wall attachment has a non-finite s, elevation or offset");
        }
        const frame = hostFrameWithLayers(host.curve, attachment.s, attachment.offset);
        return {
            point: frame.position,
            elevation: host.baseZ + attachment.elevation,
            rotation: deg(Math.atan2(frame.normal[1], frame.normal[0])),
            normal: [frame.normal[0], frame.normal[1], 0],
        };
    }
    if (host.kind === "face" && attachment.hostKind === "face") {
        if (!Number.isFinite(attachment.u) || !Number.isFinite(attachment.v) || !Number.isFinite(attachment.offset)) {
            throw new Error("hostedFamilyPlacement: face attachment has a non-finite u, v or offset");
        }
        const vAxis = validateFaceHost(host);
        const p = [
            host.origin[0] + attachment.u * host.uAxis[0] + attachment.v * vAxis[0] + attachment.offset * host.normal[0],
            host.origin[1] + attachment.u * host.uAxis[1] + attachment.v * vAxis[1] + attachment.offset * host.normal[1],
            host.origin[2] + attachment.u * host.uAxis[2] + attachment.v * vAxis[2] + attachment.offset * host.normal[2],
        ];
        // A vertical face is faced along its normal; a horizontal face
        // (floor/ceiling) is oriented along its u-axis.
        const rotation = Math.abs(host.normal[2]) < 0.5
            ? deg(Math.atan2(host.normal[1], host.normal[0]))
            : deg(Math.atan2(host.uAxis[1], host.uAxis[0]));
        return { point: [p[0], p[1]], elevation: p[2], rotation, normal: host.normal };
    }
    throw new Error("hostedFamilyPlacement: unreachable host/attachment combination");
}
/** Validate that an attachment still fits a host (anchor in range). */
export function validateAttachment(host, attachment) {
    if (host.id !== attachment.hostId)
        return `attachment belongs to host "${attachment.hostId}", not "${host.id}"`;
    if (host.kind !== attachment.hostKind)
        return `attachment kind "${attachment.hostKind}" does not match host kind "${host.kind}"`;
    try {
        hostedFamilyPlacement(host, attachment);
    }
    catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
    if (host.kind === "wall" && attachment.hostKind === "wall") {
        const L = hostLength(host.curve);
        if (attachment.s < -TOL || attachment.s > L + TOL) {
            return `s=${attachment.s.toFixed(3)} is outside the edited host [0, ${L.toFixed(3)}]`;
        }
        if (attachment.elevation < -TOL || attachment.elevation > host.height + TOL) {
            return `elevation ${attachment.elevation.toFixed(3)} exceeds the edited host height ${host.height.toFixed(3)}`;
        }
    }
    if (host.kind === "face" && attachment.hostKind === "face") {
        if (attachment.u < host.uMin - TOL || attachment.u > host.uMax + TOL) {
            return `u=${attachment.u.toFixed(3)} is outside the edited face [${host.uMin}, ${host.uMax}]`;
        }
        if (attachment.v < host.vMin - TOL || attachment.v > host.vMax + TOL) {
            return `v=${attachment.v.toFixed(3)} is outside the edited face [${host.vMin}, ${host.vMax}]`;
        }
    }
    return null;
}
/**
 * Re-evaluate hosted family attachments after a host edit. Attachments
 * keep their host parameters (s / u, v) — the dependent follows the
 * host's parametric position. Attachments that no longer fit are
 * reported invalid; a deleted host (`next: null`) invalidates all of
 * them. Nothing is silently dropped.
 */
export function evaluateHostedFamiliesAfterHostChange(previous, next, attachments) {
    if (!next) {
        return {
            kind: "host-deleted",
            moved: [],
            invalid: attachments.map((a) => ({
                attachment: a,
                reason: `host "${a.hostId}" was deleted`,
            })),
            version: 0,
        };
    }
    const changed = JSON.stringify(stripVersion(previous)) !== JSON.stringify(stripVersion(next));
    const heightChanged = previous.kind === "wall" && next.kind === "wall" &&
        Math.abs(previous.height - next.height) > TOL;
    const kind = !changed
        ? "unchanged"
        : next.kind === "face"
            ? "face-change"
            : heightChanged && JSON.stringify(previous.curve) === JSON.stringify(next.curve)
                ? "height-change"
                : "curve-edit";
    const moved = [];
    const invalid = [];
    for (const a of attachments) {
        const reason = validateAttachment(next, a);
        if (reason) {
            invalid.push({ attachment: a, reason });
            continue;
        }
        try {
            moved.push({ attachment: a, placement: hostedFamilyPlacement(next, a) });
        }
        catch (err) {
            invalid.push({ attachment: a, reason: err instanceof Error ? err.message : String(err) });
        }
    }
    return { kind, moved, invalid, version: next.version };
}
function stripVersion(host) {
    const { version: _v, ...rest } = host;
    return rest;
}
// ── Element wiring ─────────────────────────────────────────────────────────
/**
 * Apply a derived placement to an element: host link, stored
 * attachment (a copy — the element owns its parameters) and the
 * world placement the host currently implies. Returns true when
 * anything changed.
 */
export function applyHostPlacementToElement(element, attachment, placement) {
    let changed = false;
    if (element.hostId !== attachment.hostId) {
        element.hostId = attachment.hostId;
        changed = true;
    }
    const prev = element.hostAttachment;
    if (JSON.stringify(prev ?? null) !== JSON.stringify(attachment)) {
        element.hostAttachment = { ...attachment };
        changed = true;
    }
    const p = element.params;
    if (!p.point || p.point[0] !== placement.point[0] || p.point[1] !== placement.point[1]) {
        p.point = [...placement.point];
        changed = true;
    }
    if (p.elevation !== placement.elevation) {
        p.elevation = placement.elevation;
        changed = true;
    }
    if (p.rotation !== placement.rotation) {
        p.rotation = placement.rotation;
        changed = true;
    }
    return changed;
}
/** Remove a host link from an element. Returns true when one was present. */
export function detachFamilyFromHost(element) {
    if (!element.hostId && !element.hostAttachment)
        return false;
    delete element.hostId;
    delete element.hostAttachment;
    return true;
}
/**
 * Audit every hosted element against the current hosts: orphaned when
 * its host is gone, invalid when its attachment no longer fits the
 * host, stale when the host has a newer geometry version than the
 * attachment was computed against (placement should be re-derived).
 */
export function auditHostedFamilies(elements, hostsById) {
    const hosted = elements.filter((e) => e.hostAttachment ?? e.hostId);
    const lookup = (id) => hostsById instanceof Map ? hostsById.get(id) : hostsById[id];
    const audit = { total: hosted.length, orphaned: [], invalid: [], stale: [] };
    for (const el of hosted) {
        const hostId = el.hostAttachment?.hostId ?? el.hostId;
        if (!hostId)
            continue;
        const host = lookup(hostId);
        if (!host) {
            audit.orphaned.push({
                elementId: el.id,
                hostId,
                code: "orphaned",
                severity: "error",
                message: `host "${hostId}" does not exist`,
            });
            continue;
        }
        if (el.hostAttachment) {
            const reason = validateAttachment(host, el.hostAttachment);
            if (reason) {
                audit.invalid.push({
                    elementId: el.id,
                    hostId,
                    code: "invalid",
                    severity: "error",
                    message: reason,
                });
                continue;
            }
            if (el.hostAttachment.hostVersion !== host.version) {
                audit.stale.push({
                    elementId: el.id,
                    hostId,
                    code: "stale-version",
                    severity: "warning",
                    message: `host "${hostId}" is at version ${host.version}, attachment was computed against ${el.hostAttachment.hostVersion}`,
                });
            }
        }
    }
    return audit;
}
// ── Host geometry from authored elements ───────────────────────────────────
// The ribbon hosting dialog (and the authoring rebuild) derive the host
// geometry from the LIVE authored element — never from a cached copy —
// so a host edit is visible to the next attach / rehost with no extra
// bookkeeping. Version is always 1 here: the caller that tracks host
// edits (authoring.ts, last-seen snapshots) owns version bumps.
/** Build a wall host geometry from an authored wall element. Null when
 *  the element is not a wall with a plan curve. */
export function wallHostGeometryFromElement(el) {
    const p = el.params;
    if (el.type !== "wall" || !p?.start || !p?.end)
        return null;
    return {
        id: el.id,
        kind: "wall",
        curve: {
            kind: "line",
            start: [...p.start],
            end: [...p.end],
        },
        baseZ: typeof p.elevation === "number" ? p.elevation : 0,
        height: typeof p.height === "number" ? p.height : 3,
        version: 1,
        thickness: typeof p.thickness === "number" ? p.thickness : 0.2,
    };
}
/**
 * Build a face host geometry from an authored element. A wall contributes
 * its normal-side face (the plane through the location line offset by half
 * the thickness along the host normal; u runs along the wall, v runs up
 * from the base). A slab contributes its top face (u along the first edge,
 * origin at the corner (u, v) runs from, bounds from the polygon extent).
 * Null when the element offers no face.
 */
export function faceHostGeometryFromElement(el) {
    const p = el.params;
    if (el.type === "wall" && p?.start && p?.end) {
        const [ax, ay] = p.start;
        const [bx, by] = p.end;
        const dx = bx - ax, dy = by - ay;
        const L = Math.hypot(dx, dy);
        if (L < TOL)
            return null;
        const tx = dx / L, ty = dy / L;
        // Left of the tangent — the host normal (same convention as
        // projectPointToWallCurve's offset sign).
        const nx = -ty, ny = tx;
        const half = (typeof p.thickness === "number" ? p.thickness : 0.2) / 2;
        const baseZ = typeof p.elevation === "number" ? p.elevation : 0;
        const height = typeof p.height === "number" ? p.height : 3;
        return {
            id: el.id,
            kind: "face",
            origin: [ax + nx * half, ay + ny * half, baseZ],
            normal: [nx, ny, 0],
            uAxis: [tx, ty, 0],
            uMin: 0,
            uMax: L,
            vMin: 0,
            vMax: height,
            version: 1,
        };
    }
    if (el.type === "slab" && Array.isArray(p?.polygon) && p.polygon.length >= 3) {
        const poly = p.polygon;
        const [x0, y0] = poly[0];
        const [x1, y1] = poly[1];
        let ux = x1 - x0, uy = y1 - y0;
        const len = Math.hypot(ux, uy);
        if (len < TOL)
            return null;
        ux /= len;
        uy /= len;
        const uAxis = [ux, uy, 0];
        const normal = [0, 0, 1];
        // vAxis = uAxis x normal (same convention as validateFaceHost).
        const vAxis = cross(uAxis, normal);
        const top = (typeof p.elevation === "number" ? p.elevation : 0)
            + (typeof p.height === "number" ? p.height : 0.2);
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const [x, y] of poly) {
            const rx = x - x0, ry = y - y0;
            const u = rx * ux + ry * uy;
            const v = rx * vAxis[0] + ry * vAxis[1];
            if (u < uMin)
                uMin = u;
            if (u > uMax)
                uMax = u;
            if (v < vMin)
                vMin = v;
            if (v > vMax)
                vMax = v;
        }
        // Shift the origin to the corner (u, v) runs from, so the bounds
        // start at 0 — the same convention as the module's floor fixture
        // (origin at the far edge when v runs back toward it).
        return {
            id: el.id,
            kind: "face",
            origin: [x0 + uMin * ux + vMin * vAxis[0], y0 + uMin * uy + vMin * vAxis[1], top],
            normal,
            uAxis,
            uMin: 0,
            uMax: uMax - uMin,
            vMin: 0,
            vMax: vMax - vMin,
            version: 1,
        };
    }
    return null;
}
/** Derive the host geometry of the requested kind from an authored element. */
export function hostGeometryFromElement(el, kind) {
    return kind === "wall"
        ? wallHostGeometryFromElement(el)
        : faceHostGeometryFromElement(el);
}
/**
 * Host-geometry equality ignoring the version stamp (Slice 9 convention:
 * the host-change kind is computed from the geometry diff, not the
 * version bump).
 */
export function hostGeometryEquals(a, b) {
    if (a.id !== b.id || a.kind !== b.kind)
        return false;
    return JSON.stringify(stripVersion(a)) === JSON.stringify(stripVersion(b));
}
export const familyHostingService = {
    attachToWall: attachFamilyToWall,
    attachToFace: attachFamilyToFace,
    placement: hostedFamilyPlacement,
    validateAttachment,
    evaluateAfterHostChange: evaluateHostedFamiliesAfterHostChange,
    applyToElement: applyHostPlacementToElement,
    detach: detachFamilyFromHost,
    audit: auditHostedFamilies,
};
void {};
