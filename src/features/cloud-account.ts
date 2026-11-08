/**
 * Cloud account — sign in with an email account or Google, and keep projects
 * in a per-user cloud vault so they can be reopened from any device
 * (desktop, tablet or phone browser).
 *
 * Backend: worker/auth.ts — AuthVault Durable Object on the same origin:
 *   POST /api/auth/register | login | logout, GET /api/auth/me
 *   GET  /api/auth/google/start → Google consent (when the deployment has
 *         GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET secrets configured)
 *   GET/POST /api/projects, GET/DELETE /api/projects/<id>
 *
 * The session lives in an HttpOnly cookie, so the page scripts can only ask
 * "am I signed in?" — the token itself is never readable from JS.
 *
 * UI:
 *   - An account button in the ribbon tab row (next to the brand) and in the
 *     Project Center header: "Sign in" when signed out, the user's name when
 *     signed in. Opens a dropdown menu with the cloud actions.
 *   - Sign in / create account dialog (email + password) with a
 *     "Continue with Google" button.
 *   - "My cloud projects" dialog: save the current project, open it again on
 *     any device, delete old copies.
 *
 * Cloud saves reuse the exact .obsproj project file format (buildProjectFile),
 * and cloud opens go through importProjectFile, so a cloud project is
 * byte-compatible with File → Open.
 */
import { ctx } from "../core/context";
import { registerCommand } from "./command-palette";
import { getCurrentProject, saveProject } from "../modules/projects/projects";
import * as store from "../modules/projects/store";
import { buildProjectFile, suggestedFileName } from "../modules/projects/project-file";
import { importProjectFile } from "../modules/projects/project-file-io";

const STYLE = `
.obs-acct{position:relative;display:inline-flex;align-items:center;z-index:80;flex:0 0 auto}
.obs-acct__btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;
  border-radius:8px;border:1px solid rgba(148,163,184,.28);background:rgba(15,20,28,.72);
  color:#cbd5e1;font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer;
  transition:background .15s,border-color .15s,color .15s;max-width:200px;white-space:nowrap}
.obs-acct__btn:hover{background:rgba(56,189,248,.14);border-color:rgba(56,189,248,.5);color:#e2e8f0}
.obs-acct__btn svg{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;
  stroke-linecap:round;stroke-linejoin:round}
.obs-acct__btn .nm{overflow:hidden;text-overflow:ellipsis;max-width:120px}
.obs-acct__dot{width:7px;height:7px;border-radius:50%;background:#22c55e;flex:none;
  box-shadow:0 0 6px rgba(34,197,94,.7)}
.obs-acct__menu{position:fixed;min-width:240px;padding:6px;
  border-radius:10px;border:1px solid rgba(148,163,184,.25);background:#0d1219;
  box-shadow:0 12px 32px rgba(0,0,0,.55);display:none;z-index:9600}
.obs-acct.is-open .obs-acct__menu{display:block}
.obs-acct__menu-title{padding:6px 8px 4px;font:600 10px/1.3 ui-monospace,monospace;
  letter-spacing:.08em;text-transform:uppercase;color:#64748b;white-space:nowrap}
.obs-acct__item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:0;
  border-radius:7px;background:transparent;color:#cbd5e1;font:13px/1.2 system-ui,sans-serif;
  text-align:left;cursor:pointer}
.obs-acct__item:hover{background:rgba(56,189,248,.12)}
.obs-acct__item .k{margin-left:auto;font:600 10px/1 ui-monospace,monospace;color:#64748b}
/* ── dialogs ── */
.obs-acct-overlay{position:fixed;inset:0;z-index:9700;display:flex;align-items:center;
  justify-content:center;background:rgba(4,6,10,.62);backdrop-filter:blur(3px);padding:16px}
.obs-acct-card{width:min(420px,94vw);max-height:86vh;overflow:auto;border-radius:14px;
  border:1px solid rgba(148,163,184,.25);background:#0d1219;color:#e2e8f0;
  box-shadow:0 24px 80px rgba(0,0,0,.6);font:13px/1.45 system-ui,sans-serif}
.obs-acct-card__head{display:flex;align-items:center;justify-content:space-between;
  padding:14px 16px 10px;border-bottom:1px solid rgba(148,163,184,.14)}
.obs-acct-card__title{font:600 15px/1.2 system-ui,sans-serif;color:#f1f5f9}
.obs-acct-card__x{border:0;background:transparent;color:#94a3b8;font:16px/1 system-ui;cursor:pointer;padding:4px}
.obs-acct-card__x:hover{color:#e2e8f0}
.obs-acct-card__body{padding:12px 16px 16px;display:flex;flex-direction:column;gap:10px}
.obs-acct-field{display:flex;flex-direction:column;gap:4px}
.obs-acct-field label{font:600 10px/1 ui-monospace,monospace;letter-spacing:.08em;
  text-transform:uppercase;color:#64748b}
.obs-acct-field input{height:34px;padding:0 10px;border-radius:8px;font:13px system-ui,sans-serif;
  border:1px solid rgba(148,163,184,.3);background:#0a0e14;color:#e2e8f0;outline:none}
.obs-acct-field input:focus{border-color:#38bdf8}
.obs-acct-submit{height:36px;border:0;border-radius:8px;background:#0ea5e9;color:#04121d;
  font:700 13px system-ui,sans-serif;cursor:pointer}
.obs-acct-submit:hover{background:#38bdf8}
.obs-acct-submit[disabled]{opacity:.55;cursor:default}
.obs-acct-google{height:36px;display:flex;align-items:center;justify-content:center;gap:8px;
  border-radius:8px;border:1px solid rgba(148,163,184,.35);background:transparent;color:#e2e8f0;
  font:600 13px system-ui,sans-serif;cursor:pointer}
.obs-acct-google:hover{background:rgba(148,163,184,.12)}
.obs-acct-swap{background:transparent;border:0;color:#38bdf8;font:12px system-ui;cursor:pointer;
  text-align:center;padding:2px}
.obs-acct-err{color:#fca5a5;font:12px system-ui;min-height:15px;white-space:pre-wrap}
.obs-acct-note{color:#64748b;font:11px/1.5 system-ui,sans-serif}
.obs-acct-hint{border:1px solid rgba(251,191,36,.35);background:rgba(251,191,36,.08);
  color:#fcd34d;font:11px/1.5 system-ui,sans-serif;border-radius:8px;padding:8px 10px}
/* cloud projects list */
.obs-acct-row{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:9px;
  border:1px solid rgba(148,163,184,.16);background:rgba(15,20,28,.55)}
.obs-acct-row__main{flex:1;min-width:0}
.obs-acct-row__name{font:600 13px/1.3 system-ui,sans-serif;color:#e2e8f0;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.obs-acct-row__meta{font:11px/1.3 ui-monospace,monospace;color:#64748b}
.obs-acct-row button{border-radius:7px;border:1px solid rgba(148,163,184,.3);background:transparent;
  color:#cbd5e1;font:600 11px system-ui;padding:6px 10px;cursor:pointer;flex:none}
.obs-acct-row button:hover{border-color:#38bdf8;color:#e2e8f0}
.obs-acct-row button.danger:hover{border-color:#f87171;color:#fecaca}
.obs-acct-row--save{justify-content:center;background:rgba(14,165,233,.12);
  border-color:rgba(14,165,233,.4);color:#7dd3fc;font:600 12px system-ui;cursor:pointer}
.obs-acct-row--save:hover{background:rgba(14,165,233,.2)}
.obs-acct-empty{color:#64748b;font:12px system-ui;text-align:center;padding:14px 0}
`;

type SessionUser = { email: string; name: string; provider: string };

let currentUser: SessionUser | null = null;
let meRequest: Promise<void> | null = null;
let googleReady: boolean | null = null;

/**
 * Probe (and cache) whether this deployment has Google OAuth configured.
 * Lets the UI explain — inside the dialog — instead of navigating away to a
 * bare "not configured" response when the owner has not set the secrets yet.
 */
async function googleConfigured(): Promise<boolean> {
  if (googleReady !== null) return googleReady;
  try {
    const res = await fetch("/api/auth/google/status", { credentials: "same-origin" });
    googleReady = Boolean((await res.json() as { configured?: boolean }).configured);
  } catch {
    googleReady = false;
  }
  return googleReady;
}

/** Amber, once-per-dialog note explaining the state and the owner setup steps. */
function showGoogleSetupHint(anchor: HTMLElement): void {
  if (anchor.parentElement?.querySelector(":scope > .obs-acct-hint")) return;
  const hint = document.createElement("div");
  hint.className = "obs-acct-hint";
  hint.textContent =
    "Google sign-in isn't set up on this deployment yet — email accounts work right now " +
    "(create one above). To enable Google: in Google Cloud Console create an OAuth client ID " +
    "(Web application) with redirect URI " +
    `${location.origin}/api/auth/google/callback` +
    ", then set the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET Worker secrets. " +
    "The button starts working after the next deploy — no code changes needed.";
  anchor.insertAdjacentElement("afterend", hint);
}

function toast(kind: string, msg: string): void {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { kind, message: msg, timeout: 2200 } }));
  } catch {
    console.log(`[cloud-acct] ${msg}`);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

/** Ask the server who we are (once at a time — renderTabs can call freely). */
export function refreshAccountState(): Promise<void> {
  if (meRequest) return meRequest;
  meRequest = api<{ user: SessionUser | null }>("/api/auth/me")
    .then((r) => {
      currentUser = r.user;
    })
    .catch(() => {
      currentUser = null;
    })
    .finally(() => {
      meRequest = null;
    });
  return meRequest;
}

function ensureStyle(): void {
  if (document.getElementById("obs-acct-style")) return;
  const style = document.createElement("style");
  style.id = "obs-acct-style";
  style.textContent = STYLE;
  document.head.appendChild(style);
}

const PERSON_SVG =
  `<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c1.2-3.6 4-5.4 7.5-5.4s6.3 1.8 7.5 5.4"/></svg>`;

function buttonLabel(): string {
  if (!currentUser) return "Sign in";
  return currentUser.name || currentUser.email.split("@")[0];
}

/**
 * Mount (or re-mount) the account button into the given host. Called from the
 * ribbon tab row renderer and the Project Center header, both of which rebuild
 * their DOM freely — so this stays cheap and side-effect-free.
 */
export function mountAccountButton(host: HTMLElement): void {
  ensureStyle();
  void refreshAccountState().then(() => {
    // Re-render once the session check resolves so the label is accurate.
    if (!host.isConnected) return;
    renderButton(host);
  });
  if (host.querySelector(":scope > .obs-acct")) return;
  renderButton(host);
}

function renderButton(host: HTMLElement): void {
  const old = host.querySelector(":scope > .obs-acct");
  const wrap = document.createElement("div");
  wrap.className = "obs-acct";
  const btn = document.createElement("button");
  btn.className = "obs-acct__btn";
  btn.type = "button";
  btn.title = currentUser ? `Account: ${currentUser.email}` : "Sign in to save your projects to the cloud";
  btn.innerHTML =
    PERSON_SVG +
    (currentUser ? `<span class="obs-acct__dot"></span>` : "") +
    `<span class="nm"></span>`;
  (btn.querySelector(".nm") as HTMLElement).textContent = buttonLabel();
  btn.onclick = (e) => {
    e.stopPropagation();
    const open = wrap.classList.toggle("is-open");
    if (open) positionMenu(btn, wrap);
  };
  wrap.appendChild(btn);
  const menu = document.createElement("div");
  menu.className = "obs-acct__menu";
  buildMenu(menu);
  wrap.appendChild(menu);
  if (old) old.replaceWith(wrap);
  else host.appendChild(wrap);
}

function positionMenu(btn: HTMLButtonElement, wrap: HTMLElement): void {
  const menu = wrap.querySelector(".obs-acct__menu") as HTMLElement;
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.left = `${Math.min(r.left, window.innerWidth - 260)}px`;
}

function menuItem(menu: HTMLElement, label: string, onClick: () => void, keyHint = ""): void {
  const item = document.createElement("button");
  item.className = "obs-acct__item";
  item.type = "button";
  item.innerHTML = `<span></span>${keyHint ? `<span class="k"></span>` : ""}`;
  (item.firstChild as HTMLElement).textContent = label;
  if (keyHint) (item.querySelector(".k") as HTMLElement).textContent = keyHint;
  item.onclick = () => {
    closeMenus();
    onClick();
  };
  menu.appendChild(item);
}

function closeMenus(): void {
  document.querySelectorAll(".obs-acct.is-open").forEach((el) => el.classList.remove("is-open"));
}

document.addEventListener("click", closeMenus);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenus();
});

function buildMenu(menu: HTMLElement): void {
  if (!currentUser) {
    const title = document.createElement("div");
    title.className = "obs-acct__menu-title";
    title.textContent = "Account — sign in to sync projects";
    menu.appendChild(title);
    menuItem(menu, "Sign in…", () => void openAuthDialog(false));
    menuItem(menu, "Create account…", () => void openAuthDialog(true));
    menuItem(menu, "Continue with Google", () => {
      void (async () => {
        if (await googleConfigured()) {
          window.location.href = "/api/auth/google/start";
        } else {
          // Explains inside the dialog instead of navigating to a dead end.
          void openAuthDialog(false);
        }
      })();
    });
  } else {
    const title = document.createElement("div");
    title.className = "obs-acct__menu-title";
    title.textContent = `Signed in: ${currentUser.email}`;
    menu.appendChild(title);
    menuItem(menu, "Save current project to cloud", () => void saveCurrentProjectToCloud());
    menuItem(menu, "My cloud projects…", () => void openCloudProjectsDialog());
    menuItem(menu, "Sign out", async () => {
      try {
        await api("/api/auth/logout", { method: "POST" });
        currentUser = null;
        remountAll();
        toast("success", "Signed out. Projects stay on this device.");
      } catch (err) {
        toast("error", err instanceof Error ? err.message : "Sign out failed.");
      }
    });
  }
}

/** Re-render every mounted account button (state changed). */
function remountAll(): void {
  document.querySelectorAll(".obs-acct").forEach((el) => {
    const host = el.parentElement;
    if (host) renderButton(host);
  });
}

// ── dialogs ───────────────────────────────────────────────────────────────

function closeOverlay(overlay: HTMLElement): void {
  overlay.remove();
}

function dialogShell(title: string): { overlay: HTMLElement; body: HTMLElement; close: () => void } {
  const overlay = document.createElement("div");
  overlay.className = "obs-acct-overlay";
  const card = document.createElement("div");
  card.className = "obs-acct-card";
  const head = document.createElement("div");
  head.className = "obs-acct-card__head";
  const h = document.createElement("div");
  h.className = "obs-acct-card__title";
  h.textContent = title;
  const x = document.createElement("button");
  x.className = "obs-acct-card__x";
  x.textContent = "✕";
  x.onclick = () => closeOverlay(overlay);
  head.append(h, x);
  const body = document.createElement("div");
  body.className = "obs-acct-card__body";
  card.append(head, body);
  overlay.appendChild(card);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeOverlay(overlay);
  });
  document.body.appendChild(overlay);
  return { overlay, body, close: () => closeOverlay(overlay) };
}

function field(body: HTMLElement, labelText: string, type: string, autocomplete: string): HTMLInputElement {
  const wrap = document.createElement("div");
  wrap.className = "obs-acct-field";
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = type;
  input.setAttribute("autocomplete", autocomplete);
  input.spellcheck = false;
  wrap.append(label, input);
  body.appendChild(wrap);
  return input;
}

async function openAuthDialog(registerMode: boolean): Promise<void> {
  const { body, close } = dialogShell(registerMode ? "Create your account" : "Sign in");
  let isRegister = registerMode;

  const nameInput = field(body, "Name", "text", "name");
  const emailInput = field(body, "Email", "email", "email");
  const passInput = field(body, "Password", "password", "current-password");
  const err = document.createElement("div");
  err.className = "obs-acct-err";
  const submit = document.createElement("button");
  submit.className = "obs-acct-submit";
  const swap = document.createElement("button");
  swap.className = "obs-acct-swap";
  const google = document.createElement("a");
  google.className = "obs-acct-google";
  google.href = "/api/auth/google/start";
  google.innerHTML =
    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">` +
    `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg><span>Continue with Google</span>`;
  google.addEventListener("click", (e) => {
    e.preventDefault();
    void (async () => {
      if (await googleConfigured()) {
        window.location.href = "/api/auth/google/start";
      } else {
        showGoogleSetupHint(google);
      }
    })();
  });
  const note = document.createElement("div");
  note.className = "obs-acct-note";
  note.textContent = "Your projects are stored in your account's private vault — sign in on any device to open them.";

  function render(): void {
    nameInput.parentElement!.style.display = isRegister ? "" : "none";
    submit.textContent = isRegister ? "Create account" : "Sign in";
    swap.textContent = isRegister
      ? "Already have an account? Sign in"
      : "New here? Create an account";
  }
  swap.onclick = (e) => {
    e.preventDefault();
    isRegister = !isRegister;
    err.textContent = "";
    render();
  };
  async function doSubmit(): Promise<void> {
    submit.disabled = true;
    err.textContent = "";
    try {
      // Friendly pre-flight check — mirrors the server's validEmail rule — so a
      // mistyped value (e.g. "gemini-3.6-flash") gets a helpful inline message
      // instead of a generic "Wrong email or password." from the server.
      const email = emailInput.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
        err.textContent = "Enter a valid email address — for example you@example.com";
        return;
      }
      const payload = isRegister
        ? { email, password: passInput.value, name: nameInput.value }
        : { email, password: passInput.value };
      const res = await api<{ ok: true }>(isRegister ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      void res;
      await refreshAccountState();
      remountAll();
      close();
      toast("success", `Welcome, ${buttonLabel()}! Your projects now sync to your account.`);
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : "Something went wrong.";
    } finally {
      submit.disabled = false;
    }
  }
  submit.onclick = () => void doSubmit();
  passInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void doSubmit();
  });

  body.append(err, submit, swap, google, note);
  render();
  emailInput.focus();
  // If Google isn't configured, surface the amber note immediately so the
  // user knows email sign-in is the working path before clicking anything.
  void googleConfigured().then((ok) => {
    if (!ok && document.contains(google)) showGoogleSetupHint(google);
  });
}

// ── cloud project vault ───────────────────────────────────────────────────

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the project data."));
    reader.readAsDataURL(blob);
  });
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function formatSize(b64: number): string {
  const raw = Math.floor((b64 * 3) / 4);
  if (raw < 1024) return `${raw} B`;
  if (raw < 1024 * 1024) return `${(raw / 1024).toFixed(1)} KB`;
  return `${(raw / 1024 / 1024).toFixed(2)} MB`;
}

/** Serialize the open project (same format as Save to File) and upload it. */
export async function saveCurrentProjectToCloud(): Promise<boolean> {
  if (!currentUser) {
    await openAuthDialog(false);
    return false;
  }
  const cur = getCurrentProject();
  if (!cur) {
    toast("warn", "Open or create a project first.");
    return false;
  }
  try {
    toast("success", "Preparing the project…");
    await saveProject(true); // flush live state into the project database
    const doc = (await store.getProject(cur.id)) ?? cur;
    const blobs = await store.getModelBlobs(cur.id);
    const blob = buildProjectFile(doc, blobs);
    const data = await blobToBase64(blob);
    const res = await api<{ project: { id: string; name: string } }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ id: doc.id, name: doc.name || suggestedFileName(doc), data }),
    });
    toast("success", `Saved "${res.project.name}" to your cloud vault.`);
    return true;
  } catch (err) {
    toast("error", err instanceof Error ? err.message : "Cloud save failed.");
    return false;
  }
}

interface CloudProject {
  id: string;
  name: string;
  updatedAt: number;
  size: number;
}

async function openCloudProjectsDialog(): Promise<void> {
  if (!currentUser) {
    await openAuthDialog(false);
    return;
  }
  const { body, close, overlay } = dialogShell("My cloud projects");
  const saveRow = document.createElement("button");
  saveRow.className = "obs-acct-row--save obs-acct-row";
  saveRow.textContent = "＋ Save current project to cloud";
  saveRow.onclick = async () => {
    const ok = await saveCurrentProjectToCloud();
    if (ok) {
      close();
      setTimeout(() => void openCloudProjectsDialog(), 150);
    }
  };
  body.appendChild(saveRow);
  const list = document.createElement("div");
  list.style.display = "flex";
  list.style.flexDirection = "column";
  list.style.gap = "6px";
  body.appendChild(list);
  const status = document.createElement("div");
  status.className = "obs-acct-empty";
  status.textContent = "Loading…";
  list.appendChild(status);

  let projects: CloudProject[];
  try {
    projects = (await api<{ projects: CloudProject[] }>("/api/projects")).projects;
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : "Could not load your projects.";
    return;
  }
  list.innerHTML = "";
  if (!projects.length) {
    const empty = document.createElement("div");
    empty.className = "obs-acct-empty";
    empty.textContent = "No cloud projects yet. Save the open project to your vault — then open it from any device.";
    list.appendChild(empty);
    return;
  }
  for (const p of projects) {
    const row = document.createElement("div");
    row.className = "obs-acct-row";
    const main = document.createElement("div");
    main.className = "obs-acct-row__main";
    const nm = document.createElement("div");
    nm.className = "obs-acct-row__name";
    nm.textContent = p.name;
    nm.title = p.name;
    const meta = document.createElement("div");
    meta.className = "obs-acct-row__meta";
    meta.textContent = `${new Date(p.updatedAt).toLocaleString()} · ${formatSize(p.size)}`;
    main.append(nm, meta);
    const openBtn = document.createElement("button");
    openBtn.textContent = "Open";
    openBtn.onclick = async () => {
      openBtn.disabled = true;
      try {
        const res = await api<{ data: string }>(`/api/projects/${encodeURIComponent(p.id)}`);
        const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
        const file = new File([bytes], `${p.name}.obsproj`, { type: "application/vnd.openbimstudio.project" });
        close();
        await importProjectFile(file);
        try {
          overlay.remove();
        } catch { /* already closed */ }
      } catch (err) {
        openBtn.disabled = false;
        toast("error", err instanceof Error ? err.message : "Could not open the cloud project.");
      }
    };
    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.className = "danger";
    delBtn.onclick = async () => {
      delBtn.disabled = true;
      try {
        await api(`/api/projects/${encodeURIComponent(p.id)}`, { method: "DELETE" });
        row.remove();
        if (!list.querySelector(".obs-acct-row:not(.obs-acct-row--save)")) {
          const empty = document.createElement("div");
          empty.className = "obs-acct-empty";
          empty.textContent = "No cloud projects left.";
          list.appendChild(empty);
        }
        toast("success", `Deleted "${p.name}" from the cloud.`);
      } catch (err) {
        delBtn.disabled = false;
        toast("error", err instanceof Error ? err.message : "Delete failed.");
      }
    };
    row.append(main, openBtn, delBtn);
    list.appendChild(row);
  }
}

// ── setup ─────────────────────────────────────────────────────────────────

let installed = false;

export function setupCloudAccount(): void {
  if (installed) return;
  installed = true;
  ensureStyle();
  void refreshAccountState();
  try {
    (ctx.features as Record<string, unknown>).cloudAccount = {
      open: () => void openCloudProjectsDialog(),
      save: () => void saveCurrentProjectToCloud(),
      signIn: () => void openAuthDialog(false),
      refresh: () => refreshAccountState(),
    };
  } catch { /* features registry unavailable during early boot */ }
  try {
    registerCommand({ id: "acct.signin", label: "Account — Sign in / Create account", category: "Account", run: () => void openAuthDialog(!currentUser) });
    registerCommand({ id: "acct.projects", label: "Cloud — My projects (open from any device)", category: "Account", run: () => void openCloudProjectsDialog() });
    registerCommand({ id: "acct.save", label: "Cloud — Save current project", category: "Account", run: () => void saveCurrentProjectToCloud() });
  } catch { /* command palette deferred */ }
}
