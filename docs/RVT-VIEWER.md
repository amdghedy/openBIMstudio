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

## Installing the decoder (operators)

The decoder is a build artifact, not committed. Without it the app says "not installed on this deployment" and points to IFC export.

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked
npm run build:rvt          # writes public/rvt/rvt.js and rvt_bg.wasm
npm run build
```

`scripts/build-rvt-wasm.mjs` fetches rvt-rs at one pinned commit, checks the commit, and builds only the `rvt-wasm` crate. Missing tools are reported and the script exits 0 (use `--strict` to fail instead). The deploy workflow runs it as a non-blocking step. To update the reader, change `RVT_RS_COMMIT`, rebuild and test with a real file before shipping.

The Content-Security-Policy needs nothing new: the decoder is same-origin, and `'wasm-unsafe-eval'` and `worker-src 'self'` were already allowed.

## Licences

`public/rvt/LICENSE-rvt-rs.txt` and `NOTICE-rvt-rs.txt` are the upstream Apache-2.0 licence and notice and ship with the built decoder.

## Verification status

`tests/rvt-viewer.test.cjs` covers file checks, the decode sequence and the honesty of the summary with a **fake** decoder, plus wiring. The real WebAssembly was **not** built here (the build environment could not reach the Rust package registry) and **no real `.rvt` file** was opened, so orientation, units and geometry quality are unverified. Try it on a real file after the first deploy.
