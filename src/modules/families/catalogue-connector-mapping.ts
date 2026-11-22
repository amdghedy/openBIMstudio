import type { ConnectorDefinition } from "../object-hierarchy";
import type { CatalogueRow } from "./catalogue-intake";

type Domain = ConnectorDefinition["domain"];
type Shape = ConnectorDefinition["shape"];
type Flow = ConnectorDefinition["flowDirection"];

const ALIASES: Record<string, string> = {
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
const toMetres = (n: number, unit: "mm" | "cm" | "m") => unit === "mm" ? n / 1000 : unit === "cm" ? n / 100 : n;
function finite(row: CatalogueRow, key: string): number | undefined {
  const entry = Object.entries(row).find(([name]) => (ALIASES[norm(name)] ?? name) === key);
  if (!entry || entry[1] === undefined || entry[1] === "") return undefined;
  const value = Number(entry[1]);
  return Number.isFinite(value) ? value : undefined;
}
function value(row: CatalogueRow, key: string): string {
  const entry = Object.entries(row).find(([name]) => (ALIASES[norm(name)] ?? name) === key);
  return entry ? String(entry[1] ?? "").trim() : "";
}

/**
 * Builds family-level ports only from explicit catalogue port coordinates and
 * axes. The current family schema stores connectorDefs on the family, not on
 * each FamilyType, so every product row must describe the same port layout.
 */
export function buildCatalogueConnectorDefinitions(
  rows: CatalogueRow[],
  unit: "mm" | "cm" | "m" = "mm",
): ConnectorDefinition[] {
  const hasPortData = rows.some(row =>
    ["connectorX","connectorY","connectorZ","directionX","directionY","directionZ","connectorDomain",
      "connectorShape","connectorDiameter","connectorWidth","connectorHeight","systemClassification"]
      .some(key => Object.entries(row).some(([name, v]) => (ALIASES[norm(name)] ?? name) === key && v !== undefined && v !== "")));
  if (!hasPortData) return [];
  const definitions = rows.map((row, index) => {
    const x=finite(row,"connectorX"), y=finite(row,"connectorY"), z=finite(row,"connectorZ");
    const dx=finite(row,"directionX"), dy=finite(row,"directionY"), dz=finite(row,"directionZ");
    const domain=value(row,"connectorDomain") as Domain;
    const shape=value(row,"connectorShape") as Shape;
    const flow=value(row,"flowDirection") as Flow;
    const system=value(row,"systemClassification");
    const name=value(row,"connectorName") || "Port " + (index+1);
    if ([x,y,z,dx,dy,dz].some(v => v === undefined)) throw new Error("Catalogue connector data requires X/Y/Z origin and direction X/Y/Z values for every product row.");
    if (!["duct","pipe","electrical","conduit","cabletray","structural","other"].includes(domain)) throw new Error("Catalogue connector domain must be explicitly set to a supported domain.");
    if (!["round","rectangular","oval","point"].includes(shape)) throw new Error("Catalogue connector shape must be explicitly set.");
    if (!["in","out","inout"].includes(flow)) throw new Error("Catalogue connector flow direction must be in, out or inout.");
    if (!system) throw new Error("Catalogue connector system classification is required.");
    const direction=[dx!,dy!,dz!];
    const magnitude=Math.hypot(...direction);
    if (magnitude < 1e-9) throw new Error("Catalogue connector direction must be non-zero.");
    let size: number | [number,number];
    if (shape === "rectangular") {
      const w=finite(row,"connectorWidth"), h=finite(row,"connectorHeight");
      if (!(w! > 0) || !(h! > 0)) throw new Error("Rectangular catalogue connectors require positive Connector Width and Connector Height.");
      size=[toMetres(w!,unit),toMetres(h!,unit)];
    } else {
      const d=finite(row,"connectorDiameter");
      if (!(d! > 0)) throw new Error("Round, oval and point catalogue connectors require a positive Connector Diameter.");
      size=toMetres(d!,unit);
    }
    return {name,origin:[toMetres(x!,unit),toMetres(y!,unit),toMetres(z!,unit)] as [number,number,number],
      direction:direction.map(v=>v/magnitude) as [number,number,number],domain,shape,size,flowDirection:flow,systemClassification:system};
  });
  const signature=(d: ConnectorDefinition) => JSON.stringify(d);
  if (definitions.some(d => signature(d) !== signature(definitions[0]))) {
    throw new Error("This family schema stores connector definitions at family level. All catalogue types must share identical connector definitions; type-specific ports are not supported yet.");
  }
  return definitions.length ? [definitions[0]] : [];
}
