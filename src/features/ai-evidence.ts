/**
 * Stable, source-labelled evidence payloads for AI-assisted BIM inspection.
 * This module is deliberately pure so IFC/Fragments values can be normalized
 * and tested without booting the viewer.
 */

export interface ElementEvidenceInput {
  modelId: string;
  modelName: string;
  localId: number;
  category: string | null;
  item: Record<string, unknown>;
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, "value")) {
    return (value as { value: unknown }).value;
  }
  return value;
}

/** Convert IFC/Fragments values to bounded JSON-safe data without inventing values. */
export function normalizeEvidenceValue(value: unknown, depth = 0): unknown {
  const unwrapped = unwrap(value);
  if (unwrapped == null || typeof unwrapped === "string" ||
      typeof unwrapped === "number" || typeof unwrapped === "boolean") return unwrapped;
  if (depth >= 5) return "[nested value omitted]";
  if (Array.isArray(unwrapped)) {
    return unwrapped.slice(0, 100).map((entry) => normalizeEvidenceValue(entry, depth + 1));
  }
  if (typeof unwrapped === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(unwrapped as Record<string, unknown>).slice(0, 200)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      const normalized = normalizeEvidenceValue(entry, depth + 1);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  return String(unwrapped);
}

function scalarText(value: unknown): string | null {
  const normalized = normalizeEvidenceValue(value);
  return normalized == null || typeof normalized === "object"
    ? null : String(normalized);
}

export function buildElementEvidence(input: ElementEvidenceInput) {
  const item = input.item ?? {};
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === "psets" || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const normalized = normalizeEvidenceValue(value);
    if (normalized !== undefined) attributes[key] = normalized;
  }

  const propertySets = normalizeEvidenceValue(item.psets ?? {}) as Record<string, unknown>;
  const name = scalarText(item.Name) ?? scalarText(item.ObjectType) ?? null;
  const globalId = scalarText(item.GlobalId) ?? null;
  const ifcType = scalarText(item.type) ?? input.category;

  return {
    evidenceType: "loaded-model-element",
    source: {
      kind: "loaded-ifc-fragments-model",
      modelId: input.modelId,
      modelName: input.modelName,
      localId: input.localId,
      category: input.category,
    },
    identity: {
      modelId: input.modelId,
      localId: input.localId,
      globalId,
      ifcType,
      name,
    },
    attributes,
    propertySets,
    evidenceNotes: [
      "Values are read from the currently loaded model through the Fragments model API.",
      "localId is scoped to modelId; it is not a globally unique IFC identifier.",
      "A null or absent value means the loaded model did not return that value.",
    ],
  };
}
