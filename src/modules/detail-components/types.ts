/**
 * Detail components & repeating details — types + library.
 *
 * Detail components are 2D symbols used in detail views (construction
 * documents): fasteners, anchors, expansion joints, repeating details
 * (bricks, blocks, decking profiles). BIM ships these as "Detail
 * Components" and "Repeating Details".
 *
 * A DetailComponent is a 2D line-art symbol defined in SVG-like
 * coordinates (mm). A RepeatingDetail repeats a component at a fixed
 * spacing along a line.
 */

/** A 2D detail component definition (line art in mm). */
export interface DetailComponent {
  id: string;
  name: string;
  category: string;
  /** Line segments [x1, y1, x2, y2] in mm. */
  lines: Array<[number, number, number, number]>;
  /** Optional filled regions (closed polygons). */
  fills?: Array<{ points: Array<[number, number]>; color: string }>;
  /** Default width (mm) for scaling. */
  width: number;
  /** Default height (mm). */
  height: number;
}

/** A repeating detail: component + spacing + count. */
export interface RepeatingDetail {
  componentId: string;
  /** Start point (world x, z in m). */
  start: [number, number];
  /** End point (world x, z in m). */
  end: [number, number];
  /** Spacing between repetitions (mm). */
  spacingMm: number;
  /** Rotation offset (degrees). */
  rotation?: number;
}

/** Built-in detail component library. */
export const BUILTIN_COMPONENTS: DetailComponent[] = [
  {
    id: "brick-running-bond",
    name: "Brick (running bond)",
    category: "Masonry",
    width: 210, height: 65,
    lines: [
      [0, 0, 210, 0], [0, 65, 210, 65],
      [0, 0, 0, 65], [105, 0, 105, 65], [210, 0, 210, 65],
    ],
    fills: [{ points: [[0, 0], [105, 0], [105, 65], [0, 65]], color: "#a16207" }],
  },
  {
    id: "concrete-block-200",
    name: "Concrete Block 200mm",
    category: "Masonry",
    width: 400, height: 200,
    lines: [
      [0, 0, 400, 0], [0, 200, 400, 200],
      [0, 0, 0, 200], [200, 0, 200, 200], [400, 0, 400, 200],
    ],
  },
  {
    id: "expansion-joint-20",
    name: "Expansion Joint 20mm",
    category: "Joints",
    width: 20, height: 100,
    lines: [
      [0, 0, 0, 100], [20, 0, 20, 100],
      [5, 20, 15, 30], [5, 40, 15, 50], [5, 60, 15, 70],
    ],
  },
  {
    id: "deck-profile",
    name: "Metal Deck Profile",
    category: "Decking",
    width: 300, height: 50,
    lines: [
      [0, 0, 75, 50, 150, 0, 225, 50, 300, 0].flatMap((v, i, a) =>
        i > 0 && i % 2 === 0 ? [[a[i - 2], a[i - 1], v, a[i + 1]]] : []
      ).flat() as any,
      [0, 0, 300, 0],
    ].flat() as any,
  },
  {
    id: "anchor-bolt-16",
    name: "Anchor Bolt D16",
    category: "Fasteners",
    width: 16, height: 150,
    lines: [
      [8, 0, 8, 150], [0, 20, 16, 20], [4, 25, 12, 25], [4, 30, 12, 30],
    ],
  },
  {
    id: "l-angle-50x50x5",
    name: "L-Angle 50x50x5",
    category: "Steel",
    width: 50, height: 50,
    lines: [
      [0, 0, 50, 0], [0, 0, 0, 50], [5, 5, 50, 5], [5, 5, 5, 50],
    ],
    fills: [
      { points: [[0, 0], [50, 0], [50, 5], [5, 5], [5, 50], [0, 50]], color: "#94a3b8" },
    ],
  },
];

export function getComponent(id: string): DetailComponent | null {
  return BUILTIN_COMPONENTS.find((c) => c.id === id) ?? null;
}

export function listComponents(): Array<{ id: string; name: string; category: string }> {
  return BUILTIN_COMPONENTS.map((c) => ({ id: c.id, name: c.name, category: c.category }));
}
