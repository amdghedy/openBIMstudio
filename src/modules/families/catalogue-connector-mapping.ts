import type { ConnectorDefinition } from "../object-hierarchy";
import type { CatalogueRow } from "./catalogue-intake";

type Domain = ConnectorDefinition["domain"];
type Shape = ConnectorDefinition["shape"];
type Flow = ConnectorDefinition["flowDirection"];
type PortField = "connectorX" | "connectorY" | "connectorZ" | "directionX" | "directionY" | "directionZ" |
  "connectorDomain" | "connectorShape" | "connectorDiameter" | "connectorWidth" | "connectorHeight" |
  "flowDirection" | "systemClassification" | "connectorName";

const ALIASES: Record<string, PortField> = {
  connectorx:"connectorX", portx:"connectorX", connectionx:"connectorX",
  connectory:"connectorY", porty:"connectorY", connectiony:"connectorY",
  connectorz:"connectorZ", portz:"connectorZ", connectionz:"connectorZ",
  directionx:"directionX", axisx:"directionX", directiony:"directionY", axisy:"directionY",
  directionz:"directionZ", axisz:"directionZ",
  connectordomain:"connectorDomain", portdomain:"connectorDomain",
  connectorshape:"connectorShape", portshape:"connectorShape",
  connectordiameter:"connectorDiameter", portdiameter:"connectorDiameter",
  connectorwidth:"connectorWidth", portwidth:"connectorWidth",
  connectorheight:"connectorHeight", portheight:"connectorHeight",
  flowdirection:"flowDirection", systemclassification:"systemClassification",
  connectorsystem:"systemClassification", connectorname:"connectorName", portname:"connectorName",
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function resolveField(header: string): { field: PortField; index: number } | null {
  const key = norm(header);
  const numbered = /^(?:connector|port|connection)([0-9]+)(.+)$/.exec(key);
  if (numbered) {
    const field = ALIASES["connector" + numbered[2]] ?? ALIASES[numbered[2]] ??
      (numbered[2] === "axisx" ? "directionX" : numbered[2] === "axisy" ? "directionY" : numbered[2] === "axisz" ? "directionZ" : undefined);
    return field ? { field, index: Number(numbered[1]) } : null;
  }
  const field = ALIASES[key];
  return field ? { field, index: 1 } : null;
}
const toMetres = (n: number, unit: "mm" | "cm" | "m") => unit === "mm" ? n / 1000 : unit === "cm" ? n / 100 : n;

function read(row: CatalogueRow, index: number, field: PortField): string | number | undefined {
  for (const [header, raw] of Object.entries(row)) {
    const resolved = resolveField(header);
    if (resolved?.index === index && resolved.field === field && raw !== "") return raw;
  }
  return undefined;
}
function numeric(row: CatalogueRow, index: number, field: PortField): number | undefined {
  const raw = read(row,index,field);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
function text(row: CatalogueRow,index:number,field:PortField): string {
  return String(read(row,index,field) ?? "").trim();
}
const FIELDS: PortField[] = ["connectorX","connectorY","connectorZ","directionX","directionY","directionZ",
  "connectorDomain","connectorShape","connectorDiameter","connectorWidth","connectorHeight","flowDirection","systemClassification"];

function rowHasPort(row: CatalogueRow): boolean {
  return Object.keys(row).some(header => resolveField(header) !== null);
}

/**
 * Imports one or more explicitly numbered catalogue ports (Connector 1 X,
 * Connector 2 X, ...). All catalogue product types must share the same family
 * level port layout because the current FamilyDefinition contract stores ports
 * on the family rather than on each FamilyType. Port positions are never guessed.
 */
export function buildCatalogueConnectorDefinitions(
  rows: CatalogueRow[],
  unit: "mm" | "cm" | "m" = "mm",
): ConnectorDefinition[] {
  if (!rows.some(rowHasPort)) return [];
  const buildForRow = (row: CatalogueRow): ConnectorDefinition[] => {
    const indices = [...new Set(Object.keys(row).map(resolveField).filter((v): v is NonNullable<typeof v> => !!v).map(v=>v.index))].sort((a,b)=>a-b);
    return indices.map((index) => {
      const x=numeric(row,index,"connectorX"), y=numeric(row,index,"connectorY"), z=numeric(row,index,"connectorZ");
      const dx=numeric(row,index,"directionX"), dy=numeric(row,index,"directionY"), dz=numeric(row,index,"directionZ");
      const domain=text(row,index,"connectorDomain") as Domain;
      const shape=text(row,index,"connectorShape") as Shape;
      const flow=text(row,index,"flowDirection") as Flow;
      const system=text(row,index,"systemClassification");
      const name=text(row,index,"connectorName") || "Port " + index;
      if ([x,y,z,dx,dy,dz].some(v => v === undefined)) throw new Error("Catalogue connector " + index + " requires X/Y/Z origin and direction X/Y/Z values for every product row.");
      if (!["duct","pipe","electrical","conduit","cabletray","structural","other"].includes(domain)) throw new Error("Catalogue connector " + index + " domain must be explicitly set to a supported domain.");
      if (!["round","rectangular","oval","point"].includes(shape)) throw new Error("Catalogue connector " + index + " shape must be explicitly set.");
      if (!["in","out","inout"].includes(flow)) throw new Error("Catalogue connector " + index + " flow direction must be in, out or inout.");
      if (!system) throw new Error("Catalogue connector " + index + " system classification is required.");
      const direction=[dx!,dy!,dz!], magnitude=Math.hypot(...direction);
      if (magnitude < 1e-9) throw new Error("Catalogue connector " + index + " direction must be non-zero.");
      let size: number | [number,number];
      if (shape === "rectangular") {
        const w=numeric(row,index,"connectorWidth"), h=numeric(row,index,"connectorHeight");
        if (!(w! > 0) || !(h! > 0)) throw new Error("Rectangular catalogue connector " + index + " requires positive width and height.");
        size=[toMetres(w!,unit),toMetres(h!,unit)];
      } else {
        const d=numeric(row,index,"connectorDiameter");
        if (!(d! > 0)) throw new Error("Catalogue connector " + index + " requires a positive diameter.");
        size=toMetres(d!,unit);
      }
      return {name,origin:[toMetres(x!,unit),toMetres(y!,unit),toMetres(z!,unit)],direction:direction.map(v=>v/magnitude) as [number,number,number],
        domain,shape,size,flowDirection:flow,systemClassification:system};
    });
  };
  const definitions=rows.map(buildForRow);
  const signature=(ports:ConnectorDefinition[])=>JSON.stringify(ports);
  if (definitions.some(ports=>signature(ports)!==signature(definitions[0]))) {
    throw new Error("The current family schema stores connectors at family level. Every catalogue type must have the same numbered connector definitions and values.");
  }
  return definitions[0] ?? [];
}
