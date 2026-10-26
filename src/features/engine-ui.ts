/**
 * v69 Engine UI — wires every v67/v68 engine to user-facing buttons,
 * dialogs and panels. This closes the "engine without a button" gap:
 * before this module the constraint solver, structural FEM, MEP
 * hydraulics, adaptive components, solid kernel, Modify engine, hosting,
 * parameter engine, relationships and registry were only reachable from
 * the developer console via window.__obs*.
 *
 * Structure:
 *   1. Pure helpers (Node-testable): parsing, frame builder, summaries
 *   2. Floating report card (result display)
 *   3. Structural dialogs  — Analyze tab (v67 __obsStructural engine)
 *   4. Hydraulics dialogs  — Analyze tab (v67 __obsMepPressure engine)
 *   5. Adaptive dialogs    — Architecture tab (v67 __obsAdaptive engine)
 *   6. Solid form dialogs  — Edit tab (v68 __obsSolids engine)
 *   7. Modify dialogs      — Edit tab (v68 __obsModify engine on the
 *                             live authored model via an ElementStore
 *                             adapter)
 *   8. Hosted opening      — Architecture tab (v68 __obsHosting engine)
 *   9. Parameter manager   — Manage tab (v68 __obsParametric engine)
 *  10. Model intelligence  — Manage tab (__obsRegistry + __obsRelationships
 *                             + __obsMepConnectors + __obsSnapping)
 *  11. setupEngineUi() boot
 *
 * Engine access: stateless engines are imported directly (pure modules);
 * singleton-backed registries are read through the window.__obs* handles
 * installed by v67/v68-register so the UI always reflects the same state
 * the console sees. The authoring model is reached exclusively through
 * window.__obsAuthoring so this module never pulls three.js into the
 * Node test slice.
 */

import { openFormModal } from "./form-modal";
import { notify } from "../core/notify";

import {
  solveFrame,
  type FemModel, type FemResult, type FemNode, type FemMember,
} from "../modules/analytical-model/fem";
import { checkSteel, checkRcBeam } from "../modules/analytical-model/checks";
import { STEEL_SECTIONS, findSection, type SteelSection } from "../modules/analytical-model/sections";
import {
  ductPressureDrop, pipePressureDrop, worstPath, classifyFrictionRate,
  type DuctSegment, type PipeSegment, type PressureNetwork, type PressureResult,
} from "../modules/mep/pressure";
import {
  sweepProfile, meshVolume, profileArea, divideLine, pathLength, repeatAlongPath,
  registerFamily, listFamilies,
  type ProfilePt, type Pt3, type IndexedMesh, type AdaptiveFamily,
} from "../modules/adaptive";
import {
  extrude, revolve, sweep as solidSweep, blend,
  subtract, generateVoid, cutVoids, validateMeshDiagnostics,
  generalBoolean, fuseAll, weldMesh,
  hollowExtrusion, hollowMetrics, loftSections, offsetClosedRing,
  type VoidShape, type GeneralBooleanOp,
} from "../modules/solid-kernel";
import {
  MoveCommand, RotateCommand, ArrayLinearCommand, MirrorCommand,
  MoveTool, RotateTool, MirrorTool,
  type ElementStore, type ModifyElement, type ElementPatch, type ModifyContext,
  type RemovableElementStore,
} from "../modules/modify";
import { SelectionEngine, type SelectableElement } from "../modules/selection";
import { ReferenceService } from "../modules/references";
import { TransactionService } from "../modules/transaction";
import { placeOpening, type HostGeometry, type HostedOpening } from "../modules/hosting";
import { ParameterEngine, type ParameterDefinition } from "../modules/parameter-engine";
import type { GeometryDiagnostic } from "../modules/solid-kernel/validate";

type Any = Record<string, any>;
/** Browser window handle — guarded so the compiled module also loads in
 *  Node (the unit-test slice requires this file without a DOM). */
const w: Any = typeof window !== "undefined" ? (window as unknown as Any) : {};

/* ═════════════════════════════════════════════════════════════════════════
   1. Pure helpers — no DOM, unit-tested in tests/v69-engine-ui.test.cjs
   ═════════════════════════════════════════════════════════════════════════ */

/** Parse "0,0; 6,0; 6,0.3" (2D) or "0,0,0\n6,0,2.5" into points.
 *  Points are separated by ";" or newlines; coordinates by commas/spaces. */
export function parsePointList(s: string): Pt3[] {
  const out: Pt3[] = [];
  const chunks = String(s || "").split(/[;\n]+/).map((c) => c.trim()).filter(Boolean);
  for (const chunk of chunks) {
    const parts = chunk.split(/[\s,]+/).map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) {
      throw new Error(`parsePointList: bad point "${chunk}"`);
    }
    out.push({ x: parts[0], y: parts[1] ?? 0, z: parts[2] ?? 0 });
  }
  return out;
}

/** Parse "0,0; 6,0; 6,0.3; 0,0.3" into a closed (u, v) profile polygon.
 *  The ring is auto-closed (first point appended) when left open. */
export function parseProfile(s: string): ProfilePt[] {
  const pts = parsePointList(s);
  if (pts.length < 3) throw new Error("parseProfile: a closed profile needs at least 3 points");
  const ring = pts.map((p) => ({ u: p.x, v: p.y }));
  const first = ring[0], last = ring[ring.length - 1];
  if (Math.abs(first.u - last.u) > 1e-9 || Math.abs(first.v - last.v) > 1e-9) ring.push({ ...first });
  return ring;
}

export interface FrameModelOptions {
  /** Number of bays between columns (>= 1). */
  bays: number;
  /** Bay width (m). */
  bayWidth: number;
  /** Storey height (m). */
  height: number;
  /** Gravity UDL on each beam, kN/m (applied as global -y). */
  udlKnm: number;
  /** Steel section id from the catalog (A, Ix from the catalog). */
  sectionId: string;
  /** Model beams as pin-ended truss members (no moment transfer). */
  trussBeams?: boolean;
  /** Fixed column bases (default) or pinned. */
  fixedBase?: boolean;
}

const FEM_STEEL_E = 210e9; // Pa

/** Build a single-storey portal frame FEM model from UI parameters. */
export function buildFrameModel(o: FrameModelOptions): FemModel {
  const bays = Math.max(1, Math.round(o.bays));
  const section = findSection(o.sectionId);
  if (!section) throw new Error(`buildFrameModel: unknown section '${o.sectionId}'`);
  const nodes: FemNode[] = [];
  const members: FemMember[] = [];
  const col = (i: number) => `c${i}`;
  const top = (i: number) => `t${i}`;
  for (let i = 0; i <= bays; i++) {
    nodes.push({ id: col(i), x: i * o.bayWidth, y: 0, ux: true, uy: true, rz: o.fixedBase !== false });
    nodes.push({ id: top(i), x: i * o.bayWidth, y: o.height });
  }
  for (let i = 0; i <= bays; i++) {
    members.push({ id: `col${i}`, nodeA: col(i), nodeB: top(i), E: FEM_STEEL_E, A: section.A, I: section.Ix });
  }
  for (let i = 0; i < bays; i++) {
    members.push({
      id: `beam${i}`, nodeA: top(i), nodeB: top(i + 1),
      E: FEM_STEEL_E, A: section.A, I: section.Ix, truss: o.trussBeams === true,
    });
  }
  const memberUdls = o.trussBeams === true
    ? [] // truss members carry axial only — apply beam load as nodal loads
    : members.filter((m) => m.id.startsWith("beam")).map((m) => ({ memberId: m.id, wy: -o.udlKnm * 1000 }));
  if (o.trussBeams === true) {
    // Pin-ended beams carry axial only — distribute each bay's UDL to its
    // end nodes instead (wL/2 per node, doubled for interior nodes).
    const perNode = (o.udlKnm * 1000 * o.bayWidth) / 2;
    return { nodes, members, nodalLoads: topLoads(bays, perNode), memberUdls: [] };
  }
  return { nodes, members, memberUdls };
}

function topLoads(bays: number, perNode: number) {
  const loads: { nodeId: string; fy: number }[] = [];
  for (let i = 0; i <= bays; i++) {
    const interior = i > 0 && i < bays;
    loads.push({ nodeId: `t${i}`, fy: interior ? -2 * perNode : -perNode });
  }
  return loads;
}

export interface FrameSummary {
  totalLoadKkN: number;
  reactionSumKkN: number;
  equilibrium: boolean;
  maxMomentKnm: number;
  maxDeflectionMm: number;
  maxAxialKkN: number;
  members: number;
  nodes: number;
}

/** Summarise a solved frame for display (pure). */
export function frameSummary(model: FemModel, res: FemResult): FrameSummary {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  let totalLoad = 0;
  for (const u of model.memberUdls ?? []) {
    const m = model.members.find((mm) => mm.id === u.memberId);
    const a = m ? byId.get(m.nodeA) : undefined;
    const b = m ? byId.get(m.nodeB) : undefined;
    const L = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
    totalLoad += Math.abs(u.wy ?? 0) * L; // N/m × m = N
  }
  for (const n of model.nodalLoads ?? []) totalLoad += Math.abs(n.fy ?? 0);
  let reactionSum = 0;
  for (const r of res.reactions) reactionSum += r.fy; // reactions are support forces (up positive)
  let maxMoment = 0;
  for (const f of res.memberForces.values()) {
    maxMoment = Math.max(maxMoment, Math.abs(f.M1), Math.abs(f.M2));
  }
  let maxAxial = 0;
  for (const f of res.memberForces.values()) maxAxial = Math.max(maxAxial, Math.abs(f.N1), Math.abs(f.N2));
  const tol = Math.max(1e-6, totalLoad * 1e-4);
  return {
    totalLoadKkN: totalLoad / 1000,
    reactionSumKkN: reactionSum / 1000,
    equilibrium: Math.abs(totalLoad - reactionSum) <= tol, // ΣRy ≈ +total load
    maxMomentKnm: maxMoment / 1000,
    maxDeflectionMm: res.maxDeflection * 1000,
    maxAxialKkN: maxAxial / 1000,
    members: model.members.length,
    nodes: model.nodes.length,
  };
}

/** wL²/8 simply supported bending (N·m), w in N/m, L in m. */
export function simpleBeamMu(wNdm: number, L: number): number {
  return (wNdm * L * L) / 8;
}
/** wL/2 simply supported shear (N). */
export function simpleBeamVu(wNdm: number, L: number): number {
  return (wNdm * L) / 2;
}
/** 5wL⁴/(384EI) simply supported deflection (m). */
export function simpleBeamDeflection(wNdm: number, L: number, E: number, I: number): number {
  return (5 * wNdm * Math.pow(L, 4)) / (384 * E * I);
}

export interface BranchSpec {
  /** Segment list "flow,length,diameter" per line (m³/s, m, m). */
  segments: string;
}

export interface SimpleSegment {
  /** Volumetric flow (m³/s). */
  flow: number;
  /** Segment length (m). */
  length: number;
  /** Round diameter (m). */
  diameter: number;
}

/** Parse "flow,length,diameter" lines into segment specs (pure). */
export function parseDuctLines(s: string): SimpleSegment[] {
  const out: SimpleSegment[] = [];
  for (const line of String(s || "").split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
    const [flow, length, diameter] = line.split(",").map((v) => Number(v.trim()));
    if (![flow, length, diameter].every((n) => Number.isFinite(n) && n > 0)) {
      throw new Error(`parseDuctLines: bad line "${line}" (expected flow,length,diameter)`);
    }
    out.push({ flow, length, diameter });
  }
  if (!out.length) throw new Error("parseDuctLines: at least one segment is required");
  return out;
}

/**
 * Build a two-branch distribution tree: source -> a1 -> a2 and
 * source -> b1 -> b2, computing each edge's pressure drop with the real
 * Darcy-Weisbach engine (pure, no DOM).
 */
export function buildBranchNetwork(
  a: SimpleSegment[], b: SimpleSegment[],
): { network: PressureNetwork; edgeDp: Map<string, number> } {
  const edges: { id: string; from: string; to: string; dp: number }[] = [];
  const edgeDp = new Map<string, number>();
  let prev = "source";
  a.forEach((seg, i) => {
    const id = `A${i + 1}`;
    edges.push({ id, from: prev, to: id, dp: 0 });
    edgeDp.set(id, ductPressureDrop(seg).dpTotal);
    prev = id;
  });
  edges.push({ id: "A_out", from: prev, to: "A_out", dp: 0 });
  let prevB = "source";
  b.forEach((seg, i) => {
    const id = `B${i + 1}`;
    edges.push({ id, from: prevB, to: id, dp: 0 });
    edgeDp.set(id, ductPressureDrop(seg).dpTotal);
    prevB = id;
  });
  edges.push({ id: "B_out", from: prevB, to: "B_out", dp: 0 });
  const network: PressureNetwork = {
    edges: edges.map((e) => ({ ...e, dp: edgeDp.get(e.id) ?? 0 })),
    source: "source",
  };
  return { network, edgeDp };
}

/** One-line human summary of a pressure result (pure). rate = Pa/m. */
export function pressureSummaryLine(r: PressureResult, lengthM: number): string {
  const cls = classifyFrictionRate(r.dpFriction / Math.max(lengthM, 1e-6));
  return `ΔP ${r.dpTotal.toFixed(1)} Pa · v ${r.velocity.toFixed(2)} m/s · Re ${r.reynolds.toFixed(0)} · f ${r.frictionFactor.toFixed(4)} · ${cls} friction`;
}

/* ═════════════════════════════════════════════════════════════════════════
   2. Floating report card
   ═════════════════════════════════════════════════════════════════════════ */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Any)[c]);
}

/** Show a dismissible floating report card (drag header, close button). */
export function showReportCard(title: string, rows: Array<[string, string | number]>, note = ""): HTMLDivElement {
  const el = document.createElement("div");
  const body = rows
    .map(([k, v]) => `<tr><td style="padding:3px 10px 3px 0;color:var(--text-secondary,#9aa3b5)">${esc(String(k))}</td>` +
      `<td style="padding:3px 0;text-align:right;font-variant-numeric:tabular-nums">${esc(String(v))}</td></tr>`)
    .join("");
  el.style.cssText =
    "position:fixed;top:120px;right:24px;width:330px;z-index:8600;" +
    "background:var(--bg-floating,#1c1e28);border:1px solid var(--border-default,#2a2e3a);" +
    "border-radius:10px;box-shadow:0 12px 36px rgba(0,0,0,.5);color:var(--text-primary,#e8eaf0);" +
    "font:12px/1.5 system-ui;";
  el.innerHTML =
    `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;` +
    `border-bottom:1px solid var(--border-subtle,#1e2029);background:var(--bg-elevated,#181a23);` +
    `border-radius:10px 10px 0 0;user-select:none;cursor:grab">` +
    `<b style="font-size:13px">${esc(title)}</b>` +
    `<button data-close style="background:transparent;border:1px solid var(--border-default);` +
    `color:var(--text-secondary);border-radius:5px;padding:1px 8px;cursor:pointer">×</button></div>` +
    `<div style="padding:10px 12px"><table style="width:100%;border-collapse:collapse">${body}</table>` +
    (note ? `<div style="margin-top:8px;color:var(--text-secondary,#9aa3b5);font-size:11px">${esc(note)}</div>` : "") +
    `</div>`;
  (el.querySelector("[data-close]") as HTMLButtonElement).addEventListener("click", () => el.remove());
  const hdr = el.firstElementChild as HTMLElement;
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  hdr.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragging = true; sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    el.style.left = `${ox + e.clientX - sx}px`;
    el.style.top = `${oy + e.clientY - sy}px`;
    el.style.right = "auto";
  });
  window.addEventListener("pointerup", () => { dragging = false; });
  document.body.appendChild(el);
  return el;
}

/* ═════════════════════════════════════════════════════════════════════════
   3. Structural dialogs — Analyze tab (v67 structural FEM + code checks)
   ═════════════════════════════════════════════════════════════════════════ */

export async function openFrameSolverDialog(): Promise<void> {
  const sectionOptions = STEEL_SECTIONS.map((s) => [s.id, s.id] as [string, string]);
  const r = await openFormModal({
    title: "Frame FEM Solver",
    subtitle: "Solve a single-storey frame with the built-in Euler-Bernoulli FEM (2D, 3 DOF/node)",
    fields: [
      { kind: "number", key: "bays", label: "Bays", default: 3, min: 1, max: 12, step: 1 },
      { kind: "number", key: "bayWidth", label: "Bay width", default: 6, unit: "m", step: 0.5, min: 1 },
      { kind: "number", key: "height", label: "Storey height", default: 3.5, unit: "m", step: 0.1, min: 1 },
      { kind: "number", key: "udl", label: "Beam load", default: 20, unit: "kN/m", step: 1, min: 0 },
      { kind: "select", key: "section", label: "Section", default: "W14X22", options: sectionOptions },
      { kind: "select", key: "base", label: "Column base", default: "fixed", options: [["fixed", "Fixed"], ["pinned", "Pinned"]] },
      { kind: "checkbox", key: "truss", label: "Pin-ended beams (truss behaviour)", default: false },
    ],
    submitLabel: "Solve Frame",
  });
  if (!r) return;
  try {
    const model = buildFrameModel({
      bays: Number(r.bays), bayWidth: Number(r.bayWidth), height: Number(r.height),
      udlKnm: Number(r.udl), sectionId: String(r.section),
      trussBeams: r.truss === true, fixedBase: r.base !== "pinned",
    });
    const res = solveFrame(model);
    const s = frameSummary(model, res);
    showReportCard("Frame FEM Results", [
      ["Nodes / members", `${s.nodes} / ${s.members}`],
      ["Total applied load", `${s.totalLoadKkN.toFixed(2)} kN`],
      ["Σ vertical reactions", `${s.reactionSumKkN.toFixed(2)} kN`],
      ["Equilibrium check", s.equilibrium ? "OK" : "CHECK INPUT"],
      ["Max member moment", `${s.maxMomentKnm.toFixed(2)} kN·m`],
      ["Max axial force", `${Number(s.maxAxialKkN).toFixed(2)} kN`],
      ["Max deflection", `${s.maxDeflectionMm.toFixed(3)} mm`],
    ], "Full displacement/force tables in the browser console.");
    console.table([...res.memberForces].map(([id, f]) => ({
      member: id, N1: f.N1.toFixed(0), V1: f.V1.toFixed(0), M1: f.M1.toFixed(1), M2: f.M2.toFixed(1),
    })));
    console.table(res.reactions.map((x) => ({ node: x.nodeId, fx: x.fx.toFixed(0), fy: x.fy.toFixed(0), mz: x.mz.toFixed(1) })));
    notify("success", `Frame solved: ${s.members} members, ΣRy = ${s.reactionSumKkN.toFixed(1)} kN`);
  } catch (e) {
    notify("error", `Frame solve failed: ${(e as Error).message}`);
  }
}

export async function openSteelCheckDialog(): Promise<void> {
  const sectionOptions = STEEL_SECTIONS.map((s) => [s.id, s.id] as [string, string]);
  const r = await openFormModal({
    title: "Steel Beam Check (AISC-style)",
    subtitle: "φMp bending, φVn shear and L/240 deflection for a simply supported span",
    fields: [
      { kind: "select", key: "section", label: "Section", default: "W14X22", options: sectionOptions },
      { kind: "number", key: "span", label: "Span", default: 6, unit: "m", step: 0.25, min: 0.5 },
      { kind: "number", key: "dead", label: "Dead load", default: 10, unit: "kN/m", step: 0.5, min: 0 },
      { kind: "number", key: "live", label: "Live load", default: 12, unit: "kN/m", step: 0.5, min: 0 },
      { kind: "number", key: "deflLimit", label: "Deflection limit", default: 240, unit: "L/", step: 10, min: 60 },
    ],
    submitLabel: "Check Section",
  });
  if (!r) return;
  try {
    const section = findSection(String(r.section));
    if (!section) throw new Error(`unknown section '${r.section}'`);
    const span = Number(r.span);
    const wu = (1.2 * Number(r.dead) + 1.6 * Number(r.live)) * 1000; // LRFD factored, N/m
    const wl = (Number(r.dead) + Number(r.live)) * 1000; // service, N/m
    const E = 200e9;
    const Mu = simpleBeamMu(wu, span);
    const Vu = simpleBeamVu(wu, span);
    const defl = simpleBeamDeflection(wl, span, E, section.Ix);
    const out = checkSteel(section, { Mu, Vu, deflection: defl, span }, { deflSpanFraction: 1 / Number(r.deflLimit) });
    showReportCard(`Steel Check — ${out.sectionId}`, [
      ["Mu (wL²/8)", `${(Mu / 1000).toFixed(1)} kN·m`],
      ["Vu (wL/2)", `${(Vu / 1000).toFixed(1)} kN`],
      ["φMp", `${(out.phiMp / 1000).toFixed(1)} kN·m`],
      ["φVn", `${(out.phiVn / 1000).toFixed(1)} kN`],
      ["Bending util.", `${(out.flexUtil * 100).toFixed(0)} %`],
      ["Shear util.", `${(out.shearUtil * 100).toFixed(0)} %`],
      ["Deflection δ", `${(defl * 1000).toFixed(2)} mm (L/${Number(r.deflLimit)})`],
      ["Deflection util.", `${(out.deflUtil * 100).toFixed(0)} %`],
      ["RESULT", out.pass ? "PASS ✓" : "FAIL ✗"],
    ], out.notes.join(" · "));
    notify(out.pass ? "success" : "warn", `${out.sectionId}: ${out.pass ? "PASS" : "FAIL"} (utilization ${(out.utilization * 100).toFixed(0)}%)`);
  } catch (e) {
    notify("error", `Steel check failed: ${(e as Error).message}`);
  }
}

export async function openRcBeamDialog(): Promise<void> {
  const r = await openFormModal({
    title: "RC Beam Design Check (ACI-style)",
    subtitle: "Sizes tension reinforcement (As) and stirrup spacing for a rectangular section",
    fields: [
      { kind: "number", key: "b", label: "Width b", default: 0.3, unit: "m", step: 0.05, min: 0.1 },
      { kind: "number", key: "h", label: "Depth h", default: 0.6, unit: "m", step: 0.05, min: 0.2 },
      { kind: "number", key: "d", label: "Effective depth d", default: 0.54, unit: "m", step: 0.01, min: 0.1 },
      { kind: "number", key: "fc", label: "Concrete f'c", default: 30, unit: "MPa", step: 5, min: 15 },
      { kind: "number", key: "fy", label: "Steel fy", default: 500, unit: "MPa", step: 25, min: 250 },
      { kind: "number", key: "Mu", label: "Required Mu", default: 250, unit: "kN·m", step: 10, min: 0 },
      { kind: "number", key: "Vu", label: "Required Vu", default: 180, unit: "kN", step: 10, min: 0 },
    ],
    submitLabel: "Design Check",
  });
  if (!r) return;
  try {
    const out = checkRcBeam(
      { b: Number(r.b), h: Number(r.h), d: Number(r.d), fc: Number(r.fc) * 1e6, fy: Number(r.fy) * 1e6 },
      { Mu: Number(r.Mu) * 1000, Vu: Number(r.Vu) * 1000 },
    );
    showReportCard("RC Beam Results", [
      ["Required As", `${(out.AsReq * 1e6).toFixed(0)} mm²`],
      ["Stress-block depth a", `${(out.a * 1000).toFixed(1)} mm`],
      ["φMn with AsReq", `${(out.phiMn / 1000).toFixed(1)} kN·m`],
      ["φVc (concrete)", `${(out.phiVc / 1000).toFixed(1)} kN`],
      ["Shear util. (φVc)", `${(out.shearUtil * 100).toFixed(0)} %`],
      ["Stirrup spacing", out.stirrupSpacing ? `${(out.stirrupSpacing * 1000).toFixed(0)} mm` : "not required"],
      ["RESULT", out.pass ? "PASS ✓" : "FAIL ✗"],
    ], out.notes.join(" · "));
    notify(out.pass ? "success" : "warn", `RC beam: As = ${(out.AsReq * 1e6).toFixed(0)} mm²${out.stirrupSpacing ? `, stirrups @ ${(out.stirrupSpacing * 1000).toFixed(0)} mm` : ""}`);
  } catch (e) {
    notify("error", `RC check failed: ${(e as Error).message}`);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   4. Hydraulics dialogs — Analyze tab (v67 MEP pressure engine)
   ═════════════════════════════════════════════════════════════════════════ */

export async function openDuctPressureDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Duct Pressure Drop (Darcy-Weisbach)",
    subtitle: "Colebrook-White friction, hydraulic diameter for rectangular ducts, ASHRAE roughness",
    fields: [
      { kind: "select", key: "shape", label: "Shape", default: "round", options: [["round", "Round"], ["rect", "Rectangular"]] },
      { kind: "number", key: "diameter", label: "Diameter", default: 0.4, unit: "m", step: 0.05, min: 0.05 },
      { kind: "number", key: "width", label: "Width (rect)", default: 0.6, unit: "m", step: 0.05, min: 0.05 },
      { kind: "number", key: "height", label: "Height (rect)", default: 0.3, unit: "m", step: 0.05, min: 0.05 },
      { kind: "number", key: "length", label: "Length", default: 12, unit: "m", step: 0.5, min: 0.1 },
      { kind: "number", key: "flow", label: "Air flow", default: 0.8, unit: "m³/s", step: 0.05, min: 0.01 },
      { kind: "select", key: "material", label: "Material", default: "galvanized-steel",
        options: [["galvanized-steel", "Galvanized steel"], ["stainless-steel", "Stainless steel"], ["aluminum", "Aluminium"], ["flex-duct", "Flex duct"], ["fiberglass-duct-board", "Duct board"], ["pvc", "PVC"]] },
    ],
    submitLabel: "Compute ΔP",
  });
  if (!r) return;
  try {
    const seg: DuctSegment = {
      length: Number(r.length), flow: Number(r.flow),
      ...(String(r.shape) === "round"
        ? { diameter: Number(r.diameter) }
        : { width: Number(r.width), height: Number(r.height) }),
      material: String(r.material) as DuctSegment["material"],
    };
    const res = ductPressureDrop(seg);
    showReportCard("Duct Pressure Drop", [
      ["Length", `${Number(r.length).toFixed(1)} m`],
      ["Flow", `${Number(r.flow).toFixed(3)} m³/s`],
      ["Friction ΔP", `${res.dpFriction.toFixed(1)} Pa`],
      ["Fittings ΔP", `${res.dpFittings.toFixed(1)} Pa`],
      ["Total ΔP", `${res.dpTotal.toFixed(1)} Pa`],
      ["Velocity", `${res.velocity.toFixed(2)} m/s`],
      ["Reynolds", res.reynolds.toFixed(0)],
      ["Friction factor f", res.frictionFactor.toFixed(4)],
      ["Rate class", classifyFrictionRate(res.dpFriction / Number(r.length))],
    ], "Rate band: < 0.4 low · 0.4–1.0 ASHRAE recommended · > 1.0 high (Pa/m).");
    notify("info", pressureSummaryLine(res, Number(r.length)));
  } catch (e) {
    notify("error", `Duct ΔP failed: ${(e as Error).message}`);
  }
}

export async function openPipePressureDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Pipe Pressure Drop (Darcy-Weisbach)",
    subtitle: "Water at 20 °C by default; custom density/viscosity supported",
    fields: [
      { kind: "number", key: "diameter", label: "Inner diameter", default: 0.05, unit: "m", step: 0.005, min: 0.005 },
      { kind: "number", key: "length", label: "Length", default: 25, unit: "m", step: 0.5, min: 0.1 },
      { kind: "number", key: "flow", label: "Water flow", default: 0.6, unit: "L/s", step: 0.05, min: 0.01 },
      { kind: "select", key: "material", label: "Material", default: "copper",
        options: [["copper", "Copper"], ["steel", "Steel"], ["galvanized-steel", "Galvanized steel"], ["pvc", "PVC"], ["pex", "PEX"], ["hdpe", "HDPE"], ["concrete", "Concrete"]] },
    ],
    submitLabel: "Compute ΔP",
  });
  if (!r) return;
  try {
    const seg: PipeSegment = {
      length: Number(r.length), flow: Number(r.flow) / 1000,
      diameter: Number(r.diameter), material: String(r.material) as PipeSegment["material"],
    };
    const res = pipePressureDrop(seg);
    showReportCard("Pipe Pressure Drop", [
      ["Length", `${Number(r.length).toFixed(1)} m`],
      ["Flow", `${(Number(r.flow) / 1000).toFixed(4)} m³/s`],
      ["Friction ΔP", `${res.dpFriction.toFixed(0)} Pa`],
      ["Total ΔP", `${res.dpTotal.toFixed(0)} Pa`],
      ["Head loss", `${(res.dpTotal / 9810).toFixed(3)} m`],
      ["Velocity", `${res.velocity.toFixed(3)} m/s`],
      ["Reynolds", res.reynolds.toFixed(0)],
      ["Friction factor f", res.frictionFactor.toFixed(4)],
    ], "Head loss uses ρg ≈ 9810 N/m³ for water at 20 °C.");
    notify("info", `Pipe ΔP ${res.dpTotal.toFixed(0)} Pa (${(res.dpTotal / 9810).toFixed(3)} m head)`);
  } catch (e) {
    notify("error", `Pipe ΔP failed: ${(e as Error).message}`);
  }
}

export async function openWorstPathDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Critical Path (Worst-Branch Search)",
    subtitle: "Two-branch tree from the AHU/fan — find the branch the fan must be sized for",
    fields: [
      { kind: "textarea", key: "branchA", label: "Branch A (supply-air, one segment per line: flow,length,diameter)",
        default: "0.8,10,0.4\n0.5,8,0.3", placeholder: "flow(m³/s),length(m),diameter(m)" },
      { kind: "textarea", key: "branchB", label: "Branch B (return-air, same format)",
        default: "0.6,14,0.35\n0.4,6,0.25", placeholder: "flow(m³/s),length(m),diameter(m)" },
    ],
    submitLabel: "Find Critical Path",
    width: 560,
  });
  if (!r) return;
  try {
    const a = parseDuctLines(String(r.branchA));
    const b = parseDuctLines(String(r.branchB));
    const { network } = buildBranchNetwork(a, b);
    const worst = worstPath(network);
    const pathDp = worst.edgeIds.map((id) => network.edges.find((e) => e.id === id)?.dp ?? 0);
    showReportCard("Worst Path Results", [
      ["Critical path", worst.nodes.join(" → ")],
      ["Branch edges", worst.edgeIds.join(", ")],
      ["Total ΔP (fan duty)", `${worst.totalDp.toFixed(1)} Pa`],
      ["Per-edge ΔP", pathDp.map((p) => p.toFixed(1)).join(" + ")],
      ["Compare branch B", `${(network.edges.filter((e) => e.id.startsWith("B") && !e.id.includes("out")).reduce((s, e) => s + e.dp, 0)).toFixed(1)} Pa`],
    ], "The fan/pump must overcome the highest-loss source→sink path.");
    notify("success", `Critical path ΔP ${worst.totalDp.toFixed(0)} Pa via ${worst.edgeIds.join(", ")}`);
  } catch (e) {
    notify("error", `Worst path failed: ${(e as Error).message}`);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   5. Adaptive dialogs — Architecture tab (v67 adaptive components)
   ═════════════════════════════════════════════════════════════════════════ */

function ensureDefaultAdaptiveFamilies(): void {
  if (!listFamilies().length) {
    registerFamily({ id: "rect-post", name: "Rectangular post 100×100", pointCount: 2, profile: [{ u: -0.05, v: -0.05 }, { u: 0.05, v: -0.05 }, { u: 0.05, v: 0.05 }, { u: -0.05, v: 0.05 }] });
    registerFamily({ id: "round-mullion", name: "Round mullion Ø60", pointCount: 2, profile: circleProfile(0.03, 16) });
    registerFamily({ id: "fin-300", name: "Sunshade fin 300×40", pointCount: 2, profile: [{ u: -0.15, v: -0.02 }, { u: 0.15, v: -0.02 }, { u: 0.15, v: 0.02 }, { u: -0.15, v: 0.02 }] });
  }
}

export function circleProfile(radius: number, segments = 24): ProfilePt[] {
  const out: ProfilePt[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push({ u: radius * Math.cos(a), v: radius * Math.sin(a) });
  }
  return out;
}

/** Closed rectangle profile (explicitly repeated first point). */
export function rectProfile(halfW: number, halfD: number): ProfilePt[] {
  return [
    { u: -halfW, v: -halfD }, { u: halfW, v: -halfD },
    { u: halfW, v: halfD }, { u: -halfW, v: halfD }, { u: -halfW, v: -halfD },
  ];
}

export async function openAdaptiveSweepDialog(): Promise<void> {
  ensureDefaultAdaptiveFamilies();
  const r = await openFormModal({
    title: "Adaptive Sweep",
    subtitle: "Sweep a family profile along a 3D path — watertight mesh, exact divergence-theorem volume",
    fields: [
      { kind: "select", key: "profile", label: "Profile source", default: "family",
        options: [["family", "From family"], ["rect", "Rectangle w×h"], ["circle", "Circle radius"]] },
      { kind: "select", key: "family", label: "Family", default: "rect-post",
        options: listFamilies().map((f: AdaptiveFamily) => [f.id, f.name] as [string, string]) },
      { kind: "number", key: "rw", label: "Rect width", default: 0.1, unit: "m", step: 0.01, min: 0.01 },
      { kind: "number", key: "rh", label: "Rect height", default: 0.1, unit: "m", step: 0.01, min: 0.01 },
      { kind: "number", key: "cr", label: "Circle radius", default: 0.05, unit: "m", step: 0.005, min: 0.005 },
      { kind: "textarea", key: "path", label: "Path points (x,y,z per line or x,z pairs)",
        default: "0,0,0\n6,0,0\n6,0,2.5", placeholder: "x,y,z per line" },
    ],
    submitLabel: "Create Sweep",
    width: 560,
  });
  if (!r) return;
  try {
    const path = parsePointList(String(r.path).split(/\n+/).join(";"));
    if (path.length < 2) throw new Error("path needs at least 2 points");
    let profile: ProfilePt[];
    if (r.profile === "family") {
      const fam = listFamilies().find((f: AdaptiveFamily) => f.id === r.family);
      if (!fam) throw new Error(`unknown family '${r.family}'`);
      profile = fam.profile;
    } else if (r.profile === "circle") {
      profile = circleProfile(Number(r.cr));
    } else {
      const w2 = Number(r.rw) / 2, h2 = Number(r.rh) / 2;
      profile = [{ u: -w2, v: -h2 }, { u: w2, v: -h2 }, { u: w2, v: h2 }, { u: -w2, v: h2 }];
    }
    const mesh = sweepProfile(profile, path);
    const vol = meshVolume(mesh);
    const area = profileArea(profile);
    showReportCard("Adaptive Sweep Created", [
      ["Path length", `${pathLength(path).toFixed(3)} m`],
      ["Profile area", `${(area * 1e4).toFixed(1)} cm²`],
      ["Mesh volume", `${(vol * 1e6).toFixed(1)} L`],
      ["Check area × length", `${(area * pathLength(path) * 1e6).toFixed(1)} L`],
      ["Vertices / triangles", `${mesh.vertices.length} / ${mesh.faces.length}`],
    ], "Volume is computed from the watertight mesh (divergence theorem) and matches area × length for straight runs.");
    notify("success", `Sweep created: ${mesh.faces.length} triangles, ${(vol * 1e6).toFixed(0)} L`);
  } catch (e) {
    notify("error", `Adaptive sweep failed: ${(e as Error).message}`);
  }
}

export async function openAdaptiveRepeatDialog(): Promise<void> {
  ensureDefaultAdaptiveFamilies();
  const r = await openFormModal({
    title: "Adaptive Divide & Repeat",
    subtitle: "Divide a line into equal bays and repeat a 2-point family along it",
    fields: [
      { kind: "select", key: "family", label: "Family", default: "round-mullion",
        options: listFamilies().filter((f: AdaptiveFamily) => f.pointCount === 2).map((f: AdaptiveFamily) => [f.id, f.name] as [string, string]) },
      { kind: "text", key: "start", label: "Path start", default: "0,0,0", placeholder: "x,y,z" },
      { kind: "text", key: "end", label: "Path end", default: "6,0,2.5", placeholder: "x,y,z" },
      { kind: "number", key: "bays", label: "Bays", default: 6, min: 1, max: 100, step: 1 },
    ],
    submitLabel: "Repeat Components",
  });
  if (!r) return;
  try {
    const s = parsePointList(String(r.start))[0];
    const e = parsePointList(String(r.end))[0];
    if (!s || !e) throw new Error("start and end points are required");
    const bays = Math.max(1, Math.round(Number(r.bays)));
    const divisions = divideLine(s, e, bays);
    const instances = repeatAlongPath(String(r.family), divisions);
    showReportCard("Divide & Repeat", [
      ["Family", String(r.family)],
      ["Path length", `${pathLength([s, e]).toFixed(3)} m`],
      ["Bays", bays],
      ["Bay spacing", `${(pathLength([s, e]) / bays).toFixed(3)} m`],
      ["Instances placed", instances.length],
    ], `Placement points: ${divisions.map((p) => `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`).join("  ")}`);
    notify("success", `${instances.length} instances repeated along ${bays} bays`);
  } catch (e) {
    notify("error", `Divide & repeat failed: ${(e as Error).message}`);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   6. Solid form dialogs — Edit tab (v68 solid kernel)
   ═════════════════════════════════════════════════════════════════════════ */

let lastSolid: IndexedMesh | null = null;

/** The last solid created by the Solid Forms buttons (for Validate + tests). */
export function getLastSolid(): IndexedMesh | null { return lastSolid; }

/** Summarise a GeometryDiagnostic[] into display booleans (pure). */
export function summarizeDiagnostics(diags: GeometryDiagnostic[]): {
  errors: number; warnings: number; edgeIssues: number; degenerate: number;
  watertight: boolean; commitOk: boolean;
} {
  const errors = diags.filter((d) => d.severity === "error").length;
  const warnings = diags.filter((d) => d.severity === "warning").length;
  const edgeIssues = diags.filter((d) => d.code === "non-manifold-edge").length;
  const degenerate = diags.filter((d) => d.code === "degenerate-face" || d.code === "zero-length-edge").length;
  return {
    errors, warnings, edgeIssues, degenerate,
    watertight: edgeIssues === 0,
    commitOk: errors === 0,
  };
}

function recordSolid(mesh: IndexedMesh, label: string): void {
  lastSolid = mesh;
  const diags = validateMeshDiagnostics(mesh);
  const s = summarizeDiagnostics(diags);
  const vol = meshVolume(mesh);
  showReportCard(`Solid Created — ${label}`, [
    ["Vertices", mesh.vertices.length],
    ["Triangles", mesh.faces.length],
    ["Volume", `${(vol * 1e6).toFixed(1)} L`],
    ["Watertight", s.watertight ? "yes" : "NO"],
    ["Errors / warnings", `${s.errors} / ${s.warnings}`],
    ["Commit eligible", s.commitOk ? "yes" : "no"],
  ], "Use Validate Last for the full diagnostic list with recovery actions.");
  notify("success", `${label}: vol ${(vol * 1e6).toFixed(1)} L, ${s.watertight ? "watertight" : "NOT watertight"}`);
}

export async function openExtrudeDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Solid Form — Extrude",
    subtitle: "Extrude a closed profile along +z (B-Rep validated, watertight)",
    fields: [
      { kind: "textarea", key: "profile", label: "Profile (x,y per point, CCW)", default: "0,0\n4,0\n4,0.2\n0,0.2" },
      { kind: "number", key: "depth", label: "Depth", default: 3, unit: "m", step: 0.1, min: 0.01 },
      { kind: "number", key: "startOffset", label: "Start offset", default: 0, unit: "m", step: 0.1 },
    ],
    submitLabel: "Create Extrusion",
  });
  if (!r) return;
  try {
    const mesh = extrude({ profile: parseProfile(String(r.profile)), depth: Number(r.depth), startOffset: Number(r.startOffset) });
    recordSolid(mesh, "Extrusion");
  } catch (e) {
    notify("error", `Extrude failed: ${(e as Error).message}`);
  }
}

export async function openRevolveDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Solid Form — Revolve",
    subtitle: "Revolve an (r, z) profile about an axis — full 2π or partial angle",
    fields: [
      { kind: "textarea", key: "profile", label: "Profile (r,z per point, r ≥ 0)", default: "0,0\n1.5,0\n1.5,0.15\n0.6,0.5\n0,0.5" },
      { kind: "text", key: "axisPoint", label: "Axis point", default: "0,0,0", placeholder: "x,y,z" },
      { kind: "text", key: "axisDir", label: "Axis direction", default: "0,1,0", placeholder: "x,y,z" },
      { kind: "number", key: "angle", label: "Angle", default: 360, unit: "°", step: 15, min: 5, max: 360 },
      { kind: "number", key: "segments", label: "Segments", default: 32, min: 3, max: 128, step: 1 },
    ],
    submitLabel: "Create Revolution",
  });
  if (!r) return;
  try {
    const ap = parsePointList(String(r.axisPoint))[0];
    const ad = parsePointList(String(r.axisDir))[0];
    if (!ap || !ad) throw new Error("axis point and direction are required");
    const mesh = revolve({
      profile: parseProfile(String(r.profile)),
      axisPoint: ap, axisDir: ad,
      angle: (Number(r.angle) * Math.PI) / 180,
      segments: Math.round(Number(r.segments)),
    });
    recordSolid(mesh, "Revolution");
  } catch (e) {
    notify("error", `Revolve failed: ${(e as Error).message}`);
  }
}

export async function openSolidSweepDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Solid Form — Sweep",
    subtitle: "Sweep a profile along a 3D polyline with per-segment frames",
    fields: [
      { kind: "textarea", key: "profile", label: "Profile (x,y per point, CCW)", default: "-0.1,-0.1\n0.1,-0.1\n0.1,0.1\n-0.1,0.1" },
      { kind: "textarea", key: "path", label: "Path (x,y,z per line)", default: "0,0,0\n8,0,0\n8,0,3" },
    ],
    submitLabel: "Create Sweep",
    width: 560,
  });
  if (!r) return;
  try {
    const path = parsePointList(String(r.path).split(/\n+/).join(";"));
    if (path.length < 2) throw new Error("path needs at least 2 points");
    const mesh = solidSweep({ profile: parseProfile(String(r.profile)), path });
    recordSolid(mesh, "Sweep");
  } catch (e) {
    notify("error", `Sweep failed: ${(e as Error).message}`);
  }
}

export async function openBlendDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Solid Form — Blend (Loft)",
    subtitle: "Loft between two closed sections; correspondence by polar angle when omitted",
    fields: [
      { kind: "textarea", key: "start", label: "Start profile", default: "-1,-1\n1,-1\n1,1\n-1,1" },
      { kind: "textarea", key: "end", label: "End profile", default: "-0.5,0\n0.5,0\n0,0.5\n0,-0.5" },
      { kind: "number", key: "height", label: "Height", default: 3, unit: "m", step: 0.1, min: 0.01 },
    ],
    submitLabel: "Create Blend",
    width: 560,
  });
  if (!r) return;
  try {
    const mesh = blend({
      startProfile: parseProfile(String(r.start)),
      endProfile: parseProfile(String(r.end)),
      height: Number(r.height),
    });
    recordSolid(mesh, "Blend");
  } catch (e) {
    notify("error", `Blend failed: ${(e as Error).message}`);
  }
}

export async function openBooleanDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Boolean — Subtract (A − B)",
    subtitle: "Exact half-space composition with convex cutters; coplanar operands are refused by the kernel",
    fields: [
      { kind: "number", key: "aw", label: "A width", default: 4, unit: "m", step: 0.25, min: 0.1 },
      { kind: "number", key: "ah", label: "A height", default: 3, unit: "m", step: 0.25, min: 0.1 },
      { kind: "number", key: "ad", label: "A depth", default: 0.3, unit: "m", step: 0.05, min: 0.05 },
      { kind: "number", key: "bw", label: "B width", default: 1.2, unit: "m", step: 0.1, min: 0.05 },
      { kind: "number", key: "bh", label: "B height", default: 2.1, unit: "m", step: 0.1, min: 0.05 },
      { kind: "number", key: "bx", label: "B centre X", default: 0.8, unit: "m", step: 0.1 },
    ],
    submitLabel: "Subtract",
  });
  if (!r) return;
  try {
    const box = (w2: number, h2: number, d2: number): IndexedMesh =>
      extrude({ profile: rectProfile(w2, d2), depth: h2 * 2, startOffset: -h2 });
    const a = box(Number(r.aw) / 2, Number(r.ah) / 2, Number(r.ad) / 2);
    const b = box(Number(r.bw) / 2, Number(r.bh) / 2, Number(r.ad));
    // Shift B along X by re-extruding with offset profile — simple translate:
    const translated = { vertices: b.vertices.map((v) => ({ ...v, x: v.x + Number(r.bx) })), faces: [...b.faces] };
    const out = subtract(a, translated);
    const vBefore = meshVolume(a), vAfter = meshVolume(out);
    recordSolid(out, "A − B");
    showReportCard("Boolean Result", [
      ["Volume A", `${(vBefore * 1e6).toFixed(1)} L`],
      ["Volume A − B", `${(vAfter * 1e6).toFixed(1)} L`],
      ["Removed", `${((vBefore - vAfter) * 1e6).toFixed(1)} L`],
    ], "");
  } catch (e) {
    notify("error", `Subtract failed: ${(e as Error).message} — the kernel refuses coplanar/wrong-operand inputs rather than returning wrong geometry.`);
  }
}

export async function openVoidDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Cut Openings (Voids)",
    subtitle: "Sequential void cutting with rollback guarantee — box + cylinder cutters on a wall slab",
    fields: [
      { kind: "number", key: "wallW", label: "Wall width", default: 8, unit: "m", step: 0.5, min: 1 },
      { kind: "number", key: "wallH", label: "Wall height", default: 3, unit: "m", step: 0.1, min: 1 },
      { kind: "number", key: "wallT", label: "Wall thickness", default: 0.2, unit: "m", step: 0.05, min: 0.05 },
      { kind: "number", key: "winW", label: "Window width", default: 1.5, unit: "m", step: 0.1, min: 0.1 },
      { kind: "number", key: "winH", label: "Window height", default: 1.2, unit: "m", step: 0.1, min: 0.1 },
      { kind: "number", key: "sill", label: "Sill height", default: 0.9, unit: "m", step: 0.1, min: 0 },
      { kind: "checkbox", key: "duct", label: "Also cut a Ø0.3 m duct at (6, 2.4)", default: true },
    ],
    submitLabel: "Cut Voids",
  });
  if (!r) return;
  try {
    const W = Number(r.wallW), H = Number(r.wallH), T = Number(r.wallT);
    const wall = extrude({ profile: rectProfile(W / 2, T / 2), depth: H });
    const volBefore = meshVolume(wall);
    const voids: VoidShape[] = [
      { kind: "box", center: { x: -2, y: 0, z: Number(r.sill) + Number(r.winH) / 2 }, size: { x: Number(r.winW), y: T * 3, z: Number(r.winH) } },
    ];
    if (r.duct === true) {
      voids.push({ kind: "cylinder", center: { x: 6, y: 0, z: 2.4 }, radius: 0.15, height: T * 3, segments: 24 });
    }
    const out = cutVoids(wall, voids);
    recordSolid(out.solid, "Wall with openings");
    showReportCard("Void Cutting Report", [
      ["Volume before", `${(volBefore * 1e6).toFixed(1)} L`],
      ["Volume after", `${(meshVolume(out.solid) * 1e6).toFixed(1)} L`],
      ["Voids cut", String(out.records.length)],
      ["Failures", String(out.failures.length)],
      ["Rollback guarantee", "sequential — any failure leaves the previous state intact"],
    ], "");
  } catch (e) {
    notify("error", `Void cutting failed: ${(e as Error).message}`);
  }
}

/* ── v70 deep-modeling dialogs: general booleans, shell, loft, fuse ────── */

/** Axis-aligned box overlap volume (closed form for the UI report). */
export function boxOverlapVolume(
  a: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number },
  b: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number },
): number {
  const dx = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const dy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const dz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
  return dx > 0 && dy > 0 && dz > 0 ? dx * dy * dz : 0;
}

interface Box6 { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; }

export async function openGeneralBooleanDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Boolean — General (any closed solids)",
    subtitle: "v70 kernel: union / intersect / subtract with NON-CONVEX operands on both sides; coplanar faces resolved exactly",
    fields: [
      { kind: "select", key: "op", label: "Operation", default: "union", options: [["union", "Union (A ∪ B)"], ["intersect", "Intersect (A ∩ B)"], ["subtract", "Subtract (A − B)"]] },
      { kind: "number", key: "aw", label: "A width (x)", default: 2, unit: "m", step: 0.25, min: 0.1 },
      { kind: "number", key: "ad", label: "A depth (y)", default: 2, unit: "m", step: 0.25, min: 0.1 },
      { kind: "number", key: "ah", label: "A height (z)", default: 1, unit: "m", step: 0.25, min: 0.1 },
      { kind: "number", key: "leg", label: "B leg size (cube)", default: 1, unit: "m", step: 0.1, min: 0.1 },
      { kind: "number", key: "legGap", label: "B leg2 diagonal offset", default: 0.5, unit: "m", step: 0.1, min: 0 },
    ],
    submitLabel: "Run Boolean",
  });
  if (!r) return;
  try {
    const aw = Number(r.aw), ad = Number(r.ad), ah = Number(r.ah);
    const s = Number(r.leg), off = Number(r.legGap);
    const A: Box6 = { x0: -aw / 2, y0: -ad / 2, z0: 0, x1: aw / 2, y1: ad / 2, z1: ah };
    const leg1: Box6 = { x0: 0, y0: 0, z0: 0, x1: s, y1: s, z1: s };
    const leg2: Box6 = { x0: off, y0: off, z0: 0, x1: off + s, y1: off + s, z1: s };
    const meshOf = (bx: Box6): IndexedMesh =>
      generateVoid({ kind: "box", center: { x: (bx.x0 + bx.x1) / 2, y: (bx.y0 + bx.y1) / 2, z: (bx.z0 + bx.z1) / 2 }, size: { x: bx.x1 - bx.x0, y: bx.y1 - bx.y0, z: bx.z1 - bx.z0 } });
    const bMesh = fuseAll([meshOf(leg1), meshOf(leg2)]); // NON-CONVEX L when the legs overlap
    const op = String(r.op) as GeneralBooleanOp;
    const out = generalBoolean(op, meshOf(A), bMesh);

    // Closed-form expectations (axis-aligned boxes): |B| = v1+v2−o12;
    // |A∩B| = oA1 + oA2 − oA12 (legs overlap counted once).
    const vA = (A.x1 - A.x0) * (A.y1 - A.y0) * (A.z1 - A.z0);
    const o12 = boxOverlapVolume(leg1, leg2);
    const vB = (s * s * s) * 2 - o12;
    const oA1 = boxOverlapVolume(A, leg1);
    const oA2 = boxOverlapVolume(A, leg2);
    const oA12 = boxOverlapVolume(
      { x0: Math.max(A.x0, leg1.x0), y0: Math.max(A.y0, leg1.y0), z0: 0, x1: Math.min(A.x1, leg1.x1), y1: Math.min(A.y1, leg1.y1), z1: Math.min(A.z1, leg1.z1) },
      leg2,
    );
    const iAB = oA1 + oA2 - oA12;
    const expected = op === "union" ? vA + vB - iAB : op === "intersect" ? iAB : vA - iAB;

    const vol = meshVolume(out);
    const diags = validateMeshDiagnostics(weldMesh(out));
    const sSum = summarizeDiagnostics(diags);
    recordSolid(out, `Boolean ${op}`);
    showReportCard(`General Boolean — ${op}`, [
      ["Volume A (closed form)", `${(vA * 1e6).toFixed(1)} L`],
      ["Volume B (L, closed form)", `${(vB * 1e6).toFixed(1)} L`],
      ["Result (kernel)", `${(vol * 1e6).toFixed(1)} L`],
      ["Result (closed form)", `${(expected * 1e6).toFixed(1)} L`],
      ["Match", Math.abs(vol - expected) < 1e-6 ? "EXACT" : "check inputs"],
      ["Watertight", sSum.watertight ? "yes" : "NO"],
    ], "The kernel refuses nothing here — non-convex operands and coplanar faces are resolved exactly.");
  } catch (e) {
    notify("error", `General boolean failed: ${(e as Error).message}`);
  }
}

export async function openShellDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Shell / Hollow Extrusion",
    subtitle: "Give a closed profile a wall thickness — miter inward offset, watertight cavity, exact V = depth·(A_out − A_in)",
    fields: [
      { kind: "textarea", key: "profile", label: "Profile (x,y per point, CCW)", default: "0,0\n2,0\n2,2\n0,2" },
      { kind: "number", key: "depth", label: "Depth", default: 3, unit: "m", step: 0.1, min: 0.01 },
      { kind: "number", key: "thickness", label: "Wall thickness", default: 0.25, unit: "m", step: 0.05, min: 0.01 },
    ],
    submitLabel: "Create Shell",
  });
  if (!r) return;
  try {
    const profile = parseProfile(String(r.profile));
    const depth = Number(r.depth);
    const thickness = Number(r.thickness);
    const mesh = hollowExtrusion({ profile, depth, thickness });
    const metrics = hollowMetrics(profile, depth, thickness);
    const vol = meshVolume(mesh);
    recordSolid(mesh, "Shell");
    showReportCard("Shell Report", [
      ["Outer area", `${metrics.outerArea.toFixed(3)} m²`],
      ["Inner (cavity) area", `${metrics.innerArea.toFixed(3)} m²`],
      ["Volume (kernel)", `${(vol * 1e6).toFixed(1)} L`],
      ["Volume (closed form)", `${(metrics.expectedVolume * 1e6).toFixed(1)} L`],
      ["Match", Math.abs(vol - metrics.expectedVolume) < 1e-9 ? "EXACT" : "check"],
    ], "Cavity walls wind into the void; annular caps connect both rings without polygon-with-hole triangulation.");
  } catch (e) {
    notify("error", `Shell failed: ${(e as Error).message} — reduce the thickness or simplify the profile`);
  }
}

export async function openLoftDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Loft Through Sections",
    subtitle: "N-section ruled loft with polar-angle correspondence (2 sections == blend); explicit levels optional",
    width: 560,
    fields: [
      { kind: "textarea", key: "s1", label: "Section 1 (bottom)", default: "-1,-1\n1,-1\n1,1\n-1,1" },
      { kind: "textarea", key: "s2", label: "Section 2", default: "-0.5,0\n0.5,0\n0,0.5\n0,-0.5" },
      { kind: "textarea", key: "s3", label: "Section 3 (optional — blank for 2-section loft)", default: "-0.75,-0.75\n0.75,-0.75\n0.75,0.75\n-0.75,0.75" },
      { kind: "number", key: "height", label: "Height", default: 3, unit: "m", step: 0.1, min: 0.01 },
      { kind: "text", key: "levels", label: "Levels (optional, z per section)", default: "", placeholder: "e.g. 0,1.2,3" },
    ],
    submitLabel: "Create Loft",
  });
  if (!r) return;
  try {
    const sections = [parseProfile(String(r.s1)), parseProfile(String(r.s2))];
    if (String(r.s3).trim().length > 0) sections.push(parseProfile(String(r.s3)));
    const levelsRaw = String(r.levels).trim();
    let levels: number[] | undefined;
    if (levelsRaw.length > 0) {
      levels = levelsRaw.split(/[;,\s]+/).filter(Boolean).map(Number);
      if (levels.some((v) => !Number.isFinite(v))) throw new Error("levels must be numbers");
      if (levels.length !== sections.length) throw new Error(`levels needs ${sections.length} entries`);
    }
    const mesh = loftSections({ sections, height: Number(r.height), levels });
    recordSolid(mesh, "Loft");
  } catch (e) {
    notify("error", `Loft failed: ${(e as Error).message}`);
  }
}

export async function openFuseDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Fuse Solids (n-ary Union)",
    subtitle: "Join many solids into one with the general kernel — overlapping, touching or disjoint inputs",
    fields: [
      { kind: "number", key: "size", label: "Cube size", default: 1, unit: "m", step: 0.1, min: 0.1 },
      { kind: "number", key: "o12", label: "Overlap 1↔2", default: 0.25, unit: "m", step: 0.05, min: 0 },
      { kind: "number", key: "o23", label: "Overlap 2↔3", default: 0.25, unit: "m", step: 0.05, min: 0 },
    ],
    submitLabel: "Fuse",
  });
  if (!r) return;
  try {
    const s = Number(r.size);
    const o12 = Number(r.o12), o23 = Number(r.o23);
    const cube = (x0: number): Box6 => ({ x0, y0: 0, z0: 0, x1: x0 + s, y1: s, z1: s });
    const b1 = cube(0);
    const b2 = cube(s - o12);
    const b3 = cube(2 * s - o12 - o23);
    const meshOf = (bx: Box6): IndexedMesh =>
      generateVoid({ kind: "box", center: { x: (bx.x0 + bx.x1) / 2, y: (bx.y0 + bx.y1) / 2, z: (bx.z0 + bx.z1) / 2 }, size: { x: bx.x1 - bx.x0, y: bx.y1 - bx.y0, z: bx.z1 - bx.z0 } });
    const f = fuseAll([meshOf(b1), meshOf(b2), meshOf(b3)]);
    const vol = meshVolume(f);
    const expected = 3 * s * s * s - (o12 * s * s + o23 * s * s);
    recordSolid(f, "Fused solids");
    showReportCard("Fuse Report", [
      ["Solids fused", "3"],
      ["Volume (kernel)", `${(vol * 1e6).toFixed(1)} L`],
      ["Volume (closed form)", `${(expected * 1e6).toFixed(1)} L`],
      ["Match", Math.abs(vol - expected) < 1e-6 ? "EXACT" : "check inputs"],
    ], "fuseAll reduces pairwise with the general union — overlapping, glued and disjoint inputs all accepted.");
  } catch (e) {
    notify("error", `Fuse failed: ${(e as Error).message}`);
  }
}

export function validateLastSolid(): void {
  if (!lastSolid) { notify("warn", "No solid created yet — use a Solid Form button first"); return; }
  // Boolean/general-kernel outputs are polygon soups: weld first so the
  // edge-use counts see the welded topology (forms outputs are unaffected).
  const diags = validateMeshDiagnostics(weldMesh(lastSolid));
  const s = summarizeDiagnostics(diags);
  showReportCard("Solid Diagnostics", [
    ["Vertices", lastSolid.vertices.length],
    ["Triangles", lastSolid.faces.length],
    ["Volume", `${(meshVolume(lastSolid) * 1e6).toFixed(2)} L`],
    ["Watertight", s.watertight ? "yes" : "NO"],
    ["Edge issues", String(s.edgeIssues)],
    ["Degenerate / zero-length", String(s.degenerate)],
    ["Errors", String(s.errors)],
    ["Commit eligible", s.commitOk ? "YES" : "NO"],
  ], diags.slice(0, 4).map((d) => `• ${d.message} → ${d.recoveryAction}`).join("\n"));
  notify(s.commitOk ? "success" : "warn", `Solid: ${s.commitOk ? "commit eligible" : `${s.errors} error(s)`}`);
}

/* ═════════════════════════════════════════════════════════════════════════
   7. Modify engine dialogs — Edit tab (v68 Modify engine on the live model)
   ═════════════════════════════════════════════════════════════════════════ */

interface AuthoredLike {
  id: string;
  type: string;
  name?: string;
  params: {
    start?: [number, number];
    end?: [number, number];
    point?: [number, number];
    width?: number;
    height?: number;
    [k: string]: any;
  };
}

function authoredList(): AuthoredLike[] {
  const auth = w.__obsAuthoring;
  try { return (auth?.getElements?.() ?? []) as AuthoredLike[]; } catch { return []; }
}

/** Adapt the authored element array to the v68 Modify ElementStore. */
export function authoredElementStore(): RemovableElementStore {
  const auth = w.__obsAuthoring;
  const els = authoredList();
  const find = (id: string): AuthoredLike | undefined => els.find((x) => x.id === id);
  const toModify = (e: AuthoredLike): ModifyElement => {
    const p = e.params ?? {};
    const pos: [number, number] = p.start && p.end
      ? [(p.start[0] + p.end[0]) / 2, (p.start[1] + p.end[1]) / 2]
      : p.point ? [p.point[0], p.point[1]] : [0, 0];
    const numeric: Record<string, number> = {};
    if (typeof p.width === "number") numeric.width = p.width;
    if (typeof p.height === "number") numeric.height = p.height;
    return {
      id: e.id,
      categoryId: e.type,
      pinned: false,
      editable: true,
      position: pos,
      rotationZ: 0,
      curve: p.start && p.end ? { start: [...p.start] as [number, number], end: [...p.end] as [number, number] } : undefined,
      params: numeric,
    };
  };
  const writeBack = (e: AuthoredLike, patch: ElementPatch): void => {
    if (patch.position) {
      if (e.params.start && e.params.end) {
        const mid: [number, number] = [
          (e.params.start[0] + e.params.end[0]) / 2,
          (e.params.start[1] + e.params.end[1]) / 2,
        ];
        const dx = patch.position[0] - mid[0];
        const dy = patch.position[1] - mid[1];
        e.params.start = [e.params.start[0] + dx, e.params.start[1] + dy];
        e.params.end = [e.params.end[0] + dx, e.params.end[1] + dy];
      } else if (e.params.point) {
        e.params.point = [patch.position[0], patch.position[1]];
      }
    }
    if (patch.curve) {
      e.params.start = [...patch.curve.start] as [number, number];
      e.params.end = [...patch.curve.end] as [number, number];
    }
  };
  return {
    get: (id) => { const e = find(id); return e ? toModify(e) : undefined; },
    apply: (id, patch) => {
      const e = find(id);
      if (!e) return false;
      writeBack(e, patch);
      try { auth?.rebuildAuthored?.(); } catch { /* ignore */ }
      return true;
    },
    insert: (el: ModifyElement) => {
      const src = find(el.id);
      // Preserve the tool's freshly allocated id when free (mirror copies,
      // Group 1 spec §6.3); only collide-fallback to a derived id.
      const newId = !src && !els.some((x) => x.id === el.id)
        ? el.id
        : `${el.id}-m${Math.random().toString(36).slice(2, 6)}`;
      const clone: AuthoredLike = src
        ? { ...src, id: newId, name: src.name ? `${src.name} (copy)` : undefined, params: { ...src.params } }
        : {
            id: newId, type: el.categoryId, name: `${el.categoryId} (copy)`,
            params: el.curve
              ? { start: [...el.curve.start] as [number, number], end: [...el.curve.end] as [number, number], width: el.params?.width ?? 0.2 }
              : { point: [...el.position] as [number, number] },
          };
      // For duplicating commands the newElement patch carries the geometry.
      if (el.curve) { clone.params.start = [...el.curve.start] as [number, number]; clone.params.end = [...el.curve.end] as [number, number]; }
      else if (el.position) { clone.params.point = [...el.position] as [number, number]; }
      els.push(clone);
      try { auth?.rebuildAuthored?.(); } catch { /* ignore */ }
    },
    all: () => els.map(toModify),
    remove: (id: string): boolean => {
      const i = els.findIndex((x) => x.id === id);
      if (i < 0) return false;
      const viaAuth = (auth as { removeElementById?: (id: string) => boolean } | undefined)?.removeElementById;
      let ok = false;
      try { ok = typeof viaAuth === "function" ? viaAuth.call(auth, id) : false; } catch { ok = false; }
      if (!ok) els.splice(i, 1);
      try { auth?.rebuildAuthored?.(); } catch { /* ignore */ }
      return true;
    },
  };
}

function selectedAuthoredIds(): string[] {
  try { return (w.__obsAuthoring?.getSelectedIds?.() ?? []) as string[]; } catch { return []; }
}

function modifyContext(): ModifyContext {
  const rel = w.__obsRelationships?.registry;
  return {
    store: authoredElementStore(),
    ...(rel ? { relationships: rel } : {}),
    allocateId: () => `m-${Math.random().toString(36).slice(2, 8)}`,
  };
}

/** Run a v68 Modify command end-to-end: Begin → UpdatePreview → Validate → Commit. */
function runModifyCommand(
  label: string,
  ids: string[],
  make: (ctx: ModifyContext) => { Begin(ids: string[]): void; UpdatePreview(input: Any): Any[]; Validate(): { ok: boolean; diagnostics: Any[] }; Commit(): { ok: boolean; applied: number }; },
  input: Any,
): void {
  if (!ids.length) { notify("warn", "Nothing selected — select elements in the viewport first"); return; }
  try {
    const ctx = modifyContext();
    const cmd = make(ctx);
    cmd.Begin(ids);
    cmd.UpdatePreview(input);
    const v = cmd.Validate();
    if (!v.ok) {
      const msgs = v.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ");
      notify("error", `${label} blocked: ${msgs}`);
      return;
    }
    const c = cmd.Commit();
    notify("success", `${label}: ${c.applied} change(s) applied`);
  } catch (e) {
    notify("error", `${label} failed: ${(e as Error).message}`);
  }
}

export async function openModifyMoveDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Modify Engine — Move",
    subtitle: "Moves the selected authored elements through the v68 command pipeline (preview → validate → commit)",
    fields: [
      { kind: "number", key: "dx", label: "Offset X", default: 1, unit: "m", step: 0.1 },
      { kind: "number", key: "dz", label: "Offset Z", default: 0, unit: "m", step: 0.1 },
    ],
    submitLabel: "Move Selection",
  });
  if (!r) return;
  runModifyCommand("Move", selectedAuthoredIds(), (ctx) => new MoveCommand(ctx), { type: "numeric-offset", dx: Number(r.dx), dy: Number(r.dz) });
}

export async function openModifyRotateDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Modify Engine — Rotate",
    subtitle: "Rodrigues rotation about a plan pivot, applied through the v68 command pipeline",
    fields: [
      { kind: "text", key: "pivot", label: "Pivot", default: "0,0", placeholder: "x,z" },
      { kind: "number", key: "angle", label: "Angle", default: 90, unit: "°", step: 5 },
    ],
    submitLabel: "Rotate Selection",
  });
  if (!r) return;
  const p = parsePointList(String(r.pivot))[0];
  if (!p) { notify("warn", "Invalid pivot"); return; }
  runModifyCommand("Rotate", selectedAuthoredIds(), (ctx) => new RotateCommand(ctx), {
    type: "rotation", pivot: [p.x, p.y], angle: (Number(r.angle) * Math.PI) / 180,
  });
}

export async function openModifyArrayDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Modify Engine — Linear Array",
    subtitle: "Clones the selection n times at a fixed step (new authored elements are inserted)",
    fields: [
      { kind: "number", key: "count", label: "Count (total)", default: 4, min: 2, max: 50, step: 1 },
      { kind: "number", key: "sx", label: "Step X", default: 3, unit: "m", step: 0.25 },
      { kind: "number", key: "sz", label: "Step Z", default: 0, unit: "m", step: 0.25 },
    ],
    submitLabel: "Create Array",
  });
  if (!r) return;
  runModifyCommand("Linear Array", selectedAuthoredIds(), (ctx) => new ArrayLinearCommand(ctx), {
    type: "array-linear", count: Math.round(Number(r.count)), step: [Number(r.sx), Number(r.sz)],
  });
}

export async function openModifyMirrorDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Modify Engine — Mirror",
    subtitle: "Mirror the selection about an axis; copy keeps the originals",
    fields: [
      { kind: "text", key: "point", label: "Axis point", default: "0,0", placeholder: "x,z" },
      { kind: "text", key: "dir", label: "Axis direction", default: "1,0", placeholder: "dx,dz" },
      { kind: "checkbox", key: "copy", label: "Keep originals (copy)", default: true },
    ],
    submitLabel: "Mirror Selection",
  });
  if (!r) return;
  const p = parsePointList(String(r.point))[0];
  const d = parsePointList(String(r.dir))[0];
  if (!p || !d) { notify("warn", "Invalid axis point/direction"); return; }
  runModifyCommand("Mirror", selectedAuthoredIds(), (ctx) => new MirrorCommand(ctx), {
    type: "mirror-axis", point: [p.x, p.y], dir: [d.x, d.y], copy: r.copy === true,
  });
}

/* ═════════════════════════════════════════════════════════════════════════
   8. Hosted opening — Architecture tab (v68 hosting engine)
   ═════════════════════════════════════════════════════════════════════════ */

export async function openHostedOpeningDialog(): Promise<void> {
  const walls = authoredList().filter((e) => e.type === "wall" && e.params?.start && e.params?.end);
  if (!walls.length) { notify("warn", "No authored walls to host an opening — draw a wall first"); return; }
  const selected = new Set(selectedAuthoredIds());
  const host = walls.find((x) => selected.has(x.id)) ?? walls[0];
  const p = host.params;
  const L = Math.hypot((p.end![0] - p.start![0]), (p.end![1] - p.start![1]));
  const r = await openFormModal({
    title: "Hosted Opening (v68 Hosting Engine)",
    subtitle: `Host: ${host.name ?? host.id} (${L.toFixed(2)} m) — validated placement with overlap detection`,
    fields: [
      { kind: "select", key: "host", label: "Host wall", default: host.id,
        options: walls.map((x) => [x.id, x.name ?? x.id] as [string, string]) },
      { kind: "number", key: "s", label: "Centre along wall", default: +(L / 2).toFixed(2), unit: "m", step: 0.1, min: 0 },
      { kind: "number", key: "width", label: "Opening width", default: 0.9, unit: "m", step: 0.05, min: 0.1 },
      { kind: "number", key: "height", label: "Opening height", default: 2.1, unit: "m", step: 0.05, min: 0.1 },
      { kind: "number", key: "sill", label: "Sill height", default: 0.9, unit: "m", step: 0.05, min: 0 },
      { kind: "number", key: "wallH", label: "Wall height", default: +(host.params.height ?? 3), unit: "m", step: 0.1, min: 0.5 },
    ],
    submitLabel: "Place Opening",
  });
  if (!r) return;
  try {
    const h: HostGeometry = {
      curve: { kind: "line", start: [...(p.start as [number, number])], end: [...(p.end as [number, number])] },
      baseZ: 0,
      height: Number(r.wallH),
      version: 1,
      layers: [{ name: "core", function: "structure", thickness: p.width ?? 0.2, material: "concrete" }],
    };
    const opening: HostedOpening = {
      id: `op-${Math.random().toString(36).slice(2, 8)}`,
      s: Number(r.s), width: Number(r.width), height: Number(r.height),
      sillHeight: Number(r.sill), layerOffset: 0,
    };
    const placement = placeOpening(h, opening);
    showReportCard("Opening Placed", [
      ["Host", String(r.host)],
      ["Centre s", `${opening.s.toFixed(2)} m (host L = ${L.toFixed(2)} m)`],
      ["Size", `${opening.width} × ${opening.height} m @ sill ${opening.sillHeight} m`],
      ["World centre", `(${placement.center[0].toFixed(2)}, ${placement.center[1].toFixed(2)})`],
      ["Elevation range", `${placement.zStart.toFixed(2)} – ${placement.zEnd.toFixed(2)} m`],
    ], "Placement validated against host length and layer bounds by the hosting engine.");
    notify("success", `Opening placed on ${host.name ?? host.id}`);
  } catch (e) {
    notify("error", `Opening failed: ${(e as Error).message}`);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   9. Parameter manager — Manage tab (v68 parameter engine)
   ═════════════════════════════════════════════════════════════════════════ */

/** Document-level parameter engine singleton (shared with the console). */
export const documentParameters = new ParameterEngine();

/** Register a project parameter from dialog values (pure-ish, no DOM). */
export function addProjectParameter(v: {
  id: string; name: string; symbol: string; dataType: string;
  unit: string; defaultValue: string; formula: string;
}): ParameterDefinition {
  const hasFormula = String(v.formula || "").trim().length > 0;
  const num = Number(v.defaultValue);
  const def: ParameterDefinition = {
    id: v.id.trim(),
    name: v.name.trim() || v.id.trim(),
    symbol: (v.symbol.trim() || v.id.trim()).replace(/\s+/g, "_"),
    dataType: v.dataType as ParameterDefinition["dataType"],
    scope: "global",
    origin: "project",
    ...(hasFormula ? { formula: v.formula.trim(), readOnly: true } : {}),
    ...(v.defaultValue && !hasFormula
      ? { defaultValue: v.dataType === "number" && Number.isFinite(num) ? num : v.defaultValue }
      : {}),
    ...(v.unit && v.unit !== "none" ? { unit: v.unit as ParameterDefinition["unit"], displayUnit: v.unit as ParameterDefinition["unit"] } : {}),
  };
  documentParameters.registerDefinition(def);
  return def;
}

export async function openParameterManagerDialog(): Promise<void> {
  const existing = documentParameters.allDefinitions();
  const r = await openFormModal({
    title: "Project Parameter Manager",
    subtitle: existing.length
      ? `${existing.length} parameter(s) defined — ${existing.map((d) => d.symbol).join(", ")}`
      : "Add document-wide parameters; formulas are evaluated by the dependency graph",
    fields: [
      { kind: "text", key: "id", label: "Parameter id", default: "", placeholder: "e.g. project.floor-height" },
      { kind: "text", key: "name", label: "Display name", default: "", placeholder: "e.g. Floor height" },
      { kind: "text", key: "symbol", label: "Formula symbol", default: "", placeholder: "e.g. floorHeight (defaults to id)" },
      { kind: "select", key: "dataType", label: "Data type", default: "number",
        options: [["number", "Number"], ["length", "Length"], ["area", "Area"], ["volume", "Volume"], ["angle", "Angle"], ["integer", "Integer"], ["text", "Text"], ["boolean", "Yes/No"]] },
      { kind: "select", key: "unit", label: "Unit", default: "m",
        options: [["none", "—"], ["m", "m"], ["mm", "mm"], ["m2", "m²"], ["m3", "m³"], ["deg", "°"]] },
      { kind: "text", key: "defaultValue", label: "Default value", default: "", placeholder: "e.g. 3.2" },
      { kind: "text", key: "formula", label: "Formula (optional — makes it read-only)", default: "", placeholder: "e.g. floorHeight * 2" },
    ],
    submitLabel: existing.length ? "Add Parameter" : "Add First Parameter",
    width: 560,
  });
  if (!r) return;
  try {
    if (!String(r.id).trim()) throw new Error("parameter id is required");
    const def = addProjectParameter({
      id: String(r.id), name: String(r.name), symbol: String(r.symbol),
      dataType: String(r.dataType), unit: String(r.unit),
      defaultValue: String(r.defaultValue), formula: String(r.formula),
    });
    notify("success", `Parameter '${def.symbol}' registered${def.formula ? ` (formula: ${def.formula})` : ""}`);
  } catch (e) {
    notify("error", `Parameter rejected: ${(e as Error).message}`);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   10. Model intelligence panel — Manage tab
       (registry + relationships + MEP connectors + snapping)
   ═════════════════════════════════════════════════════════════════════════ */

let intelligencePanel: HTMLDivElement | null = null;

function panelShell(title: string): { el: HTMLDivElement; body: HTMLDivElement } {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;top:100px;right:16px;width:360px;max-height:calc(100vh - 140px);" +
    "overflow:auto;z-index:8500;background:var(--bg-floating,#1c1e28);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:10px;" +
    "box-shadow:0 12px 36px rgba(0,0,0,.5);color:var(--text-primary,#e8eaf0);" +
    "font:12px/1.4 system-ui;display:none;";
  el.innerHTML =
    `<div style="display:flex;align-items:center;justify-content:space-between;` +
    `padding:10px 12px;border-bottom:1px solid var(--border-subtle,#1e2029);` +
    `background:var(--bg-elevated,#181a23);cursor:grab;user-select:none;">` +
    `<b style="font-size:13px">${esc(title)}</b>` +
    `<button data-close style="background:transparent;border:1px solid var(--border-default);` +
    `color:var(--text-secondary);border-radius:5px;padding:2px 8px;cursor:pointer">-</button></div>` +
    `<div data-body style="padding:10px 12px"></div>`;
  (el.querySelector("[data-close]") as HTMLButtonElement).addEventListener("click", () => {
    el.style.display = "none";
  });
  const body = el.querySelector("[data-body]") as HTMLDivElement;
  const hdr = el.firstElementChild as HTMLElement;
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  hdr.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragging = true; sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  });
  hdr.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    el.style.left = `${ox + e.clientX - sx}px`;
    el.style.top = `${oy + e.clientY - sy}px`;
    el.style.right = "auto";
  });
  hdr.addEventListener("pointerup", () => { dragging = false; });
  document.body.appendChild(el);
  return { el, body };
}

function section(html: string): string {
  return `<div style="margin-bottom:10px">${html}</div>`;
}

function h(heading: string): string {
  return `<div style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.06em;` +
    `color:var(--text-secondary,#9aa3b5);margin-bottom:4px">${esc(heading)}</div>`;
}

/** Build the intelligence report HTML from live engine state (pure string). */
export function intelligenceReportHtml(): string {
  const parts: string[] = [];
  // Registry (object hierarchy + identity)
  const reg = w.__obsRegistry?.registry;
  if (reg) {
    try {
      const st = reg.stats();
      parts.push(section(h("Object registry") +
        `<div>Categories: <b>${st.categories}</b> · Families: <b>${st.families}</b> · ` +
        `Types: <b>${st.types}</b> · Elements: <b>${st.elements}</b></div>` +
        (reg.identity?.stats
          ? `<div style="color:var(--text-secondary,#9aa3b5)">Identity: ${reg.identity.stats().registered} unique ids registered, ${reg.identity.stats().freed} freed (never reused)</div>`
          : "")));
    } catch { /* ignore */ }
  }
  // Relationships
  const rel = w.__obsRelationships?.registry;
  if (rel) {
    try {
      const all = rel.queryRelationships({}) ?? [];
      const byType = new Map<string, number>();
      let suspended = 0;
      for (const rec of all) {
        byType.set(rec.type, (byType.get(rec.type) ?? 0) + 1);
        if (rec.state === "suspended") suspended++;
      }
      const rows = [...byType.entries()].map(([k, n]) => `${esc(k)}: <b>${n}</b>`).join(" · ") || "none";
      parts.push(section(h("Relationships") +
        `<div>${rows}</div><div style="color:var(--text-secondary,#9aa3b5)">Total ${all.length}, suspended ${suspended}</div>`));
    } catch { /* ignore */ }
  }
  // MEP connectors
  const conn = w.__obsMepConnectors ?? w.__obsMep?.connectors;
  if (conn) {
    parts.push(section(h("MEP connectors") +
      `<div>Connector intelligence ready — compatibility gating, fittings, topology validation.</div>` +
      `<div style="color:var(--text-secondary,#9aa3b5)">No network placed yet: route MEP elements, then validate via the API.</div>`));
  }
  // Snapping
  const snap = w.__obsSnapping;
  if (snap?.settings) {
    try {
      const kinds = Object.entries(snap.settings).filter(([, v]) => v === true).map(([k]) => k);
      parts.push(section(h("Snapping engine") +
        `<div>Enabled snap kinds: ${kinds.length ? kinds.map(esc).join(", ") : "all defaults"}</div>`));
    } catch { /* ignore */ }
  }
  // Authoring
  try {
    const els = w.__obsAuthoring?.getElements?.() ?? [];
    parts.push(section(h("Authored model") +
      `<div>${els.length} element(s) — constraints, modify and hosted-opening tools operate on this model.</div>`));
  } catch { /* ignore */ }
  return parts.join("") || `<div style="color:var(--text-secondary,#9aa3b5)">Engines booting… reopen in a moment.</div>`;
}

/** Toggle the Model Intelligence dockable panel. */
export function openModelIntelligencePanel(): void {
  if (!intelligencePanel || !intelligencePanel.isConnected) {
    intelligencePanel = panelShell("Model Intelligence").el;
  }
  const body = intelligencePanel.querySelector("[data-body]") as HTMLDivElement;
  body.innerHTML = intelligenceReportHtml();
  intelligencePanel.style.display = intelligencePanel.style.display === "block" ? "none" : "block";
}

/* ═════════════════════════════════════════════════════════════════════════
   10b. Group 1 Modify tools (v71 spec §4–§6) — Move / Rotate / Mirror
   full function catalogs with transaction undo/redo, hosted rigid
   follow and relationship cloning, plus the Selection inspector and
   Reference picker (spec §2–§3).
   ═════════════════════════════════════════════════════════════════════════ */

/** Persistent undo/redo stack shared by every Group 1 tool invocation. */
const group1Txn = new TransactionService();

/** Persistent ReferenceService (command-scoped references live here). */
const group1Refs = new ReferenceService();

/** Map an authored element to the SelectionEngine's SelectableElement. */
export function toSelectable(e: { id: string; type?: string; params?: Record<string, any> }): SelectableElement {
  const p = e.params ?? {};
  const hasCurve = Array.isArray(p.start) && Array.isArray(p.end);
  const el: SelectableElement = {
    id: e.id,
    categoryId: String(e.type ?? "generic"),
    pinned: false,
    hidden: false,
    editable: true,
    curve: hasCurve
      ? { start: [Number(p.start[0]), Number(p.start[1])], end: [Number(p.end[0]), Number(p.end[1])] }
      : undefined,
    point: !hasCurve && Array.isArray(p.point) ? [Number(p.point[0]), Number(p.point[1])] : undefined,
    params: {},
  };
  if (hasCurve) {
    el.aabb = {
      min: [Math.min(Number(p.start[0]), Number(p.end[0])), Math.min(Number(p.start[1]), Number(p.end[1]))],
      max: [Math.max(Number(p.start[0]), Number(p.end[0])), Math.max(Number(p.start[1]), Number(p.end[1]))],
    };
  }
  if (typeof p.width === "number") el.params!.width = p.width;
  if (typeof p.height === "number") el.params!.height = p.height;
  return el;
}

/** Persistent selection engine over the live authored model. */
let group1Selection: SelectionEngine | null = null;
export function selectionEngine(): SelectionEngine {
  if (!group1Selection) {
    group1Selection = new SelectionEngine({
      elements: () => authoredList().map((e) => toSelectable(e)),
    });
  }
  return group1Selection;
}

function group1Context(): ModifyContext {
  const rel = w.__obsRelationships?.registry;
  return {
    store: authoredElementStore(),
    ...(rel ? { relationships: rel } : {}),
    allocateId: () => `g1-${Math.random().toString(36).slice(2, 8)}`,
  };
}

export async function openGroup1MoveDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Group 1 Tool — Move (v71 spec §4)",
    subtitle: "Full Move catalog: numeric Δ with axis constraint, hosted elements rigidly follow, transaction undo/redo",
    fields: [
      { kind: "number", key: "dx", label: "Displacement X (Δx)", default: 2, unit: "m", step: 0.25 },
      { kind: "number", key: "dy", label: "Displacement Y (Δy)", default: 0, unit: "m", step: 0.25 },
      { kind: "select", key: "axis", label: "Axis constraint", default: "none", options: [["none", "Free (2-D)"], ["x", "Constrain to X"], ["y", "Constrain to Y"]] },
    ],
    submitLabel: "Move Selection",
  });
  if (!r) return;
  const ids = selectedAuthoredIds();
  if (!ids.length) { notify("warn", "Nothing selected — select elements in the viewport first"); return; }
  try {
    let dx = Number(r.dx), dy = Number(r.dy);
    if (r.axis === "x") dy = 0;
    if (r.axis === "y") dx = 0;
    const tool = new MoveTool(group1Context(), group1Txn);
    tool.BeginMove(ids);
    tool.SetNumericTranslation([dx, dy]);
    const deps = tool.EvaluateMoveDependencies();
    tool.GenerateMovePreview();
    const v = tool.ValidateMove();
    if (!v.ok) {
      notify("error", `Move blocked: ${v.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ")}`);
      return;
    }
    const res = tool.CommitMove();
    showReportCard("Move Report (Group 1)", [
      ["Displacement", `Δ = (${dx.toFixed(3)}, ${dy.toFixed(3)}) m`],
      ["Elements moved", String(res.applied)],
      ["Hosted followers", deps.hosted.length ? deps.hosted.join(", ") : "none"],
      ["Connected (policy-reconciled)", deps.connected.length ? deps.connected.join(", ") : "none"],
      ["Reconciliation", res.reconciliation.length ? res.reconciliation.join("; ") : "no actions"],
      ["Undo", "available (transaction stack)"],
    ], "P' = P + Δ — hosted elements rigidly follow (spec §4.3, D-16). Undo via the Group 1 Undo ribbon button.");
  } catch (e) {
    notify("error", `Move failed: ${(e as Error).message}`);
  }
}

/** Undo the last Group 1 transaction (Move/Rotate/Mirror are one unit each). */
export function group1Undo(): boolean {
  return group1Txn.undo();
}

/** Redo the last undone Group 1 transaction. */
export function group1Redo(): boolean {
  return group1Txn.redo();
}

export async function openGroup1RotateDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Group 1 Tool — Rotate (v71 spec §5)",
    subtitle: "Rodrigues plan rotation: pivot + angle with optional angular snap; hosted elements rotate about the SAME pivot",
    fields: [
      { kind: "text", key: "pivot", label: "Pivot (x,y)", default: "0,0", placeholder: "x,y" },
      { kind: "number", key: "angle", label: "Angle", default: 90, unit: "°", step: 5 },
      { kind: "select", key: "snap", label: "Angular snap", default: "off", options: [["off", "Off (exact)"], ["15", "15°"], ["30", "30°"], ["45", "45°"], ["90", "90°"]] },
    ],
    submitLabel: "Rotate Selection",
  });
  if (!r) return;
  const ids = selectedAuthoredIds();
  if (!ids.length) { notify("warn", "Nothing selected — select elements in the viewport first"); return; }
  const p = parsePointList(String(r.pivot))[0];
  if (!p) { notify("warn", "Invalid pivot"); return; }
  try {
    const tool = new RotateTool(group1Context(), group1Txn);
    tool.BeginRotate(ids);
    tool.AcquireRotationAxis();
    tool.AcquireRotationPivot([p.x, p.y]);
    const snapSel = String(r.snap);
    const snapStep = snapSel === "off" ? undefined : (Number(snapSel) * Math.PI) / 180;
    tool.ResolveRotationAngle({ angle: (Number(r.angle) * Math.PI) / 180 }, { snapStep });
    tool.GenerateRotationPreview();
    const v = tool.ValidateRotation();
    const errors = v.diagnostics.filter((d) => d.severity === "error");
    if (errors.length) {
      notify("error", `Rotate blocked: ${errors.map((d) => d.message).join("; ")}`);
      return;
    }
    const res = tool.CommitRotation();
    if (!res.ok) {
      notify("warn", `Rotate rejected: ${res.diagnostics.map((d) => d.message).join("; ")}`);
      return;
    }
    showReportCard("Rotate Report (Group 1)", [
      ["Pivot", `(${p.x}, ${p.y})`],
      ["Angle", `${Number(r.angle)}°${snapStep ? " (snapped)" : ""}`],
      ["Elements rotated", String(res.applied)],
      ["Hosted co-rotated", tool.UpdateDependentOrientations().join(", ") || "none"],
      ["Reconciliation", res.reconciliation.length ? res.reconciliation.join("; ") : "no actions"],
    ], "p' = Q + R(θ)(p − Q); hosted elements share the pivot (spec §5.3).");
  } catch (e) {
    notify("error", `Rotate failed: ${(e as Error).message}`);
  }
}

export async function openGroup1MirrorDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Group 1 Tool — Mirror (v71 spec §6)",
    subtitle: "Reflection M = 2ddᵀ − I, θ' = 2φ − θ; copy mode clones relationships with mirrored geometry",
    fields: [
      { kind: "text", key: "point", label: "Mirror-line point (x,y)", default: "0,0", placeholder: "x,y" },
      { kind: "text", key: "dir", label: "Mirror-line direction", default: "1,0", placeholder: "dx,dy" },
      { kind: "checkbox", key: "copy", label: "Keep originals (copy mode)", default: true },
    ],
    submitLabel: "Mirror Selection",
  });
  if (!r) return;
  const ids = selectedAuthoredIds();
  if (!ids.length) { notify("warn", "Nothing selected — select elements in the viewport first"); return; }
  const p = parsePointList(String(r.point))[0];
  const d = parsePointList(String(r.dir))[0];
  if (!p || !d) { notify("warn", "Invalid mirror-line point/direction"); return; }
  try {
    const tool = new MirrorTool(group1Context(), group1Txn);
    tool.BeginMirror(ids, r.copy === true);
    tool.AcquireMirrorPlane([p.x, p.y], [d.x, d.y]);
    tool.GenerateMirrorPreview();
    const v = tool.ValidateMirror();
    const errors = v.diagnostics.filter((dg) => dg.severity === "error");
    if (errors.length) {
      notify("error", `Mirror blocked: ${errors.map((dg) => dg.message).join("; ")}`);
      return;
    }
    const res = tool.CommitMirror();
    if (!res.ok) {
      notify("warn", `Mirror rejected: ${res.diagnostics.map((dg) => dg.message).join("; ")}`);
      return;
    }
    const warns = res.diagnostics.filter((dg) => dg.severity === "warning").map((dg) => dg.message);
    showReportCard("Mirror Report (Group 1)", [
      ["Mode", r.copy === true ? "copy (originals preserved)" : "move (originals transformed)"],
      ["Elements", String(res.applied)],
      ["Created copies", res.createdIds.length ? res.createdIds.join(", ") : "—"],
      ["Relationships cloned", String(res.clonedRelationships)],
      ["Warnings", warns.length ? warns.join("; ") : "none"],
    ], "Handed parameters flip; copies start unpinned (spec §6.2–§6.3).");
  } catch (e) {
    notify("error", `Mirror failed: ${(e as Error).message}`);
  }
}

export async function openSelectionInspectorDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Selection Inspector (v71 spec §2)",
    subtitle: "Hit-testing with deterministic priority (vertex > edge > connector > datum > body), window modes, filters, hosted expansion",
    fields: [
      { kind: "select", key: "mode", label: "Mode", default: "hit", options: [["hit", "Hit-test at point"], ["window-inside", "Window (fully inside)"], ["window-crossing", "Crossing (intersects)"], ["category", "Select by category"], ["expand", "Expand hosted of current selection"]] },
      { kind: "text", key: "point", label: "Pick point (x,y)", default: "0,0", placeholder: "x,y" },
      { kind: "number", key: "radius", label: "Pick radius", default: 0.05, unit: "m", step: 0.01, min: 0.001 },
      { kind: "text", key: "corner", label: "Opposite corner (x,y) — window modes", default: "5,5", placeholder: "x,y" },
      { kind: "text", key: "category", label: "Category — category mode", default: "wall", placeholder: "wall / column / ..." },
    ],
    submitLabel: "Run Selection",
  });
  if (!r) return;
  try {
    const eng = selectionEngine();
    const p = parsePointList(String(r.point))[0] ?? { x: 0, y: 0 };
    const c = parsePointList(String(r.corner))[0] ?? { x: 5, y: 5 };
    let result: string;
    if (r.mode === "hit") {
      const hit = eng.SelectSingle([p.x, p.y], Number(r.radius));
      result = hit ? `${hit.elementId} (${hit.subKind}, prio ${hit.priority}, d=${hit.distance.toFixed(4)}m)` : "no hit";
    } else if (r.mode === "window-inside" || r.mode === "window-crossing") {
      const picked = eng.SelectWindow([p.x, p.y], [c.x, c.y], r.mode === "window-inside" ? "inside" : "crossing");
      result = picked.length ? picked.join(", ") : "none";
    } else if (r.mode === "category") {
      const picked = eng.SelectByCategory([String(r.category).trim()]);
      result = picked.length ? picked.join(", ") : "none";
    } else {
      const out: string[] = [];
      for (const id of eng.GetSelection()) out.push(...eng.ExpandHosted(id));
      result = out.length ? out.join(", ") : "no hosted dependents";
    }
    const diags = eng.GetDiagnostics().slice(-6).map((dg) => `${dg.severity.toUpperCase()} ${dg.code}: ${dg.message}`);
    showReportCard("Selection Report (Group 1)", [
      ["Mode", String(r.mode)],
      ["Selection", eng.GetSelection().join(", ") || "empty"],
      ["Last result", result],
      ["Diagnostics", diags.length ? diags.join("  |  ") : "none"],
    ], "Pinned elements stay selectable for unpinning; edits reject them at command activation (spec §2.4).");
  } catch (e) {
    notify("error", `Selection failed: ${(e as Error).message}`);
  }
}

export async function openReferencePickerDialog(): Promise<void> {
  const r = await openFormModal({
    title: "Reference Picker (v71 spec §3)",
    subtitle: "Acquire a typed reference with a canonical orthonormal frame; command-scoped, never implicitly persistent",
    fields: [
      { kind: "select", key: "kind", label: "Reference kind", default: "edge", options: [["edge", "Edge"], ["vertex", "Vertex"], ["face", "Face"], ["host-surface", "Host surface"], ["centerline", "Centerline"], ["location-line", "Location line"], ["reference-plane", "Reference plane"], ["grid", "Grid"], ["level", "Level"], ["work-plane", "Work plane"], ["connector", "Connector"], ["analytical-axis", "Analytical axis"]] },
      { kind: "text", key: "position", label: "Position (x,y,z)", default: "0,0,0", placeholder: "x,y,z" },
      { kind: "text", key: "direction", label: "Direction / tangent (x,y,z)", default: "1,0,0", placeholder: "dx,dy,dz" },
      { kind: "text", key: "normal", label: "Normal (face/plane kinds)", default: "0,0,1", placeholder: "nx,ny,nz" },
      { kind: "number", key: "elevation", label: "Elevation (level kind)", default: 0, unit: "m", step: 0.5 },
    ],
    submitLabel: "Acquire Reference",
  });
  if (!r) return;
  try {
    const v3 = (s: string): [number, number, number] => {
      const p = parsePointList(String(s))[0] ?? { x: 0, y: 0 };
      return [p.x, p.y, (p as { z?: number }).z ?? 0];
    };
    const ref = group1Refs.Acquire({
      kind: String(r.kind) as never,
      position: v3(String(r.position)),
      direction: v3(String(r.direction)),
      normal: v3(String(r.normal)),
      elevation: Number(r.elevation),
    });
    const elig = (["move", "rotate", "mirror"] as const).map((cmd) => {
      const res = group1Refs.ValidateForCommand(ref, cmd);
      return [cmd, res.ok ? "eligible" : "ineligible"] as [string, string];
    });
    showReportCard("Reference Report (Group 1)", [
      ["Reference", `${ref.id} (${ref.kind})`],
      ["Frame origin", ref.frame.origin.map((n) => n.toFixed(3)).join(", ")],
      ["Frame x / z", `${ref.frame.xAxis.map((n) => n.toFixed(2)).join(",")}  /  ${ref.frame.zAxis.map((n) => n.toFixed(2)).join(",")}`],
      ["Status", `${ref.status} (persistent: ${String(ref.persistent)})`],
      ...elig.map(([cmd, s]) => [`Eligibility — ${cmd}`, s] as [string, string]),
    ], "Acquired references are command inputs; persistence requires an explicit lock (e.g. Align-with-lock).");
  } catch (e) {
    notify("error", `Reference acquisition failed: ${(e as Error).message}`);
  }
}

export function setupEngineUi(): void {
  w.__obsEngineUi = {
    // structural
    openFrameSolverDialog, openSteelCheckDialog, openRcBeamDialog,
    // hydraulics
    openDuctPressureDialog, openPipePressureDialog, openWorstPathDialog,
    // adaptive
    openAdaptiveSweepDialog, openAdaptiveRepeatDialog,
    // solids
    openExtrudeDialog, openRevolveDialog, openSolidSweepDialog, openBlendDialog,
    openBooleanDialog, openVoidDialog, validateLastSolid, getLastSolid,
    // modify
    openModifyMoveDialog, openModifyRotateDialog, openModifyArrayDialog, openModifyMirrorDialog,
    // group 1 tools (v71 spec §4–§6)
    openGroup1MoveDialog, openGroup1RotateDialog, openGroup1MirrorDialog,
    openSelectionInspectorDialog, openReferencePickerDialog,
    group1Undo, group1Redo, selectionEngine, toSelectable,
    get group1Txn() { return group1Txn; },
    get group1Refs() { return group1Refs; },
    authoredElementStore,
    // hosting
    openHostedOpeningDialog,
    // parameters
    openParameterManagerDialog, documentParameters, addProjectParameter,
    // intelligence
    openModelIntelligencePanel, intelligenceReportHtml,
    // helpers
    parsePointList, parseProfile, parseDuctLines, buildFrameModel, frameSummary,
    buildBranchNetwork, pressureSummaryLine, summarizeDiagnostics,
    simpleBeamMu, simpleBeamVu, simpleBeamDeflection, circleProfile,
  };
  console.log(
    "[obs] v69 engine UI ready: Analyze (Frame FEM / Steel / RC / Duct / Pipe / Worst path), " +
    "Architecture (Adaptive / Hosted Opening), Edit (Solid Forms / Modify engine), " +
    "Manage (Parameters / Model Intelligence)",
  );
}
