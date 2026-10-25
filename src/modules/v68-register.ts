/**
 * v68 module globals — the "Authoring Core" engine package.
 *
 * Implements the MASTER PROMPT authorized modules (1, 2, 2B, 2C, 2D, 2E)
 * as pure engines and exposes them on window.__obs* for the console,
 * ribbon, automation and AI tools:
 *
 *   __obsParametric — dependency graph + parameter engine (Modules 1.1–1.3, 1.6)
 *   __obsRegistry   — object hierarchy + identity (Module 2.1–2.2)
 *   __obsSolids     — solid kernel: forms, booleans, voids, validation (2.7–2.9, 2.12)
 *   __obsSnapping   — magnetic snapping + modeling state machine + wall-column + alignment (2B.1–2B.4)
 *   __obsRelationships — persistent relationship registry (2B.5–2B.6)
 *   __obsMepConnectors — MEP connector intelligence (2B.7)
 *   __obsModify     — unified Modify command engine (2C)
 *   __obsProperties — property schemas + editing lifecycle + dimensions (2D)
 *   __obsHosting    — host parameterization + opening regeneration (1.5)
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
  validateMeshDiagnostics, validateProfileDiagnostics, commitEligible,
} from "./solid-kernel";
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
} from "./modify";
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

export function setupV68Engines(): void {
  // ── 1. Parametric engine (dependency graph + parameters) ────────────────
  const parametricApi = {
    DependencyGraph,
    ParameterEngine,
    convertUnits,
    parse: parseParameterValue,
    format: formatParameterValue,
  };
  w.__obsParametric = parametricApi;
  features().parametricEngine = parametricApi;

  // ── 2. Object hierarchy ─────────────────────────────────────────────────
  const registry = new BimRegistry();
  const registryApi = {
    registry,
    BimRegistry,
    newUniqueId,
  };
  w.__obsRegistry = registryApi;
  features().bimRegistry = registryApi;

  // ── 3. Solid kernel ─────────────────────────────────────────────────────
  const solidsApi = {
    extrude, revolve, sweep, blend,
    subtract, union, intersect,
    cutVoids, generateVoid, planesOfConvex, AabbTree,
    validate: validateMeshDiagnostics,
    validateProfile: validateProfileDiagnostics,
    commitEligible,
  };
  w.__obsSolids = solidsApi;
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
  w.__obsSnapping = snappingApi;
  features().snappingEngine = snappingApi;

  // ── 5. Relationships ────────────────────────────────────────────────────
  const relationships = new RelationshipRegistry();
  const relationshipsApi = {
    registry: relationships,
    RelationshipRegistry,
    defaultPolicyFor,
  };
  w.__obsRelationships = relationshipsApi;
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
  w.__obsMepConnectors = mepConnectorsApi;
  const existingMep = (w.__obsMep ?? {}) as Any;
  w.__obsMep = { ...existingMep, connectors: mepConnectorsApi };

  // ── 7. Modify engine ────────────────────────────────────────────────────
  const modifyApi = {
    MoveCommand, RotateCommand, AlignCommand, OffsetCommand,
    TrimExtendCommand, SplitCommand, CopyCommand,
    ArrayLinearCommand, ArrayRadialCommand, MirrorCommand,
    rotateAboutAxis,
  };
  w.__obsModify = modifyApi;
  features().modifyEngine = modifyApi;

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
  w.__obsProperties = propertiesApi;
  features().propertyEngine = propertiesApi;

  // ── 9. Hosting ──────────────────────────────────────────────────────────
  const hostingApi = {
    evaluateHost,
    hostLength,
    placeOpening,
    findOverlappingOpenings,
    evaluateHostedOpeningsAfterHostChange,
  };
  w.__obsHosting = hostingApi;
  features().hostingEngine = hostingApi;

  console.log(
    "[obs] v68 engines registered: __obsParametric, __obsRegistry, __obsSolids, " +
    "__obsSnapping, __obsRelationships, __obsMepConnectors, __obsModify, " +
    "__obsProperties, __obsHosting",
  );
}
