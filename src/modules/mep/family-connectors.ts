/**
 * Converts family-local connector definitions into world-space MEP ports.
 *
 * The definition remains local and immutable. The rendered Object3D world
 * matrix is the source of truth for translation, rotation, scale and parents.
 */
import * as THREE from "three";
import type { ConnectorDefinition } from "../object-hierarchy";
import type { MepConnector } from "./connectors";

function copyDefinition(definition: ConnectorDefinition): ConnectorDefinition {
  return {
    ...definition,
    origin: [...definition.origin] as [number, number, number],
    direction: [...definition.direction] as [number, number, number],
    size: Array.isArray(definition.size)
      ? [...definition.size] as [number, number]
      : definition.size,
  };
}

function isFiniteVector3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) => typeof component === "number" && Number.isFinite(component));
}

/**
 * Connector definitions use the local x/y/z frame of the family mesh.
 * Origins are transformed as points; directions are transformed as axes.
 */
export function deriveFamilyInstanceConnectors(
  ownerElementId: string,
  definitions: ConnectorDefinition[],
  instanceObject: THREE.Object3D,
): MepConnector[] {
  if (typeof ownerElementId !== "string" || !ownerElementId.trim()) {
    throw new Error("A family connector owner element id is required");
  }
  if (!Array.isArray(definitions)) {
    throw new Error("Family connector definitions must be an array");
  }
  if (!instanceObject || typeof instanceObject.updateWorldMatrix !== "function") {
    throw new Error("A rendered family instance is required to transform connector definitions");
  }

  instanceObject.updateWorldMatrix(true, false);
  const worldMatrix = instanceObject.matrixWorld;

  return definitions.map((definition) => {
    if (!definition || typeof definition.name !== "string" || !definition.name.trim()) {
      throw new Error("Family connector names must be non-empty");
    }
    if (!isFiniteVector3(definition.origin) || !isFiniteVector3(definition.direction)) {
      throw new Error("Family connector origin and direction must be finite 3D vectors: " + definition.name);
    }
    const localDirection = new THREE.Vector3(...definition.direction);
    if (localDirection.lengthSq() < 1e-18) {
      throw new Error("Family connector direction must be non-zero: " + definition.name);
    }

    const worldOrigin = new THREE.Vector3(...definition.origin).applyMatrix4(worldMatrix);
    const worldDirection = localDirection.transformDirection(worldMatrix);
    if (!Number.isFinite(worldOrigin.x) || !Number.isFinite(worldOrigin.y) ||
        !Number.isFinite(worldOrigin.z) || worldDirection.lengthSq() < 1e-18) {
      throw new Error("Family connector transform produced an invalid world-space port: " + definition.name);
    }

    return {
      ownerElementId,
      def: copyDefinition(definition),
      worldOrigin: [worldOrigin.x, worldOrigin.y, worldOrigin.z] as [number, number, number],
      worldDirection: [worldDirection.x, worldDirection.y, worldDirection.z] as [number, number, number],
      engaged: false,
      connectedTo: null,
    };
  });
}
