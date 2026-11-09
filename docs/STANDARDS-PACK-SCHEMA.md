# Standards packs as JSON

Regional experts can write a rule pack as a plain JSON file, without TypeScript. Load it in **Standards → Load pack file…**
(or drop the file on the Standards panel), tick it and press Run, like a built-in pack.

A pack file is **data only**. It cannot contain code; every rule is evaluated by the platform's own evaluator
(`src/modules/standards/rules/json-pack.ts`). Unknown fields are ignored.

* Schema for editors: `docs/schemas/standards-pack.schema.json` (add `"$schema"` to get completion/validation in VS Code).
* Worked example: `docs/examples/standards-pack-example.json`. It illustrates the format and is **not** a real building code.

## Shape

```json
{ "format": "openbimstudio-standards-pack", "formatVersion": 1,
  "id": "my-pack", "name": "…", "description": "…", "version": "1.0.0", "jurisdiction": "AE",
  "rules": [ { "id": "…", "name": "…", "severity": "warning", "appliesTo": ["IFCDOOR"],
               "require": { "property": "Pset_DoorCommon.Width", "op": "gte", "value": 850, "unit": "mm" } } ] }
```

A rule has `id`, `name`, `severity` (`info|warning|error`), `require` (what a compliant element satisfies) and optionally
`appliesTo` (IFC classes), `when` (only elements that match are checked), `message` (`{actual}` / `{required}` are replaced),
`standard`, `category`, `description`, `jurisdiction` and `missing`.

**Conditions:** `{property, op, value}` where `property` is a name or a list (the first recorded one is used) and `op` is
`gte gt lte lt eq ne between` (numbers), `equals notEquals contains notContains matches in` (text, case-insensitive),
`exists notExists`. Combine with `{all:[…]}`, `{any:[…]}`, `{not:…}` (nesting depth ≤ 6).

**Units:** `unit` (`m cm mm ft in`) converts the *threshold* to metres. Property values written with a unit suffix
(`"900mm"`) are converted to metres by the platform; plain numbers are compared as they are. If your model stores widths in
millimetres without a suffix, give thresholds without `unit`.

**Missing data:** `missing` says what happens when the property is not recorded: `pass` (default), `info` (one information-level
note) or `fail` (violation at the rule's severity).

**Limits:** file ≤ 5 MB, ≤ 2000 rules, regex ≤ 200 characters and no nested quantifiers (`(a+)+`), matched text capped at 2000 characters.

## What this is not

* It does **not** replace the built-in packs. The built-in rules are TypeScript with custom geometry and cross-element logic,
  so they cannot be exported to this format without losing behaviour. Only the data-style rules can be expressed here.
* Validation uses a hand-written validator, not **ajv**: the platform has no ajv dependency and none was added. The JSON Schema
  file is for authors' tooling; where it and the validator disagree, the validator decides.
* Rules only see the flat property map of each element (`Pset.Property` names). Geometry-based checks are not available.
