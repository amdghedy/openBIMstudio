/**
 * Options Registry — central place for app-level preferences.
 */
import { ctx } from "./context";
import { diagnostics } from "./diagnostics";

export type OptionType = "boolean" | "number" | "string" | "select";

export interface OptionBase {
  id: string;
  group: string;
  label: string;
  description?: string;
  type: OptionType;
  default: boolean | number | string;
  apply?: (value: any) => void;
}

export interface BooleanOption extends OptionBase {
  type: "boolean";
  default: boolean;
}
export interface NumberOption extends OptionBase {
  type: "number";
  default: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}
export interface StringOption extends OptionBase {
  type: "string";
  default: string;
  placeholder?: string;
}
export interface SelectOption extends OptionBase {
  type: "select";
  default: string;
  choices: Array<{ value: string; label: string }>;
}

export type OptionDef = BooleanOption | NumberOption | StringOption | SelectOption;

const STORAGE_KEY = "obs.options.v1";
const registry = new Map<string, OptionDef>();
const values = new Map<string, any>();
const listeners = new Set<(id: string, value: any) => void>();

function loadPersisted(): Record<string, any> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persist(): void {
  try {
    const out: Record<string, any> = {};
    for (const [id, v] of values) out[id] = v;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch (err) {
    diagnostics.warn("options.persist", "could not save options", err);
  }
}

function validate(def: OptionDef, v: any): boolean {
  switch (def.type) {
    case "boolean":
      return typeof v === "boolean";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "string":
      return typeof v === "string";
    case "select":
      return def.choices.some((c) => c.value === v);
  }
}

export function registerOption(def: OptionDef): void {
  if (registry.has(def.id)) {
    diagnostics.warn("options.register", `duplicate option id "${def.id}"`);
    return;
  }
  registry.set(def.id, def);
}

export function listOptions(group?: string): OptionDef[] {
  const all = [...registry.values()];
  return group ? all.filter((o) => o.group === group) : all;
}

export function getOption<T = any>(id: string): T {
  if (values.has(id)) return values.get(id) as T;
  const def = registry.get(id);
  if (!def) return undefined as any;
  const persisted = loadPersisted();
  const v =
    id in persisted && validate(def, persisted[id]) ? persisted[id] : def.default;
  values.set(id, v);
  return v as T;
}

export function setOption(id: string, value: any): void {
  const def = registry.get(id);
  if (!def) {
    diagnostics.warn("options.set", `unknown option "${id}"`);
    return;
  }
  if (!validate(def, value)) {
    diagnostics.warn("options.set", `invalid value for "${id}"`, value);
    return;
  }
  values.set(id, value);
  try {
    def.apply?.(value);
  } catch (err) {
    diagnostics.warn(`options.apply.${id}`, "apply threw", err);
  }
  persist();
  for (const l of listeners) {
    try {
      l(id, value);
    } catch {
      /* */
    }
  }
}

export function onOptionChanged(cb: (id: string, value: any) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function applyAllOptions(): void {
  for (const def of registry.values()) {
    const v = getOption(def.id);
    try {
      def.apply?.(v);
    } catch (err) {
      diagnostics.warn(`options.apply.${def.id}`, "apply threw", err);
    }
  }
}

let dialog: HTMLDivElement | null = null;
let currentGroup: string | null = null;

function ensureDialog(): HTMLDivElement {
  if (dialog) return dialog;
  dialog = document.createElement("div");
  dialog.id = "obs-options-dialog";
  dialog.style.cssText =
    "position:fixed;inset:0;z-index:9000;display:none;align-items:center;" +
    "justify-content:center;background:rgba(8,9,12,.55)";
  dialog.addEventListener("mousedown", (e) => {
    if (e.target === dialog) hideOptions();
  });

  const card = document.createElement("div");
  card.style.cssText =
    "width:min(760px,94vw);max-height:82vh;display:flex;flex-direction:column;" +
    "background:#1c1e28;border:1px solid #2a2e3a;border-radius:12px;" +
    "box-shadow:0 30px 80px rgba(0,0,0,.55);overflow:hidden;color:#e8eaf0;" +
    "font:12.5px system-ui,sans-serif";

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:12px 14px;" +
    "border-bottom:1px solid #1e2029;background:#181a23";
  header.innerHTML = `<span style="font-weight:700;font-size:14px;flex:1">Options</span>`;
  const close = document.createElement("button");
  close.textContent = "✕";
  close.style.cssText =
    "padding:4px 9px;background:transparent;color:#9ca3af;" +
    "border:1px solid #2a2e3a;border-radius:5px;cursor:pointer";
  close.onclick = () => hideOptions();
  header.appendChild(close);

  const body = document.createElement("div");
  body.style.cssText = "display:flex;flex:1;min-height:0";

  const sidebar = document.createElement("div");
  sidebar.dataset.role = "sidebar";
  sidebar.style.cssText =
    "width:200px;flex:none;border-right:1px solid #1e2029;padding:10px 6px;overflow-y:auto;background:#181a23";

  const content = document.createElement("div");
  content.dataset.role = "content";
  content.style.cssText = "flex:1;padding:14px 18px;overflow-y:auto";

  body.append(sidebar, content);
  card.append(header, body);
  dialog.appendChild(card);
  document.body.appendChild(dialog);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dialog?.style.display === "flex") hideOptions();
  });

  return dialog;
}

export function showOptions(group?: string): void {
  const d = ensureDialog();
  d.style.display = "flex";
  renderOptions(group);
}

export function hideOptions(): void {
  if (dialog) dialog.style.display = "none";
}

export function toggleOptions(): void {
  if (dialog?.style.display === "flex") hideOptions();
  else showOptions();
}

function renderOptions(group?: string): void {
  if (!dialog) return;
  const sidebar = dialog.querySelector('[data-role="sidebar"]') as HTMLElement;
  const content = dialog.querySelector('[data-role="content"]') as HTMLElement;
  if (!sidebar || !content) return;

  const groups = [...new Set(listOptions().map((o) => o.group))].sort();
  if (!currentGroup || (group && groups.includes(group))) {
    currentGroup = group ?? groups[0] ?? null;
  }

  sidebar.innerHTML = "";
  for (const g of groups) {
    const b = document.createElement("button");
    b.textContent = g;
    const active = g === currentGroup;
    b.style.cssText =
      "display:block;width:100%;padding:7px 10px;margin-bottom:2px;text-align:left;" +
      `background:${active ? "rgba(56,189,248,.14)" : "transparent"};` +
      `color:${active ? "#38bdf8" : "#e8eaf0"};border:none;border-radius:6px;cursor:pointer;font:inherit`;
    b.onclick = () => {
      currentGroup = g;
      renderOptions();
    };
    sidebar.appendChild(b);
  }

  content.innerHTML = "";
  if (!currentGroup) {
    content.innerHTML =
      `<div style="color:#6b7280;text-align:center;padding:40px">No options registered.</div>`;
    return;
  }

  for (const def of listOptions(currentGroup)) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:grid;grid-template-columns:1fr auto;gap:14px;align-items:start;" +
      "padding:10px 0;border-bottom:1px solid #1e2029";

    const labelWrap = document.createElement("div");
    const label = document.createElement("div");
    label.textContent = def.label;
    label.style.cssText = "font-weight:600";
    labelWrap.appendChild(label);
    if (def.description) {
      const desc = document.createElement("div");
      desc.textContent = def.description;
      desc.style.cssText = "font-size:11px;color:#6b7280;margin-top:3px;line-height:1.45";
      labelWrap.appendChild(desc);
    }

    const control = createControl(def);
    row.append(labelWrap, control);
    content.appendChild(row);
  }
}

function createControl(def: OptionDef): HTMLElement {
  const value = getOption(def.id);

  if (def.type === "boolean") {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!value;
    cb.style.cssText = "cursor:pointer;transform:scale(1.2);accent-color:#38bdf8";
    cb.onchange = () => setOption(def.id, cb.checked);
    return cb;
  }

  if (def.type === "number") {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;gap:6px;align-items:center";
    const inp = document.createElement("input");
    inp.type = "number";
    inp.value = String(value);
    if (def.min != null) inp.min = String(def.min);
    if (def.max != null) inp.max = String(def.max);
    if (def.step != null) inp.step = String(def.step);
    inp.style.cssText =
      "width:110px;padding:5px 8px;background:#0e1017;border:1px solid #2a2e3a;" +
      "border-radius:5px;color:#e8eaf0;font:inherit";
    inp.onchange = () => {
      const v = Number(inp.value);
      if (Number.isFinite(v)) setOption(def.id, v);
    };
    wrap.appendChild(inp);
    if (def.unit) {
      const u = document.createElement("span");
      u.textContent = def.unit;
      u.style.cssText = "font-size:11px;color:#6b7280";
      wrap.appendChild(u);
    }
    return wrap;
  }

  if (def.type === "string") {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = String(value);
    inp.style.cssText =
      "min-width:220px;padding:5px 8px;background:#0e1017;border:1px solid #2a2e3a;" +
      "border-radius:5px;color:#e8eaf0;font:inherit";
    inp.oninput = () => setOption(def.id, inp.value);
    return inp;
  }

  if (def.type === "select") {
    const sel = document.createElement("select");
    sel.style.cssText =
      "min-width:180px;padding:5px 8px;background:#0e1017;border:1px solid #2a2e3a;" +
      "border-radius:5px;color:#e8eaf0;font:inherit;cursor:pointer";
    for (const c of def.choices) {
      const opt = document.createElement("option");
      opt.value = c.value;
      opt.textContent = c.label;
      if (c.value === value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.onchange = () => setOption(def.id, sel.value);
    return sel;
  }

  return document.createElement("div");
}

export function setupOptions(): void {
  registerOption({
    id: "nav.smoothTime",
    group: "Navigation",
    label: "Camera smoothing",
    description: "Time constant for smoothing camera motion. Lower = snappier.",
    type: "number",
    default: 0.04,
    min: 0,
    max: 0.5,
    step: 0.01,
    unit: "s",
    apply: (v) => {
      try {
        const c: any = ctx.world?.camera?.controls;
        if (c && "smoothTime" in c) c.smoothTime = v;
      } catch {
        /* */
      }
    },
  });

  registerOption({
    id: "nav.draggingSmoothTime",
    group: "Navigation",
    label: "Drag smoothing",
    description: "Smoothing while dragging. Lower = more responsive.",
    type: "number",
    default: 0.02,
    min: 0,
    max: 0.5,
    step: 0.01,
    unit: "s",
    apply: (v) => {
      try {
        const c: any = ctx.world?.camera?.controls;
        if (c && "draggingSmoothTime" in c) c.draggingSmoothTime = v;
      } catch {
        /* */
      }
    },
  });

  registerOption({
    id: "nav.invertOrbit",
    group: "Navigation",
    label: "Invert orbit direction",
    type: "boolean",
    default: false,
    apply: () => {},
  });

  registerOption({
    id: "nav.wheelZoomMultiplier",
    group: "Navigation",
    label: "Wheel zoom multiplier",
    type: "number",
    default: 1,
    min: 0.25,
    max: 5,
    step: 0.25,
    apply: () => {},
  });

  registerOption({
    id: "diagnostics.showBadge",
    group: "Diagnostics",
    label: "Show warning badge",
    type: "boolean",
    default: true,
    apply: (v) => {
      const el = document.getElementById("obs-diag-badge");
      if (!el) return;
      if (!v) el.style.display = "none";
    },
  });

  applyAllOptions();

  (ctx.features as any).options = {
    show: showOptions,
    hide: hideOptions,
    toggle: toggleOptions,
    register: registerOption,
    list: listOptions,
    get: getOption,
    set: setOption,
    onChanged: onOptionChanged,
  };

  console.log("[options] ready");
}
