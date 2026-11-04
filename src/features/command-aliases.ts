/**
 * AutoCAD-style command aliases (abbreviations).
 *
 * Type KS or ALIASEDIT to open the editor. Aliases are stored in localStorage
 * and applied on top of the built-in CAD_COMMANDS list.
 */
import { confirmDialog } from "./form-modal";

const STORE = "obs.cad-command-aliases.v1";

/** alias (uppercase) → command name (uppercase) */
type AliasMap = Record<string, string>;

let map: AliasMap = {};

export function loadCadAliases(): void {
  try {
    map = JSON.parse(localStorage.getItem(STORE) || "{}") || {};
  } catch {
    map = {};
  }
}

export function saveCadAliases(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(map));
  } catch {
    /* */
  }
}

export function getCadAliasMap(): AliasMap {
  return { ...map };
}

/** Register one alias → command (replaces any previous use of that alias). */
export function setCadAlias(alias: string, command: string): void {
  const a = alias.trim().toUpperCase();
  const c = command.trim().toUpperCase();
  if (!a || !c) return;
  // Remove this alias from any other command first
  for (const [k, v] of Object.entries(map)) {
    if (k === a || (v === c && k === a)) delete map[k];
  }
  map[a] = c;
  saveCadAliases();
}

export function clearCadAlias(alias: string): void {
  delete map[alias.trim().toUpperCase()];
  saveCadAliases();
}

export function resetCadAliases(): void {
  map = {};
  saveCadAliases();
}

/**
 * Resolve a typed token to a canonical command name using user aliases first,
 * then the provided built-in command definitions.
 */
export function resolveCadToken(
  token: string,
  builtins: ReadonlyArray<{ name: string; aliases: string[] }>,
): string {
  const t = token.trim().toUpperCase();
  if (!t) return t;
  if (map[t]) return map[t];
  // Also: user may have stored command name as key by mistake — ignore
  for (const [alias, cmd] of Object.entries(map)) {
    if (cmd === t) return cmd;
  }
  const hit = builtins.find(
    (c) => c.name === t || c.aliases.some((a) => a.toUpperCase() === t),
  );
  return hit?.name ?? t;
}

/** Effective aliases for a command (user overrides + builtins, unique). */
export function effectiveAliases(
  commandName: string,
  builtinAliases: string[],
): string[] {
  const name = commandName.toUpperCase();
  const user = Object.entries(map)
    .filter(([, cmd]) => cmd === name)
    .map(([a]) => a);
  const set = new Set<string>([...user, ...builtinAliases.map((a) => a.toUpperCase())]);
  set.delete(name);
  return [...set];
}

let host: HTMLDivElement | null = null;

export type AliasRow = { name: string; aliases: string[]; description: string };

/**
 * Open the AutoCAD-style alias editor.
 * @param commands full command list from the CAD editor
 * @param onApply called after save so the host can refresh autocomplete
 */
export function openCadAliasEditor(
  commands: AliasRow[],
  onApply?: () => void,
): void {
  loadCadAliases();
  if (host) {
    host.remove();
    host = null;
  }

  host = document.createElement("div");
  host.id = "obs-cad-alias-editor";
  host.setAttribute("data-obs-ui", "1");
  host.style.cssText =
    "position:fixed;inset:0;z-index:9800;display:flex;align-items:center;justify-content:center;" +
    "background:rgba(8,9,12,.55)";
  host.onmousedown = (e) => {
    if (e.target === host) closeCadAliasEditor();
  };

  const card = document.createElement("div");
  card.style.cssText =
    "width:min(640px,94vw);max-height:86vh;display:flex;flex-direction:column;" +
    "background:#1c1e28;color:#e8eaf0;border:1px solid #2a2e3a;border-radius:10px;" +
    "box-shadow:0 24px 60px rgba(0,0,0,.65);font:13px system-ui,sans-serif";

  card.innerHTML =
    `<div style="display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid #2a2e3a;background:#181a23;border-radius:10px 10px 0 0">` +
    `<div style="flex:1"><div style="font-weight:700;font-size:15px">Command Aliases <span style="color:#38bdf8;font-weight:600">(KS)</span></div>` +
    `<div style="font-size:11px;color:#94a3b8;margin-top:2px">AutoCAD-style abbreviations — edit the alias, then Save. Example: L → LINE, C → CIRCLE.</div></div>` +
    `<button type="button" data-close style="width:28px;height:28px;border-radius:4px;background:transparent;color:#94a3b8;border:1px solid #2a2e3a;cursor:pointer">✕</button></div>`;

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;padding:10px 16px;border-bottom:1px solid #242734";
  const search = document.createElement("input");
  search.placeholder = "Search command or alias…";
  search.style.cssText =
    "flex:1;padding:6px 10px;background:#12141b;border:1px solid #3a4050;border-radius:5px;color:#e8eaf0";
  bar.appendChild(search);

  const list = document.createElement("div");
  list.style.cssText = "flex:1;overflow:auto;padding:8px 12px";

  const foot = document.createElement("div");
  foot.style.cssText =
    "display:flex;gap:8px;justify-content:flex-end;padding:10px 16px;border-top:1px solid #2a2e3a";
  const btnCss =
    "padding:7px 14px;border-radius:6px;border:1px solid #3a4050;background:#2a2e3a;color:#e8eaf0;cursor:pointer;font:600 12px system-ui";
  const resetBtn = document.createElement("button");
  resetBtn.textContent = "Reset defaults";
  resetBtn.style.cssText = btnCss;
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.style.cssText =
    "padding:7px 16px;border-radius:6px;border:1px solid #0284c7;background:#0369a1;color:#fff;cursor:pointer;font:600 12px system-ui";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  closeBtn.style.cssText = btnCss;
  foot.append(resetBtn, saveBtn, closeBtn);

  // Working copy: command → primary alias (first / preferred)
  const draft: Record<string, string> = {};
  for (const c of commands) {
    const eff = effectiveAliases(c.name, c.aliases);
    draft[c.name.toUpperCase()] = (eff[0] || c.aliases[0] || "").toUpperCase();
  }

  function render(): void {
    const q = search.value.trim().toUpperCase();
    list.innerHTML = "";
    const header = document.createElement("div");
    header.style.cssText =
      "display:grid;grid-template-columns:1fr 120px 1.2fr;gap:8px;padding:4px 6px;font-size:10px;color:#64748b;font-weight:700;letter-spacing:.4px";
    header.innerHTML = "<span>COMMAND</span><span>ALIAS</span><span>DESCRIPTION</span>";
    list.appendChild(header);

    for (const c of commands) {
      const name = c.name.toUpperCase();
      const alias = draft[name] || "";
      if (q && !name.includes(q) && !alias.includes(q) && !(c.description || "").toUpperCase().includes(q)) {
        continue;
      }
      const row = document.createElement("div");
      row.style.cssText =
        "display:grid;grid-template-columns:1fr 120px 1.2fr;gap:8px;align-items:center;padding:6px;border-radius:6px";
      row.onmouseenter = () => {
        row.style.background = "#242734";
      };
      row.onmouseleave = () => {
        row.style.background = "transparent";
      };

      const nameEl = document.createElement("div");
      nameEl.style.cssText = "font-weight:600;font-family:var(--font-mono,monospace);font-size:12px";
      nameEl.textContent = name;

      const input = document.createElement("input");
      input.value = alias;
      input.maxLength = 12;
      input.style.cssText =
        "width:100%;box-sizing:border-box;padding:5px 8px;background:#0e1017;border:1px solid #3a4050;" +
        "border-radius:4px;color:#38bdf8;font:600 12px var(--font-mono,monospace);text-transform:uppercase";
      input.oninput = () => {
        draft[name] = input.value.replace(/[^a-z0-9]/gi, "").toUpperCase();
        input.value = draft[name];
      };

      const desc = document.createElement("div");
      desc.style.cssText = "font-size:11px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      desc.title = c.description || "";
      desc.textContent = c.description || "";

      row.append(nameEl, input, desc);
      list.appendChild(row);
    }
  }

  search.oninput = () => render();
  render();

  saveBtn.onclick = () => {
    // Rebuild map from draft: only non-empty aliases
    const next: AliasMap = {};
    const used = new Set<string>();
    for (const c of commands) {
      const name = c.name.toUpperCase();
      const a = (draft[name] || "").trim().toUpperCase();
      if (!a) continue;
      if (used.has(a) && next[a] !== name) {
        window.dispatchEvent(
          new CustomEvent("obs-toast", {
            detail: { message: `Alias "${a}" is used more than once — kept for ${next[a] || name}`, kind: "warn" },
          }),
        );
        continue;
      }
      next[a] = name;
      used.add(a);
    }
    map = next;
    saveCadAliases();
    onApply?.();
    window.dispatchEvent(
      new CustomEvent("obs-toast", { detail: { message: "Command aliases saved", kind: "success" } }),
    );
    closeCadAliasEditor();
  };

  resetBtn.onclick = async () => {
    const ok = await confirmDialog(
      "Reset aliases",
      "Clear all custom abbreviations and restore built-in AutoCAD-style defaults?",
    );
    if (!ok) return;
    resetCadAliases();
    for (const c of commands) {
      draft[c.name.toUpperCase()] = (c.aliases[0] || "").toUpperCase();
    }
    render();
    onApply?.();
    window.dispatchEvent(
      new CustomEvent("obs-toast", { detail: { message: "Aliases reset to defaults", kind: "info" } }),
    );
  };

  closeBtn.onclick = () => closeCadAliasEditor();
  card.querySelector("[data-close]")?.addEventListener("click", () => closeCadAliasEditor());

  card.append(bar, list, foot);
  host.appendChild(card);
  document.body.appendChild(host);
  search.focus();
}

export function closeCadAliasEditor(): void {
  host?.remove();
  host = null;
}

/** Open alias editor if CAD commands are available, else keyboard shortcuts. */
let cadAliasEditorOpener: (() => void) | null = null;

/** Register the active drawing's alias editor without adding a window global. */
export function registerCadAliasEditorOpener(opener: () => void): () => void {
  cadAliasEditorOpener = opener;
  return () => {
    if (cadAliasEditorOpener === opener) cadAliasEditorOpener = null;
  };
}

export function openKs(): void {
  loadCadAliases();
  if (cadAliasEditorOpener) {
    cadAliasEditorOpener();
    return;
  }
  void import("./shortcut-editor").then((m) => m.openShortcutEditor());
}

export function setupCommandAliases(): void {
  loadCadAliases();
  try {
    void import("./shortcuts").then(({ shortcuts }) => {
      shortcuts.register({
        id: "app-ks-aliases",
        label: "Command aliases / shortcuts (KS)",
        keys: "ks",
        category: "app",
        handler: () => openKs(),
      });
    });
  } catch {
    /* */
  }
  console.log("[aliases] KS / command abbreviations ready");
}
