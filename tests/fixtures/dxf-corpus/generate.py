#!/usr/bin/env python3
"""Generate the representative DXF test corpus with ezdxf (independent implementation).

The corpus is committed to the repository; this script only needs to be re-run
when the corpus itself changes. It requires `pip install ezdxf` (the same
independent parser the validation test uses), so the fixtures are authored by
a third-party DXF implementation rather than by openBIMstudio's own writer -
import tests exercise real-world structure, not our own output.

Usage: python3 tests/fixtures/dxf-corpus/generate.py
"""
import os
import ezdxf

HERE = os.path.dirname(os.path.abspath(__file__))

MM = 1.0          # wall length in drawing units for the mm file
M = MM / 1000.0   # same wall in metres
IN = MM / 25.4    # same wall in inches

IN_TO_MM_UNITS = {"mm": 4, "m": 6, "in": 1}


def units_doc(name: str, scale: float, insunits: int):
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = insunits
    doc.layers.add("WALLS", color=1, linetype="DASHED", lineweight=35)
    doc.layers.add("ANNO", color=3)
    msp = doc.modelspace()
    s = scale
    # A 100-unit wall: two parallel lines and a closed rectangle 100 x 50.
    msp.add_line((0, 0), (100 * s, 0), dxfattribs={"layer": "WALLS"})
    msp.add_line((0, 10 * s), (100 * s, 10 * s), dxfattribs={"layer": "WALLS"})
    msp.add_lwpolyline(
        [(0, 0), (100 * s, 0), (100 * s, 10 * s), (0, 10 * s)],
        dxfattribs={"layer": "WALLS", "closed": True},
    )
    msp.add_text(f"WALL {round(100 * s, 6)}", height=5 * s, dxfattribs={"layer": "ANNO"}).set_placement((0, 20 * s))
    doc.saveas(os.path.join(HERE, name))


def entities_rich():
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    msp.add_line((0, 0), (100, 0))
    msp.add_circle((50, 50), radius=20)
    msp.add_arc((10, 10), radius=5, start_angle=0, end_angle=90)
    msp.add_lwpolyline([(0, 200), (50, 200), (50, 230), (0, 230)], dxfattribs={"closed": True})
    msp.add_ellipse((200, 50), major_axis=(15, 0, 0), ratio=0.5)
    msp.add_spline([(0, 300), (10, 310), (20, 300), (30, 315)])
    msp.add_text("Rich entity set", height=5).set_placement((0, 120))
    msp.add_mtext("Line one\\PLine two", dxfattribs={"char_height": 3}).set_location((10, 130))
    msp.add_point((5, 5))
    msp.add_ray((0, 400), (1, 0.25))
    msp.add_xline((0, 500), (0, 1))
    msp.add_solid([(400, 0), (410, 0), (400, 10), (410, 10)])
    h1 = msp.add_hatch()
    h1.set_solid_fill()
    h1.paths.add_polyline_path([(500, 0), (550, 0), (550, 30), (500, 30)], is_closed=True)
    h2 = msp.add_hatch()
    h2.set_pattern_fill("ANSI31", scale=2, angle=45)
    h2.paths.add_polyline_path([(600, 0), (650, 0), (650, 30), (600, 30)], is_closed=True)
    doc.saveas(os.path.join(HERE, "entities_rich.dxf"))


def blocks_attribs():
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4
    doc.layers.add("SYMBOLS", color=5)
    msp = doc.modelspace()
    inner = doc.blocks.new(name="INNER")
    inner.add_line((0, 0), (2, 0))
    inner.add_circle((1, 1), radius=0.5)
    outer = doc.blocks.new(name="OUTER")
    outer.add_lwpolyline([(0, 0), (4, 0), (4, 4), (0, 4)], dxfattribs={"closed": True})
    outer.add_blockref("INNER", (1, 1))
    ins = msp.add_blockref("OUTER", (100, 50), dxfattribs={"layer": "SYMBOLS"})
    ins.add_attrib("TAG1", "door 900", (100, 46)).dxf.height = 2.5
    ins.add_attrib("TAG2", "type B", (100, 44)).dxf.height = 2.5
    msp.add_blockref("OUTER", (200, 50), dxfattribs={"layer": "SYMBOLS", "rotation": 90, "xscale": 2, "yscale": 2})
    doc.saveas(os.path.join(HERE, "blocks_attribs.dxf"))


def dims_leaders():
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4
    doc.layers.add("DIM", color=5)
    msp = doc.modelspace()
    dim = msp.add_linear_dim(base=(0, 20), p1=(0, 0), p2=(100, 0), dimstyle="EZDXF",
                             dxfattribs={"layer": "DIM"})
    dim.render()
    adim = msp.add_angular_dim_2l(base=(50, 50), line1=((300, 0), (400, 0)),
                                  line2=((300, 0), (300, 40)), location=(310, 8),
                                  dimstyle="EZ_CURVED", dxfattribs={"layer": "DIM"})
    adim.render()
    msp.add_leader([(0, 60), (10, 70), (20, 70)], dxfattribs={"layer": "DIM"})
    doc.saveas(os.path.join(HERE, "dims_leaders.dxf"))


def unsupported_mline():
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    msp.add_line((0, 0), (50, 0))
    msp.add_mline([(0, 0), (20, 0), (20, 15)])
    msp.add_mline([(100, 0), (120, 0), (120, 15)])
    doc.saveas(os.path.join(HERE, "unsupported_mline.dxf"))


def paper_space():
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4
    doc.layers.add("PAPER", color=8)
    msp = doc.modelspace()
    msp.add_line((0, 0), (100, 0))
    msp.add_circle((50, 25), radius=10)
    lay = doc.new_layout("A4")
    lay.add_line((0, 0), (210, 0), dxfattribs={"layer": "PAPER"})
    lay.add_text("SHEET 01 — PLAN", height=5).set_placement((0, 25))
    lay.add_viewport(center=(105, 120), size=(180, 120), view_center_point=(50, 10), view_height=60)
    doc.saveas(os.path.join(HERE, "paper_space.dxf"))


def styles_ltypes():
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4
    doc.header["$LTSCALE"] = 2.0
    doc.layers.add("TRUECOLOR", true_color=0x0033CCFF, lineweight=50)
    doc.layers.add("DASHED", color=1, linetype="DASHED")
    doc.layers.add("CENTERED", color=3, linetype="CENTER")
    msp = doc.modelspace()
    msp.add_line((0, 0), (100, 0), dxfattribs={"layer": "DASHED"})
    msp.add_line((0, 20), (100, 20), dxfattribs={"layer": "CENTERED"})
    msp.add_line((0, 40), (100, 40), dxfattribs={"layer": "TRUECOLOR", "true_color": 0x00FF8800})
    doc.saveas(os.path.join(HERE, "styles_ltypes.dxf"))


if __name__ == "__main__":
    units_doc("units_mm.dxf", MM, IN_TO_MM_UNITS["mm"])
    units_doc("units_m.dxf", M, IN_TO_MM_UNITS["m"])
    units_doc("units_in.dxf", IN, IN_TO_MM_UNITS["in"])
    entities_rich()
    blocks_attribs()
    dims_leaders()
    unsupported_mline()
    paper_space()
    styles_ltypes()
    print("corpus written to", HERE)
