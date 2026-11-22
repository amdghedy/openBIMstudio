"use strict";
/**
 * Selection engine — MODIFY GROUP 1 spec §2 (docs/MODIFY_GROUP1_SPEC_V71.md).
 *
 * Implements the uploaded Modify design spec §4.1: hit-testing with
 * deterministic overlap priority, window/crossing selection, category /
 * type / parameter / id selection, inversion, hosted / connected /
 * dependent / related expansion, and the hidden / pinned / read-only /
 * linked-model behavioral rules.
 *
 * Discipline: selection is authoritative-input bookkeeping only — it
 * NEVER mutates element data. Pinned and read-only elements ARE
 * selectable (so the user can select then unpin); edit commands reject
 * them at CanExecute.
 *
 * Diagnostic codes: MOD-SEL-nnn (spec §2.6).
 * Pure module: no DOM — safe to unit-test in Node.
 *
 * Boundary (hardening item 20): this engine selects AUTHORED elements
 * (string ids + plan geometry) for the Selection Inspector dialog in
 * src/features/engine-ui.ts — its only live consumer. It is NOT the live
 * viewport selection, which is the SelectionManager in
 * src/features/selection.ts (fragment modelId/localId, highlighter
 * bridge, click-to-select, registered as the services SelectionService).
 * The two share the word "selection" but serve disjoint element
 * universes; neither subsumes the other, so neither may be deleted as
 * "the duplicate". Which copy runs where is pinned by
 * tests/selection-generations.test.cjs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SelectionEngine = exports.DEFAULT_SELECTION_FILTER = exports.DATUM_CATEGORIES = exports.HIT_PRIORITY = void 0;
/** Base priorities — spec §2.2 table (E-M1-01): vertex > edge > connector > datum > body. */
exports.HIT_PRIORITY = {
    vertex: 100,
    edge: 90,
    connector: 70,
    datum: 60,
    body: 40,
};
/** Category ids treated as datum elements for hit-testing. */
exports.DATUM_CATEGORIES = new Set([
    "levels", "grids", "reference-planes",
]);
exports.DEFAULT_SELECTION_FILTER = {
    categories: [],
    typeIds: [],
    includePinned: true,
    includeHidden: false,
    includeLinkedModels: false,
    selectWholeGroups: true,
};
// ── Geometry helpers ─────────────────────────────────────────────────────
function dist2(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return dx * dx + dy * dy;
}
/** Squared distance from p to segment ab, plus nearest-point parameter. */
function dist2ToSegment(p, a, b) {
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-18)
        return { d2: dist2(p, a), t: 0 };
    let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = a[0] + t * abx;
    const qy = a[1] + t * aby;
    return { d2: dist2(p, [qx, qy]), t };
}
function pointInAabb(p, aabb) {
    return (p[0] >= aabb.min[0] && p[0] <= aabb.max[0] &&
        p[1] >= aabb.min[1] && p[1] <= aabb.max[1]);
}
function aabbOverlapsRect(aabb, a, b) {
    const minx = Math.min(a[0], b[0]);
    const maxx = Math.max(a[0], b[0]);
    const miny = Math.min(a[1], b[1]);
    const maxy = Math.max(a[1], b[1]);
    return !(aabb.max[0] < minx || aabb.min[0] > maxx ||
        aabb.max[1] < miny || aabb.min[1] > maxy);
}
function aabbInsideRect(aabb, a, b) {
    const minx = Math.min(a[0], b[0]);
    const maxx = Math.max(a[0], b[0]);
    const miny = Math.min(a[1], b[1]);
    const maxy = Math.max(a[1], b[1]);
    return (aabb.min[0] >= minx && aabb.max[0] <= maxx &&
        aabb.min[1] >= miny && aabb.max[1] <= maxy);
}
function insideRect(p, a, b) {
    const minx = Math.min(a[0], b[0]);
    const maxx = Math.max(a[0], b[0]);
    const miny = Math.min(a[1], b[1]);
    const maxy = Math.max(a[1], b[1]);
    return p[0] >= minx && p[0] <= maxx && p[1] >= miny && p[1] <= maxy;
}
function curveAabb(c) {
    return {
        min: [Math.min(c.start[0], c.end[0]), Math.min(c.start[1], c.end[1])],
        max: [Math.max(c.start[0], c.end[0]), Math.max(c.start[1], c.end[1])],
    };
}
class SelectionEngine {
    deps;
    filter = { ...exports.DEFAULT_SELECTION_FILTER };
    selection = [];
    diagnostics = [];
    lastHit = null;
    constructor(deps) {
        this.deps = deps;
    }
    // ── filter ──
    SetFilter(f) {
        this.filter = { ...this.filter, ...f };
    }
    GetFilter() {
        return { ...this.filter };
    }
    // ── diagnostics ──
    GetDiagnostics() {
        return [...this.diagnostics];
    }
    diag(severity, code, message, elementIds = []) {
        this.diagnostics.push({ severity, code, message, elementIds });
    }
    // ── visibility / eligibility (spec §2.4) ──
    isSelectable(el) {
        if (this.filter.categories.length && !this.filter.categories.includes(el.categoryId))
            return false;
        if (this.filter.typeIds.length && (!el.typeId || !this.filter.typeIds.includes(el.typeId)))
            return false;
        if (el.hidden && !this.filter.includeHidden)
            return false;
        if (el.linkedModel && !this.filter.includeLinkedModels)
            return false;
        if (el.pinned && !this.filter.includePinned)
            return false;
        return true;
    }
    // ── hit-testing (spec §2.2) ──
    HitTest(p, pickRadius = 0.05) {
        if (!(pickRadius > 0)) {
            this.diag("error", "MOD-SEL-006", `degenerate pick radius ${pickRadius}`);
            return null;
        }
        const r2 = pickRadius * pickRadius;
        const hits = [];
        for (const el of this.deps.elements()) {
            if (!this.isSelectable(el))
                continue;
            const isDatum = exports.DATUM_CATEGORIES.has(el.categoryId);
            // vertex + edge hits: curve endpoints and segment
            if (el.curve) {
                const eps = [el.curve.start, el.curve.end];
                for (let i = 0; i < 2; i++) {
                    const d2 = dist2(p, eps[i]);
                    if (d2 <= r2) {
                        hits.push({ elementId: el.id, subKind: "vertex", priority: exports.HIT_PRIORITY.vertex, distance: Math.sqrt(d2), featureIndex: i });
                    }
                }
                const seg = dist2ToSegment(p, el.curve.start, el.curve.end);
                if (seg.d2 <= r2) {
                    hits.push({ elementId: el.id, subKind: "edge", priority: exports.HIT_PRIORITY.edge, distance: Math.sqrt(seg.d2) });
                }
            }
            if (el.point) {
                const d2 = dist2(p, el.point);
                if (d2 <= r2) {
                    hits.push({ elementId: el.id, subKind: isDatum ? "datum" : "vertex", priority: isDatum ? exports.HIT_PRIORITY.datum : exports.HIT_PRIORITY.vertex, distance: Math.sqrt(d2) });
                }
            }
            if (this.deps.connectorPositions) {
                for (const cp of this.deps.connectorPositions(el.id) ?? []) {
                    const d2 = dist2(p, cp);
                    if (d2 <= r2) {
                        hits.push({ elementId: el.id, subKind: "connector", priority: exports.HIT_PRIORITY.connector, distance: Math.sqrt(d2) });
                    }
                }
            }
            // body: containment in aabb
            if (el.aabb && pointInAabb(p, el.aabb)) {
                hits.push({ elementId: el.id, subKind: "body", priority: exports.HIT_PRIORITY.body, distance: 0 });
            }
        }
        if (!hits.length) {
            this.diag("info", "MOD-SEL-001", `no element at pick point (${p[0]}, ${p[1]})`);
            return null;
        }
        hits.sort((x, y) => (y.priority - x.priority) ||
            (x.distance - y.distance) ||
            (x.elementId < y.elementId ? -1 : x.elementId > y.elementId ? 1 : 0));
        return hits[0];
    }
    SelectSingle(p, pickRadius = 0.05) {
        const hit = this.HitTest(p, pickRadius);
        if (!hit) {
            this.selection = [];
            return null;
        }
        this.applySelectionRules([hit.elementId]);
        this.lastHit = hit;
        return hit;
    }
    GetLastHit() {
        return this.lastHit ? { ...this.lastHit } : null;
    }
    // ── window / crossing (spec §2.3) ──
    SelectWindow(a, b, mode) {
        const picked = [];
        for (const el of this.deps.elements()) {
            if (!this.isSelectable(el))
                continue;
            let hit;
            if (el.aabb) {
                hit = mode === "inside" ? aabbInsideRect(el.aabb, a, b) : aabbOverlapsRect(el.aabb, a, b);
            }
            else if (el.curve) {
                hit = mode === "inside"
                    ? insideRect(el.curve.start, a, b) && insideRect(el.curve.end, a, b)
                    : aabbOverlapsRect(curveAabb(el.curve), a, b);
            }
            else if (el.point) {
                hit = insideRect(el.point, a, b);
            }
            else {
                hit = false;
            }
            if (hit)
                picked.push(el.id);
        }
        this.applySelectionRules(picked);
        return [...this.selection];
    }
    // ── filtered scans (spec §2.3) ──
    SelectByCategory(categories) {
        const picked = this.deps.elements()
            .filter((el) => this.isSelectable(el) && categories.includes(el.categoryId))
            .map((el) => el.id);
        this.applySelectionRules(picked);
        return [...this.selection];
    }
    SelectByType(typeId) {
        const picked = this.deps.elements()
            .filter((el) => this.isSelectable(el) && el.typeId === typeId)
            .map((el) => el.id);
        this.applySelectionRules(picked);
        return [...this.selection];
    }
    SelectByParameter(pred) {
        const picked = this.deps.elements()
            .filter((el) => this.isSelectable(el) && el.params && pred(el.params))
            .map((el) => el.id);
        this.applySelectionRules(picked);
        return [...this.selection];
    }
    SelectByIds(ids) {
        const known = new Set(this.deps.elements().map((el) => el.id));
        const missing = ids.filter((id) => !known.has(id));
        if (missing.length) {
            this.diag("info", "MOD-SEL-004", `select-by-id: unknown ids ignored: ${missing.join(", ")}`, missing);
        }
        this.applySelectionRules(ids.filter((id) => known.has(id)));
        return [...this.selection];
    }
    Invert() {
        const visible = this.deps.elements()
            .filter((el) => this.isSelectable(el))
            .map((el) => el.id);
        const current = new Set(this.selection);
        this.applySelectionRules(visible.filter((id) => !current.has(id)));
        return [...this.selection];
    }
    // ── multi-selection bookkeeping (spec §2.3) ──
    AddToSelection(id) {
        if (!this.selection.includes(id))
            this.selection.push(id);
    }
    RemoveFromSelection(id) {
        this.selection = this.selection.filter((x) => x !== id);
    }
    ToggleSelection(id) {
        if (this.selection.includes(id))
            this.RemoveFromSelection(id);
        else
            this.AddToSelection(id);
    }
    Clear() {
        this.selection = [];
        this.diagnostics = [];
        this.lastHit = null;
    }
    GetSelection() {
        return [...this.selection];
    }
    // ── relationship-driven expansion (spec §2.4) ──
    ExpandHosted(id) {
        const out = [];
        // direct hostedOnId links
        for (const el of this.deps.elements()) {
            if (el.hostedOnId === id)
                out.push(el.id);
        }
        // registry records (host / attachment kinds)
        const reg = this.deps.relationships;
        if (reg) {
            for (const rec of reg.queryRelationships({ elementId: id })) {
                const other = rec.source.elementId === id ? rec.target.elementId : rec.source.elementId;
                const hostKind = rec.type === "host" || rec.type === "face-attachment" || rec.type === "rigid-attachment";
                if (hostKind && other !== id && !out.includes(other)) {
                    out.push(other);
                }
            }
        }
        for (const x of out)
            this.AddToSelection(x);
        return out;
    }
    ExpandConnected(id) {
        const reg = this.deps.relationships;
        const out = [];
        if (reg) {
            for (const rec of reg.queryRelationships({ elementId: id })) {
                const other = rec.source.elementId === id ? rec.target.elementId : rec.source.elementId;
                if (other !== id && !out.includes(other))
                    out.push(other);
            }
        }
        for (const x of out)
            this.AddToSelection(x);
        return out;
    }
    ExpandDependents(id) {
        return this.ExpandHosted(id);
    }
    ExpandRelated(id) {
        return this.ExpandConnected(id);
    }
    // ── internal ──
    /**
     * Selection rules: group expansion (selectWholeGroups), pinned /
     * read-only / hidden-force warnings (spec §2.4).
     */
    applySelectionRules(ids) {
        const byId = new Map(this.deps.elements().map((el) => [el.id, el]));
        const final = [];
        const seen = new Set();
        const push = (id) => {
            if (seen.has(id))
                return;
            const el = byId.get(id);
            if (!el)
                return;
            // visibility/eligibility filter applies to EVERY selection path
            // (hit-test, window, scan, by-id) — spec §2.4
            if (!this.isSelectable(el))
                return;
            seen.add(id);
            final.push(id);
            if (el.pinned) {
                this.diag("warning", "MOD-SEL-002", `element '${id}' is pinned (edits will be rejected)`, [id]);
            }
            if (!el.editable || el.linkedModel) {
                this.diag("warning", "MOD-SEL-003", `element '${id}' is read-only${el.linkedModel ? " (linked model)" : ""}`, [id]);
            }
            if (el.hidden) {
                this.diag("warning", "MOD-SEL-005", `element '${id}' is hidden (force-selected via filter override)`, [id]);
            }
        };
        for (const id of ids)
            push(id);
        if (this.filter.selectWholeGroups) {
            const groupIds = new Set();
            for (const id of ids) {
                const el = byId.get(id);
                if (el?.groupId) {
                    for (const other of this.deps.elements()) {
                        if (other.groupId === el.groupId && this.isSelectable(other))
                            groupIds.add(other.id);
                    }
                }
            }
            for (const id of groupIds)
                push(id);
        }
        this.selection = final;
    }
}
exports.SelectionEngine = SelectionEngine;
