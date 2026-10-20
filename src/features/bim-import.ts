/**
 * RVT / Navisworks import — client-side flow.
 *
 * Lets the user pick a .rvt, .nwd, or .nwc file from the browser,
 * uploads it to the server's /api/convert endpoint, polls for
 * conversion status, then loads the resulting IFC into the viewport.
 *
 * Requires the server to be running (npm run server) with APS credentials
 * configured (APS_CLIENT_ID, APS_CLIENT_SECRET).
 *
 * If APS credentials are not configured, the server saves the file
 * locally and instructs the user to export IFC from BIM manually.
 */

import { ctx } from "../core/context";
import { importFiles } from "./file-interop";

type Any = Record<string, any>;

/** Default server URL (can be overridden). */
let serverUrl = "http://localhost:4000";

/** Set the conversion server URL. */
export function setConvertServer(url: string): void {
  serverUrl = url.replace(/\/$/, "");
}

/** Get the conversion server URL. */
export function getConvertServer(): string {
  return serverUrl;
}

/** Supported file extensions for conversion. */
const CONVERTIBLE_EXTS = [".rvt", ".rfa", ".nwd", ".nwc", ".dwg"];

/**
 * Open a file picker for RVT/NWD/NWC/DWG files, upload to the server,
 * poll for conversion status, then load the resulting IFC.
 */
export async function pickAndConvertBIMFile(): Promise<void> {
  // 1. File picker
  const input = document.createElement("input");
  input.type = "file";
  input.accept = CONVERTIBLE_EXTS.join(",");
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    await convertAndLoadFile(file);
  };
  input.click();
}

/**
 * Convert a RVT/NWD/NWC/DWG file to IFC and load it into the viewport.
 *
 * Flow:
 *   1. Upload to server /api/convert
 *   2. Poll /api/convert/:urn/status every 3 seconds
 *   3. When status = "success", download IFC from /api/convert/:urn/download
 *   4. Load the IFC bytes into the viewport via the existing importFiles() flow
 */
export async function convertAndLoadFile(file: File): Promise<void> {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();

  if (!CONVERTIBLE_EXTS.includes(`.${ext}`)) {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: `Unsupported file type: .${ext}. Use .rvt, .nwd, .nwc, or .dwg.`, kind: "error" },
    }));
    return;
  }

  // Show progress toast
  const toastId = `convert-${Date.now()}`;
  showToast(toastId, "info", `Uploading "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB)...`);

  try {
    // 1. Upload to server
    const res = await fetch(`${serverUrl}/api/convert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-file-name": file.name,
      },
      body: file,
    });

    const data = await res.json();

    if (!data.ok) {
      throw new Error(data.error || "Upload failed");
    }

    // If server is in "manual" mode (no APS credentials), instruct the user
    if (data.mode === "manual") {
      showToast(toastId, "warn",
        `"${file.name}" saved to server. APS credentials not configured.\n` +
        `To enable auto-conversion: set APS_CLIENT_ID and APS_CLIENT_SECRET.\n` +
        `Manual path: In BIM → File → Export → IFC → import the .ifc here.`,
        8000
      );
      return;
    }

    // 2. Poll for conversion status
    const urn = data.urn;
    showToast(toastId, "info", `Converting "${file.name}" to IFC... This may take 1-5 minutes.`);

    const ifcBlob = await pollConversionStatus(urn, file.name, toastId);
    if (!ifcBlob) {
      throw new Error("Conversion failed or timed out");
    }

    // 3. Load the IFC into the viewport
    showToast(toastId, "success", `Conversion complete! Loading IFC into viewport...`);
    const ifcFile = new File([ifcBlob], file.name.replace(/\.[^.]+$/, ".ifc"), {
      type: "application/ifc",
    });

    // Use the existing import pipeline
    await importFiles([ifcFile]);

    showToast(toastId, "success", `"${file.name}" loaded successfully as IFC!`, 5000);

  } catch (e: any) {
    console.error("[convert] failed:", e);
    showToast(toastId, "error", `Conversion failed: ${e.message || e}`, 8000);
  }
}

/**
 * Poll the server for conversion status until complete or failed.
 * Returns the IFC Blob on success, null on failure.
 */
async function pollConversionStatus(
  urn: string,
  fileName: string,
  toastId: string,
): Promise<Blob | null> {
  const maxAttempts = 120; // 120 × 5s = 10 minutes max
  const intervalMs = 5000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    try {
      const res = await fetch(`${serverUrl}/api/convert/${encodeURIComponent(urn)}/status`);
      const data = await res.json();

      if (data.status === "success") {
        // Download the IFC
        const dlRes = await fetch(`${serverUrl}/api/convert/${encodeURIComponent(urn)}/download`);
        return await dlRes.blob();
      }

      if (data.status === "failed") {
        showToast(toastId, "error", `Conversion failed: ${data.message || "unknown error"}`, 8000);
        return null;
      }

      // Still in progress — update toast
      const progress = data.progress || `${Math.round((attempt / maxAttempts) * 100)}%`;
      showToast(toastId, "info", `Converting "${fileName}": ${progress} (${attempt * 5}s elapsed)`);

    } catch (e) {
      console.warn("[convert] poll error:", e);
    }
  }

  showToast(toastId, "error", `Conversion timed out after 10 minutes.`, 8000);
  return null;
}

/** Show/update a toast notification by ID. */
function showToast(id: string, kind: string, message: string, timeout?: number): void {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { kind, message, timeout, id },
    }));
  } catch { /* */ }
}

/**
 * Register the "Import BIM/Navisworks File" command.
 */
export function setupBIMImport(): void {
  // Expose global for console + command palette
  (window as any).__obsBIMImport = {
    pickAndConvert: pickAndConvertBIMFile,
    convertFile: convertAndLoadFile,
    setServer: setConvertServer,
    getServer: getConvertServer,
  };

  // Register command
  try {
    const w = window as any;
    if (w.__obsPlugins) {
      w.__obsPlugins.set("command:bim:import", {
        id: "bim.import",
        label: "Import BIM / Navisworks File…",
        hint: "Convert .rvt/.nwd/.nwc to IFC and load into viewport",
        run: () => { pickAndConvertBIMFile(); },
      });
    }
  } catch { /* */ }

  console.log("[bim-import] ready. Use command palette → 'Import BIM / Navisworks File' or __obsBIMImport.pickAndConvert().");
}
