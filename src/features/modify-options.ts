/** Options bar for a selection (RVT "Modify | Walls" options row): edit the dimensions of ALL selected
 *  elements at once. A value shown blank ("-") means the selection has different values. Units: metres. */
import { getSelectedIds, getElementById, editSelectedParams } from "./authoring";

type El = NonNullable<ReturnType<typeof getElementById>>;
const ROUND = new Set(["pipe", "conduit"]);
const MEP = new Set(["duct", "pipe", "cable-tray", "conduit"]);

const WIDTH_LABEL: Record<string, string> = {
  wall: "Thickness", "curtain-wall": "Thickness", slab: "Thickness", beam: "Width", strip: "Width", duct: "Width",
  "cable-tray": "Width", pipe: "Diameter", conduit: "Diameter", column: "Width", footing: "Size", brace: "Section",
};
const HEIGHT_LABEL: Record<string, string> = { beam: "Depth", strip: "Depth", footing: "Depth", slab: "" , pipe: "", conduit: "" };

export function selectedAuthored(): El[] {
  const out: El[] = [];
  for (const id of getSelectedIds()) { const e = getElementById(id); if (e) out.push(e); }
  return out;
}

export function selectionCategory(els: El[]): string {
  const types = [...new Set(els.map((e) => e.type))];
  if (types.length !== 1) return "Multi-Select";
  const t = types[0];
  const plural: Record<string, string> = {
    wall: "Walls", "curtain-wall": "Curtain Walls", beam: "Beams", strip: "Wall Foundations", duct: "Ducts", pipe: "Pipes",
    "cable-tray": "Cable Trays", conduit: "Conduits", column: "Columns", slab: "Floors", footing: "Isolated Foundations",
    brace: "Braces", door: "Doors", window: "Windows", truss: "Trusses", stairs: "Stairs", railing: "Railings", ramp: "Ramps",
    equipment: "Components",
  };
  return plural[t] ?? (t.charAt(0).toUpperCase() + t.slice(1) + "s");
}

function common(els: El[], read: (e: El) => number | undefined): number | null | undefined {
  let v: number | undefined;
  for (const e of els) {
    const x = read(e);
    if (x === undefined) return undefined; // not every element has it: no control
    if (v === undefined) v = x; else if (Math.abs(v - x) > 1e-6) return null; // mixed
  }
  return v;
}

function field(title: string, label: string, value: number | null, apply: (v: number) => void, min?: number): HTMLElement[] {
  const l = document.createElement("span"); l.className = "obs-rv-label"; l.textContent = label;
  const wrap = document.createElement("label"); wrap.className = "obs-rv-number";
  const input = document.createElement("input");
  input.type = "number"; input.step = "0.01"; input.title = title; input.style.width = "66px";
  if (min != null) input.min = String(min);
  input.value = value == null ? "" : String(Math.round(value * 10000) / 10000);
  input.placeholder = "-";
  const commit = () => {
    if (input.value === "") return;
    const v = Number(input.value);
    if (!Number.isFinite(v) || (min != null && v < min)) { input.value = value == null ? "" : String(value); return; }
    apply(v);
  };
  input.onchange = commit;
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") { commit(); input.blur(); } };
  wrap.append(input);
  return [l, wrap];
}

function toast(message: string, kind = "info") {
  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } }));
}

export function buildModifyOptions(bar: HTMLElement): boolean {
  const els = selectedAuthored();
  if (!els.length) return false;
  const types = [...new Set(els.map((e) => e.type))];
  const pinned = els.filter((e) => e.properties?.pinned).length;
  const run = (patch: Record<string, number>, what: string) => {
    const r = editSelectedParams(patch);
    if (r.failed.length) toast(`${what}: ${r.failed[0]}${r.failed.length > 1 ? ` (+${r.failed.length - 1} more)` : ""}`, "warn");
    else if (!r.changed) toast(pinned ? "Selected elements are pinned." : `${what}: nothing to change`, "warn");
  };

  const t0 = types.length === 1 ? types[0] : "";
  const wLabel = t0 ? (WIDTH_LABEL[t0] ?? "Width") : "Width";
  const w = common(els, (e) => (typeof e.params.thickness === "number" ? e.params.thickness : undefined));
  if (w !== undefined) {
    const both = types.every((t) => ROUND.has(t) || t === "slab");
    bar.append(...field(`${wLabel} (m)`, wLabel + ":", w, (v) => run(both ? { thickness: v, height: v } : { thickness: v }, wLabel), 0.005));
  }
  const hLabel = t0 ? (HEIGHT_LABEL[t0] ?? "Height") : "Height";
  const hideH = types.every((t) => ROUND.has(t) || t === "slab");
  const h = common(els, (e) => (typeof e.params.height === "number" ? e.params.height : undefined));
  if (h !== undefined && !hideH && hLabel) bar.append(...field(`${hLabel} (m)`, hLabel + ":", h, (v) => run({ height: v }, hLabel), 0.005));
  const elevLabel = types.every((t) => MEP.has(t)) ? "Middle elevation:" : "Elevation:";
  const z = common(els, (e) => (typeof e.params.elevation === "number" ? e.params.elevation : 0));
  if (z !== undefined) bar.append(...field("Elevation of the base (walls, columns, beams) or the centre line (MEP), in metres", elevLabel, z, (v) => run({ elevation: v }, "Elevation")));
  if (pinned) { const n = document.createElement("span"); n.className = "obs-rv-label"; n.textContent = `${pinned} pinned`; n.style.color = "#fbbf24"; bar.append(n); }
  return true;
}
