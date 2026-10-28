/**
 * Pure model of the viewport context menu. No DOM, no app imports: every action is injected, so
 * the structure (what is offered, in what order, and when it is disabled) can be unit-tested.
 */
export type MenuItem =
  | { type: "sep" }
  | { type: "label"; text: string }
  | { type: "action"; text: string; icon?: string; kbd?: string; title?: string; onclick: () => void; disabled?: boolean; checked?: boolean; danger?: boolean }
  | { type: "sub"; text: string; icon?: string; items: MenuItem[]; disabled?: boolean };

export interface ModifyDef { id: string; label: string; icon?: string; shortcut?: string; needsSelection?: boolean; needsMulti?: boolean; danger?: boolean }

export interface MenuDeps {
  authoredCount: number;
  linkedCount: number;
  clipboardCount: number;
  modifyDefs: ModifyDef[];
  activeModifyTool: (id: string) => boolean;
  runModify: (id: string) => void;
  /** Run a registered BIM command (view.*, review.*, global.*, modify.*). */
  command: (id: string) => void;
  hasCommand: (id: string) => boolean;
  openDialog: (kind: "move" | "rotate" | "array" | "mirror") => void;
  setTool: (tool: string) => void;
  copyToClipboard: () => void;
  makeNativeTwin: () => void;
  openProperties: () => void;
}

const bySel = (d: ModifyDef, n: number, clip: number): boolean =>
  d.id === "paste" ? clip > 0 : d.needsMulti ? n >= 2 : d.needsSelection ? n >= 1 : true;

export const CREATE_TOOLS: Array<[string, string, string]> = [
  ["wall", "Wall", "▭"], ["column", "Column", "▮"], ["beam", "Beam", "▬"], ["slab", "Slab / Floor", "▱"],
  ["door", "Door", "▯"], ["window", "Window", "▫"], ["footing", "Footing", "◫"],
  ["pipe", "Pipe", "┅"], ["duct", "Duct", "▤"], ["cable-tray", "Cable Tray", "☰"], ["conduit", "Conduit", "═"],
  ["equipment", "Equipment", "▣"], ["fitting", "Fitting", "◇"],
];

/** Modify flyout groups: [heading, action ids]. Order is the order shown. */
export const MODIFY_GROUPS: Array<[string, string[]]> = [
  ["TRANSFORM", ["move", "copy", "rotate", "mirror", "scale", "array", "offset"]],
  ["EDIT", ["@trim", "split-mid", "join-walls", "align-x", "align-z"]],
  ["CREATE & MATCH", ["create-similar", "match-props", "select-similar"]],
  ["CLIPBOARD", ["@clipcopy", "paste"]],
  ["CONSTRAINTS", ["pin", "unpin"]],
];

export function buildModifyFlyout(d: MenuDeps): MenuItem[] {
  const out: MenuItem[] = [];
  const n = d.authoredCount;
  const defs = new Map(d.modifyDefs.map((x) => [x.id, x]));
  const noSel = n === 0 ? "Select an authored element first" : undefined;
  const fromDef = (id: string): MenuItem | null => {
    const df = defs.get(id); if (!df) return null;
    const ok = bySel(df, n, d.clipboardCount);
    return { type: "action", text: df.label, icon: df.icon, kbd: df.shortcut, onclick: () => d.runModify(id), disabled: !ok,
      checked: d.activeModifyTool(id), title: ok ? undefined : (df.needsMulti ? "Select two or more elements" : id === "paste" ? "Clipboard is empty" : noSel) };
  };
  for (const [heading, ids] of MODIFY_GROUPS) {
    const rows: MenuItem[] = [];
    for (const id of ids) {
      if (id === "@trim") {
        if (d.hasCommand("modify.trimExtend")) rows.push({ type: "action", text: "Trim / Extend to Corner", icon: "⌐", kbd: "TR", disabled: n < 2, title: n < 2 ? "Select two line elements" : undefined, onclick: () => d.command("modify.trimExtend") });
      } else if (id === "@clipcopy") {
        rows.push({ type: "action", text: "Copy to Clipboard", icon: "⎘", kbd: "Ctrl+C", disabled: n < 1, title: noSel, onclick: d.copyToClipboard });
      } else { const it = fromDef(id); if (it) rows.push(it); }
    }
    if (rows.length) { out.push({ type: "label", text: heading }, ...rows); }
  }
  // Numeric (dialog) versions of the transforms
  out.push({ type: "label", text: "PRECISE (ENTER VALUES)" });
  for (const [k, t, ic] of [["move", "Move…", "✥"], ["rotate", "Rotate…", "↻"], ["mirror", "Mirror…", "▦"], ["array", "Array…", "⊞"]] as const) {
    out.push({ type: "action", text: t, icon: ic, disabled: n < 1, title: noSel, onclick: () => d.openDialog(k) });
  }
  const del = defs.get("delete");
  if (del) { out.push({ type: "sep" }); const it = fromDef("delete"); if (it && it.type === "action") out.push({ ...it, danger: true }); }
  return out;
}

export function buildContextMenu(d: MenuDeps): MenuItem[] {
  const items: MenuItem[] = [];
  const total = d.authoredCount + d.linkedCount;
  if (d.authoredCount > 0) items.push({ type: "label", text: `Authored: ${d.authoredCount} element(s)` });
  else if (d.linkedCount > 0) items.push({ type: "label", text: `Selection: ${d.linkedCount} item(s)` });

  const cmd = (id: string, text: string, icon?: string, kbd?: string, disabled = false): MenuItem | null =>
    d.hasCommand(id) ? { type: "action", text, icon, kbd, disabled, onclick: () => d.command(id) } : null;
  const push = (...xs: Array<MenuItem | null>) => { for (const x of xs) if (x) items.push(x); };

  push(cmd("global.cancel", "Cancel", "✕", "Esc"), cmd("global.repeat", "Repeat Last Command", "↺", "Space"));
  items.push({ type: "sep" });

  items.push({ type: "sub", text: "Modify", icon: "✎", items: buildModifyFlyout(d) });

  items.push({
    type: "sub", text: "Create", icon: "＋",
    items: [{ type: "label", text: "BUILD" }, ...CREATE_TOOLS.map(([id, text, icon]): MenuItem => ({ type: "action", text, icon, onclick: () => d.setTool(id) }))],
  });

  const view: MenuItem[] = [];
  for (const [id, t, k] of [["view.fit", "Zoom to Fit", "ZF"], ["review.focus", "Zoom to Selection", "ZS"], ["view.home", "Default 3D View", ""], ["view.top", "Top / Plan", ""], ["view.front", "Front Elevation", ""], ["view.ortho", "Orthographic", ""], ["view.perspective", "Perspective", ""]] as const) {
    const c = cmd(id, t, undefined, k || undefined, id === "review.focus" && total === 0); if (c) view.push(c);
  }
  if (view.length) items.push({ type: "sub", text: "View", icon: "◉", items: view });

  const vis: MenuItem[] = [];
  for (const [id, t] of [["review.isolate", "Temporary Isolate"], ["review.hide", "Temporary Hide"], ["review.reveal", "Reveal Hidden Elements"]] as const) {
    const c = cmd(id, t, undefined, undefined, id !== "review.reveal" && total === 0); if (c) vis.push(c);
  }
  if (vis.length) items.push({ type: "sub", text: "Visibility", icon: "◐", items: vis });

  const sel: MenuItem[] = [];
  push2(sel, cmd("global.selectAll", "Select All", undefined, "Ctrl+A"));
  sel.push({ type: "action", text: "Select Similar", disabled: d.authoredCount < 1, onclick: () => d.runModify("select-similar") });
  push2(sel, cmd("global.clearSelection", "Clear Selection", undefined, undefined, total === 0));
  items.push({ type: "sub", text: "Select", icon: "▢", items: sel });

  items.push({ type: "sep" });
  items.push({ type: "action", text: "Make Editable Native Twin", icon: "⇪", disabled: total === 0, onclick: d.makeNativeTwin });
  items.push({ type: "action", text: "Properties", icon: "ⓘ", disabled: total === 0, onclick: d.openProperties });
  push(cmd("modify.typeProperties", "Type Properties", undefined, undefined, d.authoredCount === 0));
  items.push({ type: "sep" });
  push(cmd("global.undo", "Undo", "↶", "Ctrl+Z"), cmd("global.redo", "Redo", "↷", "Ctrl+Y"));
  return items;
}
function push2(arr: MenuItem[], x: MenuItem | null) { if (x) arr.push(x); }
