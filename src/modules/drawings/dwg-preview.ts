/**
 * Embedded DWG preview extraction.
 *
 * TypeScript port of the MIT OR Apache-2.0 licensed `dwg-thumbnailer` crate
 * (github.com/HakanSeven12/OpenCADStudio, crates/dwg-thumbnailer/src/lib.rs) —
 * the only license-clean component of the otherwise GPL-3.0 OpenCADStudio
 * application, absorbed here under its permissive license. The port covers the
 * pure byte parsing; image decoding uses the platform decoder.
 *
 * Every DWG version stores an (uncompressed) preview at the raw file offset
 * recorded in the header's preview seeker (byte 0x0D). This module reads only
 * that — no full document parse — so a drawing shows its embedded preview
 * instantly while the native-grade parse (acadrust) runs.
 *
 * Container layout:
 *   [sentinel 16][overall_size RL][count RC] count×[code RC, start RL, size RL]
 *   [image data][end sentinel 16]
 * where `start` is an ABSOLUTE file offset, code 2 = BMP (a headerless DIB),
 * code 6 = PNG, and 1/3 = header / WMF (skipped).
 */

/** DWG preview container start sentinel — the same 16 bytes across all versions. */
const PREVIEW_SENTINEL = [
  0x1f, 0x25, 0x6d, 0x07, 0xd4, 0x36, 0x28, 0x28, 0x9d, 0x57, 0xca, 0x3f, 0x9d, 0x44, 0x10, 0x2b,
] as const;
/** Image descriptor codes (1 = header, 3 = WMF — both skipped). */
const CODE_BMP = 2;
const CODE_PNG = 6;
const MAX_CONTAINER = 64 * 1024 * 1024;

export interface DwgPreviewData {
  format: "bmp" | "png";
  /** For `bmp` this is the stored DIB with a BITMAPFILEHEADER prepended; for `png` the raw stream. */
  data: Uint8Array;
}

const le32 = (b: Uint8Array, at: number): number =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

function containerLen(head: Uint8Array): number | null {
  if (head.length < 20) return null;
  for (let i = 0; i < 16; i++) if (head[i] !== PREVIEW_SENTINEL[i]) return null;
  const overall = le32(head, 16);
  if (overall === 0 || overall > MAX_CONTAINER) return null;
  // Whole container = sentinel(16) + size(4) + overall + end sentinel(16).
  return 36 + overall;
}

/**
 * Extract the embedded preview from in-memory DWG bytes. Returns `null` for a
 * DXF/other file, a missing or empty preview, or a preview in a format this
 * parser can't handle (WMF).
 */
export function extractDwgPreview(bytes: Uint8Array): DwgPreviewData | null {
  if (bytes.length < 2 || bytes[0] !== 0x41 /* A */ || bytes[1] !== 0x43 /* C */) return null;
  const base = le32(bytes, 0x0d);
  if (base === 0 || base > MAX_CONTAINER) return null;
  const start = base;
  if (start + 20 > bytes.length) return null;
  const total = containerLen(bytes.subarray(start, start + 20));
  if (total == null || start + total > bytes.length) return null;
  const buf = bytes.subarray(start, start + total);
  const count = buf[20];
  let off = 21;
  for (let i = 0; i < count; i++) {
    if (off + 9 > buf.length) break;
    const code = buf[off];
    const abs = le32(buf, off + 1);
    const size = le32(buf, off + 5);
    off += 9;
    const format = code === CODE_BMP ? "bmp" : code === CODE_PNG ? "png" : null;
    if (!format) continue; // header / WMF / unknown
    const rel = abs - base;
    if (size === 0 || rel < 0 || rel + size > buf.length) continue;
    const stored = buf.subarray(rel, rel + size);
    return { format, data: format === "bmp" ? dibToBmp(stored) : stored.slice() };
  }
  return null;
}

/**
 * Prepend the 14-byte BITMAPFILEHEADER a stored DIB lacks so the platform BMP
 * decoder can read it (ported from dwg-thumbnailer's `dib_to_bmp`).
 */
export function dibToBmp(dib: Uint8Array): Uint8Array {
  if (dib.length < 16) return new Uint8Array(0);
  const biSize = le32(dib, 0);
  const bpp = dib[14] | (dib[15] << 8);
  const palette = bpp >= 1 && bpp <= 8 ? (1 << bpp) * 4 : 0;
  const out = new Uint8Array(14 + dib.length);
  const view = new DataView(out.buffer);
  out[0] = 0x42; // "B"
  out[1] = 0x4d; // "M"
  view.setUint32(2, 14 + dib.length, true);
  view.setUint32(10, 14 + biSize + palette, true);
  out.set(dib, 14);
  return out;
}

export interface DwgPreviewImage {
  url: string;
  width: number;
  height: number;
  format: "bmp" | "png";
}

/**
 * Extract + decode the preview of a DWG `File` to an object URL for an
 * `<img>`/canvas placeholder. Browser-side; resolves `null` when there is no
 * embedded preview or the platform decoder is unavailable (Node tests use the
 * pure `extractDwgPreview` instead).
 */
export async function readDwgPreview(file: File): Promise<DwgPreviewImage | null> {
  if (typeof createImageBitmap !== "function" || typeof Blob === "undefined") return null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hit = extractDwgPreview(bytes);
    if (!hit || !hit.data.length) return null;
    const blob = new Blob([hit.data.slice().buffer as ArrayBuffer], {
      type: hit.format === "png" ? "image/png" : "image/bmp",
    });
    const bmp = await createImageBitmap(blob);
    const url = URL.createObjectURL(blob);
    const out = { url, width: bmp.width, height: bmp.height, format: hit.format };
    bmp.close();
    return out;
  } catch {
    return null;
  }
}
