# Vendored WebAssembly readers

Prebuilt files under `public/vendor/` are downloaded unmodified from npm by the **Vendor drawing readers** workflow
(`.github/workflows/vendor-drawing-readers.yml`), smoke-tested there on real sample files, and pushed to the branch `vendor-cad-build`.
Nothing is added to `package.json` / `package-lock.json`.

| Folder | Package | Version | Licence | Used for |
|---|---|---|---|---|
| `public/vendor/occt/` | occt-import-js (Open CASCADE inside) | 0.0.23 | LGPL-2.1 | STEP / IGES / BREP view |
| `public/vendor/rhino3dm/` | rhino3dm | 8.35.0 | MIT | Rhino `.3dm` view |

**LGPL-2.1 note (occt-import-js):** the library is shipped as a separate, unmodified `.wasm` + `.js` pair that the page loads at
run time, with its licence text next to it (`public/vendor/occt/LICENSE.md`). Source: https://github.com/kovacsv/occt-import-js.
To replace it with your own build, drop a compatible `occt-import-js.js` / `.wasm` into the same folder. This is an engineering
description, not legal advice; have counsel confirm it before a commercial release.

**rhino3dm:** MIT; the npm package ships no licence file, so `NOTICE.txt` points to the upstream licence.

Every entry has `VERSION.json` recording the exact version and declared licence.

## Optional plug-in (not shipped)

`@mlightcad/libredwg-web` (LibreDWG, **GPL-3.0**) is installed from npm and copied to `public/libredwg/` by `scripts/copy-libredwg-wasm.mjs`; it was the DWG fallback reader. As of 2026-11-16 it is a **devDependency only** and is not copied into builds (set `OBS_BUNDLE_LIBREDWG=1` for a private build); in a browser it loads only from a user-supplied `/plugins/libredwg/libredwg-web.js`. See `docs/COMMERCIAL-READINESS.md` (L1). acadrust (MPL-2.0) is compiled into `public/cad-engine/obim-cad-engine.wasm`. This is an engineering note, not legal advice.

## Hershey Fonts (stroke-font data)

`src/modules/drawings/stroke-font-data.ts` contains the Hershey Fonts rowmans, rowmand, rowmant, timesi and scripts (converted from the JHF
distribution at github.com/kamalmostafa/hershey-fonts), used to draw AutoCAD SHX text as thin single strokes. The Hershey Fonts licence allows
use by anyone for any purpose, commercial or otherwise, provided these acknowledgements are distributed with the font data (they are in that file's
header): the fonts were originally created by Dr. A. V. Hershey at the U. S. National Bureau of Standards; the data format was originally created by
James Hurt, Cognition, Inc., 900 Technology Park Drive, Billerica, MA 01821. The data may be converted to any other format except the format
distributed by the U.S. NTIS. (The surrounding GPL-2.0 repository code is not used; only the font data.) Not legal advice.
