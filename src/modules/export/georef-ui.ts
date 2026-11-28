/** Dialog for the project's map coordinate system (IFC4 IfcProjectedCRS + IfcMapConversion). */
import { openFormModal } from "../../features/form-modal";
import { describeGeoref, getGeoref, setGeoref, validateGeoref, type Georef, type GeorefUnit } from "./ifc-georef";

export async function openGeorefDialog(): Promise<{ changed: boolean; message: string }> {
  const cur = getGeoref();
  const vals = await openFormModal({
    title: "Project coordinate system",
    subtitle: `${describeGeoref(cur)} Written into IFC4 exports as IfcProjectedCRS + IfcMapConversion (IFC2X3 cannot carry it).`,
    submitLabel: "Apply",
    width: 560,
    fields: [
      { kind: "checkbox", key: "clear", label: "Remove the coordinate system (not georeferenced)", default: false },
      { kind: "text", key: "crsName", label: "Coordinate system", default: cur?.crsName ?? "", placeholder: "EPSG:2263", hint: "Usually an EPSG code: EPSG:32618 (UTM 18N), EPSG:2263 (NY Long Island, US ft), EPSG:27700 (British National Grid)." },
      { kind: "select", key: "unit", label: "Map unit", default: cur?.unit ?? "metre", options: [["metre", "Metre"], ["foot", "International foot"], ["ussurveyfoot", "US survey foot"]], hint: "Must match the coordinate system. State Plane zones are usually in US survey feet." },
      { kind: "number", key: "eastings", label: "Model origin — Eastings", default: cur?.eastings ?? 0, step: 0.001 },
      { kind: "number", key: "northings", label: "Model origin — Northings", default: cur?.northings ?? 0, step: 0.001 },
      { kind: "number", key: "orthogonalHeight", label: "Model origin — Height", default: cur?.orthogonalHeight ?? 0, step: 0.001 },
      { kind: "number", key: "rotationDeg", label: "Rotation from grid east", default: cur?.rotationDeg ?? 0, unit: "°", step: 0.0001, hint: "Counter-clockwise angle of the model's X axis against grid east." },
      { kind: "number", key: "scale", label: "Scale", default: cur?.scale ?? 1, step: 0.000001 },
      { kind: "text", key: "crsDescription", label: "Description (optional)", default: cur?.crsDescription ?? "" },
      { kind: "text", key: "mapProjection", label: "Projection (optional)", default: cur?.mapProjection ?? "", placeholder: "Lambert Conformal Conic" },
      { kind: "text", key: "mapZone", label: "Zone (optional)", default: cur?.mapZone ?? "", placeholder: "3104" },
      { kind: "text", key: "geodeticDatum", label: "Datum (optional)", default: cur?.geodeticDatum ?? "", placeholder: "NAD83" },
    ],
    onSubmit: (v) => {
      if (v.clear) return true;
      return validateGeoref(valuesToGeoref(v)).length === 0;
    },
  });
  if (!vals) return { changed: false, message: "Coordinate system unchanged." };
  if (vals.clear) { setGeoref(null); return { changed: true, message: "Coordinate system removed; IFC exports are not georeferenced." }; }
  const g = valuesToGeoref(vals);
  const problems = validateGeoref(g);
  if (problems.length) return { changed: false, message: problems.map((p) => p.message).join(" ") };
  setGeoref(g);
  return { changed: true, message: describeGeoref(g) };
}

export function valuesToGeoref(v: Record<string, unknown>): Georef {
  const t = (k: string): string | undefined => { const s = typeof v[k] === "string" ? (v[k] as string).trim() : ""; return s || undefined; };
  const n = (k: string, d: number): number => { const x = typeof v[k] === "number" ? (v[k] as number) : Number(v[k]); return Number.isFinite(x) ? x : d; };
  return {
    crsName: t("crsName") ?? "", unit: (t("unit") as GeorefUnit) ?? "metre",
    eastings: n("eastings", NaN), northings: n("northings", NaN), orthogonalHeight: n("orthogonalHeight", 0),
    rotationDeg: n("rotationDeg", 0), scale: n("scale", 1),
    ...(t("crsDescription") ? { crsDescription: t("crsDescription") } : {}), ...(t("mapProjection") ? { mapProjection: t("mapProjection") } : {}),
    ...(t("mapZone") ? { mapZone: t("mapZone") } : {}), ...(t("geodeticDatum") ? { geodeticDatum: t("geodeticDatum") } : {}),
  };
}
