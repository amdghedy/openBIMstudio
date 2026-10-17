/**
 * IFC GlobalId helpers (buildingSMART "compressed GUID", 22 characters).
 *
 * A valid IFC GlobalId is the 128-bit GUID written as 22 base-64 digits using
 * the alphabet below. The first digit therefore only carries 2 bits and must be
 * one of 0-3. A random hex string is NOT a valid GlobalId.
 */
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/** 32 hex characters (a UUID without dashes) -> 22-character IFC GlobalId. */
export function compressGuid(hex32: string): string {
  const hex = hex32.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("compressGuid: expected 32 hex digits");
  let n = BigInt("0x" + hex);
  const out: string[] = new Array(22);
  for (let i = 21; i >= 0; i--) {
    out[i] = CHARS[Number(n & 63n)];
    n >>= 6n;
  }
  return out.join("");
}

/** 22-character IFC GlobalId -> 32 hex digits. */
export function decompressGuid(g: string): string {
  if (!isValidIfcGuid(g)) throw new Error("decompressGuid: not a valid IFC GlobalId");
  let n = 0n;
  for (const ch of g) n = (n << 6n) | BigInt(CHARS.indexOf(ch));
  return n.toString(16).padStart(32, "0");
}

export function isValidIfcGuid(g: unknown): g is string {
  if (typeof g !== "string" || g.length !== 22) return false;
  if ("0123".indexOf(g[0]) < 0) return false;
  for (const ch of g) if (CHARS.indexOf(ch) < 0) return false;
  return true;
}

function randomHex32(): string {
  const bytes = new Uint8Array(16);
  const c: any = (globalThis as any).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fresh random GlobalId. */
export function newIfcGuid(): string {
  return compressGuid(randomHex32());
}

/** cyrb128 - small deterministic 128-bit string hash (four 32-bit words). */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/**
 * Deterministic GlobalId derived from a stable key (e.g. an authored element
 * id). Re-exporting the same element always yields the same GlobalId, which
 * is what BIM / BCF / change tracking need.
 */
export function stableIfcGuid(key: string): string {
  const [a, b, c, d] = cyrb128("obs:" + key);
  const hex = [a, b, c, d].map((w) => w.toString(16).padStart(8, "0")).join("");
  return compressGuid(hex);
}
