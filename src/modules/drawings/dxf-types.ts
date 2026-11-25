/** Shared types for the Drawings / DXF / DWG engine. */

export interface DxfPoint {
  x: number;
  y: number;
  z?: number;
}

export interface DxfLayer {
  name: string;
  color: number; // ACI color index 1-255
  /** 24-bit true colour (0xRRGGBB) from DXF group 420 — wins over ACI when present. */
  rgb?: number;
  lineType?: string;
  frozen?: boolean;
  locked?: boolean;
  /** Layer switched off (negative colour in DXF, "off" flag in DWG). */
  off?: boolean;
  /** Default lineweight in mm (DXF group 370 / 100); undefined = default. */
  lineweight?: number;
  /** Layer transparency in percent 0-90 (DXF group 440); 0/undefined = opaque. */
  transparency?: number;
  /** DXF group 290: does this layer plot? undefined = plots. */
  plot?: boolean;
}

import type { NativeCurve } from "./native-curves";

/** Fields every entity carries. */
interface DxfEntityBase {
  layer: string;
  /** ACI colour; undefined = BYLAYER. */
  color?: number;
  /** 24-bit true colour (0xRRGGBB) when the entity has one. */
  rgb?: number;
  /** Linetype name; undefined = BYLAYER. */
  lineType?: string;
  /** Lineweight in mm; undefined = BYLAYER. */
  lineweight?: number;
  /** Per-entity linetype scale (DXF group 48); undefined = 1. */
  ltScale?: number;
  /** Entity transparency in percent 0-90 (DXF group 440); 0/undefined = opaque. */
  transparency?: number;
  /**
   * DXF group 60 Invisible flag — the object-level hidden state produced by
   * HIDEOBJECTS / ISOLATEOBJECTS. Hidden entities are skipped by rendering,
   * picking and snapping; ENDISOLATE restores them. Persisted through QSAVE
   * so hidden state survives the save/open round trip.
   */
  invisible?: boolean;
  /**
   * In-memory grouping metadata — never written to DXF/DWG output. Dimensions
   * tag their constituent LINE/TEXT entities with a shared dimId + role so the
   * dimension can be restyled (DIMSTYLE) and re-measured associatively.
   */
  meta?: { dimId?: string; role?: "ext" | "dimline" | "arrow" | "text"; hyperlink?: string };
}

/** Hatch data carried on a closed polyline (`points` is the outer loop). */
export interface DxfHatch {
  solid: boolean;
  pattern?: string;
  /** Pattern angle in degrees. */
  angle?: number;
  /** Pattern scale (DXF group 41). */
  scale?: number;
  /** All boundary loops, outer first (even-odd fill). */
  loops: DxfPoint[][];
  /** Gradient fill (solid hatch with a colour ramp). Angle in radians; stop colours as 0xRRGGBB. */
  gradient?: { name: string; angle: number; shift: number; single: boolean; tint: number; stops: Array<{ pos: number; rgb: number }> };
  /**
   * Real pattern definition read from the file (acadrust engine): one entry
   * per pattern line family. Angles are radians in pattern space; `offset`
   * is the perpendicular spacing vector between lines; `dashes` alternate
   * dash/gap lengths along the line (positive dash, negative gap). When
   * present the renderer draws the actual ANSI/ISO pattern instead of a
   * generic fallback.
   */
  patternLines?: Array<{
    angle: number;
    base: [number, number];
    offset: [number, number];
    dashes: number[];
  }>;
  /**
   * Pattern-space marker for `patternLines`. True (authored hatches and DXF
   * HATCH imports): the families still carry the hatch's own angle/scale and
   * the renderer applies them before drawing. Absent (DWG imports via the
   * acadrust engine): the families are already in drawing space and the
   * renderer draws them as-is, while the DXF writer emits angle 0 / scale 1
   * so native CAD does not apply them twice.
   */
  patternSpace?: boolean;
  /** WIPEOUT: solid fill with the drawing background (masks what is behind it). */
  wipeout?: boolean;
}

export type DxfEntity =
  | (DxfEntityBase & {
      type: "LINE";
      start: DxfPoint;
      end: DxfPoint;
    })
  | (DxfEntityBase & {
      type: "RAY";
      /** Point the ray starts at. */
      start: DxfPoint;
      /** Direction of the infinite extension. */
      direction: DxfPoint;
    })
  | (DxfEntityBase & {
      type: "XLINE";
      /** A point on the infinite construction line. */
      start: DxfPoint;
      /** Direction of the line (both ways). */
      direction: DxfPoint;
    })
  | (DxfEntityBase & {
      type: "CIRCLE";
      center: DxfPoint;
      radius: number;
    })
  | (DxfEntityBase & {
      type: "ARC";
      center: DxfPoint;
      radius: number;
      startAngle: number; // degrees, counter-clockwise
      endAngle: number;
    })
  | (DxfEntityBase & {
      type: "LWPOLYLINE";
      points: DxfPoint[];
      closed?: boolean;
      /** Present when this polyline is the boundary of a hatch / solid fill. */
      hatch?: DxfHatch;
      /**
       * True SPLINE / ELLIPSE definition behind this tessellated polyline (see native-curves.ts).
       * Only valid while `nativeSig` matches the current points.
       */
      native?: NativeCurve;
      nativeSig?: string;
    })
  | (DxfEntityBase & {
      type: "TEXT";
      position: DxfPoint;
      height: number;
      value: string;
      rotation?: number;
      /** Horizontal anchor of `position`; default left. */
      align?: "left" | "center" | "right";
      /** Vertical anchor of `position`; default baseline. */
      valign?: "top" | "middle" | "bottom" | "baseline";
      /** Text style name (STYLE table). */
      style?: string;
      /** Font file / family from the style or an inline \\f code (e.g. "simplex.shx", "Arial"). */
      font?: string;
      bold?: boolean;
      italic?: boolean;
      /** Width factor (1 = normal). */
      widthFactor?: number;
      /** Oblique angle in degrees (positive leans right). */
      oblique?: number;
      /** DXF group 71 flag 2: mirrored horizontally (reads backwards). */
      backwards?: boolean;
      /** DXF group 71 flag 4: flipped vertically (reads upside down). */
      upsideDown?: boolean;
      /** MTEXT column width (group 41) in drawing units — wrap visual lines to this width like native CAD. */
      wrapWidth?: number;
      /** MTEXT line-spacing factor (group 44, 0.25-4.0; 1 = the default 3-on-5 pitch). */
      lineSpacing?: number;
      /** Express Tools TEXTMASK: draw a background-coloured box behind the text. */
      mask?: boolean;
      /**
       * Inline-formatted runs of an MTEXT (from \C / \c colour and \f bold/italic codes).
       * `value` stays the plain concatenated text; when absent the entity renders as one run.
       */
      runs?: Array<{ text: string; color?: number; rgb?: number; bold?: boolean; italic?: boolean }>;
    })
  | (DxfEntityBase & {
      type: "POINT";
      position: DxfPoint;
    })
  | (DxfEntityBase & {
      type: "DIMENSION";
      /**
       * In-memory link to the dimension's drawn geometry: entities carrying
       * meta.dimId === dimId are written into this dimension's anonymous
       * block (*D<n>) instead of as plain entities, so the file carries a
       * real DIMENSION — not dumb LINE/TEXT geometry. Never written to DXF.
       */
      dimId?: string;
      /** DXF group 70 (& 7): 0 rotated-linear, 1 aligned, 3 diameter, 4 radius, 6 ordinate. */
      dimType: 0 | 1 | 3 | 4 | 6;
      /** Dimension style name (DXF group 3); undefined = Standard. */
      styleName?: string;
      /**
       * Definition point (DXF group 10): dimension-line location for
       * linear/aligned, centre for radius/diameter.
       */
      defPoint: DxfPoint;
      /** Extension-line origins (DXF groups 13/14; linear/aligned only). */
      extOrigin1?: DxfPoint;
      extOrigin2?: DxfPoint;
      /** Point on the measured curve (DXF group 15; radius/diameter only). */
      curvePoint?: DxfPoint;
      /**
       * Leader end (DXF group 13; ordinate only): the point the user picked
       * as the dimension's leader/text position. The axis (X vs Y) is
       * derived from the leader end's dominant offset from the feature
       * point (see ordinateAxis).
       */
      leaderEnd?: DxfPoint;
      /** Measurement text (DXF group 1); readers measure it when omitted. */
      text?: string;
      /** Dimension text midpoint (DXF group 11). */
      textPoint?: DxfPoint;
    })
  | DxfInsert;

/** Attribute definition inside a block (DXF ATTDEF). */
export interface DxfAttDef {
  tag: string;
  prompt: string;
  defaultValue: string;
  position: DxfPoint;
  height: number;
  rotation?: number;
  layer?: string;
  /** DXF group 70 flags, kept individually. */
  invisible?: boolean;
  constant?: boolean;
  verify?: boolean;
  preset?: boolean;
}

/** Attribute value carried by one block reference (DXF ATTRIB). Position is in the host (insert's parent) space. */
export interface DxfAttrib {
  tag: string;
  value: string;
  position: DxfPoint;
  height: number;
  rotation?: number;
  layer?: string;
  invisible?: boolean;
}

/** Block definition: reusable geometry referenced by name from any number of INSERTs. */
export interface DxfBlockDef {
  name: string;
  /** Block base point (BLOCK group 10): maps to the insertion point. */
  base: DxfPoint;
  /** Definition entities in block space. Nested block references stay INSERT entities (not copied). */
  entities: DxfEntity[];
  attdefs: DxfAttDef[];
  description?: string;
}

/**
 * Native block reference. Geometry is NOT copied: it is looked up by `name` in `DxfDocument.blocks` and
 * resolved on demand (see block-refs.ts), so editing a block definition updates every reference.
 */
export type DxfInsert = DxfEntityBase & {
  type: "INSERT";
  name: string;
  position: DxfPoint;
  /** Per-axis scale; undefined = 1. Negative values mirror. */
  scale?: { x: number; y: number; z?: number };
  /** Rotation in degrees (counter-clockwise). */
  rotation?: number;
  /** MINSERT array (>1 means an array of references). */
  columns?: number;
  rows?: number;
  columnSpacing?: number;
  rowSpacing?: number;
  attributes?: DxfAttrib[];
};

/** A paper-space viewport showing a window of model space. */
export interface DxfViewport {
  /** Centre on the sheet. */
  center: DxfPoint;
  width: number;
  height: number;
  /** Model-space point shown at the viewport centre. */
  viewCenter: DxfPoint;
  /** Model-space height shown through the viewport. */
  viewHeight: number;
  /** View twist in degrees. */
  twist?: number;
}

export interface DxfLayout {
  name: string;
  entities: DxfEntity[];
  viewports: DxfViewport[];
}

/** An external reference declared by a drawing (DXF block flag 4 = xref, 8 = overlay; path in group 1). */
export interface DxfXrefDecl { name: string; path: string; kind: "attach" | "overlay" }

export type DxfUnits = "unitless" | "mm" | "cm" | "m" | "in" | "ft";

/** A STYLE-table record (text style) as read from the file. */
export interface DxfTextStyle {
  /** Primary font: SHX file name ("txt.shx") or TrueType family ("Arial"). */
  font?: string;
  /** Big-font file name for the extended character set (DXF group 4). */
  bigFont?: string;
  /** Fixed height (DXF group 40); 0/undefined = height set per entity. */
  height?: number;
  /** Width factor (DXF group 41). */
  width?: number;
  /** Oblique angle in degrees (DXF group 50). */
  oblique?: number;
  bold?: boolean;
  italic?: boolean;
  /** DXF group 71 flag 2: drawn backwards. */
  backwards?: boolean;
  /** DXF group 71 flag 4: drawn upside down. */
  upsideDown?: boolean;
}

/** A DIMSTYLE-table record (dimension style) as read from the file — the values needed to draw dimensions natively. */
export interface DxfDimStyle {
  /** DIMSCALE (group 40) — overall scale applied to every size. */
  scale?: number;
  /** DIMTXT (group 140) — dimension text height. */
  textHeight?: number;
  /** DIMASZ (group 41) — arrowhead size. */
  arrowSize?: number;
  /** DIMEXO (group 42) — extension-line offset from the measured origin. */
  extOffset?: number;
  /** DIMEXE (group 44) — extension past the dimension line. */
  extExtend?: number;
  /** DIMGAP (group 147) — gap around the dimension text. */
  textGap?: number;
  /** DIMDEC (group 271) — decimal places of the measurement text. */
  decimals?: number;
  /** DIMPOST (group 3) — suffix / prefix for the measurement ("<>" is the measurement). */
  postFix?: string;
  /** DIMLFAC (group 143) — linear measurement scale factor. */
  linearFactor?: number;
}

export interface DxfDocument {
  layers: DxfLayer[];
  entities: DxfEntity[];
  /** Drawing extents (model space), computed from the entities. */
  extents?: { min: DxfPoint; max: DxfPoint };
  /** External references this drawing declares (XREF block records), nested ones included. */
  xrefs?: DxfXrefDecl[];
  /** Drawing units as declared by the file ($INSUNITS). */
  units?: DxfUnits;
  sourceFormat?: "dxf" | "dwg" | "cad-engine" | "unknown";
  /** Paper-space layouts (sheets). */
  layouts?: DxfLayout[];
  /** Linetype name (upper case) -> dash pattern in drawing units (+dash, -gap, 0 dot). */
  linetypes?: Record<string, number[]>;
  /** Global linetype scale ($LTSCALE). */
  ltscale?: number;
  /** STYLE table (text styles) by upper-case name, as read from the file. */
  textStyles?: Record<string, DxfTextStyle>;
  /** DIMSTYLE table names, as read from the file. */
  dimStyles?: string[];
  /** DIMSTYLE table by upper-case name, with the values needed for native dimension drawing. */
  dimStyleTable?: Record<string, DxfDimStyle>;
  /** Model-space view stored in the file (active viewport / $VIEWCTR): what the native app shows on open. */
  savedView?: { cx: number; cy: number; height: number; twist?: number };
  /** Entity types that were present but not drawn, with counts. */
  skipped?: Record<string, number>;
  /**
   * Block table (name -> definition). Present only when the document was read with native blocks, in
   * which case block references are INSERT entities in `entities`/layouts instead of expanded copies.
   */
  blocks?: Record<string, DxfBlockDef>;
}
