/**
 * SVG icon set for the ribbon.
 *
 * Every icon is a `<svg>` string with `stroke="currentColor"` so it inherits
 * the button color and hover/active states. No emoji, no font dependency.
 *
 * Each path is designed on a 24×24 grid, drawn with a 1.8 px stroke.
 * All icons are visually distinct — no two glyphs are identical, even where
 * the underlying concept is similar (e.g. view directions).
 */
export type IconName =
  // App / file
  | "menu" | "home" | "save" | "file" | "file-frag" | "folder" | "folder-recent"
  | "new-file" | "new-family" | "new-sheet" | "print" | "settings" | "close"
  | "issues" | "bcf" | "glb" | "csv" | "cost-takeoff"
  // Build
  | "wall" | "floor" | "roof" | "column" | "beam" | "component" | "ceiling"
  | "brace" | "truss" | "footing" | "strip" | "slab" | "equipment"
  // Openings
  | "door" | "window" | "opening" | "shaft"
  | "circle"
  // MEP
  | "duct" | "duct-fitting" | "air-terminal" | "flex-duct" | "duct-accessory"
  | "pipe" | "pipe-fitting" | "pipe-accessory" | "plumbing-fixture"
  | "sprinkler" | "sprinkler-main" | "fire-pump"
  | "cable-tray" | "cable-tray-fitting" | "conduit" | "conduit-fitting"
  | "wire" | "panel" | "switch" | "outlet" | "junction-box"
  | "lighting-fixture" | "emergency-light" | "lighting-switch"
  | "transformer" | "generator"
  // Structure
  | "rebar" | "area-rebar" | "path-rebar" | "rebar-cover"
  | "connection" | "plate" | "anchor" | "pile"
  // Circulation
  | "stairs" | "railing" | "ramp"
  // Datum
  | "grid" | "level" | "ref-plane"
  // Room
  | "room" | "area" | "room-tag"
  // Modify
  | "move" | "copy" | "rotate" | "mirror" | "array" | "offset"
  | "delete" | "clear" | "isolate" | "show-all" | "select-all"
  // View
  | "perspective" | "orthographic" | "fit"
  | "top" | "bottom" | "front" | "back" | "right" | "left"
  | "iso-ne" | "iso-nw" | "iso-se" | "iso-sw"
  | "viewcube" | "bounds" | "camera" | "walk"
  // Panels
  | "tree" | "plan" | "schedules" | "ids" | "cost" | "tools-panel"
  // Clash / Coordinate
  | "measure" | "section" | "clash" | "interference" | "clearance"
  | "crop-shrink" | "crop-expand" | "crop-reset" | "crop-remove"
  | "origin" | "recenter" | "reset-offsets" | "refresh"
  | "publish-coords" | "acquire-coords" | "specify-coords"
  // Annotation
  | "dim-aligned" | "dim-linear" | "dim-angular" | "dim-radial" | "arc-length"
  | "spot-elev" | "spot-coord"
  | "detail-line" | "detail-component" | "filled-region" | "masking-region"
  | "insulation" | "revision-cloud"
  | "text" | "model-text" | "tag" | "tag-all" | "material-tag" | "symbol" | "color-legend"
  // Reports
  | "report" | "check" | "energy" | "compare" | "schedule" | "quantification"
  // Massing & Site
  | "mass" | "mass-floor" | "toposurface" | "building-pad" | "property-line"
  | "site-component" | "parking" | "graded-region" | "subregion" | "split-surface" | "site-settings"
  // System
| "undo" | "mline" | "modify" | "view"
    | "system";

const PATHS: Record<IconName, string> = {
  // ── App / file ──────────────────────────────────────────────────────
  menu: `<path d="M4 7h16M4 12h16M4 17h16"/>`,
  home: `<path d="M4 11 L12 4 L20 11 M6 10 V20 H18 V10"/>`,
  save: `<path d="M5 5 H17 L19 7 V19 H5 Z"/><path d="M9 5 V9 H15 V5"/><path d="M9 19 V13 H15 V19"/>`,
  file: `<path d="M6 3 H15 L19 7 V21 H6 Z"/><path d="M15 3 V7 H19"/>`,
  "file-frag": `<path d="M6 3 H15 L19 7 V21 H6 Z"/><path d="M15 3 V7 H19"/><path d="M9 12 L12 9 L15 12 L12 15 Z"/>`,
  folder: `<path d="M3 6 H10 L12 8 H21 V19 H3 Z"/>`,
  "folder-recent": `<path d="M3 6 H10 L12 8 H21 V19 H3 Z"/><path d="M12 11 V14 L14 15"/>`,
  "new-file": `<path d="M6 3 H15 L19 7 V21 H6 Z"/><path d="M15 3 V7 H19"/><path d="M11 12 H14 M12 10.5 V13.5"/>`,
  "new-family": `<path d="M9 3 H15 L18 6 V15 H6 V6 Z"/><path d="M9 3 V6 H15 V3"/><circle cx="12" cy="18" r="3"/>`,
  "new-sheet": `<rect x="5" y="4" width="14" height="16" rx="1"/><path d="M8 8 H16 M8 12 H16 M8 16 H12"/>`,
  print: `<path d="M7 9 V4 H17 V9"/><rect x="4" y="9" width="16" height="8" rx="1"/><path d="M7 15 H17 V21 H7 Z"/>`,
  settings: `<circle cx="12" cy="12" r="3"/><path d="M12 3 V6 M12 18 V21 M3 12 H6 M18 12 H21 M5 5 L7 7 M17 17 L19 19 M5 19 L7 17 M17 7 L19 5"/>`,
  close: `<path d="M6 6 L18 18 M18 6 L6 18"/>`,
  issues: `<path d="M4 5 H20 V17 H12 L7 21 V17 H4 Z"/><path d="M12 9 V13 M12 15 V15.01"/>`,
  bcf: `<path d="M5 5 H19 V19 H5 Z"/><path d="M9 9 H15 M9 12 H15 M9 15 H12"/>`,
  glb: `<path d="M12 3 L20 7 V17 L12 21 L4 17 V7 Z"/><path d="M4 7 L12 11 L20 7 M12 11 V21"/>`,
  csv: `<path d="M5 4 H19 V20 H5 Z"/><path d="M8 9 H16 M8 13 H16 M8 17 H12"/>`,
  "cost-takeoff": `<rect x="5" y="5" width="14" height="14"/><circle cx="12" cy="12" r="3"/>`,

  // ── Build ───────────────────────────────────────────────────────────
  wall: `<rect x="3" y="6" width="18" height="12"/><path d="M3 10 H21 M3 14 H21 M7 6 V10 M11 10 V14 M15 14 V18 M19 10 V14"/>`,
  floor: `<path d="M3 15 L12 20 L21 15 L12 10 Z"/>`,
  roof: `<path d="M3 14 L12 5 L21 14"/><path d="M6 12 V18 H18 V12"/>`,
  column: `<rect x="9" y="4" width="6" height="16"/><path d="M6 20 H18 M6 4 H18"/>`,
  beam: `<rect x="3" y="10" width="18" height="4"/>`,
  component: `<rect x="6" y="6" width="12" height="12" rx="1"/><path d="M9 9 H15 M9 12 H15 M9 15 H12"/>`,
  ceiling: `<path d="M3 6 H21"/><path d="M5 6 V9 M9 6 V9 M13 6 V9 M17 6 V9 M21 6 V9"/>`,
  brace: `<path d="M4 20 L20 4"/><path d="M4 16 L8 20 M16 4 L20 8"/>`,
  truss: `<path d="M3 20 L21 20 M3 8 L21 8"/><path d="M3 8 L6 20 M6 8 L9 20 M9 8 L12 20 M12 8 L15 20 M15 8 L18 20 M18 8 L21 20"/>`,
  footing: `<path d="M4 8 H20 V16 H4 Z"/><path d="M8 16 V20 M16 16 V20"/>`,
  strip: `<path d="M3 10 H21 V14 H3 Z"/><path d="M6 14 V18 M12 14 V18 M18 14 V18"/>`,
  slab: `<path d="M3 8 H21 V16 H3 Z"/><path d="M3 12 H21"/>`,
  equipment: `<rect x="4" y="4" width="16" height="12"/><path d="M8 16 V20 M16 16 V20 M4 20 H20"/>`,

  // ── Openings ────────────────────────────────────────────────────────
  door: `<path d="M6 4 H18 V20"/><path d="M6 4 V20"/><circle cx="15" cy="12" r="1"/>`,
  window: `<rect x="5" y="5" width="14" height="14"/><path d="M12 5 V19 M5 12 H19"/>`,
  opening: `<path d="M4 5 H20 V19 H4 Z"/><path d="M8 9 L16 15 M16 9 L8 15"/>`,
  circle: `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.9"/>`,
  shaft: `<path d="M6 4 H18 V20 H6 Z"/><path d="M6 12 H18 M12 4 V20"/>`,

  // ── MEP ─────────────────────────────────────────────────────────────
  duct: `<path d="M3 8 H21 V16 H3 Z"/><path d="M3 12 H21"/>`,
  "duct-fitting": `<path d="M4 8 H12 L20 4 V20 L12 16 H4 Z"/>`,
  "air-terminal": `<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8 H16 M8 12 H16 M8 16 H16"/>`,
  "flex-duct": `<path d="M4 12 Q8 4 12 12 T20 12"/>`,
  "duct-accessory": `<path d="M4 10 H20 V14 H4 Z"/><circle cx="8" cy="12" r="1"/><circle cx="16" cy="12" r="1"/>`,
  pipe: `<path d="M4 12 H20"/><path d="M4 9 H20 M4 15 H20"/>`,
  "pipe-fitting": `<path d="M6 6 L18 18 M6 18 L18 6"/>`,
  "pipe-accessory": `<rect x="8" y="8" width="8" height="8"/><path d="M4 12 H8 M16 12 H20"/>`,
  "plumbing-fixture": `<path d="M6 12 H18 V20 H6 Z"/><path d="M10 12 V8 Q10 5 14 5"/>`,
  sprinkler: `<circle cx="12" cy="10" r="3"/><path d="M12 13 V19"/><path d="M9 20 L15 20"/>`,
  "sprinkler-main": `<path d="M3 12 H21"/><path d="M8 12 V17 M16 12 V17"/>`,
  "fire-pump": `<rect x="6" y="6" width="12" height="12" rx="1"/><circle cx="12" cy="12" r="3"/>`,
  "cable-tray": `<path d="M3 6 H21 M3 18 H21 M3 6 V18 M21 6 V18"/><path d="M8 6 V18 M13 6 V18 M18 6 V18"/>`,
  "cable-tray-fitting": `<path d="M4 6 H20 M4 18 H20 M4 6 V18"/><path d="M4 12 L20 12"/>`,
  conduit: `<path d="M4 12 H20"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="12" r="2"/>`,
  "conduit-fitting": `<path d="M6 6 H18 V18 H6 Z"/>`,
  wire: `<path d="M3 12 Q7 6 12 12 T21 12"/><path d="M3 12 Q7 18 12 12 T21 12"/>`,
  panel: `<rect x="4" y="4" width="16" height="16"/><path d="M8 8 H16 M8 12 H16 M8 16 H12"/>`,
  switch: `<rect x="8" y="6" width="8" height="12" rx="1"/><path d="M12 9 V12"/>`,
  outlet: `<circle cx="12" cy="12" r="6"/><circle cx="10" cy="11" r="0.6"/><circle cx="14" cy="11" r="0.6"/><path d="M12 14 V16"/>`,
  "junction-box": `<rect x="6" y="6" width="12" height="12"/><path d="M6 10 H18 M6 14 H18"/>`,
  "lighting-fixture": `<circle cx="12" cy="12" r="6"/><path d="M12 3 V6 M12 18 V21 M3 12 H6 M18 12 H21"/>`,
  "emergency-light": `<rect x="4" y="8" width="16" height="8"/><path d="M12 8 V6 M8 6 H16"/>`,
  "lighting-switch": `<rect x="8" y="6" width="8" height="12" rx="1"/><circle cx="12" cy="12" r="1"/>`,
  transformer: `<rect x="4" y="6" width="16" height="12"/><path d="M8 6 V4 M16 6 V4 M8 18 V20 M16 18 V20"/>`,
  generator: `<rect x="4" y="6" width="16" height="12"/><path d="M8 12 L11 9 M11 15 L15 11 M16 14 L17 15"/>`,

  // ── Structure ───────────────────────────────────────────────────────
  rebar: `<path d="M4 6 H20 M4 12 H20 M4 18 H20"/><path d="M6 4 V8 M12 4 V8 M18 4 V8"/>`,
  "area-rebar": `<rect x="4" y="4" width="16" height="16"/><path d="M4 8 H20 M4 12 H20 M4 16 H20 M8 4 V20 M12 4 V20 M16 4 V20"/>`,
  "path-rebar": `<path d="M4 6 H20 M4 10 H20 M4 14 H20 M4 18 H20"/>`,
  "rebar-cover": `<rect x="6" y="6" width="12" height="12"/><rect x="3" y="3" width="18" height="18" stroke-dasharray="2 2"/>`,
  connection: `<circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>`,
  plate: `<rect x="4" y="8" width="16" height="8"/>`,
  anchor: `<path d="M12 3 V16"/><path d="M8 16 L12 20 L16 16"/>`,
  pile: `<path d="M12 3 V21"/><path d="M8 6 H16 M8 10 H16"/>`,

  // ── Circulation ─────────────────────────────────────────────────────
  stairs: `<path d="M3 20 H7 V17 H11 V14 H15 V11 H19 V8 H21"/><path d="M3 20 V8"/>`,
  railing: `<path d="M3 12 H21"/><path d="M5 12 V20 M9 12 V20 M13 12 V20 M17 12 V20"/>`,
  ramp: `<path d="M3 18 L21 8"/><path d="M3 15 L3 18 L6 18"/>`,

  // ── Datum ───────────────────────────────────────────────────────────
  grid: `<path d="M3 8 H21 M3 12 H21 M3 16 H21 M8 3 V21 M12 3 V21 M16 3 V21"/>`,
  level: `<path d="M3 12 H21"/><path d="M6 8 L12 12 L18 8"/>`,
  "ref-plane": `<path d="M3 4 L21 20"/><circle cx="6" cy="6" r="1.5"/><circle cx="18" cy="18" r="1.5"/>`,

  // ── Room ────────────────────────────────────────────────────────────
  room: `<rect x="4" y="4" width="16" height="16"/><path d="M8 12 H16"/>`,
  area: `<path d="M4 4 H20 V20 H4 Z"/><path d="M4 4 L20 20" stroke-dasharray="2 2"/>`,
  "room-tag": `<path d="M4 12 L12 4 L20 12 L12 20 Z"/><circle cx="12" cy="12" r="2"/>`,

  // ── Modify ──────────────────────────────────────────────────────────
  move: `<path d="M12 3 V21 M3 12 H21"/><path d="M9 6 L12 3 L15 6 M9 18 L12 21 L15 18 M6 9 L3 12 L6 15 M18 9 L21 12 L18 15"/>`,
  copy: `<rect x="6" y="6" width="12" height="12"/><path d="M9 3 H21 V15"/>`,
  rotate: `<path d="M4 12 A8 8 0 0 1 20 12"/><path d="M20 12 L17 9 M20 12 L23 9" transform="translate(-3 0)"/>`,
  mirror: `<path d="M12 3 V21" stroke-dasharray="2 2"/><path d="M9 6 L3 12 L9 18 Z M15 6 L21 12 L15 18 Z"/>`,
  array: `<rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/><rect x="3" y="15" width="6" height="6"/><rect x="15" y="15" width="6" height="6"/>`,
  offset: `<path d="M4 12 H20" stroke-dasharray="3 2"/><path d="M6 8 H18"/><path d="M6 16 H18"/>`,
  delete: `<path d="M6 6 H18 M9 6 V4 H15 V6 M8 6 L9 20 H15 L16 6"/>`,
  clear: `<path d="M5 7 H19 M9 7 V5 H15 V7 M8 7 L9 20 H15 L16 7"/><path d="M12 10 V17 M15 10 L15 17"/>`,
  isolate: `<rect x="4" y="4" width="16" height="16" stroke-dasharray="3 2"/><path d="M8 8 H16 V16 H8 Z"/>`,
  "show-all": `<path d="M3 12 Q12 4 21 12 Q12 20 3 12 Z"/><circle cx="12" cy="12" r="3"/>`,
  "select-all": `<rect x="4" y="4" width="16" height="16" stroke-dasharray="3 2"/><path d="M8 12 L11 15 L16 9"/>`,

  // ── View — cube seen from each side, distinctly ─────────────────────
  perspective: `<circle cx="12" cy="12" r="8"/><path d="M12 4 V20 M4 12 H20" stroke-dasharray="2 2"/>`,
  orthographic: `<rect x="4" y="4" width="16" height="16"/><path d="M4 8 H20 M4 12 H20 M4 16 H20 M8 4 V20 M12 4 V20 M16 4 V20"/>`,
  fit: `<path d="M4 8 V4 H8 M16 4 H20 V8 M20 16 V20 H16 M8 20 H4 V16"/>`,

  top: `<path d="M12 5 L20 9 V17 L12 21 L4 17 V9 Z" opacity="0.35"/><path d="M4 9 L12 13 L20 9 M12 13 V21" opacity="0.35"/><path d="M4 9 L12 5 L20 9 L12 13 Z" fill="currentColor" stroke="none"/>`,
  bottom: `<path d="M12 5 L20 9 V17 L12 21 L4 17 V9 Z" opacity="0.35"/><path d="M4 9 L12 13 L20 9 M12 13 V21" opacity="0.35"/><path d="M4 17 L12 13 L20 17 L12 21 Z" fill="currentColor" stroke="none"/>`,
  front: `<path d="M12 5 L20 9 V17 L12 21 L4 17 V9 Z" opacity="0.35"/><path d="M4 9 L12 13 L20 9 M12 13 V21" opacity="0.35"/><path d="M4 9 L12 13 L12 21 L4 17 Z" fill="currentColor" stroke="none"/>`,
  back: `<path d="M12 5 L20 9 V17 L12 21 L4 17 V9 Z" opacity="0.35"/><path d="M4 9 L12 13 L20 9 M12 13 V21" opacity="0.35"/><path d="M12 13 L20 9 L20 17 L12 21 Z" fill="currentColor" stroke="none"/>`,
  right: `<path d="M12 5 L20 9 V17 L12 21 L4 17 V9 Z" opacity="0.35"/><path d="M4 9 L12 13 L20 9 M12 13 V21" opacity="0.35"/><path d="M20 9 L20 17 L12 21 L12 13 Z" fill="currentColor" stroke="none"/>`,
  left: `<path d="M12 5 L20 9 V17 L12 21 L4 17 V9 Z" opacity="0.35"/><path d="M4 9 L12 13 L20 9 M12 13 V21" opacity="0.35"/><path d="M4 9 L4 17 L12 21 L12 13 Z" fill="currentColor" stroke="none"/>`,

  "iso-ne": `<path d="M12 4 L19 8 V16 L12 20 L5 16 V8 Z" opacity="0.4"/><path d="M5 8 L12 12 L19 8 M12 12 V20" opacity="0.4"/><circle cx="16" cy="6.5" r="2" fill="currentColor" stroke="none"/>`,
  "iso-nw": `<path d="M12 4 L19 8 V16 L12 20 L5 16 V8 Z" opacity="0.4"/><path d="M5 8 L12 12 L19 8 M12 12 V20" opacity="0.4"/><circle cx="8" cy="6.5" r="2" fill="currentColor" stroke="none"/>`,
  "iso-se": `<path d="M12 4 L19 8 V16 L12 20 L5 16 V8 Z" opacity="0.4"/><path d="M5 8 L12 12 L19 8 M12 12 V20" opacity="0.4"/><circle cx="16" cy="17.5" r="2" fill="currentColor" stroke="none"/>`,
  "iso-sw": `<path d="M12 4 L19 8 V16 L12 20 L5 16 V8 Z" opacity="0.4"/><path d="M5 8 L12 12 L19 8 M12 12 V20" opacity="0.4"/><circle cx="8" cy="17.5" r="2" fill="currentColor" stroke="none"/>`,

  viewcube: `<path d="M12 3 L20 7 V17 L12 21 L4 17 V7 Z"/><path d="M4 7 L12 11 L20 7 M12 11 V21"/>`,
  bounds: `<path d="M4 4 H20 V20 H4 Z" stroke-dasharray="2 2"/><path d="M4 8 H20 M4 16 H20 M8 4 V20 M16 4 V20"/>`,
  camera: `<rect x="3" y="7" width="18" height="12" rx="2"/><circle cx="12" cy="13" r="3"/><path d="M8 7 L9 5 H15 L16 7"/>`,

  // Walk mode — walking stick figure
  walk: `<circle cx="12" cy="4.5" r="1.9"/><path d="M12 7 V13"/><path d="M12 9 L8.5 11 M12 9 L15.5 11"/><path d="M12 13 L9.5 20 M12 13 L14.5 20"/>`,

  // ── Panels ──────────────────────────────────────────────────────────
  tree: `<path d="M12 3 V7 M12 7 V21"/><path d="M12 7 L6 11 M12 7 L18 11"/><circle cx="12" cy="3" r="1.5"/><circle cx="6" cy="13" r="1.5"/><circle cx="18" cy="13" r="1.5"/>`,
  plan: `<rect x="3" y="4" width="18" height="16"/><path d="M3 12 H21 M12 4 V20"/>`,
  schedules: `<rect x="3" y="4" width="18" height="16"/><path d="M3 9 H21 M3 14 H21 M9 4 V20"/>`,
  ids: `<path d="M12 3 L20 6 V12 Q20 18 12 21 Q4 18 4 12 V6 Z"/><path d="M9 12 L11 14 L15 10"/>`,
  cost: `<circle cx="12" cy="12" r="8"/><path d="M9 9 H13 Q15 9 15 11 Q15 13 13 13 H9 M9 13 H14 Q16 13 16 15 Q16 17 14 17 H9 M12 7 V9 M12 17 V19"/>`,
  "tools-panel": `<rect x="4" y="4" width="4" height="16"/><rect x="10" y="4" width="10" height="7"/><rect x="10" y="13" width="10" height="7"/>`,

  // ── Clash / Coordinate ──────────────────────────────────────────────
  measure: `<path d="M3 17 L17 3"/><path d="M6 14 L9 17 M10 10 L13 13 M14 6 L17 9"/>`,
  section: `<path d="M3 7 L12 3 L21 7 V17 L12 21 L3 17 Z" opacity="0.35"/><path d="M3 12 L12 16 L21 12" stroke-dasharray="2 2"/><path d="M12 3 V21" opacity="0.4"/>`,
  clash: `<path d="M4 4 L20 20 M20 4 L4 20"/><circle cx="12" cy="12" r="4"/>`,
  interference: `<path d="M4 4 L12 12 L4 20 M20 4 L12 12 L20 20"/><path d="M12 12 V20" stroke-dasharray="2 2"/>`,
  clearance: `<path d="M3 12 H9 M15 12 H21"/><path d="M9 8 V16 M15 8 V16"/><path d="M10 12 H14" stroke-dasharray="2 2"/>`,
  "crop-shrink": `<rect x="6" y="6" width="12" height="12"/><path d="M3 3 L8 8 M21 3 L16 8 M3 21 L8 16 M21 21 L16 16"/>`,
  "crop-expand": `<rect x="8" y="8" width="8" height="8"/><path d="M3 3 L8 8 M21 3 L16 8 M3 21 L8 16 M21 21 L16 16"/>`,
  "crop-reset": `<path d="M12 3 A9 9 0 1 1 3 12"/><path d="M3 8 V13 H8" transform="translate(-1 -1)"/>`,
  "crop-remove": `<rect x="6" y="6" width="12" height="12" stroke-dasharray="2 2"/><path d="M4 4 L20 20"/>`,
  origin: `<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 4 V8 M12 16 V20 M4 12 H8 M16 12 H20"/>`,
  recenter: `<path d="M12 3 V21 M3 12 H21"/><circle cx="12" cy="12" r="3"/>`,
  "reset-offsets": `<path d="M12 4 A8 8 0 0 1 20 12"/><path d="M20 12 L17 9 M20 12 L23 9" transform="translate(-3 0)"/><circle cx="12" cy="12" r="2"/>`,
  refresh: `<path d="M4 12 A8 8 0 0 1 12 4 M20 12 A8 8 0 0 1 12 20"/><path d="M4 12 L1 9 M4 12 L7 9" transform="translate(0 0)"/><path d="M20 12 L23 15 M20 12 L17 15"/>`,
  "publish-coords": `<circle cx="12" cy="12" r="8"/><path d="M12 8 V16 M8 12 H16"/>`,
  "acquire-coords": `<circle cx="12" cy="12" r="8"/><path d="M8 12 L11 15 L16 9"/>`,
  "specify-coords": `<circle cx="12" cy="12" r="8"/><path d="M12 8 V16 M9 11 L12 8 L15 11"/>`,

  // ── Annotation ──────────────────────────────────────────────────────
  "dim-aligned": `<path d="M3 18 L21 6"/><path d="M3 15 V21 M21 3 V9"/>`,
  "dim-linear": `<path d="M4 12 H20"/><path d="M4 8 V16 M20 8 V16"/>`,
  "dim-angular": `<path d="M4 20 L4 4 M4 20 L20 20"/><path d="M10 20 A6 6 0 0 0 4 14"/>`,
  "dim-radial": `<circle cx="12" cy="12" r="8"/><path d="M12 12 L20 12"/><path d="M16 10 L20 12 L16 14"/>`,
  "arc-length": `<path d="M4 18 Q12 4 20 18"/><path d="M4 15 V18 M20 15 V18"/>`,
  "spot-elev": `<path d="M12 4 V20"/><path d="M8 8 L12 4 L16 8"/><circle cx="12" cy="20" r="1.5"/>`,
  "spot-coord": `<circle cx="12" cy="12" r="3"/><path d="M12 3 V9 M12 15 V21 M3 12 H9 M15 12 H21"/>`,
  "detail-line": `<path d="M3 17 L21 7"/>`,
  "detail-component": `<rect x="5" y="6" width="14" height="12"/><path d="M5 12 H19"/>`,
  "filled-region": `<path d="M4 20 Q12 4 20 20 Z" fill="currentColor"/>`,
  "masking-region": `<path d="M4 20 Q12 4 20 20 Z" stroke-dasharray="2 2"/>`,
  insulation: `<path d="M4 12 Q8 4 12 12 T20 12"/>`,
  "revision-cloud": `<path d="M5 12 Q3 8 7 7 Q8 4 12 5 Q16 3 18 7 Q22 8 19 12 Q22 16 18 18 Q16 21 12 19 Q8 21 7 18 Q3 17 5 12 Z"/>`,
  text: `<path d="M5 6 V4 H19 V6"/><path d="M12 4 V20"/><path d="M9 20 H15"/>`,
  "model-text": `<path d="M5 6 V4 H19 V6"/><path d="M12 4 V20"/><path d="M9 20 H15"/><path d="M3 21 H21" stroke-dasharray="2 2"/>`,
  tag: `<path d="M4 8 L12 4 L20 8 L12 12 Z"/><path d="M4 8 V16 L12 20 L20 16 V8"/><circle cx="12" cy="8" r="1"/>`,
  "tag-all": `<path d="M4 6 L12 2 L20 6 L12 10 Z"/><path d="M4 12 L12 16 L20 12 M4 16 L12 20 L20 16"/>`,
  "material-tag": `<rect x="4" y="4" width="16" height="16"/><path d="M4 8 H20 M4 12 H20 M4 16 H20"/>`,
  symbol: `<circle cx="12" cy="12" r="8"/><path d="M12 4 L12 20 M4 12 L20 12"/>`,
  "color-legend": `<rect x="4" y="4" width="16" height="16"/><path d="M4 10 H20 M4 14 H20 M4 18 H20" stroke-width="3"/>`,

  // ── Reports ─────────────────────────────────────────────────────────
  report: `<rect x="4" y="4" width="16" height="16"/><path d="M7 10 H17 M7 13 H17 M7 16 H13"/>`,
  check: `<path d="M4 12 L10 18 L20 6"/>`,
  energy: `<path d="M13 3 L5 14 H11 L10 21 L19 10 H13 Z"/>`,
  compare: `<path d="M4 4 V20 M20 4 V20 M4 12 H20"/><path d="M8 8 H12 M12 16 H16"/>`,
  schedule: `<rect x="3" y="4" width="18" height="16"/><path d="M3 9 H21 M9 4 V20"/>`,
  quantification: `<path d="M4 20 V10 M9 20 V6 M14 20 V13 M19 20 V4"/>`,

  // ── Massing & Site ─────────────────────────────────────────────────
  mass: `<path d="M4 20 L12 4 L20 20 Z"/>`,
  "mass-floor": `<path d="M4 8 L12 4 L20 8 L12 12 Z"/><path d="M4 16 L12 20 L20 16" stroke-dasharray="2 2"/>`,
  toposurface: `<path d="M3 18 Q8 12 12 16 Q16 20 21 14"/>`,
  "building-pad": `<rect x="6" y="8" width="12" height="8"/><path d="M3 20 Q8 16 12 18 Q16 20 21 16"/>`,
  "property-line": `<path d="M3 6 L21 6 M3 18 L21 18 M3 6 V18 M21 6 V18" stroke-dasharray="3 2"/>`,
  "site-component": `<path d="M12 3 L15 12 H9 Z"/><path d="M12 12 V20"/>`,
  parking: `<rect x="4" y="4" width="16" height="16"/><path d="M9 17 V7 H13 Q15 7 15 9 Q15 11 13 11 H9"/>`,
  "graded-region": `<path d="M3 16 Q8 10 12 14 Q16 18 21 12"/>`,
  subregion: `<path d="M3 18 Q8 12 12 16 Q16 20 21 14" stroke-dasharray="2 2"/>`,
  "split-surface": `<path d="M3 18 Q12 4 21 18"/><path d="M12 4 V20" stroke-dasharray="2 2"/>`,
  "site-settings": `<circle cx="12" cy="12" r="3"/><path d="M12 3 V5 M12 19 V21 M3 12 H5 M19 12 H21 M5 5 L7 7 M17 17 L19 19 M5 19 L7 17 M17 7 L19 5"/>`,

  // ── System ──────────────────────────────────────────────────────────
  // Aliases
  undo: `<path d="M9 14 L4 9 L9 4 M4 9 H14 A5 5 0 0 1 14 19 H10"/>`,
  mline: `<path d="M3 17 L21 7"/>`,
  modify: `<path d="M4 20 L20 4 M4 16 V20 H8 M16 4 H20 V8"/>`,
  view: `<path d="M3 12 Q12 4 21 12 Q12 20 3 12 Z"/><circle cx="12" cy="12" r="3"/>`,

  system: `<circle cx="12" cy="12" r="3"/><path d="M12 3 V6 M12 18 V21 M3 12 H6 M18 12 H21"/>`,
};

/**
 * Return an inline SVG string for a given icon name.
 * Sized 16×16 to fit the compact ribbon button (default --rbb-icon: 16px).
 */
export function svgIcon(name: IconName): string {
  const p = PATHS[name] ?? PATHS.system;
  return (
    `<svg width="16" height="16" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="1.9" ` +
    `stroke-linecap="round" stroke-linejoin="round" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `${p}</svg>`
  );
}