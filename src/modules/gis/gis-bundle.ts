/**
 * Persistence container for a shapefile and its sidecars.
 *
 * A project keeps one blob per imported file, so the .prj (coordinate system / unit) and .dbf (attributes) used to be
 * lost on reopen. This packs them with the .shp. Layout: "OBSGIS1\0" | u32 prjLen | u32 dbfLen | prj | dbf | shp
 * (little endian). A plain .shp (older projects) has no magic and is read as-is.
 */
const MAGIC = [0x4f, 0x42, 0x53, 0x47, 0x49, 0x53, 0x31, 0x00];
const HEADER = 16;
const MAX_SIDECAR = 64 * 1024 * 1024;

export interface GisBundle { shp: ArrayBuffer; dbf?: ArrayBuffer; prj?: string }

const slice = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export function packGisBundle(shp: ArrayBuffer, dbf?: ArrayBuffer, prj?: string): Uint8Array {
  const prjBytes = prj ? new TextEncoder().encode(prj) : new Uint8Array(0);
  const dbfBytes = dbf ? new Uint8Array(dbf) : new Uint8Array(0);
  const shpBytes = new Uint8Array(shp);
  const out = new Uint8Array(HEADER + prjBytes.length + dbfBytes.length + shpBytes.length);
  out.set(MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, prjBytes.length, true);
  dv.setUint32(12, dbfBytes.length, true);
  out.set(prjBytes, HEADER);
  out.set(dbfBytes, HEADER + prjBytes.length);
  out.set(shpBytes, HEADER + prjBytes.length + dbfBytes.length);
  return out;
}

export function isGisBundle(buf: ArrayBuffer): boolean {
  if (buf.byteLength < HEADER) return false;
  const u = new Uint8Array(buf, 0, 8);
  return MAGIC.every((b, i) => u[i] === b);
}

/** Unpack a stored blob. Throws on a bundle whose lengths do not add up (corrupt or hostile). */
export function unpackGisBundle(buf: ArrayBuffer): GisBundle {
  if (!isGisBundle(buf)) return { shp: buf };
  const dv = new DataView(buf);
  const prjLen = dv.getUint32(8, true), dbfLen = dv.getUint32(12, true);
  if (prjLen > MAX_SIDECAR || dbfLen > MAX_SIDECAR || HEADER + prjLen + dbfLen > buf.byteLength) throw new Error("The stored shapefile bundle is damaged.");
  const u = new Uint8Array(buf);
  const prj = prjLen ? new TextDecoder().decode(u.subarray(HEADER, HEADER + prjLen)) : undefined;
  const dbf = dbfLen ? slice(u.subarray(HEADER + prjLen, HEADER + prjLen + dbfLen)) : undefined;
  const shp = slice(u.subarray(HEADER + prjLen + dbfLen));
  return { shp, ...(dbf ? { dbf } : {}), ...(prj !== undefined ? { prj } : {}) };
}
