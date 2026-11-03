/**
 * Keyboard Shortcuts window (type KS). Lists every command, lets the user assign, change or clear a
 * shortcut for each, warns about conflicts and persists the choices (localStorage).
 *
 * Command sources: built-in registry shortcuts (re-bound in place), command-palette commands,
 * BIM-experience commands and Modify actions (user shortcuts are added to the registry).
 */
import { shortcuts } from "./shortcuts";
import { confirmDialog } from "./form-modal";
import { listCommands } from "./command-palette";
import { listBimCommands, executeBimCommand } from "./bim-experience";
import { listModifyActions, runModifyAction } from "./modify-actions";
import { normalizeKeys, prettyKeys, comboFromEvent, findConflict } from "../modules/shortcuts/shortcut-keys";

const STORE = "obs.user-shortcuts.v1";
type Store = Record<string, string>; // commandKey -> keys ("" = explicitly cleared)
let store: Store = {};
const defaults = new Map<string, string>(); // registry id -> original keys

function load(): void { try { store = JSON.parse(localStorage.getItem(STORE) || "{}") || {}; } catch { store = {}; } }
function save(): void { try { localStorage.setItem(STORE, JSON.stringify(store)); } catch { /* */ } }
const toast = (message: string, kind = "info") => window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } }));

interface Row { key: string; label: string; category: string; kind: "reg" | "pal" | "bim" | "mod"; id: string; builtin: string }

function collect(): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  const add = (r: Row) => { const sig = r.label.trim().toLowerCase(); if (seen.has(sig)) return; seen.add(sig); rows.push(r); };
  for (const s of shortcuts.list()) {
    if (s.id.startsWith("user:")) continue;
    if (!defaults.has(s.id)) defaults.set(s.id, s.keys);
    add({ key: `reg:${s.id}`, label: s.label.replace(/\s*\(BIM [A-Z]+\)/, ""), category: s.category, kind: "reg", id: s.id, builtin: defaults.get(s.id)! });
  }
  for (const m of listModifyActions()) add({ key: `mod:${m.id}`, label: m.label, category: "modify", kind: "mod", id: m.id, builtin: "" });
  for (const c of listBimCommands()) add({ key: `bim:${c.id}`, label: c.label, category: c.ribbon ?? "command", kind: "bim", id: c.id, builtin: "" });
  for (const c of listCommands()) add({ key: `pal:${c.id}`, label: c.label, category: c.category ?? "command", kind: "pal", id: c.id, builtin: "" });
  return rows.sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
}

function run(kind: Row["kind"], id: string): void {
  try {
    if (kind === "pal") void listCommands().find((c) => c.id === id)?.run();
    else if (kind === "bim") executeBimCommand(id);
    else if (kind === "mod") void runModifyAction(id as any);
  } catch (e) { console.warn("[shortcut-editor] command failed", id, e); }
}

/** Effective keys of a row (user choice wins over the built-in). */
function effective(r: Row): string { return r.key in store ? store[r.key] : r.builtin; }

/** Push the stored choices into the live registry. */
export function applyUserShortcuts(): void {
  for (const [key, keys] of Object.entries(store)) {
    const [kind, ...rest] = key.split(":"); const id = rest.join(":");
    if (kind === "reg") {
      const s = shortcuts.get(id);
      if (s) { if (!defaults.has(id)) defaults.set(id, s.keys); shortcuts.setKeys(id, keys || "none:" + id); }
    } else {
      shortcuts.unregister(`user:${key}`);
      if (keys) shortcuts.register({ id: `user:${key}`, label: key, keys, category: "app", handler: () => run(kind as Row["kind"], id) });
    }
  }
}

function assign(row: Row, keys: string): void {
  if (keys === row.builtin && row.kind === "reg") delete store[row.key];
  else if (!keys && !row.builtin) delete store[row.key];
  else store[row.key] = keys;
  if (row.kind !== "reg") shortcuts.unregister(`user:${row.key}`);
  if (row.kind === "reg") { const s = shortcuts.get(row.id); if (s) s.keys = keys || "none:" + row.id; }
  else if (keys) shortcuts.register({ id: `user:${row.key}`, label: row.label, keys, category: "app", handler: () => run(row.kind, row.id) });
  save();
}

let host: HTMLDivElement | null = null;

export function closeShortcutEditor(): void { host?.remove(); host = null; }

export function openShortcutEditor(): void {
  if (host) { host.querySelector<HTMLInputElement>("input[data-search]")?.focus(); return; }
  load();
  let rows = collect();
  const eff = () => { const m: Record<string, string> = {}; for (const r of rows) { const k = effective(r); if (k) m[r.key] = k; } return m; };

  host = document.createElement("div");
  host.id = "obs-shortcut-editor";
  host.setAttribute("data-obs-ui", "1");
  host.style.cssText = "position:fixed;inset:0;z-index:9700;display:flex;align-items:center;justify-content:center;background:rgba(8,9,12,.55)";
  host.onmousedown = (e) => { if (e.target === host) closeShortcutEditor(); };
  const card = document.createElement("div");
  card.style.cssText = "width:min(720px,94vw);max-height:84vh;display:flex;flex-direction:column;background:#1c1e28;color:#e8eaf0;border:1px solid #2a2e3a;border-radius:10px;box-shadow:0 24px 60px rgba(0,0,0,.65);font:13px system-ui,sans-serif";
  card.innerHTML =
    "<div style='display:flex;align-items:center;padding:14px 18px;border-bottom:1px solid #2a2e3a;background:#181a23;border-radius:10px 10px 0 0'>" +
    "<div style='flex:1'><div style='font-weight:700;font-size:15px'>Keyboard Shortcuts</div>" +
    "<div style='font-size:11px;color:#94a3b8;margin-top:2px'>Click a shortcut box, then type 1–3 letters (e.g. WA) or press a combination (e.g. Ctrl+Shift+K). Enter saves, Backspace clears, Esc cancels.</div></div></div>";
  const close = document.createElement("button");
  close.textContent = "✕"; close.style.cssText = "margin-left:10px;width:28px;height:28px;border-radius:4px;background:transparent;color:#94a3b8;border:1px solid #2a2e3a;cursor:pointer";
  close.onclick = closeShortcutEditor;
  card.firstElementChild!.appendChild(close);

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;padding:10px 18px;border-bottom:1px solid #242734";
  const search = document.createElement("input");
  search.setAttribute("data-search", "1"); search.placeholder = "Search commands…";
  search.style.cssText = "flex:1;padding:6px 10px;background:#12141b;border:1px solid #3a4050;border-radius:5px;color:#e8eaf0";
  const resetAll = document.createElement("button");
  resetAll.textContent = "Reset all"; resetAll.style.cssText = "padding:6px 12px;background:transparent;color:#cbd5e1;border:1px solid #3a4050;border-radius:5px;cursor:pointer";
  bar.append(search, resetAll);
  const msg = document.createElement("div");
  msg.style.cssText = "padding:0 18px;min-height:18px;font-size:11.5px;color:#fbbf24";
  const list = document.createElement("div");
  list.style.cssText = "overflow:auto;padding:4px 18px 14px";
  card.append(bar, msg, list);
  host.appendChild(card);
  document.body.appendChild(host);

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = "";
    let cat = "";
    for (const r of rows) {
      if (q && !(r.label.toLowerCase().includes(q) || r.category.toLowerCase().includes(q) || effective(r).includes(q))) continue;
      if (r.category !== cat) { cat = r.category; const h = document.createElement("div"); h.textContent = cat.toUpperCase(); h.style.cssText = "font-size:10px;letter-spacing:.5px;color:#64748b;margin:12px 0 2px"; list.appendChild(h); }
      const line = document.createElement("div");
      line.style.cssText = "display:grid;grid-template-columns:1fr 150px 56px;gap:10px;align-items:center;padding:4px 0;border-bottom:1px solid #242734";
      const name = document.createElement("span"); name.textContent = r.label;
      const box = document.createElement("input");
      box.readOnly = true; box.placeholder = "Not assigned";
      box.value = prettyKeys(effective(r).startsWith("none:") ? "" : effective(r));
      box.style.cssText = "padding:4px 8px;background:#12141b;border:1px solid #3a4050;border-radius:4px;color:#cbd5e1;font:11.5px ui-monospace,monospace;text-align:center;cursor:pointer";
      let draft = "";
      box.onfocus = () => { draft = ""; box.value = ""; box.placeholder = "Type keys…"; box.style.borderColor = "#38bdf8"; };
      box.onblur = () => { box.style.borderColor = "#3a4050"; box.placeholder = "Not assigned"; box.value = prettyKeys(effective(r).startsWith("none:") ? "" : effective(r)); };
      box.onkeydown = async (e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); box.blur(); return; }
        if (e.key === "Tab") return;
        if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); draft = ""; box.value = ""; return; }
        if (e.key === "Enter") {
          e.preventDefault();
          if (!draft) { assign(r, ""); msg.textContent = `Cleared the shortcut for "${r.label}".`; rows = collect(); draw(); return; }
          const keys = normalizeKeys(draft);
          if (!keys) { msg.textContent = "That is not a valid shortcut."; return; }
          const other = findConflict(eff(), r.key, keys);
          if (other) {
            const o = rows.find((x) => x.key === other)!;
            if (!(await confirmDialog("Shortcut conflict", `"${prettyKeys(keys)}" is already used by "${o.label}". Reassign it to "${r.label}"?`))) return;
            assign(o, "");
          }
          assign(r, keys);
          msg.textContent = `"${r.label}" → ${prettyKeys(keys)}`;
          rows = collect(); draw();
          return;
        }
        e.preventDefault();
        const combo = comboFromEvent(e);
        if (!combo) return;
        if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[a-z]$/i.test(e.key)) {
          draft = (draft.length >= 3 || draft.includes("+") ? "" : draft) + e.key.toLowerCase();
        } else draft = combo;
        box.value = prettyKeys(draft);
      };
      const reset = document.createElement("button");
      reset.textContent = "Reset"; reset.title = "Back to the built-in shortcut";
      reset.style.cssText = "padding:3px 6px;background:transparent;color:#94a3b8;border:1px solid #2a2e3a;border-radius:4px;cursor:pointer;font-size:11px;visibility:" + (r.key in store ? "visible" : "hidden");
      reset.onclick = () => {
        const wasKeys = r.builtin;
        delete store[r.key]; save();
        if (r.kind === "reg") shortcuts.setKeys(r.id, wasKeys); else shortcuts.unregister(`user:${r.key}`);
        rows = collect(); draw();
      };
      line.append(name, box, reset);
      list.appendChild(line);
    }
    if (!list.firstChild) list.textContent = "No commands match.";
  };
  search.oninput = draw;
  resetAll.onclick = async () => {
    if (!(await confirmDialog("Reset shortcuts", "Reset every shortcut to its built-in value?"))) return;
    for (const key of Object.keys(store)) {
      const [kind, ...rest] = key.split(":"); const id = rest.join(":");
      if (kind === "reg") { const d = defaults.get(id); if (d != null) shortcuts.setKeys(id, d); } else shortcuts.unregister(`user:${key}`);
    }
    store = {}; save(); rows = collect(); draw(); msg.textContent = "All shortcuts reset.";
  };
  host.addEventListener("keydown", (e) => { if (e.key === "Escape" && e.target === search) closeShortcutEditor(); });
  draw();
  search.focus();
}

export function setupShortcutEditor(): void {
  load();
  shortcuts.register({ id: "app-shortcut-editor", label: "Keyboard shortcuts (assign)", keys: "ks", category: "app", handler: () => openShortcutEditor() });
  collect(); // remember built-in defaults before any override is applied
  applyUserShortcuts();
  // Modules register their shortcuts at different times: re-apply once everything has booted.
  window.setTimeout(() => { collect(); applyUserShortcuts(); }, 4000);
  try { (window as any).__obsShortcutEditor = { open: openShortcutEditor, close: closeShortcutEditor }; } catch { /* */ }
}
