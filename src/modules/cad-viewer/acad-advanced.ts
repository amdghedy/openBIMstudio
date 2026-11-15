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



/* ── Nested XREF binary cache (IndexedDB-backed when available) ── */

const XREF_CACHE_DB = "obs-cad-xref-cache";
const XREF_CACHE_STORE = "files";

function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(XREF_CACHE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(XREF_CACHE_STORE)) db.createObjectStore(XREF_CACHE_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function xrefCachePut(key: string, bytes: ArrayBuffer, meta: { path: string; parent?: string }): Promise<void> {
  const db = await idb();
  if (!db) {
    try {
      const b64 = btoa(String.fromCharCode(...new Uint8Array(bytes.slice(0, Math.min(bytes.byteLength, 2_000_000)))));
      localStorage.setItem(`obs.xref.${key}`, JSON.stringify({ ...meta, b64, truncated: bytes.byteLength > 2_000_000 }));
    } catch { /* quota */ }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(XREF_CACHE_STORE, "readwrite");
    tx.objectStore(XREF_CACHE_STORE).put({ bytes, ...meta, at: Date.now() }, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function xrefCacheGet(key: string): Promise<{ bytes: ArrayBuffer; path: string; parent?: string } | null> {
  const db = await idb();
  if (!db) {
    try {
      const raw = localStorage.getItem(`obs.xref.${key}`);
      if (!raw) return null;
      const o = JSON.parse(raw);
      const bin = Uint8Array.from(atob(o.b64), (c) => c.charCodeAt(0));
      return { bytes: bin.buffer, path: o.path, parent: o.parent };
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    const tx = db.transaction(XREF_CACHE_STORE, "readonly");
    const req = tx.objectStore(XREF_CACHE_STORE).get(key);
    req.onsuccess = () => {
      const v = req.result;
      if (!v?.bytes) resolve(null);
      else resolve({ bytes: v.bytes, path: v.path, parent: v.parent });
    };
    req.onerror = () => resolve(null);
  });
}

export async function xrefCacheDelete(key: string): Promise<void> {
  const db = await idb();
  if (!db) {
    try { localStorage.removeItem(`obs.xref.${key}`); } catch { /* */ }
    return;
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(XREF_CACHE_STORE, "readwrite");
    tx.objectStore(XREF_CACHE_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/* ── Dynamic blocks: stretch + flip actions ── */

export type DynAction =
  | { type: "visibility"; state: string; layers: string[] }
  | { type: "stretch"; dx: number; dy: number; tags?: string[] }
  | { type: "flip"; axis: "x" | "y"; tags?: string[] };

export interface DynBlockRich {
  blockName: string;
  states: string[];
  current: string;
  actions: DynAction[];
  /** Base entities cloned when applying actions (optional in-memory). */
  baseEntities?: unknown[];
}

export function applyDynActionsToPoints(
  points: Array<{ x: number; y: number }>,
  actions: DynAction[],
  state: string,
): Array<{ x: number; y: number }> {
  let pts = points.map((p) => ({ ...p }));
  for (const a of actions) {
    if (a.type === "stretch") {
      pts = pts.map((p) => ({ x: p.x + a.dx, y: p.y + a.dy }));
    } else if (a.type === "flip") {
      if (a.axis === "x") pts = pts.map((p) => ({ x: -p.x, y: p.y }));
      else pts = pts.map((p) => ({ x: p.x, y: -p.y }));
    }
  }
  void state;
  return pts;
}

export function defineDynBlockStretchFlip(
  store: DynBlockStore,
  blockName: string,
  opts: { stretch?: { dx: number; dy: number }; flip?: "x" | "y"; states?: string[] },
): DynBlockRich {
  const states = opts.states ?? ["Default", "Stretched", "Flipped"];
  store.define(
    blockName,
    states.map((name) => ({ name, visibleLayers: ["*"] })),
  );
  const actions: DynAction[] = [];
  if (opts.stretch) actions.push({ type: "stretch", dx: opts.stretch.dx, dy: opts.stretch.dy });
  if (opts.flip) actions.push({ type: "flip", axis: opts.flip });
  const rich: DynBlockRich = {
    blockName,
    states,
    current: "Default",
    actions,
  };
  try {
    localStorage.setItem(`obs.dynblock.${blockName.toLowerCase()}`, JSON.stringify(rich));
  } catch { /* */ }
  return rich;
}

export function loadDynBlockRich(blockName: string): DynBlockRich | null {
  try {
    const raw = localStorage.getItem(`obs.dynblock.${blockName.toLowerCase()}`);
    return raw ? (JSON.parse(raw) as DynBlockRich) : null;
  } catch {
    return null;
  }
}

/* ── Richer LISP subset ── */

export type LispVal = number | string | boolean | LispVal[] | null;

function tokenizeLisp(src: string): string[] {
  const s = src.replace(/;.*$/gm, " ");
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")") { tokens.push(c); i++; continue; }
    if (c === '"') {
      let j = i + 1, out = "";
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length) { out += s[j + 1]; j += 2; continue; }
        out += s[j++];
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s|[()]/.test(s[j])) j++;
    tokens.push(s.slice(i, j));
    i = j;
  }
  return tokens;
}

function parseLisp(tokens: string[]): { expr: LispVal; rest: string[] } {
  if (!tokens.length) return { expr: null, rest: [] };
  const t = tokens[0];
  if (t === "(") {
    const list: LispVal[] = [];
    let rest = tokens.slice(1);
    while (rest.length && rest[0] !== ")") {
      const r = parseLisp(rest);
      list.push(r.expr);
      rest = r.rest;
    }
    return { expr: list, rest: rest.slice(1) };
  }
  if (t === ")") return { expr: null, rest: tokens.slice(1) };
  if (t.startsWith('"') && t.endsWith('"')) return { expr: t.slice(1, -1), rest: tokens.slice(1) };
  if (t === "t" || t === "T") return { expr: true, rest: tokens.slice(1) };
  if (t === "nil" || t === "NIL") return { expr: null, rest: tokens.slice(1) };
  const n = Number(t);
  if (!Number.isNaN(n) && /^-?\d/.test(t)) return { expr: n, rest: tokens.slice(1) };
  return { expr: t, rest: tokens.slice(1) }; // symbol
}

export function runLispProgram(
  source: string,
  host: {
    command: (args: string[]) => void;
    getvar?: (name: string) => LispVal;
    setvar?: (name: string, v: LispVal) => void;
  },
): string[] {
  const log: string[] = [];
  const env = new Map<string, LispVal>();
  const defuns = new Map<string, { params: string[]; body: LispVal[] }>();

  function evalExpr(expr: LispVal): LispVal {
    if (expr === null || typeof expr === "number" || typeof expr === "boolean") return expr;
    if (typeof expr === "string") {
      if (env.has(expr)) return env.get(expr)!;
      return expr;
    }
    if (!Array.isArray(expr) || !expr.length) return null;
    const [op, ...args] = expr;
    const opName = typeof op === "string" ? op.toLowerCase() : "";

    if (opName === "quote") return args[0] ?? null;
    if (opName === "setq") {
      const name = String(args[0]);
      const val = evalExpr(args[1]);
      env.set(name, val);
      return val;
    }
    if (opName === "defun") {
      const name = String(args[0]).toLowerCase();
      const params = Array.isArray(args[1]) ? args[1].map(String) : [];
      defuns.set(name, { params, body: args.slice(2) });
      log.push(`defun ${name}`);
      return name;
    }
    if (opName === "if") {
      const cond = evalExpr(args[0]);
      return cond ? evalExpr(args[1]) : evalExpr(args[2] ?? null);
    }
    if (opName === "while") {
      let n = 0;
      while (evalExpr(args[0]) && n++ < 1000) {
        for (const b of args.slice(1)) evalExpr(b);
      }
      return null;
    }
    if (opName === "progn" || opName === "list") {
      let last: LispVal = null;
      for (const a of args) last = opName === "list" ? args.map(evalExpr) as LispVal : evalExpr(a);
      return opName === "list" ? (args.map(evalExpr) as LispVal) : last;
    }
    if (opName === "command") {
      const strs = args.map((a) => {
        const v = evalExpr(a);
        return v == null ? "" : String(v);
      });
      log.push(`command ${strs.join(" ")}`);
      host.command(strs);
      return null;
    }
    if (opName === "getvar") {
      const name = String(evalExpr(args[0]));
      return host.getvar?.(name) ?? env.get(name) ?? null;
    }
    if (opName === "setvar") {
      const name = String(evalExpr(args[0]));
      const val = evalExpr(args[1]);
      host.setvar?.(name, val);
      env.set(name, val);
      return val;
    }
    if (opName === "+" || opName === "-" || opName === "*" || opName === "/") {
      const nums = args.map((a) => Number(evalExpr(a)) || 0);
      if (opName === "+") return nums.reduce((x, y) => x + y, 0);
      if (opName === "*") return nums.reduce((x, y) => x * y, 1);
      if (opName === "-") return nums.length === 1 ? -nums[0] : nums.reduce((x, y) => x - y);
      return nums.reduce((x, y) => (y === 0 ? x : x / y));
    }
    if (opName === "=" || opName === "eq" || opName === "equal") {
      return evalExpr(args[0]) === evalExpr(args[1]);
    }
    if (opName === "<") return Number(evalExpr(args[0])) < Number(evalExpr(args[1]));
    if (opName === ">") return Number(evalExpr(args[0])) > Number(evalExpr(args[1]));
    if (opName === "strcat") return args.map((a) => String(evalExpr(a) ?? "")).join("");
    if (opName === "strlen") return String(evalExpr(args[0]) ?? "").length;
    if (opName === "car") {
      const v = evalExpr(args[0]);
      return Array.isArray(v) ? v[0] ?? null : null;
    }
    if (opName === "cdr") {
      const v = evalExpr(args[0]);
      return Array.isArray(v) ? v.slice(1) : null;
    }
    if (opName === "princ" || opName === "print" || opName === "prompt") {
      const v = args.length ? evalExpr(args[0]) : null;
      log.push(v == null ? "" : String(v));
      return v;
    }
    if (opName === "not") return !evalExpr(args[0]);
    if (opName === "and") return args.every((a) => !!evalExpr(a));
    if (opName === "or") return args.some((a) => !!evalExpr(a));

    // user defun
    if (defuns.has(opName)) {
      const fn = defuns.get(opName)!;
      const saved = new Map(env);
      fn.params.forEach((p, i) => env.set(p, evalExpr(args[i] ?? null)));
      let last: LispVal = null;
      for (const b of fn.body) last = evalExpr(b);
      env.clear();
      saved.forEach((v, k) => env.set(k, v));
      return last;
    }

    log.push(`unknown form: ${opName}`);
    return null;
  }

  try {
    const tokens = tokenizeLisp(source);
    let rest = tokens;
    while (rest.length) {
      if (rest[0] !== "(" && rest[0] !== ")") {
        rest = rest.slice(1);
        continue;
      }
      const { expr, rest: r } = parseLisp(rest);
      rest = r;
      if (expr != null) evalExpr(expr);
    }
  } catch (e) {
    log.push(`LISP error: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!log.length) log.push("LISP: done.");
  return log;
}
