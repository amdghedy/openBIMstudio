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
} from "./index";

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
}

export interface AdaptiveElementCreateInput {
  familyId: string;
  familyName: string;
  points: Pt3[];
  profile: ProfilePt[];
  pointLength?: number;
  name?: string;
  color?: string;
}

export interface AdaptiveElementPatch {
  points?: Pt3[];
  profile?: ProfilePt[];
  pointLength?: number;
  familyName?: string;
  name?: string;
  color?: string;
}

let installed = false;
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
  if (input.points.length === 1 && input.pointLength !== undefined &&
      (!Number.isFinite(input.pointLength) || input.pointLength <= 0)) {
    throw new Error("One-point adaptive extrusion length must be positive");
  }
  return input;
}

function meshForDefinition(definition: AdaptiveElementDefinition, color = "#60a5fa"): THREE.Group {
  const def = validateDefinition(definition);
  const path = def.points.length === 1
    ? [
        def.points[0],
        { x: def.points[0].x, y: def.points[0].y + (def.pointLength ?? 1), z: def.points[0].z },
      ]
    : def.points;
  const indexed = sweepProfile(def.profile, path);
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

export function createAdaptiveElement(input: AdaptiveElementCreateInput): AuthoredElement {
  const auth = authoring();
  if (!auth || typeof auth.getElements !== "function" || typeof auth.rebuildAuthored !== "function") {
    throw new Error("Native authoring is not ready");
  }
  const definition = definitionFromInput(input);
  // Validate/build before inserting anything into the project.
  meshForDefinition(definition, input.color);
  const levelId = typeof auth.getActiveLevelId === "function" ? auth.getActiveLevelId() : null;
  const element: AuthoredElement = {
    id: nextId(),
    type: "adaptive-component",
    name: input.name?.trim() || definition.familyName,
    color: input.color || "#60a5fa",
    familyId: definition.familyId,
    levelId: levelId || undefined,
    params: paramsFor(definition),
    properties: {
      adaptiveDefinition: clone(definition),
      adaptiveFamilyName: definition.familyName,
      adaptivePointCount: definition.pointCount,
    },
  };
  const elements = auth.getElements() as AuthoredElement[];
  const apply = () => {
    if (!elements.some((entry) => entry.id === element.id)) elements.push(element);
    markAndRebuild(auth);
    auth.setSelectedAuthored?.([element.id], "replace");
  };
  const revert = () => {
    const index = elements.findIndex((entry) => entry.id === element.id);
    if (index >= 0) elements.splice(index, 1);
    markAndRebuild(auth);
  };
  try {
    apply();
    history.push({ label: `Place adaptive component · ${element.name}`, apply, revert });
  } catch (error) {
    const index = elements.findIndex((entry) => entry.id === element.id);
    if (index >= 0) elements.splice(index, 1);
    try { markAndRebuild(auth); } catch { /* preserve the original error */ }
    throw error;
  }
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
  });
  // Build first so a malformed edit cannot leave a broken project element.
  meshForDefinition(afterDefinition, patch.color ?? element.color);
  const beforeParams = clone(element.params);
  const afterParams = paramsFor(afterDefinition);
  const beforeName = element.name;
  const afterName = patch.name?.trim() || beforeName;
  const beforeColor = element.color;
  const afterColor = patch.color ?? beforeColor;
  const applyState = (
    definition: AdaptiveElementDefinition,
    params: AuthoredElement["params"],
    name: string,
    color: string | undefined,
  ) => {
    element.properties = {
      ...(element.properties ?? {}),
      adaptiveDefinition: clone(definition),
      adaptiveFamilyName: definition.familyName,
      adaptivePointCount: definition.pointCount,
    };
    element.params = clone(params);
    element.name = name;
    element.color = color;
    markAndRebuild(auth);
  };
  applyState(afterDefinition, afterParams, afterName, afterColor);
  history.push({
    label: `Edit adaptive component · ${element.name}`,
    apply: () => applyState(afterDefinition, afterParams, afterName, afterColor),
    revert: () => applyState(beforeDefinition, beforeParams, beforeName, beforeColor),
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
