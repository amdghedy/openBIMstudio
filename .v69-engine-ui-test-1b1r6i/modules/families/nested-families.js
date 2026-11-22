"use strict";
/**
 * Nested family resolution.
 *
 * A nested family is a FamilyDefinition embedded inside another family's
 * geometry tree (kind: "nested"). Parameter maps bind parent parameters
 * (or constants) onto the child's instance overrides - the same model
 * BIM uses for nested shared / non-shared families.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveNested = resolveNested;
exports.collectNestedFamilyIds = collectNestedFamilyIds;
exports.collectSchedulableInstances = collectSchedulableInstances;
function resolveRef(ref, parentParams) {
    if (typeof ref === "string") {
        return parentParams[ref];
    }
    if ("const" in ref)
        return ref.const;
    if ("ref" in ref)
        return parentParams[ref.ref];
    if ("expr" in ref)
        return parentParams[ref.expr];
    return undefined;
}
/**
 * Resolve a nested family reference against parent parameters.
 * Returns null when the target family cannot be found.
 */
function resolveNested(ref, parentParams, familyLookup, typeLookup) {
    const family = familyLookup(ref.familyId);
    if (!family)
        return null;
    const type = ref.typeId && typeLookup
        ? typeLookup(ref.familyId, ref.typeId) ?? null
        : ref.typeId
            ? family.types.find((t) => t.id === ref.typeId) ?? null
            : null;
    const overrides = {};
    if (ref.paramMap) {
        for (const [key, binding] of Object.entries(ref.paramMap)) {
            // Convention: key is the CHILD parameter name.
            overrides[key] = resolveRef(binding, parentParams);
        }
    }
    return {
        family,
        type,
        overrides,
        shared: !!ref.shared,
        label: ref.label ?? family.name,
    };
}
/**
 * Collect every nested family id referenced by a geometry tree (depth-first).
 * Useful for load-order / dependency graphs.
 */
function collectNestedFamilyIds(geometry, out = new Set()) {
    if (!geometry || typeof geometry !== "object")
        return out;
    if (geometry.kind === "nested" && typeof geometry.familyId === "string") {
        out.add(geometry.familyId);
    }
    if (geometry.kind === "composed" && Array.isArray(geometry.parts)) {
        for (const p of geometry.parts)
            collectNestedFamilyIds(p, out);
    }
    if (geometry.kind === "array" && geometry.of) {
        collectNestedFamilyIds(geometry.of, out);
    }
    if (geometry.kind === "conditional") {
        if (geometry.then)
            collectNestedFamilyIds(geometry.then, out);
        if (geometry.else)
            collectNestedFamilyIds(geometry.else, out);
    }
    if (geometry.kind === "void" && geometry.solid) {
        collectNestedFamilyIds(geometry.solid, out);
    }
    return out;
}
function collectSchedulableInstances(root) {
    if (!root || typeof root !== "object")
        return [];
    const rows = [];
    const ud = root.userData ?? {};
    if (typeof ud.familyId === "string") {
        rows.push({
            familyId: ud.familyId,
            typeId: ud.familyTypeId ?? null,
            label: typeof ud.familyName === "string" ? ud.familyName : ud.familyId,
            params: { ...(ud.familyParams ?? {}) },
            shared: false,
        });
    }
    const walk = (node) => {
        for (const child of node.children ?? []) {
            const shared = child.userData?.sharedNested;
            if (shared && typeof shared.familyId === "string") {
                rows.push({
                    familyId: shared.familyId,
                    typeId: shared.typeId ?? null,
                    label: typeof shared.label === "string" ? shared.label : shared.familyId,
                    params: { ...(shared.params ?? {}) },
                    shared: true,
                });
            }
            walk(child);
        }
    };
    walk(root);
    return rows;
}
