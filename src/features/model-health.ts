/**
 * Model Health — BIM QA dashboard.
 *
 * Read-only audits over every loaded model, with clickable findings that
 * select and focus the offending element in the viewport.
 *
 * Audits:
 *   • Duplicate GlobalIds across the federation
 *   • Missing Name on IfcRoot subtypes
 *   • Elements with no property sets attached
 *   • Empty IfcPropertySingleValue (no NominalValue)
 *   • Sub-millimetre geometry (likely noise)
 *   • Very large elements (> 500 m on any axis)
 *   • Products with no ObjectPlacement (orphan heuristic)
 *
 * Every finding is clickable: click selects the element and fits the camera.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { makeDockable, type DockHandle } from "./dockable";
import { selection } from "./selection";
import { services, tryUse } from "../core/services";
import { notify } from "../core/notify";
import { getElementWorldBoxes } from "../modules/geometry/world-box";

/* ══════════════════════════════════════════════════════════════════════════
   Types
   ══════════════════════════════════════════════════════════════════════════ */

type Severity = "error" | "warning" | "info";

interface Finding {
  id: string;
  audit: string;
  severity: Severity;
  message: string;
  modelId: string;
  localId?: number;
  elementName?: string;
  elementCategory?: string;
  detail?: string;
}

interface AuditResult {
  name: string;
  severity: Severity;
  findings: Finding[];
  durationMs: number;
}

interface AuditContext {
  modelId: string;
  model: any;
  ids: number[];
  data: any[];
  idToCat: Map<number, string>;
}

/* ══════════════════════════════════════════════════════════════════════════
   Constants
   ══════════════════════════════════════════════════════════════════════════ */

const SEV_COLOR: Record<Severity, string> = {
  error: "#ef4444",
  warning: "#f59e0b",
  info: "#38bdf8",
};

const MIN_DIM_METERS = 0.001; // 1 mm
const MAX_DIM_METERS = 500;   // 500 m

/** Categories we skip when auditing "missing psets" — they legitimately
 *  carry no property sets and are noise in the QA report. */
const PSetSilentCategories = new RegExp(
  "^IFC(" +
  "CARTESIAN|DIRECTION|PLACEMENT|POINT|VECTOR|POLYLINE|" +
  "SHAPE|REPRESENTATION|STYLE|COLOUR|AXIS|LOCAL|" +
  "GEOMETRIC|CURVE|SURFACE|SOLID|FACE|EDGE|VERTEX|" +
  "POLY|TRIANGULATED|INDEXED|BOUNDING|CONNECTED|CLOSED|OPEN" +
  ")",
);

/** Categories we treat as "products" when auditing orphan placement. */
const ProductCategory = new RegExp(
  "^IFC(" +
  "WALL|SLAB|DOOR|WINDOW|COLUMN|BEAM|MEMBER|FOOTING|PILE|" +
  "RAMP|RAILING|STAIR|ROOF|COVERING|CURTAINWALL|PLATE|" +
  "PIPE|DUCT|ELEMENTASSEMBLY|BUILDINGELEMENTPROXY|FURNITURE|" +
  "SPACE|FLOW|VALVE|PUMP|FAN|CHILLER|BOILER|TANK|" +
  "AIRTERMINAL|SANITARYTERMINAL|ELECTRIC|LIGHTING|OUTLET|" +
  "SWITCH|SENSOR|ALARM|CONTROLLER|ACTUATOR|PROTECTIVEDEVICE|" +
  "TRANSFORMER|MOTOR|GENERATOR|CONVEYOR|VEHICLE" +
  ")",
);

/* ══════════════════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════════════════ */

let findingSeq = 0;

function fid(prefix: string): string {
  findingSeq += 1;
  return `${prefix}-${findingSeq}`;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c] ?? c,
  );
}

function catOf(ctxA: AuditContext, localId: number): string {
  return ctxA.idToCat.get(localId) ?? "";
}

function shortName(v: unknown): string {
  const s = String(v ?? "").trim();
  return s.length ? s : "";
}

/* ══════════════════════════════════════════════════════════════════════════
   Individual audits
   ══════════════════════════════════════════════════════════════════════════ */

function auditDuplicateGlobalId(all: AuditContext[]): Finding[] {
  interface Hit { modelId: string; localId: number; name: string; cat: string; }
  const map = new Map<string, Hit[]>();

  for (const a of all) {
    for (let i = 0; i < a.ids.length; i++) {
      const d = a.data[i] as any;
      const guid = d?.GlobalId?.value;
      if (!guid || typeof guid !== "string") continue;
      const arr = map.get(guid) ?? [];
      arr.push({
        modelId: a.modelId,
        localId: a.ids[i],
        name: shortName(d?.Name?.value) || `#${a.ids[i]}`,
        cat: catOf(a, a.ids[i]),
      });
      map.set(guid, arr);
    }
  }

  const out: Finding[] = [];
  for (const [guid, hits] of map) {
    if (hits.length < 2) continue;
    const summary = hits.map((h) => `${h.modelId}/${h.localId}`).join(", ");
    for (const h of hits) {
      out.push({
        id: fid("dup"),
        audit: "Duplicate GlobalId",
        severity: "error",
        message: `GlobalId ${guid} appears ${hits.length} times in the federation`,
        modelId: h.modelId,
        localId: h.localId,
        elementName: h.name,
        elementCategory: h.cat,
        detail: summary,
      });
    }
  }
  return out;
}

function auditMissingName(a: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (let i = 0; i < a.ids.length; i++) {
    const d = a.data[i] as any;
    // Only flag when the attribute exists but is empty — we do not have
    // schema info here to know whether the entity even carries Name.
    if (d?.Name === undefined) continue;
    const name = d.Name?.value;
    if (name == null || String(name).trim() === "") {
      out.push({
        id: fid("noname"),
        audit: `Missing name · ${a.modelId}`,
        severity: "warning",
        message: "Element has an empty Name attribute",
        modelId: a.modelId,
        localId: a.ids[i],
        elementCategory: catOf(a, a.ids[i]),
      });
    }
  }
  return out;
}

function auditMissingPsets(a: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (let i = 0; i < a.ids.length; i++) {
    const d = a.data[i] as any;
    const has = d?.psets && typeof d.psets === "object" && Object.keys(d.psets).length > 0;
    if (has) continue;

    const cat = catOf(a, a.ids[i]);
    if (PSetSilentCategories.test(cat.toUpperCase())) continue;

    out.push({
      id: fid("nopset"),
      audit: `No property sets · ${a.modelId}`,
      severity: "info",
      message: "Element has no property sets attached",
      modelId: a.modelId,
      localId: a.ids[i],
      elementCategory: cat,
    });
  }
  return out;
}

function auditEmptyPropertyValues(a: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (let i = 0; i < a.ids.length; i++) {
    const d = a.data[i] as any;
    if (!d?.psets || typeof d.psets !== "object") continue;

    for (const psetName of Object.keys(d.psets)) {
      const props = d.psets[psetName];
      if (!props || typeof props !== "object") continue;

      for (const key of Object.keys(props)) {
        const raw = (props as any)[key];
        const value = raw?.value;
        if (value == null || String(value).trim() === "") {
          out.push({
            id: fid("emptyprop"),
            audit: `Empty property values · ${a.modelId}`,
            severity: "info",
            message: `${psetName}.${key} is empty`,
            modelId: a.modelId,
            localId: a.ids[i],
            elementCategory: catOf(a, a.ids[i]),
            detail: psetName,
          });
        }
      }
    }
  }
  return out;
}

async function auditGeometry(a: AuditContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const CHUNK = 800;
  const size = new THREE.Vector3();

  for (let i = 0; i < a.ids.length; i += CHUNK) {
    const slice = a.ids.slice(i, i + CHUNK);

    let boxes: Array<{ id: number; box: THREE.Box3 }> = [];
    try {
      boxes = await getElementWorldBoxes(a.model, slice, a.modelId);
    } catch {
      continue;
    }

    for (const wb of boxes) {
      if (!wb?.box || wb.box.isEmpty()) continue;
      wb.box.getSize(size);
      const dx = size.x;
      const dy = size.y;
      const dz = size.z;

      if (dx < MIN_DIM_METERS && dy < MIN_DIM_METERS && dz < MIN_DIM_METERS) {
        out.push({
          id: fid("tiny"),
          audit: `Sub-millimetre geometry · ${a.modelId}`,
          severity: "info",
          message: "Bounding box is smaller than 1 mm on every axis",
          modelId: a.modelId,
          localId: wb.id,
          elementCategory: catOf(a, wb.id),
          detail:
            `${(dx * 1000).toFixed(2)} × ` +
            `${(dy * 1000).toFixed(2)} × ` +
            `${(dz * 1000).toFixed(2)} mm`,
        });
        continue;
      }

      if (dx > MAX_DIM_METERS || dy > MAX_DIM_METERS || dz > MAX_DIM_METERS) {
        out.push({
          id: fid("huge"),
          audit: `Very large element · ${a.modelId}`,
          severity: "warning",
          message: "Bounding box exceeds 500 m on at least one axis",
          modelId: a.modelId,
          localId: wb.id,
          elementCategory: catOf(a, wb.id),
          detail: `${dx.toFixed(1)} × ${dy.toFixed(1)} × ${dz.toFixed(1)} m`,
        });
      }
    }
  }
  return out;
}

function auditOrphanProducts(a: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (let i = 0; i < a.ids.length; i++) {
    const cat = catOf(a, a.ids[i]);
    if (!ProductCategory.test(cat.toUpperCase())) continue;

    const d = a.data[i] as any;
    const hasPlacement = d?.ObjectPlacement?.value != null;
    if (hasPlacement) continue;

    out.push({
      id: fid("orphan"),
      audit: `Orphan products · ${a.modelId}`,
      severity: "info",
      message: "Product has no ObjectPlacement (orphan heuristic)",
      modelId: a.modelId,
      localId: a.ids[i],
      elementCategory: cat,
    });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   Context gathering
   ══════════════════════════════════════════════════════════════════════════ */

async function gatherContexts(): Promise<AuditContext[]> {
  const out: AuditContext[] = [];

  for (const entry of ctx.fragments.list as unknown as Iterable<[string, any]>) {
    const [modelId, model] = entry;
    if (!model) continue;

    let ids: number[] = [];
    try {
      ids = ((await (model as any).getItemsIdsWithGeometry?.()) as number[]) ?? [];
    } catch {
      continue;
    }
    if (!ids.length) continue;

    let data: any[] = [];
    try {
      data = await (model as any).getItemsData(ids, {
        attributesDefault: true,
        psetsDefault: false,
      });
    } catch {
      // Shape mismatch is fine — audits skip missing attributes.
    }

    let catMap: Record<string, number[]> = {};
    try {
      catMap = (await (model as any).getItemsOfCategories([/.+/])) as Record<string, number[]>;
    } catch {
      // Category audit silently degrades to "unknown".
    }

    const idToCat = new Map<number, string>();
    for (const cat of Object.keys(catMap)) {
      const list = catMap[cat];
      if (!Array.isArray(list)) continue;
      for (const id of list) idToCat.set(id, cat);
    }

    out.push({ modelId, model, ids, data, idToCat });
  }

  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   Orchestrator
   ══════════════════════════════════════════════════════════════════════════ */

let running = false;

export async function runModelHealth(): Promise<AuditResult[]> {
  if (running) {
    // Calling twice in a row is a UI bug, not a runtime failure. Return
    // an empty result set so the caller's `await` resolves cleanly.
    return [];
  }
  running = true;
  findingSeq = 0;

  try {
    const contexts = await gatherContexts();
    if (!contexts.length) {
      notify("warn", "No models loaded — nothing to audit.");
      return [];
    }

    const results: AuditResult[] = [];

    const run = async (
      name: string,
      severity: Severity,
      fn: () => Promise<Finding[]> | Finding[],
    ): Promise<void> => {
      const t0 = performance.now();
      let findings: Finding[] = [];
      try {
        findings = await fn();
      } catch (err) {
        findings = [{
          id: fid("auditfail"),
          audit: name,
          severity: "error",
          message: `Audit failed: ${err instanceof Error ? err.message : String(err)}`,
          modelId: "",
        }];
      }
      results.push({
        name,
        severity,
        findings,
        durationMs: performance.now() - t0,
      });
    };

    // Global audits first — they look across the federation.
    await run("Duplicate GlobalId", "error", () => auditDuplicateGlobalId(contexts));

    // Per-model audits.
    for (const a of contexts) {
      await run(`Missing name · ${a.modelId}`, "warning", () => auditMissingName(a));
      await run(`No property sets · ${a.modelId}`, "info", () => auditMissingPsets(a));
      await run(`Empty property values · ${a.modelId}`, "info", () => auditEmptyPropertyValues(a));
      await run(`Geometry · ${a.modelId}`, "warning", () => auditGeometry(a));
      await run(`Orphan products · ${a.modelId}`, "info", () => auditOrphanProducts(a));
    }

    return results;
  } finally {
    running = false;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Panel — DOM
   ══════════════════════════════════════════════════════════════════════════ */

const panel = document.createElement("div");
panel.id = "obs-model-health";
panel.style.cssText =
  "display:none;flex-direction:column;z-index:38;" +
  "background:var(--bg-floating,#1c1e28);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:10px;" +
  "box-shadow:0 16px 44px rgba(0,0,0,.55);" +
  "color:var(--text-primary,#e8eaf0);font:12px system-ui,sans-serif;" +
  "overflow:hidden";
panel.addEventListener("mousedown", (e) => e.stopPropagation());

const header = document.createElement("div");
header.style.cssText =
  "display:flex;align-items:center;gap:8px;padding:9px 10px;" +
  "border-bottom:1px solid var(--border-subtle,#1e2029);" +
  "background:var(--bg-elevated,#181a23);" +
  "cursor:move;user-select:none";

const headerIcon = document.createElement("span");
headerIcon.style.cssText = "display:flex;color:#22c55e";
headerIcon.textContent = "◆";

const headerTitle = document.createElement("span");
headerTitle.style.cssText = "font-weight:700;flex:1";
headerTitle.textContent = "Model Health";

const headerSummary = document.createElement("span");
headerSummary.id = "obs-health-summary";
headerSummary.style.cssText =
  "font:600 10px var(--font-mono,monospace);" +
  "color:var(--text-tertiary,#6b7280)";
headerSummary.textContent = "idle";

header.append(headerIcon, headerTitle, headerSummary);

const body = document.createElement("div");
body.style.cssText = "flex:1;overflow:auto;padding:10px;min-height:200px";

panel.append(header, body);

/* ══════════════════════════════════════════════════════════════════════════
   Panel — state
   ══════════════════════════════════════════════════════════════════════════ */

let dock: DockHandle | null = null;
let visible = false;
let lastResults: AuditResult[] = [];
let activeSeverity: Severity | "all" = "all";

/* ══════════════════════════════════════════════════════════════════════════
   Panel — rendering
   ══════════════════════════════════════════════════════════════════════════ */

function renderIdle(): void {
  headerSummary.textContent = "idle";
  headerSummary.style.color = "var(--text-tertiary,#6b7280)";

  body.innerHTML =
    `<div style="text-align:center;padding:30px;color:#6b7280;line-height:1.6">` +
    `<p style="margin:0 0 12px">Run a health check to audit the loaded federated models.</p>` +
    `<button data-act="run" style="padding:8px 16px;background:#22c55e;color:#0b0d12;` +
    `border:none;border-radius:6px;cursor:pointer;font:600 12px system-ui">` +
    `▶ Run Model Health Check</button>` +
    `</div>`;

  body.querySelector<HTMLElement>('[data-act="run"]')?.addEventListener("click", () => {
    void run();
  });
}

function summarize(results: AuditResult[]): {
  total: number;
  bySeverity: Record<Severity, number>;
} {
  const bySeverity: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  let total = 0;
  for (const r of results) {
    for (const f of r.findings) {
      bySeverity[f.severity] += 1;
      total += 1;
    }
  }
  return { total, bySeverity };
}

function makeFilterButton(
  label: string,
  value: Severity | "all",
  active: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.dataset.sev = value;
  b.style.cssText =
    "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:10px;" +
    "border:1px solid #2a2e3a;" +
    (active
      ? "background:rgba(56,189,248,.14);color:#38bdf8;"
      : "background:transparent;color:#a0a6b5;");
  b.addEventListener("click", onClick);
  return b;
}

function renderFindingRow(f: Finding): HTMLElement {
  const row = document.createElement("div");
  row.style.cssText =
    "display:grid;grid-template-columns:auto 1fr auto;gap:8px;" +
    "padding:6px 8px;margin-bottom:3px;align-items:center;" +
    "background:var(--bg-inset,#0e1017);" +
    "border:1px solid var(--border-subtle,#1e2029);" +
    "border-radius:5px;font-size:10.5px;" +
    (f.localId ? "cursor:pointer;" : "");

  if (f.localId) {
    row.addEventListener("click", () => {
      selection.replace({ [f.modelId]: new Set([f.localId!]) });
      void selection.applyToHighlighter();
      services.ready("camera").then((cam) => {
        void cam.fitToMap({ [f.modelId]: new Set([f.localId!]) } as any);
      }).catch(() => { /* camera service optional */ });
    });
  }

  // Severity badge
  const badge = document.createElement("span");
  badge.textContent = f.severity.toUpperCase();
  badge.style.cssText =
    `background:${SEV_COLOR[f.severity]};color:#0b0d12;` +
    `padding:1px 6px;border-radius:3px;font:700 9px ui-monospace,monospace;` +
    `flex:none`;
  row.appendChild(badge);

  // Message text
  const text = document.createElement("div");
  text.style.cssText = "min-width:0";

  const catPrefix = f.elementCategory ? `[${esc(f.elementCategory)}] ` : "";
  const namePrefix = f.elementName ? `${esc(f.elementName)} — ` : "";

  const primary = document.createElement("div");
  primary.innerHTML = `${catPrefix}${namePrefix}${esc(f.message)}`;
  text.appendChild(primary);

  if (f.detail) {
    const d = document.createElement("div");
    d.textContent = f.detail;
    d.style.cssText = "color:#6b7280;font-size:9.5px;margin-top:2px";
    text.appendChild(d);
  }

  if (f.modelId) {
    const loc = document.createElement("div");
    loc.textContent = f.localId
      ? `${f.modelId} / #${f.localId}`
      : f.modelId;
    loc.style.cssText = "color:#6b7280;font-size:9px;margin-top:2px";
    text.appendChild(loc);
  }

  row.appendChild(text);

  // Trailing arrow (only when clickable)
  const arrow = document.createElement("span");
  arrow.textContent = f.localId ? "→" : "";
  arrow.style.cssText = "color:#6b7280;flex:none";
  row.appendChild(arrow);

  return row;
}

function renderFindings(): void {
  const container = document.getElementById("obs-health-findings");
  if (!container) return;
  container.innerHTML = "";

  // Collect + filter.
  const all: Finding[] = [];
  for (const r of lastResults) {
    for (const f of r.findings) {
      if (activeSeverity !== "all" && f.severity !== activeSeverity) continue;
      all.push(f);
    }
  }

  if (!all.length) {
    const empty = document.createElement("div");
    empty.style.cssText =
      "text-align:center;padding:20px;color:#6b7280;font-size:11px";
    empty.textContent = "No findings match this filter.";
    container.appendChild(empty);
    return;
  }

  // Group by audit name (preserving the audit order from lastResults).
  const order: string[] = [];
  const byAudit = new Map<string, Finding[]>();
  for (const r of lastResults) {
    for (const f of r.findings) {
      if (activeSeverity !== "all" && f.severity !== activeSeverity) continue;
      if (!byAudit.has(r.name)) {
        byAudit.set(r.name, []);
        order.push(r.name);
      }
      byAudit.get(r.name)!.push(f);
    }
  }

  for (const auditName of order) {
    const items = byAudit.get(auditName) ?? [];
    if (!items.length) continue;

    const sec = document.createElement("section");
    sec.style.cssText = "margin-bottom:14px";

    const worst: Severity = items.some((f) => f.severity === "error")
      ? "error"
      : items.some((f) => f.severity === "warning")
        ? "warning"
        : "info";

    const h = document.createElement("div");
    h.style.cssText =
      "display:flex;align-items:center;gap:6px;margin-bottom:6px;" +
      "font-weight:700;font-size:11.5px";
    h.innerHTML =
      `<span style="width:8px;height:8px;border-radius:50%;` +
      `background:${SEV_COLOR[worst]}"></span>` +
      `<span>${esc(auditName)}</span>` +
      `<span style="color:#6b7280;font-weight:400;font-size:10px">` +
      `(${items.length})</span>`;
    sec.appendChild(h);

    const shown = items.slice(0, 60);
    for (const f of shown) sec.appendChild(renderFindingRow(f));

    if (items.length > shown.length) {
      const more = document.createElement("div");
      more.textContent = `+ ${items.length - shown.length} more…`;
      more.style.cssText = "color:#6b7280;font-size:10px;padding:3px 8px";
      sec.appendChild(more);
    }

    container.appendChild(sec);
  }
}

function renderResults(): void {
  const summary = summarize(lastResults);
  headerSummary.textContent = `${summary.total} finding(s)`;
  headerSummary.style.color =
    summary.bySeverity.error > 0 ? "#ef4444"
    : summary.bySeverity.warning > 0 ? "#f59e0b"
    : "#38bdf8";

  body.innerHTML = "";

  // Toolbar
  const bar = document.createElement("div");
  bar.style.cssText =
    "display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;align-items:center";

  const runBtn = document.createElement("button");
  runBtn.textContent = "↻ Re-run";
  runBtn.style.cssText =
    "padding:5px 12px;background:#22c55e;color:#0b0d12;border:none;" +
    "border-radius:5px;cursor:pointer;font:600 11px system-ui";
  runBtn.addEventListener("click", () => { void run(); });
  bar.appendChild(runBtn);

  const filterRow = document.createElement("div");
  filterRow.style.cssText = "display:flex;gap:4px;flex-wrap:wrap";

  const filters: Array<{ label: string; value: Severity | "all" }> = [
    { label: `All (${summary.total})`, value: "all" },
    { label: `Errors (${summary.bySeverity.error})`, value: "error" },
    { label: `Warnings (${summary.bySeverity.warning})`, value: "warning" },
    { label: `Info (${summary.bySeverity.info})`, value: "info" },
  ];

  for (const f of filters) {
    filterRow.appendChild(
      makeFilterButton(f.label, f.value, activeSeverity === f.value, () => {
        activeSeverity = f.value;
        renderResults();
      }),
    );
  }
  bar.appendChild(filterRow);
  body.appendChild(bar);

  // Findings container
  const container = document.createElement("div");
  container.id = "obs-health-findings";
  body.appendChild(container);

  renderFindings();
}

/* ══════════════════════════════════════════════════════════════════════════
   Panel — run
   ══════════════════════════════════════════════════════════════════════════ */

async function run(): Promise<void> {
  // Disable the trigger while running.
  const btn = body.querySelector<HTMLButtonElement>('[data-act="run"], button');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Running…";
  }

  const loader = tryUse("appLoader");
  loader?.begin?.("Model Health — scanning");
  try {
    loader?.set?.("Reading models", 0.1);
    lastResults = await runModelHealth();
    loader?.set?.("Done", 1);
    activeSeverity = "all";
    if (lastResults.length) renderResults();
    else renderIdle();
  } catch (err) {
    console.error("[model-health] run failed", err);
    notify("error", `Model Health failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    loader?.finish?.();
    const btn2 = body.querySelector<HTMLButtonElement>('[data-act="run"]');
    if (btn2) { btn2.disabled = false; btn2.textContent = "▶ Run Model Health Check"; }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Public API
   ══════════════════════════════════════════════════════════════════════════ */

export function openModelHealth(): void {
  visible = true;
  if (!panel.parentElement) ctx.rightHost.appendChild(panel);
  panel.style.display = "flex";

  if (!dock) {
    dock = makeDockable(panel, {
      id: "model-health",
      host: ctx.rightHost,
      header,
      minWidth: 420,
      minHeight: 320,
      defaultDock: "right",
      defaultWidth: 520,
      defaultHeight: 680,
    });
  }
  dock.show();

  if (lastResults.length) renderResults();
  else { renderIdle(); void run(); }
}

export function closeModelHealth(): void {
  visible = false;
  dock?.hide();
  panel.style.display = "none";
}

export function toggleModelHealth(): void {
  if (visible) closeModelHealth();
  else openModelHealth();
}

export function isModelHealthVisible(): boolean {
  return visible;
}

export function getLastHealthResults(): readonly AuditResult[] {
  return lastResults;
}

/* ══════════════════════════════════════════════════════════════════════════
   Setup
   ══════════════════════════════════════════════════════════════════════════ */

export function setupModelHealth(): void {
  if (panel.parentElement !== ctx.rightHost) {
    ctx.rightHost.appendChild(panel);
  }

  dock = makeDockable(panel, {
    id: "model-health",
    host: ctx.rightHost,
    header,
    minWidth: 420,
    minHeight: 320,
    defaultDock: "right",
    defaultWidth: 520,
    defaultHeight: 680,
  });
  panel.style.display = "none";

  const svc = {
    open: openModelHealth,
    close: closeModelHealth,
    toggle: toggleModelHealth,
    isVisible: isModelHealthVisible,
    run: async () => {
      const res = await runModelHealth();
      lastResults = res;
      return res;
    },
    getLastResults: getLastHealthResults,
  };
  (ctx.features as any).modelHealth = svc;

  // Also expose as a panel service so the ribbon and command palette
  // can toggle it without knowing the shape of the health-specific API.
  (ctx.features as any).modelHealthPanel = {
    toggle: toggleModelHealth,
    isVisible: isModelHealthVisible,
  };

  console.log("[model-health] ready");
}