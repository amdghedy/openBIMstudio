/** Options bar controls for placement tools (the Revit "Modify | Place …" options row).
 *  Every control reads and writes the real drawing state used by authoring.ts:
 *  level, type defaults (dimensions), wall location line / join / offset / chain / radius,
 *  beam & MEP justification and MEP slope. Units: metres. */
import {
  getLevels, getLevel, setLevel, getTypeDefaults, setTypeDefault,
  getWallChain, setWallChain, getWallOffset, setWallOffset,
  getWallLocationLine, setWallLocationLine, getWallJoinStatus, setWallJoinStatus,
  getWallRadius, setWallRadius,
  getBeamJustification, setBeamJustification, getBeamZJustification, setBeamZJustification,
  getMepJustification, setMepJustification, getDrawSlope, setDrawSlope,
  type WallLocationLine, type WallJoinStatus, type HJustification, type ZJustification,
} from "./authoring";
import { listWallTypePresets, applyWallTypePreset } from "../modules/architecture-depth";

const WALLS = new Set(["wall", "curtain-wall"]);
const BEAMS = new Set(["beam", "strip"]);
const MEP = new Set(["duct", "pipe", "cable-tray", "conduit"]);
const ROUND = new Set(["pipe", "conduit"]);
const LINEAR = new Set([...WALLS, ...BEAMS, ...MEP, "mline"]);

export const PLACE_TOOLS = new Set([...WALLS, ...BEAMS, ...MEP, "column", "slab", "footing", "brace", "door", "window"]);

const LOCATION_LINES: Array<[WallLocationLine, string]> = [
  ["wall-centerline", "Wall Centerline"], ["core-centerline", "Core Centerline"],
  ["finish-exterior", "Finish Face: Exterior"], ["finish-interior", "Finish Face: Interior"],
  ["core-exterior", "Core Face: Exterior"], ["core-interior", "Core Face: Interior"],
];
const JOINS: Array<[WallJoinStatus, string]> = [
  ["allow", "Allow"], ["disallow", "Disallow"], ["chamfer", "Chamfer"], ["extended", "Extended"], ["butt", "Butt"],
];

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag); if (cls) n.className = cls; return n;
}
const label = (t: string) => { const s = mk("span", "obs-rv-label"); s.textContent = t; return s; };
const sep = () => mk("span", "obs-rv-sep");

function select(value: string, items: Array<[string, string]>, onChange: (v: string) => void, width = 130): HTMLSelectElement {
  const s = mk("select", "obs-rv-select"); s.style.width = `${width}px`;
  for (const [v, t] of items) { const o = mk("option"); o.value = v; o.textContent = t; s.appendChild(o); }
  s.value = value;
  s.onchange = () => onChange(s.value);
  return s;
}
function num(value: number, title: string, onChange: (v: number) => void, opts: { step?: number; min?: number; width?: number; disabled?: boolean } = {}): HTMLElement {
  const wrap = mk("label", "obs-rv-number");
  const input = mk("input"); input.type = "number"; input.step = String(opts.step ?? 0.01); input.title = title;
  if (opts.min != null) input.min = String(opts.min);
  input.value = String(Math.round(value * 10000) / 10000);
  if (opts.width) input.style.width = `${opts.width}px`;
  input.disabled = !!opts.disabled;
  const commit = () => { const v = Number(input.value); if (Number.isFinite(v) && (opts.min == null || v >= opts.min)) onChange(v); };
  input.onchange = commit;
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") { commit(); input.blur(); } };
  wrap.append(input);
  return wrap;
}
function check(text: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const l = mk("label", "obs-rv-label"); l.style.cssText = "display:inline-flex;align-items:center;gap:4px;cursor:pointer;color:var(--text-secondary,#cbd5e1)";
  const c = mk("input"); c.type = "checkbox"; c.checked = value; c.onchange = () => onChange(c.checked);
  l.append(c, text); return l;
}

/** Elevation offset above the current level is stored as the type's `elevation` default (absolute);
 *  an offset of 0 clears it so the tool follows the active level. */
function getOffset(tool: string): number {
  const e = getTypeDefaults(tool).params.elevation;
  return typeof e === "number" && Number.isFinite(e) ? e - getLevel() : 0;
}
function setOffset(tool: string, off: number): void {
  setTypeDefault(tool, "params", "elevation", Math.abs(off) < 1e-9 ? undefined : getLevel() + off);
}

export function buildPlaceOptions(tool: string, bar: HTMLElement): void {
  const p = () => getTypeDefaults(tool).params;
  const dim = (key: string, v: number) => setTypeDefault(tool, "params", key, v);

  // Level (all placement tools)
  const levels = getLevels();
  const cur = getLevel();
  const items: Array<[string, string]> = levels.map((l) => [String(l.elevation), `${l.name}  (${l.elevation.toFixed(2)} m)`]);
  if (!levels.some((l) => Math.abs(l.elevation - cur) < 0.001)) items.unshift([String(cur), `Elevation ${cur.toFixed(2)} m`]);
  bar.append(label("Level:"), select(String(cur), items, (v) => {
    const keep = getOffset(tool);
    setLevel(Number(v));
    setOffset(tool, keep); // the offset stays relative to the newly chosen level
  }, 150), sep());

  if (WALLS.has(tool)) {
    const heightControl = num(Number(p().height ?? 3), "Wall height (m)", (v) => dim("height", v), { min: 0.01, width: 64 });
    const thicknessControl = num(Number(p().thickness ?? 0.2), "Wall thickness (m)", (v) => dim("thickness", v), { min: 0.005, width: 64 });
    bar.append(label("Height:"), heightControl, label("Thickness:"), thicknessControl);
    bar.append(label("Base offset:"), num(getOffset(tool), "Base offset from the level (m)", (v) => setOffset(tool, v), { width: 64 }), sep());
    const typeOpts = listWallTypePresets()
      .filter((pr) => (tool === "curtain-wall" ? pr.kind === "curtain" : pr.kind !== "curtain"))
      .map((pr) => [pr.id, pr.name] as [string, string]);
    if (typeOpts.length) {
      const preferred = tool === "curtain-wall" ? "curtain-system" : "compound-exterior";
      const cur = typeOpts.some(([id]) => id === preferred) ? preferred : typeOpts[0][0];
      bar.append(
        label("Type:"),
        select(cur, typeOpts, (v) => {
          const preset = applyWallTypePreset(v);
          if (!preset) return;
          const heightInput = heightControl.querySelector("input");
          const thicknessInput = thicknessControl.querySelector("input");
          if (heightInput) heightInput.value = String(preset.height);
          if (thicknessInput) thicknessInput.value = String(preset.thickness);
        }, 200),
      );
    }
    bar.append(label("Location Line:"), select(getWallLocationLine(), LOCATION_LINES, (v) => setWallLocationLine(v as WallLocationLine), 170));
    bar.append(check("Chain", getWallChain(), (v) => setWallChain(v)));
    bar.append(label("Offset:"), num(getWallOffset(), "Offset of the location line (m)", (v) => setWallOffset(v), { width: 64 }));
    const r = getWallRadius();
    bar.append(check("Radius:", r > 0, (on) => setWallRadius(on ? 1 : 0)), num(r || 1, "Corner radius (m)", (v) => setWallRadius(v), { min: 0.01, width: 64, disabled: !(r > 0) }));
    bar.append(label("Join Status:"), select(getWallJoinStatus(), JOINS, (v) => setWallJoinStatus(v as WallJoinStatus), 100));
    return;
  }

  if (BEAMS.has(tool)) {
    bar.append(label("Width:"), num(Number(p().thickness ?? 0.25), "Section width (m)", (v) => dim("thickness", v), { min: 0.005, width: 64 }));
    bar.append(label("Depth:"), num(Number(p().height ?? 0.5), "Section depth (m)", (v) => dim("height", v), { min: 0.005, width: 64 }));
    bar.append(label("Elevation offset:"), num(getOffset(tool), "Offset from the level (m)", (v) => setOffset(tool, v), { width: 64 }), sep());
    bar.append(label("Justification:"), select(getBeamJustification(), [["center", "Center"], ["outer", "Outer"], ["inner", "Inner"]], (v) => setBeamJustification(v as HJustification), 90));
    if (tool === "beam") bar.append(label("Z:"), select(getBeamZJustification(), [["bottom", "Bottom"], ["center", "Center"], ["top", "Top"]], (v) => setBeamZJustification(v as ZJustification), 90));
    bar.append(check("Chain", getWallChain(), (v) => setWallChain(v)));
    return;
  }

  if (MEP.has(tool)) {
    if (ROUND.has(tool)) {
      bar.append(label("Diameter:"), num(Number(p().thickness ?? 0.1), "Outside diameter (m)", (v) => { dim("thickness", v); dim("height", v); }, { min: 0.005, width: 64 }));
    } else {
      bar.append(label("Width:"), num(Number(p().thickness ?? 0.6), "Width (m)", (v) => dim("thickness", v), { min: 0.01, width: 64 }));
      bar.append(label("Height:"), num(Number(p().height ?? 0.4), "Height (m)", (v) => dim("height", v), { min: 0.01, width: 64 }));
    }
    bar.append(label("Middle offset:"), num(getOffset(tool), "Offset of the centre line from the level (m)", (v) => setOffset(tool, v), { width: 64 }), sep());
    bar.append(label("Justification:"), select(getMepJustification(), [["center", "Center"], ["outer", "Outer"], ["inner", "Inner"]], (v) => setMepJustification(v as HJustification), 90));
    bar.append(label("Slope %:"), num(getDrawSlope(), "Slope of new runs (%) - 0 is flat", (v) => setDrawSlope(v), { step: 0.1, width: 56 }));
    bar.append(check("Chain", getWallChain(), (v) => setWallChain(v)));
    return;
  }

  if (tool === "door" || tool === "window") {
    const win = tool === "window";
    bar.append(label("Width:"), num(Number(p().width ?? (win ? 1.2 : 0.9)), `${win ? "Window" : "Door"} width (m)`, (v) => dim("width", v), { min: 0.1, width: 64 }));
    bar.append(label("Height:"), num(Number(p().height ?? (win ? 1.4 : 2.1)), `${win ? "Window" : "Door"} height (m)`, (v) => dim("height", v), { min: 0.1, width: 64 }));
    bar.append(label("Sill height:"), num(Number(p().sillHeight ?? (win ? 0.9 : 0)), "Height of the bottom above the level (m)", (v) => dim("sillHeight", v), { min: 0, width: 64 }), sep());
    const hint = mk("span", "obs-rv-label"); hint.textContent = "Move over a wall and click to place";
    bar.append(hint);
    return;
  }

  // column / slab / footing / brace
  const keyDims: Array<[string, string, string, number]> =
    tool === "slab" ? [["Thickness:", "thickness", "Slab thickness (m)", 0.2]] :
    tool === "footing" ? [["Size:", "thickness", "Footing plan size (m)", 1.2], ["Depth:", "height", "Footing depth (m)", 0.4]] :
    tool === "brace" ? [["Section:", "thickness", "Brace section (m)", 0.15]] :
    [["Width:", "thickness", "Column width (m)", 0.3], ["Height:", "height", "Column height (m)", 3]];
  for (const [t, key, title, d] of keyDims) {
    bar.append(label(t), num(Number(p()[key] ?? d), title, (v) => { dim(key, v); if (tool === "slab") dim("height", v); }, { min: 0.005, width: 64 }));
  }
  bar.append(label("Base offset:"), num(getOffset(tool), "Offset from the level (m)", (v) => setOffset(tool, v), { width: 64 }));
}
