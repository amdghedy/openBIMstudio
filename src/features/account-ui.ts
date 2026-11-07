/**
 * "Account & cloud projects" dialog: sign in with Google or Microsoft, save the
 * open project to the cloud, and open / delete projects saved from any device.
 * The server (worker/cloud.ts) does all verification; this file is only UI.
 */
import { notify } from "../core/notify";
import { escapeHtml } from "../core/html-escape";
import { AccountClient, AccountError, cloudIdFor, parseAuthFragment, randomNonce, type AccountConfig, type AccountUser } from "./account-client";

const client = new AccountClient();
let panel: HTMLElement | null = null;

const css = {
  wrap: "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center",
  box: "background:#141821;color:#e8eaf0;border:1px solid #2a2e3a;border-radius:10px;padding:18px 20px;width:min(480px,94vw);max-height:86vh;overflow:auto;font:13px system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.6)",
  btn: "padding:7px 14px;border-radius:6px;border:1px solid #2a2e3a;cursor:pointer;background:#1e2430;color:#e8eaf0",
  primary: "padding:7px 14px;border-radius:6px;border:1px solid #2563eb;cursor:pointer;background:#2563eb;color:#fff",
};

export async function openAccountDialog(): Promise<void> {
  if (panel) return;
  const wrap = document.createElement("div");
  wrap.style.cssText = css.wrap;
  const box = document.createElement("div");
  box.style.cssText = css.box;
  box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Account and cloud projects");
  wrap.appendChild(box); document.body.appendChild(wrap); panel = wrap;
  const close = () => { wrap.remove(); panel = null; };
  wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) close(); });
  wrap.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); e.stopPropagation(); });
  box.tabIndex = -1; box.focus();
  await render(box, close);
}

async function render(box: HTMLElement, close: () => void): Promise<void> {
  box.innerHTML = `<div style="opacity:.7">Checking account…</div>`;
  const [cfg, user] = await Promise.all([client.config(), client.me()]);
  if (!panel) return;
  if (!cfg) {
    box.innerHTML = head("Account") + `<p style="line-height:1.5">Accounts are not available on this deployment. They need the Cloudflare edge worker with sign-in configured (see docs/ACCOUNTS.md). Your projects still save in this browser and to <b>.obsproj</b> files.</p>` + foot();
    box.querySelector<HTMLButtonElement>("[data-close]")!.onclick = close;
    return;
  }
  if (!user) return renderSignedOut(box, cfg, close);
  return renderSignedIn(box, cfg, user, close);
}

const head = (t: string) => `<div style="font-weight:700;font-size:15px;margin-bottom:10px">${escapeHtml(t)}</div>`;
const foot = () => `<div style="display:flex;justify-content:flex-end;margin-top:14px"><button data-close style="${css.btn}">Close</button></div>`;

function renderSignedOut(box: HTMLElement, cfg: AccountConfig, close: () => void) {
  const none = !cfg.google && !cfg.microsoft;
  box.innerHTML = head("Sign in") +
    `<p style="line-height:1.5;opacity:.85;margin:0 0 12px">Sign in to save projects to your account and open them from your phone or any other device. Signing in is optional: without it everything keeps working locally.</p>` +
    (none ? `<p style="color:#fca5a5">No sign-in provider is configured on this server yet (see docs/ACCOUNTS.md).</p>` : "") +
    (cfg.google ? `<div id="obs-g" style="min-height:44px;margin:6px 0"></div>` : "") +
    (cfg.microsoft ? `<button data-ms style="${css.btn};width:100%;margin:6px 0">Sign in with Microsoft</button>` : "") +
    (cfg.storage ? "" : `<p style="color:#fbbf24;font-size:12px">Sign-in works, but cloud storage is not enabled on this server, so projects cannot be saved to the cloud yet.</p>`) +
    `<div data-err style="color:#fca5a5;min-height:16px;font-size:12px"></div>` + foot();
  box.querySelector<HTMLButtonElement>("[data-close]")!.onclick = close;
  const err = box.querySelector<HTMLElement>("[data-err]")!;
  const finish = async (p: "google" | "microsoft", cred: string, nonce: string) => {
    try { const u = await client.login(p, cred, nonce); notify("success", `Signed in as ${u.name ?? u.email ?? "your account"}`); window.dispatchEvent(new CustomEvent("obs:account-changed")); await render(box, close); }
    catch (e) { err.textContent = e instanceof Error ? e.message : "Sign-in failed."; }
  };
  if (cfg.google) void mountGoogle(box.querySelector<HTMLElement>("#obs-g")!, cfg.google.clientId, finish, err);
  const ms = box.querySelector<HTMLButtonElement>("[data-ms]");
  if (ms && cfg.microsoft) ms.onclick = () => void microsoftPopup(cfg.microsoft!.clientId, finish, err);
}

/* Google Identity Services: the button is rendered by Google; we only receive a signed ID token. */
async function mountGoogle(host: HTMLElement, clientId: string, finish: (p: "google", c: string, n: string) => void, err: HTMLElement) {
  try {
    await loadScript("https://accounts.google.com/gsi/client");
    const g = (window as any).google?.accounts?.id;
    if (!g) throw new Error("Google sign-in script did not load.");
    const nonce = randomNonce();
    g.initialize({ client_id: clientId, nonce, callback: (r: { credential?: string }) => { if (r?.credential) finish("google", r.credential, nonce); }, auto_select: false });
    g.renderButton(host, { theme: "filled_black", size: "large", text: "signin_with", width: 300 });
  } catch (e) {
    err.textContent = (e instanceof Error ? e.message : "Google sign-in could not load.") + " Check your connection or content blocker.";
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement("script"); s.src = src; s.async = true;
    s.onload = () => res(); s.onerror = () => rej(new Error("Could not load " + new URL(src).host));
    document.head.appendChild(s);
  });
}

/* Microsoft: OpenID Connect implicit flow in a popup; the ID token comes back in the URL fragment. */
function microsoftPopup(clientId: string, finish: (p: "microsoft", c: string, n: string) => void, err: HTMLElement) {
  const nonce = randomNonce(), state = randomNonce();
  const u = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  u.search = new URLSearchParams({
    client_id: clientId, response_type: "id_token", response_mode: "fragment", scope: "openid profile email",
    redirect_uri: location.origin + "/auth-callback.html", nonce, state, prompt: "select_account",
  }).toString();
  const win = window.open(u.toString(), "obs-ms-login", "popup,width=520,height=680");
  if (!win) { err.textContent = "The sign-in window was blocked. Allow pop-ups for this site and try again."; return; }
  const onMsg = (ev: MessageEvent) => {
    if (ev.origin !== location.origin || ev.data?.type !== "obs-auth") return;
    window.removeEventListener("message", onMsg);
    const r = parseAuthFragment(String(ev.data.hash ?? ""));
    if (r.error || !r.idToken || r.state !== state) { err.textContent = r.error ?? "Sign-in was cancelled or could not be verified."; return; }
    finish("microsoft", r.idToken, nonce);
  };
  window.addEventListener("message", onMsg);
}

async function renderSignedIn(box: HTMLElement, cfg: AccountConfig, user: AccountUser, close: () => void) {
  const who = escapeHtml(user.name ?? user.email ?? "Signed in");
  box.innerHTML = head("Account") +
    `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">` +
    (user.picture ? `<img src="${escapeHtml(user.picture)}" alt="" width="36" height="36" referrerpolicy="no-referrer" style="border-radius:50%">` : "") +
    `<div style="flex:1"><div style="font-weight:600">${who}</div><div style="opacity:.65;font-size:12px">${escapeHtml(user.email ?? "")} · ${user.provider === "google" ? "Google" : "Microsoft"}</div></div>` +
    `<button data-out style="${css.btn}">Sign out</button></div>` +
    `<div style="display:flex;gap:8px;margin-bottom:10px"><button data-save style="${css.primary}" ${cfg.storage ? "" : "disabled"}>Save open project to cloud</button><button data-refresh style="${css.btn}">Refresh</button></div>` +
    (cfg.storage ? "" : `<p style="color:#fbbf24;font-size:12px">Cloud storage is not enabled on this server (docs/ACCOUNTS.md).</p>`) +
    `<div data-err style="color:#fca5a5;min-height:16px;font-size:12px"></div><div data-list style="margin-top:6px"></div>` + foot();
  const q = <T extends HTMLElement>(s: string) => box.querySelector<T>(s)!;
  q("[data-close]").onclick = close;
  const err = q("[data-err]");
  const fail = (e: unknown) => { err.textContent = e instanceof Error ? e.message : String(e); };
  q("[data-out]").onclick = async () => { try { await client.logout(); notify("info", "Signed out."); window.dispatchEvent(new CustomEvent("obs:account-changed")); await render(box, close); } catch (e) { fail(e); } };
  const refresh = async () => { err.textContent = ""; await renderList(q("[data-list]"), cfg.storage, fail, close); };
  q("[data-refresh]").onclick = () => void refresh();
  q("[data-save]").onclick = async () => { err.textContent = ""; try { await saveOpenProjectToCloud(); await refresh(); } catch (e) { fail(e); } };
  await refresh();
}

async function renderList(host: HTMLElement, storage: boolean, fail: (e: unknown) => void, close: () => void) {
  if (!storage) { host.innerHTML = ""; return; }
  host.innerHTML = `<div style="opacity:.7">Loading your projects…</div>`;
  try {
    const items = await client.list();
    if (!items.length) { host.innerHTML = `<div style="opacity:.7;line-height:1.5">No cloud projects yet. Open a project and choose “Save open project to cloud”.</div>`; return; }
    host.innerHTML = items.map((p) => `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid #2a2e3a">
      <div style="flex:1;min-width:0"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.name)}</div>
      <div style="opacity:.6;font-size:12px">${new Date(p.updatedAt).toLocaleString()} · ${(p.size / 1048576).toFixed(p.size < 1048576 ? 2 : 1)} MB</div></div>
      <button data-open="${escapeHtml(p.id)}" style="${css.primary}">Open</button>
      <button data-del="${escapeHtml(p.id)}" data-nm="${escapeHtml(p.name)}" style="${css.btn}" aria-label="Delete ${escapeHtml(p.name)}">Delete</button></div>`).join("");
    host.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((b) => b.onclick = async () => {
      try { b.disabled = true; await openCloudProject(b.dataset.open!); close(); } catch (e) { b.disabled = false; fail(e); }
    });
    host.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) => b.onclick = async () => {
      const { confirmDialog } = await import("./form-modal");
      if (!(await confirmDialog("Delete cloud project", `Delete "${b.dataset.nm}" from your account? Copies on your devices are not affected.`))) return;
      try { await client.remove(b.dataset.del!); await renderList(host, storage, fail, close); } catch (e) { fail(e); }
    });
  } catch (e) { host.innerHTML = ""; fail(e); }
}

export async function saveOpenProjectToCloud(): Promise<void> {
  const io = await import("../modules/projects/project-file-io");
  const snap = await io.buildOpenProjectBlob();
  if (!snap) { notify("warn", "Open or create a project first."); return; }
  const id = cloudIdFor(snap.id);
  if (!id) throw new AccountError("This project's id cannot be used in the cloud.");
  try {
    const r = await client.save(id, snap.name, snap.blob);
    notify("success", `Saved "${r.name}" to your account (${(r.size / 1048576).toFixed(1)} MB).`);
  } catch (e) {
    if (e instanceof AccountError && e.conflict) {
      const { confirmDialog } = await import("./form-modal");
      if (await confirmDialog("Changed on another device", "This project was saved from another device after you last opened it.\n\nConfirm = overwrite the cloud copy with this one.\nCancel = keep the cloud copy (open it from the list instead).")) {
        const r = await client.save(id, snap.name, snap.blob, { overwrite: true });
        notify("success", `Saved "${r.name}" to your account.`);
      }
      return;
    }
    throw e;
  }
}

export async function openCloudProject(id: string): Promise<void> {
  const { blob, name } = await client.open(id);
  const io = await import("../modules/projects/project-file-io");
  const ok = await io.importProjectFile(blob);
  if (!ok) notify("info", `Did not open "${name}".`);
}
