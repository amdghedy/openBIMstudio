/**
 * Parametric constraint tools — the user-facing creation surface for the
 * stored-constraint system.
 *
 * Before this module the L-M solver stack was complete but unreachable:
 * `lockDimension / addEquality / addParallel / addPerpendicular /
 * addAlignment` had zero UI call sites, and the only console entry point
 * was broken by a `require()` call inside an ESM bundle. This module
 * exposes selection-aware commands that:
 *   1. create a stored constraint from the CURRENT selection,
 *   2. capture the current geometric value (same nearest-endpoint-pair
 *      semantics the solver bridge uses — no jump on creation),
 *   3. run the numeric solver and report the honest outcome
 *      (elements moved / over-constrained / did not converge),
 *   4. queue the debounced auto-solve so later move/drag commits keep
 *      enforcing the constraints.
 *
 * Per-element parameter locks (length / height / thickness / width) remain
 * the temporary-dimension lock system in authoring.ts — the same division
 * Revit uses (element dims vs inter-element constraints).
 */
import { ctx } from "../core/context";
import {
  lockDimension,
  addEquality,
  addParallel,
  addPerpendicular,
  addAlignment,
  getAllConstraints,
  removeConstraint,
  toggleConstraint,
  type ParametricConstraint,
} from "../modules/parametric-constraints/types";
import { nearestEndpointDistance, solveStoredConstraints, type ElementLike } from "../modules/parametric-constraints/solver-bridge";
import { notify } from "../core/notify";

type Any = Record<string, any>;

function authoring(): Any | null {
  return ((ctx as Any).features ?? {}).authoring ?? null;
}

function elements(): ElementLike[] {
  const a = authoring();
  if (!a) return [];
  try {
    if (typeof a.getElements === "function") return (a.getElements() ?? []) as ElementLike[];
    if (Array.isArray(a.elements)) return a.elements as ElementLike[];
  } catch { /* boot order */ }
  return [];
}

function selected(): ElementLike[] {
  const a = authoring();
  if (!a) return [];
  let ids: string[] = [];
  try { ids = ((typeof a.getSelectedIds === "function" ? a.getSelectedIds() : []) ?? []).map(String); } catch { ids = []; }
  if (!ids.length) return [];
  const all = elements();
  const byId = new Map(all.map((e) => [String((e as Any).id), e]));
  return ids.map((id) => byId.get(id)).filter(Boolean) as ElementLike[];
}

function isSegment(el: ElementLike): boolean {
  const p = (el as Any)?.params ?? {};
  return Array.isArray(p.start) && Array.isArray(p.end);
}

/** Run the stored-constraint solve and report the honest outcome. */
function solveAndReport(what: string): { changed: number; errors: string[] } {
  const els = elements();
  let changed = 0;
  let errors: string[] = [];
  try {
    const out = solveStoredConstraints(els, getAllConstraints());
    changed = out.changed;
    errors = out.errors ?? [];
  } catch (err) {
    errors = [err instanceof Error ? err.message : String(err)];
  }
  // The debounced auto-solve engine runs the FULL pipeline (stored solve +
  // hosted-opening re-clamp + rebuild) and re-enforces on later commits.
  try { ((ctx as Any).features?.constraintSolver as Any)?.auto?.schedule?.(); } catch { /* */ }
  if (errors.length) {
    notify("warn", `${what}: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`);
  } else if (changed > 0) {
    notify("success", `${what}: solved, ${changed} element(s) adjusted`);
  } else {
    notify("success", `${what}: constraint stored — geometry already satisfies it`);
  }
  return { changed, errors };
}

function needSelection(n: number, label: string): ElementLike[] | null {
  const els = selected();
  if (els.length < n) {
    notify("warn", `${label}: select ${n === 2 ? "two" : n} element(s) first (walls, beams, columns…).`);
    return null;
  }
  return els;
}

/** Lock the current nearest-endpoint distance between two selected elements. */
export function lockSelectedDistance(): boolean {
  const els = needSelection(2, "Lock Distance");
  if (!els) return false;
  const [a, b] = els;
  const d = nearestEndpointDistance(a, b);
  if (d == null || !Number.isFinite(d)) {
    notify("warn", "Lock Distance needs two linear or point elements (wall, beam, line, column…).");
    return false;
  }
  const c = lockDimension(String((a as Any).id), String((b as Any).id), Math.round(d * 1000) / 1000);
  solveAndReport(`Distance locked (${d.toFixed(3)} m, #${c.id})`);
  return true;
}

/** Make 2+ selected segments keep equal length (first selection is the reference). */
export function makeSelectedEqual(): boolean {
  const els = needSelection(2, "Equal Length");
  if (!els) return false;
  const segs = els.filter(isSegment);
  if (segs.length < 2) {
    notify("warn", "Equal Length needs at least two linear elements (wall, beam, line…).");
    return false;
  }
  const ids = segs.map((e) => String((e as Any).id));
  const c = addEquality(ids, "length");
  solveAndReport(`Equal length on ${ids.length} element(s), reference #${ids[0]} (#${c.id})`);
  return true;
}

function pairConstraint(
  kind: "parallel" | "perpendicular" | "alignment",
  label: string,
): boolean {
  const els = needSelection(2, label);
  if (!els) return false;
  const [a, b] = els;
  if (!isSegment(a) || !isSegment(b)) {
    notify("warn", `${label} needs two linear elements (wall, beam, line…).`);
    return false;
  }
  const fn = kind === "parallel" ? addParallel : kind === "perpendicular" ? addPerpendicular : addAlignment;
  const c = fn(String((a as Any).id), String((b as Any).id));
  solveAndReport(`${label} constraint stored (#${c.id})`);
  return true;
}

export const makeSelectedParallel = (): boolean => pairConstraint("parallel", "Parallel");
export const makeSelectedPerpendicular = (): boolean => pairConstraint("perpendicular", "Perpendicular");
export const makeSelectedAligned = (): boolean => pairConstraint("alignment", "Alignment");

/** Run the full stored-constraint solve on demand. */
export function solveConstraintsNow(): number {
  const f = (ctx as Any).features ?? {};
  try {
    const n = typeof f.constraintSolver?.solve === "function"
      ? f.constraintSolver.solve()
      : 0;
    notify(n > 0 ? "success" : "info", n > 0 ? `Solve complete — ${n} element(s) adjusted` : "Solve complete — model already satisfies all constraints");
    return n;
  } catch (err) {
    notify("warn", `Solve failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/** Constraint list row for the manage dialog. */
export function constraintRows(): Array<Record<string, unknown>> {
  return getAllConstraints().map((c) => ({
    id: c.id,
    type: c.type,
    elements: (c.elementIds ?? []).join(", "),
    value: c.type === "locked-dimension" && c.value != null ? `${Number(c.value).toFixed(3)} m` : (c.dimensionLabel ?? "—"),
    active: c.active ? "yes" : "no",
  }));
}

const TYPE_COLORS: Record<string, string> = {
  "locked-dimension": "#38bdf8",
  equality: "#a855f7",
  alignment: "#22c55e",
  parallel: "#f59e0b",
  perpendicular: "#ef4444",
};

function manageConstraintsDialog(): void {
  const render = (list: HTMLDivElement, close: () => void): void => {
    const all = getAllConstraints();
    list.innerHTML = "";
    if (!all.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:14px;text-align:center;color:#8b93a7;font-size:12px";
      empty.textContent = "No parametric constraints yet. Select two elements and use Lock Distance / Parallel / Perpendicular / Equal Length / Alignment.";
      list.appendChild(empty);
      return;
    }
    for (const c of all) {
      const rowEl = document.createElement("div");
      rowEl.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid #2a2e3a;border-radius:8px;background:#1b1e28";
      const dot = `<span style="width:8px;height:8px;border-radius:50%;background:${TYPE_COLORS[c.type] ?? "#6b7280"};flex:none"></span>`;
      const info = document.createElement("div");
      info.style.cssText = "flex:1;min-width:0";
      info.innerHTML =
        `<div style="font-weight:600;font-size:12px">${dot} ${c.type} ${c.value != null ? `· ${Number(c.value).toFixed(3)} m` : ""}${c.active ? "" : ' · <span style="color:#f59e0b">inactive</span>'}</div>` +
        `<div style="font-size:10px;color:#8b93a7;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.id} · ${(c.elementIds ?? []).join(" ↔ ")}</div>`;
      const btnCss = "padding:4px 8px;border-radius:6px;border:1px solid #2a2e3a;background:#232633;color:#e8eaf0;cursor:pointer;font-size:11px";
      const toggleBtn = document.createElement("button");
      toggleBtn.textContent = c.active ? "Disable" : "Enable";
      toggleBtn.style.cssText = btnCss;
      toggleBtn.onclick = () => { toggleConstraint(c.id); render(list, close); };
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Remove";
      removeBtn.style.cssText = btnCss + ";color:#f87171";
      removeBtn.onclick = () => { removeConstraint(c.id); render(list, close); };
      rowEl.append(info, toggleBtn, removeBtn);
      list.appendChild(rowEl);
    }
    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;gap:8px;margin-top:10px";
    const solveBtn = document.createElement("button");
    solveBtn.textContent = "Solve now";
    solveBtn.style.cssText = "flex:1;padding:7px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;font-weight:600;font-size:12px";
    solveBtn.onclick = () => { solveConstraintsNow(); render(list, close); };
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Remove all";
    clearBtn.style.cssText = "padding:7px 10px;border-radius:8px;border:1px solid #2a2e3a;background:#232633;color:#f87171;cursor:pointer;font-size:12px";
    clearBtn.onclick = () => {
      for (const c of getAllConstraints()) removeConstraint(c.id);
      render(list, close);
    };
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.style.cssText = "padding:7px 10px;border-radius:8px;border:1px solid #2a2e3a;background:#232633;color:#e8eaf0;cursor:pointer;font-size:12px";
    closeBtn.onclick = close;
    footer.append(solveBtn, clearBtn, closeBtn);
    list.appendChild(footer);
  };

  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif";
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) overlay.remove(); });
  const card = document.createElement("div");
  card.style.cssText = "width:430px;max-width:92vw;max-height:70vh;display:flex;flex-direction:column;background:#161922;border:1px solid #2a2e3a;border-radius:12px;box-shadow:0 16px 50px rgba(0,0,0,.5);color:#e8eaf0;overflow:hidden";
  const head = document.createElement("div");
  head.style.cssText = "padding:10px 12px;border-bottom:1px solid #2a2e3a;font-weight:700";
  head.textContent = "Parametric Constraints";
  const sub = document.createElement("div");
  sub.style.cssText = "padding:8px 12px;border-bottom:1px solid #222634;font-size:11px;color:#8b93a7";
  sub.textContent = "Locked dimensions, equality, alignment, parallel and perpendicular constraints enforced by the geometric solver after every move commit.";
  const listEl = document.createElement("div");
  listEl.style.cssText = "padding:10px 12px;overflow:auto;display:flex;flex-direction:column;gap:6px";
  overlay.appendChild(card);
  card.append(head, sub, listEl);
  document.body.appendChild(overlay);
  render(listEl, () => overlay.remove());
}

export function openConstraintManager(): void { manageConstraintsDialog(); }

let installed = false;
export function setupConstraintTools(): void {
  if (installed) return; installed = true;
  const f = (ctx as Any).features ?? ((ctx as Any).features = {});
  f.constraintTools = {
    lockDistance: lockSelectedDistance,
    equalLength: makeSelectedEqual,
    parallel: makeSelectedParallel,
    perpendicular: makeSelectedPerpendicular,
    alignment: makeSelectedAligned,
    solve: solveConstraintsNow,
    manage: openConstraintManager,
    rows: constraintRows,
  };
  console.log("[constraint-tools] ready — select two elements, then Lock Distance / Parallel / Perpendicular / Equal Length / Alignment.");
}
