/**
 * Lossless source-information archive for Native / Digital Twins.
 *
 * Dual-layer model:
 *   Layer 1 — editable native params + generated geometry (authoring)
 *   Layer 2 — this archive: complete accessible source payload + field map
 *
 * Native parametric edits must never erase Layer 2.
 */
export const SOURCE_ARCHIVE_VERSION = 1;
const CONVERTER = "openbimstudio-native-twin/source-archive@1";
/** Depth-limited path discovery for audit (not full tree clone). */
export function discoverPaths(value, prefix = "", depth = 0, out = [], maxDepth = 6, maxPaths = 2000) {
    if (out.length >= maxPaths || depth > maxDepth)
        return out;
    if (value == null) {
        out.push(prefix || "(root)");
        return out;
    }
    if (typeof value !== "object") {
        out.push(prefix);
        return out;
    }
    if (Array.isArray(value)) {
        out.push(prefix + "[]");
        if (value.length && depth < maxDepth) {
            discoverPaths(value[0], prefix + "[0]", depth + 1, out, maxDepth, maxPaths);
        }
        return out;
    }
    for (const [k, v] of Object.entries(value)) {
        if (typeof v === "function")
            continue;
        const path = prefix ? `${prefix}.${k}` : k;
        out.push(path);
        if (v && typeof v === "object") {
            discoverPaths(v, path, depth + 1, out, maxDepth, maxPaths);
        }
        if (out.length >= maxPaths)
            break;
    }
    return out;
}
function pickScalar(data, ...keys) {
    for (const key of keys) {
        const v = data?.[key];
        const value = v?.value ?? v;
        if (value != null && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
            return String(value);
        }
    }
    return undefined;
}
function extractPsets(raw) {
    const candidates = [raw.psets, raw.Psets, raw.propertySets, raw.PropertySets, raw.HasPropertySets];
    for (const c of candidates) {
        if (c && typeof c === "object" && !Array.isArray(c))
            return c;
    }
    return {};
}
function extractQtos(raw) {
    const candidates = [raw.qtos, raw.Qtos, raw.quantities, raw.Quantities, raw.ElementQuantities];
    for (const c of candidates) {
        if (c && typeof c === "object" && !Array.isArray(c))
            return c;
    }
    return {};
}
function extractMaterials(raw) {
    return raw.materials ?? raw.Materials ?? raw.HasAssociations ?? raw.material ?? undefined;
}
function extractClassifications(raw) {
    return raw.classifications ?? raw.Classifications ?? raw.HasAssociations ?? undefined;
}
function extractRelationships(raw) {
    const rel = {};
    for (const key of [
        "ContainedInStructure",
        "Decomposes",
        "IsDecomposedBy",
        "FillsVoids",
        "HasOpenings",
        "ConnectedTo",
        "ConnectedFrom",
        "ReferencedBy",
        "HasAssignments",
        "systems",
        "type",
        "Type",
    ]) {
        if (raw[key] != null)
            rel[key] = raw[key];
    }
    return rel;
}
function buildFieldMap(identity, psets, qtos, dims) {
    const map = [];
    const add = (m) => map.push(m);
    if (identity.globalId) {
        add({ sourcePath: "GlobalId", nativePath: "ifc.globalId", lossless: true, status: "synchronized" });
    }
    if (identity.entityType) {
        add({ sourcePath: "Entity/Type", nativePath: "ifc.entity", lossless: true, status: "synchronized" });
    }
    if (identity.name) {
        add({ sourcePath: "Name", nativePath: "name", lossless: true, status: "synchronized" });
    }
    for (const key of Object.keys(psets)) {
        add({
            sourcePath: `psets.${key}`,
            nativePath: `ifc.propertySets.${key}`,
            lossless: true,
            status: "synchronized",
            note: "Property set preserved on native ifc layer and archive",
        });
    }
    for (const key of Object.keys(qtos)) {
        add({
            sourcePath: `qtos.${key}`,
            nativePath: `ifc.quantities.${key}`,
            lossless: true,
            status: "synchronized",
            note: "Quantity set preserved; distinct from regenerated geometry metrics",
        });
    }
    if (dims) {
        for (const [k, v] of Object.entries(dims)) {
            if (v == null)
                continue;
            add({
                sourcePath: `sourceDimensions.${k}`,
                nativePath: `params.${k}`,
                lossless: false,
                status: "synchronized",
                note: "Source dimension retained in archive; native params may diverge after edit",
            });
        }
    }
    return map;
}
/**
 * Build a versioned lossless archive from accessible source item data.
 */
export function buildSourceArchive(input) {
    const rawItem = input.rawItem && typeof input.rawItem === "object"
        ? JSON.parse(JSON.stringify(input.rawItem))
        : {};
    const propertySets = extractPsets(rawItem);
    const quantities = extractQtos(rawItem);
    const identity = {
        ...input.identity,
        globalId: input.identity.globalId ?? pickScalar(rawItem, "GlobalId", "globalId"),
        entityType: input.identity.entityType ?? pickScalar(rawItem, "Entity", "Type", "ObjectType"),
        name: input.identity.name ?? pickScalar(rawItem, "Name", "name"),
        tag: input.identity.tag ?? pickScalar(rawItem, "Tag"),
        predefinedType: input.identity.predefinedType ?? pickScalar(rawItem, "PredefinedType"),
        description: input.identity.description ?? pickScalar(rawItem, "Description"),
        objectType: pickScalar(rawItem, "ObjectType"),
    };
    const discoveredPaths = discoverPaths(rawItem);
    const fieldMap = buildFieldMap(identity, propertySets, quantities, input.sourceDimensions);
    // Unmapped top-level keys → preserved-unmapped
    for (const path of discoveredPaths) {
        if (path.includes(".") || path.includes("["))
            continue;
        if (fieldMap.some((f) => f.sourcePath === path || f.sourcePath.startsWith(path)))
            continue;
        fieldMap.push({
            sourcePath: path,
            lossless: true,
            status: "preserved-unmapped",
            note: "Retained in rawItem; no native parametric binding",
        });
    }
    return {
        version: SOURCE_ARCHIVE_VERSION,
        convertedAt: new Date().toISOString(),
        converter: CONVERTER,
        identity,
        rawItem,
        propertySets,
        quantities,
        discoveredPaths,
        fieldMap,
        geometry: input.geometry ?? {},
        sourceDimensions: input.sourceDimensions,
        materials: extractMaterials(rawItem),
        classifications: extractClassifications(rawItem),
        relationships: extractRelationships(rawItem),
        warnings: input.warnings ?? [],
    };
}
/**
 * Mark native dimension fields as modified without dropping source values.
 */
export function markNativeDimensionModified(archive, paramKey) {
    if (!archive?.fieldMap)
        return;
    for (const f of archive.fieldMap) {
        if (f.nativePath === `params.${paramKey}` || f.sourcePath === `sourceDimensions.${paramKey}`) {
            f.status = "native-modified";
            f.note = (f.note ? f.note + "; " : "") + `Native ${paramKey} edited; source value retained in sourceDimensions`;
        }
    }
}
export function auditSourceArchive(archive) {
    if (!archive) {
        return {
            fieldCount: 0,
            mappedNative: 0,
            preservedUnmapped: 0,
            nativeModified: 0,
            warnings: ["no archive"],
            hasRawItem: false,
            hasPropertySets: false,
            hasQuantities: false,
            completeness: "minimal",
        };
    }
    const mappedNative = archive.fieldMap.filter((f) => f.nativePath && f.status !== "mapping-failed").length;
    const preservedUnmapped = archive.fieldMap.filter((f) => f.status === "preserved-unmapped").length;
    const nativeModified = archive.fieldMap.filter((f) => f.status === "native-modified").length;
    const hasRawItem = !!archive.rawItem && Object.keys(archive.rawItem).length > 0;
    const hasPropertySets = Object.keys(archive.propertySets || {}).length > 0;
    const hasQuantities = Object.keys(archive.quantities || {}).length > 0;
    let completeness = "minimal";
    if (hasRawItem && (hasPropertySets || archive.discoveredPaths.length > 5))
        completeness = "full-accessible";
    else if (hasRawItem || hasPropertySets || hasQuantities)
        completeness = "partial";
    return {
        fieldCount: archive.fieldMap.length,
        mappedNative,
        preservedUnmapped,
        nativeModified,
        warnings: [...archive.warnings],
        hasRawItem,
        hasPropertySets,
        hasQuantities,
        completeness,
    };
}
