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
- Header-unit normalization for airflow (m³/s and L/s to m³/h), static pressure (kPa to Pa), power (W to kW) and voltage (kV to V).
- Required positive width/depth/height validation; family creation is blocked while any product type has a missing or non-positive geometry dimension.
- Duplicate model identifiers are flagged before family creation. PDF extraction preserves repeated model rows for review instead of silently discarding later rows.
- Creation of a native OpenBIMstudio family definition using the existing family service, parameter schema, geometry engine and project persistence.
- Type parameters for dimensions, manufacturer, product code, airflow, static pressure, power and voltage.
- Explicit parametric box or cylinder geometry profiles when the catalogue provides a supported Geometry Profile / Product Geometry value; cylinder diameter is driven by Width and height by Height.
- Multiple explicitly numbered MEP ports with validation and coordinate conversion, stored per product FamilyType so variants can carry different port layouts.
- Explicit catalogue MEP port mapping when the source provides port origin, axis, domain, shape, nominal size, flow direction and system classification; definitions are stored in the existing family connector schema and displayed in the catalogue review table.

**Not implemented yet**
- High-fidelity OCR of all catalogue layouts; the current local vision path is experimental and requires a vision-capable Ollama model.
- OCR of pages containing selectable text but nonstandard or unrecognized table structures.
- Formula recalculation, macro-enabled XLSM and legacy XLS workbook parsing. XLSX imports visible worksheets only and reads cached formula results.
- DWG/DXF/STEP/SAT geometry extraction.
- Catalogue drawing-to-solid reconstruction.
- Manufacturer-specific solid reconstruction and inferred connector placement. Connector definitions are accepted only when explicit port coordinates and axes are supplied; no port location is guessed.
- The shared authoring rebuild now registers type-specific family ports with the MEP lifecycle after placement and geometry/transform edits. Non-authoring integrations that create family instances outside this rebuild must call the placement bridge themselves.
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

XLSX, CSV/TSV and PDF table readers recognize model/model number/type, manufacturer/brand, product code/SKU, overall width/depth/height, airflow rate, static pressure/ESP, rated power and supply voltage aliases. Explicit unit suffixes are normalized for airflow (m³/s, L/s), pressure (kPa), power (W) and voltage (kV); dimension columns still use the selected family dimension unit. Geometry Profile / Product Geometry accepts explicit box or cylinder values. Explicit MEP connector columns can use unnumbered fields for one port or numbered groups such as Connector 1 Name, Connector 1 X/Y/Z, Connector 1 Direction X/Y/Z, Connector 1 Domain, Connector 1 Shape, Connector 1 Diameter or Connector 1 Width/Height, Flow Direction and System Classification; repeat for Connector 2, Connector 3, etc. Port coordinates and nominal sizes use the selected dimension unit and are converted to metres; direction vectors are normalized. PDF table extraction relies on selectable text and recognizable column positions. OCR prompts the local vision model for the same canonical fields; unknown fields and source-page evidence remain attached to extracted rows where available.

## Engineering boundaries

- Dimensions are converted to metres for the existing family geometry parameter contract.
- The generated geometry supports explicit box and cylinder parametric primitives only. Cylinder profile treats Width as diameter and Height as axial length. These are generic primitives, not manufacturer-accurate solids.
- Connector definitions are not inferred from airflow, dimensions or product imagery. Multiple explicitly numbered ports can be imported. Connector definitions are stored per FamilyType when imported from a catalogue, so product variants can carry different port counts and layouts; the existing family-level connector list remains the fallback for types without a type-specific list. The Family Browser connector editor can edit and preview the selected type's layout. The family service exposes `buildConnectors`; the common authoring rebuild resolves the selected type's connector definitions (falling back to family defaults), transforms them through the rendered instance world matrix, and replaces that element's ports in `MepModelLifecycle`. External placement hosts must call `syncPlacementConnectors` after final placement and relevant edits.
- Missing dimensions use a 1 m preview fallback only; QA explicitly flags the missing source values and users must correct them before relying on the geometry.
- Text PDF parsing and page rendering run locally in the browser. Scanned page images are sent only to the user's configured local/private Ollama endpoint when OCR is explicitly enabled; no cloud OCR is used.
- PDF OCR requires an image-capable Ollama model. A text-only or coding model may fail to return structured extraction data.
- OCR output is untrusted draft data. Source values, units, model identifiers and page evidence must be checked before family creation.
- Native RFA generation requires a separate Windows Revit API adapter and a real Revit installation. Browser mesh export is not RFA export.

## Next implementation milestones

1. XLSX parser hardening for unusual OOXML layouts, date/number formats and merged headers.
2. Improve PDF layout reconstruction for rotated tables, merged headers, multi-column brochures and engineering unit inference.
3. Parameter mapping UI with units, type/instance scope, GUID mapping and source confidence.
4. Reuse the existing parametric feature tree for detailed product geometry templates.
5. Extend connector lifecycle synchronization to external placement hosts and add manufacturer drawing evidence with guided parameter/port mapping.
6. Revit 2020 adapter proof-of-concept, then version-specific adapters and reopen verification.
