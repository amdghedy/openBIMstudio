/**
 * Revit Command Center - clear, grouped UI for every parity tool.
 *
 * Dockable panel (top-left of viewport) with sections:
 *   Architecture - Modify - View - Project - Coordinate
 *
 * Every button maps to a real function; disabled state when a dependency
 * is missing. Opens via toolbar, Ctrl+Shift+R, or command palette.
 */

type Any = Record<string, any>;

let panel: HTMLDivElement | null = null;
let styleOk = false;
let visible = false;

function installCss(): void {
  if (styleOk) return;
  styleOk = true;
  const s = document.createElement("style");
  s.textContent = `
#obs-revit-cc {
  position: fixed; top: 100px; left: 16px; width: 300px;
  max-height: calc(100vh - 160px); overflow: auto; z-index: 8600;
  background: linear-gradient(180deg, #1a1d27 0%, #12141c 100%);
  border: 1px solid #2a2e3a; border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0,0,0,.55), 0 0 0 1px rgba(56,189,248,.08);
  color: #e8eaf0; font: 12px/1.4 Inter, system-ui, sans-serif;
  display: none; user-select: none;
}
#obs-revit-cc.is-open { display: flex; flex-direction: column; }
#obs-revit-cc .rcc-hdr {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 12px; border-bottom: 1px solid #1e2029;
  background: #181a23; cursor: grab; border-radius: 12px 12px 0 0;
}
#obs-revit-cc .rcc-hdr b {
  flex: 1; font-size: 13px; letter-spacing: -.01em;
  background: linear-gradient(90deg, #e8eaf0, #7dd3fc);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
#obs-revit-cc .rcc-close {
  width: 26px; height: 26px; border-radius: 6px; border: 1px solid #2a2e3a;
  background: transparent; color: #94a3b8; cursor: pointer; font-size: 14px;
}
#obs-revit-cc .rcc-close:hover { background: #232633; color: #f8fafc; }
#obs-revit-cc .rcc-body { padding: 8px 10px 12px; overflow: auto; }
#obs-revit-cc .rcc-sec {
  margin-bottom: 10px; border: 1px solid #1e2029; border-radius: 8px;
  background: #0e1017; overflow: hidden;
}
#obs-revit-cc .rcc-sec-title {
  padding: 6px 10px; font: 700 9px/1 Inter, system-ui;
  letter-spacing: .7px; text-transform: uppercase; color: #6b7280;
  background: #151820; border-bottom: 1px solid #1e2029;
}
#obs-revit-cc .rcc-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 6px;
}
#obs-revit-cc .rcc-btn {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  padding: 7px 8px; border-radius: 6px; border: 1px solid transparent;
  background: transparent; color: #cbd5e1; cursor: pointer; text-align: left;
  font: 600 11px/1.2 Inter, system-ui; transition: background .1s, border-color .1s;
}
#obs-revit-cc .rcc-btn:hover {
  background: #232633; border-color: #343847; color: #f1f5f9;
}
#obs-revit-cc .rcc-btn:active { transform: scale(.98); }
#obs-revit-cc .rcc-btn[disabled] {
  opacity: .4; cursor: not-allowed; transform: none;
}
#obs-revit-cc .rcc-btn small {
  font: 400 9px/1.2 Inter, system-ui; color: #6b7280; font-weight: 400;
}
#obs-revit-cc .rcc-btn:hover small { color: #94a3b8; }
#obs-revit-cc .rcc-status {
  margin: 0 10px 10px; padding: 7px 9px; border-radius: 6px;
  background: rgba(56,189,248,.08); border: 1px solid rgba(56,189,248,.2);
  color: #7dd3fc; font: 500 10.5px/1.35 Inter, system-ui;
}
#obs-revit-cc .rcc-kbd {
  display: inline-block; padding: 0 4px; margin-left: 4px;
  border: 1px solid #343847; border-radius: 3px; background: #1a1d28;
  font: 9px ui-monospace, monospace; color: #94a3b8;
}
`;
  document.head.appendChild(s);
}

function toast(msg: string, kind: "info" | "success" | "warn" | "error" = "info"): void {
  try {
    window.dispatchEvent(
      new CustomEvent("obs-toast", { detail: { kind, message: msg, timeout: 2000 } }),
    );
  } catch {
    console.log(`[rcc] ${kind}: ${msg}`);
  }
}

function selIds(): string[] {
  try {
    const sel = ((window as Any).__OBS_CTX__?.features?.selection) as Any;
    return sel?.getSelectedIds?.() ?? [];
  } catch {
    return [];
  }
}

type Action = () => void | Promise<void>;

function btn(label: string, hint: string, action: Action, enabled = true): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "rcc-btn";
  b.innerHTML = `${label}<small>${hint}</small>`;
  b.disabled = !enabled;
  b.onclick = async (e) => {
    e.stopPropagation();
    if (b.disabled) return;
    b.disabled = true;
    try {
      await action();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      b.disabled = !enabled;
    }
  };
  return b;
}

function section(title: string, buttons: HTMLButtonElement[]): HTMLDivElement {
  const sec = document.createElement("div");
  sec.className = "rcc-sec";
  const t = document.createElement("div");
  t.className = "rcc-sec-title";
  t.textContent = title;
  const grid = document.createElement("div");
  grid.className = "rcc-grid";
  for (const b of buttons) grid.appendChild(b);
  sec.append(t, grid);
  return sec;
}

function has(globalName: string): boolean {
  return !!(window as Any)[globalName];
}

function buildBody(host: HTMLElement): void {
  host.innerHTML = "";

  const status = document.createElement("div");
  status.className = "rcc-status";
  const ready: string[] = [];
  if (has("__obsStairs")) ready.push("Stairs");
  if (has("__obsRailings")) ready.push("Railings");
  if (has("__obsCurtainWall")) ready.push("Curtain");
  if (has("__obsRooms")) ready.push("Rooms");
  if (has("__obsPhases")) ready.push("Phases");
  if (has("__obsVisibility")) ready.push("Visibility");
  if (has("__obsAlign")) ready.push("Align");
  status.textContent = ready.length
    ? `Ready: ${ready.join(" - ")}`
    : "Modules still loading... open again in a moment.";
  host.appendChild(status);

  // Architecture
  host.appendChild(
    section("Architecture", [
      btn("Straight Stair", "Parametric run", async () => {
        await (window as Any).__obsRevitParity?.placeStair?.("straight");
      }, has("__obsStairs") || has("__obsRevitParity")),
      btn("L-Stair", "Landing turn", async () => {
        await (window as Any).__obsRevitParity?.placeStair?.("l-shape");
      }, has("__obsStairs") || has("__obsRevitParity")),
      btn("U-Stair", "Switchback", async () => {
        await (window as Any).__obsRevitParity?.placeStair?.("u-shape");
      }, has("__obsStairs") || has("__obsRevitParity")),
      btn("Railing", "Path + balusters", async () => {
        await (window as Any).__obsRevitParity?.placeRailing?.();
      }, has("__obsRailings") || has("__obsRevitParity")),
      btn("Curtain Wall", "Mullions + panels", async () => {
        await (window as Any).__obsRevitParity?.placeCurtainWall?.();
      }, has("__obsCurtainWall") || has("__obsRevitParity")),
      btn("Parametric Fam", "Ctrl+Shift+F", () => {
        (window as Any).__obsParamFamilyPanel?.toggle?.();
      }, true),
      btn("Create Room", "Sample boundary", () => {
        const r = (window as Any).__obsRooms?.createRoom?.({
          name: "Room",
          boundary: [
            { x: 0, z: 0 },
            { x: 4, z: 0 },
            { x: 4, z: 3 },
            { x: 0, z: 3 },
          ],
        });
        toast(r ? `Room ${r.number} - ${r.area.toFixed(1)} m-` : "Rooms not ready", r ? "success" : "warn");
      }, has("__obsRooms")),
    ]),
  );

  // Modify
  host.appendChild(
    section("Modify", [
      btn("Align X", "Min edge - X", () => {
        const n = (window as Any).__obsAlign?.alignSelection?.("x", "min") ?? 0;
        toast(n ? `Aligned ${n}` : "Select elements first", n ? "success" : "info");
      }, has("__obsAlign")),
      btn("Align Z", "Min edge - Z", () => {
        const n = (window as Any).__obsAlign?.alignSelection?.("z", "min") ?? 0;
        toast(n ? `Aligned ${n}` : "Select elements first", n ? "success" : "info");
      }, has("__obsAlign")),
      btn("Distribute X", "Even spacing", () => {
        const n = (window as Any).__obsAlign?.distributeSelection?.("x") ?? 0;
        toast(n ? `Distributed ${n}` : "Need 3+ selected", n ? "success" : "info");
      }, has("__obsAlign")),
      btn("Match Props", "Pick source", () => {
        (window as Any).__obsRevitParity?.matchPropertiesPickSource?.();
      }, has("__obsRevitParity")),
      btn("Paint Props", "Apply to selection", () => {
        const n = (window as Any).__obsRevitParity?.matchPropertiesApply?.() ?? 0;
        toast(n ? `Painted ${n}` : "Pick source first", n ? "success" : "info");
      }, has("__obsRevitParity")),
      btn("Create Group", "From selection", () => {
        const ids = selIds();
        if (!ids.length) {
          toast("Select elements to group", "info");
          return;
        }
        const name = window.prompt("Group name:", "Group") ?? "Group";
        const g = (window as Any).__obsGroups?.createFromSelection?.(name, ids, true);
        toast(g ? `Group "${name}" created` : "Groups not ready", g ? "success" : "warn");
      }, has("__obsGroups")),
      btn("Create Similar", "Same type tool", () => {
        (window as Any).__obsRevitParity?.createSimilar?.();
      }, true),
    ]),
  );

  // View
  host.appendChild(
    section("View", [
      btn("Hide", "Temp hide selected", () => {
        const ids = selIds();
        (window as Any).__obsVisibility?.hideElements?.(ids);
        toast(ids.length ? `Hidden ${ids.length}` : "Nothing selected", ids.length ? "info" : "info");
      }, has("__obsVisibility")),
      btn("Isolate", "Temp isolate", () => {
        const ids = selIds();
        (window as Any).__obsVisibility?.isolateElements?.(ids);
        toast(ids.length ? `Isolated ${ids.length}` : "Nothing selected", "info");
      }, has("__obsVisibility")),
      btn("Reset Vis", "Clear temp hide", () => {
        (window as Any).__obsVisibility?.resetTemporary?.();
        toast("Visibility reset", "success");
      }, has("__obsVisibility")),
      btn("Work Plane XY", "Floor plane", () => {
        (window as Any).__obsRefPlanes?.setActiveWorkPlane?.("rp-xy");
        toast("Work plane: Floor (XY)", "success");
      }, has("__obsRefPlanes")),
      btn("Work Plane XZ", "Front plane", () => {
        (window as Any).__obsRefPlanes?.setActiveWorkPlane?.("rp-xz");
        toast("Work plane: Front (XZ)", "success");
      }, has("__obsRefPlanes")),
      btn("2D Draft", "Toggle overlay", () => {
        const d = (window as Any).__obsDrafting2D;
        if (!d) {
          toast("Drafting not ready", "warn");
          return;
        }
        const on = !!d.getTool?.();
        d.setTool(on ? null : "line");
        toast(on ? "Draft off" : "Draft on - draw lines", "info");
      }, true),
      btn("Mouse & Keys", "Revit map - Ctrl+/", () => {
        const h = (window as Any).__obsRevitInput;
        if (h?.toggleHelp) h.toggleHelp();
        else toast("Input help loading...", "info");
      }, true),
    ]),
  );

  // CAD
  host.appendChild(
    section("CAD / Drafting", [
      btn("CAD Panel", "Ctrl+Shift+D", () => {
        const c = (window as Any).__obsCad;
        if (c?.toggle) c.toggle();
        else toast("CAD loading...", "info");
      }, true),
      btn("Line", "L", () => {
        (window as Any).__obsCad?.open?.();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
      }, true),
      btn("Polyline", "PL - Enter ends", () => {
        const c = (window as Any).__obsCad;
        c?.open?.();
        // set tool via engine
        try {
          const eng = c?.engine;
          eng?.setTool?.("polyline");
          toast("PLINE - click points, Enter to finish", "info");
        } catch { /* */ }
      }, true),
      btn("Circle", "CC", () => {
        const c = (window as Any).__obsCad;
        c?.open?.();
        c?.engine?.setTool?.("circle");
        toast("CIRCLE", "info");
      }, true),
      btn("Ortho", "F8", () => {
        const on = (window as Any).__obsCad?.engine?.toggleOrtho?.();
        toast(on ? "ORTHO on" : "ORTHO off", "info");
      }, true),
      btn("3D Ortho", "VO", () => {
        (window as Any).__obsSelPivot?.toggleOrtho?.();
      }, true),
      btn("Zoom Sel", "ZO", () => {
        void (window as Any).__obsSelPivot?.zoomToSelection?.();
      }, true),
      btn("Zoom +", "+", () => {
        (window as Any).__obsSelPivot?.zoomIn?.();
      }, true),
      btn("Zoom -", "-", () => {
        (window as Any).__obsSelPivot?.zoomOut?.();
      }, true),
      btn("Grid", "F7", () => {
        const on = (window as Any).__obsCad?.engine?.toggleGrid?.();
        toast(on ? "GRID on" : "GRID off", "info");
      }, true),
      btn("Drawings DXF", "Ctrl+Shift+G", () => {
        (window as Any).__obsDrawingsPanel?.toggle?.();
      }, true),
      btn("Export DXF", "CAD - file", () => {
        (window as Any).__obsDrawings?.exportCadAsDxf?.();
      }, true),
    ]),
  );

  // Project panels
  host.appendChild(
    section("Project panels", [
      btn("Rooms & Areas", "Open panel", () => {
        window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "rooms" } }));
      }, has("__obsRooms")),
      btn("Phasing", "Open panel", () => {
        window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "phases" } }));
      }, has("__obsPhases")),
      btn("Design Options", "Open panel", () => {
        window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "design-options" } }));
      }, has("__obsDesignOptions")),
      btn("Model Groups", "Open panel", () => {
        window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "groups" } }));
      }, has("__obsGroups")),
      btn("Copy / Monitor", "Open panel", () => {
        window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "copy-monitor" } }));
      }, has("__obsCopyMonitor")),
      btn("Solve Hosts", "Openings + offsets", () => {
        const fn = (window as Any).__obsSolveHostedConstraints;
        if (typeof fn !== "function") {
          toast("Solver not ready", "warn");
          return;
        }
        const n = Number(fn() ?? 0);
        toast(n ? `Solved ${n}` : "No changes", n ? "success" : "info");
      }, true),
    ]),
  );
}

function makeDraggable(el: HTMLElement, handle: HTMLElement): void {
  let dragging = false;
  let sx = 0, sy = 0, ox = 0, oy = 0;
  handle.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    const r = el.getBoundingClientRect();
    ox = r.left;
    oy = r.top;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    el.style.left = `${ox + e.clientX - sx}px`;
    el.style.top = `${oy + e.clientY - sy}px`;
    el.style.right = "auto";
  });
  handle.addEventListener("pointerup", () => {
    dragging = false;
  });
}

export function openRevitCommandCenter(): void {
  if (!panel) return;
  buildBody(panel.querySelector(".rcc-body") as HTMLElement);
  panel.classList.add("is-open");
  visible = true;
}

export function closeRevitCommandCenter(): void {
  panel?.classList.remove("is-open");
  visible = false;
}

export function toggleRevitCommandCenter(): void {
  if (visible) closeRevitCommandCenter();
  else openRevitCommandCenter();
}

export function setupRevitCommandCenter(): void {
  if (panel) return;
  installCss();

  panel = document.createElement("div");
  panel.id = "obs-revit-cc";
  panel.innerHTML = `
    <div class="rcc-hdr">
      <b>Revit Command Center</b>
      <button class="rcc-close" type="button" title="Close">-</button>
    </div>
    <div class="rcc-body"></div>
  `;
  document.body.appendChild(panel);

  const hdr = panel.querySelector(".rcc-hdr") as HTMLElement;
  makeDraggable(panel, hdr);
  panel.querySelector(".rcc-close")?.addEventListener("click", () => closeRevitCommandCenter());

  // Keyboard: Ctrl+Shift+R
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "R" || e.key === "r")) {
      const t = e.target as HTMLElement;
      if (t?.closest?.("input,textarea,[contenteditable]")) return;
      e.preventDefault();
      toggleRevitCommandCenter();
    }
  });

  // Floating launcher button (always visible)
  const launch = document.createElement("button");
  launch.id = "obs-rcc-launch";
  launch.type = "button";
  launch.title = "Revit Command Center (Ctrl+Shift+R)";
  launch.textContent = "RC";
  launch.style.cssText =
    "position:fixed;left:16px;bottom:52px;z-index:10002;width:40px;height:40px;" +
    "border-radius:10px;border:1px solid #38bdf8;background:rgba(56,189,248,.16);" +
    "color:#7dd3fc;font:700 12px Inter,system-ui;cursor:pointer;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.35);";
  launch.onmouseenter = () => {
    launch.style.background = "rgba(56,189,248,.28)";
  };
  launch.onmouseleave = () => {
    launch.style.background = "rgba(56,189,248,.16)";
  };
  launch.onclick = () => toggleRevitCommandCenter();
  document.body.appendChild(launch);

  // Palette command
  void (async () => {
    try {
      const cp: Any = await import("./command-palette");
      cp.registerCommand?.({
        id: "parity.commandCenter",
        label: "Revit Command Center",
        category: "Panels",
        kbd: "Ctrl+Shift+R",
        run: () => toggleRevitCommandCenter(),
      });
    } catch { /* */ }
  })();

  (window as Any).__obsRevitCC = {
    open: openRevitCommandCenter,
    close: closeRevitCommandCenter,
    toggle: toggleRevitCommandCenter,
  };

  // First-run: open once so the user sees every function grouped clearly
  try {
    const key = "obs.rcc.autoOpened.v1";
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, "1");
      window.setTimeout(() => openRevitCommandCenter(), 800);
    }
  } catch { /* */ }

  console.log("[revit-command-center] ready - Ctrl+Shift+R or RC button");
}

