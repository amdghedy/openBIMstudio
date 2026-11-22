# Catalogue-to-BIM Family Generator

## Current delivery status

The first delivery adds a BIM Family Generator launcher and a local catalogue intake workflow integrated with the existing project-scoped family service.

**Currently implemented**
- CSV, TSV, TXT-delimited and JSON product catalogue intake (15 MB per-file limit).
- Quoted CSV fields and header aliases for common manufacturer catalogue columns.
- Product rows and model variants review.
- Explicit dimension unit selection (mm, cm, m) and conversion to metres for the current family geometry contract.
- Required-dimension completeness warnings.
- Creation of a native OpenBIMstudio family definition using the existing family service, parameter schema, geometry engine and project persistence.
- Type parameters for dimensions, manufacturer, product code, airflow, static pressure, power and voltage.
- A dimension-driven box geometry template as a first authoring placeholder.

**Not implemented yet**
- PDF OCR, scanned drawing interpretation or AI extraction.
- XLSX workbook parsing.
- DWG/DXF/STEP/SAT geometry extraction.
- Catalogue drawing-to-solid reconstruction.
- Detailed product-specific geometry and connector auto-placement.
- Revit API companion add-in or native RFA export.
- External manufacturer catalogue APIs.

The UI must continue to label these as unavailable/planned until implemented and verified. It must not present a preview box as a complete manufacturer-accurate product family.

## Workflow

1. Open **BIM Family Generator** using the BFG launcher or Command Palette.
2. Import a CSV/TSV/TXT or JSON product catalogue.
3. Review the extracted model rows and QA warnings.
4. Set the family name, category and source dimension unit.
5. Correct the source catalogue if required; missing dimensions are never invented.
6. Create the family. The existing project-scoped Family Store persists it.
7. Open the existing Parametric Families panel to inspect parameters, types and regenerate geometry.

## Supported catalogue columns

The CSV/TSV reader recognizes model/model number/type, manufacturer/brand, product code/SKU, width, depth/length, height, airflow/flow, static pressure/pressure, power and voltage. Unknown columns are ignored in this first slice and should remain in the original source file.

## Engineering boundaries

- Dimensions are converted to metres for the existing family geometry parameter contract.
- The generated geometry is a bounding-box template controlled by Width, Depth and Height. It is not a manufacturer-accurate solid.
- Missing dimensions use a 1 m preview fallback only; QA explicitly flags the missing source values and users must correct them before relying on the geometry.
- The importer runs locally in the browser; no catalogue file is uploaded to a server by this feature.
- Native RFA generation requires a separate Windows Revit API adapter and a real Revit installation. Browser mesh export is not RFA export.

## Next implementation milestones

1. PDF text/table extraction with page-level evidence and OCR adapter for scanned pages.
2. XLSX importer with workbook/sheet/row provenance.
3. Parameter mapping UI with units, type/instance scope, GUID mapping and source confidence.
4. Reuse existing parametric feature tree for detailed geometry templates.
5. Connector mapping and placement editor, validated against existing MEP connector definitions.
6. Revit 2020 adapter proof-of-concept, then version-specific adapters and reopen verification.
