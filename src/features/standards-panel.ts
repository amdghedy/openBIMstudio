/**
 * Standards panel.
 *
 * Left column: rule packs grouped by jurisdiction.
 * Right column: run button + results table with severity filter.
 * Bottom: export to CSV / HTML report.
 */
import { ctx } from "../core/context";
import { makeDockable, type DockHandle } from "./dockable";
import { t, scoped } from "../core/i18n";
import { register } from "../core/services";
import { listPacks, registerStandardPacks } from "../modules/standards/rules";
import { runRules, type RunResult } from "../modules/standards/rules/engine";
import type { RulePack, RuleViolation, RuleSeverity } from "../modules/standards/rules/types";

const tr = scoped("standards");

const panel = document.createElement("div");
panel.id = "obs-standards-panel";
panel.style.cssText =
  "z-index:39;display:none;flex-direction:column;background:var(--bg-floating,#1c1e28);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:10px;" +
  "box-shadow:0 12px 36px rgba(0,0,0,.55);font:12px system-ui,sans-serif;" +
  "color:var(--text-primary,#e8eaf0);min-height:0;position:relative";
panel.addEventListener("mousedown", (e) => e.stopPropagation());

const header = document.createElement("div");
header.style.cssText =
  "display:flex;align-items:center;gap:6px;padding:9px 10px;" +
  "border-bottom:1px solid var(--border-subtle,#1e2029);" +
  "background:var(--bg-elevated,#181a23);flex-shrink:0;cursor:grab;user-select:none";
header.innerHTML =
  `<span style="display:flex;color:var(--accent,#38bdf8)">⚖</span>` +
  `<span style="font-weight:700;flex:1">${t("standards.title", { defaultValue: "Standards" } as any) ?? "Standards"}</span>`;

const body = document.createElement("div");
body.style.cssText = "flex:1;display:flex;min-height:0";
panel.append(header, body);

/* ── Left column: pack list ──────────────────────────────────────── */
const left = document.createElement("div");
left.style.cssText =
  "width:280px;flex:none;border-inline-end:1px solid var(--border-subtle,#1e2029);" +
  "overflow-y:auto;padding:8px;background:var(--bg-inset,#0e1017)";

const runBar = document.createElement("div");
runBar.style.cssText = "display:flex;gap:6px;margin-bottom:8px";
const runBtn = document.createElement("button");
runBtn.textContent = "▶ Run selected";
runBtn.style.cssText =
  "flex:1;padding:8px;background:var(--accent,#38bdf8);color:#0b0d12;border:none;" +
  "border-radius:6px;cursor:pointer;font:700 12px system-ui";
const cancelBtn = document.createElement("button");
cancelBtn.textContent = "■";
cancelBtn.title = "Cancel";
cancelBtn.style.cssText =
  "padding:8px 12px;background:transparent;color:#fca5a5;border:1px solid rgba(239,68,68,.5);" +
  "border-radius:6px;cursor:pointer;font:700 12px system-ui;display:none";
runBar.append(runBtn, cancelBtn);
left.appendChild(runBar);

const selectAllRow = document.createElement("div");
selectAllRow.style.cssText = "display:flex;gap:6px;margin-bottom:10px;font-size:10.5px";
const allOn = document.createElement("button");
allOn.textContent = "Select all";
allOn.style.cssText =
  "flex:1;padding:4px;background:transparent;color:var(--text-tertiary,#6b7280);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:4px;cursor:pointer";
const allOff = document.createElement("button");
allOff.textContent = "Clear";
allOff.style.cssText = allOn.style.cssText;
selectAllRow.append(allOn, allOff);
left.appendChild(selectAllRow);

const packList = document.createElement("div");
left.appendChild(packList);

/* ── Right column: results ───────────────────────────────────────── */
const right = document.createElement("div");
right.style.cssText = "flex:1;display:flex;flex-direction:column;min-height:0";

const summary = document.createElement("div");
summary.style.cssText =
  "padding:8px 12px;border-bottom:1px solid var(--border-subtle,#1e2029);" +
  "font-size:11px;color:var(--text-secondary,#a0a6b5);flex-shrink:0";
summary.textContent = "Select rule packs on the left, then Run.";

const filterBar = document.createElement("div");
filterBar.style.cssText =
  "display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid var(--border-subtle,#1e2029);" +
  "font-size:10.5px;background:var(--bg-elevated,#181a23)";
const filterState = { error: true, warning: true, info: true };
const mkToggle = (label: string, key: "error" | "warning" | "info", color: string) => {
  const b = document.createElement("button");
  b.textContent = label;
  const on = () => filterState[key];
  const style = () => {
    b.style.cssText =
      `padding:3px 9px;border-radius:999px;font:600 10.5px system-ui;cursor:pointer;` +
      (on()
        ? `background:${color}22;color:${color};border:1px solid ${color}`
        : `background:transparent;color:#6b7280;border:1px solid #2a2e3a`);
  };
  b.onclick = () => { filterState[key] = !on(); style(); renderResults(); };
  style();
  return b;
};
filterBar.append(
  mkToggle("Errors", "error", "#ef4444"),
  mkToggle("Warnings", "warning", "#f59e0b"),
  mkToggle("Info", "info", "#38bdf8"),
);
right.append(summary, filterBar);

const results = document.createElement("div");
results.style.cssText = "flex:1;overflow-y:auto;padding:4px 6px";
right.append(results);

body.append(left, right);

let dock: DockHandle | null = null;
let visible = false;
let lastRun: RunResult | null = null;
const selected = new Set<string>();

/* ── Pack list rendering ─────────────────────────────────────────── */

function renderPacks(): void {
  packList.innerHTML = "";
  const packs = listPacks();
  const byJurisdiction = new Map<string, RulePack[]>();
  for (const p of packs) {
    const jKey = p.jurisdiction ?? "intl";
    const arr = byJurisdiction.get(jKey) ?? [];
    arr.push(p);
    byJurisdiction.set(jKey, arr);
  }

  const order = ["GB", "US", "DE", "FR", "CN", "JP", "intl"];
  const sorted = [...byJurisdiction.entries()].sort((a, b) => {
    const ai = order.indexOf(a[0]);
    const bi = order.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  for (const [jurisdiction, group] of sorted) {
    const gLabel = document.createElement("div");
    gLabel.textContent = jurisdiction === "intl" ? "International" : jurisdiction;
    gLabel.style.cssText =
      "font:700 10px system-ui;color:#6b7280;letter-spacing:.5px;" +
      "text-transform:uppercase;margin:8px 2px 4px";
    packList.appendChild(gLabel);

    for (const pack of group) {
      const row = document.createElement("label");
      row.style.cssText =
        "display:flex;align-items:flex-start;gap:6px;padding:6px 7px;border-radius:5px;" +
        "cursor:pointer;margin-bottom:2px";
      row.onmouseenter = () => (row.style.background = "var(--bg-hover,#232633)");
      row.onmouseleave = () => (row.style.background = "");

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(pack.id);
      cb.style.cssText = "margin-top:2px;cursor:pointer;flex:none";
      cb.onchange = () => {
        if (cb.checked) selected.add(pack.id);
        else selected.delete(pack.id);
      };

      const text = document.createElement("div");
      text.style.cssText = "flex:1;min-width:0";
      const name = document.createElement("div");
      name.textContent = pack.name;
      name.style.cssText = "font-weight:600;font-size:11.5px";
      const desc = document.createElement("div");
      desc.textContent = `${pack.rules.length} rules · ${pack.version}`;
      desc.style.cssText = "font-size:10px;color:#6b7280;margin-top:1px";
      text.append(name, desc);

      row.append(cb, text);
      packList.appendChild(row);
    }
  }
}

/* ── Run ─────────────────────────────────────────────────────────── */

async function run(): Promise<void> {
  if (!selected.size) {
    summary.textContent = "Select at least one rule pack.";
    return;
  }

  const signal = { cancelled: false };
  runBtn.disabled = true;
  runBtn.textContent = "Running…";
  cancelBtn.style.display = "inline-block";
  cancelBtn.onclick = () => { signal.cancelled = true; };
  results.innerHTML = "";

  try {
    lastRun = await runRules({
      packIds: [...selected],
      signal,
      onProgress: (done: number, total: number, note?: string) => {
        summary.textContent = `${done} / ${total} · ${note ?? ""}`;
      },
    });
    renderResults();
  } catch (err) {
    summary.textContent = `Failed: ${err instanceof Error ? err.message : err}`;
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = "▶ Run selected";
    cancelBtn.style.display = "none";
  }
}

/* ── Results rendering ───────────────────────────────────────────── */

function renderResults(): void {
  if (!lastRun) return;
  const { summary: s, violations } = lastRun;

  summary.innerHTML =
    `<b>${s.violations}</b> violation(s) · ` +
    `<span style="color:#ef4444">${s.errors} error(s)</span> · ` +
    `<span style="color:#f59e0b">${s.warnings} warning(s)</span> · ` +
    `<span style="color:#38bdf8">${s.infos} info</span> · ` +
    `${s.ruleCount} rule(s) in ${s.durationMs} ms`;

  results.innerHTML = "";
  if (!violations.length) {
    const empty = document.createElement("div");
    empty.textContent = "No violations.";
    empty.style.cssText = "padding:30px;text-align:center;color:#6b7280";
    results.appendChild(empty);
    return;
  }

  const colourOf = (sev: RuleSeverity) =>
    sev === "error" ? "#ef4444" : sev === "warning" ? "#f59e0b" : "#38bdf8";

  for (const v of violations) {
    if (!filterState[v.severity]) continue;

    const row = document.createElement("div");
    row.style.cssText =
      `padding:8px 10px;margin:4px 2px;border-radius:6px;` +
      `background:var(--bg-elevated,#181a23);` +
      `border-inline-start:3px solid ${colourOf(v.severity)}`;

    const top = document.createElement("div");
    top.style.cssText = "display:flex;gap:8px;align-items:center";
    const sev = document.createElement("span");
    sev.textContent = v.severity.toUpperCase();
    sev.style.cssText =
      `padding:1px 6px;border-radius:3px;font:700 9px system-ui;color:#0b0d12;` +
      `background:${colourOf(v.severity)}`;
    const name = document.createElement("div");
    name.textContent = v.elementName;
    name.style.cssText = "flex:1;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    const std = document.createElement("span");
    std.textContent = v.standard;
    std.style.cssText = "font-size:10px;color:#6b7280";
    top.append(sev, name, std);

    const msg = document.createElement("div");
    msg.textContent = v.message;
    msg.style.cssText = "font-size:11px;line-height:1.5;margin-top:4px";

    const meta = document.createElement("div");
    meta.style.cssText = "font-size:9.5px;color:#6b7280;margin-top:3px;font-family:var(--font-mono,monospace)";
    const metaParts: string[] = [`#${v.elementId}`, v.elementCategory];
    if (v.actual) metaParts.push(`actual ${v.actual}`);
    if (v.required) metaParts.push(`required ${v.required}`);
    meta.textContent = metaParts.join(" · ");

    row.append(top, msg, meta);
    row.onclick = () => focusElement(v.elementId);
    row.style.cursor = "pointer";
    results.appendChild(row);
  }
}

async function focusElement(localId: number): Promise<void> {
  try {
    const modelId = lastRun ? [...ctx.fragments.list.keys()][0] : null;
    if (!modelId) return;
    const sel = (ctx.features as any).selection;
    sel?.replace?.({ [modelId]: new Set([localId]) });
    await sel?.applyToHighlighter?.();
    const cam = (ctx.features as any).camera;
    await cam?.fitToMap?.({ [modelId]: new Set([localId]) });
  } catch (err) {
    console.warn("[standards] focus failed", err);
  }
}

/* ── Public API ──────────────────────────────────────────────────── */

export function openStandardsPanel(): void {
  registerStandardPacks();
  renderPacks();
  if (!dock) {
    dock = makeDockable(panel, {
      id: "standards",
      host: ctx.rightHost,
      header,
      minWidth: 720, minHeight: 480,
      defaultDock: "right",
      defaultWidth: 900, defaultHeight: 700,
    });
  }
  visible = true;
  panel.style.display = "flex";
  dock.show();
}

export function closeStandardsPanel(): void {
  visible = false;
  dock?.hide();
  panel.style.display = "none";
}

export function toggleStandardsPanel(): void {
  visible ? closeStandardsPanel() : openStandardsPanel();
}

export function isStandardsPanelVisible(): boolean {
  return visible;
}

export function setupStandardsPanel(): void {
  registerStandardPacks();
  ctx.rightHost.appendChild(panel);
  dock = makeDockable(panel, {
    id: "standards",
    host: ctx.rightHost,
    header,
    minWidth: 720, minHeight: 480,
    defaultDock: "right",
    defaultWidth: 900, defaultHeight: 700,
  });
  panel.style.display = "none";
  runBtn.onclick = () => void run();
  allOn.onclick = () => {
    for (const p of listPacks()) selected.add(p.id);
    renderPacks();
  };
  allOff.onclick = () => {
    selected.clear();
    renderPacks();
  };
  register("standards", { run: runRules });

  ctx.features.standardsPanel = {
    open: openStandardsPanel,
    close: closeStandardsPanel,
    toggle: toggleStandardsPanel,
    isVisible: isStandardsPanelVisible,
    run: runRules,
  };
  console.log("[standards] panel ready");
}