/**
 * Parametric Family Panel - clear UI to inspect/edit family parameters,
 * formulas, constraints, and rebuild geometry (BIM family types feel).
 */

import { ctx } from "../core/context";

type Any = Record<string, any>;

let panel: HTMLDivElement | null = null;
let styleOk = false;
let selectedFamilyId: string | null = null;
let selectedTypeId: string | null = null;

function familySvc(): Any {
  return (
    (window as Any).__obsFamilyParametric ??
    (window as Any).__obsFamily ??
    (ctx.features as Any)?.family ??
    {}
  );
}

function toast(kind: string, msg: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent("obs-toast", { detail: { kind, message: msg, timeout: 2000 } }),
    );
  } catch {
    console.log(`[param-panel] ${msg}`);
  }
}

function installStyle(): void {
  if (styleOk) return;
  styleOk = true;
  const s = document.createElement("style");
  s.textContent = `
#obs-param-family-panel {
  position: fixed; top: 100px; right: 16px; width: 340px; z-index: 8650;
  max-height: calc(100vh - 140px); overflow: auto;
  background: linear-gradient(180deg,#1a1d27,#12141c);
  border: 1px solid #2a2e3a; border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0,0,0,.55);
  color: #e8eaf0; font: 12px/1.4 Inter, system-ui, sans-serif;
  display: none;
}
#obs-param-family-panel.is-open { display: flex; flex-direction: column; }
#obs-param-family-panel .pf-hdr {
  display:flex;align-items:center;gap:8px;padding:11px 12px;
  border-bottom:1px solid #1e2029;background:#181a23;cursor:grab;
  border-radius:12px 12px 0 0;
}
#obs-param-family-panel .pf-hdr b {
  flex:1;font-size:13px;
  background:linear-gradient(90deg,#e8eaf0,#34d399);
  -webkit-background-clip:text;background-clip:text;color:transparent;
}
#obs-param-family-panel .pf-close {
  width:26px;height:26px;border-radius:6px;border:1px solid #2a2e3a;
  background:transparent;color:#94a3b8;cursor:pointer;
}
#obs-param-family-panel .pf-body { padding:10px 12px 14px; }
#obs-param-family-panel select, #obs-param-family-panel input {
  width:100%;padding:6px 8px;margin:4px 0 8px;
  background:#0e1017;border:1px solid #2a2e3a;border-radius:6px;
  color:#e8eaf0;font:12px Inter,system-ui;
}
#obs-param-family-panel .pf-row {
  display:grid;grid-template-columns:1fr 100px;gap:6px;align-items:center;
  margin-bottom:6px;
}
#obs-param-family-panel .pf-row label {
  color:#94a3b8;font-size:11px;overflow:hidden;text-overflow:ellipsis;
}
#obs-param-family-panel .pf-row label .formula {
  display:block;color:#34d399;font:10px ui-monospace,monospace;
}
#obs-param-family-panel .pf-actions {
  display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px;
}
#obs-param-family-panel .pf-btn {
  padding:8px;border-radius:7px;border:1px solid #2a2e3a;
  background:#1e2029;color:#e8eaf0;cursor:pointer;font:600 11px Inter,system-ui;
}
#obs-param-family-panel .pf-btn:hover { border-color:#34d399; }
#obs-param-family-panel .pf-status {
  margin-top:8px;padding:7px 9px;border-radius:6px;
  background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.2);
  color:#6ee7b7;font-size:11px;
}
#obs-param-family-panel .pf-sec {
  font:700 9px/1 Inter,system-ui;letter-spacing:.6px;text-transform:uppercase;
  color:#6b7280;margin:10px 0 6px;
}
`;
  document.head.appendChild(s);
}

function buildPanel(): void {
  if (panel) return;
  installStyle();
  panel = document.createElement("div");
  panel.id = "obs-param-family-panel";
  panel.innerHTML = `
    <div class="pf-hdr">
      <b>Parametric Families</b>
      <button class="pf-close" type="button">-</button>
    </div>
    <div class="pf-body">
      <div class="pf-sec">Family</div>
      <select data-family></select>
      <div class="pf-sec">Type</div>
      <select data-type></select>
      <div class="pf-sec">Parameters</div>
      <div data-params></div>
      <div class="pf-actions">
        <button class="pf-btn" data-act="rebuild" type="button">Rebuild geometry</button>
        <button class="pf-btn" data-act="place" type="button">Place instance</button>
        <button class="pf-btn" data-act="apply-type" type="button">Save type values</button>
        <button class="pf-btn" data-act="constraints" type="button">Show constraints</button>
      </div>
      <div class="pf-status" data-status>Select a family to edit parameters.</div>
    </div>
  `;
  document.body.appendChild(panel);

  panel.querySelector(".pf-close")?.addEventListener("click", () => closeParamFamilyPanel());

  panel.querySelector("[data-family]")?.addEventListener("change", (e) => {
    selectedFamilyId = (e.target as HTMLSelectElement).value || null;
    selectedTypeId = null;
    refreshTypes();
    refreshParams();
  });
  panel.querySelector("[data-type]")?.addEventListener("change", (e) => {
    selectedTypeId = (e.target as HTMLSelectElement).value || null;
    refreshParams();
  });

  panel.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest("[data-act]")?.getAttribute("data-act");
    if (!act) return;
    const svc = familySvc();
    if (act === "rebuild") {
      if (!selectedFamilyId) return;
      if (typeof svc.buildParametric === "function") {
        const result = svc.buildParametric(selectedFamilyId, selectedTypeId);
        const err = result?.errors?.length ? result.errors.join("; ") : "";
        const status = panel!.querySelector("[data-status]") as HTMLElement;
        if (result?.object) {
          // Add preview to scene
          try {
            const scene = (ctx as Any).world?.scene?.three;
            if (scene) {
              let g = scene.getObjectByName("obs-param-preview");
              if (g) scene.remove(g);
              result.object.name = "obs-param-preview";
              result.object.position.set(0, 0, 0);
              scene.add(result.object);
            }
          } catch { /* */ }
          status.textContent = err
            ? `Built with warnings: ${err}`
            : `Geometry built - ${Object.keys(result.params ?? {}).length} params`;
          toast("success", "Parametric geometry rebuilt");
        } else {
          status.textContent = err || "Build failed";
          toast("warn", "Build failed");
        }
      } else if (typeof svc.buildGeometry === "function") {
        const obj = svc.buildGeometry(selectedFamilyId, selectedTypeId);
        toast(obj ? "success" : "warn", obj ? "Geometry built" : "Build failed");
      }
    }
    if (act === "place") {
      const fam = svc.get?.(selectedFamilyId);
      if (!fam) return;
      try {
        const a = (ctx.features as Any)?.authoring;
        if (a?.setAuthoringTool && fam.sourceElementType) {
          a.setAuthoringTool(fam.sourceElementType);
          if (a.setActiveFamily) a.setActiveFamily(fam.id, selectedTypeId);
          toast("info", `Place tool: ${fam.sourceElementType}`);
        } else {
          toast("info", "Use Family Browser to place - or Rebuild for 3D preview");
        }
      } catch {
        toast("info", "Rebuild for preview; place via Family Browser");
      }
    }
    if (act === "apply-type") {
      if (!selectedFamilyId || !selectedTypeId) {
        toast("info", "Select a type first");
        return;
      }
      const values = readParamInputs();
      svc.updateType?.(selectedFamilyId, selectedTypeId, { values });
      toast("success", "Type values saved");
      refreshParams();
    }
    if (act === "constraints") {
      const list = svc.getConstraints?.(selectedFamilyId) ?? [];
      const status = panel!.querySelector("[data-status]") as HTMLElement;
      status.textContent = list.length
        ? `Constraints: ${list.map((c: Any) => c.kind).join(", ")}`
        : "No constraints on this family";
    }
  });

  // Drag
  const hdr = panel.querySelector(".pf-hdr") as HTMLElement;
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
    panel.style.right = "auto";
  });
  hdr.addEventListener("pointerup", () => {
    dragging = false;
  });
}

function readParamInputs(): Record<string, any> {
  const values: Record<string, any> = {};
  panel?.querySelectorAll("[data-param]").forEach((el) => {
    const name = (el as HTMLElement).getAttribute("data-param")!;
    const input = el as HTMLInputElement;
    if (input.type === "checkbox") values[name] = input.checked;
    else if (input.type === "number") values[name] = Number(input.value);
    else values[name] = input.value;
  });
  return values;
}

function refreshFamilies(): void {
  const sel = panel?.querySelector("[data-family]") as HTMLSelectElement | null;
  if (!sel) return;
  const list = familySvc().list?.() ?? [];
  sel.innerHTML =
    `<option value="">- select -</option>` +
    list
      .map(
        (f: Any) =>
          `<option value="${f.id}" ${f.id === selectedFamilyId ? "selected" : ""}>${escapeHtml(
            f.name,
          )} (${f.category ?? "?"})</option>`,
      )
      .join("");
}

function refreshTypes(): void {
  const sel = panel?.querySelector("[data-type]") as HTMLSelectElement | null;
  if (!sel) return;
  const fam = selectedFamilyId ? familySvc().get?.(selectedFamilyId) : null;
  const types = fam?.types ?? [];
  if (!selectedTypeId && types[0]) selectedTypeId = types[0].id;
  sel.innerHTML =
    `<option value="">- default -</option>` +
    types
      .map(
        (t: Any) =>
          `<option value="${t.id}" ${t.id === selectedTypeId ? "selected" : ""}>${escapeHtml(
            t.name,
          )}</option>`,
      )
      .join("");
}

function refreshParams(): void {
  const host = panel?.querySelector("[data-params]") as HTMLElement | null;
  if (!host) return;
  const svc = familySvc();
  const fam = selectedFamilyId ? svc.get?.(selectedFamilyId) : null;
  if (!fam) {
    host.innerHTML = `<div style="color:#6b7280">No family selected.</div>`;
    return;
  }
  const values =
    svc.resolveParametric?.(selectedFamilyId, selectedTypeId) ??
    svc.resolveParams?.(selectedFamilyId, selectedTypeId) ??
    {};

  host.innerHTML = (fam.parameters ?? [])
    .map((p: Any) => {
      const v = values[p.name] ?? p.default;
      const isFormula = !!p.formula;
      const readonly = isFormula || p.editable === false;
      if (p.type === "boolean") {
        return `<div class="pf-row">
          <label>${escapeHtml(p.name)}${
            isFormula ? `<span class="formula">= ${escapeHtml(p.formula)}</span>` : ""
          }</label>
          <input data-param="${escapeHtml(p.name)}" type="checkbox" ${v ? "checked" : ""} ${
            readonly ? "disabled" : ""
          }/>
        </div>`;
      }
      const inputType = p.type === "text" ? "text" : "number";
      return `<div class="pf-row">
        <label>${escapeHtml(p.name)}${
          isFormula ? `<span class="formula">= ${escapeHtml(String(p.formula))}</span>` : ""
        }</label>
        <input data-param="${escapeHtml(p.name)}" type="${inputType}" value="${escapeHtml(
          String(v ?? ""),
        )}" step="any" ${readonly ? "readonly" : ""}/>
      </div>`;
    })
    .join("");
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Any)[c],
  );
}

export function openParamFamilyPanel(): void {
  buildPanel();
  refreshFamilies();
  refreshTypes();
  refreshParams();
  panel?.classList.add("is-open");
}

export function closeParamFamilyPanel(): void {
  panel?.classList.remove("is-open");
}

export function toggleParamFamilyPanel(): void {
  if (panel?.classList.contains("is-open")) closeParamFamilyPanel();
  else openParamFamilyPanel();
}

export function setupParametricFamilyPanel(): void {
  const launch = document.createElement("button");
  launch.id = "obs-param-launch";
  launch.type = "button";
  launch.title = "Parametric Families (Ctrl+Shift+F)";
  launch.textContent = "FAM";
  launch.style.cssText =
    "position:fixed;left:168px;bottom:52px;z-index:10002;width:44px;height:40px;" +
    "border-radius:10px;border:1px solid #34d399;background:rgba(52,211,153,.14);" +
    "color:#6ee7b7;font:700 11px Inter,system-ui;cursor:pointer;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.35);display:none;";
  launch.onclick = () => toggleParamFamilyPanel();
  document.body.appendChild(launch);

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
      const t = e.target as HTMLElement;
      if (t?.closest?.("input,textarea,[contenteditable]")) return;
      e.preventDefault();
      toggleParamFamilyPanel();
    }
  });

  void (async () => {
    try {
      const cp: Any = await import("./command-palette");
      cp.registerCommand?.({
        id: "parametric.familyPanel",
        label: "Parametric Families Panel",
        category: "Architecture",
        kbd: "Ctrl+Shift+F",
        run: () => toggleParamFamilyPanel(),
      });
    } catch { /* */ }
  })();

  (window as Any).__obsParamFamilyPanel = {
    open: openParamFamilyPanel,
    close: closeParamFamilyPanel,
    toggle: toggleParamFamilyPanel,
  };

  console.log("[parametric-family-panel] ready - FAM button or Ctrl+Shift+F");
}
