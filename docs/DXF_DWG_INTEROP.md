# DXF / DWG interoperability — openBIMstudio

This is the precise, evidence-based statement of what the 2D drawing engine
(`src/modules/drawings`, `src/modules/cad-link`) reads and writes for DXF and
DWG, what it only partially preserves, and what it explicitly does not. It
complements `docs/COMPATIBILITY.md` (platform-wide format matrix).

**The honesty rule this document follows**

> An internal read-back test (our reader reading our writer's output) is never
> described as proof of external compatibility. External evidence comes from
> independent implementations only: **ezdxf** (Python, DXF) and **LibreDWG**
> (WASM, DWG). Passing those checks evidences standards conformance and
> faithful data handling — it is **not** certification that a specific desktop
> CAD product opens the files, and no desktop CAD application was run to
> produce this document.

## Validation stack

| Direction | Independent validator | Test | Notes |
|---|---|---|---|
| DXF import fidelity | ezdxf (independent parser) | `tests/dxf-independent-validation.test.cjs` | The committed corpus `tests/fixtures/dxf-corpus/` is *authored by ezdxf itself* (`generate.py`), so import tests exercise real third-party structure, not our own output |
| DXF export conformance | ezdxf + its `Auditor` | `tests/dxf-independent-validation.test.cjs` | The writer's output must load with **0 audit errors** and carry the exact entities/layers/text/units that were written |
| DWG export | LibreDWG (independent reader, bypasses the writer's engine) | `tests/cad-dwg-export.test.cjs` | `parseDwgBytesWithLibreDwg` deliberately does not use acadrust to check acadrust's output |
| DWG/DXF round trip (internal) | acadrust WASM engine | `tests/cad-dwg-roundtrip.test.cjs` | Labelled internal: proves our converter keeps our content; not external proof |
| DXF/DWG unit tests (internal) | platform reader/writer | `tests/dxf-features.test.cjs`, `tests/dwg-features.test.cjs`, `tests/dwg-convert-limits.test.cjs` | Parser/writer behavior pins |

Reproduce the external validation locally:

```bash
pip install ezdxf
npm run test:dxf-independent-validation          # ezdxf cross-validation (43 checks)
python3 scripts/validate_dxf_external.py file.dxf  # one-file JSON report + structural audit
npm run test:cad-dwg-export                      # LibreDWG cross-read of the DWG export
```

## DXF — what is supported where

### DXF import (R12 – R2018 ASCII; `dxf-reader.ts`)

| Data | Status | Notes |
|---|---|---|
| LINE, CIRCLE, ARC, POINT, RAY, XLINE | **supported** | Exact coordinates; OCS/elevation handled |
| LWPOLYLINE (bulges), POLYLINE/VERTEX | **supported** | Bulges expanded to the polyline path |
| SPLINE | **partial** | Drawn as a polyline approximation that follows the fit points; the original B-spline definition is not kept, so re-export writes the approximation |
| ELLIPSE | **partial** | Drawn as a polyline approximation of the true ellipse; same caveat on re-export |
| SOLID / TRACE / 3DFACE | **partial** | Imported as closed polylines (with fill data where applicable) |
| TEXT | **supported** | Height, rotation, alignment, width factor, oblique, mirroring, style |
| MTEXT | **partial** | Text content, column width, line spacing, inline colour/bold/italic runs kept; exotic inline codes (columns, fields beyond the basics) are simplified to plain text |
| ATTRIB | **supported** | Visible attributes become text; invisible ones are dropped |
| ATTDEF | reported, not drawn | Placeholder definitions; the inserted ATTRIBs carry the values |
| HATCH | **supported** | Solid and patterned fills with boundary loops; real pattern definitions read where present |
| INSERT / MINSERT + nested BLOCKS | **supported** | Flattened to the drawing with full transforms (scale/rotation/mirror), nested blocks resolved; block *definitions* themselves are not kept as reusable blocks |
| DIMENSION | **partial** | Geometry is expanded from the entity's anonymous block (or computed natively when a third-party tool omitted it); measurement text and DIMSTYLE variables are read so dimensions can be restyled and re-measured natively. The DIMENSION entity itself is not re-exported as a native DIMENSION |
| LEADER / MLEADER | **partial** | Leader polyline + arrowhead drawn; MLEADER content simplified |
| IMAGE | **partial** | External raster is not embedded in the platform; the placement frame, diagonals and file name are drawn and the type is reported in `doc.skipped` |
| WIPEOUT | **supported** | Drawn as a background-coloured mask polygon |
| Layer table | **supported** | Colour (ACI + true colour), linetype, lineweight, frozen, locked, off, transparency, plot flag |
| Linetype table + $LTSCALE | **supported** | Dash patterns read in drawing units |
| STYLE table (text styles) | **supported** | Font, big font, fixed height, width factor, oblique, bold/italic/backwards/upside-down |
| DIMSTYLE table | **partial** | Names plus the variables the native renderer uses (DIMSCALE, DIMTXT, DIMASZ, DIMEXO, DIMEXE, DIMGAP, DIMDEC, DIMPOST, DIMLFAC); unused DIMSTYLE variables are not kept |
| $INSUNITS (drawing units) | **supported** | unitless/in/ft/mm/cm/m mapped through the pipeline |
| Paper-space layouts + viewports | **supported** | Sheet names come from the file's LAYOUT/BLOCK_RECORD link; viewport centre/size/view window/twist are kept |
| Unsupported or unknown entity types (MLINE, OLE2FRAME, REGION, 3DSOLID, BODY, VIEWPORT, TOLERANCE, MESH, SURFACE, anything else) | **explicitly reported** | Counted per type in `doc.skipped`, shown in the import summary ("N entity type(s) were skipped on import") and the Drawing Database Status dialog ("Entities Not Drawn") — never silently dropped |

### DXF export (R2010 ASCII, `$ACADVER` selectable for the DWG path; `dxf-writer.ts`)

| Data | Status | Notes |
|---|---|---|
| LINE, CIRCLE, ARC, POINT, RAY, XLINE | **supported** | Written with handle + `AcDbEntity` subclass markers so third-party loaders parse them structurally |
| LWPOLYLINE | **supported** | Closed/open, vertices |
| HATCH | **supported** | Real HATCH entities from fill data: solid fills and patterned fills with pattern lines, angle, scale |
| TEXT | **partial** | Multi-line text is written as one TEXT record per visual line (a DXF TEXT cannot hold a line break); MTEXT is not re-created as MTEXT |
| Layers | **supported** | Colour, true colour, linetype, lineweight, transparency, plot flag, off/frozen/locked state |
| Linetype table | **supported** | Definitions for every linetype in use |
| Text style table | **supported** | Per-font styles with TrueType bold/italic flags |
| $INSUNITS, $LTSCALE, $EXTMIN/$EXTMAX | **supported** | Drawing units and precision of the written coordinates are exactly the document's values (no unit conversion is applied) |
| First paper-space layout + viewports | **supported** | Written as paper-space entities (group 67) with viewport records |
| Additional layouts | **partial** | Plain DXF save keeps the first sheet only (`layoutsNotSaved()` reports the count); the DWG conversion path (`allLayouts`) writes every sheet |
| Blocks / INSERT | **not written** | Imported blocks stay flattened; the writer emits no BLOCK definitions for model content |
| DIMENSION entities | **not written** | Native dimensions export as their drawn geometry + text on their layer; they are not re-created as associative DIMENSION entities |
| SPLINE / ELLIPSE as curves | **not written** | They exist in the document as polyline approximations only |
| Entity types never imported (MLINE, TOLERANCE, …) | **not written** | Nothing that was not imported can be exported |

## DWG

| Direction | Status | Mechanism | Boundaries |
|---|---|---|---|
| Import | **supported** (versions per engine) | acadrust WASM engine (MPL-2.0), R12 – R2018+; falls back to `@mlightcad/libredwg-web` (GPL-3.0 runtime) when the primary engine cannot read a file; runs in a dedicated worker with structured error codes and a timeout | 2D drawing scope; the same entity coverage as the DXF import path above (the two paths share the document model); embedded BMP/PNG preview extracted when present |
| Export | **partial** (2D subset) | The drawing editor serialises to the DXF subset above, which the acadrust WASM writer converts to binary DWG locally (versions 2000/2004/2007/2010/2013/2018 selectable, default 2010) | Same subset as DXF export; extra sheets are written as Paper_Space blocks; **verified only by internal read-back plus the independent LibreDWG cross-read — the file has not been opened in desktop drafting software**; when the local engine artifact is missing, DWG export is unavailable and nothing is written |

DWG import/export runs entirely locally; no file content leaves the machine.

## Units, coordinates, precision

- The platform never rescales imported geometry: coordinates are kept exactly
  as drawn, and `$INSUNITS` declares their meaning (`mm`, `m`, `in`, … are
  mapped; unitless files are treated as document units).
- Export writes the same coordinates back and stamps `$INSUNITS` with the
  document unit — verified for mm/m/in by the ezdxf cross-validation
  (identical wall coordinates round-trip at 100 / 0.1 / 3.937007874015748
  drawing units with `auditErrors: 0`).
- No hidden snapping/rounding is applied on import/export; per-entity
  precision is the ASCII precision of the written floats.

## Representative test drawings

`tests/fixtures/dxf-corpus/` (generated by `generate.py`, committed):

| Fixture | Exercises |
|---|---|
| `units_mm.dxf` / `units_m.dxf` / `units_in.dxf` | Same 100-unit wall at three $INSUNITS; coordinate + text + unit consistency |
| `entities_rich.dxf` | All core 2D entities incl. spline, ellipse, solid, two hatch kinds, ray, xline |
| `blocks_attribs.dxf` | Nested blocks, two INSERTs (identity + rotated/scaled), ATTRIBs |
| `dims_leaders.dxf` | Linear + angular dimensions (rendered by ezdxf), leader, DIMSTYLE table |
| `unsupported_mline.dxf` | MLINE entities — the explicit-warning path |
| `paper_space.dxf` | Named sheet, sheet entities, viewport |
| `styles_ltypes.dxf` | True-colour layer + entity, lineweights, DASHED/CENTER patterns, $LTSCALE |

## Known limits (summary)

1. DXF/DWG export is a 2D subset: no block definitions, no native DIMENSION
   entities, no MTEXT records, no spline/ellipse curves on export.
2. DWG export has never been opened in desktop CAD software; the independent
   evidence is the LibreDWG cross-read, and it covers the same 2D subset.
3. Raster images are not embedded on import (frame + filename placeholder).
4. Unknown entity types are counted and reported, not drawn — the UI states
   exactly which types and how many.
5. DXF binary files are read through the acadrust engine path; the pure-TypeScript
   reader covers ASCII DXF.
