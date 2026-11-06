# Drawings · DXF / DWG Engine

## Install

```bash
cp -r artifacts/src/* <OpenBIMStudio>/src/
npm run typecheck && npm run dev
```

### Optional native DWG (browser WASM)

```bash
npm i @mlightcad/libredwg-web
```

Without it, **DXF** still works fully; for DWG convert to DXF first (any CAD).

## What you get

| Capability | Format | Status |
|------------|--------|--------|
| Import drawing | **DXF** | ✅ pure TypeScript parser |
| Import drawing | **DWG** | ✅ if `@mlightcad/libredwg-web` installed |
| Export CAD sketch | **DXF** | ✅ R2010 ASCII |
| Export edited CAD drawing | **DWG** | ⚠️ local acadrust WASM writer; 2D subset, read back with the same engine in tests (not opened in AutoCAD). Versions 2000 to 2018, chosen with `DWGVERSION` |
| Load into CAD overlay | DXF/DWG | ✅ lines, circles, arcs, polylines, text |
| Load into 3D scene | DXF/DWG | ✅ THREE.Line preview |
| Layers | DXF | ✅ read + write |

## UI

| Entry | |
|-------|--|
| Purple **DWG** button | bottom-left (next to CAD / RC) |
| **Ctrl+Shift+G** | Drawings panel |
| CAD Editor application menu → **Save DWG…** | Local native DWG export |
| CAD command line → `DWGSAVE` / `EXPORTDWG` | Local native DWG export |
| CAD command line → `DWGVERSION` | Pick the AutoCAD version to write (2000, 2004, 2007, 2010, 2013, 2018+) |
| CAD panel → **Import DXF / Export DXF** | |
| Command Center → **Drawings DXF / Export DXF** | |
| Ctrl+P → “Import DXF / DWG” | |

## Modules

```
src/modules/drawings/dxf-types.ts
src/modules/drawings/dxf-reader.ts
src/modules/drawings/dxf-writer.ts
src/modules/drawings/dwg-engine.ts
src/features/drawings-panel.ts
```

## API

```js
// Import
await __obsDrawings.importDrawingFile(file)

// Export current CAD entities
__obsDrawings.exportCadAsDxf("my-plan.dxf")

// Parse / write raw
const doc = __obsDrawings.parseDxf(dxfText)
const text = __obsDrawings.writeDxf(doc)

// Push to CAD or 3D only
__obsDrawings.loadDxfIntoCad(doc)
__obsDrawings.loadDxfIntoScene(doc, { scale: 0.001 })
```

## CAD gaps (complete set)

Draw · PLine · Rect · Circle · Arc · Text · Offset · **Trim · Extend · Fillet** · Erase · Copy · Mirror · Dist · Ortho · Grid · Layers · **DXF/DWG I/O**

## Native DWG export (experimental)

The CAD editor exposes **Save DWG…** in the application menu and the
`DWGSAVE` / `EXPORTDWG` commands. It serializes the live edited 2D entity
list to DXF, then converts those bytes to native binary DWG using the
`acadrust` Rust library compiled to WebAssembly.

- **Cost:** free and open source; no paid SDK, cloud conversion, API key or
  external CAD installation is required.
- **License:** acadrust is MPL-2.0. Its source and local bridge are kept in
  `cad-engine-rust/`; see the third-party notices and upstream license.
- **Privacy:** conversion happens locally in the browser; drawing bytes are
  not uploaded.
- **Safety:** the output is signature-checked and reopened by the engine;
  entity counts are compared before download. The editor refuses export if
  hatch boundaries, skipped imported entities or paper-space entities would
  be lost by the current 2D DXF serializer.
- **Build:** CI installs the free Rust toolchain, builds
  `wasm32-unknown-unknown`, stages `public/cad-engine/obim-cad-engine.wasm`,
  and runs the DWG round-trip acceptance suite.

This is an experimental 2D CAD editor export path, not a claim of full
DWG-format coverage or arbitrary BIM/model-to-DWG export. DXF export remains
available as before.
