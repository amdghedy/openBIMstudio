# openBIMstudio

**A web-native, open-source BIM authoring platform with a focus on Revit-parity workflows and reliable IFC interoperability.**

openBIMstudio is an ambitious project to bring professional-grade BIM authoring to the browser. It is built for architects, engineers, and developers who want a lightweight, collaborative, and fully open alternative to traditional desktop software.

> **Status:** Early-stage / Active Development. The core authoring engine, parametric families, and IFC export are functional. We are actively closing feature gaps documented in our [`docs/`](./docs) roadmap.

---

## Key Features

- **Parametric Modeling:** Families with formulas, constraints, nested families, arrays, and type catalogs.
- **Architectural Tools:** Walls, slabs, roofs, stairs, railings, curtain walls, rooms and areas, and hosted elements.
- **Revit-Style Workflow:** Revit Command Center UI, command palette (Ctrl+P), align/distribute, match properties, phasing.
- **Interoperability:** Export to IFC4 and IFC2X3 with stable GlobalIds. Designed for round-tripping.
- **Modern UI:** Walkthrough minimap, notification system that prevents hard crashes.
- **Modular Architecture:** Boot system loads modules safely.

For a detailed capability matrix, see [docs/CRITICAL_GAPS_CLOSURE.md](./docs/CRITICAL_GAPS_CLOSURE.md).

---

## Getting Started

**Prerequisites:** Node.js v18+ and npm.

```bash
git clone https://github.com/amdghedy/openBIMstudio.git
cd openBIMstudio
npm install
npm run typecheck
npm run dev
```

The entry point (main.ts) already imports ./critical-gaps-boot - no extra wiring needed.

### Quick UI Tour

- **Revit Command Center:** Opens on first load, or click **RC** in the bottom-left.
- **Command Palette:** Ctrl+P (Cmd+P on macOS) to search tools.
- **Bottom Toolbar:** Draft, Hosts, Solve, generators, visibility, panels.

See [docs/INSTALL_AND_UX.md](./docs/INSTALL_AND_UX.md) for the full UX map.

---

## Roadmap

- [docs/REVIT_GAPS_M1.md](./docs/REVIT_GAPS_M1.md) - Milestone 1
- [docs/REVIT_GAPS_M2.md](./docs/REVIT_GAPS_M2.md) - Milestone 2
- [docs/REVIT_GAPS_M3.md](./docs/REVIT_GAPS_M3.md) - Milestone 3
- [docs/CRITICAL_GAPS_CLOSURE.md](./docs/CRITICAL_GAPS_CLOSURE.md) - Capability matrix

---

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md). Pick a task from docs/. Open an issue or draft PR to discuss.

Please note this project is released with a [Contributor Code of Conduct](./CODE_OF_CONDUCT.md).

---

## License

MIT - see [LICENSE](./LICENSE).