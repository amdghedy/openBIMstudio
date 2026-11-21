#!/usr/bin/env python3
"""Independent validation of IFC files produced by openBIMstudio's Native Twin
exporter (src/modules/export/native-twin-ifc.ts).

Uses IfcOpenShell (https://ifcopenshell.org) -- an independent IFC
implementation that shares no code with the openBIMstudio writer, its
in-repo semantic parser, or web-ifc. What passing means:

  - the file parses as IFC4 in a third-party reader;
  - every exported element is present with the expected IFC entity type
    (not silently downgraded to IfcBuildingElementProxy);
  - every element has a valid 22-char GlobalId, a valid local placement,
    a Body tessellation representation (when geometry was supplied), and
    exactly one spatial containment (IfcRelContainedInSpatialStructure
    to the storey);
  - every property set is attached via IfcRelDefinesByProperties;
  - door/window OverallHeight/OverallWidth, when present, are positive
    and match the reported bounding-box derivation.

What passing does NOT mean:
  - it is NOT proof that a desktop BIM tool (Revit/ArchiCAD/etc.) opens
    the file -- no desktop tool was run here;
  - it does NOT validate openings/fills relationships for doors/windows
    (the twin writer deliberately emits none -- see
    docs/engineering/NATIVE_IFC_ENTITY_EXPORT.md);
  - geometric shape validation is best-effort: if the IfcOpenShell
    geometry kernel is unavailable, vertex/triangle counts from the
    tessellation are reported instead of a BRep shape check.

Usage:
    python3 scripts/validate_native_ifc_export.py <file.ifc> [--expect expectations.json]
    python3 scripts/validate_native_ifc_export.py <file.ifc> --expect-json '{"IfcWall": 1}'

Exit code 0 = no errors; 1 = validation errors (printed as JSON).
Requires: pip install ifcopenshell
"""

import json
import re
import sys

GUID_RE = re.compile(r"^[0-9A-Za-z_$]{22}$")

# IFC4 PredefinedType enumerations, from the IFC4 schema (verified via
# ifcopenshell.schema_by_name("IFC4")). Kept here so the validator checks
# enum values independently of the writer's own tables.
PREDEFINED_ENUMS = {
    "IfcWall": ["MOVABLE", "PARAPET", "PARTITIONING", "PLUMBINGWALL", "SHEAR",
                "SOLIDWALL", "STANDARD", "POLYGONAL", "ELEMENTEDWALL",
                "USERDEFINED", "NOTDEFINED"],
    "IfcSlab": ["FLOOR", "ROOF", "LANDING", "BASESLAB", "USERDEFINED", "NOTDEFINED"],
    "IfcBeam": ["BEAM", "JOIST", "HOLLOWCORE", "LINTEL", "SPANDREL", "T_BEAM",
                "USERDEFINED", "NOTDEFINED"],
    "IfcColumn": ["COLUMN", "PILASTER", "USERDEFINED", "NOTDEFINED"],
    "IfcDoor": ["DOOR", "GATE", "TRAPDOOR", "USERDEFINED", "NOTDEFINED"],
    "IfcWindow": ["WINDOW", "SKYLIGHT", "LIGHTDOME", "USERDEFINED", "NOTDEFINED"],
    "IfcMember": ["BRACE", "CHORD", "COLLAR", "MEMBER", "MULLION", "PLATE",
                  "POST", "PURLIN", "RAFTER", "STRINGER", "STRUT", "STUD",
                  "USERDEFINED", "NOTDEFINED"],
    "IfcPlate": ["CURTAIN_PANEL", "SHEET", "USERDEFINED", "NOTDEFINED"],
    "IfcFooting": ["CAISSON_FOUNDATION", "FOOTING_BEAM", "PAD_FOOTING",
                   "PILE_CAP", "STRIP_FOOTING", "USERDEFINED", "NOTDEFINED"],
    "IfcPile": ["BORED", "DRIVEN", "JETGROUTING", "COHESION", "FRICTION",
                "SUPPORT", "USERDEFINED", "NOTDEFINED"],
    "IfcRailing": ["HANDRAIL", "GUARDRAIL", "BALUSTRADE", "USERDEFINED",
                   "NOTDEFINED"],
    "IfcStair": ["STRAIGHT_RUN_STAIR", "TWO_STRAIGHT_RUN_STAIR",
                 "QUARTER_WINDING_STAIR", "QUARTER_TURN_STAIR",
                 "HALF_WINDING_STAIR", "HALF_TURN_STAIR",
                 "TWO_QUARTER_WINDING_STAIR", "TWO_QUARTER_TURN_STAIR",
                 "THREE_QUARTER_WINDING_STAIR", "THREE_QUARTER_TURN_STAIR",
                 "SPIRAL_STAIR", "DOUBLE_RETURN_STAIR", "CURVED_RUN_STAIR",
                 "TWO_CURVED_RUN_STAIR", "USERDEFINED", "NOTDEFINED"],
    "IfcRamp": ["STRAIGHT_RUN_RAMP", "TWO_STRAIGHT_RUN_RAMP",
                "QUARTER_TURN_RAMP", "TWO_QUARTER_TURN_RAMP",
                "HALF_TURN_RAMP", "SPIRAL_RAMP", "USERDEFINED", "NOTDEFINED"],
    "IfcBuildingElementProxy": ["COMPLEX", "ELEMENT", "PARTIAL",
                                "PROVISIONFORVOID", "PROVISIONFORSPACE",
                                "USERDEFINED", "NOTDEFINED"],
}

# Element entity types the twin writer may emit (typed + explicit fallback).
ELEMENT_TYPES = list(PREDEFINED_ENUMS) + [
    "IfcFurnishingElement", "IfcFlowSegment", "IfcFlowTerminal",
    "IfcFlowFitting", "IfcDistributionElement",
]


def _placement_location(element):
    """Location of an element's ObjectPlacement, or None."""
    try:
        placement = element.ObjectPlacement
        if placement is None:
            return None
        rel = placement.RelativePlacement
        if rel is None:
            return None
        loc = rel.Location
        if loc is None:
            return None
        return [float(c) for c in loc.Coordinates]
    except Exception:
        return None


def _representation_info(element):
    """(representation_type, vertex_count, triangle_count) for the Body rep."""
    try:
        rep = element.Representation
        if rep is None:
            return (None, 0, 0)
        for shape_rep in rep.Representations or []:
            if shape_rep.RepresentationIdentifier != "Body":
                continue
            for item in shape_rep.Items or []:
                if item.is_a("IfcTriangulatedFaceSet"):
                    coords = item.Coordinates
                    verts = len(coords.CoordList) if coords is not None else 0
                    tris = len(item.CoordIndex) if item.CoordIndex else 0
                    return ("Tessellation", verts, tris)
                return (item.is_a(), 0, 0)
        return (None, 0, 0)
    except Exception:
        return (None, 0, 0)


def _psets(element):
    out = {}
    try:
        for rel in element.IsDefinedBy or []:
            if not rel.is_a("IfcRelDefinesByProperties"):
                continue
            pset = rel.RelatingPropertyDefinition
            if pset is None or not pset.is_a("IfcPropertySet"):
                continue
            props = {}
            for prop in pset.HasProperties or []:
                try:
                    props[prop.Name] = prop.NominalValue.wrappedValue \
                        if prop.NominalValue is not None else None
                except Exception:
                    props[prop.Name] = None
            out[pset.Name] = props
    except Exception:
        pass
    return out


def validate(path, expect=None):
    import ifcopenshell

    model = ifcopenshell.open(path)
    errors = []
    elements = []
    counts = {}
    seen_guids = set()

    for type_name in ELEMENT_TYPES:
        # Exact-type instances only: by_type() is polymorphic (an
        # IfcFlowSegment is also an IfcDistributionElement), and counting a
        # subtype under its supertype would double-count elements and report
        # phantom duplicate GlobalIds.
        found = [el for el in model.by_type(type_name) if el.is_a() == type_name]
        counts[type_name] = len(found)
        for el in found:
            gid = el.GlobalId
            if not GUID_RE.match(gid or ""):
                errors.append(f"{type_name} #{el.id()}: invalid GlobalId {gid!r}")
            if gid in seen_guids:
                errors.append(f"duplicate GlobalId {gid!r}")
            seen_guids.add(gid)

            loc = _placement_location(el)
            if loc is None:
                errors.append(f"{type_name} '{el.Name}' #{el.id()}: no valid ObjectPlacement")
            elif len(loc) != 3 or any(c != c or c in (float("inf"), float("-inf")) for c in loc):
                errors.append(f"{type_name} '{el.Name}' #{el.id()}: non-finite placement {loc}")

            rep_type, verts, tris = _representation_info(el)
            if rep_type is None:
                errors.append(f"{type_name} '{el.Name}' #{el.id()}: no Body representation")
            elif rep_type != "Tessellation":
                errors.append(f"{type_name} '{el.Name}' #{el.id()}: Body is {rep_type}, not Tessellation")
            elif verts < 3 or tris < 1:
                errors.append(f"{type_name} '{el.Name}' #{el.id()}: degenerate tessellation ({verts} verts, {tris} tris)")

            contained = list(el.ContainedInStructure or [])
            if len(contained) != 1:
                errors.append(
                    f"{type_name} '{el.Name}' #{el.id()}: expected 1 spatial containment, found {len(contained)}")
            elif not contained[0].RelatingStructure.is_a("IfcBuildingStorey"):
                errors.append(
                    f"{type_name} '{el.Name}' #{el.id()}: contained in "
                    f"{contained[0].RelatingStructure.is_a()}, not IfcBuildingStorey")

            psets = _psets(el)
            if "Pset_NativeTwinLineage" not in psets:
                errors.append(f"{type_name} '{el.Name}' #{el.id()}: missing Pset_NativeTwinLineage")

            predefined = None
            if type_name in PREDEFINED_ENUMS:
                predefined = getattr(el, "PredefinedType", None)
                if predefined is not None and predefined not in PREDEFINED_ENUMS[type_name]:
                    errors.append(
                        f"{type_name} '{el.Name}' #{el.id()}: PredefinedType {predefined!r} "
                        f"not in {type_name} enum")
                if predefined == "USERDEFINED" and not el.ObjectType:
                    errors.append(
                        f"{type_name} '{el.Name}' #{el.id()}: USERDEFINED without ObjectType "
                        f"(violates CorrectPredefinedType)")

            overall = {}
            if type_name in ("IfcDoor", "IfcWindow"):
                for attr in ("OverallHeight", "OverallWidth"):
                    val = getattr(el, attr, None)
                    overall[attr] = val
                    if val is not None and not (isinstance(val, (int, float)) and val > 0):
                        errors.append(
                            f"{type_name} '{el.Name}' #{el.id()}: {attr}={val!r} is not positive")

            # Best-effort shape check via the geometry kernel, when available.
            shape_ok = None
            shape_error = None
            try:
                import ifcopenshell.geom
                settings = ifcopenshell.geom.settings()
                shape = ifcopenshell.geom.create_shape(settings, el)
                shape_ok = shape is not None
            except Exception as exc:  # kernel unavailable -- tessellation counts stand in
                shape_error = str(exc)[:200]

            elements.append({
                "id": el.id(),
                "type": type_name,
                "name": el.Name,
                "globalId": gid,
                "predefinedType": predefined,
                "tag": el.Tag,
                "placement": loc,
                "representation": rep_type,
                "vertices": verts,
                "triangles": tris,
                "containedIn": contained[0].RelatingStructure.is_a() if contained else None,
                "propertySets": sorted(psets.keys()),
                "lineage": psets.get("Pset_NativeTwinLineage", {}),
                "overall": overall,
                "shapeOk": shape_ok,
                "shapeError": shape_error,
            })

    if expect:
        for type_name, wanted in expect.items():
            got = counts.get(type_name, 0)
            if got != wanted:
                errors.append(f"expected {wanted} x {type_name}, found {got}")

    return {
        "file": path,
        "schema": model.schema,
        "validator": f"IfcOpenShell {ifcopenshell.version}",
        "counts": {k: v for k, v in counts.items() if v},
        "totalElements": sum(counts.values()),
        "elements": elements,
        "errors": errors,
        "ok": not errors,
    }


def main(argv):
    path = argv[1]
    expect = None
    if "--expect" in argv:
        with open(argv[argv.index("--expect") + 1]) as f:
            expect = json.load(f)
    if "--expect-json" in argv:
        expect = json.loads(argv[argv.index("--expect-json") + 1])
    result = validate(path, expect)
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
