# Changelog

All notable changes to OpenBIMStudio are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) informally while the project is in 0.x
(pre-1.0, breaking changes may land in minor releases).

Versions before 0.73.0 are summarized by the commit history and the milestone
verification scripts (`npm run verify:v50` … `verify:v67`) rather than this
file — the project adopted a written changelog at 0.73.0.

## [Unreleased]

### Fixed: the critical CodeQL security tier — ReDoS in the relay, file-content XSS sinks, endpoint spoofing
- **Server relay ReDoS.** `tokenOk` in `server/security.mjs` parsed the `Authorization` header with a backtracking regex (`/^Bearer\s+(.+)$/i`) over attacker-controlled input — a header like `Bearer ` + thousands of spaces burned quadratic CPU on every request to the local collab/agent relay. Parsing is now linear (`slice(7)` + `trim`); same accept/reject behaviour, covered by the existing `server-security` (11) and `server-hardening` (37) suites.
- **File-content XSS sinks escaped.** Nine `innerHTML` interpolations of untrusted strings now go through `escapeHtml`: the large-IFC recovery dialog (file names, `src/features/importer.ts`), the IFC→FRAG job rows (source file name, phase, error, `src/features/ifc-to-frag.ts`), the CAD status bar's ACAD prompt text (`src/features/cad-viewer.ts`), the schedules diff banner (snapshot label, `src/features/schedules-panel.ts`), the LibreDWG toolkit overlay shell (title/subtitle carry DWG file names, `src/features/libredwg-toolkit.ts`), the base/level pickers (level names and ids, `src/features/property-palette.ts` + `src/features/plan-view-panel.ts`). A drawing or project with `<img onerror=…>` in a file or level name can no longer execute script in the studio.
- **CAD underlay href is blob-only.** The plan view's SVG `<image>` now refuses any underlay URL that is not one of our own `blob:` object URLs (`src/features/plan-view-panel.ts`).
- **Provider endpoint spoofing closed.** The AI provider routing matched endpoints by substring — `https://evil.com/?x=localhost:1234` looked like LM Studio and `https://api.anthropic.com.evil.com` looked like Anthropic. Both decisions now parse the URL and compare hostname (and port for LM Studio) exactly (`src/features/ai-providers.ts`).
- **SVG import comment stripping is now a linear state machine.** The regex pre-strip of `<!-- -->` / `<![CDATA[ ]]>` was incomplete against adversarial nesting and could unhide markup between the two replaces; a single-pass scanner drops both regions completely and treats unterminated ones as dropped to EOF (`src/modules/drawings/svg-import.ts`).
- **Secrets are never written as plaintext.** `src/core/secure-store.ts` (the encrypted-at-rest store for API keys and tokens) fell back to plain `localStorage` when the AES key was not ready yet or when WebCrypto/IndexedDB is unavailable — a pre-init write even landed plaintext and was then silently deleted by the next init's decrypt failure. Writes now defer until the key exists (then encrypt), and when encryption is genuinely unavailable secrets stay in memory for the session only. The public surface (`secureGet/secureSet/secureRemove/secureNames/migrateLegacy/secureEncryptionActive/secureFlush`) is unchanged; ai-privacy (15), project-crypto (9), secret-crypto, ai-embeddings-config re-run green.
- **The missed third endpoint check.** `resolveEndpoint` still matched `api.anthropic.com` by substring after the first two were fixed; it now compares the parsed hostname exactly like the others (`src/features/ai-providers.ts`).
- **IDS panel metadata escaped** (title/version/author from the parsed IDS file, `src/features/ids-panel.ts`).
- Verified: `tsc --noEmit` clean, production build exit 0, full `ci-unit-tests` exit 0, and the directly affected suites re-run green: server-security (11), server-hardening (37), anthropic (17), ai-presets (6), libredwg-toolkit (21), cad-insert/importSvg (23), plan-commands (7), escape-all.

### Fixed: main was red — broken production build plus six failing test ratchets
- **The production build failed on main.** The PDF → DWG one-step commit added a ribbon button using icon name `"export"`, which did not exist in the ribbon `IconName` union — `tsc` refused to compile and every CI step after the build (worker typecheck, locale integrity, unit tests, IFC corpus, dependency audit) was skipped, hiding the engine's real state. An `"export"` icon now exists (`src/features/icon-set.ts`): the mirror of the `import` glyph (arrow leaving the tray), drawn on the same 24×24 / 1.8 px grid.
- **`ci-unit-tests` was failing six suites on main.** Root causes fixed:
  - `test:region-format` — the AI Agent Bridge log stamped entries with browser-locale `new Date().toLocaleTimeString()`; it now uses the app's `fmtTime` (`src/core/format.ts`) like every other UI surface.
  - `test:ui-honesty` — the `window.__obs*` ratchet (baseline 819) had grown to 828. The Agent Bridge spelled the global name in comments/status/help text beyond need, and `wire-authoring.ts` published a second object under the existing `__obsParametric` window global — dead (no consumer ever read the wire shape) and actively clobbering authoring-core's live ParameterEngine global. The wire functions stay module exports; the bridge copy now names its API once. The ratchet is back to exactly 819 and the public bridge surface (the `__obsAgentBridge` window API, the `__obsAgent` postMessage flag, the e2e hook `__obsPdfToDwg`) is unchanged and still tested.
  - `test:cad-ocs-absorb` — the open/drop ratchet pins the exact strings `".dxf,.dwg,.bak,.sv$,.xml"` and `/\.(dwg|dxf|bak|sv\$|xml)$/i.test(f.name)`; the PDFIN commit had appended `pdf` inside both. The drawing accept list and drop regex are back to the pinned literals with `.pdf` as an explicit extra clause, so BAK/SV$/LandXML acceptance and PDF drag-drop/open both keep working.
  - `test:cad-native-engine` — the REVCLOUD catalog entry listed `["RC", "CLOUD", "REVISIONCLOUD"]`, breaking the exact-match ratchet `aliases: ["RC", "CLOUD"]`. The catalog matches the spec again; the dispatcher arm still accepts the hidden `REVISIONCLOUD` alias from the command line.
  - `test:welcome-screen` — the showcase claimed "161 keyboard-first commands" while the engine catalog is 168; all showcase copy now states 168 (hero specs, feature card, commands card).
  - `test:hatch-engine` and `test:cad-draw-order-tools` (outside the CI list — caught by running every suite) ratcheted the catalog size at 167; it is 168 since `PDFTODWG` landed. Both expect 168 now.
- Verified: `tsc --noEmit` clean; `npm run build` (the exact failing CI step) exit 0; `node scripts/ci-unit-tests.mjs` (the exact failing CI job) exit 0; all 12 suites outside the CI list green (hatch-engine 23, cad-draw-order 18, libredwg-toolkit 21, pick-arbiter 8, ai-agent 13, grip-axis-lock 15, pdf-vector 12, openings-chain 10, native-twin-linear, ai-embeddings, ai-evidence, universal-3d-grips).

### Added: the finishing layer — DRAWORDER, DIMRADIUS, ARRAYPATH (catalog 167)
- **DRAWORDER** (`DORD`, args `FRONT`/`BACK`) closes the biggest post-HATCH usability gap: paint-order control. Entities render in array order, so hatches and wipes could bury linework with no way to fix it. The selection can now be sent to front or back from Home › Modify (*To Front* / *To Back*), the right-click menu (*Bring to Front* / *Send to Back*) or the command line — with a new `"order"` undo action that snapshots the full paint order so `U` / `REDO` restore it exactly.
- **DIMRADIUS** (`DIMRAD`, `DRA`) replaces the old "radius" tool, which was a half-built two-point distance probe: the Radius button in the Dimensions group now picks a CIRCLE or ARC entity and places a persistent radial dimension (centre → picked edge, `R<radius>` label) through a new `dimrad` markup kind, symmetric with DIMDIAMETER. The new catalog entry also makes radius dimensions runnable from the command line and the AI Agent Bridge for the first time.
- **ARRAYPATH** (`ARPATH`) completes the array trio (rectangular + polar + path). New pure module `pathPointTangent` / `pathArrayEnts` in modify-math samples LINE, open/closed LWPOLYLINE, ARC and CIRCLE paths at equal parameter intervals (open paths include both endpoints; closed loops never duplicate the start), optionally rotating each copy onto the path tangent (AutoCAD "Aligned" semantics). Flow: select objects → `ARRAYPATH` → pick the path → items (2–500) → align Yes/No; right-click › *Path Array* does the same. Sources are never mutated, the 10,000-entity cap holds, and validation rejects unsupported/zero-length paths with explicit messages.
- Covered by `tests/cad-draw-order-tools.test.cjs` (`test:cad-draw-order`, 18 checks: path sampling on all four path types, endpoint/closed-loop placement, aligned vs unaligned orientation, immutability, validation, and the full catalog → dispatcher → ribbon → context-menu → act → undo wiring); `tsc --noEmit` clean; cad-ribbon-layout (22), hatch-engine (23), cad-viewer (57), cad-ui-wiring (12), ai-agent (13), pdf-vector (12), shortcut-keys (13), cad-tools (9), modify-registry (7), cad-ai (7) re-run green.

### Added: HATCH 2.0 — pattern hatching with pick-point boundary detection
- The 2D Drawing Editor's HATCH went from "solid fill on a closed polyline" to production hatching. **Pick-point boundary detection** (BHATCH-style): click inside any fully enclosed area and the boundary is found — the smallest closed object containing the point first, and when the region is only formed by open entities (four loose wall lines, a crossing partition), the crossings are split into atomic edges and the face containing the point is traced with the standard planar "next edge CCW after the reverse" walk (both orientations tried, smallest containing loop wins; endpoint gap quantisation lets nearly-touching corners close). `BOUNDARY`/`BPOLY` runs the same detection and creates just the closed polyline. Text, points and infinite construction lines never bound a hatch; traced regions fill over islands (documented v1 limit); face tracing caps at 2,500 segments with an explicit message beyond.
- **13 ANSI/ISO-style patterns as real DXF pattern-line definitions** (`src/modules/drawings/hatch-patterns.ts`): SOLID, ANSI31–ANSI38, NET, CROSS, DOTS, EARTH — angle/base/offset/dash families in pattern space, the exact codes the DXF HATCH entity writes (53/43/44/45/46/49 + 52/41 semantics), so authored hatches export as genuine patterned HATCH entities that native CAD renders with the same look.
- **Hatch & Boundaries panel** (HATCH, or Home › Draw II › Hatch Panel): a tile gallery whose previews are drawn by the very same `hatchPatternLineSegments` generator the drawing canvas uses, scale/angle fields, Pick inside an area / Boundary only / Edit hatch / Remove hatch actions, draggable, settings persisted per browser (`obs.cad.hatchDefaults`). `HATCH <pattern> [scale] [angle]` presets from the command line — agent-friendly via the AI Agent Bridge.
- **Hatches pick on their fill**: `pickEntity`/`pickEntities` treat a point inside a closed hatch's loops as a hit at 0.75·tol — clicking an empty hatch area selects it while a line under the cursor still wins. `HATCHEDIT` (selection-based, or `HATCHEDIT <pattern> [scale] [angle]` / `HATCHEDIT REMOVE`) restyles hatches from the CLI.
- **Honest pattern round trip**: `DxfHatch.patternSpace` marks families that still carry the hatch's angle/scale (authored + DXF imports — the DXF reader now parses the 78/53/43/44/45/46/79/49 definition block); DWG-imported drawing-space families render as-is and export at angle 0 / scale 1, fixing a double-transform when re-exporting DWG-imported hatched files to DXF. Catalog is 164 commands (`HATCH`, `BOUNDARY`, `HATCHEDIT` new aliases `H`/`BHATCH`, `BPOLY`, `HE`).
- Covered by `tests/hatch-engine.test.cjs` (`test:hatch-engine`, 23 checks: pattern library + transform math, tier-1/tier-2 detection incl. circle, room traces, crossing split, shared-wall rooms, open-floor rejection, complexity cap, DXF patternSpace round trip through the real writer/reader, inside-fill picking, catalog/dispatcher/ribbon/palette/act wiring); `tsc --noEmit` clean; cad-ui-wiring (12), cad-ribbon-layout (22), ai-agent (13), pdf-vector (12), modify-registry (7), shortcut-keys (13), cad-tools (9) re-run green.

### Added
- **PDF → DWG in one step.** File menu → *PDF → DWG…*, the Drawing Editor ribbon (Insert → PDF Import → *PDF → DWG file…*) or the command `PDFTODWG`: pick a vector PDF, choose pages (`all`, `1`, `2-4`), choose DWG or DXF and scale (true-size mm or raw points) and the file downloads (a zip of one DWG per page when several). Converted locally; nothing is uploaded. It reuses the existing PDFIN extractor and the CAD WASM DWG writer; empty/scanned pages are reported, never silently dropped. Verified with the real pdf.js extractor and the real CAD WASM in Node (`tests/pdf-to-dwg.test.cjs`: 3-page PDF, DWG read back, text/lines/mm scale survive) and by a real-Chromium test that downloads a binary DWG. Not verified: opening the DWG in AutoCAD/BricsCAD/Revit, large or scanned production PDFs, fonts (text keeps position and size, not the typeface).

### Fixed
- **Walk mode walked through IFC walls and ignored IFC floors.** IFC models are drawn by the fragments engine and keep no triangles on the main thread, so the walker's plain three.js rays threw and were swallowed: no collision, no floor. Walk mode now asks the model's own raycast (asynchronous) and applies the results as world-fixed wall planes and floor heights every frame, so the answer delay cannot let you slip through. One un-testable mesh no longer hides the others (authored walls and the ground now work next to an IFC model). Probing follows the keys you hold, and the wall is resolved after each step, which removed a 7 cm shake when pressing against a wall. Verified in real Chromium: walking 4.5 s into a 5 m wall stops at exactly the wall face plus body radius (z 0.42), speed varies 3% frame to frame, no shaking, Esc returns the orbit camera.
- **3D dimensions (Measure tool).** Esc now cancels the dimension being drawn, removes its leftover first-point marker and ends the dimension command in one press. Finished dimensions stay on screen (previously each new dimension erased the previous one's lines and labels) until you press Clear measurements, which deletes them all. Verified in real Chromium with real clicks: 2 dimensions stay, a half-drawn third is cancelled by Esc, Clear leaves 0 graphics, 0 labels.
- **Section Box face arrows could not be dragged, and froze the camera.** Pressing an arrow disabled the orbit controls, but the move/up events never reached the handler (the input router stops them), so the face did not move and the controls stayed disabled. The handler now listens in the capture phase. Verified in real Chromium with a real mouse drag: the +X face moved from 3.0 to 1.77, still exactly 6 planes, camera released afterwards.
- **Section Box leaked clip planes.** Editing the box (dragging a face, grow/shrink, reset) added six new ThatOpen clipper planes without removing the old ones, and switching the box off left them all active, so the model stayed clipped. Cause: `Clipper.delete(world, id)` takes the list key, not the plane. Planes are now found by geometry and deleted by key. Verified in real Chromium (CI): 6 planes on, still 6 after an edit, 0 after Off, and half the wall disappears when the box is halved.

### Fixed: the plan-view openings chain verified in a real browser — six breaks found and closed
- The core documentation chain (draw wall → place door/window → annotate → schedules → sheets → export) was walked end-to-end in a live browser. Six real breaks surfaced and are fixed, each now guarded by `tests/openings-chain.test.cjs` (`test:openings-chain`):
  - **Doors/windows placed in the Floor Plan were authored as unhosted `equipment`.** The plan view mapped the door/window tools onto the generic point placement (`type: "equipment", preset: "door"`), so the element carried the wrong type and no `hostId`: Door/Window schedules (IFCDOOR / IFCWINDOW) returned 0 rows with a door in the model, the wall was never cut in 3D, the plan drew a plain equipment box instead of the swing symbol, and clash/export layers misclassified them. Plan door/window placement now routes through a new `authoring.addHostedOpening()` (finds the wall under the click, hosts the element, clamps the offset, mirrors the 3D path's parameters), and clicking off-wall keeps the tool active with "click on a wall to insert". Verified live: plan shows the poché gap + swing arc, the 3D wall mesh drops from 11.098 to 10.384 m³ (112 triangles), and Door/Window/Wall schedules each return their row.
  - **Saved projects with the old mistyped openings are repaired on load.** `setElements()` retags equipment elements carrying `properties.category "door"/"window"` and hosts them on the wall under their stored point; elements with no wall under the point are left untouched rather than converted into invisible hostless doors (a door mesh only builds against its host).
  - **Wall take-off ignored openings.** The quantity formula was `L × H × T` solid, so every wall with a door or window overstated volume/area by exactly the punched-through amount. The take-off now deducts hosted openings per wall and matches the cut mesh to the milliliter (10.384 m³ live). Curtain/arc walls stay chord-based approximations, noted in the registry.
  - **Escape was dead for every classic keydown listener.** Two stacked causes: the escape-all `ui-transients` scope tested `getElementById("obs-cad-query-panel")?.style.display !== "none"`, which is TRUE when the element is absent (undefined ≠ "none"), so the scope claimed a cancel on every bare press and the sweep consumed the key; and the plan view's capture handler called `stopImmediatePropagation()` on every bare Escape even when nothing was active ("Nothing to cancel"), starving every panel stacked above the plan. Both now follow the documented contract — the key is consumed only when something was actually canceled. Verified live: the Schedules panel's "Esc to close" closes again.
  - **"Toggle Sheets" was a dead palette command.** The palette (and drafting-bridge) resolve the sheets panel under the service key `sheetsPanel`, which nothing registered — the same break class the schedules panel had. The Sheets (2D) panel now registers the facade and aliases its feature handle.
  - **The Sheets panel opened invisibly behind the Floor Plan.** It sat at z-index 36 under the plan workspace overlay (z=200), so sheets could only be seen from other workspaces. Raised to the Schedules tier (340). Verified live: create sheet → add viewport (authored plan renders inside) → Export SVG issues a real `A-001.svg` download; "Place on sheet" from the Schedules panel lands on sheet A-001.
- Registry entries `authoring-tools`, `sheets-views-pdf` and `schedules-cost` updated with the real-browser evidence and the remaining honest limits (viewport fit is extent-based; arc/curtain take-offs stay approximations; the repair only fixes mistyped openings that have a wall under their point).

### Added: AI Agent Bridge — external AI clients (AlphaCLI / AlphaCode) drive the engines
- New **AI Agent Bridge** (`src/features/agent-bridge.ts`) connects AI chats and agents to openBIMstudio so they can issue orders **directly into the engines**. Four channels, all funnelling through one audited log: **window API** `__obsAgentBridge` (`exec("CIRCLE 0,0 50")`, `ask("draw a gear profile")`, `state()`, `commands()`, `log()`, `on()`), **postMessage** protocol (`{ __obsAgent: true, type: "exec"|"ask"|"state"|"commands", text }` — origin allow-listed, `https://alphacli.github.io` allowed by default, more via `obs.agent.allowedOrigins`), **URL deep links** `#agent-cmd=<enc>` / `#agent-ask=<enc>` (one-shot after boot), and an **opt-in local relay** on the collab server: terminal AI agents POST `/api/agent/exec` (`{"cmd":…}` or `{"ask":…}`) → SSE `/api/agent/events` wakes the connected browser session → the order runs in the engine → `/api/agent/result` returns the outcome to the agent's HTTP request (20 s timeout, rate-limited, Bearer-token auth, size-capped orders, 503 when no studio is connected).
- Orders take exactly the user paths: CAD command strings run through `runCadAiCommand` (the real command-line dispatcher — a closed editor is auto-opened and the order retried), natural-language asks go to the AI copilot's approved tool loop; nothing bypasses the UI. `AGENT` (aliases `AGENTBRIDGE`, `BRIDGE`, `ALPHACLI`, `ALPHACODE`) opens the dock; a new **Agent Bridge** button sits in Home › AI Copilot. The dock shows engine/relay status, a try-it box (Run / Ask AI), the live order log and a **Copy Snippet** button with ready-to-paste console + `curl` examples for AlphaCode.
- New `getCadCommandCatalog()` export (161st catalog entry) lets agents discover every command name + alias before running them. Covered by `tests/ai-agent-bridge.test.cjs` (`test:ai-agent`, 13 checks); `tsc --noEmit` clean; relay endpoints smoke-tested live (auth 401 / empty-body 400 / no-studio 503 / status 200).

### Added: Convert PDF to Drawing (PDFIN) — vector PDF → editable drawing, fully local
- The 2D Drawing Editor can now **convert a vector PDF into an editable drawing** — the "Convert PDF to DWG" workflow, built in: stroked paths become LINE/LWPOLYLINE entities, filled areas become closed boundaries on a *PDF Fill* layer, text runs keep position/height/rotation as TEXT, colours are carried as true colour (near-black stays BYLAYER so it renders on dark and light backgrounds), and the result opens as a normal drawing tab true-size in millimetres (1 pt = 0.3528 mm; `PDFIN 72` keeps raw PDF points). From there **QSAVE** writes DXF and **DWGSAVE** writes DWG, completing the PDF → DWG conversion.
- **Everything is parsed locally in the browser** with the bundled PDF.js (same-origin worker, no CDN) — the PDF is not uploaded to the cloud, matching the local-first privacy model.
- Wired on every surface: `PDFIN` / `PDFIMPORT` / `PDF2DWG` on the command line (autocomplete included, `PDFIN N` converts page N), **Insert tab → PDF Import → PDF to Drawing…**, App menu → *Convert PDF to Drawing…*, drag & drop of `.pdf` onto the editor, and the welcome screen *Open DWG / DXF / PDF…*. Details and limits: `docs/PDF-IMPORT.md`.
- Honest limits (v1): vector PDFs only (scanned PDFs are refused with an explicit message), raster images skipped and counted, clipping paths discarded (counted), Béziers flattened to 16 segments, fonts not matched, one page per conversion.
- Implementation: `src/modules/drawings/pdf-vector.ts` handles the installed pdfjs-dist v6.5 operator packing (constructPath `[paintOp, [interleaved DrawOPS], minMax]`, CSS-string colours) as well as the pdf.js 4–5 and legacy unpacked forms. Covered by `tests/pdf-vector-import.test.cjs` (`test:pdf-vector`, 12 checks: real pdf.js extraction of strokes/fills/cubic/text, colour and BYLAYER policy, both scale modes, page-range errors, DXF round trip through the standard writer); `test:cad-ribbon-layout` pins the new ribbon group to the Insert tab; `tsc --noEmit` clean.

### Fixed: 2D Drawing Editor wiring audit — one missing ribbon button and five hidden command tokens
- The standalone 2D Drawing Editor's command layer was audited end-to-end (command catalog → dispatcher → ribbon → command line → keyboard shortcuts) against the README: every catalog command has a dispatch arm, every documented Modify tool has engine code, a ribbon entry and its alias, and all absorbed OpenCADStudio features (embedded DWG preview, CTB/STB plot styles, BAK/SV$ recovery, LandXML CgPoints, Entity Data CSV export, RAY/XLINE) are wired to their UI, drop and command-line entries. Three gaps surfaced and are closed:
  - **PEDIT had no ribbon button.** The handler existed (`act.pedit` → `executeDrawingCommand("PEDIT")`) but was reachable only by typing. A **Pedit** button now sits in Home › Modify II next to Join.
  - **Five command-line tokens were invisible to autocomplete and the alias dialog** (`POLYLINE`, `DELETE`, `REVISIONCLOUD`, `SNAPMODE`, `-INSERT`): the dispatcher accepted them but the command catalog did not list them, so exact-token Space commit and the KS alias editor missed them. They are now aliases of PLINE / ERASE / REVCLOUD / SNAP / INSERT respectively.
  - **SELECTSIMILAR was registered twice** in the command catalog (duplicate row, both with the SELSIM alias); the duplicate is removed. The catalog is now 160 commands with no duplicate names and no duplicate aliases.
- Wiring suites re-run green after the change: `test:cad-ui-wiring` (12), `test:modify-registry` (7), `test:cad-tools` (9), `test:cad-ribbon-layout` (22), `test:ui-reachability` (17), `test:cad-context-menu` (11), `test:cad-clipboard` (13), `test:shortcut-keys` (13), `tsc --noEmit` clean.

### Fixed: schedules chain verified in a real browser — three breaks found and closed
- Drawing walls and running a Wall Schedule end-to-end (command palette → panel → template → quantities → totals → place on sheet) was exercised in a live browser for the first time. Three breaks surfaced and are fixed:
  - **"Toggle Schedules" and every "Schedule: …" palette command did nothing.** The panel exposed `ctx.features.schedules`, but the palette, the built-in templates and the workspace boot resolve the service key `schedulesPanel`, which nothing registered. The panel now registers the service facade (and the palette no longer advertises `Ctrl+Shift+S` for it — that key toggles the Scope Box Visualizer).
  - **First run of a schedule showed empty Length/Area/Volume for authored elements.** The take-off cache was warmed only after the authored rows were built, so every cold run attached no geometry quantities. The cache now warms first; a wall schedule run shows 19.422 m / 116.532 m² / 11.653 m³ on the first run, matching a direct take-off probe.
  - **Subtotals and grand totals summed per-element dimensions** — a wall schedule total read "Height 6.000 m" (3+3) and "Thickness 0.400" (0.2+0.2). Totalling policy now lives in `src/modules/schedules/schedule-totals.ts` (quantities and formula columns sum; width/height/thickness/depth/elevation and text/date never do) and is covered by `tests/schedule-totals.test.cjs` (8 checks, `test:schedule-totals`).
- Also fixed on the way: the app failed to boot in dev mode with "Cannot access 'activeToolLabel' before initialization" (white screen) — the drawing.ts shim read `authoringLabel` eagerly across the authoring ↔ drawing import cycle; it is a pure re-export now (`7e557d3`).

### Added: Export views to CAD (DWG / DXF)
- File menu → Export → *Views → CAD*, and the *Export: Views to CAD* command, export plan / RCP / section / elevation views as DWG or DXF (one file per view, ZIP for several) with AIA-style layers, true colours, lineweights, dashed linetypes, text sized from paper height × scale, hatches, units (mm / m), layer prefix and DWG version. Details and limits: `docs/EXPORT-VIEW-TO-CAD.md`. Not opened in AutoCAD/Revit.
- Same dialog: **3D model → DXF** writes the authored 3D model as 3DFACE triangles (DXF R12) on layers by element type with Z up, in mm or m, optionally selected/visible elements only. Includes loaded IFC/Revit models (layers by IFC entity, 4M-triangle cap) via the Native Twin geometry reader; no solids; no DWG. The IFC path has not been run on a real model in a browser.

### Added: smooth navigation
- While you orbit, pan or zoom the 3D view is drawn at a lower resolution (half the device pixel ratio, between 0.5 and 1) and returns to full sharpness 0.22 s after you stop. On by default; toggle with *View: Smooth navigation (lower resolution while moving)*. A browser test checks the ratio drops while dragging and is restored. **Whether it removes the lag on your model is not measured** (CI renders in software).

### Verified: the DWG path of Export views to CAD
- `tests/export-cad-dwg.test.cjs` converts a view to DXF, then to binary DWG in the real CAD WASM, and reads it back: layers, entities, text height, hatches, colours, linetypes and mm coordinates survive. Not opened in AutoCAD/Revit.

### Changed: grips show a grab hand
- Hovering an editable (orange) grip in select mode now shows an open-hand cursor; the closed hand while dragging was already there. Covered by a real-browser spec (`tests/e2e/orbit-rtl.spec.ts`, informational CI job).

### Fixed: 3D orbit rolling and stuttering
- Orbiting (middle-mouse + modifier, and Shift+left-drag) now restores the camera's up vector to world +Y at the start of the drag, so a tilt left behind by a Top/saved/section view no longer makes rotation roll the picture, and applies at most one camera update per animation frame instead of one per pointer event. Logic covered by `tests/orbit-frame.test.cjs`. A CPU profile of an orbit over a 1,600-wall IFC (CI, headless Chromium with *software* WebGL) found no JavaScript hot spot: 95.5% of the time was native `(program)` time (software rasterising), the largest JavaScript function was 0.3%. So the lag is not a JS cost in the orbit path; on a real GPU this model should not lag, but that was **not measured**. If you still see lag on your model, the cost is on the GPU side (draw calls, shadows/post-effects, very large meshes) and needs a profile on your machine.

### Family sketch editor (experimental)
- Parametric Families panel: **Sketch profile…** and **New from sketch…** open a grid canvas to draw a plan outline (polygon, rectangle, circle), set depth and elevation, and add it to a family (built-ins are copied) or create a new one. Outlines are validated (≥3 points, no self-crossing). Limits and verification: `docs/FAMILY-SKETCH.md`.
- Sketch shapes can now be **parametric** (rectangle → width/length parameters, circle → radius parameter, so they resize) and can have **holes** (draw the outline, press *Next: draw hole*, draw holes; holes must lie inside the outline and not overlap). Core and CI geometry checks added; the drawing window still has not been used in a real browser.

### Right-to-left readiness (issue #141, partly)
- The core stylesheets (`src/style.css`, `src/styles.css`) now use logical properties (`margin-inline-end`, `border-inline-start`, `inset-inline-end`, `text-align: start`) instead of left/right, so the ribbon, toasts, cards and KPIs mirror under `<html dir="rtl">` (set already for Arabic, Persian, Hebrew, Urdu) and render the same as before in LTR. A test keeps physical properties from coming back.
- **Not done and not verified:** nothing was viewed in a browser in Arabic or Hebrew. Inline styles written in TypeScript (`style.cssText` in about 200 places), directional icons (undo/redo, chevrons, arrows), the 3D viewport tools and the drawing editor were not audited, and the issue's 100-string pseudo-localisation pass was not done.

### ICU messages and region-aware formatting (issue #140, partly)
- Catalog strings may now use an ICU MessageFormat **subset**: `{n, plural, =0{…} one{# …} other{# …}}`, `select`, `{n, number}`, `{d, date}`, nesting and apostrophe quoting (`src/core/icu-lite.ts`). Plain `{name}` strings and the existing `{one, other}` plural objects keep working unchanged. Plural categories are checked for en, ar, ru, pl and fr.
- New `fmtNumber`, `fmtDate`, `fmtTime`, `fmtDateTime` in `src/core/region.ts`; about 15 UI files that used the browser's own locale (`toLocaleString()`) now follow the active region profile. A test fails if new ones appear in `src/features` or `src/shell`.
- **Not done:** the `intl-messageformat` library was not added (no package install available); `selectordinal`, plural offsets and date/time styles are unsupported. `toLocaleString()` calls in `src/modules` (reports, exports) are not migrated, and no catalog has been rewritten to use ICU yet.

### Standards packs as JSON (issue #144)
- Standards → **Load pack file…** (or drop a file on the panel) loads a rule pack written as JSON: data only, validated, with documented operators, units and limits (`docs/STANDARDS-PACK-SCHEMA.md`, `docs/schemas/standards-pack.schema.json`, example in `docs/examples/`). Not done: exporting the built-in packs to JSON (their rules are code), and ajv validation (no dependency; hand-written validator).

### STEP / IGES / BREP and Rhino 3dm view (experimental)
- Open `.step .stp .iges .igs .brep` (occt-import-js) and `.3dm` (rhino3dm) from Open File, drag-and-drop or Link many. Tessellated, view-only copies in metres; summary lists what could not be drawn. The prebuilt WebAssembly is vendored by the "Vendor drawing readers" workflow (licences: docs/THIRD-PARTY-VENDOR.md). Tested on cube fixtures and upstream sample files only.

### Fixed
- Seed families **Rectangular Concrete Column** and **Universal Steel I-Beam** were rejected at boot ("not a valid FamilyDefinition") because they had no geometry; both now define it (the beam gains a `length` parameter, default 6 m).
- Boot no longer logs a missing `standards.title` translation, a blocked Google Fonts stylesheet, or a failing request to the retired `api.counterapi.dev` counter; garbled `Â·` in one log line fixed.
- Dropping a external BIM authoring software, GLB/OBJ/FBX, GeoJSON or Shapefile onto the viewport did nothing (only IFC, FRAG and DWG/DXF were handled). These now go through the universal importer.

### Link many files in one step
- Selecting several files (Insert → Any model…, Link drawing, the external BIM authoring software picker, or the palette command "Link many files at once") now links each kind together: several DWG/DXF files share **one** link dialog and the same placement settings, several external BIM authoring software files open in sequence with one combined result line, several IFC files load as one batch. Unreadable files are skipped and listed instead of stopping the batch.

### GIS site context (experimental)
- **GeoJSON and Shapefile** (`.geojson`, `.shp` with optional `.dbf`) open from Open File as flat outlines on the ground plane. Context only: not georeferenced to the model, `.prj` not read. Tested on hand-built files only.

### 4D/5D schedule import (experimental)
- **Microsoft Project XML (MSPDI)** and **CSV task schedules** can be imported in the timeline panel next to Primavera P6. The format is detected from the content. Binary `.mpp` is not supported. Tested only against hand-written fixtures, not files from real MS Project.

### external BIM authoring software view: browser and tools (experimental)
- **external BIM authoring software browser** (File tab, command palette): every element of an opened external BIM authoring software file in a tree grouped by IFC class, level or material, with search across names, classes, levels, materials, ids and property values; click to select (Shift/Ctrl for several), double-click to zoom, per-group select and show/hide.
- **Multi-select** (Shift/Ctrl-click) with a combined panel; **Hide**, **Isolate**, **Show all**; **Select same class / level / material**; **Make editable native twins** for the whole selection.
- **Export to CSV**: a schedule of the selected (or all) elements with identity, level, material, placement, size and one column per decoded property; spreadsheet formulas in property text are neutralised.
- Hide/isolate is per session (not saved with the project). Tested as pure logic; the panels and menus have not been run in a browser.

### external BIM authoring software view: select, inspect, make editable (experimental)
- Click an element of an opened `.rvt` / `.rfa` to select it and see the properties the decoder read (identity, level, material, placement and size, property sets; metric with the file's imperial value alongside). Properties are embedded in the 3D file itself, so they survive saving the project, reopening it and opening it on another device.
- Right-click an element → **Make editable native twin**: creates a real authored element (same path as IFC Native Twins) with the element's triangles and properties; the external BIM authoring software source is hidden while the twin exists and returns if the twin is deleted. Twins take part in clash tests, schedules and edits like any native element.
- The twin is a tessellated copy, not external BIM authoring software's parametric definition, and nothing is written back to the `.rvt`. Only properties the decoder can read are shown.
- Verified with the real WebAssembly decoder on a synthetic wall (its properties match the decoder's own info panel). Not yet exercised on a real project file in a browser.

### View external BIM authoring software files (experimental, view only)
- Open `.rvt` / `.rfa` files for viewing, decoded inside the browser tab (nothing uploaded) by the third-party rvt-rs reader compiled to WebAssembly. Entry points: drag and drop / Open, File tab → View external BIM authoring software File, command palette.
- Every open states the decoder's own confidence; a file that decodes to structure only is reported as "nothing to draw", not as success. Result is view-only geometry (no external BIM authoring software parameters, not in clash tests).
- The decoder is an optional build step (`npm run build:rvt`, run automatically and non-blocking by the deploy workflow); without it the app says so and points to IFC export. Pinned to a specific rvt-rs commit; Apache-2.0 licence and notice are shipped in `public/rvt/`.
- Tested with a fake decoder only. Not yet run against the real WebAssembly or a real external BIM authoring software file.

### Clash detection (audit and fixes)
- Found by test and fixed: an element fully inside another (a pipe embedded in a wall) was never reported as a clash; elements whose boxes overlapped but whose surfaces were apart were falsely reported as "touching"; heavy elements had triangles silently skipped (now all or nothing, up to 120,000 triangles, never thinned).
- Native elements modelled in this app are now part of clash tests (they were offered in the category dialog but never reached the engine).
- Selection A versus B now means exactly that: category against category inside one IFC file, host against linked model, native against IFC. Before, two selections in the same model tested nothing.
- The "Clash by category" dialog called a function that did not exist, so it always ran with empty selections; fixed.
- Contact up to the tolerance is "touching" (a wall resting on a slab is no longer a clash); distance is now measured on the real surfaces, not the boxes.
- The status line now says how many elements were tested, how many only by bounding box, and how many were skipped, so "No clashes found" can be judged.
- 36 new tests on real triangle meshes (engine) and scope planning. Not run against real IFC files in a browser; 100% detection cannot be guaranteed.

### drawing Insert tab
- New Insert tab groups: Block (Insert, Create, Write Block, Library, Explode), Import (DWG/DXF, File as Block, SVG) and Annotation (Field, Table, MText). Commands BLOCK/B, INSERT/I, WBLOCK/W, BLOCKLIB, SVGIMPORT, FIELD. `INSERT` now inserts a block as in desktop drafting software; merging a file is `IMPORT`.
- Blocks are editable copies with a library shared by all tabs (stored in this browser). No block references, attributes, raster images, XREF or PDF import yet. Logic is unit-tested; the UI has not been run in a browser.

### AI assistant
- Claude is now a native provider (Anthropic Messages API: streaming, tool use, model list, specific error messages). Each user pastes their own Anthropic API key; it is stored in the encrypted local store and never shared. Old "OpenAI-compatible + api.anthropic.com" setups migrate automatically.
- Added presets for xAI Grok, Fireworks, SambaNova, NVIDIA NIM, Hyperbolic, Moonshot Kimi, Alibaba Qwen and local llama.cpp / vLLM / Jan (alongside Ollama, LM Studio, Gemini, Groq, OpenRouter, Cerebras, OpenAI, DeepSeek, Mistral, Together, Claude). Presets moved to `ai-presets.ts`; a test checks every cloud host is in the CSP. Model ids are defaults and not live-checked; any other OpenAI-compatible service works via a custom endpoint.
- A Claude.ai free/Pro login cannot be used by third-party apps, so there is no "sign in with Claude" path. Not yet exercised against the live API.

### Milestone: polish and drawing/plan workflow pass

Everything below is covered by unit tests and a type-check; none of it has been
run in a browser yet (see `tests/e2e/README.md`).

- **MTEXT reads like native drawing.** The column width and line-spacing factor of
  an MTEXT are kept: notes word-wrap inside their own column instead of
  stretching one long line across the drawing, hard-splitting words that do
  not fit like desktop drafting software. Inline `\C`/`\c` colours and `\f` bold/italic flags
  become styled runs the viewer paints per segment, so a note keeps its red
  warnings and bold titles. The DXF writer no longer corrupts the group stream
  when a multi-line text is saved: one TEXT per visual line, offset along the
  text's own baseline direction exactly as drawn. Measurement text of
  dimensions honours DIMDEC, DIMPOST and DIMLFAC from the DIMSTYLE table (with
  entity-level overrides), so "200 mm" renders instead of "200.00".
- **2D plan command line.** Type a command or alias (`WA`, `L`, `DI`, `Z`, `U`,
  `E`...) with autocomplete and history; Enter or Space repeats the last command;
  `x,z`, `@dx,dz`, `d<angle` and plain lengths place points directly. Esc cancels
  every active order (paths, typed lengths, dimension picks, drags, tool,
  selection) and no longer closes the plan.
- **drawing editor.** 40 linetypes, 24 lineweights, 28 fonts and 10 text styles with
  managers, Match Properties, and a DXF writer that keeps linetypes, true colour,
  text styles, layer state, hatch fills and the first paper-space layout.
- **Walls.** Baseboards, cornices and wainscots export to IFC; reveals are cut into
  straight walls and export as IfcOpeningElement. Doors and windows have an options
  bar for width, height and sill height.
- **DWG.** Export now keeps hatch fills and every paper-space sheet (names are not kept), and you can
  choose the desktop drafting software version it writes (`DWGVERSION`, 2000 to 2018+). A new test runs
  the real DWG engine in Node: DXF to DWG to read-back for every version and for the
  repo's DWG fixtures. Not yet opened in desktop drafting software itself.
- **DWG reading fix.** A DWG with one sheet used to open as two identical sheets, and
  content of extra sheets could appear in model space; both are fixed and tested.
- **UI.** Double-click a ribbon tab to collapse it; full screen hides command bars;
  Clash Review is dockable; every blocking prompt/confirm/alert is a dialog.
- **Honesty and structure.** Feature Status registry, UI-honesty guard tests, an
  architecture document, release-specific names removed, and the number of
  `window.__obs*` references reduced from 901 to 818 behind a ratchet test.

### Known gaps

- LAZ, E57 and RWCX point clouds (LAZ needs the `laz-perf` dependency).
- DXF/DWG: blocks are saved exploded and plain DXF saves only the first layout; Autodesk compatibility of written DWG files is unverified.
- Browser smoke tests exist but are not in CI.

### Added

- external BIM authoring software-style section box face arrows: each of the six crop faces now carries
  a double-headed drag arrow pointing along its face normal, next to the
  translucent drag quad. Grabbing the arrow (or the quad) stretches or
  shrinks that face live; hovering highlights the face. Arrow orientation is
  pinned by unit tests (every face rotation must map local +Z onto the
  outward normal) alongside new pure helpers `faceNormal`, `faceCenter`,
  `ARROW_SPEC` in `section-box-math.ts`.
- Region-profile service (`src/core/region.ts`): 20 country profiles unifying
  language, units, currency, paper sizes, date formats and standards packs;
  wired into Settings as a single "Region profile" control with browser
  auto-detection on first run (PR #137).
- Fourteen locale catalogs (fr, es, pt-BR, it, zh-TW, ko, ru, tr, pl, nl, hi,
  he, fa, ur) bringing the UI to 19 languages.
- GCC standards pack (`src/modules/standards/rules/packs/gcc.ts`): UAE FSC
  2018 fire rules, SBC 201 egress rules, Dubai Build accessibility rules and
  USSC issue categories, registered in the built-in rule-pack index.

### Changed

- Repository governance: squash-only merges with branch auto-deletion,
  linear-history branch protection on `main`, required CI status checks,
  Discussions enabled, curated issue backlog (#140–#144), stale branches
  pruned.
- Repository hygiene pass: disabled one-shot recovery workflows removed;
  23 single-use fix/repair scripts moved to `scripts/archive/`; test fixtures
  consolidated under `tests/`; README de-duplicated (release notes now live
  here); CONTRIBUTING rewritten with the actual workflow, commit conventions
  and AI-assistance policy.

### Fixed

- `.gitignore` no longer excludes the golden IFC corpus
  (`tests/fixtures/ifc-corpus/`), whose sources had been silently kept out of
  version control — leaving the golden-roundtrip CI gate running against an
  empty corpus (0 files). The corpus folder is documented in its README; see
  `docs/engineering/ISSUES.md` (P1-03) for the rebuild plan.

## [0.74.0] — 2026-11

### Added

- Cursor-accurate wheel zoom with a guaranteed orientation invariant: zooming
  never rotates the camera (`tests/wheel-zoom-orientation.test.cjs`,
  `tests/cursor-zoom.test.cjs`).
- Full Content-Security-Policy with a self-hosted Fragments worker
  (`docs/CSP.md`).
- Trimble point-cloud import assistant: real LAS (1.0–1.4, RGB) and PTX
  parsers with survey-coordinate recentering; explicit guidance for
  proprietary formats (.rwcx, .rcp, .rcs, .fls, LAZ, E57).
- Point-cloud management actions; contextual `Modify | <Category>` tabs;
  multi-element dimension editing; Flip and one-undo batch edits.

### Changed

- desktop drafting software-style drawing shell ribbon (tabs above, panels below, drawing tabs under
  the ribbon); external BIM authoring software-style contextual placement tabs with a real options bar
  (level, dimensions, location line, join, chain, offset, justification,
  slope) for every placement tool.

## [0.73.0]

> Earlier release — exact date not tracked here; see the commit history.

### Added

- Justification-aware wall & MEP modeling with magnetic snapping and
  persistent snap relationships (`tests/magnet.test.cjs`,
  `tests/linear-follow.test.cjs`).
- Dependent-geometry updates applied in a single undo step
  (`tests/boundary-edit.test.cjs`).
- Dynamic per-tool property panels and stronger family/parametric workflows
  (`tests/v73-just`, `v73-mag`, `v73-panels`, `v73-rel` suites).

[Unreleased]: https://github.com/amdghedy/openBIMstudio/commits/main
[0.74.0]: https://github.com/amdghedy/openBIMstudio/releases
[0.73.0]: https://github.com/amdghedy/openBIMstudio/commits/main
