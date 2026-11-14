/**
 * Live IFC link - edit in the app, the IFC file on disk follows (no export step), and changes made to that file by
 * another program are noticed instead of silently overwritten.
 *
 * Honest scope: this links Native Twin edits (Insert → Make editable) to ONE output IFC4 file you choose; it never
 * overwrites your original model. It uses the browser's File System Access API (Chrome / Edge). It does not read or write
 * Revit .rvt files. External changes are detected by the file's modified time and offered back as "Reload from file".
 */
import { ctx } from "../core/context";
import { registerCommand } from "./command-palette";
import { writeFederatedNativeTwinIfc } from "../modules/export/native-twin-ifc";
import { hashString, detectExternalChange, nextLinkAction } from "../modules/export/live-link-core";
import { loadIfcFiles } from "./importer";
import { recordIfcChange } from "./native-ifc-workflow";

type Any = Record<string, any>;
const POLL_MS = 2000;

interface Link {
  handle: any;
  name: string;
  timer: number;
  knownModified: number;
  lastWrittenSig: string | null;
  lastWriteAt: number;
  writes: number;
  elements: number;
  external: boolean;
  busy: boolean;
  forceNext: boolean;
  error: string | null;
}
let link: Link | null = null;
let panel: HTMLDivElement | null = null;

function toast(message: string, kind: "success" | "warn" | "error" | "info" = "info"): void {
  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { kind, message, timeout: 5000 } }));
}

function twinEdits(): Any[] {
  const fe = (ctx as Any).features?.fragEdit as Any | undefined;
  try { return (typeof fe?.getTwinsForIfcExport === "function" ? fe.getTwinsForIfcExport() : []) ?? []; } catch { return []; }
}

export function isLiveLinkActive(): boolean { return !!link; }

export function liveLinkStatus(): { active: boolean; file?: string; writes?: number; elements?: number; external?: boolean; lastWriteAt?: number; error?: string | null } {
  if (!link) return { active: false };
  return { active: true, file: link.name, writes: link.writes, elements: link.elements, external: link.external, lastWriteAt: link.lastWriteAt, error: link.error };
}

async function modified(h: any): Promise<number> { return (await h.getFile()).lastModified as number; }

async function writeNow(l: Link): Promise<void> {
  const edits = twinEdits();
  const text = writeFederatedNativeTwinIfc(edits as any, l.name.replace(/\.ifc$/i, "") || "Live IFC");
  const w = await l.handle.createWritable();
  await w.write(text);
  await w.close();
  l.knownModified = await modified(l.handle);
  l.lastWrittenSig = hashString(JSON.stringify(edits));
  l.lastWriteAt = Date.now();
  l.writes++;
  l.elements = edits.length;
  l.error = null;
  if (l.writes === 1 || l.writes % 10 === 0) recordIfcChange("export-ifc", `Live link wrote ${edits.length} element(s) to ${l.name}`, { count: edits.length });
}

async function tick(): Promise<void> {
  const l = link; if (!l || l.busy) return;
  l.busy = true;
  try {
    const external = l.external || detectExternalChange(l.knownModified, await modified(l.handle));
    if (external && !l.external) { l.external = true; toast(`${l.name} was changed outside Open BIM Studio. Auto-save is paused - choose Reload or Keep mine.`, "warn"); }
    const edits = twinEdits();
    const action = nextLinkAction({ externalChange: l.external, sig: hashString(JSON.stringify(edits)), lastWrittenSig: l.lastWrittenSig, hasEdits: edits.length > 0, force: l.forceNext });
    if (action === "write") { l.forceNext = false; await writeNow(l); }
  } catch (e) {
    l.error = (e as Error).message;
  } finally { l.busy = false; render(); }
}

export async function startLiveIfcLink(): Promise<void> {
  if (link) { render(); return; }
  const pick = (window as Any).showSaveFilePicker;
  if (typeof pick !== "function") { toast("Live IFC link needs a Chromium browser (Chrome / Edge): it uses the File System Access API.", "warn"); return; }
  if (!twinEdits().length) toast("Nothing is editable yet. Make a model editable (Insert → Make editable) - the link will write as soon as there are edits.", "info");
  let handle: any;
  try {
    handle = await pick({ suggestedName: "openbimstudio-live.ifc", types: [{ description: "IFC4 file", accept: { "application/x-step": [".ifc"] } }] });
  } catch { return; } // cancelled
  const l: Link = { handle, name: handle.name ?? "live.ifc", timer: 0, knownModified: 0, lastWrittenSig: null, lastWriteAt: 0, writes: 0, elements: 0, external: false, busy: false, forceNext: false, error: null };
  link = l;
  try { await writeNow(l); } catch (e) { l.error = (e as Error).message; }
  l.timer = window.setInterval(() => { void tick(); }, POLL_MS);
  toast(`Live IFC link on: ${l.name} now follows your edits.`, "success");
  render();
}

export function stopLiveIfcLink(): void {
  if (!link) return;
  window.clearInterval(link.timer);
  const name = link.name; link = null;
  toast(`Live IFC link stopped (${name} keeps its last saved state).`, "info");
  render();
}

async function reloadFromFile(): Promise<void> {
  const l = link; if (!l) return;
  const file: File = await l.handle.getFile();
  l.knownModified = file.lastModified;
  l.external = false;
  l.lastWrittenSig = hashString(JSON.stringify(twinEdits())); // do not write straight back over what we just loaded
  loadIfcFiles([file]);
  toast(`Loaded ${l.name} from disk.`, "success");
  render();
}

function keepMine(): void { if (!link) return; link.external = false; link.forceNext = true; void tick(); }

function render(): void {
  if (!link) { panel?.remove(); panel = null; return; }
  if (!panel || !panel.isConnected) {
    panel = document.createElement("div");
    panel.id = "obs-live-ifc-link";
    panel.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:9000;width:280px;background:#12161f;color:#e6e9f0;border:1px solid #2b3445;border-radius:8px;padding:10px 12px;font:12px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4)";
    document.body.appendChild(panel);
  }
  const l = link;
  const when = l.lastWriteAt ? new Date(l.lastWriteAt).toLocaleTimeString() : "not yet";
  const state = l.external ? "Changed outside the app - auto-save paused" : l.error ? `Problem: ${l.error}` : "Following your edits";
  const btn = (a: string, t: string) => `<button data-a="${a}" style="margin:4px 4px 0 0;padding:3px 8px;background:#1d2533;color:inherit;border:1px solid #33405a;border-radius:5px;cursor:pointer">${t}</button>`;
  panel.innerHTML = `<div style="font-weight:600;margin-bottom:4px">● Live IFC link</div>
    <div data-file style="opacity:.85;word-break:break-all">${l.name.replace(/[<>&]/g, "")}</div>
    <div data-state style="margin:4px 0;color:${l.external ? "#fbbf24" : l.error ? "#f87171" : "#86efac"}">${state}</div>
    <div style="opacity:.7">${l.elements} element(s) · ${l.writes} write(s) · last ${when}</div>
    <div>${l.external ? btn("reload", "Reload from file") + btn("keep", "Keep mine (overwrite)") : btn("now", "Write now")}${btn("stop", "Stop")}</div>`;
  panel.querySelectorAll<HTMLButtonElement>("button[data-a]").forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.a;
      if (a === "stop") stopLiveIfcLink();
      else if (a === "reload") void reloadFromFile();
      else if (a === "keep") keepMine();
      else if (a === "now" && link) { link.forceNext = true; void tick(); }
    };
  });
}

export function setupLiveIfcLink(): void {
  (ctx as Any).features = (ctx as Any).features ?? {};
  (ctx as Any).features.liveIfcLink = { start: startLiveIfcLink, stop: stopLiveIfcLink, status: liveLinkStatus, tick };
  registerCommand({ id: "ifc.live_link.start", label: "IFC: Live link - keep an IFC file in sync with my edits", category: "IFC", hint: "Pick an IFC4 file; every edit is written to it automatically, and outside changes are detected", run: () => { void startLiveIfcLink(); } });
  registerCommand({ id: "ifc.live_link.stop", label: "IFC: Stop live link", category: "IFC", hint: "Stop writing edits to the linked IFC file", run: () => stopLiveIfcLink() });
}
