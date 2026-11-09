/**
 * Native adaptive-component integration.
 *
 * The editable definition (profile, ordered placement points and family
 * identity) is stored on the authored project element. The viewport mesh is
 * always rebuilt from that definition through the existing adaptive sweep
 * engine; it is never the source of truth.
 */
import * as THREE from "three";
import { ctx } from "../../core/context";
import { history } from "../../features/history";
import type { AuthoredElement } from "../projects/types";
import {
  pathLength,
  sweepProfile,
  validateProfile,
  type ProfilePt,
  type Pt3,
  type AdaptivePointConstraint,
  solveAdaptivePointConstraints,
  validateAdaptivePointConstraints,
} from "./index";
import { resolveNumber } from "../families/parametric-geometry";

type Any = Record<string, any>;

export interface AdaptiveElementDefinition {
  schemaVersion: 1;
  familyId: string;
  familyName: string;
  pointCount: number;
  points: Pt3[];
  profile: ProfilePt[];
  /** Used only for one-point components; extrusion is along local +Y. */
  pointLength?: number;
  constraints?: AdaptivePointConstraint[];
  /** Optional link to a shared BIM family and family type. */
  familyBinding?: { familyId: string; typeId: string };
}

export interface AdaptiveElementCreateInput {
  familyId: string;
  familyName: string;
  points: Pt3[];
  profile: ProfilePt[];
  pointLength?: number;
  name?: string;
  color?: string;
  constraints?: AdaptivePointConstraint[];
}

export interface AdaptiveElementPatch {
  points?: Pt3[];
  profile?: ProfilePt[];
  pointLength?: number;
  familyName?: string;
  name?: string;
  color?: string;
  constraints?: AdaptivePointConstraint[];
  familyBinding?: { familyId: string; typeId: string } | null;
}

export interface AdaptiveElementSnapshot {
  definition: AdaptiveElementDefinition;
  params: AuthoredElement["params"];
  name: string;
  color?: string;
  properties: Record<string, unknown>;
  familyId?: string;
  familyTypeId?: string;
}

export interface AdaptiveFamilyTypeChoice {
  familyId: string;
  typeId: string;
  label: string;
}

let installed = false;
let familyUnsubscribe: (() => void) | null = null;
let familyPropagationBusy = false;
let idCounter = 0;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function authoring(): Any | null {
  return (ctx.features as Any)?.authoring ?? null;
}

function validateDefinition(input: AdaptiveElementDefinition): AdaptiveElementDefinition {
  if (!input || input.schemaVersion !== 1) throw new Error("Unsupported adaptive definition version");
  if (!String(input.familyId ?? "").trim()) throw new Error("Adaptive family id is required");
  if (!String(input.familyName ?? "").trim()) throw new Error("Adaptive family name is required");
  if (!Array.isArray(input.points) || input.points.length < 1 || input.points.length > 8) {
    throw new Error("Adaptive components require 1 to 8 placement points");
  }
  if (input.pointCount !== input.points.length) {
    throw new Error("Adaptive point count must match the number of placement points");
  }
  for (let i = 0; i < input.points.length; i++) {
    const p = input.points[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      throw new Error(`Placement point ${i + 1} must have finite x, y and z coordinates`);
    }
  }
  validateProfile(input.profile);
  validateAdaptivePointConstraints(input.constraints, input.points.length);
  if (input.points.length === 1 && input.pointLength !== undefined &&
      (!Number.isFinite(input.pointLength) || input.pointLength <= 0)) {
    throw new Error("One-point adaptive extrusion length must be positive");
  }
  if (input.familyBinding && (!String(input.familyBinding.familyId ?? "").trim() ||
      !String(input.familyBinding.typeId ?? "").trim())) {
    throw new Error("Shared family binding requires both family and type ids");
  }
  const solvedPoints = solveAdaptivePointConstraints(input.points, input.constraints ?? []);
  return { ...input, points: solvedPoints };
}

function pathForDefinition(definition: AdaptiveElementDefinition): Pt3[] {
  if (definition.points.length === 1) {
    const point = definition.points[0];
    return [
      point,
      { x: point.x, y: point.y + (definition.pointLength ?? 1), z: point.z },
    ];
  }
  return definition.points;
}

/** Build the indexed sweep without allocating any Three.js objects. */
function indexedMeshForDefinition(definition: AdaptiveElementDefinition) {
  const def = validateDefinition(definition);
  const indexed = sweepProfile(def.profile, pathForDefinition(def));
  if (indexed.vertices.length < 3 || indexed.faces.length < 1) {
    throw new Error("Adaptive geometry is empty");
  }
  return { definition: def, indexed };
}

function meshForDefinition(definition: AdaptiveElementDefinition, color = "#60a5fa"): THREE.Group {
  const { definition: def, indexed } = indexedMeshForDefinition(definition);
  const positions = new Float32Array(indexed.vertices.length * 3);
  indexed.vertices.forEach((p, i) => {
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
  });
  const indices = indexed.faces.flat();
  if (positions.length < 9 || indices.length < 3) throw new Error("Adaptive geometry is empty");
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshLambertMaterial({
    color: new THREE.Color(color || "#60a5fa"),
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "adaptive-component-solid";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.adaptiveDefinition = clone(def);

  const group = new THREE.Group();
  group.name = "adaptive-component";
  group.add(mesh);
  return group;
}

/** Mesh-builder hook used by authoring.ts when it rebuilds an authored element. */
export function buildAdaptiveElementMesh(element: Any): THREE.Object3D | null {
  const definition = element?.properties?.adaptiveDefinition as AdaptiveElementDefinition | undefined;
  if (!definition) return null;
  try {
    const group = meshForDefinition(definition, String(element.color ?? "#60a5fa"));
    group.traverse((object) => {
      object.userData.elementId = element.id;
      object.userData.baseColor = element.color || "#60a5fa";
      object.userData.adaptiveComponent = true;
    });
    return group;
  } catch (error) {
    console.warn("[adaptive] failed to rebuild native adaptive component", element?.id, error);
    return null;
  }
}

function definitionFromInput(input: AdaptiveElementCreateInput): AdaptiveElementDefinition {
  const points = clone(input.points);
  const def: AdaptiveElementDefinition = {
    schemaVersion: 1,
    familyId: String(input.familyId),
    familyName: String(input.familyName),
    pointCount: points.length,
    points,
    profile: clone(input.profile),
    ...(input.pointLength === undefined ? {} : { pointLength: Number(input.pointLength) }),
  };
  return validateDefinition(def);
}

function paramsFor(def: AdaptiveElementDefinition): AuthoredElement["params"] {
  const us = def.profile.map((p) => p.u), vs = def.profile.map((p) => p.v);
  const profileSize = Math.max(
    Math.max(...us) - Math.min(...us),
    Math.max(...vs) - Math.min(...vs),
    0.01,
  );
  const length = def.points.length === 1
    ? (def.pointLength ?? 1)
    : pathLength(def.points);
  return {
    height: Math.max(length, 0.01),
    thickness: profileSize,
    elevation: def.points[0].y,
  };
}

function nextId(): string {
  idCounter += 1;
  return `adaptive-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function markAndRebuild(auth: Any): void {
  if (typeof auth.rebuildAuthored !== "function") throw new Error("Native authoring rebuild is unavailable");
  auth.rebuildAuthored();
}

/** Insert + rebuild as one model mutation; restore the array if rebuild fails. */
function insertElementAndRebuild(
  auth: Any,
  elements: AuthoredElement[],
  element: AuthoredElement,
): void {
  if (elements.some((entry) => entry.id === element.id)) return;
  elements.push(element);
  try {
    markAndRebuild(auth);
  } catch (error) {
    const index = elements.findIndex((entry) => entry.id === element.id);
    if (index >= 0) elements.splice(index, 1);
    try {
      markAndRebuild(auth);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Adaptive element '${element.name}' failed to build and rollback was incomplete`,
      );
    }
    throw error;
  }
}

/** Remove + rebuild as one model mutation; restore the original position on failure. */
function removeElementAndRebuild(
  auth: Any,
  elements: AuthoredElement[],
  element: AuthoredElement,
): void {
  const index = elements.findIndex((entry) => entry.id === element.id);
  if (index < 0) return;
  elements.splice(index, 1);
  try {
    markAndRebuild(auth);
  } catch (error) {
    elements.splice(Math.min(index, elements.length), 0, element);
    try {
      markAndRebuild(auth);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Adaptive element '${element.name}' could not be removed and rollback was incomplete`,
      );
    }
    throw error;
  }
}

export function createAdaptiveElement(input: AdaptiveElementCreateInput): AuthoredElement {
  const auth = authoring();
  if (!auth || typeof auth.getElements !== "function" || typeof auth.rebuildAuthored !== "function") {
    throw new Error("Native authoring is not ready");
  }
  const definition = definitionFromInput(input);
  // Validate the complete sweep before inserting anything into the project.
  // This is a pure geometry pass: do not allocate temporary THREE.Mesh /
  // Material objects that would need disposal after a validation-only build.
  indexedMeshForDefinition(definition);
  const levelId = typeof auth.getActiveLevelId === "function" ? auth.getActiveLevelId() : null;
  const element: AuthoredElement = {
    id: nextId(),
    type: "adaptive-component",
    name: input.name?.trim() || definition.familyName,
    color: input.color || "#60a5fa",
    familyId: definition.familyBinding?.familyId ?? definition.familyId,
    familyTypeId: definition.familyBinding?.typeId,
    levelId: levelId || undefined,
    params: paramsFor(definition),
    properties: {
      adaptiveDefinition: clone(definition),
      adaptiveFamilyName: definition.familyName,
      adaptivePointCount: definition.pointCount,
    },
  };
  const elements = auth.getElements() as AuthoredElement[];
  const apply = () => insertElementAndRebuild(auth, elements, element);
  const revert = () => removeElementAndRebuild(auth, elements, element);

  apply();
  // Selection is UI state rather than model state. A selection-panel failure
  // must not turn a successfully-created model element into a failed command.
  try { auth.setSelectedAuthored?.([element.id], "replace"); } catch { /* ignore */ }
  history.push({ label: `Place adaptive component · ${element.name}`, apply, revert });
  return element;
}

/** Place a repeated set as one atomic, single-step undo operation. */
export async function createAdaptiveElements(inputs: AdaptiveElementCreateInput[]): Promise<AuthoredElement[]> {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const created: AuthoredElement[] = [];
  await history.transaction(`Place ${inputs.length} adaptive component(s)`, async () => {
    for (const input of inputs) created.push(createAdaptiveElement(input));
  });
  return created;
}

export function getAdaptiveDefinition(elementId: string): AdaptiveElementDefinition | null {
  const el = (authoring()?.getElements?.() ?? []).find((item: Any) => item?.id === elementId);
  const def = el?.properties?.adaptiveDefinition as AdaptiveElementDefinition | undefined;
  return def ? clone(def) : null;
}

export function updateAdaptiveElement(elementId: string, patch: AdaptiveElementPatch): boolean {
  const auth = authoring();
  const elements = auth?.getElements?.() as AuthoredElement[] | undefined;
  const element = elements?.find((entry) => entry.id === elementId);
  if (!auth || !element || element.type !== "adaptive-component") return false;
  const beforeDefinition = clone((element.properties as Any)?.adaptiveDefinition as AdaptiveElementDefinition);
  const afterDefinition = validateDefinition({
    ...beforeDefinition,
    familyName: patch.familyName ?? beforeDefinition.familyName,
    points: patch.points ? clone(patch.points) : beforeDefinition.points,
    profile: patch.profile ? clone(patch.profile) : beforeDefinition.profile,
    pointCount: patch.points ? patch.points.length : beforeDefinition.pointCount,
    pointLength: patch.pointLength ?? beforeDefinition.pointLength,
    constraints: patch.constraints ? clone(patch.constraints) : beforeDefinition.constraints,
    familyBinding: patch.familyBinding === undefined
      ? beforeDefinition.familyBinding
      : patch.familyBinding ? clone(patch.familyBinding) : undefined,
  });
  // Validate the complete sweep before touching the authored element.
  indexedMeshForDefinition(afterDefinition);
  const beforeParams = clone(element.params);
  const afterParams = paramsFor(afterDefinition);
  const beforeName = element.name;
  const afterName = patch.name?.trim() || beforeName;
  const beforeColor = element.color;
  const afterColor = patch.color ?? beforeColor;
  const beforeFamilyId = element.familyId;
  const beforeFamilyTypeId = element.familyTypeId;
  const afterFamilyId = afterDefinition.familyBinding?.familyId ?? afterDefinition.familyId;
  const afterFamilyTypeId = afterDefinition.familyBinding?.typeId;
  const beforeProperties = clone(element.properties ?? {});
  const afterProperties = {
    ...beforeProperties,
    adaptiveDefinition: clone(afterDefinition),
    adaptiveFamilyName: afterDefinition.familyName,
    adaptivePointCount: afterDefinition.pointCount,
  };
  const applyState = (
    definition: AdaptiveElementDefinition,
    params: AuthoredElement["params"],
    name: string,
    color: string | undefined,
    familyId: string | undefined,
    familyTypeId: string | undefined,
    properties: Record<string, unknown>,
  ) => {
    // History replay (undo/redo) must be just as atomic as the initial edit.
    // Keep a complete local snapshot so a failed rebuild cannot strand changed
    // parameters or metadata without a matching regenerated mesh.
    const previousProperties = clone(element.properties ?? {});
    const previousParams = clone(element.params);
    const previousName = element.name;
    const previousColor = element.color;
    const previousFamilyId = element.familyId;
    const previousFamilyTypeId = element.familyTypeId;
    element.properties = clone(properties);
    element.params = clone(params);
    element.name = name;
    element.color = color;
    element.familyId = familyId;
    element.familyTypeId = familyTypeId;
    try {
      markAndRebuild(auth);
    } catch (error) {
      element.properties = previousProperties;
      element.params = previousParams;
      element.name = previousName;
      element.color = previousColor;
      element.familyId = previousFamilyId;
      element.familyTypeId = previousFamilyTypeId;
      try {
        markAndRebuild(auth);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Adaptive component '${element.name}' edit failed and rollback was incomplete`,
        );
      }
      throw error;
    }
  };
  const beforeState: AdaptiveElementSnapshot = {
    definition: beforeDefinition, params: beforeParams, name: beforeName, color: beforeColor,
    properties: beforeProperties, familyId: beforeFamilyId, familyTypeId: beforeFamilyTypeId,
  };
  const afterState: AdaptiveElementSnapshot = {
    definition: afterDefinition, params: afterParams, name: afterName, color: afterColor,
    properties: afterProperties, familyId: afterFamilyId, familyTypeId: afterFamilyTypeId,
  };
  applyState(afterDefinition, afterParams, afterName, afterColor, afterFamilyId, afterFamilyTypeId, afterProperties);
  history.push({
    label: `Edit adaptive component · ${element.name}`,
    apply: () => applyElementSnapshot(auth, element, afterState),
    revert: () => applyElementSnapshot(auth, element, beforeState),
  });
  return true;
}

export function setupAdaptiveAuthoring(): {
  create: typeof createAdaptiveElement;
  createMany: typeof createAdaptiveElements;
  update: typeof updateAdaptiveElement;
  getDefinition: typeof getAdaptiveDefinition;
  buildMesh: typeof buildAdaptiveElementMesh;
} {
  if (!installed) {
    const builders = ((ctx.features as Any).meshBuilders ??= {}) as Any;
    builders["adaptive-component"] = buildAdaptiveElementMesh;
    const api = {
      create: createAdaptiveElement,
      createMany: createAdaptiveElements,
      update: updateAdaptiveElement,
      getDefinition: getAdaptiveDefinition,
      buildMesh: buildAdaptiveElementMesh,
    };
    (ctx.features as Any).adaptiveAuthoring = api;
    installed = true;
  }
  return (ctx.features as Any).adaptiveAuthoring;
}
