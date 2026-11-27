/**
 * Authoring core — parametric graph, registry, solids, snapping, relationships.
 *
 * Implements the Design spec authorized modules (1, 2, 2B, 2C, 2D, 2E)
 * as pure engines and registers them on ctx.features for the app,
 * ribbon, automation and AI tools:
 *
 *   parametricEngine — dependency graph + parameter engine (Modules 1.1–1.3, 1.6)
 *   bimRegistry   — object hierarchy + identity (Module 2.1–2.2)
 *   solidKernel     — solid kernel: forms, booleans, voids, validation (2.7–2.9, 2.12)
 *   snappingEngine   — magnetic snapping + modeling state machine + wall-column + alignment (2B.1–2B.4)
 *   relationshipRegistry — persistent relationship registry (2B.5–2B.6)
 *   mepConnectors — MEP connector intelligence (2B.7)
 *   modifyEngine     — unified Modify command engine (2C)
 *   propertyEngine — property schemas + editing lifecycle + dimensions (2D)
 *   hostingEngine    — host parameterization + opening regeneration (1.5)
 *
 * Pure engines: no DOM beyond global registration, so a failure here
 * cannot break boot (the boot wrapper catches).
 */

import { ctx } from "../core/context";
import { DependencyGraph } from "./dependency-graph";
import { ParameterEngine, convertUnits, parseParameterValue, formatParameterValue } from "./parameter-engine";
import { BimRegistry, newUniqueId } from "./object-hierarchy";
import {
  extrude, revolve, sweep, blend, subtract, union, intersect,
  cutVoids, generateVoid, planesOfConvex, AabbTree,
  generalBoolean, generalUnion, generalIntersect, generalSubtract,
  fuseAll, weldMesh, hollowExtrusion, hollowMetrics, offsetClosedRing,
  loftSections,
  validateMeshDiagnostics, validateProfileDiagnostics, commitEligible,
  gateSolid, assertCommitEligible, gateImportedSolid,
  threeGeometryToIndexedMesh, summarizeGateDiagnostics,
  listQuarantinedSolids, isQuarantined, clearQuarantinedSolids,
  ValidationGateError,
  // K4 unified Boolean post-condition: one post-condition for all
  // three engines + general-kernel fallback for three-csg-ts cuts.
  applyBooleanPostcondition, postconditionThreeCsgResult,
  recordBooleanCutFailure, MIN_REMOVED_VOLUME_M3,
} from "./solid-kernel";
// K4 THREE adapter (imported directly, not via the barrel: it needs
// `three` / `three-csg-ts`, which do not resolve from the /tmp dirs
// Node tests compile the barrel into).
import { subtractThreeMesh } from "./solid-kernel/three-boolean";
import {
  ModelingSession, DEFAULT_SNAP_SETTINGS,
  getColumnReferenceGeometry, getWallLocationLine, calculateWallEndpoint,
  previewWallColumnJoin, createWallColumnRelationship,
  validateWallColumnConnection,
  computeAlignmentResidual, detectAlignmentConflict,
} from "./snapping";
import { RelationshipRegistry, defaultPolicyFor } from "./relationships";
import {
  evaluateConnectorCompatibility, queryCompatibleConnectors,
  calculateRequiredFittings, findMepConnectionPath, previewMepConnection,
  createConnectorRelationship, validateMepNetworkTopology,
  disconnectMepConnectors,
} from "./mep/connectors";
import {
  MoveCommand, RotateCommand, AlignCommand, OffsetCommand,
  TrimExtendCommand, SplitCommand, CopyCommand,
  ArrayLinearCommand, ArrayRadialCommand, MirrorCommand, rotateAboutAxis,
  MoveTool, RotateTool, MirrorTool,
} from "./modify";
import { SelectionEngine } from "./selection";
import { ReferenceService, REFERENCE_ELIGIBILITY } from "./references";
import {
  GetPropertyDefinitions, GetPropertyValue, IsPropertyEditable,
  ParsePropertyInput, BuildPropertyChangeSet, PreviewPropertyChange,
  CommitPropertyChange, coveredCategories,
  EvaluateDimension, ResolveDimensionEdit, CommitDimensionEdit, IsDimensionDriving,
} from "./properties-panel/authoring";
import {
  evaluateHost, hostLength, placeOpening, findOverlappingOpenings,
  evaluateHostedOpeningsAfterHostChange,
} from "./hosting";

type Any = Record<string, any>;
const w = window as unknown as Any;

function features(): Any {
  const c = ctx as Any;
  if (!c.features) c.features = {};
  return c.features;
}

export function setupAuthoringCore(): void {
  // ── 1. Parametric engine (dependency graph + parameters) ────────────────
  const parametricApi = {
    DependencyGraph,
    ParameterEngine,
    convertUnits,
    parse: parseParameterValue,
    format: formatParameterValue,
  };

  features().parametricEngine = parametricApi;

  // ── 2. Object hierarchy ─────────────────────────────────────────────────
  const registry = new BimRegistry();
  const registryApi = {
    registry,
    BimRegistry,
    newUniqueId,
  };

  features().bimRegistry = registryApi;

  // ── 3. Solid kernel ─────────────────────────────────────────────────────
  const solidsApi = {
    extrude, revolve, sweep, blend,
    subtract, union, intersect,
    // v0.70 general boolean kernel (non-convex operands, coplanar resolution)
    generalBoolean, generalUnion, generalIntersect, generalSubtract,
    fuseAll, weldMesh,
    hollowExtrusion, hollowMetrics, offsetClosedRing, loftSections,
    cutVoids, generateVoid, planesOfConvex, AabbTree,
    validate: validateMeshDiagnostics,
    validateProfile: validateProfileDiagnostics,
    commitEligible,
    // K1 validation gate: validate (welded) on every Boolean result +
    // authoring commit / import; refuse / quarantine on errors.
    gateSolid,
    assertCommitEligible,
    gateImportedSolid,
    threeGeometryToIndexedMesh,
    summarizeGateDiagnostics,
    listQuarantinedSolids,
    isQuarantined,
    clearQuarantinedSolids,
    quarantinedSolids: listQuarantinedSolids,
    ValidationGateError,
    // K4 unified Boolean post-condition (one post-condition for all
    // three engines; three-csg-ts cuts fall back to the general kernel
    // and surface total failures instead of keeping uncut solids).
    applyBooleanPostcondition,
    postconditionThreeCsgResult,
    recordBooleanCutFailure,
    MIN_REMOVED_VOLUME_M3,
    subtractThreeMesh,
  };

  features().solidKernel = solidsApi;

  // ── 4. Snapping + modeling state machine ────────────────────────────────
  const snappingApi = {
    ModelingSession,
    settings: DEFAULT_SNAP_SETTINGS,
    getColumnReferenceGeometry,
    getWallLocationLine,
    calculateWallEndpoint,
    previewWallColumnJoin,
    createWallColumnRelationship,
    validateWallColumnConnection,
    computeAlignmentResidual,
    detectAlignmentConflict,
  };

  features().snappingEngine = snappingApi;

  // ── 5. Relationships ────────────────────────────────────────────────────
  const relationships = new RelationshipRegistry();
  const relationshipsApi = {
    registry: relationships,
    RelationshipRegistry,
    defaultPolicyFor,
  };

  features().relationshipRegistry = relationshipsApi;

  // ── 6. MEP connectors ───────────────────────────────────────────────────
  const mepConnectorsApi = {
    evaluateConnectorCompatibility,
    queryCompatibleConnectors,
    calculateRequiredFittings,
    findMepConnectionPath,
    previewMepConnection,
    createConnectorRelationship,
    validateMepNetworkTopology,
    disconnectMepConnectors,
  };
  features().mepConnectors = mepConnectorsApi;
  const existingMep = (w.__obsMep ?? {}) as Any;
  w.__obsMep = { ...existingMep, connectors: mepConnectorsApi };

  // ── 7. Modify engine ────────────────────────────────────────────────────
  const modifyApi = {
    MoveCommand, RotateCommand, AlignCommand, OffsetCommand,
    TrimExtendCommand, SplitCommand, CopyCommand,
    ArrayLinearCommand, ArrayRadialCommand, MirrorCommand,
    // Group 1 tools (v71 spec §4–§6): full catalogs + transaction undo/redo
    MoveTool, RotateTool, MirrorTool,
    rotateAboutAxis,
  };

  features().modifyEngine = modifyApi;

  // ── 7b. Group 1 selection + reference engines (v71 spec §2–§3) ─────────
  const selectionApi = { SelectionEngine };

  features().selectionEngine = selectionApi;
  const referencesApi = { ReferenceService, REFERENCE_ELIGIBILITY };

  features().referenceService = referencesApi;

  // ── 8. Property panel engine ────────────────────────────────────────────
  const propertiesApi = {
    GetPropertyDefinitions,
    GetPropertyValue,
    IsPropertyEditable,
    ParsePropertyInput,
    BuildPropertyChangeSet,
    PreviewPropertyChange,
    CommitPropertyChange,
    coveredCategories,
    EvaluateDimension,
    ResolveDimensionEdit,
    CommitDimensionEdit,
    IsDimensionDriving,
  };

  features().propertyEngine = propertiesApi;

  // ── 9. Hosting ──────────────────────────────────────────────────────────
  const hostingApi = {
    evaluateHost,
    hostLength,
    placeOpening,
    findOverlappingOpenings,
    evaluateHostedOpeningsAfterHostChange,
  };

  features().hostingEngine = hostingApi;

  console.log(
    "[obs] v68 engines registered on ctx.features: parametricEngine, bimRegistry, solidKernel, " +
    "snappingEngine, relationshipRegistry, mepConnectors, modifyEngine, " +
    "propertyEngine, hostingEngine",
  );
}
