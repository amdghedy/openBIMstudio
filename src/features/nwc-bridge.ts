/**
 * Navisworks local-bridge client.
 *
 * `.nwc`/`.nwd`/`.nwf` are closed binary formats that cannot be decoded in
 * the browser, and Navisworks has no built-in IFC export (Autodesk support
 * confirms it). The smooth local path is therefore:
 *
 *   browser → openBIM NWC Bridge (127.0.0.1:8424, see tools/navisworks-bridge)
 *           → Navisworks + the free MIT BIMCamel exporter plug-in
 *           → IFC back → existing IFC import pipeline (web-ifc → Fragments)
 *
 * This module probes the bridge, uploads the source file, shows a live
 * status dialog (with the export folder, copy + open-folder helpers),
 * collects the produced IFC files and feeds them to importFiles().
 *
 * If the bridge is not running, showNwcConvertWizard() guides the user
 * through the one-time setup (or a manual BIMCamel export / cloud APS route).
 */
import { importFiles } from "./file-interop";
import { uiAlert } from "../core/notify";

type Any = Record<string, any>;

/** Extensions the local bridge can handle. */
export const NWC_LOCAL_EXTS = ["nwc", "nwd", "nwf"] as const;

const BRIDGE_PORT_DEFAULT = 8424;
let bridgeBase = `http://127.0.0.1:${BRIDGE_PORT_DEFAULT}/openbim-bridge`;

/** Override the bridge base URL (unit tests / advanced setups). */
export function setBridgeBase(base: string): void {
  bridgeBase = String(base || "").replace(/\/+$/, "");
}

export function getBridgeBase(): string {
  return bridgeBase;
}

/** Lower-cased extension of a file name (without the dot). */
export function extOf(fileName: string): string {
  return String(fileName || "").split(".").pop()?.toLowerCase() ?? "";
}

/** True when this file should take the local-bridge route. */
export function isNwcLocalFile(fileName: string): boolean {
  return (NWC_LOCAL_EXTS as readonly string[]).includes(extOf(fileName));
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** fetch() with an abort timeout; returns null on network failure/timeout. */
async function fetchWithTimeout(url: string, init: Any | undefined, timeoutMs: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(init || {}), signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Health payload validation (pure, unit-tested)                      */
/* ------------------------------------------------------------------ */

/**
 * Validate a bridge /health payload. Returns the typed object or null.
 * Deliberately strict about the service marker so random loopback services
 * can't impersonate the bridge.
 */
export function validateHealth(json: Any | null | undefined): NwcBridgeHealth | null {
  if (!json || typeof json !== "object") return null;
  if (json.ok !== true) return null;
  if (typeof json.service !== "string" || !json.service.startsWith("openbim-nwc-bridge")) return null;
  if (typeof json.ready !== "boolean") return null;
  const modes = Array.isArray(json.modes) ? json.modes.filter((m: unknown) => typeof m === "string") : [];
  return {
    ok: true,
    service: json.service,
    version: typeof json.version === "string" ? json.version : "0",
    platform: typeof json.platform === "string" ? json.platform : "",
    ready: json.ready,
    modes,
    navisworks: Array.isArray(json.navisworks) ? json.navisworks : [],
    exporter: json.exporter && typeof json.exporter === "object" ? json.exporter : {},
    workspace: typeof json.workspace === "string" ? json.workspace : "",
    maxBodyBytes: typeof json.maxBodyBytes === "number" ? json.maxBodyBytes : 0,
  };
}

export interface NwcBridgeHealth {
  ok: true;
  service: string;
  version: string;
  platform: string;
  ready: boolean;
  modes: string[];
  navisworks: Any[];
  exporter: Any;
  workspace: string;
  maxBodyBytes: number;
}

/** Probe the bridge; resolves null when absent/unreachable/invalid. */
export async function probeNwcBridge(timeoutMs = 1800): Promise<NwcBridgeHealth | null> {
  const res = await fetchWithTimeout(`${bridgeBase}/health`, { method: "GET" }, timeoutMs);
  if (!res || !res.ok) return null;
  try {
    return validateHealth(await res.json());
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Job status → UI text (pure, unit-tested)                           */
/* ------------------------------------------------------------------ */

/** Map a bridge job state to a short user-facing status line. */
export function describeStateForUi(state: string, message?: string): string {
  switch (state) {
    case "converting":
      return message || "Converting headlessly with Navisworks…";
    case "waiting-for-export":
      return message || "Waiting for the IFC export in Navisworks…";
    case "done":
      return message || "Conversion finished — loading IFC…";
    case "error":
      return message || "Conversion failed.";
    case "expired":
      return message || "The conversion job expired before an IFC was produced.";
    default:
      return message || "Working…";
  }
}

/** Max time to wait for a job before giving up (guided exports can be slow). */
export const MAX_JOB_WAIT_MS = 30 * 60 * 1000;
/** Poll cadence for job status. */
export const POLL_MS = 2000;

/* ------------------------------------------------------------------ */
/* Conversion flow                                                    */
/* ------------------------------------------------------------------ */

function toast(kind: string, message: string, timeout?: number): void {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { kind, message, timeout } }));
  } catch { /* headless/test */ }
}

interface JobStartResponse {
  ok: boolean;
  jobId?: string;
  mode?: string;
  exportDir?: string;
  message?: string;
  error?: string;
}

/** Start a bridge job for a File; returns the job descriptor or null. */
async function startBridgeJob(file: File): Promise<JobStartResponse | null> {
  try {
    const res = await fetchWithTimeout(
      `${bridgeBase}/jobs`,
      {
        method: "POST",
        headers: { "x-file-name": file.name, "Content-Type": "application/octet-stream" },
        body: file,
      },
      5 * 60 * 1000, // big files need real upload time
    );
    if (!res) return null;
    return (await res.json()) as JobStartResponse;
  } catch {
    return null;
  }
}

/** Fetch all produced IFC outputs of a finished job. */
async function fetchJobIfcFiles(jobId: string, files: { name: string; url: string }[]): Promise<File[]> {
  const out: File[] = [];
  for (const f of files) {
    const res = await fetch(`${bridgeBase}${f.url}`);
    if (!res.ok) throw new Error(`could not download ${f.name} from the bridge`);
    const blob = await res.blob();
    out.push(new File([blob], f.name, { type: "application/octet-stream" }));
  }
  return out;
}

/**
 * Full bridge conversion for one NWC/NWD/NWF File:
 * start job → live status dialog (guided mode) → collect IFC → importFiles().
 * Returns true when the file was handled (converted, or failed after having
 * started); false when the bridge was not available at all.
 */
export async function tryNwcLocalBridge(
  file: File,
  onCloudFallback?: (file: File) => Promise<void>,
): Promise<boolean> {
  const health = await probeNwcBridge();

  // No usable bridge → setup wizard (manual pick / cloud route / retry).
  if (!health || !health.ready) {
    return await showNwcConvertWizard(file, health, onCloudFallback);
  }

  const modal = openBridgeStatusModal(file.name);
  try {
    const start = await startBridgeJob(file);
    if (!start || !start.ok || !start.jobId) {
      modal.status(describeStateForUi("error"), start?.error || "the bridge could not start the conversion job");
      toast("error", `Navisworks bridge: ${start?.error || "could not start conversion job"}`, 8000);
      return true; // handled (failed visibly); don't cascade into other flows
    }

    const guided = start.mode === "guided";
    modal.begin(start.mode || "guided", start.exportDir || "");

    const startedAt = Date.now();
    while (Date.now() - startedAt < MAX_JOB_WAIT_MS) {
      await sleep(POLL_MS);
      const res = await fetchWithTimeout(`${bridgeBase}/jobs/${start.jobId}`, { method: "GET" }, 4000);
      const job = res && res.ok ? await res.json() : null;
      if (!job || !job.ok) {
        modal.status(describeStateForUi("error"), "lost contact with the bridge");
        toast("error", "Navisworks bridge: lost contact while converting.", 8000);
        return true;
      }
      if (job.state === "error" || job.state === "expired") {
        modal.status(describeStateForUi(job.state), job.message || "");
        toast("error", `Navisworks bridge: ${job.message || "conversion failed"}`, 8000);
        return true;
      }
      if (job.state === "done") {
        modal.status(describeStateForUi("done"), "");
        const ifcFiles = await fetchJobIfcFiles(start.jobId, job.ifcFiles || []);
        modal.close();
        toast("success", `"${file.name}" converted with your local Navisworks — loading ${ifcFiles.length} IFC…`, 6000);
        await importFiles(ifcFiles);
        return true;
      }
      if (guided) {
        modal.status(describeStateForUi("waiting-for-export"), job.message || "");
      } else {
        modal.status(describeStateForUi("converting"), job.message || "");
      }
    }
    modal.status(describeStateForUi("expired"), "gave up waiting after 30 minutes");
    toast("error", "Navisworks bridge: conversion timed out after 30 minutes.", 8000);
    return true;
  } catch (e: any) {
    modal.status(describeStateForUi("error"), e?.message || String(e));
    toast("error", `Navisworks bridge: ${e?.message || e}`, 8000);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Status dialog (same visual language as the Trimble assistant)       */
/* ------------------------------------------------------------------ */

interface BridgeStatusModal {
  begin(mode: string, exportDir: string): void;
  status(main: string, detail: string): void;
  close(): void;
}

function openBridgeStatusModal(fileName: string): BridgeStatusModal {
  ensureSpinnerStyles();
  const overlay = document.createElement("div");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Navisworks conversion status");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:100000;background:rgba(8,12,20,.72);" +
    "display:flex;align-items:center;justify-content:center;padding:20px;font:13px/1.5 system-ui,sans-serif;color:#e8edf5;";

  const panel = document.createElement("section");
  panel.style.cssText =
    "width:min(620px,94vw);background:#151b26;border:1px solid #354154;border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.5);";
  overlay.appendChild(panel);

  const header = document.createElement("header");
  header.style.cssText = "padding:16px 20px;border-bottom:1px solid #2b3545;display:flex;justify-content:space-between;gap:16px;align-items:center;";
  header.innerHTML =
    `<div><div style="font-size:16px;font-weight:700">Converting with your local Navisworks</div>` +
    `<div style="color:#9aa9bd;margin-top:3px">${escapeHtml(fileName)}</div></div>`;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "✕";
  close.title = "Close";
  close.style.cssText = "border:0;background:transparent;color:#aebbd0;font-size:20px;cursor:pointer;padding:4px 8px;";
  header.appendChild(close);
  panel.appendChild(header);

  const body = document.createElement("div");
  body.style.cssText = "padding:18px 20px;display:grid;gap:12px;";
  panel.appendChild(body);

  const spinnerLine = document.createElement("div");
  spinnerLine.style.cssText = "display:flex;align-items:center;gap:10px;font-weight:600;";
  spinnerLine.innerHTML =
    `<span aria-hidden="true" style="width:16px;height:16px;border:2px solid #38bdf8;border-top-color:transparent;` +
    `border-radius:50%;display:inline-block;animation:obs-spin 0.9s linear infinite;"></span>` +
    `<span data-role="main">Starting…</span>`;
  body.appendChild(spinnerLine);

  const detail = document.createElement("div");
  detail.style.cssText = "color:#9aa9bd;min-height:18px;white-space:pre-wrap;";
  body.appendChild(detail);

  const folderBox = document.createElement("div");
  folderBox.style.cssText = "display:none;grid-gap:8px;gap:8px;padding:11px 12px;border:1px solid #3a4659;border-radius:8px;background:#101722;";
  const folderLabel = document.createElement("div");
  folderLabel.style.cssText = "font-weight:700;margin-bottom:6px;";
  folderLabel.textContent = "Export folder — save the IFC here in Navisworks";
  const folderPath = document.createElement("code");
  folderPath.style.cssText = "display:block;color:#7dd3fc;overflow-wrap:anywhere;margin-bottom:8px;";
  const folderButtons = document.createElement("div");
  folderButtons.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
  const copyBtn = mkSmallButton("Copy folder path");
  const openBtn = mkSmallButton("Open folder in Explorer");
  folderButtons.append(copyBtn, openBtn);
  folderBox.append(folderLabel, folderPath, folderButtons);
  body.appendChild(folderBox);

  const steps = document.createElement("div");
  steps.style.cssText = "display:none;color:#c6d2e2;padding:11px 12px;border-left:3px solid #38bdf8;background:#101d2c;border-radius:4px;";
  steps.innerHTML =
    `<strong style="display:block;margin-bottom:6px">In the Navisworks window that just opened:</strong>` +
    `BIMCamel tab ▸ <strong>IFC exporter</strong> ▸ Export ▸ save into the folder above.`;
  body.appendChild(steps);

  const footer = document.createElement("footer");
  footer.style.cssText = "padding:14px 20px;border-top:1px solid #2b3545;display:flex;justify-content:flex-end;gap:8px;";
  const hideBtn = mkSmallButton("Hide (keep converting)");
  footer.appendChild(hideBtn);
  panel.appendChild(footer);

  let jobId = "";
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(folderPath.textContent || "");
      copyBtn.textContent = "Copied ✓";
      setTimeout(() => { copyBtn.textContent = "Copy folder path"; }, 1600);
    } catch { /* clipboard blocked */ }
  };
  openBtn.onclick = async () => {
    if (!jobId) return;
    try { await fetch(`${bridgeBase}/jobs/${jobId}/reveal`, { method: "POST" }); } catch { /* */ }
  };

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    overlay.remove();
  };
  close.onclick = finish;
  hideBtn.onclick = finish;

  document.body.appendChild(overlay);

  return {
    begin(mode, exportDir) {
      if (mode === "guided") {
        folderBox.style.display = "grid";
        steps.style.display = "block";
        folderPath.textContent = exportDir;
        jobId = extractJobId(exportDir) || "";
      }
    },
    status(main, sub) {
      const mainEl = spinnerLine.querySelector("[data-role=main]");
      if (mainEl) mainEl.textContent = main;
      detail.textContent = sub || "";
      if (/error|failed|expired/i.test(main)) {
        (spinnerLine.firstElementChild as HTMLElement | null)?.style.setProperty("display", "none");
      }
    },
    close: finish,
  };
}

function mkSmallButton(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText =
    "padding:7px 11px;border:1px solid #53647d;border-radius:6px;background:#202c3c;color:#e8edf5;cursor:pointer;font-size:12px;";
  return b;
}

/** Best-effort job id from the exportDir tail (…/jobs/<id>/export). */
export function extractJobId(exportDir: string): string {
  const m = /jobs[\\/]([A-Za-z0-9]+)[\\/]export[\\/]?$/.exec(String(exportDir || ""));
  return m ? m[1] : "";
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/** Inject the spinner keyframes once (app-loader only injects them after first use). */
let spinnerStylesInjected = false;
function ensureSpinnerStyles(): void {
  if (spinnerStylesInjected) return;
  spinnerStylesInjected = true;
  try {
    if (!document.querySelector("style[data-obs-nwc-bridge-spin]")) {
      const style = document.createElement("style");
      style.setAttribute("data-obs-nwc-bridge-spin", "");
      style.textContent = "@keyframes obs-spin { to { transform: rotate(360deg); } }";
      document.head.appendChild(style);
    }
  } catch { /* non-DOM */ }
}

/* ------------------------------------------------------------------ */
/* Setup wizard (no bridge / exporter found)                          */
/* ------------------------------------------------------------------ */

/**
 * Wizard shown when the bridge is absent or cannot convert. Returns true if
 * the user completed an import path (manual pick or cloud), false on cancel.
 */
export function showNwcConvertWizard(
  file: File,
  health: NwcBridgeHealth | null,
  onCloudFallback?: (file: File) => Promise<void>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Navisworks local conversion setup");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:100000;background:rgba(8,12,20,.72);" +
      "display:flex;align-items:center;justify-content:center;padding:20px;font:13px/1.5 system-ui,sans-serif;color:#e8edf5;";

    const panel = document.createElement("section");
    panel.style.cssText =
      "width:min(720px,96vw);max-height:88vh;overflow:auto;background:#151b26;" +
      "border:1px solid #354154;border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.5);";
    overlay.appendChild(panel);

    const header = document.createElement("header");
    header.style.cssText = "padding:18px 20px;border-bottom:1px solid #2b3545;display:flex;justify-content:space-between;gap:16px;align-items:center;";
    header.innerHTML =
      `<div><div style="font-size:17px;font-weight:700">Convert "${escapeHtml(file.name)}" with your local Navisworks</div>` +
      `<div style="color:#9aa9bd;margin-top:3px">Navisworks cannot export IFC by itself — the free BIMCamel plug-in performs the conversion</div></div>`;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕";
    close.title = "Close";
    close.style.cssText = "border:0;background:transparent;color:#aebbd0;font-size:20px;cursor:pointer;padding:4px 8px;";
    header.appendChild(close);
    panel.appendChild(header);

    const body = document.createElement("div");
    body.style.cssText = "padding:18px 20px;display:grid;gap:14px;";
    panel.appendChild(body);

    // Diagnosis banner
    const banner = document.createElement("div");
    banner.style.cssText = "padding:11px 12px;border-left:3px solid #e0a33a;background:#2a2418;color:#f4dfb5;border-radius:4px;";
    if (!health) {
      banner.textContent =
        "The openBIM NWC bridge is not running on this PC (127.0.0.1:8424 did not answer). Start it once — Route A below.";
    } else if (!health.navisworks?.length) {
      banner.textContent =
        "The bridge is running but no Navisworks Manage/Simulate installation was detected. Navisworks Freedom cannot host exporter plug-ins.";
    } else {
      banner.textContent =
        "The bridge is running and Navisworks was detected, but the BIMCamel IFC exporter plug-in is not installed yet (Route A, step 2).";
    }
    body.appendChild(banner);

    // Route tabs
    const tabs = document.createElement("div");
    tabs.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
    const instructions = document.createElement("div");
    instructions.style.cssText = "padding:14px;border:1px solid #354154;border-radius:8px;background:#101722;min-height:190px;";
    body.append(tabs, instructions);

    const bridgeSteps = [
      "Start the bridge once: open the openBIMstudio folder → tools → navisworks-bridge → double-click start-bridge.cmd (needs Node.js). Keep the window open.",
      "Install the free BIMCamel IFC exporter (MIT, Navisworks Manage/Simulate 2024–2027): github.com/mrshoma99-rgb/bimcamel-ifc-exporter → Releases → BIMCamelSetup.exe.",
      "Press “Re-check and convert automatically” below — the file you already picked will be sent to Navisworks and the IFC will come back automatically.",
    ];
    const manualSteps = [
      "Open your .nwc / .nwd / .nwf in Navisworks Manage or Simulate (2024–2027).",
      "Install the free BIMCamel IFC exporter plug-in (see Route A, step 2) if you have not yet.",
      "BIMCamel tab ▸ IFC exporter ▸ Export ▸ save an IFC 4 file anywhere on this PC.",
      "Return here and select the exported .ifc — it federates like every other IFC link.",
    ];

    const renderRoute = (route: "bridge" | "manual") => {
      for (const child of Array.from(tabs.children) as HTMLButtonElement[]) {
        const active = child.dataset.route === route;
        child.style.background = active ? "#24517a" : "#202c3c";
        child.style.borderColor = active ? "#4e9bd5" : "#53647d";
      }
      instructions.innerHTML = "";
      const title = document.createElement("div");
      title.style.cssText = "font-weight:700;font-size:14px;margin-bottom:8px;";
      title.textContent = route === "bridge" ? "Route A — automatic via the local bridge (recommended)" : "Route B — manual export, then pick the IFC";
      const list = document.createElement("ol");
      list.style.cssText = "margin:0;padding-left:20px;color:#c6d2e2;display:grid;gap:7px;";
      for (const step of route === "bridge" ? bridgeSteps : manualSteps) {
        const li = document.createElement("li");
        li.textContent = step;
        list.appendChild(li);
      }
      instructions.append(title, list);
    };
    const mkTab = (label: string, key: "bridge" | "manual") => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.dataset.route = key;
      button.style.cssText = "padding:8px 13px;border:1px solid #53647d;border-radius:7px;background:#202c3c;color:#e8edf5;cursor:pointer;font-weight:600;";
      button.onclick = () => renderRoute(key);
      tabs.appendChild(button);
    };
    mkTab("Route A — local bridge", "bridge");
    mkTab("Route B — manual export", "manual");
    renderRoute("bridge");

    const note = document.createElement("div");
    note.style.cssText = "font-size:12px;color:#9aa9bd;";
    note.textContent =
      "Files stay on your PC: the bridge only talks to 127.0.0.1 and your local Navisworks. BIMCamel is MIT-licensed open source and not affiliated with Autodesk.";
    body.appendChild(note);

    const footer = document.createElement("footer");
    footer.style.cssText = "padding:14px 20px;border-top:1px solid #2b3545;display:flex;justify-content:space-between;gap:8px;align-items:center;";
    const cloudBtn = document.createElement("button");
    cloudBtn.type = "button";
    cloudBtn.textContent = "Use cloud conversion (APS)…";
    cloudBtn.title = "Upload to Autodesk Platform Services instead (requires the local collaboration server with APS credentials)";
    cloudBtn.style.cssText = "padding:9px 12px;border:1px solid #53647d;border-radius:7px;background:#202c3c;color:#e8edf5;cursor:pointer;";
    const right = document.createElement("div");
    right.style.cssText = "display:flex;gap:8px;";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.style.cssText = "padding:9px 14px;border:1px solid #53647d;border-radius:7px;background:#202c3c;color:#e8edf5;cursor:pointer;";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Re-check and convert automatically";
    retry.style.cssText = "padding:9px 14px;border:1px solid #367eb5;border-radius:7px;background:#24517a;color:white;cursor:pointer;font-weight:700;";
    right.append(cancel, retry);
    footer.append(cloudBtn, right);
    panel.appendChild(footer);

    let settled = false;
    const finish = (handled: boolean) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(handled);
    };
    close.onclick = () => finish(false);
    cancel.onclick = () => finish(false);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(false); });

    retry.onclick = async () => {
      retry.disabled = true;
      retry.textContent = "Checking…";
      const h = await probeNwcBridge();
      if (h && h.ready) {
        overlay.remove();
        settled = true; // wizard hands over to the live conversion flow
        resolve(true);
        await tryNwcLocalBridge(file, onCloudFallback);
        return;
      }
      retry.disabled = false;
      retry.textContent = "Re-check and convert automatically";
      banner.textContent = !h
        ? "Still no answer from 127.0.0.1:8424 — is the bridge window open? (Route A, step 1)"
        : "The bridge answers but cannot convert yet — check the diagnosis banner above.";
    };

    cloudBtn.onclick = async () => {
      if (!onCloudFallback) {
        uiAlert("Cloud (APS) conversion is not available in this session.");
        return;
      }
      overlay.remove();
      settled = true;
      resolve(true);
      await onCloudFallback(file);
    };

    // Route B: manual pick of the exported IFC
    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.textContent = "Select converted IFC…";
    pickBtn.style.cssText =
      "margin-top:12px;padding:9px 14px;border:1px solid #367eb5;border-radius:7px;background:#1b3a5c;color:white;cursor:pointer;font-weight:700;";
    pickBtn.onclick = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".ifc,.ifczip";
      input.onchange = async () => {
        const picked = input.files?.[0];
        if (!picked) return;
        pickBtn.disabled = true;
        pickBtn.textContent = "Importing…";
        try {
          await importFiles([picked]);
          finish(true);
        } catch (error) {
          console.error("[nwc-bridge] manual IFC import failed", error);
          pickBtn.disabled = false;
          pickBtn.textContent = "Select converted IFC…";
          const message = error instanceof Error ? error.message : String(error);
          uiAlert("The exported IFC could not be imported: " + message);
        }
      };
      input.click();
    };

    document.body.appendChild(overlay);
  });
}
