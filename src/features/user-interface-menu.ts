/**
 * User Interface dropdown menu — the BIM-style panel toggle menu.
 *
 * Renders a floating dropdown below the ribbon button. Each row is a
 * checkbox bound to a UiItem from modules/ui-registry. Two footer items
 * (Browser Organization, Keyboard Shortcuts) open small dialogs.
 */

import { ctx } from "../core/context";
import {
  listUiItems, loadStoredVisibility, persistItem,
  onUiRegistryChange, notifyUiChange,
} from "../modules/ui-registry";

let menuEl: HTMLDivElement | null = null;
let anchorEl: HTMLElement | null = null;
let open = false;

const SVG_NS = "http://www.w3.org/2000/svg";

function buildMenu(): HTMLDivElement {
  const el = document.createElement("div");
  el.id = "obs-user-interface-menu";
  el.style.cssText =
    "position:fixed;z-index:9500;display:none;min-width:280px;" +
    "background:#1c1e28;color:#e8eaf0;border:1px solid #2a2e3a;" +
    "border-radius:6px;box-shadow:0 18px 46px rgba(0,0,0,.55);" +
    "font:12px system-ui,sans-serif;padding:4px 0;user-select:none";
  el.onmousedown = (e) => e.stopPropagation();
  document.body.appendChild(el);
  return el;
}

function closeMenu(): void {
  if (!menuEl) return;
  menuEl.style.display = "none";
  open = false;
  anchorEl = null;
}

function positionMenu(anchor: HTMLElement): void {
  if (!menuEl) return;
  const rect = anchor.getBoundingClientRect();
  const menuW = menuEl.offsetWidth || 280;
  let x = rect.left;
  let y = rect.bottom + 4;
  if (x + menuW > window.innerWidth - 8) x = window.innerWidth - menuW - 8;
  if (y + 380 > window.innerHeight - 8) y = rect.top - 380 - 4;
  menuEl.style.left = x + "px";
  menuEl.style.top = y + "px";
}

function renderRows(): void {
  if (!menuEl) return;
  menuEl.innerHTML = "";

  const stored = loadStoredVisibility();
  const items = listUiItems();

  for (const item of items) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:6px 14px;cursor:pointer;" +
      (item.available ? "" : "opacity:.4;cursor:default;");

    const cb = document.createElement("span");
    cb.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;" +
      "width:14px;height:14px;border:1px solid #4b5563;border-radius:3px;" +
      "background:transparent;flex:none;color:#0b0d12;font-weight:700;font-size:11px";

    const visible = item.available
      ? item.isVisible()
      : (stored[item.id] ?? false);
    if (visible) {
      cb.style.background = "#38bdf8";
      cb.style.borderColor = "#38bdf8";
      cb.textContent = "\u2713";
    }

    const label = document.createElement("span");
    label.textContent = item.label;
    label.style.cssText = "flex:1;font-size:12.5px";

    row.append(cb, label);

    if (item.available) {
      row.onmouseenter = () => { row.style.background = "rgba(56,189,248,.14)"; };
      row.onmouseleave = () => { row.style.background = "transparent"; };
      row.onclick = () => {
        try {
          item.toggle();
          persistItem(item.id, item.isVisible());
        } catch (err) {
          console.error("[ui-menu] toggle failed", item.id, err);
        }
        renderRows();
      };
    } else {
      row.title = item.unavailableHint ?? "Coming soon";
      row.onmouseenter = () => { row.style.background = "transparent"; };
    }

    menuEl.appendChild(row);
  }

  // Separator
  const sep1 = document.createElement("div");
  sep1.style.cssText = "height:1px;background:#2a2e3a;margin:4px 0";
  menuEl.appendChild(sep1);

  // Footer: Browser Organization
  const bo = mkFooterRow("\u2630", "Browser Organization", () => {
    closeMenu();
    openBrowserOrganizationDialog();
  });
  menuEl.appendChild(bo);

  // Footer: Keyboard Shortcuts
  const ks = mkFooterRow("\u2328", "Keyboard Shortcuts", () => {
    closeMenu();
    openKeyboardShortcutsDialog();
  });
  menuEl.appendChild(ks);
}

function mkFooterRow(icon: string, label: string, onClick: () => void): HTMLElement {
  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:7px 14px;cursor:pointer";
  const ic = document.createElement("span");
  ic.textContent = icon;
  ic.style.cssText = "width:16px;text-align:center;font-size:14px;color:#94a3b8";
  const tx = document.createElement("span");
  tx.textContent = label;
  tx.style.cssText = "flex:1;font-size:12.5px";
  row.append(ic, tx);
  row.onmouseenter = () => { row.style.background = "rgba(56,189,248,.14)"; };
  row.onmouseleave = () => { row.style.background = "transparent"; };
  row.onclick = (e) => { e.stopPropagation(); onClick(); };
  return row;
}

export function toggleUserInterfaceMenu(anchor: HTMLElement): void {
  if (open && anchorEl === anchor) {
    closeMenu();
    return;
  }
  if (!menuEl) menuEl = buildMenu();
  anchorEl = anchor;
  renderRows();
  menuEl.style.display = "block";
  positionMenu(anchor);
  open = true;

  setTimeout(() => {
    const docHandler = (ev: MouseEvent) => {
      if (!menuEl) return;
      const t = ev.target as Node;
      if (!menuEl.contains(t) && !anchor.contains(t)) {
        closeMenu();
        document.removeEventListener("mousedown", docHandler);
      }
    };
    document.addEventListener("mousedown", docHandler);
  }, 0);
}

export function setupUserInterfaceMenu(): void {
  // Re-render on external visibility changes
  onUiRegistryChange(() => { if (open) renderRows(); });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) closeMenu();
  });

  (ctx.features as any).userInterfaceMenu = {
    toggle: (anchor: HTMLElement) => toggleUserInterfaceMenu(anchor),
    close: closeMenu,
    isOpen: () => open,
    refresh: () => { if (open) renderRows(); notifyUiChange(); },
  };
}

/* ══════════════════════════════════════════════════════════════════════
   Browser Organization dialog
   ══════════════════════════════════════════════════════════════════════ */

function openBrowserOrganizationDialog(): void {
  showModal("Browser Organization", [
    ["Group by", "Category \u00B7 Level \u00B7 Type"],
    ["Sort by", "Name (alphabetical)"],
    ["Filter", "None"],
  ], "Controls how views, sheets, and schedules are grouped in the Project Browser.");
}

/* ══════════════════════════════════════════════════════════════════════
   Keyboard Shortcuts dialog
   ══════════════════════════════════════════════════════════════════════ */

function openKeyboardShortcutsDialog(): void {
  const shortcuts: Array<[string, string]> = [
    ["Ctrl + S", "Save project"],
    ["Ctrl + O", "Open file"],
    ["Ctrl + P", "Command palette"],
    ["Ctrl + Z", "Undo"],
    ["Ctrl + Y", "Redo"],
    ["Ctrl + A", "Select all"],
    ["F5", "Run clash test"],
    ["WA", "Wall tool"],
    ["SL", "Slab tool"],
    ["CM", "Column tool"],
    ["DR", "Door tool"],
    ["WN", "Window tool"],
    ["Esc", "Cancel current command"],
    ["Space", "Repeat last command"],
    ["Delete", "Delete selection"],
  ];
  showShortcutsTable(shortcuts);
}

/* ══════════════════════════════════════════════════════════════════════
   Generic modal helpers
   ══════════════════════════════════════════════════════════════════════ */

function ensureOverlay(): HTMLDivElement {
  let ov = document.getElementById("obs-ui-modal") as HTMLDivElement | null;
  if (ov) {
    ov.style.display = "flex";
    ov.innerHTML = "";
    return ov;
  }
  ov = document.createElement("div");
  ov.id = "obs-ui-modal";
  ov.style.cssText =
    "position:fixed;inset:0;z-index:9600;display:flex;align-items:center;" +
    "justify-content:center;background:rgba(8,9,12,.6);backdrop-filter:blur(4px)";
  ov.onmousedown = (e) => { if (e.target === ov) { ov!.style.display = "none"; } };
  document.body.appendChild(ov);
  return ov;
}

function showModal(title: string, rows: [string, string][], subtitle: string): void {
  const ov = ensureOverlay();
  const card = document.createElement("div");
  card.style.cssText =
    "width:min(520px,92vw);background:#1c1e28;color:#e8eaf0;" +
    "border:1px solid #2a2e3a;border-radius:10px;" +
    "box-shadow:0 24px 60px rgba(0,0,0,.65);font:13px system-ui,sans-serif;" +
    "overflow:hidden";

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;padding:14px 18px;" +
    "border-bottom:1px solid #2a2e3a;background:#181a23";
  header.innerHTML =
    "<div style='flex:1'>" +
      "<div style='font-weight:700;font-size:15px'>" + esc(title) + "</div>" +
      "<div style='font-size:11px;color:#94a3b8;margin-top:2px'>" + esc(subtitle) + "</div>" +
    "</div>";

  const close = document.createElement("button");
  close.textContent = "\u2715";
  close.style.cssText =
    "width:28px;height:28px;border-radius:4px;background:transparent;color:#94a3b8;" +
    "border:1px solid #2a2e3a;cursor:pointer;font-size:13px";
  close.onclick = () => { ov.style.display = "none"; };
  header.appendChild(close);

  const body = document.createElement("div");
  body.style.cssText = "padding:14px 18px";
  for (const [k, v] of rows) {
    const r = document.createElement("div");
    r.style.cssText =
      "display:grid;grid-template-columns:140px 1fr;gap:12px;" +
      "padding:8px 0;border-bottom:1px solid #242734";
    const kk = document.createElement("span");
    kk.textContent = k;
    kk.style.cssText = "color:#94a3b8;font-size:12px";
    const vv = document.createElement("span");
    vv.textContent = v;
    vv.style.cssText = "color:#e8eaf0;font-size:12.5px;font-weight:600";
    r.append(kk, vv);
    body.appendChild(r);
  }

  const footer = document.createElement("div");
  footer.style.cssText =
    "padding:10px 18px;border-top:1px solid #2a2e3a;background:#181a23;" +
    "display:flex;justify-content:flex-end;gap:8px";
  const ok = document.createElement("button");
  ok.textContent = "Close";
  ok.style.cssText =
    "padding:6px 16px;background:#38bdf8;color:#0b0d12;border:none;" +
    "border-radius:5px;cursor:pointer;font:600 12px system-ui";
  ok.onclick = () => { ov.style.display = "none"; };
  footer.appendChild(ok);

  card.append(header, body, footer);
  ov.appendChild(card);
}

function showShortcutsTable(rows: [string, string][]): void {
  const ov = ensureOverlay();
  const card = document.createElement("div");
  card.style.cssText =
    "width:min(520px,92vw);max-height:80vh;overflow:auto;background:#1c1e28;" +
    "color:#e8eaf0;border:1px solid #2a2e3a;border-radius:10px;" +
    "box-shadow:0 24px 60px rgba(0,0,0,.65);font:13px system-ui,sans-serif";

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;padding:14px 18px;" +
    "border-bottom:1px solid #2a2e3a;background:#181a23";
  header.innerHTML =
    "<div style='flex:1'>" +
      "<div style='font-weight:700;font-size:15px'>Keyboard Shortcuts</div>" +
      "<div style='font-size:11px;color:#94a3b8;margin-top:2px'>" +
        "Two-letter tool aliases fire when the app has focus and no input is active." +
      "</div>" +
    "</div>";
  const close = document.createElement("button");
  close.textContent = "\u2715";
  close.style.cssText =
    "width:28px;height:28px;border-radius:4px;background:transparent;color:#94a3b8;" +
    "border:1px solid #2a2e3a;cursor:pointer;font-size:13px";
  close.onclick = () => { ov.style.display = "none"; };
  header.appendChild(close);

  const body = document.createElement("div");
  body.style.cssText = "padding:8px 18px 18px";
  for (const [k, v] of rows) {
    const r = document.createElement("div");
    r.style.cssText =
      "display:grid;grid-template-columns:130px 1fr;gap:12px;" +
      "padding:7px 0;border-bottom:1px solid #242734;align-items:center";
    const kk = document.createElement("kbd");
    kk.textContent = k;
    kk.style.cssText =
      "display:inline-block;padding:2px 8px;border:1px solid #3a4050;" +
      "border-bottom-width:2px;border-radius:4px;background:#12141b;" +
      "color:#cbd5e1;font:11px ui-monospace,monospace;text-align:center";
    const vv = document.createElement("span");
    vv.textContent = v;
    vv.style.cssText = "color:#e8eaf0;font-size:12.5px";
    r.append(kk, vv);
    body.appendChild(r);
  }

  card.append(header, body);
  ov.appendChild(card);
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
}