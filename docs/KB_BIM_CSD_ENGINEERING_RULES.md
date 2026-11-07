# KB-BIM Engineering Rules — Profile Contract

## Purpose

The rule engine compiles project-approved MEP requirements into solver-ready constraints. It deliberately contains no universal engineering clearance defaults. The project team must provide the values and source documents that govern the project.

## API

- `validateKbCsdRuleProfile(profile)`: validates schema, rule IDs, provenance, approval audit and dates.
- `compileKbCsdRules({ profile, context, boundary, items, baseRelationships })`: creates cloned solver items, appends hard relationships, and returns diagnostics, applied rule IDs and blocked item IDs.
- `optimizeCsdPacking({ boundary, items, relationships, options })`: consumes the compiled constraints.

The MEP service exposes the compiler as `compileKbCsdRules`.

## Supported rule types

| Rule | Effect |
|---|---|
| `pair-clearance` | Pair-specific minimum separation between two named MEP systems |
| `edge-clearance` | Minimum distance from the section boundary for one system |
| `preferred-side` | Soft preferred side: top, bottom, left or right |
| `service-order` | Hard vertical order and minimum gap between two systems |
| `discipline-restriction` | Blocks systems not allowed for the selected discipline |
| `system-priority` | Candidate-search ordering priority for a system |

All geometric values are metres. Rule names and system identifiers are case-insensitive during matching; item IDs and rule IDs remain stable identifiers.

## Provenance and approval

Every rule must include:
- Stable rule ID and human-readable title.
- Source kind: standard, project specification, consultant instruction, approved RFI or engineering decision.
- Source document ID and clause.
- Approval state: draft or approved.
- For approved rules, approver identity and ISO date.
- Optional effective-from and effective-to dates.

Draft rules are ignored. Approved rules outside their effective date are ignored and reported. A profile with missing source or approval audit is rejected before compilation.

## Example profile

This is a schema illustration only. Values are placeholders and must be replaced with project-approved requirements before use.

```json
{
  "schemaVersion": 1,
  "id": "project-csd-profile",
  "name": "Project CSD Coordination Rules",
  "revision": "A",
  "jurisdiction": "project-defined",
  "projectId": "PROJECT-ID",
  "rules": [
    {
      "id": "CSD-CLR-001",
      "title": "Supply air to chilled water clearance",
      "kind": "pair-clearance",
      "systems": ["supply-air", "chilled-water"],
      "value": 0.0,
      "source": {
        "kind": "project-specification",
        "documentId": "SPEC-REFERENCE",
        "clause": "CLAUSE-REFERENCE",
        "revision": "A"
      },
      "approval": "draft"
    }
  ]
}
```

## Compilation semantics

- Duplicate pair-clearance requirements are resolved conservatively using the maximum value.
- Pair-specific clearances are stored by peer item ID; they do not inflate clearances to unrelated services.
- Edge clearances use the maximum applicable requirement.
- Multiple system-priority rules use the maximum priority; negative priorities are supported.
- Preferred-side rules are soft. Strongest rule wins; ties resolve by rule ID. A pre-existing fixed or preferred position is not silently overwritten.
- Service-order rules become hard `above` relationships for each matching item pair.
- Discipline restrictions return `blockedItemIds`. The caller must not run or approve a candidate while blocked items remain unresolved.
- `valid` means the profile and compilation context are structurally valid. It does not mean every model item is permitted; always inspect `blockedItemIds` and diagnostics.
- No rule is silently inferred from an unknown standard or jurisdiction.

## Engineering boundary

This module is a traceable rule compiler, not a code-compliance certification engine. Project engineers must confirm the source clause, applicability, units, exceptions and approvals. The UI must show the source reference and diagnostics for every applied rule.
