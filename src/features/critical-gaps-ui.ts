/**
 * Critical Gaps UI - bottom toolbar with one-click access to Revit-parity tools.
 * Extends the original advanced toolbar with Architecture / Modify / View actions.
 */

type Any = Record<string, any>;

let toolbar: HTMLDivElement | null = null;
let styleInstalled = false;

function installStyle(): void {
  if (styleInstalled) return;
  styleInstalled = true;
  const css = `
.obs-adv-toolbar {
  position: fixed; left: 50%; transform: translateX(-50%); bottom: 46px;
  display: flex; flex-direction: row; gap: 5px; flex-wrap: wrap;
  justify-content: center; max-width: calc(100vw - 40px); z-index: 10001;
  font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.obs-adv-btn {
  width: auto; min-width: 108px; min-height: 32px; padding: 6px 9px;
  border-radius: 7px; border: 1px solid #2a2e3a; background: #1e2029;
  color: #cbd5e1; font: 600 11px/1.2 Inter, system-ui, sans-serif;
  cursor: pointer; text-align: left;
  box-shadow: 0 2px 8px rgba(0,0,0,.22);
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.obs-adv-btn:hover { background: #2a2e3a; color: #f8fafc; border-color: #38bdf8; }
.obs-adv-btn[data-active="1"] {
  background: rgba(56,189,248,.16); color: #7dd3fc; border-color: #38bdf8;
}
.obs-adv-btn[disabled] { opacity: .55; cursor: default; }
.obs-adv-sep {
  width: 1px; height: 28px; background: #2a2e3a; margin: 0 2px; align-self: center;
}
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

function makeButton(id: string, label: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "obs-adv-btn";
  btn.id = id;
  btn.type = "button";
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener("click", onClick);
  return btn;
}

function flash(btn: HTMLButtonElement, msg: string, ms = 1400): void {
  const old = btn.textContent;
  btn.textContent = msg;
  window.setTimeout(() => { btn.textContent = old; }, ms);
}

function sep(): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "obs-adv-sep";
  return d;
}

export async function setupCriticalGapsUI(): Promise<void> {
  if (toolbar) return;
  installStyle();
  toolbar = document.createElement("div");
  toolbar.className = "obs-adv-toolbar";

  // -- Command Center (primary entry) --------------------------------
  const ccBtn = makeButton("obs-adv-cc", "Ctrl+ Command Center", "Open Revit Command Center (Ctrl+Shift+R)", () => {
    const cc = (window as Any).__obsRevitCC;
    if (cc?.toggle) cc.toggle();
    else window.dispatchEvent(new KeyboardEvent("keydown", { key: "R", ctrlKey: true, shiftKey: true }));
  });
  ccBtn.style.minWidth = "148px";
  ccBtn.style.borderColor = "#38bdf8";
  ccBtn.style.color = "#7dd3fc";

  // -- Original advanced tools ---------------------------------------
  const draftBtn = makeButton("obs-adv-draft", "[D] 2D Draft", "Toggle 2D drafting overlay", () => {
    const d = (window as Any).__obsDrafting2D;
    if (!d) { flash(draftBtn, "[!] Draft"); return; }
    const active = !!d.getTool?.();
    d.setTool(active ? null : "line");
  });
  const refreshDraft = (): void => {
    const d = (window as Any).__obsDrafting2D;
    const active = !!d?.getTool?.();
    draftBtn.textContent = active ? "[D] Draft: ON" : "[D] 2D Draft";
    draftBtn.dataset.active = active ? "1" : "0";
  };
  window.addEventListener("obs:draft-tool-changed", refreshDraft);

  const hostBtn = makeButton("obs-adv-hosts", "[H] Hosts", "Recompute wall openings", async () => {
    try {
      const m: Any = await import("./hosted-openings");
      const n = Number(m.recomputeHostedOpenings?.() ?? 0);
      flash(hostBtn, n > 0 ? `[OK] ${n}` : "[--]");
    } catch { flash(hostBtn, "[!]"); }
  });

  const solveBtn = makeButton("obs-adv-solve", "[S] Solve", "Hosted constraint solver", () => {
    const fn = (window as Any).__obsSolveHostedConstraints;
    if (typeof fn !== "function") { flash(solveBtn, "[!]"); return; }
    try {
      const n = Number(fn() ?? 0);
      flash(solveBtn, n > 0 ? `[OK] ${n}` : "[--]");
    } catch { flash(solveBtn, "[!]"); }
  });

  // -- Architecture generators ---------------------------------------
  const stairBtn = makeButton("obs-adv-stair", "Stair", "Place straight stair", () => {
    void (window as Any).__obsRevitParity?.placeStair?.("straight");
    flash(stairBtn, "[OK]");
  });
  const railBtn = makeButton("obs-adv-rail", "Railing", "Place path railing", () => {
    void (window as Any).__obsRevitParity?.placeRailing?.();
    flash(railBtn, "[OK]");
  });
  const cwBtn = makeButton("obs-adv-cw", "[C] Curtain", "Place curtain wall", () => {
    void (window as Any).__obsRevitParity?.placeCurtainWall?.();
    flash(cwBtn, "[OK]");
  });
  const roomBtn = makeButton("obs-adv-room", "[R] Room", "Create sample room", () => {
    const r = (window as Any).__obsRooms?.createRoom?.({
      name: "Room",
      boundary: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }],
    });
    flash(roomBtn, r ? r.number : "[!]");
  });

  // -- Modify --------------------------------------------------------
  const alignBtn = makeButton("obs-adv-align", "[A] Align", "Align selection on X", () => {
    const n = (window as Any).__obsAlign?.alignSelection?.("x", "min") ?? 0;
    flash(alignBtn, n ? `[OK] ${n}` : "[--]");
  });
  const matchBtn = makeButton("obs-adv-match", "Match", "Match properties (pick source)", () => {
    (window as Any).__obsRevitParity?.matchPropertiesPickSource?.();
    flash(matchBtn, "SRC");
  });
  const matchApplyBtn = makeButton("obs-adv-match-apply", "Paint", "Apply matched properties", () => {
    const n = (window as Any).__obsRevitParity?.matchPropertiesApply?.() ?? 0;
    flash(matchApplyBtn, n ? `[OK] ${n}` : "[--]");
  });
  const groupBtn = makeButton("obs-adv-group", "Group", "Group selection", () => {
    const sel = (window as Any).__OBS_CTX__?.features?.selection;
    let ids: string[] = [];
    try {
      ids = sel?.getSelectedIds?.() ?? [];
    } catch { /* */ }
    if (!ids.length) { flash(groupBtn, "sel?"); return; }
    const g = (window as Any).__obsGroups?.createFromSelection?.("Group", ids, true);
    flash(groupBtn, g ? "[OK]" : "[!]");
  });

  // -- View ----------------------------------------------------------
  const hideBtn = makeButton("obs-adv-hide", "Hide", "Temporary hide selection", () => {
    const sel = (window as Any).__OBS_CTX__?.features?.selection;
    let ids: string[] = [];
    try { ids = sel?.getSelectedIds?.() ?? []; } catch { /* */ }
    (window as Any).__obsVisibility?.hideElements?.(ids);
    flash(hideBtn, ids.length ? `[OK] ${ids.length}` : "[--]");
  });
  const isoBtn = makeButton("obs-adv-iso", "Isolate", "Temporary isolate selection", () => {
    const sel = (window as Any).__OBS_CTX__?.features?.selection;
    let ids: string[] = [];
    try { ids = sel?.getSelectedIds?.() ?? []; } catch { /* */ }
    (window as Any).__obsVisibility?.isolateElements?.(ids);
    flash(isoBtn, ids.length ? `[OK] ${ids.length}` : "[--]");
  });
  const resetVisBtn = makeButton("obs-adv-resetvis", "Reset Vis", "Reset temp hide/isolate", () => {
    (window as Any).__obsVisibility?.resetTemporary?.();
    flash(resetVisBtn, "[OK]");
  });

  // -- Panels --------------------------------------------------------
  const phasesBtn = makeButton("obs-adv-phases", "Phases", "Open phasing panel", () => {
    window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "phases" } }));
  });
  const roomsBtn = makeButton("obs-adv-rooms-panel", "Rooms", "Open rooms panel", () => {
    window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "rooms" } }));
  });
  const optsBtn = makeButton("obs-adv-opts", "Options", "Design options panel", () => {
    window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "design-options" } }));
  });

  // -- LOD / Perf / Collab (kept) ------------------------------------
  const lodBtn = makeButton("obs-adv-lod", "[L] LOD", "Toggle LOD culling", () => {
    const l = (window as Any).__obsLodManager;
    if (!l) { flash(lodBtn, "[!]"); return; }
    const on = !!l.setEnabled?.(!l.isEnabled?.());
    lodBtn.textContent = on ? "[L] LOD: ON" : "[L] LOD: OFF";
    lodBtn.dataset.active = on ? "1" : "0";
  });
  const perfBtn = makeButton("obs-adv-perf", "[P] Perf", "Toggle frustum culling", () => {
    const p = (window as Any).__obsPerfOptimizer;
    if (!p) { flash(perfBtn, "[!]"); return; }
    const on = !!p.setEnabled?.(!p.isEnabled?.());
    perfBtn.textContent = on ? "[P] Perf: ON" : "[P] Perf: OFF";
    perfBtn.dataset.active = on ? "1" : "0";
  });

  toolbar.append(
    ccBtn,
    sep(),
    draftBtn, hostBtn, solveBtn,
    sep(),
    stairBtn, railBtn, cwBtn, roomBtn,
    sep(),
    alignBtn, matchBtn, matchApplyBtn, groupBtn,
    sep(),
    hideBtn, isoBtn, resetVisBtn,
    sep(),
    phasesBtn, roomsBtn, optsBtn,
    sep(),
    lodBtn, perfBtn,
  );

  document.body.appendChild(toolbar);
  // Migrated to top ribbon - keep buttons in DOM for programmatic click, hide bar
  toolbar.style.display = "none";
  toolbar.setAttribute("data-parity-ribbon-migrated", "1");
  refreshDraft();

  // Command palette extras
  try {
    const cp: Any = await import("./command-palette");
    const reg = cp.registerCommand;
    if (typeof reg === "function") {
      reg({ id: "advanced.draft2d", label: "2D Draft Overlay", category: "Advanced", run: () => draftBtn.click() });
      reg({ id: "advanced.updateHosts", label: "Update Hosted Openings", category: "Advanced", run: () => hostBtn.click() });
      reg({ id: "advanced.solveConstraints", label: "Solve Hosted Constraints", category: "Advanced", run: () => solveBtn.click() });
    }
  } catch { /* */ }

  console.log("[critical-gaps-ui] toolbar ready (hidden - tools in top ribbon)");
}
