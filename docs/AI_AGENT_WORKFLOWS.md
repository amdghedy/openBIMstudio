# AI-driven BIM workflows

## Purpose

The AI Assistant is an operator for openBIMstudio's own application services. The language model interprets instructions and chooses tools; openBIMstudio remains responsible for model geometry, validation, persistence, and history. A chat response or generated description is never evidence that a model edit occurred.

## Current agent behavior

The agent is instructed to follow a read → plan → act → verify sequence:

1. **Read:** inspect the active project, loaded models, relevant elements, drawing links, and available commands with read-only tools.
2. **Plan:** determine the smallest supported sequence of operations. Ask for missing placement, dimensions, system constraints, or design criteria instead of inventing them.
3. **Approve:** project-writing operations display a confirmation card with the tool arguments before execution.
4. **Act:** call registered native application tools. Do not simulate unsupported functionality with unrelated geometry.
5. **Verify:** inspect tool results and actual committed element counts/IDs. Run an available validation or clash check when requested; state clearly when no suitable validator exists.

Read-only inspection tools remain available without a confirmation prompt. The following write operations require explicit approval: native linear element creation, drawing-derived wall creation, BCF issue creation, custom schedule creation, and all destructive operations. Destructive operations retain their existing confirmation behavior.

## Implemented native capabilities

- Read active project state, model categories, element properties/evidence, and filtered element queries.
- Create straight native walls, beams, strips, ducts, pipes, cable trays, conduits, and linear members using `create_linear_elements`.
- Analyze linked drawing layers and create native walls from supported drawing wall geometry using `create_walls_from_cad`.
- Run registered clash and schedule tools, and create supported BCF issues or custom schedules after approval.

Native linear coordinates use metres in plan X/Z; elevation is Y. The authoring service creates the geometry, so successful commits participate in native editing/history. The AI must report the actual returned count and IDs, not the requested count.

## MEP scope boundary

The current linear authoring tool can create straight MEP segments. That does **not** by itself establish a connected, sized, or validated MEP system.

Do not claim automatic end-to-end MEP routing, connector compatibility, equipment port mapping, automatic fitting selection, pressure-loss/flow calculations, electrical load calculations, circuiting, or system compliance unless dedicated tools implement and verify those operations. A connected MEP workflow needs, at minimum:

- Reliable connector definitions for equipment, fittings, and linear elements.
- A connector graph with domain/system compatibility and direction rules.
- Route planning against model obstacles and clearance envelopes.
- Fitting/transition generation with geometric and connectivity checks.
- Native persistence, undo/redo, and lifecycle synchronization after move/rotate/resize/delete.
- Domain-specific calculations and validation with explicit inputs, units, and traceable results.

Until those components are available, the assistant must say which parts it can create and which remain unsupported. It must not represent disconnected segments as a completed system.

## Provider configuration

The model provider is used for language understanding and tool selection. The native tools execute inside openBIMstudio. The free DeepSeek Chat website session is not an API credential and cannot be reused as an application endpoint. Users may configure a supported API provider or a local Ollama model with reliable function/tool calling. Provider compatibility and tool-calling behavior must be tested for the exact model/version.

## Roadmap

### Stage 1 — Safe agent orchestration
- Consistent read → plan → approve → act → verify behavior.
- Approval gates for all registered project-writing operations.
- Honest capability boundaries and actionable error reporting.

### Stage 2 — Context-aware authoring
- Resolve placements from explicit user picks, active views, levels, grids, and verified drawing/model geometry.
- Provide editable previews and grouped approval for bounded modeling plans.
- Add dedicated hosted/area/point tools for slabs, columns, openings, doors, and windows.

### Stage 3 — Connector-aware MEP
- Family-aware connector authoring and graph validation.
- Obstacle-aware route planning, fittings, and connected native runs.
- Rebuild and lifecycle handling for edits to connected systems.

### Stage 4 — Engineering verification
- Dedicated domain calculations and rule checks with traceable assumptions.
- Clash/clearance verification and actionable issue generation.
- Reports distinguish calculated results from engineering review and approval.

Each stage must be implemented against the existing domain services, covered by automated tests, and merged only after CI passes. A roadmap item is not a delivered capability.
