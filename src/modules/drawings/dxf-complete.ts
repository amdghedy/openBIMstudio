/**
 * Structural completeness of an ASCII DXF stream. The pure-TS reader (and the engine's recovery mode) are
 * deliberately lenient, which is right when OPENING a damaged file but wrong when MERGING it into a drawing
 * the user already has: a file cut off mid-record would add partial junk geometry. Merge paths call this first.
 *
 * Complete means: an even number of lines (every group code has a value) and the stream ends with the
 * `0` / `EOF` pair that every conforming writer emits. Binary DXF is not checked here.
 */
export function dxfCompleteness(text: string): { complete: boolean; reason?: string } {
  if (/^AutoCAD Binary DXF/.test(text)) return { complete: true };
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.length < 2) return { complete: false, reason: "the file is empty or too short to be a DXF drawing" };
  if (lines.length % 2 !== 0) return { complete: false, reason: "the file ends in the middle of a record (a group code has no value)" };
  const code = lines[lines.length - 2].trim(), val = lines[lines.length - 1].trim().toUpperCase();
  if (code !== "0" || val !== "EOF") return { complete: false, reason: "the file has no end-of-file marker (it looks truncated)" };
  return { complete: true };
}
