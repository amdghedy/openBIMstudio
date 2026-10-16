/**
 * IFC category catalog.
 *
 * Maps each category to a suggested column set, default grouping, and
 * discipline. Used by the AI schedule builder and by the "new schedule"
 * dialog to auto-populate a definition from just a category name.
 */

export type Discipline =
  | "architectural"
  | "structural"
  | "mechanical"
  | "electrical"
  | "plumbing"
  | "fire"
  | "civil"
  | "site"
  | "rooms"
  | "other";

export interface CategoryEntry {
  ifc: string;
  label: string;
  discipline: Discipline;
  defaultColumns: string[];
  defaultGrouping: string[];
  defaultSort: string;
}

export const CATEGORY_CATALOG: CategoryEntry[] = [
  // Architectural
  {
    ifc: "IFCWALL",
    label: "Walls",
    discipline: "architectural",
    defaultColumns: ["type", "level", "length", "thickness", "height", "area", "volume", "fireRating", "costItem", "lineCost"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCWALLSTANDARDCASE",
    label: "Walls (standard)",
    discipline: "architectural",
    defaultColumns: ["type", "level", "length", "thickness", "height", "area", "volume"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCDOOR",
    label: "Doors",
    discipline: "architectural",
    defaultColumns: ["mark", "type", "level", "width", "height", "fireRating", "panel", "costItem", "lineCost"],
    defaultGrouping: ["level"],
    defaultSort: "mark",
  },
  {
    ifc: "IFCWINDOW",
    label: "Windows",
    discipline: "architectural",
    defaultColumns: ["mark", "type", "level", "width", "height", "glazing", "costItem", "lineCost"],
    defaultGrouping: ["level"],
    defaultSort: "mark",
  },
  {
    ifc: "IFCSLAB",
    label: "Slabs",
    discipline: "architectural",
    defaultColumns: ["type", "level", "area", "thickness", "volume", "material", "costItem", "lineCost"],
    defaultGrouping: ["level"],
    defaultSort: "type",
  },
  {
    ifc: "IFCROOF",
    label: "Roofs",
    discipline: "architectural",
    defaultColumns: ["type", "level", "area", "volume", "material"],
    defaultGrouping: ["level"],
    defaultSort: "type",
  },
  {
    ifc: "IFCCEILING",
    label: "Ceilings",
    discipline: "architectural",
    defaultColumns: ["type", "level", "area", "material"],
    defaultGrouping: ["level"],
    defaultSort: "type",
  },
  {
    ifc: "IFCSTAIR",
    label: "Stairs",
    discipline: "architectural",
    defaultColumns: ["type", "level", "width", "height", "count"],
    defaultGrouping: ["level"],
    defaultSort: "type",
  },
  {
    ifc: "IFCRAILING",
    label: "Railings",
    discipline: "architectural",
    defaultColumns: ["type", "level", "length", "height", "material"],
    defaultGrouping: ["level"],
    defaultSort: "type",
  },
  {
    ifc: "IFCCURTAINWALL",
    label: "Curtain walls",
    discipline: "architectural",
    defaultColumns: ["type", "level", "area", "material"],
    defaultGrouping: ["level"],
    defaultSort: "type",
  },
  {
    ifc: "IFCCOVERING",
    label: "Coverings",
    discipline: "architectural",
    defaultColumns: ["type", "level", "area", "material"],
    defaultGrouping: ["level"],
    defaultSort: "type",
  },
  {
    ifc: "IFCFURNISHINGELEMENT",
    label: "Furniture",
    discipline: "architectural",
    defaultColumns: ["type", "level", "count", "costItem", "lineCost"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },

  // Structural
  {
    ifc: "IFCBEAM",
    label: "Beams",
    discipline: "structural",
    defaultColumns: ["type", "level", "length", "width", "height", "volume", "material", "costItem", "lineCost"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCCOLUMN",
    label: "Columns",
    discipline: "structural",
    defaultColumns: ["type", "level", "width", "depth", "height", "volume", "material", "costItem", "lineCost"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCMEMBER",
    label: "Members",
    discipline: "structural",
    defaultColumns: ["type", "level", "length", "volume", "material"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCPLATE",
    label: "Plates",
    discipline: "structural",
    defaultColumns: ["type", "level", "area", "thickness", "volume", "material"],
    defaultGrouping: ["level"],
    defaultSort: "type",
  },
  {
    ifc: "IFCFOOTING",
    label: "Footings",
    discipline: "structural",
    defaultColumns: ["type", "level", "width", "depth", "height", "volume", "material", "costItem", "lineCost"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCPILE",
    label: "Piles",
    discipline: "structural",
    defaultColumns: ["type", "length", "material", "count"],
    defaultGrouping: ["type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCREINFORCINGBAR",
    label: "Reinforcement",
    discipline: "structural",
    defaultColumns: ["type", "length", "volume", "material", "count"],
    defaultGrouping: ["type"],
    defaultSort: "type",
  },

  // Mechanical
  {
    ifc: "IFCDUCTSEGMENT",
    label: "Duct segments",
    discipline: "mechanical",
    defaultColumns: ["systemType", "category", "length", "width", "height", "costItem", "lineCost"],
    defaultGrouping: ["systemType", "category"],
    defaultSort: "systemType",
  },
  {
    ifc: "IFCDUCTFITTING",
    label: "Duct fittings",
    discipline: "mechanical",
    defaultColumns: ["systemType", "type", "count", "costItem", "lineCost"],
    defaultGrouping: ["systemType", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCAIRTERMINAL",
    label: "Air terminals",
    discipline: "mechanical",
    defaultColumns: ["type", "level", "width", "height", "count", "costItem", "lineCost"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCAIRTERMINALBOX",
    label: "Air terminal boxes",
    discipline: "mechanical",
    defaultColumns: ["type", "level", "count"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCFLOWSEGMENT",
    label: "Flow segments",
    discipline: "mechanical",
    defaultColumns: ["systemType", "category", "length", "count"],
    defaultGrouping: ["systemType", "category"],
    defaultSort: "systemType",
  },
  {
    ifc: "IFCFLOWFITTING",
    label: "Flow fittings",
    discipline: "mechanical",
    defaultColumns: ["systemType", "type", "count"],
    defaultGrouping: ["systemType", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCFLOWTERMINAL",
    label: "Flow terminals",
    discipline: "mechanical",
    defaultColumns: ["systemType", "type", "count"],
    defaultGrouping: ["systemType", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCFLOWMOVINGDEVICE",
    label: "Fans and pumps",
    discipline: "mechanical",
    defaultColumns: ["type", "level", "count", "costItem", "lineCost"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCENERGYCONVERSIONDEVICE",
    label: "HVAC equipment",
    discipline: "mechanical",
    defaultColumns: ["type", "level", "count", "costItem", "lineCost"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCUNITARYEQUIPMENT",
    label: "Unitary equipment",
    discipline: "mechanical",
    defaultColumns: ["type", "level", "count"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },

  // Plumbing
  {
    ifc: "IFCPIPESEGMENT",
    label: "Pipe segments",
    discipline: "plumbing",
    defaultColumns: ["systemType", "category", "length", "thickness", "costItem", "lineCost"],
    defaultGrouping: ["systemType", "category"],
    defaultSort: "systemType",
  },
  {
    ifc: "IFCPIPEFITTING",
    label: "Pipe fittings",
    discipline: "plumbing",
    defaultColumns: ["systemType", "type", "count", "costItem", "lineCost"],
    defaultGrouping: ["systemType", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCVALVE",
    label: "Valves",
    discipline: "plumbing",
    defaultColumns: ["type", "systemType", "count", "costItem", "lineCost"],
    defaultGrouping: ["systemType", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCSANITARYTERMINAL",
    label: "Plumbing fixtures",
    discipline: "plumbing",
    defaultColumns: ["type", "level", "count", "costItem", "lineCost"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCPUMP",
    label: "Pumps",
    discipline: "plumbing",
    defaultColumns: ["type", "level", "count", "costItem", "lineCost"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCTANK",
    label: "Tanks",
    discipline: "plumbing",
    defaultColumns: ["type", "level", "volume", "count"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },

  // Fire
  {
    ifc: "IFCFIRESUPPRESSIONTERMINAL",
    label: "Sprinklers",
    discipline: "fire",
    defaultColumns: ["type", "level", "count", "costItem", "lineCost"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },

  // Electrical
  {
    ifc: "IFCCABLECARRIERSEGMENT",
    label: "Cable tray segments",
    discipline: "electrical",
    defaultColumns: ["systemType", "category", "length", "width", "height", "costItem", "lineCost"],
    defaultGrouping: ["systemType", "category"],
    defaultSort: "systemType",
  },
  {
    ifc: "IFCCABLECARRIERFITTING",
    label: "Cable tray fittings",
    discipline: "electrical",
    defaultColumns: ["systemType", "type", "count"],
    defaultGrouping: ["systemType", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCCONDUITSEGMENT",
    label: "Conduit segments",
    discipline: "electrical",
    defaultColumns: ["systemType", "category", "length", "thickness", "costItem", "lineCost"],
    defaultGrouping: ["systemType", "category"],
    defaultSort: "systemType",
  },
  {
    ifc: "IFCCONDUITFITTING",
    label: "Conduit fittings",
    discipline: "electrical",
    defaultColumns: ["systemType", "type", "count"],
    defaultGrouping: ["systemType", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCLIGHTFIXTURE",
    label: "Light fixtures",
    discipline: "electrical",
    defaultColumns: ["type", "level", "count", "costItem", "lineCost"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCOUTLET",
    label: "Outlets",
    discipline: "electrical",
    defaultColumns: ["type", "level", "count"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCSWITCHINGDEVICE",
    label: "Switches",
    discipline: "electrical",
    defaultColumns: ["type", "level", "count"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCELECTRICGENERATOR",
    label: "Generators",
    discipline: "electrical",
    defaultColumns: ["type", "level", "count"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCTRANSFORMER",
    label: "Transformers",
    discipline: "electrical",
    defaultColumns: ["type", "level", "count"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCELECTRICDISTRIBUTIONBOARD",
    label: "Electrical panels",
    discipline: "electrical",
    defaultColumns: ["type", "level", "count"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },

  // Civil / site
  {
    ifc: "IFCSITE",
    label: "Site",
    discipline: "site",
    defaultColumns: ["name", "area"],
    defaultGrouping: [],
    defaultSort: "name",
  },
  {
    ifc: "IFCBUILDING",
    label: "Buildings",
    discipline: "site",
    defaultColumns: ["name", "area"],
    defaultGrouping: [],
    defaultSort: "name",
  },
  {
    ifc: "IFCBUILDINGSTOREY",
    label: "Storeys",
    discipline: "site",
    defaultColumns: ["name", "elevation", "area"],
    defaultGrouping: [],
    defaultSort: "elevation",
  },
  {
    ifc: "IFCSPACE",
    label: "Spaces",
    discipline: "rooms",
    defaultColumns: ["name", "level", "area", "volume", "count"],
    defaultGrouping: ["level"],
    defaultSort: "name",
  },
  {
    ifc: "IFCZONE",
    label: "Zones",
    discipline: "rooms",
    defaultColumns: ["name", "area", "count"],
    defaultGrouping: [],
    defaultSort: "name",
  },
  {
    ifc: "IFCRAIL",
    label: "Rail",
    discipline: "civil",
    defaultColumns: ["type", "length", "material"],
    defaultGrouping: ["type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCROAD",
    label: "Roads",
    discipline: "civil",
    defaultColumns: ["type", "length", "area", "material"],
    defaultGrouping: ["type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCPAVEMENT",
    label: "Pavements",
    discipline: "civil",
    defaultColumns: ["type", "area", "material"],
    defaultGrouping: ["type"],
    defaultSort: "type",
  },

  // Other
  {
    ifc: "IFCOPENINGELEMENT",
    label: "Openings",
    discipline: "other",
    defaultColumns: ["type", "level", "width", "height", "count"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
  {
    ifc: "IFCBUILDINGELEMENTPROXY",
    label: "Generic elements",
    discipline: "other",
    defaultColumns: ["type", "level", "area", "volume"],
    defaultGrouping: ["level", "type"],
    defaultSort: "type",
  },
];

export function findCategory(ifc: string): CategoryEntry | undefined {
  const upper = ifc.toUpperCase();
  return CATEGORY_CATALOG.find(
    (c) => c.ifc === upper || c.ifc.startsWith(upper) || upper.startsWith(c.ifc),
  );
}

export function listDisciplines(): { key: Discipline; label: string }[] {
  return [
    { key: "architectural", label: "Architectural" },
    { key: "structural", label: "Structural" },
    { key: "mechanical", label: "Mechanical" },
    { key: "plumbing", label: "Plumbing" },
    { key: "fire", label: "Fire protection" },
    { key: "electrical", label: "Electrical" },
    { key: "civil", label: "Civil" },
    { key: "site", label: "Site & buildings" },
    { key: "rooms", label: "Rooms & zones" },
    { key: "other", label: "Other" },
  ];
}