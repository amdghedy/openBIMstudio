/**
 * Parity Tab Bar - docks all floating tools into bottom tabbed ribbon.
 * Tabs: Home | Architecture | Modify | View | CAD | Drawings | Families | Project
 */

type Any = Record<string, any>;

let installed = false;
let root: HTMLDivElement | null = null;
let activeTab = "home";

interface TabDef {
  id: string;
  label: string;
  buttons: Array<{ id: string; label: string; title?: string; run: () => void }>;
}

function hideFloaters(): void {
  const ids = [
    "obs-rc-launch",
    "obs-cad-launch",
    "obs-dwg-launch",
    "obs-param-launch",
    "obs-adv-toolbar",
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = "none";
      el.setAttribute("data-parity-hidden", "1");
    }
  }
  // Hide any leftover floating parity launchers
  document.querySelectorAll("[id^=obs-][id$=-launch]").forEach((el) => {
    (el as HTMLElement).style.display = "none";
  });
}

function run(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn("[parity-tabs]", e);
  }
}

function tabs(): TabDef[] {
  return [
    {
      id: "home",
      label: "Home",
      buttons: [
        {
          id: "cc",
          label: "Command Center",
          title: "Ctrl+Shift+R",
          run: () => (window as Any).__obsBIMCommandCenter?.toggle?.(),
        },
        {
          id: "draft",
          label: "[D] 2D Draft",
          run: () => (window as Any).__obsCriticalGaps?.toggleDraft?.() ?? document.getElementById("obs-adv-draft")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "hosts",
          label: "[H] Hosts",
          run: () => document.getElementById("obs-adv-hosts")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "solve",
          label: "[S] Solve",
          run: () => document.getElementById("obs-adv-solve")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "help",
          label: "Mouse Map",
          title: "Ctrl+/",
          run: () => (window as Any).__obsBIMInput?.showHelp?.(),
        },
      ],
    },
    {
      id: "arch",
      label: "Architecture",
      buttons: [
        {
          id: "stair",
          label: "Stair",
          run: () => document.getElementById("obs-adv-stair")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "rail",
          label: "Railing",
          run: () => document.getElementById("obs-adv-rail")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "cw",
          label: "[C] Curtain",
          run: () => document.getElementById("obs-adv-cw")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "room",
          label: "[R] Room",
          run: () => document.getElementById("obs-adv-room")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "rooms",
          label: "Rooms panel",
          run: () => document.getElementById("obs-adv-rooms-panel")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "fam",
          label: "Families",
          title: "Ctrl+Shift+F",
          run: () => (window as Any).__obsParamFamilyPanel?.toggle?.(),
        },
      ],
    },
    {
      id: "modify",
      label: "Modify",
      buttons: [
        {
          id: "align",
          label: "[A] Align",
          run: () => document.getElementById("obs-adv-align")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "match",
          label: "Match",
          run: () => document.getElementById("obs-adv-match")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "paint",
          label: "Paint",
          run: () => document.getElementById("obs-adv-match-apply")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "group",
          label: "Group",
          run: () => document.getElementById("obs-adv-group")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "hide",
          label: "Hide",
          run: () => document.getElementById("obs-adv-hide")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "iso",
          label: "Isolate",
          run: () => document.getElementById("obs-adv-iso")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "reset",
          label: "Reset Vis",
          run: () => document.getElementById("obs-adv-resetvis")?.dispatchEvent(new MouseEvent("click")),
        },
      ],
    },
    {
      id: "view",
      label: "View",
      buttons: [
        {
          id: "ortho3d",
          label: "3D Ortho",
          title: "VO",
          run: () => (window as Any).__obsSelPivot?.toggleOrtho?.(),
        },
        {
          id: "zoomsel",
          label: "Zoom Sel",
          title: "ZO",
          run: () => void (window as Any).__obsSelPivot?.zoomToSelection?.(),
        },
        {
          id: "zoomin",
          label: "Zoom +",
          run: () => (window as Any).__obsNavCog?.zoomIn?.() ?? (window as Any).__obsSelPivot?.zoomIn?.(),
        },
        {
          id: "zoomout",
          label: "Zoom -",
          run: () => (window as Any).__obsNavCog?.zoomOut?.() ?? (window as Any).__obsSelPivot?.zoomOut?.(),
        },
        {
          id: "lod",
          label: "[L] LOD",
          run: () => document.getElementById("obs-adv-lod")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "perf",
          label: "[P] Perf",
          run: () => document.getElementById("obs-adv-perf")?.dispatchEvent(new MouseEvent("click")),
        },
      ],
    },
    {
      id: "cad",
      label: "CAD",
      buttons: [
        {
          id: "cadpanel",
          label: "CAD Tools",
          title: "Ctrl+Shift+D",
          run: () => (window as Any).__obsCad?.open?.() ?? (window as Any).__obsCad?.toggle?.(),
        },
        {
          id: "line",
          label: "Line",
          run: () => (window as Any).__obsCad?.setTool?.("line"),
        },
        {
          id: "pl",
          label: "PLine",
          run: () => (window as Any).__obsCad?.setTool?.("polyline"),
        },
        {
          id: "trim",
          label: "Trim",
          run: () => (window as Any).__obsCad?.setTool?.("trim"),
        },
        {
          id: "ext",
          label: "Extend",
          run: () => (window as Any).__obsCad?.setTool?.("extend"),
        },
        {
          id: "fillet",
          label: "Fillet",
          run: () => (window as Any).__obsCad?.setTool?.("fillet"),
        },
      ],
    },
    {
      id: "drawings",
      label: "Drawings",
      buttons: [
        {
          id: "dwg",
          label: "DXF / DWG",
          title: "Ctrl+Shift+G",
          run: () => (window as Any).__obsDrawingsPanel?.toggle?.(),
        },
        {
          id: "exportdxf",
          label: "Export DXF",
          run: () => (window as Any).__obsDrawings?.exportCadAsDxf?.(),
        },
        {
          id: "importdxf",
          label: "Import DXF",
          run: () => (window as Any).__obsDrawingsPanel?.open?.(),
        },
      ],
    },
    {
      id: "project",
      label: "Project",
      buttons: [
        {
          id: "phases",
          label: "Phases",
          run: () => document.getElementById("obs-adv-phases")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "opts",
          label: "Options",
          run: () => document.getElementById("obs-adv-opts")?.dispatchEvent(new MouseEvent("click")),
        },
        {
          id: "rooms2",
          label: "Rooms",
          run: () => document.getElementById("obs-adv-rooms-panel")?.dispatchEvent(new MouseEvent("click")),
        },
      ],
    },
  ];
}

function render(): void {
  if (!root) return;
  const list = tabs();
  const tabRow = list
    .map(
      (t) =>
        `<button type="button" class="pt-tab${t.id === activeTab ? " is-active" : ""}" data-tab="${t.id}">${t.label}</button>`,
    )
    .join("");
  const current = list.find((t) => t.id === activeTab) ?? list[0];
  const btns = current.buttons
    .map(
      (b) =>
        `<button type="button" class="pt-btn" data-run="${b.id}" title="${b.title ?? b.label}">${b.label}</button>`,
    )
    .join("");

  root.innerHTML = `
    <div class="pt-tabs">${tabRow}</div>
    <div class="pt-tools">${btns}</div>
  `;

  root.querySelectorAll("[data-tab]").forEach((el) => {
    el.addEventListener("click", () => {
      activeTab = (el as HTMLElement).getAttribute("data-tab") || "home";
      render();
    });
  });

  const map = new Map(current.buttons.map((b) => [b.id, b]));
  root.querySelectorAll("[data-run]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = (el as HTMLElement).getAttribute("data-run") || "";
      const b = map.get(id);
      if (b) run(b.run);
    });
  });
}

function installStyle(): void {
  if (document.getElementById("obs-parity-tabs-style")) return;
  const s = document.createElement("style");
  s.id = "obs-parity-tabs-style";
  s.textContent = `
#obs-parity-tabs {
  position: fixed;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  z-index: 10050;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  max-width: min(960px, calc(100vw - 24px));
  pointer-events: none;
}
#obs-parity-tabs .pt-tabs,
#obs-parity-tabs .pt-tools {
  pointer-events: auto;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px;
  padding: 4px 6px;
  background: rgba(18, 20, 28, 0.92);
  border: 1px solid #2a2e3a;
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.45);
}
#obs-parity-tabs .pt-tab {
  border: 1px solid transparent;
  background: transparent;
  color: #94a3b8;
  font: 600 11px/1 Inter, system-ui, sans-serif;
  padding: 6px 10px;
  border-radius: 7px;
  cursor: pointer;
}
#obs-parity-tabs .pt-tab:hover { color: #e8eaf0; background: #1e2029; }
#obs-parity-tabs .pt-tab.is-active {
  color: #e8eaf0;
  background: #243044;
  border-color: #3b82f6;
}
#obs-parity-tabs .pt-btn {
  border: 1px solid #2a2e3a;
  background: #1a1d27;
  color: #e8eaf0;
  font: 600 11px/1 Inter, system-ui, sans-serif;
  padding: 7px 11px;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
}
#obs-parity-tabs .pt-btn:hover {
  border-color: #3b82f6;
  background: #232633;
}
`;
  document.head.appendChild(s);
}

export function setupParityTabBar(): void {
  if (installed) return;
  installed = true;
  // Migrated to top ribbon - do not show bottom tab bar
  const RIBBON_MIGRATED = true;
  if (RIBBON_MIGRATED) {
    const kill = () => {
      const el = document.getElementById("obs-parity-tabs");
      if (el) el.style.display = "none";
    };
    kill();
    window.setTimeout(kill, 500);
    console.log("[parity-tab-bar] skipped UI - tools moved to top ribbon");
    return;
  }
  installStyle();

  root = document.createElement("div");
  root.id = "obs-parity-tabs";
  document.body.appendChild(root);
  render();

  // Hide floaters after other modules create them
  hideFloaters();
  window.setTimeout(hideFloaters, 500);
  window.setTimeout(hideFloaters, 1500);
  window.setTimeout(hideFloaters, 3000);

  // Observe new floaters
  const mo = new MutationObserver(() => hideFloaters());
  mo.observe(document.body, { childList: true, subtree: true });

  (window as Any).__obsParityTabs = {
    setTab: (id: string) => {
      activeTab = id;
      render();
    },
    showFloaters: () => {
      document.querySelectorAll("[data-parity-hidden]").forEach((el) => {
        (el as HTMLElement).style.display = "";
        el.removeAttribute("data-parity-hidden");
      });
    },
  };

  console.log("[parity-tab-bar] tabbed ribbon ready (floaters hidden)");
}
