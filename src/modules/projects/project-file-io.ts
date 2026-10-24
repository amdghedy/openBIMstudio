/**
 * Save to file / Open from file for whole projects (.obsproj).
 *
 *  - Chrome / Edge: pick a file once; Ctrl+S then keeps re-writing that same file
 *    (the file link is remembered between sessions, the browser may ask to allow access again).
 *  - Other browsers: the project is downloaded as a .obsproj file instead.
 *  - Opening a file imports it into this browser's project database and opens it, so
 *    projects can move between the web version and a local copy.
 */
import { notify as toast } from "../../core/notify";
import * as store from "./store";
import type { ProjectDoc } from "./types";
import { buildProjectFile, parseProjectFile, ProjectFileError, PROJECT_FILE_EXT, PROJECT_FILE_MIME, suggestedFileName } from "./project-file";
import { getCurrentProject, openProject, saveProject } from "./projects";

type Handle = any; // FileSystemFileHandle (not in every TS lib)
interface Link { projectId: string; handle: Handle; name: string }

let link: Link | null = null;
let lastFileWrite = 0;
let writing = false;
const AUTOSAVE_MIN_GAP_MS = 45_000;

const hasPicker = () => typeof (window as any).showSaveFilePicker === "function";
const pickerTypes = () => [{ description: "Open BIM Studio project", accept: { [PROJECT_FILE_MIME]: [PROJECT_FILE_EXT] } }];

/* ── remember the file handle per project (IndexedDB can store handles) ── */
const LINK_DB = "obs-file-links";
function linkDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(LINK_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("links");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function saveLink(l: Link): Promise<void> {
  try {
    const db = await linkDb();
    await new Promise<void>((res, rej) => {
      const t = db.transaction("links", "readwrite");
      t.objectStore("links").put({ handle: l.handle, name: l.name }, l.projectId);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  } catch { /* handle persistence is best-effort */ }
}
async function loadLink(projectId: string): Promise<Link | null> {
  try {
    const db = await linkDb();
    const rec: any = await new Promise((res, rej) => {
      const r = db.transaction("links", "readonly").objectStore("links").get(projectId);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return rec?.handle ? { projectId, handle: rec.handle, name: rec.name ?? rec.handle.name } : null;
  } catch { return null; }
}
async function linkFor(projectId: string): Promise<Link | null> {
  if (link?.projectId === projectId) return link;
  const l = await loadLink(projectId);
  if (l) link = l;
  return l;
}

async function ensurePermission(handle: Handle, prompt: boolean): Promise<boolean> {
  try {
    const opts = { mode: "readwrite" };
    if ((await handle.queryPermission?.(opts)) === "granted") return true;
    if (!prompt) return false;
    return (await handle.requestPermission?.(opts)) === "granted";
  } catch { return false; }
}

async function snapshotFile(): Promise<{ blob: Blob; doc: ProjectDoc } | null> {
  const cur = getCurrentProject();
  if (!cur) { toast("warn", "Open or create a project first."); return null; }
  await saveProject(true);                       // flush live state into the project database
  const doc = (await store.getProject(cur.id)) ?? cur;
  const blobs = await store.getModelBlobs(cur.id);
  return { blob: buildProjectFile(doc, blobs), doc };
}

async function writeHandle(handle: Handle, blob: Blob): Promise<void> {
  const w = await handle.createWritable();
  try { await w.write(blob); } finally { await w.close(); }
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Save the open project to a .obsproj file. `asNew` always asks for a new file (Save As / backup copy). */
export async function saveProjectToFile(asNew = false): Promise<boolean> {
  if (writing) return false;
  writing = true;
  try {
    const snap = await snapshotFile();
    if (!snap) return false;
    const { blob, doc } = snap;
    const name = suggestedFileName(doc);
    if (!hasPicker()) {
      download(blob, name);
      toast("success", `Downloaded ${name}. This browser cannot save to a chosen file, so use Open File to continue from it.`);
      return true;
    }
    let l = !asNew ? await linkFor(doc.id) : null;
    if (l && !(await ensurePermission(l.handle, true))) l = null;
    if (!l) {
      const handle = await (window as any).showSaveFilePicker({ suggestedName: name, types: pickerTypes() });
      l = { projectId: doc.id, handle, name: handle.name };
      link = l; void saveLink(l);               // Ctrl+S now keeps this file up to date (Save As re-points it)
    }
    await writeHandle(l.handle, blob);
    lastFileWrite = Date.now();
    toast("success", `Saved to file: ${l.name}`);
    return true;
  } catch (err: any) {
    if (err?.name === "AbortError") return false;           // user closed the picker
    console.error("[project-file] save failed", err);
    toast("error", `Could not save the file: ${err?.message ?? err}`);
    return false;
  } finally {
    writing = false;
  }
}

async function readPickedFile(): Promise<{ file: File; handle: Handle | null } | null> {
  if (typeof (window as any).showOpenFilePicker === "function") {
    try {
      const [h] = await (window as any).showOpenFilePicker({ types: pickerTypes(), multiple: false });
      return { file: await h.getFile(), handle: h };
    } catch (err: any) {
      if (err?.name === "AbortError") return null;
      throw err;
    }
  }
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = PROJECT_FILE_EXT;
    inp.onchange = () => resolve(inp.files?.[0] ? { file: inp.files[0], handle: null } : null);
    inp.oncancel = () => resolve(null);
    inp.click();
  });
}

/** Import a parsed project into this browser and open it. */
export async function importProjectFile(file: Blob, handle: Handle | null = null): Promise<boolean> {
  const { doc, blobs } = await parseProjectFile(file);
  const existing = await store.getProject(doc.id);
  let id = doc.id;
  if (existing) {
    const when = new Date(existing.updatedAt).toLocaleString();
    const replace = window.confirm(
      `"${existing.name}" already exists in this browser (last saved ${when}).\n\n` +
      `OK = replace it with the file's version.\nCancel = open the file as a separate copy.`);
    if (replace) {
      await store.deleteModelBlobs(id);
    } else {
      id = (crypto as any).randomUUID?.() ?? `${doc.id}-copy-${Date.now()}`;
      doc.id = id;
      doc.name = `${doc.name} (copy)`;
    }
  }
  doc.updatedAt = Date.now();
  await store.putProject(doc);
  for (const b of blobs) await store.putModelBlob(id, b.modelId, b.name, b.blob);
  if (handle) { link = { projectId: id, handle, name: handle.name }; void saveLink(link); }
  await openProject(id);
  toast("success", `Opened ${doc.name}${blobs.length ? ` with ${blobs.length} model(s)` : ""}`);
  return true;
}

export async function openProjectFromFile(): Promise<boolean> {
  try {
    const picked = await readPickedFile();
    if (!picked) return false;
    return await importProjectFile(picked.file, picked.handle);
  } catch (err: any) {
    console.error("[project-file] open failed", err);
    toast("error", err instanceof ProjectFileError ? err.message : `Could not open the file: ${err?.message ?? err}`);
    return false;
  }
}

/** After every project save: keep the linked file up to date (silent saves never prompt). */
async function onProjectSaved(ev: Event): Promise<void> {
  if (writing) return;
  const cur = getCurrentProject();
  if (!cur || !hasPicker()) return;
  const silent = !!(ev as CustomEvent).detail?.silent;
  const l = await linkFor(cur.id);
  if (!l) return;
  if (silent && Date.now() - lastFileWrite < AUTOSAVE_MIN_GAP_MS) return;
  if (!(await ensurePermission(l.handle, !silent))) return;
  writing = true;
  try {
    const doc = (await store.getProject(cur.id)) ?? cur;
    const blobs = await store.getModelBlobs(cur.id);
    await writeHandle(l.handle, buildProjectFile(doc, blobs));
    lastFileWrite = Date.now();
    if (!silent) toast("success", `Saved to ${l.name}`);
  } catch (err) {
    console.warn("[project-file] linked write failed", err);
  } finally {
    writing = false;
  }
}

export function setupProjectFileIO(): void {
  window.addEventListener("obs:project-saved", (e) => { void onProjectSaved(e); });
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault(); e.stopImmediatePropagation();
      void saveProjectToFile(true);
    }
  }, true);
  (window as any).__obsProjectFile = { save: () => saveProjectToFile(false), saveAs: () => saveProjectToFile(true), open: openProjectFromFile };
}
