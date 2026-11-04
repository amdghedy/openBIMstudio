/**
 * LandXML survey point import — reads `<CgPoint>` elements from a LandXML
 * document (the survey interchange format used by civil packages) into CAD
 * POINT entities.
 *
 * Absorbed as part of the OpenCADStudio feature grab ("grab more options and
 * functions"): OpenCADStudio is GPL-3.0 and its code is NOT copied — this is
 * an independent implementation against the public LandXML schema
 * (https://www.landxml.org/schema/LandXML-1.2).
 *
 * LandXML CgPoint text is "northing easting [elevation]" (Y X Z order) with
 * optional comma thousands separators; `name` and `desc` attributes carry the
 * point identifier and description. Coordinates map north→CAD Y, east→CAD X.
 */

export interface LandXmlPoint {
  name: string;
  desc: string;
  /** Easting → CAD X. */
  x: number;
  /** Northing → CAD Y. */
  y: number;
  /** Elevation, NaN when the file carries none. */
  z: number;
}

const stripNum = (s: string): number => {
  // Strip thousands separators and trailing units; tolerate "1,234.567".
  const v = Number(s.replace(/,/g, "").trim());
  return Number.isFinite(v) ? v : NaN;
};

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) out[m[1].toLowerCase()] = m[2];
  return out;
}

/**
 * Parse CgPoints from LandXML text. Returns every parseable point; entries
 * with unparsable coordinates are skipped rather than failing the import.
 */
export function parseLandXmlPoints(text: string): LandXmlPoint[] {
  const out: LandXmlPoint[] = [];
  const re = /<CgPoint\b([^>]*?)(?:\/>|>([\s\S]*?)<\/CgPoint\s*>)/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const a = attrs(m[1] ?? "");
    const nums = (m[2] ?? "")
      .trim()
      .split(/[\s]+/)
      .filter((s) => /^[-+]?[\d.,]+$/.test(s));
    if (nums.length < 2) continue;
    const y = stripNum(nums[0]); // northing
    const x = stripNum(nums[1]); // easting
    const z = nums.length > 2 ? stripNum(nums[2]) : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ name: a.name ?? "", desc: a.desc ?? "", x, y, z });
  }
  return out;
}

export const isLandXml = (text: string): boolean =>
  /<LandXML[\s>]/i.test(text) && /<CgPoints?[\s>]/i.test(text);
