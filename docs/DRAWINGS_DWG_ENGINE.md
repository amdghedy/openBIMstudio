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
| Load into CAD overlay | DXF/DWG | ✅ lines, circles, arcs, polylines, text |
| Load into 3D scene | DXF/DWG | ✅ THREE.Line preview |
| Layers | DXF | ✅ read + write |

## UI

| Entry | |
|-------|--|
| Purple **DWG** button | bottom-left (next to CAD / RC) |
| **Ctrl+Shift+G** | Drawings panel |
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

## Note on DWG

DWG is a proprietary binary format. Full support in-browser needs LibreDWG WASM (`@mlightcad/libredwg-web`, GPL).  
OpenBIMStudio ships a complete **DXF** engine with zero extra deps so drawings always work offline.
