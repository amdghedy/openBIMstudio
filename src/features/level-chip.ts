// openbim-levels:ui-wired
// Revit-style floating "current level" chip.
//
// Layout: bottom-left of the viewport.
// Shows:  "<diamond> Level 2 . +6.00 m"
// Click:  opens a dropdown of every level in the project, plus
//         New / Rename / Delete actions.
//
// Every write goes through modules/levels/levels.ts -> features/authoring.ts
// so the numeric draw elevation always tracks the active level id. No
// parallel state.
//
// All glyphs are emitted via \uXXXX escapes so this .ts file stays pure
// ASCII even though the UI renders non-ASCII characters at runtime.

import { ctx } from "../core/context";
import { levels, type LevelRecord } from "../modules/levels";
import { registerCommand } from "./command-palette";
import { notify } from "../core/notify";

const CHIP_ID = "obs-level-chip";

const GLYPH_DIAMOND = "\u25C6"; // BLACK DIAMOND
const GLYPH_CARET   = "\u25BE"; // BLACK DOWN-POINTING SMALL TRIANGLE

function fmtMeters(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const sign = v > 0 ? "+" : "";
  return sign + v.toFixed(2) + " m";
}

// -----------------------------------------------------------------------------
// DOM
// -----------------------------------------------------------------------------
const chip = document.createElement("div");
chip.id = CHIP_ID;
chip.style.cssText =
  "position:absolute;left:14px;bottom:14px;z-index:55;display:flex;" +
  "align-items:center;gap:6px;padding:6px 11px;" +
  "background:rgba(20,22,30,.88);" +
  "border:1px solid var(--border-default,#2a2e3a);" +
  "border-radius:6px;color:var(--text-primary,#e8eaf0);" +
  "font:11.5px system-ui,sans-serif;cursor:pointer;user-select:none;" +
  "box-shadow:0 4px 14px rgba(0,0,0,.4);backdrop-filter:blur(6px)";
chip.title = "Current level - click to switch";

const icon = document.createElement("span");
icon.textContent = GLYPH_DIAMOND;
icon.style.cssText = "color:var(--accent,#38bdf8);font-size:12px";

const labelEl = document.createElement("span");
labelEl.style.cssText =
  "font-weight:600;letter-spacing:.1px;overflow:hidden;text-overflow:ellipsis;" +
  "white-space:nowrap;max-width:220px";

const sep = document.createElement("span");
sep.textContent = "|";
sep.style.cssText = "opacity:.4";

const elevEl = document.createElement("span");
elevEl.style.cssText =
  "font-family:var(--font-mono,ui-monospace,monospace);opacity:.8";

const caret = document.createElement("span");
caret.textContent = GLYPH_CARET;
caret.style.cssText = "opacity:.6;font-size:10px;margin-left:2px";

chip.append(icon, labelEl, sep, elevEl, caret);

// -----------------------------------------------------------------------------
// Dropdown
// -----------------------------------------------------------------------------
let dropdown: HTMLDivElement | null = null;
let outsideHandler: ((ev: MouseEvent) => void) | null = null;

function closeDropdown(): void {
  if (dropdown) { dropdown.remove(); dropdown = null; }
  if (outsideHandler) {
    document.removeEventListener("mousedown", outsideHandler, true);
    outsideHandler = null;
  }
}

function makeRow(opts: {
  label: string;
  meta?: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
}): HTMLDivElement {
  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:7px 12px;" +
    "cursor:pointer;white-space:nowrap;border-radius:4px";
  if (opts.active) row.style.background = "rgba(56,189,248,.14)";
  if (opts.danger) row.style.color = "#fca5a5";

  const name = document.createElement("span");
  name.textContent = opts.label;
  name.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis";
  if (opts.active) name.style.color = "#38bdf8";
  row.appendChild(name);

  if (opts.meta) {
    const meta = document.createElement("span");
    meta.textContent = opts.meta;
    meta.style.cssText =
      "font-family:var(--font-mono,ui-monospace,monospace);font-size:10px;" +
      "opacity:.55";
    row.appendChild(meta);
  }

  row.onmouseenter = () =>
    (row.style.background = opts.active ? "rgba(56,189,248,.2)" : "rgba(255,255,255,.06)");
  row.onmouseleave = () =>
    (row.style.background = opts.active ? "rgba(56,189,248,.14)" : "transparent");
  row.onclick = (ev) => {
    ev.stopPropagation();
    opts.onClick();
  };
  return row;
}

function makeSeparator(): HTMLDivElement {
  const s = document.createElement("div");
  s.style.cssText =
    "height:1px;background:var(--border-subtle,#1e2029);margin:4px 8px";
  return s;
}

function openDropdown(): void {
  if (dropdown) { closeDropdown(); return; }
  const list = levels.list();
  const activeId = levels.getActiveId();

  const dd = document.createElement("div");
  dd.style.cssText =
    "position:absolute;left:14px;bottom:48px;z-index:56;min-width:260px;" +
    "max-height:400px;overflow-y:auto;padding:4px;" +
    "background:var(--bg-floating,#1c1e28);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:8px;" +
    "box-shadow:0 12px 36px rgba(0,0,0,.55);" +
    "font:12px system-ui,sans-serif;color:var(--text-primary,#e8eaf0)";

  const header = document.createElement("div");
  header.textContent = list.length + " level" + (list.length === 1 ? "" : "s");
  header.style.cssText =
    "padding:6px 12px 8px;font-size:10px;letter-spacing:.5px;" +
    "text-transform:uppercase;color:var(--text-tertiary,#6b7280)";
  dd.appendChild(header);

  if (!list.length) {
    const empty = document.createElement("div");
    empty.textContent = "No levels yet.";
    empty.style.cssText = "padding:10px 12px;color:#6b7280";
    dd.appendChild(empty);
  } else {
    for (const lv of list) {
      dd.appendChild(
        makeRow({
          label: lv.name,
          meta: fmtMeters(lv.elevation),
          active: lv.id === activeId,
          onClick: () => {
            levels.setActiveId(lv.id);
            notify("success", "Active level: " + lv.name);
            closeDropdown();
            refresh();
          },
        }),
      );
    }
  }

  dd.appendChild(makeSeparator());

  dd.appendChild(
    makeRow({
      label: "+  New level...",
      onClick: () => {
        closeDropdown();
        const last = list[list.length - 1];
        const nextElev = last ? last.elevation + 3 : 0;
        const name = prompt("New level name:", "Level " + list.length);
        if (name == null) return;
        const elevRaw = prompt("Elevation (m):", String(nextElev));
        if (elevRaw == null) return;
        const elev = Number(elevRaw);
        if (!Number.isFinite(elev)) {
          notify("warn", "Elevation must be a number");
          return;
        }
        const rec = levels.add({
          name: name.trim() || ("Level " + list.length),
          elevation: elev,
        });
        levels.setActiveId(rec.id);
        notify("success", "Level added: " + rec.name + " (" + fmtMeters(rec.elevation) + ")");
        refresh();
      },
    }),
  );

  if (activeId) {
    const cur = levels.get(activeId);
    if (cur) {
      dd.appendChild(
        makeRow({
          label: "Rename current...",
          meta: cur.name,
          onClick: () => {
            closeDropdown();
            const name = prompt("Rename level:", cur.name);
            if (name == null) return;
            levels.update(cur.id, { name: name.trim() || cur.name });
            notify("success", "Level renamed");
            refresh();
          },
        }),
      );
      dd.appendChild(
        makeRow({
          label: "Delete current",
          meta: cur.name,
          danger: true,
          onClick: () => {
            closeDropdown();
            if (list.length <= 1) {
              notify("warn", "A project must keep at least one level.");
              return;
            }
            if (!confirm("Delete level \"" + cur.name + "\"?")) return;
            levels.remove(cur.id);
            const next = levels.list()[0];
            if (next) levels.setActiveId(next.id);
            notify("info", "Level deleted");
            refresh();
          },
        }),
      );
    }
  }

  ctx.rightHost.appendChild(dd);
  dropdown = dd;

  outsideHandler = (ev: MouseEvent) => {
    const t = ev.target as Node;
    if (dropdown && dropdown.contains(t)) return;
    if (chip.contains(t)) return;
    closeDropdown();
  };
  setTimeout(() => {
    if (outsideHandler) document.addEventListener("mousedown", outsideHandler, true);
  }, 0);
}

// -----------------------------------------------------------------------------
// Refresh
// -----------------------------------------------------------------------------
function refresh(): void {
  const active = levels.getActive();
  if (active) {
    labelEl.textContent = active.name;
    elevEl.textContent = fmtMeters(active.elevation);
    chip.style.opacity = "1";
  } else {
    labelEl.textContent = "No active level";
    elevEl.textContent = "--";
    chip.style.opacity = "0.7";
  }
}

// -----------------------------------------------------------------------------
// Public
// -----------------------------------------------------------------------------
let installed = false;

export function setupLevelChip(): void {
  if (installed) return;
  installed = true;

  try { levels.ensureSeed(); } catch { /* */ }

  if (!chip.parentElement) ctx.rightHost.appendChild(chip);
  chip.onclick = (ev) => {
    ev.stopPropagation();
    openDropdown();
  };

  levels.onChange(() => refresh());
  window.addEventListener("obs-locale-changed", () => refresh());
  window.addEventListener("obs-project-opened", () => refresh());

  try {
    registerCommand({
      id: "level.new",
      label: "Level: New...",
      category: "Levels",
      run: () => {
        const list = levels.list();
        const last = list[list.length - 1];
        const nextElev = last ? last.elevation + 3 : 0;
        const name = prompt("New level name:", "Level " + list.length);
        if (name == null) return;
        const elevRaw = prompt("Elevation (m):", String(nextElev));
        if (elevRaw == null) return;
        const elev = Number(elevRaw);
        if (!Number.isFinite(elev)) { notify("warn", "Elevation must be a number"); return; }
        const rec = levels.add({ name: name.trim() || ("Level " + list.length), elevation: elev });
        levels.setActiveId(rec.id);
        refresh();
      },
    });

    registerCommand({
      id: "level.rename",
      label: "Level: Rename current...",
      category: "Levels",
      run: () => {
        const cur = levels.getActive();
        if (!cur) { notify("warn", "No active level"); return; }
        const name = prompt("Rename level:", cur.name);
        if (name == null) return;
        levels.update(cur.id, { name: name.trim() || cur.name });
        refresh();
      },
    });

    registerCommand({
      id: "level.delete",
      label: "Level: Delete current",
      category: "Levels",
      run: () => {
        const cur = levels.getActive();
        if (!cur) { notify("warn", "No active level"); return; }
        const list = levels.list();
        if (list.length <= 1) { notify("warn", "A project must keep at least one level."); return; }
        if (!confirm("Delete level \"" + cur.name + "\"?")) return;
        levels.remove(cur.id);
        const next = levels.list()[0];
        if (next) levels.setActiveId(next.id);
        refresh();
      },
    });

    const registerLevelSwitchCommands = () => {
      for (const lv of levels.list()) {
        registerCommand({
          id: "level.activate." + lv.id,
          label: "Level: " + lv.name,
          category: "Levels",
          hint: fmtMeters(lv.elevation),
          run: () => {
            levels.setActiveId(lv.id);
            notify("success", "Active level: " + lv.name);
            refresh();
          },
        });
      }
    };
    registerLevelSwitchCommands();
    levels.onChange(registerLevelSwitchCommands);
  } catch (err) {
    console.warn("[level-chip] command registration failed", err);
  }

  refresh();
  console.log("[level-chip] ready");
}

export function isLevelChipVisible(): boolean {
  return chip.style.display !== "none";
}

export function showLevelChip(): void {
  chip.style.display = "flex";
}

export function hideLevelChip(): void {
  chip.style.display = "none";
}

export function refreshLevelChip(): void {
  refresh();
}

export function openLevelDropdown(): void {
  openDropdown();
}

export type { LevelRecord };