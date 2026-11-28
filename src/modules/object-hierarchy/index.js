/**
 * Object hierarchy and identity management.
 *
 * Implements Design spec MODULE 2.1 (object hierarchy) and 2.2
 * (identifier management).
 *
 * Storage architecture (spec 2.1 asks for an explicit comparison):
 *   - Pure ECS (all data in component tables) is optimal for bulk iteration
 *     but makes family/type inheritance awkward.
 *   - Pure OO (instance objects own their data) mirrors the UI but duplicates
 *     type data across thousands of instances.
 *   - Pure relational is durable but verbose in TypeScript.
 *   We use a HYBRID (level E): definition tables keyed by id (categories,
 *   families, types, parameter definitions) plus per-instance sparse
 *   override maps. Types are shared structurally — an instance stores only
 *   what differs (spec 2.3 memory efficiency). Geometry definitions are
 *   stored once per family/type and referenced, never copied.
 *
 * Identity (spec 2.2, level E policy):
 *   - elementId: stable integer-style handle, unique within the document,
 *     never reused after deletion.
 *   - uniqueId: UUID (RFC 4122 v4 via crypto when available, deterministic
 *     fallback otherwise), survives copy/paste as a NEW uniqueId (a copy is
 *     a distinct element) but is preserved across undo/redo and save/reload.
 *   - externalId: mapping slot for IFC GUIDs / DWG handles / exchange ids.
 *   - Duplication assigns a fresh elementId and uniqueId and remaps
 *     relationship membership (see relationships module).
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */
// ── Identity (spec 2.2) ──────────────────────────────────────────────────
let cryptoRef = null;
try {
    // Node 19+ and browsers expose crypto.randomUUID.
    cryptoRef = globalThis.crypto ?? null;
}
catch { /* non-secure contexts */ }
/** UUID v4 with a deterministic fallback for non-secure runtimes. */
export function newUniqueId(seed) {
    if (cryptoRef?.randomUUID)
        return cryptoRef.randomUUID();
    let s = seed ?? Date.now();
    const hex = () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s.toString(16).padStart(8, "0").slice(0, 8);
    };
    return `${hex()}-${hex().slice(0, 4)}-4${hex().slice(0, 3)}-a${hex().slice(0, 3)}-${hex()}${hex()}`;
}
/**
 * Identity service (spec 2.2). Element ids are monotonic and never reused;
 * a freed id stays freed. Session handles map 1:1 to element ids in this
 * engine (the document is the session scope).
 */
export class IdentityService {
    nextId = 1;
    freed = 0;
    /** uniqueId -> elementId index (spec 2.2 lookup). */
    byUniqueId = new Map();
    /** Allocate a fresh persistent id. */
    allocateElementId() {
        return `el${this.nextId++}`;
    }
    /** Register the uniqueId of an element (throws on duplicate). */
    registerUniqueId(elementId, uniqueId) {
        const existing = this.byUniqueId.get(uniqueId);
        if (existing && existing !== elementId) {
            throw new Error(`uniqueId '${uniqueId}' already assigned to '${existing}'`);
        }
        this.byUniqueId.set(uniqueId, elementId);
    }
    findByUniqueId(uniqueId) {
        return this.byUniqueId.get(uniqueId) ?? null;
    }
    forgetUniqueId(uniqueId) {
        this.byUniqueId.delete(uniqueId);
        this.freed++;
    }
    /** Identity stats (diagnostics/tests). */
    stats() {
        return { nextId: this.nextId, freed: this.freed, registered: this.byUniqueId.size };
    }
}
/**
 * Document registry: categories, families, types, elements with identity
 * management and duplication semantics (spec 2.1/2.2/2C.8).
 */
export class BimRegistry {
    identity = new IdentityService();
    categories = new Map();
    families = new Map();
    types = new Map();
    elements = new Map();
    addCategory(c) {
        this.categories.set(c.id, c);
    }
    addFamily(f) {
        if (!this.categories.has(f.categoryId)) {
            throw new Error(`addFamily: unknown category '${f.categoryId}'`);
        }
        for (const n of f.nestedFamilyIds) {
            if (!this.families.has(n) && n !== f.id) {
                throw new Error(`addFamily: nested family '${n}' not yet registered`);
            }
        }
        this.families.set(f.id, f);
    }
    addType(t) {
        if (!this.families.has(t.familyId)) {
            throw new Error(`addType: unknown family '${t.familyId}'`);
        }
        this.types.set(t.id, t);
    }
    /**
     * Create an element. Validates category/family/type coherence
     * (spec 2.1: an instance must reference an existing type of its family).
     */
    createElement(args) {
        const fam = this.families.get(args.familyId);
        if (!fam)
            throw new Error(`createElement: unknown family '${args.familyId}'`);
        if (fam.categoryId !== args.categoryId) {
            throw new Error(`createElement: family '${fam.id}' belongs to category '${fam.categoryId}', not '${args.categoryId}'`);
        }
        const type = this.types.get(args.typeId);
        if (!type || type.familyId !== args.familyId) {
            throw new Error(`createElement: type '${args.typeId}' is not a type of family '${args.familyId}'`);
        }
        const id = this.identity.allocateElementId();
        const uniqueId = newUniqueId();
        const el = {
            id,
            uniqueId,
            name: args.name,
            categoryId: args.categoryId,
            familyId: args.familyId,
            typeId: args.typeId,
            hostId: args.hostId ?? null,
            instanceValues: { ...(args.instanceValues ?? {}) },
            externalIds: { ...(args.externalIds ?? {}) },
            pinned: false,
            createdAt: ++BimRegistry.clock,
        };
        this.identity.registerUniqueId(id, uniqueId);
        this.elements.set(id, el);
        return el;
    }
    getElement(id) {
        return this.elements.get(id) ?? null;
    }
    requireElement(id) {
        const el = this.elements.get(id);
        if (!el)
            throw new Error(`element '${id}' not found`);
        return el;
    }
    getFamily(id) {
        return this.families.get(id) ?? null;
    }
    getType(id) {
        return this.types.get(id) ?? null;
    }
    getCategory(id) {
        return this.categories.get(id) ?? null;
    }
    /** All elements of a type (spec 2.11 type-change impact set). */
    elementsOfType(typeId) {
        const out = [];
        for (const el of this.elements.values())
            if (el.typeId === typeId)
                out.push(el);
        return out;
    }
    /** All elements hosted by an element (spec 1.5 host dependents). */
    hostedBy(hostId) {
        const out = [];
        for (const el of this.elements.values())
            if (el.hostId === hostId)
                out.push(el);
        return out;
    }
    /** Delete an element. Orphan hosted elements are reported, not deleted. */
    deleteElement(id) {
        const el = this.elements.get(id);
        if (!el)
            return { deleted: false, orphaned: [] };
        const orphaned = this.hostedBy(id).map((h) => h.id);
        this.elements.delete(id);
        this.identity.forgetUniqueId(el.uniqueId);
        return { deleted: true, orphaned };
    }
    /**
     * Duplication (spec 2C.8 CreateCopyPlan/CloneElementDefinition):
     * fresh elementId + uniqueId per copy, instance values deep-cloned,
     * external ids NOT copied (the copy has no exchange identity yet),
     * host remapping through `hostRemap` when the host itself was copied.
     */
    duplicate(sourceIds) {
        const idMap = new Map();
        const newElements = [];
        // First pass: allocate ids for all sources (so host remaps resolve).
        for (const srcId of sourceIds) {
            const src = this.requireElement(srcId);
            idMap.set(srcId, this.identity.allocateElementId());
        }
        // Second pass: clone.
        for (const srcId of sourceIds) {
            const src = this.requireElement(srcId);
            const newId = idMap.get(srcId);
            const uniqueId = newUniqueId();
            const copy = {
                ...src,
                id: newId,
                uniqueId,
                instanceValues: { ...src.instanceValues },
                externalIds: {},
                hostId: src.hostId ? (idMap.get(src.hostId) ?? src.hostId) : null,
                createdAt: ++BimRegistry.clock,
            };
            this.identity.registerUniqueId(newId, uniqueId);
            this.elements.set(newId, copy);
            newElements.push(copy);
        }
        return { idMap, newElements };
    }
    /** ChangeType (spec 2.11): validates the new type is same-family. */
    changeType(elementId, newTypeId) {
        const el = this.requireElement(elementId);
        const type = this.types.get(newTypeId);
        if (!type)
            throw new Error(`changeType: unknown type '${newTypeId}'`);
        if (type.familyId !== el.familyId) {
            throw new Error(`changeType: type '${newTypeId}' belongs to family '${type.familyId}', element is in family '${el.familyId}'`);
        }
        el.typeId = newTypeId;
    }
    stats() {
        return {
            categories: this.categories.size,
            families: this.families.size,
            types: this.types.size,
            elements: this.elements.size,
        };
    }
    static clock = 0;
}
