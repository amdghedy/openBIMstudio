# Commercial readiness and CAD-engine gaps (audit, 2026-11-16)

This is an engineering audit, **not legal advice**. It lists what stands between the current code and a paid release, and what has
and has not been compared with AutoCAD or ZWCAD. Items are ordered by how likely they are to block a sale.

## 1. Licensing (check first)

| # | Finding | Where | What to do |
|---|---|---|---|
| L1 | The repository is labelled **MIT**, but the DWG fallback reader `@mlightcad/libredwg-web` is **GPL-3.0** and is loaded at run time and copied into `public/libredwg/` at build. Shipping it inside a closed-source paid product is the most likely licensing blocker. | `LICENSE`, `docs/DXF_DWG_INTEROP.md` (row "Import"), `scripts/copy-libredwg-wasm.mjs` | Counsel decides. Options: (a) remove the fallback and rely on the acadrust engine only; (b) ship the product under a GPL-compatible licence; (c) buy a commercial licence for the reader; (d) keep it out of the shipped build and let users opt in. |
| L2 | `libredwg` is **not listed** in `docs/THIRD-PARTY-VENDOR.md` (only occt-import-js and rhino3dm are). | `docs/THIRD-PARTY-VENDOR.md` | Add it, with version and licence text, once L1 is decided. |
| L3 | acadrust (MPL-2.0) is compiled into `public/cad-engine/obim-cad-engine.wasm`. MPL-2.0 is file-level: changes to acadrust's own files must be published, and the notice must ship. | `cad-engine-rust/` | Ship the MPL notice and source link with the product. |
| L4 | occt-import-js is LGPL-2.1, shipped as a replaceable `.wasm`/`.js` pair; the note there already says counsel should confirm. | `docs/THIRD-PARTY-VENDOR.md` | Confirm with counsel. |
| L5 | "AutoCAD", "DWG", "RealDWG" and "ZWCAD" are third-party names/marks. Do not describe the product as an "identical copy" of, or "certified" for, any of them. | UI text, README, store pages | Use "reads and writes DWG/DXF"; claim only what is tested. |
| L6 | No end-user licence agreement, privacy statement or terms of service in the repo. | root | Write them; state clearly what leaves the machine (AI features, live link, updates). |

## 2. CAD engine versus AutoCAD / ZWCAD

Nothing below has been compared in AutoCAD or ZWCAD. Differences already seen on a real 580 k-entity drawing and not yet closed:

- Hatches that cannot be read (18 in that file) are skipped.
- Font substitution when a drawing's fonts are missing; view presentation differs from the native viewer.
- A DWG read by the acadrust engine (the main path) does not carry its **saved view** to the viewer; the engine's JSON does not export it. DXF headers and the libredwg path do.
- Background colour, lineweight display and other saved viewport settings are not restored.
- Paper-space plotting details, plot styles in real plots, and most AutoCAD commands have not been checked one by one.
- Fixed since: text and dimensions are no longer dropped when a huge drawing exceeds the geometry budget (annotation reserve).

Method to close these honestly: for each reference drawing, keep the native viewer's PNG, open the same file here, list the differences, fix one, add a test that pins it. This needs the user's drawings.

## 3. Product readiness checklist (not done unless marked)

- [ ] Licence decision (L1–L6 above)
- [ ] Code-signed desktop installers and an update channel (see `docs/DESKTOP_INSTALLER.md`)
- [ ] Opening exports in AutoCAD, BricsCAD, ZWCAD and Revit (never done)
- [ ] Large-model and real-GPU performance runs on customer-class hardware
- [ ] Accessibility and Arabic/RTL review of every dialog (the Arabic user guide lacks the newest walk-mode items)
- [ ] Backup / recovery behaviour for unsaved work
- [ ] Support process, versioned releases and a security-disclosure path (`SECURITY.md` exists)
- [ ] Revoke the GitHub token that was pasted into a chat earlier (github.com/settings/tokens); it has never been used by the assistant
