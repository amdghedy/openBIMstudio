/**
 * IFC → FRAG converter (download only, no scene load).
 *
 * Workflow for large models:
 *   1. Convert IFC / IFCZIP → .frag (this tool)
 *   2. Insert → Link FRAG
 *
 * Conversion still runs in the browser via web-ifc; files above the
 * browser-safe limit need "Allow unsafe large IFC" and may OOM.
 */
import { ctx } from "../core/context";
import { uiAlert } from "../core/notify";
import {
  convertIfcToFragBytes,
  expandIfcSources,
} from "./importer";
import { loadFragFiles } from "./importer";
import { openToolWindow } from "./tool-windows";
import { confirmDialog } from "./form-modal";

type Job = {
  id: number;
  sourceName: string;
  file: File;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  phase: string;
  error?: string;
  frag?: Uint8Array;
  fragName?: string;
};

let panel: HTMLDivElement | null = null;
let jobs: Job[] = [];
let jobUid = 0;
let running = false;
let cancelFlag = false;

function toast(msg: string, kind: "info" | "warn" | "success" = "info") {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: msg, kind } }));
  } catch {
    console.log("[ifc→frag]", msg);
  }
}

/** Session-only: user accepted risk for large IFC→FRAG conversions. */
let allowLargeThisSession = false;

async function confirmLargeConvert(sizeMB: number, name: string): Promise<boolean> {
  if (allowLargeThisSession) return true;
  const ok = await confirmDialog(
    "Large IFC conversion",
    `“${name}” is ${sizeMB.toFixed(0)} MB.\n\n` +
    `In-browser web-ifc conversion of multi-hundred-MB IFCs usually runs out of memory and can crash this tab.\n\n` +
    `Recommended: convert offline to .frag, then Insert → Link FRAG.\n\n` +
    `Continue anyway in this browser?`,
  );
  if (ok) allowLargeThisSession = true;
  return ok;
}

function downloadBytes(bytes: Uint8Array, name: string) {
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}

function ensurePanel(): HTMLDivElement {
  if (panel) return panel;
  const root = document.createElement("div");
  root.id = "obs-ifc-to-frag";
  root.style.cssText =
    "position:fixed;top:88px;right:18px;width:min(420px,calc(100vw - 28px));max-height:min(72vh,560px);" +
    "z-index:260;display:none;flex-direction:column;background:#1b1c26;border:1px solid #34353f;" +
    "border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.55);color:#e2e8f0;font:12.5px system-ui;overflow:hidden";

  const head = document.createElement("div");
  head.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2a2e3a;" +
    "background:linear-gradient(180deg,#242632,#1b1c26);cursor:move;user-select:none";
  head.innerHTML =
    `<b style="flex:1">IFC → FRAG</b>` +
    `<span style="opacity:.55;font-size:11px">convert · download · link</span>`;
  const close = document.createElement("button");
  close.textContent = "✕";
  close.style.cssText =
    "padding:4px 8px;border-radius:6px;border:1px solid #3a3f4d;background:#2a2e3a;color:#e8eaf0;cursor:pointer";
  close.onclick = () => hideIfcToFragPanel();
  head.appendChild(close);
  root.appendChild(head);

  // drag
  let drag: { x: number; y: number; l: number; t: number } | null = null;
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    drag = { x: e.clientX, y: e.clientY, l: root.offsetLeft, t: root.offsetTop };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    root.style.left = `${drag.l + e.clientX - drag.x}px`;
    root.style.top = `${drag.t + e.clientY - drag.y}px`;
    root.style.right = "auto";
  });
  head.addEventListener("pointerup", () => {
    drag = null;
  });

  const body = document.createElement("div");
  body.style.cssText = "padding:12px;display:flex;flex-direction:column;gap:10px;overflow:auto;flex:1";
  body.innerHTML =
    `<div style="color:#94a3b8;line-height:1.45;font-size:12px">
      Convert <b style="color:#e2e8f0">IFC / IFCZIP</b> to ThatOpen <b style="color:#38bdf8">.frag</b> without loading the 3D scene.
      Then use <b style="color:#e2e8f0">Insert → Link FRAG</b> — much lighter for big models.
    </div>`;

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";

  const btnCss =
    "padding:7px 12px;border-radius:6px;border:1px solid #3a3f4d;background:#2a2e3a;color:#e8eaf0;" +
    "cursor:pointer;font:600 12px system-ui";
  const primary =
    "padding:7px 12px;border-radius:6px;border:1px solid #0284c7;background:#0369a1;color:#fff;" +
    "cursor:pointer;font:600 12px system-ui";

  const pickBtn = document.createElement("button");
  pickBtn.textContent = "Choose IFC / IFCZIP…";
  pickBtn.style.cssText = primary;
  pickBtn.onclick = () => pickAndQueue();

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = btnCss;
  cancelBtn.onclick = () => {
    cancelFlag = true;
    try {
      (ctx.features as any)?.importer?.cancelActiveConversion?.();
    } catch {
      /* */
    }
    toast("Cancel requested…", "warn");
  };

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "Clear list";
  clearBtn.style.cssText = btnCss;
  clearBtn.onclick = () => {
    if (running) {
      toast("Wait for conversion to finish or cancel first", "warn");
      return;
    }
    jobs = [];
    renderList();
  };

  actions.append(pickBtn, cancelBtn, clearBtn);
  body.appendChild(actions);

  const list = document.createElement("div");
  list.id = "obs-ifc-to-frag-list";
  list.style.cssText = "display:flex;flex-direction:column;gap:6px;min-height:80px";
  body.appendChild(list);

  const tip = document.createElement("div");
  tip.style.cssText = "font-size:11px;color:#64748b;line-height:1.4";
  tip.innerHTML =
    `Typical <b>~80 MB IFCZIP</b> files are allowed. You are asked to confirm only above <b>~350 MB</b> extracted IFC. ` +
    `A <b>698 MB</b> IFC still needs offline convert + <b>Link FRAG</b>.`;
  body.appendChild(tip);

  root.appendChild(body);
  document.body.appendChild(root);
  panel = root;
  return root;
}

function renderList() {
  const list = document.getElementById("obs-ifc-to-frag-list");
  if (!list) return;
  list.innerHTML = "";
  if (!jobs.length) {
    list.innerHTML =
      `<div style="color:#64748b;padding:12px 4px;text-align:center">No files yet — choose IFC / IFCZIP to convert.</div>`;
    return;
  }
  for (const j of jobs) {
    const row = document.createElement("div");
    row.style.cssText =
      "border:1px solid #2a2e3a;border-radius:8px;padding:8px 10px;background:#12141c";
    const col =
      j.status === "done"
        ? "#22c55e"
        : j.status === "failed"
          ? "#ef4444"
          : j.status === "running"
            ? "#38bdf8"
            : "#94a3b8";
    const bar = Math.max(0, Math.min(100, j.progress));
    row.innerHTML =
      `<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px">` +
      `<span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${j.sourceName}">${j.sourceName}</span>` +
      `<span style="color:${col};font:700 10px system-ui;letter-spacing:.3px">${j.status.toUpperCase()}</span>` +
      `</div>` +
      `<div style="height:4px;background:#1e2230;border-radius:2px;overflow:hidden;margin-bottom:4px">` +
      `<div style="height:100%;width:${bar}%;background:${col};transition:width .2s"></div></div>` +
      `<div style="font-size:11px;color:#94a3b8">${j.phase}${j.error ? ` · <span style="color:#f87171">${j.error}</span>` : ""}</div>`;

    if (j.status === "done" && j.frag && j.fragName) {
      const acts = document.createElement("div");
      acts.style.cssText = "display:flex;gap:6px;margin-top:8px;flex-wrap:wrap";
      const dl = document.createElement("button");
      dl.textContent = "Download .frag";
      dl.style.cssText =
        "padding:5px 10px;border-radius:6px;border:1px solid #0284c7;background:#0369a1;color:#fff;cursor:pointer;font:600 11px system-ui";
      dl.onclick = () => downloadBytes(j.frag!, j.fragName!);
      const link = document.createElement("button");
      link.textContent = "Link FRAG now";
      link.style.cssText =
        "padding:5px 10px;border-radius:6px;border:1px solid #3a3f4d;background:#2a2e3a;color:#e8eaf0;cursor:pointer;font:600 11px system-ui";
      link.onclick = async () => {
        const blob = new Blob([j.frag! as BlobPart], { type: "application/octet-stream" });
        const f = new File([blob], j.fragName!, { type: "application/octet-stream" });
        await loadFragFiles([f]);
        toast(`Linked ${j.fragName}`, "success");
      };
      acts.append(dl, link);
      row.appendChild(acts);
    }
    list.appendChild(row);
  }
}

async function pickAndQueue() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".ifc,.ifczip,.zip";
  input.multiple = true;
  input.onchange = async () => {
    const files = Array.from(input.files ?? []);
    if (!files.length) return;
    await queueFiles(files);
  };
  input.click();
}

export async function queueFiles(files: File[]) {
  showIfcToFragPanel();
  try {
    openToolWindow("import");
  } catch {
    /* */
  }
  const loader = (ctx.features as any).appLoader;
  try {
    loader?.begin?.("Preparing IFC for FRAG conversion…", { cancellable: false });
    const expanded = await expandIfcSources(files, (msg) => {
      try {
        loader?.set?.(msg, 0.1);
      } catch {
        /* */
      }
    });
    if (!expanded.length) {
      uiAlert("No IFC models found in the selection / archive.");
      return;
    }
    for (const f of expanded) {
      jobs.push({
        id: ++jobUid,
        sourceName: f.name,
        file: f,
        status: "queued",
        progress: 0,
        phase: `queued · ${(f.size / (1024 * 1024)).toFixed(0)} MB`,
      });
    }
    renderList();
    void processJobs();
  } catch (err: any) {
    uiAlert(err?.message || String(err));
  } finally {
    try {
      loader?.finish?.();
    } catch {
      /* */
    }
  }
}

async function processJobs() {
  if (running) return;
  running = true;
  cancelFlag = false;
  const loader = (ctx.features as any).appLoader;
  try {
    for (const j of jobs) {
      if (j.status !== "queued") continue;
      if (cancelFlag) {
        j.status = "cancelled";
        j.phase = "cancelled";
        renderList();
        continue;
      }
      j.status = "running";
      j.phase = "starting…";
      j.progress = 1;
      renderList();
      loader?.begin?.(`IFC → FRAG · ${j.sourceName}`, {
        cancellable: true,
        onCancel: () => {
          cancelFlag = true;
        },
      });
      try {
        const sizeMB = j.file.size / (1024 * 1024);
        // Confirm only for very large extracted IFCs (normal ~80 MB IFCZIP is fine).
        const LARGE_MB = 350;
        if (sizeMB > LARGE_MB && !(await confirmLargeConvert(sizeMB, j.sourceName))) {
          j.status = "cancelled";
          j.phase = "skipped — user declined large-file risk";
          renderList();
          continue;
        }
        j.phase = sizeMB > LARGE_MB
          ? `⚠️ converting large IFC (${sizeMB.toFixed(0)} MB) — do not close this tab`
          : "starting…";
        renderList();

        const result = await convertIfcToFragBytes(j.file, {
          force: sizeMB > LARGE_MB || allowLargeThisSession,
          onProgress: (pct, phase) => {
            j.progress = pct;
            j.phase = phase;
            renderList();
            loader?.set?.(`${phase} · ${pct}%`, pct / 100);
          },
        });
        j.frag = result.frag;
        j.fragName = result.fileName;
        j.status = "done";
        j.progress = 100;
        j.phase = `done · ${(result.frag.byteLength / (1024 * 1024)).toFixed(1)} MB FRAG · ${result.schema}`;
        // Auto-download so the user always gets the file even if they close the panel
        downloadBytes(result.frag, result.fileName);
        toast(`Saved ${result.fileName}`, "success");
      } catch (err: any) {
        j.status = "failed";
        j.error = err?.message || String(err);
        j.phase = "failed";
        console.error("[ifc→frag]", err);
        toast(j.error ?? "Conversion failed", "warn");
      }
      renderList();
      try {
        loader?.finish?.();
      } catch {
        /* */
      }
    }
  } finally {
    running = false;
    cancelFlag = false;
  }
}

export function showIfcToFragPanel(): void {
  const p = ensurePanel();
  p.style.display = "flex";
  renderList();
}

export function hideIfcToFragPanel(): void {
  if (panel) panel.style.display = "none";
}

export function toggleIfcToFragPanel(): void {
  const p = ensurePanel();
  if (p.style.display === "none" || !p.style.display) showIfcToFragPanel();
  else hideIfcToFragPanel();
}

export function setupIfcToFrag(): void {
  (window as any).__obsIfcToFrag = {
    open: showIfcToFragPanel,
    toggle: toggleIfcToFragPanel,
    queue: queueFiles,
  };
  try {
    (ctx.features as any).ifcToFrag = (window as any).__obsIfcToFrag;
  } catch {
    /* */
  }
  console.log("[ifc→frag] converter ready — convert IFC to downloadable FRAG");
}
