import type { ConnectorDefinition } from "../object-hierarchy";

const DOMAINS = ["duct", "pipe", "electrical", "conduit", "cabletray", "structural", "other"];
const SHAPES = ["round", "rectangular", "oval", "point"];
const FLOWS = ["in", "out", "inout"];

function finiteVector3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every(component => typeof component === "number" && Number.isFinite(component));
}

/** Return actionable validation errors for a family's complete local port list. */
export function validateFamilyConnectorDefinitions(input: unknown): string[] {
  if (!Array.isArray(input)) return ["Connector definitions must be an array."];
  const errors: string[] = [];
  const names = new Set<string>();

  input.forEach((value, index) => {
    const prefix = "Connector " + (index + 1) + ": ";
    if (!value || typeof value !== "object") {
      errors.push(prefix + "definition is invalid.");
      return;
    }
    const definition = value as ConnectorDefinition;
    if (typeof definition.name !== "string" || !definition.name.trim()) {
      errors.push(prefix + "name is required.");
    } else {
      const key = definition.name.trim().toLowerCase();
      if (names.has(key)) errors.push(prefix + "name duplicates another port (names are case-insensitive).");
      names.add(key);
    }
    if (!DOMAINS.includes(definition.domain)) errors.push(prefix + "unsupported MEP domain.");
    if (!SHAPES.includes(definition.shape)) errors.push(prefix + "unsupported connector shape.");
    if (!FLOWS.includes(definition.flowDirection)) errors.push(prefix + "unsupported flow direction.");
    if (typeof definition.systemClassification !== "string" || !definition.systemClassification.trim()) {
      errors.push(prefix + "system classification is required.");
    }
    if (!finiteVector3(definition.origin)) errors.push(prefix + "origin must contain three finite coordinates.");
    if (!finiteVector3(definition.direction)) {
      errors.push(prefix + "direction must contain three finite coordinates.");
    } else if (Math.hypot(...definition.direction) < 1e-9) {
      errors.push(prefix + "direction must be non-zero.");
    }

    const size = definition.size;
    if (Array.isArray(size)) {
      if (size.length !== 2 || !size.every(component => typeof component === "number" && Number.isFinite(component) && component > 0)) {
        errors.push(prefix + "two-dimensional size must contain two positive finite values.");
      }
      if (definition.shape === "round") errors.push(prefix + "round connectors require a scalar diameter.");
    } else if (typeof size !== "number" || !Number.isFinite(size) || size <= 0 || definition.shape === "rectangular") {
      errors.push(prefix + "size is invalid for the selected shape.");
    }
  });

  return errors;
}

/** Clone nested coordinates and sizes so UI drafts cannot mutate stored data. */
export function cloneFamilyConnectorDefinitions(
  definitions: readonly ConnectorDefinition[],
): ConnectorDefinition[] {
  return definitions.map(definition => ({
    ...definition,
    origin: [...definition.origin] as [number, number, number],
    direction: [...definition.direction] as [number, number, number],
    size: Array.isArray(definition.size) ? [...definition.size] as [number, number] : definition.size,
  }));
}
