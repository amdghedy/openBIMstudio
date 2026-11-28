/**
 * Scene2D — renderer-agnostic description of a 2D view.
 *
 * Every view generator produces a Scene2D. Every renderer consumes one.
 * Units are world metres. Stroke widths are paper points — converted to
 * world units by paperToWorld() at render time.
 */
export function emptyScene() {
    return {
        bounds: { minX: 0, minZ: 0, maxX: 10, maxZ: 10 },
        layers: { cut: [], project: [], overhead: [], below: [], grid: [], annotation: [], symbols: [] },
        generatedAt: Date.now(),
    };
}
/**
 * Convert paper millimetres to world metres at a given view scale.
 *   paperToWorld(0.18, 100) === 0.018   // 0.18 mm at 1:100 = 18 mm world
 */
export function paperToWorld(paperMm, viewScale) {
    return (paperMm / 1000) * viewScale;
}
export function worldToPaper(worldM, viewScale) {
    return (worldM / viewScale) * 1000;
}
