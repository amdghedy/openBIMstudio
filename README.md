<p align="center">
  <img src="openBIMstudio.png" alt="OpenBIMStudio" width="960">
</p>

<div align="center">

# OpenBIMStudio

### The open, local-first BIM workspace that runs in your browser

[![Version](https://img.shields.io/badge/version-0.74.0-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![IFC](https://img.shields.io/badge/IFC-2x3%20%7C%204-3b82f6.svg)](#-interoperability)
[![Runs in](https://img.shields.io/badge/runs%20in-browser-success.svg)](#)
[![CI](https://github.com/amdghedy/openBIMstudio/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/amdghedy/openBIMstudio/actions/workflows/unit-tests.yml)
[![BIM validation](https://github.com/amdghedy/openBIMstudio/actions/workflows/native-bim-validation.yml/badge.svg)](https://github.com/amdghedy/openBIMstudio/actions/workflows/native-bim-validation.yml)

**Local-first · Zero install · Open standards · IFC · BCF · IDS · PDF · CAD · AI-ready**

[Quick start](#quick-start) · [Why OpenBIMStudio](#-why-openbimstudio) · [What you can do](#-what-you-can-do) · [All tools & commands](#tools--commands) · [Interoperability](#-interoperability) · [Documentation](#-documentation)

<p align="center">
  <a href="https://www.buildingsmart.org/"><img src="https://img.shields.io/badge/IFC-2x3%20%7C%204-0096D6?style=for-the-badge" alt="IFC — Industry Foundation Classes"></a>
  <a href="https://thatopen.com/"><img src="https://img.shields.io/badge/That%20Open-web--ifc%20·%20Fragments-7C3AED?style=for-the-badge" alt="That Open"></a>
  <a href="https://threejs.org/"><img src="https://img.shields.io/badge/Three.js-000000?style=for-the-badge&logo=threedotjs&logoColor=white" alt="Three.js"></a>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/React-18-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite">
  <img src="https://img.shields.io/badge/MUI-007FFF?style=flat-square&logo=mui&logoColor=white" alt="MUI">
  <img src="https://img.shields.io/badge/LibreDWG-WASM-2D7D9A?style=flat-square" alt="LibreDWG">
  <img src="https://img.shields.io/badge/Yjs-CRDT-4B7BE5?style=flat-square" alt="Yjs">
</p>

</div>

---

## Repository snapshot

OpenBIMStudio is a browser-native BIM workspace designed for architecture, engineering, and coordination teams who want a local-first, open-standards workflow without a desktop-only lock-in.

- Primary codebase: JavaScript (75.6%) and TypeScript (24.1%)
- Runtime model: local-first browser app with optional server-backed collaboration, AI, and cloud services
- Core stack: React, Vite, Three.js, web-ifc / Fragments, MUI, and WASM-based CAD tooling
- Typical use cases: authoring, federation, clash detection, drawing production, validation, and issue exchange

This repository brings together model authoring, coordination, interoperability, and QA in a single app — with the goal of reducing tool fragmentation while keeping data portable and vendor-independent.

---

## What is OpenBIMStudio?

OpenBIMStudio is a **browser-based, local-first BIM workspace** for architecture, engineering, and construction. It combines model authoring, multi-model federation, clash detection, BCF issue exchange, sheet production, and validation around open standards and a self-hosted local workflow.

One install (none, actually — it's your browser). One license (MIT — yours). Your model data stays on your machine by default.

> **Latest (v0.74.0):** cursor-accurate wheel zoom with a guaranteed orientation invariant (zoom never rotates the camera), full Content-Security-Policy with a self-hosted Fragments worker, and a wide set of modeling/documentation improvements.
> 
> **Modeling (v0.73.0):** justification-aware wall & MEP modeling, magnetic snapping with persistent relationships, dependent-geometry updates in a single undo step, dynamic per-tool property panels, and a more robust family/parametric workflow.

| For you if you… | OpenBIMStudio helps by… |
|-----------------|-------------------------|
| Need a free / open alternative for BIM | Full authoring + coordination workspace, MIT license, IFC-native |
| Coordinate multi-discipline models | Federation, worker-based clash detection, BCF issues, Copy/Monitor |
| Produce plans and sheets | Views, auto-dimension chains, tags, sheets with title blocks, PDF export |
| Validate deliverables | IDS requirements, native model QA, rule packs, model health diagnostics |
| Prefer open data | IFC, BCF, IDS, DXF, CSV, PDF — no proprietary lock-in, ever |

> **Note:** The platform is actively developed and tools differ in maturity. Every capability below exists in the codebase today; check the [Master Tool Catalogue](documentation/MASTER_TOOL_CATALOG.md) for the current status and verification boundaries.

---
