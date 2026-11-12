# Convert PDF to Drawing (PDFIN — vector PDF → editable DWG/DXF)

**Where:** Insert tab → *PDF Import* → **PDF to Drawing…**, App menu (red "A") → *Convert PDF to Drawing…*,
drop a `.pdf` onto the drawing editor, welcome screen → *Open DWG / DXF / PDF…*, or the command line:
`PDFIN` (aliases `PDFIMPORT`, `PDF2DWG`). `PDFIN N` converts page N.

The converter turns a **vector PDF** into an editable drawing — lines, polylines, curves and text become
real LINE / LWPOLYLINE / TEXT entities you can snap to, modify, dimension and re-issue.

## Privacy — nothing is uploaded

Parsing runs **locally in your browser** with the bundled PDF.js (loaded from the app itself, no CDN).
The PDF is **not uploaded to the cloud**; user data is secure. The same local-first model as the rest
of OpenBIMStudio.

## How the conversion works

1. PDF.js reads the page's content stream and text run (in the browser, on your machine).
2. Stroked paths become LINE (2-point) or LWPOLYLINE entities on the **PDF** layer; cubic and quadratic
   Béziers are flattened to short segments (16 per curve by default).
3. Filled areas (even-odd/nonzero) become closed boundaries on the **PDF Fill** layer — run HATCH to
   refill them if needed.
4. Text runs become TEXT entities on the **PDF Text** layer with position, cap height and rotation.
5. Near-black geometry stays BYLAYER (it renders correctly on dark and light backgrounds); any colour
   with a strong channel keeps its true colour.
6. The result is written through the standard DXF writer and opened as a normal drawing tab — from there
   **QSAVE** writes a DXF and **DWGSAVE** writes a DWG (local acadrust WASM), completing the
   **PDF → DWG** conversion end to end.

## Scale / units

| Command | Meaning |
|---|---|
| `PDFIN` | True-size millimetres — 1 PDF pt = 0.3528 mm (25.4 units per inch); the document is tagged `units = mm` |
| `PDFIN 72` | 1 PDF pt = 1 drawing unit (raw user space, unitless) |
| `PDFIN N` | N drawing units per inch of paper (e.g. `304.8` = inches → feet) |

`PDFIN N` also selects page N when a second number is given (`PDFIN 25.4` keeps page 1).

## Limits (v1, stated honestly)

- **Vector PDFs only.** Scanned / raster PDFs have no vector content and are refused with an explicit
  message (counts come back empty).
- Embedded **raster images are skipped** (counted and reported in the toast and the `skipped` table);
  use *PDF underlay* in the BIM workspace when you need the raster behind the drawing.
- Clipping paths are discarded — geometry is emitted unclipped (the clip count is reported).
- Fonts are not matched: text keeps position, height and rotation, not the typeface.
- Pattern / separation colours fall back to the last plain colour; transparency and blend modes are
  not carried over.
- One page per conversion; run `PDFIN N` per page (a multi-page PDF opens one drawing per page).

## Verification

`tests/pdf-vector-import.test.cjs` (`npm run test:pdf-vector`, 12 checks) builds a minimal vector PDF
in memory and runs the real pdf.js extraction (legacy build under Node — the same code path the browser
uses): strokes, fills, a cubic Bézier, text placement/height, true-colour mapping, BYLAYER policy for
near-black, both scale modes, page-range errors, and the DXF round trip through the standard writer.
`test:cad-ribbon-layout` pins the *PDF Import* ribbon group to the Insert tab; `tsc --noEmit` covers
the wiring. Not yet opened against a large production drawing set in a browser — page-size limits
(very complex pages) are unmeasured.
