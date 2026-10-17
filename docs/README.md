# OpenBIMstudio Documentation

This directory contains user, developer and tool-reference documentation for OpenBIMstudio.

## Start here

- [User Guide](USER_GUIDE.md) — local setup, common workflows, troubleshooting and safe verification.
- [Master Tool Catalogue](MASTER_TOOL_CATALOG.md) — source-mapped inventory of tool families, with explicit verification boundaries.
- [Developer Guide](DEVELOPER_GUIDE.md) — architecture, module registration, persistence, testing and security.
- [Tool Reference Pages](tools/README.md) — per-tool documentation template and priority list.

## Existing implementation and gap documents

- [Install and UX notes](INSTALL_AND_UX.md)
- [Native BIM validation](NATIVE_BIM_VALIDATION.md)
- [Parametric engine](PARAMETRIC_ENGINE.md)
- [Drawing DWG engine](DRAWINGS_DWG_ENGINE.md)
- [M4 view templates and automatic dimensions](M4_VIEW_TEMPLATES_AUTO_DIMS.md)
- [Revit gap reviews: M1](REVIT_GAPS_M1.md), [M2](REVIT_GAPS_M2.md), [M3](REVIT_GAPS_M3.md)
- [Critical gaps closure](CRITICAL_GAPS_CLOSURE.md)
- [CAD gaps closure](CAD_GAPS_CLOSURE.md)
- [Revit input parity](REVIT_INPUT_PARITY.md)
- [Parametric Revit closure](PARAMETRIC_REVIT_CLOSURE.md)

## Documentation policy

Each feature page should identify its source path, entry point, inputs, output, persistence, dependencies, known limitations and tests. A feature is not “verified” merely because its module or UI exists. Mark runtime and interoperability claims only after reproducible tests.
