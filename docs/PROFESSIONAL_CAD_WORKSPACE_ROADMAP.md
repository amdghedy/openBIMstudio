# Professional 2D CAD Workspace — Implementation Roadmap

## Product direction

The DWG/DXF editor is a standalone professional drafting application inside OpenBIMStudio. It must retain the existing drawing database, command dispatcher, rendering and transaction systems. The workspace shell should not introduce a second drawing model or parallel command implementations.

## Existing foundation verified on 2026-11-15

- Multi-document drawing tabs and a dedicated CAD shell.
- Nine ribbon tabs: Home, Insert, Annotate, Parametric, View, Manage, Output, Express Tools and Collaborate.
- Quick Access Toolbar, application menu, ribbon collapse, command entry and command aliases.
- Canvas rendering, spatial culling, window/crossing selection, grips, object snaps and dynamic input.
- Layer management, selection filters, visibility history, context menus and transactional undo/redo.
- DXF/DWG reader and export paths, layouts, plot styles, text styles, dimensions, blocks, hatches and drawing metadata.
- Existing regression suites cover ribbon layout, UI wiring, command behavior, import/export and drawing fidelity.

These are verified codebase capabilities, not a claim of complete AutoCAD compatibility. Feature depth and interoperability still need validation against representative real-world drawings.

## Milestone 1 — Quick Access Toolbar customization

Implemented on branch feat/cad-professional-workspace:

- Right-click the Quick Access Toolbar to open its customization menu.
- Show or hide Open, Save DXF, Plot, Undo, Redo, Zoom Extents and AI Copilot shortcuts.
- Persist visibility preferences in local browser storage under a versioned key.
- Restore the default toolbar without affecting drawing data or other CAD preferences.
- Existing toolbar action dispatch remains unchanged.

Validation added: tests/cad-workspace-customization.test.cjs (static source-level regression checks; run with Node).

## Next milestones

### 2 — Dockable / floating palettes
Create a shared palette host with Properties, Layers, Blocks, Xrefs, Tool Palettes, Drawing Explorer and command history. Support dock-left/right, float, collapse, resize, close/reopen and saved layout. Keep palette state separate from drawing content.

### 3 — Workspace profiles and toolbar customization
Add named profiles (Drafting, Annotation, Review, Survey), reorderable QAT actions, user-defined shortcut groups, ribbon panel visibility and reset-to-default. Persist through a versioned preferences schema with validation and migration.

### 4 — Command and interaction consistency
Audit every ribbon, context-menu, keyboard and command-line entry against the same command registry. Add command lifecycle tests for cancel, invalid input, repeat, undo/redo and document switching.

### 5 — Drawing fidelity
Build a golden DWG/DXF fixture set covering SHX/TTF fonts, MTEXT formatting, ACI/TrueColor, linetypes, lineweights, transparency, hatches, blocks, dimensions, layouts, external references and proxy/unsupported entities. Compare against named reference CAD applications and report measurable differences.

### 6 — Release gates
Require typecheck, targeted CAD tests, import/export round-trip tests, browser interaction tests and performance checks before merging. Do not mark a tool complete because a ribbon button exists; it must execute a real operation and preserve drawing data.

## Non-goals
- Do not replace the existing CAD editor wholesale.
- Do not silently flatten or discard unsupported DWG data.
- Do not claim native AutoCAD parity without fixture-based evidence.
- Do not store workspace preferences inside the drawing file unless the user explicitly exports a workspace profile.