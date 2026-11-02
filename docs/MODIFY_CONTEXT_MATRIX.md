# Modify Context Matrix

**Reference:** Revit 2027 primary; 2024–2026 retained. **Status values describe OpenBIMstudio evidence at the audit commit**, not Revit availability.

Legend: C = context-specific; D = discipline-specific; L = linked/reference; P = planned/partial capability. “Common” means shared Modify commands, not a claim that all category-specific contextual ribbon tabs are identical.

| Selection/category | Context family | Shared commands | Category-specific edits | Key dependencies / restrictions | OpenBIMstudio evidence / gap |
|---|---|---|---|---|---|
| No selection | Standard Modify | Select, filter, previous selection, move/copy/rotate/mirror/array/align/offset, paste, measure | command-acquire workflows | active view, clipboard, capability registry | selection + modify actions exist; command registry not yet proven centralized |
| Multi-category | Modify Multi-Select | move, copy, rotate, mirror, delete, pin/unpin, common parameter edits | intersection of compatible capabilities | all selected items editable; type/host/system restrictions | basic multi-selection and options surface exist; mixed category capability matrix needs hardening |
| Wall | Modify Wall | transform, copy, pin, delete, align, trim/split/join | profile, base/top constraints, offsets, attachments, joins, location line, room bounding | hosted inserts, wall joins, phases, options | native wall geometry + constraints + corner tools exist; full profile/attachment behavior not verified |
| Curtain wall/panel/mullion | Curtain system | transform, pin, type | grid, panel/mullion replacement, host/system editing | panel hosted by grid; unpin can alter host-driven behavior | no complete curtain system editor evidenced |
| Door/window/opening | Hosted component | move, rotate, mirror, copy, type, properties | flip facing/hand, rehost, sill/head, host opening | host wall, phase, opening cut | generic component/property mechanisms exist; host-specific behavior partial |
| Floor/roof/ceiling | Sketch/shape | move, copy, rotate, pin, delete, join/cut | boundary sketch, slope arrows, shape points, openings, layers | closed planar profile, level/host, joins | geometry/constraints foundation; category-specific editing not established complete |
| Stairs/ramps/railings | Stair editor | move, copy, type, properties | run/path/landing/support/railing edits | connected run geometry, code checks | no full editor evidenced |
| Room/area/space | Spatial element | properties, tag, boundary-related selection | boundary, separation lines, calculation point | enclosure, phase, view | spatial model support requires separate audit |
| Generic model/furniture/casework | Family/component | move, rotate, mirror, copy, type, properties, pin | host/work plane, nested family, flip controls | family constraints, connectors if MEP | authored generic elements and properties exist; family flex not proven complete |
| Structural column/framing/foundation | Structural | transform, align, copy, pin, type | justification, end offsets, coping, cut, analytical relation | levels, supports, analytical model, joins | structural modules exist; full category editors and analytical sync not proven |
| Rebar/rebar set | Rebar | move/copy/type/properties | shape/sketch, hooks, cover constraints, layout, edit bars, visibility | host concrete, cover refs, bar shape, code rules | rebar layout/geometry/standards/schedules/clashes exist; constraint editor and full 3D shape workflow partial |
| Duct | Duct | move/rotate/copy/delete, properties | size, elevation, slope, justification, route solutions, insulation/lining, fittings | connector graph, system, flow, fitting preferences | router/sizing/slope/connectivity modules and tests exist; routing edit integration & persistent connectors partial |
| Pipe | Pipe | move/rotate/copy/delete, properties | diameter, elevation, slope, justification, route solution, fittings, insulation | system classification, connector sizes, gravity/pressure | MEP foundation exists; full run editing/pressure integration requires validation |
| Cable tray | Tray | transform, type, properties | width/height, elevation, fittings, routing | electrical containment connectivity | cable-tray module exists; category-complete contextual tools not proven |
| Conduit | Conduit | transform, type, properties | diameter, elevation, fittings, routing | electrical connectivity, bend radius | linear MEP model exists; detailed routing/constraints need audit |
| Mechanical equipment | Equipment | transform, type, properties, pin | connector select, connect into, disconnect, source assignment | connector frame, system, equipment hosting | equipment connector model present; family-aware connector definitions still a gap |
| Plumbing/MEP fixtures/accessories | MEP component | transform, type, properties | connector connect/disconnect, system assignment | connector domain, host and flow direction | connector derivation partial; category family support incomplete |
| Electrical fixture/device | Electrical | transform, type, properties | circuit add/remove, panel assignment, circuit path | voltage, phase, poles, circuit rules | electrical calculation/model module exists; complete editing UI and validation gaps |
| Panel/circuit | Electrical system | properties, select members | circuit membership, numbering, panel schedule, loads, panel capacity | panel distribution system and connected loads | data model/calculations exist; complete UI workflows need implementation |
| Fabrication part | Fabrication | move, rotate, copy, properties | service/spec, fabrication connector, part edit, hanger/support | fabrication database/service, spool status | fabrication module exists; editing and documentation parity not verified |
| Group | Group | move, rotate, copy, pin, delete | edit group, add/remove/exclude/restore, ungroup | group type and instance membership | group store exists; robust edit mode/transaction semantics require tests |
| Assembly | Assembly | transform, properties | add/remove members, assembly views/sheet/type | assembly membership and view regeneration | no complete assembly workflow evidenced |
| Part | Parts | transform, properties | divide, merge, include/exclude, boundary/shape handles | host provenance; edits may not write back to host | no complete parts subsystem evidenced |
| Linked Revit/IFC | Reference model | select, pin, visibility, override, reload | select linked element, copy/monitor, copy to native | source identity, transform, reload/version | linked model/CAD snap foundations exist; source read-only boundary required |
| CAD/DWG | Underlay/reference | select link instance, pin, visibility, snap | reference snap, align, move link, reload | source file coordinate system, layer visibility | CAD underlay snap exists; user-requested manual alignment snap integration must be verified |
| Coordination model | Coordination | select model instance, visibility, override | markup/coordination only | external source remains read-only | coordination features exist; no native element parameter editing |
| Point cloud | Scan reference | select cloud, pin, visibility, crop | scan region/crop/registration if supported | point cloud source, coordinate transform | parsers/import and point-cloud modules exist; edit operations are reference-only |
| View | View context | select/open, duplicate, properties | crop, scope box, view range, template, overrides | view type and template control | view/crop/section modules exist; complete command integration partial |
| Sheet/viewport | Sheet context | select, move, align, properties | open placed view, viewport title/label, placement | sheet coordinates, viewport uniqueness | sheet placement workflow not fully evidenced |
| Dimension | Annotation | move, delete, type/properties | witness refs, text, equality, segments, units | referenced geometry and view | annotation modules exist; driving dimension/constraint binding partial |
| Tag/text/keynote | Annotation | move, rotate, copy, type/properties | label, leader endpoints, text edit | referenced element, tag family, view | annotation layer exists; category-specific tag editors partial |
| Detail/model lines | Curve/detail | move, rotate, trim, split, offset | line style, work plane, view/model scope | view plane or model work plane | CAD geometry/modify math exists; full authoring integration requires verification |
| Grid/level/reference plane | Datum | move, rotate, pin, properties | datum extents, bubbles, 2D/3D extent, name | level/host references and constraints | level constraints exist; datum extent/bubble editor needs work |
| Scope box | View reference | move, rotate, pin | extents, view assignment | associated views | scope/section box code exists; full contextual UX not established |
| Analytical member/panel/load/support | Analytical | properties, selection | analytical geometry, releases, loads, combinations, boundary conditions | physical/analytical association and engineering checks | not enough evidence for complete analytical edit subsystem |

## Context resolution rules

1. Determine selected objects by source model + stable ID.
2. Resolve selection category set, capability set, view type, edit mode, worksharing state, phase/design option, and linked/reference ownership.
3. A single-category selection may expose category commands; a heterogeneous selection exposes only safe shared commands.
4. If any selected element cannot execute a command, default to disabled with a reason; offer “apply to editable subset” only as an explicit action with a preview of skipped IDs.
5. Context tab activation is a UI preference; command availability is independent of which ribbon tab has focus.
6. In edit/sketch mode, hide project-level commands that would violate the edit transaction boundary.
7. Linked/reference elements may support selection/visibility/transform of the link instance, but not mutation of source geometry.
8. Feature status indicator is based on registry metadata and release acknowledgement, not on context tab visibility.
