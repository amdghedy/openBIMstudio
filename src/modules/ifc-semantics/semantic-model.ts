/**
 * IFC semantic model — builds a typed index over an SPF file:
 *
 *   entity classes · GlobalIds (validity + duplicates) · unit assignment ·
 *   spatial structure (Project→Site→Building→Storey) · containment ·
 *   relationships (aggregates, containment, voids, fills, properties,
 *   materials, classifications) · property sets · quantity sets ·
 *   placement chains (world matrices) · preserved unknown classes.
 *
 * Built ON TOP of the independent step-reader; shares no code with web-ifc
 * or the platform writers, so it can audit their output. Unknown entity
 * classes are PRESERVED (counted, never dropped) and every problem becomes
 * a warning — invalid or incomplete models never throw.
 */

import {
  readStep, parseRef, parseRefList, unquote, unenum,
  type StepFile, type StepEntity,
} from "./step-reader";
import { collectUnits, type UnitsAssignment } from "./units";
import { isValidIfcGuid } from "../bim-gaps/ifc-guid";

export type RelKind =
  | "aggregates"
  | "containment"
  | "voids"
  | "fills"
  | "properties"
  | "material"
  | "classification"
  | "other";

export interface RelationshipRecord {
  kind: RelKind;
  cls: string;
  id: number;
  globalId: string | null;
  /** Entities on the "many" side (related objects). */
  related: number[];
  /** Entity on the "one" side (relating object). */
  relating: number | null;
  /** Raw argument text for unknown relationship classes. */
  raw?: string;
}

export interface ParsedProperty {
  id: number;
  name: string;
  value: ParsedValue;
}

export interface ParsedValue {
  type: "real" | "integer" | "boolean" | "label" | "enum" | "ref" | "null" | "unknown";
  value: number | string | boolean | null;
  /** Measure type when the literal carried one (IFCLENGTHMEASURE, …). */
  measure?: string;
  /** Unit role+factor when the property declared a unit entity. */
  unitRole?: string;
  unitFactor?: number;
  unitName?: string;
}

export interface ParsedQuantity {
  id: number;
  cls: string;
  name: string;
  value: number | null;
  /** Unit entity id if declared. */
  unitId: number | null;
}

export interface PsetRecord {
  id: number;
  name: string;
  props: ParsedProperty[];
  /** Express ids of elements this pset is attached to (via RelDefinesByProperties). */
  hosts: number[];
}

export interface QtoRecord {
  id: number;
  name: string;
  quantities: ParsedQuantity[];
  hosts: number[];
}

export interface ClassificationRecord {
  id: number;
  cls: "IFCCLASSIFICATION" | "IFCCLASSIFICATIONREFERENCE";
  /** IfcClassification: Name (4-arg 2x3 form, 7-arg IFC4 form). */
  name: string | null;
  /** IfcClassification: Source / Edition / Location when present. */
  source: string | null;
  edition: string | null;
  location: string | null;
  /** IfcClassificationReference: Identification / ItemReference token. */
  identification: string | null;
  /** Reference → classification parent (ReferencedSource). */
  referencedSource: number | null;
  /** Elements associated via IfcRelAssociatesClassification. */
  hosts: number[];
}

export interface SpatialNode {
  id: number;
  cls: string;
  name: string | null;
  children: SpatialNode[];
  /** Elements contained in this spatial node (storeys/spaces). */
  contained: number[];
}

export interface SpatialTree {
  project: SpatialNode | null;
  /** Elements not contained in any spatial structure node. */
  uncontained: number[];
  storeys: number;
}

export interface PlacementTransform {
  /** Row-major 4×4 world matrix (elements 12/13/14 = translation). */
  matrix: number[];
  /** Chain depth (root placement = 0). */
  depth: number;
  /** Placement chain root→this placement, express ids. */
  chain: number[];
}

export interface SemanticModel {
  schema: string | null;
  /** All parsed entities — unknown classes preserved here, never dropped. */
  entities: Map<number, StepEntity>;
  byClass: Map<string, number[]>;
  globalIds: Map<number, string>;
  /** GlobalId candidates that fail the buildingSMART base64 validation. */
  invalidGlobalIds: { id: number; value: string }[];
  /** GlobalId → express ids (≥2 entries = duplicate). */
  duplicateGlobalIds: Map<string, number[]>;
  units: UnitsAssignment;
  relationships: RelationshipRecord[];
  psets: Map<number, PsetRecord>;
  qtos: Map<number, QtoRecord>;
  classifications: Map<number, ClassificationRecord>;
  placements: Map<number, PlacementTransform>;
  spatial: SpatialTree;
  /** Classes outside the platform's known set — preserved, with counts. */
  unknownClasses: Map<string, number>;
  warnings: string[];
}

const REL_SHAPES: Record<string, { kind: RelKind; relatedIdx: number; relatingIdx: number }> = {
  IFCRELAGGREGATES: { kind: "aggregates", relatedIdx: 5, relatingIdx: 4 },
  IFCRELCONTAINEDINSPATIALSTRUCTURE: { kind: "containment", relatedIdx: 4, relatingIdx: 5 },
  IFCRELVOIDSELEMENT: { kind: "voids", relatedIdx: 5, relatingIdx: 4 },
  IFCRELFILLSELEMENT: { kind: "fills", relatedIdx: 5, relatingIdx: 4 },
  IFCRELDEFINESBYPROPERTIES: { kind: "properties", relatedIdx: 4, relatingIdx: 5 },
  IFCRELASSOCIATESMATERIAL: { kind: "material", relatedIdx: 4, relatingIdx: 5 },
  IFCRELASSOCIATESCLASSIFICATION: { kind: "classification", relatedIdx: 4, relatingIdx: 5 },
};

/** Classes the platform intentionally handles; anything else is "unknown" but preserved. */
const KNOWN_CLASSES = new Set([
  "IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCSPACE",
  "IFCWALL", "IFCWALLSTANDARDCASE", "IFCWALLELEMENTEDCASE", "IFCSLAB", "IFCBEAM", "IFCCOLUMN",
  "IFCMEMBER", "IFCPLATE", "IFCFOOTING", "IFCPILE", "IFCSTAIR", "IFCRAILING", "IFCRAMP",
  "IFCROOF", "IFCCEILING", "IFCCURTAINWALL", "IFCDOOR", "IFCWINDOW", "IFCOPENINGELEMENT",
  "IFCFURNISHINGELEMENT", "IFCBUILDINGELEMENTPROXY", "IFCCOVERING",
  "IFCFLOWSEGMENT", "IFCFLOWTERMINAL", "IFCFLOWFITTING", "IFCFLOWCONTROLLER",
  "IFCFLOWMOVINGDEVICE", "IFCFLOWSTORAGEDEVICE", "IFCDISTRIBUTIONELEMENT",
  "IFCDUCTSEGMENT", "IFCPIPESEGMENT", "IFCCABLECARRIERSEGMENT", "IFCCABLESEGMENT", "IFCCONDUITSEGMENT",
  "IFCDUCTFITTING", "IFCPIPEFITTING", "IFCCABLECARRIERFITTING", "IFCCONDUITFITTING",
  "IFCELEMENTQUANTITY", "IFCPROPERTYSET", "IFCPROPERTYSINGLEVALUE",
  "IFCQUANTITYLENGTH", "IFCQUANTITYAREA", "IFCQUANTITYVOLUME", "IFCQUANTITYWEIGHT",
  "IFCQUANTITYTIME", "IFCQUANTITYCOUNT", "IFCQUANTITYPERIMETER",
  "IFCUNITASSIGNMENT", "IFCSIUNIT", "IFCCONVERSIONBASEDUNIT", "IFCMEASUREWITHUNIT",
  "IFCPROJECT", "IFCGEOMETRICREPRESENTATIONCONTEXT", "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
  "IFCCARTESIANPOINT", "IFCDIRECTION", "IFCAXIS2PLACEMENT3D", "IFCLOCALPLACEMENT",
  "IFCEXTRUDEDAREASOLID", "IFCRECTANGLEPROFILEDEF", "IFCCIRCLEPROFILEDEF", "IFCCIRCLEHOLLOWPROFILEDEF",
  "IFCSHAPEREPRESENTATION", "IFCPRODUCTDEFINITIONSHAPE", "IFCFACETEDBREP", "IFCCLOSEDSHELL",
  "IFCFACE", "IFCFACEOUTERBOUND", "IFCEDGELOOP", "IFCORIENTEDEDGE", "IFCEDGE", "IFCVERTEXPOINT",
  "IFCPOLYLINE", "IFCTRIANGULATEDFACESET", "IFCCARTESIANPOINTLIST3D", "IFCPLANE",
  "IFCOWNERHISTORY", "IFCPERSON", "IFCORGANIZATION", "IFCPERSONANDORGANIZATION", "IFCAPPLICATION",
  "IFCRELAGGREGATES", "IFCRELCONTAINEDINSPATIALSTRUCTURE", "IFCRELVOIDSELEMENT",
  "IFCRELFILLSELEMENT", "IFCRELDEFINESBYPROPERTIES", "IFCRELASSOCIATESMATERIAL",
  "IFCRELASSOCIATESCLASSIFICATION", "IFCMATERIAL", "IFCMATERIALLAYERSET", "IFCMATERIALLAYERSETUSAGE",
  "IFCMATERIALCONSTITUENTSET", "IFCMATERIALCONSTITUENT",
  "IFCCLASSIFICATION", "IFCCLASSIFICATIONREFERENCE",
  "IFCPROPERTYBOUNDEDVALUE", "IFCPROPERTYLISTVALUE", "IFCPROPERTYENUMERATION",
  "IFCGUID", "IFCCALENDARDATE",
]);

const MEASURE_TYPES = new Set([
  "IFCREAL", "IFCINTEGER", "IFCBOOLEAN", "IFCLABEL", "IFCTEXT", "IFCIDENTIFIER",
  "IFCLENGTHMEASURE", "IFCAREAMEASURE", "IFCVOLUMEMEASURE", "IFCPLANEANGLEMEASURE",
  "IFCCOUNTMEASURE", "IFCTIMEMEASURE", "IFCMASSMEASURE",
  "IFCPOSITIVELENGTHMEASURE", "IFCNONNEGATIVELENGTHMEASURE",
  "IFCPOSITIVEPLANEANGLEMEASURE", "IFCNUMERICMEASURE",
]);

/** Parse a typed STEP literal: IFCREAL(1.5), IFCLABEL('x'), .T., bare numbers, refs, $. */
export function parseTypedLiteral(s: string | undefined, units?: UnitsAssignment): ParsedValue {
  if (s === undefined || s === "$" || s === "*" || s.trim() === "") {
    return { type: "null", value: null };
  }
  const t = s.trim();
  const typed = /^([A-Z0-9_]+)\((.*)\)$/s.exec(t);
  if (typed) {
    const cls = typed[1];
    const inner = typed[2];
    if (cls === "IFCBOOLEAN") {
      const e = unenum(inner);
      return { type: "boolean", value: e === "T" ? true : e === "F" ? false : null };
    }
    if (cls === "IFCLABEL" || cls === "IFCTEXT" || cls === "IFCIDENTIFIER") {
      return { type: "label", value: unquote(inner) };
    }
    const num = Number(inner);
    if (Number.isFinite(num)) {
      const measure = cls.startsWith("IFC") && cls !== "IFCREAL" && cls !== "IFCINTEGER" ? cls : undefined;
      return { type: cls === "IFCINTEGER" ? "integer" : "real", value: num, measure };
    }
    return { type: "unknown", value: inner };
  }
  if (t.startsWith("'") && t.endsWith("'")) return { type: "label", value: unquote(t) };
  if (t.startsWith(".") && t.endsWith(".")) {
    if (t === ".T." || t === ".F.") return { type: "boolean", value: t === ".T." };
    return { type: "enum", value: t.slice(1, -1) };
  }
  if (t.startsWith("#")) {
    const id = parseRef(t);
    return { type: "ref", value: id };
  }
  const num = Number(t);
  if (Number.isFinite(num)) return { type: !t.includes(".") ? "integer" : "real", value: num };
  return { type: "unknown", value: t };
}

function parseProperty(id: number, e: StepEntity, units: UnitsAssignment): ParsedProperty {
  // IfcPropertySingleValue(Name, Description, NominalValue, Unit)
  const name = unquote(e.args[0]) ?? `#${id}`;
  const value = parseTypedLiteral(e.args[2], units);
  const unitRef = parseRef(e.args[3]);
  if (unitRef != null && units) {
    const u = units.all.find((x) => x.id === unitRef);
    if (u) {
      value.unitRole = u.role;
      value.unitFactor = u.factor;
      value.unitName = u.name;
    }
  }
  return { id, name, value };
}

function parseQuantity(e: StepEntity): ParsedQuantity {
  // IfcQuantityLength/Area/Volume/Weight/Time/Count/Perimeter — arg order varies
  // by schema, so locate the value positionally: first bare finite number.
  const name = unquote(e.args[0]) ?? `#${e.id}`;
  let value: number | null = null;
  let unitId: number | null = null;
  for (const a of e.args) {
    const ref = parseRef(a);
    if (ref != null) { unitId = unitId ?? null; continue; }
    const inner = /^\(?([A-Z0-9_]+)?\(?([-+0-9.eE]+)\)?\)?$/.exec(a.trim());
    if (inner && Number.isFinite(Number(inner[2])) && value === null) {
      value = Number(inner[2]);
      break;
    }
  }
  return { id: e.id, cls: e.name, name, value, unitId };
}

function parseClassification(e: StepEntity): ClassificationRecord {
  const str = (i: number) => unquote(e.args[i]);
  if (e.name === "IFCCLASSIFICATION") {
    // IFC2X3: (Source, Edition, EditionDate, Name)
    // IFC4:   (Source, Edition, EditionDate, Name, Description, Location, ReferenceTokens)
    const rec: ClassificationRecord = {
      id: e.id, cls: e.name,
      name: str(3),
      source: str(0), edition: str(1),
      location: e.args.length >= 7 ? str(5) : null,
      identification: null, referencedSource: null, hosts: [],
    };
    return rec;
  }
  // IFC2X3 IfcClassificationReference: (Location, ItemReference, Name, ReferencedSource)
  // IFC4   IfcClassificationReference: (Location, Identification, Name, ReferencedSource)
  const rec: ClassificationRecord = {
    id: e.id,
    cls: e.name as ClassificationRecord["cls"],
    name: str(2),
    source: null, edition: null,
    location: str(0),
    identification: str(1),
    referencedSource: parseRef(e.args[3]),
    hosts: [],
  };
  return rec;
}

function composeMatrix(a: number[], b: number[]): number[] {
  // row-major 4×4 multiply: a × b
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] =
        a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
  }
  return out;
}

function axis2ToMatrix(e: StepEntity, entities: Map<number, StepEntity>, warnings: string[]): number[] | null {
  const locRef = parseRef(e.args[0]);
  const axisRef = parseRef(e.args[1]);
  const dirRef = parseRef(e.args[2]);
  const pt = locRef != null ? entities.get(locRef) : null;
  if (!pt || pt.name !== "IFCCARTESIANPOINT") {
    warnings.push(`#${e.id} IFCAXIS2PLACEMENT3D: location #${locRef} missing or wrong class`);
    return null;
  }
  const coords = parseCoords(pt);
  if (!coords || coords.length < 3) {
    warnings.push(`#${e.id} IFCAXIS2PLACEMENT3D: bad location coordinates`);
    return null;
  }
  const zAxis = readDirection(axisRef, entities, [0, 0, 1]);
  const xDir = readDirection(dirRef, entities, [1, 0, 0]);
  // Build orthonormal frame: z = axis, x = refDir orthogonalized against z.
  let zx = zAxis[0], zy = zAxis[1], zz = zAxis[2];
  const zlen = Math.hypot(zx, zy, zz) || 1;
  zx /= zlen; zy /= zlen; zz /= zlen;
  let xx = xDir[0], xy = xDir[1], xz = xDir[2];
  const dot = xx * zx + xy * zy + xz * zz;
  xx -= dot * zx; xy -= dot * zy; xz -= dot * zz;
  const xlen = Math.hypot(xx, xy, xz) || 1;
  xx /= xlen; xy /= xlen; xz /= xlen;
  // y = z × x
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return [
    xx, xy, xz, 0,
    yx, yy, yz, 0,
    zx, zy, zz, 0,
    coords[0], coords[1], coords[2], 1,
  ];
}

function parseCoords(e: StepEntity): number[] | null {
  const inner = e.args[0];
  if (!inner || !inner.startsWith("(")) return null;
  const parts = inner.slice(1, -1).split(",").map((s) => Number(s.trim()));
  if (!parts.every((v) => Number.isFinite(v))) return null;
  return parts;
}

function readDirection(ref: number | null, entities: Map<number, StepEntity>, fallback: [number, number, number]): [number, number, number] {
  if (ref == null) return fallback;
  const d = entities.get(ref);
  if (!d || d.name !== "IFCDIRECTION") return fallback;
  const inner = d.args[0];
  if (!inner || !inner.startsWith("(")) return fallback;
  const parts = inner.slice(1, -1).split(",").map((s) => Number(s.trim()));
  if (parts.length < 3 || !parts.every((v) => Number.isFinite(v))) return fallback;
  return [parts[0], parts[1], parts[2]];
}

function buildPlacements(
  entities: Map<number, StepEntity>, warnings: string[],
): Map<number, PlacementTransform> {
  const out = new Map<number, PlacementTransform>();
  const visiting = new Set<number>();
  const worldOf = (id: number): number[] | null => {
    if (out.has(id)) return out.get(id)!.matrix;
    if (visiting.has(id)) { warnings.push(`#${id} IFCLOCALPLACEMENT: cyclic placement chain — treated as root`); return null; }
    const e = entities.get(id);
    if (!e || e.name !== "IFCLOCALPLACEMENT") return null;
    visiting.add(id);
    try {
      const relRef = parseRef(e.args[0]);
      const relToWorld = relRef != null ? worldOf(relRef) : null;
      const axisRef = parseRef(e.args[1]);
      const axis = axisRef != null ? entities.get(axisRef) : null;
      const local = axis && axis.name === "IFCAXIS2PLACEMENT3D"
        ? axis2ToMatrix(axis, entities, warnings)
        : null;
      if (!local) return null;
      const world = relToWorld ? composeMatrix(relToWorld, local) : local;
      const relDepth = relRef != null && relToWorld ? (out.get(relRef)?.depth ?? 0) : -1;
      const chain = relRef != null && out.has(relRef) ? [...out.get(relRef)!.chain, id] : [id];
      const t: PlacementTransform = { matrix: world, depth: relDepth + 1, chain };
      out.set(id, t);
      return world;
    } finally {
      visiting.delete(id);
    }
  };
  for (const e of entities.values()) {
    if (e.name === "IFCLOCALPLACEMENT") worldOf(e.id);
  }
  return out;
}

function buildSpatial(
  entities: Map<number, StepEntity>,
  relationships: RelationshipRecord[],
  warnings: string[],
): SpatialTree {
  const nodeOf = (id: number): SpatialNode | null => {
    const e = entities.get(id);
    if (!e) return null;
    return { id, cls: e.name, name: unquote(e.args[2]) ?? (e.args.length >= 3 ? null : null), children: [], contained: [] };
  };
  // Aggregate parents.
  const parentOf = new Map<number, number>();
  for (const r of relationships) {
    if (r.kind !== "aggregates" || r.relating == null) continue;
    for (const child of r.related) parentOf.set(child, r.relating);
  }
  // Containment.
  const containedBy = new Map<number, number>();
  for (const r of relationships) {
    if (r.kind !== "containment" || r.relating == null) continue;
    for (const el of r.related) containedBy.set(el, r.relating);
  }
  const projectEnt = [...entities.values()].find((e) => e.name === "IFCPROJECT");
  if (!projectEnt) {
    return { project: null, uncontained: [], storeys: 0 };
  }
  const buildDown = (id: number, depth: number): SpatialNode | null => {
    if (depth > 8) return null;
    const n = nodeOf(id);
    if (!n) return null;
    for (const [child, parent] of parentOf) {
      if (parent !== id) continue;
      const c = buildDown(child, depth + 1);
      if (c) n.children.push(c);
    }
    for (const [el, structure] of containedBy) {
      if (structure === id) n.contained.push(el);
    }
    return n;
  };
  const project = buildDown(projectEnt.id, 0) ?? nodeOf(projectEnt.id)!;
  // Storeys + uncontained elements.
  let storeys = 0;
  const containedIds = new Set<number>();
  const countStoreys = (n: SpatialNode) => {
    if (n.cls === "IFCBUILDINGSTOREY") storeys++;
    for (const c of n.children) countStoreys(c);
  };
  countStoreys(project);
  const collectContained = (n: SpatialNode) => {
    for (const el of n.contained) containedIds.add(el);
    for (const c of n.children) collectContained(c);
  };
  collectContained(project);
  const physicalRe = /^IFC(WALL|SLAB|BEAM|COLUMN|MEMBER|PLATE|FOOTING|PILE|STAIR|RAILING|RAMP|ROOF|CEILING|CURTAINWALL|DOOR|WINDOW|FURNISHINGELEMENT|BUILDINGELEMENTPROXY|COVERING|FLOW|OPENINGELEMENT|DUCT|PIPE|CABLE|CONDUIT)/;
  const uncontained: number[] = [];
  for (const e of entities.values()) {
    if (!physicalRe.test(e.name)) continue;
    if (!containedIds.has(e.id) && !parentOf.has(e.id)) uncontained.push(e.id);
  }
  if (uncontained.length) {
    warnings.push(`${uncontained.length} physical element(s) not contained in any spatial structure node`);
  }
  return { project, uncontained, storeys };
}

export function buildSemanticModel(text: string): SemanticModel {
  const file: StepFile = readStep(text);
  const units = collectUnits(file);
  const warnings = [...file.warnings, ...units.warnings];

  // byClass index.
  const byClass = new Map<string, number[]>();
  for (const e of file.entities.values()) {
    const arr = byClass.get(e.name);
    if (arr) arr.push(e.id);
    else byClass.set(e.name, [e.id]);
  }

  // GlobalId extraction + validation + duplicates.
  const globalIds = new Map<number, string>();
  const invalidGlobalIds: { id: number; value: string }[] = [];
  const dupGlobalIds = new Map<string, number[]>();
  for (const e of file.entities.values()) {
    const g = unquote(e.args[0]);
    // Any quoted 22-char first argument is a GlobalId candidate — invalid
    // charsets (including ones containing parentheses) must be captured so
    // validation can flag them.
    if (g && g.length === 22) {
      globalIds.set(e.id, g);
      const arr = dupGlobalIds.get(g);
      if (arr) arr.push(e.id); else dupGlobalIds.set(g, [e.id]);
      if (!isValidIfcGuid(g)) invalidGlobalIds.push({ id: e.id, value: g });
    }
  }

  // Relationships.
  const relationships: RelationshipRecord[] = [];
  for (const e of file.entities.values()) {
    const shape = REL_SHAPES[e.name];
    if (!shape) {
      if (e.name.startsWith("IFCREL")) {
        relationships.push({
          kind: "other", cls: e.name, id: e.id,
          globalId: unquote(e.args[0]),
          related: [], relating: null, raw: e.raw,
        });
      }
      continue;
    }
    const related = parseRefList(e.args[shape.relatedIdx]);
    const relating = parseRef(e.args[shape.relatingIdx]);
    relationships.push({
      kind: shape.kind, cls: e.name, id: e.id,
      globalId: unquote(e.args[0]),
      related, relating,
    });
    // Dangling relationship targets become warnings (validation layer also reports them).
    for (const r of related) {
      if (!file.entities.has(r)) warnings.push(`#${e.id} ${e.name}: related #${r} missing (dangling relationship)`);
    }
    if (relating != null && !file.entities.has(relating)) {
      warnings.push(`#${e.id} ${e.name}: relating #${relating} missing (dangling relationship)`);
    }
  }

  // Property sets.
  const psets = new Map<number, PsetRecord>();
  for (const e of file.entities.values()) {
    if (e.name !== "IFCPROPERTYSET") continue;
    const name = unquote(e.args[2]) ?? `#${e.id}`;
    const propRefs = parseRefList(e.args[4]);
    const props: ParsedProperty[] = [];
    for (const pid of propRefs) {
      const pe = file.entities.get(pid);
      if (!pe) continue; // dangling prop already warned via refs
      if (pe.name === "IFCPROPERTYSINGLEVALUE") props.push(parseProperty(pid, pe, units));
      else props.push({ id: pid, name: unquote(pe.args[0]) ?? `#${pid}`, value: { type: "unknown", value: pe.name } });
    }
    psets.set(e.id, { id: e.id, name, props, hosts: [] });
  }

  // Quantity sets.
  const qtos = new Map<number, QtoRecord>();
  for (const e of file.entities.values()) {
    if (e.name !== "IFCELEMENTQUANTITY") continue;
    const name = unquote(e.args[2]) ?? `#${e.id}`;
    const qRefs = parseRefList(e.args[5]);
    const quantities: ParsedQuantity[] = [];
    for (const qid of qRefs) {
      const qe = file.entities.get(qid);
      if (!qe || !qe.name.startsWith("IFCQUANTITY")) continue;
      quantities.push(parseQuantity(qe));
    }
    qtos.set(e.id, { id: e.id, name, quantities, hosts: [] });
  }

  // Classifications.
  const classifications = new Map<number, ClassificationRecord>();
  for (const e of file.entities.values()) {
    if (e.name === "IFCCLASSIFICATION" || e.name === "IFCCLASSIFICATIONREFERENCE") {
      classifications.set(e.id, parseClassification(e));
    }
  }

  // Wire relationship hosts into psets / qtos / classifications.
  for (const r of relationships) {
    if (r.kind === "properties" && r.relating != null) {
      const rec = psets.get(r.relating) ?? qtos.get(r.relating);
      if (rec) rec.hosts.push(...r.related);
    } else if (r.kind === "classification" && r.relating != null) {
      const rec = classifications.get(r.relating);
      if (rec) rec.hosts.push(...r.related);
    }
  }

  // Placements.
  const placements = buildPlacements(file.entities, warnings);

  // Spatial structure.
  const spatial = buildSpatial(file.entities, relationships, warnings);

  // Unknown classes (preserved — counted, never dropped).
  const unknownClasses = new Map<string, number>();
  for (const e of file.entities.values()) {
    if (!KNOWN_CLASSES.has(e.name)) {
      unknownClasses.set(e.name, (unknownClasses.get(e.name) ?? 0) + 1);
    }
  }

  return {
    schema: file.schema,
    entities: file.entities,
    byClass,
    globalIds,
    invalidGlobalIds,
    duplicateGlobalIds: dupGlobalIds,
    units,
    relationships,
    psets,
    qtos,
    classifications,
    placements,
    spatial,
    unknownClasses,
    warnings,
  };
}
