/**
 * Pre-parse guards for untrusted FILES that are not JSON (JSON goes through `safeLoad`).
 *
 * Every binary/text import boundary calls `assertFileAllowed(kind, name, size, head?)` BEFORE reading the whole
 * file into a parser, and the format-specific content guards below before decoding it. All checks are O(1) or a single
 * bounded pass and never allocate in proportion to attacker-chosen counts.
 *
 * This is a first line of defence, not a validator: a file that passes is still parsed by a parser that must cope
 * with malformed content. A file that fails is rejected with an actionable message and must leave application
 * state untouched (callers invoke the guard before any state mutation).
 */

export type GuardedKind = "ifc" | "dxf" | "dwg" | "bcf" | "pdf" | "ids" | "standards-pack" | "point-cloud"
  | "frag" | "geojson" | "shapefile" | "mesh" | "solid" | "landxml" | "factors" | "type-catalog";

const MiB = 1024 * 1024;
/** Hard upper bounds per kind. Browser tabs cannot hold more than this in memory with a parser's working set anyway. */
export const FILE_LIMITS: Record<GuardedKind, number> = {
  ifc: 1536 * MiB,
  dxf: 512 * MiB,
  dwg: 256 * MiB,
  bcf: 256 * MiB,
  pdf: 200 * MiB,
  ids: 5 * MiB,
  "standards-pack": 5 * MiB,
  "point-cloud": 2048 * MiB,
  // FRAG is the binary cache of a converted IFC: same ceiling as the IFC it came from.
  frag: 1536 * MiB,
  // GeoJSON is JSON.parsed by gis-core (via safeLoad): 20 MB keeps the parse + projection cheap.
  geojson: 20 * MiB,
  // Shapefile (.shp + .dbf) is a binary record stream with its own 5M-vertex cap; 256 MB bounds the read.
  shapefile: 256 * MiB,
  // Three.js mesh formats (glb/gltf/obj/stl/ply/fbx/dae/3ds): whole-file parse on the main thread.
  mesh: 200 * MiB,
  // STEP / IGES / BREP / 3DM via the isolated solid reader worker (mirrors openSolid MAX_BYTES).
  solid: 200 * MiB,
  // LandXML is regex-parsed text (no XML parser, so no XXE), but the scan is linear in file size.
  landxml: 5 * MiB,
  // Carbon-factor CSV/JSON imports: small reference data, never a model.
  factors: 5 * MiB,
  // Family type catalogs: small TSV/CSV reference data.
  "type-catalog": 5 * MiB,
};

export interface GuardResult { ok: boolean; reason?: string }
const ok: GuardResult = { ok: true };
const bad = (reason: string): GuardResult => ({ ok: false, reason });

const ascii = (b: Uint8Array, n = 16): string => { let s = ""; for (let i = 0; i < Math.min(n, b.length); i++) s += String.fromCharCode(b[i]); return s; };

/** Size bound + empty-file check. */
export function guardSize(kind: GuardedKind, size: number): GuardResult {
  if (!Number.isFinite(size) || size <= 0) return bad("The file is empty.");
  const max = FILE_LIMITS[kind];
  if (size > max) return bad(`The file is ${(size / MiB).toFixed(0)} MB, above the ${(max / MiB).toFixed(0)} MB limit for this format.`);
  return ok;
}

/** Magic bytes. `head` must be at least the first 32 bytes (or the whole file when shorter). */
export function guardSignature(kind: GuardedKind, head: Uint8Array): GuardResult {
  const h = ascii(head, 32);
  switch (kind) {
    case "dwg":
      return /^AC10\d\d/.test(h) ? ok : bad("Not a DWG file (missing the AC10xx version signature).");
    case "pdf":
      // PDF allows up to 1024 bytes of leading junk, but every real producer starts at byte 0.
      return h.startsWith("%PDF-") ? ok : bad("Not a PDF file (missing the %PDF- header).");
    case "bcf":
      return h.startsWith("PK\u0003\u0004") ? ok : bad("Not a BCF file (a BCF is a ZIP archive).");
    case "dxf": {
      if (h.startsWith("AutoCAD Binary DXF")) return ok;
      // ASCII DXF: group code 0 / SECTION (possibly after a 999 comment or a BOM).
      const t = new TextDecoder("latin1").decode(head.subarray(0, 256)).replace(/^﻿/, "");
      return /^\s*(999\s*\r?\n[^\r\n]*\r?\n\s*)?0\s*\r?\n\s*SECTION\b/.test(t) ? ok : bad("Not a DXF file (expected the group code 0 / SECTION header).");
    }
    case "point-cloud":
      return ok; // LAS is checked by guardLasHeader; PLY/PCD/PTX are text and bounded by their parsers' point-count caps
    default:
      return ok;
  }
}

/** LAS public header: signature + a sane point-count/size relationship. */
export function guardLasHeader(bytes: Uint8Array): GuardResult {
  if (ascii(bytes, 4) !== "LASF") return bad("Not a LAS file (missing the LASF signature).");
  if (bytes.length < 227) return bad("The LAS header is truncated.");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = dv.getUint32(96, true);
  const recLen = dv.getUint16(105, true);
  const legacyCount = dv.getUint32(107, true);
  if (recLen < 20) return bad("The LAS point record length is invalid.");
  if (offset > bytes.length) return bad("The LAS point data offset is beyond the end of the file.");
  const maxPossible = Math.floor((bytes.length - offset) / recLen);
  if (legacyCount > maxPossible) return bad("The LAS header declares more points than the file can contain.");
  return ok;
}

/** XML packs (IDS / standards): bounded size, no DOCTYPE entity declarations (entity-expansion bombs, XXE). */
export function guardXmlText(text: string): GuardResult {
  if (text.length > FILE_LIMITS.ids) return bad("The XML file is too large.");
  if (/<!ENTITY/i.test(text)) return bad("XML entity declarations are not allowed.");
  if (/<!DOCTYPE[^>]*\[/i.test(text)) return bad("An inline DOCTYPE subset is not allowed.");
  return ok;
}

export interface ZipLimits { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number; maxRatio: number }
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 20000, maxEntryBytes: 1024 * MiB, maxTotalBytes: 3072 * MiB, maxRatio: 1000 };

/**
 * ZIP central-directory audit WITHOUT inflating anything: entry count, declared sizes, compression ratio and path
 * safety (no `..`, absolute, drive-letter, backslash or NUL names). Declared sizes can lie; consumers must still
 * inflate with a limit. Handles ZIP64 EOCD markers conservatively (rejects: BCF/IFCZIP exports never need them).
 */
export function guardZipDirectory(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): GuardResult {
  const n = bytes.length;
  if (n < 22) return bad("The archive is truncated.");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End-of-central-directory: scan back at most 64 KiB + 22 for the signature.
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return bad("The archive has no central directory (corrupt or not a ZIP file).");
  const entries = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return bad("ZIP64 archives are not supported.");
  if (entries > limits.maxEntries) return bad(`The archive has ${entries} entries (limit ${limits.maxEntries}).`);
  if (cdOffset + cdSize > n) return bad("The archive's central directory is out of range.");
  let p = cdOffset, total = 0;
  for (let e = 0; e < entries; e++) {
    if (p + 46 > cdOffset + cdSize || dv.getUint32(p, true) !== 0x02014b50) return bad("The archive's central directory is malformed.");
    const comp = dv.getUint32(p + 20, true), raw = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), cmtLen = dv.getUint16(p + 32, true);
    if (p + 46 + nameLen > n) return bad("The archive has a truncated entry name.");
    let name = "";
    for (let k = 0; k < nameLen; k++) name += String.fromCharCode(bytes[p + 46 + k]);
    if (name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes("..")) {
      return bad("The archive contains an unsafe path.");
    }
    if (raw > limits.maxEntryBytes) return bad("An entry in the archive is too large when extracted.");
    total += raw;
    if (total > limits.maxTotalBytes) return bad("The archive is too large when extracted.");
    if (comp > 0 && raw / comp > limits.maxRatio) return bad("An entry has an implausible compression ratio (possible zip bomb).");
    if (comp === 0 && raw > 0 && dv.getUint16(p + 10, true) !== 0) return bad("An entry declares zero compressed bytes but non-zero content.");
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return ok;
}

export class FileGuardError extends Error {
  constructor(public kind: GuardedKind, public fileName: string, reason: string) {
    super(`${fileName}: ${reason} The file was not opened and your project is unchanged.`);
    this.name = "FileGuardError";
  }
}

/** Throws FileGuardError when any check fails. `head` may be omitted when only the size can be checked yet. */
export function assertFileAllowed(kind: GuardedKind, fileName: string, size: number, head?: Uint8Array): void {
  let r = guardSize(kind, size);
  if (r.ok && head) r = guardSignature(kind, head);
  if (!r.ok) throw new FileGuardError(kind, fileName, r.reason ?? "The file was rejected.");
}

/** Reads only the first `n` bytes of a File/Blob (no full read). */
export async function readHead(file: Blob, n = 256): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, n).arrayBuffer());
}
