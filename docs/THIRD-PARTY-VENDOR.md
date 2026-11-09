# Vendored WebAssembly readers

Prebuilt files under `public/vendor/` are downloaded unmodified from npm by the **Vendor drawing readers** workflow
(`.github/workflows/vendor-cad-wasm.yml`), smoke-tested there on real sample files, and pushed to the branch `vendor-cad-build`.
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
