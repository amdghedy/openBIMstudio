/** Upload store for the conversion endpoint (pure, unit-tested). Phase 1.3.
 *
 * Rules:
 *  - Storage keys are server-generated opaque ids (32 chars, URL-safe) —
 *    never client-supplied names.
 *  - The original name is kept in a sidecar metadata file, sanitized, and
 *    only ever echoed back redacted (extension + size) in logs.
 *  - Signature sniffing where a public format allows it:
 *      .ifc  → text starting with ISO-10303-21
 *      .dxf  → printable ASCII control header (0/SECTION/999 comment)
 *      .dwg  → "AC10xx" version magic at offset 0
 *    RVT/NWD/NWC are closed formats with no public magic → accepted with a
 *    recorded `signatureChecked: false` note (documented limitation).
 *  - Retention: sweepExpired() removes uploads older than maxAgeMs (default
 *    24 h) and their sidecars.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EXT_SIG = {
  ".ifc": (head) => /^ISO-10303-21/.test(head),
  ".dxf": (head, buf) => {
    // DXF is ASCII (or binary with sentinel "AutoCAD Binary DXF"). Accept
    // either a text control pair at the start or the binary sentinel.
    if (/^AutoCAD Binary DXF/.test(head)) return true;
    const text = buf.subarray(0, 4096).toString("latin1");
    return /\b0\s*\r?\n\s*SECTION\b/.test(text) || /\b999\b/.test(text.slice(0, 64));
  },
  ".dwg": (head) => /^AC10(1[2-9]|2[0-9]|3[0-9])/.test(head),
};

export function createUploadId(now = Date.now()) {
  return `${now.toString(36)}${crypto.randomBytes(12).toString("base64url")}`.slice(0, 32);
}

/**
 * Validate the first bytes of an upload against its (already sanitized)
 * extension. Returns { ok, signatureChecked, note? }.
 * `signatureChecked: false` means the format has no public magic to verify.
 */
export function sniffSignature(buf, ext) {
  const e = String(ext || "").toLowerCase();
  if (e === ".rvt" || e === ".nwd" || e === ".nwc") {
    return { ok: true, signatureChecked: false, note: "closed format — signature not verifiable" };
  }
  const check = EXT_SIG[e];
  if (!check) return { ok: false, signatureChecked: false, note: "no signature rule for extension" };
  const head = buf.subarray(0, 64).toString("latin1");
  const ok = check(head, buf);
  return { ok, signatureChecked: true, note: ok ? undefined : "file signature does not match extension" };
}

/** Persist an upload under an opaque id + sanitized sidecar. Returns the record. */
export function storeUpload(uploadsDir, { buffer, originalName, ext, note }) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  const id = createUploadId();
  const safeName = String(originalName ?? "upload").split(/[\\/]/).pop().slice(0, 120);
  const meta = {
    id,
    originalName: safeName,
    ext: String(ext || "").toLowerCase(),
    size: buffer.length,
    receivedAt: new Date().toISOString(),
    signatureNote: note ?? null,
  };
  fs.writeFileSync(path.join(uploadsDir, id), buffer);
  fs.writeFileSync(path.join(uploadsDir, `${id}.json`), JSON.stringify(meta, null, 2));
  return meta;
}

/** Read an upload + metadata by opaque id (ids are strict-validated by caller). */
export function readUpload(uploadsDir, id) {
  const metaPath = path.join(uploadsDir, `${id}.json`);
  if (!fs.existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const dataPath = path.join(uploadsDir, id);
    if (!fs.existsSync(dataPath)) return null;
    return { meta, buffer: fs.readFileSync(dataPath) };
  } catch {
    return null;
  }
}

/** Delete an upload and its sidecar. Idempotent. */
export function deleteUpload(uploadsDir, id) {
  for (const suffix of ["", ".json"]) {
    try { fs.rmSync(path.join(uploadsDir, id + suffix), { force: true }); } catch { /* ignore */ }
  }
}

/** Remove uploads (and sidecars) older than maxAgeMs. Returns removed ids. */
export function sweepExpired(uploadsDir, maxAgeMs = 24 * 60 * 60_000, now = Date.now()) {
  const removed = [];
  let entries = [];
  try { entries = fs.readdirSync(uploadsDir); } catch { return removed; }
  for (const name of entries) {
    if (name.endsWith(".json")) continue;
    const full = path.join(uploadsDir, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs > maxAgeMs) {
        fs.rmSync(full, { force: true });
        fs.rmSync(path.join(uploadsDir, `${name}.json`), { force: true });
        removed.push(name);
      }
    } catch { /* ignore */ }
  }
  return removed;
}
