/**
 * Drafting plot style tables — CTB (colour-dependent) and STB (named) reading
 * and application.
 *
 * Absorbed as part of the OpenCADStudio feature grab ("grab more options and
 * functions"). OpenCADStudio itself is GPL-3.0 and its code is NOT copied;
 * this is an independent implementation against the documented file format
 * (format knowledge cross-checked against the MIT-licensed ezdxf `acadctb`
 * add-on, which also supplied the test fixtures in tests/fixtures/).
 *
 * File layout (all little-endian):
 *   bytes 0..47   text header "PIAFILEVERSION_2.0,<CTBVER1|STBVER1>,compress\r\npmzlibcodec"
 *   bytes 48..59  uint32 adler32(zlib stream), uint32 uncompressed size, uint32 compressed size
 *   bytes 60..    zlib (deflate) stream of the INI-style text content
 *
 * The decompressed content is an INI-like text: top-level `name=value` lines
 * and `{ ... }` blocks (`aci_table{`, `plot_style{`, `custom_lineweight_table{`).
 * Colour values are packed 32-bit ints (type byte << 24 | r << 16 | g << 8 | b);
 * strings are written with a leading quote and terminated by end of line.
 *
 * Style mapping: in a CTB, `plot_style` block `i` applies to Drafting Colour
 * Index `i + 1`; in an STB, blocks carry their own names (`Normal` is special —
 * it leaves objects as drawn).
 */

export interface PlotStyleEntry {
  /** File block index (CTB: ACI - 1; STB: order). */
  index: number;
  name: string;
  /** Resolved (r, g, b) when the style forces a colour, else null (object colour). */
  color: [number, number, number] | null;
  /** 0..100 — plotted ink coverage (screening). */
  screen: number;
  /** Bit flags: 1 dithering, 2 grayscale. */
  colorPolicy: number;
  /** Index into the lineweight table; 0 = use object lineweight. */
  lineweightIndex: number;
  /** 31 = use object linetype, 0..30 = forced. */
  linetype: number;
}

export interface PlotStyleTable {
  kind: "ctb" | "stb";
  description: string;
  scaleFactor: number;
  applyFactor: boolean;
  /** Lineweight table in millimetres (index 0 = 0.00 = use object). */
  lineweights: number[];
  /** CTB: entries are indexed by ACI (1..255). STB: by file order. */
  styles: PlotStyleEntry[];
}

export const DEFAULT_LINEWEIGHTS_MM: number[] = [
  0.0, 0.05, 0.09, 0.1, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.53, 0.6, 0.65,
  0.7, 0.8, 0.9, 1.0, 1.06, 1.2, 1.4, 1.58, 2.0, 2.11,
];

const MAGIC_PREFIX = "PIAFILEVERSION_2.0,";
const HEADER_END = 60;
/** color_policy bits */
export const POLICY_DITHERING = 1;
export const POLICY_GRAYSCALE = 2;
/** style.lineweight / style.linetype sentinel: use the object's own value. */
export const USE_OBJECT_LINEWEIGHT = 0;
export const USE_OBJECT_LINETYPE = 31;

type CtbValue = string | { [k: string]: CtbValue };

/** Inflate the zlib stream at `bytes[60..]` via the platform DecompressionStream. */
async function inflateContent(bytes: Uint8Array): Promise<string | null> {
  const DS = (globalThis as { DecompressionStream?: new (fmt: string) => unknown })
    .DecompressionStream;
  if (typeof DS !== "function" || typeof Blob === "undefined" || typeof Response === "undefined") {
    return null;
  }
  try {
    const ds = new (DS as new (fmt: string) => TransformStream<Uint8Array, Uint8Array>)("deflate");
    const stream = new Blob([bytes.slice(HEADER_END).buffer as ArrayBuffer])
      .stream()
      .pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}

const sanitized = (raw: string): string => {
  let v = raw.trim();
  if (v.startsWith('"')) return v.slice(1); // strings: <name>="string
  if (v.endsWith(")")) v = v.split(" ")[0]; // strip "0.00762 (+7.Z+...)" appendices
  return v;
};

/** Port of ezdxf's PlotStyleFileParser: first-level elements + `{}` blocks. */
function parseIni(text: string): Record<string, CtbValue> {
  const lines = text.split("\n");
  const data: Record<string, CtbValue> = {};
  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && lines[i].trim() === "") i++;
  };
  // Read one block body (until a line ending with "}"); `indentBlind` accepts
  // both `plot_style{`-level and nested ` N{` blocks.
  const readMapping = (): Record<string, CtbValue> => {
    const out: Record<string, CtbValue> = {};
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        i++;
        continue;
      }
      if (line.endsWith("}")) {
        i++;
        return out;
      }
      const name = line.endsWith("{") ? line.slice(0, -1).trim() : line.split("=", 1)[0].trim();
      const value = readValue();
      out[name] = value;
    }
    return out;
  };
  const readValue = (): CtbValue => {
    const line = lines[i];
    if (line.endsWith("{")) {
      i++;
      return readMapping();
    }
    i++;
    const eq = line.indexOf("=");
    return eq < 0 ? "" : sanitized(line.slice(eq + 1));
  };

  while (i < lines.length) {
    skipBlank();
    if (i >= lines.length) break;
    const line = lines[i];
    if (line.endsWith("}")) {
      i++;
      continue;
    }
    const name = line.endsWith("{") ? line.slice(0, -1).trim() : line.split("=", 1)[0].trim();
    data[name] = readValue();
  }
  return data;
}

/** Decode a packed plot-style colour int; returns null when the style keeps the object colour. */
function decodeColor(raw: number | null): [number, number, number] | null {
  if (raw == null || raw === -1 || raw === -1006632961) return null; // OBJECT_COLOR / OBJECT_COLOR2
  const v = raw >>> 0;
  return [(v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function asStyles(
  plotStyleBlock: Record<string, string | Record<string, string>> | undefined,
  aciTable: Record<string, string> | undefined,
): { styles: PlotStyleEntry[]; kind: "ctb" | "stb" } {
  const styles: PlotStyleEntry[] = [];
  if (!plotStyleBlock) return { styles, kind: "ctb" };
  const hasAciTable = !!aciTable && Object.keys(aciTable).length > 0;
  const keys = Object.keys(plotStyleBlock).sort((a, b) => Number(a) - Number(b));
  for (const k of keys) {
    const v = plotStyleBlock[k];
    if (typeof v === "string") continue;
    const index = Number(k);
    if (!Number.isFinite(index)) continue;
    const rawColor = v.color != null && v.color !== "" ? Number(sanitized(String(v.color))) : null;
    const rawMode =
      v.mode_color != null && v.mode_color !== "" ? Number(sanitized(String(v.mode_color))) : null;
    const name = String(v.name ?? "").trim() || (hasAciTable ? aciTable?.[k] ?? "" : "");
    styles.push({
      index,
      name,
      color: decodeColor(rawMode ?? rawColor),
      screen: Math.max(0, Math.min(100, Number(sanitized(String(v.screen ?? "100"))) || 0)),
      colorPolicy: Number(sanitized(String(v.color_policy ?? "1"))) || 0,
      lineweightIndex: Math.max(0, Number(sanitized(String(v.lineweight ?? "0"))) || 0),
      linetype: Number(sanitized(String(v.linetype ?? String(USE_OBJECT_LINETYPE)))) || 0,
    });
  }
  return { styles, kind: hasAciTable ? "ctb" : "stb" };
}

/**
 * Parse a CTB/STB byte stream. Returns null when the bytes are not a plot
 * style table or the platform cannot inflate the content.
 */
export async function parsePlotStyleTable(bytes: Uint8Array): Promise<PlotStyleTable | null> {
  if (bytes.length < HEADER_END) return null;
  const head = new TextDecoder().decode(bytes.subarray(0, 48));
  if (!head.startsWith(MAGIC_PREFIX)) return null;
  const isCtb = head.includes("CTBVER1");
  const isStb = head.includes("STBVER1");
  if (!isCtb && !isStb) return null;
  const text = await inflateContent(bytes);
  if (!text) return null;
  const data = parseIni(text.replace(/\r/g, ""));

  const description = String(data.description ?? "");
  const scaleFactor = Number(sanitized(String(data.scale_factor ?? "1.0"))) || 1;
  const applyFactor = String(data.apply_factor ?? "FALSE").toUpperCase() === "TRUE";

  let lineweights = DEFAULT_LINEWEIGHTS_MM.slice();
  const lwt = data.custom_lineweight_table;
  if (lwt && typeof lwt === "object" && !Array.isArray(lwt)) {
    const pairs = Object.entries(lwt).filter(([, v]) => typeof v === "string");
    if (pairs.length) {
      lineweights = pairs
        .map(([k, v]) => [Number(k), Number(v)] as const)
        .filter(([k]) => Number.isFinite(k))
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v);
    }
  }

  const aciTableRaw = data.aci_table;
  const aciTable: Record<string, string> | undefined =
    aciTableRaw && typeof aciTableRaw === "object"
      ? Object.fromEntries(
          Object.entries(aciTableRaw).map(([k, v]) => [k, typeof v === "string" ? v : ""]),
        )
      : undefined;
  const plotStyleBlock = data.plot_style;
  const { styles, kind } = asStyles(
    plotStyleBlock && typeof plotStyleBlock === "object"
      ? (plotStyleBlock as Record<string, string | Record<string, string>>)
      : undefined,
    aciTable,
  );
  if (!styles.length) return null;
  // CTB mapping: file block i applies to ACI i+1 (verified against ezdxf).
  if (kind === "ctb") for (const s of styles) s.index = s.index + 1;
  return { kind, description, scaleFactor, applyFactor, lineweights, styles };
}

/** Read a CTB/STB `File` and parse it (Plot dialog "Load CTB / STB…"). */
export async function loadPlotStyleFile(
  file: File,
): Promise<{ table: PlotStyleTable; fileName: string } | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const table = await parsePlotStyleTable(bytes);
  return table ? { table, fileName: file.name } : null;
}

export function plotStyleForAci(table: PlotStyleTable, aci: number): PlotStyleEntry | null {
  if (table.kind !== "ctb") return null;
  return table.styles.find((s) => s.index === aci) ?? null;
}

export function plotStyleByName(table: PlotStyleTable, name: string): PlotStyleEntry | null {
  if (table.kind !== "stb") return null;
  const k = name.trim().toLowerCase();
  return table.styles.find((s) => s.name.toLowerCase() === k) ?? null;
}

export interface ResolvedPlotStyle {
  /** Forced plot colour, or null to draw with the object's own colour. */
  color: [number, number, number] | null;
  /** 0..1 ink coverage from the style screen. */
  alpha: number;
  /** Forced lineweight in mm, or null to keep the object lineweight. */
  lineweightMm: number | null;
  grayscale: boolean;
}

/** Resolve an entry to drawable values (colour policy, screening, lineweight). */
export function resolvePlotStyle(
  table: PlotStyleTable,
  entry: PlotStyleEntry | null,
): ResolvedPlotStyle {
  const none: ResolvedPlotStyle = { color: null, alpha: 1, lineweightMm: null, grayscale: false };
  if (!entry) return none;
  const grayscale = (entry.colorPolicy & POLICY_GRAYSCALE) !== 0;
  const lineweightMm =
    entry.lineweightIndex > 0 && entry.lineweightIndex < table.lineweights.length
      ? table.lineweights[entry.lineweightIndex]
      : null;
  return {
    color: entry.color,
    alpha: Math.min(1, Math.max(0.02, entry.screen / 100)),
    lineweightMm,
    grayscale,
  };
}

/** rgb int → (r,g,b); for grayscale plotting of as-drawn colours. */
export function rgbToChannels(rgb: number): [number, number, number] {
  return [(rgb >>> 16) & 0xff, (rgb >>> 8) & 0xff, rgb & 0xff];
}

export function grayscaleChannel([r, g, b]: [number, number, number]): number {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}
