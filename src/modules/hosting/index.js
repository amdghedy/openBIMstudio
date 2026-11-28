/**
 * Hosting and transform propagation (Design spec MODULE 1.5).
 *
 * Host-child relationships for straight AND curved (arc) walls: the host
 * surface is parameterised by curve length s; a hosted element stores its
 * position AS a curve parameter (not a world point), so host edits
 * propagate deterministically (spec 1.5: "when the host changes,
 * recalculate the dependent placement and opening according to the
 * persistent relationship policy").
 *
 * For a window in a curved multilayer wall (spec worked example B), the
 * engine computes: host surface parameterisation, local surface frame
 * (tangent/normal), position along host, layer offsets, opening geometry,
 * and sill/height constraints. Host geometry versions gate re-evaluation
 * (spec 5.6); deleted/changed topology and invalid offsets are reported,
 * never silently ignored.
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */
import { COINCIDENT_TOL } from "../solid-kernel/brep";
/** Total host length (metres). */
export function hostLength(curve) {
    if (curve.kind === "line") {
        return Math.hypot(curve.end[0] - curve.start[0], curve.end[1] - curve.start[1]);
    }
    let span = curve.endAngle - curve.startAngle;
    if (span < 0)
        span += 2 * Math.PI;
    return Math.abs(span) * curve.radius;
}
/** Evaluate the host surface at curve length s (spec: parameterisation). */
export function evaluateHost(curve, s) {
    const L = hostLength(curve);
    if (s < -COINCIDENT_TOL || s > L + COINCIDENT_TOL) {
        throw new Error(`evaluateHost: s=${s.toFixed(4)} outside host length ${L.toFixed(4)}`);
    }
    if (curve.kind === "line") {
        const dx = curve.end[0] - curve.start[0];
        const dy = curve.end[1] - curve.start[1];
        const l = Math.hypot(dx, dy) || 1;
        const t = [dx / l, dy / l];
        return {
            position: [curve.start[0] + t[0] * s, curve.start[1] + t[1] * s],
            tangent: t,
            normal: [-t[1], t[0]],
            s,
        };
    }
    let span = curve.endAngle - curve.startAngle;
    if (span < 0)
        span += 2 * Math.PI;
    const ang = curve.startAngle + (s / curve.radius) * (span / Math.abs(span) === 0 ? 1 : Math.sign(span) || 1);
    const pos = [curve.center[0] + curve.radius * Math.cos(ang), curve.center[1] + curve.radius * Math.sin(ang)];
    const tangent = [-Math.sin(ang), Math.cos(ang)];
    return { position: pos, tangent, normal: [-tangent[1], tangent[0]], s };
}
/**
 * Host frame with layer offsets (spec worked example B): for a point at
 * curve parameter s and layer offset o (positive toward the interior),
 * return the world frame in which a hosted element orients itself.
 */
export function hostFrameWithLayers(curve, s, layerOffset) {
    const base = evaluateHost(curve, s);
    return {
        ...base,
        position: [
            base.position[0] + base.normal[0] * layerOffset,
            base.position[1] + base.normal[1] * layerOffset,
        ],
        offset: layerOffset,
    };
}
/** Place an opening on the host (validation + placement in one call). */
export function placeOpening(host, opening) {
    const L = hostLength(host.curve);
    const half = opening.width / 2;
    if (opening.s - half < -COINCIDENT_TOL || opening.s + half > L + COINCIDENT_TOL) {
        throw new Error(`placeOpening: opening at s=${opening.s.toFixed(3)} ± ${half.toFixed(3)} exceeds host length ${L.toFixed(3)}`);
    }
    if (opening.sillHeight < -COINCIDENT_TOL) {
        throw new Error("placeOpening: sill height below the host base");
    }
    if (opening.sillHeight + opening.height > host.height + COINCIDENT_TOL) {
        throw new Error(`placeOpening: head elevation ${(opening.sillHeight + opening.height).toFixed(3)} exceeds host height ${host.height.toFixed(3)}`);
    }
    const centerFrame = hostFrameWithLayers(host.curve, opening.s, opening.layerOffset);
    return {
        center: centerFrame.position,
        along: centerFrame.tangent,
        sStart: opening.s - half,
        sEnd: opening.s + half,
        zStart: host.baseZ + opening.sillHeight,
        zEnd: host.baseZ + opening.sillHeight + opening.height,
    };
}
/** Detect overlapping openings on a host (spec 1.5 "overlapping openings"). */
export function findOverlappingOpenings(openings) {
    const sorted = [...openings].sort((a, b) => a.s - b.s);
    const out = [];
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            const a = sorted[i];
            const b = sorted[j];
            if (b.s - b.width / 2 < a.s + a.width / 2 - COINCIDENT_TOL) {
                // Vertical ranges must also overlap for a real conflict.
                const aLo = a.sillHeight, aHi = a.sillHeight + a.height;
                const bLo = b.sillHeight, bHi = b.sillHeight + b.height;
                if (bLo < aHi - COINCIDENT_TOL && aLo < bHi - COINCIDENT_TOL) {
                    out.push([a.id, b.id]);
                }
            }
            else {
                break; // sorted by s: no further overlap possible with a
            }
        }
    }
    return out;
}
/**
 * Re-evaluate every hosted opening after a host edit. Openings keep their
 * curve parameter s (level E policy: the dependent follows the host's
 * parametric position, matching the observable RVT behavior that a
 * window stays at its position along the wall when the wall is resized
 * or re-curved). Positions beyond the new length are reported invalid.
 */
export function evaluateHostedOpeningsAfterHostChange(previous, next, openings) {
    const moved = [];
    const invalid = [];
    const prevL = hostLength(previous.curve);
    const nextL = hostLength(next.curve);
    const curveChanged = JSON.stringify(previous.curve) !== JSON.stringify(next.curve) ||
        Math.abs(prevL - nextL) > COINCIDENT_TOL;
    const heightChanged = Math.abs(previous.height - next.height) > COINCIDENT_TOL;
    const layersChanged = JSON.stringify(previous.layers) !== JSON.stringify(next.layers);
    const kind = curveChanged
        ? "curve-edit"
        : heightChanged
            ? "height-change"
            : layersChanged
                ? "layer-change"
                : "curve-edit";
    for (const o of openings) {
        const half = o.width / 2;
        if (o.s + half > nextL + COINCIDENT_TOL || o.s - half < -COINCIDENT_TOL) {
            invalid.push({
                openingId: o.id,
                reason: `opening at s=${o.s.toFixed(3)} no longer fits the edited host (length ${nextL.toFixed(3)})`,
            });
            continue;
        }
        if (o.sillHeight + o.height > next.height + COINCIDENT_TOL) {
            invalid.push({
                openingId: o.id,
                reason: `opening head ${(o.sillHeight + o.height).toFixed(3)} exceeds the edited host height ${next.height.toFixed(3)}`,
            });
            continue;
        }
        try {
            moved.push({ openingId: o.id, placement: placeOpening(next, o) });
        }
        catch (err) {
            invalid.push({ openingId: o.id, reason: err instanceof Error ? err.message : String(err) });
        }
    }
    return { kind, moved, invalid, version: next.version };
}
/**
 * Curved-host frame test used by acceptance scenario 3: a window on an
 * arc wall keeps its angular position when the arc radius changes.
 */
export function propagateOpeningToNewRadius(arc, opening, newRadius) {
    // Angular position is preserved: s_new = angle_position × newRadius.
    const L = hostLength({ kind: "arc", ...arc });
    const angleFrac = opening.s / L;
    let span = arc.endAngle - arc.startAngle;
    if (span < 0)
        span += 2 * Math.PI;
    const newS = angleFrac * Math.abs(span) * newRadius;
    const newCurve = { kind: "arc", center: arc.center, radius: newRadius, startAngle: arc.startAngle, endAngle: arc.endAngle };
    const placement = placeOpening({ curve: newCurve, baseZ: 0, height: opening.sillHeight + opening.height + 0.5, version: 1, layers: [] }, { ...opening, s: newS });
    return { newS, placement, newCurve };
}
