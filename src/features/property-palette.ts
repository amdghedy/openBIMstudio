/**
 * BIM-style Properties palette.
 *
 * Two modes:
 *   • defaults — a tool is active; edits set the values applied to the next
 *     element placed.
 *   • edit    — one element is selected; edits apply live to that element.
 *
 * The palette is draggable, resizable, and dockable via the generic
 * `dockable.ts` controller. Position and size persist per panel ID.
 */
import { ctx } from "../core/context";
import {
  getActiveTool,
  getSelectedIds,
  getElements,
  getTypeDefaults,
  setTypeDefault,
  getPaletteTarget,
  setPaletteTarget,
  onAuthoringChange,
  rebuildAuthored,
  markAuthoringDirty,
  applyElementParamChange,
  isDrawToolActive,
  refreshPreview,
  resetTypeDefaults,
  getWallLocationLine, setWallLocationLine,
  getWallChain, setWallChain,
  getWallOffset, setWallOffset,
  getWallJoinStatus, setWallJoinStatus,
  getBeamJustification, setBeamJustification,
  getBeamZJustification, setBeamZJustification,
  getMepJustification, setMepJustification,
  getDrawSlope, setDrawSlope,
} from "./authoring";
import { getSchema, setLevelsProvider, type PropertyField, type FieldTarget } from "./property-schema";
import {
  getToolPanel,
  validatePanelNumber,
  type ToolPanelDescriptor,
  type ToolPanelField,
} from "./tool-panels";
import { coreThicknessFromLayers } from "../modules/justification";
import { units } from "../core/units";
import { svgIcon, type IconName } from "./icon-set";
import { levels } from "../modules/levels";
import { makeDockable, type DockHandle } from "./dockable";
import { selection } from "./selection";
import type { AuthoredElement } from "../modules/projects/types";

/* ═════════════════════════════════════════════════════════════════════════
   Panel shell
   ═════════════════════════════════════════════════════════════════════════ */
const panel = document.createElement("div");
panel.id = "obs-property-palette";
panel.style.cssText =
  "z-index:60;" +
  "display:none;flex-direction:column;background:var(--bg-floating,#1c1e28);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:10px;" +
  "box-shadow:0 12px 36px rgba(0,0,0,.55);font:12px system-ui,sans-serif;" +
  "color:var(--text-primary,#e8eaf0);overflow:hidden";
panel.addEventListener("mousedown", (e) => e.stopPropagation());

const header = document.createElement("div");
header.style.cssText =
  "display:flex;align-items:center;gap:8px;padding:9px 10px;" +
  "border-bottom:1px solid var(--border-subtle,#1e2029);" +
  "background:var(--bg-elevated,#181a23);cursor:move;user-select:none";

const body = document.createElement("div");
body.style.cssText = "flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:4px 0;overscroll-behavior:contain;scrollbar-width:auto";

panel.append(header, body);

let expanded = true;
let visible = false;
let dockHandle: DockHandle | null = null;

/* ═════════════════════════════════════════════════════════════════════════
   Field I/O
   ═════════════════════════════════════════════════════════════════════════ */
function readValue(
  target: FieldTarget,
  element: AuthoredElement | null,
  typeKey: string,
  key: string,
): string | number | boolean {
  if (target === "root") {
    if (element) return (element as any)[key] ?? "";
    const d = getTypeDefaults(typeKey);
    return (d as any)[key] ?? "";
  }
  if (element) {
    if (target === "params") {
      const v = (element.params as any)[key];
      return v ?? "";
    }
    return (element.properties?.[key] as any) ?? "";
  }
  const d = getTypeDefaults(typeKey);
  if (target === "params") return (d.params as any)?.[key] ?? "";
  return (d.properties as any)?.[key] ?? "";
}

import { isElementLocked, getLockOwner } from "../modules/collaboration/workshare-locks";

function writeValue(
  target: FieldTarget,
  element: AuthoredElement | null,
  typeKey: string,
  key: string,
  value: string | number | boolean,
): void {
  if (element) {
    if (isElementLocked(element.id)) {
      alert(`Cannot edit: this element is currently locked by ${getLockOwner(element.id)}.`);
      return;
    }
    // Elbow bend radius re-trims connected runs through the authoring service.
    if (key === "bendRadius" && element.type === "fitting") {
      import("./authoring").then((m) => (m as any).setElbowBendRadius?.(element.id, Number(value)));
      return;
    }
    // 1. Snapshot the "before" state for Undo
    const before = JSON.parse(JSON.stringify(element));

    // 2. Apply the new value — geometric params go through the authoritative
    //    applyElementParamChange path so Native Twin / authored solids regenerate.
    const geometricKeys = new Set([
      "height", "thickness", "width", "depth", "elevation", "sillHeight",
      "offsetAlongHost", "frameThickness", "length", "rotation",
    ]);
    if (target === "params" && geometricKeys.has(key) && typeof value === "number") {
      const res = applyElementParamChange(element.id, key, value);
      if (!res?.ok) {
        Object.assign(element, before);
        window.dispatchEvent(new CustomEvent("obs-toast", {
          detail: { message: res?.reason || "Could not apply parameter", kind: "error" },
        }));
        return;
      }
    } else if (target === "root") {
      (element as any)[key] = value;
    } else if (target === "params") {
      (element.params as any)[key] = value;
    } else {
      element.properties = { ...(element.properties ?? {}), [key]: value };
    }

    // 3. Snapshot the "after" state for Redo
    const after = JSON.parse(JSON.stringify(element));

    // 4. Non-geometric fields still need an explicit rebuild
    if (!(target === "params" && geometricKeys.has(key) && typeof value === "number")) {
      try {
        import("./authoring").then((m) => {
          m.rebuildAuthored();
          m.markAuthoringDirty();
        });
      } catch (e) { /* */ }
    }

    // 5. Push to History so Ctrl+Z works
    try {
      import("./history").then((m) => {
        m.history.push({
          label: `Edit ${key} · ${element.name || element.id}`,
          apply: () => {
            Object.assign(element, after);
            import("./authoring").then(m => m.rebuildAuthored());
          },
          revert: () => {
            Object.assign(element, before);
            import("./authoring").then(m => m.rebuildAuthored());
          }
        });
      });
    } catch (e) { /* */ }
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Input builders
   ═════════════════════════════════════════════════════════════════════════ */
const INPUT_CSS =
  "width:100%;box-sizing:border-box;padding:4px 6px;background:var(--bg-inset,#0e1017);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:4px;" +
  "color:var(--text-primary,#e8eaf0);font:12px system-ui;outline:none";

function fieldRow(
  field: PropertyField,
  getValue: () => any,
  setValue: (v: any) => void,
): HTMLElement {
  const row = document.createElement("div");
  row.style.cssText = "display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center;padding:3px 12px";

  const label = document.createElement("label");
  label.textContent = field.label;
  label.style.cssText = "font-size:11px;color:var(--text-secondary,#a0a6b5)";
  if (field.helpText) label.title = field.helpText;

  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;gap:4px;align-items:center";

  let input: HTMLElement;

  switch (field.type) {
    case "number": {
      const i = document.createElement("input");
      i.type = "number";
      i.step = String(field.step ?? 0.1);
      if (field.min != null) i.min = String(field.min);
      if (field.max != null) i.max = String(field.max);
      i.value = String(getValue() ?? "");
      i.style.cssText = INPUT_CSS + ";text-align:right";
      i.onchange = () => {
        let v = Number(i.value);
        if (!Number.isFinite(v)) v = 0;
        if (field.min != null) v = Math.max(field.min, v);
        if (field.max != null) v = Math.min(field.max, v);
        i.value = String(v);
        setValue(v);
      };
      input = i;
      break;
    }
    case "text": {
      const i = document.createElement("input");
      i.type = "text";
      i.value = String(getValue() ?? "");
      i.style.cssText = INPUT_CSS;
      i.onchange = () => setValue(i.value);
      input = i;
      break;
    }
    case "select": {
      const s = document.createElement("select");
      s.style.cssText = INPUT_CSS + ";cursor:pointer";
      const cur = String(getValue() ?? field.default ?? "");
      s.innerHTML =
        `<option value="">—</option>` +
        (field.options ?? [])
          .map(
            (o) =>
              `<option value="${o.value}" ${o.value === cur ? "selected" : ""}>${o.label}</option>`,
          )
          .join("");
      s.onchange = () => setValue(s.value);
      input = s;
      break;
    }
    case "boolean": {
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = !!getValue();
      c.style.cssText = "cursor:pointer";
      c.onchange = () => setValue(c.checked);
      input = c;
      break;
    }
    case "color": {
      const i = document.createElement("input");
      i.type = "color";
      i.value = String(getValue() || "#cccccc");
      i.style.cssText = "width:100%;height:22px;background:none;border:1px solid var(--border-default,#2a2e3a);border-radius:4px;cursor:pointer";
      i.oninput = () => setValue(i.value);
      input = i;
      break;
    }
  }

  if (field.readOnly) {
    try {
      const inp2: any = input;
      if (inp2.tagName === "INPUT" || inp2.tagName === "SELECT") {
        inp2.disabled = true;
        inp2.style.opacity = "0.65";
        inp2.style.cursor = "not-allowed";
        inp2.title = "Read-only (computed from geometry)";
      }
    } catch { /* */ }
  }

  wrap.appendChild(input);
  if (field.unit) {
    const u = document.createElement("span");
    u.textContent = field.unit;
    u.style.cssText = "font-size:10px;color:var(--text-tertiary,#6b7280);min-width:16px";
    wrap.appendChild(u);
  }

  row.append(label, wrap);
  return row;
}

/* ═════════════════════════════════════════════════════════════════════════
   Collapsible sections
   ═════════════════════════════════════════════════════════════════════════ */
const sectionState = new Map<string, boolean>();

function sectionBlock(
  groupName: string,
  fields: PropertyField[],
  element: AuthoredElement | null,
  typeKey: string,
): HTMLElement {
  const key = `${typeKey}:${groupName}`;
  const open = sectionState.get(key) ?? true;

  const block = document.createElement("div");
  block.style.cssText = "border-bottom:1px solid var(--border-subtle,#1e2029)";

  const headerRow = document.createElement("div");
  headerRow.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:7px 12px;cursor:pointer;" +
    "background:var(--bg-elevated,#181a23);user-select:none";

  const caret = document.createElement("span");
  caret.textContent = open ? "▾" : "▸";
  caret.style.cssText = "width:10px;font-size:9px;color:var(--text-tertiary,#6b7280)";

  const title = document.createElement("span");
  title.textContent = groupName;
  title.style.cssText = "font-weight:600;font-size:11.5px;letter-spacing:.2px";

  headerRow.append(caret, title);

  const list = document.createElement("div");
  list.style.cssText = "padding:4px 0;display:" + (open ? "block" : "none");

  for (const f of fields) {
    list.appendChild(
      fieldRow(
        f,
        () => (typeof (f as any).compute === "function" && element)
          ? (f as any).compute(element)
          : readValue(f.target, element, typeKey, f.key),
        (v) => writeValue(f.target, element, typeKey, f.key, v),
      ),
    );
  }

  headerRow.onclick = () => {
    const now = !(sectionState.get(key) ?? true);
    sectionState.set(key, now);
    caret.textContent = now ? "▾" : "▸";
    list.style.display = now ? "block" : "none";
  };

  block.append(headerRow, list);
  return block;
}

// openbim-families:instance-wiring
//
// "Family identity" block. Shown when the selected element carries a
// familyId. Lets the user switch the element's type; every instance of
// the new type is re-synced from its parametric definition.
//
// Writes:
//   element.familyTypeId = selected type id
//   then authoring.syncFamilyInstances(famId, newTypeId) re-resolves
//   params for every element carrying that type.
function makeFamilyIdentityBlock(element: AuthoredElement): HTMLElement {
  const block = document.createElement("div");
  block.style.cssText = "border-bottom:1px solid var(--border-subtle,#1e2029)";

  const headerRow = document.createElement("div");
  headerRow.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:7px 12px;" +
    "background:var(--bg-elevated,#181a23);user-select:none";
  const caret = document.createElement("span");
  caret.textContent = "\u25BE";
  caret.style.cssText = "width:10px;font-size:9px;color:var(--text-tertiary,#6b7280)";
  const title = document.createElement("span");
  title.textContent = "Family";
  title.style.cssText = "font-weight:600;font-size:11.5px;letter-spacing:.2px";
  headerRow.append(caret, title);

  const list = document.createElement("div");
  list.style.cssText = "padding:4px 0";

  const familyService: any = (ctx.features as any).family;
  const fam = familyService?.get?.(element.familyId);

  if (!fam) {
    const warn = document.createElement("div");
    warn.textContent = "Family not found: " + element.familyId;
    warn.style.cssText = "padding:4px 12px;font-size:11px;color:var(--obs-pp-warn-fg, #fca5a5)";
    list.appendChild(warn);
    block.append(headerRow, list);
    return block;
  }

  const rowFam = document.createElement("div");
  rowFam.style.cssText =
    "display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center;padding:3px 12px";
  const lblFam = document.createElement("label");
  lblFam.textContent = "Family";
  lblFam.style.cssText = "font-size:11px;color:var(--text-secondary,#a0a6b5)";
  const valFam = document.createElement("span");
  valFam.textContent = fam.name;
  valFam.style.cssText = "font-size:12px;color:#e8eaf0";
  rowFam.append(lblFam, valFam);
  list.appendChild(rowFam);

  const rowType = document.createElement("div");
  rowType.style.cssText = rowFam.style.cssText;
  const lblType = document.createElement("label");
  lblType.textContent = "Type";
  lblType.style.cssText = "font-size:11px;color:var(--text-secondary,#a0a6b5)";
  const selType = document.createElement("select");
  selType.style.cssText =
    "width:100%;box-sizing:border-box;padding:4px 6px;" +
    "background:var(--bg-inset,#0e1017);border:1px solid var(--border-default,#2a2e3a);" +
    "border-radius:4px;color:var(--text-primary,#e8eaf0);font:12px system-ui;cursor:pointer";
  selType.innerHTML = fam.types.map(
    (t: any) =>
      "<option value=\"" + t.id + "\">" + t.name + "</option>",
  ).join("");
  selType.value = element.familyTypeId ?? (fam.types[0]?.id ?? "");
  selType.onchange = () => {
    const newTypeId = selType.value || null;
    const prevType = element.familyTypeId ?? null;
    if (newTypeId === prevType) return;
    element.familyTypeId = newTypeId ?? undefined;
    try {
      const auth: any = (ctx.features as any).authoring;
      const n = auth?.syncFamilyInstances?.(fam.id, newTypeId) ?? 0;
      if (n > 0) {
        console.log(
          "[property-palette] synced " + n + " instance(s) of type " + newTypeId,
        );
      }
    } catch (err) {
      console.warn("[property-palette] sync after type change failed", err);
    }
    markAuthoringDirty();
    render();
  };
  rowType.append(lblType, selType);
  list.appendChild(rowType);

  // openbim-family-placement: instance-scope parameters edit this element
  // directly; type-scope parameters update the family type and re-sync
  // every instance of that type. This is the BIM Type/Instance split.
  try {
    const resolvedNow = familyService.resolveParams(
      fam.id,
      element.familyTypeId ?? null,
      undefined,
    ) ?? {};

    if (fam.parameters.length > 0) {
      const paramHeader = document.createElement("div");
      paramHeader.textContent = "Parameters";
      paramHeader.style.cssText =
        "font-weight:600;font-size:10.5px;color:var(--text-tertiary,#6b7280);" +
        "padding:8px 12px 2px;letter-spacing:.4px;text-transform:uppercase";
      list.appendChild(paramHeader);

      for (const p of fam.parameters) {
        const current = (resolvedNow as any)[p.name];
        if (current === undefined) continue;

        const row = document.createElement("div");
        row.style.cssText =
          "display:grid;grid-template-columns:110px 1fr 22px;gap:6px;align-items:center;padding:3px 12px";

        const lbl = document.createElement("label");
        lbl.textContent = p.label ?? p.name;
        lbl.style.cssText = "font-size:11px;color:var(--text-secondary,#a0a6b5)";

        const inp = document.createElement("input");
        inp.type = typeof current === "number" ? "number" : "text";
        if (typeof current === "number") inp.step = String(p.step ?? 0.01);
        inp.value = String(current);
        inp.style.cssText =
          "width:100%;box-sizing:border-box;padding:4px 6px;text-align:right;" +
          "background:var(--bg-inset,#0e1017);border:1px solid var(--border-default,#2a2e3a);" +
          "border-radius:4px;color:var(--text-primary,#e8eaf0);font:12px system-ui";
        inp.onchange = () => {
          const isNum = typeof current === "number";
          const v = isNum ? Number(inp.value) : inp.value;
          if (isNum && !Number.isFinite(v)) { inp.value = String(current); return; }
          void (async () => {
            try {
              const mod: any = await import("../modules/families/placement");
              const res = mod.editFamilyParameter(element, p.name, v);
              if (res.applied === "type" && res.instancesSynced > 0) {
                window.dispatchEvent(new CustomEvent("obs-toast", {
                  detail: {
                    message: "Updated " + res.instancesSynced + " instance(s)",
                    kind: "success",
                  },
                }));
              }
            } catch (err) {
              console.warn("[property-palette] family param edit failed", err);
            }
            markAuthoringDirty();
            render();
          })();
        };

        const scope = document.createElement("span");
        scope.textContent = p.scope === "type" ? "T" : "I";
        scope.title = p.scope === "type" ? "Type parameter" : "Instance parameter";
        scope.style.cssText =
          "font:700 10px ui-monospace,monospace;text-align:center;" +
          "border-radius:3px;padding:2px 0;" +
          (p.scope === "type"
            ? "background:var(--obs-pp-type-bg, rgba(56,189,248,.14));color:var(--obs-pp-type-fg, #7dd3fc)"
            : "background:var(--obs-pp-inst-bg, rgba(168,85,247,.14));color:var(--obs-pp-inst-fg, #c4b5fd)");

        row.append(lbl, inp, scope);
        list.appendChild(row);
      }
    }
  } catch (err) {
    console.warn("[property-palette] family parameter table failed", err);
  }

  block.append(headerRow, list);
  return block;
}

/* ═════════════════════════════════════════════════════════════════════════
   Header
   ═════════════════════════════════════════════════════════════════════════ */
function renderHeader(mode: "defaults" | "edit", typeLabel: string, elementName?: string) {
  header.innerHTML = "";

  const icon = document.createElement("span");
  icon.style.cssText = "display:flex;color:var(--accent,#38bdf8)";
  try {
    icon.innerHTML = svgIcon("component" as IconName);
  } catch {
    icon.textContent = "◧";
  }

  const text = document.createElement("div");
  text.style.cssText = "flex:1;min-width:0";

  const title = document.createElement("div");
  title.style.cssText = "font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  title.textContent =
    mode === "defaults"
      ? `${typeLabel} — defaults`
      : elementName
        ? elementName
        : `${typeLabel} — instance`;

  const sub = document.createElement("div");
  sub.style.cssText = "font-size:10px;color:var(--text-tertiary,#6b7280);margin-top:1px";
  sub.textContent =
    mode === "defaults"
      ? "Applied to the next element you place"
      : "Edit the selected element";

  text.append(title, sub);

  const collapseBtn = document.createElement("button");
  collapseBtn.textContent = expanded ? "▾" : "▸";
  collapseBtn.title = "Collapse / expand";
  collapseBtn.style.cssText =
    "padding:2px 6px;background:transparent;color:var(--text-secondary);" +
    "border:1px solid var(--border-default);border-radius:4px;cursor:pointer;font-size:10px";
  collapseBtn.onclick = () => {
    expanded = !expanded;
    body.style.display = expanded ? "block" : "none";
    render();
  };

  header.append(icon, text, collapseBtn);
}

/* ═══════════════════════════════════════════════════════════════════════
   Modeling tool panel (MASTER PROMPT §2) — contextual per-tool parameters
   rendered from the declarative registry in tool-panels.ts. Values write
   to the type defaults (what the NEXT placed element receives) or to live
   authoring state (location line, chain, slope, justification…), and every
   write refreshes the placement preview immediately.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Live authoring-state accessors used by "authoring"-bound fields. */
const AUTHORING_STATE: Record<string, { get: () => any; set: (v: any) => void }> = {
  wallLocationLine: { get: () => getWallLocationLine(), set: (v) => setWallLocationLine(v) },
  wallChain: { get: () => getWallChain(), set: (v) => setWallChain(!!v) },
  wallOffset: { get: () => getWallOffset(), set: (v) => setWallOffset(Number(v) || 0) },
  wallJoinStatus: { get: () => getWallJoinStatus(), set: (v) => setWallJoinStatus(v) },
  beamJustification: { get: () => getBeamJustification(), set: (v) => setBeamJustification(v) },
  beamZJustification: { get: () => getBeamZJustification(), set: (v) => setBeamZJustification(v) },
  mepJustification: { get: () => getMepJustification(), set: (v) => setMepJustification(v) },
  drawSlope: { get: () => getDrawSlope(), set: (v) => setDrawSlope(Number(v) || 0) },
};

function readToolFieldValue(field: ToolPanelField, elementType: string): any {
  if (!field.bind) return "";
  if (field.bind.kind === "authoring") {
    const s = AUTHORING_STATE[field.bind.stateKey];
    return s ? s.get() : "";
  }
  const d = getTypeDefaults(elementType);
  if (field.bind.target === "params") return (d.params as any)[field.bind.key] ?? "";
  return (d.properties as any)[field.bind.key] ?? "";
}

function writeToolFieldValue(field: ToolPanelField, elementType: string, v: any): void {
  if (!field.bind) return;
  if (field.bind.kind === "authoring") {
    const s = AUTHORING_STATE[field.bind.stateKey];
    if (s) s.set(v);
    return;
  }
  setTypeDefault(elementType, field.bind.target, field.bind.key, v);
}

/** §3.1 — core location-line options need a compound core in the type. */
function coreLayersSupported(elementType: string): boolean {
  try {
    const d = getTypeDefaults(elementType);
    const layers = d.properties?.layers as string | undefined;
    const t = Number(d.params?.thickness) || 0.2;
    return coreThicknessFromLayers(layers, t) != null;
  } catch { return false; }
}

/** Numeric display in the app's configured unit system. */
function formatPanelNumber(field: ToolPanelField, v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v == null ? "" : String(v);
  if (field.unit === "m") {
    try { return units.formatLength(n, { withUnit: false }); } catch { return String(n); }
  }
  return String(n);
}

/** Parse user input to SI using the app's unit grammar (§2.3). */
function parsePanelNumber(field: ToolPanelField, raw: string): number | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (field.unit === "m") {
    const parsed = units.parseLengthInput(text);
    if (parsed != null && Number.isFinite(parsed)) return parsed;
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function renderToolField(field: ToolPanelField, elementType: string): HTMLElement {
  const row = document.createElement("div");

  if (field.kind === "info") {
    row.style.cssText = "padding:4px 12px 6px";
    const hint = document.createElement("div");
    hint.textContent = field.text ?? "";
    hint.style.cssText = "font-size:10.5px;color:var(--text-tertiary,#6b7280);line-height:1.45";
    row.appendChild(hint);
    return row;
  }

  row.style.cssText = "display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center;padding:3px 12px";

  const label = document.createElement("label");
  label.textContent = field.label;
  label.style.cssText = "font-size:11px;color:var(--text-secondary,#a0a6b5)";
  if (field.helpText) label.title = field.helpText;

  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;gap:4px;align-items:center;min-width:0";

  const errRow = document.createElement("div");
  errRow.style.cssText =
    "display:none;grid-column:1 / -1;font-size:10px;color:var(--obs-pp-warn-fg,#fca5a5);padding:0 12px 2px";

  const setErr = (msg: string | null) => {
    if (msg) {
      errRow.textContent = msg;
      errRow.style.display = "block";
    } else {
      errRow.style.display = "none";
    }
  };

  const commit = (v: any) => {
    writeToolFieldValue(field, elementType, v);
    // §2.3 — update the modeling preview immediately.
    try { refreshPreview(); } catch { /* preview optional */ }
  };

  switch (field.kind) {
    case "number": {
      const i = document.createElement("input");
      i.type = "text";
      i.inputMode = "decimal";
      i.value = formatPanelNumber(field, readToolFieldValue(field, elementType));
      i.style.cssText = INPUT_CSS + ";text-align:right";
      i.onchange = () => {
        const raw = i.value.trim();
        if (!raw) { setErr(null); return; }
        const v = parsePanelNumber(field, raw);
        if (v == null) {
          setErr("Enter a valid number" + (field.unit ? ` (e.g. ${field.unit})` : ""));
          i.style.borderColor = "var(--obs-pp-warn-fg,#fca5a5)";
          return;
        }
        const problem = validatePanelNumber(field, v);
        if (problem) {
          setErr(problem);
          i.style.borderColor = "var(--obs-pp-warn-fg,#fca5a5)";
          return;
        }
        setErr(null);
        i.style.borderColor = "";
        i.value = formatPanelNumber(field, v);
        commit(v);
      };
      i.oninput = () => { setErr(null); i.style.borderColor = ""; };
      wrap.appendChild(i);
      break;
    }
    case "select": {
      const s = document.createElement("select");
      s.style.cssText = INPUT_CSS + ";cursor:pointer";
      const cur = String(readToolFieldValue(field, elementType) ?? "");
      s.innerHTML = (field.options ?? [])
        .map((o) => `<option value="${o.value}" ${o.value === cur ? "selected" : ""}>${o.label}</option>`)
        .join("");
      s.onchange = () => { commit(s.value); };
      wrap.appendChild(s);
      break;
    }
    case "boolean": {
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = !!readToolFieldValue(field, elementType);
      c.style.cssText = "cursor:pointer";
      c.onchange = () => { commit(c.checked); };
      wrap.appendChild(c);
      break;
    }
  }

  if (field.unit) {
    const u = document.createElement("span");
    u.textContent = field.unit;
    u.style.cssText = "font-size:10px;color:var(--text-tertiary,#6b7280);min-width:16px";
    wrap.appendChild(u);
  }

  row.append(label, wrap, errRow);
  return row;
}

function renderToolPanel(desc: ToolPanelDescriptor): HTMLElement {
  const block = document.createElement("div");
  block.style.cssText = "border-bottom:1px solid var(--border-subtle,#1e2029)";

  const headerRow = document.createElement("div");
  headerRow.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:7px 12px;cursor:pointer;" +
    "background:var(--bg-elevated,#181a23);user-select:none";

  const caret = document.createElement("span");
  const openKey = `tool:${desc.tool}`;
  const open = sectionState.get(openKey) ?? true;
  caret.textContent = open ? "▾" : "▸";
  caret.style.cssText = "width:10px;font-size:9px;color:var(--text-tertiary,#6b7280)";

  const title = document.createElement("span");
  title.textContent = "Tool Options";
  title.style.cssText = "font-weight:600;font-size:11.5px;letter-spacing:.2px;flex:1";

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "Reset";
  resetBtn.title = "Restore factory defaults for this tool";
  resetBtn.style.cssText =
    "padding:2px 8px;background:transparent;color:var(--text-secondary);" +
    "border:1px solid var(--border-default);border-radius:4px;cursor:pointer;font-size:10px";
  resetBtn.onclick = (ev) => {
    ev.stopPropagation();
    resetTypeDefaults(desc.elementType);
    try { refreshPreview(); } catch { /* */ }
    render();
  };

  headerRow.append(caret, title, resetBtn);

  const list = document.createElement("div");
  list.style.cssText = "padding:4px 0;display:" + (open ? "block" : "none");

  headerRow.onclick = () => {
    const now = !(sectionState.get(openKey) ?? true);
    sectionState.set(openKey, now);
    caret.textContent = now ? "▾" : "▸";
    list.style.display = now ? "block" : "none";
  };

  const coreOk = coreLayersSupported(desc.elementType);
  for (const g of desc.groups) {
    const gTitle = document.createElement("div");
    gTitle.textContent = g.title;
    gTitle.style.cssText =
      "font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;" +
      "color:var(--text-tertiary,#6b7280);padding:6px 12px 2px";
    list.appendChild(gTitle);
    for (const f of g.fields) {
      // §3.1 — hide core-specific controls unless the data model supports
      // a compound core; never show controls that do nothing.
      if (f.requiresCoreLayers && !coreOk) continue;
      list.appendChild(renderToolField(f, desc.elementType));
    }
  }

  block.append(headerRow, list);
  return block;
}

/* ═════════════════════════════════════════════════════════════════════════
   Render
   ═════════════════════════════════════════════════════════════════════════ */
function render() {
  const target = getPaletteTarget();

  if (!target) {
    // Keep open if user explicitly opened Properties — show view properties
    if (visible) {
      if (dockHandle) dockHandle.show();
      else panel.style.display = "flex";
      renderViewProperties();
    } else {
      if (dockHandle) dockHandle.hide();
      else panel.style.display = "none";
    }
    return;
  }

  visible = true;
  if (dockHandle) dockHandle.show();
  else panel.style.display = "flex";

  const schema = getSchema(target.type);
  // MASTER PROMPT §2 — while a draw tool is active, its contextual panel
  // renders even when the element type has no other schema yet.
  const toolPanelDesc = target.mode === "defaults" ? getToolPanel(getActiveTool()) : null;
  if (!schema && !toolPanelDesc) {
    header.innerHTML = "";
    const t = document.createElement("div");
    t.textContent = `${target.type} — no editable properties`;
    t.style.cssText = "font-weight:600;flex:1";
    header.appendChild(t);
    body.innerHTML = "";
    return;
  }

  let element: AuthoredElement | null = null;
  if (target.mode === "edit") {
    element = getElements().find((e) => e.id === target.elementId) ?? null;
    if (!element) {
      // Element deleted underneath us — fall back to tool defaults.
      setPaletteTarget(
        getActiveTool() ? { mode: "defaults", type: getActiveTool() as any } : null,
      );
      return;
    }
  }

  renderHeader(
    target.mode,
    schema ? schema.label : (toolPanelDesc?.title ?? target.type),
    element ? element.name : undefined,
  );

  body.innerHTML = "";
  body.style.display = expanded ? "block" : "none";

  // Contextual tool parameters come first while a tool is active.
  if (toolPanelDesc) {
    try { body.appendChild(renderToolPanel(toolPanelDesc)); }
    catch (err) { console.warn("[property-palette] tool panel failed", err); }
  }

  if (schema) {
    const byGroup = new Map<string, PropertyField[]>();
    for (const f of schema.fields) {
      const arr = byGroup.get(f.group) ?? [];
      arr.push(f);
      byGroup.set(f.group, arr);
    }
    for (const g of schema.groups) {
      const fields = byGroup.get(g);
      if (!fields || !fields.length) continue;
      body.appendChild(sectionBlock(g, fields, element, schema.type));
    }
  }

  // openbim-levels:ui-wired:property-palette
  if (element && schema && LEVEL_CONSTRAINED_TYPES.has(schema.type)) {
    try { body.appendChild(makeLevelConstraintsBlock(element)); }
    catch (err) { console.warn("[property-palette] level constraints failed", err); }
  }

  // openbim-families:instance-wiring
  if (element && element.familyId) {
    try { body.appendChild(makeFamilyIdentityBlock(element)); }
    catch (err) { console.warn("[property-palette] family identity failed", err); }
  }
}

/** Element types that carry a BIM-style "Base Constraint" (level). */
const LEVEL_CONSTRAINED_TYPES = new Set<string>([
  "wall", "slab", "column", "beam", "brace", "truss",
  "footing", "strip",
  "door", "window",
  "duct", "pipe", "cable-tray", "conduit", "equipment",
]);

/**
 * Build a "Constraints" block bound to `element.levelId`.
 *
 * Writes:
 *   element.levelId          = selected level id
 *   element.params.elevation = level.elevation + baseOffset
 *
 * baseOffset is derived on read as
 *   (element.params.elevation - level.elevation)
 * so a user who edited elevation manually sees a stable offset.
 */
function makeLevelConstraintsBlock(element: AuthoredElement): HTMLElement {
  const block = document.createElement("div");
  block.style.cssText = "border-bottom:1px solid var(--border-subtle,#1e2029)";

  const headerRow = document.createElement("div");
  headerRow.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:7px 12px;" +
    "background:var(--bg-elevated,#181a23);user-select:none";
  const caret = document.createElement("span");
  caret.textContent = "\u25BE";
  caret.style.cssText = "width:10px;font-size:9px;color:var(--text-tertiary,#6b7280)";
  const title = document.createElement("span");
  title.textContent = "Constraints";
  title.style.cssText = "font-weight:600;font-size:11.5px;letter-spacing:.2px";
  headerRow.append(caret, title);

  const list = document.createElement("div");
  list.style.cssText = "padding:4px 0";

  const all = levels.list();

  const rowBase = document.createElement("div");
  rowBase.style.cssText =
    "display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center;padding:3px 12px";
  const lblBase = document.createElement("label");
  lblBase.textContent = "Base Constraint";
  lblBase.style.cssText = "font-size:11px;color:var(--text-secondary,#a0a6b5)";
  const selBase = document.createElement("select");
  selBase.style.cssText =
    "width:100%;box-sizing:border-box;padding:4px 6px;" +
    "background:var(--bg-inset,#0e1017);border:1px solid var(--border-default,#2a2e3a);" +
    "border-radius:4px;color:var(--text-primary,#e8eaf0);font:12px system-ui;cursor:pointer";
  selBase.innerHTML =
    "<option value=\"\">-- none --</option>" +
    all.map((l) =>
      "<option value=\"" + l.id + "\">" + l.name + " (" + l.elevation.toFixed(2) + " m)</option>",
    ).join("");
  selBase.value = element.levelId ?? "";
  selBase.onchange = () => {
    const id = selBase.value || null;
    const before = {
      levelId: element.levelId,
      elevation: element.params.elevation,
    };
    const target = id ? all.find((l) => l.id === id) ?? null : null;
    element.levelId = id ?? undefined;
    if (target) {
      element.params.elevation = target.elevation;
    } else {
      element.params.elevation = before.elevation;
    }
    rebuildAuthored();
    markAuthoringDirty();
    const after = {
      levelId: element.levelId,
      elevation: element.params.elevation,
    };
    try {
      const hist = (ctx.features as any).history;
      hist?.push?.({
        label: "Base Constraint - " + element.name,
        apply: () => {
          element.levelId = after.levelId;
          element.params.elevation = after.elevation;
          rebuildAuthored(); markAuthoringDirty();
        },
        revert: () => {
          element.levelId = before.levelId;
          element.params.elevation = before.elevation;
          rebuildAuthored(); markAuthoringDirty();
        },
      });
    } catch { /* history optional */ }
    render();
  };
  rowBase.append(lblBase, selBase);
  list.appendChild(rowBase);

  const activeLevel = element.levelId
    ? all.find((l) => l.id === element.levelId) ?? null
    : null;
  const offsetVal = activeLevel
    ? element.params.elevation - activeLevel.elevation
    : 0;

  const rowOff = document.createElement("div");
  rowOff.style.cssText = rowBase.style.cssText;
  const lblOff = document.createElement("label");
  lblOff.textContent = "Base Offset";
  lblOff.style.cssText = "font-size:11px;color:var(--text-secondary,#a0a6b5)";
  const offWrap = document.createElement("div");
  offWrap.style.cssText = "display:flex;gap:4px;align-items:center";
  const inpOff = document.createElement("input");
  inpOff.type = "number";
  inpOff.step = "0.05";
  inpOff.value = offsetVal.toFixed(3);
  inpOff.disabled = !activeLevel;
  inpOff.style.cssText =
    "flex:1;box-sizing:border-box;padding:4px 6px;text-align:right;" +
    "background:var(--bg-inset,#0e1017);border:1px solid var(--border-default,#2a2e3a);" +
    "border-radius:4px;color:var(--text-primary,#e8eaf0);font:12px system-ui";
  if (!activeLevel) inpOff.style.opacity = "0.5";
  inpOff.onchange = () => {
    if (!activeLevel) return;
    const v = Number(inpOff.value);
    if (!Number.isFinite(v)) { inpOff.value = offsetVal.toFixed(3); return; }
    const before = element.params.elevation;
    const after = activeLevel.elevation + v;
    element.params.elevation = after;
    rebuildAuthored(); markAuthoringDirty();
    try {
      const hist = (ctx.features as any).history;
      hist?.push?.({
        label: "Base Offset - " + element.name,
        apply: () => { element.params.elevation = after; rebuildAuthored(); markAuthoringDirty(); },
        revert: () => { element.params.elevation = before; rebuildAuthored(); markAuthoringDirty(); },
      });
    } catch { /* */ }
    render();
  };
  const unit = document.createElement("span");
  unit.textContent = "m";
  unit.style.cssText = "font-size:10px;color:var(--text-tertiary,#6b7280);min-width:16px";
  offWrap.append(inpOff, unit);
  rowOff.append(lblOff, offWrap);
  list.appendChild(rowOff);

  block.append(headerRow, list);
  return block;
}

/* ═════════════════════════════════════════════════════════════════════════
   Public
   ═════════════════════════════════════════════════════════════════════════ */
export function openPropertyPalette() {
  visible = true;
  if (dockHandle) dockHandle.show();
  else panel.style.display = "flex";
  if (!getPaletteTarget()) renderViewProperties();
  else render();
}
export function closePropertyPalette() {
  visible = false;
  if (dockHandle) dockHandle.hide();
  else panel.style.display = "none";
}
export function isPropertyPaletteVisible(): boolean {
  return visible;
}
export function togglePropertyPalette() {
  if (visible) closePropertyPalette();
  else openPropertyPalette();
}

/** BIM-style view / graphics properties when no element is selected. */
function renderViewProperties() {
  try {
    renderHeader("defaults", "3D View", "Project view");
  } catch {
    header.innerHTML = `<div style="font-weight:700;flex:1">3D View — Properties</div>`;
  }
  body.innerHTML = "";
  body.style.display = "block";

  const section = (title: string, rows: { label: string; value: string }[]) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "padding:6px 10px 10px";
    const h = document.createElement("div");
    h.style.cssText =
      "font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;" +
      "color:#64748b;margin:4px 0 6px;padding-bottom:4px;border-bottom:1px solid #1e2029";
    h.textContent = title;
    wrap.appendChild(h);
    for (const r of rows) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;justify-content:space-between;align-items:center;padding:4px 0;gap:8px";
      const lab = document.createElement("span");
      lab.style.cssText = "color:#94a3b8";
      lab.textContent = r.label;
      const val = document.createElement("span");
      val.style.cssText =
        "color:#e2e8f0;background:#12141b;border:1px solid #2a2e3a;border-radius:4px;" +
        "padding:2px 8px;min-width:72px;text-align:right;font-variant-numeric:tabular-nums";
      val.textContent = r.value;
      row.append(lab, val);
      wrap.appendChild(row);
    }
    return wrap;
  };

  body.appendChild(section("Identity", [
    { label: "View name", value: "3D View" },
    { label: "View type", value: "3D" },
    { label: "Discipline", value: "Coordination" },
  ]));
  body.appendChild(section("Graphics", [
    { label: "View scale", value: "1 : 100" },
    { label: "Scale value", value: "100" },
    { label: "Detail level", value: "Medium" },
    { label: "Parts visibility", value: "Show original" },
    { label: "Show hidden lines", value: "By discipline" },
  ]));
  body.appendChild(section("Extents", [
    { label: "Crop region", value: "Off" },
    { label: "Annotation crop", value: "Off" },
    { label: "Far clip", value: "No clip" },
  ]));

  const tip = document.createElement("div");
  tip.style.cssText = "padding:8px 12px;font-size:11px;color:#64748b;line-height:1.4";
  tip.textContent =
    "Select an authored element or activate a modeling tool to edit instance / type properties.";
  body.appendChild(tip);
}

/* ═════════════════════════════════════════════════════════════════════════
   Setup
   ═════════════════════════════════════════════════════════════════════════ */
// openbim-fix:pp-theme
//
// Injects a small :root block mapping palette-local tokens to app
// theme tokens. The palette's inline styles then use
// var(--obs-pp-*, <fallback>) so a theme override anywhere in the app
// (dark/light toggle, high-contrast, brand palette) automatically
// reaches the Properties palette.
//
// The <style> element is added once (guard on its id). All fallbacks
// are the previous hard-coded values, so visual output is unchanged
// until a theme overrides one of the tokens.
function installPaletteTheme(): void {
  const STYLE_ID = "obs-pp-theme";
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    ":root {",
    "  --obs-pp-warn-fg:       var(--danger-soft, #fca5a5);",
    "  --obs-pp-type-bg:       var(--accent-dim, rgba(56,189,248,.14));",
    "  --obs-pp-type-fg:       var(--accent-soft, #7dd3fc);",
    "  --obs-pp-inst-bg:       var(--alt-dim, rgba(168,85,247,.14));",
    "  --obs-pp-inst-fg:       var(--alt-soft, #c4b5fd);",
    "  --obs-pp-active-border: var(--accent, #38bdf8);",
    "  --obs-pp-row-bg:        var(--bg-base, #0b0d12);",
    "  --obs-pp-row-border:    var(--border-subtle, #1e2029);",
    "  --obs-pp-row-fg:        var(--text-secondary, #cbd5e1);",
    "}",
  ].join("\n");
  document.head.appendChild(style);
}
export function setupPropertyPalette(): void {
  setLevelsProvider(() => ((ctx.features as any).authoring?.getLevels?.() ?? []) as any);
  installPaletteTheme();
  ctx.rightHost.appendChild(panel);

  dockHandle = makeDockable(panel, {
    id: "property-palette",
    host: ctx.rightHost,
    header,
    minWidth: 260,
    minHeight: 280,
    defaultDock: "right",
    defaultWidth: 320,
    defaultHeight: 520,
    margin: 8,
    snapThreshold: 28,
  });

  // openbim-fix:property-palette-closed-by-default
  // Refresh the palette contents when authoring changes, but DO NOT
  // force it open. The palette stays closed unless the user opened it
  // via the ribbon, User Interface menu, Ctrl+1, the command palette,
  // or openPropertyPalette().
  // MASTER PROMPT §2.1 — selecting a modeling tool opens its contextual
  // properties panel automatically. (Supersedes the earlier
  // closed-by-default behaviour for tool activation only: selection and
  // manual open/close still behave exactly as before.)
  onAuthoringChange(() => {
    try {
      if (isDrawToolActive() && !visible) {
        openPropertyPalette();
        return;
      }
    } catch (err) { console.warn("[property-palette] auto-open failed", err); }
    if (!visible) return;
    render();
  });

  // BIM-style auto-open: when a single element is selected, open the
  // palette and switch it to edit mode for that element.
  try {
    selection.onChange(() => {
      try {
        const auth: any = (ctx.features as any).authoring;
        const selIds: string[] = auth?.getSelectedIds?.() ?? [];
        if (selIds.length === 1) {
          const el = getElements().find((x) => x.id === selIds[0]);
          if (el) {
            setPaletteTarget({ mode: "edit", type: el.type as any, elementId: el.id });
            if (!visible) openPropertyPalette(); else render();
            return;
          }
        }
      } catch (err) { console.warn("[property-palette] auto-open failed", err); }
      if (visible) render();
    });
  } catch { /* */ }

  // Show at top/right by default — not hidden behind other chrome.
  closePropertyPalette();
  try { dockHandle.dock("right"); } catch { /* */ }
  render();

  ctx.features.propertyPalette = {
    open: openPropertyPalette,
    close: closePropertyPalette,
    isVisible: isPropertyPaletteVisible,
    rerender: render,
    dock: (side: "left" | "right" | "float") => dockHandle?.dock(side),
    resetLayout: () => dockHandle?.reset(),
  };
}