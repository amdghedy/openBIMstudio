/**
 * "Command:" line for the 2D plan, modelled on the CAD command line.
 * Pure DOM; all plan behaviour is supplied by the host so this file has no
 * dependency on plan-view-panel state.
 *
 *  - Type a command or alias and press Enter (WA, L, DI, Z, U, E ...).
 *  - Enter or Space on an empty line repeats the last command.
 *  - While a path is being drawn, "5,3", "@2,0", "4<30" or "2500" are
 *    direct coordinate / distance entry.
 *  - Up / Down walk the history, Tab completes, Esc cancels everything.
 */
import { PLAN_COMMANDS, resolveCommand, suggest, type PlanCommand } from "../modules/plan/plan-commands";

export interface PlanCmdHost {
  /** Run a command line (already non-empty). Returns a status message. */
  run(text: string): string | void;
  /** Try direct coordinate entry. Returns true when it was consumed. */
  point(text: string): boolean;
  /** True while a path / dimension is waiting for its next point. */
  isDrawing(): boolean;
  /** Prompt text for the current state, e.g. "WALL  Specify next point". */
  promptText(): string;
  /** Esc inside the line: cancel every active command. */
  cancelAll(): void;
}

export interface PlanCommandLine {
  el: HTMLElement;
  /** Focus the line, optionally seeding it with the first typed character. */
  focus(seed?: string): void;
  /** Refresh the prompt label from the host. */
  refresh(): void;
  isFocused(): boolean;
}

const HISTORY_KEY = "obs.plan.cmdHistory";

function loadHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string").slice(-50) : [];
  } catch { return []; }
}
function saveHistory(h: string[]): void {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-50))); } catch { /* storage unavailable */ }
}

export function createPlanCommandLine(host: PlanCmdHost): PlanCommandLine {
  const el = document.createElement("div");
  el.id = "obs-plan-cmdline";
  el.setAttribute("data-obs-ui", "plan-cmdline");
  el.style.cssText =
    "position:relative;display:flex;align-items:center;gap:8px;padding:4px 12px;flex:none;" +
    "background:var(--bg-surface,#12141b);border-top:1px solid var(--border-default,#2a2e3a);" +
    "font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text-primary,#e8eaf0)";

  const label = document.createElement("span");
  label.style.cssText = "color:#38bdf8;white-space:nowrap;max-width:46%;overflow:hidden;text-overflow:ellipsis";
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Plan command line");
  input.placeholder = "Type a command (WA wall, L line, DI dimension, Z zoom, U undo, ? help)";
  input.style.cssText =
    "flex:1;min-width:120px;background:transparent;border:0;outline:none;color:inherit;font:inherit;" +
    "caret-color:#38bdf8";
  const hint = document.createElement("div");
  hint.style.cssText =
    "position:absolute;left:12px;bottom:100%;display:none;max-width:520px;background:#0f172a;color:#e2e8f0;" +
    "border:1px solid #334155;border-radius:4px;padding:4px 0;box-shadow:0 6px 18px rgba(0,0,0,.35);z-index:5";
  el.append(label, input, hint);

  const history = loadHistory();
  let hIdx = history.length;
  let sugg: PlanCommand[] = [];
  let sel = 0;

  const refresh = () => {
    label.textContent = host.promptText() + " ›";
  };

  const hideHint = () => { hint.style.display = "none"; hint.textContent = ""; sugg = []; };
  const showHint = () => {
    sugg = input.value.trim() && !/\s/.test(input.value.trim()) ? suggest(input.value) : [];
    if (!sugg.length) { hideHint(); return; }
    if (sel >= sugg.length) sel = 0;
    hint.textContent = "";
    sugg.forEach((c, i) => {
      const row = document.createElement("div");
      row.style.cssText = `padding:2px 10px;white-space:nowrap;${i === sel ? "background:#1e3a5f" : ""}`;
      row.textContent = `${c.name}${c.aliases.length ? "  (" + c.aliases.join(", ") + ")" : ""} — ${c.description}`;
      row.onmousedown = (ev) => { ev.preventDefault(); input.value = c.name; hideHint(); input.focus(); };
      hint.appendChild(row);
    });
    hint.style.display = "block";
  };

  const leave = () => { input.value = ""; hideHint(); input.blur(); };

  const submit = () => {
    const text = input.value.trim();
    input.value = "";
    hideHint();
    hIdx = history.length;
    if (!text) { host.run("REPEAT"); refresh(); return; }
    if (history[history.length - 1] !== text) { history.push(text); saveHistory(history); }
    hIdx = history.length;
    if (host.isDrawing() && host.point(text)) { refresh(); return; }
    host.run(text);
    refresh();
  };

  input.addEventListener("input", () => { sel = 0; showHint(); });
  input.addEventListener("focus", refresh);
  input.addEventListener("keydown", (e) => {
    // Keys typed here belong to the line, not to the plan or the 3D view.
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); submit(); return; }
    if (e.key === "Escape") {
      e.preventDefault();
      leave();
      host.cancelAll(); // Esc always cancels active commands, like CAD
      refresh();
      return;
    }
    if (e.key === " " && !e.ctrlKey && !e.metaKey) {
      const t = input.value.trim();
      if (!t) { e.preventDefault(); submit(); return; }
      const r = resolveCommand(t);
      // Space ends a bare command word (CAD); ZOOM keeps waiting for its option.
      if (r && !r.arg && r.command.name !== "ZOOM" && !/\s$/.test(input.value)) { e.preventDefault(); submit(); return; }
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      if (sugg.length) {
        sel = (sel + (e.key === "ArrowDown" ? 1 : sugg.length - 1)) % sugg.length;
        showHint();
        return;
      }
      if (!history.length) return;
      hIdx = Math.min(history.length, Math.max(0, hIdx + (e.key === "ArrowUp" ? -1 : 1)));
      input.value = history[hIdx] ?? "";
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (sugg.length) { input.value = sugg[sel].name + " "; hideHint(); }
    }
  });
  input.addEventListener("keyup", (e) => e.stopPropagation());
  input.addEventListener("blur", () => setTimeout(hideHint, 120));

  refresh();
  return {
    el,
    focus(seed) {
      input.focus();
      if (seed) { input.value += seed; showHint(); }
      refresh();
    },
    refresh,
    isFocused: () => document.activeElement === input,
  };
}

/** Plain-text help listing, grouped, for the HELP command. */
export function planHelpRows(): string[][] {
  return PLAN_COMMANDS.map((c) => [c.group, c.name, c.aliases.join(", "), c.description]);
}
