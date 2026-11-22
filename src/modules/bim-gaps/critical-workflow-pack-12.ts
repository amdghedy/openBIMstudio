/**
 * Critical workflow pack 12 — next 10 authoring / view / delivery gaps:
 *  1. ISOLATESEL     isolate selection (hide others)
 *  2. SHOWALL        restore visibility
 *  3. HIDECAT        hide selected categories
 *  4. SELSIMTYPE     select similar by type
 *  5. SELBYLEVEL     select elements on active level
 *  6. LEVELREPORT    list levels + element counts
 *  7. UNITSREPORT    report active unit system
 *  8. QUICKSNAP      force recovery/journal snapshot label
 *  9. LINKEDSUMMARY  summarize linked fragment models
 * 10. CLEARTEMP      clear temporary hide flags
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";

type Any = Record<string, any>;

function authoring(): Any | null {
  return (ctx.features as Any)?.authoring ?? null;
}

function elements(): Any[] {
  return authoring()?.getElements?.() ?? [];
}

function elType(el: Any): string {
  return String(el.type || el.category || "unknown");
}

function elLevel(el: Any): string {
  const v = el.params?.level ?? el.properties?.level ?? el.params?.levelName ?? el.level;
  return v != null && v !== "" ? String(v) : "(none)";
}

/* 1 */ export function isolateSelection(): number {
  const a = authoring();
  const ids = new Set<string>(a?.getSelectedIds?.() ?? []);
  if (!ids.size) {
    notify("warn", "Select elements to isolate");
    return 0;
  }
  let n = 0;
  for (const el of elements()) {
    if (!ids.has(el.id)) {
      try {
        if (a?.setTempHidden) a.setTempHidden(el.id, true);
        else if (el.properties) el.properties.tempHidden = true;
        else if (el.params) el.params.tempHidden = true;
        n++;
      } catch { /* */ }
    } else {
      try {
        if (a?.setTempHidden) a.setTempHidden(el.id, false);
        else if (el.properties) el.properties.tempHidden = false;
      } catch { /* */ }
    }
  }
  try { a?.refreshVisibility?.(); } catch { /* */ }
  try { (ctx.hider as Any)?.set?.([...ids]); } catch { /* */ }
  notify("success", `Isolated ${ids.size} · hidden ${n}`);
  return ids.size;
}

/* 2 */ export function showAllElements(): number {
  const a = authoring();
  let n = 0;
  for (const el of elements()) {
    try {
      if (a?.setTempHidden) a.setTempHidden(el.id, false);
      if (el.properties?.tempHidden) { el.properties.tempHidden = false; n++; }
      if (el.params?.tempHidden) { el.params.tempHidden = false; n++; }
    } catch { /* */ }
  }
  try { a?.refreshVisibility?.(); } catch { /* */ }
  try { (ctx.hider as Any)?.show?.(); } catch { /* */ }
  notify("success", "Show all — temporary hides cleared");
  return n;
}

/* 3 */ export function hideSelectedCategories(): number {
  const a = authoring();
  const ids: string[] = a?.getSelectedIds?.() ?? [];
  if (!ids.length) {
    notify("warn", "Select an element whose category should be hidden");
    return 0;
  }
  const cats = new Set<string>();
  for (const id of ids) {
    const el = elements().find((e) => e.id === id);
    if (el) cats.add(elType(el));
  }
  let n = 0;
  for (const el of elements()) {
    if (cats.has(elType(el))) {
      try {
        if (a?.setTempHidden) a.setTempHidden(el.id, true);
        else if (el.properties) el.properties.tempHidden = true;
        n++;
      } catch { /* */ }
    }
  }
  try { a?.refreshVisibility?.(); } catch { /* */ }
  notify("success", `Hidden categories: ${[...cats].join(", ")} (${n} elements)`);
  return n;
}

/* 4 */ export function selectSimilarType(): number {
  const a = authoring();
  const ids: string[] = a?.getSelectedIds?.() ?? [];
  if (!ids.length) {
    notify("warn", "Select one element first");
    return 0;
  }
  const sample = elements().find((e) => e.id === ids[0]);
  if (!sample) return 0;
  const t = elType(sample);
  const match = elements().filter((e) => elType(e) === t).map((e) => e.id);
  try {
    if (a?.setSelection) a.setSelection(match);
    else if (a?.selectIds) a.selectIds(match);
  } catch { /* */ }
  notify("success", `Selected ${match.length} · type ${t}`);
  return match.length;
}

/* 5 */ export function selectByActiveLevel(): number {
  const a = authoring();
  let level: Any = a?.getLevel?.();
  const levels = a?.getLevels?.() ?? [];
  if (level != null && typeof level === "object") level = level.name ?? level.id ?? level.elevation;
  // typeof guard: level is typed Any, so a bare `level === ""` is a type
  // error (TS2367) — the runtime check is unchanged (true only for "").
  if ((level == null || (typeof level === "string" && level === "")) && levels[0]) {
    level = levels[0].name ?? levels[0].id ?? levels[0].elevation;
  }
  const key = String(level ?? "");
  const match = elements()
    .filter((e) => {
      const lv = elLevel(e);
      return lv === key || lv === String(level) || (e.params?.elevation != null && String(e.params.elevation) === key);
    })
    .map((e) => e.id);
  try {
    if (a?.setSelection) a.setSelection(match);
    else if (a?.selectIds) a.selectIds(match);
  } catch { /* */ }
  notify(match.length ? "success" : "warn", `Level “${key || "(none)"}”: ${match.length} element(s)`);
  return match.length;
}

/* 6 */ export function levelReport(): Any {
  const a = authoring();
  const levels = a?.getLevels?.() ?? [];
  const counts: Record<string, number> = {};
  for (const el of elements()) {
    const k = elLevel(el);
    counts[k] = (counts[k] || 0) + 1;
  }
  const report = {
    levels: levels.map((L: Any) => ({
      name: L.name ?? L.id,
      elevation: L.elevation,
    })),
    byLevel: counts,
  };
  console.log("[level-report]", report);
  const top = Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 5)
    .map(([k, v]) => `${k}:${v}`).join(", ");
  notify("info", `Levels defined: ${levels.length} · ${top || "no element level data"}`);
  return report;
}

/* 7 */ export function unitsReport(): Any {
  let report: Any = { system: "unknown" };
  try {
    // Units live on the locale service (ctx.features.units), not on a
    // window global — the old fallback global never had a producer, so this
    // always reported the "metric-ish" fallback. Config codes are the real unit
    // identifiers (length "m"/"mm"/"ft", area "m2"/"ft2", volume "m3"/"ft3").
    const svc = (ctx as Any).features?.units;
    const cfg = svc?.getConfig?.();
    report = {
      system: svc?.getSystem?.() ?? "metric-ish",
      length: cfg?.length ?? "m",
      area: cfg?.area ?? "m²",
      volume: cfg?.volume ?? "m³",
    };
  } catch {
    report = { system: "m (default)", length: "m" };
  }
  console.log("[units]", report);
  notify("info", `Units: ${report.system} · length ${report.length}`);
  return report;
}

/* 8 */ export async function quickRecoverySnapshot(): Promise<void> {
  try {
    const mod = await import("../../features/project-recovery");
    // Prefer journal save if exposed; otherwise open UI
    if (typeof (mod as Any).writeManualCheckpoint === "function") {
      await (mod as Any).writeManualCheckpoint("pack12-manual");
      notify("success", "Manual recovery checkpoint written");
      return;
    }
  } catch { /* */ }
  try {
    const store = await import("../projects/project-journal");
    if (typeof (store as Any).appendProjectSnapshot === "function") {
      // journal API varies — fall through to UI
    }
  } catch { /* */ }
  void import("../../features/project-recovery").then((m) => {
    m.showProjectRecovery?.();
    notify("info", "Open Recovery checkpoints — save the project to create a checkpoint");
  });
}

/* 9 */ export function linkedModelsSummary(): Any {
  const items: Any[] = [];
  try {
    const list = (ctx.fragments?.list ?? new Map()) as Map<string, Any>;
    for (const [id, m] of list) {
      items.push({
        id,
        name: m?.name ?? m?.guid ?? id,
        hasMesh: Boolean(m?.object || m?.meshes || m?.items),
      });
    }
  } catch { /* */ }
  try {
    const models = (ctx as Any).models || [];
    if (Array.isArray(models)) {
      for (const m of models) {
        items.push({ id: m.id, name: m.name, source: m.source || m.kind });
      }
    }
  } catch { /* */ }
  const report = { count: items.length, items };
  console.log("[linked-models]", report);
  notify("info", items.length ? `Linked models: ${items.length} (see console)` : "No linked models in the scene");
  return report;
}

/* 10 */ export function clearTempHiddenFlags(): number {
  return showAllElements();
}

export function setupCriticalWorkflowPack12(): void {
  const api = {
    isolateSelection,
    showAllElements,
    hideSelectedCategories,
    selectSimilarType,
    selectByActiveLevel,
    levelReport,
    unitsReport,
    quickRecoverySnapshot,
    linkedModelsSummary,
    clearTempHiddenFlags,
  };
  // The api is wired into ctx.features below — the internal surface. (A
  // window stash of the same api used to live here; nothing read it.)
  (ctx.features as Any).workflowPack12 = api;

  const cmds: Array<[string, string, () => void]> = [
    ["gap12-isolate", "View: Isolate selection", () => void isolateSelection()],
    ["gap12-show-all", "View: Show all elements", () => void showAllElements()],
    ["gap12-hide-cat", "View: Hide selected categories", () => void hideSelectedCategories()],
    ["gap12-sel-similar", "Select: Similar by type", () => void selectSimilarType()],
    ["gap12-sel-level", "Select: By active level", () => void selectByActiveLevel()],
    ["gap12-level-report", "Model: Level report", () => void levelReport()],
    ["gap12-units", "Project: Units report", () => void unitsReport()],
    ["gap12-snapshot", "Project: Recovery snapshot…", () => void quickRecoverySnapshot()],
    ["gap12-linked", "Model: Linked models summary", () => void linkedModelsSummary()],
    ["gap12-clear-temp", "View: Clear temporary hides", () => void clearTempHiddenFlags()],
  ];

  for (const [id, label, run] of cmds) {
    try {
      window.dispatchEvent(
        new CustomEvent("obs-register-command", { detail: { id, label, category: "Critical gaps", run } }),
      );
    } catch { /* */ }
  }

  void import("../../features/command-palette").then(({ registerCommand }) => {
    for (const [id, label, run] of cmds) {
      registerCommand({ id, label, category: "Critical gaps", run });
    }
  }).catch(() => { /* */ });

  console.log("[workflow-pack-12] 10 view/select/delivery commands ready");
}
