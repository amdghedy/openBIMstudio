/**
 * Password protection for project files.
 *
 *   bytes 0..7    magic "OBSPROJE"
 *   byte  8       format version (1)
 *   bytes 9..12   PBKDF2 iterations (uint32 LE)
 *   bytes 13..28  salt (16 random bytes)
 *   bytes 29..40  AES-GCM IV (12 random bytes)
 *   bytes 41..    AES-256-GCM ciphertext + tag of the complete plain .obsproj bytes
 *
 * The header is authenticated as additional data, so changing the iteration count or salt makes
 * decryption fail instead of silently weakening it. The password is never stored anywhere.
 */
const MAGIC = new TextEncoder().encode("OBSPROJE");
const VERSION = 1;
export const DEFAULT_ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;          // refuse files that ask for a trivially cheap derivation
const MAX_ITERATIONS = 20_000_000;       // and ones that would hang the browser

export class WrongPasswordError extends Error {
  constructor() { super("Wrong password, or the file is damaged."); }
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

export function isEncryptedProjectBytes(head: Uint8Array): boolean {
  return head.length >= MAGIC.length && MAGIC.every((b, i) => head[i] === b);
}

export async function isEncryptedProjectBlob(blob: Blob): Promise<boolean> {
  return isEncryptedProjectBytes(new Uint8Array(await blob.slice(0, MAGIC.length).arrayBuffer()));
}

export async function encryptProjectBytes(plain: Uint8Array, password: string, iterations = DEFAULT_ITERATIONS): Promise<Uint8Array> {
  if (!password) throw new Error("A password is required");
  if (iterations < MIN_ITERATIONS && iterations !== TEST_ITERATIONS) throw new Error("Too few iterations");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = new Uint8Array(41);
  header.set(MAGIC, 0); header[8] = VERSION;
  new DataView(header.buffer).setUint32(9, iterations, true);
  header.set(salt, 13); header.set(iv, 29);
  const key = await deriveKey(password, salt, iterations);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: header.slice(0, 29) as BufferSource }, key, plain as BufferSource));
  const out = new Uint8Array(header.length + ct.length);
  out.set(header, 0); out.set(ct, header.length);
  return out;
}

export async function decryptProjectBytes(data: Uint8Array, password: string): Promise<Uint8Array> {
  if (!isEncryptedProjectBytes(data) || data.length < 41 + 16) throw new Error("Not a password-protected project file.");
  if (data[8] !== VERSION) throw new Error("This file was made by a newer version of the app.");
  const iterations = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(9, true);
  if ((iterations < MIN_ITERATIONS && iterations !== TEST_ITERATIONS) || iterations > MAX_ITERATIONS) throw new Error("Unsupported key settings in file.");
  const salt = data.slice(13, 29), iv = data.slice(29, 41);
  const key = await deriveKey(password, salt, iterations);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: data.slice(0, 29) as BufferSource }, key, data.slice(41) as BufferSource));
  } catch {
    throw new WrongPasswordError();
  }
}

/** Reserved value used only by the unit tests to keep them fast. */
export const TEST_ITERATIONS = 1000;

export async function encryptProjectBlob(blob: Blob, password: string): Promise<Blob> {
  const out = await encryptProjectBytes(new Uint8Array(await blob.arrayBuffer()), password);
  return new Blob([out as BlobPart], { type: "application/octet-stream" });
}

export async function decryptProjectBlob(blob: Blob, password: string, type = "application/vnd.openbimstudio.project"): Promise<Blob> {
  const out = await decryptProjectBytes(new Uint8Array(await blob.arrayBuffer()), password);
  return new Blob([out as BlobPart], { type });
}
