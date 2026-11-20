# Malformed IFC regression fixtures (issue #231)

Hand-minimised from the corruption classes that hang the pinned `web-ifc` on CI
(probe run 44699629517: `unterminated-string` and `truncated-mid-record` hang `OpenModel`;
non-ASCII bytes, control bytes, unbalanced parentheses, missing terminator, record without id and
semicolon-in-parentheses did NOT hang; an unterminated `/* comment */` returns a typed error).

| File | Defect | Raw web-ifc (no pre-flight) | Expected in the app |
| --- | --- | --- | --- |
| `unterminated-string-min.ifc` | closing quote missing in record #1 | hang in `OpenModel` (confirmed on these exact files: probe run 44701570892) | rejected by `preflightStep` with a line number, file never reaches web-ifc |
| `truncated-in-string-min.ifc` | file ends inside a string, no `ENDSEC;` | hang in `OpenModel` (confirmed: probe run 44701570892) | rejected by `preflightStep` |
| `broken-enum-min.ifc` | enumeration `.MODEL_VIEW.` with its leading dot flipped to `/` (`/MODEL_VIEW.`) | hang in `OpenModel` (confirmed locally, pinned web-ifc 0.0.77: 12-line minimisation of fuzz failure-0463) | rejected by `preflightStep` ("'.' after a label that is not an enumeration"), file never reaches web-ifc |
| `broken-enum-shift-min.ifc` | same broken enumeration plus two quote flips that shift string boundaries between records #21 and #49 (the exact minimised fuzz input) | hang in `OpenModel` (confirmed locally, pinned web-ifc 0.0.77: bitflip-only campaign seed 42, iteration 463, seed `invalid/missing-units.ifc`) | rejected by `preflightStep` ("'.' after a label that is not an enumeration") |

Root cause (both new fixtures): web-ifc's STEP tokenizer reads a leading-dot-less
enum name as a bare LABEL, and the following `.` as an ENUM start that consumes
everything up to the next `.` in the file — including `;` record terminators —
so the token tape is corrupted and `OpenModel` never terminates. Any replacement
of the leading dot hangs (`,` `*` `n` `&` `/` all confirmed), so the fix is not
a character blocklist: `preflightStep` now validates every `.` outside
strings/comments as either part of a real number (including `1.E-05`) or a
well-formed `.NAME.` enumeration. See `src/modules/ifc-semantics/step-preflight.ts`.

Licence: authored for this repository (MIT, same as the project). No third-party content.
