<div align="center">
  <img src="./openBIMstudio.png" alt="OpenBIMStudio Banner" width="100%" />
</div>

<br />
<div align="center">
  <img src="https://raw.githubusercontent.com/amdghedy/openBIMstudio/main/public/favicon.ico" alt="OpenBIMStudio Logo" width="80" />
  <h1>OpenBIMStudio</h1>
  <p><strong>A Professional, Web-Native openBIM Authoring & Coordination Platform</strong></p>

  ![Version](https://img.shields.io/badge/version-0.54.0-blue?style=for-the-badge)
  ![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)
  ![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
  ![Vite](https://img.shields.io/badge/Vite-B73BFE?style=for-the-badge&logo=vite&logoColor=FFD62E)
  ![Three.js](https://img.shields.io/badge/Three.js-000000?style=for-the-badge&logo=three.js&logoColor=white)
  ![IFC.js](https://img.shields.io/badge/That%20Open%20Company-3b82f6?style=for-the-badge)
</div>

<br />

## 🌍 Overview

**OpenBIMStudio** is a local-first, browser-based BIM platform designed to compete with heavy desktop solutions like Autodesk Revit, Navisworks, and Solibri. Built entirely on open standards, it allows AEC professionals to author, coordinate, document, and collaborate on complex building projects without installing gigabytes of software.

By leveraging **Three.js** and the **That Open Company (OBC)** ecosystem, OpenBIMStudio renders massive federated IFC models with high performance, acting as a native web-based authoring engine.

> **Status:** Early-stage / Active Development. The core authoring engine, parametrics, and IFC export are highly functional and continuously expanding.

---

## 🚀 Strong Sides & Core Capabilities

### 1. Revit-Class Authoring (M1 / M2)
*   **Compound Walls**: Layer-based wall generation for realistic construction (e.g., `Brick:0.1, Insulation:0.05, Gypsum:0.015`).
*   **Parametric Generators**: Create stairs (straight, L, U), railings, ramps, curtain walls, and roofs.
*   **MEP Modeling**: Native ducts, pipes, cable trays, and conduits with routing and elbow fitting generation.
*   **Intelligent Joins**: Walls, beams, and ducts auto-miter at corners using advanced geometric solvers.

### 2. Safe Parametrics & Constraints (M6)
*   **Zero-Eval Formula Engine**: A custom, secure parser (`formula-v2.ts`) that processes Revit-style formulas (e.g., `height = LevelHeight - 0.3`) without using dangerous `eval()`.
*   **Level Constraints**: Attach elements to Base/Top levels with offsets; they update automatically when levels move.
*   **Lookup Tables**: Native support for Revit-style `size_lookup()` CSV tables.

### 3. Coordination & Clash Detection
*   **Category-Based Clashes**: Run clashes between specific categories (e.g., `[Native] Beam` vs `[IFC] Pipe`) using a newly designed UI panel.
*   **Native vs IFC**: Check collisions between elements you authored in the browser and elements imported from external federated models.
*   **Triangle BVH**: High-performance geometric clash detection using bounding volume hierarchies.

### 4. Documentation & 2D Generation (M3)
*   **True Sections & Elevations**: Real geometric boolean cuts with poche fills and projected silhouettes.
*   **Smart Plan Views**: Auto-tagged doors/windows (`D1`, `W1`), room area tags, and auto-dimensioning.
*   **Dynamic Schedules**: Generate quantity takeoffs and material schedules directly from the 3D model.

### 5. Interoperability (M4)
*   **Native IFC Export**: Full IFC4 and IFC2X3 STEP file generation with valid GlobalIds and property sets.
*   **Revit Bridge**: Export/Import JSON sidecars to seamlessly exchange rooms, levels, and phases with Autodesk Revit add-ins.
*   **DWG / DXF Parsing**: Native CAD import using `libredwg-web` for 2D reference underlays.

### 6. Real-Time Collaboration (M5)
*   **Element-Level Worksharing**: Borrow and lock specific elements via a central server, preventing "last write wins" data loss.
*   **Realtime Sync**: Yjs / WebSockets integration for live cursor tracking and model synchronization.

---

## 🛠️ Tech Stack

| Domain | Technologies |
| :--- | :--- |
| **Core UI** | Vanilla TypeScript (Imperative), DOM-native rendering |
| **3D Rendering** | Three.js, `@thatopen/components`, `@thatopen/fragments` |
| **Build Tool** | Vite, ESBuild |
| **State / Collab** | Redux Toolkit (Legacy), Yjs |
| **Interop** | `web-ifc`, `libredwg-web`, `pdf-lib` |

---

## 🏁 Getting Started

### Prerequisites
*   **Node.js**: v20.11.0 or higher
*   **npm**: v10 or higher

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/amdghedy/openBIMstudio.git
   cd openBIMstudio
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```
   *The application will be available at `http://localhost:3000`.*

4. Build for production:
   ```bash
   npm run build
   ```

---

## 📂 Project Structure

```text
src/
├── core/           # Core services (Context, Input Router, Camera, Math)
├── features/       # UI components (Ribbon, Context Menu, Property Panel, Clash UI)
├── modules/        # Domain logic
│   ├── revit-gaps/ # M1-M6 Engine (Compound walls, Plan gen, IFC export)
│   ├── drawings/   # DWG / DXF parsing
│   ├── families/   # Parametric family engine
│   ├── clash/      # Triangle BVH clash detection
│   └── views/      # 2D sheet generation
├── shell/          # Application layout and bootstrap
└── main.ts         # Application entry point
```

---

## 🧪 Testing

OpenBIMStudio includes a comprehensive suite of Node.js tests for geometry, IFC parsing, and parametric formulas.

```bash
# Run TypeScript compiler check
npm run typecheck

# Run the full test suite
node tests/run-tests.mjs
```

---

## 🤝 Contributing

Contributions are what make the open-source community such an amazing place to learn, inspire, and create.
1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

<div align="center">
  <i>Built with ❤️ for the openBIM community.</i>
</div>
