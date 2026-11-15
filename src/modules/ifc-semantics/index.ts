/**
 * IFC semantic intelligence — public surface.
 *
 *   readStep / splitStepArgs …    independent ISO-10303-21 reader
 *   collectUnits / readUnits      IfcUnitAssignment → SI base conversion
 *   buildSemanticModel            typed index: classes, GUIDs, relationships,
 *                                 psets, quantities, classifications, spatial
 *                                 tree, placements, preserved unknowns
 *   inspectElement / findByGlobalId / physicalElementIds
 *   validateSemanticModel / summarizeFindings
 */

export * from "./step-reader";
export * from "./units";
export * from "./semantic-model";
export * from "./inspect";
export * from "./validate";
export { isValidIfcGuid, newIfcGuid, stableIfcGuid, compressGuid, decompressGuid } from "../bim-gaps/ifc-guid";
