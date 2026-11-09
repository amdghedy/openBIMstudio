# OpenBIMstudio Modify Subsystem — Master Functional & Engineering Specification

**Document:** MODIFY_FEATURE_MASTER_SPECIFICATION.md 
**Status:** Research baseline / implementation blueprint (not a claim of complete external BIM authoring software equivalence) 
**Reference baseline:** Autodesk external BIM authoring software 2027 Help, with 2024–2026 deltas called out 
**Repository baseline:** `main` at `65ca9e0395880a59efaaf95b97a872faedd5bbdb` (2026-11-02 audit) 
**Purpose:** Clean-room functional specification for an independent openBIM authoring platform.

---

## 0. Executive decision and evidence policy

This is a **reverse-functional specification**, not an interface-copying exercise. The target is the behavior and model integrity of a professional BIM authoring system. Autodesk's public Help is evidence of documented user-visible behavior; it does not expose Autodesk's internal algorithms, transaction implementation, or complete context-tab command lists. Therefore this document distinguishes:

- **Confirmed** — directly described in official Autodesk Help for a named release.
- **Version-specific** — explicitly documented as introduced, changed, or moved in a release.
- **Context-specific** — appears only for a particular category, selection, view, or edit mode.
- **Discipline-specific** — only relevant to architecture, structure, MEP, documentation, or site.
- **Conditional** — available only if the selected element, host, view, connector, or model state supports it.
- **Inferred design requirement** — an OpenBIMstudio behavior proposed to deliver equivalent professional outcomes; not a claim about external BIM authoring software internals.
- **Unverified** — needs release-specific UI/API observation before being represented as exact Autodesk behavior.

Do not treat an Autodesk command name as proof that the command is available for every category. Do not infer an exact default shortcut from memory; Autodesk allows users to assign multiple shortcuts and customize/import/export them. Exact key bindings must come from the matching release's official shortcut export/PDF or an installation-specific XML.

### Primary Autodesk evidence (consulted 2026-11-02)

- external BIM authoring software 2027 What's New, including Options Bar removal, new wall-host behavior, rebar enhancements, fabrication editing and tag leaders
- external BIM authoring software 2027 About Modifying Elements
- external BIM authoring software 2026 Selection
- external BIM authoring software 2026 Constraints
- external BIM authoring software 2026 Duct system modification
- external BIM authoring software 2026 Rebar shape modification
- external BIM authoring software 2026 Rebar constraint editing
- external BIM authoring software 2027 Join Geometry / Cut Geometry / Split Elements: https://help.autodesk.com/
- external BIM authoring software 2027 Keyboard Shortcuts: https://help.autodesk.com/

**Version interpretation:** external BIM authoring software 2027 is the latest documented release found for this research date. 2027 is the primary reference; 2024–2026 are retained for compatibility and migration. The version matrix below only records differences supported by release documentation. Blank/unknown cells mean "not verified", not "feature absent".

---

## 1. Product boundary and terminology

### 1.1 What belongs to Modify

The Modify subsystem includes:
1. Selection, preselection, reference acquisition, filters and selection sets.
2. Transforms and duplication.
3. Geometry edits and host/solid relationships.
4. Parametric constraints, dimensions and temporary controls.
5. Element/type/property editing.
6. MEP system topology, connectors, routing and electrical circuit changes.
7. Category-specific authoring editors (walls, floors, roofs, structural members, rebar, fabrication parts).
8. Annotation, view and sheet edits.
9. Groups, assemblies, parts and linked/reference model interaction.
10. Delete, pinning, visibility and context-menu operations.
11. Transaction, history, validation, warning and dependency propagation.

A ribbon is only one command surface. The same operation may be available from a ribbon, contextual ribbon, context menu, in-canvas control, Properties palette, keyboard shortcut, or direct manipulation.

### 1.2 Model object distinctions

- **Element instance:** placed object with stable identity and instance parameters.
- **Type:** reusable definition; type edits may affect many instances and schedules.
- **Host:** element that owns or geometrically constrains another element (e.g., wall-hosted opening/door, rebar-to-concrete cover).
- **Dependent:** object whose placement, shape, or state derives from another object.
- **Relationship:** explicit persistent link (constraint, host, connection, join/cut, group membership) or derived adjacency (e.g., geometric contact).
- **Reference:** stable geometric/topological target (face, edge, vertex, datum, connector, work plane), not merely a screen coordinate.
- **Linked/reference object:** externally owned content; can be selected and coordinated, but its source geometry is not directly editable in the host model.
- **View-specific object:** annotation, crop, viewport, detail element, or override scoped to a view/sheet.
- **Preview:** transient graphics and a proposed change set; it must not mutate persisted model state.

### 1.3 Feature status vocabulary

Use one status only per feature, with evidence:
- **Complete:** end-to-end behavior, model integrity, persistence, undo/redo, validation, and automated tests demonstrated.
- **Partial:** meaningful implementation exists, but at least one required layer or category behavior is missing/unverified.
- **Planned:** accepted specification, no production implementation evidence.
- **Experimental:** present behind limited workflow or not stable for production.
- **Unavailable:** deliberately unsupported in this application/runtime.
- **New feature indicator:** a small green dot may mark a newly delivered capability for a release; it is not a quality/completeness status. Dot is removed after the user's first acknowledgement or release-note cycle. Never use green dot as an alias for Complete.

---

## 2. external BIM authoring software command taxonomy and inventory boundaries

The canonical command records are in `MODIFY_COMMAND_REGISTRY.json`. They are grouped by behavior, not copied ribbon panels. The registry intentionally separates commands that have different geometry or relationship semantics:

- Move vs Align vs Offset.
- Copy vs Mirror-copy vs Array vs Create Similar.
- Trim/Extend vs Split vs Split with Gap.
- Join vs Cut vs Unjoin vs Uncut vs Switch Join Order.
- Split Face vs Split Element (face material/region vs element identity/geometry).
- Pin vs Lock constraint vs host dependency.
- Change Type vs Edit Type vs Edit Instance Properties.
- MEP connect/disconnect vs system assignment vs routing regeneration.
- Temporary dimensions vs permanent dimensions.
- Hide/isolate view state vs delete model content.

### 2.1 Standard Modify environment

Core command groups to expose in OpenBIMstudio:
- Selection: pick, window/crossing, add/remove, filter, previous set, invert, select similar, select by category/type/property, linked selection.
- Transform: move, rotate, mirror, align, offset, copy, linear/radial array, scale only where semantically valid.
- Geometry: trim/extend, split, split with gap, join/unjoin, cut/uncut, switch join order, edit profile/sketch, shape handles, split face, paint/remove paint.
- Model management: pin/unpin, delete, create similar, match type/properties, group/ungroup, clipboard, paste alignment.
- Constraints: align/lock, unlock, dimensions, equality, host/level/offset, constraint editor.
- View/documentation: hide/isolate, unhide, override, crop/scope, viewport/sheet placement, annotation editing.
- Discipline: MEP topology/routing/sizing; structural member edits and rebar constraints/layout; site/toposolid surface edits.

The exact grouping and panel layout are a product decision. Do not assert that all these commands occupy one Autodesk tab in every release.

### 2.2 Contextual command environment

Context tabs are selection-dependent and may combine category and selection cardinality. OpenBIMstudio should derive capabilities from typed metadata, not hard-code a tab per display label.

| Selection/context | Context family | Typical operations (availability conditional) |
|---|---|---|
| No selection | Modify | selection options, transforms that acquire targets, clipboard paste, measure, global selection |
| One wall | Wall | move/rotate/mirror/copy, edit profile, attach/detach top/base, joins, pin, properties/type |
| Curtain wall/panel/mullion | Curtain system | edit grid/panel/mullion, unpin/replace panel, host/system properties |
| Door/window/opening | Hosted component | flip facing/hand, rehost, move within host, type/instance, host/opening relationships |
| Floor/roof/ceiling | Sketch/shape editor | edit boundary/profile, slope/shape handles, join/cut, split, material/compound layers |
| Stair/ramp/railing | Component-specific editor | edit path/run/landing/support/railing layout; category-specific controls |
| Column/beam/bracing/foundation | Structural | justification, coping/cuts, end offsets, releases/analytical association where supported |
| Duct/pipe | MEP linear | size/elevation/slope/justification, routing solutions, fittings, insulation/lining, connect/disconnect |
| Cable tray/conduit | Electrical containment | width/height/diameter/elevation, fittings, routing, connect/disconnect |
| Equipment/fixture/accessory | MEP component | connector selection, connect into system, system assignment, rotate/move, type/instance |
| Electrical device/circuit/panel | Electrical system | add/remove circuit members, panel assignment, circuit number/load/voltage/phase, circuit path |
| Rebar/rebar set | Structural rebar | edit shape/sketch/constraints, bar layout, edit bars, hooks, cover and visibility |
| Group | Group editor | edit/add/remove/exclude/restore/ungroup; instance/type behavior |
| Assembly | Assembly | add/remove members, assembly views/sheets, type membership |
| Part | Parts | divide/include/exclude/merge/edit boundaries/shape handles |
| Link/drawing/IFC/coordination/point cloud | Reference model | select/link subelements if supported, pin, reload, visibility/override, coordinates; source content not directly edited |
| View/sheet/viewport | Documentation | open view, move/align viewport, crop, title/reference, view-specific controls |
| Dimension/tag/text/detail | Annotation | text/leader/witness/reference edits, type and graphics |
| Grid/level/reference plane/scope box | Datum/reference | move/rotate/extent/3D-2D extents, bubble/label/visibility, pin/constraints |

Multi-category selection uses the **intersection** of capabilities that can safely operate on every selected element. A command may explicitly support a heterogeneous set (e.g. delete, move) or reject it with a reason (e.g. edit a wall profile).

---

## 3. Command record contract

Every command in the JSON registry carries the user's requested fields, including applicability, selection, input, mouse/keyboard, Options Bar/Properties, effects, dependencies, regeneration, transaction, undo, failure, performance, worksharing, linked model, design option, phase, group/family, API/geometry requirement, priority, and implementation status.

Additional mandatory fields:
- `evidence`: URLs and evidence classification.
- `confidence`: confirmed / conditional / proposed.
- `capabilityPredicate`: machine-readable expression or typed capability key.
- `sideEffects`: explicit dependency propagation list.
- `idempotency`: whether repeated execution is safe.
- `selectionPolicy`: exact selection count/type rules.
- `undoGranularity`: one atomic command unless user explicitly starts a grouped operation.

The registry is a **functional command inventory**, not a claim that every Autodesk command exists in every category or release. A future research pass should expand each element family into its exact release-specific ribbon item list using official Help and observed UI/API metadata.

---

## 4. Selection and reference engine

### 4.1 State machine

`Idle → HoverPreselection → CandidateCycling → Selected → MultiSelected → CommandArmed → AcquiringReference → Preview → Validating → Committing → Committed`

Alternative transitions:
- `CommandArmed → Cancelled` via Escape/right-click cancel.
- `Preview → InvalidPreview` when geometry or constraints fail; user may adjust or cancel.
- `Committing → RolledBack` on any atomic transaction failure.
- `Selected → Subselection` for face/edge/vertex/connector/bar-handle/annotation-grip selection.
- `Selected → EditMode` for sketch, profile, group, assembly, rebar, crop, or routing editor.

The state machine is explicit and persisted in UI state only; transient preview selection is not persisted as model data.

### 4.2 Pick semantics

- Hover highlights one candidate without changing selection.
- Tab cycles deterministic candidates under cursor (element, face/edge/vertex, connector, connected chain, linked subelement according to mode).
- Ctrl adds; Shift removes (external BIM authoring software documented behavior). OpenBIMstudio may retain its own Alt-remove convention only if it is discoverable, consistent, and tested; avoid conflicting modifiers.
- Left-to-right window = fully contained; right-to-left = crossing. Selection respects active view visibility, category filters, selection filters, hidden state, and link inclusion.
- Pinned and read-only elements remain selectable for inspection/unpin; edit commands gate on editability.
- Linked subelement selection records both link instance ID and source element ID. It does not grant write access to the linked source.
- Window/fence selection must use spatial index and exact geometry refinement after broad-phase bounds.
- Selection sets store stable IDs plus model/source identity, not transient mesh indices alone.

### 4.3 Selection APIs

`SelectionQuery` supports ids, category, type, IFC class, property predicates, spatial region, visible-in-view, linked source, group, system, host/dependent expansion, and previous selection. Query results are ordered deterministically and report skipped items with reasons.

Preselection is not a command. It cannot mutate or lock an element. Reference acquisition returns a typed `GeometricReference` with owner, topology token, world transform, normal/tangent, view scope, and geometry revision. Any geometry revision invalidates stale references.

---

## 5. Transform and duplication behavior

### 5.1 Move

Input: source point and target point, numeric vector, axis/plane lock, optional snap target, optional disjoin/constraint behavior. Preview transforms all selected objects and computes affected hosts/dependents. A rigid transform must preserve shape; parameter-driven objects must update their defining parameters instead of applying arbitrary mesh deformation. Hosted openings/components follow their host unless user explicitly rehosts or disjoins. MEP endpoints must update connector graph; connected network behavior is explicit: move rigid network, stretch selected run, or disconnect/re-route. Never silently drag an entire network based only on geometric proximity.

Failure: pinned/read-only/worksharing-locked object, locked dimension conflict, invalid host, impossible connector, phase/design-option restriction. Commit one atomic transaction; rollback all moved and dependent objects if any mandatory dependency fails.

### 5.2 Rotate

Requires pivot and axis (2D view plane or 3D axis), angle or two reference rays. Preserve local geometry and transform orientation-dependent data (facing/hand, connectors, text orientation policy, rebar plane). Hosted objects may rotate only where host permits. MEP rotation must preserve connector coordinate systems and re-evaluate fitting orientation. Mirrored-handed family/component semantics are not equivalent to simply negating a mesh transform.

### 5.3 Mirror

Pick axis or draw axis; copy/no-copy are separate options. Reflect geometry and local frames; recalculate normals, winding, handedness, connector directions, dimension references, host side, and family orientation. Some families cannot mirror or may swap facing/hand. Copy mirror creates new stable IDs and clones eligible parameters; it must not duplicate electrical circuits or MEP connections without explicit remapping/reconnection.

### 5.4 Array

Linear or radial; count, spacing/total span, start/end placement, rotate-with-array, group/associate. An associative array is a parametric parent with member instances and constraints; a non-associative array creates independent copies. Editing count/spacing regenerates members atomically. Deleting the array either deletes the parent and members or dissolves association under an explicit command. Reject zero/negative count, self-overlap if disallowed, host violations, and duplicate IDs.

### 5.5 Align and lock

Acquire source reference and target reference. Supported modes: face, edge, axis, center, datum, connector, or work-plane alignment. Alignment can be one-time (transform only) or persistent (constraint record). Lock is a relationship, not a visual toggle. A persistent alignment must be solvable and acyclic; lock creation requires write access to every element that may move. Unlock removes the constraint but not the last solved geometry.

### 5.6 Offset

Offset a curve/profile by signed distance, side, copy option, and join/corner policy. Curves need analytic offset where possible; polyline offsets require robust corner intersections and self-intersection detection. For BIM solids, offset must target a profile/face/axis or a category-specific parameter, not blindly scale a rendered mesh.

---

## 6. Geometry editing

### 6.1 Trim / extend

Acquire boundary and target element(s); choose retained side using pick location. Support single, multiple, and corner trim modes as distinct interaction patterns. Compute exact curve/surface intersections in the active work plane and reject ambiguous or multiple solutions until the user chooses. For walls/MEP, trim may alter endpoint and connected fitting graph; preserve/replace fittings only after compatibility checks.

### 6.2 Split / split with gap

Split Element creates two logical elements with stable identity policy: original retains ID, new segment gets a new ID; parameters, phase, type, host, system, and relevant metadata are copied deliberately. Endpoint references and connectors are reassigned. Split with Gap additionally removes a specified interval; minimum lengths and category-specific rules apply. Split Face is a face-region/material operation and must not be conflated with splitting an element. external BIM authoring software 2027 documents different supported categories for split and split-with-gap; maintain category capability tables.

### 6.3 Join / cut relationships

Join Geometry is a persistent geometric relationship between compatible intersecting solids; it is not just a boolean union. external BIM authoring software documents category precedence/cutting behavior, including walls/columns and host elements. OpenBIMstudio must store join/cut relationship, precedence, operand references, and source solids so unjoin/uncut/switch order can be deterministic. Do not collapse semantic IFC elements into one untraceable solid. A cut may be a void, host opening, or category-specific cut relationship.

### 6.4 Edit profile / sketch / shape

Edit mode isolates a typed submodel (profile curves, footprint, sweep path, extrusion, void, floor/roof boundary, crop boundary). Finish validates closure, planarity, self-intersection, minimum edge length, host constraints, and solid validity. Cancel discards the draft. Sketch changes must preserve element identity and update dependent geometry. Shape handles use category-specific controls (e.g., floor/toposolid shape points); never expose generic mesh vertex editing as a substitute for parametric editing.

### 6.5 Split face / paint

Split Face subdivides a face's display/material region without changing the host's underlying structural geometry. Paint assigns a material to a face; Remove Paint clears that override. Both require stable face references and invalidation when topology changes.

---

## 7. Constraint and dimension engine

### 7.1 Constraint classes

- Geometric: coincident, parallel, perpendicular, tangent, equal, concentric, horizontal/vertical, angle, distance, radius.
- Datum/host: level, work plane, host face, rebar cover, reference plane, base/top constraint, attachment.
- MEP: connector coincidence, axis/normal alignment, size compatibility, system classification, flow direction.
- Documentation: dimension witness references and annotation placement constraints (view-scoped).
- Group/array: membership, transform relationship, count/spacing association.

Do not advertise a solver constraint unless the solver implements it and tests cover under/over-constrained, contradictory, singular and cyclic cases. external BIM authoring software public docs distinguish explicit locked constraints, looser alignments/dimensions, and implied host/join relationships; explicit conflicts are errors, while loose constraints may be dropped in conflict. OpenBIMstudio should not silently drop an explicit constraint.

### 7.2 Temporary vs permanent dimensions

Temporary dimensions are transient edit controls that appear during placement/selection and disappear when action/selection ends. They can drive a temporary move/offset but do not become model annotation. Permanent dimensions are view-specific documentation with references, witness lines, labels, equality/angle modes, units/rounding and text/leader graphics. Editing a dimension value updates model constraints only when the dimension is explicitly driving/locked; otherwise it changes annotation or reports non-driving state.

### 7.3 Solver contract

Solve from immutable input snapshot; return solved parameter values, residuals, DOF/underconstraint report, conflicting constraint IDs, and proposed relationship updates. Use deterministic ordering and bounded iterations. Preview may solve but cannot mutate the persisted store. Commit only when all hard constraints satisfy tolerance and dependency graph remains acyclic. Soft constraints carry weights and visible residuals; they cannot override hard constraints.

---

## 8. Properties and type modification

### 8.1 Property classification

| Property class | Editable rule | Validation / effect |
|---|---|---|
| Instance | Edit selected instances; mixed values display as mixed | Validate domain/units; update that instance and dependents |
| Type | Edit type definition; impact all instances | Preview affected count; warn for geometry/schedule/tag changes; atomic type+instance regeneration |
| Read-only | Display only | Explain source (derived, linked, computed, system-owned) |
| Calculated | Read-only formula/result | Recompute from dependency graph; show provenance |
| Shared/project parameter | Depends on binding and instance/type scope | Preserve GUID/schema; validate storage type and units |
| Family parameter | Only through editable family definition or supported family editor | Flex/regenerate family geometry and all instances |
| Global parameter | Project-level driver bound to compatible parameters | Solve all dependents; reject circular references |
| System parameter | App/discipline-owned | Expose only sanctioned edits (e.g., system assignment); protect internal identity |
| IFC property set | Metadata with schema provenance | Preserve pset/quantity semantics and IFC GUID mapping |

Property editor must show: value, unit, storage type, source, editable state, scope (instance/type/project/family/global), allowed range/options, formula, dependencies, validation message and whether regeneration is pending. Units are stored canonically (SI internal), displayed per project units, and converted at UI boundaries only.

### 8.2 Change Type

Changing type changes the instance's type reference and regenerates its geometry and derived properties. It does not mean copying parameter values from another object. Type replacement must check category compatibility, host compatibility, connector compatibility, family constraints, phase/design option, and required parameters. Type edit/duplicate/rename/load are separate operations. Schedule and tag values refresh from the correct instance/type source.

---

## 9. Clipboard, copy and deletion

### 9.1 Copy/paste

Clipboard payload includes schema version, source project/model, element definitions, types/family refs, host refs, relationship subset, units, coordinate frame, phase/design option and external dependencies. Paste aligned options: same place, current view, selected level(s), selected reference(s), or explicit point. If target dependencies are unavailable, report unresolved references; never silently bind to the nearest unrelated object. Copy must allocate new stable IDs. MEP copies are disconnected by default unless user chooses a validated network-copy workflow. Tags/dimensions may copy only when their references can be remapped.

### 9.2 Duplicate / Create Similar / Match Type

- Duplicate: creates a new instance/type according to explicit scope.
- Create Similar: activates placement with source type/default parameters; does not duplicate existing identity.
- Match Type: applies target type to compatible selected elements.
- Match Properties: copies only explicitly selected property groups; never overwrites identity, host, system, or hidden engineering parameters without confirmation.

### 9.3 Delete

Preflight dependency graph. Show direct dependents, hosted objects, constraints, joins/cuts, dimensions/tags, MEP fittings/connectors, group membership, circuits, schedule effects and linked-source limitations. Deletion policies: block, cascade, detach, replace, or orphan only where schema allows. User chooses policy for destructive ambiguity. One atomic transaction; rollback on any blocked mandatory dependency. Soft-delete may be used internally for undo, but persistent IDs must not be reused.

---

## 10. MEP modification subsystem

MEP operations are graph operations over typed connectors, not merely geometric line edits.

### 10.1 Connector contract

Each connector: owner ID, stable connector ID, domain (HVAC/piping/electrical/cable tray/conduit), shape, size, coordinate frame, origin, axis/normal, system classification, flow direction, electrical poles/voltage/phase, capacity and connection policy. Validate connector domains, compatible shape/size, direction, system, host and allowed connection count.

### 10.2 Duct / pipe / cable tray / conduit

Common edit operations: move/rotate/offset; change width/height/diameter; elevation; slope; justification (center/top/bottom/left/right); type; system; routing preferences; split/join; connect/disconnect; fittings/accessories; insulation/lining (duct/pipe as applicable); routing solution preview; transition/elbow/tee/cross insertion; run-level type change.

Operation rules:
1. Select run or segment; identify physical connected network separately from logical system.
2. Choose scope: segment, connected run, selected network, or whole system.
3. Preview new centerline, connectors, fittings, clearance and clash.
4. Recompute only affected local network; preserve unchanged branches.
5. Validate connectivity, size transitions, slope, flow direction, system membership and fitting family availability.
6. Commit all geometry and topology changes atomically.
7. Refresh pressure/flow/quantity/schedules only for impacted systems.

external BIM authoring software docs explicitly describe duct offsets/diameters, routing solutions, system division, sizing, justification and insulation/lining operations. The exact control location is release-specific; 2027 states the Options Bar controls were removed and relocated into Properties/ribbon generally.

### 10.3 Equipment and fixtures

Equipment is a connector host, not just a terminal mesh. Move/rotate must transform connector frames; host/rehost must preserve mounting rules. Connect Into selects a specific connector when multiple are available, then connects it to a selected run and creates required route geometry. Disconnect equipment removes logical source assignment and may leave physical connections; these are distinct actions.

### 10.4 Electrical

Circuit model includes panel, circuit number, loads, voltage, phase, poles, breaker, conductor, demand/load classification, and panel capacity. Add/remove member changes circuit graph and panel schedule. Moving an electrical fixture must not silently reassign circuit. Copying device creates an unassigned electrical instance by default. Panel changes validate voltage/phase/poles and spare capacity. Circuit path is a documentation/route representation and is not equivalent to physical conduit topology.

### 10.5 MEP system validation

Report open connectors, incompatible connector pairs, disconnected branches, duplicate systems, wrong flow direction, invalid source/equipment assignment, unconnected terminal, invalid slope, impossible fitting, and load/circuit mismatch. Keep warnings distinct from blocking errors. Never invent flow/load/rating values.

---

## 11. Architecture, structure, site and category-specific editors

### 11.1 Architecture

- Walls: location line, base/top constraints, offsets, unconnected height, profile, joins, attachments, inserts, room-bounding, compound structure, wall-hosted relationships. external BIM authoring software 2027 documents walls hosted on other walls; host changes, offsets and rehosting must be represented as new version capability.
- Curtain walls: grid layout, panel/mullion replacement, pin/unpin, host relationship and system constraints.
- Doors/windows: host opening, facing/hand flip, sill/head offsets, rehost and type.
- Floors/roofs/ceilings: boundary sketch, slope arrows, shape points, thickness/layers, joins/cuts, openings.
- Stairs/ramps/railings: category-specific run/path/landing/support/railing editing; no generic extrusion edit.
- Rooms/areas/spaces: boundary calculation and separation-line edits, placement/phase/view constraints.
- Toposolid/site: split, shape points, sub-divisions, excavation/cut relationships, surface points/contours and coordinate reference.
- Components/furniture/casework/generic models: type/instance, host/work plane, placement/orientation, nested family constraints.

### 11.2 Structure

Structural columns/framing/foundations: section/type, justification, end offsets, rotation, coping/cut, analytical association, releases and host/support relationships. Analytical elements, loads, supports, cases and combinations are engineering objects with independent validation; they must not be inferred from physical geometry without explicit rules. Steel connections and fabrication modifiers are category-specific editors with connection design constraints and detail states.

### 11.3 Rebar (dedicated)

Rebar instance shape, bar type/diameter, hooks, end treatments, layout rule, quantity, spacing, partition/number, host cover, bar plane, constraints and visibility are separate data. Editing shape handles preserves host cover constraints unless the user changes the target/constraint. Rebar shape family editing differs from project instance editing. Rebar constraints use valid planar targets; circular references must be rejected. Layout modes include single, fixed number, maximum spacing and release-specific enhanced spacing rules. external BIM authoring software 2027 What's New reports 3D path distribution, enhanced spacing formulas, longitudinal bars driven by transverse reinforcement, and free-form splice improvements; implement only when the relevant geometry/data model is ready.

### 11.4 Fabrication parts

Fabrication MEP parts need connector-aware geometry, fabrication service/specification, dimensions, cut lengths, seams, hangers/supports, part status and spool/fabrication data. 2027 documents improved editing; do not equate fabrication parts with generic ducts/pipes.

---

## 12. Views, sheets, annotations and documentation

### 12.1 View/sheet

Viewport position and rotation on sheet, title/label, view reference, crop boundary, annotation crop, scope box, view range, template, detail level, visual style and view-specific overrides. Crop geometry is view-scoped; model geometry outside crop is not deleted. Sheet viewport move/align changes sheet layout only. external BIM authoring software 2026.1 notes opening placed views from sheets and in-canvas editing of compatible view-reference labels.

### 12.2 Annotation

Dimensions: references/witness lines, text, equality, units, precision, leader, segment display, type. Tags: element reference, leader endpoints, orientation, tag type, label fields; 2027 allows freer leader start/end positioning. Text/keynotes: content, type, alignment, width, leader and reference. Spot elevations/coordinates/slopes: referenced point/face and display format. Grids/levels/sections/elevations/callouts: datum extents, bubbles, heads, view references and in-canvas labels. Detail/model lines are view-specific vs model-wide; classify before transforming or copying.

---

## 13. Groups, assemblies, parts and links

### 13.1 Groups

Group type definition and group instance membership are separate. Edit group changes definition and all instances; add/remove/exclude/restore operations must be explicit. Constraints and dependencies crossing group boundaries require warnings and policy. A group is not merely a collection of selected IDs.

### 13.2 Assemblies

Assembly membership, type identity, assembly views, sheet and documentation are distinct from model groups. Member edits may invalidate assembly views; regenerate only affected views and warn before deleting required members.

### 13.3 Parts

Parts are derived from host layers/geometry but may have independently edited boundaries. Divide/merge/include/exclude changes part graph. Part geometry edits do not automatically write back to original host; Autodesk documents this limitation for edited parts. Preserve provenance and show divergence.

### 13.4 Linked/reference models

- **Editable:** link instance placement/rotation/pin/visibility/overrides and link-level coordinate settings, if host owns those settings.
- **Indirectly editable:** select source elements, copy/monitor, map/copy into native model, or open source project with write permission.
- **Coordination-only:** coordination model selection/visibility/markup; no native parametric edit.
- **Reference-only:** point cloud/drawing/IFC geometry used for snapping/measurement/overlay; source remains external.
- **Non-editable:** source geometry and source properties in a read-only link.

Selection records source-model identity. Snapping to linked DWG/drawing/IFC is a reference operation; it must not modify the linked source. Link reload/replace requires coordinate and identity reconciliation.

---

## 14. Context menus, Options Bar, shortcuts and input devices

### 14.1 Context menu

Build menu from command registry and selection capabilities. Common actions: select all instances (visible/in project/active option), hide/isolate, override graphics, unhide in view, find referring views, create similar, delete, properties/type properties, open/edit, pin/unpin, group/ungroup, worksharing ownership, open placed view, link-specific reload/visibility. Each action has explicit precondition and disabled reason. Do not show generic commands that are impossible for the selected source type.

### 14.2 Options Bar evolution

The Options Bar is a historical/contextual control strip, not a stable API contract. external BIM authoring software 2027 What's New explicitly says controls previously located on the Options Bar were relocated to Properties and ribbon. Therefore OpenBIMstudio should expose a context-aware **Command Options** surface with stable semantics, while allowing layout changes. Examples: copy toggle, constrain, disjoin, multiple, radius/diameter, offset, justification, slope, rebar shape selector, array count/spacing. Store command option defaults per user/project where safe; never persist transient target/reference data.

### 14.3 Keyboard and mouse

- Escape: cancel current command or exit current edit level; repeated Escape returns to selection mode.
- Tab: cycle pick candidates; context-dependent.
- Ctrl/Shift selection semantics as above.
- Spacebar: category/family-specific flip/rotate only when documented for the active tool; don't globally assign.
- Wheel: navigation, not model rotation; user preferences may reverse zoom.
- Middle drag: pan/orbit depending view/navigation mode.
- Left drag: window select or direct manipulation according to active tool.
- Right click: context menu or command cancel; menu must not accidentally commit preview.
- Alt/Ctrl combinations: only bind after conflict audit and user customization.
- Double-click: context-specific edit/open; configurable in external BIM authoring software and should be configurable in OpenBIMstudio.
- Hover: preview highlight only; no write.
- Drag grips: preview-only until pointer release/confirm, then one transaction.
- Keyboard shortcuts: registry supports multiple aliases, customization, import/export and conflict detection. The official release shortcut file is the source of truth for exact external BIM authoring software defaults.

---

## 15. Transaction, undo/redo and failure recovery

### 15.1 Required transaction semantics

A command has one atomic commit boundary by default. Multi-step UI interaction accumulates a draft change set; it does not mutate model state. On commit:
1. Revalidate snapshot/revisions (optimistic concurrency).
2. Acquire edit locks/ownership.
3. Validate geometry and hard constraints.
4. Validate host, link, phase, design-option, group and MEP rules.
5. Apply model and relationship changes.
6. Regenerate only affected geometry/derived data.
7. Persist a single transaction record with inverse and forward patches.
8. Publish model-change events and update affected views/schedules.
If any required step fails, rollback the entire command. Warnings may be accepted by user; errors cannot.

### 15.2 Undo/redo

Undo/redo replays semantic transactions, not reverse mouse movements. Each transaction records stable element IDs, old/new parameter values, geometry revision, relationship deltas, created/deleted entities, selection restoration hints, and external side-effect boundaries. Undo validates that current state still matches the transaction's expected post-state; conflict requires a recoverable message, not silent overwrite. Nested sketch/group/family operations may be grouped into one parent command; each sub-edit remains cancellable until parent commit.

### 15.3 Failure catalog

| Failure | Detection | User-facing behavior | Recovery |
|---|---|---|---|
| Constraint conflict | solver residual / conflicting hard constraint IDs | identify constraint and affected objects | edit/unlock constraint or cancel |
| Invalid geometry | kernel validity, self-intersection, zero area/volume | show preview red + specific reason | adjust sketch/inputs |
| Invalid host | host category/face/phase incompatible | name host and dependent | rehost or cancel |
| Connector incompatibility | domain/shape/size/axis/system mismatch | show connector pair mismatch | choose another connector/fitting |
| Pinned/read-only | editability gate | identify object and reason | unpin / open source / request ownership |
| Worksharing conflict | ownership/revision mismatch | show owner/revision | sync/reload/retry |
| Type conflict | category/host/family mismatch | reject type switch | choose compatible type |
| Circular dependency | graph cycle detection | report cycle path | remove/restructure dependency |
| Invalid parameter/unit | schema/domain validation | field-level error | correct value/unit |
| Stale reference | geometry revision mismatch | ask user to repick | reacquire reference |
| Deleted dependency | preflight graph | explain cascade | rehost/remove dependency |
| Unsupported category/view | capability predicate | disable command with reason | switch view/category or alternate workflow |
| Phase/design option | ownership/context mismatch | report phase/option | change active context |
| Group/assembly restriction | membership/editor rules | identify group/type | enter editor or dissolve membership |
| Regeneration timeout | budget/cancellation token | cancel preview/commit safely | reduce scope or process batch |
| Partial persistence | durable commit failure | no success toast | rollback or recovery journal |

Warnings include disconnected-but-permitted MEP ends, constraint auto-relaxation (only soft), dependent tags/dimensions lost, rebar cover exceeded, geometry beyond host, and large affected element count. Warnings require explicit confirmation when destructive or engineering-significant.

---

## 16. OpenBIMstudio target architecture

```
Ribbon / Context Menu / Command Search / Properties / Canvas Handles
 ↓
ModifyCommandRegistry + CapabilityResolver
 ↓
Command Orchestrator (preview / validate / commit / cancel)
 ↓
Selection + Reference Engine
 ↓
Transaction / History Engine
 ↓
Parametric Model + Parameter Schema
 ↙ ↓ ↘
Constraint Solver Geometry Kernel Relationship Graph
 ↘ ↓ ↙
 MEP Connectivity / Systems / Rebar / Host Services
 ↓
Incremental Regeneration + Quantities + Schedules + Views
 ↓
Persistence / IFC Mapping / Audit Trail
```

### 16.1 Command contract

Use TypeScript and extend the existing `src/modules/modify/command.ts` contract rather than replacing it. Required public lifecycle:

```ts
interface IModifyCommand {
 readonly id: string
 canExecute(ctx: ModifyExecutionContext): CapabilityResult
 begin(ctx: ModifyExecutionContext): void
 updatePreview(input: CommandInput): PreviewResult; // no model writes
 validate(): ValidationResult
 getAffectedElements(): ElementId[]
 getDependencies(): DependencyDelta[]
 getWarnings(): Diagnostic[]
 getErrors(): Diagnostic[]
 commit(tx: TransactionContext): CommitResult
 rollback(): void
 undo(tx: TransactionContext): void
 redo(tx: TransactionContext): void
}
```

Compatibility adapter can map current PascalCase `CanExecute/Begin/UpdatePreview/Validate/Commit/Cancel` methods. Avoid a flag-day rewrite. All commands register metadata: categories, view modes, selection cardinality, reference requirements, capability predicate, options schema, shortcut aliases, command surfaces, risk level, transaction policy and test IDs.

### 16.2 Registry

`ModifyCommandRegistry` is the single source for:
- ribbon and contextual tab composition,
- context-menu generation,
- command search synonyms,
- keyboard shortcuts and conflict validation,
- enabled/disabled state and explanation,
- permission/worksharing checks,
- selection and view capability filtering,
- feature status/green-dot release metadata,
- telemetry (opt-in, privacy-preserving) and QA trace IDs.

### 16.3 Data/geometry architecture

Use typed semantic elements with stable IDs and explicit parameter schema. Use exact/analytic geometry where available, robust B-rep/CSG for solids, mesh as display/cache only. Maintain a relationship graph with typed edges (host, constraint, connector, join, cut, group, assembly, dimension reference, link source). Use incremental dirty propagation; do not scan the entire model for every edit. Spatial index handles broad phase; exact geometry kernel handles final operations.

---

## 17. Repository gap baseline (evidence-led)

Audit of the repository tree and source files found real foundations:
- `src/modules/modify/command.ts`, `transform.ts`, `edit.ts`, `duplicate.ts`, `group1.ts`, `group2.ts`.
- `src/modules/selection/index.ts` and `src/features/selection.ts`.
- `src/modules/transaction/index.ts`, `src/features/history.ts`.
- `src/modules/constraints/solver.ts`, `src/modules/parametric-constraints`, `src/modules/relationships`.
- `src/modules/snapping`, `src/features/snapping.ts`, `src/features/cad-underlay-snap.ts`.
- `src/modules/mep/connectivity.ts`, `connectors.ts`, `electrical.ts`, `router.ts`, `sizing.ts`, `slope.ts`, `stretch.ts`, `pressure.ts`.
- `src/modules/rebar` includes geometry, layout, shapes, standards, schedules and clash detection.
- `src/modules/groups`, `src/modules/model-groups`, view annotation modules, context menu, property schema/palette, and many tests.

This proves code and tests exist, **not** end-to-end completeness. For example, current MEP connectivity is geometry-derived and has explicit tolerance behavior; production connector identity/compatibility and graph persistence still need verification. Rebar layout code documents axis-aligned assumptions for beam/column/slab layouts; arbitrary orientation and full external BIM authoring software-like rebar constraint editing are not established by that module alone. Existing modify Group 1 spec explicitly limits itself to selection/reference/move/rotate/mirror; Group 2 covers align/split-gap/wall-corner trim. Do not assume remaining command families are complete.

The detailed status and exact source paths are in `MODIFY_GAP_ANALYSIS.md`.

---

## 18. QA acceptance gates

Every command must have tests at all applicable layers:
1. Unit: pure math, schema, state transitions.
2. Geometry: exact topology, tolerances, normals, validity, self-intersections.
3. Constraint: hard/soft, over/under-constrained, cycle and rollback.
4. Selection: preselection, candidate cycling, window/crossing, filters, links, multi-select.
5. Transaction: atomic commit, inverse patches, failure rollback, concurrency.
6. Persistence: save/reopen, stable IDs, schema migration, IFC mapping.
7. UI: command options, context tab/menu, search, disabled reason, grips.
8. Discipline: MEP connectivity/system, rebar host/cover, architectural host, analytical data.
9. Regression: golden geometry, schedule/quantity, view/sheet output.
10. Performance: p50/p95 for 1, 100, 1k, 10k objects; cancellation and memory.
11. Accessibility: keyboard-only workflow, focus, readable diagnostics.
12. Security: linked file boundaries, import validation, no untrusted script execution.

Acceptance criteria:
- Preview does not mutate persisted model.
- Commit is atomic and deterministic.
- Undo restores geometry, parameters, relationships, identity and schedules.
- Redo reproduces committed state.
- No orphaned connector/host/dimension references.
- Unaffected objects do not regenerate.
- Large-model operations are cancellable and report progress.
- Every UI command has a testable capability predicate and source-backed status.

---

## 19. Release matrix (documented evidence only)

| Feature / behavior | external BIM authoring software 2024 | external BIM authoring software 2025 | external BIM authoring software 2026 | external BIM authoring software 2027 | Notes |
|---|---|---|---|---|---|
| Basic selection, Ctrl add / Shift remove, Tab cycling, window/crossing | Confirmed | Confirmed baseline | Confirmed | Confirmed | Verify exact setting names per release |
| Contextual ribbon on selection | Confirmed | Confirmed | Confirmed | Confirmed | User can configure activation/focus |
| Constraints: explicit/loose/implied | Confirmed | Confirmed | Confirmed | Confirmed | Exact solver internals are not public |
| Join/cut/split families | Confirmed | Confirmed | Confirmed | Confirmed | Supported categories vary by command |
| Duct system modification / routing | Confirmed | Confirmed | Confirmed | Confirmed | Options and panel names can move |
| Rebar shape/constraint editing | Confirmed | Confirmed | Confirmed | Confirmed | 2027 adds documented distribution/spacing enhancements |
| external BIM authoring software 2027 Options Bar control relocation | — | — | — | **New** | 2027 What's New says prior Options Bar controls moved to Properties/ribbon |
| Host wall on another wall | — | — | — | **New** | 2027 What's New |
| Rule-based model element numbering | — | — | — | **New** | 2027 What's New |
| 3D path rebar distribution / enhanced spacing | — | — | — | **New** | 2027 What's New |
| Longitudinal bars driven by transverse rebar | — | — | — | **New** | 2027 What's New |
| Improved fabrication part editing | — | — | — | **New** | 2027 What's New |
| Tag leader endpoint flexibility | — | — | — | **New** | 2027 What's New |
| In-canvas labels for view refs | — | — | Confirmed 2026.1 | Current | 2026.1 What's New |
| Exact default shortcut for every command | Verify | Verify | Verify | Verify | Download release-specific shortcut list; user-customizable |

“Confirmed” means a public help topic exists for that feature family, not that every subcommand or behavior is identical across all five columns.

---

## 20. Implementation sequence

Follow the roadmap in `MODIFY_IMPLEMENTATION_ROADMAP.md`. Do not start a broad rewrite. The first implementation slice should harden the command registry, selection/capability resolver, and atomic transaction adapter around existing code. Then complete transforms and edit operations one at a time. MEP and rebar remain separate discipline engines.

**Definition of done:** UI + selection + command + geometry + parameters + constraints + dependencies + transaction + undo/redo + persistence + validation + performance + automated tests. A visible button alone is never complete.
