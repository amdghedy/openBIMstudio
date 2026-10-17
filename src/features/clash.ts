/** Clash detection (Navisworks-style A vs B) + 8 detection methods
 *  + crop box + status workflow + coordination helpers. */
import * as THREE from "three";
import type * as OBC from "@thatopen/components";
import { ctx } from "../core/context";
import { fitAll, computeSceneBounds } from "./camera-tools";
import {
  DEFAULT_CLASH_RULES,
  CLASH_METHODS,
  type ClashRules,
  type ClashKind,
  type ClashMethod,
  type ElementClash,
} from "./clash-engine";
import { runClashOffThread } from "./clash-worker-client";
import { getAuthor } from "../modules/issues/issues";
import { getElementWorldBox } from "../modules/geometry/world-box";
import { register, tryUse, type ClashService } from "../core/services";
import {
  groupClashes,
  summarizeGroups,
  type ClashGroup,
} from "../modules/clash/grouping";

// ═══════════════════════════════════════════════════════════════════════════
// Toast
// ═══════════════════════════════════════════════════════════════════════════
function clashToast(msg: string, kind: "info" | "warn" | "success" = "info", ms = 2000): void {
  try {
    let host = document.getElementById("obs-clash-toast-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "obs-clash-toast-host";
      host.className = "obs-toast-host";
      document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = "obs-toast";
    el.dataset.kind = kind;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add("obs-toast--out");
      setTimeout(() => el.remove(), 250);
    }, ms);
  } catch { /* */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Scope + status types
// ═══════════════════════════════════════════════════════════════════════════
export type ClashScope = "all" | "viewport" | "aOnly" | "bOnly" | "both";

export type ClashStatus = "new" | "active" | "reviewed" | "approved" | "resolved";

export interface ClashComment {
  id: string;
  author: string;
  date: number;
  text: string;
}

export interface ClashState {
  status: ClashStatus;
  comments: ClashComment[];
  assignee?: string;
  updatedAt: number;
}

const STATUS_ORDER: ClashStatus[] = ["new", "active", "reviewed", "approved", "resolved"];

const STATUS_COLOR: Record<ClashStatus, string> = {
  new: "#38bdf8",
  active: "#f59e0b",
  reviewed: "#c084fc",
  approved: "#22c55e",
  resolved: "#6b7280",
};

const STATUS_LABEL: Record<ClashStatus, string> = {
  new: "New",
  active: "Active",
  reviewed: "Reviewed",
  approved: "Approved",
  resolved: "Resolved",
};

function clashKey(c: ElementClash): string {
  const a = `${c.a.modelId}:${c.a.localId}`;
  const b = `${c.b.modelId}:${c.b.localId}`;
  return a < b ? `${a}|${b}|${c.kind}` : `${b}|${a}|${c.kind}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════
let rules: ClashRules = { ...DEFAULT_CLASH_RULES };
let currentMethod: ClashMethod = "hard-triangle";

let clashResults: ElementClash[] = [];
let clashGroups: ClashGroup[] = [];
let activeGroupId: string | null = null;
const clashStates = new Map<string, ClashState>();
let cropMargin = 0.3;
let activeClash: ElementClash | null = null;
let cropWire: THREE.Box3Helper | null = null;
let cancelToken: { cancelled: boolean } | null = null;

export function setTolerance(v: number) { rules.tolerance = Math.max(0, v); }
export function getTolerance() { return rules.tolerance; }
export function setClearance(v: number) { rules.clearance = Math.max(0, v); }
export function getClearance() { return rules.clearance; }
export function getRules() { return { ...rules }; }
export function setRules(r: Partial<ClashRules>) { rules = { ...rules, ...r }; }
export function getMethod(): ClashMethod { return currentMethod; }
export function setMethod(m: ClashMethod) {
  currentMethod = m;
  if (clashMethodSelect) clashMethodSelect.value = m;
  updateMethodDescription();
}

export function cancelClash() {
  if (cancelToken) {
    cancelToken.cancelled = true;
    clashToast("Cancelling clash test…", "warn", 1500);
  } else {
    clashToast("No test is currently running.", "info", 1500);
  }
}

export function getClashState(c: ElementClash): ClashState {
  const key = clashKey(c);
  let s = clashStates.get(key);
  if (!s) {
    s = { status: "new", comments: [], updatedAt: Date.now() };
    clashStates.set(key, s);
  }
  return s;
}

export function setClashStatus(c: ElementClash, status: ClashStatus): void {
  const s = getClashState(c);
  s.status = status;
  s.updatedAt = Date.now();
  renderClashList();
  updateSummary();
}

export function addClashComment(c: ElementClash, text: string): void {
  if (!text.trim()) return;
  const s = getClashState(c);
  s.comments.push({
    id:
      (crypto as any).randomUUID?.() ??
      `cc-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    author: getAuthor(),
    date: Date.now(),
    text: text.trim(),
  });
  s.updatedAt = Date.now();
  renderClashList();
}

// ═══════════════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════════════
export const clashStatusEl = document.createElement("div");
clashStatusEl.style.cssText = "margin-top:8px;font-size:12px;color:#fbbf24";
clashStatusEl.textContent = "Select models in A and B, then Run Test.";

export const clashProgressEl = document.createElement("div");
clashProgressEl.style.cssText =
  "margin-top:6px;height:6px;background:#12131a;border-radius:3px;overflow:hidden;display:none";
const clashProgressInner = document.createElement("div");
clashProgressInner.style.cssText =
  "height:100%;width:0%;background:#38bdf8;transition:width .15s";
clashProgressEl.appendChild(clashProgressInner);

export const clashCancelBtn = document.createElement("button");
clashCancelBtn.textContent = "Cancel";
clashCancelBtn.style.cssText =
  "margin-top:6px;padding:5px 10px;background:#3b0d0d;color:#fca5a5;border:1px solid #ef4444;border-radius:5px;cursor:pointer;font-size:11px;display:none";
clashCancelBtn.onclick = () => cancelClash();

export const clashListEl = document.createElement("div");
clashListEl.style.cssText = "margin-top:8px;max-height:260px;overflow:auto;font-size:11px";

const selectionA = new Set<string>();
const selectionB = new Set<string>();

/* ── A/B persistence ── */
const SEL_A_KEY = "obs.clash.selectionA";
const SEL_B_KEY = "obs.clash.selectionB";

function loadSelections(): void {
  try {
    const a = localStorage.getItem(SEL_A_KEY);
    const b = localStorage.getItem(SEL_B_KEY);
    if (a) for (const k of JSON.parse(a) as string[]) selectionA.add(k);
    if (b) for (const k of JSON.parse(b) as string[]) selectionB.add(k);
  } catch { /* */ }
}
function persistSelections(): void {
  try {
    localStorage.setItem(SEL_A_KEY, JSON.stringify([...selectionA]));
    localStorage.setItem(SEL_B_KEY, JSON.stringify([...selectionB]));
  } catch { /* */ }
}

/* ── Method persistence ── */
const METHOD_KEY = "obs.clash.method";
try {
  const stored = localStorage.getItem(METHOD_KEY) as ClashMethod | null;
  if (stored && CLASH_METHODS.some((m) => m.id === stored)) currentMethod = stored;
} catch { /* */ }

export const selABox = document.createElement("div");
export const selBBox = document.createElement("div");
selABox.style.cssText =
  "border:1px solid #3a3a4a;border-radius:6px;padding:6px;max-height:180px;overflow:auto;background:#1a1a24;font-size:11px";
selBBox.style.cssText = selABox.style.cssText;

export const clashSummaryEl = document.createElement("div");
clashSummaryEl.style.cssText =
  "margin:8px 0;padding:8px;background:#1e293b;border-radius:6px;font-size:11px;line-height:1.6";

function updateSummary() {
  if (!clashGroups.length && clashResults.length) {
    clashGroups = groupClashes(clashResults, { preferLargerHead: false });
  }
  const s = summarizeGroups(clashGroups);
  clashSummaryEl.innerHTML =
    `<b>${s.groupCount}</b> group${s.groupCount === 1 ? "" : "s"} · ` +
    `<b>${s.clashCount}</b> clash${s.clashCount === 1 ? "" : "es"}<br>` +
    `<span style="color:#ef4444">Intersect ${s.intersectCount}</span>` +
    ` · <span style="color:#f59e0b">Touching ${s.touchingCount}</span>` +
    ` · <span style="color:#38bdf8">Clearance ${s.clearanceCount}</span>` +
    ` · <span style="color:#a855f7">Duplicate ${s.duplicateCount}</span>` +
    (s.largestGroup ? `<br><span style="opacity:.7">Largest group: ${s.largestGroup.size} members</span>` : "");
}


export const testNameInput = document.createElement("input");
testNameInput.type = "text";
testNameInput.value = "Test 1";
testNameInput.style.cssText =
  "width:100%;box-sizing:border-box;padding:6px 8px;margin:4px 0 8px;background:#1a1a24;border:1px solid #3a3a4a;border-radius:4px;color:#e2e8f0;font-size:12px";

/* ── Method selector ─────────────────────────────────────────────── */
export const clashMethodSelect = document.createElement("select");
clashMethodSelect.style.cssText =
  "width:100%;box-sizing:border-box;padding:5px 8px;margin:4px 0 6px;" +
  "background:#1a1a24;border:1px solid #3a3a4a;border-radius:4px;color:#e2e8f0;" +
  "font-size:12px";
clashMethodSelect.innerHTML = CLASH_METHODS
  .map((m) => `<option value="${m.id}">${m.label}</option>`)
  .join("");
clashMethodSelect.value = currentMethod;
clashMethodSelect.onchange = () => {
  currentMethod = clashMethodSelect.value as ClashMethod;
  try { localStorage.setItem(METHOD_KEY, currentMethod); } catch { /* */ }
  updateMethodDescription();
};

export const clashMethodDesc = document.createElement("div");
clashMethodDesc.style.cssText =
  "font-size:10.5px;line-height:1.5;color:#94a3b8;padding:6px 8px;margin:0 0 8px;" +
  "background:#0e1017;border:1px solid #1e2029;border-radius:4px";

function updateMethodDescription() {
  const info = CLASH_METHODS.find((m) => m.id === currentMethod);
  if (!info) { clashMethodDesc.textContent = ""; return; }
  const flags: string[] = [];
  flags.push(info.usesTolerance ? "uses Tolerance" : "ignores Tolerance");
  flags.push(info.usesClearance ? "uses Clearance" : "ignores Clearance");
  clashMethodDesc.innerHTML =
    `${info.description}<br/><span style="opacity:.55;font-size:10px">${flags.join(" · ")}</span>`;
}
updateMethodDescription();

/* ── Scope selector ──────────────────────────────────────────────── */
export const clashScopeSelect = document.createElement("select");
clashScopeSelect.style.cssText =
  "width:100%;box-sizing:border-box;padding:5px 8px;margin:4px 0 8px;" +
  "background:#1a1a24;border:1px solid #3a3a4a;border-radius:4px;color:#e2e8f0;" +
  "font-size:12px";
clashScopeSelect.innerHTML =
  `<option value="all">All model elements</option>` +
  `<option value="viewport">Viewport selection only</option>` +
  `<option value="aOnly">Selection A only</option>` +
  `<option value="bOnly">Selection B only</option>` +
  `<option value="both">Selection A × B only (recommended)</option>`;
clashScopeSelect.value = "both";

export const cropInfoEl = document.createElement("div");
cropInfoEl.style.cssText = "margin-top:8px;font-size:11px;opacity:0.85";
cropInfoEl.textContent = "No clash selected.";

export const cropMarginLabel = document.createElement("div");
cropMarginLabel.style.cssText = "font-size:12px;margin:6px 0";
cropMarginLabel.innerHTML = `Margin: <b style="color:#22d3ee">30 cm</b>`;

export const exportCsvBtn = document.createElement("button");
exportCsvBtn.textContent = "⬇ CSV";
exportCsvBtn.style.cssText =
  "margin-top:6px;padding:5px 10px;background:#24252f;color:#cbd5e1;border:1px solid #34353f;border-radius:5px;cursor:pointer;font-size:11px";
exportCsvBtn.onclick = () => exportClashCsv();

// ═══════════════════════════════════════════════════════════════════════════
// Category cache
// ═══════════════════════════════════════════════════════════════════════════
const categoryCache = new Map<string, Record<string, number[]>>();

async function loadCategoriesForModel(modelId: string): Promise<Record<string, number[]>> {
  if (categoryCache.has(modelId)) return categoryCache.get(modelId)!;
  const model = ctx.fragments.list.get(modelId);
  const result: Record<string, number[]> = {};
  if (!model) { categoryCache.set(modelId, result); return result; }
  try {
    const cats = await model.getItemsOfCategories([/.+/]);
    for (const [cat, ids] of Object.entries(cats)) {
      const arr = (ids as number[]) || [];
      if (arr.length) result[cat] = arr;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Fragments\s*:?\s*Model not found/i.test(msg)) {
      console.warn(`[clash] pruning stale model "${modelId}" — worker no longer has it`);
      try { (ctx.fragments.list as any).delete?.(modelId); } catch { /* */ }
      categoryCache.set(modelId, result);
      return result;
    }
    console.warn("[clash] categories failed", modelId, err);
  }
  categoryCache.set(modelId, result);
  return result;
}

async function ensureCategoriesCached(modelId: string): Promise<void> {
  if (!categoryCache.has(modelId)) await loadCategoriesForModel(modelId);
}

function catKey(modelId: string, cat: string): string {
  return `${modelId}::${cat}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Refresh generation guard
// ═══════════════════════════════════════════════════════════════════════════
let refreshGeneration = 0;

// ═══════════════════════════════════════════════════════════════════════════
// Selection tree
// ═══════════════════════════════════════════════════════════════════════════
function buildSelectionTree(
  box: HTMLElement,
  set: Set<string>,
  modelId: string,
  cats: Record<string, number[]>,
) {
  const modelWrap = document.createElement("div");
  modelWrap.style.cssText = "margin-bottom:6px";
  const modelRow = document.createElement("div");
  modelRow.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer";

  const toggle = document.createElement("span");
  toggle.textContent = "▸";
  toggle.style.cssText = "width:12px;opacity:0.7;font-size:10px";

  const modelCb = document.createElement("input");
  modelCb.type = "checkbox";
  modelCb.checked = set.has(modelId);
  modelCb.onchange = () => {
    if (modelCb.checked) {
      set.add(modelId);
      for (const cat of Object.keys(cats)) set.add(catKey(modelId, cat));
      catBox.querySelectorAll("input[type=checkbox]")
        .forEach((c) => ((c as HTMLInputElement).checked = true));
    } else {
      set.delete(modelId);
      for (const cat of Object.keys(cats)) set.delete(catKey(modelId, cat));
      catBox.querySelectorAll("input[type=checkbox]")
        .forEach((c) => ((c as HTMLInputElement).checked = false));
    }
    persistSelections();
  };

  const modelLabel = document.createElement("span");
  modelLabel.textContent = modelId;
  modelLabel.style.cssText =
    "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  modelLabel.title = modelId;
  modelRow.append(toggle, modelCb, modelLabel);
  modelWrap.appendChild(modelRow);

  const catBox = document.createElement("div");
  catBox.style.cssText = "display:none;margin-left:18px;margin-top:2px";

  const catNames = Object.keys(cats).sort((a, b) => a.localeCompare(b));
  for (const cat of catNames) {
    const row = document.createElement("label");
    row.style.cssText =
      "display:flex;align-items:center;gap:6px;margin:2px 0;cursor:pointer;opacity:0.95";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const key = catKey(modelId, cat);
    cb.checked = set.has(key) || set.has(modelId);
    cb.onchange = () => {
      if (cb.checked) set.add(key);
      else {
        set.delete(key);
        set.delete(modelId);
        modelCb.checked = false;
      }
      const allOn = catNames.every((c) => set.has(catKey(modelId, c)));
      if (allOn) { set.add(modelId); modelCb.checked = true; }
      persistSelections();
    };
    const span = document.createElement("span");
    const nice = cat.replace(/^IFC/i, "");
    span.textContent = `${nice} (${cats[cat].length})`;
    span.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    row.append(cb, span);
    catBox.appendChild(row);
  }

  let open = false;
  const openTree = () => {
    open = !open;
    catBox.style.display = open ? "block" : "none";
    toggle.textContent = open ? "▾" : "▸";
  };
  toggle.onclick = (e) => { e.preventDefault(); openTree(); };
  modelLabel.onclick = () => openTree();
  modelWrap.appendChild(catBox);
  box.appendChild(modelWrap);
}

export async function refreshModelSelectionUI() {
  const myGen = ++refreshGeneration;

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of ctx.fragments.list.keys()) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  if (!ids.length) {
    selABox.innerHTML = "<div style='opacity:.5'>Load models first</div>";
    selBBox.innerHTML = "<div style='opacity:.5'>Load models first</div>";
    return;
  }

  if (myGen === refreshGeneration) {
    selABox.innerHTML = "<div style='opacity:.5'>Loading categories…</div>";
    selBBox.innerHTML = "<div style='opacity:.5'>Loading categories…</div>";
  }

  const aHolder = document.createElement("div");
  const bHolder = document.createElement("div");

  for (const id of ids) {
    const cats = await loadCategoriesForModel(id);
    if (myGen !== refreshGeneration) return;
    buildSelectionTree(aHolder, selectionA, id, cats);
    buildSelectionTree(bHolder, selectionB, id, cats);
  }

  if (myGen !== refreshGeneration) return;
  selABox.replaceChildren(...Array.from(aHolder.childNodes));
  selBBox.replaceChildren(...Array.from(bHolder.childNodes));
}

function resolveSelection(set: Set<string>): Map<string, Set<number> | "ALL"> {
  const map = new Map<string, Set<number> | "ALL">();
  for (const key of set) {
    if (key.includes("::")) {
      const [modelId, cat] = key.split("::");
      const cats = categoryCache.get(modelId) || {};
      const ids = cats[cat] || [];
      if (!map.has(modelId) || map.get(modelId) === "ALL") {
        if (map.get(modelId) !== "ALL") map.set(modelId, new Set(ids));
      } else {
        const s = map.get(modelId) as Set<number>;
        for (const id of ids) s.add(id);
      }
    } else {
      map.set(key, "ALL");
    }
  }
  return map;
}

function shortCat(cat: string) {
  return cat.replace(/^IFC/i, "").replace(/STANDARDCASE$/i, "") || cat;
}

// ═══════════════════════════════════════════════════════════════════════════
// Crop box
// ═══════════════════════════════════════════════════════════════════════════
function clearCropBox() {
  if (cropWire) {
    ctx.world.scene.three.remove(cropWire);
    cropWire.geometry?.dispose();
    (cropWire.material as THREE.Material)?.dispose?.();
    cropWire = null;
  }
}
export function removeCropBox() {
  clearCropBox();
  activeClash = null;
  cropInfoEl.textContent = "No clash selected.";
}

async function refreshElementWorldBox(
  modelId: string, localId: number,
): Promise<THREE.Box3 | null> {
  try {
    const model: any = ctx.fragments.list.get(modelId);
    if (!model) return null;
    return await getElementWorldBox(model, localId, modelId);
  } catch { return null; }
}

async function applyCropBox(c: ElementClash, margin: number) {
  clearCropBox();
  try { ctx.clipper.deleteAll(); } catch { /* */ }

  let boxA = c.boxA.clone();
  let boxB = c.boxB.clone();
  try {
    const ra = await refreshElementWorldBox(c.a.modelId, c.a.localId);
    const rb = await refreshElementWorldBox(c.b.modelId, c.b.localId);
    if (ra && !ra.isEmpty()) boxA = ra;
    if (rb && !rb.isEmpty()) boxB = rb;
    c.boxA.copy(boxA);
    c.boxB.copy(boxB);
  } catch { /* */ }

  const inter = boxA.clone().intersect(boxB);
  const interSize = new THREE.Vector3();
  inter.getSize(interSize);
  let focus = inter;
  if (inter.isEmpty() || Math.abs(interSize.x * interSize.y * interSize.z) < 1e-8) {
    const sa = new THREE.Vector3();
    const sb = new THREE.Vector3();
    boxA.getSize(sa);
    boxB.getSize(sb);
    focus =
      Math.abs(sa.x * sa.y * sa.z) <= Math.abs(sb.x * sb.y * sb.z)
        ? boxA.clone() : boxB.clone();
  }
  focus.expandByScalar(Math.max(margin, 0.05));
  cropWire = new THREE.Box3Helper(focus, new THREE.Color(0x22d3ee));
  ctx.world.scene.three.add(cropWire);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  focus.getCenter(center);
  focus.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z, 0.4);
  try {
    ctx.world.camera.controls.setLookAt(
      center.x + maxDim * 2, center.y + maxDim, center.z + maxDim * 2,
      center.x, center.y, center.z, true,
    );
  } catch { /* */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Select pair
// ═══════════════════════════════════════════════════════════════════════════
async function selectClashPair(c: ElementClash) {
  activeClash = c;
  for (const name of ["clash", "clashA", "clashB"]) {
    try { await ctx.highlighter.clear(name); } catch { /* */ }
  }
  try {
    await ctx.highlighter.highlightByID(
      "clashA", { [c.a.modelId]: new Set([c.a.localId]) } as OBC.ModelIdMap, true,
    );
  } catch (e) { console.warn("[clash] highlight A", e); }
  try {
    await ctx.highlighter.highlightByID(
      "clashB", { [c.b.modelId]: new Set([c.b.localId]) } as OBC.ModelIdMap, true,
    );
  } catch (e) { console.warn("[clash] highlight B", e); }
  try {
    ctx.props.update({
      [c.a.modelId]: new Set([c.a.localId]),
      [c.b.modelId]: new Set([c.b.localId]),
    } as OBC.ModelIdMap);
  } catch { /* */ }

  await applyCropBox(c, cropMargin);
  cropMarginLabel.innerHTML = `Margin: <b style="color:#22d3ee">${(cropMargin * 100).toFixed(0)} cm</b>`;

  const kindColor: Record<ClashKind, string> = {
    intersect: "#ef4444",
    touching: "#f59e0b",
    clearance: "#38bdf8",
    duplicate: "#a855f7",
  };
  const gapTxt =
    c.kind === "intersect"
      ? `Overlap ${(c.depthVol * 1e6).toFixed(1)} cm³`
      : c.kind === "duplicate"
        ? `Identical (Δ ≤ ${(c.minGap * 1000).toFixed(1)} mm)`
        : `Gap ${(c.minGap * 1000).toFixed(1)} mm`;
  const triTxt =
    c.precision === "triangles"
      ? `${c.triPairs} tri pair(s)`
      : `precision: ${c.precision}`;
  cropInfoEl.innerHTML =
    `<b>${c.a.name}</b> ↔ <b>${c.b.name}</b><br/>` +
    `<span style="color:${kindColor[c.kind]}">${c.kind.toUpperCase()} · ${gapTxt}</span><br/>` +
    `<span style="opacity:.6;font-size:10px">method ${c.method} · ${triTxt}</span>`;
}

export async function isolateClashPair(c: ElementClash) {
  try {
    const hider: any = ctx.hider;
    const keep = {
      [c.a.modelId]: new Set([c.a.localId]),
      [c.b.modelId]: new Set([c.b.localId]),
    };
    if (typeof hider.isolate === "function") await hider.isolate(keep);
    else if (typeof hider.set === "function") {
      await hider.set(false);
      await hider.set(true, keep);
    }
  } catch (e) { console.warn("[clash] isolate pair failed", e); }
}

const KIND_COLOR: Record<ClashKind, string> = {
  intersect: "#ef4444",
  touching: "#f59e0b",
  clearance: "#38bdf8",
  duplicate: "#a855f7",
};

// ═══════════════════════════════════════════════════════════════════════════
// Results list
// ═══════════════════════════════════════════════════════════════════════════
function renderClashList() {
  clashListEl.innerHTML = "";
  if (!clashGroups.length) {
    if (clashResults.length) {
      clashGroups = groupClashes(clashResults, { preferLargerHead: false });
      activeGroupId = activeGroupId ?? clashGroups[0]?.id ?? null;
    } else {
      return;
    }
  }

  for (const group of clashGroups) {
    const active = group.id === activeGroupId;

    const header = document.createElement("div");
    header.style.cssText =
      "display:flex;align-items:center;gap:6px;padding:6px 8px;margin:6px 0 3px;" +
      "border-radius:5px;cursor:pointer;font-weight:600;font-size:11.5px;" +
      (active
        ? "background:rgba(56,189,248,.14);border:1px solid #38bdf8"
        : "background:#1b1c26;border:1px solid #2a2a35");

    const worstKind =
      group.kinds.intersect > 0 ? "intersect"
      : group.kinds.touching > 0 ? "touching"
      : group.kinds.clearance > 0 ? "clearance"
      : "duplicate";
    const badge = document.createElement("span");
    badge.textContent = worstKind.toUpperCase();
    badge.style.cssText =
      `background:${KIND_COLOR[worstKind as ClashKind]};color:#0f1117;` +
      `padding:1px 6px;border-radius:3px;font-size:9px;font-weight:800`;
    header.appendChild(badge);

    const text = document.createElement("div");
    text.style.cssText = "flex:1;min-width:0";
    text.innerHTML =
      `<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">` +
      `${escapeHtml(group.head.name)}</div>` +
      `<div style="font-size:9.5px;opacity:.65">` +
      `${group.members.length} clash${group.members.length === 1 ? "" : "es"} · ` +
      `[${escapeHtml(shortCat(group.head.cat))}]` +
      `</div>`;
    header.appendChild(text);

    const isolateBtn = document.createElement("button");
    isolateBtn.textContent = "Isolate";
    isolateBtn.style.cssText =
      "padding:2px 8px;background:#24252f;color:#cbd5e1;border:1px solid #34353f;" +
      "border-radius:4px;cursor:pointer;font-size:10px";
    isolateBtn.onclick = (e) => { e.stopPropagation(); void isolateGroup(group.id); };
    header.appendChild(isolateBtn);

    header.onclick = () => focusGroup(group.id);
    clashListEl.appendChild(header);

    if (active) {
      for (const c of group.members) {
        clashListEl.appendChild(renderMemberRow(c, group));
      }
    }
  }
}

function renderMemberRow(c: ElementClash, group: ClashGroup): HTMLElement {
  const state = getClashState(c);
  const row = document.createElement("div");
  row.style.cssText =
    "margin:3px 0 3px 20px;padding:8px;background:#252530;border-radius:5px;" +
    `border-left:3px solid ${KIND_COLOR[c.kind]};font-size:11px`;

  const top = document.createElement("div");
  top.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap";
  const kindBadge = document.createElement("span");
  kindBadge.style.cssText =
    `background:${KIND_COLOR[c.kind]};color:#0f1117;` +
    `padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700`;
  kindBadge.textContent = c.kind.toUpperCase();

  const statusSel = document.createElement("select");
  statusSel.style.cssText =
    "padding:2px 4px;background:#12131a;border:1px solid #34353f;border-radius:3px;" +
    "color:#e8eaf0;font-size:10px;font-weight:600";
  statusSel.innerHTML = STATUS_ORDER.map(
    (s) => `<option value="${s}" ${state.status === s ? "selected" : ""}>${STATUS_LABEL[s]}</option>`,
  ).join("");
  statusSel.onclick = (e) => e.stopPropagation();
  statusSel.onchange = (e) => {
    e.stopPropagation();
    setClashStatus(c, statusSel.value as ClashStatus);
  };

  const isolateOneBtn = document.createElement("button");
  isolateOneBtn.textContent = "Isolate";
  isolateOneBtn.style.cssText =
    "margin-left:auto;padding:2px 8px;background:#24252f;color:#cbd5e1;" +
    "border:1px solid #34353f;border-radius:4px;cursor:pointer;font-size:10px";
  isolateOneBtn.onclick = (e) => { e.stopPropagation(); void isolateClashPair(c); };

  top.append(kindBadge, statusSel, isolateOneBtn);

  const mid = document.createElement("div");
  mid.style.cssText = "margin-top:4px;cursor:pointer";
  const gap =
    c.kind === "intersect"
      ? `${(c.depthVol * 1e6).toFixed(1)} cm³ overlap`
      : c.kind === "duplicate"
        ? `identical · ${c.precision}`
        : `${(c.minGap * 1000).toFixed(0)} mm gap`;
  const other = elementKeyRef(c.a) === elementKeyRef(group.head) ? c.b : c.a;
  mid.innerHTML =
    `<b>${escapeHtml(other.name)}</b> [${escapeHtml(shortCat(other.cat))}]<br/>` +
    `<span style="opacity:.7;font-size:10px">${gap} · ${c.precision} · ${c.method}</span>`;
  mid.onclick = () => void selectClashPair(c);

  row.append(top, mid);
  return row;
}


// ═══════════════════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════════════════
export async function runElementClashDetection() {
  if (cancelToken) { clashToast("A test is already running.", "warn"); return; }
  if (ctx.features.appLoader?.isActive?.()) {
    clashToast("Another operation is running — please wait.", "warn");
    return;
  }

  const scope = (clashScopeSelect.value || "both") as ClashScope;
  const method = currentMethod;

  const viewportSel: Record<string, Set<number>> =
    scope === "viewport"
      ? (() => {
          try {
            const sel: any = (ctx.features as any).selection;
            const snap = sel?.snapshot?.();
            if (!snap) return {};
            const out: Record<string, Set<number>> = {};
            for (const [m, s] of Object.entries(snap)) {
              if (s instanceof Set && s.size) out[m] = new Set(s as Set<number>);
            }
            return out;
          } catch { return {}; }
        })()
      : {};

  if (scope === "viewport" && !Object.keys(viewportSel).length) {
    clashStatusEl.textContent = "Viewport selection is empty.";
    clashToast("Pick elements in the viewport first, or switch scope.", "warn", 3000);
    return;
  }

  const loader = (ctx.features as any).appLoader;
  loader?.begin?.(`Clash test · ${testNameInput.value}`, {
    cancellable: true,
    onCancel: () => cancelClash(),
  });

  try {
    try {
      for (const [, model] of ctx.fragments.list) model.object.updateMatrixWorld(true);
    } catch { /* */ }

    clashResults = [];
    activeClash = null;
    clearCropBox();
    clashListEl.innerHTML = "";
    try { await ctx.highlighter.clear("clash"); } catch { /* */ }
    clashCancelBtn.style.display = "inline-block";
    clashProgressEl.style.display = "block";
    clashProgressInner.style.width = "0%";

    const cancelHandle = { cancelled: false };
    cancelToken = cancelHandle;

    const allModels = Array.from(ctx.fragments.list.entries());
    if (!allModels.length) { clashToast("Load a model first.", "warn"); return; }

    const resolvedA = resolveSelection(selectionA);
    const resolvedB = resolveSelection(selectionB);
    const inputs: {
      modelId: string; model: any; allowedIds: Set<number> | "ALL" | null;
    }[] = [];

    for (const [modelId, model] of allModels) {
      let allowed: Set<number> | "ALL" | null = null;

      if (scope === "viewport") {
        const ids = viewportSel[modelId];
        if (!ids || !ids.size) continue;
        allowed = ids;
      } else if (scope === "aOnly") {
        const inA = selectionA.has(modelId) ||
          [...selectionA].some((k) => k.startsWith(modelId + "::"));
        if (!inA) continue;
        allowed = resolvedA.get(modelId) ?? null;
      } else if (scope === "bOnly") {
        const inB = selectionB.has(modelId) ||
          [...selectionB].some((k) => k.startsWith(modelId + "::"));
        if (!inB) continue;
        allowed = resolvedB.get(modelId) ?? null;
      } else if (scope === "both") {
        const inA = selectionA.has(modelId) ||
          [...selectionA].some((k) => k.startsWith(modelId + "::"));
        const inB = selectionB.has(modelId) ||
          [...selectionB].some((k) => k.startsWith(modelId + "::"));
        if (!inA && !inB) continue;
        if (inA && !inB) allowed = resolvedA.get(modelId) ?? null;
        else if (!inA && inB) allowed = resolvedB.get(modelId) ?? null;
        else {
          const a = resolvedA.get(modelId);
          const b = resolvedB.get(modelId);
          if (a === "ALL" || b === "ALL") allowed = "ALL";
          else {
            const u = new Set<number>();
            if (a instanceof Set) for (const x of a) u.add(x);
            if (b instanceof Set) for (const x of b) u.add(x);
            allowed = u.size ? u : null;
          }
        }
      }
      inputs.push({ modelId, model, allowedIds: allowed });
    }

    if (inputs.length < 1) {
      const aEmpty = selectionA.size === 0;
      const bEmpty = selectionB.size === 0;
      if (scope === "both" && aEmpty && bEmpty) {
        clashStatusEl.textContent = "Selection A and B are empty — tick models in the tree above.";
      } else if (scope === "both" && aEmpty) {
        clashStatusEl.textContent = "Selection A is empty — tick at least one model in Selection A.";
      } else if (scope === "both" && bEmpty) {
        clashStatusEl.textContent = "Selection B is empty — tick at least one model in Selection B.";
      } else {
        clashStatusEl.textContent = "No models match the chosen scope.";
      }
      clashToast("Nothing to test with the current scope.", "warn");
      return;
    }

    clashStatusEl.textContent = `Running ${testNameInput.value} · ${method}…`;
    loader?.set?.(`Reading models · ${inputs.length} model(s)`, 0.05);

    const results = await runClashOffThread(inputs, {
      rules,
      method,
      signal: cancelHandle,
      allowSelfPairs: scope !== "both",
      onProgress: (p) => {
        const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
        clashProgressInner.style.width = `${pct}%`;
        const msg = `${testNameInput.value} · ${p.phase} ${p.current}/${p.total} · ${p.found} found`;
        clashStatusEl.textContent = msg;
        loader?.set?.(msg, p.total > 0 ? 0.1 + 0.85 * (p.current / p.total) : 0.5);
      },
    });

    if (cancelHandle.cancelled) {
      clashStatusEl.textContent = "Cancelled.";
      clashToast("Test cancelled.", "warn");
      return;
    }
    clashResults = results;
    clashGroups = groupClashes(clashResults, { preferLargerHead: false });
    activeGroupId = clashGroups[0]?.id ?? null;
  } catch (err) {
    console.error("[clash] engine failed", err);
    clashStatusEl.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    clashToast(`Clash test failed: ${err instanceof Error ? err.message : err}`, "warn", 4000);
    return;
  } finally {
    cancelToken = null;
    clashCancelBtn.style.display = "none";
    clashProgressEl.style.display = "none";
    loader?.finish?.();
  }

  if (clashResults.length) {
    clashStatusEl.textContent = `${testNameInput.value} · ${method}: ${clashResults.length} clash(es). Click a row to focus.`;
    clashToast(`${clashResults.length} clash(es) found (${method}).`, "success");
  } else {
    clashStatusEl.textContent = `${testNameInput.value} · ${method}: No clashes found.`;
    clashToast("No clashes found.", "info");
  }
  updateSummary();
  renderClashList();
}

export async function clearClash() {
  const had = clashResults.length;
  clashResults = [];
  clashGroups = [];
  activeGroupId = null;
  activeClash = null;
  clashStatusEl.textContent = "Cleared.";
  clashListEl.innerHTML = "";
  updateSummary();
  cropInfoEl.textContent = "No clash selected.";
  clearCropBox();
  for (const name of ["clash", "clashA", "clashB"]) {
    try { await ctx.highlighter.clear(name); } catch { /* */ }
  }
  fitAll();
  clashToast(had ? `Cleared ${had} result(s).` : "Nothing to clear.", "info", 1500);
}

export function changeCropMargin(delta: number) {
  cropMargin = Math.max(0.01, cropMargin + delta);
  cropMarginLabel.innerHTML = `Margin: <b style="color:#22d3ee">${(cropMargin * 100).toFixed(0)} cm</b>`;
  if (activeClash) void applyCropBox(activeClash, cropMargin);
}

export function resetCropMargin() {
  cropMargin = 0.3;
  changeCropMargin(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// CSV export
// ═══════════════════════════════════════════════════════════════════════════
export function exportClashCsv() {
  if (!clashResults.length) {
    clashToast("No clash results to export.", "warn");
    return;
  }
  const q = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    "GroupId,GroupHead,TestName,Method,Kind,Status,ModelA,ElementA_Id,ElementA_Name,ElementA_Category,ModelB,ElementB_Id,ElementB_Name,ElementB_Category,OverlapVolume_cm3,MinGap_mm,Precision,TrianglePairs,Comments",
  ];
  if (!clashGroups.length && clashResults.length) {
    clashGroups = groupClashes(clashResults, { preferLargerHead: false });
  }
  const groupOf = new Map<string, ClashGroup>();
  for (const g of clashGroups) {
    for (const c of g.members) groupOf.set(clashKey(c), g);
  }
  for (const c of clashResults) {
    const s = getClashState(c);
    const g = groupOf.get(clashKey(c));
    const commentText = s.comments
      .map((cm) => `[${cm.author} @ ${new Date(cm.date).toISOString()}] ${cm.text}`)
      .join(" | ");
    lines.push(
      [
        q(g?.id ?? ""),
        q(g?.head.name ?? ""),
        q(testNameInput.value),
        c.method,
        c.kind,
        s.status,
        q(c.a.modelId),
        c.a.localId,
        q(c.a.name),
        q(shortCat(c.a.cat)),
        q(c.b.modelId),
        c.b.localId,
        q(c.b.name),
        q(shortCat(c.b.cat)),
        (c.depthVol * 1e6).toFixed(2),
        (c.minGap * 1000).toFixed(2),
        c.precision,
        c.triPairs,
        q(commentText),
      ].join(","),
    );
  }
  const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `clash-report-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  clashToast("CSV exported.", "success", 1500);
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenarios
// ═══════════════════════════════════════════════════════════════════════════
const SCENARIO_KEY = "obs-clash-scenarios-v1";

export type ClashScenario = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  testName: string;
  tolerance: number;
  clearance: number;
  cropMargin: number;
  scope?: ClashScope;
  method?: ClashMethod;
  selectionA: string[];
  selectionB: string[];
  clashStates?: Record<string, ClashState>;
  lastRun?: { total: number; intersect: number; touching: number; clearance: number; duplicate: number; at: number };
};

function scenarioUid() {
  return (
    (crypto as any).randomUUID?.() ??
    `sc-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

export function listScenarios(): ClashScenario[] {
  try {
    const raw = localStorage.getItem(SCENARIO_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function notifyScenariosChanged() {
  try { window.dispatchEvent(new CustomEvent("obs-clash-scenarios-changed")); } catch { /* */ }
}

function persistScenarios(list: ClashScenario[]) {
  try { localStorage.setItem(SCENARIO_KEY, JSON.stringify(list)); }
  catch (e) { console.warn("[clash] scenario save failed", e); clashToast("Could not save scenarios.", "warn"); }
}

export function createScenario(name?: string): ClashScenario {
  const states: Record<string, ClashState> = {};
  for (const [k, v] of clashStates) states[k] = v;
  const sc: ClashScenario = {
    id: scenarioUid(),
    name: (name || testNameInput.value || "Scenario").trim() || "Scenario",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    testName: testNameInput.value || "Test 1",
    tolerance: rules.tolerance,
    clearance: rules.clearance,
    cropMargin,
    scope: (clashScopeSelect.value || "both") as ClashScope,
    method: currentMethod,
    selectionA: [...selectionA],
    selectionB: [...selectionB],
    clashStates: states,
  };
  const list = listScenarios();
  list.unshift(sc);
  persistScenarios(list);
  try { notifyScenariosChanged(); } catch { /* */ }
  renderScenarioList();
  clashStatusEl.textContent = `Scenario saved: ${sc.name}`;
  clashToast(`Scenario saved: ${sc.name}`, "success");
  return sc;
}

export function deleteScenario(id: string) {
  // scenarios list will notify after persist
  persistScenarios(listScenarios().filter((s) => s.id !== id));
  renderScenarioList();
  clashToast("Scenario deleted.", "info", 1500);
}

export async function loadScenario(id: string) {
  const sc = listScenarios().find((s) => s.id === id);
  if (!sc) { clashToast("Scenario not found.", "warn"); return; }

  testNameInput.value = sc.testName || sc.name;
  rules.tolerance = sc.tolerance ?? 0.005;
  rules.clearance = sc.clearance ?? 0;
  cropMargin = sc.cropMargin ?? 0.3;
  if (sc.scope) clashScopeSelect.value = sc.scope;
  if (sc.method) setMethod(sc.method);
  cropMarginLabel.innerHTML = `Margin: <b style="color:#22d3ee">${(cropMargin * 100).toFixed(0)} cm</b>`;

  selectionA.clear();
  selectionB.clear();
  for (const k of sc.selectionA || []) selectionA.add(k);
  for (const k of sc.selectionB || []) selectionB.add(k);
  persistSelections();

  await refreshModelSelectionUI();

  clashStates.clear();
  if (sc.clashStates) for (const [k, v] of Object.entries(sc.clashStates)) clashStates.set(k, v);

  clashStatusEl.textContent = `Loaded scenario: ${sc.name} — press Run Test`;
  clashToast(`Loaded scenario: ${sc.name}`, "success");
  renderScenarioList();
  renderClashList();
}

export function exportScenariosJson() {
  const blob = new Blob([JSON.stringify(listScenarios(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `clash-scenarios-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  clashToast("Scenarios exported.", "success", 1500);
}

export async function importScenariosJson(file: File) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const incoming: ClashScenario[] = Array.isArray(data) ? data : data?.scenarios || [];
    if (!incoming.length) { clashToast("No scenarios in file.", "warn"); return; }
    const list = listScenarios();
    const byId = new Map(list.map((s) => [s.id, s]));
    for (const s of incoming) {
      if (!s?.id) (s as any).id = scenarioUid();
      if ((s as any).clearance == null) (s as any).clearance = 0;
      byId.set(s.id, { ...s, updatedAt: Date.now() });
    }
    persistScenarios([...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt));
    renderScenarioList();
    clashStatusEl.textContent = `Imported ${incoming.length} scenario(s)`;
    clashToast(`Imported ${incoming.length} scenario(s)`, "success");
  } catch (e: any) {
    clashToast(`Import failed: ${e?.message || e}`, "warn", 3500);
  }
}

export const scenarioPanel = document.createElement("div");
scenarioPanel.style.cssText = "margin-top:10px;border-top:1px solid #2a2a35;padding-top:8px";

const scenarioToolbar = document.createElement("div");
scenarioToolbar.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px";

function scBtn(label: string, onClick: () => void, title = "") {
  const b = document.createElement("button");
  b.textContent = label;
  b.title = title || label;
  b.style.cssText =
    "padding:5px 8px;font:500 11px system-ui,sans-serif;background:#1e1f28;color:#e2e8f0;border:1px solid #3a3a4a;border-radius:5px;cursor:pointer";
  b.onclick = onClick;
  return b;
}

scenarioToolbar.append(
  scBtn("💾 Save scenario", () => {
    const name = prompt("Scenario name:", testNameInput.value || "Scenario");
    if (name == null) return;
    createScenario(name.trim() || "Scenario");
  }, "Save current A/B + scope + method + rules + statuses"),
  scBtn("📥 Export JSON", () => exportScenariosJson()),
  scBtn("📤 Import…", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => { if (input.files?.[0]) void importScenariosJson(input.files[0]); };
    input.click();
  }),
);

export const scenarioListEl = document.createElement("div");
scenarioListEl.style.cssText = "max-height:140px;overflow:auto;font-size:11px";

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
}

function renderScenarioList() {
  scenarioListEl.innerHTML = "";
  const list = listScenarios();
  if (!list.length) {
    scenarioListEl.innerHTML = `<div style="opacity:.55">No saved scenarios yet.</div>`;
    return;
  }
  for (const sc of list) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:6px;padding:5px 4px;border-bottom:1px solid #24252f";
    const meta = document.createElement("div");
    meta.style.cssText = "flex:1;min-width:0;cursor:pointer";
    const runInfo = sc.lastRun ? ` · last ${sc.lastRun.total}` : "";
    meta.innerHTML = `<b style="color:#e2e8f0">${escapeHtml(sc.name)}</b><br/>
      <span style="opacity:.55">${new Date(sc.updatedAt).toLocaleString()} · A:${
      sc.selectionA?.length || 0
    } B:${sc.selectionB?.length || 0}${sc.method ? ` · ${sc.method}` : ""}${runInfo}</span>`;
    meta.onclick = () => void loadScenario(sc.id);
    meta.title = "Load scenario";
    const run = scBtn("▶", () => {
      void (async () => {
        await loadScenario(sc.id);
        await runElementClashDetection();
        const list2 = listScenarios();
        const i = list2.findIndex((x) => x.id === sc.id);
        if (i >= 0) {
          const intersect = clashResults.filter((c) => c.kind === "intersect").length;
          const touching = clashResults.filter((c) => c.kind === "touching").length;
          const clearance = clashResults.filter((c) => c.kind === "clearance").length;
          const duplicate = clashResults.filter((c) => c.kind === "duplicate").length;
          list2[i].lastRun = {
            total: clashResults.length, intersect, touching, clearance, duplicate,
            at: Date.now(),
          };
          persistScenarios(list2);
  try { notifyScenariosChanged(); } catch { /* */ }
          renderScenarioList();
        }
      })();
    }, "Load and run");
    const del = scBtn("🗑", () => {
      if (confirm(`Delete scenario "${sc.name}"?`)) deleteScenario(sc.id);
    });
    row.append(meta, run, del);
    scenarioListEl.appendChild(row);
  }
}

scenarioPanel.append(scenarioToolbar, scenarioListEl);

// ═══════════════════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════════════════

/* ── Project persistence ────────────────────────────────────────────── */

interface SerializedClashState {
  key: string;
  status: ClashStatus;
  comments: ClashComment[];
  assignee?: string;
  updatedAt: number;
}

export function serializeClashStates(): SerializedClashState[] {
  const out: SerializedClashState[] = [];
  for (const [key, s] of clashStates) {
    out.push({
      key,
      status: s.status,
      comments: s.comments.map((c) => ({ ...c })),
      assignee: s.assignee,
      updatedAt: s.updatedAt,
    });
  }
  return out;
}

export function deserializeClashStates(list: SerializedClashState[] | null | undefined): void {
  clashStates.clear();
  if (!Array.isArray(list)) return;
  for (const s of list) {
    clashStates.set(s.key, {
      status: s.status ?? "new",
      comments: Array.isArray(s.comments) ? s.comments : [],
      assignee: s.assignee,
      updatedAt: s.updatedAt ?? Date.now(),
    });
  }
  try { renderClashList(); } catch { /* */ }
  try { updateSummary(); } catch { /* */ }
}

/** Stable key for a clash pair — public form of clashKey(). */
export function clashPairKey(c: ElementClash): string {
  return clashKey(c);
}


export function listGroups(): ClashGroup[] { return clashGroups.slice(); }
export function getActiveGroupId(): string | null { return activeGroupId; }

export function focusGroup(groupId: string): void {
  const g = clashGroups.find((x) => x.id === groupId);
  if (!g || !g.members.length) return;
  activeGroupId = groupId;
  void selectClashPair(g.members[0]);
  renderClashList();
}

export async function isolateGroup(groupId: string): Promise<void> {
  const g = clashGroups.find((x) => x.id === groupId);
  if (!g) return;
  const keep: Record<string, Set<number>> = {};
  for (const c of g.members) {
    (keep[c.a.modelId] ??= new Set()).add(c.a.localId);
    (keep[c.b.modelId] ??= new Set()).add(c.b.localId);
  }
  try {
    const hider: any = ctx.hider;
    if (typeof hider.isolate === "function") await hider.isolate(keep);
    else if (typeof hider.set === "function") {
      await hider.set(false);
      await hider.set(true, keep);
    }
  } catch (e) { console.warn("[clash] isolate group failed", e); }
}

function elementKeyRef(ref: { modelId: string; localId: number }): string {
  return `${ref.modelId}::${ref.localId}`;
}

export function setupClash() {
  loadSelections();

  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshTimerLate: ReturnType<typeof setTimeout> | null = null;

  const runRefresh = () => { void refreshModelSelectionUI().catch(() => { /* */ }); };
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (refreshTimerLate) clearTimeout(refreshTimerLate);
    refreshTimer = setTimeout(runRefresh, 400);
    refreshTimerLate = setTimeout(runRefresh, 1400);
  };

  ctx.fragments.list.onItemSet.add(() => { categoryCache.clear(); scheduleRefresh(); });
  ctx.fragments.list.onItemDeleted.add(() => {
    categoryCache.clear();
    scheduleRefresh();
    try { computeSceneBounds(); } catch { /* */ }
  });

  renderScenarioList();
  updateSummary();

  const svc: ClashService = {
    run: runElementClashDetection,
    clear: clearClash,
    cancel: cancelClash,

    listClashes,
    getClashCount,
    getActiveClashIndex,
    focusActiveClash,
    focusNextClash,
    focusPreviousClash,
    focusClashByIndex,
    isolateClashPair,

    getClashState,
    setClashStatus,
    addClashComment,
    cycleActiveClashStatus,
    setStatusForAll,

    getRules,
    setRules,
    getMethod,
    setMethod,

    createScenario,
    listScenarios,
    loadScenario,
    deleteScenario,

    exportCsv: exportClashCsv,

    addSelectionToA,
    addSelectionToB,
    swapSelections,
    clearSelectionA,
    clearSelectionB,
    isolateSelectionA,
    isolateSelectionB,
    showAllElements,

    listGroups,
    getActiveGroupId,
    focusGroup,
    isolateGroup,

    serializeStates: serializeClashStates,
    deserializeStates: deserializeClashStates,
  };
  ctx.features.clash = svc;
  register("clash", svc);
}

/* ═════════════════════════════════════════════════════════════════════════
   Coordination helpers
   ═════════════════════════════════════════════════════════════════════════ */
function currentFragmentSelection(): Record<string, Set<number>> {
  const out: Record<string, Set<number>> = {};
  try {
    const sel = tryUse("selection");
    const snap = sel?.snapshot?.();
    if (!snap) return out;
    for (const [modelId, ids] of Object.entries(snap)) {
      if (ids instanceof Set && ids.size) out[modelId] = new Set(ids as Set<number>);
    }
  } catch { /* */ }
  return out;
}

async function addCurrentSelectionCategoriesTo(target: Set<string>): Promise<number> {
  const snap = currentFragmentSelection();
  let added = 0;
  for (const [modelId, ids] of Object.entries(snap)) {
    const cats = await loadCategoriesForModel(modelId);
    const touched = new Set<string>();
    for (const [cat, catIds] of Object.entries(cats)) {
      for (const id of ids) {
        if (catIds.includes(id)) { touched.add(cat); break; }
      }
    }
    if (!touched.size) {
      if (!target.has(modelId)) { target.add(modelId); added++; }
      continue;
    }
    for (const cat of touched) {
      const key = `${modelId}::${cat}`;
      if (!target.has(key)) { target.add(key); added++; }
    }
  }
  return added;
}

export async function addSelectionToA(): Promise<void> {
  const added = await addCurrentSelectionCategoriesTo(selectionA);
  if (!added) { clashToast("Nothing selected in the viewport.", "warn"); return; }
  persistSelections();
  await refreshModelSelectionUI();
  clashStatusEl.textContent = `Added ${added} category selection(s) to A`;
  clashToast(`Added ${added} to Selection A`, "success", 1500);
}

export async function addSelectionToB(): Promise<void> {
  const added = await addCurrentSelectionCategoriesTo(selectionB);
  if (!added) { clashToast("Nothing selected in the viewport.", "warn"); return; }
  persistSelections();
  await refreshModelSelectionUI();
  clashStatusEl.textContent = `Added ${added} category selection(s) to B`;
  clashToast(`Added ${added} to Selection B`, "success", 1500);
}

export function swapSelections(): void {
  const temp = new Set(selectionA);
  selectionA.clear();
  for (const k of selectionB) selectionA.add(k);
  selectionB.clear();
  for (const k of temp) selectionB.add(k);
  persistSelections();
  void refreshModelSelectionUI();
  clashStatusEl.textContent = "Swapped Selection A ↔ B";
  clashToast("Swapped A ↔ B", "info", 1500);
}

export function clearSelectionA(): void {
  const n = selectionA.size;
  selectionA.clear();
  persistSelections();
  void refreshModelSelectionUI();
  clashStatusEl.textContent = "Cleared Selection A";
  clashToast(n ? `Cleared ${n} entries from A` : "A was already empty.", "info", 1500);
}

export function clearSelectionB(): void {
  const n = selectionB.size;
  selectionB.clear();
  persistSelections();
  void refreshModelSelectionUI();
  clashStatusEl.textContent = "Cleared Selection B";
  clashToast(n ? `Cleared ${n} entries from B` : "B was already empty.", "info", 1500);
}

async function resolveSelectionToMap(set: Set<string>): Promise<OBC.ModelIdMap> {
  const seen = new Set<string>();
  for (const key of set) {
    const modelId = key.includes("::") ? key.split("::")[0] : key;
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    await ensureCategoriesCached(modelId);
  }
  const resolved = resolveSelection(set);
  const map: OBC.ModelIdMap = {};
  for (const [modelId, ids] of resolved) {
    if (ids === "ALL") {
      const model = ctx.fragments.list.get(modelId);
      if (!model) continue;
      try {
        const all = (await (model as any).getItemsIdsWithGeometry()) as number[];
        if (all?.length) map[modelId] = new Set(all);
      } catch { /* */ }
    } else if (ids instanceof Set && ids.size) {
      map[modelId] = ids;
    }
  }
  return map;
}

export async function isolateSelectionA(): Promise<void> {
  if (!selectionA.size) { clashToast("Selection A is empty.", "warn"); return; }
  const map = await resolveSelectionToMap(selectionA);
  if (!Object.keys(map).length) { clashToast("Selection A resolves to no elements.", "warn"); return; }
  try {
    const hider: any = ctx.hider;
    if (typeof hider.isolate === "function") await hider.isolate(map);
    else if (typeof hider.set === "function") {
      await hider.set(false);
      await hider.set(true, map);
    }
    clashStatusEl.textContent = "Isolated Selection A";
    clashToast("Isolated Selection A", "success", 1500);
  } catch (e) { console.warn("[clash] isolate A failed", e); clashToast("Isolate A failed — see console.", "warn"); }
}

export async function isolateSelectionB(): Promise<void> {
  if (!selectionB.size) { clashToast("Selection B is empty.", "warn"); return; }
  const map = await resolveSelectionToMap(selectionB);
  if (!Object.keys(map).length) { clashToast("Selection B resolves to no elements.", "warn"); return; }
  try {
    const hider: any = ctx.hider;
    if (typeof hider.isolate === "function") await hider.isolate(map);
    else if (typeof hider.set === "function") {
      await hider.set(false);
      await hider.set(true, map);
    }
    clashStatusEl.textContent = "Isolated Selection B";
    clashToast("Isolated Selection B", "success", 1500);
  } catch (e) { console.warn("[clash] isolate B failed", e); clashToast("Isolate B failed — see console.", "warn"); }
}

export async function showAllElements(): Promise<void> {
  try {
    // Prefer frag-edit path so native-twin sources stay hidden.
    const frag = tryUse("fragEdit") as any;
    if (frag?.showAllPreservingTwins) {
      await frag.showAllPreservingTwins();
    } else {
      const hider: any = ctx.hider;
      if (typeof hider.show === "function") await hider.show();
      else if (typeof hider.set === "function") await hider.set(true);
    }
    clashStatusEl.textContent = "Showing all elements";
    clashToast("Showing all elements", "success", 1500);
  } catch (e) { console.warn("[clash] show all failed", e); clashToast("Show all failed — see console.", "warn"); }
}

export function changeTolerance(delta: number): void {
  rules.tolerance = Math.max(0, Math.min(1, rules.tolerance + delta));
  const msg = `Tolerance: ${(rules.tolerance * 1000).toFixed(0)} mm`;
  clashStatusEl.textContent = msg;
  clashToast(msg, "info", 1200);
}

export function changeClearance(delta: number): void {
  rules.clearance = Math.max(0, Math.min(5, rules.clearance + delta));
  const msg = `Clearance band: ${(rules.clearance * 100).toFixed(0)} cm`;
  clashStatusEl.textContent = msg;
  clashToast(msg, "info", 1200);
}

export function listClashes(): ElementClash[] { return clashResults.slice(); }
export function getClashCount(): number { return clashResults.length; }

export function getActiveClashIndex(): number {
  if (!activeClash) return -1;
  return clashResults.findIndex((c) => clashKey(c) === clashKey(activeClash!));
}

export async function focusActiveClash(): Promise<void> {
  if (!activeClash) { clashToast("No active clash — click a row or use Next / Previous.", "warn"); return; }
  await selectClashPair(activeClash);
  const idx = getActiveClashIndex();
  clashToast(`Focused clash ${idx + 1} of ${clashResults.length}`, "info", 1200);
}

export async function focusNextClash(): Promise<void> {
  if (!clashResults.length) { clashToast("No clash results.", "warn"); return; }
  const idx = getActiveClashIndex();
  const next = (idx + 1) % clashResults.length;
  await selectClashPair(clashResults[next]);
  clashStatusEl.textContent = `Clash ${next + 1} of ${clashResults.length}`;
}

export async function focusPreviousClash(): Promise<void> {
  if (!clashResults.length) { clashToast("No clash results.", "warn"); return; }
  const idx = getActiveClashIndex();
  const prev = idx <= 0 ? clashResults.length - 1 : idx - 1;
  await selectClashPair(clashResults[prev]);
  clashStatusEl.textContent = `Clash ${prev + 1} of ${clashResults.length}`;
}

/** Focus the clash at a specific index — used by the review window. */
export async function focusClashByIndex(idx: number): Promise<void> {
  if (!clashResults.length) return;
  const n = clashResults.length;
  const i = ((idx % n) + n) % n;   // wrap-around
  await selectClashPair(clashResults[i]);
  clashStatusEl.textContent = `Clash ${i + 1} of ${n}`;
}

export function setStatusForAll(status: ClashStatus): void {
  if (!clashResults.length) { clashToast("No clash results to update.", "warn"); return; }
  const now = Date.now();
  for (const c of clashResults) {
    const key = clashKey(c);
    const s: ClashState = clashStates.get(key) ?? { status: "new", comments: [], updatedAt: now };
    s.status = status;
    s.updatedAt = now;
    clashStates.set(key, s);
  }
  updateSummary();
  renderClashList();
  clashStatusEl.textContent = `All clashes set to ${status}.`;
  clashToast(`All ${clashResults.length} clash(es) → ${STATUS_LABEL[status]}`, "success");
}

export function cycleActiveClashStatus(): void {
  if (!activeClash) { clashToast("No active clash to cycle.", "warn"); return; }
  const s = getClashState(activeClash);
  const i = STATUS_ORDER.indexOf(s.status);
  const next = STATUS_ORDER[(i + 1) % STATUS_ORDER.length];
  setClashStatus(activeClash, next);
  clashToast(`Status → ${STATUS_LABEL[next]}`, "info", 1200);
}