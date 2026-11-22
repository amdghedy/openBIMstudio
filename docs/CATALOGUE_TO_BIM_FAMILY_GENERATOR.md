# Catalogue-to-BIM Family Generator

## Current delivery status

The current experimental delivery adds a BIM Family Generator launcher and local catalogue intake workflow integrated with the existing project-scoped family service.

**Currently implemented**
- XLSX (selectable worksheet), CSV, TSV, TXT-delimited and JSON product catalogue intake (40 MB per-file limit).
- PDF selectable-text extraction using the bundled PDF.js legacy build, with page-level provenance.
- Table reconstruction from recognized model/manufacturer/dimension/performance column headings.
- Image-only page detection and optional local OCR through the configured Ollama vision model (LLaVA, Qwen2.5-VL or another image-capable model); no cloud OCR path is used.
- PDF page-count, file-size and extracted-text safety limits.
- Quoted CSV fields and header aliases for common manufacturer catalogue columns.
- Product rows and model variants review.
- Explicit dimension unit selection (mm, cm, m) and conversion to metres for the current family geometry contract.
- Required-dimension completeness warnings.
- Creation of a native OpenBIMstudio family definition using the existing family service, parameter schema, geometry engine and project persistence.
- Type parameters for dimensions, manufacturer, product code, airflow, static pressure, power and voltage.
- A dimension-driven box geometry template as a first authoring placeholder.
- Explicit catalogue MEP port mapping when the source provides port origin, axis, domain, shape, nominal size, flow direction and system classification; definitions are stored in the existing family connector schema and displayed in the catalogue review table.

**Not implemented yet**
- High-fidelity OCR of all catalogue layouts; the current local vision path is experimental and requires a vision-capable Ollama model.
- OCR of pages containing selectable text but nonstandard or unrecognized table structures.
- Multi-sheet selection, formulas recalculation, macro-enabled XLSM and legacy XLS workbook parsing.
- DWG/DXF/STEP/SAT geometry extraction.
- Catalogue drawing-to-solid reconstruction.
- Manufacturer-specific solid reconstruction and inferred connector placement. Connector definitions are accepted only when explicit port coordinates and axes are supplied; no port location is guessed.
- Revit API companion add-in or native RFA export.
- External manufacturer catalogue APIs.

The UI must continue to label these as unavailable/planned until implemented and verified. It must not present a preview box as a complete manufacturer-accurate product family.

## Workflow

1. Open **BIM Family Generator** using the BFG launcher or Command Palette.
2. Import an XLSX, PDF, CSV/TSV/TXT or JSON product catalogue. XLSX lets users select a worksheet and retains source sheet/row identifiers; cached cell values are read and formulas are not recalculated.
3. For a scanned PDF, enable local vision OCR and select a vision-capable Ollama model in AI Settings. PDF page images are sent only to the configured local/private Ollama endpoint.
5. Review extracted product rows, source-page numbers and QA warnings.
6. Set the family name, category and source dimension unit.
7. Correct the source catalogue if required; missing dimensions are never invented.
8. Create the family. The existing project-scoped Family Store persists it.
9. Open the existing Parametric Families panel to inspect parameters, types and regenerate geometry.

## Supported catalogue columns

XLSX, CSV/TSV and PDF table readers recognize model/model number/type, manufacturer/brand, product code/SKU, overall width/depth/height, airflow rate, static pressure/ESP, rated power and supply voltage aliases. Explicit MEP connector columns can include Connector Name, Connector X/Y/Z, Direction X/Y/Z, Connector Domain, Connector Shape, Connector Diameter or Connector Width/Height, Flow Direction and System Classification. Port coordinates and nominal sizes use the selected dimension unit and are converted to metres; direction vectors are normalized. PDF table extraction relies on selectable text and recognizable column positions. OCR prompts the local vision model for the same canonical fields; unknown fields and source-page evidence remain attached to extracted rows where available.

## Engineering boundaries

- Dimensions are converted to metres for the existing family geometry parameter contract.
- The generated geometry is a bounding-box template controlled by Width, Depth and Height. It is not a manufacturer-accurate solid.
- Connector definitions are not inferred from airflow, dimensions or product imagery. The current family schema stores connectors at family level, so all product types in one imported family must have identical connector definitions. Multiple ports per product and type-specific connector layouts are not yet supported by this intake adapter; use the existing connector editor for richer port authoring.
- Missing dimensions use a 1 m preview fallback only; QA explicitly flags the missing source values and users must correct them before relying on the geometry.
- Text PDF parsing and page rendering run locally in the browser. Scanned page images are sent only to the user's configured local/private Ollama endpoint when OCR is explicitly enabled; no cloud OCR is used.
- PDF OCR requires an image-capable Ollama model. A text-only or coding model may fail to return structured extraction data.
- OCR output is untrusted draft data. Source values, units, model identifiers and page evidence must be checked before family creation.
- Native RFA generation requires a separate Windows Revit API adapter and a real Revit installation. Browser mesh export is not RFA export.

## Next implementation milestones

1. XLSX importer with workbook/sheet/row provenance.
2. Improve PDF layout reconstruction for rotated tables, merged headers, multi-column brochures and engineering unit inference.
3. Parameter mapping UI with units, type/instance scope, GUID mapping and source confidence.
4. Reuse the existing parametric feature tree for detailed product geometry templates.
5. Extend catalogue connector intake to multiple named ports and type-specific connector layouts, then add an interactive placement editor with manufacturer drawing evidence.
6. Revit 2020 adapter proof-of-concept, then version-specific adapters and reopen verification.
