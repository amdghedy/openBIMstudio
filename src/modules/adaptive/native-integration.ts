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
import type { NumberRef } from "../families/types";

type Any = Record<string, any>;

export interface AdaptiveWorkPlaneSnapshot {
  id?: string;
  name: string;
  origin: Pt3;
  normal: Pt3;
  face?: {
    elementId?: string;
    meshIndex?: number;
    faceIndex?: number;
    localOrigin?: Pt3;
    localNormal?: Pt3;
  };
}

export interface AdaptiveProfilePart {
  /** One swept solid in the family cross-section. Multiple parts preserve a compound family. */
  profile: ProfilePt[];
  name?: string;
}

export type AdaptiveCustomFamilyProfileAdapter = (
  params: Record<string, any>,
  resolve: (ref: NumberRef) => number,
  geometry: Record<string, any>,
) => AdaptiveProfilePart[];

const adaptiveCustomProfileAdapters = new Map<string, AdaptiveCustomFamilyProfileAdapter>();

export function registerAdaptiveCustomFamilyProfileAdapter(
  builder: string,
  adapter: AdaptiveCustomFamilyProfileAdapter,
): void {
  const key = String(builder ?? "").trim();
  if (!key || typeof adapter !== "function") throw new Error("A custom family builder name and adaptive profile adapter are required");
  adaptiveCustomProfileAdapters.set(key, adapter);
}

export interface AdaptiveElementDefinition {
  schemaVersion: 1;
  familyId: string;
  familyName: string;
  pointCount: number;
  points: Pt3[];
  profile: ProfilePt[];
  /** Optional compound section profiles; profile remains the legacy single-part fallback. */
  profileParts?: AdaptiveProfilePart[];
  /** Used only for one-point components; extrusion is along local +Y. */
  pointLength?: number;
  constraints?: AdaptivePointConstraint[];
  /** Active arbitrary work plane captured at placement time. */
  workPlane?: AdaptiveWorkPlaneSnapshot;
  /** Optional link to a shared BIM family and family type. */
  familyBinding?: { familyId: string; typeId: string };
}

export interface AdaptiveElementCreateInput {
  familyId: string;
  familyName: string;
  points: Pt3[];
  profile: ProfilePt[];
  profileParts?: AdaptiveProfilePart[];
  pointLength?: number;
  name?: string;
  color?: string;
  constraints?: AdaptivePointConstraint[];
  workPlane?: AdaptiveWorkPlaneSnapshot;
}

export interface AdaptiveElementPatch {
  points?: Pt3[];
  profile?: ProfilePt[];
  profileParts?: AdaptiveProfilePart[];
  pointLength?: number;
  familyName?: string;
  name?: string;
  color?: string;
  constraints?: AdaptivePointConstraint[];
  workPlane?: AdaptiveWorkPlaneSnapshot | null;
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

function validateDefinition(input: AdaptiveElementDefinition, driverIndex?: number): AdaptiveElementDefinition {
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
  if (input.profileParts !== undefined) {
    if (!Array.isArray(input.profileParts) || input.profileParts.length < 1 || input.profileParts.length > 64) {
      throw new Error("Adaptive compound sections require 1 to 64 profile parts");
    }
    for (const part of input.profileParts) validateProfile(part.profile);
  }
  validateAdaptivePointConstraints(input.constraints, input.points.length);
  if (input.points.length === 1 && input.pointLength !== undefined &&
      (!Number.isFinite(input.pointLength) || input.pointLength <= 0)) {
    throw new Error("One-point adaptive extrusion length must be positive");
  }
  if (input.familyBinding && (!String(input.familyBinding.familyId ?? "").trim() ||
      !String(input.familyBinding.typeId ?? "").trim())) {
    throw new Error("Shared family binding requires both family and type ids");
  }
  const solvedPoints = solveAdaptivePointConstraints(input.points, input.constraints ?? [], driverIndex);
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
function indexedMeshesForDefinition(definition: AdaptiveElementDefinition, driverIndex?: number) {
  const def = validateDefinition(definition, driverIndex);
  const parts = def.profileParts?.length ? def.profileParts : [{ profile: def.profile }];
  const indexedParts = parts.map((part) => {
    const indexed = sweepProfile(part.profile, pathForDefinition(def));
    if (indexed.vertices.length < 3 || indexed.faces.length < 1) throw new Error("Adaptive compound part is empty");
    return { name: part.name, indexed };
  });
  return { definition: def, indexed: indexedParts[0].indexed, indexedParts };
}

/** Build the indexed sweep without allocating any Three.js objects. */
function indexedMeshForDefinition(definition: AdaptiveElementDefinition, driverIndex?: number) {
  const result = indexedMeshesForDefinition(definition, driverIndex);
  return { definition: result.definition, indexed: result.indexed };
}

function triangleSoupForDefinition(definition: AdaptiveElementDefinition): number[] {
  const { indexedParts } = indexedMeshesForDefinition(definition);
  const positions: number[] = [];
  for (const part of indexedParts) {
    for (const face of part.indexed.faces) {
      for (const index of face) {
        const point = part.indexed.vertices[index];
        positions.push(point.x, point.y, point.z);
      }
    }
  }
  return positions;
}

function meshForDefinition(definition: AdaptiveElementDefinition, color = "#60a5fa"): THREE.Group {
  const { definition: def, indexedParts } = indexedMeshesForDefinition(definition);
  const group = new THREE.Group();
  group.name = "adaptive-component";
  indexedParts.forEach((part, partIndex) => {
    const positions = new Float32Array(part.indexed.vertices.length * 3);
    part.indexed.vertices.forEach((p, i) => {
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
    });
    const indices = part.indexed.faces.flat();
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
    mesh.name = indexedParts.length > 1 ? "adaptive-component-part-" + (partIndex + 1) : "adaptive-component-solid";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.adaptiveDefinition = clone(def);
    mesh.userData.adaptivePartName = part.name;
    group.add(mesh);
  });
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
    // Keep a deterministic triangle-soup cache for the shared authored IFC
    // exporter. The editable definition remains the source of truth.
    element.nativeGeometry = { positions: triangleSoupForDefinition(definition) };
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
    ...(input.profileParts?.length ? { profileParts: clone(input.profileParts) } : {}),
    ...(input.pointLength === undefined ? {} : { pointLength: Number(input.pointLength) }),
    ...(input.constraints?.length ? { constraints: clone(input.constraints) } : {}),
    ...(input.workPlane ? { workPlane: clone(input.workPlane) } : {}),
  };
  return validateDefinition(def);
}

function paramsFor(def: AdaptiveElementDefinition): AuthoredElement["params"] {
  const profiles = def.profileParts?.length ? def.profileParts.map((part) => part.profile) : [def.profile];
  const points = profiles.flat();
  const us = points.map((p) => p.u), vs = points.map((p) => p.v);
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



function snapshotElement(element: AuthoredElement): AdaptiveElementSnapshot {
  const definition = clone((element.properties as Any)?.adaptiveDefinition as AdaptiveElementDefinition);
  return {
    definition,
    params: clone(element.params),
    name: element.name,
    color: element.color,
    properties: clone(element.properties ?? {}),
    familyId: element.familyId,
    familyTypeId: element.familyTypeId,
  };
}

/** Apply a full adaptive state atomically, including undo/redo and point drags. */
function applyElementSnapshot(auth: Any, element: AuthoredElement, snapshot: AdaptiveElementSnapshot): void {
  const previous = snapshotElement(element);
  element.properties = clone(snapshot.properties);
  element.params = clone(snapshot.params);
  element.name = snapshot.name;
  element.color = snapshot.color;
  element.familyId = snapshot.familyId;
  element.familyTypeId = snapshot.familyTypeId;
  try {
    markAndRebuild(auth);
  } catch (error) {
    element.properties = clone(previous.properties);
    element.params = clone(previous.params);
    element.name = previous.name;
    element.color = previous.color;
    element.familyId = previous.familyId;
    element.familyTypeId = previous.familyTypeId;
    try {
      markAndRebuild(auth);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError],
        "Adaptive component '" + element.name + "' state update failed and rollback was incomplete");
    }
    throw error;
  }
}

function rectangleProfile(width: number, depth: number): ProfilePt[] {
  if (!Number.isFinite(width) || !Number.isFinite(depth) || width <= 0 || depth <= 0) {
    throw new Error("Linked family dimensions must be finite and positive");
  }
  const u = width / 2, v = depth / 2;
  return [{ u: -u, v: -v }, { u, v: -v }, { u, v }, { u: -u, v }];
}

function circleProfile(radius: number, segments = 24): ProfilePt[] {
  if (!Number.isFinite(radius) || radius <= 0) throw new Error("Linked family radius must be finite and positive");
  return Array.from({ length: Math.max(8, Math.min(96, Math.round(segments))) }, (_, i) => {
    const a = (i / Math.max(8, Math.min(96, Math.round(segments)))) * Math.PI * 2;
    return { u: radius * Math.cos(a), v: radius * Math.sin(a) };
  });
}

function resolveProfileRef(ref: NumberRef, params: Any): number {
  const value = Number(resolveNumber(ref, params));
  if (!Number.isFinite(value)) throw new Error("Linked family profile contains an invalid dimension");
  return value;
}

function profileFromSpec(spec: Any, params: Any): ProfilePt[] {
  if (spec?.kind === "rect") {
    return rectangleProfile(resolveProfileRef(spec.w, params), resolveProfileRef(spec.h, params));
  }
  if (spec?.kind === "circle") {
    return circleProfile(resolveProfileRef(spec.r, params), spec.segments ?? 24);
  }
  if (spec?.kind === "polygon" && Array.isArray(spec.points)) {
    return spec.points.map((point: number[]) => ({ u: Number(point[0]), v: Number(point[1]) }));
  }
  throw new Error("Unsupported adaptive extrusion profile");
}

/** Apply the part's supported in-plane transform before sweeping the section. */
function transformFamilyProfile(
  profile: ProfilePt[],
  transform: Any,
  params: Any,
): ProfilePt[] {
  if (!transform) return profile;
  const rotate = transform.rotate ?? [];
  const rx = rotate[0] ? resolveProfileRef(rotate[0], params) : 0;
  const ry = rotate[1] ? resolveProfileRef(rotate[1], params) : 0;
  const rz = rotate[2] ? resolveProfileRef(rotate[2], params) : 0;
  if (Math.abs(rx) > 1e-8 || Math.abs(rz) > 1e-8) {
    throw new Error("Adaptive compound sections currently support in-plane rotation about the family Y axis only");
  }
  const scale = transform.scale ?? [];
  const sx = scale[0] ? resolveProfileRef(scale[0], params) : 1;
  const sz = scale[2] ? resolveProfileRef(scale[2], params) : 1;
  if (!(sx > 0) || !(sz > 0)) throw new Error("Adaptive compound profile scales must be positive");
  const translate = transform.translate ?? [];
  const tx = translate[0] ? resolveProfileRef(translate[0], params) : 0;
  const tz = translate[2] ? resolveProfileRef(translate[2], params) : 0;
  const c = Math.cos(ry), si = Math.sin(ry);
  return profile.map((point) => {
    const u = point.u * sx, v = point.v * sz;
    return { u: u * c + v * si + tx, v: -u * si + v * c + tz };
  });
}

function profilesFromFamilyGeometry(
  geometry: Any,
  params: Any,
): AdaptiveProfilePart[] {
  if (!geometry || typeof geometry !== "object") throw new Error("Family geometry is missing");
  if (geometry.kind === "composed") {
    if (!Array.isArray(geometry.parts) || geometry.parts.length === 0) throw new Error("Composed family has no geometry parts");
    return geometry.parts.flatMap((part: Any) => profilesFromFamilyGeometry(part, params));
  }
  if (geometry.kind === "custom") {
    const adapter = adaptiveCustomProfileAdapters.get(String(geometry.builder ?? ""));
    if (!adapter) {
      throw new Error("Custom family builder '" + String(geometry.builder ?? "") + "' has no registered adaptive profile adapter");
    }
    const parts = adapter(params, (ref) => resolveNumber(ref, params), geometry);
    if (!Array.isArray(parts) || parts.length === 0 || parts.length > 64) {
      throw new Error("Custom adaptive profile adapter must return 1 to 64 section parts");
    }
    for (const part of parts) validateProfile(part.profile);
    return clone(parts);
  }
  let profile: ProfilePt[];
  if (geometry.kind === "box") {
    profile = rectangleProfile(resolveProfileRef(geometry.w, params), resolveProfileRef(geometry.d, params));
  } else if (geometry.kind === "cylinder") {
    profile = circleProfile(resolveProfileRef(geometry.r, params), geometry.segments ?? 24);
  } else if (geometry.kind === "extrusion") {
    if (Array.isArray(geometry.holes) && geometry.holes.length) {
      throw new Error("Extrusion profiles with voids require a custom adaptive profile adapter");
    }
    profile = profileFromSpec(geometry.profile, params);
  } else {
    throw new Error("Unsupported shared family geometry kind '" + String(geometry.kind) + "'");
  }
  profile = transformFamilyProfile(profile, geometry.transform, params);
  validateProfile(profile);
  return [{ profile, name: geometry.kind }];
}

/** Resolve a shared family type into every supported cross-section part. */
function profileFromFamilyType(
  familyId: string,
  typeId: string,
): { name: string; profile: ProfilePt[]; profileParts: AdaptiveProfilePart[] } {
  const familyService = (ctx.features as Any)?.family;
  if (!familyService || typeof familyService.get !== "function" || typeof familyService.resolveParams !== "function") {
    throw new Error("The shared family/type service is not ready");
  }
  const family = familyService.get(familyId);
  if (!family) throw new Error("The selected shared family no longer exists");
  const type = (family.types ?? []).find((entry: Any) => entry.id === typeId);
  if (!type) throw new Error("The selected shared family type no longer exists");
  const params = familyService.resolveParams(familyId, typeId);
  if (!params) throw new Error("The selected shared family type could not be resolved");
  const profileParts = profilesFromFamilyGeometry(family.geometry, params);
  const profile = clone(profileParts[0].profile);
  return { name: family.name + " · " + type.name, profile, profileParts };
}

export function getAdaptiveFamilyTypeChoices(): AdaptiveFamilyTypeChoice[] {
  const familyService = (ctx.features as Any)?.family;
  if (!familyService || typeof familyService.list !== "function") return [];
  const choices: AdaptiveFamilyTypeChoice[] = [];
  for (const family of familyService.list() as Any[]) {
    if (!family?.id || !Array.isArray(family.types)) continue;
    for (const type of family.types) {
      if (!type?.id) continue;
      try {
        profileFromFamilyType(String(family.id), String(type.id));
        choices.push({
          familyId: String(family.id),
          typeId: String(type.id),
          label: String(family.name) + " · " + String(type.name),
        });
      } catch { /* unsupported family geometry is not offered */ }
    }
  }
  return choices.sort((a, b) => a.label.localeCompare(b.label));
}

export function bindAdaptiveFamilyType(elementId: string, familyId: string, typeId: string): boolean {
  const resolved = profileFromFamilyType(familyId, typeId);
  return updateAdaptiveElement(elementId, {
    familyName: resolved.name,
    profile: resolved.profile,
    profileParts: resolved.profileParts,
    familyBinding: { familyId, typeId },
  });
}

/** Regenerate linked adaptive instances when a shared family or type changes. */
export async function propagateAdaptiveFamilyTypes(): Promise<number> {
  const auth = authoring();
  const elements = auth?.getElements?.() as AuthoredElement[] | undefined;
  if (!auth || !Array.isArray(elements) || familyPropagationBusy) return 0;
  const changes: Array<{ id: string; profile: ProfilePt[]; profileParts: AdaptiveProfilePart[]; name: string }> = [];
  for (const element of elements) {
    if (element.type !== "adaptive-component") continue;
    const definition = (element.properties as Any)?.adaptiveDefinition as AdaptiveElementDefinition | undefined;
    const binding = definition?.familyBinding;
    if (!binding) continue;
    try {
      const resolved = profileFromFamilyType(binding.familyId, binding.typeId);
      if (JSON.stringify(resolved.profileParts) !== JSON.stringify(definition.profileParts ?? [{ profile: definition.profile }]) ||
          resolved.name !== definition.familyName) {
        changes.push({ id: element.id, profile: resolved.profile, profileParts: resolved.profileParts, name: resolved.name });
      }
    } catch (error) {
      console.warn("[adaptive] linked family type could not be propagated", element.id, error);
    }
  }
  if (!changes.length) return 0;
  familyPropagationBusy = true;
  try {
    await history.transaction("Propagate shared adaptive family type changes", async () => {
      for (const change of changes) {
        updateAdaptiveElement(change.id, { profile: change.profile, profileParts: change.profileParts, familyName: change.name });
      }
    });
  } finally {
    familyPropagationBusy = false;
  }
  return changes.length;
}

export function connectAdaptiveFamilyTypePropagation(): void {
  const familyService = (ctx.features as Any)?.family;
  if (familyUnsubscribe || typeof familyService?.onChange !== "function") return;
  familyUnsubscribe = familyService.onChange(() => {
    void propagateAdaptiveFamilyTypes().catch((error) => {
      console.warn("[adaptive] family type propagation failed", error);
    });
  });
}

/** Snapshot the full definition before a placement-point grip drag. */
export function beginAdaptivePointEdit(elementId: string): AdaptiveElementSnapshot | null {
  const element = (authoring()?.getElements?.() ?? []).find((entry: Any) => entry?.id === elementId) as AuthoredElement | undefined;
  if (!element || element.type !== "adaptive-component") return null;
  return snapshotElement(element);
}

/** Transient live update during a grip drag; it deliberately creates no history item. */
export function previewAdaptivePointEdit(
  elementId: string,
  pointIndex: number,
  point: Pt3,
  baseline: AdaptiveElementSnapshot,
): boolean {
  const auth = authoring();
  const element = (auth?.getElements?.() ?? []).find((entry: Any) => entry?.id === elementId) as AuthoredElement | undefined;
  if (!auth || !element || element.type !== "adaptive-component") return false;
  if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= baseline.definition.points.length) return false;
  const points = clone(baseline.definition.points);
  points[pointIndex] = { x: point.x, y: point.y, z: point.z };
  const definition = validateDefinition({ ...clone(baseline.definition), points }, pointIndex);
  indexedMeshForDefinition(definition, pointIndex);
  const properties = {
    ...clone(baseline.properties),
    adaptiveDefinition: clone(definition),
    adaptiveFamilyName: definition.familyName,
    adaptivePointCount: definition.pointCount,
  };
  applyElementSnapshot(auth, element, {
    ...clone(baseline),
    definition,
    params: paramsFor(definition),
    properties,
  });
  return true;
}

/** Commit the live point drag as exactly one undoable command. */
export function commitAdaptivePointEdit(
  elementId: string,
  baseline: AdaptiveElementSnapshot,
): boolean {
  const element = (authoring()?.getElements?.() ?? []).find((entry: Any) => entry?.id === elementId) as AuthoredElement | undefined;
  if (!element || element.type !== "adaptive-component") return false;
  const after = snapshotElement(element);
  if (JSON.stringify(baseline) === JSON.stringify(after)) return false;
  const auth = authoring();
  if (!auth) return false;
  history.push({
    label: "Move adaptive placement point · " + element.name,
    apply: () => applyElementSnapshot(auth, element, after),
    revert: () => applyElementSnapshot(auth, element, baseline),
  });
  return true;
}

/** Restore the original definition when a grip drag is cancelled. */
export function cancelAdaptivePointEdit(
  elementId: string,
  baseline: AdaptiveElementSnapshot,
): boolean {
  const auth = authoring();
  const element = (auth?.getElements?.() ?? []).find((entry: Any) => entry?.id === elementId) as AuthoredElement | undefined;
  if (!auth || !element || element.type !== "adaptive-component") return false;
  applyElementSnapshot(auth, element, baseline);
  return true;
}

export function updateAdaptiveElement(elementId: string, patch: AdaptiveElementPatch): boolean {
  const auth = authoring();
  const elements = auth?.getElements?.() as AuthoredElement[] | undefined;
  const element = elements?.find((entry) => entry.id === elementId);
  if (!auth || !element || element.type !== "adaptive-component") return false;
  const beforeDefinition = clone((element.properties as Any)?.adaptiveDefinition as AdaptiveElementDefinition);
  const linkedProfile = patch.familyBinding
    ? profileFromFamilyType(patch.familyBinding.familyId, patch.familyBinding.typeId)
    : null;
  const afterDefinition = validateDefinition({
    ...beforeDefinition,
    familyName: linkedProfile?.name ?? patch.familyName ?? beforeDefinition.familyName,
    points: patch.points ? clone(patch.points) : beforeDefinition.points,
    profile: linkedProfile?.profile ?? (patch.profile ? clone(patch.profile) : beforeDefinition.profile),
    profileParts: linkedProfile?.profileParts ?? (patch.profile ? undefined : patch.profileParts ? clone(patch.profileParts) : beforeDefinition.profileParts),
    pointCount: patch.points ? patch.points.length : beforeDefinition.pointCount,
    pointLength: patch.pointLength ?? beforeDefinition.pointLength,
    constraints: patch.constraints ? clone(patch.constraints) : beforeDefinition.constraints,
    workPlane: patch.workPlane === undefined
      ? beforeDefinition.workPlane
      : patch.workPlane ? clone(patch.workPlane) : undefined,
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
  beginPointEdit: typeof beginAdaptivePointEdit;
  previewPointEdit: typeof previewAdaptivePointEdit;
  commitPointEdit: typeof commitAdaptivePointEdit;
  cancelPointEdit: typeof cancelAdaptivePointEdit;
  listFamilyTypeChoices: typeof getAdaptiveFamilyTypeChoices;
  bindFamilyType: typeof bindAdaptiveFamilyType;
  registerCustomFamilyProfileAdapter: typeof registerAdaptiveCustomFamilyProfileAdapter;
  connectFamilyTypePropagation: typeof connectAdaptiveFamilyTypePropagation;
  propagateFamilyTypes: typeof propagateAdaptiveFamilyTypes;
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
      beginPointEdit: beginAdaptivePointEdit,
      previewPointEdit: previewAdaptivePointEdit,
      commitPointEdit: commitAdaptivePointEdit,
      cancelPointEdit: cancelAdaptivePointEdit,
      listFamilyTypeChoices: getAdaptiveFamilyTypeChoices,
      bindFamilyType: bindAdaptiveFamilyType,
      registerCustomFamilyProfileAdapter: registerAdaptiveCustomFamilyProfileAdapter,
      connectFamilyTypePropagation: connectAdaptiveFamilyTypePropagation,
      propagateFamilyTypes: propagateAdaptiveFamilyTypes,
    };
    (ctx.features as Any).adaptiveAuthoring = api;
    installed = true;
  }
  return (ctx.features as Any).adaptiveAuthoring;
}
