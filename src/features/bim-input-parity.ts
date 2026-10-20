/**
 * Input Parity - keyboard shortcuts + mouse/view help that match
 * typical BIM navigation and command keys.
 *
 * Mouse map is owned by navigation.ts (already BIM-correct).
 * This module:
 *   1. Registers missing BIM-style two-letter + view shortcuts
 *   2. Re-asserts CameraControls mouse buttons stay OFF (nav owns them)
 *   3. Exposes a help overlay (Ctrl+/ or from Command Center)
 */

import { ctx } from "../core/context";

type Any = Record<string, any>;

let shortcutsRegistered = false;
let helpEl: HTMLDivElement | null = null;
let helpStyle = false;

/* -- Helpers --------------------------------------------------------------- */

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if ((el as Any).isContentEditable) return true;
  if (typeof el.closest === "function" &&
      el.closest('input,textarea,select,[contenteditable="true"]')) return true;
  return false;
}

async function cam(): Promise<Any> {
  try {
    return await import("./camera-tools");
  } catch {
    return {};
  }
}

function notify(kind: string, message: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent("obs-toast", { detail: { kind, message, timeout: 1600 } }),
    );
  } catch { /* */ }
}

function getAuthoring(): Any | null {
  return (ctx.features as Any)?.authoring ?? null;
}

function selIds(): string[] {
  try {
    const sel = (ctx.features as Any)?.selection;
    return sel?.getSelectedIds?.() ?? [];
  } catch {
    return [];
  }
}

/* -- Shortcut registration ------------------------------------------------- */

async function registerBIMShortcuts(): Promise<void> {
  if (shortcutsRegistered) return;
  let register: ((s: Any) => void) | null = null;
  try {
    const mod: Any = await import("./shortcuts");
    register = mod.shortcuts?.register?.bind(mod.shortcuts) ?? null;
  } catch {
    return;
  }
  if (!register) return;
  shortcutsRegistered = true;

  const reg = (s: Any) => {
    try {
      register!(s);
    } catch { /* */ }
  };

  // -- View / camera (BIM: ZA ZF ZE ZO ZI) ------------------------------
  reg({
    id: "bim-za",
    label: "Zoom All (BIM ZA)",
    keys: "za",
    category: "view",
    handler: async () => {
      const m = await cam();
      m.fitAll?.();
    },
  });
  reg({
    id: "bim-zf",
    label: "Zoom to Fit (BIM ZF)",
    keys: "zf",
    category: "view",
    handler: async () => {
      const m = await cam();
      m.fitAll?.();
    },
  });
  reg({
    id: "bim-ze",
    label: "Zoom Extents (BIM ZE)",
    keys: "ze",
    category: "view",
    handler: async () => {
      const m = await cam();
      m.fitAll?.();
    },
  });
  reg({
    id: "bim-zo",
    label: "Zoom Out (BIM ZO)",
    keys: "zo",
    category: "view",
    handler: async () => {
      const m = await cam();
      m.zoomBy?.(1.25);
    },
  });
  reg({
    id: "bim-zi",
    label: "Zoom In (BIM ZI)",
    keys: "zi",
    category: "view",
    handler: async () => {
      const m = await cam();
      m.zoomBy?.(0.8);
    },
  });
  reg({
    id: "bim-vn",
    label: "Default 3D View (BIM VN)",
    keys: "vn",
    category: "view",
    handler: async () => {
      const m = await cam();
      m.goHome?.();
    },
  });

  // -- Temporary hide / isolate (BIM HH HI HR) --------------------------
  reg({
    id: "bim-hh",
    label: "Hide Element (BIM HH)",
    keys: "hh",
    category: "view",
    handler: () => {
      const ids = selIds();
      (window as Any).__obsVisibility?.hideElements?.(ids);
      notify("info", ids.length ? `Hidden ${ids.length}` : "Select elements first");
    },
  });
  reg({
    id: "bim-hi",
    label: "Isolate Element (BIM HI)",
    keys: "hi",
    category: "view",
    handler: () => {
      const ids = selIds();
      (window as Any).__obsVisibility?.isolateElements?.(ids);
      notify("info", ids.length ? `Isolated ${ids.length}` : "Select elements first");
    },
  });
  reg({
    id: "bim-hr",
    label: "Reset Temporary Hide/Isolate (BIM HR)",
    keys: "hr",
    category: "view",
    handler: () => {
      (window as Any).__obsVisibility?.resetTemporary?.();
      notify("success", "Visibility reset");
    },
  });

  // -- Modify (BIM MV RO AL MA CS GP) -----------------------------------
  reg({
    id: "bim-mv",
    label: "Move (BIM MV)",
    keys: "mv",
    category: "tool",
    handler: () => {
      try {
        const gizmo = (ctx.features as Any)?.gizmo;
        gizmo?.setMode?.("translate");
        notify("info", "Move mode");
      } catch { /* */ }
    },
  });
  reg({
    id: "bim-ro",
    label: "Rotate (BIM RO)",
    keys: "ro",
    category: "tool",
    handler: () => {
      try {
        const gizmo = (ctx.features as Any)?.gizmo;
        gizmo?.setMode?.("rotate");
        notify("info", "Rotate mode");
      } catch { /* */ }
    },
  });
  reg({
    id: "bim-al",
    label: "Align (BIM AL)",
    keys: "al",
    category: "tool",
    handler: () => {
      const n = (window as Any).__obsAlign?.alignSelection?.("x", "min") ?? 0;
      notify(n ? "success" : "info", n ? `Aligned ${n}` : "Select elements to align");
    },
  });
  reg({
    id: "bim-ma",
    label: "Match Properties (BIM MA)",
    keys: "ma",
    category: "tool",
    handler: () => {
      (window as Any).__obsBimParity?.matchPropertiesPickSource?.();
    },
  });
  reg({
    id: "bim-cs",
    label: "Create Similar (BIM CS)",
    keys: "cs",
    category: "tool",
    handler: () => {
      (window as Any).__obsBimParity?.createSimilar?.();
    },
  });
  reg({
    id: "bim-gp",
    label: "Create Group (BIM GP)",
    keys: "gp",
    category: "tool",
    handler: () => {
      const ids = selIds();
      if (!ids.length) {
        notify("info", "Select elements to group");
        return;
      }
      const name = window.prompt("Group name:", "Group") ?? "Group";
      (window as Any).__obsGroups?.createFromSelection?.(name, ids, true);
      notify("success", `Group "${name}"`);
    },
  });

  // -- Architecture extras (BIM-like) -----------------------------------
  const tool = (keys: string, id: string, label: string, type: string) => {
    reg({
      id,
      label,
      keys,
      category: "tool",
      handler: () => {
        const a = getAuthoring();
        if (a?.setAuthoringTool) {
          a.setAuthoringTool(type);
          notify("info", label);
        } else {
          notify("warn", "Authoring not ready");
        }
      },
    });
  };
  // Already in default-shortcuts: WA SL CM BM DR WN GR LV ...
  // Add a few more BIM-common ones if missing from defaults
  tool("rf", "bim-tool-roof", "Roof (BIM RF)", "roof");
  tool("cl", "bim-tool-ceiling", "Ceiling (BIM CL)", "ceiling");
  tool("rm", "bim-tool-room", "Room (BIM RM)", "room");
  tool("st", "bim-tool-stairs", "Stairs (BIM ST)", "stairs");
  tool("ra", "bim-tool-railing", "Railing (BIM RA)", "railing");
  tool("cw", "bim-tool-curtain", "Curtain Wall (BIM CW)", "curtain-wall");

  // -- Help overlay -------------------------------------------------------
  reg({
    id: "bim-help-input",
    label: "Mouse & Keyboard Help (BIM map)",
    keys: "ctrl+/",
    category: "app",
    handler: () => toggleInputHelp(),
  });

  console.log("[bim-input-parity] BIM shortcuts registered");
}

/* -- Mouse / CameraControls guard ------------------------------------------ */

function enforceNavOwnership(): void {
  try {
    const controls = (ctx as Any).world?.camera?.controls;
    if (!controls) return;
    const ctor: Any = (controls as Any).constructor;
    const ACTION = (controls as Any).ACTION ?? (ctor && ctor.ACTION);
    const mb = controls.mouseButtons;
    if (mb && ACTION) {
      // Force CameraControls mouse off - navigation.ts is sole driver
      if (ACTION.NONE != null) {
        mb.left = ACTION.NONE;
        mb.middle = ACTION.NONE;
        mb.right = ACTION.NONE;
        mb.wheel = ACTION.NONE;
      }
    }
  } catch { /* */ }
}

/* -- Help overlay UI ------------------------------------------------------- */

function installHelpStyle(): void {
  if (helpStyle) return;
  helpStyle = true;
  const s = document.createElement("style");
  s.textContent = `
#obs-input-help {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
  width: min(640px, calc(100vw - 32px)); max-height: calc(100vh - 80px);
  overflow: auto; z-index: 12000;
  background: #12141c; border: 1px solid #2a2e3a; border-radius: 14px;
  box-shadow: 0 24px 64px rgba(0,0,0,.65);
  color: #e8eaf0; font: 12px/1.45 Inter, system-ui, sans-serif;
  display: none;
}
#obs-input-help.is-open { display: block; }
#obs-input-help .ih-hdr {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 16px; border-bottom: 1px solid #1e2029; background: #181a23;
  border-radius: 14px 14px 0 0;
}
#obs-input-help .ih-hdr b { flex: 1; font-size: 14px; }
#obs-input-help .ih-close {
  width: 28px; height: 28px; border-radius: 6px; border: 1px solid #2a2e3a;
  background: transparent; color: #94a3b8; cursor: pointer;
}
#obs-input-help .ih-body { padding: 14px 16px 18px; }
#obs-input-help .ih-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
}
@media (max-width: 560px) {
  #obs-input-help .ih-grid { grid-template-columns: 1fr; }
}
#obs-input-help h3 {
  margin: 0 0 8px; font: 700 10px/1 Inter, system-ui;
  letter-spacing: .6px; text-transform: uppercase; color: #6b7280;
}
#obs-input-help table { width: 100%; border-collapse: collapse; }
#obs-input-help td {
  padding: 4px 0; vertical-align: top; border-bottom: 1px solid #1a1d28;
}
#obs-input-help td:first-child {
  width: 42%; color: #7dd3fc; font: 600 11px/1.3 ui-monospace, monospace;
  white-space: nowrap; padding-right: 8px;
}
#obs-input-help td:last-child { color: #cbd5e1; }
#obs-input-help .ih-note {
  margin-top: 12px; padding: 8px 10px; border-radius: 8px;
  background: rgba(56,189,248,.08); border: 1px solid rgba(56,189,248,.18);
  color: #94a3b8; font-size: 11px;
}
`;
  document.head.appendChild(s);
}

function buildHelpHtml(): string {
  return `
    <div class="ih-hdr">
      <b>BIM-compatible Mouse &amp; Keyboard</b>
      <button class="ih-close" type="button">-</button>
    </div>
    <div class="ih-body">
      <div class="ih-grid">
        <div>
          <h3>Mouse (3D view)</h3>
          <table>
            <tr><td>MMB drag</td><td>Pan</td></tr>
            <tr><td>Shift + MMB drag</td><td>Orbit around target</td></tr>
            <tr><td>Ctrl + MMB drag</td><td>Orbit around selection</td></tr>
            <tr><td>Scroll wheel</td><td>Zoom to cursor</td></tr>
            <tr><td>Shift + Wheel</td><td>Zoom -3</td></tr>
            <tr><td>Double-click MMB</td><td>Zoom to fit</td></tr>
            <tr><td>LMB click</td><td>Select</td></tr>
            <tr><td>LMB drag L-R</td><td>Window select</td></tr>
            <tr><td>LMB drag R-L</td><td>Crossing select</td></tr>
            <tr><td>RMB</td><td>Context menu</td></tr>
          </table>
        </div>
        <div>
          <h3>View shortcuts</h3>
          <table>
            <tr><td>ZA / ZF / ZE</td><td>Zoom all / fit / extents</td></tr>
            <tr><td>ZI / ZO</td><td>Zoom in / out</td></tr>
            <tr><td>VN</td><td>Default 3D view</td></tr>
            <tr><td>F</td><td>Fit to view</td></tr>
            <tr><td>H</td><td>Home view</td></tr>
            <tr><td>HH / HI / HR</td><td>Hide / Isolate / Reset</td></tr>
            <tr><td>Ctrl + W</td><td>Walk mode</td></tr>
            <tr><td>Ctrl + /</td><td>This help</td></tr>
          </table>
        </div>
        <div>
          <h3>Modify</h3>
          <table>
            <tr><td>MV / G</td><td>Move</td></tr>
            <tr><td>RO / R</td><td>Rotate</td></tr>
            <tr><td>S</td><td>Scale gizmo</td></tr>
            <tr><td>AL</td><td>Align</td></tr>
            <tr><td>MA</td><td>Match properties</td></tr>
            <tr><td>CS</td><td>Create similar</td></tr>
            <tr><td>GP</td><td>Create group</td></tr>
            <tr><td>Delete</td><td>Delete selection</td></tr>
            <tr><td>Esc</td><td>Cancel / clear</td></tr>
            <tr><td>Ctrl+Z / Y</td><td>Undo / Redo</td></tr>
          </table>
        </div>
        <div>
          <h3>Architecture tools</h3>
          <table>
            <tr><td>WA</td><td>Wall</td></tr>
            <tr><td>SL</td><td>Slab / floor</td></tr>
            <tr><td>CM</td><td>Column</td></tr>
            <tr><td>BM</td><td>Beam</td></tr>
            <tr><td>DR / WN</td><td>Door / Window</td></tr>
            <tr><td>GR / LV</td><td>Grid / Level</td></tr>
            <tr><td>ST / RA</td><td>Stairs / Railing</td></tr>
            <tr><td>CW</td><td>Curtain wall</td></tr>
            <tr><td>RM</td><td>Room</td></tr>
            <tr><td>RF / CL</td><td>Roof / Ceiling</td></tr>
          </table>
        </div>
      </div>
      <div class="ih-note">
        Mouse behaviour matches BIM's default 3D navigation.
        Two-letter keys work like BIM (type within ~800&nbsp;ms).
        CameraControls mouse buttons stay off so only this map drives the view.
      </div>
    </div>
  `;
}

export function openInputHelp(): void {
  installHelpStyle();
  if (!helpEl) {
    helpEl = document.createElement("div");
    helpEl.id = "obs-input-help";
    helpEl.innerHTML = buildHelpHtml();
    document.body.appendChild(helpEl);
    helpEl.querySelector(".ih-close")?.addEventListener("click", () => closeInputHelp());
    helpEl.addEventListener("click", (e) => {
      if (e.target === helpEl) closeInputHelp();
    });
  }
  helpEl.classList.add("is-open");
}

export function closeInputHelp(): void {
  helpEl?.classList.remove("is-open");
}

export function toggleInputHelp(): void {
  if (helpEl?.classList.contains("is-open")) closeInputHelp();
  else openInputHelp();
}

/* -- Setup ----------------------------------------------------------------- */

export function setupBimInputParity(): void {
  void registerBIMShortcuts();

  // Re-assert nav ownership after boot (CameraControls can re-enable)
  enforceNavOwnership();
  window.setInterval(enforceNavOwnership, 4000);

  // Esc closes help
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && helpEl?.classList.contains("is-open")) {
        closeInputHelp();
      }
    },
    true,
  );

  (window as Any).__obsBIMInput = {
    openHelp: openInputHelp,
    closeHelp: closeInputHelp,
    toggleHelp: toggleInputHelp,
    enforceNav: enforceNavOwnership,
  };

  // Command palette
  void (async () => {
    try {
      const cp: Any = await import("./command-palette");
      cp.registerCommand?.({
        id: "parity.inputHelp",
        label: "Mouse & Keyboard Help (BIM map)",
        category: "View",
        kbd: "Ctrl+/",
        run: () => toggleInputHelp(),
      });
    } catch { /* */ }
  })();

  console.log("[bim-input-parity] ready - Ctrl+/ for mouse & keyboard map");
}
