/** AES-GCM helpers (WebCrypto) for secrets at rest. Pure of any browser storage so they can be tested in Node. */
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** A random, non-extractable key: script can use it to encrypt/decrypt but can never read its bytes. */
export function generateStorageKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Output: base64(iv[12] || ciphertext+tag). A fresh IV is used for every call. */
export async function encryptString(key: CryptoKey, plain: string, aad = ""): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(plain));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), 12);
  return b64(out);
}

/** Throws when the data was altered, the key is wrong, or `aad` (e.g. the item name) differs. */
export async function decryptString(key: CryptoKey, payload: string, aad = ""): Promise<string> {
  const all = unb64(payload);
  if (all.length < 13) throw new Error("Corrupt secret");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12), additionalData: enc.encode(aad) }, key, all.slice(12));
  return dec.decode(pt);
}

export const _b64 = { b64, unb64 };
