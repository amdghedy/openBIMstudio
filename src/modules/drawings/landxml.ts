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

/**
 * Bounds for a LandXML import (issue #90). The parser is regex-based (no XML
 * parser, so no XXE), but the scan is linear in file size and every point
 * becomes two drawing entities — cap both. The caller (cad-viewer
 * importLandXml) enforces the size bound and the <!ENTITY ban before the
 * text reaches this parser.
 */
export const LANDXML_MAX_BYTES = 5 * 1024 * 1024;
export const LANDXML_MAX_POINTS = 100_000;

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
 * Throws when the file carries more than LANDXML_MAX_POINTS points — a
 * survey file that large is imported in chunks, not as one drawing edit.
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
    if (out.length > LANDXML_MAX_POINTS) {
      throw new Error(`LandXML has more than ${LANDXML_MAX_POINTS.toLocaleString()} CgPoints. Split the file and import it in parts.`);
    }
  }
  return out;
}

export const isLandXml = (text: string): boolean =>
  /<LandXML[\s>]/i.test(text) && /<CgPoints?[\s>]/i.test(text);
