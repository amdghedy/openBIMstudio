/**
 * Shared geometry calculations for the Family Browser's isometric preview.
 *
 * Connector positions use the same runtime transform as placed family
 * instances. The preview frame expands to include connector origins and
 * direction arrows, while the reported model dimensions remain geometry-only.
 */
import * as THREE from "three";
import type { ConnectorDefinition } from "../object-hierarchy";
import { deriveFamilyInstanceConnectors } from "../mep/family-connectors";

export interface PreviewPoint2D {
  x: number;
  y: number;
}

export interface FamilyConnectorPreviewPort {
  name: string;
  domain: ConnectorDefinition["domain"];
  shape: ConnectorDefinition["shape"];
  flowDirection: ConnectorDefinition["flowDirection"];
  systemClassification: string;
  size: ConnectorDefinition["size"];
  origin: PreviewPoint2D;
  axisEnd: PreviewPoint2D;
  worldOrigin: [number, number, number];
  worldDirection: [number, number, number];
}

export interface FamilyConnectorPreviewLayout {
  width: number;
  height: number;
  geometryCorners: PreviewPoint2D[];
  dimensions: [number, number, number];
  ports: FamilyConnectorPreviewPort[];
}

/**
 * Build an isometric projection for geometry and its family-local connector
 * definitions. Coordinates are transformed by the same Object3D world matrix
 * used by MEP authoring, so preview and placed connector positions agree.
 */
export function buildFamilyConnectorPreviewLayout(
  instanceObject: THREE.Object3D,
  definitions: ConnectorDefinition[] = [],
  width = 220,
  height = 160,
  padding = 20,
): FamilyConnectorPreviewLayout | null {
  if (!instanceObject || typeof instanceObject.updateWorldMatrix !== "function") {
    throw new Error("A family preview object is required");
  }
  if (!Array.isArray(definitions)) {
    throw new Error("Family connector definitions must be an array");
  }
  if (!Number.isFinite(width) || width <= 0 ||
      !Number.isFinite(height) || height <= 0 ||
      !Number.isFinite(padding) || padding < 0 ||
      padding * 2 >= Math.min(width, height)) {
    throw new Error("Family preview dimensions or padding are invalid");
  }

  instanceObject.updateWorldMatrix(true, true);
  const geometryBounds = new THREE.Box3().setFromObject(instanceObject);
  const hasGeometry = !geometryBounds.isEmpty();
  const geometrySize = hasGeometry
    ? geometryBounds.getSize(new THREE.Vector3())
    : new THREE.Vector3();
  const dimensions: [number, number, number] = [
    geometrySize.x,
    geometrySize.y,
    geometrySize.z,
  ];

  const connectors = definitions.length
    ? deriveFamilyInstanceConnectors("__family-preview__", definitions, instanceObject)
    : [];
  const modelMaxDimension = Math.max(geometrySize.x, geometrySize.y, geometrySize.z, 0.2);
  const axisLength = modelMaxDimension * 0.18;

  const frameBounds = hasGeometry ? geometryBounds.clone() : new THREE.Box3();
  const connectorWorld = connectors.map((connector) => {
    const origin = new THREE.Vector3(...connector.worldOrigin);
    const direction = new THREE.Vector3(...connector.worldDirection);
    const axisEnd = origin.clone().addScaledVector(direction, axisLength);
    frameBounds.expandByPoint(origin);
    frameBounds.expandByPoint(axisEnd);
    return { connector, origin, axisEnd };
  });

  if (frameBounds.isEmpty()) return null;

  const frameCenter = frameBounds.getCenter(new THREE.Vector3());
  const frameSize = frameBounds.getSize(new THREE.Vector3());
  const maxFrameDimension = Math.max(frameSize.x, frameSize.y, frameSize.z, 0.001);
  const scale = (Math.min(width, height) - padding * 2) / (maxFrameDimension * 1.6);
  const cos30 = Math.cos(Math.PI / 6);
  const sin30 = Math.sin(Math.PI / 6);

  const project = (point: THREE.Vector3): PreviewPoint2D => {
    const dx = point.x - frameCenter.x;
    const dy = point.y - frameCenter.y;
    const dz = point.z - frameCenter.z;
    return {
      x: (dx - dz) * cos30 * scale + width / 2,
      y: ((dx + dz) * sin30 - dy) * scale + height / 2,
    };
  };

  const geometryCorners: PreviewPoint2D[] = [];
  if (hasGeometry) {
    const min = geometryBounds.min;
    const max = geometryBounds.max;
    const corners = [
      new THREE.Vector3(min.x, min.y, min.z),
      new THREE.Vector3(max.x, min.y, min.z),
      new THREE.Vector3(max.x, min.y, max.z),
      new THREE.Vector3(min.x, min.y, max.z),
      new THREE.Vector3(min.x, max.y, min.z),
      new THREE.Vector3(max.x, max.y, min.z),
      new THREE.Vector3(max.x, max.y, max.z),
      new THREE.Vector3(min.x, max.y, max.z),
    ];
    for (const corner of corners) geometryCorners.push(project(corner));
  }

  const ports: FamilyConnectorPreviewPort[] = connectorWorld.map(({ connector, origin, axisEnd }) => ({
    name: connector.def.name,
    domain: connector.def.domain,
    shape: connector.def.shape,
    flowDirection: connector.def.flowDirection,
    systemClassification: connector.def.systemClassification,
    size: Array.isArray(connector.def.size)
      ? [...connector.def.size] as [number, number]
      : connector.def.size,
    origin: project(origin),
    axisEnd: project(axisEnd),
    worldOrigin: [...connector.worldOrigin] as [number, number, number],
    worldDirection: [...connector.worldDirection] as [number, number, number],
  }));

  return { width, height, geometryCorners, dimensions, ports };
}
