/** Revit-style File application menu: commands + Recent Documents. */
import * as THREE from "three";
import { ctx } from "../core/context";
import * as store from "../modules/projects/store";
import { getCurrentProject, saveProject, openProject, deleteProjectById, isDirty } from "../modules/projects/projects";
import { showHome } from "./home-screen";
import { captureThumbnail } from "../modules/issues/issues";
import { exportBCF } from "../modules/issues/bcf";
import { exportCostCsv } from "../features/cost-panel";
import { pickAndImport } from "../features/file-interop";
import { settingsBox } from "../features/importer";

const menu = document.createElement("div");
menu.style.cssText = "position:fixed;top:100px;left:10px;width:760px;max-width:calc(100vw - 20px);z-index:250;display:none;background:#1b1c26;border:1px solid #34353f;border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,.6);color:#e2e8f0;font:12px system-ui,sans-serif;overflow:hidden";
menu.addEventListener("mousedown", (e) => e.stopPropagation());

const BTN = "display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;background:transparent;color:#dbe2ea;border:none;border-radius:6px;cursor:pointer;font:500 12.5px system-ui,sans-serif;text-align:left";
const BTN_H = BTN + ";background:#24252f";
const SECTION = "font:700 10px system-ui,sans-serif;color:#64748b;text-transform:uppercase;letter-spacing:.6px;padding:10px 12px 4px";

const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const uid = () => (crypto as any).randomUUID?.() ?? `p-${Date.now()}`;

let built = false;

function item(icon: string, label: string, onclick: () => void, hint = "", danger = false): HTMLElement {
  const b = document.createElement("button");
  b.style.cssText = BTN + (danger ? ";color:#fca5a5" : "");
  b.innerHTML = `<span style="width:20px;text-align:center;font-size:15px">${icon}</span><span style="flex:1">${esc(label)}</span>${hint ? `<span style="opacity:.45;font-size:10px">${esc(hint)}</span>` : ""}`;
  b.onmouseenter = () => (b.style.cssText = BTN_H + (danger ? ";color:#fca5a5" : ""));
  b.onmouseleave = () => (b.style.cssText = BTN + (danger ? ";color:#fca5a5" : ""));
  b.onclick = () => { closeFileMenu(); onclick(); };
  return b;
}

async function saveAs() {
  const cur = getCurrentProject();
  if (!cur) { alert("No project is open."); return; }
  const name = prompt("Save project as:", `${cur.name} (copy)`);
  if (!name) return;
  await saveProject();
  const copy: any = JSON.parse(JSON.stringify(cur));
  copy.id = uid();
  copy.name = name;
  copy.createdAt = copy.updatedAt = Date.now();
  await store.putProject(copy);
  const blobs = await store.getModelBlobs(cur.id);
  for (const b of blobs) await store.putModelBlob(copy.id, b.modelId, b.name, b.blob);
  await openProject(copy.id);
}

function exportProjectJson() {
  const cur = getCurrentProject();
  if (!cur) { alert("No project is open."); return; }
  void saveProject(true).then(() => {
    const blob = new Blob([JSON.stringify(getCurrentProject(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${cur.name.replace(/[^\w-]+/g, "_")}.obs.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  });
}

function printView() {
  const url = captureThumbnail(1800);
  const w = window.open("", "_blank");
  if (!w) { alert("Popup blocked — allow popups to print."); return; }
  w.document.write(`<html><head><title>Open BIM Studio — Print</title></head><body style="margin:0"><img src="${url}" style="width:100%" onload="window.print()"></body></html>`);
  w.document.close();
}

async function exportGlb() {
  const auxObjects: THREE.Object3D[] = (ctx.features as any).fileInterop?.getAuxObjects?.() ?? [];
  if (!ctx.fragments.list.size && !auxObjects.length) {
    alert("Nothing to export — the scene is empty."); return;
  }
  try {
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const g = new THREE.Group();
    for (const [, m] of ctx.fragments.list) g.add(m.object.clone(true));
    for (const o of auxObjects) g.add(o.clone(true));
    const cur = getCurrentProject();
    new (GLTFExporter as any).parse(g, (res: ArrayBuffer) => {
      const blob = new Blob([res], { type: "model/gltf-binary" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${(cur?.name ?? "scene").replace(/[^\w-]+/g, "_")}.glb`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
    }, (err: any) => { console.error(err); alert("GLB export failed — see console."); }, { binary: true });
  } catch (err: any) { alert(`GLB export failed: ${err?.message ?? err}`); }
}

async function importProjectFile() {
  const input = document.createElement("input");
  input.type = "file"; input.accept = ".obs.json,.json";
  input.onchange = async () => {
    const f = input.files?.[0]; if (!f) return;
    try {
      const doc = JSON.parse(await f.text());
      if (!doc?.id || !Array.isArray(doc.elements)) throw new Error("Not a valid Open BIM Studio project file.");
      await store.putProject(doc);
      await openProject(doc.id);
    } catch (e: any) { alert(`Open project file failed: ${e?.message ?? e}`); }
  };
  input.click();
}

function closeProject() {
  const go = () => showHome();
  if (isDirty()) {
    if (confirm("Project has unsaved changes. Save before closing?")) void saveProject(true).then(go);
    else go();
  } else go();
}

function openOptions() {
  const ov = document.createElement("div");
  ov.style.cssText = "position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
  const card = document.createElement("div");
  card.style.cssText = "background:#1b1c26;border:1px solid #34353f;border-radius:10px;padding:16px;width:420px;max-height:80vh;overflow:auto;color:#e2e8f0;font:12px system-ui,sans-serif";
  const t = document.createElement("div");
  t.textContent = "Options";
  t.style.cssText = "font-weight:700;font-size:14px;margin-bottom:10px";
  const close = document.createElement("button");
  close.textContent = "Close";
  close.style.cssText = "margin-top:10px;padding:7px 14px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600";
  close.onclick = () => ov.remove();
  ov.onmousedown = (e) => { if (e.target === ov) ov.remove(); };
  card.append(t, settingsBox, close);
  ov.appendChild(card);
  document.body.appendChild(ov);
}

function build() {
  built = true;
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:0;min-height:380px";

  const left = document.createElement("div");
  left.style.cssText = "width:300px;flex:none;border-right:1px solid #24252f;padding:6px";
  left.append(
    Object.assign(document.createElement("div"), { style: SECTION, textContent: "Application" }),
    item("🆕", "New", () => showHome(), "Ctrl+N"),
    item("📂", "Open Project…", () => showHome()),
    item("🧬", "Open File… (any format)", () => pickAndImport(), "IFC · GLB · OBJ · FBX …"),
    item("📑", "Open Project File…", () => importProjectFile(), ".obs.json"),
    Object.assign(document.createElement("div"), { style: SECTION, textContent: "Save" }),
    item("💾", "Save", () => void saveProject(), "Ctrl+S"),
    item("📝", "Save As…", () => void saveAs()),
    Object.assign(document.createElement("div"), { style: SECTION, textContent: "Export" }),
    item("🗣", "Issues → BCF", () => exportBCF()),
    item("💰", "Cost → CSV", () => exportCostCsv()),
    item("🧊", "Scene → GLB", () => void exportGlb()),
    item("🖼", "Project → JSON", () => exportProjectJson(), "backup"),
    Object.assign(document.createElement("div"), { style: SECTION, textContent: "Document" }),
    item("🖨", "Print…", () => printView()),
    item("⚙️", "Options", () => openOptions()),
    item("🚪", "Close", () => closeProject()),
    item("⏻", "Exit", () => closeProject()),
  );

  const right = document.createElement("div");
  right.style.cssText = "flex:1;padding:10px 12px;overflow:auto";
  const rl = Object.assign(document.createElement("div"), { style: SECTION, textContent: "Recent Documents" });
  const list = document.createElement("div");
  list.id = "obs-filemenu-recent";
  list.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-top:4px";
  right.append(rl, list);

  row.append(left, right);
  menu.appendChild(row);
}

async function renderRecents() {
  const list = menu.querySelector("#obs-filemenu-recent") as HTMLElement;
  if (!list) return;
  list.innerHTML = `<div style="opacity:.5;padding:8px">Loading…</div>`;
  const docs = (await store.listProjectDocs()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
  list.innerHTML = "";
  if (!docs.length) {
    list.innerHTML = `<div style="opacity:.5;padding:10px;border:1px dashed #34353f;border-radius:8px;text-align:center">Files you open will show up here.</div>`;
    return;
  }
  for (const doc of docs) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 10px;background:#171821;border:1px solid #24252f;border-radius:7px;cursor:pointer";
    const info = document.createElement("div");
    info.style.cssText = "flex:1;min-width:0";
    info.innerHTML = `<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📄 ${esc(doc.name)}</div>
      <div style="opacity:.5;font-size:10px">${doc.elements?.length ?? 0} objects · ${doc.models?.length ?? 0} model(s) · ${new Date(doc.updatedAt).toLocaleString()}</div>`;
    const open = document.createElement("button");
    open.textContent = "Open";
    open.style.cssText = "padding:4px 10px;background:#2563eb;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:10px;font-weight:600";
    open.onclick = (e) => { e.stopPropagation(); closeFileMenu(); void openProject(doc.id); };
    const del = document.createElement("button");
    del.textContent = "🗑";
    del.style.cssText = "padding:4px 8px;background:#2a2a3a;border:1px solid #3a3a4a;border-radius:5px;cursor:pointer;font-size:10px";
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove "${doc.name}" from Recent Documents?`)) return;
      await deleteProjectById(doc.id);
      void renderRecents();
    };
    row.onclick = () => { closeFileMenu(); void openProject(doc.id); };
    row.append(info, open, del);
    list.appendChild(row);
  }
}

export function toggleFileMenu() {
  menu.style.display === "block" ? closeFileMenu() : openFileMenu();
}
export function isFileMenuVisible() { return menu.style.display === "block"; }
export function openFileMenu() {
  if (!built) build();
  void renderRecents();
  menu.style.display = "block";
}
export function closeFileMenu() { menu.style.display = "none"; }

export function setupFileMenu() {
  document.body.appendChild(menu);
  window.addEventListener("mousedown", (e) => {
    if (menu.style.display === "block" && !menu.contains(e.target as Node)) closeFileMenu();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFileMenu();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); pickAndImport(); }
  });
  ctx.features.fileMenu = { toggle: toggleFileMenu, open: openFileMenu, close: closeFileMenu };
}