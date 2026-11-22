"use strict";
/**
 * View Templates + Visibility/Graphics – shared types (BIM workflow alignment).
 * Compatible with existing VisibilityFilter category overrides.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STANDARD_CATEGORIES = void 0;
exports.createDefaultVg = createDefaultVg;
exports.defaultCategoryOverride = defaultCategoryOverride;
/** Default VG used when nothing is set. */
function createDefaultVg() {
    return {
        categoryOverrides: {},
        filters: [],
        showAnnotations: true,
        showModel: true,
        detailLevel: "medium",
        modelDisplay: "shaded",
        underlay: { levelId: null, orientation: "none" },
    };
}
/** Standard architectural categories used by the VG dialog. */
exports.STANDARD_CATEGORIES = [
    { id: "Walls", label: "Walls", group: "Architecture" },
    { id: "Floors", label: "Floors", group: "Architecture" },
    { id: "Roofs", label: "Roofs", group: "Architecture" },
    { id: "Ceilings", label: "Ceilings", group: "Architecture" },
    { id: "Doors", label: "Doors", group: "Architecture" },
    { id: "Windows", label: "Windows", group: "Architecture" },
    { id: "Stairs", label: "Stairs", group: "Architecture" },
    { id: "Railings", label: "Railings", group: "Architecture" },
    { id: "CurtainWalls", label: "Curtain Walls", group: "Architecture" },
    { id: "Columns", label: "Columns", group: "Structure" },
    { id: "StructuralFraming", label: "Structural Framing", group: "Structure" },
    { id: "Foundations", label: "Foundations", group: "Structure" },
    { id: "Ducts", label: "Ducts", group: "MEP" },
    { id: "Pipes", label: "Pipes", group: "MEP" },
    { id: "CableTrays", label: "Cable Trays", group: "MEP" },
    { id: "Conduits", label: "Conduits", group: "MEP" },
    { id: "MechanicalEquipment", label: "Mechanical Equipment", group: "MEP" },
    { id: "ElectricalEquipment", label: "Electrical Equipment", group: "MEP" },
    { id: "PlumbingFixtures", label: "Plumbing Fixtures", group: "MEP" },
    { id: "Rooms", label: "Rooms", group: "Spatial" },
    { id: "Areas", label: "Areas", group: "Spatial" },
    { id: "Spaces", label: "Spaces", group: "Spatial" },
    { id: "Grids", label: "Grids", group: "Annotation" },
    { id: "Levels", label: "Levels", group: "Annotation" },
    { id: "Dimensions", label: "Dimensions", group: "Annotation" },
    { id: "Tags", label: "Tags", group: "Annotation" },
    { id: "TextNotes", label: "Text Notes", group: "Annotation" },
    { id: "DetailItems", label: "Detail Items", group: "Annotation" },
    { id: "GenericModels", label: "Generic Models", group: "Model" },
    { id: "Mass", label: "Mass", group: "Model" },
    { id: "Site", label: "Site", group: "Model" },
    { id: "Topography", label: "Topography", group: "Model" },
];
function defaultCategoryOverride() {
    return {
        visible: true,
        halftone: false,
        transparent: false,
        lineColor: null,
        surfaceColor: null,
        lineWeight: null,
        surfacePattern: null,
        cutPattern: null,
    };
}
