/**
 * Parametric Modeling Toolkit — the UI wiring for the parametric modeling
 * engine. Every tool here operates on REAL authored elements (walls, curtain
 * walls, the constraint store) through the sanctioned authoring APIs and
 * reports honestly what it did:
 *
 *   • Wall Join Doctor   — diagnoses plan joins (miter / chamfer / extended /
 *                          butt / free ends) on the selected walls or the whole
 *                          model, using the same pure geometry the rebuild uses.
 *   • Apply Join Status  — writes properties.joinStatus on walls (allow / butt /
 *                          chamfer / extended / disallow) and rebuilds.
 *   • Stacked Wall Heal  — detects vertically stacked wall chains (L1→L4),
 *                          closes gaps/overlaps by adjusting the LOWER wall's
 *                          height through applyElementParamChange.
 *   • Curtain Grid Editor— divisions, mullion profile, panel type AND explicit
 *                          grid lines (metres) persisted on curtain-wall
 *                          elements; the rebuild honors them via grid-props.
 *   • Constraint Store   — live report of the parametric constraints + dim
 *                          locks (both now persisted in the project file).
 *
 * Registration mirrors mep-fabrication.ts: floating panel + ctx.features bag +
 * command-palette entries + ui-items row + ribbon button.
 */

import { ctx } from "../core/context";
import { openFormModal, pickFromList, showTableDialog } from "./form-modal";
import { registerCommand } from "./command-palette";
import {
  getElements,
  getSelectedIds,
  rebuildAuthored,
  applyElementParamChange,
  getDimLocks,
  markAuthoringDirty,
} from "./authoring";
import { mitreEndFaces, type JoinPeer } from "../modules/geometry/linear-join";
import { healStacks } from "../modules/wall-join/stack-heal";
import { validateStacks, type StackWall } from "../modules/wall-join/vertical-join";
import { metersToGridPositions, parseCurtainGridProps } from "../modules/curtain-wall/grid-props";
import { getAllConstraints } from "../modules/parametric-constraints/types";

type Vec2 = [number, number];

function toast(message: string, kind: "success" | "error" = "success"): void {
  try { window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } })); } catch { /* */ }
}

interface WallLike {
  id: string;
  name: string;
  start: Vec2;
  end: Vec2;
  thickness: number;
  joinStatus: string;
}

function collectWalls(scope: string): WallLike[] {
  const sel = new Set(getSelectedIds().map(String));
  return getElements()
    .filter((e) => e.type === "wall")
    .filter((e) => (scope === "selection" ? sel.has(e.id) : true))
    .map((e) => {
      const p = e.params as Record<string, any>;
      return {
        id: e.id,
        name: e.name,
        start: [Number(p.start?.[0] ?? 0), Number(p.start?.[1] ?? 0)] as Vec2,
        end: [Number(p.end?.[0] ?? 0), Number(p.end?.[1] ?? 0)] as Vec2,
        thickness: Math.max(0.05, Number(p.thickness) || 0.2),
        joinStatus: String((e.properties as any)?.joinStatus ?? "allow"),
      };
    });
}

function toJoinPeers(walls: WallLike[]): JoinPeer[] {
  return walls.map((w) => ({
    id: w.id,
    start: w.start,
    end: w.end,
    thickness: w.thickness,
    joinStatus: w.joinStatus,
  }));
}

const n3 = (v: number): string => v.toFixed(3);

// ── Tool 1: Wall Join Doctor ─────────────────────────────────────────────

async function wallJoinDoctor(): Promise<void> {
  const vals = await openFormModal({
    title: "Wall Join Doctor",
    subtitle: "Diagnoses plan joins with the exact geometry the rebuild uses (miter / chamfer / extended / butt / free ends).",
    fields: [
      {
        kind: "select",
        key: "scope",
        label: "Scope",
        options: [["selection", "Selected walls"], ["all", "All walls"]],
        default: "selection",
        hint: "Peers outside the scope still count — a selected wall joining an unselected neighbour is reported as joined.",
      },
    ],
    submitLabel: "Diagnose",
  });
  if (!vals) return;
  const all = collectWalls("all");
  const scope = String(vals.scope ?? "selection");
  const walls = collectWalls(scope);
  if (!walls.length) {
    toast(scope === "selection" ? "No walls selected — select walls first, or run on All walls." : "No walls in the model yet.", "error");
    return;
  }

  const peers = toJoinPeers(all);
  const statusCount = new Map<string, number>();
  let joinedEnds = 0;
  let squareEnds = 0;
  let freeEnds = 0;
  const problemRows: string[][] = [];

  for (const w of walls) {
    statusCount.set(w.joinStatus, (statusCount.get(w.joinStatus) ?? 0) + 1);
    const len = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
    if (len < 1e-9) { freeEnds += 2; problemRows.push([w.name, "both", "degenerate (zero length)"]); continue; }
    const dir: Vec2 = [(w.end[0] - w.start[0]) / len, (w.end[1] - w.start[1]) / len];
    const halfT = w.thickness / 2;
    for (const atStart of [true, false]) {
      const end: Vec2 = atStart ? w.start : w.end;
      const faces = mitreEndFaces(end, dir, halfT, atStart, w.id, peers);
      if (!faces) { freeEnds++; problemRows.push([w.name, atStart ? "start" : "end", "free end — no peer endpoint nearby"]); continue; }
      if (faces.joined) joinedEnds++;
      else { squareEnds++; problemRows.push([w.name, atStart ? "start" : "end", `square end (status "${w.joinStatus}" or peer opt-out)`]); }
    }
  }

  const statusRows = [...statusCount.entries()].map(([s, c]) => [s, String(c)]);
  showTableDialog(
    "Wall Join Doctor",
    ["Status", "Walls"],
    statusRows.length ? statusRows : [["(none)", "0"]],
    `${walls.length} wall(s) · ${joinedEnds} joined end(s) · ${squareEnds} square end(s) · ${freeEnds} free end(s)`,
  );
  if (problemRows.length) {
    showTableDialog("Wall Join Doctor — End Details", ["Wall", "End", "Finding"], problemRows, "Every wall end, examined with the production join geometry");
  }
  toast(`Wall Join Doctor: ${walls.length} wall(s), ${joinedEnds + squareEnds} joinable end(s), ${freeEnds} free`);
}

// ── Tool 2: Apply Join Status ────────────────────────────────────────────

async function applyJoinStatusTool(): Promise<void> {
  const vals = await openFormModal({
    title: "Apply Wall Join Status",
    subtitle: 'Writes properties.joinStatus on the target walls. "chamfer" cuts the outer face to the corner diagonal; "extended" runs the wall long to the neighbour\'s far face.',
    fields: [
      { kind: "select", key: "scope", label: "Scope", options: [["selection", "Selected walls"], ["all", "All walls"]], default: "selection" },
      {
        kind: "select",
        key: "status",
        label: "Join status",
        options: [
          ["allow", "allow — full miter (default)"],
          ["butt", "butt — square end, no join"],
          ["chamfer", "chamfer — one face cut, outer corner diagonal"],
          ["extended", "extended — end slides out flush with neighbour's far face"],
          ["disallow", "disallow — no join at this wall"],
        ],
        default: "allow",
      },
    ],
    submitLabel: "Apply",
  });
  if (!vals) return;
  const walls = collectWalls(String(vals.scope ?? "selection"));
  if (!walls.length) { toast("No target walls (select walls first, or run on All walls).", "error"); return; }
  const status = String(vals.status ?? "allow");
  const els = getElements();
  let changed = 0;
  for (const w of walls) {
    const el = els.find((e) => e.id === w.id);
    if (!el) continue;
    if (!el.properties || typeof el.properties !== "object") el.properties = {};
    (el.properties as any).joinStatus = status;
    changed++;
  }
  if (changed) {
    rebuildAuthored();
    markAuthoringDirty();
  }
  showTableDialog("Apply Join Status", ["Result", "Count"], [["walls updated", String(changed)], ["status", status]], "Geometry rebuilt with the new join semantics");
  toast(`Join status "${status}" applied to ${changed} wall(s)`);
}

// ── Tool 3: Stacked Wall Heal ────────────────────────────────────────────

function stackWallsFromModel(): StackWall[] {
  return getElements()
    .filter((e) => e.type === "wall")
    .map((e) => {
      const p = e.params as Record<string, any>;
      return {
        id: e.id,
        start: [Number(p.start?.[0] ?? 0), Number(p.start?.[1] ?? 0)] as Vec2,
        end: [Number(p.end?.[0] ?? 0), Number(p.end?.[1] ?? 0)] as Vec2,
        baseZ: (Number(p.elevation) || 0) + (Number(p.baseOffset) || 0),
        height: Math.max(0.05, Number(p.height) || 0),
        joinStatus: String((e.properties as any)?.joinStatus ?? "allow"),
      };
    })
    .filter((w) => w.height > 0.1 && Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]) > 0.1);
}

async function stackedWallHeal(): Promise<void> {
  const walls = stackWallsFromModel();
  if (!walls.length) { toast("No linear walls to heal yet.", "error"); return; }

  const pre = validateStacks(walls);
  const vals = await openFormModal({
    title: "Stacked Wall Heal",
    subtitle: pre.length
      ? `${pre.length} stacked-wall issue(s) found (gaps / overlaps across level boundaries).`
      : "No stacked-wall gaps or overlaps found — walls rising across levels meet cleanly.",
    fields: [
      { kind: "checkbox", key: "apply", label: "Apply fixes (uncheck = analyze only)", default: true },
      { kind: "number", key: "scanTol", label: "Max boundary mismatch to heal", default: 0.25, min: 0.01, max: 2, step: 0.05, unit: "m", hint: "Construction-tolerance scale (one wall thickness + finishes). Larger mismatches are left untouched and reported." },
    ],
    submitLabel: "Run",
  });
  if (!vals) return;
  const apply = vals.apply !== false;
  const scanTol = Math.max(0.01, Number(vals.scanTol) || 0.25);

  if (!apply) {
    const rows = pre.map((i) => [i.kind, i.lowerId.slice(0, 8), i.upperId.slice(0, 8), i.message]);
    showTableDialog("Stacked Walls — Analysis", ["Kind", "Lower", "Upper", "Finding"], rows.length ? rows : [["clean", "—", "—", "no gaps or overlaps"]], `${walls.length} wall(s) examined · analysis only, nothing changed`);
    return;
  }

  const res = healStacks(walls, { scanTol });
  let appliedOk = 0;
  const failed: string[] = [];
  for (const patch of res.patches) {
    const r = applyElementParamChange(patch.id, "height", patch.heightAfter);
    if (r.ok) appliedOk++;
    else failed.push(`${patch.id.slice(0, 8)}: ${r.reason ?? "rejected"}`);
  }
  if (res.patches.length) { rebuildAuthored(); markAuthoringDirty(); }

  const rows: string[][] = [];
  for (const p of res.patches) {
    rows.push(["patch", p.id.slice(0, 8), `${n3(p.heightBefore)} → ${n3(p.heightAfter)} m`, p.reason]);
  }
  for (const i of res.remaining) {
    rows.push(["remaining", i.lowerId.slice(0, 8), i.upperId.slice(0, 8), i.message]);
  }
  if (failed.length) rows.push(["rejected", "—", "—", failed.join("; ")]);
  const chainSummary = res.chains.map((c) => `${c.length} walls`);
  showTableDialog(
    "Stacked Wall Heal",
    ["Kind", "Wall", "Height / Pair", "Detail"],
    rows.length ? rows : [["clean", "—", "—", "nothing to heal"]],
    `${res.patches.length} patch(es) applied · chains: ${chainSummary.length ? chainSummary.join(", ") : "none"} · ${res.remaining.length} issue(s) left`,
  );
  toast(res.patches.length ? `Stacked walls healed: ${appliedOk}/${res.patches.length} patch(es) applied` : "Stacked walls already clean");
}

// ── Tool 4: Curtain Grid Editor ──────────────────────────────────────────

async function curtainGridEditor(): Promise<void> {
  const sel = new Set(getSelectedIds().map(String));
  const cw = getElements().filter((e) => e.type === "curtain-wall" && sel.has(e.id));
  if (!cw.length) {
    toast("Select a curtain wall first (draw one with the curtain-wall tool, then click it).", "error");
    return;
  }
  const el = cw[0];
  const p = el.params as Record<string, any>;
  const props = (el.properties ?? {}) as Record<string, any>;
  const start: Vec2 = [Number(p.start?.[0] ?? 0), Number(p.start?.[1] ?? 0)];
  const end: Vec2 = [Number(p.end?.[0] ?? 0), Number(p.end?.[1] ?? 0)];
  const width = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const height = Math.max(0.5, Number(p.height) || 3);
  if (width < 0.2) { toast("Curtain wall is degenerate (too short).", "error"); return; }

  const vals = await openFormModal({
    title: "Curtain Grid Editor",
    subtitle: `${el.name} · ${n3(width)} m × ${n3(height)} m. Division counts OR explicit grid lines (in metres) — explicit lines replace even divisions on that axis.`,
    fields: [
      { kind: "number", key: "vDivisions", label: "Vertical divisions (panels across)", default: Number(props.vDivisions) || Math.max(2, Math.min(12, Math.round(width / 1.2))), min: 1, max: 24, step: 1 },
      { kind: "number", key: "hDivisions", label: "Horizontal divisions (rows)", default: Number(props.hDivisions) || Math.max(1, Math.min(6, Math.round(height / 1.4))), min: 1, max: 12, step: 1 },
      { kind: "select", key: "mullionProfile", label: "Mullion profile", options: [["rect", "rect"], ["L", "L"], ["T", "T"], ["I", "I"]], default: String(props.mullionProfile ?? "rect") },
      { kind: "select", key: "panelType", label: "Default panel type", options: [["glazed", "glazed"], ["solid", "solid"], ["door", "door"], ["void", "void"]], default: String(props.panelType ?? "glazed") },
      { kind: "text", key: "vGridM", label: "Explicit V grid lines", placeholder: "e.g. 2.4, 4.8", unit: "m", hint: `Metres from the start edge (0–${n3(width)}). Leave empty to use divisions.` },
      { kind: "text", key: "hGridM", label: "Explicit H grid lines", placeholder: "e.g. 1.5", unit: "m", hint: `Metres from the bottom edge (0–${n3(height)}).` },
    ],
    submitLabel: "Apply to curtain wall",
  });
  if (!vals) return;

  const warnings: string[] = [];
  const nextProps: Record<string, unknown> = {
    ...props,
    vDivisions: Math.max(1, Math.min(24, Math.round(Number(vals.vDivisions) || 1))),
    hDivisions: Math.max(1, Math.min(12, Math.round(Number(vals.hDivisions) || 1))),
    mullionProfile: String(vals.mullionProfile ?? "rect"),
    panelType: String(vals.panelType ?? "glazed"),
  };
  const vGrid = metersToGridPositions(String(vals.vGridM ?? ""), width, "vGrid", warnings);
  const hGrid = metersToGridPositions(String(vals.hGridM ?? ""), height, "hGrid", warnings);
  if (vGrid) nextProps.vGrid = vGrid; else delete nextProps.vGrid;
  if (hGrid) nextProps.hGrid = hGrid; else delete nextProps.hGrid;

  // Validate exactly what the rebuild will consume, and report panel/mullion counts.
  const check = parseCurtainGridProps(nextProps, warnings);
  el.properties = nextProps;
  rebuildAuthored();
  markAuthoringDirty();

  let counts = "";
  try {
    const built = (ctx.features as any).curtainWall?.buildFromElement?.({
      id: el.id,
      params: { ...p },
      properties: { ...nextProps },
    });
    const cs = built?.userData?.curtainSystem;
    if (cs) counts = `${cs.panels} panel(s), ${cs.mullions} mullion(s)`;
  } catch { /* report is honest without counts */ }

  showTableDialog(
    "Curtain Grid Editor — Applied",
    ["Setting", "Value"],
    [
      ["divisions (V × H)", `${nextProps.vDivisions} × ${nextProps.hDivisions}`],
      ["mullion profile", String(nextProps.mullionProfile)],
      ["default panel", String(nextProps.panelType)],
      ["explicit V lines", Array.isArray(check.vGrid) ? check.vGrid.map((v) => n3(v * width)).join(", ") : "(even divisions)"],
      ["explicit H lines", Array.isArray(check.hGrid) ? check.hGrid.map((v) => n3(v * height)).join(", ") : "(even divisions)"],
      ["rebuild", counts || "mesh rebuilt"],
    ],
    warnings.length ? warnings.join(" · ") : "Persisted on the element — survives save/reload",
  );
  toast(`Curtain grid updated on ${el.name}`);
}

// ── Tool 5: Constraint Store report ──────────────────────────────────────

function constraintStoreReport(): void {
  const cons = getAllConstraints();
  const locks = getDimLocks();
  const rows: string[][] = [];
  for (const c of cons) {
    rows.push([
      c.type,
      c.elementIds.map((id) => id.slice(0, 8)).join(" ↔ "),
      c.value !== undefined ? `${n3(c.value)} m` : c.dimensionLabel ?? "—",
      c.active ? "active" : "inactive",
    ]);
  }
  for (const l of locks) {
    rows.push(["dim-lock", `${l.elementId.slice(0, 8)} · ${l.param}`, `${n3(l.value)} m`, "active"]);
  }
  showTableDialog(
    "Parametric Constraint Store",
    ["Type", "Elements", "Value", "State"],
    rows.length ? rows : [["(empty)", "—", "—", "no constraints yet — lock a dimension in the plan view"]],
    `${cons.length} constraint(s) · ${locks.length} dim lock(s) · both persisted in the project file on save`,
  );
  toast(`Constraint store: ${cons.length} constraint(s), ${locks.length} dim lock(s)`);
}

// ── Toolkit dropdown + registration ──────────────────────────────────────

const TOOLKIT_ITEMS: Array<{ value: string; label: string }> = [
  { value: "join-doctor", label: "Wall Join Doctor — diagnose every wall end" },
  { value: "join-status", label: "Apply Wall Join Status (miter / chamfer / extended / butt)" },
  { value: "stack-heal", label: "Stacked Wall Heal — close gaps across levels" },
  { value: "curtain-grid", label: "Curtain Grid Editor — divisions, mullions, explicit grid lines" },
  { value: "constraints", label: "Parametric Constraint Store — live report" },
];

export async function openParametricToolkit(): Promise<void> {
  const pick = await pickFromList("Parametric Modeling Toolkit", "Tool", TOOLKIT_ITEMS, TOOLKIT_ITEMS[0].value);
  if (!pick) return;
  const runners: Record<string, () => Promise<void> | void> = {
    "join-doctor": wallJoinDoctor,
    "join-status": applyJoinStatusTool,
    "stack-heal": stackedWallHeal,
    "curtain-grid": curtainGridEditor,
    "constraints": constraintStoreReport,
  };
  const run = runners[pick];
  if (run) await run();
}

let panel: HTMLDivElement | null = null;
let panelBody: HTMLDivElement | null = null;
let visible = false;

function panelButton(label: string, color: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.style.cssText =
    `margin:8px;padding:8px 12px;background:${color};color:white;border:0;` +
    "border-radius:5px;font:600 12px system-ui,sans-serif;cursor:pointer;width:calc(100% - 16px)";
  btn.onclick = onClick;
  panelBody?.appendChild(btn);
  return btn;
}

export function setupParametricTools(): void {
  panel = document.createElement("div");
  panel.id = "obs-parametric-tools";
  panel.style.cssText =
    "position:fixed;left:16px;top:560px;width:300px;z-index:33;" +
    "display:none;flex-direction:column;background:#1a1d27;color:#e8eaf0;" +
    "border:1px solid #2a2e3a;border-radius:10px;" +
    "box-shadow:0 12px 36px rgba(0,0,0,.5);font:12px system-ui,sans-serif;overflow:hidden";
  panel.onmousedown = (e) => e.stopPropagation();

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;padding:9px 12px;" +
    "border-bottom:1px solid #2a2e3a;background:#12141b;flex-shrink:0";
  header.innerHTML = "<div style='font-weight:700;flex:1'>\u2B21 Parametric Modeling</div>" +
    "<div style='font-size:10px;color:#6b7280'>joins · stacks · curtain grids · constraints</div>";

  const body = document.createElement("div");
  body.style.cssText = "padding:4px 0 8px";
  panelBody = body;

  panel.append(header, body);
  ctx.rightHost.appendChild(panel);

  panelButton("Parametric Toolkit\u2026", "#8b5cf6", () => void openParametricToolkit());
  panelButton("Wall Join Doctor\u2026", "#3b82f6", () => void wallJoinDoctor());
  panelButton("Stacked Wall Heal\u2026", "#10b981", () => void stackedWallHeal());
  panelButton("Curtain Grid Editor\u2026", "#f59e0b", () => void curtainGridEditor());

  (ctx.features as any).parametricTools = {
    show: () => { visible = true; if (panel) panel.style.display = "flex"; },
    hide: () => { visible = false; if (panel) panel.style.display = "none"; },
    toggle: () => { visible ? (ctx.features as any).parametricTools.hide() : (ctx.features as any).parametricTools.show(); },
    isVisible: () => visible,
  };

  registerCommand({ id: "parametric.toolkit", label: "Parametric Modeling Toolkit\u2026", category: "Modeling", run: () => void openParametricToolkit() });
  registerCommand({ id: "parametric.join-doctor", label: "Wall Join Doctor", category: "Modeling", run: () => void wallJoinDoctor() });
  registerCommand({ id: "parametric.join-status", label: "Apply Wall Join Status\u2026", category: "Modeling", run: () => void applyJoinStatusTool() });
  registerCommand({ id: "parametric.stack-heal", label: "Stacked Wall Heal\u2026", category: "Modeling", run: () => void stackedWallHeal() });
  registerCommand({ id: "parametric.curtain-grid", label: "Curtain Grid Editor\u2026", category: "Modeling", run: () => void curtainGridEditor() });
  registerCommand({ id: "parametric.constraints", label: "Parametric Constraint Store Report", category: "Modeling", run: () => constraintStoreReport() });

  console.log("[parametric-tools] toolkit ready — join doctor, stacked-wall heal, curtain grid editor, constraint store");
}

export function toggleParametricTools(): void {
  if (!panel || !(ctx.features as any).parametricTools) {
    setupParametricTools();
  }
  (ctx.features as any).parametricTools?.toggle();
}
