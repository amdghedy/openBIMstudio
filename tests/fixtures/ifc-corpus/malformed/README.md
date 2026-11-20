# Malformed IFC regression fixtures (issue #231)

Hand-minimised from the corruption classes that hang the pinned `web-ifc` on CI
(probe run 44699629517: `unterminated-string` and `truncated-mid-record` hang `OpenModel`;
non-ASCII bytes, control bytes, unbalanced parentheses, missing terminator, record without id and
semicolon-in-parentheses did NOT hang; an unterminated `/* comment */` returns a typed error).

| File | Defect | Raw web-ifc (no pre-flight) | Expected in the app |
| --- | --- | --- | --- |
| `unterminated-string-min.ifc` | closing quote missing in record #1 | hang in `OpenModel` (confirmed on these exact files: probe run 44701570892) | rejected by `preflightStep` with a line number, file never reaches web-ifc |
| `truncated-in-string-min.ifc` | file ends inside a string, no `ENDSEC;` | hang in `OpenModel` (confirmed: probe run 44701570892) | rejected by `preflightStep` |

Licence: authored for this repository (MIT, same as the project). No third-party content.
