# Free family creator (slices 1 to 3, partial)

OpenBIMStudio is the family creator and engine. Revit is the destination.
Everything here uses free tools only: no paid APIs, no cloud calls.

## What slice 1 does

Product size in, editable family out, IFC2X3 written and structure-checked.

1. **Intake** (`creator/cutsheet.ts`, `creator/units.ts`): reads an overall
   `W x D x H` size from cut-sheet or spec text (one string per page, for
   example from pdf.js). Each value keeps its page, line and exact source
   text. If sizes conflict or none is clear it returns nothing and the caller
   must ask the user. It never picks one.
2. **Family** (`creator/build.ts`, `creator/templates.ts`): builds an ordinary
   `FamilyDefinition` for the existing parametric engine. `Width`, `Depth`,
   `Height` are type parameters, a template adds more (plinth, door, handle),
   and every part size is a formula. Templates: `box`, `cabinet`.
3. **Engine check** (`creator/pipeline.ts`): the family is built through the
   real `buildParametricFamily` and its bounding box must match the spec.
4. **IFC2X3** (`creator/ifc2x3.ts`): one element, one extruded solid per part,
   a property set with the parameters, standard spatial spine. The text is read
   back with the repo's STEP reader and checked.

Status is real. `progress` is finished stages over total stages, nothing else.
There is no timer. A failed stage stops the run and says why.

## Slice 2: the panel

Manage tab > Family Creator (`src/features/family-creator-panel.ts`). Paste
text or type a size in mm, press Create family. The panel shows the four real
stages, a Destinations block (OpenBIMStudio family, IFC2X3 file, Revit 2020
which always reads "not verified"), editable parameters (changing one re-runs
the whole pipeline), the Sources, a front/side/top drawing of the parts, Add
to family library, and Download IFC2X3. Browser spec:
`tests/e2e/family-creator-ui.spec.ts` (set `FC_SHOTS=dir` for screenshots).

## What it does not claim

- No "Ready for Revit". `status.revit.state` is always `"unverified"` here.
  Only a run in Revit can change that, and a person records it.
- IFC import is geometry and properties, not a native editable Revit family.
  The family stays parametric inside OpenBIMStudio.
- Scanned PDFs (no text layer) and images are not read: no OCR, no image or URL intake, no vision model yet. The panel says so and asks for the size.
- GLB stays an export for other tools. Revit 2020 has no documented GLB import.
- The two templates are small. Real products need richer parts (later slices).

## Revit 2020 acceptance (run by the user, not automated)

- R1 Open the IFC in Revit 2020 (File > Open > IFC, or Insert > Link IFC).
  Expect one element, 1200 x 700 x 2000 mm for the sample.
- R2 Units and orientation: width along X, depth along Y, base at level 0.
- R3 The `OBS_FamilyParameters` property set is present on the element.
- R4 Note what can and cannot be edited after import.

## Independent check used in CI-less review

`ifcopenshell` (LGPL, dev tool only, not shipped) opened the sample as IFC2X3,
EXPRESS validation returned 0 messages, and the geometry bbox was
1.2 x 0.7 x 2.0 m.

## Slice 3: PDF text intake and interactive 3D

- Choose a PDF or .txt in the panel. pdf.js (already bundled, same-origin
  worker, no network) reads the text layer page by page, up to 20 MB and 40
  pages. The size keeps its real page and line. Typing in the text box
  replaces the loaded file, so a run never mixes the two.
- A PDF with no text layer reports that it looks like a scan. Nothing is guessed.
- The 3D preview is a three.js scene (OrbitControls, no CDN) of the object the
  engine built: drag to rotate, wheel to zoom, right-drag to pan, Fit. It opts
  out of the global wheel arbiter with `data-obs-own-wheel`.
- Tests: `tests/family-creator-pdf.test.cjs` (unit, real pdf.js) and the
  second case of `tests/e2e/family-creator-ui.spec.ts` (browser, not a CI gate).
- Shapes: box, cabinet with door, table with four legs, open shelving. Picked from the product name, or by the user in the Shape list. Each is plain data (templates.ts), drives both the engine geometry and the IFC.
- OCR (on this device): a picture (PNG, JPEG, WebP, BMP) or a scanned PDF
  (no text layer, first 6 pages, rendered by pdf.js) is read with Tesseract as
  WebAssembly. Pinned: tesseract.js 7.0.0 (Apache-2.0), tesseract.js-core 7.0.0
  (Apache-2.0), @tesseract.js-data/eng 1.0.0 (package MIT; model files are
  tesseract-ocr tessdata_best_int, Apache-2.0). `scripts/sync-ocr-assets.mjs`
  copies the worker, three LSTM engine builds and `eng.traineddata.gz` into
  `public/ocr/` (generated, git-ignored, about 14 MB, loaded only when OCR is
  used). Nothing is fetched from another origin: the browser test records every
  request. The panel labels OCR results "check the numbers", keeps page and
  line, and the parts come from a ready-made shape, not from tracing the drawing.
- Counts: a template can repeat a part for an integer parameter. Open shelving has "Middle shelves" (0 to 12, default 1): each count writes that many equally spaced shelves into the engine geometry and the IFC, and changing it re-runs the whole pipeline.
- Still to come: URL intake, a local vision model (licence must be read first),
  more shapes, per-part visibility, other OCR languages.
