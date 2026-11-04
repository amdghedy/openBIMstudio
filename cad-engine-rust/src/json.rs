//! Hand-rolled JSON serializer for the subset of the acadrust drawing model
//! that openBIMstudio's renderer consumes. Written directly against the
//! acadrust structs instead of serde so the bridge builds inside a small
//! memory budget (serde's derive over the full document model OOMs a 4 GB
//! sandbox).

use acadrust::document::{CadDocument, HeaderVariables};
use acadrust::entities::hatch::{BoundaryEdge, BoundaryPath, Hatch, HatchPatternLine};
use acadrust::entities::polyline::{Polyline, Polyline2D};
use acadrust::entities::{
    EntityCommon, EntityType, LwPolyline,
    MText, Spline, Text,
};
use acadrust::tables::{BlockRecord, DimStyle, Layer, LineType, TextStyle};
use acadrust::types::{Color, LineWeight, Transparency};

/// Minimal JSON writer: appends directly into an owned String.
///
/// State machine: `awaiting_value` is true between a key and its value (or
/// between `[`/`{` and the first element), so separators are emitted exactly
/// once where needed.
struct W {
    out: String,
    awaiting_value: bool,
    /// Whether the container currently being written already has an element.
    has_element: bool,
    /// Parent container `has_element` flags, saved across nesting.
    stack: Vec<bool>,
}

fn num(v: f64) -> String {
    if !v.is_finite() {
        return "null".into();
    }
    if v == v.trunc() && v.abs() < 9.0e15 {
        format!("{}", v as i64)
    } else {
        format!("{}", v)
    }
}

impl W {
    fn new(cap: usize) -> Self {
        W {
            out: String::with_capacity(cap),
            awaiting_value: false,
            has_element: false,
            stack: Vec::with_capacity(16),
        }
    }

    /// Array element separator: push a comma unless this is the first element
    /// or we are directly after a key.
    fn sep(&mut self) {
        if self.awaiting_value {
            self.awaiting_value = false;
            self.has_element = true;
            return;
        }
        if self.has_element {
            self.out.push(',');
        }
        self.has_element = true;
    }

    fn key(&mut self, k: &str) {
        if !self.awaiting_value && self.has_element {
            self.out.push(',');
        }
        self.awaiting_value = true;
        self.has_element = true;
        self.out.push('"');
        self.out.push_str(k);
        self.out.push_str("\":");
    }

    fn kv_str(&mut self, k: &str, v: &str) {
        self.key(k);
        self.str_val(v);
        self.awaiting_value = false;
    }

    fn kv_num(&mut self, k: &str, v: f64) {
        self.key(k);
        self.out.push_str(&num(v));
        self.awaiting_value = false;
    }

    fn kv_int(&mut self, k: &str, v: i64) {
        self.key(k);
        self.out.push_str(&v.to_string());
        self.awaiting_value = false;
    }

    fn kv_bool(&mut self, k: &str, v: bool) {
        self.key(k);
        self.out.push_str(if v { "true" } else { "false" });
        self.awaiting_value = false;
    }

    fn kv_point(&mut self, k: &str, p: &acadrust::types::Vector3) {
        self.key(k);
        self.point(p);
        self.awaiting_value = false;
    }

    fn point(&mut self, p: &acadrust::types::Vector3) {
        self.out
            .push_str(&format!("[{},{},{}]", num(p.x), num(p.y), num(p.z)));
        self.awaiting_value = false;
    }

    fn point2(&mut self, x: f64, y: f64) {
        self.out.push_str(&format!("[{},{}]", num(x), num(y)));
        self.awaiting_value = false;
    }

    fn begin_obj(&mut self) {
        self.sep();
        self.out.push('{');
        let parent = core::mem::replace(&mut self.has_element, false);
        self.stack.push(parent);
        self.awaiting_value = false;
    }

    fn end_obj(&mut self) {
        self.out.push('}');
        self.has_element = self.stack.pop().unwrap_or(true);
        self.awaiting_value = false;
    }

    fn begin_arr(&mut self, k: &str) {
        self.key(k);
        self.out.push('[');
        let parent = core::mem::replace(&mut self.has_element, false);
        self.stack.push(parent);
        self.awaiting_value = false;
    }

    fn end_arr(&mut self) {
        self.out.push(']');
        self.has_element = self.stack.pop().unwrap_or(true);
        self.awaiting_value = false;
    }

    fn str_val(&mut self, v: &str) {
        self.out.push('"');
        for c in v.chars() {
            match c {
                '"' => self.out.push_str("\\\""),
                '\\' => self.out.push_str("\\\\"),
                '\n' => self.out.push_str("\\n"),
                '\r' => self.out.push_str("\\r"),
                '\t' => self.out.push_str("\\t"),
                c if (c as u32) < 0x20 => self.out.push_str(&format!("\\u{:04x}", c as u32)),
                c => self.out.push(c),
            }
        }
        self.out.push('"');
    }
}

fn color_json(w: &mut W, c: &Color) {
    w.begin_obj();
    match c {
        Color::ByLayer => {
            w.kv_str("t", "byLayer");
        }
        Color::ByBlock => {
            w.kv_str("t", "byBlock");
        }
        Color::None => {
            w.kv_str("t", "none");
        }
        Color::Index(i) => {
            w.kv_str("t", "index");
            w.kv_int("v", *i as i64);
        }
        Color::Rgb { r, g, b } => {
            w.kv_str("t", "rgb");
            w.kv_int("r", *r as i64);
            w.kv_int("g", *g as i64);
            w.kv_int("b", *b as i64);
        }
    }
    w.end_obj();
}

fn line_weight_json(w: &mut W, lw: &LineWeight) {
    match lw {
        LineWeight::ByLayer => w.kv_str("lineWeight", "byLayer"),
        LineWeight::ByBlock => w.kv_str("lineWeight", "byBlock"),
        LineWeight::Default => w.kv_str("lineWeight", "default"),
        LineWeight::Value(v) => w.kv_int("lineWeight", *v as i64),
    };
}

fn transparency_json(w: &mut W, t: &Transparency) {
    match t {
        Transparency::ByLayer => {}
        Transparency::ByBlock => {
            w.kv_str("transparency", "byBlock");
        }
        Transparency::Explicit(v) => {
            if *v > 0 {
                w.kv_int("transparency", *v as i64);
            }
        }
    }
}

fn write_common(w: &mut W, c: &EntityCommon) {
    w.kv_str("handle", &format!("{:x}", c.handle.value()));
    w.kv_str("layer", &c.layer);
    w.key("color");
    color_json(w, &c.color);
    line_weight_json(w, &c.line_weight);
    if c.has_linetype() {
        w.kv_str("lineType", &c.linetype);
    }
    if (c.linetype_scale - 1.0).abs() > f64::EPSILON {
        w.kv_num("ltScale", c.linetype_scale);
    }
    transparency_json(w, &c.transparency);
    if c.invisible {
        w.kv_bool("invisible", true);
    }
    if let Some(mode) = c.entity_mode {
        if mode == 1 {
            w.kv_bool("paperSpace", true);
        }
    }
}

fn vertex2_list(w: &mut W, pts: &[acadrust::types::Vector2]) {
    for p in pts {
        w.sep();
        w.point2(p.x, p.y);
    }
}

/// DXF alignment codes: 72 → 0 left / 1 center / 2 right / 3 aligned /
/// 4 middle / 5 fit; 73 → 0 baseline / 1 bottom / 2 middle / 3 top.
#[allow(unreachable_patterns)]
fn halign_code(v: &acadrust::entities::text::TextHorizontalAlignment) -> i64 {
    use acadrust::entities::text::TextHorizontalAlignment as H;
    match v {
        H::Left => 0,
        H::Center => 1,
        H::Right => 2,
        H::Aligned => 3,
        H::Middle => 4,
        H::Fit => 5,
        _ => 0,
    }
}

#[allow(unreachable_patterns)]
fn valign_code(v: &acadrust::entities::text::TextVerticalAlignment) -> i64 {
    use acadrust::entities::text::TextVerticalAlignment as V;
    match v {
        V::Baseline => 0,
        V::Bottom => 1,
        V::Middle => 2,
        V::Top => 3,
        _ => 0,
    }
}

// ---------------------------------------------------------------- entities

fn write_entity(w: &mut W, e: &EntityType) {
    match e {
        EntityType::Point(x) => {
            w.begin_obj();
            w.kv_str("type", "POINT");
            write_common(w, &x.common);
            w.kv_point("position", &x.location);
            w.end_obj();
        }
        EntityType::Line(x) => {
            w.begin_obj();
            w.kv_str("type", "LINE");
            write_common(w, &x.common);
            w.kv_point("start", &x.start);
            w.kv_point("end", &x.end);
            w.end_obj();
        }
        EntityType::Circle(x) => {
            w.begin_obj();
            w.kv_str("type", "CIRCLE");
            write_common(w, &x.common);
            w.kv_point("center", &x.center);
            w.kv_num("radius", x.radius);
            w.end_obj();
        }
        EntityType::Arc(x) => {
            w.begin_obj();
            w.kv_str("type", "ARC");
            write_common(w, &x.common);
            w.kv_point("center", &x.center);
            w.kv_num("radius", x.radius);
            w.kv_num("startAngle", x.start_angle);
            w.kv_num("endAngle", x.end_angle);
            w.end_obj();
        }
        EntityType::Ellipse(x) => {
            w.begin_obj();
            w.kv_str("type", "ELLIPSE");
            write_common(w, &x.common);
            w.kv_point("center", &x.center);
            w.kv_point("majorAxis", &x.major_axis);
            w.kv_num("axisRatio", x.minor_axis_ratio);
            w.kv_num("startParam", x.start_parameter);
            w.kv_num("endParam", x.end_parameter);
            w.end_obj();
        }
        EntityType::LwPolyline(x) => write_lwpolyline(w, x),
        EntityType::Polyline2D(x) => write_polyline2d(w, x),
        EntityType::Polyline3D(x) => {
            w.begin_obj();
            w.kv_str("type", "POLYLINE3D");
            write_common(w, &x.common);
            w.begin_arr("vertices");
            for v in &x.vertices {
                w.sep();
                w.point(&v.position);
            }
            w.end_arr();
            w.end_obj();
        }
        EntityType::Polyline(x) => write_legacy_polyline(w, x),
        EntityType::Spline(x) => write_spline(w, x),
        EntityType::Text(x) => write_text(w, x),
        EntityType::MText(x) => write_mtext(w, x),
        EntityType::Dimension(x) => write_dimension(w, x),
        EntityType::Hatch(x) => write_hatch(w, x),
        EntityType::Solid(x) => {
            w.begin_obj();
            w.kv_str("type", if x.is_trace { "TRACE" } else { "SOLID" });
            write_common(w, &x.common);
            w.kv_point("c1", &x.first_corner);
            w.kv_point("c2", &x.second_corner);
            w.kv_point("c3", &x.third_corner);
            w.kv_point("c4", &x.fourth_corner);
            w.end_obj();
        }
        EntityType::Face3D(x) => {
            w.begin_obj();
            w.kv_str("type", "3DFACE");
            write_common(w, &x.common);
            w.kv_point("c1", &x.first_corner);
            w.kv_point("c2", &x.second_corner);
            w.kv_point("c3", &x.third_corner);
            w.kv_point("c4", &x.fourth_corner);
            w.end_obj();
        }
        EntityType::Insert(x) => write_insert(w, x),
        EntityType::Block(x) => {
            w.begin_obj();
            w.kv_str("type", "BLOCK");
            write_common(w, &x.common);
            w.kv_str("name", &x.name);
            w.kv_point("basePoint", &x.base_point);
            w.end_obj();
        }
        EntityType::BlockEnd(_) => {
            w.begin_obj();
            w.kv_str("type", "ENDBLK");
            w.end_obj();
        }
        EntityType::Ray(x) => {
            w.begin_obj();
            w.kv_str("type", "RAY");
            write_common(w, &x.common);
            w.kv_point("start", &x.base_point);
            w.kv_point("direction", &x.direction);
            w.end_obj();
        }
        EntityType::XLine(x) => {
            w.begin_obj();
            w.kv_str("type", "XLINE");
            write_common(w, &x.common);
            w.kv_point("start", &x.base_point);
            w.kv_point("direction", &x.direction);
            w.end_obj();
        }
        EntityType::Viewport(x) => {
            w.begin_obj();
            w.kv_str("type", "VIEWPORT");
            write_common(w, &x.common);
            w.kv_int("id", x.id as i64);
            w.kv_point("center", &x.center);
            w.kv_num("width", x.width);
            w.kv_num("height", x.height);
            w.kv_point("viewCenter", &x.view_center);
            w.kv_num("viewHeight", x.view_height);
            w.kv_num("twist", x.twist_angle);
            w.end_obj();
        }
        EntityType::AttributeDefinition(x) => {
            w.begin_obj();
            w.kv_str("type", "ATTDEF");
            write_common(w, &x.common);
            w.kv_str("tag", &x.tag);
            w.kv_str("prompt", &x.prompt);
            w.kv_str("value", &x.default_value);
            w.kv_point("position", &x.insertion_point);
            w.kv_num("height", x.height);
            w.kv_num("rotation", x.rotation);
            w.kv_bool("invisible", x.text_generation_flags & 1 != 0);
            w.end_obj();
        }
        EntityType::AttributeEntity(x) => {
            w.begin_obj();
            w.kv_str("type", "ATTRIB");
            write_common(w, &x.common);
            w.kv_str("tag", &x.tag);
            w.kv_str("value", &x.value);
            w.kv_point("position", &x.insertion_point);
            w.kv_num("height", x.height);
            w.kv_num("rotation", x.rotation);
            w.end_obj();
        }
        EntityType::Leader(x) => {
            w.begin_obj();
            w.kv_str("type", "LEADER");
            write_common(w, &x.common);
            w.kv_str("dimStyle", &x.dimension_style);
            w.kv_bool("arrowEnabled", x.arrow_enabled);
            w.kv_num("textHeight", x.text_height);
            w.begin_arr("vertices");
            for v in &x.vertices {
                w.sep();
                w.point(v);
            }
            w.end_arr();
            w.end_obj();
        }
        EntityType::MLine(x) => {
            w.begin_obj();
            w.kv_str("type", "MLINE");
            write_common(w, &x.common);
            w.kv_str("style", &x.style_name);
            w.kv_point("position", &x.start_point);
            w.kv_num("scale", x.scale_factor);
            w.kv_int("justification", x.justification as i64);
            w.end_obj();
        }
        EntityType::Mesh(x) => {
            w.begin_obj();
            w.kv_str("type", "MESH");
            write_common(w, &x.common);
            w.begin_arr("vertices");
            for v in &x.vertices {
                w.sep();
                w.point(v);
            }
            w.end_arr();
            w.end_obj();
        }
        EntityType::RasterImage(x) => {
            w.begin_obj();
            w.kv_str("type", "IMAGE");
            write_common(w, &x.common);
            w.kv_point("position", &x.insertion_point);
            w.kv_num("width", x.width());
            w.kv_num("height", x.height());
            w.end_obj();
        }
        EntityType::Shape(x) => {
            w.begin_obj();
            w.kv_str("type", "SHAPE");
            write_common(w, &x.common);
            w.kv_str("name", &x.shape_name);
            w.kv_int("shapeNumber", x.shape_number as i64);
            w.kv_point("position", &x.insertion_point);
            w.kv_num("size", x.size);
            w.kv_num("rotation", x.rotation);
            if !x.style_name.is_empty() {
                w.kv_str("style", &x.style_name);
            }
            w.end_obj();
        }
        EntityType::Tolerance(x) => {
            w.begin_obj();
            w.kv_str("type", "TOLERANCE");
            write_common(w, &x.common);
            w.kv_point("position", &x.insertion_point);
            w.kv_str("text", &x.text);
            w.end_obj();
        }
        EntityType::Helix(x) => {
            w.begin_obj();
            w.kv_str("type", "HELIX");
            write_common(w, &x.common);
            w.kv_point("start", &x.start_point);
            w.kv_point("axis", &x.axis_vector);
            w.end_obj();
        }
        EntityType::Wipeout(x) => {
            w.begin_obj();
            w.kv_str("type", "WIPEOUT");
            write_common(w, &x.common);
            w.end_obj();
        }
        EntityType::Unknown(x) => {
            w.begin_obj();
            w.kv_str("type", "UNKNOWN");
            write_common(w, &x.common);
            w.end_obj();
        }
        other => {
            // Fallback for variants without dedicated geometry yet (3D solids,
            // regions, bodies, surfaces, tables, lights, proxy entities…):
            // still emit the common block so the entity is counted and shown
            // in the database status report.
            w.begin_obj();
            w.kv_str("type", "UNSUPPORTED");
            write_common(w, other.common());
            w.end_obj();
        }
    }
}

fn write_lwpolyline(w: &mut W, x: &LwPolyline) {
    w.begin_obj();
    w.kv_str("type", "LWPOLYLINE");
    write_common(w, &x.common);
    w.kv_bool("closed", x.is_closed);
    if x.constant_width != 0.0 {
        w.kv_num("constWidth", x.constant_width);
    }
    if x.elevation != 0.0 {
        w.kv_num("elevation", x.elevation);
    }
    w.begin_arr("vertices");
    for v in &x.vertices {
        w.sep();
        // [x, y, bulge] — bulge 0 = straight segment
        w.out
            .push_str(&format!("[{},{},{}]", num(v.location.x), num(v.location.y), num(v.bulge)));
    }
    w.end_arr();
    w.end_obj();
}

fn write_polyline2d(w: &mut W, x: &Polyline2D) {
    w.begin_obj();
    w.kv_str("type", "POLYLINE2D");
    write_common(w, &x.common);
    w.kv_bool("closed", x.flags.is_closed());
    w.begin_arr("vertices");
    for v in &x.vertices {
        w.sep();
        w.out.push_str(&format!(
            "[{},{},{}]",
            num(v.location.x),
            num(v.location.y),
            num(v.bulge)
        ));
    }
    w.end_arr();
    w.end_obj();
}

fn write_legacy_polyline(w: &mut W, x: &Polyline) {
    w.begin_obj();
    w.kv_str("type", "POLYLINE");
    write_common(w, &x.common);
    w.kv_bool("closed", x.flags.is_closed());
    w.begin_arr("vertices");
    for v in &x.vertices {
        w.sep();
        w.point(&v.location);
    }
    w.end_arr();
    w.end_obj();
}

fn write_spline(w: &mut W, x: &Spline) {
    w.begin_obj();
    w.kv_str("type", "SPLINE");
    write_common(w, &x.common);
    w.kv_int("degree", x.degree as i64);
    w.kv_bool("closed", x.flags.closed);
    if !x.knots.is_empty() {
        w.begin_arr("knots");
        for k in &x.knots {
            w.sep();
            w.out.push_str(&num(*k));
        }
        w.end_arr();
    }
    if !x.control_points.is_empty() {
        w.begin_arr("controlPoints");
        for p in &x.control_points {
            w.sep();
            w.point(p);
        }
        w.end_arr();
    }
    if !x.weights.is_empty() {
        w.begin_arr("weights");
        for k in &x.weights {
            w.sep();
            w.out.push_str(&num(*k));
        }
        w.end_arr();
    }
    if !x.fit_points.is_empty() {
        w.begin_arr("fitPoints");
        for p in &x.fit_points {
            w.sep();
            w.point(p);
        }
        w.end_arr();
    }
    w.end_obj();
}

fn write_text(w: &mut W, x: &Text) {
    w.begin_obj();
    w.kv_str("type", "TEXT");
    write_common(w, &x.common);
    w.kv_str("value", &x.value);
    w.kv_point("position", &x.insertion_point);
    if let Some(a) = &x.alignment_point {
        w.kv_point("alignPoint", a);
    }
    w.kv_num("height", x.height);
    w.kv_num("rotation", x.rotation);
    if x.width_factor != 0.0 && (x.width_factor - 1.0).abs() > f64::EPSILON {
        w.kv_num("widthFactor", x.width_factor);
    }
    if x.oblique_angle != 0.0 {
        w.kv_num("oblique", x.oblique_angle);
    }
    if !x.style.is_empty() && x.style != "Standard" {
        w.kv_str("style", &x.style);
    }
    let ha = halign_code(&x.horizontal_alignment);
    let va = valign_code(&x.vertical_alignment);
    if ha != 0 || va != 0 {
        w.kv_int("halign", ha);
        w.kv_int("valign", va);
    }
    if x.generation_flags & 0x6 != 0 {
        w.kv_int("genFlags", x.generation_flags as i64);
    }
    w.end_obj();
}

fn write_mtext(w: &mut W, x: &MText) {
    w.begin_obj();
    w.kv_str("type", "MTEXT");
    write_common(w, &x.common);
    w.kv_str("value", &x.value);
    w.kv_point("position", &x.insertion_point);
    w.kv_num("height", x.height);
    if x.rectangle_width != 0.0 {
        w.kv_num("rectWidth", x.rectangle_width);
    }
    if let Some(h) = x.rectangle_height {
        if h != 0.0 {
            w.kv_num("rectHeight", h);
        }
    }
    w.kv_num("rotation", x.rotation);
    if !x.style.is_empty() && x.style != "Standard" {
        w.kv_str("style", &x.style);
    }
    let att = x.attachment_point as i64;
    if att != 0 {
        w.kv_int("attachment", att);
    }
    if x.line_spacing_factor != 0.0 {
        w.kv_num("lineSpacing", x.line_spacing_factor);
    }
    w.end_obj();
}

fn write_insert(w: &mut W, x: &acadrust::entities::Insert) {
    w.begin_obj();
    w.kv_str("type", "INSERT");
    write_common(w, &x.common);
    w.kv_str("block", &x.block_name);
    w.kv_point("position", &x.insert_point);
    w.kv_num("xScale", x.x_scale());
    w.kv_num("yScale", x.y_scale());
    w.kv_num("zScale", x.z_scale());
    w.kv_num("rotation", x.rotation);
    if x.column_count > 1 || x.row_count > 1 {
        w.kv_int("colCount", x.column_count as i64);
        w.kv_int("rowCount", x.row_count as i64);
        w.kv_num("colSpacing", x.column_spacing);
        w.kv_num("rowSpacing", x.row_spacing);
    }
    if !x.attributes.is_empty() {
        w.begin_arr("attributes");
        for a in &x.attributes {
            w.begin_obj();
            w.kv_str("tag", &a.tag);
            w.kv_str("value", &a.value);
            w.kv_point("position", &a.insertion_point);
            w.kv_num("height", a.height);
            w.kv_num("rotation", a.rotation);
            w.end_obj();
        }
        w.end_arr();
    }
    w.end_obj();
}

// --------------------------------------------------------------- dimension

#[allow(unreachable_patterns)]
fn dim_type_name(t: acadrust::entities::DimensionType) -> &'static str {
    use acadrust::entities::DimensionType as T;
    match t {
        T::Linear => "linear",
        T::Aligned => "aligned",
        T::Angular => "angular2",
        T::Diameter => "diameter",
        T::Radius => "radius",
        T::Angular3Point => "angular3",
        T::Ordinate => "ordinate",
        T::ArcLength => "arc",
        T::LargeRadial => "largeRadial",
        _ => "linear",
    }
}

fn write_dim_base(w: &mut W, base: &acadrust::entities::dimension::DimensionBase) {
    write_common(w, &base.common);
    w.kv_str("dimType", dim_type_name(base.dimension_type));
    let text = base.user_text.clone().unwrap_or_else(|| base.text.clone());
    if !text.is_empty() {
        w.kv_str("userText", &text);
    }
    if !base.style_name.is_empty() {
        w.kv_str("style", &base.style_name);
    }
    if !base.block_name.is_empty() {
        w.kv_str("block", &base.block_name);
    }
    w.kv_num("measurement", base.actual_measurement);
    w.kv_point("textMiddle", &base.text_middle_point);
    w.kv_num("textRotation", base.text_rotation);
    w.kv_int("attachment", base.attachment_point as i64);
}

#[allow(unreachable_patterns)]
fn write_dimension(w: &mut W, d: &acadrust::entities::Dimension) {
    use acadrust::entities::Dimension as D;
    w.begin_obj();
    w.kv_str("type", "DIMENSION");
    match d {
        D::Aligned(x) => {
            write_dim_base(w, &x.base);
            w.kv_point("firstPoint", &x.first_point);
            w.kv_point("secondPoint", &x.second_point);
            w.kv_point("defPoint", &x.definition_point);
        }
        D::Linear(x) => {
            write_dim_base(w, &x.base);
            w.kv_point("firstPoint", &x.first_point);
            w.kv_point("secondPoint", &x.second_point);
            w.kv_point("defPoint", &x.definition_point);
            w.kv_num("rotation", x.rotation);
            w.kv_num("extLineRotation", x.ext_line_rotation);
        }
        D::Radius(x) => {
            write_dim_base(w, &x.base);
            w.kv_point("defPoint", &x.definition_point);
            w.kv_point("center", &x.angle_vertex);
            w.kv_num("leaderLength", x.leader_length);
        }
        D::Diameter(x) => {
            write_dim_base(w, &x.base);
            w.kv_point("defPoint", &x.definition_point);
            w.kv_point("center", &x.angle_vertex);
            w.kv_num("leaderLength", x.leader_length);
        }
        D::Angular2Ln(x) => {
            write_dim_base(w, &x.base);
            w.kv_point("dimensionArc", &x.dimension_arc);
            w.kv_point("firstLineStart", &x.first_point);
            w.kv_point("firstLineEnd", &x.second_point);
            w.kv_point("secondLineStart", &x.angle_vertex);
            w.kv_point("defPoint", &x.definition_point);
        }
        D::Angular3Pt(x) => {
            write_dim_base(w, &x.base);
            w.kv_point("arcLocation", &x.definition_point);
            w.kv_point("firstPoint", &x.first_point);
            w.kv_point("secondPoint", &x.second_point);
            w.kv_point("angleVertex", &x.angle_vertex);
        }
        D::Ordinate(x) => {
            write_dim_base(w, &x.base);
            w.kv_point("featureLocation", &x.feature_location);
            w.kv_point("leaderEndpoint", &x.leader_endpoint);
            w.kv_bool("ordinateX", x.is_ordinate_type_x);
        }
        D::Arc(x) => {
            write_dim_base(w, &x.base);
            w.kv_point("center", &x.center_point);
            w.kv_point("firstExtensionPoint", &x.first_extension_point);
            w.kv_point("secondExtensionPoint", &x.second_extension_point);
            w.kv_point("defPoint", &x.definition_point);
            w.kv_bool("isPartial", x.is_partial);
            if x.is_partial {
                w.kv_num("arcStart", x.arc_start_parameter);
                w.kv_num("arcEnd", x.arc_end_parameter);
            }
            if x.has_leader {
                w.kv_bool("hasLeader", true);
                w.kv_point("leaderPoint", &x.first_leader_point);
            }
        }
        D::LargeRadial(x) => {
            write_dim_base(w, &x.base);
            w.kv_point("defPoint", &x.definition_point);
            w.kv_point("chordPoint", &x.chord_point);
            w.kv_point("overrideCenter", &x.override_center);
            w.kv_point("jogPoint", &x.jog_point);
            w.kv_num("jogAngle", x.jog_angle);
        }
        _ => {}
    }
    w.end_obj();
}

// ------------------------------------------------------------------- hatch

fn write_hatch(w: &mut W, x: &Hatch) {
    w.begin_obj();
    w.kv_str("type", "HATCH");
    write_common(w, &x.common);
    w.kv_bool("isSolid", x.is_solid);
    w.kv_str("patternName", &x.pattern.name);
    w.kv_int("patternType", x.pattern_type as i64);
    w.kv_num("patternAngle", x.pattern_angle);
    w.kv_num("patternScale", x.pattern_scale);
    w.kv_bool("isDouble", x.is_double);
    w.kv_int("style", x.style as i64);
    w.kv_num("elevation", x.elevation);
    w.begin_arr("paths");
    for p in &x.paths {
        write_boundary_path(w, p);
    }
    w.end_arr();
    if !x.pattern.lines.is_empty() {
        w.begin_arr("patternLines");
        for l in &x.pattern.lines {
            write_pattern_line(w, l);
        }
        w.end_arr();
    }
    w.end_obj();
}

fn write_boundary_path(w: &mut W, p: &BoundaryPath) {
    w.begin_obj();
    w.kv_int("flags", p.flags.bits() as i64);
    w.begin_arr("edges");
    for e in &p.edges {
        w.begin_obj();
        #[allow(unreachable_patterns)]
        match e {
            BoundaryEdge::Line(x) => {
                w.kv_str("e", "line");
                w.key("s");
                w.point2(x.start.x, x.start.y);
                w.key("v");
                w.point2(x.end.x, x.end.y);
            }
            BoundaryEdge::CircularArc(x) => {
                w.kv_str("e", "arc");
                w.key("c");
                w.point2(x.center.x, x.center.y);
                w.kv_num("r", x.radius);
                w.kv_num("sa", x.start_angle);
                w.kv_num("ea", x.end_angle);
                w.kv_bool("ccw", x.counter_clockwise);
            }
            BoundaryEdge::EllipticArc(x) => {
                w.kv_str("e", "ellipse");
                w.key("c");
                w.point2(x.center.x, x.center.y);
                w.key("maj");
                w.point2(x.major_axis_endpoint.x, x.major_axis_endpoint.y);
                w.kv_num("ratio", x.minor_axis_ratio);
                w.kv_num("sa", x.start_angle);
                w.kv_num("ea", x.end_angle);
                w.kv_bool("ccw", x.counter_clockwise);
            }
            BoundaryEdge::Spline(x) => {
                w.kv_str("e", "spline");
                w.kv_int("degree", x.degree as i64);
                w.kv_bool("rational", x.rational);
                w.kv_bool("periodic", x.periodic);
                if !x.knots.is_empty() {
                    w.begin_arr("knots");
                    for k in &x.knots {
                        w.sep();
                        w.out.push_str(&num(*k));
                    }
                    w.end_arr();
                }
                if !x.control_points.is_empty() {
                    w.begin_arr("ctrl");
                    for p in &x.control_points {
                        w.sep();
                        w.point2(p.x, p.y);
                    }
                    w.end_arr();
                }
                if !x.fit_points.is_empty() {
                    w.begin_arr("fit");
                    vertex2_list(w, &x.fit_points);
                    w.end_arr();
                }
            }
            BoundaryEdge::Polyline(x) => {
                w.kv_str("e", "poly");
                w.kv_bool("closed", x.is_closed);
                w.begin_arr("pts");
                for p in &x.vertices {
                    w.sep();
                    w.point2(p.x, p.y);
                }
                w.end_arr();
                if x.vertices.iter().any(|v| v.z != 0.0) {
                    w.begin_arr("bulges");
                    for p in &x.vertices {
                        w.sep();
                        w.out.push_str(&num(p.z));
                    }
                    w.end_arr();
                }
            }
            _ => {
                w.kv_str("e", "unknown");
            }
        }
        w.end_obj();
    }
    w.end_arr();
    w.end_obj();
}

fn write_pattern_line(w: &mut W, l: &HatchPatternLine) {
    w.begin_obj();
    w.kv_num("angle", l.angle);
    w.key("base");
    w.point2(l.base_point.x, l.base_point.y);
    w.key("offset");
    w.point2(l.offset.x, l.offset.y);
    w.begin_arr("dashes");
    for d in &l.dash_lengths {
        w.sep();
        w.out.push_str(&num(*d));
    }
    w.end_arr();
    w.end_obj();
}

// ------------------------------------------------------------------ tables

fn write_layer(w: &mut W, l: &Layer) {
    w.begin_obj();
    w.kv_str("name", &l.name);
    w.key("color");
    color_json(w, &l.color);
    if !l.line_type.is_empty() && l.line_type != "ByLayer" {
        w.kv_str("lineType", &l.line_type);
    }
    line_weight_json(w, &l.line_weight);
    w.kv_bool("isPlottable", l.is_plottable);
    if l.flags.frozen {
        w.kv_bool("frozen", true);
    }
    if l.flags.off {
        w.kv_bool("off", true);
    }
    if l.flags.locked {
        w.kv_bool("locked", true);
    }
    transparency_json(w, &l.transparency);
    w.end_obj();
}

fn write_linetype(w: &mut W, lt: &LineType) {
    w.begin_obj();
    w.kv_str("name", &lt.name);
    if !lt.description.is_empty() {
        w.kv_str("description", &lt.description);
    }
    w.kv_num("patternLength", lt.pattern_length);
    w.begin_arr("elements");
    for el in &lt.elements {
        w.begin_obj();
        w.kv_num("length", el.length);
        w.end_obj();
    }
    w.end_arr();
    w.end_obj();
}

fn write_text_style(w: &mut W, s: &TextStyle) {
    w.begin_obj();
    w.kv_str("name", &s.name);
    w.kv_num("height", s.height);
    w.kv_num("widthFactor", s.width_factor);
    w.kv_num("oblique", s.oblique_angle);
    if !s.font_file.is_empty() {
        w.kv_str("fontFile", &s.font_file);
    }
    if !s.big_font_file.is_empty() {
        w.kv_str("bigFontFile", &s.big_font_file);
    }
    if !s.true_type_font.is_empty() {
        w.kv_str("trueTypeFont", &s.true_type_font);
    }
    if s.flags.backward {
        w.kv_bool("backwards", true);
    }
    if s.flags.upside_down {
        w.kv_bool("upsideDown", true);
    }
    w.end_obj();
}

fn write_dim_style(w: &mut W, s: &DimStyle) {
    w.begin_obj();
    w.kv_str("name", &s.name);
    w.kv_int("dimclrd", s.dimclrd as i64);
    w.kv_int("dimclre", s.dimclre as i64);
    w.kv_num("dimgap", s.dimgap);
    w.kv_num("dimexo", s.dimexo);
    w.kv_num("dimexe", s.dimexe);
    w.kv_num("dimasz", s.dimasz);
    w.kv_num("dimtsz", s.dimtsz);
    w.kv_num("dimtxt", s.dimtxt);
    w.kv_int("dimjust", s.dimjust as i64);
    w.kv_int("dimtad", s.dimtad as i64);
    w.kv_bool("dimtih", s.dimtih);
    w.kv_bool("dimtoh", s.dimtoh);
    w.kv_num("dimscale", s.dimscale);
    w.kv_num("dimlfac", s.dimlfac);
    w.kv_int("dimdec", s.dimdec as i64);
    if !s.dimtxsty.is_empty() {
        w.kv_str("dimtxsty", &s.dimtxsty);
    }
    w.kv_bool("dimtofl", s.dimtofl);
    w.kv_int("dimatfit", s.dimatfit as i64);
    if !s.dimpost.is_empty() {
        w.kv_str("dimpost", &s.dimpost);
    }
    if !s.dimapost.is_empty() {
        w.kv_str("dimapost", &s.dimapost);
    }
    w.end_obj();
}

fn write_block_record(w: &mut W, b: &BlockRecord) {
    w.begin_obj();
    w.kv_str("name", &b.name);
    w.kv_str("blockHandle", &format!("{:x}", b.block_entity_handle.value()));
    w.begin_arr("entityHandles");
    for h in &b.entity_handles {
        w.sep();
        w.out.push_str(&format!("\"{:x}\"", h.value()));
    }
    w.end_arr();
    w.end_obj();
}

// ------------------------------------------------------------------ header

fn write_header(w: &mut W, h: &HeaderVariables) {
    w.begin_obj();
    w.kv_num("ltscale", h.linetype_scale);
    w.kv_num("dimscale", h.dim_scale);
    w.kv_int("insunits", h.insertion_units as i64);
    w.kv_point("extmin", &h.model_space_extents_min);
    w.kv_point("extmax", &h.model_space_extents_max);
    w.kv_point("psExtmin", &h.paper_space_extents_min);
    w.kv_point("psExtmax", &h.paper_space_extents_max);
    w.end_obj();
}

// ---------------------------------------------------------------- document

/// Serialize a whole document. Returns the JSON body for `"document": …`.
pub fn document_json(doc: &CadDocument) -> String {
    let mut w = W::new(1 << 20);
    w.begin_obj();
    w.kv_str("version", doc.version.as_str());

    w.key("header");
    write_header(&mut w, &doc.header);

    w.begin_arr("layers");
    for l in doc.layers.iter() {
        write_layer(&mut w, l);
    }
    w.end_arr();

    w.begin_arr("linetypes");
    for lt in doc.line_types.iter() {
        write_linetype(&mut w, lt);
    }
    w.end_arr();

    w.begin_arr("textStyles");
    for s in doc.text_styles.iter() {
        write_text_style(&mut w, s);
    }
    w.end_arr();

    w.begin_arr("dimStyles");
    for s in doc.dim_styles.iter() {
        write_dim_style(&mut w, s);
    }
    w.end_arr();

    w.begin_arr("blockRecords");
    for b in doc.block_records.iter() {
        write_block_record(&mut w, b);
    }
    w.end_arr();

    w.begin_arr("entities");
    for e in doc.entities() {
        write_entity(&mut w, e);
    }
    w.end_arr();
    w.end_obj();
    w.out
}

/// Serialize the read statistics footer.
pub fn stats_json(stats: &acadrust::io::read::ReadStats) -> String {
    let mut w = W::new(512);
    w.begin_obj();
    w.kv_str("sourceVersion", &stats.source_version);
    w.kv_bool("recoveryMode", stats.recovery_mode);
    w.kv_bool("streamCompleted", stats.stream_completed);
    w.kv_int("sourceSections", stats.source_sections as i64);
    w.kv_int("sourceRecords", stats.source_records as i64);
    w.kv_int("decodedRecords", stats.decoded_source_records as i64);
    w.kv_int("skippedRecords", stats.skipped_source_records as i64);
    w.kv_int("entities", stats.output_entities as i64);
    w.kv_int("objects", stats.output_objects as i64);
    w.kv_int("tableRecords", stats.output_table_records as i64);
    w.kv_int("recoveredErrors", stats.recovered_errors as i64);
    w.end_obj();
    w.out
}
