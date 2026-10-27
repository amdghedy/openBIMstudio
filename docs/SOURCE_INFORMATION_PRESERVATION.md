# Source Information Preservation (Digital Twin Layer 2)

## Dual-layer architecture

| Layer | Contents | Mutated by parametric edit? |
|-------|----------|------------------------------|
| **1 – Native** | `params`, `nativeGeometry` / solid builders, transforms | Yes — drives viewport |
| **2 – Source archive** | `sourceArchive` on each AuthoredElement | **No** (status flags only) |

## Archive contents (`SourceArchive`)

* Identity: model id, localId, GlobalId, entity, tag, names  
* `rawItem`: full JSON-safe `getItemsData` snapshot  
* `propertySets` / `quantities`  
* `discoveredPaths` + `fieldMap` (mapped vs preserved-unmapped)  
* `sourceDimensions` — original source values  
* Geometry provenance (extraction path, counts, bounds)  
* Materials, classifications, relationship stubs when present  
* Warnings  

## Native height edit example

1. Source height 3.5 m stored in `sourceArchive.sourceDimensions.height`  
2. User sets native height 4.0 m → geometry regenerates to 4.0 m  
3. Archive still holds 3.5 m; field map status → `native-modified`  

## Limitations

* Only information **exposed by the Fragments/web-ifc item APIs** can be archived.  
* Analytic IFC surfaces beyond tessellation are not re-exported as CSG; tessellation is noted in provenance.  
* Relationship graphs are stored as stubs when the loader provides them — not a full IFC relationship rewrite.  
* Completeness is **accessible-source preservation**, not proof of absolute zero loss vs the original binary IFC file.

## Tests

`tests/source-archive.test.cjs` — unknown attributes, psets/qtos, native-modified without source erasure.
