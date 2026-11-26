// Free family creator, slice 1: IFC2X3 writer for a created family.
//
// Writes one element (IfcFurnishingElement or IfcBuildingElementProxy) with
// one extruded solid per part, a property set with the family parameters,
// and the standard Project > Site > Building > Storey spine. IFC2X3 is the
// schema Autodesk documents for Revit open/link, so it is the first
// candidate. Whether Revit 2020 accepts this exact file is NOT verified
// here: that needs a run in Revit (acceptance test R1 in the plan).
//
// Engine axes (X width, Y up, Z depth) map to IFC (X, Y = -Z, Z = Y).
// Units are metres.

import type { ResolvedPart } from "./layout";

export interface IfcCreatorInput {
  name: string;
  manufacturer?: string;
  model?: string;
  entity: "IfcBuildingElementProxy" | "IfcFurnishingElement";
  parts: ResolvedPart[];
  /** Parameter name -> value in metres, written as IfcLengthMeasure. */
  lengthParams: Record<string, number>;
  /** Count parameters (doors, drawers, shelves), written as IfcInteger. */
  countParams?: Record<string, number>;
  /** ISO timestamp for the header. Defaults to now. */
  timestamp?: string;
  /**
   * A flat outline (metres, x right, y up, outer counter-clockwise, holes clockwise) extruded by
   * `thicknessM`: the shape read from a picture. Written as one solid with an arbitrary profile.
   */
  outline?: { outer: Array<[number, number]>; holes: Array<Array<[number, number]>>; thicknessM: number };
}

const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/** IFC 22-character GlobalId from a 128-bit value. Deterministic per seed. */
export function ifcGuid(seed: string): string {
  // Four 32-bit lanes from a seeded FNV-style mix.
  const lanes: number[] = [];
  for (let k = 0; k < 4; k++) {
    let h = (2166136261 ^ (k * 0x9e3779b1)) >>> 0;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    lanes.push(h >>> 0);
  }
  let big = 0n;
  for (const l of lanes) big = (big << 32n) | BigInt(l);
  // 128 bits -> first char carries 2 bits, then 21 chars of 6 bits.
  let out = "";
  const first = Number((big >> 126n) & 3n);
  out += B64[first];
  for (let i = 20; i >= 0; i--) out += B64[Number((big >> BigInt(i * 6)) & 63n)];
  return out;
}

/** STEP string escaping: apostrophes doubled, non-ASCII as \X2\ escapes. */
export function stepString(s: string): string {
  let out = "";
  for (const ch of String(s)) {
    const c = ch.codePointAt(0) as number;
    if (ch === "'") out += "''";
    else if (ch === "\\") out += "\\\\";
    else if (c >= 32 && c < 127) out += ch;
    else if (c <= 0xffff) out += `\\X2\\${c.toString(16).toUpperCase().padStart(4, "0")}\\X0\\`;
    else out += "?";
  }
  return `'${out}'`;
}

const f = (n: number): string => {
  if (!Number.isFinite(n)) throw new Error("Non-finite number in IFC output");
  const r = Math.round(n * 1e9) / 1e9;
  let s = String(r);
  if (!/[.eE]/.test(s)) s += ".";
  return s;
};

export interface IfcWriteResult { text: string; entityCount: number }

export function writeIfc2x3(input: IfcCreatorInput): IfcWriteResult {
  const lines: string[] = [];
  let id = 0;
  const add = (body: string): number => { id += 1; lines.push(`#${id}=${body};`); return id; };
  const ref = (n: number) => `#${n}`;
  const g = (tag: string) => stepString(ifcGuid(`${input.name}|${input.model ?? ""}|${tag}`));

  // Owner history
  const person = add("IFCPERSON($,'Creator',$,$,$,$,$,$)");
  const org = add("IFCORGANIZATION($,'OpenBIMStudio',$,$,$)");
  const pao = add(`IFCPERSONANDORGANIZATION(${ref(person)},${ref(org)},$)`);
  const app = add("IFCAPPLICATION(" + ref(org) + ",'1.0','OpenBIMStudio Family Creator','OBSFC')");
  const oh = add(`IFCOWNERHISTORY(${ref(pao)},${ref(app)},$,.ADDED.,$,${ref(pao)},${ref(app)},0)`);

  // Units
  const uLen = add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)");
  const uArea = add("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)");
  const uVol = add("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)");
  const uAng = add("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)");
  const units = add(`IFCUNITASSIGNMENT((${[uLen, uArea, uVol, uAng].map(ref).join(",")}))`);

  // World coordinate system and context
  const o3 = add("IFCCARTESIANPOINT((0.,0.,0.))");
  const dz = add("IFCDIRECTION((0.,0.,1.))");
  const dx = add("IFCDIRECTION((1.,0.,0.))");
  const wcs = add(`IFCAXIS2PLACEMENT3D(${ref(o3)},${ref(dz)},${ref(dx)})`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${ref(wcs)},$)`);
  const project = add(`IFCPROJECT(${g("project")},${ref(oh)},${stepString(input.name)},$,$,$,$,(${ref(ctx)}),${ref(units)})`);

  // Spatial spine
  const place = (): number => add(`IFCLOCALPLACEMENT($,${ref(wcs)})`);
  const sitePl = place();
  const site = add(`IFCSITE(${g("site")},${ref(oh)},'Site',$,$,${ref(sitePl)},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldPl = add(`IFCLOCALPLACEMENT(${ref(sitePl)},${ref(wcs)})`);
  const bld = add(`IFCBUILDING(${g("building")},${ref(oh)},'Building',$,$,${ref(bldPl)},$,$,.ELEMENT.,$,$,$)`);
  const stPl = add(`IFCLOCALPLACEMENT(${ref(bldPl)},${ref(wcs)})`);
  const storey = add(`IFCBUILDINGSTOREY(${g("storey")},${ref(oh)},'Level 1',$,$,${ref(stPl)},$,$,.ELEMENT.,0.)`);
  add(`IFCRELAGGREGATES(${g("rel-project-site")},${ref(oh)},$,$,${ref(project)},(${ref(site)}))`);
  add(`IFCRELAGGREGATES(${g("rel-site-building")},${ref(oh)},$,$,${ref(site)},(${ref(bld)}))`);
  add(`IFCRELAGGREGATES(${g("rel-building-storey")},${ref(oh)},$,$,${ref(bld)},(${ref(storey)}))`);

  // Geometry: one extruded solid per part (engine -> IFC axes).
  const solids: number[] = [];
  for (const p of input.parts) {
    const ix = p.cx, iy = -p.cz, iz = p.cy - p.h / 2;
    const base = add(`IFCCARTESIANPOINT((${f(ix)},${f(iy)},${f(iz)}))`);
    const pos = add(`IFCAXIS2PLACEMENT3D(${ref(base)},$,$)`);
    const p2 = add("IFCCARTESIANPOINT((0.,0.))");
    const pos2 = add(`IFCAXIS2PLACEMENT2D(${ref(p2)},$)`);
    const profile = p.shape === "cylinder"
      ? add(`IFCCIRCLEPROFILEDEF(.AREA.,${stepString(p.name)},${ref(pos2)},${f(p.r)})`)
      : add(`IFCRECTANGLEPROFILEDEF(.AREA.,${stepString(p.name)},${ref(pos2)},${f(p.w)},${f(p.d)})`);
    solids.push(add(`IFCEXTRUDEDAREASOLID(${ref(profile)},${ref(pos)},${ref(dz)},${f(p.h)})`));
  }
  if (input.outline) {
    const o = input.outline;
    // Profile x = IFC X, profile y = IFC Z (up); extrusion runs along IFC -Y, centred on the origin.
    const base = add(`IFCCARTESIANPOINT((0.,${f(o.thicknessM / 2)},0.))`);
    const axis = add("IFCDIRECTION((0.,-1.,0.))");
    const pos = add(`IFCAXIS2PLACEMENT3D(${ref(base)},${ref(axis)},${ref(dx)})`);
    const curve = (pts: Array<[number, number]>): number => {
      const ids = pts.map((q) => add(`IFCCARTESIANPOINT((${f(q[0])},${f(q[1])}))`));
      return add(`IFCPOLYLINE((${[...ids, ids[0]].map(ref).join(",")}))`);
    };
    const outer = curve(o.outer);
    const holes = o.holes.map(curve);
    const profile = holes.length
      ? add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,${stepString(input.name)},${ref(outer)},(${holes.map(ref).join(",")}))`)
      : add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,${stepString(input.name)},${ref(outer)})`);
    solids.push(add(`IFCEXTRUDEDAREASOLID(${ref(profile)},${ref(pos)},${ref(dz)},${f(o.thicknessM)})`));
  }
  const rep = add(`IFCSHAPEREPRESENTATION(${ref(ctx)},'Body','SweptSolid',(${solids.map(ref).join(",")}))`);
  const pds = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${ref(rep)}))`);
  const elPl = add(`IFCLOCALPLACEMENT(${ref(stPl)},${ref(wcs)})`);
  const elName = stepString(input.name);
  const el = input.entity === "IfcFurnishingElement"
    ? add(`IFCFURNISHINGELEMENT(${g("element")},${ref(oh)},${elName},$,$,${ref(elPl)},${ref(pds)},$)`)
    : add(`IFCBUILDINGELEMENTPROXY(${g("element")},${ref(oh)},${elName},$,$,${ref(elPl)},${ref(pds)},$,.NOTDEFINED.)`);
  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${g("rel-contained")},${ref(oh)},$,$,(${ref(el)}),${ref(storey)})`);

  // Property set with the family parameters (and manufacturer / model as text).
  const props: number[] = [];
  for (const [k, v] of Object.entries(input.lengthParams)) {
    props.push(add(`IFCPROPERTYSINGLEVALUE(${stepString(k)},$,IFCLENGTHMEASURE(${f(v)}),$)`));
  }
  for (const [k, v] of Object.entries(input.countParams ?? {})) {
    props.push(add(`IFCPROPERTYSINGLEVALUE(${stepString(k)},$,IFCINTEGER(${Math.round(v)}),$)`));
  }
  if (input.manufacturer) props.push(add(`IFCPROPERTYSINGLEVALUE('Manufacturer',$,IFCLABEL(${stepString(input.manufacturer)}),$)`));
  if (input.model) props.push(add(`IFCPROPERTYSINGLEVALUE('Model',$,IFCLABEL(${stepString(input.model)}),$)`));
  if (props.length) {
    const pset = add(`IFCPROPERTYSET(${g("pset")},${ref(oh)},'OBS_FamilyParameters',$,(${props.map(ref).join(",")}))`);
    add(`IFCRELDEFINESBYPROPERTIES(${g("rel-pset")},${ref(oh)},$,$,(${ref(el)}),${ref(pset)})`);
  }

  const header = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    `FILE_NAME(${stepString(input.name + ".ifc")},${stepString((input.timestamp ?? new Date().toISOString()).slice(0, 19))},('OpenBIMStudio'),('OpenBIMStudio'),'OpenBIMStudio Family Creator','OpenBIMStudio','');`,
    "FILE_SCHEMA(('IFC2X3'));",
    "ENDSEC;",
    "DATA;",
  ];
  const text = [...header, ...lines, "ENDSEC;", "END-ISO-10303-21;", ""].join("\n");
  return { text, entityCount: lines.length };
}
