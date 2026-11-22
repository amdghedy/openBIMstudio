"use strict";
// openbim-families:parameter-scope
// Parameter-scope enforcement for family type values.
//
// A FamilyType's `values` map may only set parameters declared with
// scope "type". Before this module existed, both resolution paths
// (resolveParametricValues in parametric-engine.ts and resolveParameters
// in registry.ts) applied type.values to every parameter regardless of
// scope, so a type could silently set an instance-scope parameter — and
// the built-in wall/column/beam families relied on exactly that.
//
// Behaviour (deliberate, fail-soft): a type value that targets an
// instance-scope parameter, or a parameter the family does not declare
// at all, is IGNORED and recorded as a warning — never silently applied
// and never fatal. Rejecting (throwing) was considered and rejected:
// family definitions arrive from user files, the seed library and
// localStorage, and a single bad type entry must not make a whole
// family (or project) unloadable. Callers that can surface diagnostics
// should surface the returned warnings; the base service logs them the
// same way it already logs formula errors.
//
// Instance overrides are NOT restricted by this module: an override is,
// by definition, a per-instance value, so it may set any declared
// parameter including a type-scope one. Only the type layer is scoped.
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyTypeValues = applyTypeValues;
/**
 * Filter a type's values to the ones the family's declarations allow.
 * Pure; never mutates the family or the type.
 */
function applyTypeValues(family, type) {
    const applied = {};
    const warnings = [];
    const byName = new Map(family.parameters.map((p) => [p.name, p]));
    for (const [key, value] of Object.entries(type.values ?? {})) {
        const param = byName.get(key);
        if (!param) {
            warnings.push(`type "${type.name}" sets undeclared parameter "${key}" — ignored`);
            continue;
        }
        if (param.scope !== "type") {
            warnings.push(`type "${type.name}" sets ${param.scope}-scope parameter "${key}" — ignored; set it per instance instead`);
            continue;
        }
        applied[key] = value;
    }
    return { applied, warnings };
}
