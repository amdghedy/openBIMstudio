/**
 * Space-aware entity-add targeting (AutoCAD 2D parity A9 — DWG geometry-baking fix).
 *
 * The A8+A19 DWG loop showed QSAVE writing 24 LINE records for an 8-LINE
 * drawing after a DWG re-import while a paper layout was on screen, with the
 * dimension text tripled. The node probe (writer -> WASM converter ->
 * parseWithAcadEngine) came back clean — the reader, the converter's document
 * model and the writer are exonerated — so the baking happened in the viewer:
 * `addEntities` pushed every incoming entity into BOTH the current space's
 * list and `modelEnts`, with no space guard. Its sibling `addDraftEntity`
 * has always carried `layoutI < 0` on the mirror push (the mirror exists only
 * so a model-space `ents` rebound by UNDO / DRAWORDER stays in sync with
 * `modelEnts`); `addEntities` never got the guard. A paper-space add must
 * never touch the model list, and an import merge must land its model
 * entities in the model list even when a sheet is on screen.
 *
 * Pure: no DOM, no storage. The viewer uses these lists; the lists themselves
 * are the viewer's live arrays, mutated in place.
 */

/** The lists an add lands in, given the space on screen (`space` < 0 = model). */
export function addTargets<T>(space: number, model: T[], current: T[]): T[][] {
  const targets: T[][] = [current];
  // Model space only, and only when `current` was rebound away from the
  // model list (UNDO / DRAWORDER rebind `ents`): in paper space the lists
  // differ and the model list must NOT get the push — that was the baking.
  if (space < 0 && model !== current) targets.push(model);
  return targets;
}

/** Push `list` into every target list (mutates the targets). */
export function pushToTargets<T>(targets: T[][], list: readonly T[]): void {
  for (const t of targets) for (const e of list) t.push(e);
}

/**
 * The lists an import merge lands in: incoming entities are MODEL entities,
 * so they always land in the model list — even when a paper layout is on
 * screen (where `addTargets` would put them in the sheet instead).
 */
export function mergeTargets<T>(model: T[]): T[][] {
  return [model];
}
