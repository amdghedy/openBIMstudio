/**
 * Drawings Panel - import/export DXF (and DWG when available),
 * push into CAD overlay or 3D scene.
 */

import { ctx } from "../core/context";

type Any = Record<string, any>;

let panel: HTMLDivElement | null = null;
let styleOk = false;

function drawings(): Any {
  return (window as Any).__obsDrawings ?? (ctx.features as Any)?.drawings ?? {};
}

function toast(kind: string, msg: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent("obs-toast", { detail: { kind, message: msg, timeout: 2200 } }),
    );
  } catch {
    console.log(`[drawings-panel] ${msg}`);
  }
}

function installStyle(): void {
  if (styleOk) return;
  styleOk = true;
  const s = document.createElement("style");
  s.textContent = `
#obs-drawings-panel {
  position: fixed; top: 100px; left: 50%; transform: translateX(-50%);
  width: min(420px, calc(100vw - 24px)); z-index: 8700;
  background: linear-gradient(180deg,#1a1d27,#12141c);
  border: 1px solid #2a2e3a; border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0,0,0,.55);
  color: #e8eaf0; font: 12px/1.4 Inter, system-ui, sans-serif;
  display: none; max-height: calc(100vh - 120px); overflow: auto;
}
#obs-drawings-panel.is-open { display: flex; flex-direction: column; }
#obs-drawings-panel .dw-hdr {
  display:flex;align-items:center;gap:8px;padding:12px 14px;
  border-bottom:1px solid #1e2029;background:#181a23;cursor:grab;
  border-radius:12px 12px 0 0;
}
#obs-drawings-panel .dw-hdr b {
  flex:1;font-size:13px;
  background:linear-gradient(90deg,#e8eaf0,#a78bfa);
  -webkit-background-clip:text;background-clip:text;color:transparent;
}
#obs-drawings-panel .dw-close {
  width:26px;height:26px;border-radius:6px;border:1px solid #2a2e3a;
  background:transparent;color:#94a3b8;cursor:pointer;
}
#obs-drawings-panel .dw-body { padding:12px 14px 16px; }
#obs-drawings-panel .dw-row {
  display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;
}
#obs-drawings-panel .dw-btn {
  padding:10px 12px;border-radius:8px;border:1px solid #2a2e3a;
  background:#1e2029;color:#e8eaf0;cursor:pointer;font:600 12px Inter,system-ui;
  text-align:left;
}
#obs-drawings-panel .dw-btn:hover { border-color:#a78bfa;background:#232633; }
#obs-drawings-panel .dw-btn small { display:block;color:#6b7280;font-weight:400;margin-top:2px; }
#obs-drawings-panel .dw-note {
  margin-top:8px;padding:8px 10px;border-radius:8px;
  background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.2);
  color:#c4b5fd;font-size:11px;line-height:1.4;
}
#obs-drawings-panel .dw-list {
  margin-top:10px;max-height:160px;overflow:auto;
}
#obs-drawings-panel .dw-item {
  padding:6px 8px;border-radius:6px;background:#0e1017;margin-bottom:4px;
  border:1px solid #1e2029;font-size:11px;
}
`;
  document.head.appendChild(s);
}

function refreshList(): void {
  if (!panel) return;
  const list = panel.querySelector(".dw-list") as HTMLElement;
  if (!list) return;
  const items = drawings().listDrawings?.() ?? [];
  if (!items.length) {
    list.innerHTML = `<div style="color:#6b7280;font-size:11px">No drawings loaded yet.</div>`;
    return;
  }
  list.innerHTML = items
    .map(
      (d: Any) =>
        `<div class="dw-item"><b>${escapeHtml(d.name)}</b> - ${d.format.toUpperCase()} - ${
          d.doc?.entities?.length ?? 0
        } entities</div>`,
    )
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Any)[c],
  );
}

async function pickAndImport(): Promise<void> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".dxf,.dwg,image/vnd.dxf";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const api = drawings();
    if (!api.importDrawingFile) {
      toast("warn", "Drawings engine not ready");
      return;
    }
    try {
      const doc = await api.importDrawingFile(file);
      if (doc) {
        toast("success", `Loaded ${file.name}`);
        refreshList();
        // Open CAD so user sees geometry
        (window as Any).__obsCad?.open?.();
      }
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };
  input.click();
}

function buildPanel(): void {
  if (panel) return;
  installStyle();
  panel = document.createElement("div");
  panel.id = "obs-drawings-panel";
  panel.innerHTML = `
    <div class="dw-hdr">
      <b>Drawings - DXF / DWG</b>
      <button class="dw-close" type="button">-</button>
    </div>
    <div class="dw-body">
      <div class="dw-row">
        <button class="dw-btn" data-act="import" type="button">
          Import DXF / DWG
          <small>Load into CAD + 3D</small>
        </button>
        <button class="dw-btn" data-act="export-cad" type="button">
          Export CAD - DXF
          <small>Download current sketch</small>
        </button>
        <button class="dw-btn" data-act="export-active" type="button">
          Export Active DXF
          <small>Last imported drawing</small>
        </button>
        <button class="dw-btn" data-act="clear-scene" type="button">
          Clear 3D Drawing
          <small>Remove DXF preview mesh</small>
        </button>
      </div>
      <div class="dw-list"></div>
      <div class="dw-note">
        <b>DXF</b> is fully supported (read + write).<br/>
        <b>DWG</b> import works when <code>@mlightcad/libredwg-web</code> is installed;
        otherwise convert DWG-DXF in any CAD and import the DXF.
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  panel.querySelector(".dw-close")?.addEventListener("click", () => closeDrawingsPanel());

  panel.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    const api = drawings();
    if (act === "import") void pickAndImport();
    if (act === "export-cad") api.exportCadAsDxf?.("cad-export.dxf");
    if (act === "export-active") api.exportActiveDxf?.();
    if (act === "clear-scene") {
      api.clearDrawingsScene?.();
      // clearDrawingsScene may not be exported on window - try engine
      try {
        const scene = (ctx as Any).world?.scene?.three;
        const g = scene?.getObjectByName?.("obs-drawings-dxf");
        if (g) {
          while (g.children.length) g.remove(g.children[0]);
        }
      } catch { /* */ }
      toast("info", "3D drawing cleared");
    }
  });

  // Drag
  const hdr = panel.querySelector(".dw-hdr") as HTMLElement;
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  hdr.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    const r = panel!.getBoundingClientRect();
    ox = r.left;
    oy = r.top;
    hdr.setPointerCapture(e.pointerId);
  });
  hdr.addEventListener("pointermove", (e) => {
    if (!dragging || !panel) return;
    panel.style.left = `${ox + e.clientX - sx}px`;
    panel.style.top = `${oy + e.clientY - sy}px`;
    panel.style.transform = "none";
  });
  hdr.addEventListener("pointerup", () => {
    dragging = false;
  });
}

export function openDrawingsPanel(): void {
  buildPanel();
  panel?.classList.add("is-open");
  refreshList();
}

export function closeDrawingsPanel(): void {
  panel?.classList.remove("is-open");
}

export function toggleDrawingsPanel(): void {
  if (panel?.classList.contains("is-open")) closeDrawingsPanel();
  else openDrawingsPanel();
}

export function setupDrawingsPanel(): void {
  // Launcher
  const launch = document.createElement("button");
  launch.id = "obs-dwg-launch";
  launch.type = "button";
  launch.title = "Drawings DXF/DWG (Ctrl+Shift+G)";
  launch.textContent = "DWG";
  launch.style.cssText =
    "position:fixed;left:116px;bottom:52px;z-index:10002;width:44px;height:40px;" +
    "border-radius:10px;border:1px solid #a78bfa;background:rgba(167,139,250,.14);" +
    "color:#c4b5fd;font:700 11px Inter,system-ui;cursor:pointer;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.35);";
  launch.onclick = () => toggleDrawingsPanel();
  document.body.appendChild(launch);

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "G" || e.key === "g")) {
      const t = e.target as HTMLElement;
      if (t?.closest?.("input,textarea,[contenteditable]")) return;
      e.preventDefault();
      toggleDrawingsPanel();
    }
  });

  void (async () => {
    try {
      const cp: Any = await import("./command-palette");
      cp.registerCommand?.({
        id: "drawings.panel",
        label: "Drawings DXF/DWG Panel",
        category: "Drafting",
        kbd: "Ctrl+Shift+G",
        run: () => toggleDrawingsPanel(),
      });
      cp.registerCommand?.({
        id: "drawings.exportCad",
        label: "Export CAD to DXF",
        category: "Drafting",
        run: () => drawings().exportCadAsDxf?.(),
      });
      cp.registerCommand?.({
        id: "drawings.import",
        label: "Import DXF / DWG",
        category: "Drafting",
        run: () => void pickAndImport(),
      });
    } catch { /* */ }

    try {
      const sc: Any = await import("./shortcuts");
      sc.shortcuts?.register?.({
        id: "drawings-panel",
        label: "Drawings Panel",
        keys: "ctrl+shift+g",
        category: "app",
        handler: () => toggleDrawingsPanel(),
      });
    } catch { /* */ }
  })();

  (window as Any).__obsDrawingsPanel = {
    open: openDrawingsPanel,
    close: closeDrawingsPanel,
    toggle: toggleDrawingsPanel,
  };

  console.log("[drawings-panel] ready - DWG button or Ctrl+Shift+G");
}
