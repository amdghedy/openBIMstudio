/** Grid bubbles & level markers in 2D views. */
export interface GridBubble {
  gridId: string;
  /** Position on the grid line [x, z] in world metres. */
  position: [number, number];
  /** Grid label (e.g. "A", "B", "1", "2"). */
  label: string;
  /** Which end: "start" or "end". */
  end: "start" | "end";
  /** Whether the bubble is visible (user can toggle). */
  visible: boolean;
}
export interface LevelMarker {
  levelId: string;
  /** Position [x, z] where the marker appears. */
  position: [number, number];
  /** Level label (e.g. "Level 1", "L2"). */
  label: string;
  /** Elevation (m). */
  elevation: number;
  visible: boolean;
}

const gridBubbles: GridBubble[] = [];
const levelMarkers: LevelMarker[] = [];

export function addGridBubble(b: GridBubble): void { gridBubbles.push(b); }
export function getGridBubbles(): GridBubble[] { return gridBubbles; }
export function toggleGridBubble(gridId: string, end: "start" | "end"): void {
  const b = gridBubbles.find(g => g.gridId === gridId && g.end === end);
  if (b) b.visible = !b.visible;
}
export function addLevelMarker(m: LevelMarker): void { levelMarkers.push(m); }
export function getLevelMarkers(): LevelMarker[] { return levelMarkers; }

let installed = false;
export function setupGridBubbles() {
  if (installed) return; installed = true;
  (window as any).__obsGridBubbles = {
    addGrid: addGridBubble, getGrids: getGridBubbles, toggleGrid: toggleGridBubble,
    addLevel: addLevelMarker, getLevels: getLevelMarkers,
  };
  console.log("[grid-bubbles] ready.");
}
