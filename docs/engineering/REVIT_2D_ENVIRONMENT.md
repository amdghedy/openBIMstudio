# Revit 2D Environment — Audit & Ranked Gap List

Base: `amdghedy/openBIMstudio` @ `29c222b` ("fix(camera): fitAll empty-bounds retry is bounded (10×) with a single timer and one warning (#259)").
Audit date: 2026-11-21. Auditor: read-only code audit of the repo at that commit; no live Revit available.

## Evidence basis — read this first

- **Current behaviour** is grounded in the code at `29c222b` (file:line cited). Nothing below about the repo is guessed.
- **Revit behaviour** is marked `[knowledge]` (well-established Revit UI behaviour, no live Revit here to verify against) or cited to a source found by web search:
  - **[GSG-2015]** Autodesk Revit 2015 Getting Started Guide — ribbon tab order and contextual tabs ("Modify | Place Wall"). https://www.scribd.com/document/424573865/05122016-GSG-Revit-2015-Architecture-CC-version-4-pdf
  - **[MEP-2013]** SDC Publications, *Revit MEP 2013 Fundamentals*, ch. 2 — Modify tab panels (Select, Properties, View, Measure, Geometry, Clipboard, Create, Modify, Tag, Placement Tools), Tab-to-cycle, window/crossing, Shift-remove, Ctrl+Left reselect. https://static.sdcpublications.com/pdfsample/978-1-58503-743-8-2.pdf
  - **[SEL]** EVOLVE Electrical help, "Selecting elements in Revit" (Tab cycles connected/overlapping elements; L→R window vs R→L crossing; Esc/click-background deselect; Ctrl add, Shift remove). https://help-electrical.evolvemep.com/tips-tricks-evolve-electrical/selecting-elements-in-revit
  - **[CADNOTES]** CADnotes, "Revit basic tip: 7 ways to select objects" (noun-verb selection opens contextual Modify tab; Filter dialog; window = solid line, crossing = dashed line). https://www.cad-notes.com/revit-basic-tip-selecting-objects/
- **Reachability** uses: *reachable* = implementable in this repo with the existing engine; *partial* = closest faithful subset possible, with a named limit; *out of reach* = needs a capability this engine does not have (named).
- No gap is marked closed. Phase 2 (implementation) is recorded separately; this document is the audit only.

## 1. Inventory — the 2D environment as it is today

### 1.1 Ribbon (`src/shell/ribbon.ts`, 3,630 lines; note: the task brief said `src/features/ribbon.ts` — the ribbon actually lives in `src/shell/ribbon.ts`)

16 permanent tabs, in this order (`TABS`, ribbon.ts:790):

| # | Tab | Groups (in order) |
|---|---|---|
| 1 | File | App, New, Open, Export, Doc, AI |
| 2 | Architecture | Build, Openings, Adaptive, Datum, Circulation, Direct Modeling, Sweeps, Constraints, (unlabeled Modify row), Massing, Properties |
| 3 | Structure | Framing, Found, Connections, Truss Builder, Rebar, Properties |
| 4 | Mechanical | HVAC, Auto-Route, Plumbing, Fire, Systems, Display, Engineering, Properties |
| 5 | Electrical | Containment, Power, Lighting, Equipment, Properties |
| 6 | Insert | Link / Import, Link CAD / BIM, Fabrication, Load from Library, Placement, Ext, Analysis, Views |
| 7 | Annotate | Graphics, Dimension, Chain, Keynotes, Detail, Text, Legend |
| 8 | Analyze | Model Checker, Health & QA, Daylight, Energy, Loads, Generative, MEP Analysis, AI, Structural FEM, Hydraulics |
| 9 | Massing & Site | Topo, Property, Site, Massing |
| 10 | Coordinate | Review, Placement |
| 11 | Clash Detective | Clash Rules, Tests, Select, Rules, Run, Review, Status, Isolate, Report, Coordinates |
| 12 | Edit | Select, Clipboard, BIM Authoring, Element, Gizmo, Solid Forms, Modify Engine, Group 1 Tools (v71), Snaps, Focus |
| 13 | View | Section, Crop, Crop View, Selection, Filters, Schedules, Select, Graphics, Presentation, Create, Schedules, Sheets, Orient, Windows, Bars, Windows |
| 14 | Manage | Parameters, Collaboration, View Tools, Worksets, Plugins, Performance, Analysis, Marketplace, Links, Project, Position, Production, Selection, Reset, Panels |
| 15 | X Dim | 4D Simulation, P6 Planning, Assign to model, 5D Cost, 6D Carbon, Schedules & BOQ, Reports |

Plus one **contextual tab** (`syncContextTab`, ribbon.ts:3236): `Modify | Place <Tool>` while a placement tool is active, and `Modify | <Category>` while elements are selected with no active tool; it disappears and returns to the previous tab when the tool/selection ends. A double-click on a tab collapses the ribbon strip (BIM-style minimize); single click while minimized expands it.

Architecture tab, Build group order: Wall (WA), Floor (SL), Roof, Column (CM), Beam (BM), Comp, Ceiling, Ramp (RM). Openings group: Door (DR), Window (WN), Opening, Shaft, Hosted Opening. Datum: Grid (GR), Level (LV), Ref plane. Stairs are three buttons (Stairs / Winder / Spiral) that instantly build a stair at a fixed place — not a placement tool. No Curtain Wall, Railing, Room, Area, Model Text or Model Line placement in the Architecture tab (Model Text exists only as a prompt-driven Annotate → 3D text that places an equipment marker).

### 1.2 Contextual Modify tab (what it contains)

- **On placement** (`ctxItems`, ribbon.ts:3158): Select (Modify/Esc), Properties (Properties, Type Properties), Clipboard (Paste), Modify (Move, Copy, Rotate, Mirror, Array, Offset, Scale, Delete), Draw (Finish/Enter, Cancel/Esc, Chain toggle), plus Join Walls for walls.
- **On selection** (`selectionItems`, ribbon.ts:3197): Select (Modify, Select Similar, Select All, Clear), Properties (Properties, Type Properties), Clipboard (Copy, Paste), Modify (Move, Copy Move, Rotate, Mirror, Array, Offset, Scale, Align H, Align V, Delete), Geometry (Trim/Extend, Split at Midpoint, Flip), Constraints (Pin, Unpin), Create (Create Similar, Match Properties), View (Isolate, Hide, Reveal, Zoom). MEP selection adds "Branch / Network" (Tab cycles branch → network → single run).
- Modify commands are canonicalised in `src/modules/modify/registry.ts` (18 commands: move, copy, paste, rotate, mirror, array, offset, scale, create-similar, match-props, select-similar, align-x, align-z, pin, unpin, split-mid, join-walls, delete) with Revit-style aliases (MV, CO, RO, MI, AR, OF, SC, Del). **Only authored ("native") elements are eligible** — fragment/linked IFC elements are not (`sourceKinds: NATIVE`).

### 1.3 Plan view (`src/features/plan-view-panel.ts`, 5,506 lines)

A modal SVG overlay (not a docked/tabbed view). Renders authored elements plus IFC cut segments at the cut plane (footer: "N authored · M fragments · K segments · zoom %"). Modes: `pan | select | navigate | move | linear | point | dim | tag | text | region`. Linear kinds: wall, beam, strip, duct, pipe, cable-tray, conduit, mline, brace, truss. Point kinds: column, footing, equipment, door, window (door/window are hosted on walls).

- **Header controls**: Level select, cut-plane slider (0.5–3 m, default 1.20 m), Scale (1:50 / 1:100 / 1:200 / 1:500 only), Dimension Type select, Chain checkbox, Units (mm/cm/m/ft/in), Regenerate, Link drawing, Clear CAD, Print, SVG export, Close.
- **View Properties side panel** (`renderPlanViewProperties`): Identity (Level, View Scale, Detail Level Coarse/Medium/Fine); Graphics (Display Model, Wall Poché, Crop View, Annotation Crop, Underlay: None/Below/Link drawing); View Range (Cut Plane, Bottom, Top, View Depth); Annotations (Dimension Type, Dimension Units).
- **Tools reachable in plan**: dimensions (Aligned DI, Linear, Auto Dim, Dim All, Angular, Radial, Arc Length, Spot Elevation, Spot Coordinate, Diameter, Slope), tags (Tag, Tag All, Material, Room tag, Multi-Category, Area, Space), text notes, filled/masking regions, revision clouds, section lines, detail lines (via mline), crop region with drag handles (`src/features/crop-region.ts`), DXF/SVG/PNG underlay with snap points (`cad-underlay-snap.ts`), plan-region cut-plane override, scope boxes.
- **Temporary dimensions**: rendered in-plan (`renderTemporaryDimensions`, plan-view-panel.ts:842, called at :2839); editable temp dims exist for the 3D viewport (`src/features/temp-dimensions.ts`, `temp-dimensions-edit.ts` — click-to-edit labels).
- **Snaps**: plan dim mode supports Tab-cycling overlapping snap points (plan-view-panel.ts:591, :5236-5246). 3D snapping engine (`src/features/snapping.ts`) has endpoint, midpoint, center, intersection, perpendicular, tangent, quadrant, vertex, face, nearest, parallel, extension, grid, connector. Shift constrains ortho while drawing.
- **Selection in plan**: click select; drag box = window L→R / crossing R→L (`planBoxOverlay`, :3605-3743, footer: "L→R window · R→L crossing"); Ctrl/Meta/Shift-click is additive; dimensions/tags/notes are selectable, draggable, double-click-to-edit-text, Delete to remove; Esc cancels in priority order (dim chain → region → annotation → dimension selection → tool cancel, :5231-5444).
- **Double-click in plan**: on an annotation → edit its text; otherwise → fit view (:4336, :4565). Double-click on a model element does **not** open type/family editing.
- **2D ↔ 3D relation**: the plan is a separate SVG projection regenerated from the authored model + IFC cut segments; it is not a live view of the Three.js scene. The 3D engine is Three.js + ThatOpen fragments; the Rust CAD-engine wasm (`cad-engine-rust/`, `public/cad-engine/`) powers the **standalone CAD viewer** (`src/features/cad-viewer.ts`, 13,373 lines), not the plan view. Plan and 3D share the authored model, so a plan edit appears in 3D after regeneration, but there is no tiled/multi-view session and no live section/elevation view sync.

### 1.4 Selection (3D) — `src/features/selection.ts`, `box-selection.ts`, `src/modules/selection/`

- Click-select with Ctrl add; box selection window/crossing with replace/add/remove modifiers (`commitBoxSelection`); selection sets; Select All (Ctrl+A); isolate/hide/reveal; "Select Similar" exists in the Modify registry but the engine method it calls is missing (known follow-up from the parametric-families work — do not claim it works).
- **No Tab-cycle through overlapping elements at hover** in 3D or in plan select mode. Tab is used for: snap-point cycling (plan dim mode only), MEP branch/network cycling, and AccuDraw axis input.
- **Double-click in 3D** (`dblclick-fit.ts`): fits the camera to the element under the cursor and sets it as orbit pivot; on empty space does nothing.
- **Esc** (global `cancel-or-clear`, `src/shell/default-shortcuts.ts`): cancels the active authoring tool → Select, else clears model + authored selection. Plan view owns Esc while open; CAD viewer owns Esc while its shell is visible.

### 1.5 Shortcuts (`src/shell/default-shortcuts.ts`, `src/features/bim-input-compatibility.ts`, `src/features/shortcuts.ts`)

Two-letter tool sequences (800 ms buffer): WA Wall, SL Slab, CM Column, BM Beam, BR Brace, TR Truss, FT Footing, SF Strip, DU Duct, PP Pipe, GR Grid, LV Level, DR Door, WN Window, RF Roof, CL Ceiling, RM Room, ST Stairs, RA Railing, CW Curtain Wall, PU Push/Pull, RE Rectangle, CI Circle. View: ZA/ZF/ZE zoom fit, ZO/ZI zoom out/in, VN default 3D, F fit, H home. Visibility: HH hide, HI isolate, HR reset. Modify: MV Move, RO Rotate, AL Align, MA Match Properties, CS Create Similar, GP Create Group. App: Ctrl+S/O/N/H, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / Ctrl+R redo, Ctrl+A, Delete, Esc, F5 run clash, KS shortcut editor, Ctrl+/ help. Gizmo modals: G/R/S/Q. View tools: Ctrl+Shift+B selection box, Ctrl+Shift+R crop to selection, Ctrl+Shift+F zoom to selection, Ctrl+B section box, Ctrl+Shift+S scope-box visualizer, Ctrl+I isolate, Ctrl+Shift+I reset isolation, Ctrl+Shift+V view tools manager. Snap toggle Shift+S; AccuDraw reserves X/Z/Y/Tab while a base point is active.

**Not bound despite appearing as `kbd` labels on ribbon/context-menu buttons:** DI (Aligned Dimension), OF, CO, MI, AR, SC, VG/VV (Visibility/Graphics), TL (Thin Lines), WT (Tile Views), WC. **TR is bound to Truss**, while Revit TR = Trim/Extend — and the context menu simultaneously shows "Trim / Extend to Corner" with kbd TR. That is a live key conflict.

### 1.6 Annotate tab — what is real vs alias vs stub

Real: Aligned/Linear/Auto/Dim-All/Angular/Radial/Arc/Spot-Elevation/Spot-Coordinate dimensions (distinct `planDimStyle` values), Filled/Masking Region, Revision Cloud, Section Line, Text, Tag, Keynote assign + legend CSV export, Line Weights table, Grid Bubbles table. **Aliases (same underlying tool, different label):** Continuous and Baseline dimensions both just activate `dim-aligned` + toast; Diameter activates `dim-radial`; Slope activates `spot-elev`; Detail Line and Insulation both activate `mline`; Material/Room/Space/Multi-Category/Area tags all activate `tag`. **Honest stubs** (`planned()`): View Reference, Tread Number, Detail Group, Check Spelling, Find/Replace, Duct/Pipe/Color-Fill/Symbol legends.

### 1.7 View controls

- **Bottom view control bar** (`bim-experience.ts:887-913`): Scale (Fit, 1:20, 1:50, 1:100, 1:200, 1:500), Detail (Coarse/Medium/Fine), Discipline (Coordination, Architecture, Structure, Mechanical, Electrical, Plumbing), visual styles (Shaded, Shaded+Edges, Wireframe, Hidden Line), Crop toggle, Temporary Hide/Isolate, Reveal, Sun, VG, Templates, 3D/Ortho/Top/Fit. Toggleable (View → Windows → View bar).
- **Options Bar** (under ribbon, `bim-experience.ts:832`): per-tool options (e.g. place tools show Height/Elevation type defaults, Finish/Cancel); empty state says "Select a tool or element to see contextual options".
- **View tab**: Section Cut/Box, Scope Box, Plan Region, Crop View toggle/reset/50 m/100 m, Selection Box, Crop to Selection, Zoom Selection, Isolate, Dependent View, View Filters (create rule-based filter; apply via Model Tree), Matchline, Schedules, Graphic Display Options, visual presets (Wireframe/Hidden Line/Shaded/Consistent Colors/Realistic/Ray Trace), Thin Lines, Show Hidden, MEP colors, Bounds, Theme, Render/screenshot, Walk, Full Screen, Create views (3D, Plan, Section, Elevation, Duplicate, Legends), Sheets, Title block, Revisions, Guide grid, Orient (Ortho/Persp, Fit, Home, Top/Front/Right/NE/NW/SE/SW), Windows (Project Browser, Model Tree, Properties, UI menu, Sheets 2D, Views, Models, IFC Props, Controls, BIM Center, Tile L/R, Close all, Command palette, Recover view).
- **Crop toggle hardcodes viewId `"plan-view-1"`** (ribbon.ts View tab, Crop View group) — it does not follow the active plan view.

### 1.8 Properties palette (`src/features/property-palette.ts`, 1,727 lines)

Floating (toggleable) panel. Renders instance parameters by element type, family identity block, level constraints, wall-type block for multi-selection, classification block, and view properties when nothing is selected (`renderViewProperties`). **There is no Type Selector dropdown** (no "Type Selector"/typeSelect in the file) — the Revit pattern of picking a different type for the selected element from the top of the palette is absent. "Type Properties" is reachable from the contextual Modify tab (wired to `bimExperience` `modify.typeProperties`; behaviour not verified in this audit).

### 1.9 Project Browser (`src/features/project-browser.ts`, 487 lines)

Fixed left-docked floating panel (280 px). Root order: **Views (all)** → 3D View, Floor Plan, saved views · **Schedules/Quantities (all)** → Open Schedules panel, Cost/QTO · **Sheets (all)** → sheets by number · **Families** → materials only (first 40) · **Models & Links** → loaded IFC/FRAG models · **Groups** → selection sets · **4D Phases** → phases. Double-click activates; chevron expands; toolbar has + View, + Sheet, Expand; header has Refresh, Properties, Close. No right-click menu, no search/filter, no per-discipline view grouping (no Floor Plans / Ceiling Plans / Elevations / Sections / 3D Views sub-nodes), no Legends node, Families shows materials not family types.

### 1.10 Context menu (`src/features/context-menu.ts`, `context-menu-model.ts`)

Right-click menu with flyouts: Modify (full registry + Trim/Extend, Copy to Clipboard, precise dialogs), Create (build tools), View, Visibility, Select (Select Similar, etc.), Make Editable Native Twin, Properties. No "Select All Instances", no "Override Graphics in View", no "Select Previous".

### 1.11 What is already at Revit parity (do not rework)

Window/crossing selection in both plan and 3D with correct L→R/R→L semantics; Esc cancel-then-deselect; two-letter shortcuts incl. WA/CM/BM/DR/WN/GR/LV/DU/PP/ZA/ZF/HH/HI/HR/MV/RO/AL/MA/CS/GP/KS; contextual `Modify | Place …` and `Modify | <category>` tabs that appear/disappear; view bar with Scale/Detail/Discipline; plan View Range (Cut/Bottom/Top/Depth) and Detail Level; crop region with handles; temporary dimensions (3D overlay + plan render + editable labels); dimension styles and units; filled/masking regions; revision clouds; DXF underlay with snapping; worksets; ribbon minimize on double-click tab.

## 2. Ranked gap list

Ranked by user-visible impact on a Revit user's daily plan-view workflow. "Evidence" cites the repo location proving the current behaviour; Revit claims are `[knowledge]` unless a source tag is given.

### G1 — Ribbon tab order and structure does not match Revit
- **Current:** 16 tabs: File, Architecture, Structure, Mechanical, Electrical, Insert, Annotate, Analyze, Massing & Site, Coordinate, Clash Detective, Edit, View, Manage, X Dim (+ contextual Modify). Revit's Systems discipline is split into two tabs; there is no Collaborate or Add-Ins tab; File is a ribbon tab rather than the application menu; Coordinate / Clash Detective / X Dim are product tabs with no Revit counterpart; Edit is a permanent tab.
- **Revit [GSG-2015]:** Architecture, Structure, Systems, Insert, Annotate, Analyze, Massing & Site, Collaborate, View, Manage, Add-Ins, Modify (contextual only). Newer Revit adds Steel and Precast tabs.
- **Reachability:** reachable. Reorder/rename/merge in `src/shell/ribbon.ts` `TABS` (mechanical+electrical → Systems with HVAC/Plumbing/Electrical/Fire groups; move Coordinate/Clash/X Dim content under View/Manage/Analyze or keep as clearly-marked product tabs after Manage; demote Edit to contextual-only or keep as a documented deviation; add Collaborate tab for the existing worksharing/live-sync tools currently under Manage). Pure UI restructure, no engine work. Risk: existing e2e tests and `ci-unit-tests.mjs` entries reference tab ids — update them in the same branch.
- **Evidence:** ribbon.ts:790-3140.

### G2 — Contextual Modify tab is missing Revit's Measure panel, Filter, and fragment support
- **Current:** on selection the tab has Select, Properties, Clipboard, Modify, Geometry, Constraints, Create, View. No Measure panel; no Filter button; no Select Previous / Save Selection; and the tab only appears for authored elements — selecting a linked IFC/FRAG element shows no Modify tab (registry `sourceKinds: NATIVE`, registry.ts:60-88; `syncContextTab` reads `selectedAuthored()` only, ribbon.ts:3247-3257).
- **Revit [MEP-2013][CADNOTES]:** Modify tab panels are Select, Properties, View, Measure, Geometry, Clipboard, Create, Modify, Tag, Placement Tools; Filter sits in the Select panel; any selectable element (including linked) gets a Modify tab.
- **Reachability:** partial. Adding Measure (the existing Measure tool, currently under Coordinate) + Filter (a category filter dialog over the current selection) + Select Previous is reachable. Modify for linked elements is **out of reach** without an edit path — the honest subset is a Modify tab for linked selection offering only View/Visibility/Isolate + "Make Editable" (which already exists), with transform commands disabled and the reason shown.
- **Evidence:** ribbon.ts:3197-3234, registry.ts:60-88.

### G3 — No Tab-cycle through overlapping elements at hover (3D or plan)
- **Current:** Tab cycles only snap points in plan dim mode (plan-view-panel.ts:5236) and MEP branch→network (ribbon.ts:3226). Hovering a crowded spot and pressing Tab does nothing to the element pre-highlight.
- **Revit [SEL][MEP-2013]:** Tab cycles connected/overlapping elements under the cursor before clicking; the status bar shows which element is pre-highlighted.
- **Reachability:** reachable, medium. Needs a hover hit-stack in the 3D pick path (`selection.ts` / navigation pick) and in plan select mode (reuse `nearestAuthoredAt` + fragment hit list), with a status-bar/tooltip readout of the current candidate. One browser spec can prove it in plan view; 3D proof needs the fragment hit path.
- **Evidence:** plan-view-panel.ts:591, :5236; no Tab handling in selection.ts.

### G4 — Shift-click adds instead of removing; no Select Previous, no Filter dialog, no Select All Instances
- **Current:** plan click uses `additive = Ctrl || Meta || Shift` (plan-view-panel.ts:4502) — Shift adds, where Revit Shift removes. There is no Ctrl+Left "Select Previous", no Filter dialog on a mixed selection, no "Select All Instances (Visible in View / In Entire Project)". A selection-filters UI exists only inside the Edit → "Selection & Snapping" palette.
- **Revit [SEL][MEP-2013]:** Ctrl adds (+), Shift removes (−), Ctrl+Left re-selects the previous set, Filter dialog filters a selection by category, right-click → Select All Instances.
- **Reachability:** reachable. Shift-remove is a small change in plan + 3D click paths (verify 3D path separately — `selection.ts` click handling was not fully traced in this audit). Select Previous needs a stored previous-selection snapshot. Filter dialog is a new small dialog over the current selection's categories. Select All Instances needs a category/type query over authored + fragment elements.
- **Evidence:** plan-view-panel.ts:4292, :4502; context-menu-model.ts:123 (Select Similar only).

### G5 — Double-click does not open Type Properties / edit the type or family
- **Current:** 3D double-click fits the camera and sets the orbit pivot (`dblclick-fit.ts`); plan double-click edits annotation text if over an annotation, else fits the view (plan-view-panel.ts:4336, :4565). No double-click path opens Type Properties or a family/type editor for a model element.
- **Revit [knowledge]:** double-click a family opens the Family Editor by default (Options → Double-click Options can change it to Edit Type or Do Nothing); double-clicking most elements opens an editor appropriate to the category.
- **Reachability:** partial. Double-click → open Type Properties for the element is reachable (the `modify.typeProperties` command exists). A full Family Editor is **out of reach** in this workstream — `family-sketch-editor.ts` exists for family sketching but there is no per-element family edit session wired to double-click; record that limit.
- **Evidence:** dblclick-fit.ts:20-60; plan-view-panel.ts:4336-4360, :4565.

### G6 — Draw-tool ordering and grouping on Architecture/Structure tabs
- **Current:** Architecture Build order is Wall, Floor, Roof, Column, Beam, Comp, Ceiling, Ramp; Beam lives in Architecture; Stairs/Winder/Spiral instantly build at a fixed place instead of placing; no Curtain Wall, Railing, Room, Area, Model Text placement; Openings is a separate group holding Door/Window. Structure Framing order is Beam, Column, Brace, Truss, Wall, Floor; "Mat" is a slab tool under Foundations; no Beam System, Slab Edge, Area/Path Reinforcement.
- **Revit [knowledge]:** Architecture Build panel order is Wall, Door, Window, Component, Column, Roof, Ceiling, Floor, Curtain System, Railing, Ramp, Stair, (then Room, Area, Model Text/Line/Group); Structure panel is Beam, Beam System, Brace, Column, Wall, Floor; Foundations are Isolated/Wall/Slab; Reinforcement is Rebar/Area/Path/Fabric.
- **Reachability:** reachable. Reorder the `toolBtn` calls and move Beam out of Architecture Build (keep a copy under Structure only, or keep and document the deviation); convert Stairs to a real placement tool (placement point + run direction) instead of instant-build; add Curtain Wall (the `curtain-wall` tool type exists in the registry — `CTX_LABEL` maps it, ribbon.ts:3150) and Railing placement to the Architecture tab; Room/Area need the rooms/area-plans modules wired to placement (verify before claiming).
- **Evidence:** ribbon.ts:862-1011 (Architecture), :1012-1086 (Structure).

### G7 — Annotate: tag variants, Continuous/Baseline dimensions, and stubs are aliases or placeholders
- **Current:** Material/Room/Space/Multi-Category/Area tags all call `pv.setTool("tag")`; Continuous and Baseline dimensions call `setTool("dim-aligned")` + toast; Diameter calls `dim-radial`; Slope calls `spot-elev`; Detail Line and Insulation both call `mline`. `planned()` stubs: View Reference, Tread Number, Detail Group, Check Spelling, Find/Replace, Duct/Pipe/Color-Fill/Symbol legends (ribbon.ts:1662-1694).
- **Revit [knowledge]:** each tag type tags its own category with its own tag family; Continuous and Baseline are distinct dimension chains; Diameter/Slope are distinct dimension types; Detail Line vs Insulation are distinct line styles.
- **Reachability:** partial. Distinct tag modes (filtering which categories the tag tool accepts + which label it renders) and wiring Continuous/Baseline to the existing plan chain mode (`planDimChain` + header Chain checkbox, plan-view-panel.ts:928-943) are reachable. View Reference / Tread Number / Spell / Find-Replace are **out of reach** in this workstream (no view-reference model, no spell engine); legends need the legend/schedule pipeline and are partial at best.
- **Evidence:** ribbon.ts:1405-1695; plan-view-panel.ts:928-943.

### G8 — Keyboard: TR conflict; DI/OF/CO/MI/AR/SC/VG/VV/TL shown but not bound
- **Current:** `TR` is bound to Truss (default-shortcuts.ts:220) while the context menu labels Trim/Extend "TR" (context-menu-model.ts:72) and the ribbon shows DI/OF/CO/MI/AR/SC kbd labels with no registry binding. VG/VV/TL/WT/WC are not bound at all.
- **Revit [knowledge]:** TR = Trim/Extend, DI = Aligned Dimension, OF = Offset, CO = Copy, MI = Mirror, AR = Array, VG/VV = Visibility/Graphics, TL = Thin Lines, WT = Tile Views, WC = Close Hidden.
- **Reachability:** reachable, but TR is a breaking change: Truss needs a new sequence (suggest `TS`, unused) and Trim/Extend needs a real interactive implementation before its key is advertised — today `modify.trimExtend` exists as a command; verify it works before binding. Bind DI/OF/CO/MI/AR/SC to the modify registry commands; bind VG to Visibility/Graphics, TL to Thin Lines toggle (both exist); WT/WC tile/close-hidden need a multi-view window system — **out of reach** until views can be tiled (see G12).
- **Evidence:** default-shortcuts.ts:215-230; context-menu-model.ts:72; ribbon.ts:1445 (kbd "DI"), :1548 (kbd "TR" in menu model).

### G9 — View controls: plan scale list, dead Underlay control, hardcoded crop view
- **Current:** plan Scale offers only 1:50/1:100/1:200/1:500 (plan-view-panel.ts:906); the View Properties "Underlay: Below" option sets a variable that is never read (`planUnderlay` written at :275, never consumed elsewhere); the View tab Crop toggle hardcodes `"plan-view-1"` (ribbon.ts, Crop View group); the plan header has no visual-style control (plan is SVG linework only).
- **Revit [knowledge]:** full scale list (1:5–1:1000+); Underlay shows another level's plan below the current view; crop region follows the active view; view control bar offers visual style per view.
- **Reachability:** partial. Full scale list + crop-follows-active-view are reachable. A true Revit Underlay (render another level's plan beneath) is reachable in the plan renderer (levels already exist; render that level's segments greyed below) — medium work. Visual styles in plan are **out of reach** as drawn — the plan is SVG linework; the honest subset is the existing Display Model / Wall Poché toggles.
- **Evidence:** plan-view-panel.ts:207, :275, :906; ribbon.ts View tab Crop View group.

### G10 — Properties palette has no Type Selector and is floating, not docked
- **Current:** floating toggleable panel; instance parameters render per type, but there is no type-selector dropdown at the top (grep for "Type Selector"/"typeSelect" in property-palette.ts: no hits). Revit's palette is docked left by default with the Type Selector at the top; changing the type re-types the selected element(s).
- **Revit [knowledge]:** Properties palette shows Type Selector + instance parameters; "Edit Type" opens Type Properties.
- **Reachability:** reachable. Add a type dropdown populated from the element's family/type registry (the type system exists — `type-catalog`, `families` modules; Slice 1 type-propagation work already handles instance overrides on type change, branch `feat/parametric-families-scope-1`). Docking left by default is a layout change (the panel is `position:fixed`; a dock mode needs the workspace layout to reserve the column — medium).
- **Evidence:** property-palette.ts (no type selector); ribbon.ts:3213 (Type Properties button).

### G11 — Project Browser ordering and grouping
- **Current order:** Views, Schedules/Quantities, Sheets, Families (materials only), Models & Links, Groups, 4D Phases. Views node is flat (3D View, Floor Plan, saved views). No search/filter, no right-click menu.
- **Revit [knowledge]:** Views (all) [grouped Floor Plans / Ceiling Plans / Elevations / Sections / 3D Views / …], Sheets (all), Schedules/Quantities, Families, Groups, Links, Legends. (Exact node order varies by template; the stable facts are Views first, Sheets before Schedules, Groups before Links.)
- **Reachability:** reachable. Reorder roots to Views, Sheets, Schedules/Quantities, Families, Groups, Models & Links, 4D Phases; subgroup Views by kind (plan/3D/saved/section — section views exist via the views module); make Families list family types as well as materials; add a filter textbox. All in `project-browser.ts` `buildTree()`.
- **Evidence:** project-browser.ts:130-216.

### G12 — Plan is a separate SVG projection, not a live view; no tiled views
- **Current:** plan view is a modal overlay rendering authored elements + IFC cut segments; it cannot sit beside the 3D view, views cannot be tiled (no WT), and there is no live section/elevation view that stays in sync with the model. The Rust CAD wasm engine serves the standalone CAD viewer, not the plan view.
- **Revit [knowledge]:** every view (plan, section, elevation, 3D) is a live view of the same model; views tile (WT) and stay synchronised.
- **Reachability:** out of reach for full unification in this workstream. Reachable subsets: (a) make the plan view a dockable panel that can stay open beside 3D (layout work); (b) live-sync plan regeneration on model change (regeneration is already coalesced — wire the model-change event so the plan refreshes without the Regenerate button); (c) IFC cut-segment fidelity improvements are a separate IFC workstream. Do not claim "live views" for (a)/(b) alone.
- **Evidence:** plan-view-panel.ts:70-160 (overlay DOM), :4570+ (coalesced regenerate); cad-viewer.ts:1-60 (standalone viewer).

### G13 — Temporary dimensions in plan: present but editability unverified
- **Current:** plan renders temporary dimensions (`renderTemporaryDimensions`, :842/:2839); the 3D viewport has editable temp-dim labels (`temp-dimensions-edit.ts`). Whether plan temp dims appear on selection and are click-to-edit was not verified in this audit (the render call passes bounds, not a selection-driven provider).
- **Revit [knowledge]:** selecting an element in plan shows temporary dimensions to the nearest references, editable in place.
- **Reachability:** reachable — wire the editable temp-dim provider to plan selection and verify with a browser spec; if the provider cannot run in SVG, record the limit.
- **Evidence:** plan-view-panel.ts:842, :2839; temp-dimensions-edit.ts:291-292.

### G14 — Snaps: full type set in 3D, but no snap overrides UI
- **Current:** 14 snap types exist (snapping.ts:76-78) with a Snap settings panel (Edit → Snaps) and Shift-ortho; plan dim mode Tab-cycles snap candidates. There is no right-click Snap Overrides menu and no per-tool snap toggles in the plan header or Options Bar.
- **Revit [knowledge]:** Snaps dialog under Manage → Settings; right-click → Snap Overrides during a command; two-letter overrides (SE endpoint, SM midpoint, SC centre, SI intersection, SN nearest, SP perpendicular, ST tangent…).
- **Reachability:** reachable. A right-click override menu during plan placement + SO/SE-style override shortcuts in the plan tool flow; the snap engine already supports per-type enablement.
- **Evidence:** snapping.ts:76-78; ribbon.ts Edit tab Snaps group; plan-view-panel.ts:591.

### G15 — Context menu gaps (minor)
- **Current:** Modify/Create/View/Visibility/Select flyouts + Make Editable + Properties. Missing: Select All Instances, Override Graphics in View, Select Previous.
- **Revit [knowledge]:** right-click offers Select All Instances, Override Graphics in View, Select Previous, plus category-specific tools.
- **Reachability:** reachable — same implementations as G4/G2; Override Graphics in View needs the view-graphics override path for the selected element in the active view (view-graphics module exists; scope to plan + 3D visibility override).
- **Evidence:** context-menu-model.ts:92-129.

## 3. Suggested Phase 2 order (confirm against this audit)

The task brief's suggested order holds, with two adjustments: G8 (keyboard conflicts) moves up because TR is actively misleading, and G1 is split so the tab reorder lands before the tool reorder that depends on it.

1. **G1a — Ribbon tab reorder** (Systems merge, Collaborate, Edit demotion, File handling) — one branch.
2. **G8 — Keyboard conflicts** (TR → Trim/Extend, TS for Truss, bind DI/OF/CO/MI/AR/SC/VG/TL) — one branch; verify `modify.trimExtend` works before binding TR.
3. **G6 — Draw-tool ordering/grouping** (Architecture/Structure) — one branch.
4. **G2 — Contextual Modify completion** (Measure panel, Filter, Select Previous, linked-selection honest subset) — one branch.
5. **G3 + G4 — Selection behaviours** (Tab cycle; Shift-remove; Select Previous; Filter dialog; Select All Instances) — one branch per behaviour, or one branch for Tab-cycle and one for the rest.
6. **G5 — Double-click → Type Properties** — one branch.
7. **G7 — Annotate distinctions** (tag modes, Continuous/Baseline chains) — one branch.
8. **G9 — View controls** (scale list, crop follows active view, Underlay "Below" real or removed) — one branch.
9. **G10 + G11 — Properties Type Selector; Project Browser reorder** — one branch each.
10. **G13/G14 — Temp dims in plan; snap overrides** — one branch each.
11. **G12 — Plan dockable + live-sync subset** — one branch; full unification explicitly out of scope.

Out of reach in this workstream (record, do not fake): full Family Editor on double-click; WT/WC tiled views; View Reference / Tread Number / Spell / Find-Replace annotations; true multi-view live synchronisation; Modify transforms on linked (non-editable) elements.

## 4. Test / evidence baseline for Phase 2

- Node tests live in `tests/*.cjs`, listed in `scripts/ci-unit-tests.mjs`; e2e specs in `tests/e2e/` (5 specs at this commit: smoke, document-chain, edit-undo-save, native-ifc-roundtrip, orbit-rtl). No e2e spec covers the ribbon tab order or the plan view tools directly; node tests exist for CAD ribbon layout (`tests/cad-ribbon-layout.test.cjs`, `cad-ribbon-collapse.test.cjs`, `cad-tabs-compatibility.test.cjs`) but those cover the standalone CAD viewer, not `src/shell/ribbon.ts`.
- Phase 2 branches must add: node tests asserting tab/group/tool order from a ribbon-order model (extract the order into a testable module rather than asserting on DOM), node tests for selection semantics (window/crossing, Shift-remove, Tab-cycle stack), and one Chromium spec per UI-visible behaviour, run one at a time, one retry max per the standing skip rule.
- Patches must be verified to apply cleanly to a pristine `29c222b` checkout (`git apply --check` in a scratch clone).
