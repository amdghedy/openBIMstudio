/**
 * Export loaded ThatOpen Fragments models as official .frag binaries.
 *
 * Uses FragmentsModel.getBuffer() from @thatopen/fragments — the same
 * format produced by IfcImporter and consumed by FragmentsModels.load().
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";

export interface FragExportResult {
  modelId: string;
  bytes: ArrayBuffer;
  byteLength: number;
}

function safeFileName(id: string): string {
  const base = String(id || "model")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return base.endsWith(".frag") ? base : `${base}.frag`;
}

function triggerDownload(bytes: ArrayBuffer, filename: string): void {
  if (!bytes || bytes.byteLength === 0) {
    throw new Error("Empty .frag buffer — model may not be fully loaded.");
  }
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}

/**
 * Serialize one loaded Fragments model to ThatOpen .frag bytes.
 */
export async function getFragBuffer(modelId: string, raw = false): Promise<FragExportResult> {
  const model: any = ctx.fragments?.list?.get?.(modelId);
  if (!model) {
    throw new Error(`Model not found: ${modelId}`);
  }
  if (typeof model.getBuffer !== "function") {
    throw new Error(
      `Model "${modelId}" does not support getBuffer() — ` +
        `requires @thatopen/fragments FragmentsModel.`,
    );
  }
  const buf: ArrayBuffer = await model.getBuffer(raw);
  if (!buf || !(buf instanceof ArrayBuffer) && !(buf as any)?.byteLength) {
    throw new Error(`getBuffer() returned empty data for "${modelId}".`);
  }
  const bytes =
    buf instanceof ArrayBuffer
      ? buf
      : (buf as ArrayBufferView).buffer.slice(
          (buf as ArrayBufferView).byteOffset,
          (buf as ArrayBufferView).byteOffset + (buf as ArrayBufferView).byteLength,
        );
  return { modelId, bytes, byteLength: bytes.byteLength };
}

/**
 * Download one model as a .frag file (ThatOpen Fragments format).
 */
export async function downloadFragModel(modelId: string, raw = false): Promise<void> {
  const { bytes } = await getFragBuffer(modelId, raw);
  triggerDownload(bytes, safeFileName(modelId));
  notify("info", `Saved ${safeFileName(modelId)} (${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB)`);
}

/**
 * Export every loaded Fragments model as individual .frag downloads.
 * Returns counts for UI feedback.
 */
export async function downloadAllFragModels(raw = false): Promise<{ ok: number; failed: string[] }> {
  const ids = Array.from(ctx.fragments?.list?.keys?.() ?? []);
  if (!ids.length) {
    throw new Error("No Fragments models are loaded. Import or link an IFC / .frag first.");
  }
  let ok = 0;
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await downloadFragModel(id, raw);
      ok++;
      // Brief gap so browsers don't coalesce multi-download prompts.
      await new Promise((r) => setTimeout(r, 250));
    } catch (e: any) {
      failed.push(`${id}: ${e?.message ?? e}`);
      console.error("[export-frag]", id, e);
    }
  }
  if (ok && !failed.length) {
    notify("info", `Exported ${ok} .frag file(s) (ThatOpen Fragments)`);
  } else if (ok && failed.length) {
    notify("warn", `Exported ${ok}; failed ${failed.length}. See console.`);
  } else if (!ok) {
    notify("error", `FRAG export failed for all models.`);
  }
  return { ok, failed };
}

/**
 * File-menu entry: export all loaded models (or prompt if several).
 */
export async function exportFragFromMenu(): Promise<void> {
  const ids = Array.from(ctx.fragments?.list?.keys?.() ?? []);
  if (!ids.length) {
    alert("No Fragments models are loaded.\nImport an IFC or open a .frag file first.");
    return;
  }
  if (ids.length === 1) {
    try {
      await downloadFragModel(ids[0]);
    } catch (e: any) {
      alert(`FRAG export failed: ${e?.message ?? e}`);
    }
    return;
  }
  // Multiple models: export all (one download each).
  const choice = confirm(
    `${ids.length} Fragments models are loaded.\n\nOK = save each as its own .frag file\nCancel = abort`,
  );
  if (!choice) return;
  try {
    const { ok, failed } = await downloadAllFragModels();
    if (failed.length) {
      alert(`Exported ${ok} file(s).\nFailed:\n${failed.slice(0, 8).join("\n")}`);
    }
  } catch (e: any) {
    alert(`FRAG export failed: ${e?.message ?? e}`);
  }
}
