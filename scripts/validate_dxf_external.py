#!/usr/bin/env python3
"""Independent DXF validation with ezdxf.

This script is deliberately a THIRD-PARTY implementation: it parses with
ezdxf (https://ezdxf.readthedocs.io), which shares no code with
openBIMstudio's TypeScript reader/writer or the acadrust WASM engine. It is
used by tests/dxf-independent-validation.test.cjs to check that files the
platform writes are structurally valid DXF that other software can open, and
to produce ground-truth reports for files the platform reads.

What it reports (JSON on stdout):
  ok            file loaded
  acadver       $ACADVER (e.g. AC1024)
  insunits      $INSUNITS raw value (0 unknown, 1 in, 2 ft, 4 mm, 5 cm, 6 m)
  ltscale       $LTSCALE
  layers        [{name, color, rgb, linetype, lineweight, frozen, locked, off}]
  linetypes     {NAME: [dash, gap, ...]} total pattern length per record
  msp / psp     {ENTITYTYPE: count} for model space / first paper space
  texts         [str] every TEXT/MTEXT string in model space
  blocks        {blockName: {ENTITYTYPE: count}} named blocks + anonymous *D dim blocks
  blockTexts    {blockName: [str]} text values inside each block (dimension text ground truth)
  sample        per-type geometry ground truth (capped): LINE/CIRCLE/ARC/LWPOLYLINE/
                TEXT/ELLIPSE/SPLINE/HATCH coordinates as ezdxf reads them
  dimstyles     [name] DIMSTYLE table entries
  viewports     first paper space viewports [{center,w,h,viewCenter,viewHeight}]
  auditErrors / auditFixes   ezdxf's own structural audit counts
  auditDetails  first few audit messages

Exit codes: 0 = loaded and audit-clean, 1 = loaded with audit errors,
2 = could not load at all, 3 = ezdxf not importable.

NOTE: passing here is evidence that the file conforms to the DXF standard as
understood by an independent implementation. It is NOT certification that a
specific desktop CAD product opens the file.
"""
import json
import sys
from collections import Counter

try:
    import ezdxf
    from ezdxf.audit import Auditor
except ImportError:
    print(json.dumps({"ok": False, "error": "ezdxf is not installed (pip install ezdxf)"}))
    sys.exit(3)


def layer_report(doc):
    out = []
    for l in doc.layers:
        entry = {"name": l.dxf.name, "color": l.dxf.color}
        if l.rgb is not None:
            entry["rgb"] = (l.rgb[0] << 16) | (l.rgb[1] << 8) | l.rgb[2]
        if l.dxf.hasattr("linetype"):
            entry["linetype"] = l.dxf.linetype
        if l.dxf.hasattr("lineweight"):
            entry["lineweight"] = l.dxf.lineweight
        if l.dxf.hasattr("frozen"):
            entry["frozen"] = bool(l.dxf.frozen)
        if l.dxf.hasattr("locked"):
            entry["locked"] = bool(l.dxf.locked)
        entry["off"] = entry["color"] < 0
        out.append(entry)
    return out


def ltype_report(doc):
    out = {}
    for lt in doc.linetypes:
        if lt.dxf.name.upper() in ("BYBLOCK", "BYLAYER"):
            continue
        pattern = getattr(lt, "pattern_tags", None)
        dashes = [t.value for t in pattern.tags if t.code == 49] if pattern else []
        out[lt.dxf.name.upper()] = dashes
    return out


def census(layout):
    return dict(Counter(e.dxftype() for e in layout))


def all_paper_census(doc):
    """Entity census across EVERY paper-space layout (the active one may be
    empty while other sheets carry the content)."""
    total = Counter()
    for name in doc.layouts.names():
        if name.lower() == "model":
            continue
        total.update(Counter(e.dxftype() for e in doc.layouts.get(name)))
    return dict(total)


def all_paper_viewports(doc):
    vps = []
    for name in doc.layouts.names():
        if name.lower() == "model":
            continue
        vps.extend(viewport_report(doc.layouts.get(name)))
    return vps


def texts_of(layout):
    vals = []
    for e in layout:
        if e.dxftype() == "TEXT":
            vals.append(e.dxf.text)
        elif e.dxftype() == "MTEXT":
            vals.append(e.plain_text())
    return vals


def block_report(doc):
    out = {}
    for b in doc.blocks:
        name = b.name
        # Named blocks and anonymous dimension blocks (*D...) are data;
        # model/paper space containers are reported by msp/psp instead.
        if name.startswith("*Model_Space") or name.startswith("*Paper_Space"):
            continue
        out[name] = dict(Counter(e.dxftype() for e in b))
    return out


def block_texts(doc):
    """Text values per block — the ground truth for dimension text (it lives
    in the anonymous *D blocks, not in the model space TEXT census)."""
    out = {}
    for b in doc.blocks:
        if b.name.startswith("*Model_Space") or b.name.startswith("*Paper_Space"):
            continue
        vals = []
        for e in b:
            if e.dxftype() == "TEXT":
                vals.append(e.dxf.text)
            elif e.dxftype() == "MTEXT":
                vals.append(e.plain_text())
        if vals:
            out[b.name] = vals
    return out


def sample_report(layout, cap=16):
    """Geometry ground truth per type as ezdxf reads it (first `cap` each)."""
    out = {"LINE": [], "CIRCLE": [], "ARC": [], "LWPOLYLINE": [], "TEXT": [],
           "ELLIPSE": [], "SPLINE": [], "HATCH": [], "LEADER": []}

    def room(t):
        arr = out[t]
        if len(arr) >= cap:
            return None
        arr.append({})
        return arr[-1]

    for e in layout:
        t = e.dxftype()
        if t == "LINE":
            s = room("LINE")
            if s is not None:
                s.update(layer=e.dxf.layer, start=[e.dxf.start.x, e.dxf.start.y], end=[e.dxf.end.x, e.dxf.end.y])
        elif t == "CIRCLE":
            s = room("CIRCLE")
            if s is not None:
                s.update(layer=e.dxf.layer, center=[e.dxf.center.x, e.dxf.center.y], radius=e.dxf.radius)
        elif t == "ARC":
            s = room("ARC")
            if s is not None:
                s.update(layer=e.dxf.layer, center=[e.dxf.center.x, e.dxf.center.y], radius=e.dxf.radius,
                         start_angle=e.dxf.start_angle, end_angle=e.dxf.end_angle)
        elif t == "LWPOLYLINE":
            s = room("LWPOLYLINE")
            if s is not None:
                pts = [[p[0], p[1]] for p in e.get_points("xy")]
                s.update(layer=e.dxf.layer, points=pts, closed=bool(e.closed))
        elif t == "TEXT":
            s = room("TEXT")
            if s is not None:
                s.update(layer=e.dxf.layer, text=e.dxf.text, height=e.dxf.height,
                         position=[e.dxf.insert.x, e.dxf.insert.y], rotation=e.dxf.rotation)
        elif t == "ELLIPSE":
            s = room("ELLIPSE")
            if s is not None:
                s.update(layer=e.dxf.layer, center=[e.dxf.center.x, e.dxf.center.y],
                         major_axis=[e.dxf.major_axis.x, e.dxf.major_axis.y], ratio=e.dxf.ratio,
                         start_param=e.dxf.start_param, end_param=e.dxf.end_param)
        elif t == "SPLINE":
            s = room("SPLINE")
            if s is not None:
                s.update(layer=e.dxf.layer, fit_points=[[p[0], p[1]] for p in e.fit_points],
                         degree=e.dxf.degree)
        elif t == "HATCH":
            s = room("HATCH")
            if s is not None:
                s.update(layer=e.dxf.layer, pattern=e.dxf.pattern_name, solid=bool(e.dxf.solid_fill),
                         scale=e.dxf.pattern_scale, angle=e.dxf.pattern_angle,
                         loops=[[list(p[:2]) for p in path.vertices] for path in e.paths])
        elif t == "LEADER":
            s = room("LEADER")
            if s is not None:
                s.update(layer=e.dxf.layer, vertices=[[p[0], p[1]] for p in e.vertices])
    return out


def viewport_report(layout):
    vps = []
    for vp in layout.query("VIEWPORT"):
        vps.append({
            "center": [vp.dxf.center.x, vp.dxf.center.y],
            "width": vp.dxf.width,
            "height": vp.dxf.height,
            "viewCenter": [vp.dxf.view_center_point.x, vp.dxf.view_center_point.y],
            "viewHeight": vp.dxf.view_height,
        })
    return vps


def report(path):
    try:
        doc = ezdxf.readfile(path)
    except Exception as e:  # noqa: BLE001 - report any load failure as JSON
        print(json.dumps({"ok": False, "path": path, "error": str(e)}))
        return 2
    auditor = Auditor(doc)
    auditor.run()
    details = [f"{i.message}" for i in auditor.errors[:8]]
    out = {
        "ok": True,
        "path": path,
        "acadver": doc.dxfversion,
        "insunits": doc.header.get("$INSUNITS", 0),
        "ltscale": doc.header.get("$LTSCALE", 1.0),
        "layers": layer_report(doc),
        "linetypes": ltype_report(doc),
        "msp": census(doc.modelspace()),
        "psp": all_paper_census(doc),
        "texts": texts_of(doc.modelspace()),
        "blocks": block_report(doc),
        "blockTexts": block_texts(doc),
        "sample": sample_report(doc.modelspace()),
        "dimstyles": [ds.dxf.name for ds in doc.dimstyles],
        "viewports": all_paper_viewports(doc),
        "auditErrors": len(auditor.errors),
        "auditFixes": len(auditor.fixes),
        "auditDetails": details,
    }
    print(json.dumps(out))
    return 0 if not auditor.errors else 1


def main(argv):
    if len(argv) < 2:
        print("usage: validate_dxf_external.py <file.dxf> [...]", file=sys.stderr)
        return 2
    worst = 0
    for path in argv[1:]:
        rc = report(path)
        worst = max(worst, rc)
    return worst


if __name__ == "__main__":
    sys.exit(main(sys.argv))
