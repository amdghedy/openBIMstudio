# Viewing Revit files (.rvt / .rfa)

View-only, decoded inside the browser tab. Nothing is uploaded.

## What it does

* Open a `.rvt` or `.rfa` (also `.rte` / `.rft`) by drag and drop, **Open**, File tab → **View Revit File**, or the command palette ("View a Revit file…").
* A worker decodes the file with [rvt-rs](https://github.com/DrunkOnJava/rvt-rs) (Apache-2.0, a clean-room reader that works without Revit), compiled to WebAssembly. The result is turned into a glTF model and added to the scene like any imported mesh.
* After every open the app says how complete the decode was, using the decoder's own confidence figures. A file that decodes to project structure only is reported as "Nothing to draw", never as success.

## What it is not

* **Not Revit's own display.** The geometry is reconstructed from the file. Shapes can be simplified (doors and windows may be boxes) or missing.
* **View only.** No Revit parameters, no editing, not included in clash tests or quantities. For complete BIM data use *File → Export → IFC* in Revit and open the `.ifc`.
* Reader coverage is the reader's own: measured geometry for Revit 2023–2025 projects is its stable range; other releases are experimental. Very large files need a lot of memory (the app warns above 300 MB and refuses above 1.5 GB).
* Revit is a trademark of Autodesk, Inc. This project is not affiliated with or endorsed by Autodesk.

## The decoder

The built decoder (`public/rvt/rvt.js` and `rvt_bg.wasm`, about 10 MB) is committed, so every host (Cloudflare, Vercel, any static host) serves it with no Rust toolchain. If it is ever missing, the app says "not installed on this deployment" and names the exact file and HTTP status it could not load.

To rebuild or upgrade it: change `RVT_RS_COMMIT` in `scripts/build-rvt-wasm.mjs`, then run the **Build Revit reader** workflow (Actions tab). It builds, runs `scripts/rvt-smoke.mjs` on three upstream sample files, and pushes the result to the branch `rvt-decoder-build`; open a pull request from it (main is protected). Locally: `rustup target add wasm32-unknown-unknown`, `cargo install wasm-pack --locked`, `npm run build:rvt`.

The Content-Security-Policy needs nothing new: the decoder is same-origin, and `'wasm-unsafe-eval'` and `worker-src 'self'` were already allowed.

## Licences

`public/rvt/LICENSE-rvt-rs.txt` and `NOTICE-rvt-rs.txt` are the upstream Apache-2.0 licence and notice and ship with the built decoder.

## Verification status

`tests/rvt-viewer.test.cjs` covers file checks, the decode sequence and the honesty of the summary with a fake decoder, and (when `public/rvt/` is present) runs the **real WebAssembly** on a synthetic 20 KB fixture from the rvt-rs corpus: it decodes, produces a glTF binary, is reported as "nothing to draw" (scaffold, 25%), and garbage input throws. The workflow's smoke test did the same on three upstream samples in Node.

Not verified: opening a **real project** `.rvt` (the fixtures have no geometry), the worker and the display in a real browser, orientation, units and geometry quality. Try it with one of your own files.
