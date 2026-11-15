/**
 * Advanced AutoCAD-style features for the browser 2D engine:
 * sheet sets, nested XREF registry, minimal LISP runner, dynamic-block states.
 */
export interface SheetSetSheet {
  id: string;
  name: string;
  layoutName?: string;
  drawingFile?: string;
  number?: string;
  title?: string;
}

export interface SheetSet {
  name: string;
  sheets: SheetSetSheet[];
  updatedAt: number;
}

const SHEETSET_KEY = "obs.cad.sheetSet.v1";

export function loadSheetSet(): SheetSet {
  try {
    const raw = localStorage.getItem(SHEETSET_KEY);
    if (raw) return JSON.parse(raw) as SheetSet;
  } catch { /* */ }
  return { name: "Project Sheets", sheets: [], updatedAt: Date.now() };
}

export function saveSheetSet(ss: SheetSet): void {
  ss.updatedAt = Date.now();
  try { localStorage.setItem(SHEETSET_KEY, JSON.stringify(ss)); } catch { /* */ }
}

export function addSheet(ss: SheetSet, name: string, layoutName?: string): SheetSetSheet {
  const sheet: SheetSetSheet = {
    id: `S${Date.now().toString(36)}`,
    name,
    layoutName,
    number: String(ss.sheets.length + 1).padStart(2, "0"),
  };
  ss.sheets.push(sheet);
  saveSheetSet(ss);
  return sheet;
}

/** Nested XREF path registry (metadata; geometry still via attach). */
export interface XrefNode {
  name: string;
  path: string;
  parent?: string;
  nested: string[];
  status: "loaded" | "unloaded" | "missing";
}

export class XrefManager {
  nodes = new Map<string, XrefNode>();
  add(name: string, path: string, parent?: string): void {
    this.nodes.set(name, {
      name,
      path,
      parent,
      nested: [],
      status: "loaded",
    });
    if (parent && this.nodes.has(parent)) {
      this.nodes.get(parent)!.nested.push(name);
    }
  }
  detach(name: string): string[] {
    const removed = [name];
    const node = this.nodes.get(name);
    if (node) {
      for (const c of [...node.nested]) removed.push(...this.detach(c));
      this.nodes.delete(name);
    }
    for (const n of this.nodes.values()) {
      n.nested = n.nested.filter((x) => x !== name);
    }
    return removed;
  }
  list(): XrefNode[] {
    return [...this.nodes.values()];
  }
}

/** Dynamic block: visibility states only (stretch/flip later). */
export interface DynBlockState {
  name: string;
  visibleLayers: string[]; // entity layer filters or tags
}

export interface DynBlockDef {
  blockName: string;
  states: DynBlockState[];
  current: string;
}

export class DynBlockStore {
  private map = new Map<string, DynBlockDef>();
  define(blockName: string, states: DynBlockState[]): void {
    this.map.set(blockName.toLowerCase(), {
      blockName,
      states,
      current: states[0]?.name ?? "Default",
    });
  }
  setState(blockName: string, state: string): boolean {
    const d = this.map.get(blockName.toLowerCase());
    if (!d) return false;
    if (!d.states.some((s) => s.name === state)) return false;
    d.current = state;
    return true;
  }
  get(blockName: string): DynBlockDef | undefined {
    return this.map.get(blockName.toLowerCase());
  }
}

/**
 * Minimal AutoLISP-like runner: (command "LINE" ...) (setq) (princ) only.
 * Not a real LISP — enough for short automation macros.
 */
export function runMinimalLisp(
  source: string,
  execCommand: (line: string) => void,
): string[] {
  const log: string[] = [];
  const vars = new Map<string, string>();
  const text = source.replace(/;.*$/gm, "").trim();
  // Match (command "FOO" "arg" ...)
  const cmdRe = /\(\s*command\s+((?:"[^"]*"|\s+)+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = cmdRe.exec(text))) {
    const args = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    if (!args.length) continue;
    const line = args.join(" ");
    log.push(`→ ${line}`);
    try {
      execCommand(line);
    } catch (e) {
      log.push(`! ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const setqRe = /\(\s*setq\s+([A-Za-z_][\w]*)\s+"([^"]*)"\s*\)/gi;
  while ((m = setqRe.exec(text))) {
    vars.set(m[1], m[2]);
    log.push(`setq ${m[1]} = "${m[2]}"`);
  }
  if (/\(\s*princ\s*\)/i.test(text)) log.push(vars.size ? JSON.stringify(Object.fromEntries(vars)) : "");
  if (!log.length) log.push("LISP: no (command ...) forms found. Example: (command \"CIRCLE\")");
  return log;
}
