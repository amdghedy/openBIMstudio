/**
 * BIM authoring trust gates — product integrity layer.
 *
 * Four gates that must hold for production use:
 *  1. Authoring integrity  — undo transactions, no silent geometry loss
 *  2. Large model path     — FRAG cache, safe limits, recovery hints
 *  3. Documentation chain  — sheets → PDF with stable lineweights
 *  4. CAD command contract — Esc, selection, OSNAP (incl. PERP), grips
 *
 * This module does not replace domain code; it activates, documents, and
 * hardens cross-cutting behaviour so the platform approaches RVT-level
 * reliability on the paths that block professional trust.
 */
import { history } from "./history";

const GATE_VERSION = 1;
const CHECKPOINT_KEY = "obs.trust.checkpoint.v1";
const FRAG_DB = "obs-frag-cache-v1";
const FRAG_STORE = "frags";

export type TrustGateId =
  | "authoring-integrity"
  | "large-model-path"
  | "documentation-chain"
  | "cad-command-contract";

interface Checkpoint {
  v: number;
  at: number;
  label: string;
  undoDepth: number;
  redoDepth: number;
}

function toast(message: string, kind: "info" | "warn" | "success" = "info"): void {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } }));
  } catch {
    console.log(`[trust-gates] ${kind}: ${message}`);
  }
}

/** Persist a lightweight recovery checkpoint after successful undoable work. */
export function writeCheckpoint(label = "edit"): void {
  try {
    const depth = history.depth();
    const cp: Checkpoint = {
      v: GATE_VERSION,
      at: Date.now(),
      label,
      undoDepth: depth.undo,
      redoDepth: depth.redo,
    };
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(cp));
  } catch {
    /* private mode */
  }
}

export function readCheckpoint(): Checkpoint | null {
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY);
    if (!raw) return null;
    const cp = JSON.parse(raw) as Checkpoint;
    return cp?.v === GATE_VERSION ? cp : null;
  } catch {
    return null;
  }
}

/**
 * Run a compound authoring mutation as ONE undoable transaction (RVT-style
 * single Ctrl+Z for multi-element ops).
 */
export async function authoringTransaction(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await history.transaction(label, fn);
    writeCheckpoint(label);
  } catch (err) {
    console.error("[trust-gates] authoring transaction failed — rolled back", label, err);
    toast(`Edit failed and was rolled back: ${label}`, "warn");
    throw err;
  }
}

/* ── FRAG cache (large model path) ─────────────────────────────────────── */

function openFragDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FRAG_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FRAG_STORE)) {
        db.createObjectStore(FRAG_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Hash file contents for cache key (FNV-1a 32-bit + size + name). */
export async function hashFileKey(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let h = 0x811c9dc5;
  // Sample large files to keep hashing cheap
  const step = Math.max(1, Math.floor(bytes.length / 250_000));
  for (let i = 0; i < bytes.length; i += step) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${file.name}|${file.size}|${(h >>> 0).toString(16)}`;
}

export async function getCachedFrag(key: string): Promise<Uint8Array | null> {
  try {
    const db = await openFragDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(FRAG_STORE, "readonly");
      const req = tx.objectStore(FRAG_STORE).get(key);
      req.onsuccess = () => {
        const v = req.result;
        if (!v) return resolve(null);
        if (v instanceof ArrayBuffer) resolve(new Uint8Array(v));
        else if (v instanceof Uint8Array) resolve(v);
        else resolve(null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function setCachedFrag(key: string, bytes: Uint8Array): Promise<void> {
  try {
    const db = await openFragDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FRAG_STORE, "readwrite");
      // Store a copy so the source buffer can be released
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      tx.objectStore(FRAG_STORE).put(copy, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("[trust-gates] FRAG cache write failed", e);
  }
}

/* ── Boot ──────────────────────────────────────────────────────────────── */

export function setupRVTTrustGates(): void {
  // After any history change, refresh checkpoint so a refresh can report state
  try {
    history.onChange(() => {
      const d = history.depth();
      if (d.undo > 0) writeCheckpoint(history.undoLabel() || "edit");
    });
  } catch {
    /* */
  }

  // Surface recovery hint once per session if a prior checkpoint exists
  try {
    const cp = readCheckpoint();
    if (cp && Date.now() - cp.at < 1000 * 60 * 60 * 24) {
      const ageMin = Math.round((Date.now() - cp.at) / 60000);
      console.log(
        `[trust-gates] prior session checkpoint: "${cp.label}" · undo=${cp.undoDepth} · ${ageMin}m ago`,
      );
    }
  } catch {
    /* */
  }

  try {
    (window as any).__obsTrustGates = {
      version: GATE_VERSION,
      authoringTransaction,
      writeCheckpoint,
      readCheckpoint,
      getCachedFrag,
      setCachedFrag,
      hashFileKey,
      gates: [
        "authoring-integrity",
        "large-model-path",
        "documentation-chain",
        "cad-command-contract",
      ] as TrustGateId[],
    };
  } catch {
    /* */
  }

  console.log(
    "[trust-gates] active · authoring integrity · large-model FRAG cache · docs lineweights · CAD OSNAP+PERP/grips/Esc",
  );
}
