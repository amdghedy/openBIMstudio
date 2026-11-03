# Documentation index

OpenBIMStudio has two documentation trees. This page tells you which one to
read (and where a new document belongs).

| Tree | Purpose | You are… |
|------|---------|----------|
| [`documentation/`](../documentation/README.md) | Living guides: user guide, developer guide, the tool catalogue | a user or a new contributor |
| `docs/` | Engineering notes: engine specs, milestone records, the engineering baseline | developing on the platform |

## Start here (living documents)

- [User Guide](../documentation/USER_GUIDE.md) — setup, workflows, troubleshooting
- [Developer Guide](../documentation/DEVELOPER_GUIDE.md) — architecture and contribution
- [Master Tool Catalogue](../documentation/MASTER_TOOL_CATALOG.md) — every command and its maturity level (enforced by `scripts/check-tool-catalog.mjs`)
- [Engineering Architecture Map](engineering/ARCHITECTURE.md) — boot lifecycle, domain boundaries, complete module inventory and data flows\n- [Engineering Baseline](engineering/BASELINE.md) — verified format boundaries and evidence per capability
- [Known issues / gap tracker](engineering/ISSUES.md) (synced to GitHub issues by `engineering/sync-issues.sh`)
- [Plugin SDK](PLUGIN_SDK.md) · [CSP policy](CSP.md) · [Compatibility](COMPATIBILITY.md)

## Engine & workflow notes (current design references)

| Document | Topic |
|----------|-------|
| [SNAP_ENGINE.md](SNAP_ENGINE.md) | Snapping and magnet relationships |
| [PARAMETRIC_ENGINE.md](PARAMETRIC_ENGINE.md) | Families, formulas, constraints |
| [MEP_SYSTEMS_ENGINE.md](MEP_SYSTEMS_ENGINE.md) | Duct/pipe/tray systems, pressure, connectivity |
| [DRAWINGS_DWG_ENGINE.md](DRAWINGS_DWG_ENGINE.md) | CAD editor and DWG/DXF pipeline |
| [NATIVE_BIM_VALIDATION.md](NATIVE_BIM_VALIDATION.md) | Native QA checks and rule packs |
| [NATIVE_TWIN.md](NATIVE_TWIN.md) / [DIGITAL_TWIN_CAPABILITY_MATRIX.md](DIGITAL_TWIN_CAPABILITY_MATRIX.md) | Digital-twin reconstruction |
| [SOURCE_INFORMATION_PRESERVATION.md](SOURCE_INFORMATION_PRESERVATION.md) | Import fidelity |
| [INSTALL-DESKTOP.md](INSTALL-DESKTOP.md) / [INSTALL_AND_UX.md](INSTALL_AND_UX.md) | Install and first-run UX |

## Milestone records (historical)

The `*_V67`–`*_V73` documents (e.g. `REVIT_KILLER_V67.md`,
`AUTHORING_CORE_V68.md`, `MODIFY_GROUP1_SPEC_V71.md`, `MODELING_PANEL_V73.md`)
and `REVIT_GAPS_M1–M3` are **design-and-delivery records for specific
milestones**. They explain why a subsystem looks the way it does, and the
installer scripts they reference (e.g. `scripts/install-bim-gaps.mjs`,
`scripts/install-m4.mjs`) still run idempotently. For the *current* state of a
capability, prefer the living documents above and the tool catalogue.

## Conventions

- Living guides go in `documentation/`; point-in-time engineering notes go in `docs/`.
- Name milestone records after the milestone (`<TOPIC>_V<n>.md`), not the date.
- Every new capability should appear in the Master Tool Catalogue with its
  maturity level — see [SPEC_TEMPLATE.md](../documentation/SPEC_TEMPLATE.md)
  for the spec-first workflow.
