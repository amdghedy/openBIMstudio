/**
 * CDE panel — pick a provider, sign in, browse folders, download files,
 * push the current scene, push BCF issues.
 */
import { ctx } from "../core/context";
import { makeDockable, type DockHandle } from "./dockable";
import { fmtBytes, fmtRelative } from "../core/format";
import {
  listCdeProviders, getCdeProvider, getCdeProviderMeta,
} from "../modules/cde/registry";
import { registerCdeProviders } from "../modules/cde/providers";
import { loadCdeConfig, saveCdeConfig, clearCdeConfig } from "../modules/cde/store";
import type {
  CdeCredentials, CdeFile, CdeFolder, CdeProject, CdeProviderId,
  CdeProviderMeta, CdeSession,
} from "../modules/cde/types";

const panel = document.createElement("div");
panel.id = "obs-cde-panel";
panel.style.cssText =
  "z-index:40;display:none;flex-direction:column;background:var(--bg-floating,#1c1e28);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:10px;" +
  "box-shadow:0 12px 36px rgba(0,0,0,.55);font:12px system-ui,sans-serif;" +
  "color:var(--text-primary,#e8eaf0);min-height:0;position:relative";
panel.addEventListener("mousedown", (e) => e.stopPropagation());

const header = document.createElement("div");
header.style.cssText =
  "display:flex;align-items:center;gap:6px;padding:9px 10px;" +
  "border-bottom:1px solid var(--border-subtle,#1e2029);" +
  "background:var(--bg-elevated,#181a23);flex-shrink:0;cursor:grab;user-select:none";
header.innerHTML =
  `<span style="display:flex;color:var(--accent,#38bdf8)">☁</span>` +
  `<span style="font-weight:700;flex:1">Common Data Environment</span>`;

const body = document.createElement("div");
body.style.cssText = "flex:1;overflow-y:auto;padding:10px";

panel.append(header, body);

let dock: DockHandle | null = null;
let visible = false;

interface PanelState {
  providerId: CdeProviderId | null;
  credentials: CdeCredentials;
  session: CdeSession | null;
  projects: CdeProject[];
  folders: CdeFolder[];
  files: CdeFile[];
  currentProject: CdeProject | null;
  currentFolder: CdeFolder | null;
  busy: boolean;
  status: string;
  error: string | null;
}

const state: PanelState = {
  providerId: null,
  credentials: {},
  session: null,
  projects: [],
  folders: [],
  files: [],
  currentProject: null,
  currentFolder: null,
  busy: false,
  status: "",
  error: null,
};

/* ── Utility ── */
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
}
function inputCss(): string {
  return (
    "width:100%;box-sizing:border-box;padding:6px 8px;" +
    "background:var(--bg-inset,#0e1017);border:1px solid var(--border-default,#2a2e3a);" +
    "border-radius:5px;color:var(--text-primary,#e8eaf0);font:11.5px system-ui"
  );
}
function primaryBtnCss(): string {
  return (
    "padding:7px 16px;background:var(--accent,#38bdf8);color:#0b0d12;border:none;" +
    "border-radius:5px;cursor:pointer;font:700 11.5px system-ui"
  );
}
function mkSmallBtn(): string {
  return (
    "padding:3px 9px;background:transparent;color:var(--text-secondary,#a0a6b5);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:4px;" +
    "cursor:pointer;font-size:10.5px"
  );
}
function listRowCss(): string {
  return (
    "display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:5px;" +
    "cursor:pointer;margin-bottom:2px;font-size:11.5px;" +
    "background:var(--bg-elevated,#181a23);border:1px solid var(--border-subtle,#1e2029)"
  );
}

/* ── Rendering ── */
function render(): void {
  body.innerHTML = "";

  const providers = listCdeProviders();
  const row = document.createElement("div");
  row.style.cssText = "display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center;margin-bottom:10px";
  const lbl = document.createElement("label");
  lbl.textContent = "Provider";
  lbl.style.cssText = "font-size:11px;color:var(--text-secondary,#a0a6b5)";
  const sel = document.createElement("select");
  sel.style.cssText = inputCss();
  sel.innerHTML = `<option value="">— select a CDE —</option>` +
    providers.map((p) => `<option value="${p.id}">${p.icon ?? ""} ${p.label}</option>`).join("");
  if (state.providerId) sel.value = state.providerId;
  sel.onchange = () => {
    const id = (sel.value || null) as CdeProviderId | null;
    state.providerId = id;
    state.session = null;
    state.projects = [];
    state.folders = [];
    state.files = [];
    state.currentProject = null;
    state.currentFolder = null;
    state.error = null;
    state.status = "";
    const saved = id ? loadCdeConfig(id) : null;
    state.credentials = saved?.credentials ?? {};
    state.session = (saved?.session as CdeSession | null) ?? null;
    render();
  };
  row.append(lbl, sel);
  body.appendChild(row);

  if (!state.providerId) {
    const empty = document.createElement("div");
    empty.textContent =
      "Select a CDE provider above. Credentials are stored locally on this device.";
    empty.style.cssText = "padding:20px;color:#6b7280;text-align:center;font-size:11px;line-height:1.6";
    body.appendChild(empty);
    return;
  }

  // ✅ fixed: getCdeProviderMeta returns CdeProviderMeta, not CdeProviderId
  const meta = getCdeProviderMeta(state.providerId);
  if (!meta) {
    const warn = document.createElement("div");
    warn.textContent = `No metadata registered for provider "${state.providerId}".`;
    warn.style.cssText = "padding:20px;color:#fca5a5;text-align:center;font-size:11px";
    body.appendChild(warn);
    return;
  }

  const desc = document.createElement("div");
  desc.textContent = meta.description;
  desc.style.cssText =
    "padding:8px 10px;font-size:10.5px;color:var(--text-secondary,#a0a6b5);" +
    "background:var(--bg-inset,#0e1017);border:1px solid var(--border-subtle,#1e2029);" +
    "border-radius:5px;margin-bottom:10px;line-height:1.55";
  body.appendChild(desc);

  if (!state.session) renderCredentials(meta);
  else renderBrowser(meta);
}

function renderCredentials(meta: CdeProviderMeta): void {
  for (const field of meta.credentialFields) {
    const r = document.createElement("div");
    r.style.cssText = "display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center;margin-bottom:8px";
    const l = document.createElement("label");
    l.textContent = field.label;
    l.style.cssText = "font-size:11px;color:var(--text-secondary,#a0a6b5)";
    const i = document.createElement("input");
    i.type = field.type;
    i.placeholder = field.placeholder ?? "";
    i.value = state.credentials[field.key] ?? field.defaultValue ?? "";
    i.style.cssText = inputCss();
    i.oninput = () => { state.credentials[field.key] = i.value; };
    r.append(l, i);
    body.appendChild(r);
    if (field.hint) {
      const h = document.createElement("div");
      h.textContent = field.hint;
      h.style.cssText = "font-size:10px;color:#6b7280;margin:-4px 0 8px 118px;line-height:1.5";
      body.appendChild(h);
    }
  }

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:6px;margin-top:8px";
  const signIn = document.createElement("button");
  signIn.textContent = state.busy ? "Signing in…" : "Sign in";
  signIn.disabled = state.busy;
  signIn.style.cssText = primaryBtnCss();
  signIn.onclick = () => void signInClick();
  btnRow.appendChild(signIn);
  body.appendChild(btnRow);

  if (state.error) {
    const e = document.createElement("div");
    e.textContent = state.error;
    e.style.cssText =
      "margin-top:10px;padding:8px 10px;background:rgba(239,68,68,.1);" +
      "border:1px solid rgba(239,68,68,.4);border-radius:5px;color:#fca5a5;font-size:11px;line-height:1.5";
    body.appendChild(e);
  }
}

function renderBrowser(meta: CdeProviderMeta): void {
  const who = document.createElement("div");
  who.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:6px 10px;margin-bottom:8px;" +
    "background:var(--bg-elevated,#181a23);border-radius:5px;border:1px solid var(--border-subtle,#1e2029)";
  const dot = document.createElement("span");
  dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#22c55e;flex:none";
  const name = document.createElement("div");
  name.innerHTML =
    `<b>${escapeHtml(state.session?.user?.name ?? "Signed in")}</b>` +
    (state.session?.user?.email
      ? ` <span style="color:#6b7280">· ${escapeHtml(state.session.user.email)}</span>`
      : "");
  name.style.cssText = "flex:1;font-size:11px";
  const signOut = document.createElement("button");
  signOut.textContent = "Sign out";
  signOut.style.cssText = mkSmallBtn();
  signOut.onclick = () => {
    if (state.providerId) clearCdeConfig(state.providerId);
    state.session = null;
    state.projects = [];
    state.files = [];
    state.currentProject = null;
    state.currentFolder = null;
    render();
  };
  who.append(dot, name, signOut);
  body.appendChild(who);

  const bc = document.createElement("div");
  bc.style.cssText = "font-size:10.5px;color:#6b7280;margin-bottom:8px;padding:0 2px";
  bc.textContent = [
    state.currentProject?.name,
    state.currentFolder?.name,
  ].filter(Boolean).join("  ›  ") || "Select a project";
  body.appendChild(bc);

  if (!state.currentProject) {
    renderProjectsList(meta);
    return;
  }
  renderFilesList(meta);
}

function renderProjectsList(_meta: CdeProviderMeta): void {
  if (state.busy) return renderLoading("Loading projects…");
  if (!state.projects.length) return renderEmpty("No projects found for this account.");
  for (const p of state.projects) {
    const row = document.createElement("div");
    row.style.cssText = listRowCss();
    row.innerHTML =
      `<span style="flex:1"><b>${escapeHtml(p.name)}</b>` +
      (p.description ? `<div style="font-size:10px;color:#6b7280">${escapeHtml(p.description)}</div>` : "") +
      `</span><span style="color:#6b7280">›</span>`;
    row.onclick = () => void selectProject(p);
    body.appendChild(row);
  }
}

function renderFilesList(meta: CdeProviderMeta): void {
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:6px;margin-bottom:8px";
  const back = document.createElement("button");
  back.textContent = state.currentFolder ? "↑ Up" : "← Projects";
  back.style.cssText = mkSmallBtn();
  back.onclick = () => void goUp();
  bar.appendChild(back);

  // ✅ meta.pushEnabled — only present on CdeProviderMeta (fixed type)
  if (meta.pushEnabled) {
    const push = document.createElement("button");
    push.textContent = "↑ Push current scene";
    push.style.cssText = mkSmallBtn();
    push.disabled = !state.currentFolder;
    push.title = state.currentFolder
      ? "Upload the current scene as .obs.json to this folder"
      : "Select a folder first";
    push.onclick = () => void pushCurrentScene();
    bar.appendChild(push);
  }
  body.appendChild(bar);

  if (state.folders.length) {
    const fHeader = document.createElement("div");
    fHeader.textContent = "Folders";
    fHeader.style.cssText = "font:700 9.5px system-ui;color:#6b7280;letter-spacing:.5px;margin:6px 2px 3px;text-transform:uppercase";
    body.appendChild(fHeader);
    for (const f of state.folders) {
      const row = document.createElement("div");
      row.style.cssText = listRowCss();
      row.innerHTML = `<span style="flex:1">📁 ${escapeHtml(f.name)}</span><span style="color:#6b7280">›</span>`;
      row.onclick = () => void selectFolder(f);
      body.appendChild(row);
    }
  }

  if (state.files.length) {
    const fHeader = document.createElement("div");
    fHeader.textContent = "Files";
    fHeader.style.cssText = "font:700 9.5px system-ui;color:#6b7280;letter-spacing:.5px;margin:10px 2px 3px;text-transform:uppercase";
    body.appendChild(fHeader);
    for (const f of state.files) {
      const row = document.createElement("div");
      row.style.cssText = listRowCss();
      const sizeStr = f.size != null ? fmtBytes(f.size) : "";
      const dateStr = f.updatedAt ? fmtRelative(f.updatedAt) : "";
      row.innerHTML =
        `<span style="flex:1;min-width:0">📄 <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</span>` +
        `<div style="font-size:9.5px;color:#6b7280;margin-top:1px">${[sizeStr, dateStr].filter(Boolean).join(" · ")}</div></span>` +
        `<button data-act="download" style="${mkSmallBtn()}">Download</button>`;
      row.querySelector<HTMLElement>("[data-act=download]")!.onclick = (ev) => {
        ev.stopPropagation();
        void downloadFile(f);
      };
      body.appendChild(row);
    }
  } else if (!state.busy && !state.folders.length) {
    renderEmpty("This folder is empty.");
  }
}

function renderLoading(msg: string): void {
  const e = document.createElement("div");
  e.textContent = msg;
  e.style.cssText = "padding:24px;text-align:center;color:#6b7280;font-size:11px";
  body.appendChild(e);
}
function renderEmpty(msg: string): void {
  const e = document.createElement("div");
  e.textContent = msg;
  e.style.cssText = "padding:20px;text-align:center;color:#6b7280;font-size:11px";
  body.appendChild(e);
}

/* ── Actions ── */
async function signInClick(): Promise<void> {
  if (!state.providerId) return;
  const provider = getCdeProvider(state.providerId);
  if (!provider) return;
  state.busy = true;
  state.error = null;
  render();
  try {
    const session = await provider.authenticate(state.credentials, state.session ?? undefined);
    state.session = session;
    saveCdeConfig({
      providerId: state.providerId,
      credentials: state.credentials,
      session,
    });
    state.projects = await provider.listProjects(session);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.busy = false;
    render();
  }
}

async function selectProject(p: CdeProject): Promise<void> {
  if (!state.providerId || !state.session) return;
  const provider = getCdeProvider(state.providerId);
  if (!provider) return;
  state.currentProject = p;
  state.folders = [];
  state.files = [];
  state.busy = true;
  render();
  try {
    const folders = await provider.listFolders(state.session, p.id);
    state.folders = folders;
    state.currentFolder = null;
    if (!folders.length) {
      state.files = await provider.listFiles(state.session, p.id, "root");
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.busy = false;
    render();
  }
}

async function selectFolder(f: CdeFolder): Promise<void> {
  if (!state.providerId || !state.session || !state.currentProject) return;
  const provider = getCdeProvider(state.providerId);
  if (!provider) return;
  state.busy = true;
  render();
  try {
    const [folders, files] = await Promise.all([
      provider.listFolders(state.session, state.currentProject.id, f.id),
      provider.listFiles(state.session, state.currentProject.id, f.id),
    ]);
    state.folders = folders;
    state.files = files;
    state.currentFolder = f;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.busy = false;
    render();
  }
}

async function goUp(): Promise<void> {
  if (!state.providerId || !state.session || !state.currentProject) return;
  if (state.currentFolder?.parentId) {
    const parent = state.folders.find((x) => x.id === state.currentFolder!.parentId);
    if (parent) return selectFolder(parent);
  }
  state.currentProject = null;
  state.currentFolder = null;
  state.folders = [];
  state.files = [];
  render();
}

async function downloadFile(f: CdeFile): Promise<void> {
  if (!state.providerId || !state.session || !state.currentProject) return;
  const provider = getCdeProvider(state.providerId);
  if (!provider) return;
  state.busy = true;
  state.status = `Downloading ${f.name}…`;
  render();
  try {
    const blob = await provider.downloadFile(state.session, state.currentProject.id, f.id);
    const file = new File([blob], f.name);
    const { importFiles } = await import("./file-interop");
    await importFiles([file]);
    state.status = `Downloaded ${f.name}`;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.busy = false;
    render();
  }
}

async function pushCurrentScene(): Promise<void> {
  if (!state.providerId || !state.session || !state.currentProject || !state.currentFolder) return;
  const provider = getCdeProvider(state.providerId);
  if (!provider?.uploadFile) return;
  const { getCurrentProject } = await import("../modules/projects/projects");
  const project = getCurrentProject();
  if (!project) { alert("No project is currently open."); return; }
  const filename = `${project.name.replace(/[^\w-]+/g, "_")}.obs.json`;
  const payload = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  state.busy = true;
  state.status = `Uploading ${filename}…`;
  render();
  try {
    await provider.uploadFile(state.session, state.currentProject.id, state.currentFolder.id, filename, payload);
    state.status = `Uploaded ${filename}`;
    await selectFolder(state.currentFolder);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.busy = false;
    render();
  }
}

/* ── Public ── */
export function openCdePanel(): void {
  registerCdeProviders();
  if (!dock) {
    dock = makeDockable(panel, {
      id: "cde",
      host: ctx.rightHost,
      header,
      minWidth: 420, minHeight: 400,
      defaultDock: "right",
      defaultWidth: 500, defaultHeight: 640,
    });
  }
  visible = true;
  panel.style.display = "flex";
  dock.show();
  render();
}

export function closeCdePanel(): void {
  visible = false;
  dock?.hide();
  panel.style.display = "none";
}

export function toggleCdePanel(): void {
  visible ? closeCdePanel() : openCdePanel();
}

export function isCdePanelVisible(): boolean { return visible; }

export function setupCdePanel(): void {
  registerCdeProviders();
  ctx.rightHost.appendChild(panel);
  dock = makeDockable(panel, {
    id: "cde",
    host: ctx.rightHost,
    header,
    minWidth: 420, minHeight: 400,
    defaultDock: "right",
    defaultWidth: 500, defaultHeight: 640,
  });
  panel.style.display = "none";
  ctx.features.cdePanel = {
    open: openCdePanel,
    close: closeCdePanel,
    toggle: toggleCdePanel,
    isVisible: isCdePanelVisible,
  };
  console.log("[cde] panel ready");
}