// openbim-fix:v3:applied
/**
 * Minimal IFC4 SPF writer for Native Twins.
 *
 * - One twin → standalone IFC
 * - Many twins → one federated IFC4 (single Project/Site/Building/Storey)
 */

/** Minimal twin shape needed for IFC export (avoids cycle with frag-edit). */
export interface TwinIfcSource {
  name?: string;
  description?: string;
  nativeEntity?: string;
  sourceEntity?: string;
  sourceGlobalId?: string;
  nativeId?: string;
  modelId: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  propertySets?: Record<string, Record<string, unknown>>;
  overrides?: Record<string, unknown>;
  geometry?: { positions?: number[] | Float32Array };
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}

function guid(): string {
  const raw =
    typeof crypto !== "undefined" && (crypto as any).randomUUID
      ? (crypto as any).randomUUID().replace(/-/g, "")
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return raw.slice(0, 22).padEnd(22, "0");
}

function num(n: number): string {
  if (!Number.isFinite(n)) return "0.";
  const s = n.toFixed(6);
  return s.replace(/\.?0+$/, "") || "0";
}

const SAFE_ENTITIES = new Set([
  "IfcBuildingElementProxy",
  "IfcWall",
  "IfcSlab",
  "IfcBeam",
  "IfcColumn",
  "IfcDoor",
  "IfcWindow",
  "IfcMember",
  "IfcPlate",
  "IfcFooting",
  "IfcPile",
  "IfcRailing",
  "IfcStair",
  "IfcRamp",
  "IfcFurnishingElement",
  "IfcFlowSegment",
  "IfcFlowTerminal",
  "IfcFlowFitting",
  "IfcDistributionElement",
]);

function safeEntityName(edit: TwinIfcSource): string {
  const entity = edit.nativeEntity || edit.sourceEntity || "IfcBuildingElementProxy";
  const ifcEntity = entity.startsWith("Ifc") ? entity : `Ifc${entity}`;
  return SAFE_ENTITIES.has(ifcEntity) ? ifcEntity : "IfcBuildingElementProxy";
}

type Ctx = {
  lines: string[];
  next: () => number;
  owner: number;
  localOrigin: number;
};

/** Append one element (placement + tessellation + psets) under a storey. Returns element id. */
function appendTwinElement(ctx: Ctx, edit: TwinIfcSource, storey: number): number {
  const { lines, next, owner, localOrigin } = ctx;
  const name = esc(edit.name || "NativeTwin");
  const globalId = esc(edit.sourceGlobalId || edit.nativeId || guid());
  const description = esc(edit.description || `Native twin of ${edit.sourceEntity || "element"}`);
  // safeEntity reserved for future typed writers; proxy form is universal today
  void safeEntityName(edit);

  const [px, py, pz] = edit.position;
  const [qx, qy, qz, qw] = edit.quaternion;
  const xx = qx * qx,
    yy = qy * qy,
    zz = qz * qz;
  const xy = qx * qy,
    xz = qx * qz,
    yz = qy * qz;
  const wx = qw * qx,
    wy = qw * qy,
    wz = qw * qz;
  const r00 = 1 - 2 * (yy + zz);
  const r01 = 2 * (xy - wz);
  const r02 = 2 * (xz + wy);
  const r10 = 2 * (xy + wz);
  const r11 = 1 - 2 * (xx + zz);
  const r12 = 2 * (yz - wx);
  const r20 = 2 * (xz - wy);
  const r21 = 2 * (yz + wx);
  const r22 = 1 - 2 * (xx + yy);

  const elPt = next();
  const elDirZ = next();
  const elDirX = next();
  const elAxis = next();
  const elPlace = next();
  lines.push(`#${elPt}=IFCCARTESIANPOINT((${num(px)},${num(py)},${num(pz)}));`);
  lines.push(`#${elDirZ}=IFCDIRECTION((${num(r02)},${num(r12)},${num(r22)}));`);
  lines.push(`#${elDirX}=IFCDIRECTION((${num(r00)},${num(r10)},${num(r20)}));`);
  lines.push(`#${elAxis}=IFCAXIS2PLACEMENT3D(#${elPt},#${elDirZ},#${elDirX});`);
  lines.push(`#${elPlace}=IFCLOCALPLACEMENT(#${localOrigin},#${elAxis});`);

  const positions = edit.geometry?.positions ?? [];
  let shapeRepRef = 0;
  if (positions.length >= 9) {
    const coordList: string[] = [];
    const faceList: string[] = [];
    const nVerts = Math.floor(positions.length / 3);
    for (let i = 0; i < nVerts; i++) {
      coordList.push(
        `(${num(positions[i * 3])},${num(positions[i * 3 + 1])},${num(positions[i * 3 + 2])})`,
      );
    }
    const nTris = Math.floor(nVerts / 3);
    for (let t = 0; t < nTris; t++) {
      faceList.push(`((${t * 3 + 1},${t * 3 + 2},${t * 3 + 3}))`);
    }
    const coords = next();
    lines.push(`#${coords}=IFCCARTESIANPOINTLIST3D((${coordList.join(",")}));`);
    const faces = next();
    lines.push(`#${faces}=IFCTRIANGULATEDFACESET(#${coords},$,.F.,(${faceList.join(",")}),$);`);
    const bodyStyle = next();
    const bodyRep = next();
    lines.push(`#${bodyStyle}=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#${faces}));`);
    lines.push(`#${bodyRep}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${bodyStyle}));`);
    shapeRepRef = bodyRep;
  }

  const el = next();
  const shapeArg = shapeRepRef ? `#${shapeRepRef}` : "$";
  lines.push(
    `#${el}=IFCBUILDINGELEMENTPROXY('${globalId}',#${owner},'${name}','${description}',$,#${elPlace},${shapeArg},$,.NOTDEFINED.);`,
  );

  const relCont = next();
  lines.push(
    `#${relCont}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',#${owner},$,$,(#${el}),#${storey});`,
  );

  const psets = {
    ...(edit.propertySets ?? {}),
    ...(edit.overrides ? { NativeOverrides: edit.overrides } : {}),
  };
  for (const [psetName, props] of Object.entries(psets)) {
    if (!props || typeof props !== "object") continue;
    const propIds: number[] = [];
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      if (v == null) continue;
      const pid = next();
      propIds.push(pid);
      if (typeof v === "number") {
        lines.push(`#${pid}=IFCPROPERTYSINGLEVALUE('${esc(k)}',$,IFCREAL(${num(v)}),$);`);
      } else if (typeof v === "boolean") {
        lines.push(`#${pid}=IFCPROPERTYSINGLEVALUE('${esc(k)}',$,IFCBOOLEAN(.${v ? "T" : "F"}.),$);`);
      } else {
        lines.push(`#${pid}=IFCPROPERTYSINGLEVALUE('${esc(k)}',$,IFCLABEL('${esc(String(v))}'),$);`);
      }
    }
    if (!propIds.length) continue;
    const psid = next();
    lines.push(
      `#${psid}=IFCPROPERTYSET('${guid()}',#${owner},'${esc(psetName)}',$,(${propIds.map((x) => `#${x}`).join(",")}));`,
    );
    const rel = next();
    lines.push(`#${rel}=IFCRELDEFINESBYPROPERTIES('${guid()}',#${owner},$,$,(#${el}),#${psid});`);
  }

  const linPid = next();
  lines.push(
    `#${linPid}=IFCPROPERTYSINGLEVALUE('SourceGlobalId',$,IFCLABEL('${esc(edit.sourceGlobalId || "")}'),$);`,
  );
  const linPid2 = next();
  lines.push(
    `#${linPid2}=IFCPROPERTYSINGLEVALUE('SourceEntity',$,IFCLABEL('${esc(edit.sourceEntity || "")}'),$);`,
  );
  const linPid3 = next();
  lines.push(
    `#${linPid3}=IFCPROPERTYSINGLEVALUE('SourceModelId',$,IFCLABEL('${esc(edit.modelId)}'),$);`,
  );
  const linPs = next();
  lines.push(
    `#${linPs}=IFCPROPERTYSET('${guid()}',#${owner},'Pset_NativeTwinLineage',$,(#${linPid},#${linPid2},#${linPid3}));`,
  );
  const linRel = next();
  lines.push(`#${linRel}=IFCRELDEFINESBYPROPERTIES('${guid()}',#${owner},$,$,(#${el}),#${linPs});`);

  return el;
}

function writeHeader(projectName: string): string[] {
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    `FILE_NAME('${esc(projectName)}.ifc','${new Date().toISOString()}',('Open BIM Studio'),('Open BIM Studio'),'Open BIM Studio','Open BIM Studio','');`,
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
  ];
}

function writeSpatialSkeleton(
  lines: string[],
  next: () => number,
  projectName: string,
): { owner: number; localOrigin: number; storey: number } {
  const person = next();
  lines.push(`#${person}=IFCPERSON($,$,'OBS',$,$,$,$,$);`);
  const org = next();
  lines.push(`#${org}=IFCORGANIZATION($,'Open BIM Studio',$,$,$);`);
  const personOrg = next();
  lines.push(`#${personOrg}=IFCPERSONANDORGANIZATION(#${person},#${org},$);`);
  const app = next();
  lines.push(`#${app}=IFCAPPLICATION(#${personOrg},'Open BIM Studio','Open BIM Studio','OBS');`);
  const owner = next();
  lines.push(
    `#${owner}=IFCOWNERHISTORY(#${personOrg},#${app},$,.ADDED.,$,$,$,${Math.floor(Date.now() / 1000)});`,
  );

  const lengthUnit = next();
  const areaUnit = next();
  const volumeUnit = next();
  const angleUnit = next();
  const unitAssign = next();
  const project = next();
  const site = next();
  const building = next();
  const storey = next();
  const localOrigin = next();
  const axis2 = next();
  const cartPt = next();
  const dirZ = next();
  const dirX = next();

  lines.push(`#${cartPt}=IFCCARTESIANPOINT((0.,0.,0.));`);
  lines.push(`#${dirZ}=IFCDIRECTION((0.,0.,1.));`);
  lines.push(`#${dirX}=IFCDIRECTION((1.,0.,0.));`);
  lines.push(`#${axis2}=IFCAXIS2PLACEMENT3D(#${cartPt},#${dirZ},#${dirX});`);
  lines.push(`#${localOrigin}=IFCLOCALPLACEMENT($,#${axis2});`);
  lines.push(`#${lengthUnit}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
  lines.push(`#${areaUnit}=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);`);
  lines.push(`#${volumeUnit}=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);`);
  lines.push(`#${angleUnit}=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);`);
  lines.push(
    `#${unitAssign}=IFCUNITASSIGNMENT((#${lengthUnit},#${areaUnit},#${volumeUnit},#${angleUnit}));`,
  );
  lines.push(
    `#${project}=IFCPROJECT('${guid()}',#${owner},'${esc(projectName)}',$,$,$,$,(#${unitAssign}),$);`,
  );
  lines.push(
    `#${site}=IFCSITE('${guid()}',#${owner},'Site',$,$,#${localOrigin},$,$,.ELEMENT.,$,$,$,$,$);`,
  );
  lines.push(
    `#${building}=IFCBUILDING('${guid()}',#${owner},'Building',$,$,#${localOrigin},$,$,.ELEMENT.,$,$,$);`,
  );
  lines.push(
    `#${storey}=IFCBUILDINGSTOREY('${guid()}',#${owner},'Level 0',$,$,#${localOrigin},$,$,.ELEMENT.,0.);`,
  );
  const relAgg1 = next();
  const relAgg2 = next();
  const relAgg3 = next();
  lines.push(`#${relAgg1}=IFCRELAGGREGATES('${guid()}',#${owner},$,$,#${project},(#${site}));`);
  lines.push(`#${relAgg2}=IFCRELAGGREGATES('${guid()}',#${owner},$,$,#${site},(#${building}));`);
  lines.push(`#${relAgg3}=IFCRELAGGREGATES('${guid()}',#${owner},$,$,#${building},(#${storey}));`);

  return { owner, localOrigin, storey };
}

/** One twin → one IFC4 file. */
export function writeNativeTwinIfc(edit: TwinIfcSource): string {
  return writeFederatedNativeTwinIfc([edit], edit.name || "Native Twin Export");
}

/**
 * Many Native Twins → one federated IFC4 SPF (shared project tree).
 * This is the primary write-back path for “edit IFC natively, export one model”.
 */
export function writeFederatedNativeTwinIfc(
  edits: TwinIfcSource[],
  projectName = "OpenBIMStudio Native IFC",
): string {
  if (!edits.length) throw new Error("No Native Twins to export.");
  const lines = writeHeader(projectName.replace(/[^a-z0-9._-]+/gi, "_") || "native-ifc");
  let id = 1;
  const next = () => id++;
  const { owner, localOrigin, storey } = writeSpatialSkeleton(lines, next, projectName);
  const ctx: Ctx = { lines, next, owner, localOrigin };
  for (const edit of edits) {
    appendTwinElement(ctx, edit, storey);
  }
  lines.push("ENDSEC;");
  lines.push("END-ISO-10303-21;");
  return lines.join("\n");
}

export function downloadNativeTwinIfc(edit: TwinIfcSource, filename?: string): void {
  const text = writeNativeTwinIfc(edit);
  const blob = new Blob([text], { type: "application/x-step" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `${(edit.name || "native-twin").replace(/[^a-z0-9._-]+/gi, "_")}.ifc`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Download one federated IFC4 for all given twins. */
export function downloadFederatedNativeTwinIfc(
  edits: TwinIfcSource[],
  filename = "openbimstudio-native.ifc",
): void {
  const text = writeFederatedNativeTwinIfc(edits);
  const blob = new Blob([text], { type: "application/x-step" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}
